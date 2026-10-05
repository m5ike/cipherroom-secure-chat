package cz.m5cet.app.security;

import android.app.ActivityManager;
import android.app.NotificationManager;
import android.app.job.JobScheduler;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

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

    public static void wipe(M5 app, String reason, boolean remote, int attempts) { wipe(app, reason, remote, attempts, false); }

    /**
     * quiet (6.12, the duress PIN): the next start shows the empty app without
     * the "data erased" notice (pendingQuiet) — the server still hears of it.
     */
    public static void wipe(M5 app, String reason, boolean remote, int attempts, boolean quiet) {
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
                if (quiet) request.put("quiet", true);
                Vault.writeAtomic(pending(app), Crypto.utf8(request.toString()));
            }
        } catch (Exception e) {
            Log.e("wipe", "the wipe event could not be prepared", e);
        }
        // 6.8: the app's calls leave the phone's call log, its calling account Telecom, its call history the vault.
        try { cz.m5cet.app.telecom.CallLogBridge.wipe(app); } catch (Throwable ignored) { }
        try { app.rooms.disconnectAll(); } catch (Throwable ignored) { }
        teardown(app);
        // 6.2: the M5cet rows in the phone's address book (usernames of linked people) and our account go too —
        // also for a remote wipe, when no screen is there to do it.
        try { cz.m5cet.app.contacts.AddressBook.removeAll(app); } catch (Throwable ignored) { }
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
        }        File ext = app.getExternalFilesDir(null);
        if (ext != null) deleteTree(ext, keep);
        if (remote) endAfterReport(app);
        else sendPending(app); // a local wipe: the screen says so, then app.restart() ends the process
    }

    /**
     * 6.7 (audit S12): nothing of the wiped data stays on show or running —
     * notifications (room names, senders), the rooms' conversation shortcuts
     * (pinned ones cannot be removed by an app: they are renamed and
     * disabled), the call and location services, the NFC card emulation and
     * the scheduled check-ins.
     */
    static void teardown(M5 app) {
        try {
            NotificationManager nm = app.getSystemService(NotificationManager.class);
            if (nm != null) nm.cancelAll();
        } catch (Throwable t) { Log.w("wipe", "notifications: " + t.getMessage()); }
        try {
            ShortcutManager sm = app.getSystemService(ShortcutManager.class);
            if (sm != null) {
                List<String> ids = new ArrayList<>();
                for (ShortcutInfo si : sm.getDynamicShortcuts()) ids.add(si.getId());
                sm.removeAllDynamicShortcuts();
                if (Build.VERSION.SDK_INT >= 30) {
                    for (ShortcutInfo si : sm.getShortcuts(ShortcutManager.FLAG_MATCH_CACHED)) if (!ids.contains(si.getId())) ids.add(si.getId());
                    if (!ids.isEmpty()) sm.removeLongLivedShortcuts(ids);
                }
                List<ShortcutInfo> pinned = sm.getPinnedShortcuts();
                if (!pinned.isEmpty()) {
                    List<ShortcutInfo> renamed = new ArrayList<>();
                    List<String> pinnedIds = new ArrayList<>();
                    for (ShortcutInfo si : pinned) {
                        pinnedIds.add(si.getId());
                        renamed.add(new ShortcutInfo.Builder(app, si.getId()).setShortLabel("M5cet").setLongLabel("M5cet").build());
                    }
                    try { sm.updateShortcuts(renamed); } catch (RuntimeException ignored) { }
                    sm.disableShortcuts(pinnedIds);
                }
            }
        } catch (Throwable t) { Log.w("wipe", "shortcuts: " + t.getMessage()); }
        try { cz.m5cet.app.ui.CallService.stop(app); } catch (Throwable ignored) { }
        try { app.stopService(new Intent(app, cz.m5cet.app.location.LocationService.class)); } catch (Throwable ignored) { }
        try { cz.m5cet.app.nfc.CardService.stopServing(); } catch (Throwable ignored) { }
        try {
            JobScheduler js = app.getSystemService(JobScheduler.class);
            if (js != null) js.cancelAll();
        } catch (Throwable ignored) { }
    }

    /**
     * 6.7 (audit S12): after a remote wipe the process does not live on with
     * whatever it still holds in memory — the wipe is reported (at most a few
     * seconds), the app leaves the recent apps and the process ends.
     */
    private static void endAfterReport(M5 app) {
        Runnable end = () -> {
            try {
                ActivityManager am = app.getSystemService(ActivityManager.class);
                if (am != null) for (ActivityManager.AppTask t : am.getAppTasks()) t.finishAndRemoveTask();
            } catch (Throwable ignored) { }
            android.os.Process.killProcess(android.os.Process.myPid());
        };
        Io.mainLater(end, 8_000); // the report hangs: end anyway
        Io.bg(() -> {
            deliver(pending(app));
            Io.main(end);
        });
    }

    private static void deleteTree(File f, File keep) {
        if (f == null || !f.exists() || f.equals(keep)) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k, keep);
        if (!f.equals(keep.getParentFile())) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    public static boolean hasPending(Context ctx) { return pending(ctx).exists(); }

    /** 6.12: the pending report is of a quiet wipe (the duress PIN): no "data erased" notice. */
    public static boolean pendingQuiet(Context ctx) {
        File f = pending(ctx);
        if (!f.exists()) return false;
        try { return new JSONObject(Crypto.str(Vault.read(f))).optBoolean("quiet"); }
        catch (Exception e) { return false; }
    }

    /** Delivers the last event of a wiped device (retried on every start). */
    public static void sendPending(Context ctx) {
        File f = pending(ctx);
        if (!f.exists()) return;
        Io.bg(() -> deliver(f));
    }

    private static void deliver(File f) {
        if (!f.exists()) return;
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
    }
}
