package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

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
            Mailbox.Keys k = mailbox(id).current(System.currentTimeMillis());
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
        boolean fresh = id.publicKey.equals(cert.optString("pk")) && cert.optLong("exp") - now > P4.DEVICE_CERT_LIFETIME_MS / 3;
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
                if (mark.equals(cert.optString("uploaded"))) return;
                JSONObject body = new JSONObject().put("pk", id.publicKey)
                    .put("cert", new JSONObject().put("v", 2).put("exp", acc.getLong("exp")).put("sig", acc.getString("ac")))
                    .put("bundle", mb).put("apk", acc.getString("apk"));
                app.account.putKeyBundle(body);
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

    Kt.ConsistencyFetcher fetcher() {
        String base = origin();
        return (from, to) -> get(base, "/api/kt/consistency?from=" + from + "&to=" + to);
    }

    static JSONObject get(String base, String path) throws Exception {
        byte[] b = Server.send(base + path, "GET", null, null, null, 2 << 20);
        return new JSONObject(new String(b, StandardCharsets.UTF_8));
    }

    /**
     * Pins the server's KT key on first use and checks its newest tree head
     * against the one kept (at most every 10 minutes; background). A server
     * without key transparency answers 503 kt-off: nothing to check.
     */
    void refreshKt(Runnable after) {
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
