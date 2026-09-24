// @vitest-environment node
//
// The HTTP side of the AI & speech layer (4.14): the app's endpoints
// (status in its states, chat as JSON and as a stream of Server-Sent Events,
// a cancelled stream, the pre-4.14 call, speech) and the console's (roles:
// keys, prices, limits and content are the owner's; the playground is not
// held to the limits; the journal as a list, a detail and CSV).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STORAGE_MASTER_KEY = "b".repeat(64);

import { registerAiRoutes } from "../server/ai/routes";
import { registerAiAdminRoutes } from "../server/ai/admin-routes";
import { aiConfig, saveAiConfig } from "../server/ai/config";
import { journal } from "../server/ai/journal";
import { setPluginSwitches } from "../server/plugins/settings";
import { json, mockProvider, openAiStream, sse, type MockProvider } from "./helpers/mock-ai";

const TOKENS: Record<string, { name: string; role: "owner" | "operator" | "auditor" }> = {
  own: { name: "olga", role: "owner" }, ops: { name: "otto", role: "operator" }, aud: { name: "anna", role: "auditor" },
};
const ENV = ["ENABLE_AI", "ENABLE_SPEECH", "DATA_DIR", "PLUGINS_SETTINGS_FILE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_URL", "HF_API_KEY", "ELEVENLABS_API_KEY"];
const saved: Record<string, string | undefined> = {};
let mock: MockProvider;
let server: Server;
let base = "";

beforeAll(async () => {
  mock = await mockProvider();
  const app = express();
  app.use(express.json());
  // As the admin service does: who is asking, and their role, in res.locals.
  app.use("/admin", (req: Request, res: Response, next: NextFunction) => {
    const who = TOKENS[(req.header("authorization") ?? "").replace(/^Bearer /, "")];
    if (!who) return res.status(401).json({ ok: false });
    const needed = req.method === "GET" ? "auditor" : "operator";
    if (needed === "operator" && who.role === "auditor") return res.status(403).json({ ok: false });
    res.locals.adminName = who.name;
    res.locals.adminRole = who.role;
    next();
  });
  registerAiRoutes(app);
  registerAiAdminRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await mock.close(); journal.reset(); });
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  const dir = mkdtempSync(join(tmpdir(), "m5-ai-routes-"));
  process.env.DATA_DIR = dir;
  process.env.PLUGINS_SETTINGS_FILE = join(dir, "plugins.json");
  mock.seen.length = 0;
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function call(method: string, path: string, opts: { token?: string; body?: unknown; signal?: AbortSignal } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { status: r.status, body, text, type: r.headers.get("content-type") ?? "" };
}

/** The events of a Server-Sent Events body. */
function events(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split("\n\n").filter((b) => b.includes("data:")).map((b) => ({
    event: /^event: (.*)$/m.exec(b)?.[1] ?? "",
    data: JSON.parse(/^data: (.*)$/m.exec(b)![1]) as Record<string, unknown>,
  }));
}

/** A provider for everyone (guests too) through the console, as the owner would add it. */
async function addProvider(extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/admin/ai/providers", { token: "own", body: { type: "openai-compatible", label: "Local AI", baseUrl: `${mock.url}/v1`, key: "sk-secret-9876", groups: ["guest", "user"], model: "m1", ...extra } });
  expect(r.status).toBe(200);
  return r.body;
}
const reply = () => mock.on("POST /v1/chat/completions", (q, res) => {
  const b = q.body as { stream?: boolean };
  if (b.stream) return sse(res, openAiStream("Dobrý den!", { model: "m1" }));
  json(res, 200, { model: "m1", choices: [{ message: { content: "Dobrý den!" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
});

describe("the app's endpoints", () => {
  it("status: off, no model, sign in, no limit, ready", async () => {
    expect((await call("GET", "/api/ai/status")).body).toMatchObject({ state: "off", enabled: false, models: [] });
    setPluginSwitches({ ai: true }, "t");
    expect((await call("GET", "/api/ai/status")).body.state).toBe("no-model");
    await addProvider({ groups: ["user"] });
    expect((await call("GET", "/api/ai/status")).body.state).toBe("sign-in");
    const c = aiConfig();
    saveAiConfig({ ...c, providers: c.providers.map((p) => ({ ...p, groups: ["guest", "user"] })) }, "t");
    expect((await call("GET", "/api/ai/status")).body.state).toBe("no-limit");
    expect((await call("PUT", "/admin/ai/limits", { token: "own", body: { monthlyTokens: 100000 } })).status).toBe(200);
    const s = (await call("GET", "/api/ai/status")).body;
    expect(s).toMatchObject({ state: "ready", enabled: true, default: "local-ai/m1", models: [{ ref: "local-ai/m1", label: "m1", provider: "Local AI", reasoning: false }] });
    expect(s.connectors).toEqual([{ id: "local-ai/m1", label: "Local AI", model: "m1" }]);
  });

  it("chat: JSON, a stream of events, refusals in words, the pre-4.14 call", async () => {
    setPluginSwitches({ ai: true }, "t");
    await addProvider();
    reply();
    const refused = await call("POST", "/api/ai/chat", { body: { messages: [{ role: "user", content: "Ahoj" }] } });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ ok: false, code: "budget-unset" });
    await call("PUT", "/admin/ai/limits", { token: "own", body: { monthlyTokens: 100000 } });
    const plain = await call("POST", "/api/ai/chat", { body: { messages: [{ role: "user", content: "Ahoj" }], system: "Mluv česky." } });
    expect(plain.body).toMatchObject({ ok: true, text: "Dobrý den!", ref: "local-ai/m1", usage: { input: 10, output: 3 } });
    expect((mock.seen.at(-1)!.body as { messages: unknown[] }).messages[0]).toEqual({ role: "system", content: "Mluv česky." });
    const streamed = await call("POST", "/api/ai/chat", { body: { messages: [{ role: "user", content: "Ahoj" }], stream: true } });
    expect(streamed.type).toMatch(/^text\/event-stream/);
    const ev = events(streamed.text);
    expect(ev.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe("Dobrý den!");
    expect(ev.at(-1)).toMatchObject({ event: "done", data: { text: "Dobrý den!", usage: { input: 20, output: 5 } } });
    expect((await call("POST", "/api/ai/chat", { body: { messages: [{ role: "assistant", content: "x" }] } })).status).toBe(400);
    const old = await call("POST", "/api/ai/complete", { body: { messages: [{ role: "system", content: "S" }, { role: "user", content: "Ahoj" }] } });
    expect(old.body).toEqual({ ok: true, text: "Dobrý den!", model: "m1", connector: "local-ai/m1" });
    // The operator's guidance comes first.
    await call("PUT", "/admin/ai/defaults", { token: "ops", body: { system: "Jsi asistent M5cet." } });
    await call("POST", "/api/ai/chat", { body: { messages: [{ role: "user", content: "Ahoj" }], system: "Stručně." } });
    expect((mock.seen.at(-1)!.body as { messages: unknown[] }).messages[0]).toEqual({ role: "system", content: "Jsi asistent M5cet.\n\nStručně." });
  });

  it("a provider's failure is an error event; leaving mid-stream cancels the call", async () => {
    setPluginSwitches({ ai: true }, "t");
    await addProvider();
    await call("PUT", "/admin/ai/limits", { token: "own", body: { monthlyTokens: null } });
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 500, { error: { message: "boom" } }));
    const failed = events((await call("POST", "/api/ai/chat", { body: { messages: [{ role: "user", content: "x" }], stream: true } })).text);
    expect(failed).toEqual([{ event: "error", data: { status: 502, code: "provider", message: "Local AI 500: boom" } }]);
    mock.on("POST /v1/chat/completions", (_q, res) => sse(res, openAiStream("a very long answer indeed, piece by piece", { noUsage: true }), 60));
    const controller = new AbortController();
    const res = await fetch(`${base}/api/ai/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }], stream: true }), signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await expect.poll(() => journal.list({ limit: 1 })[0]?.status, { timeout: 5000 }).toBe("cancelled");
  });

  it("speech: status lists what may be used; synthesis returns audio", async () => {
    await addProvider();
    const c = aiConfig();
    saveAiConfig({ ...c, providers: c.providers.map((p) => ({ ...p, models: [...p.models, { id: "tts-1", label: "", kind: "tts", enabled: true, caps: p.models[0].caps, price: null, source: "manual" }] })) }, "t");
    expect((await call("GET", "/api/speech/status")).body).toMatchObject({ tts: { enabled: false, connectors: [] } });
    setPluginSwitches({ speech: true }, "t");
    expect((await call("GET", "/api/speech/status")).body).toMatchObject({ tts: { enabled: true, connectors: [{ id: "local-ai/tts-1", label: "Local AI · tts-1" }] }, stt: { enabled: false } });
    mock.on("POST /v1/audio/speech", (_q, res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.from("ID3")); });
    const t = await call("POST", "/api/speech/tts", { body: { text: "Ahoj" } });
    expect(t.body).toEqual({ ok: true, audioBase64: Buffer.from("ID3").toString("base64"), mime: "audio/mpeg", connector: "local-ai/tts-1" });
  });
});

describe("the console's endpoints", () => {
  it("never shows a key; keys, addresses and removing are the owner's", async () => {
    expect((await call("POST", "/admin/ai/providers", { token: "ops", body: { type: "ollama" } })).status).toBe(403);
    const o = await addProvider();
    expect(JSON.stringify(o)).not.toContain("sk-secret-9876");
    const p = (o.providers as Array<Record<string, unknown>>)[0];
    expect(p).toMatchObject({ id: "local-ai", hasKey: true, keyHint: "9876", keyState: "ok", effectiveBaseUrl: `${mock.url}/v1` });
    expect(p).not.toHaveProperty("key");
    expect((await call("GET", "/admin/ai", { token: "aud" })).status).toBe(200);
    expect((await call("PUT", "/admin/ai/providers/local-ai", { token: "ops", body: { key: "sk-new" } })).status).toBe(403);
    expect((await call("PUT", "/admin/ai/providers/local-ai", { token: "ops", body: { baseUrl: "https://evil.example" } })).status).toBe(403);
    expect((await call("PUT", "/admin/ai/providers/local-ai", { token: "ops", body: { label: "Lokální", groups: ["user"] } })).body.providers).toMatchObject([{ label: "Lokální", groups: ["user"] }]);
    expect((await call("PUT", "/admin/ai/providers/local-ai", { token: "own", body: { baseUrl: "ftp://x" } })).status).toBe(400);
    expect((await call("DELETE", "/admin/ai/providers/local-ai", { token: "ops" })).status).toBe(403);
    expect((await call("GET", "/admin/ai", { token: "aud" })).body.providers).toHaveLength(1);
  });

  it("models: discovered, enabled by an operator, priced by the owner", async () => {
    await addProvider();
    mock.on("GET /v1/models", (_q, res) => json(res, 200, { data: [{ id: "m1" }, { id: "m2" }] }));
    const d = await call("POST", "/admin/ai/providers/local-ai/discover", { token: "ops" });
    expect(d.body.discovered).toEqual({ ok: true, added: 1, updated: 1, total: 2 });
    const models = ((d.body.providers as Array<{ models: Array<Record<string, unknown>> }>)[0]).models;
    const on = models.map((m) => ({ ...m, enabled: true }));
    expect((await call("PUT", "/admin/ai/providers/local-ai/models", { token: "ops", body: { models: on } })).status).toBe(200);
    const priced = on.map((m) => (m.id === "m2" ? { ...m, price: { in: 3, out: 15 } } : m));
    expect((await call("PUT", "/admin/ai/providers/local-ai/models", { token: "ops", body: { models: priced } })).status).toBe(403);
    const r = await call("PUT", "/admin/ai/providers/local-ai/models", { token: "own", body: { models: priced } });
    expect((r.body.providers as Array<{ models: Array<{ id: string; enabled: boolean; price: unknown }> }>)[0].models.map((m) => [m.id, m.enabled, m.price])).toEqual([["m1", true, null], ["m2", true, { in: 3, out: 15 }]]);
    expect((await call("PUT", "/admin/ai/limits", { token: "ops", body: { monthlyTokens: 5 } })).status).toBe(403);
  });

  it("the playground is not held to the limits, streams, and shows what was sent", async () => {
    await addProvider();
    reply();
    const r = await call("POST", "/admin/ai/playground", { token: "ops", body: { model: "local-ai/m1", system: "S", messages: [{ role: "user", content: "Ahoj" }], stream: true, maxTokens: 50 } });
    const done = events(r.text).at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data).toMatchObject({ text: "Dobrý den!", ref: "local-ai/m1" });
    const trace = done.data.trace as Array<{ url: string; body: Record<string, unknown>; status: number }>;
    expect(trace[0]).toMatchObject({ url: `${mock.url}/v1/chat/completions`, status: 200, body: { model: "m1", max_tokens: 50 } });
    expect(JSON.stringify(trace)).not.toContain("sk-secret");
    expect(journal.list({ limit: 1 })[0]).toMatchObject({ source: "playground", actor: "otto", status: "ok" });
    // An auditor may not spend.
    expect((await call("POST", "/admin/ai/playground", { token: "aud", body: { model: "local-ai/m1", messages: [{ role: "user", content: "x" }] } })).status).toBe(403);
  });

  it("the journal: a list without content, content only to the owner while logging is on, CSV safe for spreadsheets", async () => {
    setPluginSwitches({ ai: true }, "t");
    await addProvider();
    reply();
    await call("PUT", "/admin/ai/limits", { token: "own", body: { monthlyTokens: null } });
    expect((await call("PUT", "/admin/ai/journal", { token: "ops", body: { content: { on: true } } })).status).toBe(403);
    const j = await call("PUT", "/admin/ai/journal", { token: "own", body: { retentionDays: 7, content: { on: true, hours: 2 } } });
    expect(j.body.journal).toMatchObject({ retentionDays: 7, content: { on: true, active: true, by: "olga" } });
    await call("POST", "/api/ai/chat", { body: { messages: [{ role: "user", content: "=HYPERLINK(\"x\")" }] } });
    const list = (await call("GET", "/admin/ai/calls?source=app", { token: "aud" })).body.calls as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ source: "app", actor: "guest", hasContent: true });
    expect(list[0]).not.toHaveProperty("content");
    const id = list[0].id as string;
    expect((await call("GET", `/admin/ai/calls/${id}`, { token: "aud" })).body.call).not.toHaveProperty("content");
    expect(JSON.parse((await call("GET", `/admin/ai/calls/${id}`, { token: "own" })).body.call.content as string)).toMatchObject({ answer: "Dobrý den!" });
    await call("PUT", "/admin/ai/journal", { token: "own", body: { content: { on: false } } });
    expect((await call("GET", `/admin/ai/calls/${id}`, { token: "own" })).body.call).toMatchObject({ content: null });
    await call("POST", "/api/ai/chat", { body: { messages: [{ role: "user", content: "x" }] } });
    // A cell a spreadsheet would run as a formula starts with a quote instead.
    await call("PUT", "/admin/ai/providers/local-ai", { token: "ops", body: { label: "=SUM(A1)" } });
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 400, { error: { message: "bad" } }));
    await call("POST", "/api/ai/chat", { body: { messages: [{ role: "user", content: "x" }] } });
    const csv = (await call("GET", "/admin/ai/calls.csv", { token: "aud" })).text;
    expect(csv.split("\n")[0]).toMatch(/^id,ts,source,actor,provider/);
    expect(csv).toContain(",'=SUM(A1) 400: bad,");
    expect(csv).not.toMatch(/,=SUM/);
    const sum = (await call("GET", "/admin/ai/summary?days=7", { token: "aud" })).body;
    expect(sum).toMatchObject({ days: 7, month: { requests: 2 } });
    expect((await call("DELETE", "/admin/ai/calls", { token: "ops" })).status).toBe(403);
    expect((await call("DELETE", "/admin/ai/calls", { token: "own" })).status).toBe(200);
    expect(journal.list()).toEqual([]);
  });

  it("switches, also under the address the 4.0.6 console used", async () => {
    const r = await call("PUT", "/admin/plugins/switches", { token: "ops", body: { ai: true } });
    expect(r.body.switches).toMatchObject({ ai: { enabled: true, source: "console" } });
    expect((await call("PUT", "/admin/ai/switches", { token: "ops", body: {} })).status).toBe(400);
    process.env.ENABLE_SPEECH = "0";
    expect((await call("PUT", "/admin/ai/switches", { token: "ops", body: { speech: true } })).status).toBe(409);
  });
});
