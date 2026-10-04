package cz.m5cet.app.telecom;

import android.Manifest;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.provider.CallLog;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.R;
import cz.m5cet.app.chat.CallHistory;
import cz.m5cet.app.chat.CallTrack;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * Calls of the rooms in the phone's own call log (when the person turned it
 * on in Settings › Calls and granted WRITE_CALL_LOG — the switch asks for
 * it): incoming, outgoing, missed and declined (CallTrack), one entry per
 * call, with its time, length and video. The call content never leaves the
 * app; the log shows only that a call happened.
 *
 * 6.8, what an entry is:
 *  - no number. 6.7 and older wrote "m5cet:<room>" as the number — a phone
 *    app calling it back hands it to Telecom, which turns its letters into
 *    keypad digits ("m5cet:team" → 652388326) and dials that over the SIM.
 *    An entry now has an empty number of unknown presentation, which no phone
 *    app offers to call; the old rows are fixed once (fixLegacy).
 *  - named by the app only ("M5cet") unless Settings › Calls says the room
 *    (or the room and the people) — any app allowed to read the call log
 *    reads the name; while the app is locked it is always only the app's.
 *    Phone apps differ in showing a name they are given (some say "Unknown").
 *  - marked with the app's self-managed calling account (M5ConnectionService,
 *    registered here), so that a phone app following the CDD (7.4.1.2) can
 *    say which app the entry is from. No call ever goes through Telecom: the
 *    service refuses every connection.
 *
 * Calling back from the phone app: not possible on Android 10–16 — Telecom
 * drops another app's self-managed account from a call and dials the number
 * as a phone call; Android 17's call-back (TelecomManager.ACTION_CALL_BACK)
 * is only for calls added through Telecom (CallsManager.addCall), which these
 * calls are not. Calling again is in the app: History › the phone button,
 * after a confirmation.
 */
public final class CallLogBridge {
    private CallLogBridge() {}

    /** calls.logName: what an entry is named. */
    public static final String NAME_APP = "app", NAME_ROOM = "room", NAME_PEOPLE = "people";
    static final String ACCOUNT_ID = "m5cet";
    /** The rows of 6.7 and older: the room as the "number". */
    static final String LEGACY = CallLog.Calls.NUMBER + " LIKE 'm5cet:%'";
    private static final int PART_MAX = 60, NAME_MAX = 120;

    /** After a wipe nothing is written any more (a room's last call may end while it runs). */
    private static volatile boolean wiped;
    private static volatile boolean legacyFixed;
    private static volatile PhoneAccountHandle account;
    private static volatile boolean accountTried;

    public static boolean wanted(M5 app) { return app.settings.bool("callLog"); }

    public static boolean granted(Context c) {
        return c.checkSelfPermission(Manifest.permission.WRITE_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean enabled(M5 app) { return !wiped && wanted(app) && granted(app); }

    /* ------------------------------------------------------- pure parts */

    /**
     * The name an entry carries: the app's (the default, and always while the
     * app is locked), "app · room", or "people · room".
     */
    public static String entryName(String level, boolean locked, String appName, String room, List<String> people) {
        String app = clean(appName);
        if (app.isEmpty()) app = "M5cet";
        String r = clean(room);
        if (locked || r.isEmpty()) return app;
        if (NAME_ROOM.equals(level)) return cut(app + " · " + r);
        if (NAME_PEOPLE.equals(level)) {
            List<String> names = new ArrayList<>();
            int more = 0;
            if (people != null) for (String p : people) {
                String c = clean(p);
                if (c.isEmpty()) continue;
                if (names.size() < 3) names.add(c); else more++;
            }
            if (names.isEmpty()) return cut(app + " · " + r);
            return cut(String.join(", ", names) + (more > 0 ? " +" + more : "") + " · " + r);
        }
        return app;
    }

    private static String clean(String s) {
        String t = s == null ? "" : s.replaceAll("[\\p{Cntrl}\\p{Cf}\\p{Zl}\\p{Zp}]+", " ").replaceAll("\\s+", " ").trim();
        return t.length() > PART_MAX ? t.substring(0, PART_MAX).trim() : t;
    }

    private static String cut(String s) { return s.length() > NAME_MAX ? s.substring(0, NAME_MAX - 1) + "…" : s; }

    /** The call log's type of a record's kind. */
    public static int systemType(String kind) {
        if (CallTrack.OUT.equals(kind)) return CallLog.Calls.OUTGOING_TYPE;
        if (CallTrack.IN.equals(kind)) return CallLog.Calls.INCOMING_TYPE;
        if (CallTrack.DECLINED.equals(kind)) return CallLog.Calls.REJECTED_TYPE;
        return CallLog.Calls.MISSED_TYPE;
    }

    /* ---------------------------------------------------------- writing */

    /** A finished call: into the app's call history and (when on) the phone's call log. Off the main thread. */
    public static void logged(M5 app, String roomKey, String room, CallTrack.Record r) {
        Io.bg(() -> {
            if (wiped) return;
            CallHistory.Entry e = CallHistory.Entry.of(CallHistory.newId(), roomKey, room, r);
            CallHistory.add(app, e);
            String uri = record(app, room, r);
            if (uri != null) CallHistory.setSysUri(app, e.id, uri);
        });
    }

    /** Writes one call into the phone's call log; the new row, or null. */
    static String record(M5 app, String room, CallTrack.Record r) {
        if (!enabled(app)) return null;
        try {
            ContentValues v = new ContentValues();
            // Never a number: nothing a phone app could dial.
            v.put(CallLog.Calls.NUMBER, "");
            v.put(CallLog.Calls.NUMBER_PRESENTATION, CallLog.Calls.PRESENTATION_UNKNOWN);
            v.put(CallLog.Calls.CACHED_NAME, entryName(app.settings.str("calls.logName"), app.lock.isLocked(), app.design().appName(), room, r.people));
            v.put(CallLog.Calls.TYPE, systemType(r.kind));
            v.put(CallLog.Calls.DATE, r.at);
            v.put(CallLog.Calls.DURATION, r.seconds);
            // Read: the app tells of its missed calls itself (CallRing), within the user's privacy level.
            v.put(CallLog.Calls.NEW, 0);
            v.put(CallLog.Calls.IS_READ, 1);
            v.put(CallLog.Calls.FEATURES, r.video ? CallLog.Calls.FEATURES_VIDEO : 0);
            PhoneAccountHandle h = account(app);
            if (h != null) {
                v.put(CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME, h.getComponentName().flattenToString());
                v.put(CallLog.Calls.PHONE_ACCOUNT_ID, h.getId());
            }
            Uri row = app.getContentResolver().insert(CallLog.Calls.CONTENT_URI, v);
            fixLegacy(app);
            return row == null ? null : row.toString();
        } catch (RuntimeException e) {
            Log.w("calllog", "the call could not be logged: " + e.getMessage());
            return null;
        }
    }

    /**
     * Once per run: the rows 6.7 and older wrote ("m5cet:<room>" as the number,
     * the room in the name) lose the number — a phone app could dial its
     * digits — and the room's name.
     */
    public static void fixLegacy(M5 app) {
        if (legacyFixed || !granted(app)) return;
        legacyFixed = true;
        String appName = app.design().appName();
        try {
            ContentValues v = new ContentValues();
            v.put(CallLog.Calls.NUMBER, "");
            v.put(CallLog.Calls.NUMBER_PRESENTATION, CallLog.Calls.PRESENTATION_UNKNOWN);
            v.put(CallLog.Calls.CACHED_NAME, appName);
            put(v, clearedCache());
            int n = app.getContentResolver().update(CallLog.Calls.CONTENT_URI, v, LEGACY, null);
            if (n > 0) Log.i("calllog", n + " old entries no longer carry a number");
        } catch (RuntimeException e) {
            Log.w("calllog", "old entries: " + e.getMessage());
        }
        // 6.10 (G-24): what a phone app looked up for the old "m5cet:<room>" numbers stays in the cached columns —
        // the formatted number, the keypad digits of the room's name, a matched contact. Rows fixed by 6.8 and the
        // app's own rows lose it (their name — the chosen entry name — stays).
        try {
            ContentValues c = new ContentValues();
            put(c, clearedCache());
            int n = app.getContentResolver().update(CallLog.Calls.CONTENT_URI, c, OURS, new String[]{ component(app).flattenToString(), appName });
            if (n > 0) Log.i("calllog", n + " entries lost what a phone app had looked up for them");
        } catch (RuntimeException e) {
            Log.w("calllog", "cached columns: " + e.getMessage());
        }
    }

    /** 6.10 (G-24): the app's rows — its calling account's, and the old ones 6.8 fixed (no number, the app's name); args: the component, the app's name. */
    static final String OURS = CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME + " = ? OR " + LEGACY
        + " OR (" + CallLog.Calls.NUMBER + " = '' AND " + CallLog.Calls.CACHED_NAME + " = ?)";

    /**
     * 6.10 (G-24): the columns a phone app fills in from its own lookup of a
     * number — emptied (the photo id is 0: the provider keeps it NOT NULL).
     */
    static Map<String, Object> clearedCache() {
        Map<String, Object> m = new LinkedHashMap<>();
        for (String c : new String[]{ CallLog.Calls.CACHED_FORMATTED_NUMBER, CallLog.Calls.CACHED_NORMALIZED_NUMBER, CallLog.Calls.CACHED_MATCHED_NUMBER,
            CallLog.Calls.CACHED_LOOKUP_URI, CallLog.Calls.CACHED_NUMBER_TYPE, CallLog.Calls.CACHED_NUMBER_LABEL, CallLog.Calls.CACHED_PHOTO_URI,
            CallLog.Calls.GEOCODED_LOCATION }) m.put(c, null);
        m.put(CallLog.Calls.CACHED_PHOTO_ID, 0L);
        return m;
    }

    private static void put(ContentValues v, Map<String, Object> columns) {
        for (Map.Entry<String, Object> e : columns.entrySet()) {
            if (e.getValue() == null) v.putNull(e.getKey());
            else if (e.getValue() instanceof Long) v.put(e.getKey(), (Long) e.getValue());
            else v.put(e.getKey(), String.valueOf(e.getValue()));
        }
    }

    /* ---------------------------------------------------------- removing */

    /**
     * Removes every call this app wrote into the phone's call log: the rows of
     * its calling account, the old "m5cet:" rows, and the rows the call history
     * names (each only while its time still matches). How many; −1 without the
     * permission.
     */
    public static int eraseSystem(M5 app, List<CallHistory.Entry> kept) {
        if (!granted(app)) return -1;
        ContentResolver cr = app.getContentResolver();
        int n = 0;
        List<Uri> tables = new ArrayList<>();
        tables.add(CallLog.Calls.CONTENT_URI);
        // Android 17 may keep a calling app's rows apart from the phone's own ("VoIP" rows).
        if (Build.VERSION.SDK_INT >= 37) tables.add(CallLog.Calls.CONTENT_URI.buildUpon().appendQueryParameter("include_voip_calls", "true").build());
        for (Uri t : tables) {
            try { n += cr.delete(t, CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME + " = ? OR " + LEGACY, new String[]{ component(app).flattenToString() }); }
            catch (RuntimeException e) { Log.w("calllog", "erase: " + e.getMessage()); }
        }
        String base = CallLog.Calls.CONTENT_URI.toString() + "/";
        for (CallHistory.Entry e : kept) {
            if (!e.sysUri.startsWith(base) || !e.sysUri.substring(base.length()).matches("\\d{1,18}")) continue;
            try { n += cr.delete(Uri.parse(e.sysUri), CallLog.Calls.DATE + " = ? AND " + CallLog.Calls.NUMBER + " = ''", new String[]{ String.valueOf(e.at) }); }
            catch (RuntimeException ex) { Log.w("calllog", "erase a row: " + ex.getMessage()); }
        }
        return n;
    }

    /** A wipe: the phone's call log loses the app's rows, Telecom its account, the vault the call history. */
    public static void wipe(M5 app) {
        wiped = true;
        List<CallHistory.Entry> kept = new ArrayList<>();
        try { kept = CallHistory.load(app); } catch (RuntimeException ignored) { }
        try { eraseSystem(app, kept); } catch (RuntimeException e) { Log.w("calllog", "wipe: " + e.getMessage()); }
        try {
            TelecomManager tm = app.getSystemService(TelecomManager.class);
            if (tm != null && hasTelecom(app)) tm.unregisterPhoneAccount(handle(app));
        } catch (RuntimeException ignored) { }
        try { CallHistory.clear(app); } catch (RuntimeException ignored) { }
    }

    /* ----------------------------------------------- the calling account */

    static ComponentName component(Context c) { return new ComponentName(c, M5ConnectionService.class); }

    static PhoneAccountHandle handle(Context c) { return new PhoneAccountHandle(component(c), ACCOUNT_ID); }

    private static boolean hasTelecom(Context c) {
        PackageManager pm = c.getPackageManager();
        return Build.VERSION.SDK_INT >= 33 ? pm.hasSystemFeature(PackageManager.FEATURE_TELECOM) : pm.hasSystemFeature("android.software.connectionservice");
    }

    /**
     * The app's self-managed calling account — only so that a phone app can
     * name the app of an entry — registered once per run; null where the phone
     * has no Telecom or refuses it (the entries are written without it).
     */
    public static PhoneAccountHandle account(M5 app) {
        if (accountTried) return account;
        accountTried = true;
        try {
            if (!hasTelecom(app)) return null;
            TelecomManager tm = app.getSystemService(TelecomManager.class);
            if (tm == null) return null;
            PhoneAccountHandle h = handle(app);
            String name = app.design().appName();
            tm.registerPhoneAccount(PhoneAccount.builder(h, name)
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setShortDescription(name)
                .setIcon(Icon.createWithResource(app, R.mipmap.ic_launcher))
                .build());
            account = h;
        } catch (RuntimeException e) {
            Log.w("calllog", "no calling account: " + e.getMessage());
        }
        return account;
    }
}
