package cz.m5cet.app.voice;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Settings;

/**
 * The voice changer on the phone (6.7): the one place the app's microphone
 * passes before the audio goes on — voice messages, the "speak it, send
 * text" recording and the voice changer's test (Audio.Recorder), and calls
 * (WebRTC's capture buffer callback: CallAudio.onCapture → onCapture here).
 * On only when the operator's module allows it (FxGate) AND the user
 * switched it on (voiceFx.on); the preset or custom values (voiceFx.*) are
 * VoiceFx's. The phone's recogniser (dictation) listens to the microphone
 * itself and only gives text — it does not pass here.
 *
 * The audio threads only read {@link #params()} (computed on the main
 * thread when a setting or the gate changes), and each stream keeps its own
 * VoiceFx: once a stream went through it, it stays in the chain (transparent
 * when off) so the delay never jumps mid-recording or mid-call.
 */
public final class MicFx {
    private MicFx() {}

    private static volatile VoiceFx.Params current = VoiceFx.NEUTRAL;
    private static volatile int version;
    private static volatile boolean listening;

    /** The settings a stream follows (the module off or the switch off: neutral). */
    public static VoiceFx.Params params() { return current; }

    /** Whether the voice is being changed now. */
    public static boolean active() { return !current.neutral(); }

    /** The user's parameters (voiceFx.preset; "custom" → voiceFx.pitch …). */
    public static VoiceFx.Params fromSettings(java.util.function.Function<String, Object> get) {
        String preset = String.valueOf(get.apply("voiceFx.preset"));
        VoiceFx.Params custom = VoiceFx.NEUTRAL;
        for (String k : VoiceFx.KEYS) {
            Object v = get.apply("voiceFx." + k);
            if (v instanceof Number) custom = custom.with(k, ((Number) v).doubleValue());
        }
        return VoiceFx.paramsFor(preset, custom);
    }

    /** The settings' keys and defaults (Settings.DEFAULTS) — the same defaults as the web's DEFAULT_VOICE_FX. */
    public static void defaults(java.util.Map<String, Object> d) {
        d.put("voiceFx.on", false);              // switched on for this phone (the operator's module must allow it)
        d.put("voiceFx.preset", "deep");         // off | higher | lower | deep | robot | echo | whisper | anonymous | custom
        d.put("voiceFx.pitch", -5.0);            // custom: semitones
        d.put("voiceFx.formant", -3.0);          // custom: semitones
        d.put("voiceFx.robot", 0.0);             // custom: ring modulator Hz (0 = off)
        d.put("voiceFx.echo", 0.0);              // custom: echo mix 0 … 1
        d.put("voiceFx.echoMs", 250.0);
        d.put("voiceFx.echoFeedback", 0.35);
        d.put("voiceFx.whisper", 0.0);           // custom: 0 … 1
        d.put("voiceFx.gain", 0.0);              // custom: dB
    }

    /** The custom values back to the defaults (Settings › Voice changer › Reset). */
    public static void resetCustom(M5 app) {
        java.util.Map<String, Object> d = new java.util.LinkedHashMap<>();
        defaults(d);
        for (String k : VoiceFx.KEYS) app.settings.set("voiceFx." + k, d.get("voiceFx." + k));
    }

    /** Works out the parameters again (main thread: reads the settings and the gate). */
    public static void recompute(M5 app) {
        if (app == null) return;
        if (!listening) {
            listening = true;
            app.settings.addListener((key, value) -> { if (key.startsWith("voiceFx.")) recompute(app); });
        }
        Settings s = app.settings;
        boolean on = s.bool("voiceFx.on") && FxGate.allowed(app);
        use(on ? fromSettings(s::get) : VoiceFx.NEUTRAL);
    }

    /** Something changed (the gate): work it out again on the main thread. */
    static void invalidate() { Io.main(() -> recompute(M5.get())); }

    static boolean sameParams(VoiceFx.Params a, VoiceFx.Params b) {
        for (String k : VoiceFx.KEYS) if (a.get(k) != b.get(k)) return false;
        return true;
    }

    /** One audio stream's processor (a recording, the call's capture); follows the settings live. */
    public static final class Stream {
        private final int rate;
        private VoiceFx fx;
        private int seen = -1;

        public Stream(int rate) { this.rate = rate; }

        /** The delay it adds now (0 while it has never been on). */
        public int latency() { return fx == null ? 0 : fx.latency(); }

        /** 16-bit PCM (interleaved channels) changed in place. */
        public void process(short[] pcm, int offset, int frames, int channels) {
            if (seen != version) {
                seen = version;
                VoiceFx.Params p = current;
                if (fx == null && !p.neutral()) fx = new VoiceFx(rate, p);
                else if (fx != null) fx.set(p);
            }
            if (fx != null) fx.process(pcm, offset, frames, channels);
        }
    }

    /* -------------------------------------------------------------- calls */

    private static Stream call;
    private static int callRate;
    private static short[] callBuf = new short[0];
    private static long checkedAt;

    /**
     * WebRTC's capture buffer (JavaAudioDeviceModule's audio buffer callback,
     * on its recording thread): the microphone's 10 ms through the chain, in
     * place, before WebRTC encodes and encrypts it.
     */
    public static void onCapture(ByteBuffer buffer, int channels, int rate, int bytes) {
        long now = System.currentTimeMillis();
        // During a call the operator's gate is asked again now and then (on the main thread).
        if (now - checkedAt > 60_000) { checkedAt = now; invalidate(); }
        if (call == null && current.neutral()) return; // nothing to do: not a sample touched
        if (call == null || callRate != rate) { call = new Stream(rate); callRate = rate; }
        callBuf = processBuffer(call, buffer, channels, bytes, callBuf);
    }

    /** 16-bit little-endian PCM in a (direct) buffer through a stream, in place; the work array back (grown when needed). */
    static short[] processBuffer(Stream s, ByteBuffer buffer, int channels, int bytes, short[] work) {
        int samples = bytes / 2;
        short[] w = work.length < samples ? new short[samples] : work;
        ByteBuffer b = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < samples; i++) w[i] = b.getShort(i * 2);
        int ch = Math.max(1, channels);
        s.process(w, 0, samples / ch, ch);
        for (int i = 0; i < samples; i++) b.putShort(i * 2, w[i]);
        return w;
    }

    /** Sets the parameters directly (recompute; the tests). */
    static void use(VoiceFx.Params p) {
        if (!sameParams(p, current)) { current = p; version++; }
    }
}
