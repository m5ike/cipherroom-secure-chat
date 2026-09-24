// Ollama's own API (4.14): /api/chat streamed as newline-delimited JSON,
// thinking models (`think`), JSON answers (`format`), the local models
// (/api/tags). No key.

import { ndjson, send, sendJson, withoutRefused, ProviderError } from "../net";
import { DEFAULT_CAPS, type ChatEvent, type ChatRequest, type ChatResult, type CallTrace, type DiscoveredModel, type ProviderAdapter, type Usage } from "../types";

type Line = {
  model?: string;
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

export class OllamaAdapter implements ProviderAdapter {
  readonly type = "ollama" as const;
  constructor(private readonly base: string, private readonly name = "Ollama") {}

  private url(path: string): string { return `${this.base.replace(/\/+$/, "")}${path}`; }

  body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const caps = { ...DEFAULT_CAPS, ...(req.caps ?? {}) };
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });
    const options: Record<string, unknown> = { num_predict: req.maxTokens };
    if (req.temperature !== undefined && !caps.noSampling) options.temperature = req.temperature;
    const body: Record<string, unknown> = { model: req.model, messages, stream, options };
    if (caps.reasoning !== "none") body.think = (req.reasoning ?? "off") !== "off";
    if (req.json) body.format = "json";
    return body;
  }

  async chat(req: ChatRequest, onEvent?: (e: ChatEvent) => void, trace?: CallTrace[]): Promise<ChatResult> {
    const stream = Boolean(onEvent);
    const opts = { json: this.body(req, stream), signal: req.signal, adjust: (b: Record<string, unknown>, m: string) => ("think" in b && /think/i.test(m) ? dropThink(b) : withoutRefused(b, m)), trace };
    if (!stream) {
      const json = await sendJson<Line>(this.name, this.url("/api/chat"), opts);
      if (json.error) throw new ProviderError(this.name, 0, json.error);
      return {
        text: (json.message?.content ?? "").trim(),
        reasoning: (json.message?.thinking ?? "").trim() || undefined,
        usage: usageOf(json),
        model: json.model || req.model,
        finish: json.done_reason || "stop",
      };
    }
    const { res } = await send(this.name, this.url("/api/chat"), opts);
    let text = "";
    let reasoning = "";
    let last: Line = {};
    for await (const line of ndjson<Line>(res, this.name, req.signal)) {
      if (line.error) throw new ProviderError(this.name, 0, line.error);
      const piece = line.message?.content;
      if (piece) { text += piece; onEvent!({ type: "text", text: piece }); }
      const thought = line.message?.thinking;
      if (thought) { reasoning += thought; onEvent!({ type: "reasoning", text: thought }); }
      if (line.done) { last = line; break; }
    }
    return { text: text.trim(), reasoning: reasoning.trim() || undefined, usage: usageOf(last), model: last.model || req.model, finish: last.done_reason || "stop" };
  }

  async models(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const json = await sendJson<{ models?: { name?: string; model?: string; details?: { family?: string; parameter_size?: string } }[] }>(this.name, this.url("/api/tags"), { method: "GET", signal });
    return (json.models ?? []).filter((m) => m.name || m.model).map((m) => {
      const id = (m.model || m.name)!;
      const s = id.toLowerCase();
      return {
        id,
        label: m.details?.parameter_size ? `${m.name ?? id} · ${m.details.parameter_size}` : undefined,
        kind: /embed/.test(s) ? "embed" as const : "chat" as const,
        caps: { stream: true, reasoning: /deepseek-r1|qwq|qwen3|gpt-oss|magistral|think/.test(s) ? "adaptive" as const : "none" as const, vision: /llava|vision|gemma3|qwen2\.5vl|llama3\.2-vision/.test(s), json: true },
      };
    });
  }
}

function dropThink(b: Record<string, unknown>): Record<string, unknown> {
  const { think: _think, ...rest } = b;
  return rest;
}

function usageOf(l: Line): Usage {
  if (typeof l.prompt_eval_count !== "number" && typeof l.eval_count !== "number") return { input: 0, output: 0, estimated: true };
  return { input: l.prompt_eval_count ?? 0, output: l.eval_count ?? 0 };
}
