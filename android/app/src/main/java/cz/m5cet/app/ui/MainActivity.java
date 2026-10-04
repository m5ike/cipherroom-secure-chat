package cz.m5cet.app.ui;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.PopupMenu;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

import javax.crypto.Cipher;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.chat.Rooms;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.design.Design;
import cz.m5cet.app.security.AppLock;
import cz.m5cet.app.security.Biometric;
import cz.m5cet.app.security.Wiper;
import cz.m5cet.app.ui.parts.Parts;

/**
 * The one activity of the framework. Screens are the design's trees
 * (Renderer), switched with the design's transitions; the app's native
 * parts plug into their slots; every action a tree can name is carried out
 * here in Java. Nothing of the look is fixed in code.
 */
public final class MainActivity extends Activity implements Renderer.Host, Renderer.AnimationGate, M5.Listener, Rooms.Listener {
    private M5 app;
    private FrameLayout root, screenBox, overlay;
    private Renderer renderer;
    private Renderer.Bound current;
    private String screen = "";
    private final ArrayDeque<String> stack = new ArrayDeque<>();
    private final Map<String, Object> form = new HashMap<>();
    /** 6.7 (audit S14): the first entry of a new PIN — kept here, never in $form, which the design sees. */
    private String setupPin;
    private boolean animate = true;
    private long splashSince;
    private String splashStatus = "";
    private final JSONObject lockState = new JSONObject();
    private CancellationSignal bioPrompt;
    private String pendingRoom;
    private String pendingShare;
    public final Parts parts = new Parts(this);

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        app = M5.get();
        SystemBars.edgeToEdge(getWindow());
        root = new FrameLayout(this);
        screenBox = new FrameLayout(this);
        overlay = new FrameLayout(this);
        root.addView(screenBox, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(overlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int[] bars = SystemBars.insets(insets);
            screenBox.setPadding(bars[0], bars[1], bars[2], bars[3]);
            overlay.setPadding(bars[0], bars[1], bars[2], bars[3]);
            return SystemBars.consumed(insets);
        });
        setContentView(root);
        renderer = new Renderer(this, this);
        applySecureFlag();
        app.addListener(this);
        app.rooms.addListener(this);
        app.notify.setFlashSink(this::flash);
        app.bundles.setListener((state, id, p) -> { if (screen.equals("update")) refresh(); if (state.equals("ready")) offerUpdate("bundle"); if (state.equals("rolled-back")) flash("", app.t("update.failed"), "warn"); });
        app.releases.setListener((state, r, p) -> { if (screen.equals("update")) refresh(); if (state.equals("available") || state.equals("ready")) offerUpdate("release"); });
        handleIntent(getIntent());
        splashSince = System.currentTimeMillis();
        splashStatus = app.t("app.starting");
        showScreen("splash", false);
        Io.bg(() -> {
            app.design();
            Io.main(this::route);
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
        // 6.2 fixes: an enrolment link while the app is already open

        // 6.2 people: "message / call via M5cet" from the phone's contacts

        if (!app.lock.isLocked()) openPendingRoom();
    }

    private void handleIntent(Intent i) {
        if (i == null) return;
        String room = i.getStringExtra("room");
        if (room != null) pendingRoom = room;
        Uri data = i.getData();
        // 6.2: the console's QR link fills the enrolment form — at a cold start (route() shows it
        // next) and while the app is open (onNewIntent: the enrolment screen comes forward).
        // Taken once: not again after a recreate(), nor from the recent apps once enrolled.
        if (data != null && "m5cet".equalsIgnoreCase(data.getScheme()) && "enroll".equalsIgnoreCase(data.getHost())) {
            boolean again = (i.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
            if (!again || !app.config.enrolled()) cz.m5cet.app.ui.parts.Forms.enrollLink(this, data.toString());
            i.setData(null);
        }
        if (Intent.ACTION_SEND.equals(i.getAction()) && "text/plain".equals(i.getType())) pendingShare = i.getStringExtra(Intent.EXTRA_TEXT);
        // 6.2 fixes (enrolment link)

        // 6.2 people (a contact's M5cet row: message / call)
        cz.m5cet.app.contacts.ContactIntents.accept(this, i);

    }

    /* ------------------------------------------------ permissions (6.2) */

    /** What waits for a permission the user is being asked for (the microphone, the contacts…). */
    private final java.util.Map<String, Runnable> afterPermission = new java.util.HashMap<>();

    /** Runs then with the permission: at once when it is granted, else after the user allows it (not at all when refused). */
    public void withPermission(String perm, Runnable then) {
        if (has(perm)) { then.run(); return; }
        afterPermission.put(perm, then);
        askPermissions(perm);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        for (int i = 0; i < perms.length && i < results.length; i++) {
            Runnable then = afterPermission.remove(perms[i]);
            if (then != null && results[i] == PackageManager.PERMISSION_GRANTED) then.run();
        }
    }

    private void applySecureFlag() {
        if (app.lock.screenshots() || debugScreenshots()) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    /**
     * Debug builds only: screenshots for testing on a device, switched on by a marker in the
     * app's private files (adb shell run-as cz.m5cet.app touch files/debug-screenshots) —
     * reachable only with run-as, which already reads everything the app has. Release builds
     * never look.
     */
    private boolean debugScreenshots() {
        return BuildConfig.DEBUG && new java.io.File(getFilesDir(), "debug-screenshots").exists();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applySecureFlag();
        if (!screen.equals("splash") && !screen.equals("lock") && !screen.equals("enroll") && app.lock.isLocked() && app.lock.isSetUp()) route();
        app.rooms.setVisible(screen.equals("room"));
    }

    @Override
    protected void onPause() {
        super.onPause();
        app.rooms.setVisible(false);
    }

    @Override
    protected void onDestroy() {
        app.removeListener(this);
        app.rooms.removeListener(this);
        app.notify.setFlashSink(null);
        super.onDestroy();
    }

    /* ------------------------------------------------------------ routing */

    /** Where the app is: wiped, not enrolled, no PIN yet, locked, or in. */
    public void route() {
        long minSplash = app.design().anim("splash").optLong("minMs", 700);
        long wait = minSplash - (System.currentTimeMillis() - splashSince);
        if (screen.equals("splash") && wait > 0) { Io.mainLater(this::route, wait); return; }
        if (Wiper.hasPending(this) && !app.config.enrolled()) { flash("", app.t("lock.wiped"), "error"); }
        if (!app.config.enrolled()) { stack.clear(); showScreen("enroll", true); return; }
        if (!app.lock.isSetUp()) { setupLock(); return; }
        if (app.lock.isLocked()) { showLock(); return; }
        enterApp();
    }

    private void enterApp() {
        if (!app.rooms.connectedSessions().isEmpty() || !app.rooms.saved().isEmpty()) { /* loaded */ }
        app.rooms.load();
        stack.clear();
        requestNotifications();
        RoomSession active = app.rooms.activeSession();
        showScreen(active != null ? "room" : "rooms", true);
        openPendingRoom();
        Io.bg(() -> app.checkin.runIfDue(false));
    }

    private void openPendingRoom() {
        if (pendingRoom != null) {
            String k = pendingRoom;
            pendingRoom = null;
            app.rooms.switchTo(k);
            showScreen("room", true);
        }
        if (pendingShare != null && app.rooms.activeSession() != null) {
            form.put("composer", pendingShare);
            pendingShare = null;
            showScreen("room", true);
        }
    }

    private void requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    /* --------------------------------------------------------------- lock */

    private void setupLock() {
        try { lockState.put("mode", "pin").put("setup", true).put("step", "enter").put("error", "").put("wait", 0).put("attempts", 0).put("left", app.lock.maxAttempts()).put("biometricAvailable", false).put("wide", lockWide()); } catch (JSONException ignored) { }
        setupPin = null;
        stack.clear();
        showScreen("lock", true);
    }

    private void showLock() {
        boolean bio = app.lock.biometricAvailable();
        try {
            lockState.put("mode", bio ? "biometric" : "pin").put("setup", false).put("step", "enter").put("error", lockState.optString("error", ""))
                .put("wait", app.lock.waitSeconds()).put("attempts", app.lock.attempts()).put("left", app.lock.left()).put("biometricAvailable", bio).put("wide", lockWide());
        } catch (JSONException ignored) { }
        stack.clear();
        showScreen("lock", true);
        if (app.lock.waitSeconds() > 0) Io.mainLater(this::tickWait, 1000);
        else if (bio && !"off".equals(app.lock.biometricMode())) Io.mainLater(this::promptBiometric, 250);
    }

    /** 6.2: $lock.wide — the window is wider than tall (landscape, a split screen side by side). */
    private boolean lockWide() {
        android.content.res.Configuration c = getResources().getConfiguration();
        return c.screenWidthDp > c.screenHeightDp;
    }

    /** From the lock pad when the window changed (fold, turn, split): the lock tree may lay out anew. */
    public void lockResized() {
        if (!screen.equals("lock") || lockWide() == lockState.optBoolean("wide")) return;
        try { lockState.put("wide", lockWide()); } catch (JSONException ignored) { }
        refresh();
    }

    private void tickWait() {
        if (!screen.equals("lock")) return;
        try { lockState.put("wait", app.lock.waitSeconds()); } catch (JSONException ignored) { }
        refresh();
        if (app.lock.waitSeconds() > 0) Io.mainLater(this::tickWait, 1000);
    }

    /** From the lock pad: a full PIN was typed. */
    public void onPinEntered(String pin) {
        if (lockState.optBoolean("setup")) {
            if (pin.length() < app.lock.pinLength()) return;
            if ("enter".equals(lockState.optString("step"))) {
                setupPin = pin;
                try { lockState.put("step", "confirm").put("error", ""); } catch (JSONException ignored) { }
                refresh();
                return;
            }
            if (!pin.equals(setupPin)) {
                setupPin = null;
                try { lockState.put("step", "enter").put("error", app.t("lock.pinMismatch")); } catch (JSONException ignored) { }
                refresh();
                return;
            }
            try {
                app.lock.setUp(pin);
                setupPin = null;
                if (!"off".equals(app.lock.biometricMode()) && Biometric.available(this)) enrollBiometric();
                else enterApp();
            } catch (Exception e) {
                Log.e("lock", "setup failed", e);
                flash("", e.getMessage(), "error");
            }
            return;
        }
        AppLock.Result r = app.lock.unlockWithPin(pin);
        handleLockResult(r);
    }

    private void handleLockResult(AppLock.Result r) {
        switch (r) {
            // 6.2: the account's session is checked (and unlocked with the kept root) once the vault is open
            case OK: try { lockState.put("error", ""); } catch (JSONException ignored) { } app.account.restore(); enterApp(); break;
            case WIPED: flash("", app.t("lock.wiped"), "error"); Io.mainLater(app::restart, 2500); break;
            default:
                try { lockState.put("error", r == AppLock.Result.WAIT ? "" : app.t("lock.wrongPin")); } catch (JSONException ignored) { }
                showLock();
        }
    }

    public void promptBiometric() {
        if (!screen.equals("lock") || app.lock.waitSeconds() > 0) return;
        Cipher cipher = app.lock.bioCipher();
        if (cipher == null) { showLock(); return; }
        if (bioPrompt != null) bioPrompt.cancel();
        bioPrompt = Biometric.prompt(this, cipher, app.t("lock.bioPrompt"), app.design().appName(), app.t("lock.bioCancel"), new Biometric.Callback() {
            @Override public void success(Cipher c) { bioPrompt = null; handleLockResult(app.lock.bioSucceeded(c)); }
            // 6.7 (audit N18): a finger that does not match is no guess at the PIN — BiometricPrompt locks
            // the sensor after a few; it no longer counts toward the wipe (a child's fingers could wipe it).
            @Override public void rejected() { refresh(); }
            @Override public void error(int code, CharSequence message) { bioPrompt = null; try { lockState.put("mode", "pin"); } catch (JSONException ignored) { } refresh(); }
        });
    }

    private void enrollBiometric() {
        try {
            Cipher c = app.vault.bioEnrollCipher();
            Biometric.prompt(this, c, app.t("settings.biometric"), app.t("lock.bioPrompt"), app.t("nav.close"), new Biometric.Callback() {
                @Override public void success(Cipher cipher) {
                    try { app.vault.finishBioEnroll(cipher); flash("", app.t("settings.biometric") + " ✓", "success"); }
                    catch (Exception e) { Log.e("lock", "biometric enrolment failed", e); }
                    enterApp();
                }
                @Override public void rejected() { }
                @Override public void error(int code, CharSequence m) { app.vault.disableBio(); enterApp(); }
            });
        } catch (Exception e) {
            Log.e("lock", "no biometric key", e);
            enterApp();
        }
    }

    public void toggleBiometric() {
        if (app.vault.bioEnrolled()) { app.vault.disableBio(); refresh(); }
        else enrollBiometric();
    }

    /* ------------------------------------------------------------ screens */

    public void showScreen(String id, boolean transition) {
        Design d = app.design();
        JSONObject tree = d.screen(id);
        if (tree == null) { Log.w("ui", "no screen " + id); return; }
        if (!screen.isEmpty() && !screen.equals(id) && !id.equals("lock") && !id.equals("enroll") && !screen.equals("splash") && !screen.equals("lock")) stack.push(screen);
        String from = screen;
        screen = id;
        animate = true;
        Renderer.Bound bound;
        try {
            bound = renderer.build(tree);
            bound.bind(scopeFor(id));
        } catch (RuntimeException e) {
            app.bundles.onRenderFailure(id, e);
            Log.e("ui", "screen " + id + " failed", e);
            JSONObject fallback = Design.builtIn(this).screen(id);
            bound = renderer.build(fallback);
            bound.bind(scopeFor(id));
        }
        View old = current == null ? null : current.root();
        current = bound;
        View v = bound.root();
        root.setBackgroundColor(Ui.color(this, "@background", Color.WHITE));
        screenBox.addView(v, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (old != null) {
            JSONObject spec = d.anim("screen");
            if (transition && !Ui.reducedMotion(this) && !from.equals(id)) {
                boolean back = !stack.isEmpty() && false;
                Renderer.animate(v, spec, this);
                old.animate().alpha(0f).setDuration(spec.optLong("ms", 240)).withEndAction(() -> screenBox.removeView(old)).start();
                if (back) v.setTranslationX(0);
            } else {
                screenBox.removeView(old);
            }
        }
        animate = false;
        app.rooms.setVisible(id.equals("room"));
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        SystemBars.lightBars(getWindow(), !Ui.dark(this));
    }

    /** Binds the current screen again with fresh data (cheap: no views are rebuilt). */
    public void refresh() {
        if (current == null) return;
        try { current.bind(scopeFor(screen)); }
        catch (RuntimeException e) { Log.e("ui", "refresh of " + screen + " failed", e); }
        parts.refreshSheet();
    }

    public String screen() { return screen; }

    @Override
    public void onBackPressed() {
        if (overlay.getChildCount() > 0 && parts.closeOverlay()) return;
        if (screen.equals("lock") || screen.equals("enroll") || screen.equals("splash")) { super.onBackPressed(); return; }
        if (stack.isEmpty()) { if (screen.equals("room")) { showScreen("rooms", true); stack.clear(); return; } moveTaskToBack(true); return; }
        String prev = stack.pop();
        String now = screen;
        screen = "";
        showScreen(prev, true);
        if (!stack.isEmpty() && stack.peek().equals(now)) stack.pop();
        if (!stack.isEmpty() && stack.peek().equals(prev)) stack.pop();
    }

    /* -------------------------------------------------------------- scope */

    JSONObject appScope() {
        JSONObject a = new JSONObject();
        try {
            a.put("name", app.design().appName()).put("version", BuildConfig.VERSION_NAME).put("code", BuildConfig.VERSION_CODE).put("bundle", app.design().version);
        } catch (JSONException ignored) { }
        return a;
    }

    public Expr.Scope scopeFor(String id) {
        Map<String, Object> s = new HashMap<>();
        s.put("app", appScope());
        // 6.7 (audit S14): the lock and enrolment screens do not see $form (nothing typed elsewhere leaks there).
        s.put("form", id.equals("lock") || id.equals("enroll") ? new JSONObject() : new JSONObject(form));
        s.put("settings", app.settings.scope());
        s.put("define", app.define.all()); // 6.3 define: $define.<name> reads m5mobile.define
        s.put("account", app.account.scope());
        switch (id) {
            case "splash": s.put("status", splashStatus); s.put("busy", true); break;
            case "lock": s.put("lock", lockState); break;
            case "enroll": s.put("enroll", jo("server", String.valueOf(form.getOrDefault("server", BuildConfig.DEFAULT_SERVER)), "error", String.valueOf(form.getOrDefault("enrollError", "")))); break;
            case "rooms": {
                JSONArray rooms = app.rooms.scope();
                s.put("rooms", rooms);
                s.put("selectedCount", (double) app.rooms.selectedCount());
                s.put("connectedCount", (double) app.rooms.connectedCount());
                s.put("unreadTotal", (double) app.rooms.unreadTotal());
                break;
            }
            case "join": s.put("error", String.valueOf(form.getOrDefault("joinError", ""))); break;
            case "room": case "call": {
                RoomSession r = app.rooms.activeSession();
                s.put("room", roomScope(r));
                JSONArray connected = new JSONArray();
                for (RoomSession c : app.rooms.connectedSessions()) connected.put(roomScope(c));
                s.put("rooms", connected);
                s.put("me", jo("name", app.config.userName()));
                JSONObject panel = app.config.usersPanel();
                s.put("users", jo("open", panel.optBoolean("open"), "dock", panel.optString("dock", "right"), "autoHide", panel.optBoolean("autoHide"), "count", (double) (r == null ? 0 : r.userCount())));
                s.put("call", jo("active", r != null && !"off".equals(r.calls().state()), "mode", r != null && r.calls().video() ? "video" : "audio", "muted", r != null && "muted".equals(r.calls().state()), "peers", (double) (r == null ? 0 : Math.max(0, r.userCount() - 1))));
                break;
            }
            case "settings.user": s.put("keys", keysScope()); s.put("connection", connectionScope()); break;
            case "settings.voice": case "voice": case "dictate.options":
                loadVoices();
                s.put("voices", voices);
                s.put("voice", jo("dictating", app.voice.dictating(), "listening", app.voice.listening(), "speaking", app.voice.speaking(), "available", cz.m5cet.app.voice.Dictation.available(app)));
                break;
            case "settings.location": {
                JSONObject pol = app.config.policy().optJSONObject("location");
                s.put("location", jo("permitted", app.where.permitted(), "tracking", app.where.tracking(), "allowed", pol == null || pol.optBoolean("track", true)));
                break;
            }
            case "settings.appearance": s.put("presets", cz.m5cet.app.design.Appearance.presets(app.lang(), app.design().appName())); break;
            case "settings.security":
                s.put("security", jo("biometricAvailable", !"off".equals(app.lock.biometricMode()) && Biometric.available(this), "biometric", app.vault.bioEnrolled(),
                    "pinLength", (double) app.lock.pinLength(), "maxAttempts", (double) app.lock.maxAttempts(), "wipe", app.config.lockPolicy().optBoolean("wipe", true), "screenshots", app.lock.screenshots()));
                break;
            case "attach": case "send.options": {
                String text = parts.composerText();
                s.put("composer", jo("hasText", !text.trim().isEmpty(), "tap", Boolean.TRUE.equals(form.get("msgTap")), "vanish", form.get("msgVanish") == null ? 0.0 : Expr.num(form.get("msgVanish")),
                    "sealed", form.get("msgSeal") != null, "private", form.get("msgTo") != null));
                break;
            }
            case "tools": s.put("tools", jo("ai", true, "voice", true, "nfc", cz.m5cet.app.nfc.Nfc.available(this))); break;
            case "call.options": { cz.m5cet.app.chat.RoomSession r = app.rooms.activeSession(); s.put("call", jo("active", r != null && !"off".equals(r.calls().state()))); break; }
            case "ai": s.put("ai", parts.aiScope()); break;
            case "nfc": s.put("nfc", parts.nfcScope()); s.put("room", roomScope(app.rooms.activeSession())); break;
            case "update": s.put("update", parts.updateScope()); break;
            case "about": {
                s.put("device", jo("id", app.config.deviceId(), "model", Build.MANUFACTURER + " " + Build.MODEL));
                s.put("server", jo("url", app.config.server(), "kid", app.config.serverKid(), "fingerprint", app.config.serverFingerprint()));
                break;
            }
            default: break;
        }
        return s::get;
    }

    JSONObject roomScope(RoomSession r) {
        if (r == null) return jo("key", "", "name", "", "users", 0.0, "unread", 0.0, "status", "offline", "connected", false);
        return jo("key", r.key, "name", r.label, "users", (double) r.userCount(), "unread", (double) r.unread(), "status", r.status(), "connected", r.connected(), "notice", r.notice(), "active", r.key.equals(app.rooms.active()));
    }

    public static JSONObject jo(Object... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]); } catch (JSONException ignored) { }
        return o;
    }

    /* --------------------------------------------------------------- host */

    @Override public Design design() { return app.design(); }
    @Override public boolean dark() { return Ui.dark(this); }
    @Override public Expr.Translate tr() { return app::t; }
    @Override public Map<String, Object> form() { return form; }
    @Override public Object setting(String key) { return app.settings.get(key); }
    @Override public void setSetting(String key, Object value) { if (app.settings.set(key, value)) { settingChanged(key); refresh(); } }

    /** 6.1: what a changed setting sets off — permissions, the tracking service, the look. */
    public void settingChanged(String key) {
        switch (key) {
            case "location.inHeader":
                if (app.settings.bool(key) && !app.where.permitted()) askPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION);
                else if (app.settings.bool(key)) app.where.current(l -> { });
                parts.refreshComposer();
                break;
            case "location.track": case "location.interval": case "location.precise":
                if (app.settings.bool("location.track") && !app.where.permitted()) { askPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION); break; }
                app.where.stopTracking();
                cz.m5cet.app.location.LocationService.sync(this);
                break;
            case "voice.lang": voices = null; loadVoices(); break;
            case "calls.speaker": { cz.m5cet.app.chat.RoomSession r = app.rooms.activeSession(); if (r != null) r.calls().route(); break; }
            default:
                // appearance.* / look.*: ui/look/Look redraws the screen in place (6.2) — no restart.
                break;
        }
    }

    /* ------------------------------------------------------- account (6.1) */

    public void accountSignIn(boolean signUp) {
        // 6.2: what follows a ceremony — a notice, or a choice (unknown passkey → create an account…)
        cz.m5cet.app.account.Account.Outcome done = r -> cz.m5cet.app.account.AccountDialogs.after(this, signUp, r);
        if (signUp) app.account.signUp(this, done); else app.account.signIn(this, done);
    }

    public void accountSignOut(boolean everywhere) {
        app.account.signOut(everywhere, (ok, err) -> { flash("", app.t("set.user.signout") + " ✓", "success"); refresh(); });
    }

    /** The phone's settings pages for the app. */
    public void systemSettings(String what) {
        try {
            Intent i;
            if ("notifications".equals(what)) i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
            else if ("location".equals(what)) i = new Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            else if ("nfc".equals(what)) i = new Intent(android.provider.Settings.ACTION_NFC_SETTINGS);
            else i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (RuntimeException e) {
            Log.w("ui", "settings: " + e.getMessage());
            // 6.6: a phone without an NFC settings screen of its own keeps it under the wireless settings.
            if ("nfc".equals(what)) try { startActivity(new Intent(android.provider.Settings.ACTION_WIRELESS_SETTINGS)); } catch (RuntimeException ignored) { }
        }
    }

    /* ------------------------------------------------- scopes of 6.1 */

    private JSONArray voices;

    /** The engine's voices for the chosen language ($voices), loaded once and then kept. */
    private void loadVoices() {
        if (voices != null) return;
        voices = new JSONArray();
        app.voice.speech.voices(list -> { voices = list; refresh(); });
    }

    /** The id of the device's signing key (what the server calls its kid). */
    private String deviceKid() {
        try { return cz.m5cet.app.security.Crypto.b64url(cz.m5cet.app.security.Crypto.sha256(cz.m5cet.app.security.Crypto.unb64(cz.m5cet.app.core.Config.signPublicKey()))).substring(0, 16); }
        catch (Exception e) { return "—"; }
    }

    private JSONObject keysScope() {
        String id = "—";
        try {
            cz.m5cet.app.chat.ChatIdentity ci = app.rooms.identityOrNull();
            if (ci != null) { String h = cz.m5cet.app.security.Crypto.hex(cz.m5cet.app.security.Crypto.sha256(cz.m5cet.app.security.Crypto.unb64(ci.publicKey))).toUpperCase(java.util.Locale.ROOT); id = h.substring(0, 4) + " " + h.substring(4, 8) + " " + h.substring(8, 12) + " " + h.substring(12, 16); }
        } catch (RuntimeException ignored) { }
        return jo("device", app.config.deviceId(), "deviceKey", deviceKid(), "identity", id, "server", app.config.serverFingerprint());
    }

    private JSONObject connectionScope() {
        java.util.List<cz.m5cet.app.chat.RoomSession> rooms = app.rooms.connectedSessions();
        int joined = 0;
        for (cz.m5cet.app.chat.RoomSession r : rooms) if (r.connected()) joined++;
        return jo("server", app.config.server(), "rooms", (double) joined, "status", joined > 0 ? "joined" : "offline", "push", app.push.enabled() ? "fcm" : "poll",
            "checkin", (double) app.checkin.lastAt(), "protocol", 2.0, "crypto", "v3", "turn", (double) cz.m5cet.app.rtc.Rtc.iceCount());
    }
    @Override public boolean animateEnter() { return animate; }
    @Override public View slot(String name, Renderer.Bound bound) { return parts.create(name, bound); }

    @Override
    public void action(String action, Object arg, Expr.Scope scope, View source) {
        Actions.run(this, action, arg, scope, source, 0);
    }

    public FrameLayout overlay() { return overlay; }
    public Renderer renderer() { return renderer; }

    /* ------------------------------------------------------------- events */

    @Override
    public void onAppState(String what) {
        switch (what) {
            case "locked": if (!screen.equals("lock")) showLock(); break;
            case "wiped": flash("", app.t("lock.wiped"), "error"); Io.mainLater(app::restart, 2500); break;
            case "design": {
                String now = screen;
                screen = "";
                current = null;
                screenBox.removeAllViews();
                showScreen(now.isEmpty() ? "rooms" : now, false);
                break;
            }
            case "device-blocked": case "device-wiped": case "device-retired": flash("", what, "error"); break;
            default: refresh();
        }
    }

    @Override public void onRoomsChanged() { if (screen.equals("rooms") || screen.equals("room") || screen.equals("call")) refresh(); parts.onRoomsChanged(); }

    @Override public void onRoomMessage(String roomKey, ChatMessage m) { parts.onRoomMessage(roomKey, m); }

    @Override public void onRoomMessageChanged(String roomKey, ChatMessage m) { parts.onRoomMessageChanged(roomKey, m); }

    /* -------------------------------------------------------------- flash */

    public boolean flash(String title, String text, String level) {
        return parts.flash(title, text, level);
    }

    private void offerUpdate(String kind) {
        if (!screen.equals("room") && !screen.equals("rooms") && !screen.equals("settings")) return;
        form.put("updateKind", kind);
        parts.showUpdateCard();
    }

    /* ------------------------------------------------------ small actions */

    public void copy(String text) {
        ClipboardManager cm = getSystemService(ClipboardManager.class);
        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("M5cet", text));
    }

    public void share(String text) {
        startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), null));
    }

    public void openUrl(String url) {
        if (url == null || !url.startsWith("https://")) return;
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    public void showMenu(String menuId, View anchor) {
        JSONArray items = app.design().menus.get(menuId);
        if (items == null || anchor == null) return;
        PopupMenu pm = new PopupMenu(this, anchor);
        Expr.Scope sc = scopeFor(screen);
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            String cond = it.optString("if", "");
            if (!cond.isEmpty() && !Expr.truthy(Expr.eval(cond, sc, tr()))) continue;
            android.view.MenuItem mi = pm.getMenu().add(0, i, i, Expr.render(it.optString("label"), sc, tr()));
            mi.setIcon(Icons.drawable(this, it.optString("icon"), Ui.dp(this, 20), Ui.color(this, "@onSurface")));
        }
        pm.setForceShowIcon(true);
        pm.setOnMenuItemClickListener(mi -> {
            JSONObject it = items.optJSONObject(mi.getItemId());
            String a = it.optString("arg", null);
            action(it.optString("action"), a == null ? null : Expr.value(a, sc, tr()), sc, anchor);
            return true;
        });
        pm.show();
    }

    public void askPermissions(String... perms) { requestPermissions(perms, 2); }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 7301 && result == RESULT_OK && data != null && data.getData() != null) parts.pickedImage(data.getData());
        if (request == 7302 && result == RESULT_OK && data != null) parts.savedTo(data.getData());
        if (request == 7303 && result == RESULT_OK && data != null && data.getData() != null) parts.pickedFile(data.getData());
        if (request == 7304 && result == RESULT_OK) parts.captured();
    }

    public boolean has(String perm) { return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED; }

    public void goRoom(String key) {
        app.rooms.switchTo(key);
        if (!screen.equals("room")) showScreen("room", true);
        else { current = null; screenBox.removeAllViews(); String s = screen; screen = ""; showScreen(s, false); }
    }

    public void finishJoin(String room, String pass, String name) {
        if (room.trim().isEmpty() || pass.isEmpty()) { form.put("joinError", app.t("join.passphrase")); refresh(); return; }
        form.put("joinError", "");
        String key = app.rooms.add(room, pass, name.trim().isEmpty() ? (app.config.userName().isEmpty() ? Build.MODEL : app.config.userName()) : name.trim(), true);
        parts.closeOverlay();
        goRoom(key);
    }

    public M5 app() { return app; }

    static { Activity.class.getName(); }
}
