package cz.m5cet.app.chat;

import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PrivateKey;

import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;

/**
 * This device's chat identity (client/src/lib/identity.ts): an ECDSA P-256
 * key that signs message bodies and hellos, and an ECDH P-256 key for the
 * pairwise keys. Both private keys are kept in the user vault (encrypted);
 * the public keys travel as SPKI base64.
 */
public final class ChatIdentity {
    public final String publicKey;
    public final String dhPublicKey;
    public final String kid;
    public final String fingerprint;
    private final PrivateKey signKey;
    private final PrivateKey dhKey;

    public ChatIdentity(PrivateKey signKey, String publicKey, PrivateKey dhKey, String dhPublicKey) {
        this.signKey = signKey;
        this.publicKey = publicKey;
        this.dhKey = dhKey;
        this.dhPublicKey = dhPublicKey;
        this.kid = Ec.kid(publicKey);
        this.fingerprint = Ec.fingerprint(publicKey);
    }

    public static ChatIdentity generate() {
        KeyPair s = Ec.generate();
        KeyPair d = Ec.generate();
        return new ChatIdentity(s.getPrivate(), Ec.spki(s.getPublic()), d.getPrivate(), Ec.spki(d.getPublic()));
    }

    public static ChatIdentity fromPkcs8(String signPkcs8, String publicKey, String dhPkcs8, String dhPublicKey) throws GeneralSecurityException {
        return new ChatIdentity(Ec.privateFromPkcs8(Crypto.unb64(signPkcs8)), publicKey, Ec.privateFromPkcs8(Crypto.unb64(dhPkcs8)), dhPublicKey);
    }

    public String signPkcs8() { return Crypto.b64(signKey.getEncoded()); }
    public String dhPkcs8() { return Crypto.b64(dhKey.getEncoded()); }

    /** P1363 signature, base64 (WebCrypto's form). */
    public String sign(byte[] data) {
        try { return Crypto.b64(Ec.sign(signKey, data)); }
        catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    public byte[] sharedSecret(String peerDhPublicKey) throws GeneralSecurityException {
        return Ec.ecdh(dhKey, Ec.publicFromSpki(peerDhPublicKey));
    }

    /** identity.ts safetyNumber: 12 groups of 5 digits from both keys. */
    public static String safetyNumber(String a, String b) {
        String first = a.compareTo(b) <= 0 ? a : b;
        String second = a.compareTo(b) <= 0 ? b : a;
        byte[] digest = Crypto.sha512(Crypto.concat(Crypto.unb64(first), Crypto.unb64(second)));
        for (int i = 0; i < 1024; i++) digest = Crypto.sha512(digest);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 12; i++) {
            long n = ((digest[i * 5] & 0xffL) << 24) | ((digest[i * 5 + 1] & 0xffL) << 16) | ((digest[i * 5 + 2] & 0xffL) << 8) | (digest[i * 5 + 3] & 0xffL);
            if (i > 0) sb.append(' ');
            sb.append(String.format(java.util.Locale.ROOT, "%05d", n % 100000));
        }
        return sb.toString();
    }
}
