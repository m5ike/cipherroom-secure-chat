package cz.m5cet.app.account;

import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Locale;

import cz.m5cet.app.security.Crypto;

/**
 * The recovery code, as the web makes it (client/src/lib/recovery.ts): 26
 * characters of Crockford base32 (130 random bits), shown once as
 * XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X. Nothing of it reaches the server; three
 * values are derived from it:
 *
 *   id       HMAC(code, "m5cet:recovery:id")[0..18]  which account (lookup)
 *   proof    HMAC(code, "m5cet:recovery:proof")      the server keeps SHA-256 of it
 *   secret   HMAC(code, "m5cet:recovery:kek")        seals the account root
 *
 * On the web, "Recover the account with a code" opens the root with it and
 * registers a new passkey — the way into an account made on a phone whose
 * passkey provider has no PRF.
 */
public final class RecoveryCode {
    private RecoveryCode() {}

    static final String ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    public static final int CHARS = 26;
    private static final SecureRandom RND = new SecureRandom();

    /** What a code stands for. */
    static final class Material {
        final String id, proof, verifier;
        final byte[] secret;
        Material(String id, String proof, String verifier, byte[] secret) { this.id = id; this.proof = proof; this.verifier = verifier; this.secret = secret; }
    }

    /** A fresh code, grouped for writing down. */
    public static String generate() {
        byte[] b = new byte[CHARS];
        RND.nextBytes(b);
        StringBuilder s = new StringBuilder(CHARS + 5);
        for (int i = 0; i < CHARS; i++) {
            if (i > 0 && i % 5 == 0) s.append('-');
            s.append(ALPHABET.charAt(b[i] & 31));   // 256 is a multiple of 32: unbiased
        }
        Arrays.fill(b, (byte) 0);
        return s.toString();
    }

    /** How a typed code is compared: case, spaces, dashes and look-alikes do not matter; null when it is not a code. */
    public static String normalize(String code) {
        if (code == null) return null;
        String c = code.toUpperCase(Locale.ROOT).replaceAll("[\\s-]+", "").replaceAll("[IL]", "1").replace('O', '0').replace('U', 'V');
        if (c.length() != CHARS) return null;
        for (int i = 0; i < c.length(); i++) if (ALPHABET.indexOf(c.charAt(i)) < 0) return null;
        return c;
    }

    /** The three values of a code; IllegalArgumentException for a malformed one. */
    static Material material(String code) {
        String n = normalize(code);
        if (n == null) throw new IllegalArgumentException("not a recovery code (26 characters)");
        byte[] key = Crypto.utf8("m5cet:recovery:v1:" + n);
        try {
            String id = Crypto.b64url(Arrays.copyOf(Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:id")), 18));
            String proof = Crypto.b64url(Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:proof")));
            String verifier = Crypto.hex(Crypto.sha256(Crypto.utf8(proof)));
            return new Material(id, proof, verifier, Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:kek")));
        } finally {
            Crypto.wipe(key);
        }
    }
}
