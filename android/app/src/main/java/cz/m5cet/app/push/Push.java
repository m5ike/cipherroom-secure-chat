package cz.m5cet.app.push;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.Vault;

/**
 * Firebase Cloud Messaging without google-services.json: the server hands
 * out its Firebase app settings (/api/android/info, check-in), the app
 * initialises Firebase with them at run time — one APK serves any M5cet
 * server. The registration token goes to the server on the next check-in.
 * Without FCM the check-in job polls (JobScheduler, network only).
 */
public final class Push {
    private final M5 app;
    private volatile String token = "";

    public Push(M5 app) { this.app = app; }

    public String token() {
        if (token.isEmpty()) token = app.vault.json(Vault.Tier.SYS, "push").optString("token", "");
        return token;
    }

    public boolean enabled() { return !token().isEmpty(); }

    public void setToken(String t) {
        token = t == null ? "" : t;
        try { app.vault.putJson(Vault.Tier.SYS, "push", new JSONObject().put("token", token)); } catch (org.json.JSONException ignored) { }
    }

    /** Starts Firebase with the server's settings, if it gave any. */
    public synchronized void init() {
        JSONObject fcm = app.config.fcm();
        if (fcm == null || fcm.optString("appId").isEmpty()) return;
        try {
            if (FirebaseApp.getApps(app).isEmpty()) {
                FirebaseOptions options = new FirebaseOptions.Builder()
                    .setApiKey(fcm.optString("apiKey"))
                    .setApplicationId(fcm.optString("appId"))
                    .setGcmSenderId(fcm.optString("senderId"))
                    .setProjectId(fcm.optString("projectId"))
                    .setStorageBucket(fcm.optString("storageBucket", null))
                    .build();
                FirebaseApp.initializeApp(app, options);
                Log.i("push", "Firebase started for project " + fcm.optString("projectId"));
            }
            FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    String t = task.getResult();
                    if (!t.equals(token())) {
                        setToken(t);
                        Log.i("push", "FCM token ready");
                        Io.bg(() -> app.checkin.run("fcm-token"));
                    }
                } else {
                    Log.w("push", "no FCM token: " + (task.getException() == null ? "?" : task.getException().getMessage()));
                }
            });
        } catch (Exception e) {
            Log.e("push", "Firebase could not start", e);
        }
    }
}
