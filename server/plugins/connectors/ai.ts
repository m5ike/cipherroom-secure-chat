// AI text connectors. Each targets one provider's HTTP API and reads its key +
// model from the environment. Without a key the connector is reported as
// not-configured and refuses to run (never an open proxy by default).

import {
  ConnectorNotConfiguredError,
  type AiConnector, type AiInput, type AiResult, type ConnectorStatus,
} from "../types";
import { postJson, withoutRefusedParam } from "../http";

const env = (name: string): string => (process.env[name]?.trim() || "");

// 4.0.6: sampling parameters are sent only when the caller sets them — newer
// models refuse `temperature` (Claude after Opus 4.6, OpenAI's reasoning
// models); a refusal is retried once without it.
const DEFAULT_MAX_TOKENS = 1024;

type ChatCompletion = { choices?: { message?: { content?: string | null; reasoning_content?: string } }[]; model?: string };

/** OpenAI (and any OpenAI-compatible endpoint via OPENAI_BASE_URL). */
export class OpenAiConnector implements AiConnector {
  readonly id = "openai";
  readonly kind = "ai" as const;
  readonly label = "OpenAI";
  readonly needs = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"];
  private key() { return env("OPENAI_API_KEY"); }
  private model() { return env("OPENAI_MODEL") || "gpt-4o-mini"; }
  private base() { return env("OPENAI_BASE_URL") || "https://api.openai.com/v1"; }
  status(): ConnectorStatus {
    const ok = this.key().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: this.model(), needs: this.needs, reason: ok ? undefined : "Set OPENAI_API_KEY." };
  }
  async complete(input: AiInput): Promise<AiResult> {
    if (!this.key()) throw new ConnectorNotConfiguredError(this.id, "Set OPENAI_API_KEY.");
    const model = input.model || this.model();
    // api.openai.com takes max_completion_tokens (max_tokens is refused by its newer models);
    // OpenAI-compatible servers (llama.cpp, vLLM, LM Studio…) know max_tokens.
    const official = /(^|\.)openai\.com$/.test(hostOf(this.base()));
    const body: Record<string, unknown> = { model, messages: input.messages, [official ? "max_completion_tokens" : "max_tokens"]: input.maxTokens ?? DEFAULT_MAX_TOKENS };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    const json = await postJson<ChatCompletion>("OpenAI", `${this.base().replace(/\/$/, "")}/chat/completions`, { Authorization: `Bearer ${this.key()}` }, body, withoutRefusedParam);
    return { text: json.choices?.[0]?.message?.content?.trim() || "", model: json.model || model, connector: this.id };
  }
}

/** Anthropic Messages API. */
export class AnthropicConnector implements AiConnector {
  readonly id = "anthropic";
  readonly kind = "ai" as const;
  readonly label = "Anthropic";
  readonly needs = ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"];
  private key() { return env("ANTHROPIC_API_KEY"); }
  private model() { return env("ANTHROPIC_MODEL") || "claude-sonnet-5"; }
  status(): ConnectorStatus {
    const ok = this.key().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: this.model(), needs: this.needs, reason: ok ? undefined : "Set ANTHROPIC_API_KEY." };
  }
  async complete(input: AiInput): Promise<AiResult> {
    if (!this.key()) throw new ConnectorNotConfiguredError(this.id, "Set ANTHROPIC_API_KEY.");
    const model = input.model || this.model();
    const system = input.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") || undefined;
    const messages = input.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = { model, max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS, messages };
    if (system) body.system = system;
    if (input.temperature !== undefined) body.temperature = input.temperature;
    const json = await postJson<{ content?: { type?: string; text?: string }[]; model?: string }>(
      "Anthropic", `${(env("ANTHROPIC_BASE_URL") || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
      { "x-api-key": this.key(), "anthropic-version": "2023-06-01" }, body, withoutRefusedParam,
    );
    // Only the answer: thinking blocks and tool calls are not text.
    const text = (json.content ?? []).filter((c) => (c.type ?? "text") === "text").map((c) => c.text || "").join("").trim();
    return { text, model: json.model || model, connector: this.id };
  }
}

/** Ollama — local models, no key. Enabled only when OLLAMA_URL is set. */
export class OllamaConnector implements AiConnector {
  readonly id = "ollama";
  readonly kind = "ai" as const;
  readonly label = "Ollama (local)";
  readonly needs = ["OLLAMA_URL", "OLLAMA_MODEL"];
  private base() { return env("OLLAMA_URL"); }
  private model() { return env("OLLAMA_MODEL") || "llama3.1"; }
  status(): ConnectorStatus {
    const ok = this.base().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: this.model(), needs: this.needs, reason: ok ? undefined : "Set OLLAMA_URL (e.g. http://127.0.0.1:11434)." };
  }
  async complete(input: AiInput): Promise<AiResult> {
    if (!this.base()) throw new ConnectorNotConfiguredError(this.id, "Set OLLAMA_URL.");
    const model = input.model || this.model();
    const options: Record<string, unknown> = { num_predict: input.maxTokens ?? DEFAULT_MAX_TOKENS };
    if (input.temperature !== undefined) options.temperature = input.temperature;
    const json = await postJson<{ message?: { content?: string } }>("Ollama", `${this.base().replace(/\/$/, "")}/api/chat`, {}, { model, messages: input.messages, stream: false, options });
    return { text: json.message?.content?.trim() || "", model, connector: this.id };
  }
}

/**
 * HuggingFace Inference Providers — the OpenAI-compatible router
 * (https://router.huggingface.co/v1). The old serverless host
 * api-inference.huggingface.co is retired (it no longer resolves). A model id
 * may carry a provider or a policy: "meta-llama/Llama-3.1-8B-Instruct:novita",
 * "…:cheapest", "…:fastest" (the default).
 */
export class HuggingFaceAiConnector implements AiConnector {
  readonly id = "huggingface";
  readonly kind = "ai" as const;
  readonly label = "HuggingFace";
  readonly needs = ["HF_API_KEY", "HF_TEXT_MODEL", "HF_BASE_URL"];
  private key() { return env("HF_API_KEY"); }
  private model() { return env("HF_TEXT_MODEL") || "meta-llama/Llama-3.1-8B-Instruct"; }
  status(): ConnectorStatus {
    const ok = this.key().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: this.model(), needs: this.needs, reason: ok ? undefined : "Set HF_API_KEY." };
  }
  async complete(input: AiInput): Promise<AiResult> {
    if (!this.key()) throw new ConnectorNotConfiguredError(this.id, "Set HF_API_KEY.");
    const model = input.model || this.model();
    const body: Record<string, unknown> = { model, messages: input.messages, max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    const json = await postJson<ChatCompletion>("HuggingFace", `${hfBase()}/v1/chat/completions`, { Authorization: `Bearer ${this.key()}` }, body, withoutRefusedParam);
    return { text: json.choices?.[0]?.message?.content?.trim() || "", model: json.model || model, connector: this.id };
  }
}

/** The HuggingFace router (HF_BASE_URL overrides it, e.g. for a proxy). */
export function hfBase(): string {
  return (env("HF_BASE_URL") || "https://router.huggingface.co").replace(/\/$/, "");
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

export function buildAiConnectors(): AiConnector[] {
  return [new OpenAiConnector(), new AnthropicConnector(), new OllamaConnector(), new HuggingFaceAiConnector()];
}
