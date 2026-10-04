package cz.m5cet.app.account;

import android.app.Activity;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.function.Consumer;

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
 * 6.2: a provider that withholds PRF when creating gets a PRF-only assertion
 * right away (as the web does); one with no PRF at all (Samsung Pass) gets a
 * device-bound account — a random root kept in DeviceRoots, usable elsewhere
 * after a recovery code or a PRF passkey is added from here. Once a passkey
 * exists, the server is always asked to register it, or the person is told
 * exactly which passkey to delete.
 *
 * The token authorises the server's APIs for this person (commands, the AI
 * assistant, speech — their groups instead of "guest") and the relay for
 * members who are away.
 */
public final class Account {
    public interface Done { void done(boolean ok, String error); }

    /** How a ceremony ended: code tells the UI which answer it gets (AccountDialogs). */
    public static final class Result {
        public final boolean ok;
        /** "", cancelled, no-passkey, unsupported, unknown-passkey, no-prf, wrong-key, orphan; 6.4: rp-unverified, taken. */
        public final String code;
        public final String message;
        /** The account's root lives only on this phone. */
        public final boolean deviceBound;
        /** The account's username — or the stale passkey's, for unknown-passkey. */
        public final String username;
        /** 6.4: the server's per-field errors (taken: someone registered that e-mail / phone meanwhile); empty otherwise. */
        public final JSONObject errors;

        Result(boolean ok, String code, String message, boolean deviceBound, String username) { this(ok, code, message, deviceBound, username, null); }

        Result(boolean ok, String code, String message, boolean deviceBound, String username, JSONObject errors) {
            this.ok = ok; this.code = code == null ? "" : code; this.message = message == null ? "" : message; this.deviceBound = deviceBound; this.username = username == null ? "" : username;
            this.errors = errors == null ? new JSONObject() : errors;
        }
        static Result success(boolean deviceBound, String username) { return new Result(true, "", "", deviceBound, username); }
        static Result failure(String code, String message, String username) { return new Result(false, code, message, false, username); }
    }

    public interface Outcome { void done(Result r); }

    /**
     * 6.4: how the creation of an account goes, step by step (the
     * registration's list): "passkey" (the ceremony), "keys" (the root and
     * its key proof), "register" (the server takes the passkey) — each
     * "run", then "ok" or "fail". On the main thread.
     */
    public interface Steps { void step(String id, String state); }

    private static void step(Steps steps, String id, String state) { if (steps != null) Io.main(() -> steps.step(id, state)); }

    /** The recovery code (shown once), or why there is none. */
    public interface CodeDone { void done(String code, Result failure); }

    static final String RECORD = "account";

    private final M5 app;
    private JSONObject state;
    private DeviceRoots roots;

    public Account(M5 app) { this.app = app; }

    private synchronized DeviceRoots roots() {
        if (roots == null) roots = new DeviceRoots(app.vault);
        return roots;
    }

    private synchronized JSONObject state() {
        if (state != null) return state;
        // Read only once the vault is open: an empty state read while locked must not stick.
        if (!app.vault.unlocked()) return new JSONObject();
        state = app.vault.json(Vault.Tier.USER, RECORD);
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
    /** The account's root is kept only on this phone (its passkey has no PRF). */
    public boolean deviceBound() { return state().optBoolean("deviceBound"); }

    /** The Authorization header value for the server's APIs ("" without an account). */
    public String bearer() { String t = token(); return t.isEmpty() ? "" : "Bearer " + t; }

    private String t(String key) { return app.t(key); }

    /* -------------------------------------------------------------- http */

    JSONObject call(String method, String path, JSONObject body, boolean auth) throws IOException {
        JSONObject headers = new JSONObject();
        try {
            if (auth && signedIn()) headers.put("Authorization", bearer());
            // 6.4.1: which certificate signed this build — the server refuses a passkey ceremony it
            // would not accept before the passkey exists (403 app-not-trusted), instead of after.
            String cert = AppCert.sha256(app);
            if (!cert.isEmpty()) headers.put("X-M5-App-Cert", cert);
        } catch (JSONException ignored) { }
        byte[] b = Server.send(app.config.server() + path, method, body == null ? null : Crypto.utf8(body.toString()), headers, null, 4 * 1024 * 1024);
        try { return new JSONObject(new String(b, java.nio.charset.StandardCharsets.UTF_8)); }
        catch (JSONException e) { throw new IOException("not a JSON answer"); }
    }

    /** What a call that must get through ended with. */
    private static final class Sent {
        JSONObject answer;
        IOException error;
        /** A try failed on the network: the server may have acted on it although no answer came. */
        boolean unsure;
        /** The server itself said no, and nothing before may have reached it. */
        boolean refused() { return answer == null && error instanceof Server.HttpError && !unsure; }
    }

    /** A call that must get through: network failures are tried again twice (a refusal by the server is not). */
    private Sent send(String method, String path, JSONObject body, boolean auth) {
        Sent s = new Sent();
        for (int attempt = 0; attempt < 3; attempt++) {
            try { s.answer = call(method, path, body, auth); s.error = null; return s; }
            catch (Server.HttpError e) { s.error = e; return s; }
            catch (IOException e) {
                s.error = e;
                s.unsure = true;
                if (attempt == 2) break;
                Log.w("account", path + ": " + e.getMessage() + " — trying again");
                try { Thread.sleep(1500L * (attempt + 1)); } catch (InterruptedException x) { Thread.currentThread().interrupt(); break; }
            }
        }
        return s;
    }

    private static void report(Outcome done, Result r) { Io.main(() -> done.done(r)); }

    /** 6.4.1: "app-not-trusted" — refused before any passkey existed, this build's certificate unknown to the server — reads as rp-unverified. */
    static String refusalCode(String serverCode) { return "app-not-trusted".equals(serverCode) ? "rp-unverified" : ""; }

    static String codeOf(Exception e) { return e instanceof Server.HttpError ? refusalCode(((Server.HttpError) e).code) : ""; }

    private static String accountId(JSONObject account, String fallback) {
        if (account == null) return fallback;
        String id = account.optString("id", account.optString("username", ""));
        return id.isEmpty() ? fallback : id;
    }

    /* ---------------------------------------------------------- sign in */

    /** Sign in with a passkey (discoverable: the system shows the person's passkeys for this server). */
    public void signIn(Activity activity, Outcome done) {
        Io.bg(() -> {
            try {
                JSONObject options = call("POST", "/api/account/signin/options", new JSONObject(), false).getJSONObject("publicKey");
                JSONObject request = AccountKeys.withPrf(new JSONObject().put("challenge", options.getString("challenge")).put("rpId", options.getString("rpId"))
                    .put("userVerification", "required").put("timeout", options.optLong("timeout", 60_000)));
                String rpId = options.getString("rpId");
                Io.main(() -> Passkeys.get(activity, request, new Passkeys.Result() {
                    @Override public void ok(JSONObject credential) { Io.bg(() -> finishSignIn(credential, rpId, done)); }
                    @Override public void failed(String code, String message) { done.done(Result.failure(code, message, "")); }
                }));
            } catch (Exception e) {
                Log.w("account", "sign-in failed: " + e.getMessage());
                report(done, Result.failure(codeOf(e), e.getMessage(), ""));
            }
        });
    }

    private void finishSignIn(JSONObject credential, String rpId, Outcome done) {
        String server = app.config.server();
        byte[] prf = AccountKeys.prfOf(credential);
        byte[] root = null;
        String token = null, id = "";
        DeviceRoots.Entry kept = null;
        try {
            JSONObject answer;
            try {
                answer = call("POST", "/api/account/signin/verify", new JSONObject().put("credential", AccountKeys.strip(credential)), false);
            } catch (Server.HttpError e) {
                if (e.status != 404 && !"unknown-passkey".equals(e.code)) throw e;
                // Left over from a sign-up the server never finished: a root kept for it is of no use.
                String stale = AccountKeys.handleName(credential);
                DeviceRoots.Entry pending = roots().get(server, stale);
                if (pending != null) { if (!pending.confirmed) roots().remove(server, stale); Crypto.wipe(pending.root); }
                report(done, Result.failure("unknown-passkey", e.getMessage(), stale));
                return;
            }
            token = answer.getString("token");
            JSONObject account = answer.optJSONObject("account");
            id = accountId(account, AccountKeys.handleName(credential));
            kept = roots().get(server, id);
            JSONObject wrapped = answer.optJSONObject("wrapped");
            // The root: kept here for a device-bound account; else sealed for this passkey
            // (added later), else this passkey's PRF output; a pending device root last.
            boolean bound = false;
            if (kept != null && kept.confirmed) { root = kept.root.clone(); bound = true; }
            else if (prf != null && AccountKeys.sealed(wrapped)) root = AccountKeys.openRoot(wrapped, prf, AccountKeys.WRAP_PASSKEY);
            else if (prf != null) root = prf.clone();
            else if (kept != null) { root = kept.root.clone(); bound = true; }
            else throw new Failure("no-prf", t("passkey.noPrf").replace("{user}", id));
            JSONObject s = new JSONObject().put("token", token).put("account", account).put("root", Crypto.b64(root)).put("at", System.currentTimeMillis())
                .put("deviceBound", bound).put("rpId", rpId);
            save(s);
            JSONObject unlocked;
            try {
                unlocked = call("POST", "/api/account/unlock", new JSONObject().put("keyProof", AccountKeys.keyProof(root)), true);
            } catch (Server.HttpError e) {
                if (e.status != 403) throw e;
                if (bound && !kept.confirmed) roots().remove(server, id);
                throw new Failure("wrong-key", t(bound ? "passkey.wrongKeyDevice" : "passkey.wrongKey").replace("{user}", id));
            }
            s.put("account", unlocked.optJSONObject("account"));
            save(s);
            if (bound && !kept.confirmed) roots().confirm(server, id, id);
            app.events.add("account-signin", cz.m5cet.app.core.Events.detail("username", username(), "deviceBound", bound));
            Log.i("account", "signed in as " + username() + (bound ? " (device-bound)" : ""));
            app.rooms.onAccountChanged();
            report(done, Result.success(bound, username()));
        } catch (Exception e) {
            Log.w("account", "sign-in failed: " + e.getMessage());
            if (token != null) { final String tk = token; Io.bg(() -> { try { signOutWith(tk, false); } catch (IOException ignored) { } }); }
            save(new JSONObject());
            report(done, e instanceof Failure ? Result.failure(((Failure) e).code, e.getMessage(), id) : Result.failure("", e.getMessage(), id));
        } finally {
            Crypto.wipe(prf);
            Crypto.wipe(root);
            if (kept != null) Crypto.wipe(kept.root);
        }
    }

    /** A failure the UI answers in its own way (see Result.code). */
    static final class Failure extends Exception {
        final String code;
        Failure(String code, String message) { super(message); this.code = code; }
    }

    /* ---------------------------------------------------------- sign up */

    /** A new account with a new passkey (the server picks the username). */
    public void signUp(Activity activity, Outcome done) {
        Io.bg(() -> {
            try {
                JSONObject answer = call("POST", "/api/account/register/options", new JSONObject(), false);
                create(activity, answer.getJSONObject("publicKey"), answer.optString("username", ""), null, done);
            } catch (Exception e) {
                Log.w("account", "sign-up failed: " + e.getMessage());
                report(done, Result.failure(codeOf(e), e.getMessage(), ""));
            }
        });
    }

    /**
     * 6.4 registration: the passkey for the account /register/start put
     * aside (its creation options and username) — the same ceremony, PRF,
     * root, key proof and /register/verify as signUp; steps hears each one.
     */
    public void register(Activity activity, JSONObject publicKey, String username, Steps steps, Outcome done) {
        try {
            create(activity, publicKey, username, steps, done);
        } catch (Exception e) {
            Log.w("account", "registration failed: " + e.getMessage());
            report(done, Result.failure(codeOf(e), e.getMessage(), username));
        }
    }

    /**
     * A new passkey from the server's creation options (with the PRF
     * extension asked for), its root, then /register/verify — shared by
     * "Create an account" and the registration (6.4). Any thread; the
     * ceremony runs on the main one.
     */
    private void create(Activity activity, JSONObject publicKey, String username, Steps steps, Outcome done) throws JSONException {
        JSONObject options = AccountKeys.withPrf(publicKey);
        String rpId = options.getJSONObject("rp").getString("id");
        JSONObject user = options.optJSONObject("user");
        String name = username == null || username.isEmpty() ? (user == null ? "" : user.optString("name")) : username;
        // What the password manager lists the passkey as (6.4.1: a registration's passkey name) — to find it there.
        String label = user == null ? name : user.optString("name", name);
        step(steps, "passkey", "run");
        Io.main(() -> Passkeys.create(activity, options, new Passkeys.Result() {
            @Override public void ok(JSONObject registration) {
                // From here on a passkey exists on the phone: the server must hear of it.
                step(steps, "passkey", "ok");
                step(steps, "keys", "run");
                rootFor(activity, rpId, registration, prf -> Io.bg(() -> finishSignUp(registration, name, label, rpId, prf, steps, done)));
            }
            @Override public void failed(String code, String message) { step(steps, "passkey", "fail"); done.done(Result.failure(code, message, "")); }
        }));
    }

    /**
     * A new passkey's PRF output: from the create answer, else from an
     * assertion with just that passkey right away (web: passkey.ts
     * createPasskey → prfSecretFor). null when the provider has none. Runs on
     * the main thread; then gets its answer there.
     */
    private void rootFor(Activity activity, String rpId, JSONObject registration, Consumer<byte[]> then) {
        byte[] direct = AccountKeys.prfOf(registration);
        if (direct != null) { then.accept(direct); return; }
        JSONObject request;
        try { request = AccountKeys.prfRequest(rpId, registration, Crypto.random(32)); }
        catch (JSONException e) { then.accept(null); return; }
        Log.i("account", "no PRF when creating — asking the new passkey for it");
        // A moment for the create sheet to go away before the next one comes up.
        Io.mainLater(() -> Passkeys.get(activity, request, new Passkeys.Result() {
            @Override public void ok(JSONObject assertion) {
                boolean same = AccountKeys.credentialId(assertion).equals(AccountKeys.credentialId(registration));
                byte[] prf = same ? AccountKeys.prfOf(assertion) : null;
                if (prf == null) Log.i("account", same ? "the passkey gives no PRF" : "another passkey answered");
                then.accept(prf);
            }
            @Override public void failed(String code, String message) { Log.i("account", "no PRF from the new passkey: " + code + " " + message); then.accept(null); }
        }), 400);
    }

    private void finishSignUp(JSONObject registration, String username, String label, String rpId, byte[] prf, Steps steps, Outcome done) {
        String server = app.config.server();
        boolean bound = prf == null;
        // No PRF at all: a root made here, kept before the server hears of it.
        byte[] root = bound ? Crypto.random(32) : prf;
        String pendingId = username.isEmpty() ? AccountKeys.credentialId(registration) : username;
        boolean asked = false;
        try {
            if (bound) {
                try { roots().put(server, pendingId, root, AccountKeys.credentialId(registration), false); }
                catch (GeneralSecurityException e) { throw new IOException("the account key could not be stored on this phone", e); }
            }
            String keyProof = AccountKeys.keyProof(root);
            step(steps, "keys", "ok");
            step(steps, "register", "run");
            asked = true;
            Sent sent = send("POST", "/api/account/register/verify", new JSONObject().put("credential", AccountKeys.strip(registration)).put("keyProof", keyProof), false);
            if (sent.refused()) {
                // The server refused it: no account exists for this passkey.
                if (bound) roots().remove(server, pendingId);
                step(steps, "register", "fail");
                Server.HttpError refusal = (Server.HttpError) sent.error;
                if (refusal.status == 409 && "taken".equals(refusal.code)) {
                    // 6.4: someone registered that e-mail or phone meanwhile — back to the form with the fields.
                    report(done, new Result(false, "taken", refusal.getMessage(), false, username, refusal.body.optJSONObject("errors")));
                    return;
                }
                report(done, Result.failure("orphan", t("passkey.orphan").replace("{user}", label).replace("{reason}", String.valueOf(sent.error.getMessage())), username));
                return;
            }
            if (sent.answer == null) {
                // Maybe registered, maybe not: a device root stays (a later sign-in with the passkey finds it).
                step(steps, "register", "fail");
                report(done, Result.failure("orphan", t("passkey.orphanOffline").replace("{user}", label), username));
                return;
            }
            step(steps, "register", "ok");
            JSONObject answer = sent.answer;
            String id = accountId(answer.optJSONObject("account"), pendingId);
            if (bound) {
                try { roots().confirm(server, pendingId, id); } catch (GeneralSecurityException e) { Log.e("account", "the device root could not be confirmed", e); }
            }
            save(new JSONObject().put("token", answer.getString("token")).put("account", answer.optJSONObject("account")).put("root", Crypto.b64(root))
                .put("at", System.currentTimeMillis()).put("deviceBound", bound).put("rpId", rpId));
            app.events.add("account-signin", cz.m5cet.app.core.Events.detail("username", username(), "created", true, "deviceBound", bound));
            Log.i("account", "account created: " + username() + (bound ? " (device-bound: the passkey has no PRF)" : ""));
            app.rooms.onAccountChanged();
            report(done, Result.success(bound, username()));
        } catch (Exception e) {
            Log.w("account", "sign-up failed: " + e.getMessage());
            step(steps, asked ? "register" : "keys", "fail");
            report(done, Result.failure("orphan", t("passkey.orphan").replace("{user}", label).replace("{reason}", String.valueOf(e.getMessage())), username));
        } finally {
            Crypto.wipe(root);
        }
    }

    /* ------------------------------------------------ registration (6.4) */

    /**
     * Seals the registration record (Registration.record) with the vault key
     * and stores it as the account vault's own "registration" part — next to
     * the profile, which the web rewrites from its preferences. Nothing of it
     * leaves the phone unsealed. done runs on the main thread.
     */
    public void saveRegistration(JSONObject record, Done done) {
        Io.bg(() -> {
            byte[] root = root(), key = null;
            try {
                if (root == null || !signedIn()) throw new IOException(t("passkey.noRoot"));
                key = AccountKeys.profileKey(root);
                // A lost answer may simply be asked again: the same part is stored again.
                Sent sent = send("PUT", "/api/account/vault", new JSONObject().put("registration", AccountKeys.sealProfile(record, key)), true);
                if (sent.answer == null) throw sent.error;
                JSONObject s = state();
                if (sent.answer.optJSONObject("account") != null) { s.put("account", sent.answer.optJSONObject("account")); save(s); }
                Io.main(() -> done.done(true, null));
            } catch (Exception e) {
                Log.w("account", "registration → vault: " + e.getMessage());
                Io.main(() -> done.done(false, e.getMessage()));
            } finally {
                Crypto.wipe(root);
                Crypto.wipe(key);
            }
        });
    }

    /* ------------------------------------------------ profile card (6.7) */

    /**
     * The profile card (profile/ProfileCard) from the vault's own "card"
     * part, opened with the vault key; null when there is none yet. Blocking
     * (a background thread): only that part is fetched (?only=card).
     */
    public JSONObject loadCard() throws IOException, GeneralSecurityException {
        byte[] root = root(), key = null;
        try {
            if (root == null || !signedIn()) throw new IOException(t("passkey.noRoot"));
            JSONObject card = call("GET", "/api/account/vault?only=card", null, true).optJSONObject("card");
            if (card == null || card.optString("ct").isEmpty()) return null;
            key = AccountKeys.profileKey(root);
            return AccountKeys.openProfile(card.optString("ct"), key);
        } finally {
            Crypto.wipe(root);
            Crypto.wipe(key);
        }
    }

    /** Seals the whole card (every audience) with the vault key into the vault's "card" part. Blocking. */
    public void saveCard(JSONObject card) throws IOException {
        byte[] root = root(), key = null;
        try {
            if (root == null || !signedIn()) throw new IOException(t("passkey.noRoot"));
            key = AccountKeys.profileKey(root);
            Sent sent = send("PUT", "/api/account/vault", new JSONObject().put("card", AccountKeys.sealProfile(card, key)), true);
            if (sent.answer == null) throw sent.error;
        } catch (JSONException e) {
            throw new IOException(e.getMessage());
        } finally {
            Crypto.wipe(root);
            Crypto.wipe(key);
        }
    }

    /** The public profile API (/api/profile…): the owner's PUT / DELETE / GET (auth), anyone's GET by username. Blocking. */
    public JSONObject profileApi(String method, String path, JSONObject body, boolean auth) throws IOException {
        if (!path.startsWith("/api/profile")) throw new IOException("not a profile path");
        return call(method, path, body, auth);
    }

    /* ------------------------------------------------ more ways into it */

    /** The account root kept with the session (null without one). */
    private byte[] root() {
        String r = state().optString("root");
        try { return r.isEmpty() ? null : Crypto.unb64(r); } catch (IllegalArgumentException e) { return null; }
    }

    /** Can this phone seal the root for a recovery code or another passkey? */
    public boolean hasRoot() { return signedIn() && !state().optString("root").isEmpty(); }

    /**
     * 6.3: the account root for an internal (passkey) M5Cet card record —
     * HKDF(root, salt, "m5cet:nfc:card:v1"). Available while signed in (the
     * session holds it); null otherwise, and the workbench then asks the user
     * to sign in. The bytes never leave the device.
     */
    public byte[] cardRoot() { return hasRoot() ? root() : null; }

    /** A sign-in or a confirmation this recent stands for the person: no second prompt. */
    private static final long FRESH_MS = 5 * 60_000;

    /**
     * One of the account's passkeys confirms it is the person (web:
     * confirmWithPasskey) before the root this phone keeps is sealed for a
     * recovery code or another passkey — an unlocked phone left on the table
     * is not enough to take the account elsewhere. A local challenge: nothing
     * of it goes to the server. then runs on the main thread.
     */
    private void confirm(Activity activity, Runnable then, Outcome failed) {
        JSONObject s = state();
        if (System.currentTimeMillis() - Math.max(s.optLong("at"), s.optLong("confirmedAt")) < FRESH_MS) { then.run(); return; }
        Io.bg(() -> {
            try {
                String rpId = state().optString("rpId");
                if (rpId.isEmpty()) rpId = call("GET", "/api/account/status", null, false).getString("rpId");
                JSONArray ids = AccountKeys.credentialIds(summary());
                JSONObject request = AccountKeys.confirmRequest(rpId, ids, Crypto.random(32));
                Io.main(() -> Passkeys.get(activity, request, new Passkeys.Result() {
                    @Override public void ok(JSONObject assertion) {
                        if (!AccountKeys.contains(ids, AccountKeys.credentialId(assertion))) { failed.done(Result.failure("", t("passkey.notThisAccount").replace("{user}", username()), username())); return; }
                        try { JSONObject st = state(); st.put("confirmedAt", System.currentTimeMillis()); save(st); } catch (JSONException ignored) { }
                        then.run();
                    }
                    @Override public void failed(String code, String message) { failed.done(Result.failure(code, message, username())); }
                }));
            } catch (Exception e) {
                report(failed, Result.failure(codeOf(e), e.getMessage(), username()));
            }
        });
    }

    /** Creates (or replaces) the recovery code (web: createRecoveryCode), after a passkey confirmed the person; the code is shown once. */
    public void createRecoveryCode(Activity activity, CodeDone done) {
        if (!hasRoot()) { done.done(null, Result.failure("", t("passkey.noRoot"), username())); return; }
        confirm(activity, () -> Io.bg(() -> {
            byte[] root = root();
            RecoveryCode.Material m = null;
            try {
                if (root == null || !signedIn()) throw new IOException(t("passkey.noRoot"));
                String code = RecoveryCode.generate();
                m = RecoveryCode.material(code);
                JSONObject body = new JSONObject().put("id", m.id).put("verifier", m.verifier).put("wrapped", AccountKeys.sealRoot(root, m.secret, AccountKeys.WRAP_RECOVERY));
                // Idempotent (the same code again), so a lost answer may simply be asked again.
                Sent sent = send("PUT", "/api/account/recovery", body, true);
                if (sent.answer == null) throw sent.error;
                JSONObject s = state();
                s.put("account", sent.answer.optJSONObject("account"));
                save(s);
                app.events.add("account-recovery-set", cz.m5cet.app.core.Events.detail("username", username()));
                Io.main(() -> done.done(code, null));
            } catch (Exception e) {
                Log.w("account", "recovery code: " + e.getMessage());
                Io.main(() -> done.done(null, Result.failure("", e.getMessage(), username())));
            } finally {
                Crypto.wipe(root);
                if (m != null) Crypto.wipe(m.secret);
            }
        }), r -> done.done(null, r));
    }

    /** Adds a passkey with PRF (another provider, a security key), after a passkey confirmed the person: the root is sealed for it (web: addPasskey). */
    public void addPasskey(Activity activity, Outcome done) {
        if (!hasRoot()) { done.done(Result.failure("", t("passkey.noRoot"), username())); return; }
        confirm(activity, () -> Io.bg(() -> {
            try {
                if (!hasRoot()) throw new IOException(t("passkey.noRoot"));
                JSONObject options = AccountKeys.withPrf(call("POST", "/api/account/passkeys/options", new JSONObject(), true).getJSONObject("publicKey"));
                String rpId = options.getJSONObject("rp").getString("id");
                Io.main(() -> Passkeys.create(activity, options, new Passkeys.Result() {
                    @Override public void ok(JSONObject registration) { rootFor(activity, rpId, registration, prf -> Io.bg(() -> finishAdd(registration, prf, done))); }
                    @Override public void failed(String code, String message) { done.done(Result.failure(code, message, username())); }
                }));
            } catch (Exception e) {
                Log.w("account", "add passkey: " + e.getMessage());
                report(done, Result.failure(codeOf(e), e.getMessage(), username()));
            }
        }), done);
    }

    private void finishAdd(JSONObject registration, byte[] prf, Outcome done) {
        String user = username();
        byte[] root = root();
        try {
            // Without PRF nothing can be sealed for it, and the server takes no passkey without its sealed root.
            if (prf == null) { report(done, Result.failure("orphan", t("passkey.addNoPrf").replace("{user}", user), user)); return; }
            if (root == null) throw new IOException(t("passkey.noRoot"));
            String label = ("Android · " + Build.MANUFACTURER + " " + Build.MODEL).trim();
            JSONObject body = new JSONObject().put("credential", AccountKeys.strip(registration)).put("wrapped", AccountKeys.sealRoot(root, prf, AccountKeys.WRAP_PASSKEY))
                .put("label", label.length() > 40 ? label.substring(0, 40) : label);
            Sent sent = send("POST", "/api/account/passkeys/verify", body, true);
            if (sent.answer == null) {
                String why = sent.refused() ? t("passkey.orphan").replace("{reason}", String.valueOf(sent.error.getMessage())) : t("passkey.orphanOffline");
                report(done, Result.failure("orphan", why.replace("{user}", user), user));
                return;
            }
            JSONObject s = state();
            s.put("account", sent.answer.optJSONObject("account"));
            save(s);
            Log.i("account", "passkey added to " + user);
            report(done, Result.success(deviceBound(), user));
        } catch (Exception e) {
            Log.w("account", "add passkey failed: " + e.getMessage());
            report(done, Result.failure("orphan", t("passkey.orphan").replace("{user}", user).replace("{reason}", String.valueOf(e.getMessage())), user));
        } finally {
            Crypto.wipe(prf);
            Crypto.wipe(root);
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
                    me = call("POST", "/api/account/unlock", new JSONObject().put("keyProof", AccountKeys.keyProof(root)), true);
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

    /** Ends the session here (or everywhere); a device root stays for the next sign-in. */
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

    /* ------------------------------------------------------------- scope */

    static String joined(org.json.JSONArray list) {
        StringBuilder b = new StringBuilder();
        if (list != null) for (int i = 0; i < list.length(); i++) b.append(i > 0 ? ", " : "").append(list.optString(i));
        return b.toString();
    }

    /** For the settings: the passkey in use (short), sessions, groups, how the account can be reached. */
    public JSONObject scope() {
        JSONObject a = summary();
        JSONObject o = new JSONObject();
        try {
            String cred = a.optString("credentialId");
            JSONObject recovery = a.optJSONObject("recovery");
            o.put("signedIn", signedIn()).put("username", username()).put("credential", cred.length() > 12 ? cred.substring(0, 12) + "…" : cred)
                .put("passkeys", a.optJSONArray("passkeys") == null ? 0 : a.optJSONArray("passkeys").length())
                .put("sessions", a.optJSONArray("sessions") == null ? 0 : a.optJSONArray("sessions").length())
                .put("groups", joined(a.optJSONArray("groups")))
                .put("since", a.optLong("createdAt")).put("lastLogin", a.optLong("lastLoginAt")).put("keyVerified", a.optBoolean("keyVerified"))
                .put("signedInAt", state().optLong("at"))
                // 6.2: a device-bound account, and what this phone can add to reach it elsewhere
                .put("deviceBound", signedIn() && deviceBound()).put("canSeal", hasRoot())
                .put("recovery", recovery != null && recovery.optBoolean("set")).put("recoverySince", recovery == null ? 0 : recovery.optLong("createdAt"))
                // 6.4: the account was made through the registration (name, mobile, e-mail checked by the server)
                .put("registered", signedIn() && a.optBoolean("registered"));
        } catch (JSONException ignored) { }
        return o;
    }
}
