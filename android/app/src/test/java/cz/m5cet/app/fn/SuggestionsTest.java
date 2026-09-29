package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** The message box's suggestions (composerSuggestions() in App.tsx; tagsIn() of linkify.tsx). */
public class SuggestionsTest {
    private static final Commands.Composer COMPOSER = Commands.DEFAULT_COMPOSER;
    private static final List<String> NONE = Collections.emptyList();

    private static Commands.State state(Boolean enabled, Command... commands) {
        return new Commands.State(enabled, Arrays.asList(commands));
    }

    private static Command cmd(String keyword, String summary, Command.Input... inputs) {
        return new Command(keyword, keyword.toUpperCase(), summary, "server", "room", true, Arrays.asList(inputs), null, null);
    }

    private static List<String> labels(Suggestions.Result r) {
        List<String> out = new ArrayList<>();
        for (Suggestions.Item i : r.items) out.add(i.label);
        return out;
    }

    private static Suggestions.Result at(String text, Commands.State s) {
        return Suggestions.suggest(text, text.length(), COMPOSER, s, NONE, NONE);
    }

    @Test
    public void commandsByPrefix() {
        Commands.State s = state(true,
            cmd("dns", "Looks up a name", CommandsTest.input("name", "hostname", true), CommandsTest.input("type", "enum", false)),
            cmd("dice", ""), cmd("help", "Help"));
        Suggestions.Result r = at("/d", s);
        assertEquals("functions", r.kind);
        assertEquals(Arrays.asList("/dns", "/dice"), labels(r));
        Suggestions.Item dns = r.items.get(0);
        assertEquals("Looks up a name", dns.detail);
        assertEquals("name [type]", dns.extra);
        assertEquals("/dns ", dns.text);
        assertEquals(5, dns.cursor);
        assertEquals("DICE", r.items.get(1).detail);
        assertEquals(3, at("/", s).items.size());
        assertEquals(Arrays.asList("/help"), labels(at("/HE", s)));
        // Arguments started: no command list (the words are for the command).
        assertNull(at("/dns exa", s));
        assertNull(at("hello", s));
    }

    @Test
    public void noticesWhenOffOrNothingFits() {
        Suggestions.Result off = at("/x", state(false));
        assertTrue(off.items.get(0).disabled);
        assertEquals("off", off.items.get(0).key);
        assertEquals("none", at("/", state(true)).items.get(0).key);
        assertNull(at("/zz", state(true, cmd("dns", ""))));
        // Not known yet: nothing to say.
        assertNull(at("/", Commands.UNKNOWN));
    }

    @Test
    public void atMostEight() {
        List<Command> many = new ArrayList<>();
        for (int i = 0; i < 12; i++) many.add(cmd("c" + i, ""));
        assertEquals(8, at("/c", new Commands.State(true, many)).items.size());
    }

    @Test
    public void mentions() {
        List<String> names = Arrays.asList("Anna Kovářová", "anton", "Bob", "", "Anna  Kovářová");
        Suggestions.Result r = Suggestions.suggest("hi @an", 6, COMPOSER, Commands.UNKNOWN, names, NONE);
        assertEquals("mentions", r.kind);
        assertEquals(Arrays.asList("@Anna_Kovářová", "@anton"), labels(r));
        assertEquals("hi @Anna_Kovářová ", r.items.get(0).text);
        assertNull(Suggestions.suggest("hi @zz", 6, COMPOSER, Commands.UNKNOWN, names, NONE));
        // The cursor inside the text: the word is replaced, what follows stays.
        Suggestions.Result mid = Suggestions.suggest("hi @an and more", 6, COMPOSER, Commands.UNKNOWN, names, NONE);
        assertEquals("hi @Anna_Kovářová and more", mid.items.get(0).text);
        assertEquals("hi @Anna_Kovářová ".length(), mid.items.get(0).cursor);
        Suggestions.Result inWord = Suggestions.suggest("hi @anXYZ!", 6, COMPOSER, Commands.UNKNOWN, names, NONE);
        assertEquals("hi @anton !", inWord.items.get(1).text);
    }

    @Test
    public void tags() {
        Commands.Composer c = new Commands.Composer(COMPOSER.triggers, Arrays.asList("urgent", "release"));
        List<String> recent = Arrays.asList("Hotovo #Release. A #release-notes", "#ops", "nic");
        Suggestions.Result r = Suggestions.suggest("see #re", 7, c, Commands.UNKNOWN, NONE, recent);
        assertEquals("tags", r.kind);
        assertEquals(Arrays.asList("#release", "#release-notes"), labels(r));
        // The tag already typed in full is not offered again.
        assertEquals(Arrays.asList("#release-notes"), labels(Suggestions.suggest("#release", 8, c, Commands.UNKNOWN, NONE, recent)));
        assertEquals(Arrays.asList("#urgent", "#release", "#release-notes", "#ops"), labels(Suggestions.suggest("#", 1, c, Commands.UNKNOWN, NONE, recent)));
        // Only at the start of a word; an unknown character offers nothing.
        assertNull(Suggestions.suggest("a#re", 4, c, Commands.UNKNOWN, NONE, recent));
        assertNull(Suggestions.suggest("~re", 3, c, Commands.UNKNOWN, NONE, recent));
    }

    @Test
    public void tagsOfAMessage() {
        assertEquals(Arrays.asList("release", "release-notes", "v5.2", "ops"), Suggestions.tagsIn("Hotovo #Release. A #release-notes a #v5.2 — http://x.test/#frag, (#ops)"));
        assertFalse(Suggestions.tagsIn("#foo-bar").contains("foo"));
        assertEquals(NONE, Suggestions.tagsIn("no tags # here"));
    }

    @Test
    public void theOperatorsCharacters() {
        Commands.Composer bang = new Commands.Composer(Arrays.asList(new Commands.Trigger("!", "functions"), new Commands.Trigger("+", "mentions")), NONE);
        Commands.State s = state(true, cmd("dns", ""));
        assertEquals(Arrays.asList("!dns"), labels(Suggestions.suggest("!d", 2, bang, s, NONE, NONE)));
        assertEquals("!dns ", Suggestions.suggest("!d", 2, bang, s, NONE, NONE).items.get(0).text);
        assertNull(Suggestions.suggest("/d", 2, bang, s, NONE, NONE));
        assertEquals(Arrays.asList("+eva"), labels(Suggestions.suggest("x +e", 4, bang, s, Arrays.asList("eva"), NONE)));
        assertNull(Suggestions.suggest("x @e", 4, bang, s, Arrays.asList("eva"), NONE));
    }
}
