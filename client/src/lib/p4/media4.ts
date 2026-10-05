// Call media keys in protocol 4 (docs/protocol-v4.md § 9).
//
// Protocol 3 derived one media key per direction from the static pair key,
// so every call between two devices reused it (F-19). Now each side picks a
// fresh random 32-byte key per direction for every call (and every
// renegotiation), numbers it with an `epoch`, and sends it to the peer as a
// pair-ratchet `media` inner message. Frames keep the media-frames.ts layout
// (clear prefix as AAD, IV in the trailer); the IV is no longer a random salt
// but
//
//   IV = epoch (4 bytes, big-endian) || frame counter (8 bytes, big-endian, from 0)
//
// so it can never repeat under one key, and the receiver finds the key for a
// frame by the epoch in its IV. A key seals at most 2^32 frames.

import { isSealed, openFrame, sealFrame } from "../media-frames";
import { b64, copy, P4Error, unb64, type Bytes } from "./primitives";
import { systemRng, type Rng } from "./rng";

export const MEDIA_FRAME_LIMIT = 2 ** 32;
const MAX_EPOCH = 2 ** 32 - 1;

/** The `media` inner message (§ 5.7). */
export type MediaInner = { t: "media"; call: string; epoch: number; key: string };

const validEpoch = (epoch: unknown): epoch is number => typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 && epoch <= MAX_EPOCH;

/** § 9 frame IV. */
export function frameIv(epoch: number, counter: number | bigint): Bytes {
  if (!validEpoch(epoch)) throw new P4Error("malformed", "epoch is a 32-bit unsigned integer");
  const c = BigInt(counter);
  if (c < 0n || c >= BigInt(MEDIA_FRAME_LIMIT)) throw new P4Error("malformed", "frame counter out of range");
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  view.setUint32(0, epoch);
  view.setBigUint64(4, c);
  return iv;
}

/** The epoch of a frame IV. */
export const ivEpoch = (iv: Uint8Array): number => new DataView(iv.buffer, iv.byteOffset, iv.byteLength).getUint32(0);

/** A fresh media key for one call direction. Draw: "media.key". */
export function newMediaKey(call: string, epoch: number, rng: Rng = systemRng): { inner: MediaInner; raw: Bytes } {
  if (!validEpoch(epoch)) throw new P4Error("malformed", "epoch is a 32-bit unsigned integer");
  const raw = rng.bytes(32, "media.key");
  return { inner: { t: "media", call, epoch, key: b64(raw) }, raw };
}

export async function importMediaKey(raw: Uint8Array | string): Promise<CryptoKey> {
  const bytes = typeof raw === "string" ? unb64(raw, 32) : raw;
  if (bytes.length !== 32) throw new P4Error("malformed", "media key must be 32 bytes");
  return crypto.subtle.importKey("raw", copy(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Seals our frames under one key; refuses frame 2^32. */
export class MediaSender {
  private counter = 0n;
  constructor(private readonly key: CryptoKey, readonly epoch: number) {
    if (!validEpoch(epoch)) throw new P4Error("malformed", "epoch is a 32-bit unsigned integer");
  }

  /** The IV for the next frame. */
  nextIv(): Bytes {
    if (this.counter >= BigInt(MEDIA_FRAME_LIMIT)) throw new P4Error("expired", "media key used for 2^32 frames: send a new one");
    const iv = frameIv(this.epoch, this.counter);
    this.counter += 1n;
    return iv;
  }

  get sent(): bigint { return this.counter; }

  seal(data: ArrayBuffer, clear: number): Promise<ArrayBuffer> {
    return sealFrame(this.key, data, clear, this.nextIv());
  }
}

const IV_BYTES = 12;

/** The IV in a sealed frame's trailer (media-frames.ts layout), or null. */
export function sealedFrameIv(data: ArrayBuffer): Bytes | null {
  if (!isSealed(data)) return null;
  const b = new Uint8Array(data);
  const at = b.length - 3 - IV_BYTES;
  return b.slice(at, at + IV_BYTES);
}

/** Opens a peer's frames with the key of the epoch in each frame's IV. */
export class MediaReceiver {
  private readonly keys = new Map<number, CryptoKey>();

  /** A peer's `media` inner message. Keeps the newest few epochs (renegotiation overlap). */
  async accept(inner: unknown): Promise<boolean> {
    const m = inner as Partial<MediaInner> | null;
    if (!m || typeof m !== "object" || m.t !== "media" || typeof m.call !== "string" || !validEpoch(m.epoch) || typeof m.key !== "string") return false;
    try { this.keys.set(m.epoch, await importMediaKey(m.key)); } catch { return false; }
    while (this.keys.size > 4) this.keys.delete(Math.min(...this.keys.keys()));
    return true;
  }

  get hasKey(): boolean { return this.keys.size > 0; }

  /** The plain frame; null when it is sealed under no known key or does not open. Unsealed frames: passed through
   *  only while no key is known (§ 9: once a peer's key is known, unsealed frames are dropped). */
  async open(data: ArrayBuffer): Promise<ArrayBuffer | null> {
    const iv = sealedFrameIv(data);
    if (!iv) return this.hasKey ? null : data;
    const key = this.keys.get(ivEpoch(iv));
    return key ? openFrame(key, data) : null;
  }
}
