package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

/**
 * The AI assistant (client/src/lib/ai.ts and components/AiPanel.tsx): the
 * models this user may use (GET /api/ai/status), a conversation streamed as
 * it is written (POST /api/ai/chat — delta, reasoning, citations, done,
 * error) and stopped at will. What is sent goes to the server and the
 * operator's provider: it is not end-to-end encrypted like the chat.
 *
 * Not thread-safe by design: use it from one thread — the one the executor
 * you pass runs on (the main thread); every change happens there.
 */
public final class Assistant {
    public static final List<String> LEVELS = Collections.unmodifiableList(Arrays.asList("off", "low", "medium", "high"));

    public static final class Model {
        public final String ref;
        public final String label;
        public final String provider;
        public final boolean reasoning;
        public final boolean vision;

        Model(JSONObject m) {
            ref = m.optString("ref");
            label = m.opt("label") instanceof String ? m.optString("label") : ref;
            provider = m.opt("provider") instanceof String ? m.optString("provider") : "";
            reasoning = Boolean.TRUE.equals(m.opt("reasoning"));
            vision = Boolean.TRUE.equals(m.opt("vision"));
        }
    }

    /** What this user may use: state off | no-model | sign-in | no-limit | ready. */
    public static final class Status {
        public final boolean enabled;
        public final String state;
        public final List<Model> models;
        public final String defaultRef;
        public final int maxOutputTokens;
        public final int maxInputChars;

        Status(boolean enabled, String state, List<Model> models, String defaultRef, int maxOutputTokens, int maxInputChars) {
            this.enabled = enabled;
            this.state = state;
            this.models = Collections.unmodifiableList(models);
            this.defaultRef = defaultRef;
            this.maxOutputTokens = maxOutputTokens;
            this.maxInputChars = maxInputChars;
        }

        public Model model(String ref) {
            for (Model m : models) if (m.ref.equals(ref)) return m;
            return null;
        }
    }

    public static final Status OFF = new Status(false, "off", Collections.emptyList(), "", 2048, 24000);
    private static final List<String> STATES = Arrays.asList("off", "no-model", "sign-in", "no-limit", "ready");

    /** One turn of the conversation. An answer fills in while pending. */
    public static final class Turn {
        public final boolean user;
        public String text = "";
        /** The model's label (an answer). */
        public String model = "";
        public String reasoning = "";
        public final List<JSONObject> citations = new ArrayList<>();
        public boolean pending;
        /** Stopped by the user (the text so far stays). */
        public boolean stopped;
        /** Why it failed: the server's code ("ai.err.<code>" may translate it) and message; "" when it did not. */
        public String errorCode = "";
        public String errorMessage = "";
        /** How long it took and the output tokens (after done). */
        public long ms;
        public long outputTokens;

        Turn(boolean user, String text) { this.user = user; this.text = text; }

        public boolean failed() { return !errorCode.isEmpty(); }
    }

    /** Changes to the answer being written (called for every piece), then its end. */
    public interface Listener {
        void changed(Turn answer);
        void finished(Turn answer);
    }

    private final String base;
    private Status status;
    private String model = "";
    private String reasoning = "off";
    private final List<Turn> turns = new ArrayList<>();
    private Api.Call busy;
    private Listener listener;

    public Assistant(String base) { this.base = base; }

    public Status status() { return status; }
    public String model() { return model; }
    /** The model to use (remembered by the app); kept on the next status only if it is still offered. */
    public void setModel(String ref) { model = ref == null ? "" : ref; }
    public String reasoning() { return reasoning; }
    public void setReasoning(String level) { reasoning = LEVELS.contains(level) ? level : "off"; }
    public List<Turn> turns() { return Collections.unmodifiableList(turns); }
    public boolean busy() { return busy != null; }

    /** Asks what this user may use; a failure is "off". Picks the model: the chosen one if offered, else the default. */
    public Api.Call loadStatus(String bearer, Executor ex, Consumer<Status> done) {
        return Api.json(base, "/api/ai/status", bearer, null, ex, new Api.Callback<JSONObject>() {
            @Override public void ok(JSONObject j) { settle(statusFrom(j)); }
            @Override public void fail(Api.Failure f) { settle(OFF); }

            private void settle(Status s) {
                status = s;
                if (s.model(model) == null) model = !s.defaultRef.isEmpty() ? s.defaultRef : s.models.isEmpty() ? "" : s.models.get(0).ref;
                if (done != null) done.accept(s);
            }
        });
    }

    static Status statusFrom(JSONObject j) {
        List<Model> models = new ArrayList<>();
        JSONArray a = j.optJSONArray("models");
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject m = a.optJSONObject(i);
            if (m != null && m.opt("ref") instanceof String) models.add(new Model(m));
        }
        JSONObject limits = j.optJSONObject("limits");
        return new Status(Boolean.TRUE.equals(j.opt("enabled")), STATES.contains(j.opt("state")) ? j.optString("state") : "off", models,
            j.opt("default") instanceof String ? j.optString("default") : "",
            limits != null && limits.opt("maxOutputTokens") instanceof Number ? limits.optInt("maxOutputTokens") : OFF.maxOutputTokens,
            limits != null && limits.opt("maxInputChars") instanceof Number ? limits.optInt("maxInputChars") : OFF.maxInputChars);
    }

    /**
     * Asks: the question and the answer as it is written join the
     * conversation. The model is told each earlier question with the answer
     * it got (a failed or empty answer leaves both out). False when there is
     * nothing to send, an answer is still being written, or the AI is not ready.
     */
    public boolean send(String bearer, String question, Executor ex, Listener l) {
        String text = question == null ? "" : Js.trim(question);
        if (text.isEmpty() || busy != null || status == null || !status.state.equals("ready")) return false;
        JSONArray messages = new JSONArray();
        try {
            for (int i = 0; i + 1 < turns.size(); i++) {
                Turn x = turns.get(i), next = turns.get(i + 1);
                if (x.user && !next.user && !next.text.isEmpty() && !next.failed()) {
                    messages.put(new JSONObject().put("role", "user").put("content", x.text));
                    messages.put(new JSONObject().put("role", "assistant").put("content", next.text));
                }
            }
            messages.put(new JSONObject().put("role", "user").put("content", text));
        } catch (JSONException e) { throw new IllegalStateException(e); }
        Model current = status.model(model);
        Turn answer = new Turn(false, "");
        answer.model = current != null ? current.label : model;
        answer.pending = true;
        turns.add(new Turn(true, text));
        turns.add(answer);
        listener = l;
        JSONObject body;
        try {
            body = new JSONObject().put("model", model).put("reasoning", current != null && current.reasoning ? reasoning : "off")
                .put("messages", messages).put("stream", true);
        } catch (JSONException e) { throw new IllegalStateException(e); }
        busy = Api.stream(base, "/api/ai/chat", bearer, body, ex, new Api.Stream() {
            @Override public void event(String name, JSONObject d) {
                if (!answer.pending) return;
                switch (name) {
                    case "delta": if (d.opt("text") instanceof String) { answer.text += d.optString("text"); l.changed(answer); } break;
                    case "reasoning": if (d.opt("text") instanceof String) { answer.reasoning += d.optString("text"); l.changed(answer); } break;
                    case "citations": if (d.opt("citations") instanceof JSONArray) { setCitations(answer, d.optJSONArray("citations")); l.changed(answer); } break;
                    case "done": done(answer, d, l); break;
                    case "error": Assistant.this.fail(answer, d.opt("code") == null || d.opt("code") == JSONObject.NULL ? "error" : Js.str(d.opt("code")),
                        d.opt("message") == null || d.opt("message") == JSONObject.NULL ? "The AI call failed." : Js.str(d.opt("message")), l); break;
                    default: break;
                }
            }

            @Override public void end() { if (answer.pending) Assistant.this.fail(answer, "incomplete", "The answer stopped before it was complete.", l); }

            @Override public void fail(Api.Failure f) {
                if (answer.pending) Assistant.this.fail(answer, !f.code.isEmpty() ? f.code : f.status > 0 ? "http-" + f.status : "network", f.getMessage(), l);
            }
        });
        return true;
    }

    private static void setCitations(Turn t, JSONArray a) {
        t.citations.clear();
        for (int i = 0; i < a.length(); i++) { JSONObject c = a.optJSONObject(i); if (c != null) t.citations.add(c); }
    }

    private void done(Turn t, JSONObject d, Listener l) {
        if (d.opt("text") instanceof String && !d.optString("text").isEmpty()) t.text = d.optString("text");
        if (d.opt("reasoning") instanceof String && !d.optString("reasoning").isEmpty()) t.reasoning = d.optString("reasoning");
        if (d.opt("citations") instanceof JSONArray) setCitations(t, d.optJSONArray("citations"));
        t.ms = d.optLong("ms");
        JSONObject usage = d.optJSONObject("usage");
        t.outputTokens = usage == null ? 0 : usage.optLong("output");
        finish(t, l);
    }

    private void fail(Turn t, String code, String message, Listener l) {
        t.errorCode = code;
        t.errorMessage = message;
        finish(t, l);
    }

    private void finish(Turn t, Listener l) {
        t.pending = false;
        busy = null;
        l.finished(t);
    }

    /** Stops the answer being written; what came so far stays (marked stopped), and its listener hears it finished. */
    public void stop() {
        Api.Call c = busy;
        if (c == null) return;
        c.cancel();
        for (Turn t : turns) if (t.pending) { t.stopped = true; finish(t, listener); }
        busy = null;
    }

    /** A new conversation (stops an answer being written). */
    public void clear() {
        if (busy != null) busy.cancel();
        busy = null;
        turns.clear();
    }

    /** The last complete answer (to copy or put into the message), or null. */
    public Turn lastAnswer() {
        for (int i = turns.size() - 1; i >= 0; i--) {
            Turn t = turns.get(i);
            if (!t.user && !t.pending && !t.text.isEmpty() && !t.failed()) return t;
        }
        return null;
    }
}
