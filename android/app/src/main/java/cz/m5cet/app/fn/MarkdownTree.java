package cz.m5cet.app.fn;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Markdown as AI answers and functions write it — a port of
 * client/src/lib/markdown.ts: paragraphs, headings, lists (nested), code
 * blocks, quotes, rules, tables; inline code, bold, italic, strike-through,
 * links and bare web addresses. A tree, never markup; links keep only
 * https / http / mailto. Half-written input (a stream) parses too.
 */
public final class MarkdownTree {
    private MarkdownTree() {}

    static final int MAX_INPUT = 200_000;
    static final int MAX_DEPTH = 4;

    /** An inline node: t is text, code (v), strong, em, del (c), link (href, c) or br. */
    public static final class Inline {
        public final String t;
        public final String v;
        public final String href;
        public final List<Inline> c;

        Inline(String t, String v, String href, List<Inline> c) { this.t = t; this.v = v; this.href = href; this.c = c; }

        static Inline text(String v) { return new Inline("text", v, null, Collections.emptyList()); }

        @Override public String toString() {
            switch (t) {
                case "text": case "code": return t + "(" + v + ")";
                case "br": return "br";
                case "link": return "link(" + href + ")" + c;
                default: return t + c;
            }
        }
    }

    /**
     * A block: t is p or h (level, inline), code (lang, v), quote (blocks), hr,
     * list (ordered, start, items) or table (head, rows).
     */
    public static final class Block {
        public final String t;
        public int level;
        public String lang = "";
        public String v = "";
        public List<Inline> inline = Collections.emptyList();
        public List<Block> blocks = Collections.emptyList();
        public boolean ordered;
        public int start = 1;
        public List<List<Block>> items = Collections.emptyList();
        public List<List<Inline>> head = Collections.emptyList();
        public List<List<List<Inline>>> rows = Collections.emptyList();

        Block(String t) { this.t = t; }

        @Override public String toString() {
            switch (t) {
                case "p": return "p" + inline;
                case "h": return "h" + level + inline;
                case "code": return "code(" + lang + ")(" + v + ")";
                case "quote": return "quote" + blocks;
                case "list": return (ordered ? "ol" + start : "ul") + items;
                case "table": return "table" + head + rows;
                default: return t;
            }
        }
    }

    private static final Pattern HREF = Pattern.compile("https?://[^" + Js.WS_CHARS + "<>\"]+", Pattern.CASE_INSENSITIVE);
    private static final Pattern MAILTO = Pattern.compile("mailto:[^" + Js.WS_CHARS + "<>\"]+", Pattern.CASE_INSENSITIVE);

    /** safeHref(): a link that may be followed, or null. */
    public static String safeHref(String raw) {
        String v = Js.trim(raw);
        return HREF.matcher(v).matches() || MAILTO.matcher(v).matches() ? v : null;
    }

    /* ------------------------------------------------------------- inline */

    private static final String ESCAPABLE = "\\`*_~[]()#>!|-";
    private static final Pattern CODE = Pattern.compile("(`+)([\\s\\S]*?[^`])\\1(?!`)");
    private static final Pattern STRONG = Pattern.compile("(\\*\\*|__)(?=" + Js.NS + ")([\\s\\S]*?" + Js.NS + ")\\1");
    private static final Pattern DEL = Pattern.compile("~~(?=" + Js.NS + ")([\\s\\S]*?" + Js.NS + ")~~");
    private static final Pattern EM_STAR = Pattern.compile("\\*(?=" + Js.NS + ")([^*]*?" + Js.NS + ")\\*(?!\\*)");
    private static final Pattern EM_UNDER = Pattern.compile("_(?=" + Js.NS + ")([^_]*?" + Js.NS + ")_(?!\\w)");
    private static final Pattern LINK = Pattern.compile("\\[([^\\]\\n]{1,500})\\]\\(" + Js.S + "*<?([^)" + Js.WS_CHARS + ">]{1,2000})>?(?:" + Js.S + "+\"[^\"]*\")?" + Js.S + "*\\)");
    private static final Pattern AUTO = Pattern.compile("<((?:https?://|mailto:)[^" + Js.WS_CHARS + "<>]+)>", Pattern.CASE_INSENSITIVE);
    private static final Pattern BARE = Pattern.compile("https?://[^" + Js.WS_CHARS + "<>\"]+", Pattern.CASE_INSENSITIVE);

    private static boolean isWord(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'; }

    /** Matches p at i (like /^…/ on src.slice(i)); null when it does not. */
    private static Matcher at(Pattern p, String src, int i) {
        Matcher m = p.matcher(src);
        m.region(i, src.length());
        return m.lookingAt() ? m : null;
    }

    public static List<Inline> parseInline(String src) { return parseInline(src, 0); }

    static List<Inline> parseInline(String src, int depth) {
        List<Inline> out = new ArrayList<>();
        StringBuilder text = new StringBuilder();
        int i = 0;
        while (i < src.length()) {
            char ch = src.charAt(i);
            // A backslash escapes the next punctuation.
            if (ch == '\\' && i + 1 < src.length() && ESCAPABLE.indexOf(src.charAt(i + 1)) >= 0) { text.append(src.charAt(i + 1)); i += 2; continue; }
            if (ch == '\n') { flush(out, text); out.add(new Inline("br", null, null, Collections.emptyList())); i++; continue; }
            Matcher m;
            if (ch == '`' && (m = at(CODE, src, i)) != null) {
                flush(out, text);
                String v = m.group(2);
                if (v.length() >= 2 && v.startsWith(" ") && v.endsWith(" ")) v = v.substring(1, v.length() - 1);
                out.add(new Inline("code", v, null, Collections.emptyList()));
                i = m.end();
                continue;
            }
            // (Each pattern starts with its own character: the checks of ch only spare the work.)
            if (depth < MAX_DEPTH) {
                boolean mark = ch == '*' || ch == '_';
                if (mark && (m = at(STRONG, src, i)) != null) { flush(out, text); out.add(new Inline("strong", null, null, parseInline(m.group(2), depth + 1))); i = m.end(); continue; }
                if (ch == '~' && (m = at(DEL, src, i)) != null) { flush(out, text); out.add(new Inline("del", null, null, parseInline(m.group(1), depth + 1))); i = m.end(); continue; }
                // _italic_ only at a word's edge (snake_case stays as it is).
                m = ch == '*' ? at(EM_STAR, src, i) : ch == '_' && (i == 0 || !isWord(src.charAt(i - 1))) ? at(EM_UNDER, src, i) : null;
                if (m != null) { flush(out, text); out.add(new Inline("em", null, null, parseInline(m.group(1), depth + 1))); i = m.end(); continue; }
                if (ch == '[' && (m = at(LINK, src, i)) != null) {
                    flush(out, text);
                    String href = safeHref(m.group(2));
                    List<Inline> label = parseInline(m.group(1), depth + 1);
                    if (href != null) out.add(new Inline("link", null, href, label)); else out.addAll(label);
                    i = m.end();
                    continue;
                }
            }
            if (ch == '<' && (m = at(AUTO, src, i)) != null) {
                flush(out, text);
                String href = safeHref(m.group(1));
                out.add(href != null ? new Inline("link", null, href, Collections.singletonList(Inline.text(m.group(1)))) : Inline.text(m.group()));
                i = m.end();
                continue;
            }
            if ((ch == 'h' || ch == 'H') && (i == 0 || !(isWord(src.charAt(i - 1)) || src.charAt(i - 1) == '/')) && (m = at(BARE, src, i)) != null) {
                // Trailing punctuation belongs to the sentence, not to the address.
                String url = m.group().replaceFirst("[.,;:!?'\"]+$", "");
                while (url.endsWith(")") && count(url, '(') < count(url, ')')) url = url.substring(0, url.length() - 1);
                flush(out, text);
                out.add(new Inline("link", null, url, Collections.singletonList(Inline.text(url))));
                i += url.length();
                continue;
            }
            text.append(ch);
            i++;
        }
        flush(out, text);
        return out;
    }

    private static int count(String s, char c) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) == c) n++;
        return n;
    }

    private static void flush(List<Inline> out, StringBuilder text) {
        if (text.length() > 0) { out.add(Inline.text(text.toString())); text.setLength(0); }
    }

    /* ------------------------------------------------------------- blocks */

    private static final Pattern FENCE = Pattern.compile(" {0,3}(`{3,}|~{3,})" + Js.S + "*([\\w+#.-]*)[^\\n]*");
    private static final Pattern HEADING = Pattern.compile(" {0,3}(#{1,6})" + Js.S + "+(.*?)" + Js.S + "*#*" + Js.S + "*");
    private static final Pattern QUOTE = Pattern.compile(" {0,3}>" + Js.S + "?(.*)");
    private static final Pattern BULLET = Pattern.compile("( {0,6})([-*+])" + Js.S + "+(.*)");
    private static final Pattern ORDERED = Pattern.compile("( {0,6})(\\d{1,9})[.)]" + Js.S + "+(.*)");

    private static Matcher full(Pattern p, String line) {
        Matcher m = p.matcher(line);
        return m.matches() ? m : null;
    }

    /** ^ {0,3}([-*_])(\s*\1){2,}\s*$ — written out (a regex with a repeated group recurses on long lines). */
    static boolean isRule(String line) {
        int i = 0;
        while (i < 3 && i < line.length() && line.charAt(i) == ' ') i++;
        if (i >= line.length() || "-*_".indexOf(line.charAt(i)) < 0) return false;
        char c = line.charAt(i);
        int marks = 0;
        for (int j = i + 1; j < line.length(); j++) {
            char x = line.charAt(j);
            if (x == c) marks++;
            else if (!Js.isWs(x)) return false;
        }
        return marks >= 2;
    }

    /** ^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$ — written out, likewise. */
    static boolean isTableSeparator(String line) {
        int n = line.length();
        int i = skipWs(line, 0);
        if (i < n && line.charAt(i) == '|') i++;
        while (true) {
            i = skipWs(line, i);
            if (i < n && line.charAt(i) == ':') i++;
            int dashes = i;
            while (i < n && line.charAt(i) == '-') i++;
            if (i == dashes) return false;
            if (i < n && line.charAt(i) == ':') i++;
            i = skipWs(line, i);
            if (i == n) return true;
            if (line.charAt(i) != '|') return false;
            i++;
            if (skipWs(line, i) == n) return true;
        }
    }

    private static int skipWs(String s, int i) {
        while (i < s.length() && Js.isWs(s.charAt(i))) i++;
        return i;
    }

    private static boolean blank(String s) { return Js.trim(s).isEmpty(); }

    /** ^\s{min,max} as a count of leading white space. */
    private static int leadingWs(String s) { return skipWs(s, 0); }

    private static List<String> cells(String line) {
        String s = Js.trim(line);
        if (s.startsWith("|")) s = s.substring(1);
        if (s.endsWith("|") && !s.endsWith("\\|")) s = s.substring(0, s.length() - 1);
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == '\\' && i + 1 < s.length() && s.charAt(i + 1) == '|') { cur.append('|'); i++; continue; }
            if (s.charAt(i) == '|') { out.add(Js.trim(cur.toString())); cur.setLength(0); continue; }
            cur.append(s.charAt(i));
        }
        out.add(Js.trim(cur.toString()));
        return out;
    }

    private static boolean isBlockStart(String l) {
        return FENCE.matcher(l).matches() || HEADING.matcher(l).matches() || isRule(l) || QUOTE.matcher(l).matches() || BULLET.matcher(l).matches() || ORDERED.matcher(l).matches();
    }

    public static List<Block> parse(String input) { return parse(input, 0); }

    static List<Block> parse(String input, int depth) {
        String src = input.length() > MAX_INPUT ? input.substring(0, MAX_INPUT) : input;
        String[] lines = src.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        List<Block> blocks = new ArrayList<>();
        int i = 0;
        while (i < lines.length) {
            String line = lines[i];
            if (blank(line)) { i++; continue; }
            Matcher fence = full(FENCE, line);
            if (fence != null) {
                String marker = fence.group(1);
                Pattern close = Pattern.compile(" {0,3}" + (marker.charAt(0) == '`' ? "`" : "~") + "{" + marker.length() + ",}" + Js.S + "*");
                List<String> body = new ArrayList<>();
                i++;
                while (i < lines.length && !close.matcher(lines[i]).matches()) body.add(lines[i++]);
                i++; // the closing fence (or past the end)
                Block b = new Block("code");
                b.lang = fence.group(2).toLowerCase(java.util.Locale.ROOT);
                b.v = String.join("\n", body);
                blocks.add(b);
                continue;
            }
            Matcher heading = full(HEADING, line);
            if (heading != null) {
                Block b = new Block("h");
                b.level = heading.group(1).length();
                b.inline = parseInline(heading.group(2));
                blocks.add(b);
                i++;
                continue;
            }
            if (isRule(line)) { blocks.add(new Block("hr")); i++; continue; }
            if (QUOTE.matcher(line).matches() && depth < MAX_DEPTH) {
                List<String> inner = new ArrayList<>();
                while (i < lines.length) {
                    Matcher q = full(QUOTE, lines[i]);
                    if (q == null && (blank(lines[i]) || isBlockStart(lines[i]) || inner.isEmpty())) break;
                    inner.add(q != null ? q.group(1) : lines[i]);
                    i++;
                }
                Block b = new Block("quote");
                b.blocks = parse(String.join("\n", inner), depth + 1);
                blocks.add(b);
                continue;
            }
            Matcher bullet = full(BULLET, line);
            Matcher ordered = full(ORDERED, line);
            if ((bullet != null || ordered != null) && depth < MAX_DEPTH) {
                boolean isOrdered = ordered != null && bullet == null;
                int indent = (bullet != null ? bullet : ordered).group(1).length();
                List<List<String>> items = new ArrayList<>();
                while (i < lines.length) {
                    String l = lines[i];
                    Matcher b = full(BULLET, l);
                    Matcher o = full(ORDERED, l);
                    Matcher m = isOrdered ? o : b;
                    if (m != null && m.group(1).length() <= indent + 1) { List<String> it = new ArrayList<>(); it.add(m.group(3)); items.add(it); i++; continue; }
                    // A deeper item or a continuation line belongs to the last item.
                    if (!items.isEmpty() && !blank(l) && (leadingWs(l) >= 2 || (!isBlockStart(l) && b == null && o == null))) {
                        items.get(items.size() - 1).add(l.substring(Math.min(8, leadingWs(l))));
                        i++;
                        continue;
                    }
                    if (!items.isEmpty() && blank(l) && i + 1 < lines.length && leadingWs(lines[i + 1]) >= 2 && leadingWs(lines[i + 1]) < lines[i + 1].length()) {
                        items.get(items.size() - 1).add("");
                        i++;
                        continue;
                    }
                    break;
                }
                Block list = new Block("list");
                list.ordered = isOrdered;
                list.start = isOrdered ? Integer.parseInt(ordered.group(2)) : 1;
                list.items = new ArrayList<>();
                for (List<String> it : items) list.items.add(parse(String.join("\n", it), depth + 1));
                blocks.add(list);
                continue;
            }
            // A table: a row, then a delimiter row with pipes (a bare "---" under a line is a rule, not a table).
            if (line.contains("|") && i + 1 < lines.length && lines[i + 1].contains("|") && isTableSeparator(lines[i + 1])) {
                Block t = new Block("table");
                t.head = new ArrayList<>();
                for (String c : cells(line)) t.head.add(parseInline(c));
                i += 2;
                t.rows = new ArrayList<>();
                while (i < lines.length && lines[i].contains("|") && !blank(lines[i])) {
                    List<List<Inline>> row = new ArrayList<>();
                    for (String c : cells(lines[i])) row.add(parseInline(c));
                    t.rows.add(row);
                    i++;
                }
                blocks.add(t);
                continue;
            }
            List<String> para = new ArrayList<>();
            while (i < lines.length && !blank(lines[i]) && !(!para.isEmpty() && isBlockStart(lines[i]))) {
                if (para.isEmpty() && isBlockStart(lines[i])) break;
                para.add(lines[i].substring(Math.min(3, leadingWs(lines[i]))));
                i++;
            }
            if (para.isEmpty()) { para.add(lines[i]); i++; }
            Block p = new Block("p");
            p.inline = parseInline(String.join("\n", para));
            blocks.add(p);
        }
        return blocks;
    }
}
