package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;

import cz.m5cet.app.M5;
import cz.m5cet.app.security.Vault;

/**
 * 6.7: each room's peer id and resume secret (the server's `joined`), kept
 * in the vault — when Android ends the process in the background, the app
 * comes back as the same member (the server kept it listed as away), not as
 * a second one. The secret only lets this device take its own place back.
 */
final class Resume {
    private Resume() {}

    private static final String RECORD = "resume";
    private static final int MAX = 64;

    /** {peerId, secret} of a room, or null. */
    static String[] load(M5 app, String key) {
        if (!app.vault.unlocked()) return null;
        JSONObject e = app.vault.json(Vault.Tier.USER, RECORD).optJSONObject(key);
        if (e == null || e.optString("peerId").isEmpty() || e.optString("secret").isEmpty()) return null;
        return new String[] { e.optString("peerId"), e.optString("secret") };
    }

    static void save(M5 app, String key, String peerId, String secret) {
        if (peerId.isEmpty() || secret.isEmpty()) return;
        // 6.12 (F-16): locked (a reconnect while locked) — kept for the unlock in the lock inbox.
        if (!app.vault.unlocked()) { if (LockedRooms.active()) LockedRooms.resume(key, peerId, secret); return; }
        JSONObject all = app.vault.json(Vault.Tier.USER, RECORD);
        try {
            JSONObject old = all.optJSONObject(key);
            if (old != null && peerId.equals(old.optString("peerId")) && secret.equals(old.optString("secret"))) return;
            all.remove(key);
            all.put(key, new JSONObject().put("peerId", peerId).put("secret", secret).put("at", System.currentTimeMillis()));
            // Rooms long gone: the oldest go first.
            while (all.length() > MAX) {
                String oldest = null;
                long at = Long.MAX_VALUE;
                for (Iterator<String> it = all.keys(); it.hasNext(); ) {
                    String k = it.next();
                    long t = all.optJSONObject(k) == null ? 0 : all.optJSONObject(k).optLong("at");
                    if (t < at) { at = t; oldest = k; }
                }
                if (oldest == null) break;
                all.remove(oldest);
            }
        } catch (JSONException ignored) { return; }
        app.vault.putJson(Vault.Tier.USER, RECORD, all);
    }
}
