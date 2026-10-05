// Protocol 4 primitives (docs/protocol-v4.md § 0): the transcript join, SHA-256,
// HMAC, HKDF, the per-message key / IV split, P-256 ECDH and ECDSA (raw r||s),
// AES-256-GCM with associated data, the base64 codecs and a constant-time
// compare.
//
// Everything is WebCrypto (browsers, Node 24), so the same bytes come out on
// the web, in the server's tests and — through test/vectors/p4.json — in the
// Java port. Transcript parts are validated in ONE place (`part`): a part with
// "|" or a non-ASCII character, or a number that is not a non-negative safe
// integer, throws — two different transcripts can never join to the same
// bytes, and a peer cannot smuggle a separator in through a message id.

import { fromBase64, toBase64, type Bytes } from "../crypto";

export type { Bytes };

const subtle = () => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/* -------------------------------------------------------------- errors */

/**
 * Why a protocol-4 operation refused its input. The codes are stable (tests,
 * UI, the reset reason): `malformed` (shape, sizes, encoding), `aead` (did not
 * decrypt), `kct` (a KEM ciphertext that cannot be decapsulated), `skip` (too
 * far ahead), `replay` (a key already used), `signature`, `no-chain`,
 * `expired`, `wiped`, `id-mismatch`, `state` (wiped or misused object).
 */
export type P4ErrorCode =
  | "malformed" | "aead" | "kct" | "skip" | "replay" | "signature" | "no-chain"
  | "expired" | "wiped" | "id-mismatch" | "state";

export class P4Error extends Error {
  constructor(readonly code: P4ErrorCode, message: string = code) {
    super(message);
    this.name = "P4Error";
  }
}

/* --------------------------------------------------------------- bytes */

export const utf8 = (s: string): Bytes => new Uint8Array(encoder.encode(s));
/** Strict UTF-8 decoding (an invalid sequence throws, it is never replaced). */
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

export function concat(...parts: Uint8Array[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A detached copy backed by its own ArrayBuffer (what WebCrypto wants). */
export const copy = (b: Uint8Array): Bytes => new Uint8Array(b);

/** Constant-time equality for equal lengths; different lengths are simply unequal. */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function wipe(...parts: Array<Uint8Array | null | undefined>): void {
  for (const p of parts) p?.fill(0);
}

/* -------------------------------------------------------------- base64 */

export const b64 = (b: Uint8Array): string => toBase64(b);

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Strict standard base64: only the canonical encoding of some bytes is
 * accepted (padding required, no whitespace, no stray bits), optionally of an
 * exact length. Anything else is `malformed`.
 */
export function unb64(value: unknown, length?: number): Bytes {
  if (typeof value !== "string" || value.length % 4 !== 0 || !B64_RE.test(value)) throw new P4Error("malformed", "not base64");
  let out: Bytes;
  try { out = fromBase64(value); } catch { throw new P4Error("malformed", "not base64"); }
  if (toBase64(out) !== value) throw new P4Error("malformed", "non-canonical base64");
  if (length !== undefined && out.length !== length) throw new P4Error("malformed", `expected ${length} bytes, got ${out.length}`);
  return out;
}

export const b64url = (b: Uint8Array): string => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Strict base64url without padding (canonical only). */
export function unb64url(value: unknown, length?: number): Bytes {
  if (typeof value !== "string" || !B64URL_RE.test(value) || value.length % 4 === 1) throw new P4Error("malformed", "not base64url");
  const std = value.replace(/-/g, "+").replace(/_/g, "/");
  const out = unb64(std + "=".repeat((4 - (std.length % 4)) % 4));
  if (b64url(out) !== value) throw new P4Error("malformed", "non-canonical base64url");
  if (length !== undefined && out.length !== length) throw new P4Error("malformed", `expected ${length} bytes, got ${out.length}`);
  return out;
}

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/* ---------------------------------------------------------------- join */

const PART_RE = /^[\x20-\x7b\x7d\x7e]*$/; // printable ASCII without "|" (0x7c)

function part(p: string | number): string {
  if (typeof p === "number") {
    if (!Number.isSafeInteger(p) || p < 0) throw new P4Error("malformed", "transcript integer out of range");
    return String(p);
  }
  if (typeof p !== "string" || !PART_RE.test(p)) throw new P4Error("malformed", "transcript part is not ASCII without |");
  return p;
}

/** § 0: the text of `join(a, b, …)` — parts joined with "|". */
export const joinText = (...parts: Array<string | number>): string => parts.map(part).join("|");

/** § 0: `join(a, b, …)` — the UTF-8 (here: ASCII) bytes of the parts joined with "|". */
export const join = (...parts: Array<string | number>): Bytes => utf8(joinText(...parts));

/* ------------------------------------------------------- hash and KDFs */

/** SHA-256. */
export async function H(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", copy(data)));
}

/** b64(H(x)) — the digest form every transcript uses. */
export const hB64 = async (data: Uint8Array): Promise<string> => b64(await H(data));

/** HMAC-SHA-256. */
export async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await subtle().importKey("raw", copy(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, copy(data)));
}

/** RFC 5869 HKDF-SHA-256; `info` is the UTF-8 of the label. */
export async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, length: number): Promise<Bytes> {
  if (!Number.isInteger(length) || length <= 0 || length > 255 * 32) throw new RangeError("HKDF length");
  const base = await subtle().importKey("raw", copy(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: copy(salt), info: typeof info === "string" ? utf8(info) : copy(info) },
    base, length * 8,
  );
  return new Uint8Array(bits);
}

const ZERO32 = new Uint8Array(32);

/** § 5.1 keyIv: HKDF(salt = 32 zero bytes, ikm = mk, info = label, L = 44) → key [0:32], iv [32:44]. */
export async function keyIv(mk: Uint8Array, label: string): Promise<{ key: Bytes; iv: Bytes }> {
  const okm = await hkdf(ZERO32, mk, label, 44);
  const out = { key: okm.slice(0, 32), iv: okm.slice(32, 44) };
  okm.fill(0);
  return out;
}

/* ------------------------------------------------------------- AES-GCM */

async function aesKey(key: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (key.length !== 32) throw new P4Error("malformed", "AES-256 key must be 32 bytes");
  return subtle().importKey("raw", copy(key), { name: "AES-GCM" }, false, [usage]);
}

/** AES-256-GCM, 12-byte IV, the 16-byte tag appended. */
export async function aesGcmSeal(key: Uint8Array | CryptoKey, iv: Uint8Array, aad: Uint8Array, plain: Uint8Array): Promise<Bytes> {
  if (iv.length !== 12) throw new P4Error("malformed", "IV must be 12 bytes");
  const k = key instanceof Uint8Array ? await aesKey(key, "encrypt") : key;
  return new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: copy(iv), additionalData: copy(aad) }, k, copy(plain)));
}

/** Inverse of {@link aesGcmSeal}; any failure is `aead`. */
export async function aesGcmOpen(key: Uint8Array | CryptoKey, iv: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Promise<Bytes> {
  if (iv.length !== 12 || sealed.length < 16) throw new P4Error("aead", "ciphertext too short");
  const k = key instanceof Uint8Array ? await aesKey(key, "decrypt") : key;
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: copy(iv), additionalData: copy(aad) }, k, copy(sealed)));
  } catch {
    throw new P4Error("aead", "does not decrypt");
  }
}

/* --------------------------------------------------------------- P-256 */

export const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;
export const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;

/** A P-256 key pair; `spki` is the public key as SPKI DER, base64. */
export type P256Pair = { privateKey: CryptoKey; publicKey: CryptoKey; spki: string };

/** Imports a peer's ECDH public key (SPKI b64); an invalid key or another curve is `malformed`. */
export async function importEcdhPublic(spki: unknown): Promise<CryptoKey> {
  const der = unb64(spki);
  try {
    return await subtle().importKey("spki", der, ECDH_P256, true, []);
  } catch {
    throw new P4Error("malformed", "not a P-256 public key");
  }
}

/** ECDH: the 32-byte x-coordinate of the shared point. */
export async function ecdh(privateKey: CryptoKey, peer: string | CryptoKey): Promise<Bytes> {
  const pub = typeof peer === "string" ? await importEcdhPublic(peer) : peer;
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
}

/** ECDSA P-256 / SHA-256, raw r||s (64 bytes), base64. */
export async function ecdsaSign(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  return b64(new Uint8Array(await subtle().sign(ECDSA_SHA256, privateKey, copy(data))));
}

const verifyKeys = new Map<string, Promise<CryptoKey>>();

/** Verifies a raw r||s signature with an SPKI (b64) key; never throws. */
export async function ecdsaVerify(spki: string, data: Uint8Array, signature: string): Promise<boolean> {
  try {
    const sig = unb64(signature, 64);
    let key = verifyKeys.get(spki);
    if (!key) {
      key = subtle().importKey("spki", unb64(spki), ECDSA_P256, false, ["verify"]);
      verifyKeys.set(spki, key);
      if (verifyKeys.size > 500) verifyKeys.delete(verifyKeys.keys().next().value!);
    }
    return await subtle().verify(ECDSA_SHA256, await key, sig, copy(data));
  } catch {
    verifyKeys.delete(spki);
    return false;
  }
}

/** Is this a P-256 public key (SPKI b64)? */
export async function isP256Spki(spki: unknown): Promise<boolean> {
  try { await importEcdhPublic(spki); return true; } catch { return false; }
}

/** Imports a PKCS#8 (b64) P-256 private key for ECDH or ECDSA, with its public half. */
export async function importP256Pkcs8(pkcs8: string, use: "ecdh" | "ecdsa", extractable = false): Promise<P256Pair> {
  const der = unb64(pkcs8);
  const alg = use === "ecdh" ? ECDH_P256 : ECDSA_P256;
  const usages: KeyUsage[] = use === "ecdh" ? ["deriveBits"] : ["sign"];
  // The public half: from a JWK export of an extractable copy (x, y), then dropped.
  const full = await subtle().importKey("pkcs8", der, alg, true, usages);
  const jwk = await subtle().exportKey("jwk", full);
  const publicKey = await subtle().importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }, alg, true, use === "ecdh" ? [] : ["verify"]);
  const privateKey = extractable ? full : await subtle().importKey("pkcs8", der, alg, false, usages);
  const spki = b64(new Uint8Array(await subtle().exportKey("spki", publicKey)));
  return { privateKey, publicKey, spki };
}

/* ------------------------------------------------------------- Ed25519 */

// RFC 8410 PKCS#8 wrapping of a raw 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/**
 * An Ed25519 key pair from a 32-byte seed (RFC 8032). The public key comes
 * from a JWK export of an extractable copy that lives only for that moment;
 * the private key returned is non-extractable.
 */
export async function ed25519FromSeed(seed: Uint8Array): Promise<{ privateKey: CryptoKey; publicKey: Bytes }> {
  if (seed.length !== 32) throw new P4Error("malformed", "Ed25519 seed must be 32 bytes");
  const pkcs8 = concat(PKCS8_ED25519_PREFIX, seed);
  try {
    const exportable = await subtle().importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await subtle().exportKey("jwk", exportable);
    const privateKey = await subtle().importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    return { privateKey, publicKey: unb64url(jwk.x, 32) };
  } finally {
    pkcs8.fill(0);
  }
}

export async function ed25519Sign(privateKey: CryptoKey, data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().sign({ name: "Ed25519" }, privateKey, copy(data)));
}

/** Verifies an Ed25519 signature; `publicKey` is the raw 32 bytes or their b64. Never throws. */
export async function ed25519Verify(publicKey: Uint8Array | string, data: Uint8Array, signature: Uint8Array | string): Promise<boolean> {
  try {
    const pub = typeof publicKey === "string" ? unb64(publicKey, 32) : publicKey;
    const sig = typeof signature === "string" ? unb64(signature, 64) : signature;
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = await subtle().importKey("raw", copy(pub), { name: "Ed25519" }, false, ["verify"]);
    return await subtle().verify({ name: "Ed25519" }, key, copy(sig), copy(data));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- signer */

/** What signs for this device: the protocol-3 Identity fits (`publicKey` SPKI b64, raw r||s b64 signatures). */
export type DeviceSigner = { publicKey: string; sign(data: Bytes): Promise<string> };

/* ---------------------------------------------------------------- misc */

export const isSafeCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Serialises async work on one object (ratchet, store): each call waits for the previous one. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
