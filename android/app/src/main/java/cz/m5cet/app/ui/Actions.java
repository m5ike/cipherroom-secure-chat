package cz.m5cet.app.ui;

import android.Manifest;
import android.view.View;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * Every action a screen tree, a menu or a library can name
 * (server/android/design.ts ACTIONS), implemented in Java. A library is a
 * list of these steps with optional conditions; it cannot call another
 * library (no loops), and each step is logged.
 */
public final class Actions {
    private Actions() {}

    static String text(Object arg) { return arg == null ? "" : Expr.toText(arg); }

    public static void run(MainActivity a, String action, Object arg, Expr.Scope scope, View source, int depth) {
        M5 app = a.app();
        String s = text(arg);
        Log.d("action", action + (s.isEmpty() ? "" : " " + s));
        try {
            switch (action) {
                case "screen.open": a.showScreen(s.isEmpty() ? "rooms" : s, true); break;
                case "back": a.onBackPressed(); break;
                case "menu.open": a.showMenu(s.isEmpty() ? "main" : s, source); break;
                case "room.join": a.parts.showJoin(); break;
                case "room.switch": if (!s.isEmpty()) a.goRoom(s); break;
                case "room.toggle": app.rooms.toggleSelected(s); break;
                case "rooms.connect": app.rooms.connectSelected(); a.refresh(); break;
                case "room.leave": app.rooms.leave(s); if (app.rooms.activeSession() == null) a.showScreen("rooms", true); else a.refresh(); break;
                case "room.forget": app.rooms.forget(s); a.refresh(); break;
                case "message.send": a.parts.sendComposer(); break;
                case "message.reply": a.parts.replyTo(s); break;
                case "message.copy": a.parts.copyMessage(s); break;
                case "users.toggle": a.parts.toggleUsers(); break;
                case "users.dock": a.parts.dockUsers(s.isEmpty() ? "right" : s); break;
                case "users.autoHide": a.parts.autoHideUsers(s.isEmpty() ? null : Expr.truthy(arg)); break;
                case "call.audio": case "call.video": {
                    RoomSession r = app.rooms.activeSession();
                    if (r == null) break;
                    boolean video = action.equals("call.video");
                    if (!a.has(Manifest.permission.RECORD_AUDIO) || (video && !a.has(Manifest.permission.CAMERA))) {
                        a.askPermissions(video ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA} : new String[]{Manifest.permission.RECORD_AUDIO});
                        break;
                    }
                    if (video) r.calls().startVideo(); else r.calls().startAudio();
                    CallService.start(a, r.label, video);
                    a.showScreen("call", true);
                    break;
                }
                case "call.end": {
                    RoomSession r = app.rooms.activeSession();
                    if (r != null) r.calls().stop();
                    CallService.stop(a);
                    if (a.screen().equals("call")) a.onBackPressed();
                    break;
                }
                case "call.mute": { RoomSession r = app.rooms.activeSession(); if (r != null) r.calls().mute(!"muted".equals(r.calls().state())); break; }
                case "lock.now": app.lock.lockNow(false); break;
                case "lock.biometric": a.parts.retryBiometric(); break;
                case "theme.toggle": app.config.setTone(Ui.dark(a) ? "light" : "dark"); a.recreate(); break;
                case "lang.set": if (s.equals("cs") || s.equals("en") || s.equals("de")) { app.config.setLang(s); a.recreate(); } break;
                case "update.check": Io.bg(() -> { boolean ok = app.checkin.run("manual"); Io.main(() -> a.flash("", ok ? app.t("update.none") : app.t("room.offline"), ok ? "info" : "warn")); }); break;
                case "update.install": a.parts.installUpdate(); break;
                case "update.later": a.parts.closeOverlay(); break;
                case "flash": a.flash("", s, "info"); break;
                case "url.open": a.openUrl(s); break;
                case "copy": a.copy(s); a.flash("", "✓", "success"); break;
                case "share": a.share(s); break;
                case "fn.run": { RoomSession r = app.rooms.activeSession(); if (r != null && s.startsWith("/")) r.send(s, null, null, null, null, 0); break; }
                case "set": {
                    int eq = s.indexOf('=');
                    if (eq > 0) { a.form().put(s.substring(0, eq).trim(), s.substring(eq + 1)); a.refresh(); }
                    break;
                }
                case "lib.run": runLibrary(a, s, scope, source, depth); break;
                default: Log.w("action", "unknown action " + action);
            }
        } catch (RuntimeException e) {
            Log.e("action", action + " failed", e);
        }
    }

    static void runLibrary(MainActivity a, String name, Expr.Scope scope, View source, int depth) {
        if (depth > 0) { Log.w("action", "a library cannot run another library"); return; }
        JSONObject lib = a.app().design().libraries.get(name);
        if (lib == null) { Log.w("action", "no library " + name); return; }
        JSONArray steps = lib.optJSONArray("steps");
        if (steps == null) return;
        for (int i = 0; i < steps.length() && i < 60; i++) {
            JSONObject st = steps.optJSONObject(i);
            if (st == null) continue;
            try {
                String cond = st.optString("if", "");
                if (!cond.isEmpty() && !Expr.truthy(Expr.eval(cond, scope, a.tr()))) continue;
                String arg = st.optString("arg", null);
                run(a, st.getString("do"), arg == null ? null : Expr.value(arg, scope, a.tr()), scope, source, depth + 1);
            } catch (JSONException | RuntimeException e) {
                Log.e("action", "library " + name + " step " + i + " failed", e);
                return;
            }
        }
    }
}
