// @vitest-environment node
// The SDK the editor describes (sdk-spec.ts) is the SDK a function gets:
// every object and member in the spec exists in JavaScript and in Python
// (5.3 adds m5.model, m5.browser and the new m5.out builders) — and Python
// has the 5.3 behaviour too: a list result, m5.model with its session.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5sdk-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { SDK_SPEC } = await import("../server/functions/sdk-spec");
const { runAdhoc, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");
afterAll(() => closeRunner());

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: null, client: "c", lang: "en", tz: "UTC" };
/** "await m5.crypto.aes_gcm.encrypt(…)" → ["crypto", "aes_gcm"]. */
const path = (sig: string) => { const m = /^(?:await\s+)?m5\.(\w+)(?:\.(\w+))?/.exec(sig); return m ? [m[1], m[2] ?? ""] : null; };

describe("the SDK spec and the preludes", () => {
  const pairs = (lang: "js" | "py") => SDK_SPEC.flatMap((o) => o.methods.map((m) => path(lang === "js" ? m.js : m.py)).filter((p): p is string[] => Boolean(p && p[1])));

  it("every member exists in JavaScript", async () => {
    await functionsStore.ready();
    const list = pairs("js");
    const code = `export async function execute() { const miss = []; for (const [o, k] of ${JSON.stringify(list)}) { if (!m5[o] || !(k in m5[o])) miss.push(o + "." + k); } return { miss }; }`;
    const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
    expect(r.run.error).toBeNull();
    expect((r.values[0] as { value: { miss: string[] } }).value.miss).toEqual([]);
    expect(list.length).toBeGreaterThan(80);
  }, 60_000);

  it("every member exists in Python; a list result and m5.model work there too", async () => {
    const list = pairs("py");
    const code = [
      "async def execute(**inputs):",
      `    miss = [o + "." + k for o, k in ${JSON.stringify(list)} if not hasattr(getattr(m5, o, None), k)]`,
      "    await m5.model.session.set(\"k\", 41)",
      "    return [m5.out.json({\"miss\": miss}), m5.out.buttons([{\"name\": \"b\", \"title\": \"B\"}]), {\"type\": \"flash\", \"text\": \"hi\"}, {\"type\": \"button\", \"data\": 1}]",
      "",
      "async def button(name, data=None, event=None, **inputs):",
      "    return m5.out.json({\"type\": m5.model.type, \"first\": m5.model.first[\"type\"], \"last\": m5.model.last[\"type\"], \"k\": await m5.model.session.get(\"k\"), \"name\": name, \"data\": data})",
      "",
    ].join("\n");
    const files = { "index.py": code };
    const r = await runAdhoc({ lang: "py", files, entry: { file: "index.py", fn: "execute" }, inputs: {} }, caller);
    expect(r.run.error).toBeNull();
    expect(r.values.map((o) => o.type)).toEqual(["json", "button", "flash", "json"]); // { type: "button", data } is data
    expect((r.values[0] as { value: { miss: string[] } }).value.miss).toEqual([]);
    const b = await runAdhoc({ lang: "py", files, entry: { file: "index.py", fn: "button" }, inputs: { name: "b", data: { n: 1 }, event: { type: "click" } }, chainId: r.chain }, caller);
    expect(b.run.error).toBeNull();
    expect((b.values[0] as { value: unknown }).value).toEqual({ type: "button", first: "execute", last: "execute", k: 41, name: "b", data: { n: 1 } });
  }, 120_000);
});
