package cz.m5cet.app.p4;

import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Iterator;
import java.util.TreeSet;

import cz.m5cet.app.InteropTest;

/** test/vectors/p4.json (script/gen-p4-vectors.ts, the web reference) and a JSON deep-equality that ignores key order. */
final class Vectors {
    private Vectors() {}

    private static JSONObject v;

    static synchronized JSONObject get() throws Exception {
        if (v == null) {
            java.nio.file.Path file = InteropTest.fixtures().getParent().resolve("vectors").resolve("p4.json");
            v = new JSONObject(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
        }
        return v;
    }

    static String text(byte[] b) { return new String(b, StandardCharsets.UTF_8); }

    static byte[] bytes(int n, java.util.function.IntUnaryOperator f) {
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) out[i] = (byte) (f.applyAsInt(i) & 0xff);
        return out;
    }

    /** A copy of `o` without `field`. */
    static JSONObject without(JSONObject o, String field) throws Exception {
        JSONObject c = new JSONObject(o.toString());
        c.remove(field);
        return c;
    }

    static void assertJson(String where, Object expected, Object actual) {
        String diff = diff("", expected, actual);
        if (diff != null) fail(where + ": " + diff);
    }

    static boolean same(Object a, Object b) { return diff("", a, b) == null; }

    private static String diff(String path, Object a, Object b) {
        if (a == null) a = JSONObject.NULL;
        if (b == null) b = JSONObject.NULL;
        if (a instanceof Number && b instanceof Number) {
            return new BigDecimal(a.toString()).compareTo(new BigDecimal(b.toString())) == 0 ? null : path + ": " + a + " != " + b;
        }
        if (a instanceof JSONObject && b instanceof JSONObject) {
            JSONObject x = (JSONObject) a, y = (JSONObject) b;
            TreeSet<String> keys = new TreeSet<>();
            for (Iterator<String> it = x.keys(); it.hasNext(); ) keys.add(it.next());
            for (Iterator<String> it = y.keys(); it.hasNext(); ) keys.add(it.next());
            for (String k : keys) {
                if (!x.has(k) || !y.has(k)) return path + "." + k + ": only on one side";
                String d = diff(path + "." + k, x.opt(k), y.opt(k));
                if (d != null) return d;
            }
            return null;
        }
        if (a instanceof JSONArray && b instanceof JSONArray) {
            JSONArray x = (JSONArray) a, y = (JSONArray) b;
            if (x.length() != y.length()) return path + ": lengths " + x.length() + " != " + y.length();
            for (int i = 0; i < x.length(); i++) {
                String d = diff(path + "[" + i + "]", x.opt(i), y.opt(i));
                if (d != null) return d;
            }
            return null;
        }
        return a.equals(b) ? null : path + ": " + a + " != " + b;
    }
}
