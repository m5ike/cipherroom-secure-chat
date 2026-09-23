// The recovery code: a way back into an account when every passkey is gone.
//
// 26 characters of Crockford base32 = 130 random bits, shown once as
// XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X for the user to write down. Nothing of it
// ever reaches the server; three independent values are derived from it:
//
//   id       HMAC(code, "m5cet:recovery:id")    — which account (lookup)
//   proof    HMAC(code, "m5cet:recovery:proof") — the server keeps only
//                                                 SHA-256(proof) to check it
//   secret   HMAC(code, "m5cet:recovery:kek")   — seals the account root
//
// With the code the browser proves it to the server, gets the sealed root,
// opens it, registers a new passkey and seals the root for that one too.

import { toBase64 } from "./crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
export const RECOVERY_CODE_CHARS = 26;

/** A fresh code, grouped for writing down. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_CHARS));
  // 256 is a multiple of 32: `b & 31` is unbiased.
  const raw = Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
  return raw.match(/.{1,5}/g)!.join("-");
}

/** How a typed code is compared: case, spaces, dashes and look-alikes do not matter. */
export function normalizeRecoveryCode(code: string): string | null {
  const cleaned = code.toUpperCase().replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0").replace(/U/g, "V");
  if (cleaned.length !== RECOVERY_CODE_CHARS || [...cleaned].some((c) => !ALPHABET.includes(c))) return null;
  return cleaned;
}

const b64url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(key: CryptoKey, label: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label)));
}

/** The three values a code stands for. Throws on a malformed code. */
export async function recoveryMaterial(code: string): Promise<{ id: string; proof: string; verifier: string; secret: Uint8Array }> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new Error("That is not a recovery code (26 characters).");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`m5cet:recovery:v1:${normalized}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const id = b64url((await hmac(key, "m5cet:recovery:id")).slice(0, 18));
  const proof = b64url(await hmac(key, "m5cet:recovery:proof"));
  const verifier = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof))), (b) => b.toString(16).padStart(2, "0")).join("");
  const secret = await hmac(key, "m5cet:recovery:kek");
  return { id, proof, verifier, secret };
}
