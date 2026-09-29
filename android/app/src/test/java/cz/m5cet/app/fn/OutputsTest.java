package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The output rules (client/src/lib/fn-outputs.ts) — the cases of test/fn-outputs.test.tsx and test/functions-lib.test.ts. */
public class OutputsTest {
    /** The same JSON, whatever the order of keys (org.json on the JVM keeps none). */
    static void same(String expected, Object actual) throws Exception {
        assertEquals(canonical(Js.parse(expected)), canonical(actual));
    }

    /** JSON with sorted keys. */
    static String canonical(Object v) {
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            List<String> keys = new ArrayList<>();
            for (Iterator<String> it = o.keys(); it.hasNext(); ) keys.add(it.next());
            Collections.sort(keys);
            StringBuilder sb = new StringBuilder("{");
            for (String k : keys) sb.append(sb.length() > 1 ? "," : "").append(Js.stringify(k)).append(':').append(canonical(o.opt(k)));
            return sb.append('}').toString();
        }
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length(); i++) sb.append(i > 0 ? "," : "").append(canonical(a.opt(i)));
            return sb.append(']').toString();
        }
        return Js.stringify(v);
    }

    static JSONArray list(String json) throws Exception { return new JSONArray(json); }

    @Test
    public void markdownOfEachKind() throws Exception {
        JSONArray outputs = list("[{\"type\":\"markdown\",\"text\":\"# Hi\"},{\"type\":\"code\",\"text\":\"x=1\",\"lang\":\"py\"},"
            + "{\"type\":\"table\",\"columns\":[\"a\",\"b\"],\"rows\":[[1,2],[\"x|y\",4]],\"title\":\"T\"},{\"type\":\"json\",\"value\":{\"ok\":true}},"
            + "{\"type\":\"flash\",\"text\":\"done\",\"level\":\"success\"},{\"type\":\"image\",\"mime\":\"image/png\",\"data\":\"AA==\",\"alt\":\"chart\"}]");
        assertEquals("# Hi\n\n```py\nx=1\n```\n\n**T**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| x\\|y | 4 |\n\n```json\n{\n  \"ok\": true\n}\n```\n\n> done\n\n_(image: chart)_",
            Outputs.toMarkdown(outputs));
        assertEquals("", Outputs.toMarkdown(new JSONArray()));
        assertEquals("[🛒 Buy]", Outputs.toMarkdown(list("[{\"type\":\"button\",\"name\":\"b\",\"title\":\"Buy\",\"icon\":\"🛒\"},{\"type\":\"js\",\"code\":\"x\"}]")));
        assertEquals("_(file: a.pdf)_\n\n_(audio: Song)_\n\n_(video)_\n\n**Form**\nFill in", Outputs.toMarkdown(list("[{\"type\":\"file\",\"name\":\"a.pdf\"},"
            + "{\"type\":\"audio\",\"title\":\"Song\"},{\"type\":\"video\"},{\"type\":\"form\",\"text\":\"Fill in\"},{\"type\":\"window\",\"id\":\"x\"}]")));
        // Objects in cells are JSON, new lines are spaces, numbers as JavaScript writes them.
        assertEquals("| k |\n| --- |\n| [1,\"a/b\"] | x y | 0.5 | 1e+21 |", Outputs.toMarkdown(list("[{\"type\":\"table\",\"columns\":[\"k\"],\"rows\":[[[1,\"a/b\"],\"x\\ny\",0.5,1e21]]}]")));
    }

    @Test
    public void checksEachTypeAndSaysWhy() throws Exception {
        Outputs.Check b = Outputs.check(new JSONObject("{\"type\":\"button\",\"name\":\"go\",\"title\":\"Go\",\"css\":\"primary evil-class primary\",\"style\":{\"color\":\" red \",\"background\":\"url(x)\"}}"));
        same("{\"type\":\"button\",\"name\":\"go\",\"title\":\"Go\",\"css\":\"primary\",\"style\":{\"color\":\"red\"}}", b.output);
        assertTrue(Outputs.check(new JSONObject("{\"type\":\"button\",\"title\":\"no name\"}")).reason.contains("needs a name"));
        assertTrue(Outputs.check(new JSONObject("{\"type\":\"audio\",\"mime\":\"audio/wav\",\"data\":\"UklGRg==\"}")).ok());
        assertFalse(Outputs.check(new JSONObject("{\"type\":\"audio\",\"mime\":\"text/html\",\"data\":\"AAAA\"}")).ok());
        assertFalse(Outputs.check(new JSONObject("{\"type\":\"image\",\"mime\":\"image/png\\n\",\"data\":\"AAAA\"}")).ok());
        assertFalse(Outputs.check(new JSONObject("{\"type\":\"image\",\"mime\":\"image/png\",\"data\":\"AA=A\"}")).ok());
        assertFalse(Outputs.check(new JSONObject("{\"type\":\"js\",\"code\":\"\"}")).ok());
        assertEquals("unknown output type \"nope\"", Outputs.check(new JSONObject("{\"type\":\"nope\"}")).reason);
        assertEquals("unknown output type \"5\"", Outputs.check(new JSONObject("{\"type\":5}")).reason);
        assertEquals("not an object", Outputs.check("text").reason);
        same("{\"type\":\"code\",\"text\":\"x\",\"lang\":\"\"}", Outputs.check(new JSONObject("{\"type\":\"code\",\"text\":\"x\"}")).output);
        same("{\"type\":\"json\",\"value\":null}", Outputs.check(new JSONObject("{\"type\":\"json\"}")).output);
        same("{\"type\":\"file\",\"name\":\"a_b_c\",\"mime\":\"text/plain\",\"data\":\"\"}", Outputs.check(new JSONObject("{\"type\":\"file\",\"name\":\"a/b\\\\c\",\"mime\":\"text/plain\",\"data\":\"\"}")).output);
        same("{\"type\":\"window\",\"id\":\"files\",\"args\":null}", Outputs.check(new JSONObject("{\"type\":\"window\",\"id\":\"files\"}")).output);
        same("{\"type\":\"js\",\"code\":\"x()\",\"height\":2000,\"hidden\":true}", Outputs.check(new JSONObject("{\"type\":\"js\",\"code\":\"x()\",\"height\":\"9999\",\"hidden\":true}")).output);
        same("{\"type\":\"table\",\"columns\":[\"1\",\"null\"],\"rows\":[]}", Outputs.check(new JSONObject("{\"type\":\"table\",\"columns\":[1,null],\"rows\":[]}")).output);
        assertEquals("table: columns and rows must be lists", Outputs.check(new JSONObject("{\"type\":\"table\",\"columns\":[],\"rows\":[1]}")).reason);

        Outputs.Check form = Outputs.check(new JSONObject("{\"type\":\"form\",\"name\":\"f\",\"panels\":[{\"layout\":\"columns\",\"columns\":9,\"fields\":["
            + "{\"name\":\"a\",\"type\":\"masked\",\"mask\":\"000\"},{\"name\":\"bad name!\",\"type\":\"text\"},"
            + "{\"name\":\"s\",\"type\":\"multiselect\",\"options\":[\"x\",{\"value\":\"y\",\"label\":\"Y\",\"icon\":\"🍎\"}]}]}]}"));
        same("{\"type\":\"form\",\"name\":\"f\",\"panels\":[{\"fields\":[{\"name\":\"a\",\"type\":\"masked\",\"mask\":\"000\"},"
            + "{\"name\":\"s\",\"type\":\"multiselect\",\"options\":[{\"value\":\"x\",\"label\":\"x\"},{\"value\":\"y\",\"label\":\"Y\",\"icon\":\"🍎\"}]}],"
            + "\"layout\":\"columns\",\"columns\":4}]}", form.output);
        same("{\"type\":\"form\",\"name\":\"form\",\"fields\":[{\"name\":\"\",\"type\":\"static\",\"text\":\"hi\"},{\"name\":\"n\",\"type\":\"number\",\"min\":2,\"step\":0.5,\"default\":null,\"required\":true}]}",
            Outputs.check(new JSONObject("{\"type\":\"form\",\"fields\":[{\"type\":\"static\",\"text\":\"hi\"},{\"name\":\"n\",\"type\":\"number\",\"min\":\"2\",\"step\":0.5,\"default\":null,\"required\":true},{\"name\":\"n\"}]}")).output);
        assertEquals("form: a form needs fields (or panels with fields)", Outputs.check(new JSONObject("{\"type\":\"form\",\"fields\":[]}")).reason);
    }

    @Test
    public void formValuesAndMasks() throws Exception {
        JSONObject spec = new JSONObject("{\"name\":\"f\",\"fields\":[{\"name\":\"e\",\"type\":\"email\",\"required\":true},{\"name\":\"n\",\"type\":\"number\",\"min\":2},{\"name\":\"p\",\"type\":\"masked\",\"mask\":\"000 000\"}]}");
        Map<String, String> want = new LinkedHashMap<>();
        want.put("e", "required");
        want.put("n", "min 2");
        want.put("p", "incomplete");
        assertEquals(want, Outputs.checkFormValues(spec, new JSONObject("{\"e\":\"\",\"n\":1,\"p\":\"12\"}")));
        assertTrue(Outputs.checkFormValues(spec, new JSONObject("{\"e\":\"a@b.cz\",\"n\":3,\"p\":\"123 456\"}")).isEmpty());
        assertEquals("email", Outputs.checkFormValues(spec, new JSONObject("{\"e\":\"a b@c.cz\"}")).get("e"));
        assertEquals("number", Outputs.checkFormValues(spec, new JSONObject("{\"e\":\"a@b.cz\",\"n\":\"abc\"}")).get("n"));
        JSONObject more = new JSONObject("{\"name\":\"g\",\"panels\":[{\"fields\":[{\"name\":\"ok\",\"type\":\"switch\",\"required\":true},"
            + "{\"name\":\"code\",\"type\":\"text\",\"pattern\":\"^[A-Z]{2}$\"},{\"name\":\"tags\",\"type\":\"multiselect\",\"required\":true},{\"name\":\"r\",\"type\":\"range\",\"max\":10}]}]}");
        Map<String, String> p = Outputs.checkFormValues(more, new JSONObject("{\"ok\":false,\"code\":\"abc\",\"tags\":[],\"r\":11}"));
        assertEquals("required", p.get("ok"));
        assertEquals("pattern", p.get("code"));
        assertEquals("required", p.get("tags"));
        assertEquals("max 10", p.get("r"));
        assertTrue(Outputs.checkFormValues(more, new JSONObject("{\"ok\":true,\"code\":\"CZ\",\"tags\":[\"a\"],\"r\":\"10\"}")).isEmpty());

        assertEquals("+420 777 123 456", Outputs.applyMask("+{420} 000 000 000", "777123456"));
        assertEquals("+420 777 123 456", Outputs.applyMask("+{420} 000 000 000", "+420 777 123 456"));
        assertEquals("+420 123", Outputs.applyMask("+\\4\\2\\0 000", "123"));
        assertEquals("ab-1234", Outputs.applyMask("aa-0000", "ab1234"));
        assertEquals("+420 ___ ___ ___", Outputs.maskPlaceholder("+{420} 000 000 000"));
        assertEquals(16, Outputs.maskTokens("+{420} 000 000 000").size());
    }

    @Test
    public void aRoomMessageCarriesWhatFits() throws Exception {
        JSONObject big = new JSONObject().put("type", "image").put("mime", "image/png").put("data", "A".repeat(800_000));
        JSONArray shared = Outputs.shareable(new JSONArray().put(new JSONObject("{\"type\":\"text\",\"text\":\"hi\"}")).put(big));
        assertEquals(2, shared.length());
        same("{\"type\":\"text\",\"text\":\"(image — too large to share in the room)\"}", shared.get(1));
        // Sizes are JSON.stringify's: "/" is not escaped (org.json on Android would write "\/").
        String data = "/".repeat(699_950);
        JSONObject slashes = new JSONObject().put("type", "image").put("mime", "image/png").put("data", data);
        assertEquals(data.length() + "{\"type\":\"image\",\"mime\":\"image/png\",\"data\":\"\"}".length(), Js.stringify(slashes).length());
        assertEquals("image", Outputs.shareable(new JSONArray().put(slashes)).getJSONObject(0).getString("type"));
    }

    @Test
    public void peersOutputsAreCheckedAgain() throws Exception {
        same("[{\"type\":\"text\",\"text\":\"ok\"},{\"type\":\"flash\",\"text\":\"x\",\"level\":\"info\"}]",
            Outputs.sanitize(list("[{\"type\":\"text\",\"text\":\"ok\"},{\"type\":\"js\",\"code\":5},{\"type\":\"flash\",\"text\":\"x\",\"level\":\"boom\"}]")));
        assertEquals(0, Outputs.sanitize(new JSONObject()).length());
        JSONArray many = new JSONArray();
        for (int i = 0; i < 60; i++) many.put(new JSONObject().put("type", "text").put("text", "t" + i));
        assertEquals(50, Outputs.sanitize(many).length());
        // The total budget: what does not fit ends the list.
        JSONArray two = list("[{\"type\":\"text\",\"text\":\"aaaa\"},{\"type\":\"text\",\"text\":\"bbbb\"}]");
        assertEquals(1, Outputs.sanitize(two, "{\"type\":\"text\",\"text\":\"aaaa\"}".length() + 5).length());
    }

    @Test
    public void buttonColours() {
        assertEquals(Integer.valueOf(0xFFFF0000), CssColor.parse("red"));
        assertEquals(Integer.valueOf(0xFF112233), CssColor.parse("#123"));
        assertEquals(Integer.valueOf(0x80112233), CssColor.parse("#11223380"));
        assertEquals(Integer.valueOf(0xFF0A141E), CssColor.parse("rgb(10, 20, 30)"));
        assertEquals(Integer.valueOf(0x80FF0000), CssColor.parse("rgba(100%,0,0,0.5)"));
        assertEquals(Integer.valueOf(0xFF00FF00), CssColor.parse("hsl(120deg, 100%, 50%)"));
        assertNull(CssColor.parse("rebeccapurplish"));
        assertNull(CssColor.parse("#12345"));
    }
}
