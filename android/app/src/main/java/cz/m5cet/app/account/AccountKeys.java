package cz.m5cet.app.account;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;

import cz.m5cet.app.security.Crypto;

/**
 * The account's key material, exactly as the web does it
 * (client/src/lib/passkey.ts), and the WebAuthn JSON around it. Pure Java,
 * so the JVM tests check it against the web's vectors.
 *
 *   root        the first passkey's PRF output — or, for an account made on
 *               a phone whose passkey provider has no PRF, 32 random bytes
 *               kept on that phone (DeviceRoots)
 *   key proof   HKDF(root, PRF_SALT, "m5cet:key-proof:v1"): the server keeps
 *               only its hash and checks it at every sign-in
 *   sealed root AES-GCM(HKDF(secret, PRF_SALT, info), root), AAD
 *               "m5cet:account-root:v1" — for a passkey added later (secret =
 *               its PRF output) or the recovery code (secret = its kek)
 *   vault key   HKDF(root, PRF_SALT, "m5cet:profile:v1"): the vault's parts
 *               (profile, registration…), base64(iv ‖ AES-GCM(JSON)) — 6.4
 */
final class AccountKeys {
    private AccountKeys() {}

    static final byte[] PRF_SALT = Crypto.utf8("m5cet:passkey:prf:v1");
    static final String WRAP_PASSKEY = "m5cet:root-wrap:passkey:v1";
    static final String WRAP_RECOVERY = "m5cet:root-wrap:recovery:v1";
    private static final byte[] WRAP_AAD = Crypto.utf8("m5cet:account-root:v1");
    private static final byte[] PROOF_INFO = Crypto.utf8("m5cet:key-proof:v1");

    /** The key proof (base64url, 43 characters) the server checks at sign-in. */
    static String keyProof(byte[] root) {
        byte[] p = Crypto.hkdf(root, PRF_SALT, PROOF_INFO, 32);
        try { return Crypto.b64url(p); } finally { Crypto.wipe(p); }
    }

    /** Seals the root under a key from secret (web: sealRoot). */
    static JSONObject sealRoot(byte[] root, byte[] secret, String info) { return sealRoot(root, secret, info, Crypto.random(12)); }

    static JSONObject sealRoot(byte[] root, byte[] secret, String info, byte[] iv) {
        byte[] k = Crypto.hkdf(secret, PRF_SALT, Crypto.utf8(info), 32);
        try { return new JSONObject().put("iv", Crypto.b64(iv)).put("ct", Crypto.b64(Crypto.gcmSeal(k, iv, root, WRAP_AAD))); }
        catch (JSONException e) { throw new IllegalStateException(e); }
        finally { Crypto.wipe(k); }
    }

    /** Opens a sealed root (web: openRoot). */
    static byte[] openRoot(JSONObject wrapped, byte[] secret, String info) throws GeneralSecurityException {
        byte[] k = Crypto.hkdf(secret, PRF_SALT, Crypto.utf8(info), 32);
        try { return Crypto.gcmOpen(k, Crypto.unb64(wrapped.optString("iv")), Crypto.unb64(wrapped.optString("ct")), WRAP_AAD); }
        catch (IllegalArgumentException e) { throw new GeneralSecurityException("the sealed account key is malformed"); }
        finally { Crypto.wipe(k); }
    }

    /* ------------------------------------------------------------- vault */

    private static final byte[] PROFILE_INFO = Crypto.utf8("m5cet:profile:v1");

    /** 6.4: the vault key (web: deriveAccountKeys → key) — HKDF(root, PRF_SALT, "m5cet:profile:v1"), AES-256-GCM. */
    static byte[] profileKey(byte[] root) { return Crypto.hkdf(root, PRF_SALT, PROFILE_INFO, 32); }

    /** Seals a vault part (web: sealProfile): base64(iv ‖ AES-GCM(JSON)), no AAD. */
    static String sealProfile(JSONObject value, byte[] key) { return sealProfile(value, key, Crypto.random(12)); }

    static String sealProfile(JSONObject value, byte[] key, byte[] iv) {
        return Crypto.b64(Crypto.concat(iv, Crypto.gcmSeal(key, iv, Crypto.utf8(value.toString()), null)));
    }

    /** Opens a vault part (web: openProfile); a JSON object, or an error — never a guess. */
    static JSONObject openProfile(String ciphertext, byte[] key) throws GeneralSecurityException {
        byte[] all;
        try { all = Crypto.unb64(ciphertext); } catch (IllegalArgumentException e) { throw new GeneralSecurityException("the vault is malformed"); }
        if (all.length < 12 + 16) throw new GeneralSecurityException("the vault is too short");
        byte[] plain = Crypto.gcmOpen(key, java.util.Arrays.copyOfRange(all, 0, 12), java.util.Arrays.copyOfRange(all, 12, all.length), null);
        try { return new JSONObject(Crypto.str(plain)); }
        catch (JSONException e) { throw new GeneralSecurityException("the vault's profile is not a JSON object"); }
        finally { Crypto.wipe(plain); }
    }

    /** Does the server's answer carry a root sealed for this passkey? */
    static boolean sealed(JSONObject wrapped) {
        return wrapped != null && !wrapped.optString("iv").isEmpty() && !wrapped.optString("ct").isEmpty();
    }

    /* ---------------------------------------------------------- webauthn */

    /** clientExtensionResults.prf.results.first (base64url) of a credential response; null without one. */
    static byte[] prfOf(JSONObject credential) {
        JSONObject ext = credential == null ? null : credential.optJSONObject("clientExtensionResults");
        JSONObject prf = ext == null ? null : ext.optJSONObject("prf");
        JSONObject results = prf == null ? null : prf.optJSONObject("results");
        String first = results == null ? "" : results.optString("first", "");
        if (first.isEmpty()) return null;
        try {
            byte[] b = Crypto.unb64url(first.replace("=", ""));
            return b.length == 0 ? null : b;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** What the server reads of a credential (webauthn.ts): id, rawId, type, response. */
    static JSONObject strip(JSONObject c) throws JSONException {
        return new JSONObject().put("id", c.getString("id")).put("rawId", c.optString("rawId", c.getString("id"))).put("type", "public-key").put("response", c.getJSONObject("response"));
    }

    /** The credential's id (base64url). */
    static String credentialId(JSONObject c) {
        return c == null ? "" : c.optString("rawId", c.optString("id", "")).replace("=", "");
    }

    /** Asks for the PRF output with PRF_SALT (merged into the options' extensions). */
    static JSONObject withPrf(JSONObject options) throws JSONException {
        JSONObject ext = options.optJSONObject("extensions");
        if (ext == null) ext = new JSONObject();
        ext.put("prf", new JSONObject().put("eval", new JSONObject().put("first", Crypto.b64url(PRF_SALT))));
        return options.put("extensions", ext);
    }

    /**
     * A PRF-only assertion with a credential just created (web: prfSecretFor):
     * a local challenge (no server ceremony), only that credential allowed.
     */
    static JSONObject prfRequest(String rpId, JSONObject registration, byte[] challenge) throws JSONException {
        JSONObject allow = new JSONObject().put("type", "public-key").put("id", credentialId(registration));
        JSONObject response = registration.optJSONObject("response");
        JSONArray transports = response == null ? null : response.optJSONArray("transports");
        if (transports != null && transports.length() > 0) allow.put("transports", transports);
        JSONObject request = new JSONObject().put("challenge", Crypto.b64url(challenge)).put("rpId", rpId)
            .put("allowCredentials", new JSONArray().put(allow)).put("userVerification", "required").put("timeout", 60_000);
        return withPrf(request);
    }

    /** The account's passkeys (base64url ids) from its summary: every one listed, else the first one. */
    static JSONArray credentialIds(JSONObject summary) {
        JSONArray ids = new JSONArray();
        JSONArray list = summary == null ? null : summary.optJSONArray("passkeys");
        if (list != null) for (int i = 0; i < list.length(); i++) {
            JSONObject p = list.optJSONObject(i);
            String id = p == null ? "" : p.optString("credentialId").replace("=", "");
            if (!id.isEmpty()) ids.put(id);
        }
        String first = summary == null ? "" : summary.optString("credentialId").replace("=", "");
        if (ids.length() == 0 && !first.isEmpty()) ids.put(first);
        return ids;
    }

    static boolean contains(JSONArray ids, String id) {
        if (id == null || id.isEmpty()) return false;
        for (int i = 0; i < ids.length(); i++) if (id.equals(ids.optString(i))) return true;
        return false;
    }

    /** "Confirm with your passkey" (web: confirmWithPasskey): any of the account's passkeys, a local challenge, no PRF needed. */
    static JSONObject confirmRequest(String rpId, JSONArray ids, byte[] challenge) throws JSONException {
        JSONArray allow = new JSONArray();
        for (int i = 0; i < ids.length(); i++) allow.put(new JSONObject().put("type", "public-key").put("id", ids.getString(i)));
        JSONObject request = new JSONObject().put("challenge", Crypto.b64url(challenge)).put("rpId", rpId).put("userVerification", "required").put("timeout", 60_000);
        if (allow.length() > 0) request.put("allowCredentials", allow);
        return request;
    }

    /** The username in an assertion's user handle (the server puts it there since 4.0), or "". */
    static String handleName(JSONObject assertion) {
        JSONObject r = assertion == null ? null : assertion.optJSONObject("response");
        String h = r == null ? "" : r.optString("userHandle", "");
        if (h.isEmpty() || "null".equals(h)) return "";
        try {
            String name = Crypto.str(Crypto.unb64url(h.replace("=", "")));
            return name.matches("[\\p{L}\\p{N}._-]{1,40}") ? name : "";
        } catch (IllegalArgumentException e) {
            return "";
        }
    }
}
