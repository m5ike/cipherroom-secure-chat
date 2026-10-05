// Where protocol 4 gets its randomness.
//
// Every random value the protocol uses — ephemeral and ratchet P-256 keys,
// ML-KEM seeds and encapsulation messages, nonces, chain keys, ids — is drawn
// through an `Rng`, never from `crypto` directly. In the app that is
// `systemRng` (getRandomValues, non-extractable keys). In tests and in
// script/gen-p4-vectors.ts it is a `RecordingRng`, which writes every draw to
// a TAPE (bytes as b64, P-256 private keys as PKCS#8 b64), and a `TapeRng`
// that replays one: the Java port replays the same tape and must produce the
// same frames byte for byte.
//
// Each draw carries a label (`what`) so a replay that draws in another order
// fails at once, naming the draw, instead of producing wrong keys later. The
// draw order is part of the vectors' contract (docs/protocol-v4.md, the order
// in which each section introduces its random values).

import { b64, copy, ECDH_P256, ECDSA_P256, importP256Pkcs8, P4Error, unb64, type Bytes, type P256Pair } from "./primitives";

export interface Rng {
  /** `n` random bytes; `what` names the draw. */
  bytes(n: number, what: string): Bytes;
  /** A fresh P-256 key pair for ECDH or for ECDSA. */
  p256(use: "ecdh" | "ecdsa", what: string): Promise<P256Pair>;
}

const subtle = () => globalThis.crypto.subtle;
const usagesOf = (use: "ecdh" | "ecdsa"): KeyUsage[] => (use === "ecdh" ? ["deriveBits"] : ["sign", "verify"]);

async function generate(use: "ecdh" | "ecdsa", extractable: boolean): Promise<P256Pair> {
  const pair = await subtle().generateKey(use === "ecdh" ? ECDH_P256 : ECDSA_P256, extractable, usagesOf(use)) as CryptoKeyPair;
  const spki = b64(new Uint8Array(await subtle().exportKey("spki", pair.publicKey)));
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, spki };
}

/** The real thing: getRandomValues and non-extractable private keys. */
export const systemRng: Rng = {
  bytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  p256: (use) => generate(use, false),
};

export type TapeEntry =
  | { what: string; bytes: string }
  | { what: string; p256: "ecdh" | "ecdsa"; pkcs8: string; spki: string };

/** Draws real randomness and records it (tests, vector generation). Keys are extractable so they can be recorded. */
export class RecordingRng implements Rng {
  readonly tape: TapeEntry[] = [];
  constructor(private readonly source: (n: number) => Bytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {}

  bytes(n: number, what: string): Bytes {
    const out = this.source(n);
    this.tape.push({ what, bytes: b64(out) });
    return copy(out);
  }

  async p256(use: "ecdh" | "ecdsa", what: string): Promise<P256Pair> {
    const pair = await generate(use, true);
    const pkcs8 = b64(new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey)));
    this.tape.push({ what, p256: use, pkcs8, spki: pair.spki });
    return pair;
  }
}

/** Replays a tape; a draw of another kind, label or length than recorded throws `state`. */
export class TapeRng implements Rng {
  private at = 0;
  constructor(private readonly tape: readonly TapeEntry[]) {}

  get remaining(): number { return this.tape.length - this.at; }

  private take(what: string): TapeEntry {
    const entry = this.tape[this.at];
    if (!entry) throw new P4Error("state", `tape exhausted at draw "${what}"`);
    if (entry.what !== what) throw new P4Error("state", `tape draw ${this.at} is "${entry.what}", wanted "${what}"`);
    this.at += 1;
    return entry;
  }

  bytes(n: number, what: string): Bytes {
    const entry = this.take(what);
    if (!("bytes" in entry)) throw new P4Error("state", `tape draw "${what}" is not bytes`);
    const out = unb64(entry.bytes);
    if (out.length !== n) throw new P4Error("state", `tape draw "${what}" has ${out.length} bytes, wanted ${n}`);
    return out;
  }

  async p256(use: "ecdh" | "ecdsa", what: string): Promise<P256Pair> {
    const entry = this.take(what);
    if (!("p256" in entry) || entry.p256 !== use) throw new P4Error("state", `tape draw "${what}" is not a P-256 ${use} key`);
    const pair = await importP256Pkcs8(entry.pkcs8, use);
    if (pair.spki !== entry.spki) throw new P4Error("state", `tape draw "${what}": public key does not match`);
    return pair;
  }
}
