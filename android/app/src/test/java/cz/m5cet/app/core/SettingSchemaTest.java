package cz.m5cet.app.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Map;

import cz.m5cet.app.voice.VoiceFx;

/** 6.10 (G-20, G-21): what a setting may hold, and which ones a design's action never changes (core/SettingSchema). */
public class SettingSchemaTest {
    private static boolean ok(String key, Object value) {
        Object v = Settings.coerce(Settings.DEFAULTS.get(key), value);
        return v != null && SettingSchema.valid(key, v);
    }

    @Test
    public void everyDefaultFitsItsRuleAndEveryKeyHasOne() {
        for (Map.Entry<String, Object> e : Settings.DEFAULTS.entrySet()) {
            assertTrue(e.getKey() + " = " + e.getValue(), SettingSchema.valid(e.getKey(), e.getValue()));
            if (!(e.getValue() instanceof Boolean)) assertTrue("no rule for " + e.getKey(), SettingSchema.ruled().contains(e.getKey()));
        }
        for (String k : SettingSchema.ruled()) assertTrue("a rule for a setting that does not exist: " + k, Settings.DEFAULTS.containsKey(k));
    }

    @Test
    public void aDesignsTextCannotHideInATextSetting() {
        // G-20: notify.* is sent to the server within seconds (PUT /api/account/notify).
        assertTrue(ok("notify.quietFrom", "22:00"));
        assertTrue(ok("notify.quietTo", "07:30"));
        assertFalse(ok("notify.quietFrom", "the secret plaintext"));
        assertFalse(ok("notify.quietFrom", "24:00"));
        assertFalse(ok("notify.quietFrom", "22:00 and more"));
        assertFalse(ok("notify.quietFrom", "7:00"));
        assertTrue(ok("notify.order", "android,webpush,email"));
        assertTrue(ok("notify.order", "email"));
        assertTrue(ok("notify.order", ""));
        assertFalse(ok("notify.order", "sms"));
        assertFalse(ok("notify.order", "android,webpush,email,android"));
        assertFalse(ok("notify.order", "android,secret"));
        assertTrue(ok("notify.privacy", ""));
        assertTrue(ok("notify.privacy", "content"));
        assertFalse(ok("notify.privacy", "everything"));
        assertTrue(ok("voice.lang", ""));
        assertTrue(ok("voice.lang", "cs"));
        assertTrue(ok("voice.lang", "pt-BR"));
        assertFalse(ok("voice.lang", "cs-the-secret"));
        assertFalse(ok("voice.lang", "hello world"));
        assertFalse(ok("voice.voice", "x‮y"));
        assertFalse(ok("voice.voice", "line\nbreak"));
        assertTrue(ok("voice.voice", "cs-cz-x-jfs-local"));
        assertFalse(ok("appearance.accent", "#12345"));
        assertTrue(ok("appearance.accent", "#1e88e5"));
        assertTrue(ok("appearance.accent", "violet"));
        assertFalse(ok("appearance.preset", "Ocean Blue"));
        assertFalse(ok("look.font", "comic"));
    }

    @Test
    public void numbersStayInTheirRange() {
        assertTrue(ok("voice.rate", "1.2"));
        assertTrue(ok("voice.rate", 2.0));
        assertFalse(ok("voice.rate", 99));
        assertFalse(ok("voice.rate", "NaN"));
        assertFalse(ok("voice.rate", "Infinity"));
        assertFalse(ok("location.interval", 1));
        assertTrue(ok("location.interval", "900"));
        assertTrue(ok("messages.ttlMinutes", 0));
        assertFalse(ok("messages.ttlMinutes", -1));
        assertTrue(ok("voiceFx.pitch", -12));
        assertFalse(ok("voiceFx.echo", 2));
        assertFalse(ok("look.speed", "fast"));
    }

    @Test
    public void whatTheDesignsChoicesOfferIsAllowed() {
        // server/android/design-61.ts, -62-look.ts, -67-voice.ts, -68-calllog.ts
        for (String v : new String[]{ "", "cs", "en", "de", "sk", "pl", "fr", "es", "it" }) assertTrue(v, ok("voice.lang", v));
        for (String v : new String[]{ "4", "15", "60", "300", "1800", "3600", "7200" }) assertTrue(v, ok("messages.vanishSeconds", v));
        for (String v : new String[]{ "0", "60", "1440", "10080" }) assertTrue(v, ok("messages.ttlMinutes", v));
        for (String v : new String[]{ "15", "60", "300", "900" }) assertTrue(v, ok("location.interval", v));
        for (String v : new String[]{ "", "red", "orange", "green", "blue", "violet" }) assertTrue(v, ok("appearance.accent", v));
        for (String v : new String[]{ "0.85", "1", "1.15", "1.3", "1.5", "0.8" }) assertTrue(v, ok("appearance.fontScale", v));
        for (String v : new String[]{ "", "sans", "serif", "mono", "condensed", "medium", "light", "casual", "cursive" }) assertTrue(v, ok("look.font", v));
        for (String v : new String[]{ "design", "motorsport", "midnight", "nord" }) assertTrue(v, ok("appearance.preset", v));
        for (String v : new String[]{ "app", "room", "people" }) assertTrue(v, ok("calls.logName", v));
        for (String v : VoiceFx.PRESET_IDS) assertTrue(v, ok("voiceFx.preset", v));
        for (int h = 0; h < 48; h++) assertTrue(ok("notify.quietFrom", String.format(java.util.Locale.ROOT, "%02d:%s", h / 2, h % 2 == 0 ? "00" : "30")));
        // The NFC workbench's key list as the user types it.
        assertTrue(ok("nfc.keyDictionary", "A0A1A2A3A4A5\nD3:F7:D3:F7:D3:F7, FFFFFFFFFFFF # factory"));
        assertFalse(ok("nfc.keyDictionary", "A0A1A2A3A4A5​"));
    }

    @Test
    public void privacyKeysAreOutOfTheDesignsReach() {
        // G-21: what widens what leaves the phone or who sees it.
        for (String k : new String[]{ "callLog", "calls.logName", "calls.history", "conversations.on", "conversations.names", "notify.privacy",
            "notify.quietFrom", "notify.order", "notify.away", "voice.engine", "voice.autoplay", "voice.dictateSend", "location.track",
            "location.inHeader", "location.precise", "nfc.emulate", "nfc.keyDictionary", "messages.receipts", "messages.readReceipts",
            "people.contacts", "security.shufflePin" }) assertTrue(k, SettingSchema.privacy(k));
        for (String k : new String[]{ "voice.rate", "voice.lang", "appearance.tone", "look.font", "look.variant", "messages.enterSends", "voiceFx.preset", "nfc.reader" })
            assertFalse(k, SettingSchema.privacy(k));
        assertTrue("no key: kept", SettingSchema.privacy(null));
    }

    @Test
    public void aWrongTypeIsNoValue() {
        assertNull(Settings.coerce(true, "maybe"));
        assertNull(Settings.coerce(1.0, "one"));
        assertFalse(SettingSchema.valid("voice.rate", "1.0"));
        assertFalse(SettingSchema.valid("voice.lang", 1.0));
        assertFalse(SettingSchema.valid("voice.lang", null));
        assertTrue(SettingSchema.valid("messages.enterSends", true));
        assertEquals(200, ((String) Settings.coerce("", new String(new char[500]).replace('\0', 'a'))).length());
    }
}
