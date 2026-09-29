package cz.m5cet.app.account;

import android.app.Activity;
import android.os.CancellationSignal;

import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialException;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Collections;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Vault;

/**
 * The user's M5cet account (6.1): passkey sign-in with the platform's
 * Credential Manager — the same passkeys as in the browser (the server's
 * domain is the relying party; the app is linked to it by
 * /.well-known/assetlinks.json).
 *
 * As on the web (client/src/lib/account.ts): the passkey's PRF output is the
 * account root (or opens it, for a second passkey); the root gives the key
 * proof that unlocks the session. The token and the root are kept in the
 * vault's user tier, so the session survives a restart without a new
 * ceremony (sliding 12 h, at most 7 days on the server).
 *
 * The token authorises the server's APIs for this person (commands, the AI
 * assistant, speech — their groups instead of "guest") and the relay for
 * members who are away.
 */
public final class Account {
    public interface Done { void done(boolean ok, String error); }

    static final byte[] PRF_SALT = Crypto.utf8("m5cet:passkey:prf:v1");
    static final String RECORD = "account";

    private final M5 app;
    private JSONObject state;

    public Account(M5 app) { this.app = app; }

    private synchronized JSONObject state() {
        if (state == null) state = app.vault.unlocked() ? app.vault.json(Vault.Tier.USER, RECORD) : new JSONObject();
        return state;
    }

    private synchronized void save(JSONObject s) {
        state = s;
        if (app.vault.unlocked()) app.vault.putJson(Vault.Tier.USER, RECORD, s);
    }

    /** Forget what was read before the vault opened (after unlock). */
    public synchronized void reload() { state = null; }

    public boolean signedIn() { return !state().optString("token").isEmpty(); }
    public String token() { return state().optString("token"); }
    public String username() { JSONObject a = state().optJSONObject("account"); return a == null ? "" : a.optString("username", a.optString("id")); }
    public JSONObject summary() { JSONObject a = state().optJSONObject("account"); return a == null ? new JSONObject() : a; }

    /** The Authorization header value for the server's APIs ("" without an account). */
    public String bearer() { String t = token(); return t.isEmpty() ? "" : "Bearer " + t; }

    /* -------------------------------------------------------------- http */

    JSONObject call(String method, String path, JSONObject body, boolean auth) throws IOException {
        JSONObject headers = new JSONObject();
        try { if (auth && signedIn()) headers.put("Authorization", bearer()); } catch (JSONException ignored) { }
        byte[] b = Server.send(app.config.server() + path, method, body == null ? null : Crypto.utf8(body.toString()), headers, null, 4 * 1024 * 1024);
        try { return new JSONObject(new String(b, java.nio.charset.StandardCharsets.UTF_8)); }
        catch (JSONException e) { throw new IOException("not a JSON answer"); }
    }

    /* ---------------------------------------------------------- sign in */

    /** Sign in with a passkey (discoverable: the system shows the person's passkeys for this server). */
    public void signIn(Activity activity, Done done) {
        Io.bg(() -> {
            try {
                JSONObject options = call("POST", "/api/account/signin/options", new JSONObject(), false).getJSONObject("publicKey");
                JSONObject request = new JSONObject().put("challenge", options.getString("challenge")).put("rpId", options.getString("rpId"))
                    .put("userVerification", "required").put("timeout", options.optLong("timeout", 60_000))
                    .put("extensions", new JSONObject().put("prf", new JSONObject().put("eval", new JSONObject().put("first", Crypto.b64url(PRF_SALT)))));
                GetCredentialRequest req = new GetCredentialRequest(Collections.singletonList(new GetPublicKeyCredentialOption(request.toString())));
                Io.main(() -> CredentialManager.create(activity).getCredentialAsync(activity, req, new CancellationSignal(), activity.getMainExecutor(),
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override public void onResult(GetCredentialResponse r) {
                            if (!(r.getCredential() instanceof PublicKeyCredential)) { done.done(false, "not a passkey"); return; }
                            String json = ((PublicKeyCredential) r.getCredential()).getAuthenticationResponseJson();
                            Io.bg(() -> finishSignIn(json, done));
                        }
                        @Override public void onError(GetCredentialException e) { Log.w("account", "passkey: " + e.getType() + " " + e.getMessage()); done.done(false, String.valueOf(e.getMessage())); }
                    }));
            } catch (Exception e) {
                Log.w("account", "sign-in failed: " + e.getMessage());
                Io.main(() -> done.done(false, e.getMessage()));
            }
        });
    }

    private void finishSignIn(String responseJson, Done done) {
        String token = null;
        try {
            JSONObject credential = new JSONObject(responseJson);
            byte[] prf = prfOf(credential);
            if (prf == null) throw new IOException("this passkey cannot derive keys (no PRF) — use another passkey or the web app");
            JSONObject answer = call("POST", "/api/account/signin/verify", new JSONObject().put("credential", strip(credential)), false);
            token = answer.getString("token");
            JSONObject wrapped = answer.optJSONObject("wrapped");
            byte[] root = wrapped == null ? prf : openRoot(wrapped, prf, "m5cet:root-wrap:passkey:v1");
            JSONObject s = new JSONObject().put("token", token).put("account", answer.optJSONObject("account")).put("root", Crypto.b64(root)).put("at", System.currentTimeMillis());
            save(s);
            JSONObject unlocked = call("POST", "/api/account/unlock", new JSONObject().put("keyProof", keyProof(root)), true);
            s.put("account", unlocked.optJSONObject("account"));
            save(s);
            Crypto.wipe(prf);
            app.events.add("account-signin", cz.m5cet.app.core.Events.detail("username", username()));
            Log.i("account", "signed in as " + username());
            app.rooms.onAccountChanged();
            Io.main(() -> done.done(true, null));
        } catch (Exception e) {
            Log.w("account", "sign-in failed: " + e.getMessage());
            if (token != null) { final String t = token; Io.bg(() -> { try { signOutWith(t, false); } catch (IOException ignored) { } }); }
            save(new JSONObject());
            Io.main(() -> done.done(false, e.getMessage()));
        }
    }

    /* ---------------------------------------------------------- sign up */

    /** A new account with a new passkey (the server picks the username). */
    public void signUp(Activity activity, Done done) {
        Io.bg(() -> {
            try {
                JSONObject options = call("POST", "/api/account/register/options", new JSONObject(), false).getJSONObject("publicKey");
                options.put("extensions", new JSONObject().put("prf", new JSONObject().put("eval", new JSONObject().put("first", Crypto.b64url(PRF_SALT)))));
                CreatePublicKeyCredentialRequest req = new CreatePublicKeyCredentialRequest(options.toString());
                Io.main(() -> CredentialManager.create(activity).createCredentialAsync(activity, req, new CancellationSignal(), activity.getMainExecutor(),
                    new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                        @Override public void onResult(CreateCredentialResponse r) {
                            if (!(r instanceof CreatePublicKeyCredentialResponse)) { done.done(false, "not a passkey"); return; }
                            String json = ((CreatePublicKeyCredentialResponse) r).getRegistrationResponseJson();
                            Io.bg(() -> finishSignUp(activity, json, done));
                        }
                        @Override public void onError(CreateCredentialException e) { Log.w("account", "passkey: " + e.getType() + " " + e.getMessage()); done.done(false, String.valueOf(e.getMessage())); }
                    }));
            } catch (Exception e) {
                Io.main(() -> done.done(false, e.getMessage()));
            }
        });
    }

    private void finishSignUp(Activity activity, String responseJson, Done done) {
        try {
            JSONObject credential = new JSONObject(responseJson);
            byte[] prf = prfOf(credential);
            if (prf == null) {
                // Some providers give PRF only on an assertion: sign in with the new passkey right away (web: passkey.ts:228).
                Io.main(() -> done.done(false, "this passkey provider gives no PRF when creating — sign in with it now"));
                return;
            }
            JSONObject answer = call("POST", "/api/account/register/verify", new JSONObject().put("credential", strip(credential)).put("keyProof", keyProof(prf)), false);
            JSONObject s = new JSONObject().put("token", answer.getString("token")).put("account", answer.optJSONObject("account")).put("root", Crypto.b64(prf)).put("at", System.currentTimeMillis());
            save(s);
            Crypto.wipe(prf);
            Log.i("account", "account created: " + username());
            app.rooms.onAccountChanged();
            Io.main(() -> done.done(true, null));
        } catch (Exception e) {
            Log.w("account", "sign-up failed: " + e.getMessage());
            Io.main(() -> done.done(false, e.getMessage()));
        }
    }

    /* ------------------------------------------------ restore / sign out */

    /** After the app unlocks: is the session still valid? A locked one is unlocked with the kept root. */
    public void restore() {
        reload();
        if (!signedIn()) return;
        Io.bg(() -> {
            try {
                JSONObject me = call("GET", "/api/account/me", null, true);
                JSONObject s = state();
                if (me.optBoolean("locked")) {
                    byte[] root = Crypto.unb64(s.optString("root"));
                    me = call("POST", "/api/account/unlock", new JSONObject().put("keyProof", keyProof(root)), true);
                    Crypto.wipe(root);
                }
                s.put("account", me.optJSONObject("account"));
                save(s);
                app.rooms.onAccountChanged();
            } catch (Server.HttpError e) {
                if (e.status == 401 || e.status == 403) { Log.i("account", "the session ended (" + e.getMessage() + ")"); save(new JSONObject()); app.rooms.onAccountChanged(); }
            } catch (Exception e) {
                Log.w("account", "restore: " + e.getMessage());
            }
        });
    }

    public void signOut(boolean everywhere, Done done) {
        String t = token();
        save(new JSONObject());
        app.rooms.onAccountChanged();
        Io.bg(() -> {
            try { if (!t.isEmpty()) signOutWith(t, everywhere); } catch (IOException e) { Log.w("account", "sign-out: " + e.getMessage()); }
            Io.main(() -> done.done(true, null));
        });
    }

    private void signOutWith(String token, boolean everywhere) throws IOException {
        JSONObject headers = new JSONObject();
        try { headers.put("Authorization", "Bearer " + token); } catch (JSONException ignored) { }
        Server.send(app.config.server() + "/api/account/signout", "POST", Crypto.utf8("{\"everywhere\":" + everywhere + "}"), headers, null, 64 * 1024);
    }

    /* ------------------------------------------------------------ crypto */

    /** clientExtensionResults.prf.results.first (base64url) of a credential response. */
    static byte[] prfOf(JSONObject credential) {
        JSONObject ext = credential.optJSONObject("clientExtensionResults");
        JSONObject prf = ext == null ? null : ext.optJSONObject("prf");
        JSONObject results = prf == null ? null : prf.optJSONObject("results");
        String first = results == null ? "" : results.optString("first", "");
        if (first.isEmpty()) return null;
        try { return Crypto.unb64url(first.replace("=", "")); } catch (IllegalArgumentException e) { return null; }
    }

    /** What the server reads of a credential (webauthn.ts): id, rawId, type, response. */
    static JSONObject strip(JSONObject c) throws JSONException {
        return new JSONObject().put("id", c.getString("id")).put("rawId", c.optString("rawId", c.getString("id"))).put("type", "public-key").put("response", c.getJSONObject("response"));
    }

    static String keyProof(byte[] root) {
        return Crypto.b64url(Crypto.hkdf(root, PRF_SALT, Crypto.utf8("m5cet:key-proof:v1"), 32));
    }

    /** passkey.ts openRoot: AES-GCM(HKDF(prf, PRF_SALT, info)), AAD "m5cet:account-root:v1". */
    static byte[] openRoot(JSONObject wrapped, byte[] prf, String info) throws java.security.GeneralSecurityException {
        byte[] k = Crypto.hkdf(prf, PRF_SALT, Crypto.utf8(info), 32);
        try { return Crypto.gcmOpen(k, Crypto.unb64(wrapped.optString("iv")), Crypto.unb64(wrapped.optString("ct")), Crypto.utf8("m5cet:account-root:v1")); }
        finally { Crypto.wipe(k); }
    }

    static String joined(org.json.JSONArray list) {
        StringBuilder b = new StringBuilder();
        if (list != null) for (int i = 0; i < list.length(); i++) b.append(i > 0 ? ", " : "").append(list.optString(i));
        return b.toString();
    }

    /** For the settings: the passkey in use (short), sessions, groups. */
    public JSONObject scope() {
        JSONObject a = summary();
        JSONObject o = new JSONObject();
        try {
            String cred = a.optString("credentialId");
            o.put("signedIn", signedIn()).put("username", username()).put("credential", cred.length() > 12 ? cred.substring(0, 12) + "…" : cred)
                .put("passkeys", a.optJSONArray("passkeys") == null ? 0 : a.optJSONArray("passkeys").length())
                .put("sessions", a.optJSONArray("sessions") == null ? 0 : a.optJSONArray("sessions").length())
                .put("groups", joined(a.optJSONArray("groups")))
                .put("since", a.optLong("createdAt")).put("lastLogin", a.optLong("lastLoginAt")).put("keyVerified", a.optBoolean("keyVerified"))
                .put("signedInAt", state().optLong("at"));
        } catch (JSONException ignored) { }
        return o;
    }
}
