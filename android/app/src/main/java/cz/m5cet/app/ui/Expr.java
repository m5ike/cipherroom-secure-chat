package cz.m5cet.app.ui;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The screens' expression and template language (server/android/expr.ts,
 * same test vectors: test/fixtures/android-expr.json). Parsed once and
 * cached; evaluation walks a small tree. Values are Java objects as org.json
 * gives them: String, Number, Boolean, JSONObject, JSONArray, Map, List, null.
 */
public final class Expr {
    private Expr() {}

    public interface Translate { String t(String key); }

    public interface Scope { Object get(String name); }

    public static Scope scope(Map<String, ?> map) { return map::get; }

    public static final int MAX = 400;

    /* ------------------------------------------------------------ AST */

    abstract static class Node { abstract Object eval(Scope s, Translate tr); }

    static final class Lit extends Node { final Object v; Lit(Object v) { this.v = v; } Object eval(Scope s, Translate tr) { return v; } }
    static final class Var extends Node { final String name; Var(String n) { name = n; } Object eval(Scope s, Translate tr) { return norm(s.get(name)); } }
    static final class Get extends Node {
        final Node obj, key; Get(Node o, Node k) { obj = o; key = k; }
        Object eval(Scope s, Translate tr) { return member(obj.eval(s, tr), key.eval(s, tr)); }
    }
    static final class Tr extends Node { final String key; Tr(String k) { key = k; } Object eval(Scope s, Translate tr) { return tr == null ? key : tr.t(key); } }
    static final class Un extends Node {
        final char op; final Node a; Un(char op, Node a) { this.op = op; this.a = a; }
        Object eval(Scope s, Translate tr) { Object v = a.eval(s, tr); return op == '!' ? (Object) !truthy(v) : (Object) (-num(v)); }
    }
    static final class And extends Node {
        final Node a, b; final boolean or; And(Node a, Node b, boolean or) { this.a = a; this.b = b; this.or = or; }
        Object eval(Scope s, Translate tr) { Object x = a.eval(s, tr); return or ? (truthy(x) ? x : b.eval(s, tr)) : (truthy(x) ? b.eval(s, tr) : x); }
    }
    static final class If extends Node {
        final Node c, a, b; If(Node c, Node a, Node b) { this.c = c; this.a = a; this.b = b; }
        Object eval(Scope s, Translate tr) { return truthy(c.eval(s, tr)) ? a.eval(s, tr) : b.eval(s, tr); }
    }
    static final class Bin extends Node {
        final String op; final Node a, b; Bin(String op, Node a, Node b) { this.op = op; this.a = a; this.b = b; }
        Object eval(Scope s, Translate tr) {
            Object x = a.eval(s, tr), y = b.eval(s, tr);
            switch (op) {
                case "==": return same(x, y);
                case "!=": return !same(x, y);
                case "+": return (x instanceof String || y instanceof String) ? toText(x) + toText(y) : (Object) (num(x) + num(y));
                case "-": return num(x) - num(y);
                case "*": return num(x) * num(y);
                case "/": return num(y) == 0 ? null : (Object) (num(x) / num(y));
                case "%": return num(y) == 0 ? null : (Object) (num(x) % num(y));
                default: {
                    int c;
                    if (x instanceof String && y instanceof String) c = ((String) x).compareTo((String) y);
                    else { double p = num(x), q = num(y); if (Double.isNaN(p) || Double.isNaN(q)) return false; c = Double.compare(p, q); }
                    switch (op) { case "<": return c < 0; case ">": return c > 0; case "<=": return c <= 0; default: return c >= 0; }
                }
            }
        }
    }

    /* ---------------------------------------------------------- lexer */

    static final class Tok { final char k; final String v; final int at; Tok(char k, String v, int at) { this.k = k; this.v = v; this.at = at; } }

    static List<Tok> lex(String src) {
        List<Tok> out = new ArrayList<>();
        int i = 0;
        while (i < src.length()) {
            char c = src.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { i++; continue; }
            if (Character.isDigit(c) || (c == '.' && i + 1 < src.length() && Character.isDigit(src.charAt(i + 1)))) {
                int j = i;
                while (j < src.length() && (Character.isDigit(src.charAt(j)) || src.charAt(j) == '.')) j++;
                if (j < src.length() && (src.charAt(j) == 'e' || src.charAt(j) == 'E')) { j++; if (j < src.length() && (src.charAt(j) == '+' || src.charAt(j) == '-')) j++; while (j < src.length() && Character.isDigit(src.charAt(j))) j++; }
                out.add(new Tok('n', src.substring(i, j), i)); i = j; continue;
            }
            if (c == '\'' || c == '"') {
                StringBuilder sb = new StringBuilder();
                int j = i + 1;
                while (j < src.length() && src.charAt(j) != c) {
                    if (src.charAt(j) == '\\' && j + 1 < src.length()) { sb.append(src.charAt(j + 1)); j += 2; continue; }
                    sb.append(src.charAt(j++));
                }
                if (j >= src.length()) throw new IllegalArgumentException("unterminated string at " + i);
                out.add(new Tok('s', sb.toString(), i)); i = j + 1; continue;
            }
            if (c == '$') {
                int j = i + 1;
                if (j >= src.length() || !(Character.isLetter(src.charAt(j)) || src.charAt(j) == '_')) throw new IllegalArgumentException("bad variable at " + i);
                while (j < src.length() && (Character.isLetterOrDigit(src.charAt(j)) || src.charAt(j) == '_')) j++;
                out.add(new Tok('v', src.substring(i + 1, j), i)); i = j; continue;
            }
            if (Character.isLetter(c) || c == '_') {
                int j = i;
                while (j < src.length() && (Character.isLetterOrDigit(src.charAt(j)) || src.charAt(j) == '_')) j++;
                out.add(new Tok('i', src.substring(i, j), i)); i = j; continue;
            }
            String three = src.length() >= i + 3 ? src.substring(i, i + 3) : "";
            String two = src.length() >= i + 2 ? src.substring(i, i + 2) : "";
            if (three.equals("===") || three.equals("!==")) { out.add(new Tok('o', three, i)); i += 3; continue; }
            if (two.equals("==") || two.equals("!=") || two.equals("<=") || two.equals(">=") || two.equals("&&") || two.equals("||")) { out.add(new Tok('o', two, i)); i += 2; continue; }
            if ("!+-*/%<>?:().[],".indexOf(c) >= 0) { out.add(new Tok('o', String.valueOf(c), i)); i++; continue; }
            throw new IllegalArgumentException("unexpected \"" + c + "\" at " + i);
        }
        out.add(new Tok('e', "", src.length()));
        return out;
    }

    /* --------------------------------------------------------- parser */

    static final class Parser {
        final List<Tok> t; int p = 0; int depth = 0;
        Parser(List<Tok> t) { this.t = t; }
        Tok peek() { return t.get(p); }
        boolean is(String v) { Tok k = peek(); return k.k == 'o' && k.v.equals(v); }
        void expect(String v) { if (!is(v)) throw new IllegalArgumentException("expected \"" + v + "\" at " + peek().at); p++; }

        Node expr() {
            if (++depth > 40) throw new IllegalArgumentException("expression nested too deep");
            Node n = ternary();
            depth--;
            return n;
        }
        Node ternary() {
            Node c = or();
            if (is("?")) { p++; Node a = expr(); expect(":"); Node b = expr(); return new If(c, a, b); }
            return c;
        }
        Node or() { Node a = and(); while (is("||")) { p++; a = new And(a, and(), true); } return a; }
        Node and() { Node a = eq(); while (is("&&")) { p++; a = new And(a, eq(), false); } return a; }
        Node eq() {
            Node a = rel();
            while (is("==") || is("!=") || is("===") || is("!==")) { String op = t.get(p++).v.substring(0, 2); a = new Bin(op, a, rel()); }
            return a;
        }
        Node rel() {
            Node a = add();
            while (is("<") || is(">") || is("<=") || is(">=")) { String op = t.get(p++).v; a = new Bin(op, a, add()); }
            return a;
        }
        Node add() { Node a = mul(); while (is("+") || is("-")) { String op = t.get(p++).v; a = new Bin(op, a, mul()); } return a; }
        Node mul() { Node a = unary(); while (is("*") || is("/") || is("%")) { String op = t.get(p++).v; a = new Bin(op, a, unary()); } return a; }
        Node unary() {
            if (is("!")) { p++; return new Un('!', unary()); }
            if (is("-")) { p++; return new Un('-', unary()); }
            return postfix();
        }
        Node postfix() {
            Node n = primary();
            for (;;) {
                if (is(".")) {
                    p++;
                    Tok id = peek();
                    if (id.k != 'i') throw new IllegalArgumentException("expected a name after \".\" at " + id.at);
                    p++;
                    n = new Get(n, new Lit(id.v));
                } else if (is("[")) {
                    p++;
                    Node key = expr();
                    expect("]");
                    n = new Get(n, key);
                } else return n;
            }
        }
        Node primary() {
            Tok k = peek();
            switch (k.k) {
                case 'n': p++; return new Lit(Double.parseDouble(k.v));
                case 's': p++; return new Lit(k.v);
                case 'v': p++; return new Var(k.v);
                case 'i':
                    p++;
                    if (k.v.equals("true")) return new Lit(true);
                    if (k.v.equals("false")) return new Lit(false);
                    if (k.v.equals("null")) return new Lit(null);
                    if (k.v.equals("_") && is("(")) {
                        p++;
                        Tok key = peek();
                        if (key.k != 's') throw new IllegalArgumentException("_() needs a quoted key at " + key.at);
                        p++;
                        expect(")");
                        return new Tr(key.v);
                    }
                    throw new IllegalArgumentException("unknown name \"" + k.v + "\" at " + k.at + " (variables start with $)");
                default:
                    if (is("(")) { p++; Node n = expr(); expect(")"); return n; }
                    throw new IllegalArgumentException(k.k == 'e' ? "unexpected end of the expression" : "unexpected \"" + k.v + "\" at " + k.at);
            }
        }
    }

    private static final Map<String, Object> CACHE = Collections.synchronizedMap(new LinkedHashMap<String, Object>(256, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Object> e) { return size() > 2000; }
    });

    static Node parse(String src) {
        Object cached = CACHE.get("e:" + src);
        if (cached instanceof Node) return (Node) cached;
        if (src.length() > MAX) throw new IllegalArgumentException("expression longer than " + MAX + " characters");
        Parser ps = new Parser(lex(src));
        Node n = ps.expr();
        if (ps.peek().k != 'e') throw new IllegalArgumentException("unexpected \"" + ps.peek().v + "\" at " + ps.peek().at);
        CACHE.put("e:" + src, n);
        return n;
    }

    public static Object eval(String src, Scope scope, Translate tr) { return parse(src).eval(scope, tr); }

    /** null when valid. */
    public static String check(String src) {
        try { parse(src); return null; } catch (IllegalArgumentException e) { return e.getMessage(); }
    }

    /* ---------------------------------------------------------- values */

    static Object norm(Object v) {
        if (v == null || v == JSONObject.NULL) return null;
        return v;
    }

    public static boolean truthy(Object v) {
        v = norm(v);
        if (v == null) return false;
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof Number) { double d = ((Number) v).doubleValue(); return d != 0 && !Double.isNaN(d); }
        if (v instanceof String) return !((String) v).isEmpty();
        return true;
    }

    public static double num(Object v) {
        v = norm(v);
        if (v == null) return 0;
        if (v instanceof Number) return ((Number) v).doubleValue();
        if (v instanceof Boolean) return (Boolean) v ? 1 : 0;
        if (v instanceof String) {
            String s = ((String) v).trim();
            if (s.isEmpty()) return 0;
            try { return Double.parseDouble(s); } catch (NumberFormatException e) { return Double.NaN; }
        }
        return Double.NaN;
    }

    static boolean same(Object a, Object b) {
        a = norm(a); b = norm(b);
        if (a == null || b == null) return a == b;
        if (a instanceof Number && b instanceof Number) return ((Number) a).doubleValue() == ((Number) b).doubleValue();
        if (a instanceof String && b instanceof String) return a.equals(b);
        if (a instanceof Boolean && b instanceof Boolean) return a.equals(b);
        return a == b;
    }

    static Object member(Object obj, Object key) {
        obj = norm(obj);
        if (obj == null) return null;
        boolean numeric = key instanceof Number || (key instanceof String && !((String) key).isEmpty() && ((String) key).chars().allMatch(Character::isDigit));
        if (numeric) {
            int i;
            // A number too long for an index is no index (and its text must not end up in an error's message).
            try { i = key instanceof Number ? ((Number) key).intValue() : Integer.parseInt((String) key); } catch (NumberFormatException e) { return null; }
            if (key instanceof Number && ((Number) key).doubleValue() != i) return null;
            if (obj instanceof JSONArray) return i >= 0 && i < ((JSONArray) obj).length() ? norm(((JSONArray) obj).opt(i)) : null;
            if (obj instanceof List) return i >= 0 && i < ((List<?>) obj).size() ? norm(((List<?>) obj).get(i)) : null;
            if (obj instanceof String) return i >= 0 && i < ((String) obj).length() ? String.valueOf(((String) obj).charAt(i)) : null;
        }
        if (!(key instanceof String)) return null;
        String k = (String) key;
        if (k.equals("length")) {
            if (obj instanceof JSONArray) return (double) ((JSONArray) obj).length();
            if (obj instanceof List) return (double) ((List<?>) obj).size();
            if (obj instanceof String) return (double) ((String) obj).length();
        }
        if (obj instanceof JSONObject) return norm(((JSONObject) obj).opt(k));
        if (obj instanceof Map) return norm(((Map<?, ?>) obj).get(k));
        return null;
    }

    /** How a value reads in text: integers without ".0", nothing for null. */
    public static String toText(Object v) {
        v = norm(v);
        if (v == null) return "";
        if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) return "";
            if (d == Math.rint(d) && Math.abs(d) < 1e15) return Long.toString((long) d);
            return BigDecimal.valueOf(Math.round(d * 1e6) / 1e6).stripTrailingZeros().toPlainString();
        }
        if (v instanceof Number) return v.toString();
        if (v instanceof Boolean) return (Boolean) v ? "true" : "false";
        if (v instanceof String) return (String) v;
        if (v instanceof JSONArray) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < ((JSONArray) v).length(); i++) { if (i > 0) sb.append(", "); sb.append(toText(((JSONArray) v).opt(i))); }
            return sb.toString();
        }
        if (v instanceof List) {
            StringBuilder sb = new StringBuilder();
            for (Object x : (List<?>) v) { if (sb.length() > 0) sb.append(", "); sb.append(toText(x)); }
            return sb.toString();
        }
        return "";
    }

    /* -------------------------------------------------------- templates */

    static final class Part { final String lit; final Node expr; final List<String[]> filters; Part(String lit, Node expr, List<String[]> f) { this.lit = lit; this.expr = expr; this.filters = f; } }

    private static final String[] FILTERS = {"upper", "lower", "trim", "truncate", "default", "count", "date", "time", "datetime", "size"};
    private static final java.util.regex.Pattern FILTER = java.util.regex.Pattern.compile("^\\s*([a-z]+)(?::\\s*(?:'([^']*)'|\"([^\"]*)\"|(-?\\d+)))?\\s*$");
    private static final java.util.regex.Pattern HEAD = java.util.regex.Pattern.compile("^\\$[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*|\\.\\d+)*$");

    static List<String[]> parseFilters(String chain) {
        List<String[]> out = new ArrayList<>();
        String[] raw = chain.split("\\|", -1);
        for (int i = 1; i < raw.length; i++) {
            java.util.regex.Matcher m = FILTER.matcher(raw[i]);
            if (!m.matches() || java.util.Arrays.asList(FILTERS).indexOf(m.group(1)) < 0) throw new IllegalArgumentException("unknown filter \"" + raw[i].trim() + "\"");
            String arg = m.group(2) != null ? m.group(2) : m.group(3) != null ? m.group(3) : m.group(4);
            out.add(new String[]{m.group(1), arg});
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    static List<Part> parseTemplate(String src) {
        Object cached = CACHE.get("t:" + src);
        if (cached instanceof List) return (List<Part>) cached;
        List<Part> parts = new ArrayList<>();
        StringBuilder lit = new StringBuilder();
        int i = 0;
        while (i < src.length()) {
            char c = src.charAt(i);
            if (c == '{' && i + 1 < src.length() && src.charAt(i + 1) == '{') { lit.append('{'); i += 2; continue; }
            if (c != '{') { lit.append(c); i++; continue; }
            int end = src.indexOf('}', i);
            if (end < 0) throw new IllegalArgumentException("unclosed \"{\" at " + i);
            String body = src.substring(i + 1, end).trim();
            if (lit.length() > 0) { parts.add(new Part(lit.toString(), null, null)); lit.setLength(0); }
            if (body.startsWith("_'") || body.startsWith("_\"")) {
                char q = body.charAt(1);
                int close = body.indexOf(q, 2);
                if (close < 0) throw new IllegalArgumentException("unclosed translation at " + i);
                parts.add(new Part(null, new Tr(body.substring(2, close)), parseFilters(body.substring(close + 1))));
            } else if (body.startsWith("=")) {
                parts.add(new Part(null, parse(body.substring(1)), new ArrayList<>()));
            } else if (body.startsWith("$")) {
                int bar = body.indexOf('|');
                String head = (bar < 0 ? body : body.substring(0, bar)).trim();
                if (!HEAD.matcher(head).matches()) throw new IllegalArgumentException("bad placeholder \"{" + body + "}\"");
                parts.add(new Part(null, parse(head.replaceAll("\\.(\\d+)", "[$1]")), bar < 0 ? new ArrayList<>() : parseFilters(body.substring(bar))));
            } else {
                throw new IllegalArgumentException("bad placeholder \"{" + body + "}\" (use {$var}, {_'key'} or {=expression})");
            }
            i = end + 1;
        }
        if (lit.length() > 0) parts.add(new Part(lit.toString(), null, null));
        CACHE.put("t:" + src, parts);
        return parts;
    }

    public static String render(String src, Scope scope, Translate tr) {
        if (src == null) return "";
        if (src.indexOf('{') < 0) return src;
        StringBuilder out = new StringBuilder();
        for (Part p : parseTemplate(src)) {
            if (p.lit != null) { out.append(p.lit); continue; }
            Object v = p.expr.eval(scope, tr);
            for (String[] f : p.filters) v = filter(v, f[0], f[1]);
            out.append(toText(v));
        }
        return out.toString();
    }

    public static String checkTemplate(String src) {
        try { parseTemplate(src); return null; } catch (IllegalArgumentException e) { return e.getMessage(); }
    }

    /**
     * 6.10 (security analysis G-20): whether a prop or an action's argument
     * reads data — an "=expression" or a template whose placeholder names a
     * variable ($msg, $form, $log…, also inside a translation's expression).
     * Literals and translations ({_'key'}) are the design's own text. What
     * cannot be parsed counts as reading data (fail closed).
     */
    public static boolean readsData(String src) {
        if (src == null) return false;
        try {
            if (src.startsWith("=")) return reads(parse(src.substring(1)));
            if (src.indexOf('{') < 0) return false;
            for (Part p : parseTemplate(src)) if (p.expr != null && reads(p.expr)) return true;
            return false;
        } catch (IllegalArgumentException e) {
            return true;
        }
    }

    static boolean reads(Node n) {
        if (n instanceof Lit || n instanceof Tr) return false;
        if (n instanceof Get) return reads(((Get) n).obj) || reads(((Get) n).key);
        if (n instanceof Un) return reads(((Un) n).a);
        if (n instanceof And) return reads(((And) n).a) || reads(((And) n).b);
        if (n instanceof If) return reads(((If) n).c) || reads(((If) n).a) || reads(((If) n).b);
        if (n instanceof Bin) return reads(((Bin) n).a) || reads(((Bin) n).b);
        return true; // a variable — or a node this check does not know
    }

    /** A prop or style value: "=expression" → its value, anything else → the rendered template. */
    public static Object value(String src, Scope scope, Translate tr) {
        if (src == null) return null;
        if (src.startsWith("=")) return eval(src.substring(1), scope, tr);
        return render(src, scope, tr);
    }

    private static String pad2(int n) { return n < 10 ? "0" + n : String.valueOf(n); }

    static Object filter(Object v, String name, String arg) {
        switch (name) {
            case "upper": return toText(v).toUpperCase(Locale.ROOT);
            case "lower": return toText(v).toLowerCase(Locale.ROOT);
            case "trim": return toText(v).trim();
            case "truncate": {
                int n = Math.max(1, arg == null ? 40 : Integer.parseInt(arg));
                String s = toText(v);
                return s.length() > n ? s.substring(0, n - 1) + "…" : s;
            }
            case "default": return truthy(v) ? v : (arg == null ? "" : arg);
            case "count": {
                Object x = norm(v);
                if (x instanceof JSONArray) return (double) ((JSONArray) x).length();
                if (x instanceof List) return (double) ((List<?>) x).size();
                if (x instanceof String) return (double) ((String) x).length();
                return 0.0;
            }
            case "date": case "time": case "datetime": {
                Object x = norm(v);
                if (!(x instanceof Number)) return "";
                Calendar c = Calendar.getInstance();
                c.setTimeInMillis(((Number) x).longValue());
                String date = c.get(Calendar.DAY_OF_MONTH) + ". " + (c.get(Calendar.MONTH) + 1) + ". " + c.get(Calendar.YEAR);
                String time = pad2(c.get(Calendar.HOUR_OF_DAY)) + ":" + pad2(c.get(Calendar.MINUTE));
                return name.equals("date") ? date : name.equals("time") ? time : date + " " + time;
            }
            case "size": {
                double n = num(v);
                if (n < 1024) return toText(n) + " B";
                if (n < 1024 * 1024) return toText(Math.round(n / 102.4) / 10.0) + " kB";
                if (n < 1024.0 * 1024 * 1024) return toText(Math.round(n / 104857.6) / 10.0) + " MB";
                return toText(Math.round(n / 107374182.4) / 10.0) + " GB";
            }
            default: return v;
        }
    }
}
