// @vitest-environment node
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

const { runAdhoc, closeRunner, runEvents, answerRun } = await import("../server/functions/runner");
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

describe("live interaction", () => {
  it("asks with m5.prompt / m5.form, waits, and continues with the answer", async () => {
    const seen: Array<{ kind: string }> = [];
    const onRun = (ev: { type?: string; runId?: string; interaction?: { id: string; kind: string } }) => {
      if (ev.type === "interaction" && ev.interaction && ev.runId) {
        seen.push({ kind: ev.interaction.kind });
        const value = ev.interaction.kind === "form" ? { name: "Mike" } : "go";
        setTimeout(() => answerRun(ev.runId!, ev.interaction!.id, value), 20);
      }
    };
    runEvents.on("run", onRun);
    try {
      const files = { "index.js": "export async function execute(){ const a = await m5.prompt({ text: 'x', choices: ['go','no'] }); const f = await m5.form({ fields: [{ name: 'name' }] }); return m5.out.json({ a, name: f.name }); }" };
      const r = await runAdhoc({ lang: "js", files, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 3000 } }, caller);
      expect(r.run.status).toBe("done");
      expect((r.value as { value: { a: string; name: string } }).value).toEqual({ a: "go", name: "Mike" });
      expect(seen.map((s) => s.kind)).toEqual(["prompt", "form"]);
    } finally {
      runEvents.off("run", onRun);
    }
  }, 30_000);
});

describe("m5.http", () => {
  it("blocks a private address by default, and fetches when allowed", async () => {
    const http = await import("node:http");
    const srv = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ hi: 1 })); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const blocked = await runAdhoc({ lang: "js", files: { "index.js": `export async function execute(){ try { await m5.http.get('http://127.0.0.1:${port}/'); return m5.out.text('open'); } catch(e){ return m5.out.text(e.code); } }` }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
      expect((blocked.value as { text: string }).text).toBe("ssrf");
      process.env.FUNCTIONS_HTTP_ALLOW_LOCAL = "1";
      const ok = await runAdhoc({ lang: "js", files: { "index.js": `export async function execute(){ const r = await m5.http.get('http://127.0.0.1:${port}/'); return m5.out.json({ status: r.status, hi: r.json.hi }); }` }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);
      expect((ok.value as { value: { status: number; hi: number } }).value).toEqual({ status: 200, hi: 1 });
    } finally {
      delete process.env.FUNCTIONS_HTTP_ALLOW_LOCAL;
      srv.close();
    }
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
