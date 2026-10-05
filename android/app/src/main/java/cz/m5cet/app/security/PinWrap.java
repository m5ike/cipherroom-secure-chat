package cz.m5cet.app.security;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;

/**
 * 6.12 (security analysis F-16): the PIN wrap "user.pin" — the user tier's
 * data key sealed by the key the PIN gives (Vault):
 *
 *   v 1  {salt, iter, iv, ct}            KEK = HMAC(m5.pep, PBKDF2(PIN)), AAD "m5/user.pin"
 *   v 2  {v: 2, salt, iter, iv, ct, hw}  KEK = HMAC(m5.pin, "m5/pin/2|" ‖ PBKDF2(PIN)), AAD "m5/user.pin/2"
 *
 * The KEK itself is the Keystore's (Kek); the format, the versions' AAD and
 * the move from v 1 to v 2 (same salt and iterations, so the PBKDF2 output
 * of the unlock that opened v 1 seals v 2) are pure: PinWrapTest.
 */
final class PinWrap {
    private PinWrap() {}

    /** The KEK from the stretched PIN, for the wrap's version. */
    interface Kek { byte[] of(byte[] stretched, int version) throws GeneralSecurityException; }

    static int version(JSONObject o) { return o.optInt("v", 1); }

    static byte[] aad(int version) { return Crypto.utf8(version >= 2 ? "m5/user.pin/2" : "m5/user.pin"); }

    /** A wrap of the data key (v 2 carries the PIN key's place, hw). */
    static JSONObject seal(byte[] dek, byte[] stretched, byte[] salt, int iterations, int version, String hw, Kek kek) throws GeneralSecurityException {
        byte[] k = kek.of(stretched, version);
        byte[] iv = Crypto.random(12);
        byte[] ct;
        try { ct = Crypto.gcmSeal(k, iv, dek, aad(version)); } finally { Crypto.wipe(k); }
        try {
            JSONObject o = new JSONObject().put("salt", Crypto.b64(salt)).put("iter", iterations).put("iv", Crypto.b64(iv)).put("ct", Crypto.b64(ct));
            if (version >= 2) o.put("v", version).put("hw", hw == null ? "tee" : hw);
            return o;
        } catch (JSONException e) {
            throw new GeneralSecurityException(e);
        }
    }

    /** The data key, or null when this stretched PIN is not the one (a wrong PIN). */
    static byte[] open(JSONObject o, byte[] stretched, Kek kek) throws GeneralSecurityException {
        int version = version(o);
        byte[] k = kek.of(stretched, version);
        try {
            return Crypto.gcmOpen(k, Crypto.unb64(o.optString("iv")), Crypto.unb64(o.optString("ct")), aad(version));
        } catch (javax.crypto.AEADBadTagException bad) {
            return null;
        } catch (IllegalArgumentException bad) {
            throw new GeneralSecurityException("the PIN wrap is damaged", bad);
        } finally {
            Crypto.wipe(k);
        }
    }

    static byte[] salt(JSONObject o) throws GeneralSecurityException {
        try { return Crypto.unb64(o.getString("salt")); }
        catch (JSONException | IllegalArgumentException e) { throw new GeneralSecurityException("the PIN wrap is damaged", e); }
    }

    static int iterations(JSONObject o) throws GeneralSecurityException {
        int it = o.optInt("iter", 0);
        if (it < 1) throw new GeneralSecurityException("the PIN wrap is damaged");
        return it;
    }

    /**
     * The v 1 wrap moved to v 2 after an unlock with it: the same data key,
     * salt and iterations (the PBKDF2 output of that unlock), sealed by the
     * v 2 KEK.
     */
    static JSONObject moved(JSONObject v1, byte[] dek, byte[] stretched, String hw, Kek kek) throws GeneralSecurityException {
        return seal(dek, stretched, salt(v1), iterations(v1), 2, hw, kek);
    }
}
