package cz.m5cet.app.voice;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;

import org.json.JSONException;
import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * The voice changer's test (6.7, Settings › Voice changer › Try it): four
 * seconds recorded through the same path a voice message takes
 * (Audio.Recorder → MicFx), then played back here. Nothing is kept or sent;
 * leaving the screen or the app stops it and frees the microphone.
 */
public final class FxTest {
    private FxTest() {}

    public static final long RECORD_MS = 4000;

    public enum State { IDLE, RECORDING, PLAYING }

    private static volatile State state = State.IDLE;
    private static Audio.Recorder recorder;
    private static AudioTrack track;
    private static int run;
    private static Runnable onChange;
    private static final Runnable STOP = FxTest::stop;

    public static State state() { return state; }

    /** $voiceFx of the settings screen. */
    public static JSONObject scope(M5 app) {
        JSONObject o = new JSONObject();
        try {
            o.put("allowed", FxGate.allowed(app));
            o.put("active", MicFx.active());
            o.put("testing", state.name().toLowerCase(java.util.Locale.ROOT));
        } catch (JSONException ignored) { }
        return o;
    }

    /** Start (when idle) or stop; `changed` refreshes the screen. */
    public static void toggle(M5 app, Runnable changed) {
        onChange = changed;
        if (state != State.IDLE) { stop(); return; }
        MicFx.recompute(app);
        Audio.Recorder r = new Audio.Recorder();
        if (!r.start()) { Log.w("voice", "the test could not record"); return; }
        recorder = r;
        set(State.RECORDING);
        final int mine = ++run;
        app.voice.addBackgroundListener(STOP);
        Io.mainLater(() -> { if (mine == run && state == State.RECORDING) play(mine); }, RECORD_MS);
    }

    private static void play(int mine) {
        Audio.Recorder r = recorder;
        recorder = null;
        if (r == null) { set(State.IDLE); return; }
        byte[] pcm = r.stop();
        if (pcm.length < 2) { set(State.IDLE); return; }
        try {
            AudioTrack t = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(Audio.RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.length)
                .build();
            t.write(pcm, 0, pcm.length);
            track = t;
            set(State.PLAYING);
            t.play();
            Io.mainLater(() -> { if (mine == run && state == State.PLAYING) stop(); }, Audio.durationMs(pcm, Audio.RATE) + 300);
        } catch (RuntimeException e) {
            Log.w("voice", "the test could not play: " + e.getMessage());
            set(State.IDLE);
        }
    }

    /** Stops whatever runs; the microphone is released. */
    public static void stop() {
        run++;
        Audio.Recorder r = recorder;
        recorder = null;
        if (r != null) r.stop();
        AudioTrack t = track;
        track = null;
        if (t != null) { try { t.stop(); } catch (RuntimeException ignored) { } t.release(); }
        M5 app = M5.get();
        if (app != null && app.voice != null) app.voice.removeBackgroundListener(STOP);
        set(State.IDLE);
    }

    private static void set(State s) {
        if (state == s) return;
        state = s;
        Runnable c = onChange;
        if (c != null) Io.main(c);
    }
}
