package cz.m5cet.app.ui.bubble;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.security.Vault;

/**
 * Hiding and deleting a message goes into the operator's audit journal
 * (6.2): POST /api/android/message-audit, signed by the device key like the
 * positions (server/message-audit.ts). It says only THAT it happened — the
 * action, the message's id, the room as the server knows it (it hashes it),
 * the kinds, whether it was mine, until when — never the text or the file.
 * Waiting actions are kept in the vault (user tier) and sent again later.
 */
public final class MessageAudit {
    private MessageAudit() {}

    private static final String RECORD = "msg-audit";
    private static final int MAX = 200;
    private static final long KEEP_MS = 7 * 86_400_000L; // the server takes device times up to a week back
    private static final Object LOCK = new Object();
    private static volatile boolean sending;

    /** One action; until = a hide's end (ms), 0 = until the next sign-in (and for unhide / delete). Kept at once, sent in the background. */
    public static void add(M5 app, String action, RoomSession r, ChatMessage m, long until) {
        JSONObject a;
        try {
            a = entry(action, m, r.roomId(), until, System.currentTimeMillis());
            a.put("roomKey", r.key); // this device's, to find the room's id later; dropped before sending
        } catch (JSONException e) { Log.w("audit", "not queued: " + e.getMessage()); return; }
        Io.bg(() -> {
            synchronized (LOCK) {
                JSONArray q = queue(app);
                q.put(a);
                while (q.length() > MAX) q.remove(0);
                save(app, q);
            }
            flush(app);
        });
    }

    /** The body's action as the server checks it (sanitizeMessageAudit). */
    static JSONObject entry(String action, ChatMessage m, String room, long until, long at) throws JSONException {
        JSONObject a = new JSONObject().put("action", action).put("messageId", m.id).put("room", room)
            .put("kinds", new JSONArray(Kinds.of(m))).put("mine", m.mine).put("at", at);
        if ("hide".equals(action)) a.put("until", Math.max(0, until));
        return a;
    }

    /** Sends what waits (a batch of up to 50); what the network kept back stays for the next time. */
    public static void flush(M5 app) {
        if (sending || !app.vault.unlocked()) return;
        sending = true;
        Io.bg(() -> {
            try { send(app); }
            finally { sending = false; }
        });
    }

    private static void send(M5 app) {
        JSONArray batch = new JSONArray();
        int taken;
        synchronized (LOCK) {
            if (!app.vault.unlocked()) return;
            JSONArray q = queue(app), keep = new JSONArray();
            long now = System.currentTimeMillis();
            for (int i = 0; i < q.length(); i++) {
                JSONObject a = q.optJSONObject(i);
                if (a == null || now - a.optLong("at") > KEEP_MS) continue;
                if (a.optString("room").isEmpty()) {
                    RoomSession r = app.rooms.session(a.optString("roomKey"));
                    String id = r == null ? "" : r.roomId();
                    if (!id.isEmpty()) try { a.put("room", id); } catch (JSONException ignored) { }
                    else if (now - a.optLong("at") > 600_000) try { a.put("room", "local"); } catch (JSONException ignored) { } // the room never connected
                }
                keep.put(a);
            }
            save(app, keep);
            for (int i = 0; i < keep.length() && batch.length() < 50; i++) {
                JSONObject a = keep.optJSONObject(i);
                if (a.optString("room").isEmpty()) break; // in order: wait for the room's id
                try {
                    JSONObject out = new JSONObject(a.toString());
                    out.remove("roomKey");
                    batch.put(out);
                } catch (JSONException ignored) { }
            }
            taken = batch.length();
        }
        if (taken == 0) return;
        try {
            JSONObject body = new JSONObject().put("actions", batch);
            String account = app.accountName();
            if (account.matches("[A-Za-z0-9_.-]{1,64}")) body.put("account", account);
            app.server.signed("POST", "/api/android/message-audit", body, null, 64 * 1024);
            drop(app, batch);
        } catch (Server.HttpError e) {
            if (e.status == 400) drop(app, batch); // the server will never take these
            Log.w("audit", "message actions not recorded: " + e.getMessage());
        } catch (Exception e) {
            Log.w("audit", "message actions wait: " + e.getMessage());
        }
    }

    private static String id(JSONObject a) { return a.optString("action") + "|" + a.optString("messageId") + "|" + a.optLong("at"); }

    private static void drop(M5 app, JSONArray sent) {
        java.util.Set<String> gone = new java.util.HashSet<>();
        for (int i = 0; i < sent.length(); i++) gone.add(id(sent.optJSONObject(i)));
        synchronized (LOCK) {
            JSONArray q = queue(app), rest = new JSONArray();
            for (int i = 0; i < q.length(); i++) { JSONObject a = q.optJSONObject(i); if (a != null && !gone.contains(id(a))) rest.put(a); }
            save(app, rest);
        }
    }

    private static JSONArray queue(M5 app) {
        JSONArray q = app.vault.json(Vault.Tier.USER, RECORD).optJSONArray("q");
        return q == null ? new JSONArray() : q;
    }

    private static void save(M5 app, JSONArray q) {
        try { app.vault.putJson(Vault.Tier.USER, RECORD, new JSONObject().put("q", q)); } catch (JSONException ignored) { }
    }
}
