// Everything a peer sends is untrusted until it has been through here.
//
// A decrypted payload only proves the sender knows the room key. Before this
// module the app spread it straight into the conversation: a peer could
// send `text: {}` and blank the page on render, claim another member's
// sender id (or ours, making the message look like our own), or hand over
// an attachment whose MIME type turned a downloaded file into a page
// running in this origin. Now each field is checked, bounded and coerced,
// and anything that does not fit is dropped.

import { sanitizeFnOutputs } from "./fn-outputs";
import { clampVanishSeconds, type MsgFlags } from "./message-kinds";
import type { AttachmentMeta } from "./chat-types";
import { parseProfileFrame, type ProfileFrame } from "./profile/room";
import { SYSTEM_MESSENGER_ID, cleanModelIcon } from "./system-messenger";
import { normalizeDisplayName } from "./names";

export const PAYLOAD_LIMITS = {
  idChars: 96,
  textChars: 64_000,
  nameChars: 48,
  replyChars: 400,
  recipients: 50,
  /** A peer's clock may be off, but not by more than this into the future. */
  futureSkewMs: 5 * 60 * 1000,
  maxTtlMinutes: 7 * 24 * 60,
  attachmentNameChars: 200,
  inlineDataUrlChars: 1_000_000,
} as const;

/** Media types that render safely from a blob:/data: URL in this origin.
 *  Everything else is served as a download (application/octet-stream):
 *  an HTML or SVG file opened from the chat must not run as a page here. */
const SAFE_MIME = /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/(mpeg|mp4|ogg|wav|webm|aac|flac)|video\/(mp4|webm|ogg)|text\/plain|application\/pdf)$/;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;

export function safeMime(mime: unknown): string {
  const m = typeof mime === "string" ? mime.trim().toLowerCase().split(";")[0] : "";
  return SAFE_MIME.test(m) ? m : "application/octet-stream";
}

export function isInlineImage(mime: string): boolean {
  return IMAGE_MIME.test(mime);
}

/** A file name to show and to download under: no paths, no controls. */
export function safeFileName(name: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = (typeof name === "string" ? name : "").replace(/[\u0000-\u001f\u007f<>:"/\\|?*‪-‮⁦-⁩]/g, "_").trim();
  return (s.replace(/^\.+/, "_") || "file").slice(0, PAYLOAD_LIMITS.attachmentNameChars);
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const clean = (v: unknown, max: number, fallback = ""): string => {
  // eslint-disable-next-line no-control-regex
  const s = typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : "";
  return s.slice(0, max) || fallback;
};

/** An inline attachment from a peer: a data: URL of a safe type, or nothing. */
export function validateAttachment(value: unknown): AttachmentMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  const url = str(a.dataUrl, PAYLOAD_LIMITS.inlineDataUrlChars);
  if (url === null) return undefined;
  const mime = safeMime(a.mime);
  let dataUrl = "";
  if (url !== "") {
    // Only data: from a peer. A blob: URL points into the sender's memory,
    // anything else would make this page fetch what the sender chose.
    const m = /^data:([^;,]*)(;base64)?,/i.exec(url);
    if (!m) return undefined;
    // Re-label the data with the safe type, whatever the sender claimed.
    dataUrl = `data:${mime}${m[2] ?? ""},${url.slice(m[0].length)}`;
  }
  return {
    kind: isInlineImage(mime) && a.kind === "image" ? "image" : "file",
    name: safeFileName(a.name),
    mime,
    size: typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? Math.floor(a.size) : 0,
    dataUrl,
    ...(a.dropped === true ? { dropped: true } : {}),
  };
}

const FN_EVENTS = new Set(["response", "button", "form", "error"]);

function validateFlags(value: unknown): MsgFlags | undefined {
  if (!value || typeof value !== "object") return undefined;
  const f = value as Record<string, unknown>;
  const out: MsgFlags = {};
  if (f.tap === true) out.tap = true;
  if (typeof f.vanishSeconds === "number" && f.vanishSeconds > 0) out.vanishSeconds = clampVanishSeconds(f.vanishSeconds);
  const sealed = f.sealed as Record<string, unknown> | undefined;
  if (sealed && typeof sealed === "object" && str(sealed.salt, 64) && str(sealed.iv, 64)) {
    out.sealed = { salt: sealed.salt as string, iv: sealed.iv as string };
    if (typeof sealed.v === "number") out.sealed.v = sealed.v;
    if (typeof sealed.it === "number" && sealed.it >= 100_000 && sealed.it <= 5_000_000) out.sealed.it = sealed.it;
  }
  const fn = f.fn as Record<string, unknown> | undefined;
  if (fn && typeof fn === "object") {
    const keyword = str(fn.keyword, 40);
    const name = str(fn.name, 120);
    if (keyword) {
      out.fn = { keyword, name: name || keyword };
      // 5.3: the processing session a reply / click continues, and the outputs to render.
      if (typeof fn.model === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(fn.model)) out.fn.model = fn.model;
      if (typeof fn.chain === "string" && /^chn_[a-z0-9]{6,40}$/.test(fn.chain)) out.fn.chain = fn.chain;
      if (typeof fn.call === "number" && Number.isInteger(fn.call) && fn.call >= 0 && fn.call < 10_000) out.fn.call = fn.call;
      if (Array.isArray(fn.events)) { const ev = fn.events.filter((e): e is string => typeof e === "string" && FN_EVENTS.has(e)); if (ev.length) out.fn.events = [...new Set(ev)]; }
      if (Array.isArray(fn.outputs)) { const outputs = sanitizeFnOutputs(fn.outputs); if (outputs.length) out.fn.outputs = outputs; }
      if (fn.origin === "error") out.fn.origin = "error";
      // 6.11: the model's icon its answer is shown under (display only — the sender stays the member).
      const icon = cleanModelIcon(fn.icon);
      if (icon) out.fn.icon = icon;
    }
  }
  return out.tap || out.vanishSeconds || out.sealed || out.fn ? out : undefined;
}

export type ChatPayload = {
  kind?: "text";
  id: string;
  text: string;
  createdAt: number;
  senderId: string;
  senderName: string;
  attachment?: AttachmentMeta;
  ttlMinutes?: number;
  flags?: MsgFlags;
  to?: string[];
  replyTo?: { id: string; senderName: string; text: string };
  forwardedFrom?: string;
  /** 6.1: where the sender was when writing it (Android: Settings › Location › in the header). */
  loc?: MessageLoc;
};

export type MessageLoc = { lat: number; lon: number; acc?: number; at?: number };

/**
 * 6.1: a delivery / read receipt between online peers — sealed with the pair
 * key to that one peer. Only callers that pass { receipts: true } get it;
 * everyone else drops it like any unknown kind (older clients do the same).
 */
export type ReceiptPayload = { kind: "receipt"; id: string; createdAt: number; senderId: string; senderName: string; state: "delivered" | "read"; ids: string[] };

/** loc: lat −90..90, lon −180..180, acc ≥ 0; rounded to 5 decimals (~1 m). */
export function validateLoc(v: unknown): MessageLoc | undefined {
  if (!v || typeof v !== "object") return undefined;
  const l = v as Record<string, unknown>;
  const lat = l.lat, lon = l.lon;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  const out: MessageLoc = { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
  if (typeof l.acc === "number" && Number.isFinite(l.acc) && l.acc >= 0 && l.acc < 1e6) out.acc = Math.round(l.acc);
  if (typeof l.at === "number" && Number.isFinite(l.at) && l.at > 0) out.at = Math.floor(l.at);
  return out;
}

export type AudioStatusPayload = { kind: "audio-status"; id: string; createdAt: number; senderId: string; senderName: string; status: "off" | "joining" | "live" | "muted" };

/** 6.7: a member's profile — announce / request / full (profile/room.ts); only for callers passing { profiles: true }. */
export type ProfilePayload = { kind: "profile"; id: string; createdAt: number; senderId: string; senderName: string } & ProfileFrame;

/** Ids the app itself uses for its own notices; a peer may not borrow them.
 *  6.11: "system-messenger" — the sender of a model's answers shown here. */
const RESERVED_SENDERS = new Set(["system", "self", "server", "admin", SYSTEM_MESSENGER_ID]);

/** 6.7: an id only this app gives — its own notices, or a caller-only function
 *  answer ("function:<keyword>"; 6.11 "system-messenger" — whose outputs act by
 *  themselves). Never a peer's: a member cannot pass a message off as the system's. */
export function isReservedSender(id: string): boolean {
  return RESERVED_SENDERS.has(id) || id.startsWith("function:") || id.startsWith(`${SYSTEM_MESSENGER_ID}:`);
}

/**
 * Checks a decrypted payload. `transportSender` is who actually delivered
 * it (the data channel's peer, or the peer the server says relayed it) —
 * the payload's own senderId must match, and may never be ours.
 */
type PayloadOpts = { transportSender?: string; myId?: string; now?: number; receipts?: boolean; profiles?: boolean };
export function validatePayload(value: unknown, opts: PayloadOpts & { profiles: true }): ChatPayload | AudioStatusPayload | ReceiptPayload | ProfilePayload | null;
export function validatePayload(value: unknown, opts?: PayloadOpts & { profiles?: false }): ChatPayload | AudioStatusPayload | ReceiptPayload | null;
export function validatePayload(value: unknown, opts: PayloadOpts = {}): ChatPayload | AudioStatusPayload | ReceiptPayload | ProfilePayload | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const now = opts.now ?? Date.now();
  const id = str(p.id, PAYLOAD_LIMITS.idChars);
  const senderId = str(p.senderId, PAYLOAD_LIMITS.idChars);
  if (!id || !senderId || isReservedSender(senderId)) return null;
  if (opts.myId && senderId === opts.myId) return null;
  if (opts.transportSender && senderId !== opts.transportSender) return null;
  const createdAt = typeof p.createdAt === "number" && Number.isFinite(p.createdAt) ? Math.min(p.createdAt, now + PAYLOAD_LIMITS.futureSkewMs) : now;
  // 6.12 (F-22): bidi controls, zero-width and other format characters out, NFKC, one space, a cap (names.ts).
  const senderName = normalizeDisplayName(p.senderName, PAYLOAD_LIMITS.nameChars) || `peer-${senderId.slice(-4)}`;

  if (p.kind === "audio-status") {
    const status = p.status;
    if (status !== "off" && status !== "joining" && status !== "live" && status !== "muted") return null;
    return { kind: "audio-status", id, createdAt, senderId, senderName, status };
  }
  if (p.kind === "receipt") {
    if (!opts.receipts || (p.state !== "delivered" && p.state !== "read") || !Array.isArray(p.ids)) return null;
    const ids = p.ids.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80).slice(0, 50);
    return ids.length ? { kind: "receipt", id, createdAt, senderId, senderName, state: p.state, ids } : null;
  }
  if (p.kind === "profile") {
    const frame = opts.profiles ? parseProfileFrame(p) : null;
    return frame ? { kind: "profile", id, createdAt, senderId, senderName, ...frame } : null;
  }
  // 6.10: anything but a chat message is dropped here — a "note" (to myself) is only ever made locally.
  if (p.kind !== undefined && p.kind !== "text") return null;
  const text = p.text === undefined ? "" : str(p.text, PAYLOAD_LIMITS.textChars);
  if (text === null) return null;

  const out: ChatPayload = { id, text, createdAt, senderId, senderName };
  const attachment = validateAttachment(p.attachment);
  if (attachment) out.attachment = attachment;
  if (!text && !attachment) return null;
  if (typeof p.ttlMinutes === "number" && p.ttlMinutes > 0) out.ttlMinutes = Math.min(p.ttlMinutes, PAYLOAD_LIMITS.maxTtlMinutes);
  const flags = validateFlags(p.flags);
  if (flags) out.flags = flags;
  if (Array.isArray(p.to)) out.to = p.to.filter((n): n is string => typeof n === "string").slice(0, PAYLOAD_LIMITS.recipients).map((n) => normalizeDisplayName(n, PAYLOAD_LIMITS.nameChars));
  const reply = p.replyTo as Record<string, unknown> | undefined;
  if (reply && typeof reply === "object" && str(reply.id, PAYLOAD_LIMITS.idChars)) {
    // What the sender CLAIMS the quoted message said: shown only after verifyQuote() found the real one.
    out.replyTo = { id: reply.id as string, senderName: normalizeDisplayName(reply.senderName, PAYLOAD_LIMITS.nameChars), text: clean(reply.text, PAYLOAD_LIMITS.replyChars) };
  }
  if (typeof p.forwardedFrom === "string") {
    const from = normalizeDisplayName(p.forwardedFrom, PAYLOAD_LIMITS.nameChars);
    if (from) out.forwardedFrom = from;
  }
  const loc = validateLoc(p.loc);
  if (loc) out.loc = loc;
  return out;
}

/* ------------------------------------------------- quotes and forwards (6.12, F-22) */

/** A stored message as far as a quote of it needs it. */
export type QuotableMessage = {
  id: string;
  senderName: string;
  text: string;
  mine?: boolean;
  flags?: { sealed?: unknown };
  attachment?: { name: string };
};

/**
 * A quote ("reply to …") as the bubble shows it. The sender of the reply only
 * CLAIMS what the quoted message said — any member can write any `replyTo`.
 * So the quote is taken from the message this app really has under that id:
 * its sender and its text. `missing`: no such message here (older than the
 * history, never received, or made up) — the bubble says so and never shows
 * the claimed text as if it were the original.
 */
export type QuoteView = { id: string; senderName: string; text: string; missing: boolean; sealed?: boolean };

export function verifyQuote(claimed: { id: string; senderName: string; text: string } | undefined, stored: QuotableMessage | null | undefined): QuoteView | undefined {
  if (!claimed) return undefined;
  if (!stored || stored.id !== claimed.id) return { id: claimed.id, senderName: "", text: "", missing: true };
  // Someone else's sealed message: the stored text is ciphertext.
  if (stored.flags?.sealed && !stored.mine) return { id: stored.id, senderName: stored.senderName, text: "🔒", missing: false, sealed: true };
  const body = stored.text.trim() || (stored.attachment ? `📎 ${stored.attachment.name}` : "");
  const text = body.length > PAYLOAD_LIMITS.replyChars ? `${body.slice(0, PAYLOAD_LIMITS.replyChars - 1)}…` : body;
  return { id: stored.id, senderName: stored.senderName, text, missing: false };
}

/** Labels a forward may carry that name no member: a model's answer ("/keyword") or an NFC card. */
const FORWARD_SOURCES = /^(\/[A-Za-z0-9_-]{1,40}|NFC)$/;

const forwardKey = (senderName: string, text: string) => `${normalizeDisplayName(senderName)}\u0000${text.trim()}`;

/** What the conversation holds, for checking forwards: "<sender>␀<text>" of every message that is not itself a forward. */
export function forwardIndex(messages: ReadonlyArray<{ senderName: string; text: string; forwardedFrom?: string }>): Set<string> {
  const out = new Set<string>();
  for (const m of messages) if (m.text && !m.forwardedFrom) out.add(forwardKey(m.senderName, m.text));
  return out;
}

/**
 * Is "forwarded from X" true as far as this app can tell? True when it holds a
 * message of its own from X with the same text; undefined for a label that
 * names no member (a model, NFC); otherwise false — the bubble shows it as the
 * forwarder's unverified claim.
 */
export function verifyForward(forwardedFrom: string | undefined, text: string, index: ReadonlySet<string>): boolean | undefined {
  if (!forwardedFrom) return undefined;
  if (FORWARD_SOURCES.test(forwardedFrom)) return undefined;
  return index.has(forwardKey(forwardedFrom, text));
}
