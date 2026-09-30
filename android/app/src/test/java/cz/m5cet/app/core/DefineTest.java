package cz.m5cet.app.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;

/**
 * Define parses the server's already-materialised values and exposes them
 * typed; a script value is handed back untouched, and a failed fetch keeps
 * the cached copy. All JVM, no network, no vault (the package-private test
 * seam: {@code new Define(Fetcher)} and {@code apply(JSONObject)}).
 */
public class DefineTest {

    /** A materialised answer as the server sends it: name → plain typed value. */
    private static JSONObject answer() throws Exception {
        JSONObject values = new JSONObject()
            .put("appName", "M5cet")                         // string
            .put("maxPeers", 8)                              // number
            .put("betaEnabled", true)                        // boolean
            .put("masterKey", "a1b2c3d4")                    // bytes → hex string
            .put("limits", new JSONObject().put("rooms", 20).put("msgKb", 512)) // nested object
            .put("apduTemplates", new JSONArray().put("00A40400").put("80CA9F17")) // nested array
            .put("greeter", new JSONObject()                 // a script value
                .put("__m5script", true)
                .put("code", "return 'ahoj ' + name")
                .put("lang", "js"));
        return new JSONObject().put("ok", true).put("values", values).put("updatedAt", 1727654400000L);
    }

    private static Define seeded() throws Exception {
        Define d = new Define((Define.Fetcher) null);
        assertTrue("a well-formed answer is adopted", d.apply(answer()));
        return d;
    }

    @Test
    public void typedAccessors() throws Exception {
        Define d = seeded();
        assertEquals("M5cet", d.str("appName"));
        assertEquals(8.0, d.num("maxPeers"), 1e-9);
        assertTrue(d.bool("betaEnabled"));
        assertEquals("a1b2c3d4", d.str("masterKey"));
        assertEquals(1727654400000L, d.updatedAt());

        JSONObject limits = d.obj("limits");
        assertEquals(20, limits.getInt("rooms"));
        assertEquals(512, limits.getInt("msgKb"));

        JSONArray apdu = d.arr("apduTemplates");
        assertEquals(2, apdu.length());
        assertEquals("00A40400", apdu.getString(0));

        // all() carries every name
        assertTrue(d.all().has("appName"));
        assertTrue(d.all().has("greeter"));
    }

    @Test
    public void getReturnsRawAndMissingIsNull() throws Exception {
        Define d = seeded();
        assertEquals("M5cet", d.get("appName"));
        assertTrue(d.get("limits") instanceof JSONObject);
        assertNull("an unknown name is null", d.get("nope"));
        assertEquals("", d.str("nope"));
        assertEquals(0.0, d.num("nope"), 1e-9);
        assertFalse(d.bool("nope"));
        assertNull(d.obj("nope"));
        assertNull(d.arr("nope"));
    }

    @Test
    public void scriptValueComesBackAsIsNotExecuted() throws Exception {
        Define d = seeded();
        Object raw = d.get("greeter");
        assertTrue("a script is a plain object", raw instanceof JSONObject);
        JSONObject script = d.obj("greeter");
        assertTrue(script.getBoolean("__m5script"));
        assertEquals("js", script.getString("lang"));
        assertEquals("return 'ahoj ' + name", script.getString("code")); // kept verbatim, never run
        assertSame("obj() and get() are the same object", raw, script);
    }

    @Test
    public void invalidAnswersAreIgnored() throws Exception {
        Define d = seeded();
        JSONObject before = d.all();
        assertFalse(d.apply(null));
        assertFalse(d.apply(new JSONObject()));                                 // no ok
        assertFalse(d.apply(new JSONObject().put("ok", false).put("values", new JSONObject()))); // ok=false
        assertFalse(d.apply(new JSONObject().put("ok", true)));                 // no values
        assertSame("the cached values are untouched", before, d.all());
        assertEquals("M5cet", d.str("appName"));
    }

    @Test
    public void refreshCachesOnSuccess() throws Exception {
        Define d = new Define(DefineTest::answer); // fetcher yields a good answer
        assertTrue(d.refresh());
        assertEquals("M5cet", d.str("appName"));
        assertEquals(8.0, d.num("maxPeers"), 1e-9);
    }

    @Test
    public void refreshFallsBackToCacheWhenFetchFails() throws Exception {
        // seed a good copy through a first, working fetch
        final boolean[] fail = {false};
        Define d = new Define(() -> {
            if (fail[0]) throw new IOException("offline");
            return answer();
        });
        assertTrue(d.refresh());
        assertEquals("M5cet", d.str("appName"));

        // now the network is down: refresh reports failure but the cache stays
        fail[0] = true;
        JSONObject cached = d.all();
        assertFalse(d.refresh());
        assertSame("the last good values survive a failed fetch", cached, d.all());
        assertEquals("M5cet", d.str("appName"));
        assertEquals(8.0, d.num("maxPeers"), 1e-9);
        assertEquals(1727654400000L, d.updatedAt());
    }

    @Test
    public void refreshWithoutAFetcherIsANoOp() {
        Define d = new Define((Define.Fetcher) null);
        assertFalse(d.refresh());
        assertEquals(0, d.all().length());
    }
}
