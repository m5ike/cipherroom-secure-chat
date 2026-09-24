// The runner and the sandbox, end to end (server/functions/runner.ts + the
// sandbox process, 4.15): a JS and a Python function actually run in a child
// process, the m5 SDK works, host calls (cache) reach the store, and the
// limits stop a runaway. These spawn real processes, so they are slower.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5run-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { runAdhoc, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

describe("running JavaScript", () => {
  it("runs the entry, uses the SDK, and reaches the cache", async () => {
    const files = { "index.js": "import { twice } from './lib.js';\nexport async function execute({ n }) {\n  m5.log.info('go', { n });\n  const c = await m5.cache.incr('runs');\n  return m5.out.json({ n: twice(n), hash: m5.crypto.hash('sha256', 'x').length, id: m5.id.uuid().length, c });\n}", "lib.js": "export const twice = (x) => x * 2;" };
    const r = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: { n: 21 } }, caller);
    expect(r.run.status).toBe("done");
    expect(r.value).toMatchObject({ type: "json" });
    expect((r.value as { value: { n: number; hash: number; id: number; c: number } }).value).toEqual({ n: 42, hash: 64, id: 36, c: 1 });
  }, 30_000);

  it("reports a thrown error as a failed run, not a throw", async () => {
    const r = await runAdhoc({ lang: "js", files: { "index.js": "export async function execute(){ throw new Error('boom'); }" }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
    expect(r.run.status).toBe("failed");
    expect(r.run.error?.message).toContain("boom");
  }, 30_000);

  it("stops an endless loop at the time limit", async () => {
    const r = await runAdhoc({ lang: "js", files: { "index.js": "export async function execute(){ while(true){} }" }, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 1000, stepMs: 500 } }, caller);
    expect(["timed-out", "failed"]).toContain(r.run.status);
    expect(r.run.error?.type).toMatch(/Time|Cancel/);
  }, 30_000);
});

describe("running Python", () => {
  it("runs the entry with keyword inputs and the SDK", async () => {
    const files = { "main.py": "from lib import twice\n\nasync def execute(n):\n    m5.log.info('go', n=n)\n    c = await m5.cache.incr('runs')\n    return m5.out.json({'n': twice(n), 'v': m5.sys.version, 'c': c})", "lib.py": "def twice(x):\n    return x * 2" };
    const r = await runAdhoc({ lang: "py", files, entry: { file: "main.py", fn: "execute" }, inputs: { n: 21 } }, caller);
    expect(r.run.status).toBe("done");
    expect((r.value as { value: { n: number; c: number } }).value.n).toBe(42);
  }, 60_000);
});
