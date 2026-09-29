package cz.m5cet.app.voice;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaRecorder;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;

import cz.m5cet.app.core.Log;

/**
 * Audio helpers (6.1): recording PCM from the microphone with a level
 * meter, reading a WAV, encoding PCM to AAC in MP4 (audio/mp4 — what every
 * browser plays, so a voice message from the phone works on the web), and
 * resampling for the call's audio.
 */
public final class Audio {
    private Audio() {}

    public static final int RATE = 16_000;

    /** Records 16 kHz mono PCM until stop(); level() is 0–1 for a meter. */
    public static final class Recorder {
        private final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        private AudioRecord rec;
        private Thread thread;
        private volatile boolean running;
        private volatile float level;
        private long startedAt;

        @SuppressWarnings("MissingPermission")
        public boolean start() {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            try {
                rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE));
                if (rec.getState() != AudioRecord.STATE_INITIALIZED) { rec.release(); rec = null; return false; }
                rec.startRecording();
            } catch (RuntimeException e) {
                Log.w("voice", "recording failed: " + e.getMessage());
                return false;
            }
            running = true;
            startedAt = System.currentTimeMillis();
            thread = new Thread(() -> {
                byte[] buf = new byte[3200];
                while (running) {
                    int n = rec.read(buf, 0, buf.length);
                    if (n <= 0) continue;
                    synchronized (pcm) { if (pcm.size() < 60 * 60 * RATE * 2) pcm.write(buf, 0, n); }
                    long sum = 0;
                    for (int i = 0; i + 1 < n; i += 2) { short s = (short) ((buf[i] & 0xff) | (buf[i + 1] << 8)); sum += (long) s * s; }
                    level = (float) Math.min(1, Math.sqrt(sum / (double) Math.max(1, n / 2)) / 8000.0);
                }
            }, "m5-rec");
            thread.start();
            return true;
        }

        public float level() { return level; }
        public long elapsedMs() { return running ? System.currentTimeMillis() - startedAt : 0; }

        /** Stops and returns the PCM. */
        public byte[] stop() {
            running = false;
            try { if (thread != null) thread.join(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            if (rec != null) { try { rec.stop(); } catch (RuntimeException ignored) { } rec.release(); rec = null; }
            synchronized (pcm) { return pcm.toByteArray(); }
        }
    }

    /** A WAV file's PCM and rate (16-bit; stereo is mixed down to mono). */
    public static final class Pcm {
        public final byte[] data;
        public final int rate;
        Pcm(byte[] d, int r) { data = d; rate = r; }
    }

    public static Pcm readWav(File f) throws IOException {
        byte[] b = Files.readAllBytes(f.toPath());
        ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
        if (b.length < 44 || bb.getInt(0) != 0x46464952 || bb.getInt(8) != 0x45564157) throw new IOException("not a WAV file");
        int at = 12, channels = 1, rate = RATE, bits = 16;
        while (at + 8 <= b.length) {
            int id = bb.getInt(at), len = bb.getInt(at + 4);
            if (id == 0x20746d66) { channels = bb.getShort(at + 10); rate = bb.getInt(at + 12); bits = bb.getShort(at + 22); }
            if (id == 0x61746164) {
                if (bits != 16) throw new IOException("WAV is not 16-bit");
                int n = Math.min(len < 0 ? b.length - at - 8 : len, b.length - at - 8);
                byte[] data = new byte[n];
                System.arraycopy(b, at + 8, data, 0, n);
                if (channels == 2) data = mono(data);
                return new Pcm(data, rate);
            }
            at += 8 + len + (len & 1);
        }
        throw new IOException("WAV without data");
    }

    static byte[] mono(byte[] stereo) {
        byte[] out = new byte[stereo.length / 2];
        for (int i = 0, o = 0; i + 3 < stereo.length; i += 4, o += 2) {
            int l = (short) ((stereo[i] & 0xff) | (stereo[i + 1] << 8)), r = (short) ((stereo[i + 2] & 0xff) | (stereo[i + 3] << 8));
            int m = (l + r) / 2;
            out[o] = (byte) m; out[o + 1] = (byte) (m >> 8);
        }
        return out;
    }

    /** Linear resampling of 16-bit mono PCM. */
    public static byte[] resample(byte[] pcm, int from, int to) {
        if (from == to || pcm.length < 4) return pcm;
        int n = pcm.length / 2, m = (int) ((long) n * to / from);
        byte[] out = new byte[m * 2];
        for (int i = 0; i < m; i++) {
            double src = (double) i * from / to;
            int a = (int) src;
            double f = src - a;
            int s0 = (short) ((pcm[a * 2] & 0xff) | (pcm[a * 2 + 1] << 8));
            int s1 = a + 1 < n ? (short) ((pcm[(a + 1) * 2] & 0xff) | (pcm[(a + 1) * 2 + 1] << 8)) : s0;
            int v = (int) Math.round(s0 + (s1 - s0) * f);
            out[i * 2] = (byte) v; out[i * 2 + 1] = (byte) (v >> 8);
        }
        return out;
    }

    public static long durationMs(byte[] pcm, int rate) { return pcm.length / 2 * 1000L / Math.max(1, rate); }

    /** PCM (16-bit mono) → AAC-LC in an MP4 file (audio/mp4). */
    public static void encodeAac(byte[] pcm, int rate, File out) throws IOException {
        MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 1);
        fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        fmt.setInteger(MediaFormat.KEY_BIT_RATE, 48_000);
        fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384);
        MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        MediaMuxer mux = new MediaMuxer(out.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        try {
            codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int track = -1, at = 0;
            boolean inputDone = false, outputDone = false;
            long presentation = 0;
            while (!outputDone) {
                if (!inputDone) {
                    int ix = codec.dequeueInputBuffer(10_000);
                    if (ix >= 0) {
                        ByteBuffer in = codec.getInputBuffer(ix);
                        int n = Math.min(in.remaining(), Math.min(8192, pcm.length - at));
                        if (n <= 0) {
                            codec.queueInputBuffer(ix, 0, 0, presentation, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            in.put(pcm, at, n);
                            codec.queueInputBuffer(ix, 0, n, presentation, 0);
                            at += n;
                            presentation = (long) at / 2 * 1_000_000L / rate;
                        }
                    }
                }
                int ox = codec.dequeueOutputBuffer(info, 10_000);
                if (ox == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { track = mux.addTrack(codec.getOutputFormat()); mux.start(); }
                else if (ox >= 0) {
                    ByteBuffer o = codec.getOutputBuffer(ox);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                    if (info.size > 0 && track >= 0) { o.position(info.offset); o.limit(info.offset + info.size); mux.writeSampleData(track, o, info); }
                    codec.releaseOutputBuffer(ox, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                }
            }
        } finally {
            try { codec.stop(); } catch (RuntimeException ignored) { }
            codec.release();
            try { mux.stop(); } catch (RuntimeException ignored) { }
            mux.release();
        }
    }

    /** A WAV header + PCM (for players that want a file). */
    public static void writeWav(byte[] pcm, int rate, File out) throws IOException {
        try (RandomAccessFile f = new RandomAccessFile(out, "rw")) {
            ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
            h.putInt(0x46464952).putInt(36 + pcm.length).putInt(0x45564157).putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16).putInt(0x61746164).putInt(pcm.length);
            f.setLength(0);
            f.write(h.array());
            f.write(pcm);
        }
    }
}
