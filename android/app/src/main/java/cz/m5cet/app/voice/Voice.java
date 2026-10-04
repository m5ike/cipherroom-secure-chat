package cz.m5cet.app.voice;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;

import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.CopyOnWriteArrayList;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.fn.Api;
import cz.m5cet.app.fn.SpeechApi;

/**
 * The voice module (6.1): speech, dictation and the conversions between them,
 * all following the voice settings.
 *
 *  - dictate(): the words go into the composer as they come; with
 *    voice.dictateSpeak the finished sentence is read back — listening pauses
 *    while it is read and comes back afterwards;
 *  - speakIncoming(): voice.autoplay reads new messages of the room on screen
 *    (dictation pauses for it too);
 *  - textToVoiceMessage(): a text as a voice message (the phone's voice into
 *    AAC, or 6.7 the server's speech module when the voice settings say so);
 *  - voiceToText(): recorded PCM as text.
 *
 * 6.7: dictation stops for real (DictationMachine) and is reported to every
 * screen that shows it (addStateListener); when the app goes to the
 * background dictation stops and whoever holds the microphone is told
 * (addBackgroundListener) — nothing listens behind the user's back.
 */
public final class Voice {
    public interface Sink {
        void onText(String text, boolean done);
        /** 6.7: the dictation is over; what came is final. */
        default void onEnded() { }
    }

    private final M5 app;
    public final Speech speech;
    public final Dictation dictation;
    private Sink sink;
    private final CopyOnWriteArrayList<Runnable> stateListeners = new CopyOnWriteArrayList<>();
    private final CopyOnWriteArrayList<Runnable> backgroundListeners = new CopyOnWriteArrayList<>();
    private int started;

    public Voice(M5 app) {
        this.app = app;
        this.speech = new Speech(app);
        this.dictation = new Dictation(app);
        speech.setOnStateChange(this::changed);
        // The voice changer's parameters (the operator's gate is asked then too).
        Io.mainLater(() -> MicFx.recompute(app), 1500);
        app.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityStarted(Activity a) { started++; }
            @Override public void onActivityStopped(Activity a) { if (--started <= 0) { started = 0; background(); } }
            @Override public void onActivityCreated(Activity a, Bundle b) { }
            @Override public void onActivityResumed(Activity a) { }
            @Override public void onActivityPaused(Activity a) { }
            @Override public void onActivitySaveInstanceState(Activity a, Bundle b) { }
            @Override public void onActivityDestroyed(Activity a) { }
        });
    }

    /** 6.7: several screens follow the voice (the composer, the voice pad); 6.1 had one. */
    public void addStateListener(Runnable r) { if (r != null && !stateListeners.contains(r)) stateListeners.add(r); }
    public void removeStateListener(Runnable r) { stateListeners.remove(r); }

    /** Told when the app goes to the background (a recording drops the microphone). */
    public void addBackgroundListener(Runnable r) { if (r != null && !backgroundListeners.contains(r)) backgroundListeners.add(r); }
    public void removeBackgroundListener(Runnable r) { backgroundListeners.remove(r); }

    private void changed() { Io.main(() -> { for (Runnable r : stateListeners) r.run(); }); }

    private void background() {
        if (dictation.active()) stopDictation();
        for (Runnable r : backgroundListeners) r.run();
    }

    public boolean dictating() { return dictation.active(); }
    public boolean listening() { return dictation.listening(); }
    public boolean speaking() { return speech.speaking(); }

    /** Starts dictation into sink (partial text, then each finished sentence, then onEnded). */
    public void dictate(Sink s) {
        sink = s;
        // A dictation that runs is aborted first (its sink hears onEnded from it).
        dictation.start(new Dictation.Listener() {
            @Override public void onPartial(String text) { Sink k = sink; if (k == s) k.onText(text, false); }
            @Override public void onFinal(String text) {
                if (sink != s) return;
                s.onText(text, true);
                if (app.settings.bool("voice.dictateSpeak")) say(text);
            }
            @Override public void onState(boolean listening) { changed(); }
            @Override public void onError(String message) { Log.w("voice", "dictation: " + message); lastError = message; changed(); }
            @Override public void onEnded() {
                if (sink == s) sink = null;
                s.onEnded();
                changed();
            }
        });
        changed();
    }

    private volatile String lastError = "";

    /** The last dictation error code (the screen says it in words), "" after it was read. */
    public String takeDictationError() { String e = lastError; lastError = ""; return e; }

    /** Stops dictation; the last words still come into the sink (then onEnded). */
    public void stopDictation() {
        dictation.stop();
        changed();
    }

    /** Stops dictation at once (nothing more comes). */
    public void abortDictation() {
        dictation.abort();
        changed();
    }

    /** Speaks; an active dictation stops listening meanwhile and resumes after. */
    public void say(String text) {
        boolean resume = dictation.active();
        if (resume) dictation.pause();
        speech.speak(text, ok -> { if (resume) dictation.resume(); changed(); });
        changed();
    }

    public void stopSpeaking() { speech.stop(); dictation.resume(); }

    /** voice.autoplay: a new message in the room on screen is read aloud. */
    public void speakIncoming(String sender, String text) {
        if (!app.settings.bool("voice.autoplay") || text == null || text.trim().isEmpty()) return;
        say(sender == null || sender.isEmpty() ? text : sender + ": " + text);
    }

    public interface Result<T> { void done(T value, String error); }

    /**
     * A text spoken into a voice message: the phone's voice (AAC, nothing
     * leaves the phone) or — voice.engine = server — the operator's speech
     * module (the server sees the text). Errors: "tts-none" (no voice on the
     * phone), "tts-server-off" (the server has none for this user),
     * "tts-failed: …".
     */
    public void textToVoiceMessage(String text, Result<Clip> done) {
        if ("server".equals(app.settings.str("voice.engine"))) serverVoiceMessage(text, done);
        else deviceVoiceMessage(text, done);
    }

    private void deviceVoiceMessage(String text, Result<Clip> done) {
        File wav = new File(app.getCacheDir(), "tts-" + System.nanoTime() + ".wav");
        speech.synthesize(text, wav, ok -> {
            if (!ok) { wav.delete(); done.done(null, speech.ready() ? "tts-failed" : "tts-none"); return; }
            Io.bg(() -> {
                try {
                    Clip c = wavClip(app, Files.readAllBytes(wav.toPath()));
                    Io.main(() -> done.done(c, null));
                } catch (Exception e) {
                    Log.w("voice", "text to voice failed: " + e.getMessage());
                    Io.main(() -> done.done(null, "tts-failed: " + e.getMessage()));
                } finally {
                    //noinspection ResultOfMethodCallIgnored
                    wav.delete();
                }
            });
        });
    }

    private void serverVoiceMessage(String text, Result<Clip> done) {
        String base = app.config.server();
        if (base.isEmpty()) { done.done(null, "tts-server-off"); return; }
        SpeechApi api = new SpeechApi(base);
        String bearer = app.account.bearer();
        api.status(bearer, Io::bg, status -> {
            if (!status.tts || status.voices.isEmpty()) { Io.main(() -> done.done(null, "tts-server-off")); return; }
            api.tts(bearer, text, status.voices.get(0).id, null, Io::bg, new Api.Callback<SpeechApi.Audio>() {
                @Override public void ok(SpeechApi.Audio audio) {
                    try {
                        Clip c = SpeakSend.isWav(audio.bytes) ? wavClip(app, audio.bytes) : new Clip(audio.bytes, audio.mime, 0, null, 0);
                        Io.main(() -> done.done(c, null));
                    } catch (Exception e) {
                        Io.main(() -> done.done(null, "tts-failed: " + e.getMessage()));
                    }
                }
                @Override public void fail(Api.Failure f) { Io.main(() -> done.done(null, "tts-failed: " + f.getMessage())); }
            });
        });
    }

    /** A WAV (the phone's voice, Piper) as an AAC voice message. */
    static Clip wavClip(M5 app, byte[] wavBytes) throws java.io.IOException {
        Audio.Pcm pcm = Audio.readWav(wavBytes);
        if (pcm.data.length < 2) throw new java.io.IOException("no speech in the audio");
        byte[] mono = pcm.rate > 24_000 ? Audio.resample(pcm.data, pcm.rate, 24_000) : pcm.data;
        int rate = pcm.rate > 24_000 ? 24_000 : pcm.rate;
        return clip(app, mono, rate);
    }

    /** Recorded PCM → an AAC clip (a voice message). */
    public static Clip clip(M5 app, byte[] pcm, int rate) throws java.io.IOException {
        File m4a = new File(app.getCacheDir(), "rec-" + System.nanoTime() + ".m4a");
        try {
            Audio.encodeAac(pcm, rate, m4a);
            return new Clip(Files.readAllBytes(m4a.toPath()), "audio/mp4", Audio.durationMs(pcm, rate), pcm, rate);
        } finally {
            //noinspection ResultOfMethodCallIgnored
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

    /** 6.7: recorded PCM → text by the operator's speech module (voice.engine = server). */
    public void serverVoiceToText(byte[] pcm, int rate, Result<String> done) {
        String base = app.config.server();
        if (base.isEmpty()) { done.done(null, "stt-server-off"); return; }
        Io.bg(() -> {
            byte[] wav;
            try { wav = Audio.wavBytes(rate == Audio.RATE ? pcm : Audio.resample(pcm, rate, Audio.RATE), Audio.RATE); }
            catch (RuntimeException e) { Io.main(() -> done.done(null, "stt-failed")); return; }
            new SpeechApi(base).stt(app.account.bearer(), wav, null, Io::bg, new Api.Callback<String>() {
                @Override public void ok(String text) { Io.main(() -> done.done(text, null)); }
                @Override public void fail(Api.Failure f) { Io.main(() -> done.done(null, "stt-failed: " + f.getMessage())); }
            });
        });
    }

    /** An audio clip: encoded bytes, their MIME type, duration, and the PCM it came from (may be null). */
    public static final class Clip {
        public final byte[] bytes;
        public final String mime;
        public final long durationMs;
        public final byte[] pcm;
        public final int rate;
        Clip(byte[] bytes, String mime, long durationMs, byte[] pcm, int rate) { this.bytes = bytes; this.mime = mime; this.durationMs = durationMs; this.pcm = pcm; this.rate = rate; }
    }
}
