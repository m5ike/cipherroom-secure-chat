package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A command's run as the chat sees it (client/src/lib/functions.ts): where
 * it comes from, what its stream says (start, progress, outputs, live
 * questions, then done or error), and the message its outputs become.
 */
public final class Run {
    private Run() {}

    /** Where a run comes from: the room (null: none), this device's client id, the language, the time zone (null: the server's UTC). */
    public static final class Origin {
        public final String room;
        public final String client;
        public final String lang;
        public final String tz;

        public Origin(String room, String client, String lang, String tz) {
            this.room = room;
            this.client = client;
            this.lang = lang;
            this.tz = tz;
        }

        void into(JSONObject body) throws JSONException {
            body.put("room", room == null || room.isEmpty() ? JSONObject.NULL : room);
            body.put("client", client == null || client.isEmpty() ? JSONObject.NULL : client);
            body.put("lang", lang == null ? "en" : lang);
            if (tz != null && !tz.isEmpty()) body.put("tz", tz);
        }
    }

    /**
     * What a stream tells, on the caller's executor. Exactly one of done() and
     * error() ends it (a stream that stops without either is an "incomplete"
     * error) — unless the call was cancelled: then nothing more comes.
     */
    public interface Listener {
        /** 6.11: any event of the stream but its end (start, progress, an output, a question, a log line) — a sign of life (RunWatch). */
        default void alive() { }
        default void start(String runId) { }
        /** p as the function reported it, and its text. */
        default void progress(double p, String text) { }
        /** One output as the function produced it (the full list comes with done). */
        default void output(JSONObject output) { }
        /** A live question (m5.prompt / m5.form): answer it with Commands.answer(). */
        default void interaction(Interaction i) { }
        void done(Done d);
        void error(String code, String message);
    }

    /**
     * A running command's question: kind "prompt" (text, choices, placeholder),
     * "form" (title, text, fields, submit) or, 6.3, "nfc" (spec.command: an NFC op
     * for this device's reader — answered with an NfcResult, not shown as a question).
     */
    public static final class Interaction {
        public final String runId;
        public final String id;
        public final String kind;
        public final JSONObject spec;

        /** A form field: name, label, type, required, placeholder, values (a choice). */
        public static final class Field {
            public final String name;
            public final String label;
            public final String type;
            public final boolean required;
            public final String placeholder;
            public final List<String> values;

            Field(JSONObject f) {
                name = f.optString("name", "");
                label = string(f, "label");
                type = string(f, "type");
                required = Boolean.TRUE.equals(f.opt("required"));
                placeholder = string(f, "placeholder");
                values = Command.strings(f.optJSONArray("values"));
            }
        }

        Interaction(JSONObject d) {
            runId = string(d, "runId");
            id = string(d, "id");
            Object k = d.opt("kind");
            kind = "form".equals(k) ? "form" : "nfc".equals(k) ? "nfc" : "prompt";
            JSONObject s = d.optJSONObject("spec");
            spec = s == null ? new JSONObject() : s;
        }

        public String title() { return string(spec, "title"); }
        public String text() { return string(spec, "text"); }
        public String placeholder() { return string(spec, "placeholder"); }
        public String submit() { return string(spec, "submit"); }
        public List<String> choices() { return Command.strings(spec.optJSONArray("choices")); }

        public List<Field> fields() {
            List<Field> out = new ArrayList<>();
            JSONArray a = spec.optJSONArray("fields");
            for (int i = 0; a != null && i < a.length(); i++) {
                JSONObject f = a.optJSONObject(i);
                if (f != null && !f.optString("name", "").isEmpty()) out.add(new Field(f));
            }
            return out;
        }
    }

    /** A finished run (doneBody() in server/functions/routes.ts). */
    public static final class Done {
        public final String runId;
        public final String status;
        public final JSONArray outputs;
        /** The failure, when the run failed and nothing answered it: {type, message}; else null. */
        public final JSONObject error;
        /** The function failed and its error entry point answered (the outputs are that answer); failed says what failed. */
        public final boolean handled;
        public final JSONObject failed;
        /** "room" or "caller"; null when the server did not say. */
        public final String visibility;
        /** The processing session a reply, a click or a form continues, and the call in it. */
        public final String chain;
        public final Integer call;
        public final String model;
        public final String keyword;
        public final String name;
        public final List<String> events;
        public final JSONObject raw;

        Done(JSONObject d) {
            raw = d;
            runId = string(d, "runId");
            status = string(d, "status");
            JSONArray o = d.optJSONArray("outputs");
            outputs = o == null ? new JSONArray() : o;
            error = d.optJSONObject("error");
            handled = Boolean.TRUE.equals(d.opt("handled"));
            failed = d.optJSONObject("failed");
            visibility = "room".equals(d.opt("visibility")) || "caller".equals(d.opt("visibility")) ? d.optString("visibility") : null;
            chain = d.opt("chain") instanceof String ? d.optString("chain") : null;
            call = d.opt("call") instanceof Number ? ((Number) d.opt("call")).intValue() : null;
            model = d.opt("model") instanceof String ? d.optString("model") : null;
            keyword = string(d, "keyword");
            name = string(d, "name");
            events = d.opt("events") instanceof JSONArray ? Command.strings(d.optJSONArray("events")) : null;
        }

        /** It failed and nothing answered: show error.message instead of outputs. */
        public boolean failedUnanswered() { return error != null && !handled; }

        /**
         * The message these outputs become — showFnResult() in App.tsx: the
         * flags.fn metadata (a reply, a click or a form continues its
         * session), the outputs, and the Markdown as the text.
         *
         * @param keyword    the command's keyword when the server did not repeat it
         * @param name       its name, likewise
         * @param visibility "room" or "caller" when the server did not say (a command's own; "caller" for an event)
         */
        public Message message(String keyword, String name, String visibility) { return message(keyword, name, visibility, null); }

        /**
         * 6.11: with the model's icon in the flags (the answer's avatar, here
         * and at the peers': keyword, name and icon are its identity) — the
         * server's when it sends one, else the command's.
         */
        public Message message(String keyword, String name, String visibility, String icon) {
            try {
                String kw = this.keyword.isEmpty() ? keyword : this.keyword;
                JSONObject meta = new JSONObject().put("keyword", kw).put("name", this.name.isEmpty() ? name : this.name);
                String ic = ModelIdentity.safeIcon(raw.opt("icon"));
                if (ic == null) ic = ModelIdentity.safeIcon(icon);
                if (ic != null) meta.put("icon", ic);
                if (model != null && !model.isEmpty()) meta.put("model", model);
                if (chain != null && !chain.isEmpty()) meta.put("chain", chain);
                if (call != null) meta.put("call", (int) call);
                if (events != null && !events.isEmpty()) meta.put("events", new JSONArray(events));
                if (handled) meta.put("origin", "error");
                String md = Outputs.toMarkdown(outputs);
                String text = !md.isEmpty() ? md : outputs.length() > 0 ? "/" + kw : "";
                JSONObject room = copy(meta).put("outputs", Outputs.shareable(outputs));
                JSONObject local = copy(meta).put("outputs", outputs);
                return new Message(room, local, text, "room".equals(this.visibility != null ? this.visibility : visibility), meta.optString("name"));
            } catch (JSONException e) { throw new IllegalStateException(e); }
        }
    }

    /** A function's answer as a chat message. */
    public static final class Message {
        /** flags.fn for the room: the outputs that fit into a message (large media become notes). */
        public final JSONObject fn;
        /** flags.fn as this device keeps it: every output. */
        public final JSONObject local;
        /** The message's text: the outputs' Markdown, "/keyword" when they have none, "" when there are no outputs (show functions.empty). */
        public final String text;
        /** Send it to the room (else show it only here). */
        public final boolean room;
        public final String name;

        Message(JSONObject fn, JSONObject local, String text, boolean room, String name) {
            this.fn = fn;
            this.local = local;
            this.text = text;
            this.room = room;
            this.name = name;
        }
    }

    private static final Pattern MODEL = Pattern.compile("[a-z0-9][a-z0-9_-]{0,63}");
    private static final Pattern CHAIN = Pattern.compile("chn_[a-z0-9]{6,40}");
    private static final List<String> EVENTS = Arrays.asList("response", "button", "form", "error");

    /**
     * A peer's flags.fn as the app may use it (validateFlags() in
     * client/src/lib/validate.ts): the model and session only in their
     * shapes, known events, the outputs checked again. null: not one.
     */
    public static JSONObject meta(Object raw) {
        if (!(raw instanceof JSONObject)) return null;
        JSONObject fn = (JSONObject) raw;
        String keyword = fn.opt("keyword") instanceof String && fn.optString("keyword").length() <= 40 ? fn.optString("keyword") : "";
        String name = fn.opt("name") instanceof String && fn.optString("name").length() <= 120 ? fn.optString("name") : "";
        if (keyword.isEmpty()) return null;
        try {
            JSONObject out = new JSONObject().put("keyword", keyword).put("name", name.isEmpty() ? keyword : name);
            if (fn.opt("model") instanceof String && MODEL.matcher(fn.optString("model")).matches()) out.put("model", fn.optString("model"));
            String icon = ModelIdentity.safeIcon(fn.opt("icon")); // 6.11: the model's avatar
            if (icon != null) out.put("icon", icon);
            if (fn.opt("chain") instanceof String && CHAIN.matcher(fn.optString("chain")).matches()) out.put("chain", fn.optString("chain"));
            if (fn.opt("call") instanceof Number) {
                double call = ((Number) fn.opt("call")).doubleValue();
                if (call == Math.rint(call) && call >= 0 && call < 10_000) out.put("call", (int) call);
            }
            if (fn.opt("events") instanceof JSONArray) {
                Set<String> ev = new LinkedHashSet<>();
                for (String e : Command.strings(fn.optJSONArray("events"))) if (EVENTS.contains(e)) ev.add(e);
                if (!ev.isEmpty()) out.put("events", new JSONArray(ev));
            }
            if (fn.opt("outputs") instanceof JSONArray) {
                JSONArray outputs = Outputs.sanitize(fn.opt("outputs"));
                if (outputs.length() > 0) out.put("outputs", outputs);
            }
            if ("error".equals(fn.opt("origin"))) out.put("origin", "error");
            return out;
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    private static String string(JSONObject o, String k) { return o.opt(k) instanceof String ? o.optString(k) : ""; }

    private static JSONObject copy(JSONObject o) throws JSONException {
        JSONObject c = new JSONObject();
        for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) { String k = it.next(); c.put(k, o.opt(k)); }
        return c;
    }

    /** The events of a run's stream, told to the listener (streamFunction() in functions.ts). */
    static Api.Stream stream(Listener l) {
        return new Api.Stream() {
            private boolean over;

            @Override public void event(String name, JSONObject d) {
                if (over) return;
                if (!name.equals("done") && !name.equals("error")) l.alive();
                switch (name) {
                    case "start": l.start(string(d, "runId")); break;
                    case "progress": l.progress(Js.toNumber(d.opt("p")), d.opt("text") == null || d.opt("text") == JSONObject.NULL ? "" : Js.str(d.opt("text"))); break;
                    case "output": l.output(d); break;
                    case "interaction": l.interaction(new Interaction(d)); break;
                    case "done": over = true; l.done(new Done(d)); break;
                    case "error": over = true; l.error(string(d, "code").isEmpty() ? "error" : string(d, "code"), string(d, "message")); break;
                    default: break; // log lines are the console's
                }
            }

            @Override public void end() {
                if (!over) { over = true; l.error("incomplete", "The answer stopped before it was complete."); }
            }

            @Override public void fail(Api.Failure f) {
                if (over) return;
                over = true;
                l.error(f.code.isEmpty() ? "error" : f.code, f.getMessage());
            }
        };
    }
}
