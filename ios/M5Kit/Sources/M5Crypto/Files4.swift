// Files in protocol 4 (docs/protocol-v4.md § 8; files4.ts; android
// p4/Files4.java). The sender picks a random 32-byte FK per transfer and sends
// it end to end (a pair `file` inner message, or the attachment's `fk`):
//
//   fileKey   = HKDF(salt = UTF-8(transferId), ikm = FK, "m5cet/p4/file", 32)
//   AAD meta  = join("m5cet/p4/file-meta", transferId)
//   AAD chunk = join("m5cet/p4/chunk", transferId, seq, total)
//   AAD end   = join("m5cet/p4/file-end", transferId)
//
// Meta and end bodies are padded; chunks are not. Frames stay those of
// protocol 3 ({iv, ciphertext}, a random 12-byte IV).

import M5Core

public enum Files4 {
    /// A fresh FK for one transfer as its `file` inner message {t, transferId, key}. Draw: "file.key".
    public static func newFileKey(_ transferId: String, _ rng: any Rng) throws -> JSONObject {
        _ = try Prim.join(transferId) // ASCII without "|": it goes into every AAD
        let fk = try rng.bytes(32, "file.key")
        return JSONObject([("t", "file"), ("transferId", .string(transferId)), ("key", .string(Prim.b64(fk)))])
    }

    /// § 8: the 32-byte AES-GCM key of one transfer.
    public static func fileKey(_ fk: Bytes, _ transferId: String) throws -> Bytes {
        if fk.count != 32 { throw P4Error.malformed("FK must be 32 bytes") }
        return Prim.hkdf(Prim.utf8(transferId), fk, P4.lFile, 32)
    }

    public static func fileKey(b64 fk: String, _ transferId: String) throws -> Bytes { try fileKey(try Prim.unb64(fk, length: 32), transferId) }

    public static func metaAad(_ transferId: String) throws -> Bytes { try Prim.join(P4.lFileMeta, transferId) }
    public static func chunkAad(_ transferId: String, _ seq: Int64, _ total: Int64) throws -> Bytes { try Prim.join(P4.lFileChunk, transferId, seq, total) }
    public static func endAad(_ transferId: String) throws -> Bytes { try Prim.join(P4.lFileEnd, transferId) }

    /// A meta or end body (its JSON text), padded → {iv, ciphertext}. Draw: "file.iv".
    public static func sealBody(_ key: Bytes, _ aad: Bytes, _ text: String, _ rng: any Rng) throws -> JSONObject {
        let iv = try rng.bytes(12, "file.iv")
        let c = try Prim.aesGcmSeal(key, iv, aad, Pad.pad(Prim.utf8(text)))
        return JSONObject([("iv", .string(Prim.b64(iv))), ("ciphertext", .string(Prim.b64(c)))])
    }

    public static func openBody(_ key: Bytes, _ aad: Bytes, iv: String, ciphertext: String) throws -> String {
        let plain = try Prim.aesGcmOpen(key, try Prim.unb64(iv, length: 12), aad, try Prim.unb64(ciphertext))
        do { return try Prim.fromUtf8(try Pad.unpad(plain)) } catch { throw P4Error.malformed("file body is not padded text") }
    }

    /// A chunk (not padded) → (iv, ciphertext). Draw: "file.iv".
    public static func sealChunk(_ key: Bytes, _ aad: Bytes, _ data: Bytes, _ rng: any Rng) throws -> (iv: Bytes, ciphertext: Bytes) {
        let iv = try rng.bytes(12, "file.iv")
        return (iv, try Prim.aesGcmSeal(key, iv, aad, data))
    }

    public static func openChunk(_ key: Bytes, _ aad: Bytes, iv: Bytes, ciphertext: Bytes) throws -> Bytes {
        try Prim.aesGcmOpen(key, iv, aad, ciphertext)
    }
}
