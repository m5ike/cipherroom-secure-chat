package cz.m5cet.app.fn;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 6.11: the hint over the message box while a command's arguments are
 * typed ("/hlr +420… "): the command's usage line with the argument the
 * cursor is in highlighted, that argument's label, help, type and — for a
 * choice or a switch — its values to tap. Which argument it is follows
 * Commands.buildInputs: "name=value" names one, bare words fill the
 * chat-typeable inputs in order, and a trailing text input takes the rest.
 * Pure.
 */
public final class ArgHint {
    public final Command command;
    public final ModelIdentity model;
    /** "/hlr &lt;number&gt; [format]". */
    public final String usage;
    /** Where each input stands in the usage line: [start, end) per input, in the command's order. */
    public final List<int[]> spans;
    /** The input the cursor is in (its index in command.inputs), −1 when all are given. */
    public final int current;
    /** What is typed for it so far. */
    public final String typed;
    /** Values to offer for it (a choice's values, true / false for a switch) that start with what is typed. */
    public final List<String> values;
    /** Where the typed value starts in the text (for {@link #pick}), and the cursor. */
    private final String text;
    private final int valueStart, caret;

    private ArgHint(Command command, String trigger, int current, String typed, String text, int valueStart, int caret) {
        this.command = command;
        this.model = ModelIdentity.of(command);
        StringBuilder sb = new StringBuilder(trigger).append(command.keyword);
        List<int[]> spans = new ArrayList<>();
        for (Command.Input i : command.inputs) {
            sb.append(' ');
            int s = sb.length();
            sb.append(CommandCheck.arg(i));
            spans.add(new int[]{s, sb.length()});
        }
        this.usage = sb.toString();
        this.spans = Collections.unmodifiableList(spans);
        this.current = current;
        this.typed = typed;
        this.text = text;
        this.valueStart = valueStart;
        this.caret = caret;
        List<String> v = new ArrayList<>();
        Command.Input in = input();
        if (in != null) {
            List<String> all = !in.values.isEmpty() ? in.values : "boolean".equals(in.type) ? java.util.Arrays.asList("true", "false") : Collections.emptyList();
            String t = typed.toLowerCase(Locale.ROOT);
            for (String x : all) if (x.toLowerCase(Locale.ROOT).startsWith(t) && !x.equals(typed)) v.add(x);
        }
        this.values = Collections.unmodifiableList(v);
    }

    /** The input the cursor is in (null when all are given). */
    public Command.Input input() { return current >= 0 && current < command.inputs.size() ? command.inputs.get(current) : null; }

    /** The text and cursor once a value is picked: it replaces what is typed for the input, a space after it. */
    public String[] pick(String value) {
        String after = text.substring(caret);
        int end = 0;
        while (end < after.length() && !Js.isWs(after.charAt(end))) end++;
        String rest = after.substring(end);
        if (!rest.isEmpty() && Js.isWs(rest.charAt(0))) rest = rest.substring(1);
        String q = value.matches(".*" + Js.S + ".*") ? "\"" + value + "\"" : value;
        String head = text.substring(0, valueStart) + q + " ";
        return new String[]{head + rest, String.valueOf(head.length())};
    }

    private static final Pattern HEAD = Pattern.compile("([a-z0-9_-]{1,40})" + Js.S + "+", Pattern.CASE_INSENSITIVE);

    /** The hint for the text before the cursor, or null (not a known command's arguments). */
    public static ArgHint of(String text, int cursor, List<String> chars, Commands.State state) {
        if (text == null || text.isEmpty() || state == null) return null;
        int at = Math.max(0, Math.min(cursor, text.length()));
        String before = text.substring(0, at);
        String first = Js.firstCodePoint(before);
        if (first.isEmpty() || !chars.contains(first)) return null;
        Matcher h = HEAD.matcher(before);
        h.region(first.length(), before.length());
        if (!h.lookingAt()) return null;
        Command cmd = state.find(h.group(1).toLowerCase(Locale.ROOT));
        if (cmd == null || cmd.inputs.isEmpty()) return null;
        int argsAt = h.end();
        // The words typed so far; the last one is the one being typed unless a space follows it.
        List<int[]> words = new ArrayList<>();
        int i = argsAt;
        while (i < before.length()) {
            while (i < before.length() && Js.isWs(before.charAt(i))) i++;
            if (i >= before.length()) break;
            int s = i;
            char quote = before.charAt(i) == '"' || before.charAt(i) == '\'' ? before.charAt(i) : 0;
            if (quote != 0) {
                int close = before.indexOf(quote, i + 1);
                i = close < 0 ? before.length() : close + 1;
            }
            while (i < before.length() && !Js.isWs(before.charAt(i))) i++;
            words.add(new int[]{s, i});
        }
        boolean inWord = !words.isEmpty() && words.get(words.size() - 1)[1] == before.length() && !Js.isWs(before.charAt(before.length() - 1));
        List<int[]> done = inWord ? words.subList(0, words.size() - 1) : words;
        Set<String> named = new HashSet<>();
        List<String> bare = new ArrayList<>();
        for (int[] w : done) {
            String tok = before.substring(w[0], w[1]);
            int eq = tok.indexOf('=');
            if (eq > 0 && index(cmd, tok.substring(0, eq)) >= 0) named.add(tok.substring(0, eq));
            else bare.add(tok);
        }
        int valueStart = inWord ? words.get(words.size() - 1)[0] : before.length();
        String typed = inWord ? before.substring(valueStart) : "";
        // "name=value" being typed: that input.
        int eq = typed.indexOf('=');
        if (eq > 0 && index(cmd, typed.substring(0, eq)) >= 0) {
            return new ArgHint(cmd, first, index(cmd, typed.substring(0, eq)), unquote(typed.substring(eq + 1)), text, valueStart + eq + 1, at);
        }
        // Else the next chat-typeable input not named yet; a trailing text input takes everything left.
        List<Command.Input> positional = new ArrayList<>();
        for (Command.Input in : cmd.inputs) if (!in.type.equals("user") && !in.type.equals("file") && !in.type.equals("secret") && !named.contains(in.name)) positional.add(in);
        int k = bare.size();
        if (!positional.isEmpty()) {
            Command.Input last = positional.get(positional.size() - 1);
            boolean rest = last.type.equals("text") || last.type.equals("string");
            if (rest && k >= positional.size() - 1) return new ArgHint(cmd, first, cmd.inputs.indexOf(last), unquote(typed), text, valueStart, at);
            if (k < positional.size()) return new ArgHint(cmd, first, cmd.inputs.indexOf(positional.get(k)), unquote(typed), text, valueStart, at);
        }
        return new ArgHint(cmd, first, -1, "", text, valueStart, at);
    }

    private static int index(Command c, String name) {
        for (int i = 0; i < c.inputs.size(); i++) if (c.inputs.get(i).name.equals(name)) return i;
        return -1;
    }

    private static String unquote(String s) {
        return s.length() > 0 && (s.charAt(0) == '"' || s.charAt(0) == '\'') ? s.substring(1).replaceFirst("[\"']$", "") : s;
    }
}
