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
                // 6.7 look: a saved room's swipe actions (asked delete, clone, edit)
                case "room.delete": case "room.clone": case "room.edit": cz.m5cet.app.ui.parts.RoomEdit.run(a, action, s); break;
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
                case "url.open": DesignUrls.confirmOpen(a, s); break; // 6.7 (F-01): the address is shown first
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
                // 6.2 look: the look changed in place (the screen is drawn again, no restart)
                case "look.set": { int eq = s.indexOf('='); if (eq > 0) cz.m5cet.app.ui.look.Look.set(s.substring(0, eq).trim(), s.substring(eq + 1).trim()); break; }
                case "look.reset": cz.m5cet.app.ui.look.Look.reset(); break;
                case "compose": a.parts.composerAction(s, null); break;
                case "message.kind": a.parts.messageKind(s); break;
                case "message.recipients": a.parts.closeOverlay(); a.parts.pickRecipients(); break;
                case "msg.map": case "msg.source": case "msg.open": a.parts.onMessageAction(action, s); break;
                // 6.2 bubbles: the details (timeline, hide, delete), a header position's map, the attachment's actions, hidden messages
                case "msg.info": case "msg.mapPreview": case "msg.save": case "msg.share": case "msg.forward": case "msg.showHidden": a.parts.onMessageAction(action, s); break;
                // voice
                case "voice.speak": if (!s.isEmpty()) app.voice.say(s); break;
                case "voice.stop": app.voice.stopSpeaking(); break;
                case "voice.dictate": a.parts.voicePadDictate(); break;
                // tools
                case "ai.send": a.parts.aiSend(); break;
                case "ai.stop": a.parts.aiStop(); break;
                case "ai.clear": a.parts.aiClear(); break;
                case "nfc.read": case "nfc.write": case "nfc.emulate": case "nfc.stop": a.parts.nfc(action.substring(4)); break;
                // ---- 6.3 nfc (the workbench, the M5Cet card builder, the reader choice) ----
                case "nfc.workbench": a.showScreen("nfc", true); break;
                case "nfc.builder": a.showScreen("nfc.builder", true); break;
                case "nfc.reader":
                    if (s.equals("internal") || s.equals("usb") || s.equals("bluetooth")) { app.settings.set("nfc.reader", s); a.refresh(); }
                    break;
                // account, security
                case "account.signin": a.accountSignIn(false); break;
                case "account.signup": a.accountSignIn(true); break;
                case "account.signout": a.accountSignOut("everywhere".equals(s)); break;
                // 6.2 fixes: reaching a device-bound account elsewhere
                case "account.recovery": cz.m5cet.app.account.AccountDialogs.recoveryCode(a); break;
                case "account.addPasskey": cz.m5cet.app.account.AccountDialogs.addPasskey(a); break;
                // 6.4: registration (name, country, mobile, e-mail → an account with a passkey)
                case "account.register": cz.m5cet.app.account.RegisterDialog.show(a); break;
                case "pin.change": a.parts.changePin(); break;
                case "biometric.toggle": a.toggleBiometric(); break;
                case "wipe.ask": a.parts.askWipe(); break;
                case "system.settings": a.systemSettings(s); break;
                // 6.7 notify: the channel order, a test, sending the settings now
                case "notify.up": case "notify.down": case "notify.use": case "notify.drop": case "notify.test": case "notify.sync":
                    cz.m5cet.app.push.NotifyPrefs.get(app).run(a, action, s);
                    break;
                // 6.8 conversations: the phone's settings of the room on screen as a conversation (priority…)
                case "conversations.settings": cz.m5cet.app.telecom.Conversations.openSettings(a, s); break;
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
                case "appearance.reset": cz.m5cet.app.ui.look.Look.reset(); break;
                // ---- 6.2 fixes (lock, enrolment, passkeys) ----

                // ---- 6.2 people (People widget, contacts) ----
                case "people.open": case "people.select": case "people.all": case "people.none": case "people.message": case "people.call":
                case "people.video": case "people.verify": case "people.link": case "people.unlink": case "people.unlinkAll":
                    a.parts.people().run(action, s);
                    break;

                // ---- 6.7 profile (the profile card, a person's public profile) ----
                case "profile.open": case "profile.pick": case "profile.clear": case "profile.field": case "profile.sync": case "profile.save": case "profile.public":
                    cz.m5cet.app.ui.parts.ProfileUi.run(a, action, s);
                    break;

                // ---- 6.2 bubbles (message details, attachments, hide/delete) ----

                // ---- 6.2 look (templates, Tools dock, send button, microphone) ----

                // ---- 6.7 voice (the voice changer: test, reset) ----
                case "voiceFx.test":
                    if (!a.has(Manifest.permission.RECORD_AUDIO)) { a.askPermissions(Manifest.permission.RECORD_AUDIO); break; }
                    cz.m5cet.app.voice.FxTest.toggle(app, a::refresh);
                    break;
                case "voiceFx.reset": cz.m5cet.app.voice.MicFx.resetCustom(app); a.refresh(); break;

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
