package cz.m5cet.app.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

import cz.m5cet.app.InteropTest;

/** Notification templates (6.7): the shared vectors (test/fixtures/notify-templates.json), privacy, quiet hours, channel order. */
public class NotifyTemplateTest {
    private static JSONObject v;

    @BeforeClass
    public static void load() throws Exception {
        v = new JSONObject(new String(Files.readAllBytes(InteropTest.fixtures().resolve("notify-templates.json")), StandardCharsets.UTF_8));
    }

    private static Map<String, String> vars(JSONObject o) throws Exception {
        Map<String, String> m = new HashMap<>();
        for (Iterator<String> it = o.keys(); it.hasNext(); ) { String k = it.next(); m.put(k, o.optString(k)); }
        return m;
    }

    @Test
    public void everySharedCaseRendersAsOnTheServerAndTheWeb() throws Exception {
        JSONArray cases = v.getJSONArray("cases");
        assertTrue(cases.length() > 20);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            String got = NotifyTemplate.render(c.getString("template"), NotifyTemplate.visibleVars(vars(c.getJSONObject("vars")), c.getString("privacy")), NotifyTemplate.BODY_MAX);
            assertEquals(c.getString("template") + " @" + c.getString("privacy"), c.getString("text"), got);
        }
    }

    @Test
    public void everyDefaultTemplateInEveryLanguage() throws Exception {
        JSONArray list = v.getJSONArray("notifications");
        for (int i = 0; i < list.length(); i++) {
            JSONObject n = list.getJSONObject(i);
            String[] tb = NotifyTemplate.notification(n.getString("title"), n.getString("body"), vars(n.getJSONObject("vars")), n.getString("privacy"));
            assertEquals(n.getString("kind") + "/" + n.getString("lang"), n.getJSONObject("expect").getString("title"), tb[0]);
            assertEquals(n.getString("kind") + "/" + n.getString("lang"), n.getJSONObject("expect").getString("body"), tb[1]);
        }
    }

    @Test
    public void privacyLevels() {
        assertEquals("room", NotifyTemplate.min("content", "room"));
        assertEquals("neutral", NotifyTemplate.min("sender", "neutral"));
        assertEquals("neutral", NotifyTemplate.min("whatever", "content"));
        assertFalse(NotifyTemplate.visible("sender", "neutral"));
        assertTrue(NotifyTemplate.visible("sender", "sender"));
        assertFalse(NotifyTemplate.visible("room", "sender"));
        assertTrue(NotifyTemplate.visible("room", "room"));
        assertFalse(NotifyTemplate.visible("preview", "room"));
        assertTrue(NotifyTemplate.visible("preview", "content"));
        assertTrue(NotifyTemplate.visible("app", "neutral"));
        assertFalse(NotifyTemplate.visible("nonsense", "content"));
    }

    @Test
    public void quietHoursAcrossMidnight() {
        long at = java.time.ZonedDateTime.of(2026, 10, 4, 22, 30, 0, 0, java.time.ZoneId.of("UTC")).toInstant().toEpochMilli();
        assertTrue(NotifyTemplate.inQuietHours(true, "22:00", "07:00", "UTC", at));
        assertFalse(NotifyTemplate.inQuietHours(true, "08:00", "17:00", "UTC", at));
        assertTrue(NotifyTemplate.inQuietHours(true, "00:00", "01:00", "Europe/Prague", at)); // 00:30 there
        assertFalse(NotifyTemplate.inQuietHours(false, "22:00", "07:00", "UTC", at));
        assertFalse(NotifyTemplate.inQuietHours(true, "25:00", "07:00", "UTC", at));
        assertFalse(NotifyTemplate.inQuietHours(true, "07:00", "07:00", "UTC", at));
    }

    @Test
    public void channelOrder() {
        assertEquals(Arrays.asList("webpush", "android"), NotifyTemplate.order("webpush, sms ,android,webpush"));
        assertEquals("webpush,android,email", NotifyTemplate.move("android,webpush,email", "webpush", -1));
        assertEquals("android,email,webpush", NotifyTemplate.move("android,webpush,email", "webpush", 1));
        assertEquals("android,webpush,email", NotifyTemplate.move("android,webpush,email", "android", -1));
        assertEquals("android,email", NotifyTemplate.use("android,webpush,email", "webpush", false));
        assertEquals("android,email,webpush", NotifyTemplate.use("android,email", "webpush", true));
        assertEquals("android,email", NotifyTemplate.use("android,email", "pigeon", true));
    }

    @Test
    public void cleaning() {
        assertEquals("Evegnp.exe Bcc: x", NotifyTemplate.clean("Eve\u202e\u2066gnp.exe\r\nBcc: x\u0000\u200b", 64));
        assertEquals("abc…", NotifyTemplate.clean("abcdefgh", 4));
        assertEquals("", NotifyTemplate.clean(null, 10));
    }
}
