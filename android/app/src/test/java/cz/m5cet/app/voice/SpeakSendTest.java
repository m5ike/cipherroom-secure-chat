package cz.m5cet.app.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 6.7: speak and send — "Send the text as voice" and "Speak it, send text"
 * with a pretend dictation and voice: the field's text spoken and sent as a
 * voice message (no text along); an empty field dictated first; the
 * dictated text sent as a message; a failed voice says why and keeps the
 * text; the composer going away sends nothing.
 */
public class SpeakSendTest {
    static final class Composer implements SpeakSend.Io<String> {
        String field = "";
        boolean recogniser = true, dictating;
        final List<String> log = new ArrayList<>();
        SpeakSend.Done<String> pending;
        String pendingText;
        @Override public boolean canDictate() { return recogniser; }
        @Override public void startDictation() { dictating = true; log.add("dictate"); }
        @Override public void stopDictation() { dictating = false; log.add("stop"); }
        @Override public String fieldText() { return field; }
        @Override public void clearField() { field = ""; log.add("clear"); }
        @Override public void speak(String text, SpeakSend.Done<String> done) { pendingText = text; pending = done; log.add("speak:" + text); }
        @Override public void sendText(String text) { log.add("text:" + text); }
        @Override public void sendVoice(String clip) { log.add("voice:" + clip); }
        @Override public void notice(String key, String detail) { log.add("notice:" + key + (detail.isEmpty() ? "" : "=" + detail)); }
    }

    @Test public void theFieldsTextIsSpokenAndSentAsAVoiceMessage() {
        Composer c = new Composer();
        SpeakSend f = new SpeakSend(c);
        c.field = "  Ahoj, jak se máš?  ";
        f.asVoice();
        assertEquals(SpeakSend.State.SPEAKING, f.state());
        assertEquals("Ahoj, jak se máš?", c.pendingText);
        c.pending.done("clip.m4a", null);
        assertEquals(Arrays.asList("notice:voice.synthesizing", "speak:Ahoj, jak se máš?", "voice:clip.m4a", "clear"), c.log);
        assertEquals(SpeakSend.State.IDLE, f.state());
        assertFalse(c.log.stream().anyMatch(l -> l.startsWith("text:"))); // the voice goes without the text
    }

    @Test public void anEmptyFieldIsDictatedFirstThenSpoken() {
        Composer c = new Composer();
        SpeakSend f = new SpeakSend(c);
        f.asVoice();
        assertEquals(SpeakSend.State.DICTATING, f.state());
        assertTrue(c.dictating);
        c.field = "dobrý den"; // the dictated words in the field
        f.stop(); // the stop square
        assertEquals(SpeakSend.State.FINISHING, f.state());
        f.dictationEnded();
        assertEquals("dobrý den", c.pendingText);
        c.pending.done("v", null);
        assertEquals(Arrays.asList("notice:speakSend.speakNow", "dictate", "stop", "notice:voice.synthesizing", "speak:dobrý den", "voice:v", "clear"), c.log);
    }

    @Test public void speakItSendText() {
        Composer c = new Composer();
        SpeakSend f = new SpeakSend(c);
        f.asText();
        assertEquals(SpeakSend.Mode.TEXT, f.mode());
        c.field = "posílám text";
        f.asText(); // the same item again stops it
        f.dictationEnded();
        assertEquals(Arrays.asList("notice:speakSend.speakNowText", "dictate", "stop", "text:posílám text", "clear"), c.log);
        assertEquals(SpeakSend.State.IDLE, f.state());
    }

    @Test public void nothingHeardSendsNothing() {
        Composer c = new Composer();
        SpeakSend f = new SpeakSend(c);
        f.asVoice();
        f.stop();
        f.dictationEnded();
        assertTrue(c.log.contains("notice:voice.nothingHeard"));
        assertNull(c.pending);
        assertEquals(SpeakSend.State.IDLE, f.state());
    }

    @Test public void aFailedVoiceSaysWhyAndKeepsTheText() {
        Composer c = new Composer();
        SpeakSend f = new SpeakSend(c);
        c.field = "text";
        f.asVoice();
        c.pending.done(null, "tts-none");
        assertTrue(c.log.contains("notice:speakSend.noVoice"));
        assertEquals("text", c.field);
        f.asVoice();
        c.pending.done(null, "tts-server-off");
        assertTrue(c.log.contains("notice:speakSend.serverOff"));
        f.asVoice();
        c.pending.done(null, "tts-failed: HTTP 503");
        assertTrue(c.log.contains("notice:speakSend.failed=HTTP 503"));
        assertFalse(c.log.stream().anyMatch(l -> l.startsWith("voice:")));
    }

    @Test public void theComposerGoingAwaySendsNothing() {
        Composer c = new Composer();
        SpeakSend f = new SpeakSend(c);
        c.field = "text";
        f.asVoice();
        f.cancel();
        c.pending.done("late", null);
        assertFalse(c.log.contains("voice:late"));
        assertEquals(SpeakSend.State.IDLE, f.state());
        f.asText();
        f.cancel();
        f.dictationEnded(); // the dictation's end after the cancel: nothing
        assertFalse(c.log.stream().anyMatch(l -> l.startsWith("text:")));
    }

    @Test public void withoutARecogniserItSaysSo() {
        Composer c = new Composer();
        c.recogniser = false;
        SpeakSend f = new SpeakSend(c);
        f.asVoice();
        assertEquals(Arrays.asList("notice:look.dictate.none"), c.log);
        assertEquals(SpeakSend.State.IDLE, f.state());
    }

    @Test public void knowsAWav() {
        assertTrue(SpeakSend.isWav("RIFF\0\0\0\0WAVEfmt ".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1)));
        assertFalse(SpeakSend.isWav(new byte[]{ (byte) 0xff, (byte) 0xfb, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }));
        assertFalse(SpeakSend.isWav(null));
        assertEquals("speakSend.failed", SpeakSend.errorKey("tts-failed: x"));
        assertEquals("x", SpeakSend.detail("tts-failed: x"));
    }
}
