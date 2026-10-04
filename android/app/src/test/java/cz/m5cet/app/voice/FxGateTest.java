package cz.m5cet.app.voice;

import static org.junit.Assert.assertEquals;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.InteropTest;

/**
 * 6.7: the operator's gate for the voice changer decides like the web's
 * modules.ts (decide() of a module that is off by default) — the fixture's
 * cases, which test/voice-fx.test.ts runs through the web's own code.
 */
public class FxGateTest {
    @Test public void decidesLikeTheWeb() throws Exception {
        JSONObject fix = new JSONObject(new String(Files.readAllBytes(InteropTest.fixtures().resolve("voice-fx.json")), StandardCharsets.UTF_8));
        JSONArray cases = fix.getJSONArray("gate");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            JSONObject modules = new JSONObject();
            if (!c.isNull("rule")) modules.put(FxGate.MODULE, c.getJSONObject("rule"));
            List<String> groups = new ArrayList<>();
            JSONArray g = c.getJSONArray("groups");
            for (int j = 0; j < g.length(); j++) groups.add(g.getString(j));
            assertEquals(c.getString("about"), c.getBoolean("allowed"), FxGate.allowed(modules, FxGate.MODULE, groups));
        }
    }

    @Test public void aRuleAsTheServerSanitisesIt() throws Exception {
        List<String> user = new ArrayList<>();
        user.add("user");
        // enabled is anything but false; the access words fall back like sanitizeModules.
        assertEquals(true, FxGate.allowed(new JSONObject().put(FxGate.MODULE, new JSONObject()), FxGate.MODULE, user));
        assertEquals(false, FxGate.allowed(new JSONObject().put(FxGate.MODULE, new JSONObject().put("enabled", false)), FxGate.MODULE, user));
        assertEquals(false, FxGate.allowed(new JSONObject().put(FxGate.MODULE, new JSONObject().put("groups", new JSONArray().put("staff"))), FxGate.MODULE, user));
        assertEquals(false, FxGate.allowed(null, FxGate.MODULE, user));
    }
}
