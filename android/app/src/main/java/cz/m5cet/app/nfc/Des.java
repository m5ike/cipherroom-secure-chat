package cz.m5cet.app.nfc;

import java.security.GeneralSecurityException;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * DES / 3DES and the ISO 9797-1 retail MAC (6.5) — the Java port of
 * client/src/lib/nfc/cards/des.ts, just enough for e-passport BAC and its
 * secure messaging. Unlike the web (which has no DES in Web Crypto and hand-rolls
 * it), Android has {@code javax.crypto}, so this wraps "DESede/CBC/NoPadding" and
 * single-block DES ("DES/ECB/NoPadding"). Correctness is pinned to the ICAO 9303
 * worked example (BacDesTest), byte-for-byte with the web.
 *
 * {@code SecretKeySpec} does not enforce DES parity, so the ICAO keys (whose
 * parity bits are fixed in {@link Bac}) load without a key-parity exception.
 */
public final class Des {
    private Des() {}

    /** Expand a DES/2-key/3-key key to the 24 bytes DESede needs (8→KKK, 16→K1K2K1, 24→as-is). */
    private static byte[] ede24(byte[] key) {
        if (key.length == 24) return key;
        if (key.length == 16) return Apdu.concat(key, Apdu.slice(key, 0, 8));            // K1 K2 K1
        if (key.length == 8) return Apdu.concat(key, key, key);
        throw new IllegalArgumentException("DES key must be 8, 16 or 24 bytes");
    }

    /** 3DES-EDE-CBC over whole 8-byte blocks, with the given IV. */
    public static byte[] tdesCbcEncrypt(byte[] key, byte[] data, byte[] iv) {
        try {
            Cipher c = Cipher.getInstance("DESede/CBC/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(ede24(key), "DESede"), new IvParameterSpec(iv));
            return c.doFinal(data);
        } catch (GeneralSecurityException e) { throw new RuntimeException(e); }
    }

    public static byte[] tdesCbcEncrypt(byte[] key, byte[] data) { return tdesCbcEncrypt(key, data, new byte[8]); }

    public static byte[] tdesCbcDecrypt(byte[] key, byte[] data, byte[] iv) {
        try {
            Cipher c = Cipher.getInstance("DESede/CBC/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(ede24(key), "DESede"), new IvParameterSpec(iv));
            return c.doFinal(data);
        } catch (GeneralSecurityException e) { throw new RuntimeException(e); }
    }

    public static byte[] tdesCbcDecrypt(byte[] key, byte[] data) { return tdesCbcDecrypt(key, data, new byte[8]); }

    /** One raw DES block (ECB, no padding) with an 8-byte key. */
    private static byte[] desBlock(byte[] key8, byte[] block, boolean encrypt) {
        try {
            Cipher c = Cipher.getInstance("DES/ECB/NoPadding");
            c.init(encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE, new SecretKeySpec(key8, "DES"));
            return c.doFinal(block);
        } catch (GeneralSecurityException e) { throw new RuntimeException(e); }
    }

    /** ISO 9797-1 padding, method 2: append 0x80 then 0x00 up to the next 8-byte block. */
    public static byte[] pad(byte[] data) {
        byte[] out = new byte[data.length + (8 - (data.length % 8))];
        System.arraycopy(data, 0, out, 0, data.length);
        out[data.length] = (byte) 0x80;
        return out;
    }

    /** Drops ISO 9797-1 method-2 padding (the last 0x80 … 0x00). */
    public static byte[] unpad(byte[] data) {
        int i = data.length - 1;
        while (i >= 0 && data[i] == 0x00) i--;
        return i >= 0 && (data[i] & 0xff) == 0x80 ? Apdu.slice(data, 0, i) : data;
    }

    private static byte[] xor8(byte[] a, byte[] b) {
        byte[] out = new byte[8];
        for (int i = 0; i < 8; i++) out[i] = (byte) (a[i] ^ b[i]);
        return out;
    }

    /**
     * ISO 9797-1 MAC algorithm 3 (retail MAC) with DES and a 2-key 3DES final step —
     * the passport's secure-messaging MAC. The data must already be padded:
     * y_i = E(k1, x_i ⊕ y_{i-1}); MAC = E(k1, D(k2, y_n)).
     */
    public static byte[] retailMac(byte[] key, byte[] dataPadded) {
        byte[] k1 = Apdu.slice(key, 0, 8), k2 = Apdu.slice(key, 8, 16);
        byte[] y = new byte[8];
        for (int i = 0; i < dataPadded.length; i += 8) y = desBlock(k1, xor8(Apdu.slice(dataPadded, i, i + 8), y), true);
        return desBlock(k1, desBlock(k2, y, false), true);
    }
}
