package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** The JavaScript the port relies on: String(n), Number(s), JSON.stringify, trim(). */
public class JsTest {
    @Test
    public void numbersAsJavaScriptWritesThem() {
        assertEquals("1", Js.numberToString(1));
        assertEquals("1.5", Js.numberToString(1.5));
        assertEquals("100", Js.numberToString(100));
        assertEquals("0.001", Js.numberToString(0.001));
        assertEquals("0.000001", Js.numberToString(0.000001));
        assertEquals("1e-7", Js.numberToString(1e-7));
        assertEquals("1.5e-7", Js.numberToString(1.5e-7));
        assertEquals("100000000000000000000", Js.numberToString(1e20));
        assertEquals("1e+21", Js.numberToString(1e21));
        assertEquals("123456789012", Js.numberToString(123456789012.0));
        assertEquals("1152921504606847000", Js.numberToString(Math.pow(2, 60)));
        assertEquals("-2.5", Js.numberToString(-2.5));
        assertEquals("0", Js.numberToString(-0.0));
        assertEquals("NaN", Js.numberToString(Double.NaN));
    }

    @Test
    public void numberOfAValue() {
        assertEquals(12, Js.toNumber(" 12 "), 0);
        assertEquals(31, Js.toNumber("0x1f"), 0);
        assertEquals(0, Js.toNumber(""), 0);
        assertEquals(1000, Js.toNumber("1e3"), 0);
        assertEquals(0.5, Js.toNumber(".5"), 0);
        assertTrue(Double.isNaN(Js.toNumber("12px")));
        assertTrue(Double.isNaN(Js.toNumber("1d")));
        assertTrue(Double.isNaN(Js.toNumber(null)));
        assertEquals(1, Js.toNumber(true), 0);
        assertEquals(0, Js.toNumber(JSONObject.NULL), 0);
        assertEquals(Double.POSITIVE_INFINITY, Js.toNumber("Infinity"), 0);
        assertEquals(5, Js.toNumber(new JSONArray().put(5)), 0);
    }

    @Test
    public void stringOfAValue() {
        assertEquals("1,,a", Js.str(new JSONArray().put(1).put(JSONObject.NULL).put("a")));
        assertEquals("[object Object]", Js.str(new JSONObject()));
        assertEquals("null", Js.str(JSONObject.NULL));
        assertEquals("undefined", Js.str(null));
        assertEquals("true", Js.str(true));
    }

    @Test
    public void jsonAsJsonStringifyWritesIt() throws Exception {
        assertEquals("{\"a\":\"x/y\\\"\\\\\\n\\u0001\u2028é\"}", Js.stringify(new JSONObject().put("a", "x/y\"\\\n\u0001\u2028é")));
        assertEquals("[1,2.5,null,true,{}]", Js.stringify(new JSONArray("[1,2.5,null,true,{}]")));
        assertEquals("\"\\ud800x\"", Js.stringify("\ud800x"));
        assertEquals("\"😀\"", Js.stringify("😀"));
        assertEquals("[\n  1,\n  [\n    {\n      \"k\": []\n    }\n  ]\n]", Js.stringify(new JSONArray("[1,[{\"k\":[]}]]"), 2));
        assertEquals("{}", Js.stringify(new JSONObject(), 2));
    }

    @Test
    public void plainDataAndParsing() throws Exception {
        assertNull(Js.plain(null, 10));
        assertNull(Js.plain("0123456789", 5));
        assertEquals(JSONObject.NULL, Js.plain(JSONObject.NULL, 10));
        assertEquals("x", Js.parse(" \"x\" "));
        try { Js.parse("{} x"); throw new AssertionError("trailing text"); } catch (org.json.JSONException expected) { }
        assertEquals("a b", Js.trim("\u00A0\ufeff a b\u2028\n"));
    }
}
