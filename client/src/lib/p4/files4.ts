// Files in protocol 4 (docs/protocol-v4.md § 8).
//
// Protocol 3 derived every file key from the ROOM key (envelope.ts fileKey):
// anyone with the passphrase could open any transfer they captured. Now the
// sender picks a random 32-byte FK per transfer and sends it end to end — a
// pair `file` inner message on a data channel, or the attachment's `fk` in
// the (pair, sender-key or mailbox) message that announces a relayed file:
//
//   fileKey   = HKDF(salt = UTF-8(transferId), ikm = FK, "m5cet/p4/file", 32)
//   AAD meta  = join("m5cet/p4/file-meta", transferId)
//   AAD chunk = join("m5cet/p4/chunk", transferId, seq, total)
//   AAD end   = join("m5cet/p4/file-end", transferId)
//
// Meta and end bodies are padded (§ 10); chunks are not (their size is fixed
// except the last). The frame formats stay those of protocol 3 ({ iv,
// ciphertext } with a random 12-byte IV).

import { LABEL } from "./contract";
import { pad, unpad } from "./pad";
import { aesGcmOpen, aesGcmSeal, b64, copy, fromUtf8, hkdf, join, P4Error, unb64, utf8, wipe, type Bytes } from "./primitives";
import { systemRng, type Rng } from "./rng";

/** The `file` inner message (§ 5.7). */
export type FileInner = { t: "file"; transferId: string; key: string };

/** A fresh FK for one transfer. Draw: "file.key". */
export function newFileKey(transferId: string, rng: Rng = systemRng): { inner: FileInner; fk: Bytes } {
  join(transferId); // ASCII without "|": it goes into every AAD
  const fk = rng.bytes(32, "file.key");
  return { inner: { t: "file", transferId, key: b64(fk) }, fk };
}

/** § 8: the raw 32-byte file key (vectors; `fileKey4` imports it). */
export async function fileKeyBytes(fk: Uint8Array, transferId: string): Promise<Bytes> {
  if (fk.length !== 32) throw new P4Error("malformed", "FK must be 32 bytes");
  return hkdf(utf8(transferId), fk, LABEL.file, 32);
}

/** § 8: the AES-GCM key of one transfer. */
export async function fileKey4(fk: Uint8Array | string, transferId: string): Promise<CryptoKey> {
  const raw = await fileKeyBytes(typeof fk === "string" ? unb64(fk, 32) : fk, transferId);
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally {
    wipe(raw);
  }
}

export const fileAad4 = {
  meta: (transferId: string): Bytes => join(LABEL.fileMeta, transferId),
  chunk: (transferId: string, seq: number, total: number): Bytes => join(LABEL.fileChunk, transferId, seq, total),
  end: (transferId: string): Bytes => join(LABEL.fileEnd, transferId),
};

/** A meta or end body (its JSON text), padded. Draw: "file.iv". */
export async function sealFileBody4(key: CryptoKey, aad: Uint8Array, text: string, rng: Rng = systemRng): Promise<{ iv: string; ciphertext: string }> {
  const iv = rng.bytes(12, "file.iv");
  const plain = pad(utf8(text));
  try {
    return { iv: b64(iv), ciphertext: b64(await aesGcmSeal(key, iv, aad, plain)) };
  } finally {
    wipe(plain);
  }
}

export async function openFileBody4(key: CryptoKey, aad: Uint8Array, iv: string, ciphertext: string): Promise<string> {
  const plain = await aesGcmOpen(key, unb64(iv, 12), aad, unb64(ciphertext));
  try { return fromUtf8(unpad(plain)); } catch { throw new P4Error("malformed", "file body is not padded text"); } finally { wipe(plain); }
}

/** A chunk (not padded). Draw: "file.iv". */
export async function sealChunk4(key: CryptoKey, aad: Uint8Array, data: Uint8Array, rng: Rng = systemRng): Promise<{ iv: Bytes; ciphertext: Bytes }> {
  const iv = rng.bytes(12, "file.iv");
  return { iv, ciphertext: await aesGcmSeal(key, iv, aad, data) };
}

export async function openChunk4(key: CryptoKey, aad: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Bytes> {
  return aesGcmOpen(key, copy(iv), aad, ciphertext);
}
