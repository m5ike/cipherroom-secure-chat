package cz.m5cet.app.security;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The symmetric primitives, exactly as WebCrypto and node:crypto do them:
 * AES-256-GCM (12-byte IV, 16-byte tag appended), HKDF-SHA256, HMAC-SHA256,
 * PBKDF2-HMAC-SHA256 over the password's UTF-8 bytes, SHA-256/512.
 * Pure Java (no Android API), so the JVM tests run the same code.
 */
public final class Crypto {
    private Crypto() {}

    private static final SecureRandom RNG = new SecureRandom();
    private static final byte[] EMPTY = new byte[0];

    public static byte[] random(int n) {
        byte[] b = new byte[n];
        RNG.nextBytes(b);
        return b;
    }

    public static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }
    public static String str(byte[] b) { return new String(b, StandardCharsets.UTF_8); }

    public static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }
    public static byte[] unb64(String s) { return Base64.getDecoder().decode(s); }
    public static String b64url(byte[] b) { return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }
    public static byte[] unb64url(String s) { return Base64.getUrlDecoder().decode(s); }

    public static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return sb.toString();
    }

    public static byte[] unhex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    public static byte[] sha256(byte[]... parts) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (byte[] p : parts) md.update(p);
            return md.digest();
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    public static byte[] sha512(byte[] data) {
        try { return MessageDigest.getInstance("SHA-512").digest(data); }
        catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    public static Mac hmac(byte[] key) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            // HMAC pads the key with zeros to the block size, so an empty key
            // is the same as one zero byte (SecretKeySpec refuses empty keys).
            mac.init(new SecretKeySpec(key.length == 0 ? new byte[1] : key, "HmacSHA256"));
            return mac;
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    public static byte[] hmac256(byte[] key, byte[] data) {
        return hmac(key).doFinal(data);
    }

    /** RFC 5869. An empty salt is HashLen zeros (as WebCrypto). */
    public static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info, int length) {
        byte[] prk = hmac(salt == null || salt.length == 0 ? new byte[32] : salt).doFinal(ikm);
        Mac mac = hmac(prk);
        byte[] out = new byte[length];
        byte[] t = EMPTY;
        int at = 0;
        for (int i = 1; at < length; i++) {
            mac.update(t);
            mac.update(info == null ? EMPTY : info);
            mac.update((byte) i);
            t = mac.doFinal();
            int n = Math.min(t.length, length - at);
            System.arraycopy(t, 0, out, at, n);
            at += n;
        }
        Arrays.fill(prk, (byte) 0);
        return out;
    }

    /** PBKDF2-HMAC-SHA256 over the raw password bytes (WebCrypto's importKey("raw", utf8(password))). */
    public static byte[] pbkdf2(byte[] password, byte[] salt, int iterations, int bytes) {
        Mac mac = hmac(password);
        byte[] out = new byte[bytes];
        int blocks = (bytes + 31) / 32;
        for (int b = 1; b <= blocks; b++) {
            mac.update(salt);
            mac.update(new byte[]{(byte) (b >>> 24), (byte) (b >>> 16), (byte) (b >>> 8), (byte) b});
            byte[] u = mac.doFinal();
            byte[] t = u.clone();
            for (int i = 1; i < iterations; i++) {
                u = mac.doFinal(u);
                for (int j = 0; j < t.length; j++) t[j] ^= u[j];
            }
            System.arraycopy(t, 0, out, (b - 1) * 32, Math.min(32, bytes - (b - 1) * 32));
        }
        return out;
    }

    /** AES-256-GCM: ciphertext ‖ 16-byte tag. */
    public static byte[] gcmSeal(byte[] key, byte[] iv, byte[] plain, byte[] aad) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            if (aad != null && aad.length > 0) c.updateAAD(aad);
            return c.doFinal(plain);
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    public static byte[] gcmOpen(byte[] key, byte[] iv, byte[] ctAndTag, byte[] aad) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        if (aad != null && aad.length > 0) c.updateAAD(aad);
        return c.doFinal(ctAndTag);
    }

    public static boolean same(byte[] a, byte[] b) { return MessageDigest.isEqual(a, b); }

    public static void wipe(byte[] b) { if (b != null) Arrays.fill(b, (byte) 0); }

    public static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int at = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, at, p.length); at += p.length; }
        return out;
    }
}
