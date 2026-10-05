package cz.m5cet.app.security;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;

/**
 * 6.12 (security analysis F-16): the duress PIN — off by default
 * (Settings › Security, "security.duress"). Typed on the lock screen, it
 * erases the app the way the attempts' wipe does (Wiper.wipe, reason
 * "duress") and the app starts again empty — the enrolment screen, no "data
 * erased" notice. The server hears of it as a wipe with that reason.
 *
 * Only a verifier is kept (the system tier, readable on the lock screen):
 * HMAC(Keystore m5.duress, "m5/duress/1|" ‖ PBKDF2-SHA256(PIN, salt, 210 000))
 * — the same work as the unlock PIN, so typing it takes as long, and guessing
 * it needs this phone's Keystore. It must differ from the unlock PIN (set
 * with the current PIN, like a PIN change); a new unlock PIN may not be it.
 */
public final class Duress {
    private Duress() {}

    public static final String SETTING = "security.duress";
    static final String RECORD = "duress";

    /** The verifier's HMAC (the Keystore's m5.duress; a fixed key in the tests). */
    interface Mac { byte[] mac(byte[] data) throws GeneralSecurityException; }

    /**
     * Why a new duress PIN is refused: null (fine), "length" (not exactly the
     * policy's length — the lock pad takes a PIN of that length) or "same"
     * (it is the unlock PIN).
     */
    public static String refusal(String pin, int length, boolean isUnlockPin) {
        if (pin == null || pin.length() != length || !pin.matches("[0-9]+")) return "length";
        return isUnlockPin ? "same" : null;
    }

    /** The record {salt, iter, tag} for this PIN. */
    static JSONObject verifier(String pin, byte[] salt, int iterations, Mac mac) throws GeneralSecurityException {
        byte[] stretched = Crypto.pbkdf2(Crypto.utf8(pin), salt, iterations, 32);
        try {
            byte[] tag = mac.mac(Crypto.concat(Crypto.utf8("m5/duress/1|"), stretched));
            return new JSONObject().put("salt", Crypto.b64(salt)).put("iter", iterations).put("tag", Crypto.b64(tag));
        } catch (JSONException e) {
            throw new GeneralSecurityException(e);
        } finally {
            Crypto.wipe(stretched);
        }
    }

    /** Whether the PIN is the one of this verifier (constant time; false on anything odd). */
    static boolean matches(JSONObject v, String pin, Mac mac) {
        if (v == null || pin == null || !v.has("tag") || !v.has("salt")) return false;
        byte[] stretched = null;
        try {
            int iterations = v.optInt("iter", 0);
            if (iterations < 1000 || iterations > 10_000_000) return false;
            stretched = Crypto.pbkdf2(Crypto.utf8(pin), Crypto.unb64(v.getString("salt")), iterations, 32);
            byte[] tag = mac.mac(Crypto.concat(Crypto.utf8("m5/duress/1|"), stretched));
            return Crypto.same(tag, Crypto.unb64(v.getString("tag")));
        } catch (GeneralSecurityException | JSONException | IllegalArgumentException e) {
            return false;
        } finally {
            Crypto.wipe(stretched);
        }
    }

    /* ------------------------------------------------------------ the app */

    private static final Mac KEYSTORE = data -> Keystore.hmacBy(Keystore.DURESS, data);

    /** Switched on and set. */
    public static boolean active(M5 app) {
        return app.settings.bool(SETTING) && app.vault.json(Vault.Tier.SYS, RECORD).has("tag");
    }

    /** Sets (or replaces) the duress PIN; the caller checked it with refusal(). */
    public static void set(M5 app, String pin) throws GeneralSecurityException {
        if (!Keystore.ensureDuressKey()) throw new GeneralSecurityException("no Keystore key for the duress PIN");
        JSONObject v = verifier(pin, Crypto.random(16), Vault.PIN_ITERATIONS, KEYSTORE);
        app.vault.put(Vault.Tier.SYS, RECORD, Crypto.utf8(v.toString()));
        Log.i("lock", "a duress PIN was set");
    }

    /** Whether this PIN is the duress PIN (switched on and set). */
    public static boolean check(M5 app, String pin) {
        if (!app.settings.bool(SETTING)) return false;
        JSONObject v = app.vault.json(Vault.Tier.SYS, RECORD);
        return v.has("tag") && matches(v, pin, KEYSTORE);
    }

    /** Whether a PIN may not become the unlock PIN (it is the duress PIN). */
    public static boolean isDuressPin(M5 app, String pin) {
        JSONObject v = app.vault.json(Vault.Tier.SYS, RECORD);
        return v.has("tag") && matches(v, pin, KEYSTORE);
    }

    /** The switch shows what is real: on without a verifier (its dialog never finished) goes off. */
    public static void reconcile(M5 app) {
        if (app.settings.bool(SETTING) && !app.vault.json(Vault.Tier.SYS, RECORD).has("tag")) app.settings.set(SETTING, false);
    }

    /** Off: the verifier and its key go. */
    public static void clear(M5 app) {
        app.vault.delete(Vault.Tier.SYS, RECORD);
        Keystore.delete(Keystore.DURESS);
    }
}
