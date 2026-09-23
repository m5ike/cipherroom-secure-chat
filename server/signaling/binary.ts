// Binary proxy chunks on the signaling socket.
//
// Layout (client/src/lib/binary-frames.ts writes it):
//
//   'M' 0x4D · type 0x11 · version · L · transferId (L bytes) · seq u32 BE · IV (12) · ciphertext+tag
//
// The server never opens a chunk; it checks the header, counts the bytes
// and forwards the message as it came — binary to a peer that joined with
// the "bin" feature, as the JSON proxy-chunk frame to an older one.

export const BINARY_MAGIC = 0x4d;
export const BINARY_PROXY_CHUNK = 0x11;

export type BinaryProxyChunk = {
  type: "proxy-chunk";
  transferId: string;
  seq: number;
  v?: number;
  /** The whole message, forwarded verbatim to binary-capable peers. */
  raw: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
};

const TRANSFER_ID = /^[A-Za-z0-9_:.-]{1,96}$/;

/** A binary message as a proxy chunk, or why it is not one. */
export function parseBinaryChunk(data: Buffer, maxBytes: number): BinaryProxyChunk | { error: string } {
  if (data.length > maxBytes) return { error: "binary frame too large" };
  if (data.length < 4 || data[0] !== BINARY_MAGIC || data[1] !== BINARY_PROXY_CHUNK) return { error: "not a proxy chunk" };
  const len = data[3];
  // header + id + seq + IV + at least the GCM tag
  if (len === 0 || len > 96 || data.length < 4 + len + 4 + 12 + 16) return { error: "truncated proxy chunk" };
  const transferId = data.subarray(4, 4 + len).toString("utf8");
  if (!TRANSFER_ID.test(transferId)) return { error: "bad transfer id" };
  const seq = data.readUInt32BE(4 + len);
  if (seq > 2_000_000) return { error: "bad seq" };
  const version = data[2];
  return {
    type: "proxy-chunk",
    transferId,
    seq,
    ...(version > 1 ? { v: version } : {}),
    raw: data,
    iv: data.subarray(8 + len, 20 + len),
    ciphertext: data.subarray(20 + len),
  };
}

export function isBinaryError(v: BinaryProxyChunk | { error: string }): v is { error: string } {
  return "error" in v;
}
