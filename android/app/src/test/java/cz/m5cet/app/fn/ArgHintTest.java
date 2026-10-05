package cz.m5cet.app.fn;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** 6.11: the hint over the message box while a command's arguments are typed, and the suggester's items for a command. */
public class ArgHintTest {
    private static final List<String> SLASH = Collections.singletonList("/");

    private static Command.Input in(String name, String type, boolean required, String... values) {
        return new Command.Input(name, type, "", "", required, null, Arrays.asList(values));
    }

    private static final Command HLR = new Command("hlr", "Číslo a síť", "Ověří číslo", "server", "room", true,
        Arrays.asList(in("number", "phone", true), in("format", "enum", false, "short", "long"), in("note", "text", false)), null, null, "phone", "/hlr +420777123456");
    private static final Command PAIR = new Command("pair", "Pair", "", "server", "caller", true,
        Arrays.asList(in("on", "boolean", false), in("n", "integer", true)), null, null);
    private static final Commands.State STATE = new Commands.State(true, Arrays.asList(HLR, PAIR, new Command("ping", "Ping", "", "server", "room", true, null, null, null)));

    private static ArgHint at(String text) { return ArgHint.of(text, text.length(), SLASH, STATE); }

    @Test public void onlyOnceTheArgumentsStart() throws Exception {
        assertNull(at("/hlr"));
        assertNull(at("/zzz "));
        assertNull(at("hlr +420"));
        assertNull(at("/ping "));          // no arguments to hint
        assertNull(ArgHint.of("/hlr ", 5, SLASH, Commands.UNKNOWN));
    }

    @Test public void theUsageLineWithTheCurrentOne() throws Exception {
        ArgHint h = at("/hlr ");
        assertEquals("/hlr <number> [format] [note]", h.usage);
        assertArrayEquals(new int[]{5, 13}, h.spans.get(0));
        assertArrayEquals(new int[]{14, 22}, h.spans.get(1));
        assertArrayEquals(new int[]{23, 29}, h.spans.get(2));
        assertEquals(0, h.current);
        assertEquals("number", h.input().name);
        assertEquals("", h.typed);
        assertTrue(h.values.isEmpty());
        assertEquals("phone", h.model.icon);
        assertEquals(0, at("/hlr +42").current);   // still in the first one
        assertEquals("+42", at("/hlr +42").typed);
    }

    @Test public void aChoiceOffersItsValues() throws Exception {
        ArgHint h = at("/hlr +420 ");
        assertEquals(1, h.current);
        assertEquals(Arrays.asList("short", "long"), h.values);
        ArgHint s = at("/hlr +420 s");
        assertEquals(Arrays.asList("short"), s.values);
        String[] p = s.pick("short");
        assertEquals("/hlr +420 short ", p[0]);
        assertEquals("16", p[1]);
        // The cursor inside a word: picking replaces all of it.
        String text = "/hlr +420 short";
        ArgHint mid = ArgHint.of(text, 11, SLASH, STATE);
        assertEquals("s", mid.typed);
        assertEquals("/hlr +420 long ", mid.pick("long")[0]);
        // A value with a space goes in quotes.
        assertEquals("/hlr +420 \"very short\" ", s.pick("very short")[0]);
    }

    @Test public void aTrailingTextTakesTheRest() throws Exception {
        ArgHint h = at("/hlr +420 short some text here");
        assertEquals(2, h.current);
        assertEquals("note", h.input().name);
        assertEquals("here", h.typed);
    }

    @Test public void namedOnes() throws Exception {
        ArgHint h = at("/hlr format=l");
        assertEquals(1, h.current);
        assertEquals("l", h.typed);
        assertEquals(Arrays.asList("long"), h.values);
        assertEquals("/hlr format=long ", h.pick("long")[0]);
        // A named one is given: the bare words fill the others.
        assertEquals(0, at("/hlr format=long ").current);
        assertEquals(2, at("/hlr format=long +420 ").current);
    }

    @Test public void allGivenAndSwitches() throws Exception {
        assertEquals(Arrays.asList("true", "false"), at("/pair ").values);
        assertEquals(Arrays.asList("false"), at("/pair f").values);
        ArgHint done = at("/pair true 3 ");
        assertEquals(-1, done.current);
        assertNull(done.input());
    }

    @Test public void aCommandsItemCarriesItsModelArgumentsAndAudience() throws Exception {
        Suggestions.Item it = Suggestions.suggest("/hl", 3, Commands.DEFAULT_COMPOSER, STATE, Collections.emptyList(), Collections.emptyList()).items.get(0);
        assertEquals("/hlr", it.label);
        assertEquals("Číslo a síť", it.name);
        assertEquals("Ověří číslo", it.summary);
        assertEquals("room", it.visibility);
        assertEquals("/hlr +420777123456", it.guide);
        assertEquals("phone", it.model.icon);
        assertEquals("#7bb234", it.model.color);
        assertEquals(3, it.args.size());
        assertTrue(it.args.get(0).required);
        assertEquals("format", it.args.get(1).name);
        assertArrayEquals(new int[][]{{1, 3}}, it.labelHits.toArray(new int[0][]));   // "hl" of "/hlr"
        assertEquals("commands", it.section);
    }
}
