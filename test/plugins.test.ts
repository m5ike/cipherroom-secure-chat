import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginLog } from "../server/plugins/log";
import { bytesToBase64, base64ToBytes, ConnectorNotConfiguredError } from "../server/plugins/types";
import { AnthropicConnector, HuggingFaceAiConnector, OpenAiConnector } from "../server/plugins/connectors/ai";
import { HuggingFaceSttConnector } from "../server/plugins/connectors/speech";
import { describeFetchError, withoutRefusedParam } from "../server/plugins/http";
import { setPluginSwitches, switchState } from "../server/plugins/settings";
import {
  aiEnabled, speechEnabled, registrySnapshot, getAi, publicSpeechStatus,
} from "../server/plugins/registry";

const AI_ENV = ["ENABLE_AI", "ENABLE_SPEECH", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "AI_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OLLAMA_URL", "HF_API_KEY", "HF_BASE_URL", "PLUGINS_SETTINGS_FILE"];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of AI_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  // A settings file of the test's own (not ./.m5cet of a developer's machine).
  process.env.PLUGINS_SETTINGS_FILE = join(mkdtempSync(join(tmpdir(), "m5-plugins-")), "plugins.json");
});
afterEach(() => {
  for (const k of AI_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.unstubAllGlobals();
});

describe("plugin log", () => {
  beforeEach(() => pluginLog.clear());
  it("records entries with id + ts and streams them", () => {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    pluginLog.emitter.on("entry", on);
    const e = pluginLog.record({ level: "info", kind: "ai", connector: "openai", message: "hi" });
    pluginLog.emitter.off("entry", on);
    expect(e.id).toBeTruthy();
    expect(e.ts).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect(pluginLog.recent(10)).toHaveLength(1);
  });
  it("is bounded to 500 entries", () => {
    for (let i = 0; i < 600; i += 1) pluginLog.record({ level: "info", kind: "ai", message: String(i) });
    expect(pluginLog.recent(1000).length).toBe(500);
    expect(pluginLog.recent(1000)[499].message).toBe("599");
  });
  it("time() logs success and rethrows on failure", async () => {
    await pluginLog.time("tts", "x", "op", async () => 1);
    await expect(pluginLog.time("tts", "x", "op", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const msgs = pluginLog.recent(10).map((e) => e.message);
    expect(msgs.some((m) => m.includes("ok"))).toBe(true);
    expect(msgs.some((m) => m.includes("failed"))).toBe(true);
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("registry gating + status", () => {
  it("is off and unconfigured by default", () => {
    expect(aiEnabled()).toBe(false);
    expect(speechEnabled()).toBe(false);
    const snap = registrySnapshot();
    expect(snap.ai.every((c) => !c.configured)).toBe(true);
    expect(publicSpeechStatus().ai.connectors).toHaveLength(0);
  });

  it("reports a connector configured once its key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const openai = registrySnapshot().ai.find((c) => c.id === "openai");
    expect(openai?.configured).toBe(true);
    expect(getAi()?.id).toBe("openai"); // default resolves to the configured one
    expect(publicSpeechStatus().ai.connectors.map((c) => c.id)).toContain("openai");
  });

  it("honours AI_PROVIDER for the default when several are configured", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OLLAMA_URL = "http://127.0.0.1:11434";
    process.env.AI_PROVIDER = "ollama";
    expect(getAi()?.id).toBe("ollama");
  });
});

describe("connector refuses to run unconfigured", () => {
  it("OpenAI throws ConnectorNotConfiguredError without a key", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(new OpenAiConnector().complete({ messages: [{ role: "user", content: "hi" }] }))
        .rejects.toBeInstanceOf(ConnectorNotConfiguredError);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("switching AI / speech on (4.0.6)", () => {
  it("is off until switched on in the console; the environment wins when set", () => {
    expect(switchState("ai")).toEqual({ enabled: false, source: "default", env: "ENABLE_AI" });
    expect(setPluginSwitches({ ai: true }, "ops")).toEqual({ ok: true });
    expect(aiEnabled()).toBe(true);
    expect(speechEnabled()).toBe(false);
    expect(registrySnapshot().switches.ai).toEqual({ enabled: true, source: "console", env: "ENABLE_AI" });
    process.env.ENABLE_AI = "0";
    expect(aiEnabled()).toBe(false);
    expect(switchState("ai").source).toBe("env");
    const refused = setPluginSwitches({ ai: true }, "ops");
    expect(refused.ok).toBe(false);
    process.env.ENABLE_SPEECH = "true";
    expect(speechEnabled()).toBe(true);
  });
});

type Call = { url: string; body: unknown; headers: Record<string, string> };
/** A fake fetch: answers in order, records what was sent. */
function fakeFetch(answers: Array<{ status: number; json?: unknown; text?: string } | Error>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const raw = init.body;
    calls.push({ url: String(url), body: typeof raw === "string" ? JSON.parse(raw) : raw, headers: init.headers as Record<string, string> });
    const a = answers.shift()!;
    if (a instanceof Error) throw a;
    const text = a.text ?? JSON.stringify(a.json ?? {});
    return new Response(text, { status: a.status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

describe("connectors (4.0.6)", () => {
  it("Anthropic: no temperature unless asked, text blocks only, a refused temperature retried without it", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const calls = fakeFetch([
      { status: 200, json: { model: "claude-sonnet-5", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: " Hello " }] } },
      { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." } } },
      { status: 200, json: { content: [{ type: "text", text: "Hi" }] } },
    ]);
    const c = new AnthropicConnector();
    const r = await c.complete({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }] });
    expect(r).toEqual({ text: "Hello", model: "claude-sonnet-5", connector: "anthropic" });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].body).toEqual({ model: "claude-sonnet-5", max_tokens: 1024, messages: [{ role: "user", content: "Hi" }], system: "Be brief." });
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    await c.complete({ messages: [{ role: "user", content: "Hi" }], temperature: 0.2 });
    expect((calls[1].body as Record<string, unknown>).temperature).toBe(0.2);
    expect(calls[2].body).not.toHaveProperty("temperature");
  });

  it("HuggingFace: the router's OpenAI-compatible chat, and ASR through hf-inference", async () => {
    process.env.HF_API_KEY = "hf_x";
    const calls = fakeFetch([
      { status: 200, json: { model: "meta-llama/Llama-3.1-8B-Instruct", choices: [{ message: { content: "Ahoj" } }] } },
      { status: 200, json: { text: " přepis " } },
    ]);
    const r = await new HuggingFaceAiConnector().complete({ messages: [{ role: "user", content: "Hi" }] });
    expect(r.text).toBe("Ahoj");
    expect(calls[0].url).toBe("https://router.huggingface.co/v1/chat/completions");
    expect(calls[0].body).toEqual({ model: "meta-llama/Llama-3.1-8B-Instruct", messages: [{ role: "user", content: "Hi" }], max_tokens: 1024 });
    const t = await new HuggingFaceSttConnector().transcribe({ audio: new Uint8Array([1, 2, 3]), mime: "audio/webm" });
    expect(t.text).toBe("přepis");
    expect(calls[1].url).toBe("https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3");
    expect(calls[1].headers["Content-Type"]).toBe("audio/webm");
  });

  it("OpenAI: max_completion_tokens at api.openai.com, max_tokens at a compatible server", async () => {
    process.env.OPENAI_API_KEY = "sk";
    const calls = fakeFetch([
      { status: 200, json: { choices: [{ message: { content: "a" } }] } },
      { status: 200, json: { choices: [{ message: { content: "b" } }] } },
    ]);
    await new OpenAiConnector().complete({ messages: [{ role: "user", content: "x" }], maxTokens: 50 });
    expect(calls[0].body).toMatchObject({ max_completion_tokens: 50 });
    expect(calls[0].body).not.toHaveProperty("temperature");
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:8080/v1";
    await new OpenAiConnector().complete({ messages: [{ role: "user", content: "x" }], maxTokens: 50 });
    expect(calls[1].url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(calls[1].body).toMatchObject({ max_tokens: 50 });
  });

  it("says why a connection failed, and the provider's own message", async () => {
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api-inference.huggingface.co" } });
    expect(describeFetchError(dns, "https://api-inference.huggingface.co/models/x")).toBe("fetch failed (api-inference.huggingface.co: ENOTFOUND — the host name does not resolve (DNS) — a wrong or retired address)");
    process.env.HF_API_KEY = "hf_x";
    fakeFetch([dns, { status: 401, json: { error: "Invalid credentials in Authorization header" } }]);
    await expect(new HuggingFaceAiConnector().complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/HuggingFace: fetch failed \(router.huggingface.co: ENOTFOUND/);
    await expect(new HuggingFaceAiConnector().complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow("HuggingFace 401: Invalid credentials in Authorization header");
  });

  it("retries only for a parameter the model refused", () => {
    expect(withoutRefusedParam({ temperature: 1, x: 1 }, "`temperature` is deprecated for this model.")).toEqual({ x: 1 });
    expect(withoutRefusedParam({ max_tokens: 5 }, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")).toEqual({ max_completion_tokens: 5 });
    expect(withoutRefusedParam({ temperature: 1 }, "messages: field required")).toBeNull();
  });
});
