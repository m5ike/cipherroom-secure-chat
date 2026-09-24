// The app's side of the server's AI (4.14): what this user may use
// (/api/ai/status — the account's token decides) and a conversation,
// streamed as it is written (/api/ai/chat, Server-Sent Events) and
// cancellable. What is sent goes to the server and the operator's provider —
// it is not end-to-end encrypted like the chat.

import { accountToken } from "./account";

export type AiState = "off" | "no-model" | "sign-in" | "no-limit" | "ready";
export type AiModel = { ref: string; label: string; provider: string; reasoning: boolean; vision: boolean };
export type AiStatus = { enabled: boolean; state: AiState; models: AiModel[]; default: string; limits: { maxOutputTokens: number; maxInputChars: number } };
export type AiTurn = { role: "user" | "assistant"; content: string };
export type AiReasoning = "off" | "low" | "medium" | "high";
export type AiCitation = { url: string; title?: string };
export type AiUsage = { input: number; output: number; reasoning?: number; cachedInput?: number; estimated?: boolean };
export type AiDone = { text: string; reasoning?: string; model: string; ref: string; usage: AiUsage; cost: number | null; ms: number; finish: string; citations?: AiCitation[] };
export type AiFailure = { ok: false; code: string; message: string };

const OFF: AiStatus = { enabled: false, state: "off", models: [], default: "", limits: { maxOutputTokens: 2048, maxInputChars: 24000 } };

function authHeaders(): Record<string, string> {
  const token = accountToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchAiStatus(): Promise<AiStatus> {
  try {
    const res = await fetch("/api/ai/status", { headers: { Accept: "application/json", ...authHeaders() }, cache: "no-store" });
    if (!res.ok) return OFF;
    const j = await res.json() as Partial<AiStatus>;
    return {
      enabled: Boolean(j.enabled),
      state: (["off", "no-model", "sign-in", "no-limit", "ready"] as const).includes(j.state as AiState) ? j.state as AiState : "off",
      models: Array.isArray(j.models) ? j.models.filter((m): m is AiModel => typeof m?.ref === "string") : [],
      default: typeof j.default === "string" ? j.default : "",
      limits: { ...OFF.limits, ...(j.limits ?? {}) },
    };
  } catch {
    return OFF;
  }
}

export type ChatHandlers = {
  onText?: (piece: string) => void;
  onReasoning?: (piece: string) => void;
  onCitations?: (c: AiCitation[]) => void;
};

/** Server-Sent Events from a fetch() body. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        try { yield { event, data: JSON.parse(data.join("\n")) }; } catch { /* not JSON: skip */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* released */ }
  }
}

/** One turn of a conversation, streamed. */
export async function aiChat(
  input: { model?: string; messages: AiTurn[]; system?: string; reasoning?: AiReasoning },
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<{ ok: true; done: AiDone } | AiFailure> {
  let res: Response;
  try {
    res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeaders() },
      body: JSON.stringify({ ...input, stream: true }),
      signal,
    });
  } catch (err) {
    return { ok: false, code: (err as Error).name === "AbortError" ? "cancelled" : "network", message: (err as Error).message };
  }
  if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("event-stream")) {
    const j = await res.json().catch(() => ({})) as { code?: string; message?: string };
    return { ok: false, code: j.code ?? `http-${res.status}`, message: j.message ?? `HTTP ${res.status}` };
  }
  try {
    for await (const { event, data } of readEvents(res.body)) {
      const d = data as Record<string, unknown>;
      if (event === "delta" && typeof d.text === "string") handlers.onText?.(d.text);
      else if (event === "reasoning" && typeof d.text === "string") handlers.onReasoning?.(d.text);
      else if (event === "citations" && Array.isArray(d.citations)) handlers.onCitations?.(d.citations as AiCitation[]);
      else if (event === "done") return { ok: true, done: d as unknown as AiDone };
      else if (event === "error") return { ok: false, code: String(d.code ?? "error"), message: String(d.message ?? "The AI call failed.") };
    }
    return { ok: false, code: "incomplete", message: "The answer stopped before it was complete." };
  } catch (err) {
    return { ok: false, code: signal?.aborted ? "cancelled" : "network", message: (err as Error).message };
  }
}
