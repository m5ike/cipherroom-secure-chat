// @vitest-environment node
// 6.3 define — m5mobile.define in the Functions runtime (JS + Python) and in
// the editor's SDK surface. The operator's typed constants/variables reach a
// run as a per-run snapshot (materialized on the server); the sandbox exposes
// them read-only under m5mobile.define, and a `script` value stays as data
// ({ __m5script }), never executed.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "m5define-"));
process.env.FUNCTIONS_DB_FILE = join(dir, "functions.db");
process.env.FUNCTIONS_WARM = "0";

// The store snapshot: a define.json the DefineStore reads (name → typed node).
const defineFile = join(dir, "define.json");
process.env.DEFINE_FILE = defineFile;
writeFileSync(
  defineFile,
  JSON.stringify({
    version: 1,
    updatedAt: 1717000000000,
    defs: [
      { name: "greeting", kind: "constant", node: { type: "string", value: "ahoj" } },
      { name: "answer", kind: "constant", node: { type: "integer", value: 42 } },
      { name: "flag", kind: "variable", node: { type: "boolean", value: true } },
      { name: "config", kind: "constant", node: { type: "object", entries: [
        { key: "host", node: { type: "string", value: "example.com" } },
        { key: "port", node: { type: "integer", value: 8080 } },
      ] } },
      { name: "colors", kind: "constant", node: { type: "array", items: [
        { type: "string", value: "red" }, { type: "string", value: "green" },
      ] } },
      { name: "onScan", kind: "constant", node: { type: "script", value: "return 1 + 1;", lang: "js" } },
      // web-only and android-only: "both" (the runtime's scope) sees both.
      { name: "webOnly", kind: "constant", scope: "web", node: { type: "string", value: "w" } },
      { name: "androidOnly", kind: "constant", scope: "android", node: { type: "string", value: "a" } },
    ],
  }),
);

const { SDK_SPEC, MOBILE_SPEC, sdkCompletions, sdkDts } = await import("../server/functions/sdk-spec");
const { runAdhoc, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");
afterAll(() => closeRunner());

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: null, client: "c", lang: "en", tz: "UTC" };
const expectedScript = { __m5script: true, code: "return 1 + 1;", lang: "js" };

describe("m5mobile.define in the Functions runtime", () => {
  it("exposes the materialized values in JavaScript; a script stays data, the object is frozen", async () => {
    await functionsStore.ready();
    const code = [
      "export async function execute() {",
      "  const d = m5mobile.define;",
      "  return {",
      "    greeting: d.greeting, answer: d.answer, flag: d.flag,",
      "    config: d.config, colors: d.colors, script: d.onScan,",
      "    both: [d.webOnly, d.androidOnly],",
      "    frozen: Object.isFrozen(m5mobile.define) && Object.isFrozen(m5mobile),",
      "    keys: Object.keys(d).sort(),",
      "  };",
      "}",
    ].join("\n");
    const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
    expect(r.run.error).toBeNull();
    const v = (r.values[0] as { value: Record<string, unknown> }).value;
    expect(v.greeting).toBe("ahoj");
    expect(v.answer).toBe(42);
    expect(v.flag).toBe(true);
    expect(v.config).toEqual({ host: "example.com", port: 8080 });
    expect(v.colors).toEqual(["red", "green"]);
    expect(v.script).toEqual(expectedScript); // a script value is never auto-evaluated
    expect(v.both).toEqual(["w", "a"]); // scope "both" sees web and android
    expect(v.frozen).toBe(true);
    expect(v.keys).toEqual(["androidOnly", "answer", "colors", "config", "flag", "greeting", "onScan", "webOnly"]);
  }, 60_000);

  it("exposes the same values in Python by attribute and by item; a script stays data", async () => {
    const code = [
      "async def execute(**inputs):",
      "    d = m5mobile.define",
      "    return m5.out.json({",
      "        'greeting': d.greeting, 'greeting_item': d['greeting'],",
      "        'answer': d.answer, 'flag': d.flag,",
      "        'config': d.config, 'config_port': d['config']['port'],",
      "        'colors': d.colors, 'script': d.onScan,",
      "        'keys': sorted(d.keys()),",
      "    })",
      "",
    ].join("\n");
    const r = await runAdhoc({ lang: "py", files: { "index.py": code }, entry: { file: "index.py", fn: "execute" }, inputs: {} }, caller);
    expect(r.run.error).toBeNull();
    const v = (r.values[0] as { value: Record<string, unknown> }).value;
    expect(v.greeting).toBe("ahoj");
    expect(v.greeting_item).toBe("ahoj");
    expect(v.answer).toBe(42);
    expect(v.flag).toBe(true);
    expect(v.config).toEqual({ host: "example.com", port: 8080 });
    expect(v.config_port).toBe(8080);
    expect(v.colors).toEqual(["red", "green"]);
    expect(v.script).toEqual(expectedScript);
    expect(v.keys).toEqual(["androidOnly", "answer", "colors", "config", "flag", "greeting", "onScan", "webOnly"]);
  }, 120_000);
});

describe("the editor's SDK surface includes m5mobile.define", () => {
  it("MOBILE_SPEC describes define without colliding with m5 / m5adm", () => {
    expect(MOBILE_SPEC.map((o) => o.name)).toContain("define");
    // m5mobile is its own root, not folded into the m5.* parity surface.
    expect(SDK_SPEC.map((o) => o.name)).not.toContain("define");
  });
  it("completions offer m5mobile.define after typing m5mobile.", () => {
    const c = sdkCompletions();
    expect(c.some((e) => e.path === "m5mobile" && e.label === "define")).toBe(true);
  });
  it("the .d.ts declares const m5mobile with define", () => {
    const dts = sdkDts();
    expect(dts).toContain("const m5mobile:");
    expect(dts).toMatch(/define: Record<string, any>;/);
  });
});
