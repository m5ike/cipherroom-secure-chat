package cz.m5cet.app.telecom;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.net.Uri;

import java.util.Collections;

import cz.m5cet.app.M5;
import cz.m5cet.app.R;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.ui.MainActivity;

/**
 * Android's notification system for the framework: channels (messages,
 * notices, calls, updates, connection), messages as conversations with a
 * direct reply and a long-lived shortcut per room (so they rank as
 * conversations and can bubble), the server's flash and push messages, and
 * update offers. A flash shows inside the app when it is on screen.
 */
public final class Notify {
    public static final String CH_MESSAGES = "messages";
    public static final String CH_NOTICES = "notices";
    public static final String CH_CALLS = "calls";
    public static final String CH_UPDATES = "updates";
    public static final String CH_SERVICE = "service";
    public static final String KEY_REPLY = "reply";

    public interface FlashSink { boolean show(String title, String text, String level); }

    private final M5 app;
    private volatile FlashSink sink;

    public Notify(M5 app) { this.app = app; }

    public void setFlashSink(FlashSink s) { sink = s; }

    private NotificationManager nm() { return app.getSystemService(NotificationManager.class); }

    public void channels() {
        NotificationManager nm = nm();
        if (nm == null) return;
        NotificationChannel messages = new NotificationChannel(CH_MESSAGES, app.t("push.channel"), NotificationManager.IMPORTANCE_HIGH);
        messages.setShowBadge(true);
        NotificationChannel notices = new NotificationChannel(CH_NOTICES, app.t("push.flash"), NotificationManager.IMPORTANCE_HIGH);
        NotificationChannel calls = new NotificationChannel(CH_CALLS, app.t("call.incoming"), NotificationManager.IMPORTANCE_HIGH);
        NotificationChannel updates = new NotificationChannel(CH_UPDATES, app.t("settings.updates"), NotificationManager.IMPORTANCE_DEFAULT);
        NotificationChannel service = new NotificationChannel(CH_SERVICE, app.t("app.connecting"), NotificationManager.IMPORTANCE_MIN);
        service.setShowBadge(false);
        nm.createNotificationChannels(java.util.Arrays.asList(messages, notices, calls, updates, service));
    }

    private boolean allowed() {
        return android.os.Build.VERSION.SDK_INT < 33 || app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private PendingIntent open(String room, int code) {
        Intent i = new Intent(app, MainActivity.class).setAction(Intent.ACTION_VIEW).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        if (room != null && !room.isEmpty()) i.putExtra("room", room);
        return PendingIntent.getActivity(app, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** The server's flash: in the app when it is visible, else a heads-up notice. */
    public void flash(String title, String text, String level) {
        FlashSink s = sink;
        if (s != null && app.inForeground()) {
            final boolean[] shown = {false};
            Io.main(() -> shown[0] = s.show(title, text, level));
            return;
        }
        if (!allowed()) return;
        Notification n = new Notification.Builder(app, CH_NOTICES)
            .setSmallIcon(R.drawable.ic_stat_m5).setContentTitle(title == null || title.isEmpty() ? app.design().appName() : title)
            .setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true).setContentIntent(open(null, 1)).setCategory(Notification.CATEGORY_MESSAGE).build();
        nm().notify(("flash" + text).hashCode(), n);
    }

    public void push(String title, String body, String room, String url) {
        if (!allowed()) return;
        PendingIntent target = open(room, 2);
        if (url != null && url.startsWith("https://")) target = PendingIntent.getActivity(app, 3, new Intent(Intent.ACTION_VIEW, Uri.parse(url)), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(app, CH_NOTICES)
            .setSmallIcon(R.drawable.ic_stat_m5).setContentTitle(title == null || title.isEmpty() ? app.design().appName() : title)
            .setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true).setContentIntent(target).build();
        nm().notify(("push" + title + body).hashCode(), n);
    }

    public void update(String title, String text) {
        if (!allowed()) return;
        Notification n = new Notification.Builder(app, CH_UPDATES)
            .setSmallIcon(R.drawable.ic_stat_m5).setContentTitle(title).setContentText(text)
            .setAutoCancel(true).setContentIntent(open(null, 4)).build();
        nm().notify(4711, n);
    }

    private String shortcutId(String roomKey) { return "room-" + Integer.toHexString(roomKey.hashCode()); }

    /** A conversation shortcut per room (conversations section, bubbles, share targets). */
    public void roomShortcut(String roomKey, String name) {
        ShortcutManager sm = app.getSystemService(ShortcutManager.class);
        if (sm == null) return;
        Intent i = new Intent(app, MainActivity.class).setAction(Intent.ACTION_VIEW).putExtra("room", roomKey);
        ShortcutInfo s = new ShortcutInfo.Builder(app, shortcutId(roomKey))
            .setShortLabel(name).setLongLived(true).setIntent(i)
            .setIcon(Icon.createWithResource(app, R.mipmap.ic_launcher))
            .setCategories(Collections.singleton("cz.m5cet.app.category.ROOM"))
            .setPerson(new Person.Builder().setName(name).build())
            .build();
        try {
            // 6.7 (audit V5): pushDynamicShortcut is API 30; Android 10 adds it the older way.
            if (android.os.Build.VERSION.SDK_INT >= 30) sm.pushDynamicShortcut(s);
            else sm.addDynamicShortcuts(Collections.singletonList(s));
        } catch (RuntimeException ignored) { }
    }

    /**
     * New messages of a room. 6.7 (audit S11): while the app is locked (or the
     * caller asks), only neutral text — no message, sender, room name, room
     * shortcut or reply; the lock screen always gets the neutral public version.
     */
    public void message(String roomKey, String roomName, String sender, String text, boolean hideContent) {
        if (!allowed()) return;
        boolean hide = hideContent || app.lock.isLocked();
        String appName = app.design().appName(), neutral = app.t("notify.message");
        Person me = new Person.Builder().setName(app.config.userName().isEmpty() ? "me" : app.config.userName()).build();
        Notification.MessagingStyle style = new Notification.MessagingStyle(me).setConversationTitle(hide ? appName : roomName).setGroupConversation(true);
        style.addMessage(hide ? neutral : text, System.currentTimeMillis(), new Person.Builder().setName(hide ? appName : sender).build());
        Notification.Builder b = new Notification.Builder(app, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_m5).setStyle(style)
            .setContentIntent(open(roomKey, roomKey.hashCode())).setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(neutral(appName, neutral));
        if (!hide) {
            RemoteInput reply = new RemoteInput.Builder(KEY_REPLY).setLabel(app.t("notify.reply")).build();
            Intent ri = new Intent(app, ReplyReceiver.class).putExtra("room", roomKey);
            PendingIntent replyPi = PendingIntent.getBroadcast(app, roomKey.hashCode(), ri, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            Notification.Action.Builder ab = new Notification.Action.Builder(Icon.createWithResource(app, R.drawable.ic_stat_m5), app.t("notify.reply"), replyPi).addRemoteInput(reply).setAllowGeneratedReplies(true);
            if (android.os.Build.VERSION.SDK_INT >= 31) ab.setAuthenticationRequired(true); // replying needs the phone unlocked
            roomShortcut(roomKey, roomName);
            b.setShortcutId(shortcutId(roomKey)).addAction(ab.build());
        }
        nm().notify(roomKey.hashCode(), b.build());
    }

    /** What the lock screen shows of a message notification: the app's name and "New message". */
    private Notification neutral(String title, String text) {
        return new Notification.Builder(app, CH_MESSAGES).setSmallIcon(R.drawable.ic_stat_m5)
            .setContentTitle(title).setContentText(text).setCategory(Notification.CATEGORY_MESSAGE).build();
    }

    public void clearRoom(String roomKey) {
        NotificationManager nm = nm();
        if (nm != null) nm.cancel(roomKey.hashCode());
    }

    public Notification service(String text) {
        return new Notification.Builder(app, CH_SERVICE).setSmallIcon(R.drawable.ic_stat_m5).setContentTitle(app.design().appName())
            .setContentText(text).setOngoing(true).setContentIntent(open(null, 5)).build();
    }

    public static Context ctx() { return M5.get(); }
}
