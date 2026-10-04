package cz.m5cet.app.telecom;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.os.Build;

import cz.m5cet.app.M5;
import cz.m5cet.app.R;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.push.NotifyPrefs;
import cz.m5cet.app.push.NotifyTemplate;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.ui.Actions;
import cz.m5cet.app.ui.MainActivity;

/**
 * 6.8: a call that starts in a room while I am not in it rings — a
 * notification on the calls channel with Join and Decline — and when it ends
 * without me it stays as a missed call (CallTrack decides, Calls tells this
 * class). Whether and how much it shows follows the user's notification
 * settings like a message: the "Calls" switch, quiet hours, the privacy level
 * (NotifyPrefs) — the person from "sender" on, the room from "room" on; while
 * the app is locked only the app's name and "Call", and the phone's lock
 * screen always gets that neutral version. The room on screen does not ring
 * (its people show who is in the call).
 *
 * Join opens the room and joins the call once the app is unlocked — only from
 * this run's own notification (a token another app cannot know), and only
 * while someone is still in the call; Decline makes it a declined call.
 */
public final class CallRing {
    private CallRing() {}

    static final String ACTION_DECLINE = "cz.m5cet.app.action.DECLINE_CALL";
    static final String ACTION_JOIN = "cz.m5cet.app.action.JOIN_CALL";
    static final String EXTRA_JOIN = "cz.m5cet.call.join";
    /** A ring stays this long at most (the call may go on; it is then missed or joined from the room). */
    static final long RING_MS = 60_000;
    /** Only a Join of this run's own notification joins (the activity takes intents from any app). */
    private static final String TOKEN = Crypto.b64url(Crypto.random(12));

    static int id(String roomKey) { return ("m5ring:" + roomKey).hashCode(); }

    private static boolean allowed(M5 app) {
        return Build.VERSION.SDK_INT < 33 || app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /** How much a call notification may show: 0 nothing, 1 the person, 2 the room too (NotifyTemplate ranks); 0 while locked. */
    private static int level(M5 app) {
        if (app.lock.isLocked()) return 0;
        return NotifyTemplate.rank(NotifyPrefs.get(app).localPrivacy("call", false));
    }

    private static PendingIntent open(M5 app, String roomKey, int code) {
        Intent i = new Intent(app, MainActivity.class).setAction(Intent.ACTION_VIEW).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("room", roomKey);
        return PendingIntent.getActivity(app, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** What the phone's lock screen shows of a call notification: the app's name and "Call". */
    private static Notification neutral(M5 app, String channel, String text) {
        return new Notification.Builder(app, channel).setSmallIcon(R.drawable.ic_stat_m5).setContentTitle(app.design().appName()).setContentText(text).build();
    }

    /** Someone started a call in a room I am not in. */
    public static void ring(M5 app, String roomKey, String room, String who, boolean video) {
        if (!allowed(app) || !NotifyPrefs.get(app).allows("call", System.currentTimeMillis()) || app.rooms.onScreen(roomKey)) return;
        int level = level(app), id = id(roomKey);
        String kind = app.t(video ? "ring.video" : "ring.call");
        String title = level >= 2 ? room : app.design().appName();
        String text = level >= 1 && who != null && !who.isEmpty() ? app.t("ring.who").replace("{name}", who) : kind;
        Intent decline = new Intent(app, Receiver.class).setAction(ACTION_DECLINE).putExtra("room", roomKey);
        PendingIntent declinePi = PendingIntent.getBroadcast(app, id, decline, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent join = new Intent(app, MainActivity.class).setAction(ACTION_JOIN).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("room", roomKey).putExtra(EXTRA_JOIN, TOKEN);
        PendingIntent joinPi = PendingIntent.getActivity(app, id + 1, join, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = new Notification.Builder(app, Notify.CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat_m5).setContentTitle(title).setContentText(text)
            .setCategory(Notification.CATEGORY_CALL).setAutoCancel(true).setOnlyAlertOnce(true).setTimeoutAfter(RING_MS)
            .setContentIntent(open(app, roomKey, id + 2))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(neutral(app, Notify.CH_CALLS, app.t("ring.call")))
            .addAction(new Notification.Action.Builder(Icon.createWithResource(app, R.drawable.ic_stat_m5), app.t("ring.decline"), declinePi).build())
            .addAction(new Notification.Action.Builder(Icon.createWithResource(app, R.drawable.ic_stat_m5), app.t("ring.join"), joinPi).build());
        if (level >= 1) b.setSubText(kind);
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(id, b.build());
    }

    /** The ring is over (joined, declined, the call ended). */
    public static void over(M5 app, String roomKey) {
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(id(roomKey));
    }

    /** A call in a room ended without me (the ring's place; quiet). */
    public static void missed(M5 app, String roomKey, String room, String who, boolean video, long at) {
        if (!allowed(app) || !NotifyPrefs.get(app).allows("call", System.currentTimeMillis()) || app.rooms.onScreen(roomKey)) return;
        int level = level(app), id = id(roomKey);
        String title = level >= 2 ? room : app.design().appName();
        String text = level >= 1 && who != null && !who.isEmpty() ? app.t("ring.missedWho").replace("{name}", who) : app.t("ring.missed");
        Notification.Builder b = new Notification.Builder(app, Notify.CH_QUIET)
            .setSmallIcon(R.drawable.ic_stat_m5).setContentTitle(title).setContentText(text)
            .setCategory(Build.VERSION.SDK_INT >= 31 ? Notification.CATEGORY_MISSED_CALL : Notification.CATEGORY_CALL)
            .setWhen(at).setShowWhen(true).setAutoCancel(true)
            .setContentIntent(open(app, roomKey, id + 2))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(neutral(app, Notify.CH_QUIET, app.t("ring.missed")));
        if (level >= 1 && video) b.setSubText(app.t("ring.video"));
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(id, b.build());
    }

    /* ------------------------------------------------------------- join */

    private static String pendingJoin;
    private static long pendingAt;
    private static int loop;

    /** From MainActivity.handleIntent: a Join of a ring (true when it was one of ours). */
    public static boolean accept(MainActivity a, Intent i) {
        if (i == null || !ACTION_JOIN.equals(i.getAction())) return false;
        String token = i.getStringExtra(EXTRA_JOIN), room = i.getStringExtra("room");
        i.removeExtra(EXTRA_JOIN); // taken once (a recreated activity gets the same intent)
        if (!TOKEN.equals(token) || room == null || room.isEmpty()) return false;
        over(a.app(), room);
        pendingJoin = room;
        pendingAt = System.currentTimeMillis();
        int g = ++loop;
        Io.mainLater(() -> tick(a, g), 400);
        return true;
    }

    /** Once the app is unlocked and on its screens: the room, and its call — if someone is still in it. */
    private static void tick(MainActivity a, int g) {
        String room = pendingJoin;
        if (room == null || g != loop || a.isDestroyed()) return;
        M5 app = a.app();
        if (System.currentTimeMillis() - pendingAt > 3 * 60_000L) { pendingJoin = null; return; }
        String screen = a.screen();
        if (app.lock.isLocked() || screen.isEmpty() || screen.equals("splash") || screen.equals("lock") || screen.equals("enroll")) { Io.mainLater(() -> tick(a, g), 500); return; }
        pendingJoin = null;
        RoomSession r = app.rooms.session(room);
        if (r == null) return;
        if (!room.equals(app.rooms.active()) || !screen.equals("room")) a.goRoom(room);
        if (!r.calls().othersInCall() || !"off".equals(r.calls().state())) return;
        a.withPermission(Manifest.permission.RECORD_AUDIO, () -> Actions.run(a, "call.audio", null, n -> null, null, 0));
    }

    /** Decline of a ring. */
    public static final class Receiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || !ACTION_DECLINE.equals(intent.getAction())) return;
            M5 app = M5.get();
            String room = intent.getStringExtra("room");
            if (app == null || room == null) return;
            RoomSession r = app.rooms.session(room);
            if (r != null) r.calls().decline();
            over(app, room);
        }
    }
}
