package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.p4.Handshake;
import cz.m5cet.app.p4.Kt;
import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Prim;
import cz.m5cet.app.p4.Rng;

/**
 * 6.12: protocol 4 for this device, across its rooms — the mailbox (own
 * bundles, private keys in the vault, § 7.1), the account attestation (a
 * device certificate v2 by the account key while signed in, § 12.3) and its
 * upload with the current bundle to the key directory (PUT /api/keys/bundle,
 * § 7.5), and key transparency for the server (the pinned KT key, the newest
 * verified tree head, gossip, lookups — § 14.4).
 */
final class P4Device {
    private final M5 app;
    final P4Store store;
    private Mailbox mailbox;
    private ChatIdentity mailboxOwner;
    final Kt.State kt;
    private volatile long ktRefreshedAt = 0;
    private volatile boolean ktBusy = false, uploadBusy = false;
    /** The upload the server refused with 429 kt-quota (not tried again in this session). */
    private volatile String quotaMark = "";

    P4Device(M5 app, P4Store store) {
        this.app = app;
        this.store = store;
        this.kt = new Kt.State(store.kt(), System::currentTimeMillis);
    }

    static Prim.DeviceSigner signer(ChatIdentity id) {
        return new Prim.DeviceSigner() {
            @Override public String publicKey() { return id.publicKey; }
            @Override public String sign(byte[] data) { return id.sign(data); }
        };
    }

    /* ------------------------------------------------------------ mailbox */

    synchronized Mailbox mailbox(ChatIdentity id) {
        if (mailbox == null || mailboxOwner != id) {
            mailbox = new Mailbox(store.mailbox(), signer(id), Rng.SYSTEM);
            mailboxOwner = id;
        }
        return mailbox;
    }

    /** The current bundle for the hello's `mb` (renewed when due), or null. */
    JSONObject bundle(ChatIdentity id) {
        try {
            long now = System.currentTimeMillis();
            if (!app.vault.unlocked()) {
                // Locked (the rooms keep receiving): no new bundle now — its private keys could not be stored safely.
                Mailbox.Keys best = null;
                for (Mailbox.Keys k : store.mailbox().all()) if (k.bundle.exp > now && (best == null || k.bundle.exp > best.bundle.exp)) best = k;
                return best == null ? null : best.bundle.json();
            }
            Mailbox.Keys k = mailbox(id).current(now);
            return k == null ? null : k.bundle.json();
        } catch (P4Error | RuntimeException e) {
            Log.w("p4", "no mailbox bundle: " + e.getMessage());
            return null;
        }
    }

    /* -------------------------------------------------- account (§ 12.3) */

    /**
     * The hello's `acc` {apk, ac, cv:2, exp} while signed in with the account
     * root here; the certificate is renewed when less than a third of its
     * lifetime is left. Null otherwise.
     */
    synchronized JSONObject account(ChatIdentity id) {
        if (app.account == null || !app.account.signedIn()) return null;
        long now = System.currentTimeMillis();
        JSONObject cert = store.cert();
        // The certificate of this device key, by the account signed in now, with more than a third of its lifetime left.
        boolean fresh = id.publicKey.equals(cert.optString("pk")) && app.account.username().equals(cert.optString("user"))
            && cert.optLong("exp") - now > P4.DEVICE_CERT_LIFETIME_MS / 3;
        if (!fresh) {
            byte[] seed = app.account.accountSeed();
            if (seed == null) return null;
            try {
                long exp = now + P4.DEVICE_CERT_LIFETIME_MS - 60_000;
                JSONObject v2 = Handshake.certifyDeviceV2(seed, id.publicKey, exp, now);
                cert = new JSONObject().put("apk", Prim.b64(Prim.ed25519Public(seed))).put("pk", id.publicKey).put("exp", exp).put("sig", v2.getString("sig"))
                    .put("user", app.account.username());
                store.putCert(cert);
            } catch (P4Error | JSONException e) {
                Log.w("p4", "no device certificate: " + e.getMessage());
                return null;
            } finally {
                Prim.wipe(seed);
            }
        }
        try { return new JSONObject().put("apk", cert.getString("apk")).put("ac", cert.getString("sig")).put("cv", 2).put("exp", cert.getLong("exp")); }
        catch (JSONException e) { return null; }
    }

    /** This device's account key (b64) as its certificate names it — "" when signed out or not certified yet. Never creates one. */
    String myAccountKey(ChatIdentity id) {
        if (app.account == null || !app.account.signedIn()) return "";
        JSONObject cert = store.cert();
        return id.publicKey.equals(cert.optString("pk")) && app.account.username().equals(cert.optString("user")) ? cert.optString("apk") : "";
    }

    /**
     * The current bundle and certificate to the key directory, when either is
     * new since the last upload (background; signed in only). The answer's
     * KT indexes are not needed here — the device's own entries are what
     * other members check.
     */
    void upload(ChatIdentity id) {
        if (uploadBusy || app.account == null || !app.account.signedIn()) return;
        uploadBusy = true;
        Io.bg(() -> {
            try {
                JSONObject acc = account(id);
                JSONObject mb = bundle(id);
                if (acc == null || mb == null) return;
                String mark = mb.optString("id") + "|" + acc.optLong("exp") + "|" + app.account.username();
                JSONObject cert = store.cert();
                if (mark.equals(cert.optString("uploaded")) || mark.equals(quotaMark)) return;
                JSONObject body = new JSONObject().put("pk", id.publicKey)
                    .put("cert", new JSONObject().put("v", 2).put("exp", acc.getLong("exp")).put("sig", acc.getString("ac")))
                    .put("bundle", mb).put("apk", acc.getString("apk"));
                try {
                    app.account.putKeyBundle(body);
                } catch (Server.HttpError e) {
                    // 6.12 review S10: 429 kt-quota — the account's key-log entries for the day are used up; not again this session.
                    if (e.status == 429 || "kt-quota".equals(e.code)) quotaMark = mark;
                    throw e;
                }
                cert.put("uploaded", mark);
                store.putCert(cert);
                Log.i("p4", "the key directory has this device's bundle");
            } catch (Server.HttpError e) {
                Log.w("p4", "key directory: " + e.status + " " + e.code + " " + e.getMessage());
            } catch (Exception e) {
                Log.w("p4", "key directory: " + e.getMessage());
            } finally {
                uploadBusy = false;
            }
        });
    }

    /* ------------------------------------------- key transparency (§ 14) */

    String origin() { return app.config.server(); }

    /** The newest verified tree head for the hello's `sth` (null before one). */
    JSONObject sth() { return kt.newest(origin()); }

    /**
     * GET /api/kt/consistency. Review P05: an answer that is an error (the
     * server refuses to prove two heads it signed) is the alert; no answer at
     * all (the network) is {@link Kt.Unreachable} — asked again later.
     */
    Kt.ConsistencyFetcher fetcher() {
        String base = origin();
        return (from, to) -> {
            try { return get(base, "/api/kt/consistency?from=" + from + "&to=" + to); }
            catch (Server.HttpError e) { throw e; }
            catch (java.io.IOException e) { throw new Kt.Unreachable(e); }
        };
    }

    static JSONObject get(String base, String path) throws Exception { return get(base, path, null); }

    /** `bearer`: the account session (the own-entries lookup needs one, § 14.3); null: none. */
    static JSONObject get(String base, String path, String bearer) throws Exception {
        JSONObject headers = bearer == null || bearer.isEmpty() ? null : new JSONObject().put("Authorization", "Bearer " + bearer);
        byte[] b = Server.send(base + path, "GET", null, headers, null, 2 << 20);
        return new JSONObject(new String(b, StandardCharsets.UTF_8));
    }

    /** Does this server run key transparency (its KT key is pinned here)? */
    boolean ktOn() { return kt.key(origin()) != null; }

    /**
     * Pins the server's KT key on first use and checks its newest tree head
     * against the one kept (at most every 10 minutes; background); asks again
     * for the proofs the server could not be asked for (review P05); and
     * looks this account's own entries up (review P04). A server without key
     * transparency answers 503 kt-off: nothing to check.
     */
    void refreshKt(Runnable after) { refreshKt(after, null); }

    void refreshKt(Runnable after, ChatIdentity id) {
        long now = System.currentTimeMillis();
        if (ktBusy || now - ktRefreshedAt < 10 * 60_000) return;
        ktBusy = true;
        String base = origin();
        Io.bg(() -> {
            try {
                JSONObject key = get(base, "/api/kt/key");
                String pin = kt.pinKey(base, key.optString("key"));
                if ("changed".equals(pin)) Log.w("p4", "the server's key-transparency key changed — alert kept");
                Kt.Outcome up = kt.update(base, get(base, "/api/kt/sth"), fetcher());
                if (!"ok".equals(up.status)) Log.w("p4", "key transparency: " + up.status);
                Kt.Outcome again = kt.retryPending(base, fetcher());
                if (!"ok".equals(again.status)) Log.w("p4", "key transparency (waiting proofs): " + again.status);
                if (id != null) selfCheck(base, id);
                ktRefreshedAt = System.currentTimeMillis();
                if (after != null) after.run();
            } catch (Server.HttpError e) {
                ktRefreshedAt = System.currentTimeMillis();
                if (!e.code.startsWith("kt-")) Log.w("p4", "key transparency: " + e.status + " " + e.getMessage());
            } catch (Exception e) {
                Log.w("p4", "key transparency: " + e.getMessage());
            } finally {
                ktBusy = false;
            }
        });
    }

    /**
     * § 14.4 / review P04: this account's own entries (GET /api/kt/lookup) —
     * a device or an account key this device does not know raises the alert.
     * Background, signed in with a certificate here only.
     */
    void selfCheck(String base, ChatIdentity id) throws Exception {
        String apk = myAccountKey(id);
        if (apk.isEmpty() || app.account == null) return;
        // § 14.3 (6.12 review): the lookup answers only the caller's own entries, and needs the account session.
        String token = app.account.token();
        if (token.isEmpty()) return;
        String username = app.account.username();
        String u = Kt.user(username);
        Kt.Checked c = kt.lookup(base, get(base, "/api/kt/lookup?u=" + userParam(username), token), u, fetcher());
        if (!c.ok) { Log.w("p4", "own key-transparency entries: " + c.why); return; }
        Own verdict = ownCheck(store.own(), u, c.entries, apk, id.publicKey, System.currentTimeMillis());
        store.putOwn(verdict.state);
        if (verdict.accountChanged) kt.raiseAlert(base, "account-key", "another account key was logged for this account");
        else if (verdict.unknown > 0) kt.raiseAlert(base, "unknown-device", verdict.unknown + " device(s) added to this account");
    }

    /** What {@link #ownCheck} found: the monitor's next state, unknown devices, another account key. */
    static final class Own {
        final JSONObject state;
        final int unknown;
        final boolean accountChanged;
        Own(JSONObject state, int unknown, boolean accountChanged) { this.state = state; this.unknown = unknown; this.accountChanged = accountChanged; }
    }

    /**
     * Review P04 (pure): this account's verified entries against what this
     * device knows. The first check (or a check for another account) takes
     * the devices logged so far as known — trust on first use, as every pin;
     * from then on a `dev` entry of the current account key that is not
     * known, not this device and not revoked again is an unknown device
     * (kept in `pending` until the person dismisses the alert), and an
     * `acct` entry with another key than this device's account key is
     * another account key.
     */
    static Own ownCheck(JSONObject own, String u, List<Kt.Entry> entries, String apk, String myPk, long now) {
        JSONObject state;
        try { state = own == null ? new JSONObject() : new JSONObject(own.toString()); } catch (JSONException e) { state = new JSONObject(); }
        try {
            boolean first = !u.equals(state.optString("u")) || !apk.equals(state.optString("apk"));
            if (first) state = new JSONObject().put("u", u).put("apk", apk).put("known", new JSONObject());
            JSONObject known = state.optJSONObject("known");
            if (known == null) state.put("known", known = new JSONObject());
            known.put(myPk, now);
            List<Kt.Entry> sorted = new java.util.ArrayList<>(entries);
            java.util.Collections.sort(sorted, (a, b) -> Long.compare(a.index, b.index));
            String current = "";
            for (Kt.Entry e : sorted) if ("acct".equals(e.entry.optString("t"))) current = e.entry.optString("apk");
            boolean accountChanged = !current.isEmpty() && !current.equals(apk) && !current.equals(state.optString("acceptedAccount"));
            java.util.Set<String> unknown = new java.util.LinkedHashSet<>();
            for (Kt.Entry e : sorted) {
                String t = e.entry.optString("t"), dpk = e.entry.optString("dpk");
                if (!apk.equals(e.entry.optString("apk")) || dpk.isEmpty()) continue;
                if ("dev".equals(t)) {
                    if (first) known.put(dpk, now);
                    else if (!known.has(dpk)) unknown.add(dpk);
                } else if ("rev".equals(t)) unknown.remove(dpk);
            }
            JSONArray pending = new JSONArray();
            for (String dpk : unknown) pending.put(dpk);
            state.put("pending", pending).put("account", current).put("at", now);
            return new Own(state, unknown.size(), accountChanged);
        } catch (JSONException e) {
            return new Own(state, 0, false);
        }
    }

    /**
     * Settings › the key-transparency alert, dismissed (the person saw it): an
     * unknown device of this account becomes known (it was theirs), another
     * account key is accepted; the other alerts come back while their cause does.
     */
    void dismissKtAlert() {
        String base = origin();
        Kt.Alert a = kt.alert(base);
        if (a == null) return;
        if ("unknown-device".equals(a.kind) || "account-key".equals(a.kind)) {
            JSONObject own = store.own();
            try {
                JSONObject known = own.optJSONObject("known");
                if (known == null) own.put("known", known = new JSONObject());
                JSONArray pending = own.optJSONArray("pending");
                if (pending != null) for (int i = 0; i < pending.length(); i++) known.put(pending.optString(i), System.currentTimeMillis());
                own.put("pending", new JSONArray());
                if ("account-key".equals(a.kind)) own.put("acceptedAccount", own.optString("account"));
                store.putOwn(own);
            } catch (JSONException ignored) { }
        }
        kt.dismissAlert(base);
    }

    /** A peer's tree head from its hello (§ 14.4 gossip); a consistency check runs in the background when needed. */
    void gossip(Object peerSth) {
        if (!(peerSth instanceof JSONObject)) return;
        String base = origin();
        Kt.Outcome g = kt.gossip(base, peerSth);
        if ("need-consistency".equals(g.status)) {
            Io.bg(() -> {
                Kt.Outcome r = kt.resolveGossip(base, peerSth, fetcher());
                if (!"ok".equals(r.status)) Log.w("p4", "key transparency gossip: " + r.status);
            });
        } else if ("split-view".equals(g.status)) {
            Log.w("p4", "key transparency: split view");
        }
    }

    /** The persistent alert for this server ("" when none): inconsistent, split-view or key-changed. */
    String ktAlert() { Kt.Alert a = kt.alert(origin()); return a == null ? "" : a.kind; }

    static String userParam(String username) {
        try { return URLEncoder.encode(Kt.user(username), "UTF-8"); } catch (java.io.UnsupportedEncodingException e) { return ""; }
    }
}
