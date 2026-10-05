package cz.m5cet.app.p4;

import org.bouncycastle.crypto.SecretWithEncapsulation;
import org.bouncycastle.crypto.kems.MLKEMExtractor;
import org.bouncycastle.crypto.kems.MLKEMGenerator;
import org.bouncycastle.crypto.params.MLKEMParameters;
import org.bouncycastle.crypto.params.MLKEMPrivateKeyParameters;
import org.bouncycastle.crypto.params.MLKEMPublicKeyParameters;

/**
 * ML-KEM-768 (FIPS 203; kem.ts) through Bouncy Castle's lightweight API
 * (org.bouncycastle.crypto.kems / crypto.params — where BC 1.80+ keeps the
 * FIPS 203 final ML-KEM; it left org.bouncycastle.pqc.crypto.mlkem). Sizes
 * are pinned before BC sees an input; key generation from a 64-byte seed
 * (d || z) and encapsulation with a given 32-byte m give exactly what noble's
 * ml_kem768 gives (test/vectors/p4.json "mlkem").
 *
 * Decapsulation never fails on a well-sized ciphertext (implicit rejection:
 * a tampered one yields an unrelated secret); every ciphertext is also bound
 * into an AAD, so tampering shows up as an AEAD failure.
 */
public final class Kem {
    private Kem() {}

    private static final MLKEMParameters P = MLKEMParameters.ml_kem_768;

    /** An ML-KEM-768 key pair: the 1184-byte encapsulation key and the 2400-byte decapsulation key. */
    public static final class KeyPair {
        public final byte[] ek;
        public final byte[] dk;
        KeyPair(byte[] ek, byte[] dk) { this.ek = ek; this.dk = dk; }
    }

    /** One encapsulation: the 1088-byte ciphertext and the 32-byte shared secret. */
    public static final class Encapsulated {
        public final byte[] ct;
        public final byte[] ss;
        Encapsulated(byte[] ct, byte[] ss) { this.ct = ct; this.ss = ss; }
    }

    private static byte[] sized(byte[] value, int length, String what, String code) throws P4Error {
        if (value == null || value.length != length) throw new P4Error(code, what + " must be " + length + " bytes");
        return value;
    }

    /** Key generation from a 64-byte seed (d || z). */
    public static KeyPair keygenFromSeed(byte[] seed) throws P4Error {
        sized(seed, P4.KEM_SEED, "ML-KEM seed", "malformed");
        MLKEMPrivateKeyParameters sk = new MLKEMPrivateKeyParameters(P, seed.clone());
        byte[] ek = sk.getPublicKey();
        byte[] dk = sk.getParametersWithFormat(MLKEMPrivateKeyParameters.EXPANDED_KEY).getEncoded();
        sk.destroy();
        return new KeyPair(ek, dk);
    }

    /** A fresh key pair; the seed is drawn from `rng` (label `what`) and wiped. */
    public static KeyPair keygen(Rng rng, String what) throws P4Error {
        byte[] seed = rng.bytes(P4.KEM_SEED, what);
        try { return keygenFromSeed(seed); } finally { Prim.wipe(seed); }
    }

    /** Encapsulation with an explicit 32-byte message m (vectors, replay). */
    public static Encapsulated encapsWith(byte[] ek, byte[] m) throws P4Error {
        sized(ek, P4.KEM_EK, "ML-KEM encapsulation key", "malformed");
        sized(m, 32, "ML-KEM message", "malformed");
        SecretWithEncapsulation out;
        try {
            out = MLKEMGenerator.internalGenerateEncapsulated(new MLKEMPublicKeyParameters(P, ek), m.clone());
        } catch (RuntimeException e) {
            // FIPS 203 § 7.2 input check (coefficients < q): not a valid key.
            throw P4Error.malformed("invalid ML-KEM encapsulation key");
        }
        return new Encapsulated(out.getEncapsulation(), out.getSecret());
    }

    /** Encapsulation; m is drawn from `rng` (label `what`) and wiped. */
    public static Encapsulated encaps(byte[] ek, Rng rng, String what) throws P4Error {
        byte[] m = rng.bytes(32, what);
        try { return encapsWith(ek, m); } finally { Prim.wipe(m); }
    }

    /** Decapsulation; a ciphertext or key of the wrong size (or a key failing its hash check) is `kct`. */
    public static byte[] decaps(byte[] ct, byte[] dk) throws P4Error {
        sized(ct, P4.KEM_CT, "ML-KEM ciphertext", "kct");
        sized(dk, P4.KEM_DK, "ML-KEM decapsulation key", "kct");
        try {
            return new MLKEMExtractor(new MLKEMPrivateKeyParameters(P, dk)).extractSecret(ct);
        } catch (RuntimeException e) {
            throw new P4Error("kct", "ML-KEM decapsulation failed");
        }
    }

    /** § 5.3 kid: b64url(H(ek))[0:16] — names one of the receiver's KEM keys. */
    public static String kid(byte[] ek) {
        return Prim.b64url(Prim.H(ek)).substring(0, 16);
    }
}
