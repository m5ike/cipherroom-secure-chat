package cz.m5cet.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import cz.m5cet.app.ui.Expr;

/** The shared vectors of the screens' language (test/fixtures/android-expr.json). */
public class ExprTest {
    static JSONObject v;
    static Expr.Scope scope;
    static Expr.Translate tr;

    @BeforeClass
    public static void load() throws Exception {
        v = new JSONObject(new String(Files.readAllBytes(InteropTest.fixtures().resolve("android-expr.json")), StandardCharsets.UTF_8));
        JSONObject s = v.getJSONObject("scope");
        scope = s::opt;
        JSONObject strings = v.getJSONObject("strings");
        tr = (k) -> strings.optString(k, k);
    }

    private static void same(String src, Object expected, Object actual) {
        if (expected == JSONObject.NULL) expected = null;
        if (expected instanceof Number && actual instanceof Number) {
            assertEquals(src, ((Number) expected).doubleValue(), ((Number) actual).doubleValue(), 1e-9);
        } else {
            assertEquals(src, expected, actual);
        }
    }

    @Test
    public void expressions() throws Exception {
        JSONArray list = v.getJSONArray("expressions");
        for (int i = 0; i < list.length(); i++) {
            JSONObject c = list.getJSONObject(i);
            same(c.getString("src"), c.get("value"), Expr.eval(c.getString("src"), scope, tr));
        }
    }

    @Test
    public void templates() throws Exception {
        JSONArray list = v.getJSONArray("templates");
        for (int i = 0; i < list.length(); i++) {
            JSONObject c = list.getJSONObject(i);
            assertEquals(c.getString("src"), c.getString("text"), Expr.render(c.getString("src"), scope, tr));
        }
    }

    @Test
    public void invalid() throws Exception {
        JSONObject inv = v.getJSONObject("invalid");
        JSONArray e = inv.getJSONArray("expressions");
        for (int i = 0; i < e.length(); i++) assertNotNull(e.getString(i), Expr.check(e.getString(i)));
        JSONArray t = inv.getJSONArray("templates");
        for (int i = 0; i < t.length(); i++) assertNotNull(t.getString(i), Expr.checkTemplate(t.getString(i)));
    }
}
