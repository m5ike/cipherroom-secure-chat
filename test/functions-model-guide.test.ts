// @vitest-environment node
// 6.11: a model's icon and usage guide (validated, migrated into an older
// database, listed with the commands), what a call with wrong parameters
// answers (every bad input, the model's definition, a usage line — as JSON
// and as the SSE error), a streamed run that ends with exactly one done or
// error, a caller who leaves mid-run (the run is cancelled, its questions
// end), and JSON errors for bodies that never reach a handler.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";

const DATA = mkdtempSync(join(tmpdir(), "m5guide-"));
const DB = join(DATA, "functions.db");
process.env.DATA_DIR = DATA;
process.env.FUNCTIONS_DB_FILE = DB;
process.env.ENABLE_FUNCTIONS = "1";
process.env.FUNCTIONS_WARM = "0";

// A database from before 6.11: its models table has no icon / usage columns.
const { loadSqliteDriver } = await import("../server/storage/db");
{
  const Driver = (await loadSqliteDriver())!;
  const db = new Driver(DB);
  db.exec(`CREATE TABLE models (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, keyword TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
    entry TEXT NOT NULL, on_event TEXT NOT NULL DEFAULT '', runtime TEXT NOT NULL DEFAULT 'auto',
    inputs TEXT NOT NULL DEFAULT '[]', outputs TEXT NOT NULL DEFAULT '[]', limits TEXT NOT NULL DEFAULT '{}',
    executors TEXT NOT NULL DEFAULT '{}', groups TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '',
    endpoints TEXT NOT NULL DEFAULT '[]', grants TEXT NOT NULL DEFAULT '{}')`);
  db.prepare("INSERT INTO models (id, name, keyword, entry, created_at, updated_at) VALUES ('old-one', 'Old', 'old', 'x@1.0.0:index.js#execute', 1, 1)").run();
  db.close();
}

const { functionsStore, fingerprint } = await import("../server/functions/store");
const { registerFunctionsRoutes } = await import("../server/functions/routes");
const { execute, closeRunner, cancelRun, openInteractions, runEvents, RunRefused } = await import("../server/functions/runner");
const { saveModel, PackageError } = await import("../server/functions/packages");
const { validateInputs, inputExpectation } = await import("../server/functions/inputs");
const { usageLine } = await import("../server/functions/guide");
const { isModelIcon } = await import("../server/functions/types");

const CODE = `
export async function execute(p) { return m5.out.text("ok " + p.n + " " + (p.host || "")); }
export async function ask() { const a = await m5.prompt({ text: "Your name?" }); return m5.out.text("hi " + a); }
export async function boom() { throw new Error("kaboom"); }
`;

let server: Server;
let base = "";
beforeAll(async () => {
  await functionsStore.ready();
  const now = Date.now();
  const files = { "index.js": CODE };
  functionsStore.savePackage({ id: "pkg_g", name: "guide", language: "js", description: "", draft: null, createdAt: now, updatedAt: now, updatedBy: "op" });
  functionsStore.saveVersion({ packageId: "pkg_g", version: "1.0.0", manifest: { name: "guide", version: "1.0.0", language: "js", main: "index.js", dependencies: {}, description: "" }, files, fingerprint: fingerprint(files), status: "published", test: null, createdAt: now, createdBy: "op", publishedAt: now });
  const chat = { chat: { enabled: true, visibility: "caller" as const }, console: { enabled: true } };
  saveModel({
    id: "g-check", name: "Checker", keyword: "check", entry: "guide@1.0.0:index.js#execute", runtime: "server", enabled: true, executors: chat,
    icon: "shield-check", usage: "/check 5 example.com — checks a host\r\n/check n=7   ",
    inputs: [
      { name: "n", type: "integer", label: "Count", required: true, min: 1, max: 10, help: "how many" },
      { name: "host", type: "hostname", label: "Host" },
      { name: "code", type: "string", pattern: "^[A-Z]{3}$" },
    ],
  }, "op");
  saveModel({ id: "g-ask", name: "Asker", keyword: "ask", entry: "guide@1.0.0:index.js#ask", runtime: "server", enabled: true, executors: chat, icon: "🙋" }, "op");
  saveModel({ id: "g-boom", name: "Boom", keyword: "boom", entry: "guide@1.0.0:index.js#boom", runtime: "server", enabled: true, executors: chat }, "op");
  const app = express();
  registerFunctionsRoutes(app);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server?.close(); closeRunner(); });

const post = (path: string, body: unknown, init: RequestInit = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init });

type Sse = { event: string; data: Record<string, unknown> };
function parseSse(text: string): Sse[] {
  return text.split("\n\n").map((b) => b.trim()).filter((b) => b && !b.startsWith(":")).map((b) => {
    const event = /^event: (.*)$/m.exec(b)?.[1] ?? "";
    const data = /^data: (.*)$/m.exec(b)?.[1] ?? "null";
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  });
}
const streamAll = async (body: Record<string, unknown>) => parseSse(await (await post("/api/functions/run", { ...body, stream: true })).text());
const terminal = (evs: Sse[]) => evs.filter((e) => e.event === "done" || e.event === "error");
const until = async <T>(f: () => T | null | undefined | false, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 50)); }
};

describe("a model's icon and usage", () => {
  it("an icon is a lucide name or one emoji", () => {
    for (const ok of ["mail", "phone-call", "dice-5", "📞", "🇨🇿", "1️⃣", "👩‍💻", "✉️"]) expect(isModelIcon(ok), ok).toBe(true);
    for (const bad of ["", "Mail", "a b", "x".repeat(41), "📞📞", "ab📞", "<svg>", "é"]) expect(isModelIcon(bad), bad).toBe(false);
  });

  it("is validated and cleaned on save", () => {
    const m = functionsStore.model("g-check")!;
    expect(m.icon).toBe("shield-check");
    expect(m.usage).toBe("/check 5 example.com — checks a host\n/check n=7"); // CRLF and trailing blanks gone
    expect(() => saveModel({ id: "g-check", icon: "Not An Icon" }, "op")).toThrow(PackageError);
    expect(() => saveModel({ id: "g-check", icon: "Not An Icon" }, "op")).toThrow(/lucide icon name/);
    expect(() => saveModel({ id: "g-check", usage: "x".repeat(501) }, "op")).toThrow(/at most 500/);
    // A save that does not send them keeps them; "" clears them (the app then picks an icon by the keyword).
    expect(saveModel({ id: "g-check", summary: "Checks" }, "op").icon).toBe("shield-check");
    const cleared = saveModel({ id: "g-ask", icon: "" }, "op");
    expect(cleared.icon).toBe("");
    saveModel({ id: "g-ask", icon: "🙋" }, "op");
    expect(functionsStore.model("g-ask")!.icon).toBe("🙋");
  });

  it("an older database gets the columns (empty)", () => {
    const old = functionsStore.model("old-one")!;
    expect(old).toMatchObject({ id: "old-one", icon: "", usage: "" });
  });

  it("GET /commands lists them, with the inputs' checks", async () => {
    const d = await (await fetch(`${base}/api/functions/commands`)).json() as { commands: Array<Record<string, unknown>> };
    const check = d.commands.find((c) => c.keyword === "check")!;
    expect(check).toMatchObject({ keyword: "check", name: "Checker", icon: "shield-check", usage: expect.stringContaining("/check 5 example.com"), model: "g-check" });
    expect(check.inputs).toEqual([
      { name: "n", type: "integer", label: "Count", help: "how many", required: true, min: 1, max: 10 },
      { name: "host", type: "hostname", label: "Host", required: false },
      { name: "code", type: "string", required: false, pattern: "^[A-Z]{3}$" },
    ]);
    expect(d.commands.find((c) => c.keyword === "boom")).toMatchObject({ icon: "", usage: "" });
  });
});

describe("wrong parameters", () => {
  it("every bad input is named, with what it expects", () => {
    const specs = functionsStore.model("g-check")!.inputs;
    let err: InstanceType<typeof RunRefused> | null = null;
    try { validateInputs(specs, { n: "40", host: "not a host", code: "abc" }); } catch (e) { err = e as InstanceType<typeof RunRefused>; }
    expect(err).toBeInstanceOf(RunRefused);
    expect(err!.code).toBe("bad-input");
    expect(err!.message).toBe("Count: must be at most 10; Host: must be a hostname; code: does not match the required pattern");
    expect(err!.details?.problems).toEqual([
      { input: "n", label: "Count", problem: "range", expected: "a whole number 1–10", message: "must be at most 10" },
      { input: "host", label: "Host", problem: "type", expected: "a host name (example.com)", message: "must be a hostname" },
      { input: "code", label: "code", problem: "pattern", expected: "text matching ^[A-Z]{3}$", message: "does not match the required pattern" },
    ]);
    expect(inputExpectation({ name: "to", type: "string", pattern: "^\\+[1-9][0-9]{6,14}$" })).toBe("a phone number in international form (+420…)");
    expect(usageLine(functionsStore.model("g-check")!)).toBe("/check <n> [host] [code]");
  });

  it("as JSON: 400 with the problems, the model as a command and its usage line", async () => {
    const res = await post("/api/functions/run", { keyword: "check", inputs: { host: "x y" } });
    expect(res.status).toBe(400);
    const d = await res.json();
    expect(d).toMatchObject({
      ok: false, code: "bad-input", message: "Count: is required; Host: must be a hostname",
      problems: [
        { input: "n", label: "Count", problem: "missing", expected: "a whole number 1–10", message: "is required" },
        { input: "host", label: "Host", problem: "type", expected: "a host name (example.com)", message: "must be a hostname" },
      ],
      command: { keyword: "check", name: "Checker", icon: "shield-check", usage: expect.stringContaining("/check 5"), inputs: expect.arrayContaining([expect.objectContaining({ name: "n", min: 1, max: 10, required: true })]) },
      usageLine: "/check <n> [host] [code]",
    });
  });

  it("as the stream's one error event (no start)", async () => {
    const evs = await streamAll({ keyword: "check", inputs: { n: "zero" } });
    expect(evs.map((e) => e.event)).toEqual(["error"]);
    expect(evs[0].data).toMatchObject({ code: "bad-input", problems: [{ input: "n", problem: "type" }], command: { keyword: "check" }, usageLine: "/check <n> [host] [code]" });
  });
});

describe("a streamed run ends once", () => {
  it("a good run: start … done", async () => {
    const evs = await streamAll({ keyword: "check", inputs: { n: 3, host: "example.com" } });
    expect(evs[0]).toMatchObject({ event: "start", data: { keyword: "check", icon: "shield-check" } });
    expect(terminal(evs)).toHaveLength(1);
    expect(evs.at(-1)).toMatchObject({ event: "done", data: { status: "done", icon: "shield-check", outputs: [{ type: "text", text: "ok 3 example.com" }] } });
  }, 30_000);

  it("a function that throws: done, with its error", async () => {
    const evs = await streamAll({ keyword: "boom", inputs: {} });
    expect(terminal(evs).map((e) => e.event)).toEqual(["done"]);
    expect(evs.at(-1)!.data).toMatchObject({ status: "failed", error: { message: expect.stringContaining("kaboom") } });
  }, 30_000);

  it("a run that cannot start: one error", async () => {
    saveModel({ id: "g-gone", name: "Gone", keyword: "gone", entry: "guide@1.0.0:index.js#execute", runtime: "server", enabled: true, executors: { chat: { enabled: true, visibility: "caller" }, console: { enabled: true } } }, "op");
    // The package version disappears under the model.
    functionsStore.deleteVersion("pkg_g", "1.0.0");
    try {
      const evs = await streamAll({ keyword: "gone", inputs: {} });
      expect(evs.map((e) => e.event)).toEqual(["start", "error"]);
      expect(evs[1].data).toMatchObject({ code: "no-package" });
    } finally {
      const now = Date.now();
      functionsStore.saveVersion({ packageId: "pkg_g", version: "1.0.0", manifest: { name: "guide", version: "1.0.0", language: "js", main: "index.js", dependencies: {}, description: "" }, files: { "index.js": CODE }, fingerprint: fingerprint({ "index.js": CODE }), status: "published", test: null, createdAt: now, createdBy: "op", publishedAt: now });
    }
  }, 30_000);
});

describe("the caller leaves", () => {
  it("mid-run: the question ends and the run is cancelled (the response's close, not the request's)", async () => {
    const ac = new AbortController();
    const res = await post("/api/functions/run", { keyword: "ask", inputs: {}, stream: true }, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (!/event: interaction/.test(text)) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
    const runId = String(parseSse(text).find((e) => e.event === "start")!.data.runId);
    expect(openInteractions(runId)).toHaveLength(1);
    ac.abort();
    const run = await until(() => { const r = functionsStore.run(runId); return r && r.status !== "running" ? r : null; });
    expect(run.status).toBe("cancelled");
    expect(openInteractions(runId)).toEqual([]);
  }, 30_000);

  it("a plain JSON run too: the caller aborts, the run is cancelled", async () => {
    let runId = "";
    const onRun = (ev: { type?: string; runId?: string }) => { if (ev.type === "interaction" && ev.runId) runId = ev.runId; };
    runEvents.on("run", onRun);
    try {
      const ac = new AbortController();
      const req = post("/api/functions/run", { keyword: "ask", inputs: {} }, { signal: ac.signal }).catch((e: Error) => e);
      await until(() => runId);
      ac.abort();
      expect(await req).toBeInstanceOf(Error);
      const run = await until(() => { const r = functionsStore.run(runId); return r && r.status !== "running" ? r : null; });
      expect(run.status).toBe("cancelled");
    } finally { runEvents.off("run", onRun); }
  }, 30_000);

  it("before the sandbox has the run: it does not start", async () => {
    expect(cancelRun("run_early", "the caller left")).toBe(false);
    const out = await execute(functionsStore.model("g-ask")!, {}, { kind: "guest", account: "", name: "guest", groups: [], room: null, client: "c", lang: "en", tz: "UTC" }, { executor: "chat", runId: "run_early" });
    expect(out.run.status).toBe("cancelled");
    expect(out.run.error).toMatchObject({ type: "Cancelled", message: "the caller left" });
    expect(out.handled).toBeUndefined();
  }, 30_000);
});

describe("errors before a handler", () => {
  it("a body that is not JSON: 400 JSON with a code", async () => {
    const res = await post("/api/functions/run", "{nope");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ ok: false, code: "bad-json", message: "The request body is not valid JSON." });
  });

  it("an unknown command: 404 JSON with a code", async () => {
    const res = await post("/api/functions/run", { keyword: "nothing-here" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "no-command" });
  });
});
