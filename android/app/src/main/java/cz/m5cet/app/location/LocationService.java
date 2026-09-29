package cz.m5cet.app.location;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import cz.m5cet.app.M5;

/**
 * Keeps position tracking running while the app is in the background: a
 * foreground service of the location type, with its notification saying so
 * (6.1, Settings › Location › tracking).
 */
public final class LocationService extends Service {
    /** Starts or stops the service to match the setting and the policy. */
    public static void sync(Context c) {
        M5 app = M5.get();
        Intent i = new Intent(c, LocationService.class);
        if (app.where.trackingWanted() && app.where.permitted()) {
            try { c.startForegroundService(i); } catch (RuntimeException ignored) { /* not allowed from the background now */ }
        } else {
            c.stopService(i);
            app.where.stopTracking();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        M5 app = M5.get();
        android.app.Notification n = app.notify.service(app.t("location.tracking"));
        if (Build.VERSION.SDK_INT >= 30) startForeground(9002, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(9002, n);
        app.where.startTracking();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        M5.get().where.stopTracking();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
