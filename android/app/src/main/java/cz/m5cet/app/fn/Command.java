package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A chat command as GET /api/functions/commands describes it (commandView()
 * in server/functions/routes.ts; Command in client/src/lib/functions.ts).
 * 6.11: the model's icon and its own guide (usage), an input's pattern, min
 * and max — absent from an older server (null / "").
 */
public final class Command {
    /** One of the model's inputs (its name fills from "name=value" or by position). */
    public static final class Input {
        public final String name;
        /** string, text, integer, number, boolean, enum, user, file, secret, hostname… */
        public final String type;
        public final String label;
        public final String help;
        public final boolean required;
        /** Its default as the server sent it (null: none). */
        public final Object def;
        /** An enum's values (empty otherwise). */
        public final List<String> values;
        /** 6.11: a regular expression the value matches (null: none). */
        public final String pattern;
        /** 6.11: a number's range (null: open). */
        public final Double min, max;

        public Input(String name, String type, String label, String help, boolean required, Object def, List<String> values) {
            this(name, type, label, help, required, def, values, null, null, null);
        }

        public Input(String name, String type, String label, String help, boolean required, Object def, List<String> values, String pattern, Double min, Double max) {
            this.name = name;
            this.type = type;
            this.label = label;
            this.help = help;
            this.required = required;
            this.def = def;
            this.values = values == null ? Collections.emptyList() : values;
            this.pattern = pattern == null || pattern.isEmpty() ? null : pattern;
            this.min = min;
            this.max = max;
        }

        /** Required and without a default: it has to be given ("&lt;name&gt;" in the usage line). */
        public boolean mustGive() { return required && def == null; }
    }

    public final String keyword;
    public final String name;
    public final String summary;
    public final String runtime;
    /** "room": its outputs go to the room; "caller": only to whoever ran it. */
    public final String visibility;
    /** One of the caller's groups may use it (not only "everyone"). */
    public final boolean mine;
    public final List<Input> inputs;
    /** What a reply, a click or a form of its messages reaches (response, button, form, error); null: not said. */
    public final List<String> events;
    /** The model's id (null from an older server). */
    public final String model;
    /** 6.11: the model's icon — a lucide name or one emoji (null: by its keyword, ModelIdentity). */
    public final String icon;
    /** 6.11: the model's own short guide (examples); "" without one. */
    public final String usage;

    public Command(String keyword, String name, String summary, String runtime, String visibility, boolean mine, List<Input> inputs, List<String> events, String model) {
        this(keyword, name, summary, runtime, visibility, mine, inputs, events, model, null, "");
    }

    public Command(String keyword, String name, String summary, String runtime, String visibility, boolean mine, List<Input> inputs, List<String> events, String model, String icon, String usage) {
        this.keyword = keyword;
        this.name = name;
        this.summary = summary;
        this.runtime = runtime;
        this.visibility = visibility;
        this.mine = mine;
        this.inputs = inputs == null ? Collections.emptyList() : inputs;
        this.events = events;
        this.model = model;
        this.icon = icon == null || icon.trim().isEmpty() ? null : icon.trim();
        this.usage = usage == null ? "" : usage;
    }

    /** From the server's JSON; null when it has no keyword. */
    public static Command from(JSONObject o) {
        String keyword = o.optString("keyword", "");
        if (keyword.isEmpty()) return null;
        List<Input> inputs = new ArrayList<>();
        JSONArray in = o.optJSONArray("inputs");
        for (int i = 0; in != null && i < in.length(); i++) {
            JSONObject x = in.optJSONObject(i);
            if (x == null || x.optString("name", "").isEmpty()) continue;
            inputs.add(new Input(x.optString("name"), text(x, "type"), text(x, "label"), text(x, "help"), x.optBoolean("required"),
                x.has("default") ? x.opt("default") : null, strings(x.optJSONArray("values")), text(x, "pattern"), number(x, "min"), number(x, "max")));
        }
        JSONArray ev = o.optJSONArray("events");
        return new Command(keyword, text(o, "name"), text(o, "summary"), text(o, "runtime"),
            "caller".equals(o.opt("visibility")) ? "caller" : "room", o.optBoolean("mine"), inputs,
            ev == null ? null : strings(ev), o.opt("model") instanceof String ? o.optString("model") : null,
            text(o, "icon"), text(o, "usage"));
    }

    /** A finite number the server sent (6.11 min / max), else null. */
    private static Double number(JSONObject o, String k) {
        Object v = o.opt(k);
        return v instanceof Number && Double.isFinite(((Number) v).doubleValue()) ? ((Number) v).doubleValue() : null;
    }

    private static String text(JSONObject o, String k) { return o.opt(k) instanceof String ? o.optString(k) : ""; }

    static List<String> strings(JSONArray a) {
        List<String> out = new ArrayList<>();
        for (int i = 0; a != null && i < a.length(); i++) if (a.opt(i) instanceof String) out.add(a.optString(i));
        return out;
    }
}
