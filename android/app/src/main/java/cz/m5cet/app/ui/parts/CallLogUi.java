package cz.m5cet.app.ui.parts;

import android.Manifest;
import android.app.AlertDialog;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ActivityLog;
import cz.m5cet.app.chat.CallHistory;
import cz.m5cet.app.chat.CallTrack;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.telecom.CallLogBridge;
import cz.m5cet.app.ui.Actions;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.bubble.Hides;

/**
 * 6.8: the History screen ("log", server/android/design-68-calllog.ts) and
 * the call log's part of Settings › Calls: $log, the calllog.* actions, and
 * what the call log's switch sets off (the permission, the calling account).
 *
 * The list (ActivityLog.collect) is gathered off the main thread when the
 * screen opens and kept while it is open; the filter ($form.logFilter) and
 * the search ($form.logQuery) apply to it on every bind. The screen is one of
 * the app's like any other: behind the app lock, and it shows nothing a room
 * would not show (a sealed or hidden message only by its kind).
 */
public final class CallLogUi {
    private CallLogUi() {}

    /** The newest this many go to the screen (a list of the design draws 200 at most). */
    static final int SHOWN = 200;

    private static List<ActivityLog.Item> all = new ArrayList<>();
    /** The list was gathered (and the app not locked since). */
    private static boolean fresh;
    private static boolean loading;
    private static int generation;
    /** The call log permission is being asked for (the switch keeps its state meanwhile). */
    private static boolean asking;
    private static boolean listening;

    public static void run(MainActivity a, String action, String arg) {
        switch (action) {
            case "calllog.open": open(a); break;
            case "calllog.refresh": a.refresh(); break;
            case "calllog.item": item(a, arg); break;
            case "calllog.call": call(a, arg); break;
            case "calllog.clear": clear(a); break;
            case "calllog.system": eraseSystem(a); break;
            default: break;
        }
    }

    private static String t(MainActivity a, String key) { return a.app().t(key); }

    /* -------------------------------------------------------- the list */

    static void open(MainActivity a) {
        a.form().putIfAbsent("logFilter", ActivityLog.ALL);
        load(a);
        a.showScreen("log", true);
    }

    /** Gathers the list again (the calls kept, every saved room's messages). */
    static void load(MainActivity a) {
        M5 app = a.app();
        if (!listening) {
            listening = true;
            // Locked or wiped: what was gathered does not stay in memory.
            app.addListener(what -> { if ("locked".equals(what) || "wiped".equals(what)) forget(); });
        }
        loading = true;
        int g = ++generation;
        Io.bg(() -> {
            List<ActivityLog.Item> got;
            try { got = ActivityLog.collect(app, Hides::hidden); }
            catch (RuntimeException e) { Log.e("calllog", "the history could not be gathered", e); got = new ArrayList<>(); }
            List<ActivityLog.Item> list = got;
            Io.main(() -> {
                if (g != generation) return;
                all = list;
                loading = false;
                fresh = true;
                if ("log".equals(a.screen())) a.refresh();
            });
        });
    }

    /**
     * Locked or wiped: what was gathered (calls, every room's messages) does
     * not stay in memory — 6.10 (G-24): also when the auto-lock time passes in
     * the background (M5.whenLocked), not only at a lock with an event. Any thread.
     */
    public static void forget() {
        Io.main(() -> { all = new ArrayList<>(); generation++; loading = false; fresh = false; });
    }

    /** $log: the entries of the filter and search, newest first (at most SHOWN), each with its day. */
    public static JSONObject scope(MainActivity a) {
        M5 app = a.app();
        if (!fresh && !loading) load(a); // opened another way than calllog.open (a design's screen.open)
        Object f = a.form().get("logFilter"), q = a.form().get("logQuery");
        List<ActivityLog.Item> list = ActivityLog.filter(all, f == null ? ActivityLog.ALL : Expr.toText(f), q == null ? "" : Expr.toText(q));
        JSONArray items = new JSONArray();
        long now = System.currentTimeMillis();
        TimeZone tz = TimeZone.getDefault();
        DateFormat dates = DateFormat.getDateInstance(DateFormat.MEDIUM, Locale.forLanguageTag(app.lang()));
        int lastDay = -1;
        for (int i = 0; i < list.size() && i < SHOWN; i++) {
            ActivityLog.Item it = list.get(i);
            int d = ActivityLog.daysAgo(it.at, now, tz);
            String day = d == 0 ? t(a, "log.today") : d == 1 ? t(a, "log.yesterday") : dates.format(new Date(it.at));
            items.put(item(a, it, day, d != lastDay));
            lastDay = d;
        }
        return MainActivity.jo("loading", loading && all.isEmpty(), "empty", list.isEmpty(), "count", (double) list.size(), "shown", (double) Math.min(SHOWN, list.size()),
            "more", list.size() > SHOWN, "history", app.settings.bool("calls.history"), "items", items);
    }

    private static JSONObject item(MainActivity a, ActivityLog.Item it, String day, boolean newDay) {
        boolean call = ActivityLog.CALL.equals(it.type);
        String people = String.join(", ", it.people);
        return MainActivity.jo("id", it.id, "type", it.type, "dir", it.dir, "what", it.what, "room", it.room, "people", people,
            "time", (double) it.at, "day", day, "newDay", newDay, "seconds", (double) it.seconds, "length", ActivityLog.length(it.seconds),
            "video", it.video, "preview", it.preview, "detail", call ? callDetail(a, it, people) : messageDetail(a, it, people),
            "icon", icon(it), "color", color(it), "callable", call && it.saved);
    }

    /** "Incoming · video · 12:04 · Alice, Bob" */
    private static String callDetail(MainActivity a, ActivityLog.Item it, String people) {
        StringBuilder s = new StringBuilder(t(a, "log.dir." + it.dir));
        if (it.video) s.append(" · ").append(t(a, "log.video"));
        String len = ActivityLog.length(it.seconds);
        if (!len.isEmpty()) s.append(" · ").append(len);
        if (!people.isEmpty()) s.append(" · ").append(people);
        else if (CallTrack.OUT.equals(it.dir)) s.append(" · ").append(t(a, "log.nobody"));
        return s.toString();
    }

    /** "Alice: the text" / "Me → Bob: …" — a sealed, hold-to-read, vanishing or hidden one only by its kind. */
    private static String messageDetail(MainActivity a, ActivityLog.Item it, String people) {
        String who = "out".equals(it.dir) ? t(a, "log.me") + (people.isEmpty() ? "" : " → " + people) : people;
        String what;
        switch (it.what) {
            case "text": case "fn": what = it.preview; break;
            case "file": what = "📎 " + it.preview; break;
            default: what = t(a, "log.kind." + it.what);
        }
        return who.isEmpty() ? what : who + ": " + what;
    }

    private static String icon(ActivityLog.Item it) {
        boolean out = "out".equals(it.dir);
        if (ActivityLog.CALL.equals(it.type)) {
            boolean gone = CallTrack.MISSED.equals(it.dir) || CallTrack.DECLINED.equals(it.dir);
            if (it.video) return gone ? "video-off" : "video";
            return gone ? "phone-off" : out ? "phone-outgoing" : "phone";
        }
        switch (it.what) {
            case "sealed": return "message-square-lock";
            case "tap": return "eye";
            case "vanish": return "timer";
            case "hidden": return "eye-off";
            case "file": return "paperclip";
            case "fn": return "terminal";
            default: return out ? "send-horizontal" : "message-circle";
        }
    }

    private static String color(ActivityLog.Item it) {
        if (CallTrack.MISSED.equals(it.dir)) return "@danger";
        if (CallTrack.DECLINED.equals(it.dir)) return "@muted";
        if (ActivityLog.CALL.equals(it.type)) return "out".equals(it.dir) ? "@primary" : "@success";
        return "out".equals(it.dir) ? "@primary" : "@muted";
    }

    private static ActivityLog.Item find(String id) {
        for (ActivityLog.Item it : all) if (it.id.equals(id)) return it;
        return null;
    }

    /* ---------------------------------------------------------- actions */

    /** An entry's room (a message: the room scrolls to it). */
    static void item(MainActivity a, String id) {
        ActivityLog.Item it = find(id);
        if (it == null) return;
        if (!it.saved || a.app().rooms.savedRoom(it.roomKey) == null) { a.flash("", t(a, "log.gone"), "warn"); return; }
        a.goRoom(it.roomKey);
        if (ActivityLog.MSG.equals(it.type)) {
            // The room's messages may still be on their way from the vault.
            Io.mainLater(() -> { if (!a.parts.revealMessage(it.msgId)) Io.mainLater(() -> a.parts.revealMessage(it.msgId), 900); }, 300);
        }
    }

    /** Calls an entry's room again — only after the person confirms it (everyone connected there hears the call). */
    static void call(MainActivity a, String id) {
        ActivityLog.Item it = find(id);
        if (it == null) return;
        if (!it.saved || a.app().rooms.savedRoom(it.roomKey) == null) { a.flash("", t(a, "log.gone"), "warn"); return; }
        // 6.10 (G-24): the History's dialogs take the app's FLAG_SECURE (a dialog is a window of its own).
        SecureDialog.show(a, new AlertDialog.Builder(a).setMessage(t(a, "log.callAsk").replace("{room}", it.room))
            .setPositiveButton(t(a, "log.call.audio"), (d, w) -> dial(a, it.roomKey, false))
            .setNeutralButton(t(a, "log.call.video"), (d, w) -> dial(a, it.roomKey, true))
            .setNegativeButton(t(a, "nav.close"), null));
    }

    private static void dial(MainActivity a, String roomKey, boolean video) {
        a.goRoom(roomKey);
        Runnable start = () -> Actions.run(a, video ? "call.video" : "call.audio", null, n -> null, null, 0);
        a.withPermission(Manifest.permission.RECORD_AUDIO, video ? () -> a.withPermission(Manifest.permission.CAMERA, start) : start);
    }

    /** Deletes the app's call history (asked first). */
    static void clear(MainActivity a) {
        M5 app = a.app();
        SecureDialog.show(a, new AlertDialog.Builder(a).setMessage(t(a, "log.clearAsk"))
            .setPositiveButton(t(a, "log.clear"), (d, w) -> Io.bg(() -> {
                CallHistory.clear(app);
                Io.main(() -> { a.flash("", t(a, "log.cleared"), "success"); load(a); });
            }))
            .setNegativeButton(t(a, "nav.close"), null));
    }

    /** Removes the app's calls from the phone's call log (asked first; needs the permission). */
    static void eraseSystem(MainActivity a) {
        M5 app = a.app();
        Runnable erase = () -> Io.bg(() -> {
            int n = CallLogBridge.eraseSystem(app, CallHistory.load(app));
            Io.main(() -> a.flash("", n < 0 ? t(a, "calllog.eraseNeedsPerm") : t(a, "calllog.erased").replace("{n}", String.valueOf(n)), n < 0 ? "warn" : "success"));
        });
        SecureDialog.show(a, new AlertDialog.Builder(a).setMessage(t(a, "calllog.eraseAsk"))
            .setPositiveButton(t(a, "calllog.erase"), (d, w) -> a.withPermission(Manifest.permission.WRITE_CALL_LOG, erase, () -> a.flash("", t(a, "calllog.eraseNeedsPerm"), "warn")))
            .setNegativeButton(t(a, "nav.close"), null));
    }

    /* ---------------------------------------------------------- settings */

    /** A setting of the call log changed (MainActivity.settingChanged). */
    public static void settingChanged(MainActivity a, String key) {
        M5 app = a.app();
        if (!"callLog".equals(key) || !app.settings.bool("callLog")) return;
        Runnable ready = () -> Io.bg(() -> { CallLogBridge.account(app); CallLogBridge.fixLegacy(app); });
        if (CallLogBridge.granted(app)) { ready.run(); return; }
        asking = true;
        a.withPermission(Manifest.permission.WRITE_CALL_LOG, () -> {
            asking = false;
            app.settings.set("callLog", true);
            ready.run();
            a.refresh();
        }, () -> {
            asking = false;
            // The switch shows what is real: no permission, no call log.
            app.settings.set("callLog", false);
            a.flash("", t(a, "calllog.denied"), "warn");
            a.refresh();
        });
    }

    /** Settings › Calls is drawn: a permission taken away in the phone's settings turns the switch off. */
    public static void reconcile(M5 app) {
        if (!asking && app.settings.bool("callLog") && !CallLogBridge.granted(app)) app.settings.set("callLog", false);
    }
}
