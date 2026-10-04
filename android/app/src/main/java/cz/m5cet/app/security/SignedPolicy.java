package cz.m5cet.app.security;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 6.7 (security analysis F-16): the device policy — lock (PIN length,
 * attempts, wipe, auto-lock, screenshots), logs, location, updates — is
 * applied only as the server signed it for this device:
 *
 *   policySigned = { at, policy: "<JSON text>", sig }
 *   sig          = ECDSA P-256 (P1363) by the pinned server key over
 *                  "m5policy/1|<deviceId>|<at>|<JSON text>"
 *
 * and never older than the policy the app already has (a replayed one).
 * TLS alone (a proxy, a mis-issued certificate) can no longer switch
 * FLAG_SECURE off or the wipe off. server/android/crypto.ts policySignedString.
 * Pure (JVM tests).
 */
public final class SignedPolicy {
    private SignedPolicy() {}

    public static String signedString(String deviceId, long at, String policyJson) {
        return "m5policy/1|" + deviceId + "|" + at + "|" + policyJson;
    }

    /**
     * The policy, when the wire holds a valid signature of serverKey for this
     * device and is not older than lastAt; null otherwise.
     */
    public static JSONObject open(JSONObject wire, String serverKey, String deviceId, long lastAt) {
        if (wire == null || serverKey == null || serverKey.isEmpty() || deviceId == null || deviceId.isEmpty()) return null;
        Object atRaw = wire.opt("at");
        if (!(atRaw instanceof Number)) return null;
        long at = ((Number) atRaw).longValue();
        String json = wire.optString("policy", "");
        String sig = wire.optString("sig", "");
        if (json.isEmpty() || sig.isEmpty() || at < lastAt) return null;
        if (!Ec.verify(serverKey, Crypto.utf8(signedString(deviceId, at, json)), sig)) return null;
        try { return new JSONObject(json); } catch (JSONException e) { return null; }
    }
}
