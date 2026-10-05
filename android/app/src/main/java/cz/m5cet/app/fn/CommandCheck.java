package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * 6.11: a command's signature and the check of a call before it goes to the
 * server — commandUsage(), inputExpectation() and checkCommandInputs() of
 * client/src/lib/system-messenger.ts, ported line by line (the same vectors
 * test both). A call that fails the check never runs: the model's answer is
 * an error card with what is wrong, the usage line, the inputs and the
 * model's own guide. Pure (org.json only).
 */
public final class CommandCheck {
    private CommandCheck() {}

    /** What is wrong with one input: missing, type, pattern, range or values — and what it expects (English, as the web says it). */
    public static final class Problem {
        public final String input;
        public final String label;
        public final String problem;
        public final String expected;
        /** The input it is about (for a translated line: Tr). */
        public final Command.Input spec;

        Problem(Command.Input spec, String problem) {
            this.spec = spec;
            this.input = spec.name;
            this.label = spec.label == null || spec.label.isEmpty() ? spec.name : spec.label;
            this.problem = problem;
            this.expected = expectation(spec);
        }

        @Override public String toString() { return input + ":" + problem + ":" + expected; }
    }

    /** The app's words for the translated lines (fnm.expect.*, fnm.problem.*). */
    public interface Tr { String t(String key); }

    private static final Pattern E164 = Pattern.compile("^\\+[1-9]\\d{1,14}$");
    // JavaScript's \s (Js.WS_CHARS), brackets, dots and dashes.
    private static final Pattern PHONE_NOISE = Pattern.compile("[" + Js.WS_CHARS + "().-]");
    private static final Pattern BOOL = Pattern.compile("^(true|false|1|0|yes|no|ano|ne)$", Pattern.CASE_INSENSITIVE);
    private static final String E164_SOURCE = "^\\+[1-9]\\d{1,14}$";

    /** commandUsage(): "/hlr &lt;number&gt; [format]" — required inputs without a default in &lt;&gt;, the others in []. */
    public static String usage(Command cmd, String trigger) {
        StringBuilder sb = new StringBuilder(trigger == null ? "/" : trigger).append(cmd.keyword);
        for (Command.Input i : cmd.inputs) sb.append(' ').append(arg(i));
        return sb.toString();
    }

    public static String usage(Command cmd) { return usage(cmd, "/"); }

    /** One input in the usage line. */
    public static String arg(Command.Input i) { return i.mustGive() ? "<" + i.name + ">" : "[" + i.name + "]"; }

    private static boolean numeric(Command.Input i) { return "number".equals(i.type) || "integer".equals(i.type); }

    /** inputExpectation(): what an input expects, for an error line ("one of: a, b", "a number 1–10"…). */
    public static String expectation(Command.Input i) {
        if (!i.values.isEmpty()) return "one of: " + String.join(", ", i.values);
        if (numeric(i)) return "a " + i.type + (i.min != null || i.max != null ? " " + num(i.min) + "–" + num(i.max) : "");
        if ("phone".equals(i.type) || E164_SOURCE.equals(i.pattern)) return "a phone number in international form (+420…)";
        if ("boolean".equals(i.type)) return "true / false";
        if (i.pattern != null) return "text matching " + i.pattern;
        return i.type != null && !i.type.isEmpty() ? "a " + i.type : "a value";
    }

    /** The same in the app's language (fnm.expect.*). */
    public static String expectation(Command.Input i, Tr tr) {
        if (!i.values.isEmpty()) return tr.t("fnm.expect.values").replace("{values}", String.join(", ", i.values));
        if (numeric(i)) {
            String what = tr.t("integer".equals(i.type) ? "fnm.expect.integer" : "fnm.expect.number");
            return i.min != null || i.max != null ? what + " " + num(i.min) + "–" + num(i.max) : what;
        }
        if ("phone".equals(i.type) || E164_SOURCE.equals(i.pattern)) return tr.t("fnm.expect.phone");
        if ("boolean".equals(i.type)) return tr.t("fnm.expect.boolean");
        if (i.pattern != null) return tr.t("fnm.expect.pattern").replace("{pattern}", i.pattern);
        if ("email".equals(i.type)) return tr.t("fnm.expect.email");
        return i.type != null && !i.type.isEmpty() ? tr.t("fnm.expect.type").replace("{type}", i.type) : tr.t("fnm.expect.value");
    }

    /** "Missing", "Wrong type"… in the app's language (fnm.problem.*). */
    public static String problem(Problem p, Tr tr) { return tr.t("fnm.problem." + p.problem); }

    private static String num(Double d) { return d == null ? "…" : Js.numberToString(d); }

    /**
     * The answer to a call that cannot run (6.11) — the model's own outputs, so
     * the bubble draws them like any answer: what is wrong (each problem, or
     * the server's refusal), the usage line, the parameters (what each
     * expects, required or not, its help), and the model's guide.
     *
     * @param problems the check's (empty when the server refused: serverMessage says why)
     */
    public static JSONArray card(Command cmd, String trigger, List<Problem> problems, String serverMessage, Tr tr) {
        JSONArray out = new JSONArray();
        try {
            StringBuilder md = new StringBuilder();
            for (Problem p : problems) {
                md.append("- **").append(p.label).append("**");
                if (!p.label.equals(p.input)) md.append(" (`").append(p.input).append("`)");
                md.append(": ").append(problem(p, tr)).append(" — ").append(tr.t("fnm.error.expects").replace("{expected}", expectation(p.spec, tr))).append('\n');
            }
            if (serverMessage != null && !serverMessage.isEmpty()) md.append(tr.t("fnm.error.server").replace("{message}", serverMessage)).append('\n');
            if (md.length() > 0) out.put(new JSONObject().put("type", "markdown").put("text", md.toString().trim()));
            out.put(new JSONObject().put("type", "code").put("text", usage(cmd, trigger)));
            if (!cmd.inputs.isEmpty()) {
                JSONArray rows = new JSONArray();
                for (Command.Input i : cmd.inputs) {
                    String what = tr.t(i.mustGive() ? "fnm.required" : "fnm.optional") + " · " + expectation(i, tr);
                    if (i.def != null && i.def != JSONObject.NULL) what += " · " + tr.t("fnm.default").replace("{value}", Js.str(i.def));
                    String name = i.name + (i.label != null && !i.label.isEmpty() && !i.label.equals(i.name) ? " (" + i.label + ")" : "");
                    rows.put(new JSONArray().put(name).put(what).put(i.help == null ? "" : i.help));
                }
                out.put(new JSONObject().put("type", "table").put("title", tr.t("fnm.inputs"))
                    .put("columns", new JSONArray().put(tr.t("fnm.col.name")).put(tr.t("fnm.col.expect")).put(tr.t("fnm.col.help"))).put("rows", rows));
            }
            if (!Js.trim(cmd.usage).isEmpty()) out.put(new JSONObject().put("type", "markdown").put("text", "**" + tr.t("fnm.guide") + "**\n\n" + cmd.usage));
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return out;
    }

    /**
     * checkCommandInputs(): the inputs of a call that cannot go to the server
     * as they are — a required input without a value or default (a model
     * whose inputs are all optional answers an empty call with its own form,
     * so that is never one), a value of the wrong type, outside its range,
     * not one of its values, not a phone number, not matching its pattern.
     *
     * @param values the call's inputs (Commands.buildInputs: name → text)
     */
    public static List<Problem> check(Command cmd, JSONObject values) {
        List<Problem> out = new ArrayList<>();
        JSONObject v0 = values == null ? new JSONObject() : values;
        for (Command.Input i : cmd.inputs) {
            Object v = v0.opt(i.name);
            boolean empty = v == null || v == JSONObject.NULL || (v instanceof String && Js.trim((String) v).isEmpty());
            if (empty) {
                if (i.mustGive()) out.add(new Problem(i, "missing"));
                continue;
            }
            String s = Js.trim(Js.str(v));
            if (numeric(i)) {
                double n = Js.toNumber(s);
                if (!Double.isFinite(n) || ("integer".equals(i.type) && n != Math.rint(n))) { out.add(new Problem(i, "type")); continue; }
                if ((i.min != null && n < i.min) || (i.max != null && n > i.max)) { out.add(new Problem(i, "range")); continue; }
            }
            if ("boolean".equals(i.type) && !BOOL.matcher(s).matches()) { out.add(new Problem(i, "type")); continue; }
            if (!i.values.isEmpty() && !i.values.contains(s)) { out.add(new Problem(i, "values")); continue; }
            if ("phone".equals(i.type) && !E164.matcher(PHONE_NOISE.matcher(s).replaceAll("")).matches()) { out.add(new Problem(i, "pattern")); continue; }
            if (i.pattern != null) {
                Pattern re = null;
                try { re = i.pattern.length() <= 200 ? Pattern.compile(i.pattern) : null; } catch (PatternSyntaxException e) { re = null; }
                if (re != null && !re.matcher(s).find()) out.add(new Problem(i, "pattern"));
            }
        }
        return out;
    }
}
