// The turns of a conversation sent to the AI (4.14): user / assistant, text,
// ending with the user's — shared by the app's and the console's endpoints.

import type { ChatMessage } from "./types";

export const MAX_MESSAGES = 200;

export function sanitizeMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    out.push({ role, content });
  }
  return out[out.length - 1].role === "user" ? out : null;
}
