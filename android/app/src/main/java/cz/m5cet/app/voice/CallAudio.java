package cz.m5cet.app.voice;

import org.webrtc.AudioTrack;
import org.webrtc.AudioTrackSink;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.FileVault;

/**
 * Audio ↔ text calls (6.1). While a room's call runs in this mode:
 *  - out: what I write is spoken (TextToSpeech) into the call — the
 *    captured microphone buffer is replaced by the speech (silence between
 *    utterances), through WebRTC's audio buffer callback;
 *  - in: each peer's audio is cut into utterances (energy, 700 ms of
 *    quiet) and transcribed on the phone; the text comes into the chat as
 *    that peer's message, the utterance kept (encrypted, FileVault) behind
 *    the bubble's "source" icon.
 * One instance for the app: the audio device module is one.
 */
public final class CallAudio {
    public interface Sink { void onTranscript(String peerId, String text, String sourceId); }

    private static final CallAudio INSTANCE = new CallAudio();
    public static CallAudio get() { return INSTANCE; }

    private volatile boolean active;
    private Sink sink;
    private final ArrayDeque<short[]> speech = new ArrayDeque<>();
    private short[] current;
    private int currentAt;
    private int speechRate = Audio.RATE;
    private final Map<String, Listener> listeners = new ConcurrentHashMap<>();
    private final ArrayDeque<Runnable> recognitions = new ArrayDeque<>();
    private boolean recognizing;

    public boolean active() { return active; }

    public void start(Sink s) { sink = s; active = true; }

    public void stop() {
        active = false;
        synchronized (speech) { speech.clear(); current = null; }
        for (Listener l : listeners.values()) l.detach();
        listeners.clear();
    }

    /* --------------------------------------------------------------- out */

    /** Speaks text into the call; done gets the recording's vault id (for the bubble's source icon). */
    public void say(M5 app, String text, java.util.function.Consumer<String> done) {
        java.io.File wav = new java.io.File(app.getCacheDir(), "call-tts-" + System.nanoTime() + ".wav");
        app.voice.speech.synthesize(text, wav, ok -> Io.bg(() -> {
            try {
                if (!ok) { done.accept(null); return; }
                Audio.Pcm pcm = Audio.readWav(wav);
                short[] samples = toShorts(pcm.data);
                synchronized (speech) { speech.add(samples); speechRate = pcm.rate; }
                done.accept(keep(app, pcm.data, pcm.rate));
            } catch (Exception e) {
                Log.w("call", "speech into the call: " + e.getMessage());
                done.accept(null);
            } finally {
                //noinspection ResultOfMethodCallIgnored
                wav.delete();
            }
        }));
    }

    /**
     * JavaAudioDeviceModule's buffer callback (the recording thread): in this
     * mode the microphone is replaced by the queued speech, else by silence.
     */
    public long onCapture(ByteBuffer buffer, int format, int channels, int rate, int bytes, long ts) {
        if (!active) return ts;
        ShortBufferView out = new ShortBufferView(buffer, bytes);
        synchronized (speech) {
            for (int i = 0; i < out.frames(channels); i++) {
                short v = 0;
                if (current == null || currentAt >= current.length) { current = speech.poll(); currentAt = 0; }
                if (current != null) {
                    // Nearest-sample resampling from the speech's rate to the device's.
                    int idx = (int) ((long) currentAt * speechRate / Math.max(1, rate));
                    if (idx < current.length) v = current[idx];
                    currentAt += 1;
                    if ((long) currentAt * speechRate / Math.max(1, rate) >= current.length) currentAt = current.length;
                }
                for (int c = 0; c < channels; c++) out.set(i * channels + c, v);
            }
        }
        return ts;
    }

    /** A little helper over the callback's buffer (16-bit little endian). */
    private static final class ShortBufferView {
        final ByteBuffer b; final int bytes;
        ShortBufferView(ByteBuffer b, int bytes) { this.b = b.order(ByteOrder.LITTLE_ENDIAN); this.bytes = bytes; }
        int frames(int channels) { return bytes / 2 / Math.max(1, channels); }
        void set(int i, short v) { b.putShort(i * 2, v); }
    }

    /* ---------------------------------------------------------------- in */

    /** Listens to a peer's audio track (called for every remote audio track while active). */
    public void listen(M5 app, String peerId, AudioTrack track) {
        if (!active || track == null || listeners.containsKey(peerId)) return;
        Listener l = new Listener(app, peerId, track);
        listeners.put(peerId, l);
        track.addSink(l);
    }

    public void forget(String peerId) { Listener l = listeners.remove(peerId); if (l != null) l.detach(); }

    private final class Listener implements AudioTrackSink {
        final M5 app;
        final String peerId;
        final AudioTrack track;
        final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        int rate = 48_000;
        long quietMs = 0, voicedMs = 0;

        Listener(M5 app, String peerId, AudioTrack track) { this.app = app; this.peerId = peerId; this.track = track; }

        void detach() { try { track.removeSink(this); } catch (RuntimeException ignored) { } }

        @Override
        public void onData(ByteBuffer data, int bits, int sampleRate, int channels, int frames, long at) {
            if (!active || bits != 16 || frames <= 0) return;
            rate = sampleRate;
            ByteBuffer b = data.duplicate().order(ByteOrder.LITTLE_ENDIAN);
            long sum = 0;
            byte[] mono = new byte[frames * 2];
            for (int f = 0; f < frames; f++) {
                int s = 0;
                for (int c = 0; c < channels; c++) s += b.getShort((f * channels + c) * 2);
                short v = (short) (s / Math.max(1, channels));
                mono[f * 2] = (byte) v;
                mono[f * 2 + 1] = (byte) (v >> 8);
                sum += (long) v * v;
            }
            double rms = Math.sqrt(sum / (double) frames);
            long ms = frames * 1000L / Math.max(1, sampleRate);
            boolean voiced = rms > 600;
            if (voiced) { voicedMs += ms; quietMs = 0; } else quietMs += ms;
            if (voicedMs > 0) pcm.write(mono, 0, mono.length);
            // An utterance ends after 700 ms of quiet (or at 15 s).
            if (voicedMs > 0 && (quietMs > 700 || voicedMs > 15_000)) {
                byte[] utterance = pcm.toByteArray();
                pcm.reset();
                long spoke = voicedMs;
                voicedMs = 0;
                quietMs = 0;
                if (spoke > 300) transcribe(app, peerId, Audio.resample(utterance, rate, Audio.RATE));
            }
        }
    }

    /** One at a time: the recogniser is one. */
    private void transcribe(M5 app, String peerId, byte[] pcm16k) {
        Runnable job = () -> Dictation.recognize(app, pcm16k, Audio.RATE, text -> {
            if (text != null && !text.trim().isEmpty() && sink != null) {
                String source = keep(app, pcm16k, Audio.RATE);
                sink.onTranscript(peerId, text.trim(), source);
            }
            next();
        });
        synchronized (recognitions) {
            recognitions.add(job);
            if (recognizing) return;
            recognizing = true;
        }
        next();
    }

    private void next() {
        Runnable r;
        synchronized (recognitions) {
            r = recognitions.poll();
            if (r == null) { recognizing = false; return; }
        }
        r.run();
    }

    /** The utterance as an AAC file in the vault (the source icon plays it); its id, or null. */
    static String keep(M5 app, byte[] pcm, int rate) {
        try {
            Voice.Clip clip = Voice.clip(app, pcm, rate);
            String id = "src-" + System.nanoTime();
            try (FileVault.Writer w = new FileVault.Writer(app, id)) { w.write(clip.bytes, 0, clip.bytes.length); }
            return id;
        } catch (Exception e) {
            Log.w("call", "source not kept: " + e.getMessage());
            return null;
        }
    }

    static short[] toShorts(byte[] b) {
        short[] s = new short[b.length / 2];
        for (int i = 0; i < s.length; i++) s[i] = (short) ((b[i * 2] & 0xff) | (b[i * 2 + 1] << 8));
        return s;
    }
}
