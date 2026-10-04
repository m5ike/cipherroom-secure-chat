package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * The outputs of a function run — a port of client/src/lib/fn-outputs.ts,
 * the rules the server and the web app share: what an output is (check,
 * sanitize), what a room message may carry (shareable), its Markdown (the
 * message's text for older apps, search and forwarding), a form's fields,
 * masks and value checks. An output is a JSONObject with a "type"; lists are
 * JSONArrays, as they travel in a message's flags.fn. 6.6 adds formatted
 * HTML, sanitized by FnHtml (fn-html.ts).
 */
public final class Outputs {
    private Outputs() {}

    /** How big one output may be (characters of text / base64). */
    public static final int OUTPUT_MAX_CHARS = 16 * 1024 * 1024;
    /** What a peer's message may carry, all outputs together. */
    public static final int PEER_MAX_TOTAL = 900_000;
    /** What this app puts into a room message. */
    public static final int ROOM_MAX_TOTAL = 700_000;

    static final List<String> OUTPUT_TYPES = Arrays.asList("text", "markdown", "code", "table", "json", "image", "file", "flash", "window", "audio", "video", "button", "form", "js", "html");
    static final List<String> FORM_FIELD_TYPES = Arrays.asList(
        "text", "textarea", "number", "range", "tel", "email", "url", "password",
        "date", "time", "datetime", "month", "color", "masked",
        "select", "multiselect", "radio", "checkbox", "switch",
        "hidden", "static", "separator");
    static final List<String> BUTTON_CLASSES = Arrays.asList("primary", "secondary", "success", "danger", "warning", "info", "ghost", "outline", "link", "small", "large", "block", "round");
    private static final List<String> FLASH_LEVELS = Arrays.asList("info", "success", "warning", "error");

    private static final Pattern IMAGE_MIME = Pattern.compile("image/(png|jpeg|gif|webp|svg\\+xml)");
    private static final Pattern AUDIO_MIME = Pattern.compile("audio/(mpeg|mp3|wav|x-wav|wave|ogg|webm|aac|mp4|flac|x-m4a)");
    private static final Pattern VIDEO_MIME = Pattern.compile("video/(mp4|webm|ogg)");
    private static final Pattern FILE_MIME = Pattern.compile("[\\w.+-]+/[\\w.+-]+");
    private static final Pattern NAME_RE = Pattern.compile("[A-Za-z0-9_.:-]{1,64}");
    private static final Pattern CSS_COLOR = cssColor(Js.S);
    private static final Pattern EMAIL = Pattern.compile("[^" + Js.WS_CHARS + "@]+@[^" + Js.WS_CHARS + "@]+\\.[^" + Js.WS_CHARS + "@]+");

    /** The CSS colours a button's style may use; s is JavaScript's \s. */
    private static Pattern cssColor(String s) {
        String n = s + "*[\\d.]+%?" + s + "*";
        return Pattern.compile("#[0-9a-f]{3,8}"
            + "|rgba?\\(" + n + "," + n + "," + n + "(," + n + ")?\\)"
            + "|hsla?\\(" + s + "*[\\d.]+(deg)?" + s + "*," + s + "*[\\d.]+%" + s + "*," + s + "*[\\d.]+%" + s + "*(," + n + ")?\\)"
            + "|[a-z]{3,20}", Pattern.CASE_INSENSITIVE);
    }

    /* ------------------------------------------------------------ helpers */

    /** str(): a string no longer than max, else null. */
    private static String str(Object v, int max) { return v instanceof String && ((String) v).length() <= max ? (String) v : null; }

    /** opt(): a non-empty string cut to max, else null. */
    private static String opt(Object v, int max) {
        if (!(v instanceof String) || ((String) v).isEmpty()) return null;
        String s = (String) v;
        return s.length() > max ? s.substring(0, max) : s;
    }

    /** num(): a finite number, or a string that is one; else null. */
    private static Double num(Object v) {
        if (v instanceof Number) { double d = ((Number) v).doubleValue(); return Double.isFinite(d) ? d : null; }
        if (v instanceof String && !Js.trim((String) v).isEmpty()) { double d = Js.toNumber(v); return Double.isFinite(d) ? d : null; }
        return null;
    }

    private static Integer clampInt(Object v, int lo, int hi) {
        Double n = num(v);
        return n == null ? null : (int) Math.max(lo, Math.min(hi, Math.round(n)));
    }

    /** A number as JSON keeps it: integral ones as integers. */
    static Object jsonNumber(double d) { return d == Math.rint(d) && Math.abs(d) < 1e15 ? (Object) (long) d : (Object) d; }

    private static String cut(String s, int max) { return s.length() > max ? s.substring(0, max) : s; }

    private static boolean isBase64(String s) {
        int n = s.length();
        int end = n;
        while (end > 0 && n - end < 2 && s.charAt(end - 1) == '=') end--;
        for (int i = 0; i < end; i++) {
            char c = s.charAt(i);
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/')) return false;
        }
        return true;
    }

    private static JSONObject put(JSONObject o, String k, Object v) {
        try { return o.put(k, v); } catch (JSONException e) { throw new IllegalArgumentException(e); }
    }

    private static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        for (int i = 0; i < kv.length; i += 2) if (kv[i + 1] != null) put(o, (String) kv[i], kv[i + 1]);
        return o;
    }

    private static boolean isTrue(Object v) { return Boolean.TRUE.equals(v); }

    /* ---------------------------------------------------- forms & buttons */

    private static JSONArray sanitizeOptions(Object raw) {
        JSONArray out = new JSONArray();
        if (!(raw instanceof JSONArray)) return out;
        JSONArray a = (JSONArray) raw;
        for (int i = 0; i < Math.min(200, a.length()); i++) {
            Object o = a.opt(i);
            if (o instanceof String || o instanceof Number) { String s = cut(Js.str(o), 200); out.put(obj("value", s, "label", s)); continue; }
            if (!(o instanceof JSONObject)) continue;
            JSONObject x = (JSONObject) o;
            Object value = x.has("value") ? x.opt("value") : x.opt("label");
            if (value == null || value == JSONObject.NULL) continue;
            Object label = x.opt("label") == null || x.opt("label") == JSONObject.NULL ? value : x.opt("label");
            out.put(obj("value", cut(Js.str(value), 200), "label", cut(Js.str(label), 200), "icon", opt(x.opt("icon"), 16)));
        }
        return out;
    }

    private static JSONObject sanitizeField(Object raw) {
        if (!(raw instanceof JSONObject)) return null;
        JSONObject r = (JSONObject) raw;
        String t = Js.str(r.opt("type"));
        String type = FORM_FIELD_TYPES.contains(t) ? t : "text";
        Object n = r.opt("name");
        String name = n instanceof String && NAME_RE.matcher((String) n).matches() ? (String) n : type.equals("static") || type.equals("separator") ? "" : null;
        if (name == null) return null;
        JSONObject f = obj("name", name, "type", type,
            "label", opt(r.opt("label"), 200), "placeholder", opt(r.opt("placeholder"), 200), "help", opt(r.opt("help"), 500));
        if (r.has("default")) put(f, "default", Js.plain(r.opt("default"), 4000));
        if (isTrue(r.opt("required"))) put(f, "required", true);
        if (isTrue(r.opt("readonly"))) put(f, "readonly", true);
        for (String k : new String[] { "min", "max", "step" }) { Double d = num(r.opt(k)); if (d != null) put(f, k, jsonNumber(d)); }
        String pattern = opt(r.opt("pattern"), 300);
        // JavaScript and Java regular expressions agree on what forms use; one Java cannot read is left out.
        if (pattern != null) { try { Pattern.compile(pattern); put(f, "pattern", pattern); } catch (PatternSyntaxException ignored) { } }
        put(f, "mask", opt(r.opt("mask"), 60));
        Integer rows = clampInt(r.opt("rows"), 1, 30); if (rows != null) put(f, "rows", rows);
        Integer span = clampInt(r.opt("span"), 1, 4); if (span != null) put(f, "span", span);
        Object labels = r.opt("labels"); if ("top".equals(labels) || "left".equals(labels)) put(f, "labels", labels);
        if (type.equals("select") || type.equals("multiselect") || type.equals("radio")) put(f, "options", sanitizeOptions(r.opt("options")));
        put(f, "text", opt(r.opt("text"), 8000));
        return f;
    }

    private static JSONArray sanitizeFields(Object raw, int[] budget) {
        JSONArray out = new JSONArray();
        if (!(raw instanceof JSONArray)) return out;
        JSONArray a = (JSONArray) raw;
        Set<String> seen = new LinkedHashSet<>();
        for (int i = 0; i < a.length(); i++) {
            if (budget[0] <= 0) break;
            JSONObject f = sanitizeField(a.opt(i));
            String name = f == null ? "" : f.optString("name");
            if (f == null || (!name.isEmpty() && seen.contains(name))) continue;
            if (!name.isEmpty()) seen.add(name);
            out.put(f);
            budget[0]--;
        }
        return out;
    }

    /** A form as the app may render it (without "type"), or null. */
    static JSONObject sanitizeForm(JSONObject raw) {
        Object n = raw.opt("name");
        JSONObject form = obj("name", n instanceof String && NAME_RE.matcher((String) n).matches() ? n : "form",
            "title", opt(raw.opt("title"), 300), "text", opt(raw.opt("text"), 4000), "submit", opt(raw.opt("submit"), 60));
        int[] budget = { 120 };
        Object labels = raw.opt("labels"); if ("top".equals(labels) || "left".equals(labels)) put(form, "labels", labels);
        Integer columns = clampInt(raw.opt("columns"), 1, 4); if (columns != null) put(form, "columns", columns);
        if (isTrue(raw.opt("once"))) put(form, "once", true);
        JSONArray fields = sanitizeFields(raw.opt("fields"), budget);
        if (fields.length() > 0) put(form, "fields", fields);
        if (raw.opt("panels") instanceof JSONArray) {
            JSONArray ps = (JSONArray) raw.opt("panels");
            JSONArray panels = new JSONArray();
            for (int i = 0; i < Math.min(16, ps.length()); i++) {
                if (!(ps.opt(i) instanceof JSONObject)) continue;
                JSONObject p = ps.optJSONObject(i);
                JSONObject panel = obj("fields", sanitizeFields(p.opt("fields"), budget), "title", opt(p.opt("title"), 200), "text", opt(p.opt("text"), 2000));
                Object layout = p.opt("layout"); if ("rows".equals(layout) || "columns".equals(layout)) put(panel, "layout", layout);
                Integer pc = clampInt(p.opt("columns"), 1, 4); if (pc != null) put(panel, "columns", pc);
                Object pl = p.opt("labels"); if ("top".equals(pl) || "left".equals(pl)) put(panel, "labels", pl);
                if (isTrue(p.opt("collapsed"))) put(panel, "collapsed", true);
                panels.put(panel);
            }
            if (panels.length() > 0) put(form, "panels", panels);
        }
        return form.has("fields") || form.has("panels") ? form : null;
    }

    /** A button as the app may render it (without "type"), or null. */
    static JSONObject sanitizeButton(JSONObject raw) {
        Object n = raw.opt("name");
        String name = n instanceof String && NAME_RE.matcher((String) n).matches() ? (String) n : null;
        String title = opt(firstDefined(raw.opt("title"), raw.opt("label"), raw.opt("text")), 120);
        if (name == null || title == null) return null;
        JSONObject b = obj("name", name, "title", title);
        if (raw.has("data")) put(b, "data", Js.plain(raw.opt("data"), 16_000));
        if (raw.opt("css") instanceof String) {
            Set<String> cls = new LinkedHashSet<>();
            for (String c : ((String) raw.opt("css")).split(Js.S + "+")) if (BUTTON_CLASSES.contains(c)) cls.add(c);
            if (!cls.isEmpty()) put(b, "css", String.join(" ", cls));
        }
        if (raw.opt("style") instanceof JSONObject) {
            JSONObject style = raw.optJSONObject("style");
            JSONObject st = new JSONObject();
            for (String k : new String[] { "color", "background", "border" }) {
                Object v = style.opt(k);
                if (v instanceof String && CSS_COLOR.matcher(Js.trim((String) v)).matches()) put(st, k, Js.trim((String) v));
            }
            if (st.length() > 0) put(b, "style", st);
        }
        put(b, "icon", opt(raw.opt("icon"), 16));
        put(b, "confirm", opt(raw.opt("confirm"), 300));
        if (isTrue(raw.opt("once"))) put(b, "once", true);
        if (isTrue(raw.opt("disabled"))) put(b, "disabled", true);
        return b;
    }

    /** a ?? b ?? c. */
    private static Object firstDefined(Object... vs) {
        for (Object v : vs) if (v != null && v != JSONObject.NULL) return v;
        return null;
    }

    /* ------------------------------------------------------------- check */

    /** One output checked: the output (ok), or why it is not one. */
    public static final class Check {
        public final JSONObject output;
        public final String reason;
        Check(JSONObject output, String reason) { this.output = output; this.reason = reason; }
        public boolean ok() { return output != null; }
    }

    private static Check good(JSONObject o) { return new Check(o, null); }

    /** checkFnOutput(): one output, field by field. */
    public static Check check(Object v, int maxChars) {
        if (!(v instanceof JSONObject)) return new Check(null, "not an object");
        JSONObject o = (JSONObject) v;
        Object t = o.opt("type");
        if (!(t instanceof String) || !OUTPUT_TYPES.contains(t)) {
            String shown = Js.stringify(t == null || t == JSONObject.NULL ? "" : Js.str(t));
            return new Check(null, "unknown output type " + cut(shown, 40));
        }
        String type = (String) t;
        switch (type) {
            case "text": case "markdown": {
                String text = str(o.opt("text"), maxChars);
                return text == null ? bad(type, "text must be a string") : good(obj("type", type, "text", text));
            }
            case "code": {
                String text = str(o.opt("text"), maxChars);
                Object l = o.opt("lang");
                String lang = str(l == null || l == JSONObject.NULL ? "" : l, 40);
                return text == null || lang == null ? bad(type, "text must be a string") : good(obj("type", "code", "text", text, "lang", lang));
            }
            case "table": {
                if (!(o.opt("columns") instanceof JSONArray) || !(o.opt("rows") instanceof JSONArray)) return bad(type, "columns and rows must be lists");
                JSONArray rows0 = o.optJSONArray("rows");
                for (int i = 0; i < rows0.length(); i++) if (!(rows0.opt(i) instanceof JSONArray)) return bad(type, "columns and rows must be lists");
                String title = opt(o.opt("title"), 500);
                Object rows = Js.plain(rows0, maxChars);
                if (rows == null) return bad(type, "the rows are not plain data");
                JSONArray cols0 = o.optJSONArray("columns");
                JSONArray columns = new JSONArray();
                for (int i = 0; i < cols0.length(); i++) columns.put(cut(Js.str(cols0.opt(i)), 200));
                return good(obj("type", "table", "columns", columns, "rows", rows, "title", title));
            }
            case "json": {
                String title = opt(o.opt("title"), 500);
                Object value = o.has("value") ? Js.plain(o.opt("value"), maxChars) : JSONObject.NULL;
                if (value == null) return bad(type, "the value is not plain data");
                return good(obj("type", "json", "value", value, "title", title));
            }
            case "image": {
                String mime = str(o.opt("mime"), 100);
                String data = str(o.opt("data"), maxChars);
                if (mime == null || mime.isEmpty() || !IMAGE_MIME.matcher(mime).matches()) return bad(type, "mime must be image/png, jpeg, gif, webp or svg+xml");
                if (data == null || !isBase64(data)) return bad(type, "data must be base64 (m5.out.image takes bytes)");
                return good(obj("type", "image", "mime", mime, "data", data, "alt", opt(o.opt("alt"), 500)));
            }
            case "file": {
                String name = str(o.opt("name"), 200);
                String mime = str(o.opt("mime"), 100);
                String data = str(o.opt("data"), maxChars);
                if (name == null || name.isEmpty() || mime == null || mime.isEmpty() || !FILE_MIME.matcher(mime).matches()) return bad(type, "a file needs a name and a mime type");
                if (data == null || !isBase64(data)) return bad(type, "data must be base64");
                return good(obj("type", "file", "name", name.replaceAll("[\\\\/\\x00]", "_"), "mime", mime, "data", data));
            }
            case "flash": {
                String text = str(o.opt("text"), 2000);
                if (text == null) return bad(type, "text must be a string (up to 2000 characters)");
                Object level = o.opt("level");
                return good(obj("type", "flash", "text", text, "level", level instanceof String && FLASH_LEVELS.contains(level) ? level : "info"));
            }
            case "window": {
                String id = str(o.opt("id"), 100);
                if (id == null || id.isEmpty()) return bad(type, "id must be a string");
                Object args = Js.plain(o.opt("args"), 16_000);
                return good(obj("type", "window", "id", id, "args", args == null ? JSONObject.NULL : args));
            }
            case "audio": case "video": {
                String mime = str(o.opt("mime"), 100);
                String data = str(o.opt("data"), maxChars);
                if (mime == null || mime.isEmpty() || !(type.equals("audio") ? AUDIO_MIME : VIDEO_MIME).matcher(mime).matches())
                    return bad(type, type.equals("audio") ? "mime must be audio/mpeg, wav, ogg, webm, aac, mp4 or flac" : "mime must be video/mp4, webm or ogg");
                if (data == null || data.isEmpty() || !isBase64(data)) return bad(type, "data must be base64 bytes (m5.out.audio / m5.out.video take bytes)");
                return good(obj("type", type, "mime", mime, "data", data, "title", opt(o.opt("title"), 300),
                    "autoplay", isTrue(o.opt("autoplay")) ? true : null, "loop", isTrue(o.opt("loop")) ? true : null));
            }
            case "button": {
                JSONObject b = sanitizeButton(o);
                return b == null ? bad(type, "a button needs a name (letters, digits, _ . : -) and a title") : good(typed("button", b));
            }
            case "form": {
                JSONObject f = sanitizeForm(o);
                return f == null ? bad(type, "a form needs fields (or panels with fields)") : good(typed("form", f));
            }
            case "js": {
                String code = str(o.opt("code"), 200_000);
                if (code == null || Js.trim(code).isEmpty()) return bad(type, "code must be a string (up to 200 000 characters)");
                Integer height = clampInt(o.opt("height"), 0, 2000);
                return good(obj("type", "js", "code", code, "args", Js.plain(o.opt("args"), 64_000), "title", opt(o.opt("title"), 200),
                    "height", height, "hidden", isTrue(o.opt("hidden")) ? true : null));
            }
            case "html": {
                // 6.6: formatted HTML — document markup only (FnHtml), sanitized here and again where it is drawn.
                String html = str(o.opt("html"), Math.min(maxChars, FnHtml.MAX));
                if (html == null) return bad(type, "html must be a string (up to " + FnHtml.MAX + " characters)");
                return good(obj("type", "html", "html", FnHtml.sanitize(html), "title", opt(o.opt("title"), 300)));
            }
            default: return bad(type, "unknown");
        }
    }

    public static Check check(Object v) { return check(v, OUTPUT_MAX_CHARS); }

    private static Check bad(String type, String why) { return new Check(null, type + ": " + why); }

    /** { type, ...fields } in that order. */
    private static JSONObject typed(String type, JSONObject fields) {
        JSONObject o = obj("type", type);
        for (java.util.Iterator<String> it = fields.keys(); it.hasNext(); ) { String k = it.next(); put(o, k, fields.opt(k)); }
        return o;
    }

    /** sanitizeFnOutputs(): the valid outputs of a peer's message (at most 50), within maxTotal characters. */
    public static JSONArray sanitize(Object raw, int maxTotal) {
        JSONArray out = new JSONArray();
        if (!(raw instanceof JSONArray)) return out;
        JSONArray a = (JSONArray) raw;
        int used = 0;
        for (int i = 0; i < Math.min(50, a.length()); i++) {
            Check c = check(a.opt(i), maxTotal);
            if (!c.ok()) continue;
            int size = Js.stringify(c.output).length();
            if (used + size > maxTotal) break;
            used += size;
            out.put(c.output);
        }
        return out;
    }

    public static JSONArray sanitize(Object raw) { return sanitize(raw, PEER_MAX_TOTAL); }

    /** shareableOutputs(): what fits into a room message; a larger item becomes a note. */
    public static JSONArray shareable(JSONArray outputs, int maxTotal) {
        JSONArray out = new JSONArray();
        int used = 0;
        for (int i = 0; i < outputs.length(); i++) {
            Object o = outputs.opt(i);
            int size = Js.stringify(o).length();
            if (used + size <= maxTotal) { out.put(o); used += size; continue; }
            String type = o instanceof JSONObject ? Js.str(((JSONObject) o).opt("type")) : "undefined";
            out.put(obj("type", "text", "text", "(" + type + " — too large to share in the room)"));
            used += 80;
        }
        return out;
    }

    public static JSONArray shareable(JSONArray outputs) { return shareable(outputs, ROOM_MAX_TOTAL); }

    /* ---------------------------------------------------------- Markdown */

    /** outputsToMarkdown(): the text of the message. */
    public static String toMarkdown(JSONArray outputs) {
        List<String> parts = new ArrayList<>();
        for (int i = 0; i < outputs.length(); i++) {
            JSONObject o = outputs.optJSONObject(i);
            if (o == null) continue;
            switch (o.optString("type")) {
                case "text": case "markdown": parts.add(s(o, "text")); break;
                case "code": parts.add("```" + s(o, "lang") + "\n" + s(o, "text") + "\n```"); break;
                case "json": parts.add((truthy(o, "title") ? "**" + s(o, "title") + "**\n" : "") + "```json\n" + Js.stringify(o.opt("value"), 2) + "\n```"); break;
                case "table": parts.add(tableToMarkdown(o)); break;
                case "flash": parts.add("> " + s(o, "text")); break;
                case "image": parts.add("_(image: " + (truthy(o, "alt") ? s(o, "alt") : s(o, "mime")) + ")_"); break;
                case "file": parts.add("_(file: " + s(o, "name") + ")_"); break;
                case "audio": case "video": parts.add("_(" + s(o, "type") + (truthy(o, "title") ? ": " + s(o, "title") : "") + ")_"); break;
                case "button": parts.add("[" + (truthy(o, "icon") ? s(o, "icon") + " " : "") + s(o, "title") + "]"); break;
                case "form": parts.add("**" + (truthy(o, "title") ? s(o, "title") : "Form") + "**" + (truthy(o, "text") ? "\n" + s(o, "text") : "")); break;
                case "html": parts.add((truthy(o, "title") ? "**" + s(o, "title") + "**\n\n" : "") + FnHtml.text(FnHtml.parse(s(o, "html")))); break;
                default: break; // window, js: nothing to read
            }
        }
        return Js.trim(String.join("\n\n", parts));
    }

    /** `${o.k}` of a present field ("" when it is missing). */
    private static String s(JSONObject o, String k) { Object v = o.opt(k); return v == null ? "" : Js.str(v); }

    private static boolean truthy(JSONObject o, String k) {
        Object v = o.opt(k);
        return v != null && v != JSONObject.NULL && !"".equals(v) && !Boolean.FALSE.equals(v) && !(v instanceof Number && (((Number) v).doubleValue() == 0 || Double.isNaN(((Number) v).doubleValue())));
    }

    /** A table cell as text: objects as JSON. */
    static String cellText(Object v) {
        if (v == null || v == JSONObject.NULL) return "";
        return v instanceof JSONObject || v instanceof JSONArray ? Js.stringify(v) : Js.str(v);
    }

    private static String tableToMarkdown(JSONObject o) {
        JSONArray columns = o.optJSONArray("columns");
        JSONArray rows = o.optJSONArray("rows");
        StringBuilder head = new StringBuilder("|");
        StringBuilder sep = new StringBuilder("|");
        for (int i = 0; columns != null && i < columns.length(); i++) {
            head.append(i == 0 ? " " : " | ").append(mdCell(columns.opt(i)));
            sep.append(i == 0 ? " " : " | ").append("---");
        }
        head.append(" |");
        sep.append(" |");
        List<String> body = new ArrayList<>();
        for (int r = 0; rows != null && r < rows.length(); r++) {
            JSONArray row = rows.optJSONArray(r);
            StringBuilder line = new StringBuilder("|");
            for (int c = 0; row != null && c < row.length(); c++) line.append(c == 0 ? " " : " | ").append(mdCell(row.opt(c)));
            body.add(line.append(" |").toString());
        }
        return (truthy(o, "title") ? "**" + s(o, "title") + "**\n\n" : "") + head + "\n" + sep + "\n" + String.join("\n", body);
    }

    private static String mdCell(Object v) { return cellText(v).replace("|", "\\|").replace("\n", " "); }

    /* -------------------------------------------------------------- forms */

    /** formFields(): a form's fields, panels included, in order. */
    public static List<JSONObject> formFields(JSONObject form) {
        List<JSONObject> out = new ArrayList<>();
        addAll(out, form.optJSONArray("fields"));
        JSONArray panels = form.optJSONArray("panels");
        for (int i = 0; panels != null && i < panels.length(); i++) {
            JSONObject p = panels.optJSONObject(i);
            if (p != null) addAll(out, p.optJSONArray("fields"));
        }
        return out;
    }

    private static void addAll(List<JSONObject> out, JSONArray a) {
        for (int i = 0; a != null && i < a.length(); i++) { JSONObject f = a.optJSONObject(i); if (f != null) out.add(f); }
    }

    /** One part of a mask: a slot ('0' a digit, 'a' a letter, '*' either) or a literal character. */
    public static final class MaskToken {
        public final boolean slot;
        public final String c;
        MaskToken(boolean slot, String c) { this.slot = slot; this.c = c; }
    }

    /** maskTokens(): what is in {braces} or after a backslash is literal ("+{420} 000 000 000"). */
    public static List<MaskToken> maskTokens(String mask) {
        List<MaskToken> out = new ArrayList<>();
        List<String> chars = codePoints(mask);
        for (int i = 0; i < chars.size(); i++) {
            String c = chars.get(i);
            if (c.equals("\\") && i + 1 < chars.size()) { out.add(new MaskToken(false, chars.get(++i))); continue; }
            if (c.equals("{")) {
                int end = chars.subList(i + 1, chars.size()).indexOf("}");
                if (end >= 0) {
                    end += i + 1;
                    for (String x : chars.subList(i + 1, end)) out.add(new MaskToken(false, x));
                    i = end;
                    continue;
                }
            }
            out.add(new MaskToken(c.equals("0") || c.equals("a") || c.equals("*"), c));
        }
        return out;
    }

    /** maskPlaceholder(): "+420 ___ ___ ___". */
    public static String maskPlaceholder(String mask) {
        StringBuilder sb = new StringBuilder();
        for (MaskToken t : maskTokens(mask)) sb.append(t.slot ? "_" : t.c);
        return sb.toString();
    }

    /** applyMask(): "777123456" → "+420 777 123 456". */
    public static String applyMask(String mask, String raw) {
        List<String> chars = new ArrayList<>();
        for (String c : codePoints(raw)) if (isL(c.codePointAt(0)) || isN(c.codePointAt(0))) chars.add(c);
        StringBuilder out = new StringBuilder();
        int i = 0;
        for (MaskToken tk : maskTokens(mask)) {
            if (i >= chars.size()) break;
            if (tk.slot) {
                // Skip what does not fit this slot.
                while (i < chars.size() && !fits(tk.c, chars.get(i).codePointAt(0))) i++;
                if (i >= chars.size()) break;
                out.append(chars.get(i++));
            } else {
                out.append(tk.c);
                if (chars.get(i).equals(tk.c)) i++;
            }
        }
        return out.toString();
    }

    private static boolean fits(String slot, int cp) { return slot.equals("0") ? isN(cp) : !slot.equals("a") || isL(cp); }

    /** \p{L}. */
    static boolean isL(int cp) { return Character.isLetter(cp); }

    /** \p{N}. */
    static boolean isN(int cp) {
        int t = Character.getType(cp);
        return t == Character.DECIMAL_DIGIT_NUMBER || t == Character.LETTER_NUMBER || t == Character.OTHER_NUMBER;
    }

    static List<String> codePoints(String s) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < s.length(); ) { int n = Character.charCount(s.codePointAt(i)); out.add(s.substring(i, i + n)); i += n; }
        return out;
    }

    /**
     * checkFormValues(): what is wrong with a form's values, per field:
     * "required", "number", "min 2", "max 9", "email", "incomplete", "pattern".
     */
    public static Map<String, String> checkFormValues(JSONObject form, JSONObject values) {
        Map<String, String> problems = new LinkedHashMap<>();
        for (JSONObject f : formFields(form)) {
            String name = f.optString("name");
            String type = f.optString("type");
            if (name.isEmpty() || type.equals("static") || type.equals("separator")) continue;
            Object v = values.opt(name);
            boolean required = isTrue(f.opt("required"));
            boolean empty = v == null || v == JSONObject.NULL || "".equals(v) || (v instanceof JSONArray && ((JSONArray) v).length() == 0)
                || ((type.equals("checkbox") || type.equals("switch")) && !Boolean.TRUE.equals(v) && required);
            if (empty) { if (required) problems.put(name, "required"); continue; }
            if (type.equals("number") || type.equals("range")) {
                double n = Js.toNumber(v);
                if (!Double.isFinite(n)) problems.put(name, "number");
                else if (f.opt("min") instanceof Number && n < ((Number) f.opt("min")).doubleValue()) problems.put(name, "min " + Js.str(f.opt("min")));
                else if (f.opt("max") instanceof Number && n > ((Number) f.opt("max")).doubleValue()) problems.put(name, "max " + Js.str(f.opt("max")));
            }
            if (type.equals("email") && !EMAIL.matcher(Js.str(v)).matches()) problems.put(name, "email");
            // A masked value is complete when every part of the mask is filled.
            String mask = f.optString("mask", "");
            if (type.equals("masked") && f.opt("mask") instanceof String && !mask.isEmpty() && codePoints(Js.str(v)).size() < maskTokens(mask).size()) problems.put(name, "incomplete");
            if (f.opt("pattern") instanceof String && v instanceof String) {
                try { if (!Pattern.compile(f.optString("pattern")).matcher((String) v).find()) problems.put(name, "pattern"); }
                catch (PatternSyntaxException ignored) { }
            }
        }
        return problems;
    }
}
