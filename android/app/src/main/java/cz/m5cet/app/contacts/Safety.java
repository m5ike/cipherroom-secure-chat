package cz.m5cet.app.contacts;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Locale;

/**
 * 6.2 People: what two people compare to rule out an impostor, computed as
 * the web does it (client/src/lib/identity.ts) so a phone and a browser show
 * the same digits: the safety number of both device keys, a key's
 * fingerprint and its id.
 */
public final class Safety {
    private Safety() {}

    /**
     * safetyNumber(): SHA-512 over both public keys (sorted first, so it is the
     * same on both sides), 1024 more rounds, then twelve groups of five digits.
     * "" when a key is missing or not base64.
     */
    public static String number(String a, String b) {
        if (a == null || b == null || a.isEmpty() || b.isEmpty()) return "";
        String first = a.compareTo(b) <= 0 ? a : b, second = first == a ? b : a;
        try {
            byte[] x = decode(first), y = decode(second);
            byte[] data = new byte[x.length + y.length];
            System.arraycopy(x, 0, data, 0, x.length);
            System.arraycopy(y, 0, data, x.length, y.length);
            MessageDigest sha = MessageDigest.getInstance("SHA-512");
            byte[] d = sha.digest(data);
            for (int i = 0; i < 1024; i++) d = sha.digest(d);
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 12; i++) {
                long n = ((long) (d[i * 5] & 0xff) << 24) | ((d[i * 5 + 1] & 0xff) << 16) | ((d[i * 5 + 2] & 0xff) << 8) | (d[i * 5 + 3] & 0xff);
                if (i > 0) out.append(' ');
                out.append(String.format(Locale.ROOT, "%05d", n % 100000));
            }
            return out.toString();
        } catch (IllegalArgumentException | NoSuchAlgorithmException e) {
            return "";
        }
    }

    /** The twelve groups in three lines of four (for reading aloud). */
    public static String lines(String number) {
        String[] g = number == null ? new String[0] : number.trim().split("\\s+");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < g.length; i++) out.append(i == 0 ? "" : i % 4 == 0 ? "\n" : " ").append(g[i]);
        return out.toString();
    }

    /** keyFingerprint(): the first 16 bytes of SHA-256, hex in groups of four ("8537 3E64 …"). */
    public static String fingerprint(String publicKey) {
        byte[] d = sha256(publicKey);
        if (d == null) return "";
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < 16; i++) {
            if (i > 0 && i % 2 == 0) hex.append(' ');
            hex.append(String.format(Locale.ROOT, "%02X", d[i] & 0xff));
        }
        return hex.toString();
    }

    /** keyId(): base64url of SHA-256, 16 characters (what the pins and the verified list keep). */
    public static String keyId(String publicKey) {
        byte[] d = sha256(publicKey);
        return d == null ? "" : Base64.getUrlEncoder().withoutPadding().encodeToString(d).substring(0, 16);
    }

    private static byte[] sha256(String publicKey) {
        if (publicKey == null || publicKey.isEmpty()) return null;
        try { return MessageDigest.getInstance("SHA-256").digest(decode(publicKey)); }
        catch (IllegalArgumentException | NoSuchAlgorithmException e) { return null; }
    }

    /** Standard base64 (padding optional); base64url as a fallback. */
    private static byte[] decode(String s) {
        try { return Base64.getDecoder().decode(s.trim()); }
        catch (IllegalArgumentException e) { return Base64.getUrlDecoder().decode(s.trim().getBytes(StandardCharsets.US_ASCII)); }
    }
}
