// NFC connection tag v2 (6.12, F-12 of the security analysis) — the format
// the web and the Android app share. Normative text: docs/protocol-v4.md § 16.
//
// v1 ("m5cet:nfc:v1:", lib/nfc.ts) sealed the room name and key under a 4–16
// digit PIN with PBKDF2 (200 000): whoever read the tag once could guess the
// PIN offline in minutes and had the room key for ever. v2 never uses a PIN:
//
//   invite   the tag holds an INVITATION REFERENCE — the server's origin, the
//            invite id — and a long random secret (26 Crockford base32
//            symbols, 130 bits). The room key stays on the server, sealed under
//            keys derived from that secret (server/share.ts, lib/share-link.ts):
//            the server cannot open it, and the tag stops working when the
//            invite runs out (uses, at most 7 days) or is revoked.
//   offline  the room data on the tag itself, AES-256-GCM under a key from
//            Argon2id (the room KDF's cost, lib/kdf.ts: 64 MiB, 3 passes) of a
//            random code of 20 Crockford base32 symbols (100 bits) that is NOT
//            on the tag: the writer is shown it once, the reader types it.
//
// The NDEF record is the same as v1's — MIME `application/vnd.m5cet.conn` —
// and its body is "m5cet:nfc:v2:" followed by a JSON object (below). Pure, no
// I/O: the invite's server round trips live in lib/share-link.ts.

import { ARGON2_PARAMS, runKdf } from "../kdf";
import { NfcError } from "./errors";

export const TAG_V2_PREFIX = "m5cet:nfc:v2:";
export const TAG_V1_PREFIX = "m5cet:nfc:v1:";
const LABEL = "m5cet/nfc-tag/2";

/** Crockford base32: no I, L, O, U (typed as 1, 1, 0 — U is refused). */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The invite secret on the tag: 26 symbols = 130 bits. */
export const INVITE_SECRET_SYMBOLS = 26;
/** The offline tag's code (never on the tag): 20 symbols = 100 bits. */
export const OFFLINE_CODE_SYMBOLS = 20;
/** What a reader accepts from a tag (a tag cannot make it allocate gigabytes or run for minutes). */
export const OFFLINE_KDF_LIMITS = { minMemoryKiB: 8, maxMemoryKiB: 256 * 1024, minPasses: 1, maxPasses: 10 } as const;

export type KdfParams = { memoryKiB: number; passes: number };

/** What a tag opens to (the room to join). `name`: a suggested name, only when the writer put one. */
export type TagRoom = { room: string; passphrase: string; name?: string; app?: string };

export type InviteTag = { v: 2; t: "inv"; o: string; id: string; k: string };
export type OfflineTag = { v: 2; t: "off"; kdf: "argon2id"; m: number; i: number; p: 1; s: string; n: string; c: string };
export type TagV2 = InviteTag | OfflineTag;

const enc = new TextEncoder();
const dec = new TextDecoder();
const ascii = (s: string) => new Uint8Array(enc.encode(s));

/* --------------------------------------------------------------- encoding */

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new NfcError("card-error", "not base64url");
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `n` symbols of Crockford base32, uniform (5 random bits each). */
export function randomBase32(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = "";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

/**
 * A typed (or read) base32 string in its canonical form: upper case, without
 * spaces, hyphens, dots and underscores, O → 0, I and L → 1. Null when
 * anything else is left (U, other letters, signs) or the length is not `n`.
 */
export function normalizeBase32(input: string, n: number): string | null {
  const s = input.toUpperCase().replace(/[\s._-]+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== n) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

/** "ABCDE-FGHIJ-KLMNP-QRSTV" — groups of five for reading out and typing. */
export function formatTagCode(code: string): string {
  return code.replace(/(.{5})(?=.)/g, "$1-");
}

/** A fresh code for an offline tag (shown once to the writer; never written to the tag). */
export function generateTagCode(): string {
  return randomBase32(OFFLINE_CODE_SYMBOLS);
}

/* ------------------------------------------------------------------ parse */

const B64URL = (len: number) => new RegExp(`^[A-Za-z0-9_-]{${len}}$`);

/** The body of the record ("m5cet:nfc:v2:{…}") as a v2 tag, or an error saying what is wrong. */
export function parseTagV2(body: string): TagV2 {
  if (!body.startsWith(TAG_V2_PREFIX)) throw new NfcError("card-error", "not a v2 connection tag");
  let o: Record<string, unknown>;
  try { o = JSON.parse(body.slice(TAG_V2_PREFIX.length)) as Record<string, unknown>; } catch { throw new NfcError("card-error", "the tag's JSON is malformed"); }
  if (!o || typeof o !== "object" || o.v !== 2) throw new NfcError("card-error", "unknown tag version");
  if (o.t === "inv") {
    const origin = typeof o.o === "string" ? safeOrigin(o.o) : null;
    const k = typeof o.k === "string" ? normalizeBase32(o.k, INVITE_SECRET_SYMBOLS) : null;
    if (!origin || typeof o.id !== "string" || !B64URL(22).test(o.id) || !k) throw new NfcError("card-error", "a malformed invitation tag");
    return { v: 2, t: "inv", o: origin, id: o.id, k };
  }
  if (o.t === "off") {
    const m = Number(o.m), i = Number(o.i);
    if (o.kdf !== "argon2id" || o.p !== 1 || !Number.isInteger(m) || !Number.isInteger(i)) throw new NfcError("card-error", "an unknown key derivation");
    if (m < OFFLINE_KDF_LIMITS.minMemoryKiB || m > OFFLINE_KDF_LIMITS.maxMemoryKiB || i < OFFLINE_KDF_LIMITS.minPasses || i > OFFLINE_KDF_LIMITS.maxPasses) {
      throw new NfcError("card-error", "the tag's key derivation is out of bounds");
    }
    if (typeof o.s !== "string" || !B64URL(22).test(o.s) || typeof o.n !== "string" || !B64URL(16).test(o.n) || typeof o.c !== "string" || !/^[A-Za-z0-9_-]{24,4096}$/.test(o.c)) {
      throw new NfcError("card-error", "a malformed offline tag");
    }
    return { v: 2, t: "off", kdf: "argon2id", m, i, p: 1, s: o.s, n: o.n, c: o.c };
  }
  throw new NfcError("card-error", "unknown tag type");
}

/** https:// (or http://localhost for development) origin, nothing else. */
export function safeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.username || u.password) return null;
    if (u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) return u.origin;
    return null;
  } catch { return null; }
}

/** The record body: prefix + JSON with the keys in the order of § 16 (writers), no spaces. */
export function serializeTagV2(tag: TagV2): string {
  const body = tag.t === "inv"
    ? { v: 2, t: "inv", o: tag.o, id: tag.id, k: tag.k }
    : { v: 2, t: "off", kdf: "argon2id", m: tag.m, i: tag.i, p: 1, s: tag.s, n: tag.n, c: tag.c };
  return TAG_V2_PREFIX + JSON.stringify(body);
}

/* ----------------------------------------------------------------- invite */

async function hkdf(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: ascii(info) }, key, bytes * 8));
}

/**
 * What the invitation's secret opens (§ 16.3): the share link key (32 bytes)
 * and the share code (12 decimal digits) of the invite `id` — both from
 * HKDF-SHA256(ikm = ASCII(k), salt = ASCII(id)).
 */
export async function inviteKeys(id: string, k: string): Promise<{ linkKey: Uint8Array<ArrayBuffer>; code: string }> {
  const secret = normalizeBase32(k, INVITE_SECRET_SYMBOLS);
  if (!secret || !B64URL(22).test(id)) throw new NfcError("invalid-argument", "a bad invitation id or secret");
  const linkKey = await hkdf(ascii(secret), ascii(id), `${LABEL}/link`, 32);
  const raw = await hkdf(ascii(secret), ascii(id), `${LABEL}/code`, 8);
  let n = 0n;
  for (const b of raw) n = (n << 8n) | BigInt(b);
  const code = (n % 1_000_000_000_000n).toString().padStart(12, "0");
  return { linkKey, code };
}

/** A new invitation tag's reference and secret (the invite itself is created on the server with them). */
export function newInviteTag(origin: string, id: string): InviteTag {
  const o = safeOrigin(origin);
  if (!o) throw new NfcError("invalid-argument", "the server's origin is not https");
  return { v: 2, t: "inv", o, id, k: randomBase32(INVITE_SECRET_SYMBOLS) };
}

/* ---------------------------------------------------------------- offline */

const offlineAad = (t: Pick<OfflineTag, "m" | "i" | "p" | "s">) => ascii(`${LABEL}|off|argon2id|${t.m}|${t.i}|${t.p}|${t.s}`);

async function offlineKey(code: string, t: Pick<OfflineTag, "m" | "i" | "s">): Promise<CryptoKey> {
  const raw = await runKdf({ kdf: "argon2id", password: code, salt: t.s, memoryKiB: t.m, passes: t.i });
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally { raw.fill(0); }
}

/**
 * Seals the room for an offline tag under `code` (20 Crockford base32
 * symbols; a fresh one when not given). Writers use the room KDF's cost
 * (ARGON2_PARAMS); `kdf` exists for tests and vectors.
 */
export async function sealOfflineTag(room: TagRoom, opts: { code?: string; kdf?: KdfParams; salt?: Uint8Array; iv?: Uint8Array } = {}): Promise<{ tag: OfflineTag; code: string }> {
  if (!room.room || !room.passphrase) throw new NfcError("invalid-argument", "a connection tag needs a room and a key");
  const code = opts.code ? normalizeBase32(opts.code, OFFLINE_CODE_SYMBOLS) : generateTagCode();
  if (!code) throw new NfcError("invalid-argument", "the code is not 20 base32 symbols");
  const m = opts.kdf?.memoryKiB ?? ARGON2_PARAMS.memoryKiB;
  const i = opts.kdf?.passes ?? ARGON2_PARAMS.passes;
  const s = b64url(opts.salt ?? crypto.getRandomValues(new Uint8Array(16)));
  const iv = new Uint8Array(opts.iv ?? crypto.getRandomValues(new Uint8Array(12)));
  const plain = { room: room.room, passphrase: room.passphrase, ...(room.name ? { name: room.name } : {}), ...(room.app ? { app: room.app } : {}) };
  const key = await offlineKey(code, { m, i, s });
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: offlineAad({ m, i, p: 1, s }) }, key, ascii(JSON.stringify(plain))));
  return { tag: { v: 2, t: "off", kdf: "argon2id", m, i, p: 1, s, n: b64url(iv), c: b64url(ct) }, code };
}

/** Opens an offline tag with the code the writer was shown. A wrong code, or a changed tag, fails. */
export async function openOfflineTag(tag: OfflineTag, codeInput: string): Promise<TagRoom> {
  const code = normalizeBase32(codeInput, OFFLINE_CODE_SYMBOLS);
  if (!code) throw new NfcError("invalid-argument", "the code is 20 base32 symbols");
  const key = await offlineKey(code, tag);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(tag.n), additionalData: offlineAad(tag) }, key, fromB64url(tag.c));
  } catch { throw new NfcError("auth-failed", "wrong code, or the tag was changed"); }
  const o = JSON.parse(dec.decode(plain)) as Record<string, unknown>;
  if (typeof o.room !== "string" || typeof o.passphrase !== "string" || !o.room || !o.passphrase) throw new NfcError("card-error", "the tag does not hold a room");
  return { room: o.room, passphrase: o.passphrase, ...(typeof o.name === "string" && o.name ? { name: o.name } : {}), ...(typeof o.app === "string" ? { app: o.app } : {}) };
}
