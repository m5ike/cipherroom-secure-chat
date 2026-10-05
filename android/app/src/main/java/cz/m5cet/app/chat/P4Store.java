package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.p4.Kt;
import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Replay;
import cz.m5cet.app.security.Ec;
import cz.m5cet.app.security.Vault;

/**
 * 6.12: what protocol 4 keeps on this device, encrypted in the vault (user
 * tier, like the identity and the pins):
 *
 *   p4.mailbox    this device's mailbox bundles with their private keys (§ 7.1)
 *   p4.seen       device key id → when it was first seen with a valid v4 hello (the downgrade rule, § 1)
 *   p4.bundles    device key id → the newest valid bundle a peer showed {pk, bundle, ref} (§ 7.1, § 12.2)
 *   p4.accounts   account pins (§ 12.2): apk → {kids, user, at, verified}; users: username → apk
 *   p4.kt         key transparency per server (§ 14.4): the pinned key, the newest head, the alert
 *   p4.cert       this device's v2 certificate by the account key {apk, pk, exp, sig} and what was uploaded
 *   p4.replay.*   accepted message ids per room (§ 11), as replay keys — never a readable id
 *
 * One instance per app (Rooms), thread-safe. The backend is the vault, or a
 * map in the JVM tests.
 */
public final class P4Store {
    public interface Backend {
        /** The record, or null while it cannot be read (the vault is locked). */
        JSONObject get(String name);
        /** False while it cannot be written (the vault is locked). */
        boolean put(String name, JSONObject value);
    }

    /** The vault's user tier — only while it is open (6.12: a lock forgets the data key; the rooms keep receiving). */
    static Backend vault(M5 app) {
        return new Backend() {
            @Override public JSONObject get(String name) { return app.vault.unlocked() ? app.vault.json(Vault.Tier.USER, name) : null; }
            @Override public boolean put(String name, JSONObject value) {
                if (!app.vault.unlocked()) return false;
                app.vault.putJson(Vault.Tier.USER, name, value);
                return true;
            }
        };
    }

    public static final class MemoryBackend implements Backend {
        private final Map<String, String> rows = new HashMap<>();
        boolean locked;
        @Override public synchronized JSONObject get(String name) {
            if (locked) return null;
            String v = rows.get(name);
            try { return v == null ? new JSONObject() : new JSONObject(v); } catch (JSONException e) { return new JSONObject(); }
        }
        @Override public synchronized boolean put(String name, JSONObject value) {
            if (locked) return false;
            rows.put(name, value.toString());
            return true;
        }
    }

    /** Every record but the replay windows (those are per room, read when a room starts). */
    static final String[] RECORDS = {"p4.seen", "p4.bundles", "p4.mailbox", "p4.accounts", "p4.kt", "p4.cert"};

    private final Backend backend;
    private final Map<String, JSONObject> cache = new HashMap<>();
    /** Records read while locked: empty stand-ins, never written over the stored ones (read again after the unlock). */
    private final java.util.Set<String> standIns = new java.util.HashSet<>();
    /** Records changed while they could not be written; and replay windows waiting the same way. */
    private final java.util.Set<String> dirty = new java.util.HashSet<>();
    private final Map<String, JSONObject> pendingReplay = new HashMap<>();

    public P4Store(Backend backend) { this.backend = backend; }

    private JSONObject read(String name) {
        JSONObject o = cache.get(name);
        if (o != null) return o;
        o = backend.get(name);
        if (o == null) { o = new JSONObject(); standIns.add(name); }
        cache.put(name, o);
        return o;
    }

    private void write(String name) {
        if (standIns.contains(name)) return; // never an empty stand-in over what the vault holds
        if (!backend.put(name, read(name))) dirty.add(name);
    }

    /** Reads every record now (before a lock takes the data key): protocol 4 then works from memory while locked. */
    public synchronized void warm() { for (String r : RECORDS) read(r); }

    /** After the unlock: what changed while locked into the vault; stand-ins forgotten (read again). */
    public synchronized void flush() {
        for (String name : standIns) cache.remove(name);
        standIns.clear();
        for (String name : new java.util.ArrayList<>(dirty)) if (cache.containsKey(name) && backend.put(name, cache.get(name))) dirty.remove(name);
        for (String name : new java.util.ArrayList<>(pendingReplay.keySet())) if (backend.put(name, pendingReplay.get(name))) pendingReplay.remove(name);
    }

    /** Forgets what is cached (the vault was wiped). */
    public synchronized void reset() { cache.clear(); standIns.clear(); dirty.clear(); pendingReplay.clear(); }

    static String kid(String pk) {
        try { return Ec.kid(pk); } catch (RuntimeException e) { return ""; }
    }

    /* ---------------------------------------------------- downgrade (§ 1) */

    public synchronized boolean p4Seen(String pk) { String k = kid(pk); return !k.isEmpty() && read("p4.seen").has(k); }

    public synchronized void markP4(String pk) {
        String k = kid(pk);
        if (k.isEmpty() || read("p4.seen").has(k)) return;
        try { read("p4.seen").put(k, System.currentTimeMillis()); } catch (JSONException ignored) { }
        write("p4.seen");
    }

    /* ------------------------------------------------- peers' bundles (§ 7) */

    /** Remembers a peer device's valid bundle (the newest by expiry), with the room-scoped account reference it came with. */
    public synchronized void rememberBundle(String pk, Mailbox.Bundle bundle, String ref) {
        String k = kid(pk);
        if (k.isEmpty() || bundle == null) return;
        JSONObject all = read("p4.bundles");
        JSONObject old = all.optJSONObject(k);
        Mailbox.Bundle prev = old == null ? null : Mailbox.Bundle.parse(old.optJSONObject("bundle"));
        if (prev != null && prev.exp > bundle.exp) return;
        try {
            all.put(k, new JSONObject().put("pk", pk).put("bundle", bundle.json()).put("ref", ref == null ? (old == null ? "" : old.optString("ref")) : ref).put("at", System.currentTimeMillis()));
        } catch (JSONException ignored) { }
        // Bounded: the oldest go first.
        while (all.length() > 2000) {
            String oldest = null;
            long at = Long.MAX_VALUE;
            for (Iterator<String> it = all.keys(); it.hasNext(); ) { String key = it.next(); long t = all.optJSONObject(key).optLong("at"); if (t < at) { at = t; oldest = key; } }
            all.remove(oldest);
        }
        write("p4.bundles");
    }

    /** Device keys and bundles learned from hellos for a room-scoped account reference (not expired at `now`). */
    public synchronized List<String[]> bundlesOfRef(String ref, long now) {
        List<String[]> out = new ArrayList<>();
        if (ref == null || ref.isEmpty()) return out;
        JSONObject all = read("p4.bundles");
        for (Iterator<String> it = all.keys(); it.hasNext(); ) {
            JSONObject row = all.optJSONObject(it.next());
            if (row == null || !ref.equals(row.optString("ref"))) continue;
            Mailbox.Bundle b = Mailbox.Bundle.parse(row.optJSONObject("bundle"));
            if (b != null && b.exp > now) out.add(new String[]{row.optString("pk"), b.json().toString()});
        }
        return out;
    }

    /* --------------------------------------------------- own mailbox (§ 7.1) */

    /** This device's bundles with their private keys, in the vault. */
    public Mailbox.Store mailbox() {
        return new Mailbox.Store() {
            @Override public List<Mailbox.Keys> all() {
                synchronized (P4Store.this) {
                    List<Mailbox.Keys> out = new ArrayList<>();
                    JSONArray list = read("p4.mailbox").optJSONArray("bundles");
                    if (list != null) for (int i = 0; i < list.length(); i++) {
                        try { out.add(Mailbox.Keys.parse(list.optJSONObject(i))); } catch (P4Error e) { Log.w("p4", "a stored mailbox bundle is unreadable"); }
                    }
                    return out;
                }
            }
            @Override public void put(Mailbox.Keys keys) {
                synchronized (P4Store.this) {
                    JSONArray list = read("p4.mailbox").optJSONArray("bundles"), next = new JSONArray();
                    if (list != null) for (int i = 0; i < list.length(); i++) {
                        JSONObject row = list.optJSONObject(i);
                        if (row != null && !keys.bundle.id.equals(row.optJSONObject("bundle") == null ? "" : row.optJSONObject("bundle").optString("id"))) next.put(row);
                    }
                    next.put(keys.json());
                    try { read("p4.mailbox").put("bundles", next); } catch (JSONException ignored) { }
                    write("p4.mailbox");
                }
            }
            @Override public void remove(String id) {
                synchronized (P4Store.this) {
                    JSONArray list = read("p4.mailbox").optJSONArray("bundles"), next = new JSONArray();
                    if (list != null) for (int i = 0; i < list.length(); i++) {
                        JSONObject row = list.optJSONObject(i);
                        if (row != null && !id.equals(row.optJSONObject("bundle") == null ? "" : row.optJSONObject("bundle").optString("id"))) next.put(row);
                    }
                    try { read("p4.mailbox").put("bundles", next); } catch (JSONException ignored) { }
                    write("p4.mailbox");
                }
            }
        };
    }

    /* -------------------------------------------------- account pins (§ 12.2) */

    static String userKey(String username) { return username == null ? "" : username.trim().toLowerCase(Locale.ROOT); }

    /**
     * An attested device (a valid account certificate): the account key is
     * pinned across rooms. "new" (first time), "match" (known account — a new
     * device of it is fine), or "changed" (the username this hello claims is
     * pinned to another account key).
     */
    public synchronized String pinAccount(String apk, String devicePk, String username) {
        JSONObject root = read("p4.accounts");
        JSONObject accounts = root.optJSONObject("apk"), users = root.optJSONObject("users");
        try {
            if (accounts == null) root.put("apk", accounts = new JSONObject());
            if (users == null) root.put("users", users = new JSONObject());
            String u = userKey(username);
            String verdict;
            JSONObject row = accounts.optJSONObject(apk);
            if (!u.isEmpty() && users.has(u) && !apk.equals(users.optString(u))) verdict = "changed";
            else verdict = row == null ? "new" : "match";
            if ("changed".equals(verdict)) return verdict; // the old pin stays until the user accepts
            if (row == null) accounts.put(apk, row = new JSONObject().put("at", System.currentTimeMillis()).put("kids", new JSONObject()));
            JSONObject kids = row.optJSONObject("kids");
            if (kids == null) row.put("kids", kids = new JSONObject());
            String k = kid(devicePk);
            if (!k.isEmpty() && !kids.has(k)) kids.put(k, System.currentTimeMillis());
            if (!u.isEmpty()) { users.put(u, apk); row.put("user", u); }
            write("p4.accounts");
            return verdict;
        } catch (JSONException e) {
            return "new";
        }
    }

    /** May a message be sealed to this account key: not when the username is pinned to another account key (changed). */
    public synchronized boolean accountAllowed(String apk, String username) {
        JSONObject users = read("p4.accounts").optJSONObject("users");
        String u = userKey(username);
        return users == null || u.isEmpty() || !users.has(u) || users.optString(u).equals(apk);
    }

    /** The user accepted a changed account: the username now pins `apk`. */
    public synchronized void acceptAccount(String apk, String devicePk, String username) {
        JSONObject users = read("p4.accounts").optJSONObject("users");
        String u = userKey(username);
        if (users != null && !u.isEmpty()) users.remove(u);
        write("p4.accounts");
        pinAccount(apk, devicePk, username);
    }

    public synchronized boolean accountVerified(String apk) {
        JSONObject accounts = read("p4.accounts").optJSONObject("apk");
        JSONObject row = accounts == null || apk == null ? null : accounts.optJSONObject(apk);
        return row != null && row.optBoolean("verified");
    }

    public synchronized void setAccountVerified(String apk, boolean on) {
        JSONObject accounts = read("p4.accounts").optJSONObject("apk");
        JSONObject row = accounts == null || apk == null ? null : accounts.optJSONObject(apk);
        if (row == null) return;
        try { row.put("verified", on); } catch (JSONException ignored) { }
        write("p4.accounts");
    }

    /* ------------------------------------------------ key transparency (§ 14) */

    public Kt.Store kt() {
        return new Kt.Store() {
            @Override public Kt.OriginState get(String origin) {
                synchronized (P4Store.this) { return Kt.OriginState.parse(read("p4.kt").optJSONObject(origin)); }
            }
            @Override public void set(String origin, Kt.OriginState state) {
                synchronized (P4Store.this) {
                    try { read("p4.kt").put(origin, state.json()); } catch (JSONException ignored) { }
                    write("p4.kt");
                }
            }
        };
    }

    /* ---------------------------------------------- own certificate (§ 12.3) */

    public synchronized JSONObject cert() {
        try { return new JSONObject(read("p4.cert").toString()); } catch (JSONException e) { return new JSONObject(); }
    }

    public synchronized void putCert(JSONObject cert) {
        cache.put("p4.cert", cert);
        write("p4.cert");
    }

    /* ------------------------------------------------------- replay (§ 11) */

    /** The replay window of one room, kept as {replay key: createdAt}; saved by {@link #saveReplay}. */
    public synchronized Replay.MemoryStore replay(String roomId) {
        Store store = new Store();
        JSONObject saved = backend.get(replayName(roomId));
        // Read while locked: a window of its own, never saved over the stored one.
        if (saved == null) { store.standIn = true; saved = new JSONObject(); }
        LinkedHashMap<String, Long> rows = new LinkedHashMap<>();
        JSONObject ids = saved.optJSONObject("ids");
        if (ids != null) for (Iterator<String> it = ids.keys(); it.hasNext(); ) { String key = it.next(); rows.put(key, ids.optLong(key)); }
        store.load(roomId, rows);
        return store;
    }

    /** Saves a room's window (while locked: kept, written at the unlock). */
    public synchronized void saveReplay(String roomId, Replay.MemoryStore store) {
        if (!(store instanceof Store) || ((Store) store).standIn) return;
        JSONObject value;
        try { value = new JSONObject().put("ids", ((Store) store).snapshot(roomId)); } catch (JSONException e) { return; }
        String name = replayName(roomId);
        if (backend.put(name, value)) pendingReplay.remove(name); else pendingReplay.put(name, value);
    }

    static String replayName(String roomId) { return "p4.replay." + Rooms.hashKey(roomId == null ? "" : roomId); }

    static final class Store extends Replay.MemoryStore {
        boolean standIn;
        synchronized void load(String roomId, LinkedHashMap<String, Long> rows) { rooms.put(roomId, rows); }
        synchronized JSONObject snapshot(String roomId) {
            JSONObject out = new JSONObject();
            Map<String, Long> r = rooms.get(roomId);
            if (r != null) for (Map.Entry<String, Long> e : r.entrySet()) try { out.put(e.getKey(), (long) e.getValue()); } catch (JSONException ignored) { }
            return out;
        }
    }
}
