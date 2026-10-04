// 6.2: what a bubble shows of a file, and how it is saved or shared — all in
// this browser, from the already decrypted bytes (nothing goes to a server).
//
//   image  the picture (as before)
//   video  <video controls> — mp4, webm, ogg (validate.ts lets no other through)
//   audio  <audio controls>
//   pdf    a card: name, size, Open / Save. No inline viewer: it would need
//          frame-src blob: (or object-src) in the app's CSP, and a framed
//          blob: document runs in this origin — not worth loosening it for.
//   text   the first lines of a text / Markdown file, as plain text
//   file   the name and size
//
// Media play from blob: URLs: the CSP's media-src is 'self' blob: (no data:),
// so an inline attachment (a data: URL) is turned into a blob: first. A file
// that arrived in chunks already is a blob: URL; its Blob is remembered here
// (rememberBlob) — fetch() of a blob: URL is not what connect-src 'self' allows.

import { safeMime } from "./validate";

export type MediaKind = "image" | "video" | "audio" | "pdf" | "text" | "file";

type AttachmentLike = { kind: "file" | "image"; name: string; mime: string; size: number; dataUrl: string };

const TEXT_NAME = /\.(txt|md|markdown|csv|log|json)$/i;

export function mediaKindOf(a: AttachmentLike): MediaKind {
  const mime = (a.mime || "").toLowerCase();
  if (a.kind === "image") return "image";
  if (/^video\/(mp4|webm|ogg)$/.test(mime)) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  // A peer's .md arrives as application/octet-stream (validate.ts): the name tells it.
  if (mime === "text/plain" || mime === "text/markdown" || ((mime === "application/octet-stream" || mime === "") && TEXT_NAME.test(a.name))) return "text";
  return "file";
}

/** The icon of a file's kind (the layout builder's catalog; aliases resolve). */
export const MEDIA_ICON: Record<MediaKind, string> = {
  image: "file-image", video: "file-video", audio: "file-audio", pdf: "file-text", text: "file-text", file: "file",
};

/** The bytes of a data: URL (at most `limit` of them), or null. */
export function dataUrlBytes(url: string, limit = Infinity): Uint8Array | null {
  const m = /^data:([^,]*?)(;base64)?,/i.exec(url);
  if (!m) return null;
  const body = url.slice(m[0].length);
  try {
    if (!m[2]) {
      const text = decodeURIComponent(body);
      const bytes = new TextEncoder().encode(text);
      return Number.isFinite(limit) ? bytes.slice(0, limit) : bytes;
    }
    // Only as much base64 as the limit needs (4 characters → 3 bytes).
    const chars = Number.isFinite(limit) ? Math.min(body.length, Math.ceil(limit / 3) * 4) : body.length;
    const bin = atob(body.slice(0, chars - (chars % 4)));
    const out = new Uint8Array(Math.min(bin.length, limit));
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A data: URL as a Blob of the given (already safe) type. */
export function dataUrlToBlob(url: string, type: string): Blob | null {
  const bytes = dataUrlBytes(url);
  return bytes ? new Blob([bytes as BlobPart], { type }) : null;
}

/* ------------------------------------------------ blobs of received files */

const blobs = new Map<string, Blob>();

/** A blob: URL this page made for a received file, and its Blob. */
export function rememberBlob(url: string, blob: Blob): void {
  blobs.set(url, blob);
}
export function forgetBlob(url: string): void {
  blobs.delete(url);
}

/** The file's bytes as a Blob: decoded from a data: URL, or the one remembered for a blob: URL. */
export function attachmentBlob(a: AttachmentLike): Blob | null {
  if (!a.dataUrl) return null;
  // 6.7 (S17): the blob gets a type safe to open in this origin, whatever the message claims —
  // a text/html (or SVG) blob: opened from here would be a page of this origin.
  if (a.dataUrl.startsWith("data:")) return dataUrlToBlob(a.dataUrl, safeMime(a.mime));
  return blobs.get(a.dataUrl) ?? null;
}

/* ------------------------------------------------------------ text preview */

/** The first lines of a text file (null when the bytes are not text). `total`: the file's size, when only its head was read. */
export function textPreview(bytes: Uint8Array, maxLines = 6, maxChars = 480, total = bytes.length): { text: string; more: boolean } | null {
  const head = bytes.subarray(0, 4096);
  if (head.includes(0)) return null;
  let text = new TextDecoder("utf-8", { fatal: false }).decode(head).replace(/\r\n?/g, "\n");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines = text.split("\n");
  let out = lines.slice(0, maxLines).join("\n");
  let more = lines.length > maxLines || Math.max(total, bytes.length) > head.length;
  if (out.length > maxChars) { out = out.slice(0, maxChars); more = true; }
  return { text: out.replace(/\s+$/, ""), more };
}

/* ------------------------------------------------------- save and share */

function clickLink(href: string, name?: string): void {
  const a = document.createElement("a");
  a.href = href;
  if (name !== undefined) a.download = name;
  else { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  document.body.append(a);
  a.click();
  a.remove();
}

/** Saves a Blob under a name (a short-lived blob: URL and a download link). */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  clickLink(url, name);
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Saves a file of a message (false: its bytes are not in this browser any more). */
export function saveAttachment(a: AttachmentLike): boolean {
  const blob = attachmentBlob(a);
  if (blob) { downloadBlob(blob, a.name); return true; }
  if (!a.dataUrl) return false;
  clickLink(a.dataUrl, a.name);
  return true;
}

/** Opens a file of a message in a new tab (a PDF): a blob: URL — a data: URL may not be opened as a page. */
export function openAttachment(a: AttachmentLike): boolean {
  if (a.dataUrl.startsWith("blob:")) { clickLink(a.dataUrl); return true; }
  const blob = attachmentBlob(a);
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  clickLink(url);
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

type ShareNavigator = Navigator & { canShare?: (d: { files?: File[] }) => boolean; share?: (d: { files?: File[]; title?: string }) => Promise<void> };

/** The system share sheet can take this file. */
export function canShareFile(file: File, nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  const n = nav as ShareNavigator | undefined;
  if (!n?.share || !n.canShare) return false;
  try { return n.canShare({ files: [file] }); } catch { return false; }
}

/** Shares the file through the system share sheet; false when it cannot (the caller offers the rest). */
export async function shareFile(file: File): Promise<boolean> {
  if (!canShareFile(file)) return false;
  try {
    await (navigator as ShareNavigator).share!({ files: [file], title: file.name });
  } catch { /* cancelled */ }
  return true;
}

/** Shares a file of a message; false when the browser cannot (then a menu offers what it can). */
export async function shareAttachment(a: AttachmentLike): Promise<boolean> {
  const blob = attachmentBlob(a);
  if (!blob || typeof File === "undefined") return false;
  return shareFile(new File([blob], a.name, { type: a.mime || blob.type || "application/octet-stream" }));
}
