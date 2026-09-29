package cz.m5cet.app.telecom;

import android.Manifest;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.provider.CallLog;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;

/**
 * Calls of the rooms in the phone's own call log (when the person turned it
 * on in the settings and granted WRITE_CALL_LOG): the room's name as the
 * "number"'s cached name, the direction, the duration, the M5cet label. The
 * call content never leaves the app; the log shows only that a call happened.
 */
public final class CallLogBridge {
    private CallLogBridge() {}

    public static boolean enabled(M5 app) {
        return app.vault.json(cz.m5cet.app.security.Vault.Tier.SYS, "settings").optBoolean("callLog", false)
            && app.checkSelfPermission(Manifest.permission.WRITE_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
    }

    /** type: CallLog.Calls.INCOMING_TYPE / OUTGOING_TYPE / MISSED_TYPE. */
    public static void record(M5 app, String roomName, boolean video, int type, long startedAt, long durationSec) {
        if (!enabled(app)) return;
        try {
            ContentValues v = new ContentValues();
            v.put(CallLog.Calls.NUMBER, "m5cet:" + roomName);
            v.put(CallLog.Calls.CACHED_NAME, "M5cet · " + roomName);
            v.put(CallLog.Calls.TYPE, type);
            v.put(CallLog.Calls.DATE, startedAt);
            v.put(CallLog.Calls.DURATION, durationSec);
            v.put(CallLog.Calls.NEW, type == CallLog.Calls.MISSED_TYPE ? 1 : 0);
            v.put(CallLog.Calls.FEATURES, video ? CallLog.Calls.FEATURES_VIDEO : 0);
            v.put(CallLog.Calls.NUMBER_PRESENTATION, CallLog.Calls.PRESENTATION_ALLOWED);
            app.getContentResolver().insert(CallLog.Calls.CONTENT_URI, v);
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w("calllog", "the call could not be logged: " + e.getMessage());
        }
    }
}
