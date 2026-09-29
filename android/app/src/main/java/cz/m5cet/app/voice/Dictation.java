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
 * Dictation keeps listening until stop(): the recogniser ends after a pause,
 * so it is started again. While the app speaks (read-back, autoplay) the
 * microphone is paused and listening resumes after the speech ends.
 *
 * recognize() transcribes recorded PCM (a voice message, a call's audio)
 * through the recogniser's audio-source input (Android 13+).
 * All calls on the main thread (SpeechRecognizer requires it).
 */
public final class Dictation {
    public interface Listener {
        default void onPartial(String text) { }
        void onFinal(String text);
        default void onState(boolean listening) { }
        default void onLevel(float rmsDb) { }
        default void onError(String message) { }
    }

    private final M5 app;
    private SpeechRecognizer recognizer;
    private Listener listener;
    private boolean active = false, paused = false, listening = false;

    public Dictation(M5 app) { this.app = app; }

    public boolean active() { return active; }
    public boolean listening() { return listening; }

    public static boolean available(M5 app) { return SpeechRecognizer.isRecognitionAvailable(app); }

    private SpeechRecognizer create() {
        if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(app)) return SpeechRecognizer.createOnDeviceSpeechRecognizer(app);
        return SpeechRecognizer.createSpeechRecognizer(app);
    }

    private Intent intent(boolean partial) {
        Locale l = app.voice.speech.locale();
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, l.toLanguageTag())
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, app.getPackageName());
        if (Build.VERSION.SDK_INT >= 33) i.putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY);
        return i;
    }

    /** Starts dictation (continuous until stop()). */
    public void start(Listener l) {
        stop();
        listener = l;
        active = true;
        paused = false;
        listen();
    }

    private void listen() {
        if (!active || paused) return;
        if (recognizer == null) {
            recognizer = create();
            recognizer.setRecognitionListener(new Rl());
        }
        try {
            recognizer.startListening(intent(true));
        } catch (RuntimeException e) {
            Log.w("voice", "dictation could not start: " + e.getMessage());
            Listener x = listener;
            if (x != null) x.onError(e.getMessage());
        }
    }

    /** Stops listening while the app speaks; resume() starts again. */
    public void pause() {
        if (!active || paused) return;
        paused = true;
        if (recognizer != null) recognizer.cancel();
        setListening(false);
    }

    public void resume() {
        if (!active || !paused) return;
        paused = false;
        listen();
    }

    public void stop() {
        active = false;
        paused = false;
        if (recognizer != null) { try { recognizer.cancel(); recognizer.destroy(); } catch (RuntimeException ignored) { } recognizer = null; }
        setListening(false);
    }

    private void setListening(boolean on) {
        if (listening == on) return;
        listening = on;
        Listener x = listener;
        if (x != null) x.onState(on);
    }

    private final class Rl implements RecognitionListener {
        @Override public void onReadyForSpeech(Bundle b) { setListening(true); }
        @Override public void onBeginningOfSpeech() { }
        @Override public void onRmsChanged(float rms) { Listener x = listener; if (x != null) x.onLevel(rms); }
        @Override public void onBufferReceived(byte[] b) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onError(int error) {
            setListening(false);
            boolean quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
            if (!quiet) {
                Log.w("voice", "recogniser error " + error);
                Listener x = listener;
                if (x != null) x.onError(errorText(error));
                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) { stop(); return; }
            }
            // Keep listening: the recogniser gives up after a pause, dictation does not.
            if (active && !paused) Io.mainLater(Dictation.this::listen, quiet ? 50 : 600);
        }
        @Override public void onResults(Bundle b) {
            setListening(false);
            String text = first(b);
            Listener x = listener;
            if (!text.isEmpty() && x != null) x.onFinal(text);
            if (active && !paused) Io.mainLater(Dictation.this::listen, 50);
        }
        @Override public void onPartialResults(Bundle b) {
            String text = first(b);
            Listener x = listener;
            if (!text.isEmpty() && x != null) x.onPartial(text);
        }
        @Override public void onEvent(int type, Bundle b) { }
    }

    static String first(Bundle b) {
        ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return r == null || r.isEmpty() || r.get(0) == null ? "" : r.get(0).trim();
    }

    static String errorText(int e) {
        switch (e) {
            case SpeechRecognizer.ERROR_NETWORK: case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "network";
            case SpeechRecognizer.ERROR_AUDIO: return "audio";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "microphone permission";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED: case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: return "language not available";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "busy";
            default: return "error " + e;
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
                r = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(app) ? SpeechRecognizer.createOnDeviceSpeechRecognizer(app) : SpeechRecognizer.createSpeechRecognizer(app);
                pipe = ParcelFileDescriptor.createPipe();
            } catch (IOException | RuntimeException e) { done.accept(null); return; }
            StringBuilder out = new StringBuilder();
            r.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle b) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float v) { }
                @Override public void onBufferReceived(byte[] b) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onError(int error) { r.destroy(); done.accept(out.length() > 0 ? out.toString() : error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "" : null); }
                @Override public void onResults(Bundle b) { out.append(first(b)); r.destroy(); done.accept(out.toString()); }
                @Override public void onPartialResults(Bundle b) { }
                @Override public void onSegmentResults(Bundle b) { String s = first(b); if (!s.isEmpty()) out.append(out.length() > 0 ? " " : "").append(s); }
                @Override public void onEndOfSegmentedSession() { r.destroy(); done.accept(out.toString()); }
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
            try { r.startListening(i); } catch (RuntimeException e) { done.accept(null); return; }
            ParcelFileDescriptor write = pipe[1];
            Io.bg(() -> {
                try (OutputStream os = new ParcelFileDescriptor.AutoCloseOutputStream(write)) {
                    for (int at = 0; at < pcm.length; at += 8192) os.write(pcm, at, Math.min(8192, pcm.length - at));
                } catch (IOException ignored) { }
            });
        });
    }
}
