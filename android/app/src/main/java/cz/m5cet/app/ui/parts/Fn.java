package cz.m5cet.app.ui.parts;

import android.content.ContentValues;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.TimeZone;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.function.Function;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.Outgoing;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.fn.Api;
import cz.m5cet.app.fn.ArgHint;
import cz.m5cet.app.fn.Assistant;
import cz.m5cet.app.fn.Command;
import cz.m5cet.app.fn.CommandCheck;
import cz.m5cet.app.fn.Commands;
import cz.m5cet.app.fn.FnView;
import cz.m5cet.app.fn.ModelIdentity;
import cz.m5cet.app.fn.Outputs;
import cz.m5cet.app.fn.Run;
import cz.m5cet.app.fn.RunWatch;
import cz.m5cet.app.fn.SpeechApi;
import cz.m5cet.app.fn.Suggestions;
import cz.m5cet.app.fn.Theme;
import cz.m5cet.app.fn.Usage;
import cz.m5cet.app.security.Vault;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.ui.bubble.ModelFace;

/**
 * Bridges the app to the {@code fn} package (6.1): chat commands (/…), a
 * command's outputs in a bubble (FnView), the AI assistant and server speech.
 * One per activity; it re-makes its clients when the server changes. The
 * composer's triggers and the command list are loaded for the account and
 * cached so suggestions and {@link #run} answer without waiting.
 *
 * 6.11 (client/src/lib/system-messenger.ts): a model's answer is an INCOMING
 * message from system-messenger — the model's name and icon — replying to
 * the command that asked (a room answer goes out with the model's identity
 * in its fn flags, and shows here the same way, "via you"). Every run has a
 * clock (RunWatch): 30 s without a sign of life ends it — the command's
 * bubble gets an error chip, a flash says so — an open question pauses it;
 * each run ends exactly once (a newer command cancels the one in flight). A
 * call that cannot run as typed (CommandCheck) is not sent: the model's
 * answer is an error card; the server's own refusal of the inputs too.
 */
final class Fn {
    private final MainActivity a;
    final Theme theme;
    private final Executor exec = Io.POOL;
    /** A run's events, in their order, on the main thread (a pool could reorder a progress and the end). */
    private final Executor main = Io::main;

    private String base = "";
    private Commands commands;
    private Assistant assistant;
    private SpeechApi speech;
    volatile Commands.Composer composer = Commands.DEFAULT_COMPOSER;
    volatile Commands.State state = Commands.UNKNOWN;
    /** 6.11: the runs in flight — a command's, a click's or a form's — each with its clock; the command's own (a newer one cancels it). */
    private final List<Live> live = new ArrayList<>();
    private Live command;
    private final Runnable watchdog = this::watch;
    /** 6.11: the commands this person runs (the suggester puts them first); in the vault's user tier. */
    private Usage usage;
    private static final String USAGE_RECORD = "fn-usage";

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

    private String t(String key) { return app().t(key); }

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
        // 6.7 (audit S21 / V2): the room's blind id (r3.…), never its plain name — the server keys
        // a model's session by it, and the name is the key derivation's salt.
        String id = r == null ? "" : r.roomId();
        return new Run.Origin(id.matches("r3\\.[A-Za-z0-9_-]{16,}") ? id : null, app.config.deviceId(), app.lang(), TimeZone.getDefault().getID());
    }

    /** Loads the operator's composer triggers and the account's command list (both cached). */
    void load() {
        Commands c = commands();
        c.loadComposer(bearer(), exec, comp -> { composer = comp; Io.main(a::refresh); });
        c.refresh(bearer(), false, exec, st -> { state = st; Io.main(a::refresh); });
    }

    List<String> commandChars() { return composer.commandChars(); }
    List<String> operatorTags() { return composer.tags; }

    /** The character a command starts with here ("/" unless the operator chose another). */
    String trigger() { List<String> c = commandChars(); return c.isEmpty() ? "/" : c.get(0); }

    Suggestions.Result suggest(String text, int caret, Collection<String> names, List<String> recent) {
        commands();
        state = commands.state(bearer());
        return Suggestions.suggest(text, caret, composer, state, names, recent, usage(), System.currentTimeMillis());
    }

    /** 6.11: the hint over the message box while a command's arguments are typed (null: none). */
    ArgHint hint(String text, int caret) {
        commands();
        return ArgHint.of(text, caret, commandChars(), commands.state(bearer()));
    }

    /* ---------------------------------------------------------- 6.11 usage */

    private Usage usage() {
        if (usage != null) return usage;
        M5 app = app();
        if (app == null || !app.vault.unlocked()) return new Usage();
        usage = Usage.from(app.vault.json(Vault.Tier.USER, USAGE_RECORD));
        return usage;
    }

    private void used(String keyword) {
        Usage u = usage();
        u.used(keyword, System.currentTimeMillis());
        M5 app = app();
        if (u == usage && app != null) Io.bg(() -> { if (app.vault.unlocked()) app.vault.putJson(Vault.Tier.USER, USAGE_RECORD, u.toJson()); });
    }

    /* ------------------------------------------------------------- a run */

    /** One run in flight: its clock, where its answer goes, what it is. */
    private final class Live {
        final RunWatch watch = new RunWatch(System.currentTimeMillis());
        final RoomSession room;
        /** The command's own bubble (null: a click or a form of a message). */
        final ChatMessage bubble;
        /** The message a click or a form came from (the answer replies to it); null for a command. */
        final ChatMessage origin;
        final ModelIdentity id;
        /** The command (null for a click or a form). */
        final Command cmd;
        /** "room" or "caller" when the server does not say. */
        final String visibility;
        /** A click's or a form's: FnView's busy state ends with whether the model answered. */
        final Consumer<Boolean> done;
        Api.Call call;
        String runId = "";
        /** The question of this run on screen, if any. */
        android.app.AlertDialog asking;

        Live(RoomSession room, ChatMessage bubble, ChatMessage origin, ModelIdentity id, Command cmd, String visibility, Consumer<Boolean> done) {
            this.room = room;
            this.bubble = bubble;
            this.origin = origin;
            this.id = id;
            this.cmd = cmd;
            this.visibility = visibility;
            this.done = done;
        }
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
        ModelIdentity id = ModelIdentity.of(cmd);
        used(cmd.keyword);
        // 6.5: the call shows at once as the sender's own bubble — pulsing, with
        // a loading indicator under the query; 6.11: then a status, the answer below it.
        final String query = trigger() + cmd.keyword + (p.argText == null || p.argText.trim().isEmpty() ? "" : " " + p.argText.trim());
        final ChatMessage call = r != null ? r.startFnCall(cmd.keyword, cmd.name, query, id.icon) : null;
        // A newer command replaces the one in flight: that one ends now ("cancelled" on its bubble).
        if (command != null) end(command, RunWatch.End.CANCELLED);
        if (nfcSheet != null) { nfcSheet.close(); nfcSheet = null; }   // the replaced run's card read is cancelled
        // 6.11: a call that cannot run as typed is not sent — the model's answer says what it expects.
        List<CommandCheck.Problem> problems = CommandCheck.check(cmd, inputs);
        if (!problems.isEmpty()) {
            if (call != null) r.fnCallStatus(call, "error", app.t("fnm.badCall"), "bad-input");
            badCall(r, call, cmd, id, problems, null);
            return true;
        }
        Live run = new Live(r, call, null, id, cmd, cmd.visibility, null);
        command = run;
        start(run, l -> c.run(bearer(), cmd.keyword, cmd.model, inputs, origin(), l, main));
        return true;
    }

    private void start(Live run, Function<Run.Listener, Api.Call> go) {
        live.add(run);
        run.call = go.apply(listener(run));
        arm();
    }

    /** What a run's stream says, on the main thread in its order. */
    private Run.Listener listener(Live run) {
        return new Run.Listener() {
            @Override public void alive() { run.watch.alive(System.currentTimeMillis()); arm(); }
            @Override public void start(String id) { run.runId = id == null ? "" : id; }
            @Override public void progress(double p, String text) {
                if (!run.watch.over() && run.bubble != null) run.room.fnCallProgress(run.bubble, p, text);
            }
            @Override public void interaction(Run.Interaction i) {
                if (run.watch.over()) return;
                run.watch.asked();
                arm();
                ask(run, i);
            }
            @Override public void error(String code, String message) { failed(run, code, message); }
            @Override public void done(Run.Done d) { finished(run, d); }
        };
    }

    /** The run's stream ended with an error: incomplete, the network, the server's refusal (HTTP), the server's error event. */
    private void failed(Live run, String code, String message) {
        if (!run.watch.settle(RunWatch.End.ERROR)) return;
        closed(run);
        String msg = message == null ? "" : message;
        if (run.cmd == null) {
            if ("expired".equals(code)) a.flash("", t("fnui.expired"), "warn");
            else a.flash("", t("fnui.eventFailed") + (msg.isEmpty() ? "" : ": " + msg), "error");
            if (run.done != null) run.done.accept(false);
            return;
        }
        if ("bad-input".equals(code)) {
            // The server refused the inputs: shown like a wrong call — what it said, the usage, the parameters.
            if (run.bubble != null) run.room.fnCallStatus(run.bubble, "error", t("fnm.badCall"), "bad-input");
            badCall(run.room, run.bubble, run.cmd, run.id, new ArrayList<>(), msg);
            return;
        }
        if (run.bubble != null) run.room.fnCallStatus(run.bubble, "error", msg.isEmpty() ? t("functions.failed") : msg, code);
        a.flash("", t("fnm.failed").replace("{keyword}", run.id.keyword), "error");
    }

    private void finished(Live run, Run.Done d) {
        if (!run.watch.settle(RunWatch.End.DONE)) return;
        closed(run);
        String vis = d.visibility != null ? d.visibility : run.visibility;
        deliver(run.room, run.bubble, run.origin, run.id, vis, d);
        if (run.done != null) run.done.accept(!d.failedUnanswered());
    }

    /** A run ended from here: a newer command replaced it, or its time was up (no sign of life for 30 s). */
    private void end(Live run, RunWatch.End how) {
        if (!run.watch.settle(how)) return;
        if (run.call != null) run.call.cancel();
        closed(run);
        if (how == RunWatch.End.CANCELLED) {
            if (run.bubble != null) run.room.fnCallStatus(run.bubble, "info", t("fnm.cancelled"), "cancelled");
        } else {
            if (run.bubble != null) run.room.fnCallStatus(run.bubble, "error", t("fnm.timeout").replace("{s}", String.valueOf(ModelIdentity.FN_RUN_TIMEOUT_MS / 1000)), "timeout");
            a.flash("", t("fnm.failed").replace("{keyword}", run.id.keyword), "error");
        }
        if (run.done != null) run.done.accept(false);
    }

    /** A run is over: out of the list, its question and card read go. */
    private void closed(Live run) {
        live.remove(run);
        if (command == run) command = null;
        if (run.asking != null) { try { run.asking.setOnCancelListener(null); run.asking.dismiss(); } catch (RuntimeException ignored) { } run.asking = null; }
        runEnded(run.runId);
        arm();
    }

    /** The clock: the run whose time is up ends; the next check comes when the next one would be. */
    private void watch() {
        long now = System.currentTimeMillis();
        for (Live run : new ArrayList<>(live)) if (run.watch.expired(now)) end(run, RunWatch.End.TIMEOUT);
        arm();
    }

    private void arm() {
        Io.cancelMain(watchdog);
        long now = System.currentTimeMillis(), next = Long.MAX_VALUE;
        for (Live run : live) next = Math.min(next, run.watch.remaining(now));
        if (next != Long.MAX_VALUE) Io.mainLater(watchdog, Math.max(10, next + 10));
    }

    /* ----------------------------------------------------------- answers */

    /**
     * showFnResult(): a room model sends its output end-to-end (6.11: with the
     * model's identity in the fn flags, a reply to the command here); a
     * caller-only one is an incoming message from system-messenger here. The
     * command's own bubble ends with a status.
     */
    private void deliver(RoomSession r, ChatMessage call, ChatMessage origin, ModelIdentity id, String visibility, Run.Done d) {
        if (d.failedUnanswered()) {
            String msg = d.error == null ? "" : d.error.optString("message");
            if (call != null) r.fnCallStatus(call, "error", msg.isEmpty() ? t("functions.failed") : msg, "failed");
            a.flash("", t("fnm.failed").replace("{keyword}", id.keyword) + (msg.isEmpty() ? "" : ": " + msg), "error");
            return;
        }
        Run.Message m = d.message(id.keyword, id.name, visibility, id.icon);
        ModelIdentity shown = ModelIdentity.fromJson(m.local);
        if (shown == null) shown = id;
        String body = m.text.isEmpty() ? t("functions.empty") : m.text;
        boolean anyone = r != null && r.peersScope().length() > 0;
        ChatMessage replyTo = call != null ? call : origin;
        if (m.room && r != null && anyone) {
            Outgoing o = new Outgoing();
            o.text = body;
            o.forwardedFrom = "/" + shown.keyword;
            o.fn = m.fn;
            o.fnLocal = m.local;
            // A reply to the command here (its own bubble is never sent: RoomSession keeps that quote here), or to the message clicked.
            o.replyTo = replyTo;
            RoomSession active = app().rooms.activeSession();
            List<String> to = recipients();
            if (active == r && to != null) for (String pid : to) { String n = r.peerName(pid); if (n != null) { o.recipients.add(pid); o.recipientNames.add(n); } }
            r.send(o);
            if (call != null) r.fnCallStatus(call, "ok", t("functions.sentToRoom"), "sent");
        } else {
            if (m.room) a.flash("", t("functions.localOnly"), "info");
            if (call != null) r.fnCallStatus(call, "ok", t("fnm.answered"), "answered");
            if (r != null) r.addModelAnswer(shown.toJson(), body, m.fn, m.local, replyTo);
        }
    }

    /** 6.11: the answer to a call that cannot run — an error card from the model: what is wrong, the usage, the parameters, its guide. */
    private void badCall(RoomSession r, ChatMessage call, Command cmd, ModelIdentity id, List<CommandCheck.Problem> problems, String serverMessage) {
        if (r == null) {
            a.flash("", t("fnm.error.title").replace("{keyword}", cmd.keyword), "error");
            return;
        }
        JSONArray outputs = CommandCheck.card(cmd, trigger(), problems, serverMessage, this::t);
        JSONObject fn = id.toJson();
        try {
            fn.put("outputs", outputs).put("problem", true).put("title", t("fnm.error.title").replace("{keyword}", cmd.keyword));
        } catch (JSONException e) { throw new IllegalStateException(e); }
        String text = fn.optString("title") + "\n\n" + Outputs.toMarkdown(outputs);
        r.addModelAnswer(id.toJson(), text, fn, null, call);
    }

    /** The composer's current recipient selection (a private command), or null for everyone. */
    private List<String> recipients() {
        Object cur = a.form().get("msgTo");
        if (cur instanceof List) {
            List<String> out = new ArrayList<>();
            for (Object o : (List<?>) cur) out.add(String.valueOf(o));
            return out.isEmpty() ? null : out;
        }
        return null;
    }

    /* --------------------------------------------------- a running question */

    /** The open "nfc" sheet (6.6), at most one: a new NFC ask replaces it. */
    private NfcModelSheet nfcSheet;

    /**
     * A running model's question (6.11: the run's clock waits for the
     * answer). 6.6: an "nfc" interaction is not a question — the model asks
     * this phone to read a card: the NFC sheet runs it and answers with the
     * NfcResult (the web's handleFnInteraction → runNfcCommand).
     */
    private void ask(Live run, Run.Interaction i) {
        Consumer<Object> reply = value -> {
            commands().answer(bearer(), i.runId, i.id, value);
            run.watch.answered(System.currentTimeMillis());
            arm();
        };
        if ("nfc".equals(i.kind)) {
            if (nfcSheet != null) { nfcSheet.close(); nfcSheet = null; }   // an older ask still open: cancelled
            nfcSheet = NfcModelSheet.start(a, i.runId, i.spec, run.id.name, reply::accept);
            return;
        }
        final android.app.AlertDialog[] holder = new android.app.AlertDialog[1];
        final boolean[] once = new boolean[1];
        Consumer<Object> answer = value -> {
            if (once[0]) return;
            once[0] = true;
            reply.accept(value);
            if (run.asking == holder[0]) run.asking = null;
            if (holder[0] != null) holder[0].dismiss();
        };
        cz.m5cet.app.fn.FnAsk view = new cz.m5cet.app.fn.FnAsk(a, theme, i, answer);
        holder[0] = new android.app.AlertDialog.Builder(a)
            .setTitle(i.title().isEmpty() ? run.id.name : i.title())
            .setView(view)
            .setOnCancelListener(x -> answer.accept(null))
            .create();
        run.asking = holder[0];
        holder[0].show();
    }

    /** The run is over: a sheet still waiting for its card has nothing more to answer. */
    private void runEnded(String runId) {
        if (nfcSheet != null && (runId == null || runId.isEmpty() || runId.equals(nfcSheet.runId))) { nfcSheet.runEnded(); nfcSheet = null; }
    }

    /* ------------------------------------------------- 6.11 the model's card */

    /** $form.model (message.model): the model behind an answer — what the command list knows of it, and who it came through. */
    JSONObject modelCard(ChatMessage m) {
        JSONObject o = ModelFace.scope(m, this::t, name -> Icons.has(a, name));
        if (o == null) return null;
        ModelIdentity id = ModelFace.of(m);
        Command cmd = commands().state(bearer()).find(id.keyword.toLowerCase(java.util.Locale.ROOT));
        try {
            boolean local = ModelFace.local(m);
            o.put("known", cmd != null).put("local", local).put("write", trigger() + id.keyword + " ")
                .put("senderId", local || m.mine ? "" : m.senderId)
                .put("summary", cmd == null ? "" : cmd.summary).put("visibility", cmd == null ? "" : cmd.visibility)
                .put("usage", cmd == null ? "" : CommandCheck.usage(cmd, trigger())).put("guide", cmd == null ? "" : cmd.usage);
            JSONArray inputs = new JSONArray();
            if (cmd != null) for (Command.Input i : cmd.inputs) {
                inputs.put(new JSONObject().put("name", i.name).put("label", i.label == null || i.label.equals(i.name) ? "" : i.label)
                    .put("required", i.mustGive()).put("expect", CommandCheck.expectation(i, this::t)).put("help", i.help == null ? "" : i.help));
            }
            o.put("inputs", inputs).put("hasInputs", inputs.length() > 0);
        } catch (JSONException ignored) { }
        return o;
    }

    /* ------------------------------------------------------ outputs (bubble) */

    FnView view() { return new FnView(a, theme, host); }

    private final FnView.Host host = new FnView.Host() {
        @Override public void event(JSONObject meta, JSONObject ev, Consumer<Boolean> done) { event(null, meta, ev, done); }

        @Override public void event(String key, JSONObject meta, JSONObject ev, Consumer<Boolean> done) {
            RoomSession r = app().rooms.activeSession();
            ChatMessage from = r == null ? null : r.message(key);
            ModelIdentity id = ModelIdentity.fromJson(meta);
            if (id == null) id = ModelIdentity.of(meta.optString("keyword", "?"), meta.optString("name"), null);
            Live run = new Live(r, null, from, id, null, "caller", done);
            start(run, l -> commands().event(bearer(), meta, ev, origin(), l, main));
        }

        @Override public void flash(String text, String level) { a.flash("", text, level); }

        @Override public void openLink(String url) { a.openUrl(url); }

        @Override public void report(JSONObject meta, JSONObject ev) {
            RoomSession r = app().rooms.activeSession();
            commands().report(bearer(), meta, ev, origin(), exec, d -> {
                if (d == null) return;
                Io.main(() -> {
                    ModelIdentity id = ModelIdentity.fromJson(meta);
                    if (id == null) id = ModelIdentity.of(meta.optString("keyword", "?"), meta.optString("name"), null);
                    deliver(r, null, null, id, d.visibility == null ? "caller" : d.visibility, d);
                });
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
