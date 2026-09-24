// Anthropic's Messages API (4.14): streaming, adaptive reasoning with an
// effort (Claude 5 generation) or a thinking budget (older models), usage
// with cached input, and the models list with what each model can do.

import { send, sendJson, sse, withoutRefused, ProviderError } from "../net";
import {
  DEFAULT_CAPS, type ChatEvent, type ChatRequest, type ChatResult, type CallTrace, type DiscoveredModel, type ModelCaps, type ProviderAdapter, type Usage,
} from "../types";

const VERSION = "2023-06-01";
/** Thinking budgets for models without adaptive reasoning. */
const BUDGET = { low: 2048, medium: 6000, high: 16000 } as const;

type Block = { type?: string; text?: string; thinking?: string };
type ApiUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type ApiMessage = { content?: Block[]; model?: string; stop_reason?: string | null; usage?: ApiUsage };

export class AnthropicAdapter implements ProviderAdapter {
  readonly type = "anthropic" as const;
  constructor(private readonly base: string, private readonly key: string, private readonly name = "Anthropic") {}

  private url(path: string): string { return `${this.base.replace(/\/+$/, "")}${path}`; }
  private headers(): Record<string, string> { return { "x-api-key": this.key, "anthropic-version": VERSION }; }

  /** The request body (exported for tests and the playground's trace). */
  body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const caps: ModelCaps = { ...DEFAULT_CAPS, reasoning: "adaptive", ...(req.caps ?? {}) };
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.system) body.system = req.system;
    if (stream) body.stream = true;
    const r = req.reasoning ?? "off";
    if (r !== "off" && caps.reasoning === "budget") {
      body.thinking = { type: "enabled", budget_tokens: BUDGET[r] };
      body.max_tokens = req.maxTokens + BUDGET[r];
    } else if (r !== "off" && caps.reasoning === "adaptive") {
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: r };
    } else if (caps.reasoning === "adaptive") {
      // As little as the model allows: no thinking where it may be switched off, the lowest effort.
      body.thinking = { type: "disabled" };
      body.output_config = { effort: "low" };
    }
    // Sampling and thinking do not go together; newer models refuse sampling altogether (then retried without).
    const thinking = (body.thinking as { type?: string } | undefined)?.type;
    if (req.temperature !== undefined && !caps.noSampling && (!thinking || thinking === "disabled")) body.temperature = req.temperature;
    return body;
  }

  async chat(req: ChatRequest, onEvent?: (e: ChatEvent) => void, trace?: CallTrace[]): Promise<ChatResult> {
    const stream = Boolean(onEvent);
    const opts = { headers: this.headers(), json: this.body(req, stream), signal: req.signal, adjust: withoutRefused, trace };
    if (!stream) {
      const json = await sendJson<ApiMessage>(this.name, this.url("/v1/messages"), opts);
      const blocks = json.content ?? [];
      return {
        text: blocks.filter((b) => (b.type ?? "text") === "text").map((b) => b.text ?? "").join("").trim(),
        reasoning: blocks.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("").trim() || undefined,
        usage: usageOf(json.usage),
        model: json.model || req.model,
        finish: json.stop_reason || "end_turn",
      };
    }
    const { res } = await send(this.name, this.url("/v1/messages"), opts);
    let text = "";
    let reasoning = "";
    let model = req.model;
    let finish = "end_turn";
    const usage: Usage = { input: 0, output: 0 };
    for await (const { data } of sse(res, this.name, req.signal)) {
      let ev: { type?: string; message?: ApiMessage; delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string }; usage?: ApiUsage; error?: { type?: string; message?: string } };
      try { ev = JSON.parse(data); } catch { continue; }
      switch (ev.type) {
        case "message_start":
          model = ev.message?.model || model;
          Object.assign(usage, usageOf(ev.message?.usage));
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta" && ev.delta.text) { text += ev.delta.text; onEvent!({ type: "text", text: ev.delta.text }); }
          else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) { reasoning += ev.delta.thinking; onEvent!({ type: "reasoning", text: ev.delta.thinking }); }
          break;
        case "message_delta":
          if (ev.delta?.stop_reason) finish = ev.delta.stop_reason;
          if (ev.usage) {
            // output_tokens is the total so far; the cache numbers may come here too.
            if (typeof ev.usage.output_tokens === "number") usage.output = ev.usage.output_tokens;
            if (typeof ev.usage.input_tokens === "number" && ev.usage.input_tokens > 0) usage.input = ev.usage.input_tokens;
            if (typeof ev.usage.cache_read_input_tokens === "number") usage.cachedInput = ev.usage.cache_read_input_tokens;
          }
          break;
        case "error":
          throw new ProviderError(this.name, 0, `${ev.error?.type ?? "error"}: ${ev.error?.message ?? "the stream failed"}`);
        default:
          break;
      }
    }
    return { text: text.trim(), reasoning: reasoning.trim() || undefined, usage, model, finish };
  }

  async models(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const out: DiscoveredModel[] = [];
    let after = "";
    for (let page = 0; page < 10; page++) {
      const json = await sendJson<{ data?: ApiModel[]; has_more?: boolean; last_id?: string }>(this.name, this.url(`/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`), { method: "GET", headers: this.headers(), signal });
      for (const m of json.data ?? []) if (m.id) out.push(modelOf(m));
      if (!json.has_more || !json.last_id) break;
      after = json.last_id;
    }
    return out;
  }
}

type ApiModel = {
  id?: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: {
    thinking?: { supported?: boolean; types?: { adaptive?: { supported?: boolean }; enabled?: { supported?: boolean } } };
    effort?: { supported?: boolean };
    image_input?: { supported?: boolean };
  };
};

function modelOf(m: ApiModel): DiscoveredModel {
  const c = m.capabilities;
  const reasoning: ModelCaps["reasoning"] = c?.thinking
    ? (c.thinking.types?.adaptive?.supported ? "adaptive" : c.thinking.types?.enabled?.supported || c.thinking.supported ? "budget" : "none")
    : "adaptive";
  return {
    id: m.id!,
    label: m.display_name,
    kind: "chat",
    context: m.max_input_tokens,
    maxOutput: m.max_tokens,
    caps: { stream: true, tools: true, reasoning, vision: c?.image_input?.supported ?? true, json: false },
  };
}

function usageOf(u: ApiUsage | undefined): Usage {
  return {
    input: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
    output: u?.output_tokens ?? 0,
    cachedInput: u?.cache_read_input_tokens || undefined,
  };
}
