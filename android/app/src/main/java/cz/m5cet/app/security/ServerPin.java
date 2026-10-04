package cz.m5cet.app.security;

import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * 6.7 (audit V6 / F-05): the server's key at enrolment is pinned by the key
 * itself, not by the kid string the server sends next to it. A pin — the
 * build's m5.serverKey or the kid of the console's QR code — is a hash of the
 * key's SPKI in one of the forms the console shows:
 *
 *   kid            base64url(SHA-256(SPKI))[0..16]          (QR code, build)
 *   fingerprint    hex of the first 16 bytes, grouped or not ("ABCD EF01 …")
 *   SHA-256        64 hex digits (":" or spaces allowed) or base64(url)
 *
 * The key must be a P-256 SPKI, the kid the server states must be the key's
 * own, and every pin given must match the key. Pure Java (JVM tests).
 */
public final class ServerPin {
    private ServerPin() {}

    /**
     * Checks the key a server presents; returns its kid. Empty pins are
     * skipped (no build pin, no QR code). Throws SecurityException with a
     * message a person can act on.
     */
    public static String check(String publicKeyB64, String statedKid, String... pins) {
        String spki = publicKeyB64 == null ? "" : publicKeyB64.trim();
        if (spki.isEmpty()) throw new SecurityException("the server sent no key — enrolment stopped");
        try {
            Ec.publicFromSpki(spki);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new SecurityException("the server's key is not a valid P-256 key — enrolment stopped");
        }
        String kid = Ec.kid(spki);
        if (statedKid == null || !same(kid, statedKid.trim())) {
            throw new SecurityException("the server's key does not match the key id it states (" + statedKid + " ≠ " + kid + ") — enrolment stopped");
        }
        if (pins != null) for (String pin : pins) {
            if (pin == null || pin.trim().isEmpty()) continue;
            if (!matches(spki, pin)) {
                throw new SecurityException("the server's key " + kid + " (" + Ec.fingerprint(spki) + ") is not the pinned key " + pin.trim()
                    + " — check the server address and the QR code; enrolment stopped");
            }
        }
        return kid;
    }

    /** The key at the end of enrolment is the very key that was checked before it. */
    public static void same(String checkedB64, String answeredB64, String answeredKid) {
        String a = checkedB64 == null ? "" : checkedB64.trim(), b = answeredB64 == null ? "" : answeredB64.trim();
        if (a.isEmpty() || !same(a, b)) throw new SecurityException("the server changed its key during enrolment — enrolment stopped");
        check(b, answeredKid);
    }

    /** True when the pin (kid, fingerprint or SHA-256 in any of its forms) names this key. */
    public static boolean matches(String spkiB64, String pin) {
        if (pin == null) return false;
        byte[] hash;
        try { hash = Crypto.sha256(Crypto.unb64(spkiB64.trim())); }
        catch (IllegalArgumentException e) { return false; }
        String p = pin.trim();
        if (p.length() == 16) return same(Crypto.b64url(hash).substring(0, 16), p);
        String bare = p.replace(":", "").replace(" ", "");
        if (bare.matches("[0-9A-Fa-f]{64}")) return same(Crypto.hex(hash), bare.toLowerCase(Locale.ROOT));
        if (bare.matches("[0-9A-Fa-f]{32}")) return same(Crypto.hex(java.util.Arrays.copyOf(hash, 16)), bare.toLowerCase(Locale.ROOT));
        if (p.length() == 43) return same(Crypto.b64url(hash), p);
        if (p.length() == 44) return same(Crypto.b64(hash), p);
        return false;
    }

    private static boolean same(String a, String b) {
        return MessageDigest.isEqual(Crypto.utf8(a), Crypto.utf8(b));
    }
}
