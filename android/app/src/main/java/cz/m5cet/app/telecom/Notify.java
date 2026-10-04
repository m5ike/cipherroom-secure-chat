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

import org.json.JSONObject;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.R;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.push.NotifyPrefs;
import cz.m5cet.app.push.NotifyTemplate;
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
    public static final String CH_QUIET = "quiet";
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
        // 6.7: a template without sound or vibration (Notifications › Templates) goes here.
        NotificationChannel quiet = new NotificationChannel(CH_QUIET, app.t("notify.quietChannel"), NotificationManager.IMPORTANCE_LOW);
        quiet.setShowBadge(true);
        nm.createNotificationChannels(java.util.Arrays.asList(messages, notices, calls, updates, service, quiet));
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
        try { sm.pushDynamicShortcut(s); } catch (RuntimeException ignored) { }
    }

    private Notification.Action replyAction(String roomKey) {
        RemoteInput reply = new RemoteInput.Builder(KEY_REPLY).setLabel(app.t("notify.reply")).build();
        Intent ri = new Intent(app, ReplyReceiver.class).putExtra("room", roomKey);
        PendingIntent replyPi = PendingIntent.getBroadcast(app, roomKey.hashCode(), ri, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        return new Notification.Action.Builder(Icon.createWithResource(app, R.drawable.ic_stat_m5), app.t("notify.reply"), replyPi).addRemoteInput(reply).setAllowGeneratedReplies(true).build();
    }

    /** 6.7: the template's accent ("#rrggbb"), or none. */
    private static Integer accent(String hex) {
        if (hex == null || !hex.matches("#[0-9a-fA-F]{6}")) return null;
        return 0xff000000 | Integer.parseInt(hex.substring(1), 16);
    }

    /**
     * New messages of a room, drawn by the app itself (it decrypted them). 6.7:
     * the user's switches and quiet hours decide whether, their privacy level
     * (within the operator's maximum) how much: the content only at "content",
     * never while the app is locked; the sender from "sender" on, the room's
     * name from "room" on. The template's accent, sound and actions apply.
     */
    public void message(String roomKey, String roomName, String sender, String text, boolean hideContent) {
        if (!allowed()) return;
        NotifyPrefs prefs = NotifyPrefs.get(app);
        if (!prefs.allows("message", System.currentTimeMillis())) return;
        int level = NotifyTemplate.rank(prefs.localPrivacy("message", hideContent));
        JSONObject tpl = prefs.template("message");
        String appName = app.design().appName();
        Person me = new Person.Builder().setName(app.config.userName().isEmpty() ? "me" : app.config.userName()).build();
        Notification.MessagingStyle style = new Notification.MessagingStyle(me).setConversationTitle(level >= 2 ? roomName : appName).setGroupConversation(true);
        style.addMessage(level >= 3 ? text : app.t("notify.message"), System.currentTimeMillis(), new Person.Builder().setName(level >= 1 ? sender : appName).build());
        boolean sound = tpl == null || tpl.optBoolean("sound", true);
        Notification.Builder b = new Notification.Builder(app, sound ? CH_MESSAGES : CH_QUIET)
            .setSmallIcon(R.drawable.ic_stat_m5).setStyle(style)
            .setContentIntent(open(roomKey, roomKey.hashCode())).setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE);
        // The conversation shortcut carries the room's name: only where the room may show.
        if (level >= 2) { roomShortcut(roomKey, roomName); b.setShortcutId(shortcutId(roomKey)); }
        if (tpl == null || tpl.optBoolean("actions", true)) b.addAction(replyAction(roomKey));
        Integer color = accent(tpl == null ? null : tpl.optString("accent"));
        if (color != null) b.setColor(color);
        nm().notify(roomKey.hashCode(), b.build());
    }

    /**
     * 6.7: a notification from the server (a "notify" control message, sealed
     * for this device): its template is rendered again with what only the app
     * knows — the room's own name, when the user's level shows rooms. It never
     * carries content (the server has none); when the app later decrypts the
     * message itself, message() replaces it (same id for the room).
     */
    public void templated(JSONObject p, boolean local) {
        if (!allowed()) return;
        NotifyPrefs prefs = NotifyPrefs.get(app);
        String kind = p.optString("kind", "message");
        if (!local && !prefs.allows(kind, System.currentTimeMillis())) return; // the phone's own switches may be newer
        String privacy = NotifyTemplate.min(p.optString("privacy", "neutral"), "room");
        Map<String, String> vars = new HashMap<>();
        JSONObject given = p.optJSONObject("vars");
        if (given != null) for (java.util.Iterator<String> it = given.keys(); it.hasNext(); ) { String k = it.next(); if (!k.equals("preview")) vars.put(k, given.optString(k)); }
        if (!vars.containsKey("app") || vars.get("app").isEmpty()) vars.put("app", app.design().appName());
        RoomSession room = p.optString("room").isEmpty() || app.rooms == null ? null : app.rooms.byServerId(p.optString("room"));
        if (room != null && NotifyTemplate.rank(privacy) >= 2) vars.put("room", room.label);
        JSONObject tpl = p.optJSONObject("tpl");
        String[] tb = tpl != null
            ? NotifyTemplate.notification(tpl.optString("title"), tpl.optString("body"), vars, privacy)
            : new String[]{ NotifyTemplate.clean(p.optString("title", app.design().appName()), NotifyTemplate.TITLE_MAX), NotifyTemplate.clean(p.optString("body"), NotifyTemplate.BODY_MAX) };
        if (tb[1].isEmpty()) tb[1] = NotifyTemplate.clean(p.optString("body"), NotifyTemplate.BODY_MAX);
        String channel = kind.equals("call") ? CH_CALLS : !p.optBoolean("sound", true) ? CH_QUIET : kind.equals("message") || kind.equals("mention") ? CH_MESSAGES : CH_NOTICES;
        String tag = p.optString("tag", "m5-" + kind);
        int id = room != null ? room.key.hashCode() : ("m5n:" + tag).hashCode();
        Notification.Builder b = new Notification.Builder(app, channel)
            .setSmallIcon(R.drawable.ic_stat_m5).setContentTitle(tb[0]).setContentText(tb[1])
            .setStyle(new Notification.BigTextStyle().bigText(tb[1])).setAutoCancel(true)
            .setContentIntent(open(room == null ? null : room.key, id))
            .setCategory(kind.equals("call") ? Notification.CATEGORY_CALL : Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE);
        if (p.optLong("at") > 0) b.setWhen(p.optLong("at")).setShowWhen(true);
        if (!"none".equals(p.optString("group")) && !tag.isEmpty()) b.setGroup(tag);
        Integer color = accent(p.optString("accent"));
        if (color != null) b.setColor(color);
        if (p.optBoolean("actions") && room != null && (kind.equals("message") || kind.equals("mention"))) b.addAction(replyAction(room.key));
        nm().notify(id, b.build());
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
