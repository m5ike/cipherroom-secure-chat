package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 6.11: a command's usage line and the check of a call before it goes —
 * the vectors of system-messenger-vectors.json (test/android-fn-611.test.ts
 * checks the TypeScript against the same).
 */
public class CommandCheckTest {
    private static final CommandCheck.Tr TR = k -> "[" + k + "]";

    /** A command as the server's JSON describes it (Command.from). */
    static Command command(JSONObject o) throws Exception {
        JSONObject c = new JSONObject(o.toString());
        if (!c.has("keyword")) c.put("keyword", "x");
        return Command.from(c);
    }

    private static List<String> problems(Command c, JSONObject values) throws Exception {
        List<String> out = new ArrayList<>();
        for (CommandCheck.Problem p : CommandCheck.check(c, values)) out.add(p.input + "|" + p.label + "|" + p.problem + "|" + p.expected);
        return out;
    }

    private static List<String> expected(JSONArray a) throws Exception {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) {
            JSONObject p = a.getJSONObject(i);
            out.add(p.getString("input") + "|" + p.getString("label") + "|" + p.getString("problem") + "|" + p.getString("expected"));
        }
        return out;
    }

    @Test public void theUsageLine() throws Exception {
        JSONObject v = ModelIdentityTest.vectors();
        Command c = command(v.getJSONObject("command"));
        assertEquals(v.getJSONObject("usage").getString("/"), CommandCheck.usage(c));
        assertEquals(v.getJSONObject("usage").getString("!"), CommandCheck.usage(c, "!"));
        // A required input with a default is optional in the line.
        assertEquals("[n]", CommandCheck.arg(c.inputs.get(2)));
    }

    @Test public void whatEachInputExpects() throws Exception {
        JSONObject v = ModelIdentityTest.vectors();
        Command c = command(v.getJSONObject("command"));
        JSONArray exp = v.getJSONArray("expectations");
        for (int i = 0; i < c.inputs.size(); i++) assertEquals(c.inputs.get(i).name, exp.getString(i), CommandCheck.expectation(c.inputs.get(i)));
        JSONArray more = v.getJSONArray("moreExpectations");
        for (int i = 0; i < more.length(); i++) {
            Command one = command(new JSONObject().put("inputs", new JSONArray().put(more.getJSONObject(i).getJSONObject("input"))));
            assertEquals(more.getJSONObject(i).getString("out"), CommandCheck.expectation(one.inputs.get(0)));
        }
    }

    @Test public void theChecksOfTheWeb() throws Exception {
        JSONObject v = ModelIdentityTest.vectors();
        Command c = command(v.getJSONObject("command"));
        JSONArray cases = v.getJSONArray("checks");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject k = cases.getJSONObject(i);
            assertEquals(k.getJSONObject("values").toString(), expected(k.getJSONArray("out")), problems(c, k.getJSONObject("values")));
        }
        JSONObject bad = v.getJSONObject("badPattern");
        assertEquals(expected(bad.getJSONArray("out")), problems(command(bad), bad.getJSONObject("values")));
    }

    @Test public void anEmptyCallOfAModelWithOnlyOptionalInputsGoes() throws Exception {
        Command c = command(new JSONObject().put("inputs", new JSONArray()
            .put(new JSONObject().put("name", "to").put("type", "email").put("required", false))
            .put(new JSONObject().put("name", "n").put("type", "integer").put("required", true).put("default", 2))));
        assertEquals(Collections.emptyList(), problems(c, new JSONObject()));
        // "/mail" without its required address: missing — the call never goes.
        Command mail = command(new JSONObject().put("keyword", "mail").put("inputs", new JSONArray().put(new JSONObject().put("name", "to").put("type", "email").put("required", true))));
        assertEquals(Arrays.asList("to|to|missing|a email"), problems(mail, Commands.buildInputs(mail, "")));
        assertEquals(Collections.emptyList(), problems(mail, Commands.buildInputs(mail, "a@b.cz")));
    }

    @Test public void anOlderServerWithoutTheNewFields() throws Exception {
        Command c = Command.from(new JSONObject().put("keyword", "dns").put("inputs", new JSONArray().put(new JSONObject().put("name", "name").put("type", "hostname").put("required", true))));
        assertEquals(null, c.icon);
        assertEquals("", c.usage);
        assertEquals(null, c.inputs.get(0).pattern);
        assertEquals(null, c.inputs.get(0).min);
        Command n = Command.from(new JSONObject().put("keyword", "dns").put("icon", "globe").put("usage", "/dns example.org")
            .put("inputs", new JSONArray().put(new JSONObject().put("name", "n").put("type", "number").put("min", 1).put("max", "x"))));
        assertEquals("globe", n.icon);
        assertEquals("/dns example.org", n.usage);
        assertEquals(1.0, n.inputs.get(0).min, 0);
        assertEquals(null, n.inputs.get(0).max);
    }

    @Test public void translatedExpectations() throws Exception {
        Command c = command(ModelIdentityTest.vectors().getJSONObject("command"));
        assertEquals("[fnm.expect.phone]", CommandCheck.expectation(c.inputs.get(0), TR));
        assertEquals("[fnm.expect.values]", CommandCheck.expectation(c.inputs.get(1), TR));
        assertEquals("[fnm.expect.integer] 1–10", CommandCheck.expectation(c.inputs.get(2), TR));
        assertEquals("[fnm.expect.number] 0.5–…", CommandCheck.expectation(c.inputs.get(5), TR));
        CommandCheck.Tr cs = k -> k.equals("fnm.expect.values") ? "jedna z: {values}" : k;
        assertEquals("jedna z: short, long", CommandCheck.expectation(c.inputs.get(1), cs));
    }

    @Test public void theErrorCard() throws Exception {
        JSONObject spec = new JSONObject(ModelIdentityTest.vectors().getJSONObject("command").toString()).put("usage", "/hlr +420777123456");
        Command c = command(spec);
        JSONArray card = CommandCheck.card(c, "/", CommandCheck.check(c, new JSONObject()), null, TR);
        assertEquals("markdown", card.getJSONObject(0).getString("type"));
        assertTrue(card.getJSONObject(0).getString("text").contains("**number**: [fnm.problem.missing]"));
        assertEquals("code", card.getJSONObject(1).getString("type"));
        assertEquals("/hlr <number> [format] [n] [flag] [code] [x]", card.getJSONObject(1).getString("text"));
        JSONObject table = card.getJSONObject(2);
        assertEquals("table", table.getString("type"));
        assertEquals(6, table.getJSONArray("rows").length());
        assertTrue(table.getJSONArray("rows").getJSONArray(2).getString(1).contains("[fnm.default]"));
        assertTrue(card.getJSONObject(3).getString("text").contains("/hlr +420777123456"));
        // The server's refusal instead of the problems.
        JSONArray refused = CommandCheck.card(c, "/", new ArrayList<>(), "input 'number' is required", TR);
        assertEquals("[fnm.error.server]", refused.getJSONObject(0).getString("text"));
        // Its Markdown is the message's text.
        assertTrue(Outputs.toMarkdown(card).contains("```\n/hlr <number>"));
    }
}
