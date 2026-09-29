package cz.m5cet.app.security;

import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PrivateKey;

/**
 * ECIES from the server to this device (docs/android-architecture.md §1.3):
 * an ephemeral P-256 key, ECDH with the device's encryption key, HKDF-SHA256
 * (salt "m5cet/android/ecies/1", info purpose|deviceId), AES-256-GCM with
 * "m5cet/android/ecies/1|purpose|deviceId" as associated data.
 */
public final class Ecies {
    private Ecies() {}

    public static final String LABEL = "m5cet/android/ecies/1";

    public static final class Wire {
        public final String e, iv, ct;
        public Wire(String e, String iv, String ct) { this.e = e; this.iv = iv; this.ct = ct; }
    }

    private static byte[] key(byte[] shared, String purpose, String deviceId) {
        return Crypto.hkdf(shared, Crypto.utf8(LABEL), Crypto.utf8(purpose + "|" + deviceId), 32);
    }

    public static byte[] open(PrivateKey device, String deviceId, String purpose, Wire w) throws GeneralSecurityException {
        byte[] shared = Ec.ecdh(device, Ec.publicFromSpki(w.e));
        byte[] k = key(shared, purpose, deviceId);
        Crypto.wipe(shared);
        try {
            return Crypto.gcmOpen(k, Crypto.unb64(w.iv), Crypto.unb64(w.ct), Crypto.utf8(LABEL + "|" + purpose + "|" + deviceId));
        } finally {
            Crypto.wipe(k);
        }
    }

    /** The server's side; the app uses it only in tests and for its own sealed notes. */
    public static Wire seal(String deviceEncSpki, String deviceId, String purpose, byte[] plain) throws GeneralSecurityException {
        KeyPair eph = Ec.generate();
        byte[] shared = Ec.ecdh(eph.getPrivate(), Ec.publicFromSpki(deviceEncSpki));
        byte[] k = key(shared, purpose, deviceId);
        Crypto.wipe(shared);
        byte[] iv = Crypto.random(12);
        byte[] ct = Crypto.gcmSeal(k, iv, plain, Crypto.utf8(LABEL + "|" + purpose + "|" + deviceId));
        Crypto.wipe(k);
        return new Wire(Ec.spki(eph.getPublic()), Crypto.b64(iv), Crypto.b64(ct));
    }
}
