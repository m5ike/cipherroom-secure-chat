// Everything a peer sends is untrusted until it has been through here.
//
// A decrypted payload only proves the sender knows the room key. Before this
// module the app spread it straight into the conversation: a peer could
// send `text: {}` and blank the page on render, claim another member's
// sender id (or ours, making the message look like our own), or hand over
// an attachment whose MIME type turned a downloaded file into a page
// running in this origin. Now each field is checked, bounded and coerced,
// and anything that does not fit is dropped.

import { clampVanishSeconds, type MsgFlags } from "./message-kinds";
import type { AttachmentMeta } from "./chat-types";

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
  return out.tap || out.vanishSeconds || out.sealed ? out : undefined;
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
};

export type AudioStatusPayload = { kind: "audio-status"; id: string; createdAt: number; senderId: string; senderName: string; status: "off" | "joining" | "live" | "muted" };

/** Ids the app itself uses for its own notices; a peer may not borrow them. */
const RESERVED_SENDERS = new Set(["system", "self", "server", "admin"]);

/**
 * Checks a decrypted payload. `transportSender` is who actually delivered
 * it (the data channel's peer, or the peer the server says relayed it) —
 * the payload's own senderId must match, and may never be ours.
 */
export function validatePayload(
  value: unknown,
  opts: { transportSender?: string; myId?: string; now?: number } = {},
): ChatPayload | AudioStatusPayload | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const now = opts.now ?? Date.now();
  const id = str(p.id, PAYLOAD_LIMITS.idChars);
  const senderId = str(p.senderId, PAYLOAD_LIMITS.idChars);
  if (!id || !senderId || RESERVED_SENDERS.has(senderId)) return null;
  if (opts.myId && senderId === opts.myId) return null;
  if (opts.transportSender && senderId !== opts.transportSender) return null;
  const createdAt = typeof p.createdAt === "number" && Number.isFinite(p.createdAt) ? Math.min(p.createdAt, now + PAYLOAD_LIMITS.futureSkewMs) : now;
  const senderName = clean(p.senderName, PAYLOAD_LIMITS.nameChars, `peer-${senderId.slice(-4)}`);

  if (p.kind === "audio-status") {
    const status = p.status;
    if (status !== "off" && status !== "joining" && status !== "live" && status !== "muted") return null;
    return { kind: "audio-status", id, createdAt, senderId, senderName, status };
  }
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
  if (Array.isArray(p.to)) out.to = p.to.filter((n): n is string => typeof n === "string").slice(0, PAYLOAD_LIMITS.recipients).map((n) => clean(n, PAYLOAD_LIMITS.nameChars));
  const reply = p.replyTo as Record<string, unknown> | undefined;
  if (reply && typeof reply === "object" && str(reply.id, PAYLOAD_LIMITS.idChars)) {
    out.replyTo = { id: reply.id as string, senderName: clean(reply.senderName, PAYLOAD_LIMITS.nameChars), text: clean(reply.text, PAYLOAD_LIMITS.replyChars) };
  }
  if (typeof p.forwardedFrom === "string") out.forwardedFrom = clean(p.forwardedFrom, PAYLOAD_LIMITS.nameChars);
  return out;
}
