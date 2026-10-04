package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

/**
 * 6.8: "Send another way" as options of the messages (chat/SendPlan) — the
 * sheet's send.option switches them in the composer's form, Send decides
 * what happens with the field: text with its kinds, the text spoken as a
 * voice message, or dictation first with an empty field; "as voice" and
 * "speak it, send text" exclude each other; an empty code is a random one; a
 * voice made of the text takes only that text out of the field.
 */
public class SendPlanTest {
    private static Map<String, Object> form() { return new HashMap<>(); }
    private static boolean apply(Map<String, Object> f, String arg) { return SendPlan.apply(f, arg, 60, () -> "ABCD-EFGH-JKMN"); }

    @Test public void nothingOnSendsTheTextAsItIs() {
        SendPlan p = SendPlan.of(form());
        assertEquals(SendPlan.Step.TEXT, p.step(true, false));
        assertEquals(SendPlan.Step.NONE, p.step(false, false));
        assertEquals(0, p.count());
        assertFalse(p.sealed());
        assertNull(p.sealCode);
    }

    @Test public void asVoiceSpeaksTheTextOrDictatesFirst() {
        Map<String, Object> f = form();
        assertTrue(apply(f, "asVoice"));
        SendPlan p = SendPlan.of(f);
        assertTrue(p.asVoice);
        assertEquals(SendPlan.Step.SPEAK, p.step(true, false));
        assertEquals(SendPlan.Step.DICTATE_SPEAK, p.step(false, false));
        // An earlier one is still being spoken: the text waits in the field.
        assertEquals(SendPlan.Step.WAIT, p.step(true, true));
    }

    @Test public void speakItSendTextDictatesOnlyWithAnEmptyField() {
        Map<String, Object> f = form();
        apply(f, "voiceText");
        SendPlan p = SendPlan.of(f);
        assertEquals(SendPlan.Step.DICTATE_TEXT, p.step(false, false));
        assertEquals(SendPlan.Step.TEXT, p.step(true, false)); // a typed text goes at once
        assertEquals(SendPlan.Step.WAIT, p.step(false, true));
    }

    @Test public void theTwoVoiceOptionsExcludeEachOther() {
        Map<String, Object> f = form();
        apply(f, "asVoice");
        apply(f, "voiceText");
        SendPlan p = SendPlan.of(f);
        assertTrue(p.voiceText);
        assertFalse(p.asVoice);
        apply(f, "asVoice");
        p = SendPlan.of(f);
        assertTrue(p.asVoice);
        assertFalse(p.voiceText);
        assertFalse(f.containsKey(SendPlan.VOICE_TEXT));
        // Both in a form (an older state): "as voice" wins.
        Map<String, Object> both = form();
        both.put(SendPlan.AS_VOICE, true);
        both.put(SendPlan.VOICE_TEXT, true);
        assertFalse(SendPlan.of(both).voiceText);
        assertEquals(1, SendPlan.of(both).count());
    }

    @Test public void tappingAnOptionAgainTurnsItOff() {
        Map<String, Object> f = form();
        for (String o : new String[]{"asVoice", "voiceText", "tap", "vanish", "seal"}) {
            apply(f, o);
            apply(f, o);
        }
        assertTrue(f.isEmpty());
    }

    @Test public void theKindsCombine() {
        Map<String, Object> f = form();
        apply(f, "tap");
        apply(f, "vanish");
        apply(f, "seal");
        apply(f, "asVoice");
        SendPlan p = SendPlan.of(f);
        assertTrue(p.tap);
        assertEquals(60, p.vanishSeconds); // the messages' vanishing time
        assertEquals("", p.sealCode); // on, a random code when sent
        assertEquals(4, p.count());
    }

    @Test public void vanishTakesItsTime() {
        Map<String, Object> f = form();
        apply(f, "vanish:300");
        assertEquals(300, SendPlan.of(f).vanishSeconds);
        f.put(SendPlan.VANISH, "15"); // the select stores what it shows
        assertEquals(15, SendPlan.of(f).vanishSeconds);
        apply(f, "vanish:0");
        assertFalse(f.containsKey(SendPlan.VANISH));
        Map<String, Object> g = form();
        SendPlan.apply(g, "vanish", 0, () -> ""); // no time in the settings: 15 s, as on the web
        assertEquals(15, SendPlan.of(g).vanishSeconds);
    }

    @Test public void theCodeIsTypedOrMadeUpAndEmptyMeansRandom() {
        Map<String, Object> f = form();
        apply(f, "seal");
        assertEquals("", SendPlan.of(f).sealCode);
        f.put(SendPlan.SEAL, "  moje-tajne  "); // typed in the field
        assertEquals("moje-tajne", SendPlan.of(f).sealCode);
        f.put(SendPlan.SEAL, " - - "); // only dashes and spaces: no code at all, so a random one
        assertEquals("", SendPlan.of(f).sealCode);
        apply(f, "newCode");
        assertEquals("ABCD-EFGH-JKMN", SendPlan.of(f).sealCode);
        apply(f, "seal:XYZ");
        assertEquals("XYZ", SendPlan.of(f).sealCode);
    }

    @Test public void noneTurnsAllOffButKeepsTheRecipients() {
        Map<String, Object> f = form();
        f.put("msgTo", java.util.Collections.singletonList("peer-1"));
        apply(f, "asVoice");
        apply(f, "tap");
        apply(f, "newCode");
        assertTrue(apply(f, "none"));
        assertEquals(0, SendPlan.of(f).count());
        assertTrue(f.containsKey("msgTo"));
        assertFalse(apply(f, "nonsense"));
    }

    @Test public void aVoiceMadeOfTheTextTakesOnlyThatTextOut() {
        assertEquals("", SendPlan.leftover("Ahoj ", "Ahoj"));
        assertEquals("", SendPlan.leftover("whatever", null));
        // Dictation that sends at once put the next words there meanwhile.
        assertEquals("a dál", SendPlan.leftover("Ahoj a dál", "Ahoj"));
        assertEquals("něco jiného", SendPlan.leftover("něco jiného", "Ahoj"));
        assertEquals("text", SendPlan.leftover("text", ""));
    }
}
