package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Vault;

/**
 * 6.8: the app's own history of calls — what the History screen lists
 * besides the rooms' messages (ActivityLog). One record per call (CallTrack),
 * encrypted in the vault's user tier (record "calls"), so nothing of it is
 * readable before the PIN or a biometric unlock; at most {@link #KEEP}
 * calls of the last {@link #KEEP_MS}. Settings › Calls can stop keeping it
 * (calls.history) or clear it; a wipe takes it with the vault. A record also
 * remembers the row it wrote into the phone's call log, so that row can be
 * removed again (CallLogBridge.eraseSystem).
 */
public final class CallHistory {
    private CallHistory() {}

    public static final int KEEP = 500;
    public static final long KEEP_MS = 90L * 24 * 3600 * 1000;
    static final String RECORD = "calls";

    /** One call of a room. */
    public static final class Entry {
        public String id = "";
        public String roomKey = "";
        /** The room's name when the call happened. */
        public String room = "";
        /** CallTrack.OUT / IN / MISSED / DECLINED. */
        public String kind = CallTrack.MISSED;
        public long at;
        public long seconds;
        public boolean video;
        public final List<String> people = new ArrayList<>();
        /** The row in the phone's call log ("" = none). */
        public String sysUri = "";

        public static Entry of(String id, String roomKey, String room, CallTrack.Record r) {
            Entry e = new Entry();
            e.id = id;
            e.roomKey = roomKey == null ? "" : roomKey;
            e.room = room == null ? "" : room;
            e.kind = r.kind;
            e.at = r.at;
            e.seconds = r.seconds;
            e.video = r.video;
            e.people.addAll(r.people);
            return e;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject().put("id", id).put("key", roomKey).put("room", room).put("kind", kind).put("at", at).put("sec", seconds).put("video", video);
            JSONArray p = new JSONArray();
            for (String n : people) p.put(n);
            o.put("people", p);
            if (!sysUri.isEmpty()) o.put("sys", sysUri);
            return o;
        }

        static Entry fromJson(JSONObject o) {
            Entry e = new Entry();
            e.id = o.optString("id");
            e.roomKey = o.optString("key");
            e.room = o.optString("room");
            String k = o.optString("kind");
            e.kind = k.equals(CallTrack.IN) || k.equals(CallTrack.OUT) || k.equals(CallTrack.DECLINED) ? k : CallTrack.MISSED;
            e.at = o.optLong("at");
            e.seconds = Math.max(0, o.optLong("sec"));
            e.video = o.optBoolean("video");
            JSONArray p = o.optJSONArray("people");
            if (p != null) for (int i = 0; i < p.length() && i < CallTrack.PEOPLE_MAX; i++) { String n = p.optString(i, ""); if (!n.isEmpty()) e.people.add(n); }
            e.sysUri = o.optString("sys", "");
            return e;
        }
    }

    /** The calls kept: those of the last KEEP_MS (none from the future), oldest first, at most KEEP. */
    static List<Entry> bound(List<Entry> list, long now) {
        List<Entry> out = new ArrayList<>();
        for (Entry e : list) if (e.at > now - KEEP_MS && e.at <= now + 24 * 3600_000L) out.add(e);
        Collections.sort(out, (a, b) -> Long.compare(a.at, b.at));
        return out.size() > KEEP ? new ArrayList<>(out.subList(out.size() - KEEP, out.size())) : out;
    }

    static JSONObject toJson(List<Entry> list) {
        JSONArray a = new JSONArray();
        for (Entry e : list) { try { a.put(e.toJson()); } catch (JSONException ignored) { } }
        try { return new JSONObject().put("c", a); } catch (JSONException e) { return new JSONObject(); }
    }

    static List<Entry> fromJson(JSONObject o) {
        List<Entry> out = new ArrayList<>();
        JSONArray a = o == null ? null : o.optJSONArray("c");
        if (a != null) for (int i = 0; i < a.length(); i++) { JSONObject x = a.optJSONObject(i); if (x != null) out.add(Entry.fromJson(x)); }
        return out;
    }

    /* ------------------------------------------------------------- vault */

    /** Calls that ended while the vault was closed (kept in memory until it opens). */
    private static final List<Entry> pending = new ArrayList<>();

    public static String newId() { return Crypto.b64url(Crypto.random(9)); }

    /** Every call kept, oldest first (empty while the vault is closed). */
    public static synchronized List<Entry> load(M5 app) {
        if (!app.vault.unlocked()) return new ArrayList<>();
        List<Entry> all = fromJson(app.vault.json(Vault.Tier.USER, RECORD));
        if (!pending.isEmpty()) { all.addAll(pending); pending.clear(); all = bound(all, System.currentTimeMillis()); save(app, all); }
        return bound(all, System.currentTimeMillis());
    }

    /** Keeps a call (unless Settings › Calls says not to). */
    public static synchronized void add(M5 app, Entry e) {
        if (!app.settings.bool("calls.history")) return;
        if (!app.vault.unlocked()) {
            // 6.12 (F-16): locked — into the lock inbox (on the disk, sealed); without it kept in memory as before.
            try { if (LockedRooms.active() && LockedRooms.call(e.toJson())) return; } catch (JSONException ignored) { }
            if (pending.size() < KEEP) pending.add(e);
            return;
        }
        List<Entry> all = load(app);
        all.add(e);
        save(app, bound(all, System.currentTimeMillis()));
    }

    /** 6.12: a call from the lock inbox — once, even when the inbox is merged a second time (after a crash). */
    static synchronized void addOnce(M5 app, Entry e) {
        if (!app.vault.unlocked() || e.id.isEmpty()) return;
        List<Entry> all = load(app);
        for (Entry x : all) if (x.id.equals(e.id)) return;
        all.add(e);
        save(app, bound(all, System.currentTimeMillis()));
    }

    /** Remembers the phone's call log row of a call kept before. */
    public static synchronized void setSysUri(M5 app, String id, String uri) {
        if (uri == null || uri.isEmpty()) return;
        for (Entry p : pending) if (p.id.equals(id)) { p.sysUri = uri; return; }
        if (!app.vault.unlocked()) { if (LockedRooms.active()) LockedRooms.callUri(id, uri); return; }
        List<Entry> all = load(app);
        for (Entry e : all) if (e.id.equals(id)) { e.sysUri = uri; save(app, all); return; }
    }

    /** Deletes the whole call history (the rows in the phone's call log stay: CallLogBridge removes those). */
    public static synchronized void clear(M5 app) {
        pending.clear();
        app.vault.delete(Vault.Tier.USER, RECORD);
    }

    private static void save(M5 app, List<Entry> all) {
        if (!app.vault.unlocked()) return;
        try { app.vault.putJson(Vault.Tier.USER, RECORD, toJson(all)); }
        catch (RuntimeException e) { Log.e("calls", "the call history cannot be saved", e); }
    }
}
