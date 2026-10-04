package cz.m5cet.app.core;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PrivateKey;

import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;
import cz.m5cet.app.security.Keystore;
import cz.m5cet.app.security.Vault;

/**
 * What the app knows about its server and itself (system tier, record
 * "config"): the server's address and pinned key, this device's id and its
 * encryption key, the policy, the Firebase settings, UI choices. Read and
 * written as one encrypted JSON document.
 */
public final class Config {
    private final Vault vault;
    private JSONObject data;

    public Config(Vault vault) { this.vault = vault; }

    public synchronized JSONObject data() {
        if (data == null) data = vault.json(Vault.Tier.SYS, "config");
        return data;
    }

    public synchronized void save() { vault.putJson(Vault.Tier.SYS, "config", data()); }

    private void put(String key, Object value) {
        try { data().put(key, value == null ? JSONObject.NULL : value); } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public synchronized String server() { return data().optString("server", ""); }
    public synchronized String deviceId() { return data().optString("deviceId", ""); }
    public synchronized boolean enrolled() { return !deviceId().isEmpty() && !serverKey().isEmpty(); }
    public synchronized String serverKey() { return data().optString("serverKey", ""); }
    public synchronized String serverKid() { return data().optString("serverKid", ""); }
    public synchronized String serverFingerprint() { return data().optString("serverFingerprint", ""); }

    public synchronized JSONObject policy() {
        JSONObject p = data().optJSONObject("policy");
        return p != null ? p : new JSONObject();
    }

    public synchronized JSONObject lockPolicy() {
        JSONObject l = policy().optJSONObject("lock");
        return l != null ? l : new JSONObject();
    }

    public synchronized JSONObject fcm() { return data().optJSONObject("fcm"); }
    public synchronized int pollSeconds() { return Math.max(900, data().optInt("pollSeconds", 1800)); }

    public synchronized String lang() { return data().optString("lang", ""); }
    public synchronized void setLang(String lang) { put("lang", lang); save(); }
    /** "light", "dark" or "" (the system's). */
    public synchronized String tone() { return data().optString("tone", ""); }
    public synchronized void setTone(String tone) { put("tone", tone); save(); }
    public synchronized String userName() { return data().optString("userName", ""); }
    public synchronized void setUserName(String name) { put("userName", name); save(); }

    public synchronized JSONObject usersPanel() {
        JSONObject u = data().optJSONObject("usersPanel");
        if (u == null) {
            u = new JSONObject();
            try { u.put("dock", "right").put("autoHide", false).put("open", false).put("x", -1).put("y", -1); } catch (JSONException ignored) { }
            put("usersPanel", u);
        }
        return u;
    }
    public synchronized void saveUsersPanel(JSONObject u) { put("usersPanel", u); save(); }

    public synchronized void enrolled(String server, JSONObject answer) throws JSONException {
        JSONObject s = answer.getJSONObject("server");
        // 6.7 (audit V6): never trust a key whose kid is not its own (SecurityException stops enrolment).
        cz.m5cet.app.security.ServerPin.check(s.optString("publicKey"), s.optString("kid"));
        put("server", server);
        put("deviceId", answer.getString("deviceId"));
        put("serverKey", s.getString("publicKey"));
        put("serverKid", s.getString("kid"));
        put("serverFingerprint", Ec.fingerprint(s.getString("publicKey"))); // computed here, not taken from the server
        applyServerAnswer(answer);
        save();
    }

    /** Policy, poll interval and Firebase settings from an enrolment or a check-in. */
    public synchronized void applyServerAnswer(JSONObject answer) {
        JSONObject policy = answer.optJSONObject("policy");
        if (policy != null) put("policy", policy);
        if (answer.has("pollSeconds")) put("pollSeconds", answer.optInt("pollSeconds", 1800));
        if (answer.has("fcm")) put("fcm", answer.optJSONObject("fcm"));
    }

    /* ------------------------------------------------------ device keys */

    /** This device's encryption key pair (software P-256; the private half only in the system tier). */
    public synchronized String encPublicKey() throws GeneralSecurityException {
        ensureEncKey();
        return data().optString("encPublic");
    }

    public synchronized PrivateKey encPrivateKey() throws GeneralSecurityException {
        ensureEncKey();
        return Ec.privateFromPkcs8(Crypto.unb64(data().optString("encPrivate")));
    }

    private void ensureEncKey() {
        if (!data().optString("encPrivate").isEmpty()) return;
        KeyPair kp = Ec.generate();
        put("encPrivate", Crypto.b64(kp.getPrivate().getEncoded()));
        put("encPublic", Ec.spki(kp.getPublic()));
        save();
    }

    public static String signPublicKey() throws GeneralSecurityException {
        return Ec.spki(Keystore.signPublicKey());
    }

    /** Forgets the server (a new enrolment); keeps nothing of the old one. */
    public synchronized void reset() {
        data = new JSONObject();
        save();
    }
}
