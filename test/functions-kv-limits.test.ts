// @vitest-environment node
// m5.session / m5.cache are bounded (6.7, audit N16): a value's size, a
// key's length, and the keys and bytes one session or cache scope may hold.
// Before, one model could write values of any size under any number of keys.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5kv-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { functionsStore, KV_LIMITS, KvLimitError } = await import("../server/functions/store");
const { runAdhoc, closeRunner } = await import("../server/functions/runner");

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

describe("N16 — key–value limits", () => {
  it("refuses a value over the size limit and a key over the length limit", () => {
    expect(() => functionsStore.cacheSet("model:kv", "big", "x".repeat(KV_LIMITS.valueBytes + 1), null)).toThrow(KvLimitError);
    expect(() => functionsStore.sessionSet("sess-kv", "k".repeat(KV_LIMITS.keyChars + 1), 1, null)).toThrow(KvLimitError);
    functionsStore.cacheSet("model:kv", "ok", { a: 1 }, null);
    expect(functionsStore.cacheGet("model:kv", "ok")).toEqual({ a: 1 });
  });

  it("caps the keys of a scope; overwriting an existing key still works", () => {
    const scope = "model:many";
    for (let i = 0; i < KV_LIMITS.keysPerScope; i++) functionsStore.cacheSet(scope, `k${i}`, i, null);
    expect(() => functionsStore.cacheSet(scope, "one-more", 1, null)).toThrow(/at most/);
    functionsStore.cacheSet(scope, "k0", "replaced", null);
    expect(functionsStore.cacheGet(scope, "k0")).toBe("replaced");
    // Another scope is not affected.
    functionsStore.cacheSet("model:other", "k", 1, null);
  });

  it("caps the bytes of a session", () => {
    const sid = "sess-bytes";
    const chunk = "y".repeat(KV_LIMITS.valueBytes - 16);
    let refused: unknown = null;
    for (let i = 0; i < 70 && !refused; i++) { try { functionsStore.sessionSet(sid, `b${i}`, chunk, null); } catch (err) { refused = err; } }
    expect(refused).toBeInstanceOf(KvLimitError);
    expect(functionsStore.sessionKeys(sid).length).toBeLessThanOrEqual(Math.floor(KV_LIMITS.bytesPerScope / KV_LIMITS.valueBytes) + 1);
  });

  it("a model sees the refusal as an m5 error with code kv-limit", async () => {
    const files = { "index.js": "export async function execute(){ try { await m5.cache.set('big', 'x'.repeat(1100000)); return m5.out.text('stored'); } catch (e) { return m5.out.text(e.code); } }" };
    const r = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
    expect((r.value as { text: string }).text).toBe("kv-limit");
  }, 30_000);
});
