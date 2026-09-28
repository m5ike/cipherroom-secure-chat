// m5.ai for functions (4.15, stage 5), host-side: a function reaches the
// instance's AI & speech layer (server/ai) through here. The call is made as
// the function's caller (source "function"), so it is subject to the module
// switch, the groups and the budgets, and it lands in the AI journal like any
// other. What leaves the sandbox to the model is only what the function passes.

import { Buffer } from "node:buffer";
import { chat, modelsFor, stt, tts, type Caller as AiCaller } from "../ai/service";
import type { ChatMessage, Reasoning } from "../ai/types";
import type { Caller } from "./types";

export class AiCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AiCallError"; }
}

/** The function's caller, as the AI layer sees it (counted, limited, logged). */
export function aiCallerOf(caller: Caller): AiCaller {
  return { source: "function", actor: caller.name || "function", account: caller.account || "", groups: caller.groups ?? [], console: false };
}

const bytesOf = (v: unknown): Buffer | null => (v && typeof v === "object" && typeof (v as { $b?: unknown }).$b === "string" ? Buffer.from((v as { $b: string }).$b, "base64") : null);

function messagesOf(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new AiCallError("bad-argument", "messages must be a list of { role, content }");
  const out: ChatMessage[] = [];
  for (const m of raw as Array<{ role?: unknown; content?: unknown }>) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = typeof m.content === "string" ? m.content : String(m.content ?? "");
    if (content) out.push({ role, content });
  }
  if (!out.length) throw new AiCallError("bad-argument", "at least one message is required");
  return out;
}

const REASONING = new Set(["off", "low", "medium", "high"]);

/** How many tokens (input+output) a call reported, for the per-run budget. */
export type AiUsageSink = (tokens: number) => void;

/** Runs one m5.ai.* call and returns a JSON-friendly result. */
export async function hostAi(op: string, args: unknown[], caller: Caller, sink: AiUsageSink, signal?: AbortSignal): Promise<unknown> {
  const aiCaller = aiCallerOf(caller);
  const a0 = (args[0] ?? {}) as Record<string, unknown>;
  switch (op) {
    case "models": {
      return modelsFor(aiCaller, "chat").map((m) => ({ ref: m.ref, label: m.model.label || m.model.id, provider: m.provider.label, reasoning: m.model.caps.reasoning !== "none", vision: m.model.caps.vision }));
    }
    case "chat": {
      const spec = a0;
      const messages = spec.messages !== undefined ? messagesOf(spec.messages) : (typeof spec.prompt === "string" ? [{ role: "user" as const, content: spec.prompt }] : messagesOf(undefined));
      const reasoning = typeof spec.reasoning === "string" && REASONING.has(spec.reasoning) ? spec.reasoning as Reasoning : undefined;
      const out = await chat({
        model: typeof spec.model === "string" ? spec.model : undefined,
        system: typeof spec.system === "string" ? spec.system : undefined,
        messages,
        maxTokens: typeof spec.maxTokens === "number" ? Math.floor(spec.maxTokens) : undefined,
        reasoning,
        json: spec.json === true,
        signal,
      }, aiCaller);
      sink((out.usage.input || 0) + (out.usage.output || 0));
      return { text: out.text, reasoning: out.reasoning ?? null, model: out.model, ref: out.ref, usage: out.usage, cost: out.cost, ms: out.ms, finish: out.finish, citations: out.citations ?? [] };
    }
    case "tts": {
      const out = await tts({ model: typeof a0.model === "string" ? a0.model : undefined, text: String(a0.text ?? ""), voice: typeof a0.voice === "string" ? a0.voice : undefined, format: a0.format as "mp3" | undefined, signal }, aiCaller);
      return { audio: { $b: Buffer.from(out.audio).toString("base64") }, mime: out.mime, ref: out.ref };
    }
    case "stt": {
      const audio = bytesOf(a0.audio);
      if (!audio) throw new AiCallError("bad-argument", "audio (bytes) is required");
      const out = await stt({ model: typeof a0.model === "string" ? a0.model : undefined, audio: new Uint8Array(audio), mime: String(a0.mime || "audio/webm"), language: typeof a0.language === "string" ? a0.language : undefined, signal }, aiCaller);
      return { text: out.text, ref: out.ref };
    }
    default:
      throw new AiCallError("unknown-call", `m5.ai: no such call "${op.slice(0, 40)}"`);
  }
}

export const AI_OPS = ["chat", "models", "tts", "stt"] as const;
/** Default tokens a single run may spend on AI, unless the model sets its own. */
export const AI_RUN_TOKEN_CAP = 500_000;
