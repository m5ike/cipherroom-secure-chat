// End-to-end encryption of call frames (the SFrame idea, simplified).
//
// A call already runs over DTLS-SRTP between the two browsers, and the
// signaling that sets it up is sealed with the room key. Encrypting every
// encoded frame once more, with keys only the two peers derived (ECDH pair
// key, one key per direction — sender-keys.ts), keeps the media end to end
// even through a middlebox that terminates SRTP: a selective forwarding
// unit, a recording relay, a compromised TURN-over-TLS proxy.
//
// Frame layout:
//
//   [clear prefix n][AES-GCM ciphertext + 16-byte tag][IV 12][n][0x6D][0xE3]
//
// The prefix stays readable because the packetiser and an SFU need it
// (Opus TOC byte; VP8 payload header — 10 bytes of a key frame, 3 of a
// delta frame, as Jitsi does) and is authenticated as associated data.
// The IV is a random 4-byte salt per sender plus a 64-bit frame counter.

export const TRAILER = [0x6d, 0xe3] as const;
const TAG = 16;
const IV = 12;
const OVERHEAD = TAG + IV + 1 + TRAILER.length;

export type MediaKind = "audio" | "video";

/** How many leading bytes stay in the clear. */
export function clearBytes(kind: MediaKind, keyFrame: boolean, length: number): number {
  const n = kind === "audio" ? 1 : keyFrame ? 10 : 3;
  return Math.min(n, length);
}

/** IVs for one sender: never the same twice under one key. */
export class FrameIvs {
  private readonly salt = crypto.getRandomValues(new Uint8Array(4));
  private counter = 0n;
  next(): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(IV);
    iv.set(this.salt, 0);
    new DataView(iv.buffer).setBigUint64(4, this.counter);
    this.counter += 1n;
    return iv;
  }
}

export async function sealFrame(key: CryptoKey, data: ArrayBuffer, clear: number, iv: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  const prefix = bytes.subarray(0, clear);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: prefix }, key, bytes.subarray(clear)));
  const out = new Uint8Array(clear + ct.length + IV + 1 + TRAILER.length);
  out.set(prefix, 0);
  out.set(ct, clear);
  out.set(iv, clear + ct.length);
  out[out.length - 3] = clear;
  out[out.length - 2] = TRAILER[0];
  out[out.length - 1] = TRAILER[1];
  return out.buffer;
}

/** True when the frame carries our trailer (it was sealed). */
export function isSealed(data: ArrayBuffer): boolean {
  const b = new Uint8Array(data);
  return b.length >= OVERHEAD && b[b.length - 2] === TRAILER[0] && b[b.length - 1] === TRAILER[1] && b[b.length - 3] <= b.length - OVERHEAD;
}

/** The plain frame; null when it does not open (wrong key, tampered). */
export async function openFrame(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer | null> {
  if (!isSealed(data)) return null;
  const b = new Uint8Array(data);
  const clear = b[b.length - 3];
  const ivAt = b.length - 3 - IV;
  const prefix = b.subarray(0, clear);
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(ivAt, ivAt + IV), additionalData: prefix }, key, b.subarray(clear, ivAt)));
    const out = new Uint8Array(clear + plain.length);
    out.set(prefix, 0);
    out.set(plain, clear);
    return out.buffer;
  } catch {
    return null;
  }
}

export type MediaStats = { sealed: number; opened: number; clearOut: number; clearIn: number; failed: number };
export const emptyStats = (): MediaStats => ({ sealed: 0, opened: 0, clearOut: 0, clearIn: 0, failed: 0 });
