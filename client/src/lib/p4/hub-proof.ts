// Hub join proof (docs/protocol-v4.md § 13, G-09).
//
// The hub routes by the blind room id, and until 6.12 it admitted anyone who
// knew that id — which every member's browser, every relay log line and every
// shared link exposes. Now a join carries a proof that the joiner knows the
// room KEY: an Ed25519 key pair derived from the room secret
// (hubSeed = RoomKeys.derive("m5cet/hub-auth/4", 256)) signs the server's
// per-socket nonce. The server learns only the public key (the room's
// verifier, registered by the first proven join) — never anything that would
// let it derive the room key or forge a member's proof.
//
// `verifyHubProof` is the server's side (Node 24 WebCrypto has Ed25519).

import { LABEL, type HubJoinProof } from "./contract";
import { b64, ed25519FromSeed, ed25519Sign, ed25519Verify, join, P4Error, unb64, unb64url, type Bytes } from "./primitives";

/** § 13: the 32-byte seed from the room keys (RoomKeys.derive). */
export function hubSeed(keys: { derive(info: string, bits?: number): Promise<Uint8Array<ArrayBuffer>> }): Promise<Bytes> {
  return keys.derive(LABEL.hubSeed, 256);
}

/** The room's hub key pair (the same in every member's client). */
export async function hubKeyPair(seed: Uint8Array): Promise<{ privateKey: CryptoKey; pub: string }> {
  const { privateKey, publicKey } = await ed25519FromSeed(seed);
  return { privateKey, pub: b64(publicKey) };
}

/** § 13: the bytes the proof signs. The nonce is the server's: b64url of 24 bytes. */
export function hubJoinData(roomId: string, nonce: string): Bytes {
  unb64url(nonce, 24);
  return join(LABEL.hubJoin, roomId, nonce);
}

/** § 13: the `proof` of a join frame. */
export async function buildHubProof(seed: Uint8Array, roomId: string, nonce: string): Promise<HubJoinProof> {
  const { privateKey, pub } = await hubKeyPair(seed);
  return { pub, sig: b64(await ed25519Sign(privateKey, hubJoinData(roomId, nonce))) };
}

/** Server: does `sig` prove knowledge of the key behind `pub` for this room and socket nonce? Never throws. */
export async function verifyHubProof(pub: unknown, sig: unknown, roomId: unknown, nonce: unknown): Promise<boolean> {
  if (typeof pub !== "string" || typeof sig !== "string" || typeof roomId !== "string" || typeof nonce !== "string") return false;
  let data: Bytes;
  try {
    unb64(pub, 32);
    unb64(sig, 64);
    data = hubJoinData(roomId, nonce);
  } catch (error) {
    if (error instanceof P4Error) return false;
    throw error;
  }
  return ed25519Verify(pub, data, sig);
}
