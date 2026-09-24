// Everything that speaks the OpenAI API (4.14): OpenAI itself, Open WebUI,
// Perplexity (answers with sources), llama.cpp's server, GPT4All's local
// server, Hugging Face's Inference Providers router and any other compatible
// server — chat with streaming, reasoning where the model has it, the models
// list, speech synthesis and transcription.

import { openAiPaths } from "../catalog";
import { send, sendJson, sse, withoutRefused, ProviderError } from "../net";
import {
  DEFAULT_CAPS, type ChatEvent, type ChatRequest, type ChatResult, type CallTrace, type Citation, type DiscoveredModel, type ModelKind,
  type ProviderAdapter, type ProviderType, type SttRequest, type SttResult, type TtsRequest, type TtsResult, type Usage,
} from "../types";

type ApiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
};
type Delta = { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
type Chunk = {
  model?: string;
  choices?: { delta?: Delta; message?: Delta; finish_reason?: string | null }[];
  usage?: ApiUsage | null;
  citations?: string[];
  search_results?: { url?: string; title?: string }[];
};

export class OpenAiAdapter implements ProviderAdapter {
  private readonly paths: ReturnType<typeof openAiPaths>;
  constructor(readonly type: ProviderType, private readonly base: string, private readonly key: string, private readonly name: string) {
    this.paths = openAiPaths(type, base);
  }

  /** api.openai.com: newer models want max_completion_tokens and take reasoning_effort. */
  private official(): boolean {
    try { return /(^|\.)openai\.com$/.test(new URL(this.base).hostname); } catch { return false; }
  }

  private headers(): Record<string, string> {
    return this.key ? { Authorization: `Bearer ${this.key}` } : {};
  }

  body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const caps = { ...DEFAULT_CAPS, ...(req.caps ?? {}) };
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });
    const body: Record<string, unknown> = { model: req.model, messages, [this.official() ? "max_completion_tokens" : "max_tokens"]: req.maxTokens };
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    const r = req.reasoning ?? "off";
    // Only models known to reason get the parameter (others would refuse it; a refusal is retried without).
    if (caps.reasoning !== "none" && r !== "off") body.reasoning_effort = r;
    if (req.json) body.response_format = { type: "json_object" };
    if (req.temperature !== undefined && !caps.noSampling) body.temperature = req.temperature;
    return body;
  }

  async chat(req: ChatRequest, onEvent?: (e: ChatEvent) => void, trace?: CallTrace[]): Promise<ChatResult> {
    const stream = Boolean(onEvent);
    const opts = { headers: this.headers(), json: this.body(req, stream), signal: req.signal, adjust: withoutRefused, trace };
    if (!stream) {
      const json = await sendJson<Chunk>(this.name, this.paths.chat, opts);
      const msg = json.choices?.[0]?.message;
      return {
        text: (msg?.content ?? "").trim(),
        reasoning: (msg?.reasoning_content ?? msg?.reasoning ?? "").trim() || undefined,
        usage: usageOf(json.usage),
        model: json.model || req.model,
        finish: json.choices?.[0]?.finish_reason || "stop",
        citations: citationsOf(json),
      };
    }
    const { res } = await send(this.name, this.paths.chat, opts);
    // A server that ignores `stream` answers with one JSON document.
    if (!(res.headers.get("content-type") ?? "").includes("event-stream")) {
      const json = JSON.parse(await res.text()) as Chunk;
      const msg = json.choices?.[0]?.message;
      const text = (msg?.content ?? "").trim();
      if (text) onEvent!({ type: "text", text });
      return { text, usage: usageOf(json.usage), model: json.model || req.model, finish: json.choices?.[0]?.finish_reason || "stop", citations: citationsOf(json) };
    }
    let text = "";
    let reasoning = "";
    let model = req.model;
    let finish = "stop";
    let usage: Usage | null = null;
    let citations: Citation[] | undefined;
    for await (const { data } of sse(res, this.name, req.signal)) {
      if (data === "[DONE]") break;
      let chunk: Chunk & { error?: { message?: string } };
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new ProviderError(this.name, 0, chunk.error.message ?? "the stream failed");
      model = chunk.model || model;
      const choice = chunk.choices?.[0];
      const piece = choice?.delta?.content;
      if (piece) { text += piece; onEvent!({ type: "text", text: piece }); }
      const thought = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      if (thought) { reasoning += thought; onEvent!({ type: "reasoning", text: thought }); }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = usageOf(chunk.usage);
      const cites = citationsOf(chunk);
      if (cites && !citations) { citations = cites; onEvent!({ type: "citations", citations: cites }); }
    }
    return { text: text.trim(), reasoning: reasoning.trim() || undefined, usage: usage ?? { input: 0, output: 0, estimated: true }, model, finish, citations };
  }

  async models(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const json = await sendJson<{ data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] }>(this.name, this.paths.models, { method: "GET", headers: this.headers(), signal });
    const list = json.data ?? json.models ?? [];
    return list.filter((m) => m.id).map((m) => ({ id: m.id!, label: m.name && m.name !== m.id ? m.name : undefined, kind: kindOf(this.type, m.id!), caps: capsOf(m.id!) }));
  }

  async tts(req: TtsRequest): Promise<TtsResult> {
    const format = req.format ?? "mp3";
    const { res } = await send(this.name, this.paths.speech, { headers: this.headers(), json: { model: req.model, voice: req.voice || "alloy", input: req.text, response_format: format }, signal: req.signal });
    return { audio: new Uint8Array(await res.arrayBuffer()), mime: format === "wav" ? "audio/wav" : format === "ogg" ? "audio/ogg" : "audio/mpeg" };
  }

  async stt(req: SttRequest): Promise<SttResult> {
    if (this.type === "huggingface") {
      // Speech recognition on the router: per model, the audio as the body.
      const model = req.model.split("/").map(encodeURIComponent).join("/");
      const url = `${this.base.replace(/\/+$/, "")}/hf-inference/models/${model}`;
      const { res } = await send(this.name, url, { headers: { ...this.headers(), "Content-Type": req.mime || "audio/webm" }, raw: new Uint8Array(req.audio), signal: req.signal });
      const json = await res.json() as { text?: string };
      return { text: (json.text ?? "").trim() };
    }
    const form = new FormData();
    const ext = req.mime.includes("ogg") ? "ogg" : req.mime.includes("wav") ? "wav" : req.mime.includes("mp4") || req.mime.includes("m4a") ? "m4a" : req.mime.includes("mpeg") ? "mp3" : "webm";
    form.append("file", new Blob([new Uint8Array(req.audio)], { type: req.mime || "audio/webm" }), `audio.${ext}`);
    form.append("model", req.model);
    if (req.language) form.append("language", req.language);
    const { res } = await send(this.name, this.paths.transcriptions, { headers: this.headers(), raw: form, signal: req.signal });
    const json = await res.json() as { text?: string };
    return { text: (json.text ?? "").trim() };
  }
}

/** What kind of model a name is (OpenAI's list mixes them). */
export function kindOf(type: ProviderType, id: string): ModelKind {
  const s = id.toLowerCase();
  if (/whisper|transcribe|asr/.test(s)) return "stt";
  if (/(^|[-/])tts|speech/.test(s) && type !== "huggingface") return "tts";
  if (/embed/.test(s)) return "embed";
  return "chat";
}

/** What a model name tells about reasoning (the rest is set in the console). */
function capsOf(id: string): DiscoveredModel["caps"] {
  const s = id.toLowerCase();
  const reasons = /(^|\/)(o[1-9]|gpt-5)|reason|thinking|r1\b|deepseek-r|qwq/.test(s);
  return { stream: true, reasoning: reasons ? "adaptive" : "none", noSampling: /(^|\/)(o[1-9]|gpt-5)/.test(s) };
}

function usageOf(u: ApiUsage | null | undefined): Usage {
  if (!u) return { input: 0, output: 0, estimated: true };
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens || undefined,
    cachedInput: u.prompt_tokens_details?.cached_tokens || undefined,
  };
}

function citationsOf(c: Chunk): Citation[] | undefined {
  if (Array.isArray(c.search_results) && c.search_results.length) {
    return c.search_results.filter((r) => typeof r.url === "string").map((r) => ({ url: r.url!, title: r.title }));
  }
  if (Array.isArray(c.citations) && c.citations.length) return c.citations.filter((u) => typeof u === "string").map((url) => ({ url }));
  return undefined;
}
