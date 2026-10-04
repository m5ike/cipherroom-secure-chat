// Sandbox processes, from the runner's side (4.15).
//
// Each run gets its own child process (dist/sandbox.cjs) that loads one
// interpreter and runs one function. A separate process is what keeps a
// runaway model — an endless loop, a memory blow-up, a crash — from touching
// the main service or the other runs: the runner watches wall time and
// memory and, if a run goes over, kills the process. Scripts are written by
// the operator, so this is about stability and fair resource use, not about
// defending against a hostile author.
//
// A small warm pool per language hides the interpreter's start-up (Pyodide is
// about a second): a spare process is kept ready and handed the next run.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFromSandbox, MAX_FRAME, type FromSandbox, type Lang, type Output, type Rejected, type RunError, type RunSpec, type ToSandbox } from "./protocol";

const here = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
const req = createRequire(here);

/* ------------------------------------------------------------------ paths */

export type SandboxPaths = { script: string; pyodide: string; quickjs: string };
let cachedPaths: Promise<SandboxPaths> | null = null;
let devBuild: Promise<string> | null = null;
/** Files outside this folder the sandbox bundles (host-pure.ts imports them). */
const SHARED_SOURCES = ["../../../client/src/lib/nfc/card-report.ts", "../../../client/src/lib/nfc/command.ts", "../../../client/src/lib/fn-html.ts"];

/** Development and tests: bundle the sandbox from source once per change. */
async function buildDevScript(): Promise<string> {
  const srcDir = dirname(here);
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort();
  const hash = createHash("sha256");
  for (const f of files) hash.update(f).update(String(statSync(join(srcDir, f)).mtimeMs));
  // 6.6: the pure helpers also bundle the client's card reports and HTML sanitizer.
  for (const f of SHARED_SOURCES) { const p = join(srcDir, f); hash.update(f).update(existsSync(p) ? String(statSync(p).mtimeMs) : "-"); }
  const out = join(tmpdir(), "m5cet-sandbox", hash.digest("hex").slice(0, 16), "sandbox.cjs");
  if (existsSync(out)) return out;
  mkdirSync(dirname(out), { recursive: true });
  const esbuild = await import("esbuild");
  const { sandboxBuildOptions } = await import("./bundle");
  await esbuild.build(sandboxBuildOptions(out, false));
  return out;
}

export function sandboxPaths(): Promise<SandboxPaths> {
  cachedPaths ??= (async () => {
    const explicit = process.env.FUNCTIONS_SANDBOX_SCRIPT?.trim();
    let script = explicit || join(dirname(here), "sandbox.cjs");
    if (!explicit && !here.endsWith(".cjs")) { devBuild ??= buildDevScript(); script = await devBuild; }
    if (!existsSync(script)) throw new Error(`the sandbox script is missing (${script}) — build it with npm run build`);
    const pyodide = dirname(req.resolve("pyodide/package.json"));
    const quickjs = req.resolve("@jitl/quickjs-ng-wasmfile-release-sync/wasm");
    return { script: realpathSync(script), pyodide: realpathSync(pyodide), quickjs: realpathSync(quickjs) };
  })();
  return cachedPaths;
}

/* --------------------------------------------------------------- a child */

/** While a run waits for the caller (m5.prompt / m5.form), the wall-time
 *  watchdog is paused: the wait counts against a separate, larger budget, not
 *  the compute limit. A host call wraps the waiting promise in `wait`. */
export type RunControl = { wait<T>(p: Promise<T>): Promise<T> };

/** The host answers a sandbox's m5.* call (session, cache, prompt); returns the value. */
export type HostCallHandler = (fn: string, args: unknown[], control: RunControl) => Promise<unknown>;

export type RunHandlers = {
  onLog?: (level: string, msg: string, fields?: Record<string, unknown>) => void;
  onOutput?: (out: Output) => void;
  /** 5.3: an output sent during the run was not a valid one. */
  onRejected?: (reason: string) => void;
  onProgress?: (p: number, text: string) => void;
  host: HostCallHandler;
};

/** How long, in total, a run may sit waiting for the caller across all prompts. */
const MAX_WAIT_MS = 10 * 60 * 1000;

export type RunResult =
  | { ok: true; values: Output[]; result: unknown; rejected: Rejected[]; ms: number; memMb: number; engine: string }
  | { ok: false; error: RunError; ms: number; memMb: number; engine: string };

type Child = {
  proc: ChildProcess;
  lang: Lang;
  ready: Promise<void>;
  engine: string;
  buffer: string;
  onMessage: ((m: FromSandbox) => void) | null;
  busy: boolean;
  killed: boolean;
};

/**
 * The command line of a sandbox process (6.7, audit V1). The first wall is
 * Node's permission model: the process may read only its own script, the
 * interpreter it loads (the QuickJS .wasm for JavaScript, the Pyodide folder
 * for Python) and nothing else; it writes no file and may not start
 * processes, workers, addons, WASI or the inspector (none of the --allow-*
 * flags for those is given). Strings never become code: eval, Function and
 * its async/generator kin throw, so a script that reaches the process's
 * JavaScript (Python can, through a JsProxy) cannot compile its way to
 * import(). WebAssembly compilation is not affected by that flag.
 */
/** Node's permission-model flag: `--permission` from Node 22.13 / 23.5, `--experimental-permission` before (20.0–22.12) — the engines field allows any 22.x. */
export function permissionFlag(version: string = process.versions.node): string {
  const [major, minor] = version.split(".").map((x) => Number(x) || 0);
  return major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13) ? "--permission" : "--experimental-permission";
}

export function sandboxArgs(lang: Lang, paths: SandboxPaths, memoryMb: number): string[] {
  // A generous ceiling for the V8 heap around the interpreter; the real
  // per-run limit is enforced by the interpreter and by the watchdog below.
  const heapCap = Math.max(256, Math.round(memoryMb * 1.5) + 128);
  const reads = [paths.script, lang === "py" ? paths.pyodide : paths.quickjs];
  return [
    permissionFlag(),
    ...reads.map((p) => `--allow-fs-read=${p}`),
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${heapCap}`,
    paths.script, `--lang=${lang}`, `--pyodide=${paths.pyodide}`, `--quickjs=${paths.quickjs}`,
  ];
}

function startChild(lang: Lang, paths: SandboxPaths, memoryMb: number): Child {
  const args = sandboxArgs(lang, paths, memoryMb);
  const proc = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
  const child: Child = { proc, lang, engine: "", buffer: "", onMessage: null, busy: false, killed: false, ready: Promise.resolve() };
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (d: string) => { if (process.env.FUNCTIONS_DEBUG) process.stderr.write(`[sandbox ${lang}] ${d}`); });
  proc.stdout?.setEncoding("utf8");
  child.ready = new Promise<void>((resolveReady, rejectReady) => {
    const onExitBeforeReady = () => rejectReady(new Error("the sandbox process exited before it was ready"));
    proc.once("exit", onExitBeforeReady);
    proc.stdout?.on("data", (chunk: string) => {
      child.buffer += chunk;
      if (child.buffer.length > MAX_FRAME && !child.buffer.includes("\n")) { child.buffer = ""; return; }
      let nl: number;
      while ((nl = child.buffer.indexOf("\n")) >= 0) {
        const line = child.buffer.slice(0, nl); child.buffer = child.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: FromSandbox | null;
        try { msg = checkFromSandbox(JSON.parse(line)); } catch { msg = null; }
        if (!msg) continue;
        if (msg.t === "ready") { child.engine = `${msg.engine} ${msg.version}`.trim(); proc.off("exit", onExitBeforeReady); resolveReady(); continue; }
        child.onMessage?.(msg);
      }
    });
  });
  return child;
}

function send(child: Child, msg: ToSandbox): void {
  try { child.proc.stdin?.write(`${JSON.stringify(msg)}\n`); } catch { /* the process is gone; the watchdog handles it */ }
}

/* ----------------------------------------------------------------- pool */

export type PoolOptions = { warmPerLang?: number };

export class SandboxPool {
  private warm: Record<Lang, Child[]> = { js: [], py: [] };
  private warmTarget: number;
  private closed = false;

  constructor(opts: PoolOptions = {}) {
    this.warmTarget = Math.max(0, opts.warmPerLang ?? 1);
  }

  private async take(lang: Lang, memoryMb: number): Promise<Child> {
    const paths = await sandboxPaths();
    let child: Child | undefined;
    while ((child = this.warm[lang].shift())) {
      if (!child.killed && child.proc.exitCode === null) break;
      child = undefined;
    }
    if (!child) child = startChild(lang, paths, memoryMb);
    try { await child.ready; } catch (err) { kill(child); if (!this.warm[lang].length) throw err; return this.take(lang, memoryMb); }
    child.busy = true;
    this.refill(lang, paths, memoryMb);
    return child;
  }

  /** Keeps `warmTarget` spare processes ready per language, so a run does not
   *  wait for the interpreter to start (Pyodide takes about a second). */
  private refill(lang: Lang, paths: SandboxPaths, memoryMb: number): void {
    if (this.closed) return;
    while (this.warm[lang].filter((c) => !c.busy).length < this.warmTarget) {
      const spare = startChild(lang, paths, memoryMb);
      spare.ready.catch(() => kill(spare));
      this.warm[lang].push(spare);
    }
  }

  /** Runs one spec to completion; enforces wall time and memory by killing. */
  async run(spec: RunSpec, handlers: RunHandlers): Promise<RunResult> {
    const child = await this.take(spec.lang, spec.limits.memoryMb);
    const engine = child.engine;
    const started = Date.now();
    const grace = 2000;
    return await new Promise<RunResult>((resolve) => {
      let settled = false;
      let rss = 0;
      // Time spent waiting for the caller (paused watchdog), so a slow answer
      // is not counted as compute.
      let pausedTotal = 0;
      let pausedSince = 0;
      let pauseDepth = 0;
      const pausedNow = () => (pauseDepth > 0 ? Date.now() - pausedSince : 0);
      const control: RunControl = {
        wait: async <T,>(p: Promise<T>): Promise<T> => {
          if (pauseDepth++ === 0) pausedSince = Date.now();
          try { return await p; }
          finally { if (--pauseDepth === 0) pausedTotal += Date.now() - pausedSince; }
        },
      };
      const finish = (r: RunResult) => { if (settled) return; settled = true; clearInterval(watch); clearTimeout(hardStop); child.onMessage = null; this.retire(child); resolve(r); };

      const watch = setInterval(() => {
        rss = readRss(child.proc.pid);
        const compute = Date.now() - started - pausedTotal - pausedNow();
        const waited = pausedTotal + pausedNow();
        if (compute > spec.limits.wallMs + grace) {
          kill(child);
          finish({ ok: false, error: { type: "TimeLimit", message: "the run took longer than its time limit" }, ms: Date.now() - started, memMb: Math.round(rss / 1048576), engine });
        } else if (waited > MAX_WAIT_MS) {
          kill(child);
          finish({ ok: false, error: { type: "TimeLimit", message: "the run waited too long for an answer" }, ms: Date.now() - started, memMb: Math.round(rss / 1048576), engine });
        } else if (rss > (spec.limits.memoryMb + 192) * 1048576) {
          kill(child);
          finish({ ok: false, error: { type: "MemoryLimit", message: "the run used more memory than its limit" }, ms: Date.now() - started, memMb: Math.round(rss / 1048576), engine });
        }
      }, 250);
      const hardStop = setTimeout(() => { if (!settled && pauseDepth === 0) { kill(child); finish({ ok: false, error: { type: "TimeLimit", message: "the run did not stop" }, ms: Date.now() - started, memMb: Math.round(rss / 1048576), engine }); } }, MAX_WAIT_MS + grace * 3);
      hardStop.unref?.();

      child.proc.once("exit", () => finish({ ok: false, error: { type: "Crashed", message: "the sandbox process stopped unexpectedly" }, ms: Date.now() - started, memMb: Math.round(rss / 1048576), engine }));

      child.onMessage = (m) => {
        switch (m.t) {
          case "log": handlers.onLog?.(m.level, m.msg, m.fields); break;
          case "out": handlers.onOutput?.(m.out); break;
          case "bad-out": handlers.onRejected?.(m.reason); break;
          case "progress": handlers.onProgress?.(m.p, m.text); break;
          case "call":
            handlers.host(m.fn, m.args, control).then(
              (v) => send(child, { t: "ret", id: m.id, ok: true, v }),
              (err) => send(child, { t: "ret", id: m.id, ok: false, e: { code: (err as { code?: string })?.code ?? "error", message: (err as Error)?.message ?? "host call failed" } }),
            );
            break;
          case "done":
            finish(m.ok
              ? { ok: true, values: m.values, result: m.result, rejected: m.rejected, ms: m.ms, memMb: Math.max(m.mem, Math.round(rss / 1048576)), engine }
              : { ok: false, error: m.error, ms: m.ms, memMb: Math.max(m.mem, Math.round(rss / 1048576)), engine });
            break;
          case "fatal":
            finish({ ok: false, error: { type: "Fatal", message: m.message }, ms: Date.now() - started, memMb: Math.round(rss / 1048576), engine });
            break;
        }
      };
      send(child, { t: "run", spec });
    });
  }

  /** A used child is not reused (one run per process); it exits on its own. */
  private retire(child: Child): void {
    if (child.killed) return;
    setTimeout(() => kill(child), 3000).unref?.();
  }

  close(): void {
    this.closed = true;
    for (const lang of ["js", "py"] as Lang[]) { for (const c of this.warm[lang]) kill(c); this.warm[lang] = []; }
  }
}

function kill(child: Child): void {
  if (child.killed) return;
  child.killed = true;
  try { child.proc.kill("SIGKILL"); } catch { /* already gone */ }
}

/** Resident memory of a process, in bytes; 0 when it cannot be read. */
function readRss(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    // Linux: /proc/<pid>/statm, in pages. Elsewhere the check is skipped
    // (the interpreter's own memory limit still applies).
    const statm = req("node:fs").readFileSync(`/proc/${pid}/statm`, "utf8") as string;
    const pages = Number(statm.split(" ")[1] || 0);
    return pages * 4096;
  } catch { return 0; }
}
