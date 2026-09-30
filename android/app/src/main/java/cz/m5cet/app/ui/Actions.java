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
                case "theme.toggle": app.settings.set("appearance.tone", Ui.dark(a) ? "light" : "dark"); a.recreate(); break;
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
                case "setting.set": {
                    int eq = s.indexOf('=');
                    if (eq > 0 && app.settings.set(s.substring(0, eq).trim(), s.substring(eq + 1).trim())) { a.settingChanged(s.substring(0, eq).trim()); a.refresh(); }
                    break;
                }
                case "setting.toggle": if (app.settings.toggle(s.trim())) { a.settingChanged(s.trim()); a.refresh(); } break;
                // 6.1: sheets, the composer, message kinds and actions on a message
                case "sheet.open": a.parts.showSheet(s); break;
                case "sheet.close": a.parts.closeOverlay(); break;
                case "compose": a.parts.composerAction(s, null); break;
                case "message.kind": a.parts.messageKind(s); break;
                case "message.recipients": a.parts.closeOverlay(); a.parts.pickRecipients(); break;
                case "msg.map": case "msg.source": case "msg.open": a.parts.onMessageAction(action, s); break;
                // voice
                case "voice.speak": if (!s.isEmpty()) app.voice.say(s); break;
                case "voice.stop": app.voice.stopSpeaking(); break;
                case "voice.dictate": a.parts.voicePadDictate(); break;
                // tools
                case "ai.send": a.parts.aiSend(); break;
                case "ai.stop": a.parts.aiStop(); break;
                case "ai.clear": a.parts.aiClear(); break;
                case "nfc.read": case "nfc.write": case "nfc.emulate": case "nfc.stop": a.parts.nfc(action.substring(4)); break;
                // account, security
                case "account.signin": a.accountSignIn(false); break;
                case "account.signup": a.accountSignIn(true); break;
                case "account.signout": a.accountSignOut("everywhere".equals(s)); break;
                // 6.2 fixes: reaching a device-bound account elsewhere
                case "account.recovery": cz.m5cet.app.account.AccountDialogs.recoveryCode(a); break;
                case "account.addPasskey": cz.m5cet.app.account.AccountDialogs.addPasskey(a); break;
                case "pin.change": a.parts.changePin(); break;
                case "biometric.toggle": a.toggleBiometric(); break;
                case "wipe.ask": a.parts.askWipe(); break;
                case "system.settings": a.systemSettings(s); break;
                // calls
                case "call.audioText": {
                    RoomSession r = app.rooms.activeSession();
                    if (r == null) break;
                    if (!a.has(Manifest.permission.RECORD_AUDIO)) { a.askPermissions(Manifest.permission.RECORD_AUDIO); break; }
                    a.parts.closeOverlay();
                    r.calls().startAudioText();
                    CallService.start(a, r.label, false);
                    a.showScreen("call", true);
                    break;
                }
                case "call.camera": { RoomSession r = app.rooms.activeSession(); if (r != null) r.calls().toggleCamera(); break; }
                case "call.switchCamera": { RoomSession r = app.rooms.activeSession(); if (r != null) r.calls().switchCamera(); break; }
                case "call.speaker": app.settings.toggle("calls.speaker"); { RoomSession r = app.rooms.activeSession(); if (r != null) r.calls().route(); } a.refresh(); break;
                case "appearance.reset": for (String k : new String[]{"appearance.tone", "appearance.preset", "appearance.accent", "appearance.fontScale", "appearance.density", "appearance.bubbles"}) app.settings.set(k, cz.m5cet.app.core.Settings.DEFAULTS.get(k)); a.recreate(); break;
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
