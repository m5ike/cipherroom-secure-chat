// How much of a conversation this page keeps in memory (6.7, audit S20).
//
// Every message stays in the page's state, a received file as a blob in
// memory until someone deletes its message — a member sending without pause
// (or a server replaying a mailbox) could grow both until the tab dies. The
// conversation keeps the newest MESSAGE_CAP messages within a byte budget;
// what falls off the front has its file released. The stored history keeps
// even fewer (chat-history.ts, 500), so nothing the user could restore is
// lost here.

import type { ChatMessage } from "./chat-types";

export const MESSAGE_CAP = { messages: 5_000, bytes: 256 * 1024 * 1024 } as const;

/** Roughly what a message holds in memory: its text and an inline file. */
function weight(m: Pick<ChatMessage, "text" | "attachment">): number {
  return (typeof m.text === "string" ? m.text.length : 0) + (m.attachment?.dataUrl?.startsWith("data:") ? m.attachment.dataUrl.length : 0) + 256;
}

/** The newest messages within the caps (in order), and the ones that fall off the front. */
export function capMessages<T extends Pick<ChatMessage, "text" | "attachment">>(list: readonly T[], cap: { messages: number; bytes: number } = MESSAGE_CAP): { kept: T[]; dropped: T[] } {
  let keepFrom = Math.max(0, list.length - cap.messages);
  let bytes = 0;
  for (let i = list.length - 1; i >= keepFrom; i--) {
    bytes += weight(list[i]);
    // Always keep the newest one, whatever it weighs.
    if (bytes > cap.bytes && i < list.length - 1) { keepFrom = i + 1; break; }
  }
  return keepFrom === 0 ? { kept: list as T[], dropped: [] } : { kept: list.slice(keepFrom), dropped: list.slice(0, keepFrom) };
}

/** Messages whose received file was released (blob: URL revoked): they keep its name and size, marked as gone. */
export function withReleasedFiles<T extends Pick<ChatMessage, "attachment">>(list: T[], released: readonly string[]): T[] {
  if (!released.length) return list;
  const set = new Set(released);
  return list.map((m) => (m.attachment && set.has(m.attachment.dataUrl) ? { ...m, attachment: { ...m.attachment, dataUrl: "", dropped: true } } : m));
}
