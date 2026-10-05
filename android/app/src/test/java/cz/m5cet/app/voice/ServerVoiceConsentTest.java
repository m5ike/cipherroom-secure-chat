package cz.m5cet.app.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * 6.12 (security analysis G-14): voice.engine = server — the first voice
 * message (or server dictation) in a room asks, naming the speech provider;
 * a no sends nothing and asks again next time; a lock forgets the yeses.
 */
public class ServerVoiceConsentTest {
    private final List<String> asked = new ArrayList<>();
    private final List<Boolean> results = new ArrayList<>();

    private ServerVoiceConsent.Ask answering(boolean yes) {
        return (use, provider, answer) -> { asked.add(use + ":" + provider); answer.accept(yes); };
    }

    @Before public void clear() { ServerVoiceConsent.reset(); }

    @Test
    public void askedOncePerRoomNamingTheProvider() {
        ServerVoiceConsent.check("room-a", ServerVoiceConsent.Use.SPEAK, "Piper (cs)", answering(true), results::add);
        ServerVoiceConsent.check("room-a", ServerVoiceConsent.Use.SPEAK, "Piper (cs)", answering(true), results::add);
        assertEquals(List.of("SPEAK:Piper (cs)"), asked);
        assertEquals(List.of(true, true), results);
        assertTrue(ServerVoiceConsent.given("room-a", ServerVoiceConsent.Use.SPEAK));
        // Another room, and the other use (a recording to transcribe), ask again.
        ServerVoiceConsent.check("room-b", ServerVoiceConsent.Use.SPEAK, "Cloud TTS", answering(true), results::add);
        ServerVoiceConsent.check("room-a", ServerVoiceConsent.Use.TRANSCRIBE, "Whisper", answering(true), results::add);
        assertEquals(List.of("SPEAK:Piper (cs)", "SPEAK:Cloud TTS", "TRANSCRIBE:Whisper"), asked);
    }

    @Test
    public void aNoSendsNothingAndIsNotRemembered() {
        ServerVoiceConsent.check("room-a", ServerVoiceConsent.Use.SPEAK, "Cloud TTS", answering(false), results::add);
        assertEquals(List.of(false), results);
        assertFalse(ServerVoiceConsent.given("room-a", ServerVoiceConsent.Use.SPEAK));
        ServerVoiceConsent.check("room-a", ServerVoiceConsent.Use.SPEAK, "Cloud TTS", answering(true), results::add);
        assertEquals(2, asked.size());
        // No one to ask (no screen): no.
        ServerVoiceConsent.check("room-c", ServerVoiceConsent.Use.SPEAK, "x", null, results::add);
        assertEquals(List.of(false, true, false), results);
        // An unnamed provider is still asked about (as "?"), never silently.
        ServerVoiceConsent.check("room-d", ServerVoiceConsent.Use.SPEAK, "  ", answering(false), results::add);
        assertEquals("SPEAK:?", asked.get(asked.size() - 1));
    }

    @Test
    public void aLockForgetsTheYeses() {
        ServerVoiceConsent.check("room-a", ServerVoiceConsent.Use.SPEAK, "p", answering(true), results::add);
        ServerVoiceConsent.reset();
        assertFalse(ServerVoiceConsent.given("room-a", ServerVoiceConsent.Use.SPEAK));
        ServerVoiceConsent.check("room-a", ServerVoiceConsent.Use.SPEAK, "p", answering(true), results::add);
        assertEquals(2, asked.size());
    }

    @Test
    public void aDeclinedVoiceSaysSo() {
        assertEquals("speakSend.declined", SpeakSend.errorKey("declined"));
        assertEquals("speakSend.serverOff", SpeakSend.errorKey("tts-server-off"));
        assertEquals("speakSend.failed", SpeakSend.errorKey("tts-failed: x"));
    }
}
