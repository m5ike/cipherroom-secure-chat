package cz.m5cet.app.security;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.net.URL;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;

/**
 * Erases everything the app keeps: the encrypted stores, bundles, caches,
 * preferences, databases and every Keystore key (without the keys, any copy
 * of the files is noise). Before that it signs one last event for the server
 * — while the device key still exists — and keeps just that request, which
 * holds no secret, until it could be delivered.
 */
public final class Wiper {
    private Wiper() {}

    private static File pending(Context ctx) { return new File(ctx.getNoBackupFilesDir(), "pending-wipe.json"); }

    public static void wipe(M5 app, String reason, boolean remote, int attempts) {
        Log.w("wipe", "wiping all local data: " + reason);
        try {
            if (app.config.enrolled()) {
                JSONObject event = new JSONObject().put("id", Crypto.b64url(Crypto.random(12))).put("type", remote ? "remote-wipe" : "wipe")
                    .put("at", System.currentTimeMillis()).put("detail", new JSONObject().put("reason", reason).put("attempts", attempts));
                byte[] body = Crypto.utf8(new JSONObject().put("events", new JSONArray().put(event)).toString());
                String base = app.config.server();
                String path = new URL(base).getPath() + "/api/android/events";
                JSONObject headers = Server.signHeaders(app.config.deviceId(), "POST", path, body, System.currentTimeMillis());
                JSONObject request = new JSONObject().put("url", base + "/api/android/events").put("headers", headers).put("body", Crypto.b64(body));
                Vault.writeAtomic(pending(app), Crypto.utf8(request.toString()));
            }
        } catch (Exception e) {
            Log.e("wipe", "the wipe event could not be prepared", e);
        }
        try { app.rooms.disconnectAll(); } catch (Throwable ignored) { }
        app.vault.lock();
        Log.clear();
        Keystore.deleteAll();
        File keep = pending(app);
        deleteTree(app.getNoBackupFilesDir(), keep);
        deleteTree(app.getFilesDir(), keep);
        deleteTree(app.getCacheDir(), keep);
        File data = app.getFilesDir().getParentFile();
        if (data != null) {
            deleteTree(new File(data, "shared_prefs"), keep);
            deleteTree(new File(data, "databases"), keep);
        }
        File ext = app.getExternalFilesDir(null);
        if (ext != null) deleteTree(ext, keep);
        sendPending(app);
    }

    private static void deleteTree(File f, File keep) {
        if (f == null || !f.exists() || f.equals(keep)) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k, keep);
        if (!f.equals(keep.getParentFile())) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    public static boolean hasPending(Context ctx) { return pending(ctx).exists(); }

    /** Delivers the last event of a wiped device (retried on every start). */
    public static void sendPending(Context ctx) {
        File f = pending(ctx);
        if (!f.exists()) return;
        Io.bg(() -> {
            try {
                JSONObject r = new JSONObject(Crypto.str(Vault.read(f)));
                Server.send(r.getString("url"), "POST", Crypto.unb64(r.getString("body")), r.getJSONObject("headers"), null, 1 << 16);
                //noinspection ResultOfMethodCallIgnored
                f.delete();
                android.util.Log.i("m5/wipe", "the wipe was reported to the server");
            } catch (Server.HttpError e) {
                // The server refused it for good (e.g. an unknown device): nothing to retry.
                if (e.status >= 400 && e.status < 500 && e.status != 429) //noinspection ResultOfMethodCallIgnored
                    f.delete();
            } catch (Exception e) {
                android.util.Log.i("m5/wipe", "reporting the wipe later: " + e.getMessage());
            }
        });
    }
}
