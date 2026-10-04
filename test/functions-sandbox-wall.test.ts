// @vitest-environment node
// The sandbox's first wall (6.7, audit V1). Before 6.7 the documented Node
// permission model was never switched on: a Python function reached the host
// bridge's JsProxy (`m5.<fn>.__globals__["_h"]`), took `.constructor.constructor`
// (= JavaScript's Function), compiled `import('node:fs')` and read any file of
// the server — storage.key, functions-adm.key, .env. Now the child runs with
// --permission (reads only its own script and interpreter, writes nothing, no
// processes/workers/addons), --disallow-code-generation-from-strings, and the
// code constructors are sealed off the function prototypes.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5wall-")));
process.env.FUNCTIONS_DB_FILE = join(dir, "functions.db");
process.env.FUNCTIONS_WARM = "0";
const SECRET = join(dir, "storage.key");
writeFileSync(SECRET, "HOST-FILE-CONTENT");

const { runAdhoc, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");
const { sandboxArgs, sandboxPaths } = await import("../server/functions/sandbox/pool");

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

async function py(code: string): Promise<Record<string, unknown>> {
  const r = await runAdhoc({ lang: "py", files: { "main.py": code }, entry: { file: "main.py", fn: "execute" }, inputs: {} }, caller);
  expect(r.run.status).toBe("done");
  return (r.value as { value: Record<string, unknown> }).value;
}

describe("the sandbox command line", () => {
  it("runs under the permission model, reads only its own files, compiles no strings", async () => {
    const paths = await sandboxPaths();
    for (const lang of ["js", "py"] as const) {
      const args = sandboxArgs(lang, paths, 128);
      const flags = args.slice(0, args.indexOf(paths.script));
      expect(flags).toContain("--permission");
      expect(flags).toContain("--disallow-code-generation-from-strings");
      expect(flags.filter((f) => f.startsWith("--allow-")).sort()).toEqual([`--allow-fs-read=${paths.script}`, `--allow-fs-read=${lang === "py" ? paths.pyodide : paths.quickjs}`].sort());
    }
  });

  it("a process started with those flags cannot read, write, spawn or compile", async () => {
    const paths = await sandboxPaths();
    const probe = join(dir, "probe.cjs");
    writeFileSync(probe, `
      const out = {};
      const fs = require("node:fs");
      const t = (k, f) => { try { out[k] = String(f()).slice(0, 40); } catch (e) { out[k] = "denied:" + (e.code || e.name); } };
      t("read", () => fs.readFileSync(${JSON.stringify(SECRET)}, "utf8"));
      t("write", () => fs.writeFileSync(${JSON.stringify(join(dir, "written.txt"))}, "x"));
      t("spawn", () => require("node:child_process").spawnSync("true").status);
      t("worker", () => new (require("node:worker_threads").Worker)("1", { eval: true }));
      t("eval", () => Function("return 1+1")());
      t("interpreter", () => fs.statSync(${JSON.stringify(join(paths.pyodide, "package.json"))}).isFile());
      process.stdout.write(JSON.stringify(out));
    `);
    // The probe stands in for the sandbox script (same flags, its own path allowed).
    const args = sandboxArgs("py", { ...paths, script: probe }, 128);
    const r = spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    const out = JSON.parse(r.stdout) as Record<string, string>;
    expect(out.read).toMatch(/^denied:ERR_ACCESS_DENIED/);
    expect(out.write).toMatch(/^denied:ERR_ACCESS_DENIED/);
    expect(out.spawn).toMatch(/^denied:ERR_ACCESS_DENIED/);
    expect(out.worker).toMatch(/^denied:ERR_ACCESS_DENIED/);
    expect(out.eval).toBe("denied:EvalError");
    expect(out.interpreter).toBe("true");
    expect(existsSync(join(dir, "written.txt"))).toBe(false);
  });
});

describe("Python cannot reach the host through the JS bridge", () => {
  it("the audit's probe (host bridge → Function → import('node:fs')) no longer reads a host file", async () => {
    const out = await py(`
async def execute():
    out = {}
    h = m5.crypto.hash.__globals__["_h"]
    out["host_bridge"] = str(type(h))
    for label, get in (("bridge", lambda: h.constructor.constructor), ("bridge_fn", lambda: h.sync.constructor)):
        try:
            F = get()
            out[label + "_eval"] = F("return 1+1")()
        except Exception as e:
            out[label + "_eval_err"] = type(e).__name__
        try:
            fs = await F("return import('node:fs')")()
            out[label + "_fs"] = fs.readFileSync(${JSON.stringify(SECRET)}, "utf8")
        except Exception as e:
            out[label + "_fs_err"] = type(e).__name__
    return m5.out.json(out)
`);
    expect(JSON.stringify(out)).not.toContain("HOST-FILE-CONTENT");
    expect(out.bridge_eval).toBeUndefined();
    expect(out.bridge_fn_eval).toBeUndefined();
    expect(out.bridge_fs).toBeUndefined();
    expect(out.bridge_fn_fs).toBeUndefined();
  }, 60_000);

  it("the async and generator constructors are sealed too", async () => {
    const out = await py(`
async def execute():
    h = m5.crypto.hash.__globals__["_h"]
    out = {}
    try:
        out["name"] = h.sync.constructor.name
    except Exception as e:
        out["name_err"] = type(e).__name__
    try:
        h.sync.constructor("return 1")
        out["called"] = True
    except Exception as e:
        out["call_err"] = str(e)[:120]
    return m5.out.json(out)
`);
    expect(out.name).toBe("Function");
    expect(out.called).toBeUndefined();
    expect(String(out.call_err)).toMatch(/not available in the sandbox|Code generation/);
  }, 60_000);

  it("JavaScript and Python functions still run", async () => {
    const js = await runAdhoc({ lang: "js", files: { "index.js": "export async function execute({ n }){ return m5.out.json({ n: n * 2, h: m5.crypto.hash('sha256', 'x').length, af: typeof (async () => 1) }); }" }, entry: { file: "index.js", fn: "execute" }, inputs: { n: 2 } }, caller);
    expect(js.run.status).toBe("done");
    expect((js.value as { value: unknown }).value).toEqual({ n: 4, h: 64, af: "function" });
    const p = await py("import json, re\nasync def execute():\n    return m5.out.json({'n': len(re.findall('a', 'banana')), 'h': len(m5.crypto.hash('sha256', 'x'))})");
    expect(p).toEqual({ n: 3, h: 64 });
  }, 60_000);
});
