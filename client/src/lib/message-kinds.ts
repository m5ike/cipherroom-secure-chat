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

import type { FnOutput } from "./fn-outputs";
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

/** v2: 12-character code, normalised, 600 000 PBKDF2 iterations (`it`).
 *  Without `v` the message is from version 1 (6 characters, 150 000). */
export type SealedMeta = { salt: string; iv: string; v?: number; it?: number };

/** Flags carried inside the decrypted chat payload. */
export type MsgFlags = {
  tap?: boolean;
  vanishSeconds?: number;
  /** Present when the `text` field is itself ciphertext (base64). */
  sealed?: SealedMeta;
  /** 4.15: the body is the Markdown output of a chat command ("/keyword"). */
  fn?: FnMeta;
};

/**
 * A chat command's message (4.15; 5.3 adds the rest): which model, its
 * processing session and the call that made it (a reply, a click or a form
 * continues it), the entry points it answers, and the outputs themselves (the
 * text stays Markdown for older apps and for search).
 */
export type FnMeta = {
  keyword: string;
  name: string;
  model?: string;
  chain?: string;
  call?: number;
  /** response · button · form · error — what reaches the model from this message. */
  events?: string[];
  outputs?: FnOutput[];
  /** The model's error entry point wrote it (its own render errors are not reported again). */
  origin?: "error";
  /**
   * 6.5: the call shows at once as the sender's own bubble. `query` is the
   * command line the person sent; while `pending` the bubble pulses and a
   * loading indicator sits under it, then the result (`outputs`) or a short
   * `status` (a room answer that went out, or an error/status code) replaces it.
   */
  query?: string;
  pending?: boolean;
  status?: FnStatus;
  /**
   * 6.11: the model's icon (a lucide name or an emoji) — with `keyword` and
   * `name` the identity its answer is shown under ("system-messenger": the
   * model's name as the nickname, its icon as the avatar; system-messenger.ts).
   * Display only: a room answer still names the member who sent it ("via …").
   */
  icon?: string;
  /** 6.11: what a running call last said of itself (m5.run.progress) — under its loading. Never sent. */
  progress?: { p: number; text: string };
};

/** The outcome shown under a call's own bubble when there is no inline result.
 *  6.11: an empty `label` with a `code` is said in the viewer's language (functions.status.<code>). */
export type FnStatus = { kind: "ok" | "error" | "info"; label: string; code?: string };

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
export const SEAL_CODE_LENGTH = 12;
export const SEAL_ITERATIONS = 600_000;
const LEGACY_SEAL_ITERATIONS = 150_000;

/**
 * A shared code shown to the sender to pass out of band: 12 characters
 * (≈ 59 bits), shown as XXXX-XXXX-XXXX. Version 1 used 6 (≈ 30 bits), which
 * any room member holding the ciphertext could try exhaustively in hours.
 * Characters are drawn by rejection sampling — `byte % 31` favoured the
 * first eight letters.
 */
export function generateSealCode(len = SEAL_CODE_LENGTH, grouped = len >= 8): string {
  let out = "";
  const limit = 256 - (256 % SEAL_ALPHABET.length);
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b >= limit) continue;
      out += SEAL_ALPHABET[b % SEAL_ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return grouped ? out.match(/.{1,4}/g)!.join("-") : out;
}

/** How a typed code is compared: case, spaces and dashes do not matter. */
export function normalizeSealCode(code: string): string {
  return code.normalize("NFKC").toUpperCase().replace(/[\s-]+/g, "");
}

async function deriveSealKey(code: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", buf(code), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt `plaintext` under `code`; returns the ciphertext + the meta to ship. */
export async function sealText(plaintext: string, code: string, iterations = SEAL_ITERATIONS): Promise<{ meta: SealedMeta; ciphertext: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSealKey(normalizeSealCode(code), salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf(plaintext)));
  return { meta: { salt: toBase64(salt), iv: toBase64(iv), v: 2, it: iterations }, ciphertext: toBase64(ct) };
}

/** Reverse of sealText. Throws on a wrong code (AES-GCM tag mismatch). */
export async function openSealed(ciphertext: string, meta: SealedMeta, code: string): Promise<string> {
  const v2 = meta.v === 2;
  const key = await deriveSealKey(v2 ? normalizeSealCode(code) : code, fromBase64(meta.salt), v2 ? (meta.it ?? SEAL_ITERATIONS) : LEGACY_SEAL_ITERATIONS);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(meta.iv) }, key, fromBase64(ciphertext));
  return decoder.decode(plain);
}
