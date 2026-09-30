// 6.2: hiding and deleting a message — in this person's own view only.
//
//   hide     15 min, 1 h, 8 h, 1 day, or until the next sign-in (for a
//            guest: the next page load). The message stays in the history
//            with `hidden` and comes back when its time is up.
//   delete   after a confirmation: the bubble goes, and so does its content
//            from the stored history. A tombstone (id, time, deletedAt — no
//            text, no file, no position) stays, so neither the history store
//            nor the away relay brings the message back. Other people keep
//            their copy.
//
// Both are told to the server's audit journal (POST /api/chat/message-audit):
// the action, the message id, the room's blind id (the server stores a hash of
// it), the kinds, whether it was mine, a hide's end — never the text, a file
// or a key. Several actions within a moment go as one batch. PURE apart from
// the queue's fetch.

import type { ChatMessage } from "./chat-types";
import { messageKinds, withAudit } from "./message-timeline";

export type HideChoice = "15m" | "1h" | "8h" | "1d" | "signin";

/** The hide durations offered, in order (0: until the next sign-in). */
export const HIDE_CHOICES: ReadonlyArray<{ id: HideChoice; ms: number }> = [
  { id: "15m", ms: 15 * 60_000 },
  { id: "1h", ms: 60 * 60_000 },
  { id: "8h", ms: 8 * 60 * 60_000 },
  { id: "1d", ms: 24 * 60 * 60_000 },
  { id: "signin", ms: 0 },
];

export const isHideChoice = (v: unknown): v is HideChoice => HIDE_CHOICES.some((c) => c.id === v);

/** When a hide made now ends (ms); 0 = at the next sign-in. */
export function hideUntil(choice: HideChoice, now: number): number {
  const c = HIDE_CHOICES.find((x) => x.id === choice);
  return !c || c.ms === 0 ? 0 : now + c.ms;
}

export const isDeleted = (m: ChatMessage): boolean => typeof m.deletedAt === "number";

/** Hidden right now (a hide until the next sign-in lasts until it is ended). */
export function isHidden(m: ChatMessage, now: number): boolean {
  const h = m.hidden;
  return Boolean(h) && (h!.until === 0 || h!.until > now);
}

export function hiddenCount(messages: readonly ChatMessage[], now: number): number {
  let n = 0;
  for (const m of messages) if (!isDeleted(m) && isHidden(m, now)) n++;
  return n;
}

/** The earliest moment a timed hide ends (for one timer), or null. */
export function nextHideEnd(messages: readonly ChatMessage[], now: number): number | null {
  let next = Infinity;
  for (const m of messages) if (m.hidden && m.hidden.until > now && m.hidden.until < next) next = m.hidden.until;
  return next === Infinity ? null : next;
}

/** Hidden from now until `until` (0 = the next sign-in); a "hidden" step records it. */
export function hideMessage(m: ChatMessage, until: number, now: number): ChatMessage {
  return { ...withAudit(m, "hidden", now, String(until)), hidden: { at: now, until } };
}

/** Shown again (by hand, or when its time is up: meta says why). */
export function unhideMessage(m: ChatMessage, now: number, reason?: "time" | "sign-in"): ChatMessage {
  if (!m.hidden) return m;
  const { hidden: _hidden, ...rest } = withAudit(m, "unhidden", now, reason);
  return rest;
}

/**
 * The hides that are over: timed ones whose time has passed, and — at a
 * sign-in (or a guest's next page load) — the ones "until the next sign-in".
 * The same array when nothing changed.
 */
export function endHides(messages: ChatMessage[], now: number, signIn = false): ChatMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    const h = m.hidden;
    if (!h) return m;
    if (h.until > 0 && h.until <= now) { changed = true; return unhideMessage(m, h.until, "time"); }
    if (h.until === 0 && signIn) { changed = true; return unhideMessage(m, now, "sign-in"); }
    return m;
  });
  return changed ? out : messages;
}

/** What is left of a deleted message: who and when, nothing of what. */
export function deleteMessage(m: ChatMessage, now: number): ChatMessage {
  return { id: m.id, senderId: m.senderId, senderName: "", text: "", createdAt: m.createdAt, mine: m.mine, secure: m.secure, deletedAt: now };
}

/** Joins messages from a store into the current list: a deletion wins over the live copy. */
export function mergeWithDeletions(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) {
    const have = byId.get(m.id);
    if (!have || (isDeleted(m) && !isDeleted(have))) byId.set(m.id, m);
  }
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
}

/* ------------------------------------------------------------ the journal */

export type MessageAuditAction = "hide" | "unhide" | "delete";

/** One action as POST /api/chat/message-audit takes it — metadata only. */
export type MessageAuditEntry = {
  action: MessageAuditAction;
  messageId: string;
  /** The room's blind id (what the server routes by; it stores a hash). */
  room: string;
  until?: number;
  kinds?: string[];
  mine?: boolean;
  at?: number;
};

export function auditEntry(action: MessageAuditAction, m: ChatMessage, room: string, at: number, until?: number): MessageAuditEntry {
  return {
    action,
    messageId: m.id,
    room,
    ...(action === "hide" ? { until: until ?? 0 } : {}),
    kinds: messageKinds(m).slice(0, 8),
    mine: m.mine,
    at,
  };
}

/** The request body: one action, or a batch of up to 50. */
export function auditBody(entries: MessageAuditEntry[], client?: string): Record<string, unknown> {
  const who = client && /^[A-Za-z0-9_-]{1,64}$/.test(client) ? { client } : {};
  return entries.length === 1 ? { ...entries[0], ...who } : { actions: entries.slice(0, 50), ...who };
}

/**
 * Collects actions for a moment and sends them as one request (a whole
 * thread hidden at once is one batch). `send` gets each body; failures are
 * swallowed — the journal is a record, the action itself already happened.
 */
export function createAuditQueue(send: (body: Record<string, unknown>) => Promise<unknown>, opts: { delayMs?: number; client?: () => string | undefined } = {}) {
  let pending: MessageAuditEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const batch = pending;
    pending = [];
    for (let i = 0; i < batch.length; i += 50) {
      try { await send(auditBody(batch.slice(i, i + 50), opts.client?.())); } catch { /* recorded or not, the action stands */ }
    }
  };
  return {
    push(entry: MessageAuditEntry) {
      pending.push(entry);
      if (timer === null) timer = setTimeout(() => { timer = null; void flush(); }, opts.delayMs ?? 300);
    },
    flush,
  };
}

/** POSTs a body to the journal (the account token when signed in). */
export async function postMessageAudit(body: Record<string, unknown>, token: string | null, fetcher: typeof fetch = fetch): Promise<boolean> {
  const res = await fetcher("/api/chat/message-audit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return res.ok;
}
