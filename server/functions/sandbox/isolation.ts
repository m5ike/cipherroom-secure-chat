// The sandbox's second wall (6.12, F-03): on Linux, every sandbox process
// runs inside bubblewrap (bwrap) — its own user, PID, IPC, UTS, cgroup and
// network namespaces (`--unshare-all`: no network at all; host calls already
// go through the parent over stdin/stdout), no capabilities (`--cap-drop
// ALL`, 6.12 review S13 — also when the server runs as root), a root file
// system that holds nothing but read-only binds of
//
//   - the Node binary and the system's shared-library directories it needs,
//   - the sandbox script (dist/sandbox.cjs),
//   - the interpreter's files (Pyodide's folder or the QuickJS .wasm),
//
// plus a private /tmp (tmpfs), a minimal /dev and the namespace's own /proc;
// `--die-with-parent` (the server goes, the sandbox goes), `--new-session`
// (no terminal to inject into) and an empty environment. The data directory,
// the storage key, .env, the rest of the install and the network are simply
// not there. Node's permission model (pool.ts sandboxArgs) stays on inside,
// as the first wall.
//
//   FUNCTIONS_SANDBOX_ISOLATION   auto (default): bwrap when it is installed
//                                 and passes a self-test at the first run,
//                                 else the permission model alone, with a
//                                 warning in the console overview;
//                                 bwrap: required — without it no run starts;
//                                 none: the permission model alone.
//   FUNCTIONS_SANDBOX_BWRAP       path of bwrap (default: found on PATH,
//                                 /usr/bin, /usr/local/bin, /bin)
//   FUNCTIONS_SANDBOX_BWRAP_BINDS extra read-only paths, comma-separated
//                                 (a Node or libraries outside the usual
//                                 places, e.g. /nix/store)
//
// The self-test starts a real JavaScript sandbox through bwrap and waits for
// its "ready" — the binds, the libraries and the namespaces all have to work
// (a container without user namespaces, an AppArmor profile that refuses
// them, an old bwrap…); what failed goes into the warning.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export type IsolationSetting = "auto" | "bwrap" | "none";

export type IsolationState = {
  setting: IsolationSetting;
  /** What sandboxes run under: bwrap + the permission model, the permission model alone, or nothing (bwrap required but unavailable: runs refused). */
  mode: "bwrap" | "permission" | "refused";
  bwrap: string | null;
  /** Why it is not bwrap (empty when it is). */
  reason: string;
  checkedAt: number;
};

const env = (name: string) => process.env[name]?.trim() || "";

export function isolationSetting(): IsolationSetting {
  const v = env("FUNCTIONS_SANDBOX_ISOLATION").toLowerCase();
  return v === "bwrap" || v === "none" ? v : "auto";
}

/** bwrap's path, or null when it is not installed. */
export function findBwrap(): string | null {
  const explicit = env("FUNCTIONS_SANDBOX_BWRAP");
  if (explicit) return existsSync(explicit) ? explicit : null;
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), "/usr/bin", "/usr/local/bin", "/bin"];
  for (const d of dirs) {
    const p = join(d, "bwrap");
    if (existsSync(p)) return p;
  }
  return null;
}

/** Where shared libraries live (the dynamic loader of the Node binary is in one of them). */
export const LIBRARY_DIRS = ["/lib", "/lib64", "/lib32", "/libx32", "/usr/lib", "/usr/lib64", "/usr/lib32", "/usr/libx32"];

type FsProbe = { exists(p: string): boolean; isSymlink(p: string): boolean; readlink(p: string): string };
const realFs: FsProbe = {
  exists: (p) => existsSync(p),
  isSymlink: (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } },
  readlink: (p) => readlinkSync(p),
};

/**
 * bwrap's arguments for one sandbox process: `node` with `nodeArgs`, seeing
 * only `reads` (and the libraries) read-only. Pure — the tests check it on
 * any platform.
 */
export function bwrapArgs(opts: { node: string; nodeArgs: string[]; reads: string[]; extraBinds?: string[]; fs?: FsProbe }): string[] {
  const fs = opts.fs ?? realFs;
  const args = [
    "--unshare-all",
    // 6.12 review S13: no capabilities inside, also when the server runs as root (bubblewrap
    // otherwise keeps a root caller's capabilities in the sandbox); --unshare-all includes the user namespace.
    "--cap-drop", "ALL",
    "--die-with-parent",
    "--new-session",
    "--hostname", "m5-sandbox",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];
  const bound = new Set<string>();
  const bind = (p: string) => {
    if (!p || bound.has(p)) return;
    bound.add(p);
    args.push("--ro-bind", p, p);
  };
  // Library directories: a symlink (/lib → usr/lib on merged-/usr systems) stays a symlink.
  for (const dir of LIBRARY_DIRS) {
    if (!fs.exists(dir)) continue;
    if (fs.isSymlink(dir)) { args.push("--symlink", fs.readlink(dir), dir); bound.add(dir); }
    else bind(dir);
  }
  if (fs.exists("/etc/ld.so.cache")) bind("/etc/ld.so.cache");
  for (const extra of opts.extraBinds ?? []) if (extra.startsWith("/") && fs.exists(extra)) bind(extra);
  bind(opts.node);
  for (const p of opts.reads) bind(p);
  args.push("--chdir", "/tmp", "--", opts.node, ...opts.nodeArgs);
  return args;
}

export function extraBinds(): string[] {
  return env("FUNCTIONS_SANDBOX_BWRAP_BINDS").split(",").map((s) => s.trim()).filter(Boolean);
}

/** The Node binary as a file (no symlink), so the bind and the exec agree. */
export function nodeBinary(): string {
  try { return realpathSync(process.execPath); } catch { return process.execPath; }
}

/* ------------------------------------------------------------- the probe */

let state: IsolationState | null = null;
let probing: Promise<IsolationState> | null = null;

/** The last known state (null before the first run / the start-up probe). */
export function isolationState(): IsolationState | null { return state; }

/** Test seam. */
export function _resetIsolationForTests(next: IsolationState | null = null): void { state = next; probing = null; }

/**
 * Decides once per process how sandboxes run: `selfTest` starts a sandbox
 * through bwrap and resolves when it reported ready (pool.ts passes it).
 */
export function resolveIsolation(selfTest: (bwrap: string) => Promise<void>, platform: NodeJS.Platform = process.platform): Promise<IsolationState> {
  if (state) return Promise.resolve(state);
  probing ??= (async () => {
    const setting = isolationSetting();
    const done = (s: Omit<IsolationState, "setting" | "checkedAt">): IsolationState => {
      state = { setting, checkedAt: Date.now(), ...s };
      if (s.mode !== "bwrap") console.warn(`[functions] sandbox isolation: ${s.mode === "refused" ? "REFUSING runs" : "permission model only"} — ${s.reason}`);
      else console.log(`[functions] sandbox isolation: bubblewrap (${s.bwrap}) + the permission model`);
      return state;
    };
    if (setting === "none") return done({ mode: "permission", bwrap: null, reason: "FUNCTIONS_SANDBOX_ISOLATION=none: sandboxes run under the Node permission model only" });
    const failMode = setting === "bwrap" ? "refused" as const : "permission" as const;
    if (platform !== "linux") return done({ mode: failMode, bwrap: null, reason: `bubblewrap needs Linux (this is ${platform}); sandboxes run under the Node permission model only` });
    const bwrap = findBwrap();
    if (!bwrap) return done({ mode: failMode, bwrap: null, reason: "bubblewrap (bwrap) is not installed — install it (apt install bubblewrap) to isolate function sandboxes" });
    // 6.12 review S13: one failed self-test (a slow start, a busy host) is tried once more before the
    // process settles on the permission model for its lifetime.
    let failure: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await selfTest(bwrap);
        return done({ mode: "bwrap", bwrap, reason: "" });
      } catch (err) {
        failure = err as Error;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
      }
    }
    return done({ mode: failMode, bwrap, reason: `bubblewrap is installed but its self-test failed: ${(failure?.message ?? "").slice(0, 300)} (tried twice)` });
  })();
  return probing;
}

/** Spawns `cmd args` and resolves at the first stdout line that says ready (the sandbox's {"t":"ready"}). */
export function readyWithin(cmd: string, args: string[], ms = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: {}, cwd: dirname(cmd) });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`no ready within ${ms} ms${err ? `: ${err.trim().slice(-200)}` : ""}`)); }, ms);
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d: string) => {
      out += d;
      if (/"t":"ready"/.test(out)) { clearTimeout(timer); p.kill("SIGKILL"); resolve(); }
    });
    p.stderr.on("data", (d: string) => { if (err.length < 4000) err += d; });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("exit", (code) => { clearTimeout(timer); if (!/"t":"ready"/.test(out)) reject(new Error(`exited with ${code}${err ? `: ${err.trim().slice(-300)}` : ""}`)); });
  });
}
