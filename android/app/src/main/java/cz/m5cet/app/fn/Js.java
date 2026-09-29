package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Iterator;
import java.util.regex.Pattern;

/**
 * The bits of JavaScript the ported web code relies on, so the port behaves
 * the same: what \s and trim() take for white space, String(v), Number(v),
 * and JSON.stringify — sizes of outputs are measured with it (org.json on
 * Android writes "/" as "\/", which would make base64 data 1–2 % larger) and
 * the Markdown of a JSON output is its pretty form.
 */
final class Js {
    private Js() {}

    /** The characters of JavaScript's \s (WhiteSpace and LineTerminator), for a regex class. */
    static final String WS_CHARS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";
    /** JavaScript's \s and \S. */
    static final String S = "[" + WS_CHARS + "]";
    static final String NS = "[^" + WS_CHARS + "]";

    static boolean isWs(char c) {
        return c == ' ' || (c >= 0x09 && c <= 0x0D) || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A)
            || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
    }

    /** String.prototype.trim(). */
    static String trim(String s) {
        int a = 0, b = s.length();
        while (a < b && isWs(s.charAt(a))) a++;
        while (b > a && isWs(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }

    /** The first code point of a string as a string ("" for an empty one) — [...s][0]. */
    static String firstCodePoint(String s) {
        return s.isEmpty() ? "" : s.substring(0, Character.charCount(s.codePointAt(0)));
    }

    /** A JSON value from its text (JSON.parse); throws on anything else. */
    static Object parse(String json) throws JSONException {
        JSONTokener t = new JSONTokener(json);
        Object v = t.nextValue();
        if (t.nextClean() != 0) throw new JSONException("trailing characters");
        return v;
    }

    /** Number.prototype.toString(): "1", "1.5", "1e+21", "1e-7". */
    static String numberToString(double d) {
        if (Double.isNaN(d)) return "NaN";
        if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "-Infinity";
        if (d == 0) return "0";
        if (d < 0) return "-" + numberToString(-d);
        BigDecimal bd = new BigDecimal(Double.toString(d)).stripTrailingZeros();
        String digits = bd.unscaledValue().toString();
        int k = digits.length();
        int n = k - bd.scale(); // d = 0.digits × 10^n
        if (k <= n && n <= 21) return digits + zeros(n - k);
        if (0 < n && n <= 21) return digits.substring(0, n) + "." + digits.substring(n);
        if (-6 < n && n <= 0) return "0." + zeros(-n) + digits;
        int e = n - 1;
        return (k == 1 ? digits : digits.charAt(0) + "." + digits.substring(1)) + "e" + (e >= 0 ? "+" : "-") + Math.abs(e);
    }

    // (String.repeat() needs Android 13.)
    private static String zeros(int n) { return fill('0', n); }
    private static String spaces(int n) { return fill(' ', n); }

    static String fill(char c, int n) {
        char[] a = new char[Math.max(0, n)];
        java.util.Arrays.fill(a, c);
        return new String(a);
    }

    /** String(v); null stands for undefined. */
    static String str(Object v) {
        if (v == null) return "undefined";
        if (v == JSONObject.NULL) return "null";
        if (v instanceof String) return (String) v;
        if (v instanceof Number) return numberToString(((Number) v).doubleValue());
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < a.length(); i++) {
                if (i > 0) sb.append(',');
                Object x = a.opt(i);
                if (x != null && x != JSONObject.NULL) sb.append(str(x));
            }
            return sb.toString();
        }
        if (v instanceof JSONObject) return "[object Object]";
        return String.valueOf(v);
    }

    private static final Pattern DECIMAL = Pattern.compile("[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?");
    private static final Pattern RADIX = Pattern.compile("0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)");

    /** Number(v); null stands for undefined. */
    static double toNumber(Object v) {
        if (v == null) return Double.NaN;
        if (v == JSONObject.NULL) return 0;
        if (v instanceof Boolean) return (Boolean) v ? 1 : 0;
        if (v instanceof Number) return ((Number) v).doubleValue();
        if (v instanceof JSONObject) return Double.NaN;
        String t = trim(v instanceof String ? (String) v : str(v));
        if (t.isEmpty()) return 0;
        if (t.equals("Infinity") || t.equals("+Infinity")) return Double.POSITIVE_INFINITY;
        if (t.equals("-Infinity")) return Double.NEGATIVE_INFINITY;
        if (RADIX.matcher(t).matches()) {
            char r = Character.toLowerCase(t.charAt(1));
            return new BigInteger(t.substring(2), r == 'x' ? 16 : r == 'o' ? 8 : 2).doubleValue();
        }
        return DECIMAL.matcher(t).matches() ? Double.parseDouble(t) : Double.NaN;
    }

    /** JSON.stringify(v): compact. */
    static String stringify(Object v) { return stringify(v, 0); }

    /** JSON.stringify(v, null, indent). */
    static String stringify(Object v, int indent) {
        StringBuilder sb = new StringBuilder();
        write(sb, v, indent, "");
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object v, int indent, String pad) {
        if (v == null || v == JSONObject.NULL) { sb.append("null"); return; }
        if (v instanceof String) { quote(sb, (String) v); return; }
        if (v instanceof Boolean) { sb.append(v); return; }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            sb.append(Double.isNaN(d) || Double.isInfinite(d) ? "null" : numberToString(d));
            return;
        }
        String inner = pad + spaces(indent);
        String sep = indent > 0 ? ",\n" + inner : ",";
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            if (a.length() == 0) { sb.append("[]"); return; }
            sb.append('[');
            if (indent > 0) sb.append('\n').append(inner);
            for (int i = 0; i < a.length(); i++) {
                if (i > 0) sb.append(sep);
                write(sb, a.opt(i), indent, inner);
            }
            if (indent > 0) sb.append('\n').append(pad);
            sb.append(']');
            return;
        }
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            if (o.length() == 0) { sb.append("{}"); return; }
            sb.append('{');
            if (indent > 0) sb.append('\n').append(inner);
            boolean first = true;
            for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                if (!first) sb.append(sep);
                first = false;
                quote(sb, k);
                sb.append(indent > 0 ? ": " : ":");
                write(sb, o.opt(k), indent, inner);
            }
            if (indent > 0) sb.append('\n').append(pad);
            sb.append('}');
            return;
        }
        quote(sb, String.valueOf(v));
    }

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    boolean lone = Character.isSurrogate(c) && !(Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1)))
                        && !(Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(s.charAt(i - 1)));
                    if (c < 0x20 || lone) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    /**
     * plainJson(): a value that survives JSON, as a fresh copy — or null
     * (undefined) when there is none or its JSON is longer than maxChars.
     */
    static Object plain(Object v, int maxChars) {
        if (v == null) return null;
        String s = stringify(v);
        if (s.length() > maxChars) return null;
        try { return parse(s); } catch (JSONException e) { return null; }
    }
}
