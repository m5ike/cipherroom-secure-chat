package cz.m5cet.app.p4;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Files in protocol 4 (docs/protocol-v4.md § 8; files4.ts). Protocol 3 derived
 * every file key from the room key; now the sender picks a random 32-byte FK
 * per transfer and sends it end to end (a pair `file` inner message, or the
 * attachment's `fk`):
 *
 *   fileKey   = HKDF(salt = UTF-8(transferId), ikm = FK, "m5cet/p4/file", 32)
 *   AAD meta  = join("m5cet/p4/file-meta", transferId)
 *   AAD chunk = join("m5cet/p4/chunk", transferId, seq, total)
 *   AAD end   = join("m5cet/p4/file-end", transferId)
 *
 * Meta and end bodies are padded; chunks are not. Frames stay those of
 * protocol 3 ({iv, ciphertext}, a random 12-byte IV).
 */
public final class Files4 {
    private Files4() {}

    /** A fresh FK for one transfer and its `file` inner message. Draw: "file.key". Returns {fk} via inner.key. */
    public static JSONObject newFileKey(String transferId, Rng rng) throws P4Error {
        Prim.join(transferId); // ASCII without "|": it goes into every AAD
        byte[] fk = rng.bytes(32, "file.key");
        try { return new JSONObject().put("t", "file").put("transferId", transferId).put("key", Prim.b64(fk)); }
        catch (JSONException e) { throw new IllegalStateException(e); }
        finally { Prim.wipe(fk); }
    }

    /** § 8: the 32-byte AES-GCM key of one transfer. */
    public static byte[] fileKey(byte[] fk, String transferId) throws P4Error {
        if (fk == null || fk.length != 32) throw P4Error.malformed("FK must be 32 bytes");
        return Prim.hkdf(Prim.utf8(transferId), fk, P4.L_FILE, 32);
    }

    public static byte[] fileKey(String fkB64, String transferId) throws P4Error {
        byte[] fk = Prim.unb64(fkB64, 32);
        try { return fileKey(fk, transferId); } finally { Prim.wipe(fk); }
    }

    public static byte[] metaAad(String transferId) throws P4Error { return Prim.join(P4.L_FILE_META, transferId); }
    public static byte[] chunkAad(String transferId, long seq, long total) throws P4Error { return Prim.join(P4.L_FILE_CHUNK, transferId, seq, total); }
    public static byte[] endAad(String transferId) throws P4Error { return Prim.join(P4.L_FILE_END, transferId); }

    /** A meta or end body (its JSON text), padded → {iv, ciphertext}. Draw: "file.iv". */
    public static JSONObject sealBody(byte[] key, byte[] aad, String text, Rng rng) throws P4Error {
        byte[] iv = rng.bytes(12, "file.iv");
        byte[] plain = Pad.pad(Prim.utf8(text));
        try { return new JSONObject().put("iv", Prim.b64(iv)).put("ciphertext", Prim.b64(Prim.aesGcmSeal(key, iv, aad, plain))); }
        catch (JSONException e) { throw new IllegalStateException(e); }
        finally { Prim.wipe(plain); }
    }

    public static String openBody(byte[] key, byte[] aad, String iv, String ciphertext) throws P4Error {
        byte[] plain = Prim.aesGcmOpen(key, Prim.unb64(iv, 12), aad, Prim.unb64(ciphertext));
        try { return Prim.fromUtf8(Pad.unpad(plain)); }
        catch (P4Error e) { throw P4Error.malformed("file body is not padded text"); }
        finally { Prim.wipe(plain); }
    }

    /** A chunk (not padded) → {iv, ciphertext} bytes. Draw: "file.iv". */
    public static byte[][] sealChunk(byte[] key, byte[] aad, byte[] data, Rng rng) throws P4Error {
        byte[] iv = rng.bytes(12, "file.iv");
        return new byte[][]{iv, Prim.aesGcmSeal(key, iv, aad, data)};
    }

    public static byte[] openChunk(byte[] key, byte[] aad, byte[] iv, byte[] ciphertext) throws P4Error {
        return Prim.aesGcmOpen(key, iv, aad, ciphertext);
    }
}
