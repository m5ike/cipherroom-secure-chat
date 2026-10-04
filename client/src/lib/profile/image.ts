// Profile images (6.7): the photo and the background are re-encoded in the
// browser before they go anywhere — drawn onto a canvas (which keeps pixels
// only: no EXIF, no GPS, no camera serial) at a capped size, then encoded as
// JPEG under a byte cap. stripImageMetadata() is the second line: it drops
// every metadata segment / chunk from a JPEG, PNG or WebP byte for byte. The
// server runs it (checkImageDataUrl) over whatever a PUT hands it, too.

import { PROFILE_LIMITS } from "./model";

export type ImageKind = "avatar" | "cover";

export function imageCap(kind: ImageKind): number {
  return kind === "avatar" ? PROFILE_LIMITS.avatarBytes : PROFILE_LIMITS.coverBytes;
}

/* ----------------------------------------------------------- metadata */

const JPEG_KEEP_APP0 = 0xe0;

/** JPEG without APP1–APP15 (EXIF, XMP, ICC, IPTC, maker notes) and comments; null if it is not a JPEG. */
function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    // Fill bytes before a marker.
    while (marker === 0xff && i + 2 < b.length) { i += 1; marker = b[i + 1]; }
    if (marker === 0xd9) { out.push(0xff, 0xd9); return Uint8Array.from(out); }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(0xff, marker); i += 2; continue; }
    if (i + 3 >= b.length) return null;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    const drop = (marker > JPEG_KEEP_APP0 && marker <= 0xef) || marker === 0xfe;
    if (!drop) for (let k = i; k < i + 2 + len; k++) out.push(b[k]);
    i += 2 + len;
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data and everything after stay as they are.
      const rest = b.subarray(i);
      const head = Uint8Array.from(out);
      const all = new Uint8Array(head.length + rest.length);
      all.set(head, 0);
      all.set(rest, head.length);
      return all;
    }
  }
  return null;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function stripPng(b: Uint8Array): Uint8Array | null {
  if (b.length < 8 || PNG_SIG.some((v, k) => b[k] !== v)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return concat(parts);
}

function stripWebp(b: Uint8Array): Uint8Array | null {
  const tag = (k: number) => String.fromCharCode(b[k], b[k + 1], b[k + 2], b[k + 3]);
  if (b.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  const parts: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = tag(i);
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > b.length) return null;
    if (type === "VP8X") {
      const chunk = Uint8Array.from(b.subarray(i, Math.min(end, b.length)));
      chunk[8] &= ~(0x08 | 0x04); // no EXIF, no XMP
      parts.push(chunk);
    } else if (type !== "EXIF" && type !== "XMP ") {
      parts.push(b.subarray(i, Math.min(end, b.length)));
    }
    i = end;
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12), 0);
  out.set(body, 12);
  const size = 4 + body.length;
  out[4] = size & 0xff; out[5] = (size >>> 8) & 0xff; out[6] = (size >>> 16) & 0xff; out[7] = (size >>> 24) & 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

/** The format the bytes really are (by their signature), or null. */
export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && PNG_SIG.every((v, k) => b[k] === v)) return "image/png";
  if (b.length >= 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" && String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP") return "image/webp";
  return null;
}

/** The same image without its metadata; null when the bytes are not a well-formed JPEG / PNG / WebP. */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array | null {
  switch (sniffImage(bytes)) {
    case "image/jpeg": return stripJpeg(bytes);
    case "image/png": return stripPng(bytes);
    case "image/webp": return stripWebp(bytes);
    default: return null;
  }
}

/* ------------------------------------------------------------ data URLs */

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toDataUrl(bytes: Uint8Array, mime: ImageMime): string {
  return `data:${mime};base64,${b64encode(bytes)}`;
}

/**
 * The server's (and a receiver's) check of an image it is handed: a data:
 * URL whose bytes really are the format it claims, no larger than `maxBytes`,
 * returned again without metadata — or "" when any of that fails.
 */
export function checkImageDataUrl(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value) return "";
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m || m[2].length > Math.ceil((maxBytes * 4) / 3) + 4) return "";
  let bytes: Uint8Array;
  try { bytes = b64decode(m[2]); } catch { return ""; }
  if (bytes.length > maxBytes || sniffImage(bytes) !== m[1]) return "";
  const clean = stripImageMetadata(bytes);
  return clean ? toDataUrl(clean, m[1] as ImageMime) : "";
}

/* ------------------------------------------------------- re-encoding */

/** The part of the source to draw and the size to draw it at: the photo a centred square, the background 3:1; never scaled up. */
export function cropFor(kind: ImageKind, w: number, h: number): { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number } {
  const ratio = kind === "avatar" ? 1 : PROFILE_LIMITS.coverW / PROFILE_LIMITS.coverH;
  let sw = w;
  let sh = Math.round(w / ratio);
  if (sh > h) { sh = h; sw = Math.round(h * ratio); }
  const sx = Math.floor((w - sw) / 2);
  const sy = Math.floor((h - sh) / 2);
  const maxW = kind === "avatar" ? PROFILE_LIMITS.avatarPx : PROFILE_LIMITS.coverW;
  const scale = Math.min(1, maxW / Math.max(1, sw));
  return { sx, sy, sw, sh, dw: Math.max(1, Math.round(sw * scale)), dh: Math.max(1, Math.round(sh * scale)) };
}

const QUALITIES = [0.86, 0.78, 0.7, 0.6, 0.5];
const SCALES = [1, 0.8, 0.64, 0.5];

/**
 * Encodes at falling quality, then at a smaller size, until the result fits
 * `cap` bytes. `encode(scale, quality)` draws and encodes; throws when even
 * the smallest attempt is too large.
 */
export async function encodeUnderCap(encode: (scale: number, quality: number) => Promise<Uint8Array>, cap: number): Promise<Uint8Array> {
  for (const scale of SCALES) {
    for (const quality of QUALITIES) {
      const bytes = await encode(scale, quality);
      if (bytes.length > 0 && bytes.length <= cap) return bytes;
    }
  }
  throw new Error("image-too-large");
}

/** Decodes a picked file with its EXIF orientation applied (the orientation is all we keep of it). */
async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MAX_INPUT_BYTES = 25 * 1024 * 1024;

/**
 * A picked file → a clean JPEG data: URL for the profile: cropped, capped in
 * pixels and bytes, without metadata. Throws "not-an-image" / "image-too-large".
 */
export async function sanitizeImage(file: Blob, kind: ImageKind): Promise<string> {
  if (!file.type.startsWith("image/") || file.size > MAX_INPUT_BYTES) throw new Error("not-an-image");
  let decoded: Awaited<ReturnType<typeof decode>>;
  try { decoded = await decode(file); } catch { throw new Error("not-an-image"); }
  try {
    const crop = cropFor(kind, decoded.width, decoded.height);
    const canvas = document.createElement("canvas");
    const bytes = await encodeUnderCap(async (scale, quality) => {
      canvas.width = Math.max(1, Math.round(crop.dw * scale));
      canvas.height = Math.max(1, Math.round(crop.dh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("not-an-image");
      // JPEG has no alpha: a transparent PNG gets a white background, not black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded.source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
    }, imageCap(kind));
    const clean = stripImageMetadata(bytes);
    if (!clean) throw new Error("not-an-image");
    return toDataUrl(clean, "image/jpeg");
  } finally {
    decoded.close();
  }
}
