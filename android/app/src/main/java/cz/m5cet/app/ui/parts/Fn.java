package cz.m5cet.app.ui.parts;

import android.content.ContentValues;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONObject;

import java.io.OutputStream;
import java.util.Collection;
import java.util.List;
import java.util.TimeZone;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.Outgoing;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.fn.Api;
import cz.m5cet.app.fn.Assistant;
import cz.m5cet.app.fn.Command;
import cz.m5cet.app.fn.Commands;
import cz.m5cet.app.fn.FnView;
import cz.m5cet.app.fn.Run;
import cz.m5cet.app.fn.SpeechApi;
import cz.m5cet.app.fn.Suggestions;
import cz.m5cet.app.fn.Theme;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;

/**
 * Bridges the app to the {@code fn} package (6.1): chat commands (/…), a
 * command's outputs in a bubble (FnView), the AI assistant and server speech.
 * One per activity; it re-makes its clients when the server changes. The
 * composer's triggers and the command list are loaded for the account and
 * cached so suggestions and {@link #run} answer without waiting.
 */
final class Fn {
    private final MainActivity a;
    final Theme theme;
    private final Executor exec = Io.POOL;

    private String base = "";
    private Commands commands;
    private Assistant assistant;
    private SpeechApi speech;
    volatile Commands.Composer composer = Commands.DEFAULT_COMPOSER;
    volatile Commands.State state = Commands.UNKNOWN;
    private Api.Call running;

    Fn(MainActivity a) {
        this.a = a;
        // The app is resolved lazily: Parts (and this) are built as a field of the
        // activity, before its onCreate sets the app, so a.app() is null here.
        this.theme = new Theme() {
            @Override public int color(String token) { return Ui.color(a, token); }
            @Override public int dp(float value) { return Ui.dp(a, value); }
            @Override public Typeface typeface(boolean bold) { return Ui.typeface(app().design(), bold, false); }
            @Override public String text(String key) { return app().t(key); }
        };
    }

    private M5 app() { return a.app(); }

    private String bearer() { M5 app = app(); return app == null || app.account == null ? "" : app.account.bearer(); }

    private Commands commands() {
        M5 app = app();
        if (app == null) return commands != null ? commands : (commands = new Commands(""));
        String b = app.config.server();
        if (commands == null || !b.equals(base)) {
            base = b;
            commands = new Commands(b);
            assistant = null;
            speech = null;
            composer = commands.composer();
        }
        return commands;
    }

    Assistant assistant() { commands(); if (assistant == null) assistant = new Assistant(base); return assistant; }
    SpeechApi speech() { commands(); if (speech == null) speech = new SpeechApi(base); return speech; }
    String assistantBearer() { return bearer(); }
    Executor exec() { return exec; }

    private Run.Origin origin() {
        M5 app = app();
        RoomSession r = app.rooms.activeSession();
        return new Run.Origin(r == null ? null : r.label, app.config.deviceId(), app.lang(), TimeZone.getDefault().getID());
    }

    /** Loads the operator's composer triggers and the account's command list (both cached). */
    void load() {
        Commands c = commands();
        c.loadComposer(bearer(), exec, comp -> { composer = comp; Io.main(a::refresh); });
        c.refresh(bearer(), false, exec, st -> { state = st; Io.main(a::refresh); });
    }

    List<String> commandChars() { return composer.commandChars(); }
    List<String> operatorTags() { return composer.tags; }

    Suggestions.Result suggest(String text, int caret, Collection<String> names, List<String> recent) {
        commands();
        state = commands.state(bearer());
        return Suggestions.suggest(text, caret, composer, state, names, recent);
    }

    /**
     * A typed command runs on the server instead of being sent; false = not a
     * command, send it as text (App.tsx: only a known command is intercepted).
     */
    boolean run(RoomSession r, String text) {
        final M5 app = app();
        Commands c = commands();
        Commands.Parsed p = Commands.parseCommandLine(text, commandChars());
        if (p == null) return false;
        Commands.State st = c.state(bearer());
        Command cmd = st.find(p.keyword);
        if (cmd == null) {
            if (st.enabled == null) c.refresh(bearer(), true, exec, s2 -> { state = s2; Io.main(a::refresh); });
            return false;
        }
        JSONObject inputs = Commands.buildInputs(cmd, p.argText);
        final String keyword = cmd.keyword, name = cmd.name, visibility = cmd.visibility;
        // 6.5: the call shows at once as the sender's own bubble — pulsing, with
        // a loading indicator under the query, replaced in place when it answers.
        final String query = "/" + keyword + (p.argText == null || p.argText.trim().isEmpty() ? "" : " " + p.argText.trim());
        final cz.m5cet.app.chat.ChatMessage call = r != null ? r.startFnCall(keyword, name, query) : null;
        if (running != null) running.cancel();
        if (nfcSheet != null) { nfcSheet.close(); nfcSheet = null; }   // the replaced run's card read is cancelled
        running = c.run(bearer(), keyword, cmd.model, inputs, origin(), new Run.Listener() {
            private volatile String runId = "";
            @Override public void start(String id) { runId = id == null ? "" : id; }
            @Override public void interaction(Run.Interaction i) { Io.main(() -> ask(i, name)); }
            @Override public void error(String code, String message) {
                Io.main(() -> {
                    runEnded(runId);
                    if (call != null) r.fnCallStatus(call, "error", message == null || message.isEmpty() ? app.t("functions.failed") : message);
                    else a.flash("", app.t("functions.failed") + (message == null || message.isEmpty() ? "" : ": " + message), "error");
                });
            }
            @Override public void done(Run.Done d) { Io.main(() -> { runEnded(d.runId.isEmpty() ? runId : d.runId); deliver(r, d, keyword, name, visibility, call); }); }
        }, exec);
        return true;
    }

    /** showFnResult(): a room model sends its output end-to-end; a caller-only one shows it here. The call's own bubble (6.5) takes the answer or a status. */
    private void deliver(RoomSession r, Run.Done d, String keyword, String name, String visibility, cz.m5cet.app.chat.ChatMessage call) {
        M5 app = app();
        if (d.failedUnanswered()) {
            String msg = d.error == null ? "" : d.error.optString("message");
            if (call != null) r.fnCallStatus(call, "error", msg.isEmpty() ? app.t("functions.failed") : msg);
            else a.flash("", app.t("functions.failed") + (msg.isEmpty() ? "" : ": " + msg), "error");
            return;
        }
        Run.Message m = d.message(keyword, name, visibility);
        String body = m.text.isEmpty() ? app.t("functions.empty") : m.text;
        boolean anyone = r != null && r.peersScope().length() > 0;
        if (m.room && r != null && anyone) {
            Outgoing o = new Outgoing();
            o.text = body;
            o.forwardedFrom = "/" + keyword;
            o.fn = m.fn;
            o.fnLocal = m.local;
            RoomSession active = app.rooms.activeSession();
            java.util.List<String> to = recipients();
            if (active == r && to != null) for (String id : to) { String n = r.peerName(id); if (n != null) { o.recipients.add(id); o.recipientNames.add(n); } }
            r.send(o);
            // The answer went to the room as its own message; the call bubble shows it was sent.
            if (call != null) r.fnCallStatus(call, "ok", app.t("functions.sentToRoom"));
        } else {
            if (m.room) a.flash("", app.t("functions.localOnly"), "info");
            if (call != null) r.fnCallResult(call, body, callLocal(m, query(call)));
            else if (r != null) r.addLocalFn(keyword, m.name, body, m.local);
        }
    }

    /** The result kept in the call bubble: the model's local outputs, with the query so the bubble still shows it. */
    private static JSONObject callLocal(Run.Message m, String query) {
        JSONObject out = m.local != null ? m.local : new JSONObject();
        try { if (query != null) out.put("query", query); out.put("pending", false); } catch (org.json.JSONException ignored) { }
        return out;
    }

    private static String query(cz.m5cet.app.chat.ChatMessage call) {
        return call != null && call.fnLocal != null ? call.fnLocal.optString("query", null) : null;
    }

    /** The composer's current recipient selection (a private command), or null for everyone. */
    private java.util.List<String> recipients() {
        Object cur = a.form().get("msgTo");
        if (cur instanceof java.util.List) {
            java.util.List<String> out = new java.util.ArrayList<>();
            for (Object o : (java.util.List<?>) cur) out.add(String.valueOf(o));
            return out.isEmpty() ? null : out;
        }
        return null;
    }

    /* --------------------------------------------------- a running question */

    /** The open "nfc" sheet (6.6), at most one: a new NFC ask replaces it. */
    private NfcModelSheet nfcSheet;

    /**
     * A running model's question. 6.6: an "nfc" interaction is not a question —
     * the model asks this phone to read a card: the NFC sheet runs it and answers
     * with the NfcResult (the web's handleFnInteraction → runNfcCommand).
     */
    private void ask(Run.Interaction i, String modelName) {
        if ("nfc".equals(i.kind)) { nfc(i, modelName); return; }
        final android.app.AlertDialog[] holder = new android.app.AlertDialog[1];
        Consumer<Object> answer = value -> {
            commands().answer(bearer(), i.runId, i.id, value);
            if (holder[0] != null) holder[0].dismiss();
        };
        cz.m5cet.app.fn.FnAsk view = new cz.m5cet.app.fn.FnAsk(a, theme, i, answer);
        holder[0] = new android.app.AlertDialog.Builder(a)
            .setTitle(i.title().isEmpty() ? app().t("tools.ai") : i.title())
            .setView(view)
            .setOnCancelListener(x -> commands().answer(bearer(), i.runId, i.id, null))
            .create();
        holder[0].show();
    }

    private void nfc(Run.Interaction i, String modelName) {
        if (nfcSheet != null) { nfcSheet.close(); nfcSheet = null; }   // an older ask still open: cancelled
        final String bearer = bearer();
        final Commands c = commands();
        nfcSheet = NfcModelSheet.start(a, i.runId, i.spec, modelName, result -> c.answer(bearer, i.runId, i.id, result));
    }

    /** The run is over: a sheet still waiting for its card has nothing more to answer. */
    private void runEnded(String runId) {
        if (nfcSheet != null && (runId == null || runId.isEmpty() || runId.equals(nfcSheet.runId))) { nfcSheet.runEnded(); nfcSheet = null; }
    }

    /* ------------------------------------------------------ outputs (bubble) */

    FnView view() { return new FnView(a, theme, host); }

    private final FnView.Host host = new FnView.Host() {
        @Override public void event(JSONObject meta, JSONObject ev, Consumer<Boolean> done) {
            RoomSession r = app().rooms.activeSession();
            running = commands().event(bearer(), meta, ev, origin(), new Run.Listener() {
                private volatile String runId = "";
                @Override public void start(String id) { runId = id == null ? "" : id; }
                @Override public void interaction(Run.Interaction i) { Io.main(() -> ask(i, meta.optString("name"))); }
                @Override public void error(String code, String message) {
                    Io.main(() -> {
                        runEnded(runId);
                        if ("expired".equals(code)) a.flash("", app().t("fnui.expired"), "warn");
                        else a.flash("", app().t("fnui.eventFailed") + (message == null || message.isEmpty() ? "" : ": " + message), "error");
                        done.accept(false);
                    });
                }
                @Override public void done(Run.Done d) {
                    Io.main(() -> {
                        runEnded(d.runId.isEmpty() ? runId : d.runId);
                        deliver(r, d, meta.optString("keyword"), meta.optString("name"), d.visibility == null ? "caller" : d.visibility, null);
                        done.accept(!d.failedUnanswered());
                    });
                }
            }, exec);
        }

        @Override public void flash(String text, String level) { a.flash("", text, level); }

        @Override public void openLink(String url) { a.openUrl(url); }

        @Override public void report(JSONObject meta, JSONObject ev) {
            RoomSession r = app().rooms.activeSession();
            commands().report(bearer(), meta, ev, origin(), exec, d -> {
                if (d != null) Io.main(() -> deliver(r, d, meta.optString("keyword"), meta.optString("name"), d.visibility == null ? "caller" : d.visibility, null));
            });
        }

        @Override public void file(String name, String mime, byte[] data, boolean open) {
            Io.bg(() -> {
                try {
                    Uri uri = saveToDownloads(name, mime, data);
                    Io.main(() -> {
                        if (uri == null) { a.flash("", app().t("file.failed"), "error"); return; }
                        if (open) {
                            try {
                                a.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW)
                                    .setDataAndType(uri, mime == null ? "application/octet-stream" : mime)
                                    .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION));
                                return;
                            } catch (RuntimeException ignored) { }
                        }
                        a.flash("", app().t("file.saved"), "success");
                    });
                } catch (Exception e) {
                    Log.w("fn", "file not saved: " + e.getMessage());
                    Io.main(() -> a.flash("", app().t("file.failed"), "error"));
                }
            });
        }
    };

    /** Saves a command's file into Downloads (MediaStore, no permission on API 29+). */
    private Uri saveToDownloads(String name, String mime, byte[] data) throws Exception {
        String safe = name == null || name.trim().isEmpty() ? "m5-" + System.currentTimeMillis() : name.trim();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
        if (mime != null && !mime.isEmpty()) v.put(MediaStore.Downloads.MIME_TYPE, mime);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        Uri uri = a.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) return null;
        try (OutputStream out = a.getContentResolver().openOutputStream(uri)) {
            if (out != null) out.write(data);
        }
        return uri;
    }
}
