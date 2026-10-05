// Padding (docs/protocol-v4.md § 10): every protocol-4 plaintext is padded to
// a bucket so the ciphertext length says little about the message — a "yes"
// and a paragraph look the same on the wire.
//
//   pad(m)   = m || 0x80 || 0x00…  up to the smallest PAD_BUCKETS entry that
//              is >= len(m) + 1; above 65 536, the next multiple of 65 536
//   unpad(m) = strip trailing 0x00, then require and strip one 0x80
//
// (ISO/IEC 7816-4 padding: unambiguous for any message, including one that
// itself ends in 0x80 or 0x00 bytes.)

import { PAD_BUCKETS } from "./contract";
import { P4Error, type Bytes } from "./primitives";

const TOP = PAD_BUCKETS[PAD_BUCKETS.length - 1];

/** The padded length (marker included) of a message of `length` bytes. */
export function paddedLength(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("message length");
  const need = length + 1;
  for (const bucket of PAD_BUCKETS) if (bucket >= need) return bucket;
  return Math.ceil(need / TOP) * TOP;
}

export function pad(message: Uint8Array): Bytes {
  const out = new Uint8Array(paddedLength(message.length));
  out.set(message, 0);
  out[message.length] = 0x80;
  return out;
}

/** The message inside; a missing 0x80 marker is `malformed`. */
export function unpad(padded: Uint8Array): Bytes {
  let i = padded.length - 1;
  while (i >= 0 && padded[i] === 0x00) i--;
  if (i < 0 || padded[i] !== 0x80) throw new P4Error("malformed", "bad padding");
  return padded.slice(0, i);
}
