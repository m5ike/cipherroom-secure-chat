package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Chat commands — the client side of Functions (client/src/lib/functions.ts
 * and the composer parts of App.tsx): which characters start what in the
 * message box (GET /api/client-config), the commands this user may run
 * (GET /api/functions/commands, asked at most every 10 s), turning
 * "/keyword args" into the model's inputs, running it and the model's other
 * entry points (a click, a form, a reply) as streams, and answering its live
 * questions. One instance per server.
 */
public final class Commands {
    /** A character that opens suggestions in the message box, and what it offers: functions, mentions or tags. */
    public static final class Trigger {
        public final String ch;
        public final String action;
        public Trigger(String ch, String action) { this.ch = ch; this.action = action; }
    }

    /** The message box as the operator set it up (ComposerPolicy in client-config.ts). */
    public static final class Composer {
        public final List<Trigger> triggers;
        /** Tags the operator offers after "#". */
        public final List<String> tags;

        public Composer(List<Trigger> triggers, List<String> tags) {
            this.triggers = Collections.unmodifiableList(triggers);
            this.tags = Collections.unmodifiableList(tags);
        }

        /** The characters that start a command ("/" unless the operator says otherwise). */
        public List<String> commandChars() {
            List<String> out = new ArrayList<>();
            for (Trigger t : triggers) if (t.action.equals("functions")) out.add(t.ch);
            return out;
        }
    }

    public static final Composer DEFAULT_COMPOSER = new Composer(
        Arrays.asList(new Trigger("/", "functions"), new Trigger("@", "mentions"), new Trigger("#", "tags")), Collections.emptyList());

    /** The commands this user may run; enabled is null until the server answered. */
    public static final class State {
        public final Boolean enabled;
        public final List<Command> commands;

        State(Boolean enabled, List<Command> commands) {
            this.enabled = enabled;
            this.commands = Collections.unmodifiableList(commands);
        }

        public Command find(String keyword) {
            for (Command c : commands) if (c.keyword.equals(keyword)) return c;
            return null;
        }
    }

    public static final State UNKNOWN = new State(null, Collections.emptyList());

    /** How long a command list is good for (App.tsx refreshCommands()). */
    static final long FRESH_MS = 10_000;

    private final String base;
    private volatile Composer composer = DEFAULT_COMPOSER;
    // The list, whose account it is for and when it was asked for (guarded by this).
    private State state = UNKNOWN;
    private String stateBearer = "";
    private long stateAt;

    public Commands(String base) { this.base = base; }

    /* ------------------------------------------------------ the composer */

    public Composer composer() { return composer; }

    /** Asks the server how the message box works; a failure keeps what was known (the defaults at first). */
    public Api.Call loadComposer(String bearer, Executor ex, Consumer<Composer> done) {
        return Api.json(base, "/api/client-config", bearer, null, ex, new Api.Callback<JSONObject>() {
            @Override public void ok(JSONObject o) {
                Object config = o.has("config") && o.opt("config") != JSONObject.NULL ? o.opt("config") : o;
                composer = composerFrom(config instanceof JSONObject ? ((JSONObject) config).opt("composer") : null);
                if (done != null) done.accept(composer);
            }

            @Override public void fail(Api.Failure f) { if (done != null) done.accept(composer); }
        });
    }

    /** sanitizeComposer() in client-config.ts. */
    static Composer composerFrom(Object raw) {
        if (!(raw instanceof JSONObject)) return raw instanceof JSONArray ? new Composer(new ArrayList<>(), new ArrayList<>()) : DEFAULT_COMPOSER;
        JSONObject r = (JSONObject) raw;
        List<Trigger> triggers = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        JSONArray ts = r.optJSONArray("triggers");
        for (int i = 0; ts != null && i < ts.length(); i++) {
            JSONObject e = ts.optJSONObject(i) == null ? new JSONObject() : ts.optJSONObject(i);
            String ch = e.opt("char") instanceof String ? Js.firstCodePoint(Js.trim(e.optString("char"))) : "";
            Object a = e.opt("action");
            String action = "functions".equals(a) || "mentions".equals(a) || "tags".equals(a) ? (String) a : null;
            if (ch.isEmpty() || action == null || BAD_TRIGGER.matcher(ch).matches() || seen.contains(ch) || triggers.size() >= 10) continue;
            seen.add(ch);
            triggers.add(new Trigger(ch, action));
        }
        Set<String> tags = new LinkedHashSet<>();
        JSONArray tg = r.optJSONArray("tags");
        for (int i = 0; tg != null && i < tg.length(); i++) {
            if (!(tg.opt(i) instanceof String)) continue;
            String t = Js.trim(tg.optString(i).replaceFirst("^#", "")).toLowerCase(Locale.ROOT);
            if (TAG.matcher(t).matches()) tags.add(t);
        }
        List<String> tagList = new ArrayList<>(tags);
        return new Composer(triggers, tagList.size() > 200 ? tagList.subList(0, 200) : tagList);
    }

    private static final Pattern BAD_TRIGGER = Pattern.compile("[" + Js.WS_CHARS + "A-Za-z0-9]");
    private static final Pattern TAG = Pattern.compile("[\\p{L}\\p{N}_-]{1,40}");

    /* ------------------------------------------------------ the commands */

    /** The commands last heard of for this account (UNKNOWN before the server answered, or for another account). */
    public synchronized State state(String bearer) {
        return (bearer == null ? "" : bearer).equals(stateBearer) ? state : UNKNOWN;
    }

    /**
     * Asks the server for the commands — unless the list for this account is
     * younger than 10 s and force is false. Any failure means "off", as on the web.
     */
    public void refresh(String bearer, boolean force, Executor ex, Consumer<State> done) {
        String b = bearer == null ? "" : bearer;
        synchronized (this) {
            if (!force && b.equals(stateBearer) && System.currentTimeMillis() - stateAt < FRESH_MS) {
                State s = state;
                if (done != null) ex.execute(() -> done.accept(s));
                return;
            }
            stateAt = System.currentTimeMillis();
            if (!b.equals(stateBearer)) { stateBearer = b; state = UNKNOWN; }
        }
        Api.json(base, "/api/functions/commands", b, null, ex, new Api.Callback<JSONObject>() {
            @Override public void ok(JSONObject o) {
                List<Command> list = new ArrayList<>();
                boolean enabled = Boolean.TRUE.equals(o.opt("enabled"));
                JSONArray a = o.optJSONArray("commands");
                for (int i = 0; enabled && a != null && i < a.length(); i++) {
                    Command c = a.optJSONObject(i) == null ? null : Command.from(a.optJSONObject(i));
                    if (c != null) list.add(c);
                }
                settle(b, new State(enabled, list));
            }

            @Override public void fail(Api.Failure f) { settle(b, new State(false, Collections.emptyList())); }

            private void settle(String forBearer, State s) {
                synchronized (Commands.this) { if (forBearer.equals(stateBearer)) state = s; }
                if (done != null) done.accept(s);
            }
        });
    }

    /* ---------------------------------------------------- the command line */

    /** "/word rest" → keyword (lower case) and the argument text. */
    public static final class Parsed {
        public final String keyword;
        public final String argText;
        Parsed(String keyword, String argText) { this.keyword = keyword; this.argText = argText; }
    }

    private static final Pattern COMMAND = Pattern.compile("([a-z0-9_-]{1,40})(?:" + Js.S + "+([\\s\\S]*))?", Pattern.CASE_INSENSITIVE);
    private static final Pattern TOKEN = Pattern.compile("\"([^\"]*)\"|'([^']*)'|(" + Js.NS + "+)");

    /** parseCommandLine(): null when the text is not a command; chars are the characters that start one. */
    public static Parsed parseCommandLine(String text, List<String> chars) {
        String t = Js.trim(text);
        String first = Js.firstCodePoint(t);
        if (t.isEmpty() || !chars.contains(first)) return null;
        Matcher m = COMMAND.matcher(t.substring(first.length()));
        if (!m.matches()) return null;
        return new Parsed(m.group(1).toLowerCase(Locale.ROOT), Js.trim(m.group(2) == null ? "" : m.group(2)));
    }

    /** Splits an argument line into tokens, honouring "quoted values". */
    static List<String> tokenize(String argText) {
        List<String> out = new ArrayList<>();
        Matcher m = TOKEN.matcher(argText);
        while (m.find()) out.add(m.group(1) != null ? m.group(1) : m.group(2) != null ? m.group(2) : m.group(3));
        return out;
    }

    /**
     * buildInputs(): key=value pairs set that input; bare tokens fill the
     * chat-typeable inputs in order, and a trailing text input takes the rest
     * ("/check example.org depth=full"). The values are strings; the server types them.
     */
    public static JSONObject buildInputs(Command command, String argText) {
        Map<String, String> inputs = new LinkedHashMap<>();
        Map<String, Command.Input> byName = new LinkedHashMap<>();
        for (Command.Input i : command.inputs) byName.put(i.name, i);
        // A value picked in the chat comes as text, so "user", "file" and "secret" are not filled by position.
        List<Command.Input> positional = new ArrayList<>();
        for (Command.Input i : command.inputs) if (!i.type.equals("user") && !i.type.equals("file") && !i.type.equals("secret")) positional.add(i);
        List<String> bare = new ArrayList<>();
        for (String tok : tokenize(argText)) {
            int eq = tok.indexOf('=');
            if (eq > 0 && byName.containsKey(tok.substring(0, eq))) inputs.put(tok.substring(0, eq), tok.substring(eq + 1));
            else bare.add(tok);
        }
        int pi = 0;
        for (Command.Input spec : positional) {
            if (inputs.containsKey(spec.name)) continue;
            if (pi >= bare.size()) break;
            // A free-text field at the end takes everything that is left.
            if ((spec.type.equals("text") || spec.type.equals("string")) && spec == positional.get(positional.size() - 1)) {
                inputs.put(spec.name, String.join(" ", bare.subList(pi, bare.size())));
                pi = bare.size();
            } else {
                inputs.put(spec.name, bare.get(pi++));
            }
        }
        JSONObject out = new JSONObject();
        try { for (Map.Entry<String, String> e : inputs.entrySet()) out.put(e.getKey(), e.getValue()); }
        catch (JSONException e) { throw new IllegalStateException(e); }
        return out;
    }

    /* ------------------------------------------------------------ running */

    /**
     * Runs a command with a live stream (POST /api/functions/run): progress,
     * questions, then the outputs. keyword or model (the model's id, which the
     * server prefers) names it.
     */
    public Api.Call run(String bearer, String keyword, String model, JSONObject inputs, Run.Origin origin, Run.Listener l, Executor ex) {
        try {
            JSONObject body = new JSONObject();
            if (model != null) body.put("model", model);
            if (keyword != null) body.put("keyword", keyword);
            body.put("inputs", inputs == null ? new JSONObject() : inputs);
            origin.into(body);
            body.put("stream", true);
            return Api.stream(base, "/api/functions/run", bearer, body, ex, Run.stream(l));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /**
     * A click, a form or a reply for a model's message (POST
     * /api/functions/event): its entry point runs in the message's processing
     * session, streamed like a run. meta is the message's flags.fn; ev one of
     * button(), form(), response(). A session that is over answers the error "expired".
     */
    public Api.Call event(String bearer, JSONObject meta, JSONObject ev, Run.Origin origin, Run.Listener l, Executor ex) {
        try {
            JSONObject body = eventBody(meta, ev, origin);
            body.put("stream", true);
            return Api.stream(base, "/api/functions/event", bearer, body, ex, Run.stream(l));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /**
     * A report from this app — an output it could not show ({type: "error",
     * error: {type, message}, output, fromError}) or a log line — logged with
     * the run; the model's error entry point may answer. done gets that answer, or null.
     */
    public Api.Call report(String bearer, JSONObject meta, JSONObject ev, Run.Origin origin, Executor ex, Consumer<Run.Done> done) {
        try {
            return Api.json(base, "/api/functions/event", bearer, eventBody(meta, ev, origin), ex, new Api.Callback<JSONObject>() {
                @Override public void ok(JSONObject o) {
                    JSONArray outputs = o.optJSONArray("outputs");
                    done.accept(outputs != null && outputs.length() > 0 ? new Run.Done(o) : null);
                }

                @Override public void fail(Api.Failure f) { done.accept(null); }
            });
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** { model, keyword, chain, call, room, client, lang, tz, ...ev } as sendFnEventStream() sends it. */
    private static JSONObject eventBody(JSONObject meta, JSONObject ev, Run.Origin origin) throws JSONException {
        JSONObject body = new JSONObject();
        if (meta.opt("model") instanceof String) body.put("model", meta.optString("model"));
        body.put("keyword", meta.optString("keyword", ""));
        body.put("chain", meta.optString("chain", ""));
        if (meta.opt("call") instanceof Number) body.put("call", ((Number) meta.opt("call")).intValue());
        origin.into(body);
        for (java.util.Iterator<String> it = ev.keys(); it.hasNext(); ) { String k = it.next(); body.put(k, ev.opt(k)); }
        return body;
    }

    /** A click on the model's button: its name and data (null: none). */
    public static JSONObject button(String name, Object data) {
        try { return new JSONObject().put("type", "button").put("name", name).put("data", data); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** A submitted form: its name and values. */
    public static JSONObject form(String name, JSONObject values) {
        try { return new JSONObject().put("type", "form").put("name", name).put("values", values); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** A reply to the model's message: the reply's text and the text of the message it answers. */
    public static JSONObject response(String text, String repliedText) {
        try { return new JSONObject().put("type", "response").put("text", text).put("message", new JSONObject().put("text", repliedText)); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** Whether a message (its flags.fn) answers this kind of event: it has a session, and says it does (or does not say). */
    public static boolean answers(JSONObject meta, String type) {
        if (meta == null || meta.optString("chain", "").isEmpty()) return false;
        JSONArray events = meta.optJSONArray("events");
        return events == null || Command.strings(events).contains(type);
    }

    /**
     * Sends the caller's answer to a running command's question (value: the
     * text, the choice, the form's values; null cancels). Failures are
     * ignored — the run times out on its own, as on the web.
     */
    public void answer(String bearer, String runId, String interactionId, Object value) {
        try {
            JSONObject body = new JSONObject().put("interactionId", interactionId).put("value", value == null ? JSONObject.NULL : value);
            String path = "/api/functions/runs/" + URLEncoder.encode(runId, "UTF-8").replace("+", "%20") + "/events";
            Api.json(base, path, bearer, body, Runnable::run, new Api.Callback<JSONObject>() {
                @Override public void ok(JSONObject o) { }
                @Override public void fail(Api.Failure f) { }
            });
        } catch (JSONException | UnsupportedEncodingException e) { throw new IllegalStateException(e); }
    }
}
