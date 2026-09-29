package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** The command line and the composer's characters — the cases of test/functions-lib.test.ts and test/composer.test.tsx. */
public class CommandsTest {
    static Command command(Command.Input... inputs) {
        return new Command("check", "Check", "", "server", "room", true, Arrays.asList(inputs), null, null);
    }

    static Command.Input input(String name, String type, boolean required) {
        return new Command.Input(name, type, "", "", required, null, null);
    }

    private static final List<String> SLASH = Collections.singletonList("/");

    private static void parsed(String text, List<String> chars, String keyword, String args) {
        Commands.Parsed p = Commands.parseCommandLine(text, chars);
        assertEquals(text, keyword, p.keyword);
        assertEquals(text, args, p.argText);
    }

    @Test
    public void recognisesACommandAndItsArguments() {
        parsed("/pocasi Brno", SLASH, "pocasi", "Brno");
        parsed("  /ping  ", SLASH, "ping", "");
        parsed("/check a=1 b=2", SLASH, "check", "a=1 b=2");
        parsed("/DNS  example.com\n type=MX ", SLASH, "dns", "example.com\n type=MX");
        // JavaScript's white space: a no-break space separates too.
        parsed("/dns" + (char) 0xA0 + "example.com", SLASH, "dns", "example.com");
    }

    @Test
    public void plainTextOrABareSlashIsNoCommand() {
        assertNull(Commands.parseCommandLine("hello", SLASH));
        assertNull(Commands.parseCommandLine("/", SLASH));
        assertNull(Commands.parseCommandLine("http://x/y", SLASH));
        assertNull(Commands.parseCommandLine("hello /dns", SLASH));
        assertNull(Commands.parseCommandLine("/" + "a".repeat(41), SLASH));
    }

    @Test
    public void anyCommandCharacterStartsOne() {
        parsed("!dns example.com", Arrays.asList("/", "!"), "dns", "example.com");
        assertNull(Commands.parseCommandLine("!dns example.com", SLASH));
    }

    @Test
    public void keyValuePairsAndPositionalInputs() {
        Command c = command(input("domain", "hostname", true), input("port", "integer", false), input("depth", "enum", false));
        JSONObject a = Commands.buildInputs(c, "example.org depth=full");
        assertEquals(2, a.length());
        assertEquals("example.org", a.optString("domain"));
        assertEquals("full", a.optString("depth"));
        JSONObject b = Commands.buildInputs(c, "example.org 8443");
        assertEquals(2, b.length());
        assertEquals("8443", b.optString("port"));
        // An unknown key=value is a bare token; a known one wins over its position.
        JSONObject d = Commands.buildInputs(c, "x=1 port=80 example.org");
        assertEquals("x=1", d.optString("domain"));
        assertEquals("80", d.optString("port"));
        assertEquals("example.org", d.optString("depth"));
    }

    @Test
    public void aTrailingTextFieldTakesTheRest() {
        Command c = command(input("to", "string", true), input("message", "text", true));
        JSONObject a = Commands.buildInputs(c, "alice \"hello there\" friend");
        assertEquals("alice", a.optString("to"));
        assertEquals("hello there friend", a.optString("message"));
    }

    @Test
    public void quotesAndChatTypeableInputs() {
        assertEquals("a b c", Commands.buildInputs(command(input("title", "string", true)), "\"a b c\"").optString("title"));
        assertEquals("it s", Commands.buildInputs(command(input("title", "string", true)), "'it''s'").optString("title"));
        assertEquals(Arrays.asList("a b", "", "c"), Commands.tokenize("'a b' \"\" c"));
        // A user, a file or a secret is never filled by position.
        JSONObject v = Commands.buildInputs(command(input("who", "user", true), input("note", "text", false)), "hello world");
        assertFalse(v.has("who"));
        assertEquals("hello world", v.optString("note"));
        assertEquals("bob", Commands.buildInputs(command(input("who", "user", true)), "who=bob").optString("who"));
    }

    @Test
    public void composerDefaultsAndTheOperatorsCharacters() throws Exception {
        assertSame(Commands.DEFAULT_COMPOSER, Commands.composerFrom(null));
        assertEquals(Arrays.asList("/"), Commands.DEFAULT_COMPOSER.commandChars());
        Commands.Composer c = Commands.composerFrom(new JSONObject("{\"triggers\":[{\"char\":\"!\",\"action\":\"functions\"},{\"char\":\"!\",\"action\":\"tags\"},"
            + "{\"char\":\"a\",\"action\":\"tags\"},{\"char\":\" \",\"action\":\"tags\"},{\"char\":\"@\",\"action\":\"mentions\"},{\"char\":\"~\",\"action\":\"nope\"}],"
            + "\"tags\":[\"#Urgent\",\"meeting\",\"bad tag!\",\"meeting\"]}"));
        List<String> triggers = new ArrayList<>();
        for (Commands.Trigger t : c.triggers) triggers.add(t.ch + t.action);
        assertEquals(Arrays.asList("!functions", "@mentions"), triggers);
        assertEquals(Arrays.asList("urgent", "meeting"), c.tags);
        // Triggers the operator removed stay removed.
        assertTrue(Commands.composerFrom(new JSONObject("{\"triggers\":[]}")).triggers.isEmpty());
    }

    @Test
    public void whatAMessageAnswers() throws Exception {
        assertFalse(Commands.answers(new JSONObject("{\"keyword\":\"k\"}"), "button"));
        assertTrue(Commands.answers(new JSONObject("{\"chain\":\"chn_1\"}"), "button"));
        assertTrue(Commands.answers(new JSONObject("{\"chain\":\"chn_1\",\"events\":[\"form\"]}"), "form"));
        assertFalse(Commands.answers(new JSONObject("{\"chain\":\"chn_1\",\"events\":[\"form\"]}"), "button"));
        JSONObject click = Commands.button("go", new JSONObject("{\"n\":2}"));
        assertEquals("{\"type\":\"button\",\"name\":\"go\",\"data\":{\"n\":2}}".length(), Js.stringify(click).length());
        assertFalse(Commands.button("go", null).has("data"));
        assertEquals("quoted", Commands.response("hi", "quoted").getJSONObject("message").getString("text"));
    }
}
