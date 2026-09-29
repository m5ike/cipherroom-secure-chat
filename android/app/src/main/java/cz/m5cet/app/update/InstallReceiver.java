package cz.m5cet.app.update;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Events;
import cz.m5cet.app.core.Log;

/** PackageInstaller's answers: ask the person, or report how it ended. */
public final class InstallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        M5 app = M5.get();
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(confirm);
            }
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            Log.i("release", "installed");
            app.events.add("update-installed", Events.detail("stage", "done"));
        } else {
            Log.w("release", "install failed (" + status + "): " + message);
            app.events.add("update-failed", Events.detail("kind", "release", "status", status, "error", message == null ? "" : message));
        }
    }
}
