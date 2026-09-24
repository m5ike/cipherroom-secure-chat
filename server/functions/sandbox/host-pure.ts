// m5.codec, m5.id and m5.crypto — the pure helpers (4.15). They run in the
// sandbox process, outside the interpreter, so JavaScript and Python get the
// same answers from one implementation and no call crosses to the runner.
//
// Values arrive as JSON: bytes are {"$b": "<base64>"}, and go back the same
// way. Every helper bounds what it produces (decompression, key lengths,
// work factors), because the caller is untrusted code.

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac, getHashes, hkdfSync, pbkdf2Sync, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, deflateRawSync, deflateSync, gunzipSync, gzipSync, inflateRawSync, inflateSync, constants as zlib } from "node:zlib";

export class HostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HostError";
  }
}

const bad = (message: string) => new HostError("bad-argument", message);

type Tagged = { $b: string };
const isTagged = (v: unknown): v is Tagged => Boolean(v) && typeof v === "object" && typeof (v as Tagged).$b === "string" && Object.keys(v as object).length === 1;

/** Bytes from a tagged value or a string (UTF-8). */
export function bytesOf(v: unknown, what = "value"): Buffer {
  if (isTagged(v)) return Buffer.from(v.$b, "base64");
  if (typeof v === "string") return Buffer.from(v, "utf8");
  throw bad(`${what} must be bytes or a string`);
}

export const tag = (b: Uint8Array): Tagged => ({ $b: Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64") });

const MAX_BYTES = 32 * 1024 * 1024;

function int(v: unknown, min: number, max: number, what: string, fallback?: number): number {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${what} must be a whole number from ${min} to ${max}`);
  return n;
}

/* ------------------------------------------------------------------ codecs */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf: Buffer, pad = true): string {
  let out = "", bits = 0, value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  if (pad) while (out.length % 8) out += "=";
  return out;
}
function unbase32(text: string): Buffer {
  const clean = text.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw bad(`not base32: "${ch}"`);
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(buf: Buffer): string {
  if (buf.length > 4096) throw bad("base58 is for short values (at most 4 kB)");
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let n = BigInt(`0x${buf.toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}
function unbase58(text: string): Buffer {
  if (text.length > 6000) throw bad("base58 is for short values");
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) throw bad(`not base58: "${ch}"`);
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}

function csvParse(text: string, opts: { delimiter?: string; header?: boolean }): unknown[] {
  const d = typeof opts.delimiter === "string" && opts.delimiter.length === 1 ? opts.delimiter : ",";
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === d) { row.push(field); field = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") {
      row.push(field); rows.push(row); row = []; field = "";
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++; continue;
    }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!opts.header) return rows;
  const [head = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ""])));
}

function csvStringify(rows: unknown, opts: { delimiter?: string }): string {
  if (!Array.isArray(rows)) throw bad("rows must be a list");
  const d = typeof opts.delimiter === "string" && opts.delimiter.length === 1 ? opts.delimiter : ",";
  let list = rows as unknown[];
  if (list.length && list[0] && typeof list[0] === "object" && !Array.isArray(list[0])) {
    const head = Object.keys(list[0] as object);
    list = [head, ...list.map((r) => head.map((h) => (r as Record<string, unknown>)[h]))];
  }
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /["\r\n]/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return list.map((r) => (Array.isArray(r) ? r : [r]).map(cell).join(d)).join("\r\n");
}

const HTML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function compress(alg: string, data: Buffer, level: unknown): Buffer {
  if (data.length > MAX_BYTES) throw bad("too much data to compress (32 MB at most)");
  switch (alg) {
    case "gzip": return gzipSync(data, { level: int(level, 0, 9, "level", 6) });
    case "deflate": return deflateSync(data, { level: int(level, 0, 9, "level", 6) });
    case "deflate-raw": return deflateRawSync(data, { level: int(level, 0, 9, "level", 6) });
    case "brotli": return brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: int(level, 0, 11, "level", 6) } });
  }
  throw bad(`unknown compression "${alg}" (gzip, deflate, deflate-raw, brotli)`);
}

function decompress(alg: string, data: Buffer): Buffer {
  // A bomb stops at the limit instead of filling memory.
  const opts = { maxOutputLength: MAX_BYTES };
  try {
    switch (alg) {
      case "gzip": return gunzipSync(data, opts);
      case "deflate": return inflateSync(data, opts);
      case "deflate-raw": return inflateRawSync(data, opts);
      case "brotli": return brotliDecompressSync(data, opts);
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE") throw bad("the decompressed data is larger than 32 MB");
    throw bad(`cannot decompress: ${(err as Error).message}`);
  }
  throw bad(`unknown compression "${alg}" (gzip, deflate, deflate-raw, brotli)`);
}

/* --------------------------------------------------------------------- ids */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlidMs = 0;
let lastUlidRand: number[] = [];

function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  let rand: number[];
  if (now === lastUlidMs) {
    // Monotonic within one millisecond: the random part counts up.
    rand = lastUlidRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) { if (rand[i] < 31) { rand[i]++; break; } rand[i] = 0; }
  } else {
    const bytes = randomBytes(16);
    rand = Array.from(bytes, (b) => b % 32);
  }
  lastUlidMs = now; lastUlidRand = rand;
  return time + rand.map((i) => CROCKFORD[i]).join("");
}

function uuid7(now = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function nanoid(size: number, alphabet: string): string {
  if (alphabet.length < 2 || alphabet.length > 256) throw bad("the alphabet needs 2 to 256 characters");
  let out = "";
  while (out.length < size) {
    for (const byte of randomBytes(size * 2)) {
      // Rejection sampling keeps every character equally likely.
      const limit = 256 - (256 % alphabet.length);
      if (byte < limit) out += alphabet[byte % alphabet.length];
      if (out.length === size) break;
    }
  }
  return out;
}

function slug(text: string, max: number): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}

/* ------------------------------------------------------------------ crypto */

const HASHES = new Set(getHashes());
const HASH_ALIASES: Record<string, string> = { "sha-1": "sha1", "sha-256": "sha256", "sha-384": "sha384", "sha-512": "sha512", "sha3-256": "sha3-256", "sha3-512": "sha3-512", blake2b: "blake2b512", blake2s: "blake2s256" };
const ALLOWED_HASHES = ["md5", "sha1", "sha256", "sha384", "sha512", "sha512-256", "sha3-256", "sha3-384", "sha3-512", "blake2b512", "blake2s256", "shake128", "shake256"];

function hashName(alg: unknown): string {
  const name = String(alg ?? "").toLowerCase();
  const real = HASH_ALIASES[name] ?? name;
  if (!ALLOWED_HASHES.includes(real) || !HASHES.has(real)) throw bad(`unknown hash "${String(alg).slice(0, 30)}" (${ALLOWED_HASHES.join(", ")})`);
  return real;
}

function encode(buf: Buffer, enc: unknown): unknown {
  switch (enc ?? "hex") {
    case "hex": return buf.toString("hex");
    case "base64": return buf.toString("base64");
    case "base64url": return buf.toString("base64url");
    case "bytes": return tag(buf);
  }
  throw bad('encoding must be "hex", "base64", "base64url" or "bytes"');
}

function aesKey(v: unknown): Buffer {
  const key = bytesOf(v, "key");
  if (![16, 24, 32].includes(key.length)) throw bad("an AES key has 16, 24 or 32 bytes");
  return key;
}

/* ------------------------------------------------------------------- table */

type Fn = (...args: unknown[]) => unknown;

export const PURE: Record<string, Fn> = {
  "codec.b64.enc": (v, url) => bytesOf(v).toString(url ? "base64url" : "base64"),
  "codec.b64.dec": (v) => { if (typeof v !== "string") throw bad("base64 text expected"); return tag(Buffer.from(v, /[-_]/.test(v) ? "base64url" : "base64")); },
  "codec.b32.enc": (v, pad) => base32(bytesOf(v), pad !== false),
  "codec.b32.dec": (v) => tag(unbase32(String(v))),
  "codec.b58.enc": (v) => base58(bytesOf(v)),
  "codec.b58.dec": (v) => tag(unbase58(String(v))),
  "codec.hex.enc": (v) => bytesOf(v).toString("hex"),
  "codec.hex.dec": (v) => { const s = String(v).replace(/\s+/g, ""); if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw bad("not hex"); return tag(Buffer.from(s, "hex")); },
  "codec.utf8.enc": (v) => tag(Buffer.from(String(v), "utf8")),
  "codec.utf8.dec": (v) => bytesOf(v).toString("utf8"),
  "codec.url.encode": (v) => encodeURIComponent(String(v)),
  "codec.url.decode": (v) => { try { return decodeURIComponent(String(v)); } catch { throw bad("not a valid percent-encoded text"); } },
  "codec.url.parse": (v) => {
    let u: URL;
    try { u = new URL(String(v)); } catch { throw bad("not a URL"); }
    const query: Record<string, string | string[]> = {};
    for (const [k, val] of u.searchParams) {
      const prev = query[k];
      query[k] = prev === undefined ? val : Array.isArray(prev) ? [...prev, val] : [prev, val];
    }
    return { href: u.href, protocol: u.protocol.replace(/:$/, ""), username: decodeURIComponent(u.username), host: u.host, hostname: u.hostname, port: u.port ? Number(u.port) : null, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin, query };
  },
  "codec.url.build": (base, query) => {
    let u: URL;
    try { u = new URL(String(base)); } catch { throw bad("not a URL"); }
    if (query && typeof query === "object") {
      for (const [k, val] of Object.entries(query as Record<string, unknown>)) {
        if (val === null || val === undefined) continue;
        for (const one of Array.isArray(val) ? val : [val]) u.searchParams.append(k, String(one));
      }
    }
    return u.href;
  },
  "codec.html.escape": (v) => String(v).replace(/[&<>"']/g, (c) => HTML[c]),
  "codec.csv.parse": (text, opts) => csvParse(String(text), (opts ?? {}) as { delimiter?: string; header?: boolean }),
  "codec.csv.stringify": (rows, opts) => csvStringify(rows, (opts ?? {}) as { delimiter?: string }),
  "codec.compress": (alg, data, level) => tag(compress(String(alg), bytesOf(data), level)),
  "codec.decompress": (alg, data) => tag(decompress(String(alg), bytesOf(data))),

  "id.uuid": () => randomUUID(),
  "id.uuid7": () => uuid7(),
  "id.ulid": () => ulid(),
  "id.nanoid": (size, alphabet) => nanoid(int(size, 2, 256, "size", 21), typeof alphabet === "string" ? alphabet : "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"),
  "id.tag": (len) => nanoid(int(len, 2, 64, "length", 8), "23456789abcdefghjkmnpqrstuvwxyz"),
  "id.slug": (text, max) => slug(String(text ?? ""), int(max, 1, 200, "max", 80)),

  "crypto.random": (n) => tag(randomBytes(int(n, 1, 1_048_576, "length"))),
  "crypto.randomInt": (min, max) => {
    const lo = int(min, -(2 ** 47), 2 ** 47, "min"); const hi = int(max, -(2 ** 47), 2 ** 47, "max");
    if (hi <= lo) throw bad("max must be above min");
    return randomInt(lo, hi);
  },
  "crypto.hash": (alg, data, enc) => {
    const name = hashName(alg);
    const h = name.startsWith("shake") ? createHash(name, { outputLength: name === "shake128" ? 16 : 32 }) : createHash(name);
    return encode(h.update(bytesOf(data, "data")).digest(), enc);
  },
  "crypto.hmac": (alg, key, data, enc) => encode(createHmac(hashName(alg), bytesOf(key, "key")).update(bytesOf(data, "data")).digest(), enc),
  "crypto.hkdf": (alg, ikm, salt, info, len) => tag(Buffer.from(hkdfSync(hashName(alg), bytesOf(ikm, "key"), bytesOf(salt ?? "", "salt"), bytesOf(info ?? "", "info"), int(len, 1, 8160, "length")))),
  "crypto.pbkdf2": (password, salt, iterations, len, alg) => tag(pbkdf2Sync(bytesOf(password, "password"), bytesOf(salt, "salt"), int(iterations, 1, 10_000_000, "iterations"), int(len, 1, 1024, "length"), hashName(alg ?? "sha256"))),
  "crypto.scrypt": (password, salt, len, opts) => {
    const o = (opts ?? {}) as { N?: number; r?: number; p?: number };
    const N = int(o.N, 2, 2 ** 20, "N", 16384); const r = int(o.r, 1, 32, "r", 8); const p = int(o.p, 1, 16, "p", 1);
    if (N & (N - 1)) throw bad("N must be a power of two");
    return tag(scryptSync(bytesOf(password, "password"), bytesOf(salt, "salt"), int(len, 1, 1024, "length"), { N, r, p, maxmem: 256 * 1024 * 1024 }));
  },
  "crypto.aesGcm.encrypt": (key, plaintext, aad) => {
    const k = aesKey(key);
    const iv = randomBytes(12);
    const cipher = createCipheriv(`aes-${k.length * 8}-gcm` as "aes-256-gcm", k, iv);
    if (aad !== undefined && aad !== null) cipher.setAAD(bytesOf(aad, "aad"));
    const ct = Buffer.concat([cipher.update(bytesOf(plaintext, "plaintext")), cipher.final()]);
    return tag(Buffer.concat([iv, ct, cipher.getAuthTag()]));
  },
  "crypto.aesGcm.decrypt": (key, sealed, aad) => {
    const k = aesKey(key);
    const b = bytesOf(sealed, "ciphertext");
    if (b.length < 28) throw bad("the ciphertext is too short");
    try {
      const decipher = createDecipheriv(`aes-${k.length * 8}-gcm` as "aes-256-gcm", k, b.subarray(0, 12));
      if (aad !== undefined && aad !== null) decipher.setAAD(bytesOf(aad, "aad"));
      decipher.setAuthTag(b.subarray(b.length - 16));
      return tag(Buffer.concat([decipher.update(b.subarray(12, b.length - 16)), decipher.final()]));
    } catch {
      throw new HostError("decrypt-failed", "cannot decrypt: wrong key, changed data or wrong associated data");
    }
  },
  "crypto.equal": (a, b) => {
    const x = bytesOf(a); const y = bytesOf(b);
    return x.length === y.length && timingSafeEqual(x, y);
  },
};

/** Runs one pure helper; the answer (or the error) as the protocol carries it. */
export function callPure(fn: string, args: unknown[]): { ok: true; v: unknown } | { ok: false; e: { code: string; message: string } } {
  const impl = Object.prototype.hasOwnProperty.call(PURE, fn) ? PURE[fn] : null;
  if (!impl) return { ok: false, e: { code: "unknown-call", message: `m5: no such helper "${fn.slice(0, 60)}"` } };
  try {
    return { ok: true, v: impl(...args) };
  } catch (err) {
    if (err instanceof HostError) return { ok: false, e: { code: err.code, message: err.message } };
    return { ok: false, e: { code: "error", message: (err as Error).message } };
  }
}
