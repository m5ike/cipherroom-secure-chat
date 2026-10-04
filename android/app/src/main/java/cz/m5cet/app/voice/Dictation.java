package cz.m5cet.app.voice;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * Speech to text (6.1) with the phone's recogniser — on the device when it
 * can (nothing leaves the phone), in the language of the voice settings.
 *
 * 6.7: driven by {@link DictationMachine} — dictation keeps listening until
 * stop() (the recogniser ends after a pause and is started again), and a
 * stop always ends it: stopListening() so the last words come, then the
 * recogniser is destroyed (cancelled after 1.5 s at the latest), a restart
 * that was pending is dropped, and a late callback of an old session can
 * no longer start a new one. Each session has its own recogniser, so a
 * stopped one cannot keep the microphone. While the app speaks (read-back,
 * autoplay) listening pauses and comes back afterwards.
 *
 * recognize() transcribes recorded PCM (a call's audio) through the
 * recogniser's audio-source input (Android 13+).
 * All calls on the main thread (SpeechRecognizer requires it).
 */
public final class Dictation {
    public interface Listener {
        default void onPartial(String text) { }
        void onFinal(String text);
        default void onState(boolean listening) { }
        default void onLevel(float rmsDb) { }
        default void onError(String message) { }
        /** 6.7: the dictation is over (stopped, aborted, or given up) — the text is final. */
        default void onEnded() { }
    }

    private final M5 app;
    private final DictationMachine machine;
    private Listener listener;
    private boolean wasListening;

    public Dictation(M5 app) {
        this.app = app;
        this.machine = new DictationMachine(new PhoneEngine(), new DictationMachine.Scheduler() {
            @Override public Object post(Runnable r, long ms) { Runnable[] box = { r }; Io.mainLater(() -> { Runnable x = box[0]; if (x != null) x.run(); }, ms); return box; }
            @Override public void cancel(Object token) { if (token instanceof Runnable[]) ((Runnable[]) token)[0] = null; }
        }, "", new DictationMachine.Listener() {
            @Override public void onText(String text, boolean fin) {
                Listener x = listener;
                if (x == null) return;
                if (fin) x.onFinal(text); else x.onPartial(text);
            }
            @Override public void onState(DictationMachine.State state) {
                Listener x = listener;
                boolean on = state == DictationMachine.State.LISTENING;
                if (on != wasListening) { wasListening = on; if (x != null) x.onState(on); }
                if (state == DictationMachine.State.IDLE) {
                    listener = null;
                    if (x != null) x.onEnded();
                }
            }
            @Override public void onError(String code) {
                Log.w("voice", "dictation: " + code);
                Listener x = listener;
                if (x != null) x.onError(code);
            }
        });
    }

    /** Dictating (from start until the text is finished). */
    public boolean active() { return machine.active(); }
    public boolean listening() { return machine.listening(); }
    public DictationMachine.State state() { return machine.state(); }

    public static boolean available(M5 app) { return SpeechRecognizer.isRecognitionAvailable(app); }

    private static SpeechRecognizer create(M5 app) {
        if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(app)) return SpeechRecognizer.createOnDeviceSpeechRecognizer(app);
        return SpeechRecognizer.createSpeechRecognizer(app);
    }

    private Intent intent() {
        Locale l = app.voice.speech.locale();
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, l.toLanguageTag())
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, app.getPackageName());
        if (Build.VERSION.SDK_INT >= 33) i.putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY);
        return i;
    }

    /** Starts dictation (continuous until stop()); a running one is aborted first. */
    public void start(Listener l) {
        if (machine.active()) { Listener old = listener; listener = null; machine.abort(); if (old != null) old.onEnded(); }
        listener = l;
        wasListening = false;
        machine.setLang(app.voice.speech.locale().toLanguageTag());
        machine.start();
    }

    /** Stops listening while the app speaks; resume() starts again. */
    public void pause() { machine.pause(); }

    public void resume() { machine.resume(); }

    /** Stops, the last words still come (then onEnded). */
    public void stop() { machine.stop(); }

    /** Stops at once (unfinished words dropped). */
    public void abort() { machine.abort(); }

    /* ------------------------------------------- the phone's recogniser */

    private final class PhoneEngine implements DictationMachine.Engine {
        @Override public DictationMachine.Session start(String lang, DictationMachine.Events ev) {
            SpeechRecognizer r = create(app);
            boolean[] over = { false };
            Runnable destroy = () -> {
                if (over[0]) return;
                over[0] = true;
                try { r.cancel(); } catch (RuntimeException ignored) { }
                try { r.destroy(); } catch (RuntimeException ignored) { }
            };
            r.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle b) { ev.ready(); }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float rms) { Listener x = listener; if (x != null) x.onLevel(rms); }
                @Override public void onBufferReceived(byte[] b) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onError(int error) {
                    if (over[0]) return;
                    String code = errorCode(error);
                    if (!"no-speech".equals(code)) Log.w("voice", "recogniser error " + error);
                    destroy.run();
                    ev.error(code);
                    ev.end();
                }
                @Override public void onResults(Bundle b) {
                    if (over[0]) return;
                    String text = first(b);
                    destroy.run();
                    ev.fin(text);
                    ev.end();
                }
                @Override public void onPartialResults(Bundle b) { if (!over[0]) ev.partial(first(b)); }
                @Override public void onEvent(int type, Bundle b) { }
            });
            try {
                r.startListening(intent());
            } catch (RuntimeException e) {
                destroy.run();
                throw e;
            }
            return new DictationMachine.Session() {
                @Override public void stop() { if (!over[0]) { try { r.stopListening(); } catch (RuntimeException e) { destroy.run(); ev.end(); } } }
                @Override public void abort() { destroy.run(); }
            };
        }
    }

    static String first(Bundle b) {
        ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return r == null || r.isEmpty() || r.get(0) == null ? "" : r.get(0).trim();
    }

    /** The recogniser's error as the web's codes (DictationMachine.FATAL decides). */
    static String errorCode(int e) {
        switch (e) {
            case SpeechRecognizer.ERROR_NO_MATCH: case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "no-speech";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "not-allowed";
            case SpeechRecognizer.ERROR_AUDIO: return "audio-capture";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED: case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: return "language-not-supported";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "busy";
            case SpeechRecognizer.ERROR_CLIENT: return "client";
            case SpeechRecognizer.ERROR_NETWORK: case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: case SpeechRecognizer.ERROR_SERVER:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED: case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS: return "network";
            default: return "error-" + e;
        }
    }

    /* ------------------------------------------------ recorded audio */

    /**
     * Transcribes PCM (16-bit mono, little endian) with the recogniser's audio
     * input (Android 13+); done gets "" when it heard nothing, null when it cannot.
     */
    public static void recognize(M5 app, byte[] pcm, int sampleRate, java.util.function.Consumer<String> done) {
        if (Build.VERSION.SDK_INT < 33) { done.accept(null); return; }
        Io.main(() -> {
            SpeechRecognizer r;
            ParcelFileDescriptor[] pipe;
            try {
                r = create(app);
                pipe = ParcelFileDescriptor.createPipe();
            } catch (IOException | RuntimeException e) { done.accept(null); return; }
            StringBuilder out = new StringBuilder();
            boolean[] answered = { false };
            java.util.function.Consumer<String> once = s -> { if (answered[0]) return; answered[0] = true; try { r.destroy(); } catch (RuntimeException ignored) { } done.accept(s); };
            r.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle b) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float v) { }
                @Override public void onBufferReceived(byte[] b) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onError(int error) { once.accept(out.length() > 0 ? out.toString() : error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "" : null); }
                @Override public void onResults(Bundle b) { out.append(first(b)); once.accept(out.toString()); }
                @Override public void onPartialResults(Bundle b) { }
                @Override public void onSegmentResults(Bundle b) { String s = first(b); if (!s.isEmpty()) out.append(out.length() > 0 ? " " : "").append(s); }
                @Override public void onEndOfSegmentedSession() { once.accept(out.toString()); }
                @Override public void onEvent(int t, Bundle b) { }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, app.voice.speech.locale().toLanguageTag())
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, android.media.AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, sampleRate)
                .putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
            try { r.startListening(i); } catch (RuntimeException e) { once.accept(null); return; }
            ParcelFileDescriptor write = pipe[1];
            Io.bg(() -> {
                try (OutputStream os = new ParcelFileDescriptor.AutoCloseOutputStream(write)) {
                    for (int at = 0; at < pcm.length; at += 8192) os.write(pcm, at, Math.min(8192, pcm.length - at));
                } catch (IOException ignored) { }
            });
            // A recogniser that never answers (some phones ignore the audio input): give up after the audio's length + 20 s.
            Io.mainLater(() -> once.accept(out.length() > 0 ? out.toString() : null), pcm.length / 2 * 1000L / Math.max(1, sampleRate) + 20_000);
        });
    }
}
