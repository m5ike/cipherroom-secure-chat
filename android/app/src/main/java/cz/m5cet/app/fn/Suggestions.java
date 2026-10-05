package cz.m5cet.app.fn;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
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
 *
 * 6.11: matching is loose (Fuzzy: the keyword's start, a word in the name,
 * the summary, the letters in order; no case, no diacritics) and says where
 * it matched (to highlight); the commands this person uses (Usage) come
 * first ("recent"), then those whose keyword or name match ("commands"),
 * then those found only by their summary ("others"); a command's item has
 * its model's identity (icon, colour), name, summary, the arguments
 * (required or not) and who sees the answer.
 */
public final class Suggestions {
    private Suggestions() {}

    public static final int MAX = 8;
    /** At most this many used commands lead the list. */
    public static final int RECENT = 3;

    /** One argument of a command's signature. */
    public static final class Arg {
        public final String name;
        public final String type;
        /** Has to be given (&lt;name&gt;); else optional ([name]). */
        public final boolean required;
        Arg(Command.Input i) { name = i.name; type = i.type; required = i.mustGive(); }
    }

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
        /** 6.11: "recent", "commands", "others", "people", "tags" ("" for a notice). */
        public final String section;
        /** 6.11 a command's: its name, summary, who sees its answer ("room" / "caller"), its model's look, its arguments, its own guide. */
        public final String name, summary, visibility, guide;
        public final ModelIdentity model;
        public final List<Arg> args;
        /** 6.11: what matched, to highlight — [start, end) pairs in label, name and summary. */
        public final List<int[]> labelHits, nameHits, summaryHits;

        Item(String key, String label, String detail, String extra, boolean disabled, String text, int cursor) {
            this(key, label, detail, extra, disabled, text, cursor, "", null, null, NONE);
        }

        private Item(String key, String label, String detail, String extra, boolean disabled, String text, int cursor,
                     String section, Command c, ModelIdentity model, List<int[]> labelHits) {
            this(key, label, detail, extra, disabled, text, cursor, section, c, model, labelHits, NONE, NONE);
        }

        private Item(String key, String label, String detail, String extra, boolean disabled, String text, int cursor,
                     String section, Command c, ModelIdentity model, List<int[]> labelHits, List<int[]> nameHits, List<int[]> summaryHits) {
            this.key = key;
            this.label = label;
            this.detail = detail;
            this.extra = extra;
            this.disabled = disabled;
            this.text = text;
            this.cursor = cursor;
            this.section = section;
            this.name = c == null ? "" : c.name;
            this.summary = c == null ? "" : c.summary;
            this.visibility = c == null ? "" : c.visibility;
            this.guide = c == null ? "" : c.usage;
            this.model = model;
            List<Arg> args = new ArrayList<>();
            if (c != null) for (Command.Input i : c.inputs) args.add(new Arg(i));
            this.args = Collections.unmodifiableList(args);
            this.labelHits = labelHits;
            this.nameHits = nameHits;
            this.summaryHits = summaryHits;
        }
    }

    private static final List<int[]> NONE = Collections.emptyList();

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

    /** As below, without what this person used before. */
    public static Result suggest(String text, int cursor, Commands.Composer composer, Commands.State state, Collection<String> names, List<String> recent) {
        return suggest(text, cursor, composer, state, names, recent, null, 0);
    }

    /**
     * The suggestions for the text before the cursor, or null.
     *
     * @param state  the commands (Commands.UNKNOWN before the server answered)
     * @param names  the people who may be mentioned (in the room, and away)
     * @param recent the texts of the room's messages (the last 300 are searched for tags)
     * @param usage  the commands this person ran (null: none known)
     * @param now    the time, for how recent a use is
     */
    public static Result suggest(String text, int cursor, Commands.Composer composer, Commands.State state, Collection<String> names, List<String> recent, Usage usage, long now) {
        if (text == null || text.isEmpty()) return null;
        int at = Math.max(0, Math.min(cursor, text.length()));
        String input = text.substring(0, at);
        String tail = text.substring(at);
        if (input.isEmpty()) return null;
        String first = Js.firstCodePoint(input);
        if (composer.commandChars().contains(first)) {
            Matcher m = COMMAND_WORD.matcher(input.substring(first.length()));
            if (m.matches()) return commands(first, m.group().toLowerCase(Locale.ROOT), tail, state, usage, now);
        }
        Matcher w = WORD_END.matcher(input);
        if (!w.find()) return null;
        String ch = w.group(2);
        Commands.Trigger trig = null;
        for (Commands.Trigger t : composer.triggers) if (t.ch.equals(ch) && !t.action.equals("functions")) { trig = t; break; }
        if (trig == null) return null;
        String q = w.group(3).toLowerCase(Locale.ROOT);
        String before = input.substring(0, input.length() - ch.length() - w.group(3).length());
        if (trig.action.equals("mentions")) {
            Set<String> unique = new LinkedHashSet<>();
            for (String n : names) if (n != null && !n.isEmpty()) unique.add(n.replaceAll(Js.S + "+", "_"));
            List<Ranked> found = new ArrayList<>();
            int idx = 0;
            for (String n : unique) {
                Fuzzy.Match fm = loose(q, n, false);
                if (fm != null) found.add(new Ranked(pick(n, trig.ch + n, before + trig.ch + n, tail, "people", shift(fm.hits, trig.ch.length())), fm.score, 0, idx));
                idx++;
            }
            List<Item> items = ranked(found);
            return items.isEmpty() ? null : new Result("mentions", items);
        }
        Set<String> seen = new LinkedHashSet<>(composer.tags);
        for (String t : recent.subList(Math.max(0, recent.size() - 300), recent.size())) seen.addAll(tagsIn(t));
        List<Ranked> found = new ArrayList<>();
        int idx = 0;
        for (String tag : seen) {
            idx++;
            if (tag.equals(q)) continue;
            Fuzzy.Match fm = loose(q, tag, false);
            if (fm == null) continue;
            found.add(new Ranked(pick(tag, trig.ch + tag, before + trig.ch + tag, tail, "tags", shift(fm.hits, trig.ch.length())), fm.score, 0, idx));
        }
        List<Item> items = ranked(found);
        return items.isEmpty() ? null : new Result("tags", items);
    }

    /** An item with its place: its section's order, how well it matched, how much it is used, its place in the server's list. */
    private static final class Ranked {
        final Item item;
        final int score;
        final double used;
        final int index;
        Ranked(Item item, int score, double used, int index) { this.item = item; this.score = score; this.used = used; this.index = index; }
        int section() { return item.section.equals("recent") ? 0 : item.section.equals("others") ? 2 : 1; }
    }

    private static List<Item> ranked(List<Ranked> found) {
        found.sort((x, y) -> x.section() != y.section() ? Integer.compare(x.section(), y.section())
            : x.used != y.used ? Double.compare(y.used, x.used)
            : x.score != y.score ? Integer.compare(y.score, x.score)
            : Integer.compare(x.index, y.index));
        List<Item> out = new ArrayList<>();
        for (Ranked r : found) { if (out.size() >= MAX) break; out.add(r.item); }
        return out;
    }

    private static Result commands(String ch, String q, String tail, Commands.State state, Usage usage, long now) {
        if (Boolean.FALSE.equals(state.enabled)) return notice("off");
        List<Ranked> found = new ArrayList<>();
        // The used ones lead — the most used (and lately) first, at most RECENT.
        List<String> leaders = new ArrayList<>();
        if (usage != null) {
            List<Command> used = new ArrayList<>();
            for (Command c : state.commands) if (usage.score(c.keyword, now) > 0) used.add(c);
            used.sort((x, y) -> Double.compare(usage.score(y.keyword, now), usage.score(x.keyword, now)));
            for (Command c : used) if (leaders.size() < RECENT && (loose(q, c.keyword, true) != null || !q.isEmpty() && loose(q, c.name, false) != null)) leaders.add(c.keyword);
        }
        int idx = 0;
        for (Command c : state.commands) {
            int index = idx++;
            Fuzzy.Match mk = loose(q, c.keyword, true);
            Fuzzy.Match mn = q.isEmpty() ? null : loose(q, c.name, false);
            Fuzzy.Match ms = q.length() < 2 ? null : Fuzzy.match(q, c.summary, false);
            if (mk == null && mn == null && ms == null) continue;
            String section = leaders.contains(c.keyword) ? "recent" : mk != null || mn != null ? "commands" : "others";
            int score = Math.max(mk == null ? 0 : mk.score, Math.max(mn == null ? 0 : mn.score * 8 / 10, ms == null ? 0 : ms.score / 2));
            List<String> extra = new ArrayList<>();
            for (Command.Input i : c.inputs) extra.add(i.required ? i.name : "[" + i.name + "]");
            Item p = pick(c.keyword, ch + c.keyword, ch + c.keyword, tail, section, NONE);
            Item item = new Item(c.keyword, p.label, c.summary.isEmpty() ? c.name : c.summary, String.join(" ", extra), false, p.text, p.cursor,
                section, c, ModelIdentity.of(c), mk == null ? NONE : shift(mk.hits, ch.length()), mn == null ? NONE : mn.hits, ms == null ? NONE : ms.hits);
            found.add(new Ranked(item, score, section.equals("recent") ? usage.score(c.keyword, now) : 0, index));
        }
        List<Item> items = ranked(found);
        if (!items.isEmpty()) return new Result("functions", items);
        return !q.isEmpty() || state.enabled == null ? null : notice("none");
    }

    /** A match worth offering: one typed letter finds only a start (of the text or a word in it); two or more find anything. */
    private static Fuzzy.Match loose(String q, String text, boolean spread) {
        Fuzzy.Match m = Fuzzy.match(q, text, spread);
        return m == null || q.length() == 1 && m.score < Fuzzy.WORD - 100 ? null : m;
    }

    private static List<int[]> shift(List<int[]> hits, int by) {
        if (by == 0 || hits.isEmpty()) return hits;
        List<int[]> out = new ArrayList<>();
        for (int[] h : hits) out.add(new int[]{h[0] + by, h[1] + by});
        return out;
    }

    private static Result notice(String key) {
        List<Item> items = new ArrayList<>();
        items.add(new Item(key, "", "", "", true, null, 0));
        return new Result("functions", items);
    }

    /**
     * Picking replaces the word being typed with "&lt;token&gt; " — the rest of
     * that word after the cursor goes too, and a space already there is not doubled.
     */
    private static Item pick(String key, String label, String replaced, String tail, String section, List<int[]> hits) {
        Matcher rest = WORD_START.matcher(tail);
        String after = rest.find() ? tail.substring(rest.end()) : tail;
        if (!after.isEmpty() && Js.isWs(after.charAt(0))) after = after.substring(1);
        String head = replaced + " ";
        return new Item(key, label, "", "", false, head + after, head.length(), section, null, null, hits);
    }
}
