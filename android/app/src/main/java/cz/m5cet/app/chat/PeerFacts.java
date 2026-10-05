package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import cz.m5cet.app.contacts.Match;
import cz.m5cet.app.contacts.RtcStats;

/**
 * 6.2 People: what a room knows of its people beyond the peers themselves —
 * the username each hello claims, which connections the server says are
 * signed in (a room-scoped account reference, never the account itself), the
 * signed-in members who are away (the server holds their messages), when a
 * peer's channel opened, and the connection's statistics. Written on the
 * room's thread (frames, hellos) and by stats callbacks, read by the UI.
 */
final class PeerFacts {
    static final class Facts {
        volatile String username = "";
        volatile long since = 0;
        /** An app / platform name, if the hello carries one (web and Android hellos do not yet). */
        volatile String app = "";
        volatile RtcStats.Summary stats;
    }

    static final class Away {
        final String account, name;
        final long since;
        Away(String account, String name, long since) { this.account = account; this.name = name; this.since = since; }
    }

    private final Map<String, Facts> peers = new ConcurrentHashMap<>();
    /** peer id → the account reference the server gave for its connection. */
    private final Map<String, String> accounts = new ConcurrentHashMap<>();
    /** account reference → a signed-in member who is away. */
    private final Map<String, Away> away = new ConcurrentHashMap<>();
    /** account reference → the username its hello named (so an away member keeps it). */
    private final Map<String, String> users = new ConcurrentHashMap<>();
    /** When this device joined the room (last "joined"). */
    volatile long joinedAt = 0;
    /** 6.12 (§ 13): peer id → did its join prove the room key to the server (absent: a server before 6.12 says nothing). */
    private final Map<String, Boolean> proven = new ConcurrentHashMap<>();

    /** 6.12: the server's word on whether this peer proved the room key; null when the server does not say. */
    Boolean proven(String peerId) { return proven.get(peerId); }

    private void noteProven(JSONObject p) {
        String id = p.optString("peerId");
        if (id.isEmpty()) return;
        Object v = p.opt("proven");
        if (v instanceof Boolean) proven.put(id, (Boolean) v); else proven.remove(id);
    }

    Facts get(String peerId) { return peers.get(peerId); }

    private Facts of(String peerId) { return peers.computeIfAbsent(peerId, k -> new Facts()); }

    /** The account reference of a peer's connection, "" for a guest. */
    String account(String peerId) { String a = accounts.get(peerId); return a == null ? "" : a; }

    String userOf(String account) { String u = users.get(account); return u == null ? "" : u; }

    List<Away> away() { return new ArrayList<>(away.values()); }

    void stats(String peerId, RtcStats.Summary s) { if (peers.containsKey(peerId)) of(peerId).stats = s; }

    /** `account` (protocol 2) or its alias `accountId`; "" when absent or null. */
    private static String ref(JSONObject f) {
        Object v = f.opt("account");
        if (v instanceof String && !((String) v).isEmpty()) return (String) v;
        v = f.opt("accountId");
        return v instanceof String ? (String) v : "";
    }

    /** A frame from the server (before the room handles it); never throws. */
    void onFrame(JSONObject f) {
        try {
            switch (f.optString("type")) {
                case "joined": {
                    joinedAt = System.currentTimeMillis();
                    accounts.clear();
                    away.clear();
                    proven.clear();
                    JSONArray list = f.optJSONArray("peers");
                    if (list != null) for (int i = 0; i < list.length(); i++) {
                        JSONObject p = list.optJSONObject(i);
                        if (p != null && !ref(p).isEmpty()) accounts.put(p.optString("peerId"), ref(p));
                        if (p != null) noteProven(p);
                    }
                    JSONArray gone = f.optJSONArray("away");
                    if (gone != null) for (int i = 0; i < gone.length(); i++) {
                        JSONObject a = gone.optJSONObject(i);
                        if (a != null && !ref(a).isEmpty()) away.put(ref(a), new Away(ref(a), a.optString("name"), a.optLong("since")));
                    }
                    break;
                }
                case "peer-joined": case "peer-updated": {
                    String id = f.optString("peerId"), r = ref(f);
                    if (id.isEmpty()) break;
                    if ("peer-joined".equals(f.optString("type"))) noteProven(f);
                    if (r.isEmpty()) accounts.remove(id); else accounts.put(id, r);
                    Facts x = peers.get(id);
                    if (!r.isEmpty() && x != null && !x.username.isEmpty()) users.put(r, x.username);
                    break;
                }
                case "peer-away": {
                    String r = ref(f);
                    if (!r.isEmpty()) away.put(r, new Away(r, f.optString("name"), f.optLong("since", System.currentTimeMillis())));
                    break;
                }
                case "peer-back": case "peer-gone": away.remove(ref(f)); break;
                case "peer-left": {
                    String id = f.optString("peerId");
                    peers.remove(id);
                    accounts.remove(id);
                    proven.remove(id);
                    break;
                }
                default: break;
            }
        } catch (RuntimeException ignored) { }
    }

    /** An accepted hello: the username it names (a claim, like the nickname), the time the channel opened. */
    void onHello(String peerId, JSONObject hello) {
        try {
            Facts x = of(peerId);
            x.username = Match.cleanUsername(hello.opt("user"));
            if (x.since == 0) x.since = System.currentTimeMillis();
            Object app = hello.opt("app");
            if (app instanceof String) x.app = ((String) app).length() > 60 ? ((String) app).substring(0, 60) : (String) app;
            String r = account(peerId);
            if (!r.isEmpty() && !x.username.isEmpty()) users.put(r, x.username);
        } catch (RuntimeException ignored) { }
    }
}
