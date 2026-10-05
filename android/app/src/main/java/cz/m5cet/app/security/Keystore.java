package cz.m5cet.app.security;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;

import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The keys that never leave the phone's secure hardware (TEE / StrongBox):
 *   m5.sys    AES-256-GCM, no user needed          → wraps the system data key
 *   m5.bio    AES-256-GCM, a biometric per use     → wraps the user data key
 *   m5.pep    HMAC-SHA256 "pepper"                  → part of the PIN key before 6.12 (no offline guessing)
 *   m5.sign   ECDSA P-256                           → signs requests to the server
 *
 * 6.12 (security analysis F-16):
 *   m5.pin    HMAC-SHA256, StrongBox else the TEE, its place CHECKED (KeyInfo):
 *             the PIN key = HMAC(m5.pin, "m5/pin/2|" ‖ PBKDF2(PIN)). Replaces
 *             m5.pep at the next PIN unlock (Vault); never kept when only
 *             software would hold it — the old scheme stays then, and the
 *             security screen says so.
 *   m5.duress HMAC-SHA256 (same places) → the duress PIN's verifier (Duress)
 *   m5.ctr.N  HMAC-SHA256 (the TEE), one generation at a time → seals the
 *             attempt counter; a new generation for every write, the old one
 *             deleted (LockStore): an older copy of the counter's file names a
 *             key that is gone.
 */
public final class Keystore {
    private Keystore() {}

    public static final String SYS = "m5.sys";
    public static final String BIO = "m5.bio";
    public static final String PEPPER = "m5.pep";
    public static final String SIGN = "m5.sign";
    /** 6.12 (F-16): the PIN key in checked secure hardware. */
    public static final String PIN = "m5.pin";
    /** 6.12 (F-16): the duress PIN's verifier. */
    public static final String DURESS = "m5.duress";
    /** 6.12 (F-16): the attempt counter's seal, + the generation. */
    public static final String COUNTER = "m5.ctr.";
    private static final String PROVIDER = "AndroidKeyStore";

    static KeyStore store() throws GeneralSecurityException {
        try {
            KeyStore ks = KeyStore.getInstance(PROVIDER);
            ks.load(null);
            return ks;
        } catch (java.io.IOException e) {
            throw new GeneralSecurityException(e);
        }
    }

    public static boolean has(String alias) {
        try { return store().containsAlias(alias); } catch (GeneralSecurityException e) { return false; }
    }

    public static void delete(String alias) {
        try { store().deleteEntry(alias); } catch (GeneralSecurityException ignored) { }
    }

    /** Tries StrongBox first, then the TEE. */
    private interface Spec { KeyGenParameterSpec build(boolean strongBox); }

    private static SecretKey genSecret(String algorithm, Spec spec) throws GeneralSecurityException {
        KeyGenerator g = KeyGenerator.getInstance(algorithm, PROVIDER);
        if (Build.VERSION.SDK_INT >= 28) {
            try {
                g.init(spec.build(true));
                return g.generateKey();
            } catch (java.security.ProviderException e) {
                // No StrongBox (or it refused the parameters): the TEE.
            }
        }
        g.init(spec.build(false));
        return g.generateKey();
    }

    public static SecretKey sysKey() throws GeneralSecurityException {
        KeyStore ks = store();
        if (ks.containsAlias(SYS)) return (SecretKey) ks.getKey(SYS, null);
        return genSecret(KeyProperties.KEY_ALGORITHM_AES, sb -> new KeyGenParameterSpec.Builder(SYS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setIsStrongBoxBacked(sb).build());
    }

    public static SecretKey pepperKey() throws GeneralSecurityException {
        KeyStore ks = store();
        if (ks.containsAlias(PEPPER)) return (SecretKey) ks.getKey(PEPPER, null);
        return genSecret(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, sb -> new KeyGenParameterSpec.Builder(PEPPER, KeyProperties.PURPOSE_SIGN)
            .setIsStrongBoxBacked(sb).build());
    }

    /** A new biometric key (replacing an old one). */
    public static SecretKey newBioKey() throws GeneralSecurityException {
        delete(BIO);
        return genSecret(KeyProperties.KEY_ALGORITHM_AES, sb -> {
            KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(BIO, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setUserAuthenticationRequired(true).setInvalidatedByBiometricEnrollment(true).setIsStrongBoxBacked(sb);
            if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
            return b.build();
        });
    }

    public static SecretKey bioKey() throws GeneralSecurityException {
        return (SecretKey) store().getKey(BIO, null);
    }

    public static PrivateKey signKey() throws GeneralSecurityException {
        KeyStore ks = store();
        if (!ks.containsAlias(SIGN)) {
            KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER);
            KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(SIGN, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build();
            g.initialize(spec);
            g.generateKeyPair();
        }
        return (PrivateKey) ks.getKey(SIGN, null);
    }

    public static PublicKey signPublicKey() throws GeneralSecurityException {
        signKey();
        return store().getCertificate(SIGN).getPublicKey();
    }

    /** Encrypts with a Keystore AES key (the IV comes from the Keystore). */
    public static byte[] seal(SecretKey key, byte[] plain, byte[] aad) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key);
        c.updateAAD(aad);
        byte[] ct = c.doFinal(plain);
        return Crypto.concat(c.getIV(), ct);
    }

    public static byte[] open(SecretKey key, byte[] sealed, byte[] aad) throws GeneralSecurityException {
        Cipher c = decryptCipher(key, sealed);
        c.updateAAD(aad);
        return c.doFinal(sealed, 12, sealed.length - 12);
    }

    /** A decrypting cipher for a sealed blob (for BiometricPrompt's CryptoObject). */
    public static Cipher decryptCipher(SecretKey key, byte[] sealed) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, sealed, 0, 12));
        return c;
    }

    public static Cipher encryptCipher(SecretKey key) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key);
        return c;
    }

    public static byte[] pepper(byte[] data) throws GeneralSecurityException {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(pepperKey());
        return m.doFinal(data);
    }

    /* ------------------------------------------- 6.12 (F-16): the PIN key */

    /**
     * Where a Keystore key lives: "strongbox", "tee", "software" — or
     * "unknown" when the Keystore does not say. Before Android 12 the
     * Keystore tells only "secure hardware" (reported as "tee").
     */
    static String level(SecretKey key) {
        try {
            SecretKeyFactory f = SecretKeyFactory.getInstance(key.getAlgorithm(), PROVIDER);
            KeyInfo info = (KeyInfo) f.getKeySpec(key, KeyInfo.class);
            if (Build.VERSION.SDK_INT >= 31) {
                int l = info.getSecurityLevel();
                if (l == KeyProperties.SECURITY_LEVEL_STRONGBOX) return "strongbox";
                if (l == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT || l == KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE) return "tee";
                if (l == KeyProperties.SECURITY_LEVEL_SOFTWARE) return "software";
                return "unknown";
            }
            //noinspection deprecation
            return info.isInsideSecureHardware() ? "tee" : "software";
        } catch (GeneralSecurityException | RuntimeException e) {
            return "unknown";
        }
    }

    /** A secure level: StrongBox or the TEE (anything else is not good enough for the PIN key). */
    static boolean secure(String level) { return "strongbox".equals(level) || "tee".equals(level); }

    private static KeyGenParameterSpec hmacSpec(String alias, boolean strongBox) {
        return new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).setIsStrongBoxBacked(strongBox).build();
    }

    /**
     * The PIN key (m5.pin): made when missing — StrongBox first, then the
     * TEE — and its place checked. Returns its level ("strongbox" / "tee"),
     * or null when this phone holds it only in software (the key is then
     * deleted: the PIN keeps the older scheme). Throws when the Keystore
     * failed now (nothing is decided then — the next unlock tries again).
     * Never exportable (no Keystore key is).
     */
    public static String ensurePinKey() throws GeneralSecurityException {
        KeyStore ks;
        try {
            ks = store();
            // An existing key may seal the PIN wrap now: it is never deleted here on a failure.
            if (ks.containsAlias(PIN)) {
                String l = level((SecretKey) ks.getKey(PIN, null));
                return "software".equals(l) ? null : secure(l) ? l : "tee"; // "unknown": it was checked when it was made
            }
        } catch (RuntimeException e) {
            throw new GeneralSecurityException("the Keystore did not answer", e);
        }
        boolean made = false;
        try {
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, PROVIDER);
            boolean strong = false;
            SecretKey k;
            try { g.init(hmacSpec(PIN, true)); k = g.generateKey(); strong = true; }
            catch (java.security.ProviderException | GeneralSecurityException e) { k = null; } // no StrongBox: the TEE
            if (k == null) { g.init(hmacSpec(PIN, false)); k = g.generateKey(); }
            made = true;
            String l = level(k);
            if ("unknown".equals(l)) l = strong ? "strongbox" : "tee";
            if (strong && "tee".equals(l) && Build.VERSION.SDK_INT < 31) l = "strongbox"; // asked for and granted
            if (!secure(l)) { delete(PIN); return null; }
            return l;
        } catch (GeneralSecurityException e) {
            if (made) delete(PIN);
            throw e;
        } catch (RuntimeException e) {
            if (made) delete(PIN);
            throw new GeneralSecurityException("the PIN key could not be made", e);
        }
    }

    /** HMAC-SHA256 by a Keystore key that exists (PIN, DURESS, a counter generation). */
    static byte[] hmacBy(String alias, byte[]... parts) throws GeneralSecurityException {
        SecretKey k = (SecretKey) store().getKey(alias, null);
        if (k == null) throw new GeneralSecurityException("no key " + alias);
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(k);
        for (byte[] p : parts) m.update(p);
        return m.doFinal();
    }

    /** The duress verifier's key (m5.duress): made when missing, StrongBox first; false when it cannot be made. */
    static boolean ensureDuressKey() {
        try {
            KeyStore ks = store();
            if (ks.containsAlias(DURESS)) return true;
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, PROVIDER);
            try { g.init(hmacSpec(DURESS, true)); g.generateKey(); return true; }
            catch (java.security.ProviderException | GeneralSecurityException ignored) { } // no StrongBox: the TEE
            g.init(hmacSpec(DURESS, false));
            g.generateKey();
            return true;
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    /* ------------------------------- 6.12 (F-16): the attempt counter's seal */

    /** The counter key generations that exist; null when the Keystore cannot be read now. */
    static Set<Long> counterGenerations() {
        try {
            Set<Long> out = new HashSet<>();
            for (Enumeration<String> e = store().aliases(); e.hasMoreElements(); ) {
                String a = e.nextElement();
                if (!a.startsWith(COUNTER)) continue;
                try { out.add(Long.parseLong(a.substring(COUNTER.length()))); } catch (NumberFormatException ignored) { }
            }
            return out;
        } catch (GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    /** A new counter key of this generation (the TEE: it is made at every attempt, StrongBox is slow). */
    static boolean newCounterKey(long gen) {
        try {
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, PROVIDER);
            g.init(hmacSpec(COUNTER + gen, false));
            g.generateKey();
            return true;
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    public static void deleteAll() {
        for (String a : new String[]{SYS, BIO, PEPPER, SIGN, PIN, DURESS}) delete(a);
        Set<Long> gens = counterGenerations();
        if (gens != null) for (long g : gens) delete(COUNTER + g);
    }
}
