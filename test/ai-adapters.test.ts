// @vitest-environment node
//
// The provider adapters of the AI & speech layer (server/ai/providers/*,
// 4.14) against a pretend provider on 127.0.0.1: what they send (URL,
// headers, body — reasoning, sampling, limits), how they read answers and
// streams (text, reasoning, usage, sources), the models lists, speech, a
// refused parameter retried, a cancelled stream, and errors in words.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AnthropicAdapter } from "../server/ai/providers/anthropic";
import { OpenAiAdapter, kindOf } from "../server/ai/providers/openai";
import { OllamaAdapter } from "../server/ai/providers/ollama";
import { ElevenLabsAdapter } from "../server/ai/providers/elevenlabs";
import { withoutRefused, ProviderError } from "../server/ai/net";
import { describeFetchError } from "../server/plugins/http";
import type { ChatEvent, ModelCaps } from "../server/ai/types";
import { anthropicStream, json, mockProvider, ndjson, openAiStream, sse, type MockProvider } from "./helpers/mock-ai";

let mock: MockProvider;
beforeAll(async () => { mock = await mockProvider(); });
afterAll(async () => { await mock.close(); });
beforeEach(() => { mock.seen.length = 0; });

const caps = (c: Partial<ModelCaps>): ModelCaps => ({ stream: true, reasoning: "none", noSampling: false, vision: false, json: false, tools: false, ...c });
const collect = () => { const events: ChatEvent[] = []; return { events, on: (e: ChatEvent) => events.push(e) }; };
const user = [{ role: "user" as const, content: "Ahoj" }];

describe("Anthropic", () => {
  it("streams text and thinking, counts usage, sends the key and version", async () => {
    mock.on("POST /v1/messages", (_q, res) => sse(res, anthropicStream("Dobrý den, jak mohu pomoci?", { thinking: "The user greets.", input: 30, output: 11 })));
    const a = new AnthropicAdapter(mock.url, "sk-ant", "Claude");
    const { events, on } = collect();
    const r = await a.chat({ model: "claude-sonnet-5", system: "Buď stručný.", messages: user, maxTokens: 300, reasoning: "medium", caps: caps({ reasoning: "adaptive" }) }, on);
    expect(r.text).toBe("Dobrý den, jak mohu pomoci?");
    expect(r.reasoning).toBe("The user greets.");
    expect(r.usage).toEqual({ input: 30, output: 11 });
    expect(r.finish).toBe("end_turn");
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe(r.text);
    expect(events[0]).toEqual({ type: "reasoning", text: "The user greets." });
    const sent = mock.seen[0];
    expect(sent.headers["x-api-key"]).toBe("sk-ant");
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.body).toEqual({
      model: "claude-sonnet-5", max_tokens: 300, messages: user, system: "Buď stručný.", stream: true,
      thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" },
    });
  });

  it("asks the least reasoning of an adaptive model, a budget of an older one, and no sampling with thinking", () => {
    const a = new AnthropicAdapter(mock.url, "k");
    expect(a.body({ model: "m", messages: user, maxTokens: 100, caps: caps({ reasoning: "adaptive" }), temperature: 0.3 }, false))
      .toMatchObject({ thinking: { type: "disabled" }, output_config: { effort: "low" }, temperature: 0.3 });
    const old = a.body({ model: "claude-haiku-4-5", messages: user, maxTokens: 100, reasoning: "high", caps: caps({ reasoning: "budget" }), temperature: 0.3 }, false);
    expect(old).toMatchObject({ thinking: { type: "enabled", budget_tokens: 16000 }, max_tokens: 16100 });
    expect(old).not.toHaveProperty("temperature");
    expect(a.body({ model: "m", messages: user, maxTokens: 100, caps: caps({ reasoning: "none", noSampling: true }), temperature: 0.3 }, false)).not.toHaveProperty("temperature");
  });

  it("retries without what the model refused: disabled thinking, then effort", async () => {
    let n = 0;
    mock.on("POST /v1/messages", (q, res) => {
      n += 1;
      const b = q.body as Record<string, unknown>;
      if (b.thinking) return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "thinking.type: disabled is not supported for this model" } });
      if (b.output_config) return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "effort is not supported" } });
      json(res, 200, { model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } });
    });
    const r = await new AnthropicAdapter(mock.url, "k").chat({ model: "claude-opus-5-5", messages: user, maxTokens: 50, caps: caps({ reasoning: "adaptive" }) });
    expect(r.text).toBe("OK");
    expect(n).toBe(3);
    expect(mock.seen[2].body).not.toHaveProperty("thinking");
    expect(mock.seen[2].body).not.toHaveProperty("output_config");
  });

  it("an error in the stream is an error; the models list carries what each model can do", async () => {
    mock.on("POST /v1/messages", (_q, res) => sse(res, [{ event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } }, { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }]));
    await expect(new AnthropicAdapter(mock.url, "k").chat({ model: "m", messages: user, maxTokens: 10 }, () => undefined)).rejects.toThrow("overloaded_error: Overloaded");
    mock.on("GET /v1/models", (_q, res) => json(res, 200, {
      data: [
        { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }, image_input: { supported: true } } },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", capabilities: { thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } }, image_input: { supported: true } } },
      ],
      has_more: false,
    }));
    const models = await new AnthropicAdapter(mock.url, "k").models();
    expect(models.map((m) => [m.id, m.label, m.caps?.reasoning, m.context])).toEqual([["claude-opus-5-5", "Claude Opus 5.5", "adaptive", 1000000], ["claude-haiku-4-5", "Claude Haiku 4.5", "budget", undefined]]);
  });
});

describe("OpenAI-compatible", () => {
  it("streams text and reasoning with usage; max_tokens for a compatible server, the key as a bearer", async () => {
    mock.on("POST /v1/chat/completions", (_q, res) => sse(res, openAiStream("Hello there", { reasoning: "hmm", model: "qwen3" })));
    const { events, on } = collect();
    const r = await new OpenAiAdapter("llamacpp", `${mock.url}/v1`, "local-key", "llama.cpp").chat({ model: "qwen3", system: "S", messages: user, maxTokens: 64, reasoning: "low", caps: caps({ reasoning: "adaptive" }) }, on);
    expect(r).toMatchObject({ text: "Hello there", reasoning: "hmm", model: "qwen3", finish: "stop", usage: { input: 20, output: 5, reasoning: 2 } });
    expect(events.map((e) => e.type)).toEqual(["reasoning", "text", "text", "text", "text"]);
    expect(mock.seen[0].headers.authorization).toBe("Bearer local-key");
    expect(mock.seen[0].body).toEqual({ model: "qwen3", messages: [{ role: "system", content: "S" }, ...user], max_tokens: 64, stream: true, stream_options: { include_usage: true }, reasoning_effort: "low" });
  });

  it("no usage in the stream is marked estimated; a server that ignores stream answers once", async () => {
    mock.on("POST /v1/chat/completions", (_q, res) => sse(res, openAiStream("x", { noUsage: true })));
    const r = await new OpenAiAdapter("gpt4all", `${mock.url}/v1`, "", "GPT4All").chat({ model: "m", messages: user, maxTokens: 10 }, () => undefined);
    expect(r.usage).toEqual({ input: 0, output: 0, estimated: true });
    expect(mock.seen[0].headers.authorization).toBeUndefined();
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 200, { model: "m", choices: [{ message: { content: "whole" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    const { events, on } = collect();
    const r2 = await new OpenAiAdapter("openai-compatible", `${mock.url}/v1`, "", "X").chat({ model: "m", messages: user, maxTokens: 10 }, on);
    expect(r2.text).toBe("whole");
    expect(events).toEqual([{ type: "text", text: "whole" }]);
  });

  it("Perplexity's sources; Hugging Face's router under /v1; Open WebUI's /api", async () => {
    mock.on("POST /chat/completions", (_q, res) => sse(res, openAiStream("Praha", { citations: ["https://cs.wikipedia.org/wiki/Praha"] })));
    const { events, on } = collect();
    const r = await new OpenAiAdapter("perplexity", mock.url, "pplx", "Perplexity").chat({ model: "sonar", messages: user, maxTokens: 50 }, on);
    expect(r.citations).toEqual([{ url: "https://cs.wikipedia.org/wiki/Praha" }]);
    expect(events.some((e) => e.type === "citations")).toBe(true);
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 200, { choices: [{ message: { content: "hf" } }] }));
    await new OpenAiAdapter("huggingface", mock.url, "hf_x", "HF").chat({ model: "meta-llama/Llama-3.1-8B-Instruct:fastest", messages: user, maxTokens: 10 });
    expect(mock.seen.at(-1)!.path).toBe("/v1/chat/completions");
    mock.on("POST /api/chat/completions", (_q, res) => json(res, 200, { choices: [{ message: { content: "owui" } }] }));
    mock.on("GET /api/models", (_q, res) => json(res, 200, { data: [{ id: "llama3.1:8b", name: "Llama 3.1" }] }));
    const owui = new OpenAiAdapter("openwebui", `${mock.url}/api`, "k", "Open WebUI");
    expect((await owui.chat({ model: "llama3.1:8b", messages: user, maxTokens: 10 })).text).toBe("owui");
    expect(await owui.models()).toEqual([{ id: "llama3.1:8b", label: "Llama 3.1", kind: "chat", caps: { stream: true, reasoning: "none", noSampling: false } }]);
  });

  it("sorts a mixed models list by kind; speech both ways", async () => {
    expect(["gpt-5", "tts-1", "whisper-1", "text-embedding-3-small", "gpt-4o-mini-tts", "gpt-4o-transcribe"].map((m) => kindOf("openai", m))).toEqual(["chat", "tts", "stt", "embed", "tts", "stt"]);
    mock.on("POST /v1/audio/speech", (_q, res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.from([1, 2, 3])); });
    mock.on("POST /v1/audio/transcriptions", (_q, res) => json(res, 200, { text: " přepis " }));
    const o = new OpenAiAdapter("openai-compatible", `${mock.url}/v1`, "k", "X");
    const t = await o.tts!({ model: "tts-1", text: "Ahoj", voice: "nova" });
    expect([...t.audio]).toEqual([1, 2, 3]);
    expect(mock.seen.at(-1)!.body).toEqual({ model: "tts-1", voice: "nova", input: "Ahoj", response_format: "mp3" });
    expect((await o.stt!({ model: "whisper-1", audio: new Uint8Array([9, 9]), mime: "audio/ogg", language: "cs" })).text).toBe("přepis");
    expect(String(mock.seen.at(-1)!.headers["content-type"])).toMatch(/^multipart\/form-data/);
    mock.on("POST /hf-inference/models/openai/whisper-large-v3", (_q, res) => json(res, 200, { text: "hf přepis" }));
    const hf = await new OpenAiAdapter("huggingface", mock.url, "hf", "HF").stt!({ model: "openai/whisper-large-v3", audio: new Uint8Array([1]), mime: "audio/webm" });
    expect(hf.text).toBe("hf přepis");
    expect(mock.seen.at(-1)!.headers["content-type"]).toBe("audio/webm");
  });

  it("api.openai.com gets max_completion_tokens (the address decides)", () => {
    const body = new OpenAiAdapter("openai", "https://api.openai.com/v1", "k", "OpenAI").body({ model: "gpt-5", messages: user, maxTokens: 99, json: true, caps: caps({ reasoning: "adaptive", noSampling: true }), temperature: 1 }, false);
    expect(body).toEqual({ model: "gpt-5", messages: user, max_completion_tokens: 99, response_format: { type: "json_object" } });
  });
});

describe("Ollama", () => {
  it("streams newline-delimited JSON with thinking and counts; lists local models", async () => {
    mock.on("POST /api/chat", (_q, res) => ndjson(res, [
      { model: "qwen3:8b", message: { role: "assistant", content: "", thinking: "hm" }, done: false },
      { model: "qwen3:8b", message: { role: "assistant", content: "Ahoj" }, done: false },
      { model: "qwen3:8b", message: { role: "assistant", content: "!" }, done: false },
      { model: "qwen3:8b", done: true, done_reason: "stop", prompt_eval_count: 14, eval_count: 3 },
    ]));
    const { events, on } = collect();
    const r = await new OllamaAdapter(mock.url).chat({ model: "qwen3:8b", messages: user, maxTokens: 40, reasoning: "medium", caps: caps({ reasoning: "adaptive" }), temperature: 0.1 }, on);
    expect(r).toMatchObject({ text: "Ahoj!", reasoning: "hm", usage: { input: 14, output: 3 }, finish: "stop" });
    expect(events.map((e) => e.type)).toEqual(["reasoning", "text", "text"]);
    expect(mock.seen[0].body).toEqual({ model: "qwen3:8b", messages: user, stream: true, options: { num_predict: 40, temperature: 0.1 }, think: true });
    mock.on("GET /api/tags", (_q, res) => json(res, 200, { models: [{ name: "llama3.1:8b", model: "llama3.1:8b", details: { parameter_size: "8.0B" } }, { name: "nomic-embed-text", model: "nomic-embed-text" }] }));
    const models = await new OllamaAdapter(mock.url).models();
    expect(models.map((m) => [m.id, m.kind, m.label])).toEqual([["llama3.1:8b", "chat", "llama3.1:8b · 8.0B"], ["nomic-embed-text", "embed", undefined]]);
  });
});

describe("ElevenLabs", () => {
  it("lists the speech models with the account's voices, speaks with a voice id", async () => {
    mock.on("GET /v1/models", (_q, res) => json(res, 200, [{ model_id: "eleven_multilingual_v2", name: "Multilingual v2", can_do_text_to_speech: true }, { model_id: "sts", can_do_text_to_speech: false }]));
    mock.on("GET /v1/voices", (_q, res) => json(res, 200, { voices: [{ voice_id: "abc", name: "Rachel" }] }));
    const e = new ElevenLabsAdapter(mock.url, "xi");
    expect(await e.models()).toEqual([{ id: "eleven_multilingual_v2", label: "Multilingual v2", kind: "tts", voices: ["abc:Rachel"] }]);
    mock.on("POST /v1/text-to-speech/abc", (_q, res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.from([7])); });
    const t = await e.tts({ model: "eleven_multilingual_v2", text: "Ahoj", voice: "abc:Rachel" });
    expect([...t.audio]).toEqual([7]);
    expect(mock.seen.at(-1)!.headers["xi-api-key"]).toBe("xi");
  });
});

describe("errors and cancelling", () => {
  it("says what the provider said, and why a connection failed", async () => {
    mock.on("POST /v1/chat/completions", (_q, res) => json(res, 401, { error: { message: "Invalid API key" } }));
    await expect(new OpenAiAdapter("openai-compatible", `${mock.url}/v1`, "bad", "X").chat({ model: "m", messages: user, maxTokens: 5 })).rejects.toThrow("X 401: Invalid API key");
    // A port that was open a moment ago and is closed now: refused.
    const closed = await mockProvider();
    const port = new URL(closed.url).port;
    await closed.close();
    await expect(new OpenAiAdapter("openai-compatible", `http://127.0.0.1:${port}/v1`, "", "Nowhere").chat({ model: "m", messages: user, maxTokens: 5 })).rejects.toThrow(new RegExp(`Nowhere: fetch failed \\(127\\.0\\.0\\.1:${port}: ECONNREFUSED — the connection was refused`));
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(describeFetchError(dns, "https://api-inference.huggingface.co/x")).toBe("fetch failed (api-inference.huggingface.co: ENOTFOUND — the host name does not resolve (DNS) — a wrong or retired address)");
  });

  it("a cancelled stream stops and says so", async () => {
    mock.on("POST /v1/chat/completions", (_q, res) => sse(res, openAiStream("a long answer that goes on and on", { noUsage: true }), 40));
    const controller = new AbortController();
    const got: string[] = [];
    const p = new OpenAiAdapter("openai-compatible", `${mock.url}/v1`, "", "X").chat({ model: "m", messages: user, maxTokens: 5, signal: controller.signal }, (e) => {
      if (e.type === "text") { got.push(e.text); if (got.length === 2) controller.abort(); }
    });
    await expect(p).rejects.toThrow("X: cancelled");
    expect(got.length).toBe(2);
  });

  it("retries only for what a model refused", () => {
    expect(withoutRefused({ temperature: 1, x: 1 }, "`temperature` is deprecated for this model.")).toEqual({ x: 1 });
    expect(withoutRefused({ max_tokens: 5 }, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")).toEqual({ max_completion_tokens: 5 });
    expect(withoutRefused({ thinking: { type: "adaptive", display: "summarized" }, max_tokens: 100 }, "thinking.display: Extra inputs are not permitted")).toEqual({ thinking: { type: "adaptive" }, max_tokens: 100 });
    expect(withoutRefused({ thinking: { type: "adaptive" }, max_tokens: 4000 }, "thinking type adaptive is not supported")).toEqual({ thinking: { type: "enabled", budget_tokens: 2000 }, max_tokens: 6000 });
    expect(withoutRefused({ stream_options: {}, x: 1 }, "Unrecognized request argument: stream_options")).toEqual({ x: 1 });
    expect(withoutRefused({ temperature: 1 }, "messages: field required")).toBeNull();
    expect(new ProviderError("P", 0, "x").message).toBe("P: x");
  });
});
