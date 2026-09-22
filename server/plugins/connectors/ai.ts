// AI text connectors. Each targets one provider's HTTP API and reads its key +
// model from the environment. Without a key the connector is reported as
// not-configured and refuses to run (never an open proxy by default).

import {
  ConnectorNotConfiguredError,
  type AiConnector, type AiInput, type AiResult, type ConnectorStatus,
} from "../types";

const env = (name: string): string => (process.env[name]?.trim() || "");

function joinPrompt(input: AiInput): string {
  return input.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

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
    const res = await fetch(`${this.base()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key()}` },
      body: JSON.stringify({ model, messages: input.messages, temperature: input.temperature ?? 0.7, max_tokens: input.maxTokens ?? 512 }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    return { text: json.choices?.[0]?.message?.content?.trim() || "", model, connector: this.id };
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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.key(), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: input.maxTokens ?? 512, temperature: input.temperature ?? 0.7, system, messages }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { content?: { text?: string }[] };
    return { text: json.content?.map((c) => c.text || "").join("").trim() || "", model, connector: this.id };
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
    const res = await fetch(`${this.base().replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: input.messages, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { message?: { content?: string } };
    return { text: json.message?.content?.trim() || "", model, connector: this.id };
  }
}

/** HuggingFace Inference API (text-generation models). */
export class HuggingFaceAiConnector implements AiConnector {
  readonly id = "huggingface";
  readonly kind = "ai" as const;
  readonly label = "HuggingFace";
  readonly needs = ["HF_API_KEY", "HF_TEXT_MODEL"];
  private key() { return env("HF_API_KEY"); }
  private model() { return env("HF_TEXT_MODEL") || "meta-llama/Llama-3.1-8B-Instruct"; }
  status(): ConnectorStatus {
    const ok = this.key().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: this.model(), needs: this.needs, reason: ok ? undefined : "Set HF_API_KEY." };
  }
  async complete(input: AiInput): Promise<AiResult> {
    if (!this.key()) throw new ConnectorNotConfiguredError(this.id, "Set HF_API_KEY.");
    const model = input.model || this.model();
    const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key()}` },
      body: JSON.stringify({ inputs: joinPrompt(input), parameters: { max_new_tokens: input.maxTokens ?? 512, temperature: input.temperature ?? 0.7, return_full_text: false } }),
    });
    if (!res.ok) throw new Error(`HuggingFace ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { generated_text?: string }[] | { generated_text?: string };
    const text = Array.isArray(json) ? json[0]?.generated_text : json.generated_text;
    return { text: (text || "").trim(), model, connector: this.id };
  }
}

export function buildAiConnectors(): AiConnector[] {
  return [new OpenAiConnector(), new AnthropicConnector(), new OllamaConnector(), new HuggingFaceAiConnector()];
}
