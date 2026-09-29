package cz.m5cet.app.voice;

import java.io.File;
import java.nio.file.Files;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * The voice module (6.1): speech, dictation and the conversions between them,
 * all following the voice settings.
 *
 *  - dictate(): the words go into the composer as they come; with
 *    voice.dictateSpeak the finished sentence is read back — listening pauses
 *    while it is read and comes back afterwards;
 *  - speakIncoming(): voice.autoplay reads new messages of the room on screen
 *    (dictation pauses for it too);
 *  - textToVoiceMessage(): a text as an AAC voice message (audio/mp4);
 *  - voiceToText(): recorded PCM as text.
 */
public final class Voice {
    public interface Sink { void onText(String text, boolean done); }

    private final M5 app;
    public final Speech speech;
    public final Dictation dictation;
    private Sink sink;
    private Runnable stateListener;

    public Voice(M5 app) {
        this.app = app;
        this.speech = new Speech(app);
        this.dictation = new Dictation(app);
        speech.setOnStateChange(this::changed);
    }

    public void setStateListener(Runnable r) { stateListener = r; }
    private void changed() { Runnable r = stateListener; if (r != null) Io.main(r); }

    public boolean dictating() { return dictation.active(); }
    public boolean listening() { return dictation.listening(); }
    public boolean speaking() { return speech.speaking(); }

    /** Starts dictation into sink (partial text, then each finished sentence). */
    public void dictate(Sink s) {
        sink = s;
        dictation.start(new Dictation.Listener() {
            @Override public void onPartial(String text) { Sink k = sink; if (k != null) k.onText(text, false); }
            @Override public void onFinal(String text) {
                Sink k = sink;
                if (k != null) k.onText(text, true);
                if (app.settings.bool("voice.dictateSpeak")) say(text);
            }
            @Override public void onState(boolean listening) { changed(); }
            @Override public void onError(String message) { Log.w("voice", "dictation: " + message); changed(); }
        });
        changed();
    }

    public void stopDictation() {
        dictation.stop();
        sink = null;
        changed();
    }

    /** Speaks; an active dictation stops listening meanwhile and resumes after. */
    public void say(String text) {
        boolean resume = dictation.active();
        if (resume) dictation.pause();
        speech.speak(text, ok -> { if (resume) dictation.resume(); changed(); });
        changed();
    }

    public void stopSpeaking() { speech.stop(); if (dictation.active()) dictation.resume(); }

    /** voice.autoplay: a new message in the room on screen is read aloud. */
    public void speakIncoming(String sender, String text) {
        if (!app.settings.bool("voice.autoplay") || text == null || text.trim().isEmpty()) return;
        say(sender == null || sender.isEmpty() ? text : sender + ": " + text);
    }

    public interface Result<T> { void done(T value, String error); }

    /** A text spoken into an AAC file (audio/mp4); the file's bytes and duration. */
    public void textToVoiceMessage(String text, Result<Clip> done) {
        File wav = new File(app.getCacheDir(), "tts-" + System.nanoTime() + ".wav");
        speech.synthesize(text, wav, ok -> {
            if (!ok) { done.done(null, "tts"); return; }
            Io.bg(() -> {
                try {
                    Audio.Pcm pcm = Audio.readWav(wav);
                    byte[] mono = pcm.rate > 24_000 ? Audio.resample(pcm.data, pcm.rate, 24_000) : pcm.data;
                    int rate = pcm.rate > 24_000 ? 24_000 : pcm.rate;
                    File m4a = new File(app.getCacheDir(), "tts-" + System.nanoTime() + ".m4a");
                    Audio.encodeAac(mono, rate, m4a);
                    Clip c = new Clip(Files.readAllBytes(m4a.toPath()), "audio/mp4", Audio.durationMs(mono, rate), mono, rate);
                    m4a.delete();
                    Io.main(() -> done.done(c, null));
                } catch (Exception e) {
                    Log.w("voice", "text to voice failed: " + e.getMessage());
                    Io.main(() -> done.done(null, e.getMessage()));
                } finally {
                    wav.delete();
                }
            });
        });
    }

    /** Recorded PCM → an AAC clip (a voice message). */
    public static Clip clip(M5 app, byte[] pcm, int rate) throws java.io.IOException {
        File m4a = new File(app.getCacheDir(), "rec-" + System.nanoTime() + ".m4a");
        try {
            Audio.encodeAac(pcm, rate, m4a);
            return new Clip(Files.readAllBytes(m4a.toPath()), "audio/mp4", Audio.durationMs(pcm, rate), pcm, rate);
        } finally {
            m4a.delete();
        }
    }

    /** Recorded PCM → text (the phone's recogniser). */
    public void voiceToText(byte[] pcm, int rate, Result<String> done) {
        Dictation.recognize(app, pcm, rate, text -> Io.main(() -> {
            if (text == null) done.done(null, "recogniser");
            else done.done(text, null);
        }));
    }

    /** An audio clip: encoded bytes, their MIME type, duration, and the PCM it came from. */
    public static final class Clip {
        public final byte[] bytes;
        public final String mime;
        public final long durationMs;
        public final byte[] pcm;
        public final int rate;
        Clip(byte[] bytes, String mime, long durationMs, byte[] pcm, int rate) { this.bytes = bytes; this.mime = mime; this.durationMs = durationMs; this.pcm = pcm; this.rate = rate; }
    }
}
