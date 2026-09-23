// Binary file chunks.
//
// A file chunk used to travel as JSON with its IV and ciphertext in base64:
// a third more bytes on the wire, plus encoding and decoding on both ends.
// Now a chunk is one binary message — over the data channel, and over the
// signaling socket when the server relays a transfer (server/signaling/
// binary.ts reads the same layout):
//
//   0      1      2        3           4 … 4+L        +4           +12    …
//   'M'    type   version  L (id len)  transferId     seq (u32 BE) IV     ciphertext + tag
//   0x4D   0x01 = P2P chunk, 0x11 = proxy chunk
//
// The ciphertext and IV are exactly what file-transfer.ts sealed (AES-GCM
// with the chunk's associated data); this layer only packs them.

export const FRAME_MAGIC = 0x4d;
export const FRAME_P2P_CHUNK = 0x01;
export const FRAME_PROXY_CHUNK = 0x11;

export type BinaryChunk = { type: number; version: number; transferId: string; seq: number; iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeChunk(chunk: Omit<BinaryChunk, "type"> & { type?: number }): ArrayBuffer {
  const id = encoder.encode(chunk.transferId);
  if (id.length === 0 || id.length > 96) throw new Error("transfer id too long");
  if (chunk.iv.length !== 12) throw new Error("IV must be 12 bytes");
  const out = new Uint8Array(4 + id.length + 4 + 12 + chunk.data.length);
  out[0] = FRAME_MAGIC;
  out[1] = chunk.type ?? FRAME_P2P_CHUNK;
  out[2] = chunk.version;
  out[3] = id.length;
  out.set(id, 4);
  new DataView(out.buffer).setUint32(4 + id.length, chunk.seq >>> 0);
  out.set(chunk.iv, 8 + id.length);
  out.set(chunk.data, 20 + id.length);
  return out.buffer;
}

/** Null for anything that is not a well-formed chunk frame. */
export function decodeChunk(buffer: ArrayBuffer | Uint8Array): BinaryChunk | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4 + 1 + 4 + 12 + 16 || bytes[0] !== FRAME_MAGIC) return null;
  const type = bytes[1];
  if (type !== FRAME_P2P_CHUNK && type !== FRAME_PROXY_CHUNK) return null;
  const len = bytes[3];
  if (len === 0 || len > 96 || bytes.length < 20 + len + 16) return null;
  const transferId = decoder.decode(bytes.subarray(4, 4 + len));
  if (!/^[A-Za-z0-9_:.-]{1,96}$/.test(transferId)) return null;
  const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4 + len);
  return {
    type,
    version: bytes[2],
    transferId,
    seq,
    iv: new Uint8Array(bytes.slice(8 + len, 20 + len)),
    data: new Uint8Array(bytes.slice(20 + len)),
  };
}
