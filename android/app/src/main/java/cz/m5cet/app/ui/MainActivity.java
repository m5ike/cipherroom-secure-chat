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
        getWindow().setDecorFitsSystemWindows(false);
        root = new FrameLayout(this);
        screenBox = new FrameLayout(this);
        overlay = new FrameLayout(this);
        root.addView(screenBox, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(overlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            screenBox.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            overlay.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
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
        if (!app.lock.isLocked()) openPendingRoom();
    }

    private void handleIntent(Intent i) {
        if (i == null) return;
        String room = i.getStringExtra("room");
        if (room != null) pendingRoom = room;
        Uri data = i.getData();
        if (data != null && "m5cet".equals(data.getScheme()) && "enroll".equals(data.getHost())) {
            form.put("server", data.getQueryParameter("server") == null ? "" : data.getQueryParameter("server"));
            form.put("code", data.getQueryParameter("code") == null ? "" : data.getQueryParameter("code"));
            form.put("kid", data.getQueryParameter("kid") == null ? "" : data.getQueryParameter("kid"));
        }
        if (Intent.ACTION_SEND.equals(i.getAction()) && "text/plain".equals(i.getType())) pendingShare = i.getStringExtra(Intent.EXTRA_TEXT);
    }

    private void applySecureFlag() {
        if (app.lock.screenshots()) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
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
        try { lockState.put("mode", "pin").put("setup", true).put("step", "enter").put("error", "").put("wait", 0).put("attempts", 0).put("left", app.lock.maxAttempts()).put("biometricAvailable", false); } catch (JSONException ignored) { }
        form.remove("pin1");
        stack.clear();
        showScreen("lock", true);
    }

    private void showLock() {
        boolean bio = app.lock.biometricAvailable();
        try {
            lockState.put("mode", bio ? "biometric" : "pin").put("setup", false).put("step", "enter").put("error", lockState.optString("error", ""))
                .put("wait", app.lock.waitSeconds()).put("attempts", app.lock.attempts()).put("left", app.lock.left()).put("biometricAvailable", bio);
        } catch (JSONException ignored) { }
        stack.clear();
        showScreen("lock", true);
        if (app.lock.waitSeconds() > 0) Io.mainLater(this::tickWait, 1000);
        else if (bio && !"off".equals(app.lock.biometricMode())) Io.mainLater(this::promptBiometric, 250);
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
                form.put("pin1", pin);
                try { lockState.put("step", "confirm").put("error", ""); } catch (JSONException ignored) { }
                refresh();
                return;
            }
            if (!pin.equals(form.get("pin1"))) {
                form.remove("pin1");
                try { lockState.put("step", "enter").put("error", app.t("lock.pinMismatch")); } catch (JSONException ignored) { }
                refresh();
                return;
            }
            try {
                app.lock.setUp(pin);
                form.remove("pin1");
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
            case OK: try { lockState.put("error", ""); } catch (JSONException ignored) { } enterApp(); break;
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
            @Override public void rejected() {
                AppLock.Result r = app.lock.failed("biometric");
                if (r == AppLock.Result.WIPED) { if (bioPrompt != null) bioPrompt.cancel(); handleLockResult(r); }
                else { try { lockState.put("attempts", app.lock.attempts()).put("left", app.lock.left()); } catch (JSONException ignored) { } refresh(); }
            }
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
        View decor = getWindow().getDecorView();
        decor.getWindowInsetsController();
        boolean dark = Ui.dark(this);
        if (decor.getWindowInsetsController() != null) {
            decor.getWindowInsetsController().setSystemBarsAppearance(dark ? 0 : android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        }
    }

    /** Binds the current screen again with fresh data (cheap: no views are rebuilt). */
    public void refresh() {
        if (current == null) return;
        try { current.bind(scopeFor(screen)); }
        catch (RuntimeException e) { Log.e("ui", "refresh of " + screen + " failed", e); }
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
        s.put("form", new JSONObject(form));
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
            case "settings": s.put("settings", new JSONObject()); break;
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
