package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.util.Base64;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Sealed messages (6.1) as client/src/lib/message-kinds.ts makes them: the
 * text encrypted with a code the recipients get some other way.
 * PBKDF2-SHA256 (600 000 rounds, 16-byte salt) → AES-256-GCM (12-byte IV,
 * no AAD) over the UTF-8 text; flags.sealed = {salt, iv, v: 2, it}.
 * The code: 12 characters from an alphabet without look-alikes, shown as
 * XXXX-XXXX-XXXX; normalised (NFKC, upper case, no spaces or dashes).
 */
public final class Sealed {
    private Sealed() {}

    static final String ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    static final int ROUNDS = 600_000, LEGACY_ROUNDS = 150_000;
    private static final SecureRandom RNG = new SecureRandom();

    /** A new random code, XXXX-XXXX-XXXX (rejection sampling: no modulo bias). */
    public static String newCode() {
        StringBuilder b = new StringBuilder();
        int limit = 256 - 256 % ALPHABET.length();
        while (b.length() < 12) {
            int v = RNG.nextInt(256);
            if (v < limit) b.append(ALPHABET.charAt(v % ALPHABET.length()));
        }
        return b.substring(0, 4) + "-" + b.substring(4, 8) + "-" + b.substring(8, 12);
    }

    public static String normalize(String code) {
        return Normalizer.normalize(code == null ? "" : code, Normalizer.Form.NFKC).toUpperCase(Locale.ROOT).replaceAll("[\\s-]+", "");
    }

    static byte[] key(String code, byte[] salt, int rounds) throws GeneralSecurityException {
        PBEKeySpec spec = new PBEKeySpec(code.toCharArray(), salt, rounds, 256);
        try { return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(); }
        finally { spec.clearPassword(); }
    }

    /** The ciphertext (base64) and the meta for flags.sealed. Slow (PBKDF2): not on the UI thread. */
    public static String[] seal(String text, String code, JSONObject metaOut) throws GeneralSecurityException {
        byte[] salt = new byte[16], iv = new byte[12];
        RNG.nextBytes(salt);
        RNG.nextBytes(iv);
        byte[] k = key(normalize(code), salt, ROUNDS);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, iv));
        byte[] ct = c.doFinal(text.getBytes(StandardCharsets.UTF_8));
        java.util.Arrays.fill(k, (byte) 0);
        try { metaOut.put("salt", b64(salt)).put("iv", b64(iv)).put("v", 2).put("it", ROUNDS); } catch (JSONException e) { throw new GeneralSecurityException(e); }
        return new String[]{b64(ct)};
    }

    /** The text, or null when the code is wrong. Slow (PBKDF2): not on the UI thread. */
    public static String open(String ciphertext, JSONObject meta, String code) {
        try {
            boolean v2 = meta.optInt("v", 1) == 2;
            int rounds = v2 ? (int) meta.optLong("it", ROUNDS) : LEGACY_ROUNDS;
            byte[] k = key(v2 ? normalize(code) : code, unb64(meta.optString("salt")), rounds);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, unb64(meta.optString("iv"))));
            byte[] plain = c.doFinal(unb64(ciphertext));
            java.util.Arrays.fill(k, (byte) 0);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return null;
        }
    }

    static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }
    static byte[] unb64(String s) { return Base64.getDecoder().decode(s.trim()); }
}
