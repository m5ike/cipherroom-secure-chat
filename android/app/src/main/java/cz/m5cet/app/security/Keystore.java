package cz.m5cet.app.security;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The keys that never leave the phone's secure hardware (TEE / StrongBox):
 *   m5.sys    AES-256-GCM, no user needed          → wraps the system data key
 *   m5.bio    AES-256-GCM, a biometric per use     → wraps the user data key
 *   m5.pep    HMAC-SHA256 "pepper"                  → part of the PIN key (no offline guessing)
 *   m5.sign   ECDSA P-256                           → signs requests to the server
 */
public final class Keystore {
    private Keystore() {}

    public static final String SYS = "m5.sys";
    public static final String BIO = "m5.bio";
    public static final String PEPPER = "m5.pep";
    public static final String SIGN = "m5.sign";
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

    public static void deleteAll() {
        for (String a : new String[]{SYS, BIO, PEPPER, SIGN}) delete(a);
    }
}
