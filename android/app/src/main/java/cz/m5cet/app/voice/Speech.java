package cz.m5cet.app.voice;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * Text to speech (6.1) with the phone's engine: the language, the voice, the
 * rate and the pitch come from the settings (voice.*). One engine for the
 * app, started on first use; utterances report their end so dictation can
 * pause while the phone speaks.
 */
public final class Speech {
    public interface Done { void done(boolean ok); }

    private final M5 app;
    private TextToSpeech tts;
    private volatile boolean ready = false;
    private final List<Runnable> pending = new ArrayList<>();
    private final Map<String, Done> callbacks = new ConcurrentHashMap<>();
    private volatile boolean speaking = false;
    private Runnable onStateChange;

    public Speech(M5 app) { this.app = app; }

    public boolean speaking() { return speaking; }
    /** 6.7: the phone has a text-to-speech engine that started (false before the first use or without one). */
    public boolean ready() { return ready; }
    public void setOnStateChange(Runnable r) { onStateChange = r; }

    private synchronized void whenReady(Runnable r) {
        if (ready) { r.run(); return; }
        pending.add(r);
        if (tts != null) return;
        tts = new TextToSpeech(app, status -> {
            List<Runnable> run;
            synchronized (Speech.this) {
                ready = status == TextToSpeech.SUCCESS;
                run = new ArrayList<>(pending);
                pending.clear();
            }
            if (!ready) { Log.w("voice", "text to speech is not available (" + status + ")"); for (Runnable x : run) x.run(); return; }
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                // 6.7: a file being made ("f…") is not the phone speaking.
                @Override public void onStart(String id) { if (id.startsWith("u")) { speaking = true; changed(); } }
                @Override public void onDone(String id) { finished(id, true); }
                @Override public void onError(String id) { finished(id, false); }
                @Override public void onStop(String id, boolean interrupted) { finished(id, false); }
            });
            for (Runnable x : run) x.run();
        });
    }

    private void finished(String id, boolean ok) {
        if (id.startsWith("u")) speaking = false;
        Done d = callbacks.remove(id);
        changed();
        if (d != null) Io.main(() -> d.done(ok));
    }

    private void changed() { Runnable r = onStateChange; if (r != null) Io.main(r); }

    /** The language for speech: the setting, else the app's language. */
    public Locale locale() {
        String l = app.settings.str("voice.lang");
        if (l.isEmpty()) l = app.lang();
        return Locale.forLanguageTag(l.equals("cs") ? "cs-CZ" : l.equals("de") ? "de-DE" : l.equals("en") ? "en-US" : l);
    }

    private void configure() {
        int lang = tts.setLanguage(locale());
        if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) Log.w("voice", "no " + locale().toLanguageTag() + " voice on this phone (" + lang + ")");
        String name = app.settings.str("voice.voice");
        if (!name.isEmpty()) {
            Voice chosen = null;
            try { for (Voice v : tts.getVoices()) if (v.getName().equals(name)) { chosen = v; break; } } catch (RuntimeException ignored) { }
            if (chosen != null) tts.setVoice(chosen);
        }
        tts.setSpeechRate((float) clamp(app.settings.num("voice.rate"), 0.3, 3.0));
        tts.setPitch((float) clamp(app.settings.num("voice.pitch"), 0.3, 2.5));
    }

    static double clamp(double v, double lo, double hi) { return v <= 0 ? 1 : Math.max(lo, Math.min(hi, v)); }

    /** Speaks now (replacing whatever is being said). */
    public void speak(String text, Done done) {
        if (text == null || text.trim().isEmpty()) { if (done != null) done.done(false); return; }
        whenReady(() -> {
            if (!ready) { if (done != null) Io.main(() -> done.done(false)); return; }
            configure();
            String id = "u" + System.nanoTime();
            if (done != null) callbacks.put(id, done);
            int r = tts.speak(text.length() > TextToSpeech.getMaxSpeechInputLength() ? text.substring(0, TextToSpeech.getMaxSpeechInputLength()) : text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id);
            if (r != TextToSpeech.SUCCESS) finished(id, false);
        });
    }

    public void stop() { if (tts != null && ready) tts.stop(); speaking = false; changed(); }

    /** Speech into a WAV file (PCM 16 bit) — for a voice message or a call's audio. */
    public void synthesize(String text, File wav, Done done) {
        whenReady(() -> {
            if (!ready) { Io.main(() -> done.done(false)); return; }
            configure();
            String id = "f" + System.nanoTime();
            callbacks.put(id, done);
            int max = TextToSpeech.getMaxSpeechInputLength();
            int r = tts.synthesizeToFile(text.length() > max ? text.substring(0, max) : text, new Bundle(), wav, id);
            if (r != TextToSpeech.SUCCESS) finished(id, false);
        });
    }

    /** The engine's voices for a language ($voices of the voice screen): [{value, label}]. */
    public void voices(java.util.function.Consumer<JSONArray> out) {
        whenReady(() -> {
            JSONArray list = new JSONArray();
            try {
                list.put(new JSONObject().put("value", "").put("label", app.t("voice.defaultVoice")));
                if (ready) {
                    String lang = locale().getLanguage();
                    List<Voice> vs = new ArrayList<>();
                    for (Voice v : tts.getVoices()) if (v.getLocale() != null && v.getLocale().getLanguage().equals(lang) && !v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) vs.add(v);
                    vs.sort((a, b) -> a.getName().compareTo(b.getName()));
                    for (Voice v : vs) list.put(new JSONObject().put("value", v.getName()).put("label", label(v)));
                }
            } catch (JSONException | RuntimeException e) { Log.w("voice", "voices: " + e.getMessage()); }
            Io.main(() -> out.accept(list));
        });
    }

    private static String label(Voice v) {
        String n = v.getName();
        // "cs-cz-x-jfs-local" → "cs-CZ · jfs"; engines name voices differently, keep it short.
        String[] p = n.split("-");
        String who = p.length >= 4 ? p[3] : n;
        return v.getLocale().toLanguageTag() + " · " + who + (v.isNetworkConnectionRequired() ? " ☁" : "") + (v.getQuality() >= Voice.QUALITY_HIGH ? " ★" : "");
    }

    public void shutdown() {
        synchronized (this) {
            if (tts != null) tts.shutdown();
            tts = null;
            ready = false;
        }
    }

    static { Context.class.getName(); }
}
