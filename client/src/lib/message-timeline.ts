// 6.2: a message's timeline and facts, as its detail window shows them. The
// states are the vocabulary the Android app shares (MsgState, chat-types.ts):
//
//   mine     created → encrypted → sent | queued → stored (cached on the
//            server, encrypted) → forwarded → delivered → read (per recipient)
//   theirs   created → received → decrypted → displayed
//   both     revealed (a hold-to-read message shown), opened (a sealed one
//            opened with its code), expired (a vanishing one ran out),
//            hidden / unhidden (in this view only)
//
// The kinds are the ones the audit journal accepts (server/message-audit.ts).
// PURE: no DOM, no React — the web and its tests use it alike.

import type { ChatMessage, MessageAudit, MsgState } from "./chat-types";

export const MSG_STATES: readonly MsgState[] = [
  "created", "encrypted", "queued", "sent", "stored", "forwarded", "delivered", "read",
  "received", "decrypted", "displayed", "revealed", "opened", "expired", "discarded", "hidden", "unhidden",
];

const STATE_SET = new Set<string>(MSG_STATES);
export const isMsgState = (v: unknown): v is MsgState => typeof v === "string" && STATE_SET.has(v);

/** Steps that happen once per message (per recipient for the receipts). */
const ONCE = new Set<MsgState>(["created", "encrypted", "sent", "received", "decrypted", "displayed", "opened", "expired", "discarded", "stored", "forwarded", "delivered", "read"]);
/** A hold-to-read message is shown again and again: one step per reveal, not per finger twitch. */
const REVEAL_GAP_MS = 2_000;

/** The message with one more step (the same message when the step is already there). */
export function withAudit(m: ChatMessage, state: MsgState, at: number = Date.now(), meta?: string): ChatMessage {
  const list = m.audit ?? [];
  if (ONCE.has(state) && list.some((a) => a.state === state && (a.meta ?? "") === (meta ?? ""))) return m;
  if (state === "revealed") {
    const last = [...list].reverse().find((a) => a.state === "revealed");
    if (last && at - last.at < REVEAL_GAP_MS) return m;
  }
  const step: MessageAudit = meta === undefined || meta === "" ? { state, at } : { state, at, meta };
  return { ...m, audit: [...list, step] };
}

/** The steps in the order they happened (equal times keep their order). */
export function timelineOf(m: ChatMessage): MessageAudit[] {
  const list = m.audit?.length ? m.audit : [{ state: (m.mine ? "created" : "received") as MsgState, at: m.createdAt }];
  return list.map((a, i) => ({ a, i })).sort((x, y) => x.a.at - y.a.at || x.i - y.i).map((x) => x.a);
}

/** Who got my message and when: the away relay's and the peers' receipts, by recipient (the step's meta). */
export type Receipt = { name: string; stored?: number; forwarded?: number; delivered?: number; read?: number };

export function receiptsOf(m: ChatMessage): Receipt[] {
  if (!m.mine) return [];
  const by = new Map<string, Receipt>();
  for (const a of m.audit ?? []) {
    if (a.state !== "stored" && a.state !== "forwarded" && a.state !== "delivered" && a.state !== "read") continue;
    const name = (a.meta ?? "").trim();
    if (!name) continue;
    const r = by.get(name) ?? { name };
    if (r[a.state] === undefined || a.at < (r[a.state] as number)) r[a.state] = a.at;
    by.set(name, r);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A message's kinds, as the audit journal names them. */
export type MessageKindName =
  | "text" | "file" | "image" | "audio" | "video" | "location" | "tap" | "vanish" | "sealed" | "fn" | "private" | "forwarded" | "reply" | "transcript";

export function messageKinds(m: ChatMessage): MessageKindName[] {
  const out: MessageKindName[] = [];
  const f = m.flags;
  if (f?.fn) out.push("fn");
  else if (m.text || m.sealPlain) out.push("text");
  const a = m.attachment;
  if (a) {
    const mime = (a.mime || "").toLowerCase();
    out.push(a.kind === "image" || mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "file");
  }
  if (m.loc) out.push("location");
  if (f?.tap) out.push("tap");
  if (f?.vanishSeconds) out.push("vanish");
  if (f?.sealed) out.push("sealed");
  if (m.to?.length) out.push("private");
  if (m.forwardedFrom) out.push("forwarded");
  if (m.replyTo) out.push("reply");
  return out;
}

const utf8 = new TextEncoder();

/** What it weighs: the text in UTF-8 bytes (the opened text of my own sealed one) and the file. */
export function messageSize(m: ChatMessage): { text: number; file: number } {
  const text = m.flags?.sealed && m.mine && m.sealPlain !== undefined ? m.sealPlain : m.text || "";
  return { text: utf8.encode(text).length, file: m.attachment?.size ?? 0 };
}
