package cz.m5cet.app;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.os.Bundle;

import java.util.concurrent.CopyOnWriteArrayList;

import cz.m5cet.app.account.Account;
import cz.m5cet.app.chat.Rooms;
import cz.m5cet.app.core.Config;
import cz.m5cet.app.core.Define;
import cz.m5cet.app.core.Events;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.core.Settings;
import cz.m5cet.app.design.Design;
import cz.m5cet.app.location.Where;
import cz.m5cet.app.net.Server;
import cz.m5cet.app.push.Checkin;
import cz.m5cet.app.push.Push;
import cz.m5cet.app.security.AppLock;
import cz.m5cet.app.security.Vault;
import cz.m5cet.app.security.Wiper;
import cz.m5cet.app.telecom.Notify;
import cz.m5cet.app.update.Bundles;
import cz.m5cet.app.update.Releases;
import cz.m5cet.app.voice.Voice;

/**
 * The application: one instance of every part of the framework. It also
 * starts in the background (an FCM control message, the check-in job), so
 * onCreate stays light — the rooms and the UI come later.
 */
public final class M5 extends Application {
    private static M5 instance;

    public static M5 get() { return instance; }

    public Vault vault;
    public Config config;
    public Define define; // 6.3 define
    public Settings settings;
    public Server server;
    public Events events;
    public AppLock lock;
    public Bundles bundles;
    public Releases releases;
    public Push push;
    public Rooms rooms;
    public Notify notify;
    public Checkin checkin;
    public Voice voice;
    public Where where;
    public Account account;
    private volatile Design design;
    private int started = 0;

    /** Whoever shows something (the activity) hears about state changes. */
    public interface Listener { void onAppState(String what); }
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        vault = new Vault(this);
        config = new Config(vault);
        define = new Define(this); // 6.3 define
        settings = new Settings(vault);
        server = new Server(config);
        events = new Events(this);
        lock = new AppLock(this);
        bundles = new Bundles(this);
        releases = new Releases(this);
        notify = new Notify(this);
        rooms = new Rooms(this);
        push = new Push(this);
        checkin = new Checkin(this);
        voice = new Voice(this);
        where = new Where(this);
        account = new Account(this);
        try {
            vault.sysKey();
            Log.attach(vault, line -> { /* problems reach the server as events only on request (status) */ });
        } catch (Exception e) {
            android.util.Log.e("m5", "the system key is not available", e);
        }
        Wiper.sendPending(this);
        installCrashHandler();
        notify.channels();
        Io.bg(() -> {
            push.init();
            Checkin.schedule(this);
            events.flush();
            cz.m5cet.app.telecom.CallLogBridge.fixLegacy(this); // 6.8: old call log rows lose their dialable "number"
            if (lock.isLocked()) notify.neutralizeAll(); // 6.10 (G-22): a process starts locked — what an earlier one showed goes neutral
        });
        registerActivityLifecycleCallbacks(new Lifecycle());
        cz.m5cet.app.telecom.Conversations.get(this).start(); // 6.8: the rooms as Android conversations
        Log.i("app", "M5cet " + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ") started");
    }

    private void installCrashHandler() {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                bundles.onCrash(e);
                events.add("crash", Events.detail("thread", t.getName(), "error", e.getClass().getName() + ": " + e.getMessage(), "bundle", bundles.activeId()));
                Log.e("crash", "uncaught on " + t.getName(), e);
                Log.flush();
            } catch (Throwable ignored) { }
            if (previous != null) previous.uncaughtException(t, e);
        });
    }

    /** The design in use: the active bundle's, or the built-in one. */
    public Design design() {
        Design d = design;
        if (d == null) {
            synchronized (this) {
                if (design == null) design = bundles.loadActive();
                d = design;
            }
        }
        return d;
    }

    public void reloadDesign() {
        synchronized (this) { design = null; }
        design();
        emit("design");
    }

    public String t(String key) { return design().t(key, lang()); }

    public String lang() {
        String l = config.lang();
        if (!l.isEmpty()) return l;
        String sys = java.util.Locale.getDefault().getLanguage();
        return sys.equals("cs") || sys.equals("sk") ? "cs" : sys.equals("de") ? "de" : "en";
    }

    /** The signed-in account's username ("" without an account). */
    public String accountName() { return account == null ? "" : account.username(); }

    public void addListener(Listener l) { listeners.add(l); }
    public void removeListener(Listener l) { listeners.remove(l); }
    public void emit(String what) { Io.main(() -> { for (Listener l : listeners) l.onAppState(what); }); }

    public void onUnlocked() {
        rooms.load();
        emit("unlocked");
    }

    public void onLocked() { whenLocked(); emit("locked"); }

    /**
     * 6.10 (G-22, G-24): what a lock takes away at once — at lockNow, and when
     * the auto-lock time passes in the background (AppLock has no event for
     * it: Conversations' timer and alarm call this) or a process starts (it
     * starts locked): the notifications go neutral, the History's list leaves
     * the memory. Any thread.
     */
    public void whenLocked() {
        if (notify != null) notify.neutralizeAll();
        cz.m5cet.app.ui.parts.CallLogUi.forget();
    }

    public void onWiped() { emit("wiped"); }

    public boolean inForeground() { return started > 0; }

    /** A fresh start after a wipe: the process goes, the launcher opens a new one. */
    public void restart() {
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i != null) {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            startActivity(i);
        }
        android.os.Process.killProcess(android.os.Process.myPid());
    }

    private final class Lifecycle implements ActivityLifecycleCallbacks {
        @Override public void onActivityStarted(Activity a) {
            if (started++ == 0) {
                lock.onForeground();
                rooms.onForeground();
                Io.bg(() -> checkin.runIfDue(false));
            }
        }
        @Override public void onActivityStopped(Activity a) {
            if (--started == 0) {
                lock.onBackground();
                rooms.onBackground();
                Log.flush();
            }
        }
        @Override public void onActivityCreated(Activity a, Bundle b) { }
        @Override public void onActivityResumed(Activity a) { }
        @Override public void onActivityPaused(Activity a) { }
        @Override public void onActivitySaveInstanceState(Activity a, Bundle b) { }
        @Override public void onActivityDestroyed(Activity a) { }
    }
}
