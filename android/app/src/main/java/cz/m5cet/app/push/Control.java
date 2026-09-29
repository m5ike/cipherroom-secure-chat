package cz.m5cet.app.push;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;
import cz.m5cet.app.security.Ecies;
import cz.m5cet.app.security.Vault;
import cz.m5cet.app.security.Wiper;

/**
 * The server's control messages (docs/android-architecture.md §1.8): the
 * same wire form whether FCM brought them or the check-in did. Each is
 * checked (the server's signature with the pinned key), opened (ECIES with
 * this device's key), deduplicated, checked for expiry, carried out and
 * acknowledged.
 */
public final class Control {
    private final M5 app;

    public Control(M5 app) { this.app = app; }

    private boolean seen(String id) {
        JSONObject s = app.vault.json(Vault.Tier.SYS, "seen");
        JSONArray ids = s.optJSONArray("ids");
        if (ids == null) ids = new JSONArray();
        for (int i = 0; i < ids.length(); i++) if (id.equals(ids.optString(i))) return true;
        ids.put(id);
        while (ids.length() > 300) ids.remove(0);
        try { app.vault.putJson(Vault.Tier.SYS, "seen", new JSONObject().put("ids", ids)); } catch (JSONException ignored) { }
        return false;
    }

    public void handle(JSONObject wire, String via) {
        String id = wire.optString("i");
        String deviceId = app.config.deviceId();
        if (id.isEmpty() || deviceId.isEmpty()) return;
        String signed = "m5push/1|" + deviceId + "|" + id + "|" + wire.optString("e") + "|" + wire.optString("iv") + "|" + wire.optString("ct");
        if (!Ec.verify(app.config.serverKey(), Crypto.utf8(signed), wire.optString("s"))) {
            Log.w("control", "message " + id + " is not signed by the server — dropped");
            return;
        }
        JSONObject content;
        try {
            content = new JSONObject(Crypto.str(Ecies.open(app.config.encPrivateKey(), deviceId, "push", new Ecies.Wire(wire.optString("e"), wire.optString("iv"), wire.optString("ct")))));
        } catch (GeneralSecurityException | JSONException e) {
            Log.w("control", "message " + id + " cannot be opened: " + e.getMessage());
            return;
        }
        if (!id.equals(content.optString("id"))) { Log.w("control", "message id mismatch"); return; }
        if (seen(id)) return;
        if (content.optLong("exp") > 0 && content.optLong("exp") < System.currentTimeMillis()) { Log.i("control", "message " + id + " expired"); return; }
        String kind = content.optString("kind");
        JSONObject payload = content.optJSONObject("payload");
        if (payload == null) payload = new JSONObject();
        Log.i("control", kind + " via " + via);
        try {
            switch (kind) {
                case "ping": ack(id, true, new JSONObject().put("state", app.checkin.state()).put("via", via), null); break;
                case "status": {
                    JSONObject r = new JSONObject().put("state", app.checkin.state()).put("bundle", app.bundles.report()).put("via", via);
                    String logs = app.config.policy().optString("logs", "errors");
                    if (payload.optBoolean("logs") && !"off".equals(logs)) r.put("log", cz.m5cet.app.core.Log.tail(200, "errors".equals(logs)));
                    ack(id, true, r, null);
                    break;
                }
                case "flash": {
                    app.notify.flash(payload.optString("title"), payload.optString("text"), payload.optString("level", "info"));
                    ack(id, true, new JSONObject().put("shown", app.inForeground() ? "app" : "notification"), null);
                    break;
                }
                case "push": {
                    app.notify.push(payload.optString("title"), payload.optString("body"), payload.optString("room"), payload.optString("url"));
                    ack(id, true, new JSONObject().put("shown", true), null);
                    break;
                }
                case "update":
                case "config":
                    ack(id, true, new JSONObject().put("checking", true), null);
                    Io.bg(() -> app.checkin.run(kind));
                    break;
                case "lock":
                    Io.main(() -> app.lock.lockNow(true));
                    ack(id, true, new JSONObject().put("locked", true), null);
                    break;
                case "wipe":
                    // Acknowledge first: afterwards the device key is gone.
                    ack(id, true, new JSONObject().put("wiping", true), null);
                    Io.main(() -> { Wiper.wipe(app, payload_reason(content), true, 0); app.onWiped(); });
                    break;
                default:
                    ack(id, false, null, "unknown kind " + kind);
            }
        } catch (JSONException e) {
            Log.e("control", "cannot answer " + kind, e);
        }
    }

    private static String payload_reason(JSONObject content) {
        JSONObject p = content.optJSONObject("payload");
        String r = p == null ? "" : p.optString("reason");
        return r.isEmpty() ? "remote" : "remote: " + r;
    }

    private void ack(String id, boolean ok, JSONObject result, String error) {
        try { app.server.ack(id, ok, result, error); }
        catch (Exception e) { Log.w("control", "the answer to " + id + " waits: " + e.getMessage()); }
    }
}
