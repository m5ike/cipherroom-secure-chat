package cz.m5cet.app.security;

import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;

import javax.crypto.KeyAgreement;

/**
 * P-256 keys as the web client and the server use them: public keys travel
 * as SPKI (base64), signatures are ECDSA/SHA-256 in IEEE P1363 form (r‖s,
 * 64 bytes) — WebCrypto's shape — while Java (and Android Keystore) speak
 * DER; this class converts. ECDH gives the raw 32-byte x-coordinate.
 */
public final class Ec {
    private Ec() {}

    public static PublicKey publicFromSpki(byte[] spki) throws GeneralSecurityException {
        PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki));
        if (!(key instanceof ECPublicKey) || ((ECPublicKey) key).getParams().getCurve().getField().getFieldSize() != 256) {
            throw new GeneralSecurityException("not a P-256 key");
        }
        return key;
    }

    public static PublicKey publicFromSpki(String spkiB64) throws GeneralSecurityException {
        return publicFromSpki(Crypto.unb64(spkiB64));
    }

    public static PrivateKey privateFromPkcs8(byte[] pkcs8) throws GeneralSecurityException {
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
    }

    public static KeyPair generate() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
            g.initialize(new ECGenParameterSpec("secp256r1"));
            return g.generateKeyPair();
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    public static String spki(PublicKey key) { return Crypto.b64(key.getEncoded()); }

    /** base64url(SHA-256(SPKI))[0..16] — identity.ts keyId, the server's kid. */
    public static String kid(String spkiB64) { return Crypto.b64url(Crypto.sha256(Crypto.unb64(spkiB64))).substring(0, 16); }

    /** Grouped hex of the first 16 bytes of SHA-256(SPKI), upper case. */
    public static String fingerprint(String spkiB64) {
        String h = Crypto.hex(java.util.Arrays.copyOf(Crypto.sha256(Crypto.unb64(spkiB64)), 16)).toUpperCase(java.util.Locale.ROOT);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < h.length(); i += 4) { if (i > 0) sb.append(' '); sb.append(h, i, i + 4); }
        return sb.toString();
    }

    public static byte[] ecdh(PrivateKey mine, PublicKey theirs) throws GeneralSecurityException {
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(mine);
        ka.doPhase(theirs, true);
        return ka.generateSecret();
    }

    /** Signs (any EC private key, Keystore ones included) and returns P1363. */
    public static byte[] sign(PrivateKey key, byte[] data) throws GeneralSecurityException {
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(key);
        s.update(data);
        return derToP1363(s.sign());
    }

    public static boolean verify(PublicKey key, byte[] data, byte[] p1363) {
        try {
            if (p1363 == null || p1363.length != 64) return false;
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(data);
            return s.verify(p1363ToDer(p1363));
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    public static boolean verify(String spkiB64, byte[] data, String sigB64) {
        try { return verify(publicFromSpki(spkiB64), data, Crypto.unb64(sigB64)); }
        catch (GeneralSecurityException | IllegalArgumentException e) { return false; }
    }

    static byte[] derToP1363(byte[] der) throws GeneralSecurityException {
        // SEQUENCE { INTEGER r, INTEGER s }
        int at = 0;
        if (der[at++] != 0x30) throw new GeneralSecurityException("bad DER signature");
        int len = der[at++] & 0xff;
        if (len > 0x80) at += len - 0x80;
        byte[] out = new byte[64];
        for (int k = 0; k < 2; k++) {
            if (der[at++] != 0x02) throw new GeneralSecurityException("bad DER signature");
            int n = der[at++] & 0xff;
            BigInteger v = new BigInteger(1, java.util.Arrays.copyOfRange(der, at, at + n));
            at += n;
            byte[] b = v.toByteArray();
            int start = b.length > 32 ? b.length - 32 : 0;
            int copy = Math.min(32, b.length);
            System.arraycopy(b, start, out, k * 32 + (32 - copy), copy);
        }
        return out;
    }

    static byte[] p1363ToDer(byte[] sig) {
        byte[] r = integer(java.util.Arrays.copyOfRange(sig, 0, 32));
        byte[] s = integer(java.util.Arrays.copyOfRange(sig, 32, 64));
        int len = r.length + s.length;
        byte[] out = new byte[2 + len];
        out[0] = 0x30;
        out[1] = (byte) len;
        System.arraycopy(r, 0, out, 2, r.length);
        System.arraycopy(s, 0, out, 2 + r.length, s.length);
        return out;
    }

    private static byte[] integer(byte[] unsigned) {
        byte[] v = new BigInteger(1, unsigned).toByteArray(); // minimal, with a leading 0 when the top bit is set
        byte[] out = new byte[2 + v.length];
        out[0] = 0x02;
        out[1] = (byte) v.length;
        System.arraycopy(v, 0, out, 2, v.length);
        return out;
    }
}
