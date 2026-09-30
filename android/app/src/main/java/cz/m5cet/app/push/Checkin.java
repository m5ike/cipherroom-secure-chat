package cz.m5cet.app.push;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.Vault;

/**
 * The check-in: this device's state to the server, the policy, pending
 * control messages, the newest bundle and release back. Runs when the app
 * comes to the front (at most every few minutes), when FCM says "update",
 * and — without FCM — as a JobScheduler job with a network constraint at
 * the policy's interval (15 min at the least), which the system batches with
 * other work: the smallest cost in battery and data.
 */
public final class Checkin {
    private static final int JOB_ID = 5501;
    private final M5 app;
    private final Control control;
    private volatile long last = 0;

    public Checkin(M5 app) { this.app = app; this.control = new Control(app); }

    public Control control() { return control; }

    public static void schedule(Context ctx) {
        M5 app = M5.get();
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js == null || !app.config.enrolled()) return;
        long period = app.push.enabled() ? 12L * 3600_000L : app.config.pollSeconds() * 1000L;
        JobInfo existing = js.getPendingJob(JOB_ID);
        if (existing != null && existing.getIntervalMillis() == period) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, Job.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(Math.max(JobInfo.getMinPeriodMillis(), period))
            .setPersisted(true)
            .build();
        js.schedule(job);
        Log.i("checkin", "check-in every " + period / 60_000 + " min (" + (app.push.enabled() ? "FCM" : "polling") + ")");
    }

    public void runIfDue(boolean force) {
        if (force || System.currentTimeMillis() - last > 5 * 60_000) run("foreground");
    }

    public JSONObject state() {
        JSONObject s = new JSONObject();
        try {
            Intent battery = app.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                s.put("battery", level < 0 ? -1 : Math.round(level * 100f / scale));
                int plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                s.put("charging", plugged != 0);
            }
            ConnectivityManager cm = app.getSystemService(ConnectivityManager.class);
            NetworkCapabilities caps = cm == null ? null : cm.getNetworkCapabilities(cm.getActiveNetwork());
            s.put("network", caps == null ? "none" : caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi" : caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cellular" : caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet" : "other");
            s.put("locked", app.lock.isLocked());
            s.put("rooms", app.rooms.connectedCount());
            s.put("bundle", app.bundles.report());
            s.put("push", app.push.enabled() ? "fcm" : "poll");
            s.put("lockMode", app.lock.biometricAvailable() ? "biometric" : app.lock.isSetUp() ? "pin" : "none");
            s.put("failedAttempts", app.lock.attempts());
            s.put("storage", folderSize(app.vault.dir()));
            JSONArray perms = new JSONArray();
            for (String p : new String[]{"android.permission.POST_NOTIFICATIONS", "android.permission.RECORD_AUDIO", "android.permission.CAMERA", "android.permission.WRITE_CALL_LOG"}) {
                if (app.checkSelfPermission(p) == android.content.pm.PackageManager.PERMISSION_GRANTED) perms.put(p.substring(p.lastIndexOf('.') + 1));
            }
            s.put("permissions", perms);
        } catch (JSONException ignored) { }
        return s;
    }

    private static long folderSize(java.io.File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long n = 0;
        java.io.File[] kids = f.listFiles();
        if (kids != null) for (java.io.File k : kids) n += folderSize(k);
        return n;
    }

    /** One check-in; safe to call from any thread (not the main one). */
    /** When the last check-in succeeded (0 = not in this run of the app). */
    public long lastAt() { return last; }

    public synchronized boolean run(String why) {
        if (!app.config.enrolled()) return false;
        try {
            JSONObject body = new JSONObject()
                .put("appVersion", BuildConfig.VERSION_NAME).put("appCode", BuildConfig.VERSION_CODE)
                .put("sdk", android.os.Build.VERSION.SDK_INT).put("locale", app.lang())
                .put("state", state());
            if (!app.push.token().isEmpty()) body.put("fcmToken", app.push.token());
            JSONObject answer = app.server.checkin(body);
            last = System.currentTimeMillis();
            boolean hadFcm = app.config.fcm() != null;
            app.config.applyServerAnswer(answer);
            app.config.save();
            if (!hadFcm && app.config.fcm() != null) app.push.init();
            JSONArray commands = answer.optJSONArray("commands");
            if (commands != null) for (int i = 0; i < commands.length(); i++) control.handle(commands.getJSONObject(i), "checkin");
            if (!answer.isNull("bundle")) app.bundles.available(answer.optJSONObject("bundle"));
            app.releases.onCheckin(answer.isNull("release") ? null : answer.optJSONObject("release"));
            app.define.refresh(); // 6.3 define: pull the operator's typed values (own endpoint), keep the cache on failure
            app.events.flush();
            schedule(app);
            Log.d("checkin", "done (" + why + ")");
            app.emit("checkin");
            return true;
        } catch (cz.m5cet.app.net.Server.HttpError e) {
            Log.w("checkin", "refused: " + e.status + " " + e.getMessage());
            if (e.status == 403 && e.code.startsWith("device-")) app.emit("device-" + e.code.substring(7));
            return false;
        } catch (Exception e) {
            Log.d("checkin", "not now: " + e.getMessage());
            return false;
        }
    }

    /** The periodic job. */
    public static final class Job extends JobService {
        @Override public boolean onStartJob(JobParameters params) {
            Io.bg(() -> {
                boolean ok = M5.get().checkin.run("job");
                jobFinished(params, !ok);
            });
            return true;
        }
        @Override public boolean onStopJob(JobParameters params) { return true; }
    }

    static { Vault.class.getName(); }
}
