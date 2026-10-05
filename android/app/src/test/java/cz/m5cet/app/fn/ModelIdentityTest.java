package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * 6.11: a model's identity as the sender of its answers — the vectors of
 * system-messenger-vectors.json, which test/android-fn-611.test.ts checks
 * against client/src/lib/system-messenger.ts (the same colours on both).
 */
public class ModelIdentityTest {
    static JSONObject vectors() {
        try (InputStream in = ModelIdentityTest.class.getResourceAsStream("system-messenger-vectors.json")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    @Test public void theSameColourAsTheWeb() throws Exception {
        JSONObject colors = vectors().getJSONObject("colors");
        for (Iterator<String> it = colors.keys(); it.hasNext(); ) {
            String k = it.next();
            assertEquals(k, colors.getString(k), ModelIdentity.modelColor(k));
        }
        // The vectors the task names, spelled out.
        assertEquals("#36b234", ModelIdentity.modelColor("mail"));
        assertEquals("#7bb234", ModelIdentity.modelColor("hlr"));
        assertEquals("#34b234", ModelIdentity.modelColor("x"));
    }

    @Test public void theSameIdentityAsTheWeb() throws Exception {
        JSONArray ids = vectors().getJSONArray("identities");
        for (int i = 0; i < ids.length(); i++) {
            JSONObject in = ids.getJSONObject(i).getJSONObject("in"), out = ids.getJSONObject(i).getJSONObject("out");
            ModelIdentity id = ModelIdentity.of(in.getString("keyword"), in.getString("name"), in.optString("icon", null));
            assertEquals(out.getString("keyword"), id.keyword);
            assertEquals(out.getString("name"), id.name);
            assertEquals(out.getString("icon"), id.icon);
            assertEquals(out.getString("color"), id.color);
        }
    }

    @Test public void fromACommandAndBackThroughTheFlags() throws Exception {
        Command c = new Command("mail", "E-mail", "", "server", "caller", true, null, null, null, null, "");
        ModelIdentity id = ModelIdentity.of(c);
        assertEquals("mail", id.icon);
        assertTrue(id.lucide());
        assertEquals(0xFF36b234, id.argb());
        JSONObject j = id.toJson();
        assertEquals(3, j.length());
        assertEquals("mail", j.getString("keyword"));
        assertEquals("E-mail", j.getString("name"));
        assertEquals("mail", j.getString("icon"));
        ModelIdentity back = ModelIdentity.fromJson(j);
        assertEquals(id.keyword, back.keyword);
        assertEquals(id.color, back.color);
        assertNull(ModelIdentity.fromJson(new JSONObject().put("name", "x")));
        assertNull(ModelIdentity.fromJson(new JSONObject().put("keyword", "bad keyword")));
        // A peer's icon that is no lucide name and no emoji: the keyword's instead.
        assertEquals("mail", ModelIdentity.fromJson(new JSONObject().put("keyword", "mail").put("icon", "<img src=x>")).icon);
        assertEquals("🦊", ModelIdentity.fromJson(new JSONObject().put("keyword", "fox").put("icon", "🦊")).icon);
        assertFalse(ModelIdentity.fromJson(new JSONObject().put("keyword", "fox").put("icon", "🦊")).lucide());
    }

    @Test public void anIconAPeerMaySend() throws Exception {
        assertEquals("phone", ModelIdentity.safeIcon("phone"));
        assertEquals("phone-call", ModelIdentity.safeIcon(" phone-call "));
        assertEquals("🦊", ModelIdentity.safeIcon("🦊"));
        assertEquals("👩‍💻", ModelIdentity.safeIcon("👩‍💻"));
        assertEquals("🇨🇿", ModelIdentity.safeIcon("🇨🇿"));
        assertNull(ModelIdentity.safeIcon("Phone"));          // not a lucide name, has letters
        assertNull(ModelIdentity.safeIcon("a b"));
        assertNull(ModelIdentity.safeIcon("<b>"));
        assertNull(ModelIdentity.safeIcon("🦊🦊🦊🦊🦊🦊🦊🦊🦊"));    // too long for one emoji
        assertNull(ModelIdentity.safeIcon(""));
        assertNull(ModelIdentity.safeIcon(42));
        assertNull(ModelIdentity.safeIcon(null));
        assertNull(ModelIdentity.safeIcon("\u0007"));
    }

    @Test public void theAppsOwnSendersArentAPeers() throws Exception {
        assertTrue(ModelIdentity.reservedSender("system-messenger"));
        assertTrue(ModelIdentity.reservedSender("function:mail"));
        assertTrue(ModelIdentity.reservedSender("system-messenger:mail"));
        assertFalse(ModelIdentity.reservedSender("peer-1"));
        assertFalse(ModelIdentity.reservedSender(null));
        assertEquals(30_000, ModelIdentity.FN_RUN_TIMEOUT_MS);
        assertEquals("system-messenger", ModelIdentity.SYSTEM_MESSENGER_ID);
    }

    @Test public void aPeersFlagsKeepTheIconAndTheMessageCarriesIt() throws Exception {
        JSONObject meta = Run.meta(new JSONObject().put("keyword", "hlr").put("name", "HLR").put("icon", "phone").put("chain", "chn_abcdef12"));
        assertEquals("phone", meta.getString("icon"));
        assertFalse(Run.meta(new JSONObject().put("keyword", "hlr").put("icon", "javascript:alert(1)")).has("icon"));
        Run.Done d = new Run.Done(new JSONObject().put("runId", "r1").put("status", "ok").put("keyword", "hlr").put("name", "HLR")
            .put("outputs", new JSONArray().put(new JSONObject().put("type", "text").put("text", "ok"))));
        Run.Message m = d.message("hlr", "HLR", "room", "radar");
        assertEquals("radar", m.fn.getString("icon"));
        assertEquals("radar", m.local.getString("icon"));
        assertFalse(d.message("hlr", "HLR", "room").fn.has("icon"));
        // The server's own icon wins over the command's.
        Run.Done d2 = new Run.Done(new JSONObject().put("keyword", "hlr").put("icon", "phone").put("outputs", new JSONArray()));
        assertEquals("phone", d2.message("hlr", "HLR", "room", "radar").fn.getString("icon"));
    }
}
