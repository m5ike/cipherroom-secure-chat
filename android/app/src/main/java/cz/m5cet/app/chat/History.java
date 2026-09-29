package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.Vault;

/**
 * The message log of each room: the last messages, encrypted in the user
 * tier (record "hist-<hash of the room>"), written a moment after a change
 * and when the app goes to the background. Nothing of it is readable before
 * the PIN or a biometric unlock opens the user key.
 */
public final class History {
    private History() {}

    static final int KEEP = 300;
    private static final Map<String, ScheduledFuture<?>> pending = new ConcurrentHashMap<>();

    private static String record(String key) { return "hist-" + Rooms.hashKey(key); }

    static List<ChatMessage> load(M5 app, String key) {
        List<ChatMessage> out = new ArrayList<>();
        JSONArray arr = app.vault.json(Vault.Tier.USER, record(key)).optJSONArray("m");
        if (arr != null) for (int i = 0; i < arr.length(); i++) { JSONObject o = arr.optJSONObject(i); if (o != null) out.add(ChatMessage.fromJson(o)); }
        return out;
    }

    static void save(M5 app, String key, List<ChatMessage> messages) {
        if (!app.vault.unlocked()) return;
        JSONArray arr = new JSONArray();
        int from = Math.max(0, messages.size() - KEEP);
        for (int i = from; i < messages.size(); i++) { ChatMessage m = messages.get(i); if (!"sys".equals(m.kind)) arr.put(m.toJson()); }
        try { app.vault.putJson(Vault.Tier.USER, record(key), new JSONObject().put("m", arr)); }
        catch (JSONException e) { Log.e("history", "cannot save", e); }
    }

    static void saveSoon(M5 app, String key, RoomSession r) {
        ScheduledFuture<?> old = pending.put(key, Io.later(() -> { pending.remove(key); save(app, key, r.messagesCopy()); }, 2000));
        if (old != null) old.cancel(false);
    }

    static void delete(M5 app, String key) { app.vault.delete(Vault.Tier.USER, record(key)); }
}
