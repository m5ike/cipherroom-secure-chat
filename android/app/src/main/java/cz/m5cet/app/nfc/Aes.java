package cz.m5cet.app.nfc;

import java.security.GeneralSecurityException;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * AES blocks, AES-CBC without padding and AES-CMAC (6.6) — the Java port of
 * client/src/lib/nfc/cards/aes.ts, for PACE and its secure messaging. The web
 * hand-rolls AES (Web Crypto's AES-CBC always pads and is async); Android has
 * {@code javax.crypto}, so the block operations wrap "AES/ECB/NoPadding" and
 * "AES/CBC/NoPadding", and only CMAC (RFC 4493 / NIST SP 800-38B) is written
 * here. Keys are 16, 24 or 32 bytes. Pinned to the FIPS-197, SP 800-38A and
 * RFC 4493 vectors (PaceTest).
 */
public final class Aes {
    private Aes() {}

    private static SecretKeySpec key(byte[] key) {
        if (key.length != 16 && key.length != 24 && key.length != 32) throw new IllegalArgumentException("AES key must be 16, 24 or 32 bytes");
        return new SecretKeySpec(key, "AES");
    }

    private static Cipher ecb(byte[] k, int mode) {
        try {
            Cipher c = Cipher.getInstance("AES/ECB/NoPadding");
            c.init(mode, key(k));
            return c;
        } catch (GeneralSecurityException e) { throw new RuntimeException(e); }
    }

    private static byte[] cbc(byte[] k, byte[] data, byte[] iv, int mode) {
        if (data.length % 16 != 0) throw new IllegalArgumentException("AES-CBC data must be a whole number of 16-byte blocks");
        if (iv.length != 16) throw new IllegalArgumentException("AES IV must be 16 bytes");
        if (data.length == 0) return new byte[0];
        try {
            Cipher c = Cipher.getInstance("AES/CBC/NoPadding");
            c.init(mode, key(k), new IvParameterSpec(iv));
            return c.doFinal(data);
        } catch (GeneralSecurityException e) { throw new RuntimeException(e); }
    }

    /** One block, AES-ECB. */
    public static byte[] encryptBlock(byte[] key, byte[] block) {
        if (block.length != 16) throw new IllegalArgumentException("AES block must be 16 bytes");
        try { return ecb(key, Cipher.ENCRYPT_MODE).doFinal(block); }
        catch (GeneralSecurityException e) { throw new RuntimeException(e); }
    }

    public static byte[] decryptBlock(byte[] key, byte[] block) {
        if (block.length != 16) throw new IllegalArgumentException("AES block must be 16 bytes");
        try { return ecb(key, Cipher.DECRYPT_MODE).doFinal(block); }
        catch (GeneralSecurityException e) { throw new RuntimeException(e); }
    }

    /** AES-CBC over whole blocks, no padding. */
    public static byte[] cbcEncrypt(byte[] key, byte[] data, byte[] iv) { return cbc(key, data, iv, Cipher.ENCRYPT_MODE); }

    public static byte[] cbcEncrypt(byte[] key, byte[] data) { return cbcEncrypt(key, data, new byte[16]); }

    public static byte[] cbcDecrypt(byte[] key, byte[] data, byte[] iv) { return cbc(key, data, iv, Cipher.DECRYPT_MODE); }

    /** AES-CBC decryption with a zero IV (the PACE nonce). */
    public static byte[] cbcDecrypt(byte[] key, byte[] data) { return cbcDecrypt(key, data, new byte[16]); }

    /** Doubling in GF(2^128) — the CMAC subkey step. */
    private static byte[] dbl(byte[] b) {
        byte[] out = new byte[16];
        for (int i = 0; i < 16; i++) out[i] = (byte) (((b[i] & 0xff) << 1) | (i < 15 ? (b[i + 1] & 0xff) >>> 7 : 0));
        if ((b[0] & 0x80) != 0) out[15] ^= (byte) 0x87;
        return out;
    }

    /** AES-CMAC (RFC 4493): the full 16-byte tag (PACE and its secure messaging use the first 8). */
    public static byte[] cmac(byte[] key, byte[] data) {
        try {
            Cipher e = ecb(key, Cipher.ENCRYPT_MODE);
            byte[] k1 = dbl(e.doFinal(new byte[16]));
            byte[] k2 = dbl(k1);
            int n = Math.max(1, (data.length + 15) / 16);
            boolean complete = data.length > 0 && data.length % 16 == 0;
            // The last block: XOR K1 when complete, else 10* padding and XOR K2.
            byte[] last = new byte[16];
            int tail = data.length - (n - 1) * 16;
            System.arraycopy(data, (n - 1) * 16, last, 0, tail);
            if (!complete) last[tail] = (byte) 0x80;
            byte[] sub = complete ? k1 : k2;
            for (int j = 0; j < 16; j++) last[j] ^= sub[j];
            byte[] x = new byte[16];
            for (int i = 0; i < n - 1; i++) {
                for (int j = 0; j < 16; j++) x[j] ^= data[i * 16 + j];
                x = e.doFinal(x);
            }
            for (int j = 0; j < 16; j++) x[j] ^= last[j];
            return e.doFinal(x);
        } catch (GeneralSecurityException ex) { throw new RuntimeException(ex); }
    }
}
