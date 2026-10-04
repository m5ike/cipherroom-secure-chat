package cz.m5cet.app.fn;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * A function's HTML output (6.6: m5.out.html) made safe — a port of
 * client/src/lib/fn-html.ts, the one parser the server, the web chat and this
 * app share. It keeps document markup only: headings, paragraphs, lists,
 * tables, details, figures, links to http(s) / mailto, and pictures that are
 * data: URIs of an image type. Scripts, styles, forms, frames, media, event
 * handlers and every other attribute are dropped; class keeps only the report
 * classes (m5h-…), style only harmless properties without url().
 *
 * The web matches tags with sticky regular expressions; here the same
 * grammar is read by hand, character by character (the same UTF-16 units,
 * JavaScript's white space, ASCII-only case folding): linear in time, no
 * recursion, and the same on the JVM and on Android, whose regular
 * expressions are ICU's. The result is byte-identical to sanitizeFnHtml().
 */
public final class FnHtml {
    private FnHtml() {}

    /** FN_HTML_MAX: the longest HTML an output may carry (characters). */
    public static final int MAX = 2_000_000;
    private static final int MAX_NODES = 20_000;
    private static final int MAX_DEPTH = 48;

    private static Set<String> set(String... s) { return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(s))); }

    static final Set<String> ALLOWED = set(
        "div", "span", "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "small", "mark", "code", "kbd", "samp", "var", "pre", "sub", "sup", "abbr", "time", "q", "cite", "del", "ins",
        "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "section", "article", "header", "footer", "aside", "figure", "figcaption",
        "details", "summary", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col", "a", "img");
    static final Set<String> VOID = set("br", "hr", "img", "col", "wbr");
    /** Dropped with everything inside them. */
    static final Set<String> DROP = set("script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "textarea", "select", "option", "form", "input", "button",
        "link", "meta", "base", "frame", "frameset", "audio", "video", "source", "track", "canvas", "title", "head", "dialog", "portal", "applet");
    private static final Set<String> GLOBAL = set("class", "style", "title", "lang", "dir");
    private static final Map<String, Set<String>> TAG_ATTRS = new HashMap<>();
    static {
        TAG_ATTRS.put("a", set("href"));
        TAG_ATTRS.put("img", set("src", "alt", "width", "height"));
        TAG_ATTRS.put("td", set("colspan", "rowspan"));
        TAG_ATTRS.put("th", set("colspan", "rowspan", "scope"));
        TAG_ATTRS.put("col", set("span"));
        TAG_ATTRS.put("colgroup", set("span"));
        TAG_ATTRS.put("ol", set("start", "reversed"));
        TAG_ATTRS.put("time", set("datetime"));
        TAG_ATTRS.put("details", set("open"));
    }
    private static final Set<String> STYLE_PROPS = set(
        "color", "background-color", "font-size", "font-weight", "font-style", "font-family", "text-align", "text-decoration", "text-transform", "letter-spacing",
        "line-height", "white-space", "word-break", "vertical-align", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding", "padding-top",
        "padding-right", "padding-bottom", "padding-left", "border", "border-top", "border-bottom", "border-left", "border-right", "border-color", "border-width",
        "border-style", "border-radius", "border-collapse", "display", "gap", "align-items", "justify-content", "flex", "flex-wrap", "flex-direction", "width", "max-width",
        "min-width", "height", "max-height", "min-height", "opacity", "overflow", "overflow-x", "text-overflow");
    private static final Set<String> DISPLAY = set("inline", "inline-block", "block", "flex", "inline-flex", "grid", "table", "table-row", "table-cell", "none");
    private static final Set<String> NUMERIC = set("width", "height", "colspan", "rowspan", "span", "start");
    private static final Set<String> SCOPE = set("row", "col", "rowgroup", "colgroup");
    private static final Set<String> BLOCKS = set("p", "div", "section", "article", "header", "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "dt", "dd", "pre",
        "blockquote", "figure", "figcaption", "details", "summary", "table", "caption");
    private static final List<String> IMAGE_TYPES = Arrays.asList("png", "jpeg", "gif", "webp", "bmp");
    private static final Map<String, String> ENTITIES = new HashMap<>();
    static {
        String[] e = { "amp", "&", "lt", "<", "gt", ">", "quot", "\"", "apos", "'", "nbsp", "\u00A0", "middot", "·", "bull", "•", "ndash", "–", "mdash", "—",
            "hellip", "…", "times", "×", "euro", "€", "copy", "©", "deg", "°" };
        for (int i = 0; i < e.length; i += 2) ENTITIES.put(e[i], e[i + 1]);
    }

    /* -------------------------------------------------------------- tree */

    /** One node of the safe tree: an element (tag, attributes in order, children) or a text (tag null). */
    public static final class SafeNode {
        /** The element's name (lower case); null for a text. */
        public final String tag;
        /** The kept attributes, in the order the source first gave them. */
        public final Map<String, String> attrs;
        public final List<SafeNode> children;
        private StringBuilder buf;
        private String text;

        private SafeNode(String tag) {
            this.tag = tag;
            this.attrs = new LinkedHashMap<>();
            this.children = new ArrayList<>();
        }

        private SafeNode(StringBuilder buf) {
            this.tag = null;
            this.attrs = Collections.emptyMap();
            this.children = Collections.emptyList();
            this.buf = buf;
        }

        public boolean isText() { return tag == null; }

        /** A text node's characters ("" for an element). */
        public String text() {
            if (tag != null) return "";
            if (text == null) { text = buf.toString(); buf = null; }
            return text;
        }
    }

    /* ---------------------------------------------------------- entities */

    private static boolean letter(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
    private static boolean digit(char c) { return c >= '0' && c <= '9'; }
    private static boolean hex(char c) { return digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }

    /** decodeHtmlEntities(): &name; (the few above), &#n; and &#xh; — anything else stays as it is. */
    static String decodeEntities(String s) {
        int amp = s.indexOf('&');
        if (amp < 0) return s;
        StringBuilder out = new StringBuilder(s.length());
        out.append(s, 0, amp);
        int n = s.length();
        int i = amp;
        while (i < n) {
            char c = s.charAt(i);
            if (c != '&') { out.append(c); i++; continue; }
            int end = entityEnd(s, i);
            if (end < 0) { out.append('&'); i++; continue; }
            String e = s.substring(i + 1, end - 1);
            if (e.charAt(0) == '#') {
                boolean x = e.charAt(1) == 'x' || e.charAt(1) == 'X';
                int code = Integer.parseInt(e.substring(x ? 2 : 1), x ? 16 : 10);
                if (code > 0 && code < 0x110000 && !(code >= 0xD800 && code < 0xE000)) out.appendCodePoint(code);
            } else {
                String v = ENTITIES.get(e.toLowerCase(Locale.ROOT));
                out.append(v != null ? v : s, v != null ? 0 : i, v != null ? v.length() : end);
            }
            i = end;
        }
        return out.toString();
    }

    /** Where /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/i matching at i ends (after the ";"), or -1. */
    private static int entityEnd(String s, int i) {
        int n = s.length();
        int j = i + 1;
        if (j >= n) return -1;
        int start, max, k;
        if (s.charAt(j) == '#') {
            if (j + 1 < n && (s.charAt(j + 1) == 'x' || s.charAt(j + 1) == 'X')) {
                start = k = j + 2;
                max = 6;
                while (k < n && hex(s.charAt(k))) k++;
                if (k - start < 1) return -1;
            } else {
                start = k = j + 1;
                max = 7;
                while (k < n && digit(s.charAt(k))) k++;
                if (k - start < 1) return -1;
            }
        } else {
            start = k = j;
            max = 8;
            while (k < n && letter(s.charAt(k))) k++;
            if (k - start < 2) return -1;
        }
        // The run is followed by ";" only when it is whole: a longer one cannot match.
        if (k - start > max || k >= n || s.charAt(k) != ';') return -1;
        return k + 1;
    }

    /* ---------------------------------------------------------- attributes */

    /** A name character of the tag grammar: [^\s"'<>/=]. */
    private static boolean nameChar(char c) { return !Js.isWs(c) && c != '"' && c != '\'' && c != '<' && c != '>' && c != '/' && c != '='; }

    /** An unquoted value's character: [^\s"'=<>`]. */
    private static boolean valueChar(char c) { return !Js.isWs(c) && c != '"' && c != '\'' && c != '=' && c != '<' && c != '>' && c != '`'; }

    /** s with A–Z as a–z (what a JavaScript /i pattern without u folds). */
    private static String asciiLower(String s) {
        char[] a = null;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 'A' && c <= 'Z') { if (a == null) a = s.toCharArray(); a[i] = (char) (c + 32); }
        }
        return a == null ? s : new String(a);
    }

    /** /word\s*\(/ somewhere in s (lower case). */
    private static boolean call(String s, String word) {
        for (int i = s.indexOf(word); i >= 0; i = s.indexOf(word, i + 1)) {
            int j = i + word.length();
            while (j < s.length() && Js.isWs(s.charAt(j))) j++;
            if (j < s.length() && s.charAt(j) == '(') return true;
        }
        return false;
    }

    /** /url\s*\(|expression|javascript:|@import|\\|[<>{}]|behavior|var\s*\(|attr\s*\(/i. */
    private static boolean dangerous(String value) {
        String v = asciiLower(value);
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '\\' || c == '<' || c == '>' || c == '{' || c == '}') return true;
        }
        return v.contains("expression") || v.contains("javascript:") || v.contains("@import") || v.contains("behavior")
            || call(v, "url") || call(v, "var") || call(v, "attr");
    }

    /** safeStyle(): only harmless properties, no url() and the like. */
    static String safeStyle(String style) {
        StringBuilder out = new StringBuilder();
        for (String decl : style.split(";", -1)) {
            int i = decl.indexOf(':');
            if (i < 0) continue;
            String prop = Js.trim(decl.substring(0, i)).toLowerCase(Locale.ROOT);
            String value = Js.trim(decl.substring(i + 1));
            if (!STYLE_PROPS.contains(prop) || value.isEmpty() || value.length() > 160) continue;
            if (dangerous(value)) continue;
            if (prop.equals("display") && !DISPLAY.contains(value)) continue;
            if (out.length() > 0) out.append("; ");
            out.append(prop).append(": ").append(value);
        }
        return out.toString();
    }

    /** At least one character, none of them \s " ' < >. */
    private static boolean urlRest(String s, int from) {
        if (from >= s.length()) return false;
        for (int i = from; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Js.isWs(c) || c == '"' || c == '\'' || c == '<' || c == '>') return false;
        }
        return true;
    }

    /** safeHref(): http(s):// or mailto: and no spaces, quotes or angle brackets; null otherwise. */
    static String safeHref(String v) {
        String s = Js.trim(v);
        String head = asciiLower(s.length() > 8 ? s.substring(0, 8) : s);
        boolean ok = head.startsWith("https://") ? urlRest(s, 8)
            : head.startsWith("http://") ? urlRest(s, 7)
            : head.startsWith("mailto:") && urlRest(s, 7);
        return ok ? s : null;
    }

    /** /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/. */
    static boolean imageSrc(String v) {
        if (!v.startsWith("data:image/")) return false;
        int semi = v.indexOf(';', 11);
        if (semi < 0 || !IMAGE_TYPES.contains(v.substring(11, semi)) || !v.startsWith(";base64,", semi)) return false;
        int i = semi + 8, start = i, n = v.length();
        while (i < n) {
            char c = v.charAt(i);
            if (!(letter(c) || digit(c) || c == '+' || c == '/')) break;
            i++;
        }
        if (i == start) return false;
        int pad = n - i;
        if (pad > 2) return false;
        for (; i < n; i++) if (v.charAt(i) != '=') return false;
        return true;
    }

    /** s without JavaScript's white space (.replace(/\s+/g, "")). */
    private static String noSpace(String s) {
        StringBuilder sb = null;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Js.isWs(c)) { if (sb == null) sb = new StringBuilder(s.length()).append(s, 0, i); }
            else if (sb != null) sb.append(c);
        }
        return sb == null ? s : sb.toString();
    }

    /**
     * Number(v) for a numeric attribute (exact for what is kept: an integer
     * up to 4000). A huge 0x/0o/0b number is infinity here — out of range
     * either way — so no big number is ever built from a long value.
     */
    static double attrNumber(String v) {
        String t = Js.trim(v);
        int n = t.length();
        if (n == 0) return 0;
        if (t.equals("Infinity") || t.equals("+Infinity")) return Double.POSITIVE_INFINITY;
        if (t.equals("-Infinity")) return Double.NEGATIVE_INFINITY;
        if (n > 2 && t.charAt(0) == '0' && "xXoObB".indexOf(t.charAt(1)) >= 0) {
            char r = Character.toLowerCase(t.charAt(1));
            int radix = r == 'x' ? 16 : r == 'o' ? 8 : 2;
            int i = 2;
            for (int k = 2; k < n; k++) if (Character.digit(t.charAt(k), radix) < 0 || t.charAt(k) > 'f') return Double.NaN;
            while (i < n - 1 && t.charAt(i) == '0') i++;
            if (n - i > 12) return Double.POSITIVE_INFINITY;
            return Long.parseLong(t.substring(i), radix);
        }
        // [+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?
        int i = 0;
        if (t.charAt(i) == '+' || t.charAt(i) == '-') i++;
        int intStart = i;
        while (i < n && digit(t.charAt(i))) i++;
        boolean intDigits = i > intStart;
        if (i < n && t.charAt(i) == '.') {
            i++;
            int fracStart = i;
            while (i < n && digit(t.charAt(i))) i++;
            if (!intDigits && i == fracStart) return Double.NaN;
        } else if (!intDigits) return Double.NaN;
        if (i < n && (t.charAt(i) == 'e' || t.charAt(i) == 'E')) {
            i++;
            if (i < n && (t.charAt(i) == '+' || t.charAt(i) == '-')) i++;
            int expStart = i;
            while (i < n && digit(t.charAt(i))) i++;
            if (i == expStart) return Double.NaN;
        }
        if (i != n) return Double.NaN;
        return Double.parseDouble(t);
    }

    /** The class tokens kept: m5h-… only, at most 8. */
    private static String classes(String value) {
        StringBuilder out = new StringBuilder();
        int kept = 0, i = 0, n = value.length();
        while (i < n && kept < 8) {
            while (i < n && Js.isWs(value.charAt(i))) i++;
            int start = i;
            while (i < n && !Js.isWs(value.charAt(i))) i++;
            if (i > start && reportClass(value, start, i)) {
                if (kept++ > 0) out.append(' ');
                out.append(value, start, i);
            }
        }
        return out.toString();
    }

    /** /^m5h-[a-z0-9-]{1,40}$/. */
    private static boolean reportClass(String s, int start, int end) {
        if (!s.startsWith("m5h-", start) || end - start - 4 < 1 || end - start - 4 > 40) return false;
        for (int i = start + 4; i < end; i++) {
            char c = s.charAt(i);
            if (!((c >= 'a' && c <= 'z') || digit(c) || c == '-')) return false;
        }
        return true;
    }

    /* -------------------------------------------------------------- tags */

    /** An open tag as /<([a-zA-Z][a-zA-Z0-9]*)(attributes)\s*(\/?)>/y matches it. */
    private static final class OpenTag {
        String name;
        /** name, raw value ("" when it has none) — in the order written. */
        final List<String[]> attrs = new ArrayList<>();
        boolean selfClosing;
        int end;
    }

    /**
     * The open tag at lt, or null. The web's sticky pattern has a single way
     * to match: names and values are delimited by white space, quotes, "=",
     * "/" and ">", so the greedy reading below is the only one that can end
     * in ">" — and where it fails, no shorter reading succeeds either.
     */
    private static OpenTag openTag(String s, int lt) {
        int n = s.length();
        int p = lt + 1;
        if (p >= n || !letter(s.charAt(p))) return null;
        int nameEnd = p + 1;
        while (nameEnd < n && (letter(s.charAt(nameEnd)) || digit(s.charAt(nameEnd)))) nameEnd++;
        OpenTag t = new OpenTag();
        t.name = s.substring(p, nameEnd);
        p = nameEnd;
        while (true) {
            int w = p;
            while (w < n && Js.isWs(s.charAt(w))) w++;
            if (w == p || w >= n || !nameChar(s.charAt(w))) break;
            int r = w;
            while (r < n && nameChar(s.charAt(r))) r++;
            String name = s.substring(w, r);
            int v = r;
            while (v < n && Js.isWs(s.charAt(v))) v++;
            if (v < n && s.charAt(v) == '=') {
                v++;
                while (v < n && Js.isWs(s.charAt(v))) v++;
                if (v >= n) return null;
                char q = s.charAt(v);
                if (q == '"' || q == '\'') {
                    int close = s.indexOf(q, v + 1);
                    if (close < 0) return null;
                    t.attrs.add(new String[] { name, s.substring(v + 1, close) });
                    p = close + 1;
                } else {
                    if (!valueChar(q)) return null;
                    int e = v;
                    while (e < n && valueChar(s.charAt(e))) e++;
                    t.attrs.add(new String[] { name, s.substring(v, e) });
                    p = e;
                }
                continue;
            }
            t.attrs.add(new String[] { name, "" });
            p = r;
        }
        int w = p;
        while (w < n && Js.isWs(s.charAt(w))) w++;
        if (w < n && s.charAt(w) == '>') { t.end = w + 1; return t; }
        if (w + 1 < n && s.charAt(w) == '/' && s.charAt(w + 1) == '>') { t.selfClosing = true; t.end = w + 2; return t; }
        return null;
    }

    /** /<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/y at lt: the end of the tag, the name in name[0]; -1 when it is not one. */
    private static int closeTag(String s, int lt, String[] name) {
        int n = s.length();
        int p = lt + 2;
        if (p >= n || !letter(s.charAt(p))) return -1;
        int e = p + 1;
        while (e < n && (letter(s.charAt(e)) || digit(s.charAt(e)))) e++;
        int w = e;
        while (w < n && Js.isWs(s.charAt(w))) w++;
        if (w >= n || s.charAt(w) != '>') return -1;
        name[0] = s.substring(p, e);
        return w + 1;
    }

    /* -------------------------------------------------------------- parse */

    private static final class Parser {
        final SafeNode root = new SafeNode("#root");
        final List<SafeNode> stack = new ArrayList<>();
        int drop;
        String dropTag = "";
        int nodes;

        Parser() { stack.add(root); }

        SafeNode top() { return stack.get(stack.size() - 1); }

        void text(String s) {
            if (drop > 0 || s.isEmpty()) return;
            String d = decodeEntities(s);
            SafeNode p = top();
            SafeNode last = p.children.isEmpty() ? null : p.children.get(p.children.size() - 1);
            if (last != null && last.isText()) last.buf.append(d);
            else { p.children.add(new SafeNode(new StringBuilder(d))); nodes++; }
        }

        void open(OpenTag m) {
            String tag = m.name.toLowerCase(Locale.ROOT);
            if (drop > 0) { if (tag.equals(dropTag) && !VOID.contains(tag) && !m.selfClosing) drop++; return; }
            if (DROP.contains(tag)) { if (!m.selfClosing && !VOID.contains(tag)) { drop = 1; dropTag = tag; } return; }
            if (!ALLOWED.contains(tag)) return;
            SafeNode el = new SafeNode(tag);
            Map<String, String> attrs = el.attrs;
            Set<String> own = TAG_ATTRS.get(tag);
            for (String[] a : m.attrs) {
                String name = a[0].toLowerCase(Locale.ROOT);
                String value = decodeEntities(a[1]);
                if (name.startsWith("on") || (!GLOBAL.contains(name) && (own == null || !own.contains(name)))) continue;
                switch (name) {
                    case "class": { String cls = classes(value); if (!cls.isEmpty()) attrs.put("class", cls); continue; }
                    case "style": { String st = safeStyle(value); if (!st.isEmpty()) attrs.put("style", st); continue; }
                    case "href": { String u = safeHref(value); if (u != null) attrs.put("href", u); continue; }
                    case "src": { String v = noSpace(value); if (imageSrc(v)) attrs.put("src", v); continue; }
                    default: break;
                }
                if (NUMERIC.contains(name)) {
                    double d = attrNumber(value);
                    int max = name.equals("width") || name.equals("height") ? 4000 : 1000;
                    if (!Double.isNaN(d) && !Double.isInfinite(d) && d == Math.floor(d) && d >= 0 && d <= max) attrs.put(name, Long.toString((long) d));
                    continue;
                }
                if (name.equals("dir")) { if (value.equals("ltr") || value.equals("rtl") || value.equals("auto")) attrs.put("dir", value); continue; }
                if (name.equals("scope")) { if (SCOPE.contains(value)) attrs.put("scope", value); continue; }
                if (name.equals("open") || name.equals("reversed")) { attrs.put(name, ""); continue; }
                attrs.put(name, value.length() > 300 ? value.substring(0, 300) : value);
            }
            if (tag.equals("img") && !attrs.containsKey("src")) return; // no picture, no element
            top().children.add(el);
            nodes++;
            if (!VOID.contains(tag) && !m.selfClosing && stack.size() < MAX_DEPTH) stack.add(el);
        }

        void close(String name) {
            String tag = name.toLowerCase(Locale.ROOT);
            if (drop > 0) { if (tag.equals(dropTag) && --drop == 0) dropTag = ""; return; }
            for (int k = stack.size() - 1; k > 0; k--) {
                if (stack.get(k).tag.equals(tag)) { stack.subList(k, stack.size()).clear(); break; }
            }
        }

        List<SafeNode> run(String src) {
            int n = src.length();
            int i = 0;
            String[] closeName = new String[1];
            while (i < n && nodes < MAX_NODES) {
                int lt = src.indexOf('<', i);
                if (lt < 0) { text(src.substring(i)); break; }
                text(src.substring(i, lt));
                if (src.startsWith("<!--", lt)) { int end = src.indexOf("-->", lt + 4); i = end < 0 ? n : end + 3; continue; }
                if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) { int end = src.indexOf('>', lt); i = end < 0 ? n : end + 1; continue; }
                if (lt + 1 < n && src.charAt(lt + 1) == '/') {
                    int end = closeTag(src, lt, closeName);
                    if (end < 0) { text("<"); i = lt + 1; continue; }
                    i = end;
                    close(closeName[0]);
                    continue;
                }
                OpenTag m = openTag(src, lt);
                if (m == null) { text("<"); i = lt + 1; continue; }
                i = m.end;
                open(m);
            }
            freeze(root);
            return root.children;
        }

        /** The texts as strings (the tree is at most MAX_DEPTH deep). */
        private static void freeze(SafeNode n) {
            for (SafeNode c : n.children) { if (c.isText()) c.text(); else freeze(c); }
        }
    }

    /** parseFnHtml(): the safe tree of html (see the header). */
    public static List<SafeNode> parse(String html) {
        String src = html == null ? "" : html;
        if (src.length() > MAX) src = src.substring(0, MAX);
        return new Parser().run(src);
    }

    /* ---------------------------------------------------------- serialize */

    private static void esc(StringBuilder sb, String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&': sb.append("&amp;"); break;
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '"': sb.append("&quot;"); break;
                default: sb.append(c);
            }
        }
    }

    private static void serialize(StringBuilder sb, List<SafeNode> nodes) {
        for (SafeNode n : nodes) {
            if (n.isText()) { esc(sb, n.text()); continue; }
            sb.append('<').append(n.tag);
            for (Map.Entry<String, String> a : n.attrs.entrySet()) {
                String k = a.getKey(), v = a.getValue();
                sb.append(' ').append(k);
                if (!(v.isEmpty() && (k.equals("open") || k.equals("reversed")))) { sb.append("=\""); esc(sb, v); sb.append('"'); }
            }
            sb.append('>');
            if (VOID.contains(n.tag)) continue;
            serialize(sb, n.children);
            sb.append("</").append(n.tag).append('>');
        }
    }

    /** serializeFnHtml(): a safe tree back to HTML text. */
    public static String serialize(List<SafeNode> nodes) {
        StringBuilder sb = new StringBuilder();
        serialize(sb, nodes);
        return sb.toString();
    }

    /** sanitizeFnHtml(): parse, keep what is safe, serialize. */
    public static String sanitize(String html) { return serialize(parse(html)); }

    /* --------------------------------------------------------------- text */

    private static void walk(StringBuilder sb, List<SafeNode> nodes) {
        for (SafeNode n : nodes) {
            if (n.isText()) { sb.append(n.text()); continue; }
            switch (n.tag) {
                case "br": sb.append('\n'); continue;
                case "img": { String alt = n.attrs.get("alt"); if (alt != null && !alt.isEmpty()) sb.append('[').append(alt).append(']'); continue; }
                case "td": case "th": walk(sb, n.children); sb.append('\t'); continue;
                default:
                    if (BLOCKS.contains(n.tag)) { sb.append('\n'); walk(sb, n.children); sb.append('\n'); }
                    else walk(sb, n.children);
            }
        }
    }

    /** fnHtmlText(): the text of a safe tree (search, forwarding, older apps). */
    public static String text(List<SafeNode> nodes) {
        StringBuilder raw = new StringBuilder();
        walk(raw, nodes);
        // .replace(/[ \t]+\n/g, "\n")
        StringBuilder a = new StringBuilder(raw.length());
        for (int i = 0, n = raw.length(); i < n; ) {
            char c = raw.charAt(i);
            if (c == ' ' || c == '\t') {
                int j = i;
                while (j < n && (raw.charAt(j) == ' ' || raw.charAt(j) == '\t')) j++;
                if (j < n && raw.charAt(j) == '\n') { a.append('\n'); i = j + 1; }
                else { a.append(raw, i, j); i = j; }
                continue;
            }
            a.append(c);
            i++;
        }
        // .replace(/\n{3,}/g, "\n\n")
        StringBuilder b = new StringBuilder(a.length());
        for (int i = 0, n = a.length(); i < n; ) {
            if (a.charAt(i) == '\n') {
                int j = i;
                while (j < n && a.charAt(j) == '\n') j++;
                if (j - i >= 3) b.append("\n\n"); else b.append(a, i, j);
                i = j;
                continue;
            }
            b.append(a.charAt(i));
            i++;
        }
        return Js.trim(b.toString());
    }
}
