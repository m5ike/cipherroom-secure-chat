// @vitest-environment node
// 6.12 — the sandbox's second wall and its queue (F-03, F-28):
//   - on Linux the child runs inside bubblewrap: own namespaces (no network),
//     read-only binds of only Node, the libraries, its script and its
//     interpreter, a private /tmp, --die-with-parent, --new-session, no env;
//   - FUNCTIONS_SANDBOX_ISOLATION=auto|bwrap|none, with a fallback (and a
//     warning) when bwrap is missing or fails its self-test;
//   - Pyodide's JS modules are unregistered and its Emscripten module is
//     gone from the API object, so emptying sys.meta_path reaches nothing;
//   - at most FUNCTIONS_SANDBOX_MAX sandboxes at once, a bounded queue.
// The bwrap path itself is checked by argument construction everywhere and
// run for real only on Linux with bwrap installed.

import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5sb612-")));
process.env.FUNCTIONS_DB_FILE = join(dir, "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { runAdhoc, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");
const { sandboxCommand, sandboxPaths, sandboxReads, SlotGate, SandboxPool, readRss, sandboxLimits } = await import("../server/functions/sandbox/pool");
const { bwrapArgs, resolveIsolation, _resetIsolationForTests, isolationState, findBwrap, readyWithin, nodeBinary } = await import("../server/functions/sandbox/isolation");
const { NEUTERED } = await import("../server/functions/sandbox/engine-py");

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

const fakeFs = (present: Record<string, string | true>) => ({
  exists: (p: string) => p in present,
  isSymlink: (p: string) => typeof present[p] === "string",
  readlink: (p: string) => String(present[p]),
});

describe("bubblewrap command line", () => {
  it("unshares everything, binds only Node, the libraries, the script and the interpreter read-only", () => {
    const args = bwrapArgs({
      node: "/opt/node/bin/node",
      nodeArgs: ["--permission", "--allow-fs-read=/srv/m5/dist/sandbox.cjs", "/srv/m5/dist/sandbox.cjs", "--lang=py"],
      reads: ["/srv/m5/dist/sandbox.cjs", "/srv/m5/node_modules/pyodide"],
      extraBinds: ["/nix/store", "relative/ignored"],
      fs: fakeFs({ "/lib": "usr/lib", "/lib64": true, "/usr/lib": true, "/etc/ld.so.cache": true, "/nix/store": true }),
    });
    const at = args.indexOf("--");
    const flags = args.slice(0, at);
    for (const f of ["--unshare-all", "--die-with-parent", "--new-session"]) expect(flags).toContain(f);
    // 6.12 review S13: no capabilities inside (a root server would otherwise keep them).
    expect(flags.join(" ")).toContain("--cap-drop ALL");
    expect(flags).not.toContain("--share-net");
    // A private /tmp, a minimal /dev, the namespace's own /proc.
    expect(flags.join(" ")).toContain("--tmpfs /tmp");
    expect(flags.join(" ")).toContain("--dev /dev");
    expect(flags.join(" ")).toContain("--proc /proc");
    const binds: string[] = [];
    for (let i = 0; i < flags.length; i++) if (flags[i] === "--ro-bind") { expect(flags[i + 1]).toBe(flags[i + 2]); binds.push(flags[i + 1]); }
    expect(binds.sort()).toEqual(["/etc/ld.so.cache", "/lib64", "/nix/store", "/opt/node/bin/node", "/srv/m5/dist/sandbox.cjs", "/srv/m5/node_modules/pyodide", "/usr/lib"].sort());
    // No writable bind of anything, no bind of the data directory or the install.
    expect(flags).not.toContain("--bind");
    expect(binds.some((b) => b === "/srv/m5" || b.includes(".m5cet") || b.includes("storage"))).toBe(false);
    // A merged-/usr symlink stays a symlink.
    expect(flags.join(" ")).toContain("--symlink usr/lib /lib");
    expect(args.slice(at + 1)).toEqual(["/opt/node/bin/node", "--permission", "--allow-fs-read=/srv/m5/dist/sandbox.cjs", "/srv/m5/dist/sandbox.cjs", "--lang=py"]);
    // The /tmp tmpfs comes before any bind under it (a dev build's script lives in the OS temp dir).
    expect(flags.indexOf("--tmpfs")).toBeLessThan(flags.indexOf("--ro-bind"));
  });

  it("the pool starts Node inside bwrap with an empty environment, the permission model still on", async () => {
    const paths = await sandboxPaths();
    for (const lang of ["js", "py"] as const) {
      const c = sandboxCommand(lang, paths, 128, { mode: "bwrap", bwrap: "/usr/bin/bwrap" });
      expect(c.cmd).toBe("/usr/bin/bwrap");
      expect(c.env).toEqual({});
      const inner = c.args.slice(c.args.indexOf("--") + 1);
      expect(inner).toContain("--permission");
      expect(inner).toContain("--disallow-code-generation-from-strings");
      for (const r of sandboxReads(lang, paths)) expect(c.args).toContain(r);
      expect(c.args).not.toContain(lang === "js" ? paths.pyodide : paths.quickjs);
      const plain = sandboxCommand(lang, paths, 128, { mode: "permission", bwrap: null });
      expect(plain.cmd).toBe(process.execPath);
      expect(Object.keys(plain.env)).toEqual(["PATH"]);
    }
  });
});

describe("FUNCTIONS_SANDBOX_ISOLATION", () => {
  const saved = process.env.FUNCTIONS_SANDBOX_ISOLATION;
  beforeEach(() => { _resetIsolationForTests(); delete process.env.FUNCTIONS_SANDBOX_ISOLATION; });
  afterAll(() => { _resetIsolationForTests(); if (saved === undefined) delete process.env.FUNCTIONS_SANDBOX_ISOLATION; else process.env.FUNCTIONS_SANDBOX_ISOLATION = saved; });

  it("auto: off Linux, the permission model alone — and it says why", async () => {
    const s = await resolveIsolation(async () => { throw new Error("must not run"); }, "darwin");
    expect(s).toMatchObject({ setting: "auto", mode: "permission", bwrap: null });
    expect(s.reason).toMatch(/needs Linux/);
    expect(isolationState()).toBe(s);
  });

  it("auto on Linux: a failing self-test falls back with the failure in the warning", async () => {
    process.env.FUNCTIONS_SANDBOX_BWRAP = process.execPath; // "installed"
    try {
      const s = await resolveIsolation(async () => { throw new Error("setting up uid map: Permission denied"); }, "linux");
      expect(s).toMatchObject({ mode: "permission", bwrap: process.execPath });
      expect(s.reason).toMatch(/self-test failed: setting up uid map/);
    } finally { delete process.env.FUNCTIONS_SANDBOX_BWRAP; }
  });

  it("auto on Linux: a passing self-test means bwrap", async () => {
    process.env.FUNCTIONS_SANDBOX_BWRAP = process.execPath;
    try {
      const s = await resolveIsolation(async () => undefined, "linux");
      expect(s).toMatchObject({ mode: "bwrap", bwrap: process.execPath, reason: "" });
    } finally { delete process.env.FUNCTIONS_SANDBOX_BWRAP; }
  });

  it("bwrap required but missing: runs are refused, not run without it", async () => {
    process.env.FUNCTIONS_SANDBOX_ISOLATION = "bwrap";
    process.env.FUNCTIONS_SANDBOX_BWRAP = join(dir, "no-such-bwrap");
    try {
      const s = await resolveIsolation(async () => undefined, "linux");
      expect(s).toMatchObject({ setting: "bwrap", mode: "refused" });
      const pool = new SandboxPool({ warmPerLang: 0 });
      const r = await pool.run({ id: "run_refused", lang: "js", files: {}, entry: { file: "index.js", fn: "execute" }, inputs: {}, deps: {}, context: {} as never, limits: { memoryMb: 64, wallMs: 1000, outputBytes: 1000, logBytes: 1000 } } as never, { host: async () => null });
      expect(r).toMatchObject({ ok: false, error: { type: "SandboxUnavailable" } });
      expect(pool.gate.stats().running).toBe(0);
      pool.close();
    } finally { delete process.env.FUNCTIONS_SANDBOX_BWRAP; }
  });

  it("none: the permission model by choice", async () => {
    process.env.FUNCTIONS_SANDBOX_ISOLATION = "none";
    const s = await resolveIsolation(async () => { throw new Error("must not run"); }, "linux");
    expect(s).toMatchObject({ setting: "none", mode: "permission" });
  });

  const bwrap = process.platform === "linux" ? findBwrap() : null;
  it.skipIf(!bwrap)("Linux with bwrap: a real sandbox comes up inside it and cannot read the data directory", async (ctx) => {
    const paths = await sandboxPaths();
    const c = sandboxCommand("js", paths, 128, { mode: "bwrap", bwrap });
    try { await readyWithin(c.cmd, c.args); }
    catch (err) {
      // A host without user namespaces (a container, Ubuntu's AppArmor restriction): what auto mode falls back from.
      process.stderr.write(`bwrap cannot start a sandbox here: ${(err as Error).message}\n`);
      ctx.skip();
      return;
    }
    const probe = spawnSync(bwrap!, bwrapArgs({ node: nodeBinary(), nodeArgs: ["-e", `try{require("fs").readdirSync(${JSON.stringify(dir)});console.log("visible")}catch(e){console.log("hidden:"+e.code)}`], reads: [] }), { encoding: "utf8", env: {} });
    expect(probe.stdout.trim()).toMatch(/^hidden:ENOENT/);
  }, 30_000);
});

describe("the sandbox queue (FUNCTIONS_SANDBOX_MAX)", () => {
  it("defaults scale with the CPUs and read the environment", () => {
    const d = sandboxLimits();
    expect(d.max).toBeGreaterThanOrEqual(4);
    expect(d.queue).toBe(d.max * 4);
    process.env.FUNCTIONS_SANDBOX_MAX = "3"; process.env.FUNCTIONS_SANDBOX_QUEUE = "0"; process.env.FUNCTIONS_SANDBOX_QUEUE_MS = "500";
    try { expect(sandboxLimits()).toEqual({ max: 3, queue: 0, waitMs: 500 }); }
    finally { delete process.env.FUNCTIONS_SANDBOX_MAX; delete process.env.FUNCTIONS_SANDBOX_QUEUE; delete process.env.FUNCTIONS_SANDBOX_QUEUE_MS; }
  });

  it("lets max runs in, queues a bounded number in order, refuses the rest", async () => {
    const gate = new SlotGate(1, 1, 5_000);
    const first = await gate.acquire("a");
    const order: string[] = [];
    const second = gate.acquire("b").then((rel) => { order.push("b"); return rel; });
    await expect(gate.acquire("c")).rejects.toMatchObject({ type: "Busy" });
    expect(gate.stats()).toMatchObject({ running: 1, waiting: 1 });
    first(); first(); // twice is harmless
    const rel = await second;
    expect(order).toEqual(["b"]);
    expect(gate.stats()).toMatchObject({ running: 1, waiting: 0 });
    rel();
    expect(gate.stats()).toMatchObject({ running: 0 });
  });

  it("a run waits at most the queue time; a cancelled one leaves the queue", async () => {
    const gate = new SlotGate(1, 5, 150);
    const held = await gate.acquire("a");
    await expect(gate.acquire("late")).rejects.toMatchObject({ type: "Busy", message: expect.stringMatching(/no sandbox became free/) });
    const waiting = gate.acquire("gone");
    expect(gate.abandon("gone", "the caller left")).toBe(true);
    await expect(waiting).rejects.toMatchObject({ type: "Cancelled", message: "the caller left" });
    held();
    expect(gate.stats()).toMatchObject({ running: 0, waiting: 0 });
  });

  it("a run holds its slot to the end; with the queue full the next one fails as Busy", async () => {
    _resetIsolationForTests();
    closeRunner();
    process.env.FUNCTIONS_SANDBOX_MAX = "1"; process.env.FUNCTIONS_SANDBOX_QUEUE = "0";
    try {
      const code = (body: string) => ({ lang: "js" as const, files: { "index.js": `export async function execute(){ ${body} }` }, entry: { file: "index.js", fn: "execute" }, inputs: {} });
      const slow = runAdhoc(code("await m5.sleep(600); return m5.out.json({ slow: true });"), caller);
      await new Promise((r) => setTimeout(r, 150));
      const busy = await runAdhoc(code("return m5.out.json({ fast: true });"), caller);
      expect(busy.run.status).toBe("failed");
      expect(busy.run.error).toMatchObject({ type: "Busy" });
      const done = await slow;
      expect(done.run.status).toBe("done");
      const after = await runAdhoc(code("return m5.out.json({ again: true });"), caller);
      expect(after.run.status).toBe("done");
    } finally {
      delete process.env.FUNCTIONS_SANDBOX_MAX; delete process.env.FUNCTIONS_SANDBOX_QUEUE;
      closeRunner();
    }
  }, 30_000);
});

describe("tree memory under bwrap", () => {
  it("adds the descendants' resident memory (bwrap → init → node)", () => {
    const proc: Record<string, string> = {
      "/proc/10/statm": "100 10 0 0 0 0 0", "/proc/10/task/10/children": "11",
      "/proc/11/statm": "100 5 0 0 0 0 0", "/proc/11/task/11/children": "12 ",
      "/proc/12/statm": "999 1000 0 0 0 0 0", "/proc/12/task/12/children": "",
    };
    const read = (p: string) => { if (!(p in proc)) throw new Error("ENOENT"); return proc[p]; };
    expect(readRss(10, read)).toBe((10 + 5 + 1000) * 4096);
    expect(readRss(99, read)).toBe(0);
  });
});

describe("Pyodide's reach (F-03)", () => {
  async function py(code: string): Promise<Record<string, unknown>> {
    const r = await runAdhoc({ lang: "py", files: { "main.py": code }, entry: { file: "main.py", fn: "execute" }, inputs: {} }, caller);
    expect(r.run.error).toBeNull();
    return (r.value as { value: Record<string, unknown> }).value;
  }

  it("the Emscripten module is on the neutered list", () => {
    expect(NEUTERED).toEqual(expect.arrayContaining(["_module", "FS", "_api"]));
  });

  it("emptying sys.meta_path does not bring back js / pyodide_js / the host module", async () => {
    const out = await py(`
import sys
async def execute():
    out = {}
    sys.meta_path[:] = [f for f in sys.meta_path if getattr(f, "__name__", "") != "_Blocker"]
    out["blockers_left"] = sum(1 for f in sys.meta_path if getattr(f, "__name__", "") == "_Blocker")
    for name in ("js", "pyodide_js", "_m5host"):
        sys.modules.pop(name, None)
        try:
            m = __import__(name)
            out[name] = "imported"
            try:
                out[name + "_module"] = str(type(m._module))
            except Exception as e:
                out[name + "_module_err"] = type(e).__name__
        except Exception as e:
            out[name] = type(e).__name__
    try:
        import pyodide.code
        out["run_js"] = str(pyodide.code.run_js("1+1"))
    except Exception as e:
        out["run_js"] = type(e).__name__
    return m5.out.json(out)
`);
    // The prelude's blocker really was removed — what stops the imports is that nothing provides them.
    expect(out).toMatchObject({ blockers_left: 0, js: "ModuleNotFoundError", pyodide_js: "ModuleNotFoundError", _m5host: "ModuleNotFoundError" });
    expect(String(out.run_js)).not.toBe("2");
  }, 60_000);

  it("the SDK still works after the hardening", async () => {
    const out = await py("async def execute():\n    return m5.out.json({'h': m5.crypto.hash('sha256', 'x')[:8]})");
    expect(out).toEqual({ h: "2d711642" });
  }, 60_000);
});
