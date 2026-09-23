// Room cryptography, version 2.
//
// Version 1 derived one AES-GCM key from the passphrase and used it for
// everything — chat, file chunks, the lot — with no associated data, so a
// ciphertext meant for one purpose decrypted just as well in another: a
// file chunk from one transfer fitted any other, a relayed envelope could
// be replayed as a live message, and the signaling server, which relays the
// WebRTC offers in the clear, could swap the DTLS fingerprints in them and
// sit in the middle of a call.
//
// Version 2:
//
//   passphrase ──NFC──▶ PBKDF2-SHA256, 600 000 iterations,
//                       salt "m5cet:room:v2:<room>"          (OWASP 2023)
//        │
//        ▼  256-bit room secret → HKDF-SHA256 (salt "m5cet:v2")
//        ├── info "message" → AES-GCM key for chat envelopes
//        ├── info "signal"  → AES-GCM key sealing SDP / ICE for the server
//        ├── info "files"   → HKDF key; per transfer: info "file",
//        │                    salt = transfer id → one AES key per file
//        └── info "check"   → 64-bit key check value, compared by peers over
//                             the data channel to spot a wrong passphrase
//
// Every encryption binds its context as AES-GCM associated data
// ("m5cet/2|<purpose>|…"): the room and message id for chat, sender and
// recipient peer ids for signals, transfer id, sequence number and chunk
// count for file chunks. Moving a ciphertext anywhere else fails to decrypt.
//
// Sender authenticity: a room key is shared, so any member can write "from
// Alice". A body can therefore be signed with the sender's device identity
// (identity.ts, ECDSA P-256) INSIDE the encryption — the server never sees
// who signed, and the signature covers the same context as the AAD.
//
// Version 1 envelopes are still read (the v1 key is derived on first need),
// so an old client in the room is not cut off mid-conversation.

import { deriveRoomKey as deriveLegacyRoomKey, fromBase64, toBase64, type Bytes } from "./crypto";
import type { Identity } from "./identity";
import { verifyDeviceCert, verifySignature } from "./identity";

export const CRYPTO_VERSION = 2 as const;
export const ROOM_KDF_ITERATIONS = 600_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (s: string): Bytes => new Uint8Array(encoder.encode(s));
const HKDF_SALT = utf8("m5cet:v2");

/** Associated data: the purpose and everything the ciphertext belongs to. */
export function context(...parts: Array<string | number>): Bytes {
  return utf8(["m5cet/2", ...parts.map(String)].join("|"));
}

function concat(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export type RoomKeys = {
  version: 2;
  room: string;
  message: CryptoKey;
  signal: CryptoKey;
  /** HKDF key; fileKey() derives one AES key per transfer from it. */
  files: CryptoKey;
  /** Key check value: equal on both sides iff the passphrases match. */
  check: string;
  /** The version 1 key, derived on first use (old peers, old envelopes). */
  legacy(): Promise<CryptoKey>;
};

export async function deriveRoomKeys(room: string, passphrase: string, opts: { iterations?: number } = {}): Promise<RoomKeys> {
  const material = await crypto.subtle.importKey("raw", utf8(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const seed = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: utf8(`m5cet:room:v2:${room}`), iterations: opts.iterations ?? ROOM_KDF_ITERATIONS, hash: "SHA-256" },
    material,
    256,
  );
  const root = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey", "deriveBits"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: utf8(info) });
  const aes = (info: string) => crypto.subtle.deriveKey(hkdf(info), root, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const [message, signal, filesBits, checkBits] = await Promise.all([
    aes("message"),
    aes("signal"),
    crypto.subtle.deriveBits(hkdf("files"), root, 256),
    crypto.subtle.deriveBits(hkdf("check"), root, 64),
  ]);
  const files = await crypto.subtle.importKey("raw", filesBits, "HKDF", false, ["deriveKey"]);
  let legacy: Promise<CryptoKey> | null = null;
  return {
    version: 2,
    room,
    message,
    signal,
    files,
    check: hex(checkBits),
    legacy: () => (legacy ??= deriveLegacyRoomKey(room, passphrase)),
  };
}

/* ------------------------------------------------------------------ bodies */

/** What travels inside the encryption: the body, who signed it, and (when
 *  signed in) the account that vouches for the signing device. */
type SignedBody = { b: string; pk?: string; s?: string; apk?: string; ac?: string };

export type Signer = {
  publicKey: string;
  valid: boolean;
  /** The account key that certified this device, and whether the certificate holds. */
  account?: { publicKey: string; valid: boolean };
};

async function signBody(body: string, ctx: Bytes, identity?: Identity | null): Promise<string> {
  const inner: SignedBody = { b: body };
  if (identity) {
    inner.pk = identity.publicKey;
    inner.s = await identity.sign(concat(ctx, utf8(body)));
    if (identity.attestation) {
      inner.apk = identity.attestation.accountKey;
      inner.ac = identity.attestation.cert;
    }
  }
  return JSON.stringify(inner);
}

async function readBody(plain: string, ctx: Bytes): Promise<{ body: string; signer: Signer | null }> {
  const inner = JSON.parse(plain) as Partial<SignedBody>;
  if (!inner || typeof inner.b !== "string") throw new Error("malformed body");
  if (typeof inner.pk === "string" && typeof inner.s === "string") {
    const valid = await verifySignature(inner.pk, concat(ctx, utf8(inner.b)), inner.s).catch(() => false);
    const signer: Signer = { publicKey: inner.pk, valid };
    if (typeof inner.apk === "string" && typeof inner.ac === "string") {
      signer.account = { publicKey: inner.apk, valid: valid && await verifyDeviceCert({ accountKey: inner.apk, cert: inner.ac }, inner.pk) };
    }
    return { body: inner.b, signer };
  }
  return { body: inner.b, signer: null };
}

async function encrypt(key: CryptoKey, plain: Bytes, ad?: Bytes): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params: AesGcmParams = ad ? { name: "AES-GCM", iv, additionalData: ad } : { name: "AES-GCM", iv };
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, plain));
  return { iv: toBase64(iv), ciphertext: toBase64(ct) };
}

async function decrypt(key: CryptoKey, iv: string, ciphertext: string, ad?: Bytes): Promise<string> {
  const params: AesGcmParams = ad ? { name: "AES-GCM", iv: fromBase64(iv), additionalData: ad } : { name: "AES-GCM", iv: fromBase64(iv) };
  return decoder.decode(await crypto.subtle.decrypt(params, key, fromBase64(ciphertext)));
}

/* ---------------------------------------------------------------- messages */

/** A chat envelope. Version 1 had only iv + ciphertext. */
export type Envelope = { v?: 2; id?: string; iv: string; ciphertext: string };

export type Opened<T> = { payload: T; version: 1 | 2; signer: Signer | null };

export async function sealMessage(keys: RoomKeys, id: string, payload: unknown, identity?: Identity | null): Promise<Envelope> {
  const ctx = context("msg", keys.room, id);
  const plain = await signBody(JSON.stringify(payload), ctx, identity);
  return { v: 2, id, ...(await encrypt(keys.message, utf8(plain), ctx)) };
}

export async function openMessage<T>(keys: RoomKeys, envelope: Envelope): Promise<Opened<T>> {
  if (envelope.v === 2) {
    if (typeof envelope.id !== "string" || !envelope.id) throw new Error("envelope without id");
    const ctx = context("msg", keys.room, envelope.id);
    const { body, signer } = await readBody(await decrypt(keys.message, envelope.iv, envelope.ciphertext, ctx), ctx);
    const payload = JSON.parse(body) as T;
    // The id inside must be the id the envelope was bound to.
    if ((payload as { id?: unknown })?.id !== envelope.id) throw new Error("envelope id mismatch");
    return { payload, version: 2, signer };
  }
  const plain = await decrypt(await keys.legacy(), envelope.iv, envelope.ciphertext);
  return { payload: JSON.parse(plain) as T, version: 1, signer: null };
}

/* ----------------------------------------------------------------- signals */

/** SDP or ICE sealed for the signaling server: it routes it, it cannot read
 *  or alter it (the DTLS fingerprints in the SDP are what keeps a call
 *  end-to-end). Bound to sender and recipient peer ids. */
export type SealedSignal = { sealed: { v: 2; iv: string; ciphertext: string } };

export async function sealSignal(keys: RoomKeys, from: string, to: string, payload: unknown): Promise<SealedSignal> {
  const ctx = context("signal", keys.room, from, to);
  return { sealed: { v: 2, ...(await encrypt(keys.signal, utf8(JSON.stringify(payload)), ctx)) } };
}

export async function openSignal<T>(keys: RoomKeys, from: string, to: string, sealed: SealedSignal["sealed"]): Promise<T> {
  const ctx = context("signal", keys.room, from, to);
  return JSON.parse(await decrypt(keys.signal, sealed.iv, sealed.ciphertext, ctx)) as T;
}

export function isSealedSignal(value: unknown): value is SealedSignal {
  const s = (value as { sealed?: { v?: unknown; iv?: unknown; ciphertext?: unknown } } | null)?.sealed;
  return Boolean(s) && s!.v === 2 && typeof s!.iv === "string" && typeof s!.ciphertext === "string";
}

/* ------------------------------------------------------------------- files */

/** One AES key per transfer: a broken or reused IV stays inside one file. */
export async function fileKey(keys: RoomKeys, transferId: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(transferId), info: utf8("file") },
    keys.files,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export const fileContext = {
  meta: (transferId: string) => context("file-meta", transferId),
  chunk: (transferId: string, seq: number, total: number) => context("chunk", transferId, seq, total),
  end: (transferId: string) => context("file-end", transferId),
};

/** Encrypts a (signed) JSON body under a file key with its context. */
export async function sealFileBody(key: CryptoKey, ctx: Bytes, value: unknown, identity?: Identity | null): Promise<{ iv: string; ciphertext: string }> {
  return encrypt(key, utf8(await signBody(JSON.stringify(value), ctx, identity)), ctx);
}

export async function openFileBody<T>(key: CryptoKey, ctx: Bytes, iv: string, ciphertext: string): Promise<{ value: T; signer: Signer | null }> {
  const { body, signer } = await readBody(await decrypt(key, iv, ciphertext, ctx), ctx);
  return { value: JSON.parse(body) as T, signer };
}

export async function sealChunk(key: CryptoKey, ctx: Bytes, data: Bytes): Promise<{ iv: string; ciphertext: string }> {
  return encrypt(key, data, ctx);
}

export async function openChunk(key: CryptoKey, ctx: Bytes, iv: string, ciphertext: string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData: ctx }, key, fromBase64(ciphertext)));
}

/** SHA-256 over the concatenated per-chunk digests: the file's fingerprint,
 *  computed while sending and checked by the receiver at the end. */
export async function digestList(digests: Bytes[]): Promise<string> {
  const all = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => all.set(d, i * 32));
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", all)));
}

export async function chunkDigest(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/* ------------------------------------------------------------------ replay */

/** Remembers message ids already accepted, so a replay is dropped. Bounded. */
export function createReplayGuard(limit = 20_000) {
  const seen = new Set<string>();
  return {
    /** True the first time an id is offered, false on every repeat. */
    accept(id: string): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > limit) {
        const drop = seen.size - limit;
        let i = 0;
        for (const old of seen) { if (i++ >= drop) break; seen.delete(old); }
      }
      return true;
    },
    has: (id: string) => seen.has(id),
    clear: () => seen.clear(),
    get size() { return seen.size; },
  };
}
