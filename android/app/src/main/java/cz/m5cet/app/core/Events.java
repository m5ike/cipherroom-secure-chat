package cz.m5cet.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Vault;

/**
 * Events for the server (security, updates, crashes): queued encrypted in
 * the system tier (record "events"), sent in batches over the signed API,
 * kept until the server has them. Each has its own id, so a retry is never
 * counted twice.
 */
public final class Events {
    private static final int KEEP = 500;
    private final M5 app;
    private boolean sending;

    public Events(M5 app) { this.app = app; }

    public void add(String type, JSONObject detail) {
        try {
            JSONObject e = new JSONObject().put("id", Crypto.b64url(Crypto.random(12))).put("type", type).put("at", System.currentTimeMillis()).put("detail", detail == null ? new JSONObject() : detail);
            synchronized (this) {
                JSONArray list = pending();
                list.put(e);
                while (list.length() > KEEP) list.remove(0);
                app.vault.putJson(Vault.Tier.SYS, "events", new JSONObject().put("list", list));
            }
            Log.i("event", type + " " + (detail == null ? "" : detail.toString()));
        } catch (JSONException ex) {
            Log.e("event", "cannot queue " + type, ex);
        }
        Io.later(this::flush, 1500);
    }

    public static JSONObject detail(Object... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]); } catch (JSONException ignored) { }
        return o;
    }

    private JSONArray pending() {
        JSONArray list = app.vault.json(Vault.Tier.SYS, "events").optJSONArray("list");
        return list != null ? list : new JSONArray();
    }

    /** Sends what is queued (one batch at a time); quietly waits for the next chance when offline. */
    public void flush() {
        JSONArray batch;
        synchronized (this) {
            if (sending || !app.config.enrolled()) return;
            JSONArray list = pending();
            if (list.length() == 0) return;
            batch = new JSONArray();
            for (int i = 0; i < Math.min(100, list.length()); i++) batch.put(list.opt(i));
            sending = true;
        }
        try {
            app.server.events(batch);
            synchronized (this) {
                JSONArray list = pending();
                JSONArray rest = new JSONArray();
                java.util.Set<String> sent = new java.util.HashSet<>();
                for (int i = 0; i < batch.length(); i++) sent.add(batch.optJSONObject(i).optString("id"));
                for (int i = 0; i < list.length(); i++) if (!sent.contains(list.optJSONObject(i).optString("id"))) rest.put(list.opt(i));
                app.vault.putJson(Vault.Tier.SYS, "events", new JSONObject().put("list", rest));
                if (rest.length() > 0) Io.later(this::flush, 500);
            }
        } catch (Exception e) {
            Log.d("event", "sending events later: " + e.getMessage());
        } finally {
            synchronized (this) { sending = false; }
        }
    }
}
