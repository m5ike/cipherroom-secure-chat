package cz.m5cet.app.fn;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What typing a trigger character offers in the message box —
 * composerSuggestions() in App.tsx: "/" commands at the start of the text,
 * "@" the people in the room and "#" tags at the start of a word (the
 * characters are the operator's). Up to 8 items, each with the text it leaves
 * when picked.
 */
public final class Suggestions {
    private Suggestions() {}

    public static final int MAX = 8;

    /** One suggestion. A disabled one is a notice (key "off": commands are off; "none": no command fits). */
    public static final class Item {
        public final String key;
        /** "/keyword", "@name", "#tag" ("" for a notice: say it by its key). */
        public final String label;
        /** A command's summary (or name). */
        public final String detail;
        /** A command's inputs: "domain [port]". */
        public final String extra;
        public final boolean disabled;
        /** The message box's text and cursor once this is picked (null for a notice). */
        public final String text;
        public final int cursor;

        Item(String key, String label, String detail, String extra, boolean disabled, String text, int cursor) {
            this.key = key;
            this.label = label;
            this.detail = detail;
            this.extra = extra;
            this.disabled = disabled;
            this.text = text;
            this.cursor = cursor;
        }
    }

    public static final class Result {
        /** "functions", "mentions" or "tags" (what the list's title says). */
        public final String kind;
        public final List<Item> items;
        Result(String kind, List<Item> items) { this.kind = kind; this.items = items; }
    }

    private static final Pattern COMMAND_WORD = Pattern.compile("[a-z0-9_-]*", Pattern.CASE_INSENSITIVE);
    private static final Pattern WORD_END = Pattern.compile("(^|" + Js.S + ")(" + Js.NS + ")([\\p{L}\\p{N}_.-]*)\\z");
    private static final Pattern WORD_START = Pattern.compile("\\A[\\p{L}\\p{N}_.-]*");
    // The same as client/src/lib/linkify.tsx: a tag starts a word.
    private static final Pattern TAG = Pattern.compile("(?:^|[" + Js.WS_CHARS + "(])#([\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]{0,39})");

    /** tagsIn(): a message's #tags as the chat shows and filters them — lower case, no trailing "." or "-". */
    public static List<String> tagsIn(String text) {
        List<String> out = new ArrayList<>();
        if (text == null || text.indexOf('#') < 0) return out;
        Matcher m = TAG.matcher(text);
        while (m.find()) {
            String tag = m.group(1).replaceFirst("[.-]+$", "").toLowerCase(Locale.ROOT);
            if (!tag.isEmpty()) out.add(tag);
        }
        return out;
    }

    /**
     * The suggestions for the text before the cursor, or null.
     *
     * @param state  the commands (Commands.UNKNOWN before the server answered)
     * @param names  the people who may be mentioned (in the room, and away)
     * @param recent the texts of the room's messages (the last 300 are searched for tags)
     */
    public static Result suggest(String text, int cursor, Commands.Composer composer, Commands.State state, Collection<String> names, List<String> recent) {
        if (text == null || text.isEmpty()) return null;
        int at = Math.max(0, Math.min(cursor, text.length()));
        String input = text.substring(0, at);
        String tail = text.substring(at);
        if (input.isEmpty()) return null;
        String first = Js.firstCodePoint(input);
        if (composer.commandChars().contains(first)) {
            Matcher m = COMMAND_WORD.matcher(input.substring(first.length()));
            if (m.matches()) return commands(first, m.group().toLowerCase(Locale.ROOT), tail, state);
        }
        Matcher w = WORD_END.matcher(input);
        if (!w.find()) return null;
        String ch = w.group(2);
        Commands.Trigger trig = null;
        for (Commands.Trigger t : composer.triggers) if (t.ch.equals(ch) && !t.action.equals("functions")) { trig = t; break; }
        if (trig == null) return null;
        String q = w.group(3).toLowerCase(Locale.ROOT);
        String before = input.substring(0, input.length() - ch.length() - w.group(3).length());
        List<Item> items = new ArrayList<>();
        if (trig.action.equals("mentions")) {
            Set<String> unique = new LinkedHashSet<>();
            for (String n : names) if (n != null && !n.isEmpty()) unique.add(n.replaceAll(Js.S + "+", "_"));
            for (String n : unique) {
                if (items.size() >= MAX) break;
                if (n.toLowerCase(Locale.ROOT).startsWith(q)) items.add(pick(n, trig.ch + n, before + trig.ch + n, tail));
            }
            return items.isEmpty() ? null : new Result("mentions", items);
        }
        Set<String> seen = new LinkedHashSet<>(composer.tags);
        for (String t : recent.subList(Math.max(0, recent.size() - 300), recent.size())) seen.addAll(tagsIn(t));
        for (String tag : seen) {
            if (items.size() >= MAX) break;
            if (tag.startsWith(q) && !tag.equals(q)) items.add(pick(tag, trig.ch + tag, before + trig.ch + tag, tail));
        }
        return items.isEmpty() ? null : new Result("tags", items);
    }

    private static Result commands(String ch, String q, String tail, Commands.State state) {
        if (Boolean.FALSE.equals(state.enabled)) return notice("off");
        List<Item> items = new ArrayList<>();
        for (Command c : state.commands) {
            if (items.size() >= MAX) break;
            if (!c.keyword.startsWith(q)) continue;
            List<String> extra = new ArrayList<>();
            for (Command.Input i : c.inputs) extra.add(i.required ? i.name : "[" + i.name + "]");
            Item p = pick(c.keyword, ch + c.keyword, ch + c.keyword, tail);
            items.add(new Item(c.keyword, p.label, c.summary.isEmpty() ? c.name : c.summary, String.join(" ", extra), false, p.text, p.cursor));
        }
        if (!items.isEmpty()) return new Result("functions", items);
        return !q.isEmpty() || state.enabled == null ? null : notice("none");
    }

    private static Result notice(String key) {
        List<Item> items = new ArrayList<>();
        items.add(new Item(key, "", "", "", true, null, 0));
        return new Result("functions", items);
    }

    /**
     * Picking replaces the word being typed with "<token> " — the rest of that
     * word after the cursor goes too, and a space already there is not doubled.
     */
    private static Item pick(String key, String label, String replaced, String tail) {
        Matcher rest = WORD_START.matcher(tail);
        String after = rest.find() ? tail.substring(rest.end()) : tail;
        if (!after.isEmpty() && Js.isWs(after.charAt(0))) after = after.substring(1);
        String head = replaced + " ";
        return new Item(key, label, "", "", false, head + after, head.length());
    }
}
