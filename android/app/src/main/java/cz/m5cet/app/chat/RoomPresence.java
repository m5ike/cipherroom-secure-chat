package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 6.7 presence of a room's people, from the server's frames (hub.ts) — the
 * web's lib/presence-book.ts in Java: who is connected with the app in the
 * foreground and when the others were last seen (joined.peers, peer-joined,
 * peer-presence), the members whose connection went without a goodbye
 * ("held": peer-left with held — listed as away until they come back), and
 * when the relay's signed-in away members were last seen (peer-away).
 * Written on the room's thread, read by the UI.
 */
final class RoomPresence {
    static final class Live {
        final boolean foreground;
        final long lastSeen;
        Live(boolean foreground, long lastSeen) { this.foreground = foreground; this.lastSeen = lastSeen; }
    }

    static final class Held {
        final String peerId, name, account;
        final long lastSeen, since;
        Held(String peerId, String name, String account, long lastSeen, long since) {
            this.peerId = peerId; this.name = name; this.account = account; this.lastSeen = lastSeen; this.since = since;
        }
    }

    private final Map<String, Live> live = new ConcurrentHashMap<>();
    /** In the order they went. */
    private final Map<String, Held> held = new LinkedHashMap<>();
    /** account reference → when the away member was last seen. */
    private final Map<String, Long> away = new ConcurrentHashMap<>();

    /** `account` (protocol 2) or its alias `accountId`; "" when absent or null. */
    private static String ref(JSONObject f) {
        Object v = f.opt("account");
        if (v instanceof String && !((String) v).isEmpty()) return (String) v;
        v = f.opt("accountId");
        return v instanceof String ? (String) v : "";
    }

    private static long time(JSONObject f, String key) { return (long) f.optDouble(key, 0); }

    private void setLive(JSONObject f) {
        String id = f.optString("peerId");
        if (id.isEmpty()) return;
        synchronized (held) { held.remove(id); }
        // A server before 6.7 says nothing: the member counts as in the foreground.
        live.put(id, new Live(f.optBoolean("foreground", true), time(f, "lastSeen")));
    }

    private void setHeld(JSONObject f) {
        String id = f.optString("peerId");
        if (id.isEmpty()) return;
        live.remove(id);
        synchronized (held) { held.remove(id); held.put(id, new Held(id, f.optString("name"), ref(f), time(f, "lastSeen"), time(f, "since"))); }
    }

    /** A frame from the server; never throws. */
    void onFrame(JSONObject f) {
        try {
            switch (f.optString("type")) {
                case "joined": {
                    live.clear();
                    synchronized (held) { held.clear(); }
                    away.clear();
                    JSONArray peers = f.optJSONArray("peers"), gone = f.optJSONArray("held"), aw = f.optJSONArray("away");
                    if (peers != null) for (int i = 0; i < peers.length(); i++) { JSONObject p = peers.optJSONObject(i); if (p != null) setLive(p); }
                    if (gone != null) for (int i = 0; i < gone.length(); i++) { JSONObject h = gone.optJSONObject(i); if (h != null) setHeld(h); }
                    if (aw != null) for (int i = 0; i < aw.length(); i++) {
                        JSONObject a = aw.optJSONObject(i);
                        if (a != null && !ref(a).isEmpty()) away.put(ref(a), time(a, "lastSeen") > 0 ? time(a, "lastSeen") : time(a, "since"));
                    }
                    break;
                }
                case "peer-joined": setLive(f); break;
                case "peer-presence": {
                    String id = f.optString("peerId");
                    if (!id.isEmpty()) live.put(id, new Live(f.optBoolean("foreground"), time(f, "lastSeen")));
                    break;
                }
                case "peer-left": {
                    if (f.optBoolean("held")) { setHeld(f); break; }
                    String id = f.optString("peerId");
                    live.remove(id);
                    synchronized (held) { held.remove(id); }
                    break;
                }
                case "peer-away": {
                    String r = ref(f);
                    long seen = time(f, "lastSeen") > 0 ? time(f, "lastSeen") : time(f, "since");
                    if (!r.isEmpty()) away.put(r, seen > 0 ? seen : System.currentTimeMillis());
                    break;
                }
                case "peer-back": case "peer-gone": away.remove(ref(f)); break;
                default: break;
            }
        } catch (RuntimeException ignored) { }
    }

    /** A live member's presence; null when the server said nothing of it. */
    Live live(String peerId) { return live.get(peerId); }

    /** When a relay-covered member was last seen; 0 when not known. */
    long awayLastSeen(String account) { Long v = away.get(account); return v == null ? 0 : v; }

    /** Held members to list — not those listed already: live peers, or the relay's entry for the same account. */
    List<Held> held(Collection<String> peerIds, Collection<String> awayAccounts) {
        List<Held> out = new ArrayList<>();
        synchronized (held) {
            for (Held h : held.values()) {
                if (peerIds.contains(h.peerId) || (!h.account.isEmpty() && awayAccounts.contains(h.account))) continue;
                out.add(h);
            }
        }
        return out;
    }
}
