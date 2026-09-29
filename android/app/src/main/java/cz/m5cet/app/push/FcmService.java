package cz.m5cet.app.push;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/** FCM delivers the server's control messages here (data messages only). */
public final class FcmService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (!"1".equals(data.get("m5"))) return;
        M5 app = M5.get();
        JSONObject wire = new JSONObject(data);
        Log.i("push", "control message " + data.get("i") + " (priority " + message.getPriority() + ")");
        // Handled synchronously: FCM keeps the process alive while this runs (~10 s budget).
        app.checkin.control().handle(wire, "fcm");
    }

    @Override
    public void onNewToken(String token) {
        M5 app = M5.get();
        app.push.setToken(token);
        Io.bg(() -> app.checkin.run("fcm-token"));
    }
}
