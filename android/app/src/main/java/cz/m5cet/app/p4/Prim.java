package cz.m5cet.app.p4;

import org.bouncycastle.asn1.nist.NISTNamedCurves;
import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.math.ec.ECPoint;
import org.bouncycastle.math.ec.rfc8032.Ed25519;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPrivateKey;
import java.util.Arrays;
import java.util.Base64;
import java.util.regex.Pattern;

import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;

/**
 * Protocol 4 primitives (docs/protocol-v4.md § 0; primitives.ts): the
 * transcript join, SHA-256, HMAC, HKDF, keyIv, strict base64, AES-256-GCM
 * with associated data, P-256 ECDH (32-byte x) and ECDSA (raw r||s), Ed25519
 * (Bouncy Castle, RFC 8032). Transcript parts are validated in one place
 * ({@link #join}): a part with "|" or a non-printable character, or a number
 * that is not a non-negative safe integer, throws — two transcripts can never
 * join to the same bytes.
 */
public final class Prim {
    private Prim() {}

    /** JavaScript's Number.MAX_SAFE_INTEGER. */
    public static final long MAX_SAFE = 9_007_199_254_740_991L;

    /* --------------------------------------------------------------- bytes */

    public static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    /** Strict UTF-8 decoding: an invalid sequence throws, it is never replaced. */
    public static String fromUtf8(byte[] b) throws P4Error {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString();
        } catch (CharacterCodingException e) {
            throw P4Error.malformed("not UTF-8");
        }
    }

    public static byte[] concat(byte[]... parts) { return Crypto.concat(parts); }

    /** Constant-time equality for equal lengths; different lengths are simply unequal. */
    public static boolean ctEqual(byte[] a, byte[] b) {
        if (a == null || b == null || a.length != b.length) return false;
        int diff = 0;
        for (int i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }

    public static void wipe(byte[]... parts) { for (byte[] p : parts) if (p != null) Arrays.fill(p, (byte) 0); }

    public static boolean isSafeCount(Object v) {
        if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) {
            long n = ((Number) v).longValue();
            return n >= 0 && n <= MAX_SAFE;
        }
        if (v instanceof Double || v instanceof Float || v instanceof java.math.BigDecimal) {
            double d = ((Number) v).doubleValue();
            return d >= 0 && d <= MAX_SAFE && d == Math.rint(d);
        }
        if (v instanceof BigInteger) return ((BigInteger) v).signum() >= 0 && ((BigInteger) v).bitLength() < 54;
        return false;
    }

    public static long count(Object v) throws P4Error {
        if (!isSafeCount(v)) throw P4Error.malformed("not a non-negative safe integer");
        return ((Number) v).longValue();
    }

    /* -------------------------------------------------------------- base64 */

    private static final Pattern B64_RE = Pattern.compile("^[A-Za-z0-9+/]*={0,2}$");
    private static final Pattern B64URL_RE = Pattern.compile("^[A-Za-z0-9_-]*$");

    public static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }

    public static String b64url(byte[] b) { return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }

    /** Strict standard base64 (padding required, canonical only); any other input is `malformed`. */
    public static byte[] unb64(Object value) throws P4Error { return unb64(value, -1); }

    public static byte[] unb64(Object value, int length) throws P4Error {
        if (!(value instanceof String)) throw P4Error.malformed("not base64");
        String s = (String) value;
        if (s.length() % 4 != 0 || !B64_RE.matcher(s).matches()) throw P4Error.malformed("not base64");
        byte[] out;
        try { out = Base64.getDecoder().decode(s); } catch (IllegalArgumentException e) { throw P4Error.malformed("not base64"); }
        if (!b64(out).equals(s)) throw P4Error.malformed("non-canonical base64");
        if (length >= 0 && out.length != length) throw P4Error.malformed("expected " + length + " bytes, got " + out.length);
        return out;
    }

    /** Strict base64url without padding (canonical only). */
    public static byte[] unb64url(Object value, int length) throws P4Error {
        if (!(value instanceof String)) throw P4Error.malformed("not base64url");
        String s = (String) value;
        if (!B64URL_RE.matcher(s).matches() || s.length() % 4 == 1) throw P4Error.malformed("not base64url");
        byte[] out;
        try { out = Base64.getUrlDecoder().decode(s); } catch (IllegalArgumentException e) { throw P4Error.malformed("not base64url"); }
        if (!b64url(out).equals(s)) throw P4Error.malformed("non-canonical base64url");
        if (length >= 0 && out.length != length) throw P4Error.malformed("expected " + length + " bytes, got " + out.length);
        return out;
    }

    public static String hex(byte[] b) { return Crypto.hex(b); }

    /* ---------------------------------------------------------------- join */

    /** One transcript part: printable ASCII without "|" (0x7c), or a non-negative safe integer. */
    static String part(Object p) throws P4Error {
        if (p instanceof String) {
            String s = (String) p;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c < 0x20 || c > 0x7e || c == '|') throw P4Error.malformed("transcript part is not ASCII without |");
            }
            return s;
        }
        if (p instanceof Integer || p instanceof Long) {
            long n = ((Number) p).longValue();
            if (n < 0 || n > MAX_SAFE) throw P4Error.malformed("transcript integer out of range");
            return Long.toString(n);
        }
        throw P4Error.malformed("transcript part is not a string or an integer");
    }

    /** § 0: the text of join(a, b, …) — parts joined with "|". */
    public static String joinText(Object... parts) throws P4Error {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) sb.append('|');
            sb.append(part(parts[i]));
        }
        return sb.toString();
    }

    /** § 0: join(a, b, …) — the ASCII bytes of the parts joined with "|". */
    public static byte[] join(Object... parts) throws P4Error { return utf8(joinText(parts)); }

    /* ------------------------------------------------------- hash and KDFs */

    public static byte[] H(byte[] data) { return Crypto.sha256(data); }

    /** b64(H(x)) — the digest form every transcript uses. */
    public static String hB64(byte[] data) { return b64(H(data)); }

    public static byte[] hmac(byte[] key, byte[] data) { return Crypto.hmac256(key, data); }

    /** RFC 5869 HKDF-SHA-256; `info` is the UTF-8 of the label. */
    public static byte[] hkdf(byte[] salt, byte[] ikm, String info, int length) {
        if (length <= 0 || length > 255 * 32) throw new IllegalArgumentException("HKDF length");
        return Crypto.hkdf(ikm, salt, utf8(info), length);
    }

    private static final byte[] ZERO32 = new byte[32];

    /** § 5.1 keyIv: HKDF(salt = 32 zero bytes, ikm = mk, info = label, L = 44) → key [0:32], iv [32:44]. */
    public static byte[][] keyIv(byte[] mk, String label) {
        byte[] okm = hkdf(ZERO32, mk, label, 44);
        byte[][] out = {Arrays.copyOfRange(okm, 0, 32), Arrays.copyOfRange(okm, 32, 44)};
        wipe(okm);
        return out;
    }

    /* ------------------------------------------------------------- AES-GCM */

    /** AES-256-GCM, 12-byte IV, the 16-byte tag appended. */
    public static byte[] aesGcmSeal(byte[] key, byte[] iv, byte[] aad, byte[] plain) throws P4Error {
        if (key == null || key.length != 32) throw P4Error.malformed("AES-256 key must be 32 bytes");
        if (iv == null || iv.length != 12) throw P4Error.malformed("IV must be 12 bytes");
        return Crypto.gcmSeal(key, iv, plain, aad);
    }

    /** Inverse of {@link #aesGcmSeal}; any failure is `aead`. */
    public static byte[] aesGcmOpen(byte[] key, byte[] iv, byte[] aad, byte[] sealed) throws P4Error {
        if (key == null || key.length != 32) throw P4Error.malformed("AES-256 key must be 32 bytes");
        if (iv == null || iv.length != 12 || sealed == null || sealed.length < 16) throw new P4Error("aead", "ciphertext too short");
        try {
            return Crypto.gcmOpen(key, iv, sealed, aad);
        } catch (GeneralSecurityException | RuntimeException e) {
            throw new P4Error("aead", "does not decrypt");
        }
    }

    /* --------------------------------------------------------------- P-256 */

    /** A P-256 key pair; `spki` is the public key as SPKI DER, base64. */
    public static final class P256 {
        public final PrivateKey privateKey;
        public final PublicKey publicKey;
        public final String spki;
        public P256(PrivateKey privateKey, PublicKey publicKey, String spki) { this.privateKey = privateKey; this.publicKey = publicKey; this.spki = spki; }
        /** PKCS#8 (base64) of the private key — for the vault (mailbox bundles); null for a hardware key. */
        public String pkcs8() { byte[] e = privateKey.getEncoded(); return e == null ? null : b64(e); }
    }

    private static final byte[] SPKI_PREFIX = Crypto.unhex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
    private static final X9ECParameters CURVE = NISTNamedCurves.getByName("P-256");

    /** The 91-byte SPKI (uncompressed point) of P-256 public key (x, y) — WebCrypto's export form. */
    static byte[] spkiOf(BigInteger x, BigInteger y) {
        byte[] out = new byte[91];
        System.arraycopy(SPKI_PREFIX, 0, out, 0, SPKI_PREFIX.length);
        out[26] = 0x04;
        put32(out, 27, x);
        put32(out, 59, y);
        return out;
    }

    private static void put32(byte[] out, int at, BigInteger v) {
        byte[] b = v.toByteArray();
        int start = b.length > 32 ? b.length - 32 : 0;
        int n = Math.min(32, b.length);
        System.arraycopy(b, start, out, at + 32 - n, n);
    }

    /**
     * A peer's P-256 public key (SPKI b64): the canonical uncompressed form
     * WebCrypto exports, with a point on the curve. Anything else (another
     * curve, a compressed or off-curve point, stray bytes) is `malformed`.
     */
    public static PublicKey p256Public(Object spki) throws P4Error {
        byte[] der = unb64(spki);
        if (der.length != 91 || !Arrays.equals(Arrays.copyOf(der, 26), SPKI_PREFIX) || der[26] != 0x04) throw P4Error.malformed("not a P-256 public key");
        try {
            ECPoint q = CURVE.getCurve().decodePoint(Arrays.copyOfRange(der, 26, 91));
            if (q.isInfinity() || !q.isValid()) throw P4Error.malformed("not a P-256 public key");
            return Ec.publicFromSpki(der);
        } catch (GeneralSecurityException | RuntimeException e) {
            throw P4Error.malformed("not a P-256 public key");
        }
    }

    /** Is this a P-256 public key (SPKI b64)? */
    public static boolean isP256Spki(Object spki) {
        try { p256Public(spki); return true; } catch (P4Error e) { return false; }
    }

    /** A fresh P-256 key pair (ECDH and ECDSA use the same key type in Java). */
    public static P256 generateP256() {
        KeyPair kp = Ec.generate();
        return new P256(kp.getPrivate(), kp.getPublic(), Ec.spki(kp.getPublic()));
    }

    /** A PKCS#8 (b64) P-256 private key with its public half (d·G), as WebCrypto exports both. */
    public static P256 importP256Pkcs8(String pkcs8) throws P4Error {
        try {
            PrivateKey priv = Ec.privateFromPkcs8(unb64(pkcs8));
            if (!(priv instanceof ECPrivateKey)) throw P4Error.malformed("not a P-256 private key");
            BigInteger d = ((ECPrivateKey) priv).getS();
            ECPoint q = CURVE.getG().multiply(d).normalize();
            String spki = b64(spkiOf(q.getAffineXCoord().toBigInteger(), q.getAffineYCoord().toBigInteger()));
            return new P256(priv, p256Public(spki), spki);
        } catch (GeneralSecurityException e) {
            throw P4Error.malformed("not a P-256 private key");
        }
    }

    /** ECDH: the 32-byte x-coordinate of the shared point. */
    public static byte[] ecdh(PrivateKey mine, Object peerSpki) throws P4Error {
        return ecdh(mine, p256Public(peerSpki));
    }

    public static byte[] ecdh(PrivateKey mine, PublicKey peer) throws P4Error {
        try {
            byte[] out = Ec.ecdh(mine, peer);
            if (out.length != 32) throw P4Error.malformed("ECDH output");
            return out;
        } catch (GeneralSecurityException | RuntimeException e) {
            throw P4Error.malformed("ECDH failed");
        }
    }

    /** ECDSA P-256 / SHA-256, raw r||s (64 bytes), base64. */
    public static String ecdsaSign(PrivateKey key, byte[] data) throws P4Error {
        try { return b64(Ec.sign(key, data)); } catch (GeneralSecurityException | RuntimeException e) { throw new P4Error("state", "cannot sign"); }
    }

    /** Verifies a raw r||s signature with an SPKI (b64) key; never throws. */
    public static boolean ecdsaVerify(Object spki, byte[] data, Object signature) {
        try {
            byte[] sig = unb64(signature, 64);
            return Ec.verify(p256Public(spki), data, sig);
        } catch (P4Error | RuntimeException e) {
            return false;
        }
    }

    /* ------------------------------------------------------------- Ed25519 */

    /** The raw 32-byte Ed25519 public key of a 32-byte seed (RFC 8032). */
    public static byte[] ed25519Public(byte[] seed) throws P4Error {
        if (seed == null || seed.length != 32) throw P4Error.malformed("Ed25519 seed must be 32 bytes");
        byte[] pk = new byte[32];
        Ed25519.generatePublicKey(seed, 0, pk, 0);
        return pk;
    }

    public static byte[] ed25519Sign(byte[] seed, byte[] data) throws P4Error {
        if (seed == null || seed.length != 32) throw P4Error.malformed("Ed25519 seed must be 32 bytes");
        byte[] sig = new byte[64];
        Ed25519.sign(seed, 0, data, 0, data.length, sig, 0);
        return sig;
    }

    /** Verifies an Ed25519 signature; `publicKey` and `signature` are raw bytes or their b64. Never throws. */
    public static boolean ed25519Verify(Object publicKey, byte[] data, Object signature) {
        try {
            byte[] pub = publicKey instanceof byte[] ? (byte[]) publicKey : unb64(publicKey, 32);
            byte[] sig = signature instanceof byte[] ? (byte[]) signature : unb64(signature, 64);
            if (pub.length != 32 || sig.length != 64) return false;
            return Ed25519.verify(sig, 0, pub, 0, data, 0, data.length);
        } catch (P4Error | RuntimeException e) {
            return false;
        }
    }

    /* -------------------------------------------------------------- signer */

    /** What signs for this device: the hello's device key (`publicKey` SPKI b64, raw r||s b64 signatures). */
    public interface DeviceSigner {
        String publicKey();
        String sign(byte[] data) throws P4Error;
    }

    public static DeviceSigner signer(PrivateKey key, String publicKey) {
        return new DeviceSigner() {
            @Override public String publicKey() { return publicKey; }
            @Override public String sign(byte[] data) throws P4Error { return ecdsaSign(key, data); }
        };
    }
}
