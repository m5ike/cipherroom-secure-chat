// How a bundled client file is answered (pure — no Electron, no fs).
//
// Same headers as the server's static handler (server/static.ts): content
// type, Cache-Control (a content-hashed asset is immutable, everything else
// no-store), Accept-Ranges — plus the page's security headers
// (web-headers.ts). HEAD has no body; a single byte range gets 206, an
// unsatisfiable one 416; several ranges are answered with the whole file (as
// the spec allows).

/** Hashed assets: Vite writes name.<hash>.ext; workers name-<hash>.js (= server/static.ts isHashedAsset). */
export function isHashedAsset(path: string): boolean {
  return /^\/assets\/[^/]+[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path);
}

const IMMUTABLE = "public, max-age=31536000, immutable";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".pub": "text/plain; charset=utf-8",
  ".sig": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

export function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

export type ByteRange = { start: number; end: number };

/**
 * A Range header against a file of `size` bytes: null (no usable range →
 * whole file), "unsatisfiable", or one inclusive range.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return null;
  const spec = m[1].trim();
  if (spec.includes(",")) return null; // several ranges: the whole file
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!r || (r[1] === "" && r[2] === "")) return null;
  if (r[1] === "") {
    const suffix = Number(r[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    return size === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(r[1]);
  const end = r[2] === "" ? size - 1 : Math.min(Number(r[2]), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

export type BundleAnswer = {
  status: 200 | 206 | 405 | 416;
  headers: Record<string, string>;
  /** Byte range of the file to send; null = no body (HEAD, 405, 416). */
  slice: ByteRange | null;
};

/** Status, headers and the part of the file to send for a bundled file. */
export function answerBundled(path: string, size: number, method: string, rangeHeader: string | undefined, security: Readonly<Record<string, string>>): BundleAnswer {
  const headers: Record<string, string> = { ...security };
  if (isHashedAsset(path)) {
    headers["Cache-Control"] = IMMUTABLE;
  }
  headers["Content-Type"] = contentType(path);
  headers["Accept-Ranges"] = "bytes";
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    headers.Allow = "GET, HEAD";
    return { status: 405, headers, slice: null };
  }
  const range = parseRange(rangeHeader, size);
  if (range === "unsatisfiable") {
    headers["Content-Range"] = `bytes */${size}`;
    headers["Content-Length"] = "0";
    return { status: 416, headers, slice: null };
  }
  const slice = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : slice.end - slice.start + 1;
  headers["Content-Length"] = String(length);
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return { status: range ? 206 : 200, headers, slice: m === "HEAD" || size === 0 ? null : slice };
}
