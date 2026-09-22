// Extra message kinds a sender can layer onto a normal chat message.
//
// A message may carry NONE, ONE, TWO or all THREE of these flags at once:
//
//   tap     — "klikací": the body is hidden; it shows only while the reader
//             holds a finger/pointer on the bubble (like a drawn curtain).
//   vanish  — "mizející": a TTL in [4 s, 2 h]. The countdown only advances
//             while the message is actually visible (tab focused, bubble in
//             view, and — for a tap message — while it is being revealed).
//             When it elapses the bubble becomes a tombstone at 80% opacity.
//   sealed  — "individuálně šifrovaná": the text is AES-GCM encrypted under a
//             separate code (a passphrase, or a random 6-char code). Peers in
//             the room still cannot read it without that code, which travels
//             out of band.
//
// The room-level E2EE envelope still wraps everything; these flags live
// INSIDE the already-decrypted payload, so the signalling server never sees
// them and a passive room member cannot read a sealed body.

import { toBase64, fromBase64 } from "./crypto";

export const VANISH_MIN_SECONDS = 4;
export const VANISH_MAX_SECONDS = 2 * 60 * 60; // 7200 s = 2 h

export const VANISH_PRESETS: ReadonlyArray<{ labelKey: string; seconds: number }> = [
  { labelKey: "msgkind.vanish.4s", seconds: 4 },
  { labelKey: "msgkind.vanish.15s", seconds: 15 },
  { labelKey: "msgkind.vanish.1m", seconds: 60 },
  { labelKey: "msgkind.vanish.5m", seconds: 300 },
  { labelKey: "msgkind.vanish.30m", seconds: 1800 },
  { labelKey: "msgkind.vanish.1h", seconds: 3600 },
  { labelKey: "msgkind.vanish.2h", seconds: 7200 },
];

export type SealedMeta = { salt: string; iv: string };

/** Flags carried inside the decrypted chat payload. */
export type MsgFlags = {
  tap?: boolean;
  vanishSeconds?: number;
  /** Present when the `text` field is itself ciphertext (base64). */
  sealed?: SealedMeta;
};

export function hasAnyFlag(flags: MsgFlags | undefined): boolean {
  return Boolean(flags && (flags.tap || flags.vanishSeconds || flags.sealed));
}

export function clampVanishSeconds(v: number): number {
  if (!Number.isFinite(v)) return VANISH_MIN_SECONDS;
  return Math.max(VANISH_MIN_SECONDS, Math.min(VANISH_MAX_SECONDS, Math.round(v)));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// WebCrypto's lib types want ArrayBuffer-backed views; a fresh copy is always
// Uint8Array<ArrayBuffer> and satisfies BufferSource.
const buf = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(s));

// Crockford-ish alphabet without look-alikes (no 0/O, 1/I/L).
const SEAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A short shared code shown to the sender to pass out of band. */
export function generateSealCode(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i += 1) out += SEAL_ALPHABET[bytes[i] % SEAL_ALPHABET.length];
  return out;
}

async function deriveSealKey(code: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", buf(code), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt `plaintext` under `code`; returns the ciphertext + the meta to ship. */
export async function sealText(plaintext: string, code: string): Promise<{ meta: SealedMeta; ciphertext: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSealKey(code, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf(plaintext)));
  return { meta: { salt: toBase64(salt), iv: toBase64(iv) }, ciphertext: toBase64(ct) };
}

/** Reverse of sealText. Throws on a wrong code (AES-GCM tag mismatch). */
export async function openSealed(ciphertext: string, meta: SealedMeta, code: string): Promise<string> {
  const key = await deriveSealKey(code, fromBase64(meta.salt));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(meta.iv) }, key, fromBase64(ciphertext));
  return decoder.decode(plain);
}
