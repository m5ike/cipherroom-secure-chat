// @vitest-environment node
//
// The AI & speech service (server/ai/{config,journal,service}.ts, 4.14): the
// configuration (keys sealed, the environment's providers, sanitizing), the
// module switches, who may use what, the limits (the default 0 = off), the
// journal (usage, cost, content only while logging is on), speech, and the
// console's tools (discovering models, testing a provider).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The server's storage key (the keys module reads it once).
process.env.STORAGE_MASTER_KEY = "a".repeat(64);

import { pluginLog } from "../server/plugins/log";
import { setPluginSwitches, switchState } from "../server/plugins/settings";
import {
  aiConfig, aiConfigPath, defaultAiConfig, keyState, parseRef, providerKey, saveAiConfig, sanitizeAiConfig, sanitizeBaseUrl, sealKey, type ProviderConfig,
} from "../server/ai/config";
import { journal } from "../server/ai/journal";
import { AiRefused, chat, discover, modelsFor, testProvider, tts, type Caller } from "../server/ai/service";
import { json, mockProvider, openAiStream, sse, type MockProvider } from "./helpers/mock-ai";

const ENV = ["ENABLE_AI", "ENABLE_SPEECH", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_API_KEY", "OLLAMA_URL", "HF_API_KEY", "ELEVENLABS_API_KEY", "DATA_DIR", "PLUGINS_SETTINGS_FILE", "AI_DATA_DIR", "AI_CONFIG_FILE", "AI_JOURNAL_FILE"];
const saved: Record<string, string | undefined> = {};
let mock: MockProvider;

beforeAll(async () => { mock = await mockProvider(); });
afterAll(async () => { await mock.close(); journal.reset(); });
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  const dir = mkdtempSync(join(tmpdir(), "m5-ai-"));
  process.env.DATA_DIR = dir;
  process.env.PLUGINS_SETTINGS_FILE = join(dir, "plugins.json");
  mock.seen.length = 0;
  pluginLog.clear();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const user: Caller = { source: "app", actor: "bystry-sokol", account: "acc-1", groups: ["user"], console: false };
const guest: Caller = { source: "app", actor: "guest", account: "", groups: ["guest"], console: false };
const admin: Caller = { source: "playground", actor: "admin", account: "", groups: [], console: true };
const hi = [{ role: "user" as const, content: "Ahoj" }];

function provider(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "local", type: "openai-compatible", label: "Local", baseUrl: `${mock.url}/v1`, ...sealKey("local", "sk-local-1234"), enabled: true, groups: ["user"],
    models: [
      { id: "m1", label: "Model One", kind: "chat", enabled: true, caps: { stream: true, reasoning: "none", noSampling: false, vision: false, json: false, tools: false }, price: { in: 1, out: 2 }, source: "manual" },
      { id: "tts-1", label: "", kind: "tts", enabled: true, caps: { stream: false, reasoning: "none", noSampling: false, vision: false, json: false, tools: false }, price: null, voices: ["nova"], source: "manual" },
    ],
    source: "console", createdAt: 1, updatedAt: 1, updatedBy: "t", ...extra,
  };
}
function setup(limits: Partial<ReturnType<typeof defaultAiConfig>["limits"]> = { monthlyTokens: 1_000_000 }, extra: Partial<ProviderConfig> = {}) {
  const c = defaultAiConfig();
  const r = saveAiConfig({ ...c, providers: [provider(extra)], defaults: { ...c.defaults, chat: "local/m1", tts: "local/tts-1", voice: "nova" }, limits: { ...c.limits, ...limits } }, "test");
  expect(r.ok).toBe(true);
}
const answer = (text = "Dobrý den") => mock.on("POST /v1/chat/completions", (_q, res) => json(res, 200, { model: "m1", choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));

describe("switches and the live log (4.0.6, kept)", () => {
  it("are off until switched on in the console; the environment wins when set", () => {
    expect(switchState("ai")).toEqual({ enabled: false, source: "default", env: "ENABLE_AI" });
    expect(setPluginSwitches({ ai: true }, "ops")).toEqual({ ok: true });
    expect(switchState("ai")).toEqual({ enabled: true, source: "console", env: "ENABLE_AI" });
    process.env.ENABLE_AI = "0";
    expect(switchState("ai").enabled).toBe(false);
    expect(setPluginSwitches({ ai: true }, "ops").ok).toBe(false);
  });
  it("the live log is bounded and streams", () => {
    const seen: unknown[] = [];
    pluginLog.emitter.on("entry", (e) => seen.push(e));
    for (let i = 0; i < 600; i += 1) pluginLog.record({ level: "info", kind: "ai", message: String(i) });
    expect(pluginLog.recent(1000)).toHaveLength(500);
    expect(seen).toHaveLength(600);
    pluginLog.emitter.removeAllListeners("entry");
  });
});

describe("the configuration", () => {
  it("keeps keys sealed: not in the file, opened only for their provider", () => {
    setup();
    const file = readFileSync(aiConfigPath(), "utf8");
    expect(file).not.toContain("sk-local-1234");
    const p = aiConfig().providers[0];
    expect(p.keyHint).toBe("1234");
    expect(providerKey(p)).toBe("sk-local-1234");
    // The same sealed key moved to another provider does not open.
    expect(providerKey({ ...p, id: "other" })).toBe("");
    expect(keyState({ ...p, id: "other" })).toBe("unreadable");
  });

  it("drops what is not valid; addresses are http(s) without credentials", () => {
    const c = sanitizeAiConfig({
      providers: [
        { id: "ok", type: "ollama", models: [{ id: "llama3.1", kind: "chat", enabled: true }, { id: "bad model!", kind: "chat" }], groups: ["user", "Bad Group", "guest"] },
        { id: "Bad Id", type: "ollama" }, { id: "x", type: "nope" },
      ],
      limits: { monthlyTokens: -5, maxOutputTokens: 5 },
    });
    expect(c.providers.map((p) => p.id)).toEqual(["ok"]);
    expect(c.providers[0].models.map((m) => m.id)).toEqual(["llama3.1"]);
    expect(c.providers[0].groups).toEqual(["user", "guest"]);
    expect(c.limits.monthlyTokens).toBe(0);
    expect(c.limits.maxOutputTokens).toBe(16);
    expect(sanitizeBaseUrl("https://user:pw@example.org/v1")).toBe("");
    expect(sanitizeBaseUrl("ftp://example.org")).toBe("");
    expect(sanitizeBaseUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1");
    expect(defaultAiConfig().limits.monthlyTokens).toBe(0);
  });

  it("a key in the environment (as before 4.14) is a provider of its own, until it is removed there", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.OPENAI_MODEL = "gpt-5-mini";
    const p = aiConfig().providers.find((x) => x.id === "env-openai")!;
    expect(p.source).toBe("env");
    expect(p.models.map((m) => [m.id, m.kind, m.enabled])).toEqual([["gpt-5-mini", "chat", true], ["tts-1", "tts", true], ["whisper-1", "stt", true]]);
    expect(providerKey(p)).toBe("sk-env");
    // What the console sets for it is kept; the key and address stay in the environment.
    saveAiConfig({ ...aiConfig(), providers: aiConfig().providers.map((x) => (x.id === "env-openai" ? { ...x, groups: ["user", "guest"] } : x)) }, "t");
    expect(aiConfig().providers.find((x) => x.id === "env-openai")!.groups).toEqual(["user", "guest"]);
    delete process.env.OPENAI_API_KEY;
    saveAiConfig({ ...aiConfig() }, "t");
    expect(aiConfig().providers.some((x) => x.id === "env-openai")).toBe(false);
  });

  it("references are provider/model, and a model may contain a slash", () => {
    expect(parseRef("hf/meta-llama/Llama-3.1-8B-Instruct:fastest")).toEqual({ provider: "hf", model: "meta-llama/Llama-3.1-8B-Instruct:fastest" });
    expect(parseRef("nomodel")).toBeNull();
  });
});

describe("chat through the service", () => {
  it("is refused while the module is off, then while no monthly limit is set (the default)", async () => {
    setup({ monthlyTokens: 0 });
    answer();
    await expect(chat({ messages: hi }, user)).rejects.toMatchObject({ code: "off", status: 404 });
    setPluginSwitches({ ai: true }, "t");
    await expect(chat({ messages: hi }, user)).rejects.toMatchObject({ code: "budget-unset", status: 503 });
    expect(mock.seen).toHaveLength(0);
    await journal.ready();
    expect(journal.list().map((r) => [r.status, r.error.slice(0, 20)])).toEqual([["refused", "The AI is off until "], ["refused", "The AI module is off"]]);
    // The console is not held to the limit (but is counted).
    const out = await chat({ messages: hi }, admin);
    expect(out.text).toBe("Dobrý den");
  });

  it("answers, counts tokens and cost, and keeps no content unless logging is on", async () => {
    setup();
    setPluginSwitches({ ai: true }, "t");
    answer();
    const out = await chat({ messages: hi, system: "Buď stručný." }, user);
    expect(out).toMatchObject({ text: "Dobrý den", ref: "local/m1", usage: { input: 20, output: 5 } });
    expect(out.cost).toBeCloseTo((20 * 1 + 5 * 2) / 1e6, 12);
    expect(mock.seen[0].headers.authorization).toBe("Bearer sk-local-1234");
    const rec = journal.list()[0];
    expect(rec).toMatchObject({ source: "app", actor: "bystry-sokol", account: "acc-1", provider: "local", model: "m1", status: "ok", tokensIn: 20, tokensOut: 5, content: null });
    expect(journal.usage(0)).toMatchObject({ requests: 1, tokens: 25 });
    // Content logging on (the owner, for a while): what was said is kept.
    const c = aiConfig();
    saveAiConfig({ ...c, journal: { ...c.journal, content: { on: true, until: Date.now() + 60_000, by: "owner" } } }, "t");
    await chat({ messages: hi }, user);
    expect(JSON.parse(journal.list()[0].content!)).toMatchObject({ answer: "Dobrý den", messages: hi });
    // …and dropped at once when switched off.
    journal.dropContentBefore(Date.now() + 1);
    expect(journal.list()[0].content).toBeNull();
    // When its time runs out, nothing more is kept, and the periodic sweep removes what was.
    saveAiConfig({ ...aiConfig(), journal: { ...aiConfig().journal, content: { on: true, until: Date.now() - 1, by: "owner" } } }, "t");
    await chat({ messages: hi }, user);
    expect(journal.list()[0].content).toBeNull();
  });

  it("holds each to the limits: the instance's month, a user's day, the size", async () => {
    setup({ monthlyTokens: 60, userDailyRequests: 2 });
    setPluginSwitches({ ai: true }, "t");
    answer();
    await chat({ messages: hi }, user);
    await chat({ messages: hi }, user);
    await expect(chat({ messages: hi }, user)).rejects.toMatchObject({ code: "user-limit", status: 429 });
    const other: Caller = { ...user, account: "acc-2", actor: "jiny" };
    await chat({ messages: hi }, other);
    // 3 × 25 tokens ≥ 60: the month is used up for everyone.
    await expect(chat({ messages: hi }, { ...user, account: "acc-3" })).rejects.toMatchObject({ code: "budget-exhausted" });
    const c = aiConfig();
    saveAiConfig({ ...c, limits: { ...c.limits, monthlyTokens: null, maxInputChars: 500 } }, "t");
    await expect(chat({ messages: [{ role: "user", content: "x".repeat(600) }] }, other)).rejects.toMatchObject({ code: "too-long", status: 413 });
  });

  it("offers a provider only to its groups; guests get nothing unless let in", async () => {
    setup();
    setPluginSwitches({ ai: true }, "t");
    answer();
    expect(modelsFor(guest, "chat")).toEqual([]);
    await expect(chat({ messages: hi }, guest)).rejects.toMatchObject({ code: "no-model" });
    await expect(chat({ model: "local/m1", messages: hi }, guest)).rejects.toMatchObject({ code: "not-allowed", status: 403 });
    saveAiConfig({ ...aiConfig(), providers: aiConfig().providers.map((p) => ({ ...p, groups: ["user", "guest"] })) }, "t");
    expect((await chat({ messages: hi }, guest)).text).toBe("Dobrý den");
    // A switched-off model is not offered, and asked for by name it is refused.
    saveAiConfig({ ...aiConfig(), providers: aiConfig().providers.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m, enabled: false })) })) }, "t");
    await expect(chat({ model: "local/m1", messages: hi }, user)).rejects.toMatchObject({ code: "no-model" });
  });

  it("streams, estimates usage the provider did not report, records a cancelled call", async () => {
    setup();
    setPluginSwitches({ ai: true }, "t");
    mock.on("POST /v1/chat/completions", (_q, res) => sse(res, openAiStream("Ahoj, jak se máš?", { noUsage: true })));
    const pieces: string[] = [];
    const out = await chat({ messages: hi }, user, (e) => { if (e.type === "text") pieces.push(e.text); });
    expect(pieces.join("")).toBe("Ahoj, jak se máš?");
    expect(out.usage.estimated).toBe(true);
    expect(out.usage.output).toBe(Math.ceil("Ahoj, jak se máš?".length / 4));
    expect(journal.list()[0]).toMatchObject({ stream: true, estimated: true });
    expect(journal.list()[0].ttft).toBeGreaterThan(0);
    mock.on("POST /v1/chat/completions", (_q, res) => sse(res, openAiStream("a long answer that goes on", { noUsage: true }), 40));
    const controller = new AbortController();
    await expect(chat({ messages: hi, signal: controller.signal }, user, () => controller.abort())).rejects.toThrow("cancelled");
    expect(journal.list()[0].status).toBe("cancelled");
  });

  it("a provider's error is recorded with its status", async () => {
    setup();
    setPluginSwitches({ ai: true }, "t");
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 429, { error: { message: "Rate limit reached" } }));
    await expect(chat({ messages: hi }, user)).rejects.toThrow("Local 429: Rate limit reached");
    expect(journal.list()[0]).toMatchObject({ status: "error", http: 429, error: "Local 429: Rate limit reached" });
    expect(journal.usage(0).requests).toBe(0);
  });
});

describe("speech and the console's tools", () => {
  it("speaks with the default voice when the speech module is on", async () => {
    setup();
    mock.on("POST /v1/audio/speech", (_q, res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.from([1, 2])); });
    await expect(tts({ text: "Ahoj" }, user)).rejects.toBeInstanceOf(AiRefused);
    setPluginSwitches({ speech: true }, "t");
    const out = await tts({ text: "Ahoj" }, user);
    expect([...out.audio]).toEqual([1, 2]);
    expect(mock.seen.at(-1)!.body).toMatchObject({ model: "tts-1", voice: "nova", input: "Ahoj" });
    expect(journal.list()[0]).toMatchObject({ kind: "tts", status: "ok", charsIn: 4 });
  });

  it("discovers models (new ones switched off, edits kept) and tests a provider", async () => {
    setup();
    mock.on("GET /v1/models", (_q, res) => json(res, 200, { data: [{ id: "m1" }, { id: "m2" }, { id: "whisper-1" }] }));
    const r = await discover("local", "ops");
    expect(r).toEqual({ ok: true, added: 2, updated: 1, total: 3 });
    const models = aiConfig().providers[0].models;
    expect(models.map((m) => [m.id, m.kind, m.enabled, m.label])).toEqual([["m1", "chat", true, "Model One"], ["tts-1", "tts", true, ""], ["m2", "chat", false, ""], ["whisper-1", "stt", false, ""]]);
    const t = await testProvider("local", "ops");
    expect(t).toMatchObject({ ok: true, models: 3 });
    expect(aiConfig().providers[0].lastTest).toMatchObject({ ok: true });
    mock.on("GET /v1/models", (_q, res) => json(res, 401, { error: { message: "bad key" } }));
    expect(await testProvider("local", "ops")).toMatchObject({ ok: false, message: "Local 401: bad key" });
  });
});
