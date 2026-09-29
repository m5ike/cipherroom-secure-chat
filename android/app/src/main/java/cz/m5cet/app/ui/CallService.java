package cz.m5cet.app.ui;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import cz.m5cet.app.M5;

/**
 * Keeps a call alive while the app is in the background (Android allows the
 * microphone and camera there only to a foreground service of that type).
 */
public final class CallService extends Service {
    public static void start(Context c, String room, boolean video) {
        Intent i = new Intent(c, CallService.class).putExtra("room", room).putExtra("video", video);
        c.startForegroundService(i);
    }

    public static void stop(Context c) { c.stopService(new Intent(c, CallService.class)); }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String room = intent == null ? "" : intent.getStringExtra("room");
        boolean video = intent != null && intent.getBooleanExtra("video", false);
        M5 app = M5.get();
        android.app.Notification n = app.notify.service(app.t(video ? "call.video" : "call.audio") + " · " + room);
        if (Build.VERSION.SDK_INT >= 30) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | (video ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA : 0);
            startForeground(9001, n, type);
        } else {
            startForeground(9001, n);
        }
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
