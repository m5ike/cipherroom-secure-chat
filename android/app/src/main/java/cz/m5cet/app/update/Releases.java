package cz.m5cet.app.update;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;

import org.json.JSONObject;

import java.io.File;
import java.io.OutputStream;
import java.nio.file.Files;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.M5;
import cz.m5cet.app.core.Events;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;

/**
 * New versions of the app itself (APK releases): the server signs each
 * release (package, version, SHA-256, signing certificate); the app checks
 * that signature with the pinned key, the file's hash, and that the APK is
 * signed with the SAME certificate as the installed app — then hands it to
 * PackageInstaller, which asks the person to confirm. A failed install
 * leaves the running version untouched.
 */
public final class Releases {
    public interface Listener { void onRelease(String state, JSONObject release, double progress); }

    private final M5 app;
    private volatile Listener listener;
    private volatile JSONObject available;
    private volatile File ready;

    public Releases(M5 app) { this.app = app; }

    public void setListener(Listener l) { listener = l; }
    public JSONObject available() { return available; }
    public boolean isReady() { return ready != null && ready.exists(); }

    private void tell(String state, JSONObject r, double p) {
        Listener l = listener;
        if (l != null) Io.main(() -> l.onRelease(state, r, p));
    }

    public boolean onUnmeteredNetwork() {
        ConnectivityManager cm = app.getSystemService(ConnectivityManager.class);
        NetworkCapabilities caps = cm == null ? null : cm.getNetworkCapabilities(cm.getActiveNetwork());
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
    }

    public void onCheckin(JSONObject release) {
        if (release == null || release.optInt("versionCode") <= BuildConfig.VERSION_CODE) { available = null; return; }
        boolean isNew = available == null || !available.optString("id").equals(release.optString("id"));
        available = release;
        if (isNew) {
            app.events.add("update-available", Events.detail("kind", "release", "id", release.optString("id"), "version", release.optString("versionName")));
            app.notify.update(app.t("update.release"), release.optString("versionName"));
        }
        tell("available", release, 0);
    }

    private static String certOf(Signature[] signers) {
        return signers == null || signers.length == 0 ? "" : Crypto.hex(Crypto.sha256(signers[0].toByteArray()));
    }

    private String installedCert() throws PackageManager.NameNotFoundException {
        PackageInfo pi = app.getPackageManager().getPackageInfo(app.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        return pi.signingInfo == null ? "" : certOf(pi.signingInfo.getApkContentsSigners());
    }

    /** Downloads and checks everything; the file is then ready to install. */
    public void download() {
        JSONObject r = available;
        if (r == null) return;
        String id = r.optString("id");
        Io.bg(() -> {
            try {
                tell("downloading", r, 0);
                JSONObject answer = app.server.release(id);
                JSONObject rel = answer.getJSONObject("release");
                String signed = answer.getString("signed");
                String expected = "m5release/1|" + rel.getString("id") + "|" + rel.getInt("versionCode") + "|" + rel.getString("versionName") + "|" + rel.getString("packageName") + "|" + rel.getString("apkSha256") + "|" + rel.getString("certSha256") + "|" + rel.getLong("size");
                if (!expected.equals(signed) || !Ec.verify(app.config.serverKey(), Crypto.utf8(signed), answer.getString("signature"))) throw new SecurityException("the release is not signed by the server");
                if (!app.getPackageName().equals(rel.getString("packageName"))) throw new SecurityException("the release is for another app");
                String mine = installedCert();
                if (!mine.equalsIgnoreCase(rel.getString("certSha256"))) throw new SecurityException("the release is signed with another certificate than this app");
                byte[] apk = app.server.apk(id, (done, total) -> tell("downloading", r, total > 0 ? (double) done / total : 0));
                if (!Crypto.hex(Crypto.sha256(apk)).equalsIgnoreCase(rel.getString("apkSha256"))) throw new SecurityException("the APK does not match the release");
                File f = new File(app.getCacheDir(), "update.apk");
                Files.write(f.toPath(), apk);
                PackageInfo pi = app.getPackageManager().getPackageArchiveInfo(f.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
                if (pi == null || !app.getPackageName().equals(pi.packageName) || pi.signingInfo == null || !mine.equalsIgnoreCase(certOf(pi.signingInfo.getApkContentsSigners()))) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                    throw new SecurityException("the APK itself is not this app, signed by the same key");
                }
                ready = f;
                Log.i("release", "release " + rel.getString("versionName") + " is ready to install");
                tell("ready", r, 1);
            } catch (Exception e) {
                Log.e("release", "release " + id + " refused", e);
                app.events.add("update-failed", Events.detail("kind", "release", "id", id, "error", String.valueOf(e.getMessage())));
                tell("failed", r, 0);
            }
        });
    }

    /** Streams the checked APK into a PackageInstaller session (the system asks the person). */
    public void install(Context ctx) {
        File f = ready;
        if (f == null || !f.exists()) return;
        Io.bg(() -> {
            try {
                PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(ctx.getPackageName());
                if (android.os.Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                int sessionId = pi.createSession(params);
                try (PackageInstaller.Session session = pi.openSession(sessionId)) {
                    try (OutputStream out = session.openWrite("m5cet.apk", 0, f.length())) {
                        Files.copy(f.toPath(), out);
                        session.fsync(out);
                    }
                    Intent intent = new Intent(ctx, InstallReceiver.class);
                    PendingIntent pending = PendingIntent.getBroadcast(ctx, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                    session.commit(pending.getIntentSender());
                }
                app.events.add("update-installed", Events.detail("stage", "committed", "version", available == null ? "" : available.optString("versionName")));
            } catch (Exception e) {
                Log.e("release", "the install could not start", e);
                app.events.add("update-failed", Events.detail("kind", "release", "error", String.valueOf(e.getMessage())));
                tell("failed", available, 0);
            }
        });
    }
}
