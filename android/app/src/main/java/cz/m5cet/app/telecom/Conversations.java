package cz.m5cet.app.telecom;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.Application;
import android.app.PendingIntent;
import android.app.Person;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.LocusId;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledFuture;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.chat.Rooms;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.core.Settings;
import cz.m5cet.app.push.NotifyPrefs;
import cz.m5cet.app.push.NotifyTemplate;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Vault;
import cz.m5cet.app.ui.MainActivity;

/**
 * 6.8: the rooms as Android conversations, as Signal and WhatsApp do it —
 * Android has no message log another app may write to; a conversation is a
 * long-lived shortcut with a Person and a LocusId. Every joined room gets
 * one (ConversationPlan decides which, in what order, under what label), so
 * it shows in the notifications' Conversations section (priority, the
 * Conversation widget), as a direct share target (res/xml/shortcuts.xml:
 * shared text lands in the room's message field, not sent) and when the
 * app's icon is held. Kept up to date on join / leave / rename / delete, a
 * new message (the order — throttled), the lock and the settings; a room
 * that is gone loses its shortcut (a pinned one is renamed and disabled).
 *
 * Privacy (Settings › Notifications › Android conversations): a shortcut
 * names its room only while the app is unlocked and notifications may name
 * the room; otherwise — and once the app locks, also by the auto-lock time
 * in the background (a timer and an alarm, as a frozen process misses the
 * timer) or at a start while locked — every one is relabelled "Conversation
 * n" with a numbered monogram. The ids are keyed (nothing of the name) and
 * the intents carry only the id. Switched off: all of them go.
 *
 * Bubbles are not offered: a bubble needs an embeddable, resizeable activity
 * of its own — the app has one singleTask activity carrying the lock, the
 * design and every screen.
 */
public final class Conversations implements Rooms.Listener, M5.Listener, Settings.Listener {
    private static final String TAG = "conversations";
    /** The vault's system tier (readable while locked): {k: the id key (hex), named: the last publish carried names}. */
    private static final String STORE = "conversations";
    private static volatile Conversations instance;

    public static Conversations get(M5 app) {
        Conversations c = instance;
        if (c == null) synchronized (Conversations.class) {
            if (instance == null) instance = new Conversations(app);
            c = instance;
        }
        return c;
    }

    private final M5 app;
    private final Object timing = new Object();
    private boolean started;
    private volatile boolean wiped;
    private volatile int visible;
    private byte[] secret;
    /** What was published last: the dynamic ids, what the system shows, the order, when, with names. */
    private final Set<String> published = new HashSet<>();
    private String lastSet = "", lastRank = "";
    private long lastAt;
    private volatile boolean named, dirty;
    private String lastActive = "";
    private ScheduledFuture<?> pending, lockCheck;
    private long pendingAt;

    private Conversations(M5 app) { this.app = app; }

    /** At the app's start: listens, and a start while locked turns names left from before neutral. */
    public synchronized void start() {
        if (started) return;
        started = true;
        app.settings.addListener(this);
        app.addListener(this);
        app.rooms.addListener(this);
        app.registerActivityLifecycleCallbacks(lifecycle);
        Io.bg(this::run);
    }

    private ShortcutManager sm() { return app.getSystemService(ShortcutManager.class); }
    private boolean on() { return !wiped && app.settings.bool(ConversationPlan.SETTING_ON); }

    /* ------------------------------------------------------------ events */

    @Override public void onSetting(String key, Object value) {
        if (key.equals(ConversationPlan.SETTING_ON) || key.equals(ConversationPlan.SETTING_NAMES) || key.equals("notify.privacy")) request();
    }

    @Override public void onAppState(String what) {
        if ("wiped".equals(what)) { wiped = true; return; }
        if ("unlocked".equals(what) || "locked".equals(what) || "design".equals(what)) request();
    }

    @Override public void onRoomsChanged() { request(); reportOpened(); }

    @Override public void onRoomMessage(String roomKey, ChatMessage message) { request(); }

    private final Application.ActivityLifecycleCallbacks lifecycle = new Application.ActivityLifecycleCallbacks() {
        @Override public void onActivityStarted(Activity a) { if (visible++ == 0) onForeground(); }
        @Override public void onActivityStopped(Activity a) { if (visible > 0 && --visible == 0) onBackground(); }
        @Override public void onActivityCreated(Activity a, Bundle b) { }
        @Override public void onActivityResumed(Activity a) { }
        @Override public void onActivityPaused(Activity a) { }
        @Override public void onActivitySaveInstanceState(Activity a, Bundle b) { }
        @Override public void onActivityDestroyed(Activity a) { }
    };

    /** Back in the foreground: no lock check needed; what waited for it (a new order, a refused call) goes now. */
    private void onForeground() {
        synchronized (timing) { if (lockCheck != null) { lockCheck.cancel(false); lockCheck = null; } }
        alarm(-1);
        if (dirty) { dirty = false; request(); }
    }

    /**
     * In the background the app locks by time (AppLock: no event): when the
     * shortcuts carry names, they go neutral then — a timer, and an alarm in
     * case the process is frozen or gone by then (a new process starts
     * locked and does the same).
     */
    private void onBackground() {
        if (!named) return;
        long ms = app.lock.autolockSeconds() * 1000L + 2_000;
        synchronized (timing) {
            if (lockCheck != null) lockCheck.cancel(false);
            lockCheck = Io.later(() -> Io.bg(this::run), ms);
        }
        alarm(ms);
    }

    /** A publish soon (changes close together become one). */
    public void request() { schedule(ConversationPlan.DEBOUNCE_MS); }

    private void schedule(long ms) {
        long at = System.currentTimeMillis() + ms;
        synchronized (timing) {
            if (pending != null && !pending.isDone()) {
                if (pendingAt <= at) return;
                pending.cancel(false);
            }
            pendingAt = at;
            pending = Io.later(() -> Io.bg(this::run), ms);
        }
    }

    private PendingIntent alarmIntent() {
        return PendingIntent.getBroadcast(app, 6801, new Intent(app, Alarm.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void alarm(long ms) {
        AlarmManager am = app.getSystemService(AlarmManager.class);
        if (am == null) return;
        try {
            if (ms < 0) am.cancel(alarmIntent());
            else am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + ms, alarmIntent());
        } catch (RuntimeException e) { Log.w(TAG, "alarm: " + e.getMessage()); }
    }

    /** The lock check of a frozen or ended process (an inexact alarm, no wake-up). */
    public static final class Alarm extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            M5 app = M5.get();
            if (app == null) return;
            PendingResult done = goAsync();
            Io.bg(() -> { try { get(app).run(); } finally { done.finish(); } });
        }
    }

    /* ------------------------------------------------------------- state */

    private synchronized JSONObject store() { return app.vault.json(Vault.Tier.SYS, STORE); }

    /** The key of the ids, made once per install (null while the system tier cannot keep it: no ids then). */
    private synchronized byte[] secret() {
        if (secret != null) return secret;
        JSONObject o = store();
        String k = o.optString("k");
        if (!k.matches("[0-9a-f]{32}")) {
            try { o.put("k", Crypto.hex(Crypto.random(16))); } catch (JSONException e) { return null; }
            app.vault.putJson(Vault.Tier.SYS, STORE, o);
            k = store().optString("k"); // read back: an id that changes with every start would churn the shortcuts
            if (!k.matches("[0-9a-f]{32}")) { Log.w(TAG, "the id key cannot be kept"); return null; }
        }
        secret = Crypto.unhex(k);
        return secret;
    }

    private synchronized void storeNamed(boolean v) {
        named = v;
        JSONObject o = store();
        if (o.optBoolean("named") == v && o.has("k")) return;
        try { o.put("named", v); } catch (JSONException ignored) { }
        app.vault.putJson(Vault.Tier.SYS, STORE, o);
    }

    private int privacyRank() { return NotifyTemplate.rank(NotifyPrefs.get(app).localPrivacy("message", false)); }

    private boolean namesNow() { return ConversationPlan.names(app.settings.bool(ConversationPlan.SETTING_NAMES), app.lock.isLocked(), privacyRank()); }

    private String tr(String key, String fallback) { String v = app.t(key); return v == null || v.equals(key) ? fallback : v; }

    private String neutralTemplate() { return tr("conversations.neutral", app.design().appName() + " {n}"); }

    private List<ConversationPlan.Room> rooms() {
        List<ConversationPlan.Room> out = new ArrayList<>();
        for (Rooms.Saved s : app.rooms.saved()) {
            RoomSession r = app.rooms.session(s.key);
            out.add(new ConversationPlan.Room(s.key, s.label, Math.max(s.lastActive, r == null ? 0 : r.lastActivity()), s.selected || r != null));
        }
        return out;
    }

    private List<ConversationPlan.Entry> plan(byte[] k, boolean names) {
        return ConversationPlan.plan(rooms(), key -> ConversationPlan.id(k, key), names, neutralTemplate());
    }

    /* ----------------------------------------------------------- publish */

    /** Brings the shortcuts in line with the rooms, the lock and the settings (on a background thread). */
    synchronized void run() {
        ShortcutManager sm = sm();
        if (sm == null || wiped) return;
        try {
            if (!on()) { clearAll(sm); return; }
            boolean locked = app.lock.isLocked();
            // A start while locked: the saved rooms are not readable yet — names left from before go neutral.
            if (!app.rooms.loaded()) { if (locked) neutralizeExisting(sm); return; }
            byte[] k = secret();
            if (k == null) return;
            boolean names = namesNow();
            List<ConversationPlan.Entry> all = plan(k, names);
            String set = ConversationPlan.setSignature(all, names), rank = ConversationPlan.rankSignature(all);
            long now = System.currentTimeMillis();
            long when = ConversationPlan.when(!set.equals(lastSet), !rank.equals(lastRank), visible > 0, now, lastAt);
            if (when == ConversationPlan.NOTHING) return;
            if (when == ConversationPlan.ON_FOREGROUND) { dirty = true; return; }
            if (when > 0) { schedule(when); return; }
            if (publish(sm, all, names)) { lastSet = set; lastRank = rank; lastAt = now; }
            else dirty = true;
        } catch (RuntimeException e) {
            Log.w(TAG, "publishing failed: " + e.getMessage());
        }
    }

    private boolean publish(ShortcutManager sm, List<ConversationPlan.Entry> all, boolean names) {
        List<ConversationPlan.Entry> top = ConversationPlan.top(all, ConversationPlan.cap(sm.getMaxShortcutCountPerActivity()));
        Set<String> keep = ConversationPlan.ids(all);
        removeStale(sm, keep);
        int size = iconSize(sm);
        List<ShortcutInfo> infos = new ArrayList<>();
        for (ConversationPlan.Entry e : top) infos.add(info(e, size));
        if (!sm.setDynamicShortcuts(infos)) {
            // Rate-limited (the background): a name must not stay in the launcher or the share sheet.
            Log.w(TAG, "rate-limited — again in the foreground");
            if (!names) { sm.removeAllDynamicShortcuts(); published.clear(); }
            return false;
        }
        published.clear();
        published.addAll(ConversationPlan.ids(top));
        // The cached (a notification's) and pinned ones beyond the dynamic set follow the label too.
        Map<String, ConversationPlan.Entry> byId = ConversationPlan.byId(all);
        List<ShortcutInfo> others = new ArrayList<>();
        for (ShortcutInfo si : kept(sm)) {
            ConversationPlan.Entry e = byId.get(si.getId());
            if (e != null && si.isEnabled() && !published.contains(e.id) && !e.label.contentEquals(String.valueOf(si.getShortLabel()))) others.add(info(e, size));
        }
        if (!others.isEmpty() && !sm.updateShortcuts(others)) return false;
        storeNamed(names && !all.isEmpty());
        Log.i(TAG, top.size() + " of " + all.size() + " rooms published" + (names ? "" : " (neutral)"));
        return true;
    }

    /** The cached and pinned shortcuts (API 29 has no cached ones). */
    private static List<ShortcutInfo> kept(ShortcutManager sm) {
        return Build.VERSION.SDK_INT >= 30 ? sm.getShortcuts(ShortcutManager.FLAG_MATCH_CACHED | ShortcutManager.FLAG_MATCH_PINNED) : sm.getPinnedShortcuts();
    }

    private static List<String> idsOf(List<ShortcutInfo> list) {
        List<String> out = new ArrayList<>();
        for (ShortcutInfo si : list) out.add(si.getId());
        return out;
    }

    /** Rooms left, deleted or renamed (and 6.7's ids): out of the dynamic set and the cache; a pinned one is renamed and disabled. */
    private void removeStale(ShortcutManager sm, Set<String> keep) {
        List<String> dynamic = ConversationPlan.stale(idsOf(sm.getDynamicShortcuts()), keep);
        if (!dynamic.isEmpty()) sm.removeDynamicShortcuts(dynamic);
        if (Build.VERSION.SDK_INT >= 30) {
            List<String> gone = new ArrayList<>(dynamic);
            for (String id : ConversationPlan.stale(idsOf(sm.getShortcuts(ShortcutManager.FLAG_MATCH_CACHED)), keep)) if (!gone.contains(id)) gone.add(id);
            if (!gone.isEmpty()) sm.removeLongLivedShortcuts(gone);
        }
        List<String> retire = new ArrayList<>(), enable = new ArrayList<>();
        for (ShortcutInfo si : sm.getPinnedShortcuts()) {
            if (!ConversationPlan.ours(si.getId())) continue;
            if (!keep.contains(si.getId())) { if (si.isEnabled()) retire.add(si.getId()); }
            else if (!si.isEnabled()) enable.add(si.getId()); // a room joined again
        }
        if (!enable.isEmpty()) sm.enableShortcuts(enable);
        retire(sm, retire);
    }

    /** Pinned shortcuts cannot be removed by the app: renamed to the app's name (when the system allows) and disabled. */
    private void retire(ShortcutManager sm, List<String> ids) {
        if (ids.isEmpty()) return;
        String appName = app.design().appName();
        List<ShortcutInfo> renamed = new ArrayList<>();
        for (String id : ids) renamed.add(new ShortcutInfo.Builder(app, id).setShortLabel(appName).setLongLabel(appName).build());
        try { sm.updateShortcuts(renamed); } catch (RuntimeException ignored) { }
        sm.disableShortcuts(ids, tr("conversations.gone", appName));
    }

    /** Switched off: every conversation of the app goes. */
    private void clearAll(ShortcutManager sm) {
        List<String> dynamic = ConversationPlan.stale(idsOf(sm.getDynamicShortcuts()), Collections.emptySet());
        if (!dynamic.isEmpty()) sm.removeDynamicShortcuts(dynamic);
        if (Build.VERSION.SDK_INT >= 30) {
            List<String> gone = new ArrayList<>(dynamic);
            for (String id : ConversationPlan.stale(idsOf(sm.getShortcuts(ShortcutManager.FLAG_MATCH_CACHED)), Collections.emptySet())) if (!gone.contains(id)) gone.add(id);
            if (!gone.isEmpty()) sm.removeLongLivedShortcuts(gone);
        }
        List<String> pinned = new ArrayList<>();
        for (ShortcutInfo si : sm.getPinnedShortcuts()) if (ConversationPlan.ours(si.getId()) && si.isEnabled()) pinned.add(si.getId());
        retire(sm, pinned);
        published.clear();
        lastSet = "";
        lastRank = "";
        if (named || store().optBoolean("named")) storeNamed(false);
    }

    /** Locked without the rooms (a start): what the last publish named gets neutral labels and monograms. */
    private void neutralizeExisting(ShortcutManager sm) {
        if (!named && !store().optBoolean("named")) return;
        List<String> ids = new ArrayList<>();
        for (ShortcutInfo si : sm.getDynamicShortcuts()) if (ConversationPlan.ours(si.getId())) ids.add(si.getId());
        for (ShortcutInfo si : kept(sm)) if (ConversationPlan.ours(si.getId()) && si.isEnabled() && !ids.contains(si.getId())) ids.add(si.getId());
        int size = iconSize(sm);
        List<ShortcutInfo> neutral = new ArrayList<>();
        for (ConversationPlan.Entry e : ConversationPlan.neutralOf(ids, neutralTemplate())) {
            Icon icon = icon(e, size);
            neutral.add(new ShortcutInfo.Builder(app, e.id).setShortLabel(e.label).setLongLabel(e.label).setIcon(icon)
                .setPerson(new Person.Builder().setName(e.label).setKey(e.id).build()).build());
        }
        if (neutral.isEmpty() || sm.updateShortcuts(neutral)) {
            storeNamed(false);
            lastSet = "";
        } else if (!sm.getDynamicShortcuts().isEmpty()) {
            sm.removeAllDynamicShortcuts(); // rate-limited: at least not in the launcher and the share sheet
        }
    }

    /* ------------------------------------------------------------ pieces */

    private static int iconSize(ShortcutManager sm) { return Math.max(96, Math.min(256, sm.getIconMaxWidth())); }

    /** The room's monogram as the web draws it (contacts/Avatars), on an adaptive icon. */
    private static Icon icon(ConversationPlan.Entry e, int size) {
        Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        c.drawColor(ConversationPlan.background(e.seed));
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(ConversationPlan.foreground(e.seed));
        p.setTypeface(Typeface.DEFAULT_BOLD);
        p.setTextAlign(Paint.Align.CENTER);
        p.setTextSize(size * (e.glyph.length() > 1 ? 0.24f : 0.30f));
        c.drawText(e.glyph, size / 2f, size / 2f - (p.descent() + p.ascent()) / 2f, p);
        return Icon.createWithAdaptiveBitmap(b);
    }

    /** A conversation shortcut: long-lived, with a Person and a LocusId, in the share category; its intent carries only the id. */
    private ShortcutInfo info(ConversationPlan.Entry e, int size) {
        Intent open = new Intent(app, MainActivity.class).setAction(Intent.ACTION_VIEW).putExtra(Intent.EXTRA_SHORTCUT_ID, e.id);
        return new ShortcutInfo.Builder(app, e.id)
            .setShortLabel(e.label).setLongLabel(e.label).setIcon(icon(e, size)).setIntent(open)
            .setLongLived(true).setLocusId(new LocusId(e.id))
            .setPerson(new Person.Builder().setName(e.label).setKey(e.id).build())
            .setCategories(Collections.singleton(ConversationPlan.CATEGORY)).setRank(e.rank)
            .build();
    }

    /* ------------------------------------------------- for the rest of the app */

    /**
     * The conversation a room's message notification belongs to (Notify:
     * setShortcutId + setLocusId), its shortcut published when it is not
     * yet — or null: switched off, the app locked (S11), or no shortcut.
     */
    public String forNotification(String roomKey) {
        if (roomKey == null || !on() || app.lock.isLocked()) return null;
        byte[] k = secret();
        if (k == null) return null;
        String id = ConversationPlan.id(k, roomKey);
        synchronized (this) {
            if (!published.contains(id)) {
                ShortcutManager sm = sm();
                ConversationPlan.Entry entry = null;
                boolean names = namesNow();
                for (ConversationPlan.Entry e : plan(k, names)) if (e.id.equals(id)) entry = e;
                if (sm == null || entry == null) return null;
                try {
                    ShortcutInfo si = info(entry, iconSize(sm));
                    // pushDynamicShortcut (API 30) makes room for it itself; Android 10 adds it while there is room.
                    if (Build.VERSION.SDK_INT >= 30) sm.pushDynamicShortcut(si);
                    else if (!sm.addDynamicShortcuts(Collections.singletonList(si))) return null;
                    published.add(id);
                    if (names) storeNamed(true);
                } catch (RuntimeException e) {
                    Log.w(TAG, "a notification's shortcut: " + e.getMessage());
                    return null;
                }
            }
        }
        request();
        return id;
    }

    /** The saved room a conversation shortcut (or a direct share into it) stands for, or null. */
    public String roomOf(String id) {
        if (id == null || !id.startsWith(ConversationPlan.PREFIX)) return null;
        byte[] k = secret();
        if (k == null) return null;
        for (Rooms.Saved s : app.rooms.saved()) if (id.equals(ConversationPlan.id(k, s.key))) return s.key;
        return null;
    }

    /** A room opened: the system learns which conversations are used (the share sheet's order). */
    private void reportOpened() {
        String active = app.rooms.active();
        if (active == null || active.isEmpty() || active.equals(lastActive)) return;
        lastActive = active;
        Io.bg(() -> {
            if (!on() || app.lock.isLocked()) return;
            byte[] k = secret();
            ShortcutManager sm = sm();
            if (k == null || sm == null) return;
            try { sm.reportShortcutUsed(ConversationPlan.id(k, active)); } catch (RuntimeException ignored) { }
        });
    }

    /**
     * "conversations.settings": "room" — the phone's settings of the room on
     * screen as a conversation (priority, sound, on the lock screen; Android
     * 11+, before its first notification and on Android 10 the messages
     * channel's); anything else — the app's notification settings, which
     * list its conversations on Android 11+.
     */
    public static void openSettings(Activity a, String arg) {
        String pkg = a.getPackageName();
        Intent general = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, pkg);
        Intent target = general;
        M5 app = M5.get();
        RoomSession r = app == null ? null : app.rooms.activeSession();
        if ("room".equals(arg) && r != null) {
            target = new Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, pkg).putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, Notify.CH_MESSAGES);
            byte[] k = get(app).secret();
            if (Build.VERSION.SDK_INT >= 30 && k != null) target.putExtra(android.provider.Settings.EXTRA_CONVERSATION_ID, ConversationPlan.id(k, r.key));
        }
        try { a.startActivity(target); }
        catch (RuntimeException e) {
            try { a.startActivity(general); } catch (RuntimeException ignored) { Log.w(TAG, "no notification settings: " + e.getMessage()); }
        }
    }
}
