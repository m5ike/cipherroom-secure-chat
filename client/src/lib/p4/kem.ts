// ML-KEM-768 (FIPS 203), the post-quantum half of protocol 4: the hello's
// KEM exchange (§ 3), the KEM ratchet in pair headers (§ 5.3) and the mailbox
// (§ 7). A thin wrapper over @noble/post-quantum that pins the sizes — a key,
// ciphertext or seed of the wrong length is `malformed` (for a ciphertext:
// `kct`, it cannot be decapsulated) before the library sees it — and takes
// its randomness from an `Rng`: key generation from a 64-byte seed (d || z),
// encapsulation from a 32-byte message m. Bouncy Castle (Android) accepts the
// same seed and m, so the vectors pin keys, ciphertexts and secrets exactly.
//
// Decapsulation never fails on a well-sized ciphertext (implicit rejection:
// a tampered one yields an unrelated secret), so tampering shows up as an
// AEAD failure one step later — every ciphertext is also bound into the AAD.

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { KEM } from "./contract";
import { b64url, copy, H, P4Error, wipe, type Bytes } from "./primitives";
import { systemRng, type Rng } from "./rng";

export type KemKeyPair = { ek: Bytes; dk: Bytes };

function sized(value: Uint8Array, length: number, what: string, code: "malformed" | "kct" = "malformed"): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new P4Error(code, `${what} must be ${length} bytes`);
  return value;
}

/** Key generation from a 64-byte seed (d || z). */
export function kemKeygenFromSeed(seed: Uint8Array): KemKeyPair {
  const { publicKey, secretKey } = ml_kem768.keygen(sized(seed, KEM.seed, "ML-KEM seed"));
  return { ek: copy(publicKey), dk: copy(secretKey) };
}

/** A fresh key pair; the seed is drawn from `rng` (label `what`) and wiped. */
export function kemKeygen(rng: Rng = systemRng, what = "kem-seed"): KemKeyPair {
  const seed = rng.bytes(KEM.seed, what);
  try { return kemKeygenFromSeed(seed); } finally { wipe(seed); }
}

/** Encapsulation with an explicit 32-byte message m (vectors, replay). */
export function kemEncapsWith(ek: Uint8Array, m: Uint8Array): { ct: Bytes; ss: Bytes } {
  sized(ek, KEM.ek, "ML-KEM encapsulation key");
  sized(m, 32, "ML-KEM message");
  let out: { cipherText: Uint8Array; sharedSecret: Uint8Array };
  try {
    out = ml_kem768.encapsulate(ek, m);
  } catch {
    // FIPS 203 § 7.2 input check (coefficients < q): not a valid key.
    throw new P4Error("malformed", "invalid ML-KEM encapsulation key");
  }
  return { ct: copy(out.cipherText), ss: copy(out.sharedSecret) };
}

/** Encapsulation; m is drawn from `rng` (label `what`) and wiped. */
export function kemEncaps(ek: Uint8Array, rng: Rng = systemRng, what = "kem-m"): { ct: Bytes; ss: Bytes } {
  const m = rng.bytes(32, what);
  try { return kemEncapsWith(ek, m); } finally { wipe(m); }
}

/** Decapsulation; a ciphertext or key of the wrong size is `kct`. */
export function kemDecaps(ct: Uint8Array, dk: Uint8Array): Bytes {
  sized(ct, KEM.ct, "ML-KEM ciphertext", "kct");
  sized(dk, KEM.dk, "ML-KEM decapsulation key", "kct");
  try {
    return copy(ml_kem768.decapsulate(ct, dk));
  } catch {
    throw new P4Error("kct", "ML-KEM decapsulation failed");
  }
}

/** § 5.3 kid: b64url(H(ek))[0:16] — names one of the receiver's KEM keys. */
export async function kemKid(ek: Uint8Array): Promise<string> {
  return b64url(await H(ek)).slice(0, 16);
}
