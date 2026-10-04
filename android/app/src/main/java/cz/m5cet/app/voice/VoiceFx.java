package cz.m5cet.app.voice;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The voice changer's effect chain (6.7) — client/src/lib/voice-fx.ts in
 * Java, with the same presets and numbers (test/fixtures/voice-fx.json keeps
 * both equal). Pure Java: the JVM tests run it on synthetic signals; the app
 * runs it on the microphone (MicFx: voice messages, calls).
 *
 *  1. spectral voice — an STFT phase vocoder: the excitation's pitch and
 *     the spectral envelope's formants move separately; whisper swaps the
 *     excitation for noise under the same envelope;
 *  2. robot — a ring modulator;
 *  3. echo — a feedback delay;
 *  4. gain and a soft limiter.
 * While it runs the delay is constant (one STFT frame: 1024 samples at
 * 48 kHz, 512 at 16 kHz). Not thread-safe: one instance per audio stream.
 */
public final class VoiceFx {

    /* ------------------------------------------------------------ params */

    /** The parameters (see voice-fx.ts › VoiceFxParams). */
    public static final class Params {
        public final double pitch, formant, robot, echo, echoMs, echoFeedback, whisper, gain;

        public Params(double pitch, double formant, double robot, double echo, double echoMs, double echoFeedback, double whisper, double gain) {
            this.pitch = clamp(pitch, -12, 12);
            this.formant = clamp(formant, -12, 12);
            double r = clamp(robot, 0, 400);
            this.robot = r > 0 && r < 20 ? 0 : r;
            this.echo = clamp(echo, 0, 1);
            this.echoMs = clamp(echoMs, 40, 1000);
            this.echoFeedback = clamp(echoFeedback, 0, 0.9);
            this.whisper = clamp(whisper, 0, 1);
            this.gain = clamp(gain, -12, 12);
        }

        public boolean neutral() { return pitch == 0 && formant == 0 && robot == 0 && echo == 0 && whisper == 0 && gain == 0; }

        Params with(String key, double v) {
            switch (key) {
                case "pitch": return new Params(v, formant, robot, echo, echoMs, echoFeedback, whisper, gain);
                case "formant": return new Params(pitch, v, robot, echo, echoMs, echoFeedback, whisper, gain);
                case "robot": return new Params(pitch, formant, v, echo, echoMs, echoFeedback, whisper, gain);
                case "echo": return new Params(pitch, formant, robot, v, echoMs, echoFeedback, whisper, gain);
                case "echoMs": return new Params(pitch, formant, robot, echo, v, echoFeedback, whisper, gain);
                case "echoFeedback": return new Params(pitch, formant, robot, echo, echoMs, v, whisper, gain);
                case "whisper": return new Params(pitch, formant, robot, echo, echoMs, echoFeedback, v, gain);
                case "gain": return new Params(pitch, formant, robot, echo, echoMs, echoFeedback, whisper, v);
                default: return this;
            }
        }

        /** A value by its name (the fixture's and the settings' keys). */
        public double get(String key) {
            switch (key) {
                case "pitch": return pitch;
                case "formant": return formant;
                case "robot": return robot;
                case "echo": return echo;
                case "echoMs": return echoMs;
                case "echoFeedback": return echoFeedback;
                case "whisper": return whisper;
                case "gain": return gain;
                default: throw new IllegalArgumentException(key);
            }
        }
    }

    public static final String[] KEYS = { "pitch", "formant", "robot", "echo", "echoMs", "echoFeedback", "whisper", "gain" };
    public static final Params NEUTRAL = new Params(0, 0, 0, 0, 250, 0.35, 0, 0);

    /** The preset ids, in the order the settings offer them ("custom": the user's own). */
    public static final String[] PRESET_IDS = { "off", "higher", "lower", "deep", "robot", "echo", "whisper", "anonymous", "custom" };

    /** The presets — the same names and numbers as VOICE_FX_PRESETS on the web. */
    public static final Map<String, Params> PRESETS;
    static {
        Map<String, Params> m = new LinkedHashMap<>();
        m.put("off", NEUTRAL);
        m.put("higher", NEUTRAL.with("pitch", 4).with("formant", 3));
        m.put("lower", NEUTRAL.with("pitch", -4).with("formant", -3));
        m.put("deep", NEUTRAL.with("pitch", -7).with("formant", -5));
        m.put("robot", NEUTRAL.with("robot", 70).with("gain", 2));
        m.put("echo", NEUTRAL.with("echo", 0.5).with("echoMs", 280).with("echoFeedback", 0.45));
        m.put("whisper", NEUTRAL.with("whisper", 1).with("gain", 2));
        m.put("anonymous", NEUTRAL.with("pitch", -3).with("formant", -6).with("whisper", 0.35).with("gain", 2));
        PRESETS = Collections.unmodifiableMap(m);
    }

    /** Each parameter's range. */
    public static double[] limits(String key) {
        switch (key) {
            case "pitch": case "formant": case "gain": return new double[]{ -12, 12 };
            case "robot": return new double[]{ 0, 400 };
            case "echo": case "whisper": return new double[]{ 0, 1 };
            case "echoMs": return new double[]{ 40, 1000 };
            case "echoFeedback": return new double[]{ 0, 0.9 };
            default: throw new IllegalArgumentException(key);
        }
    }

    /** A preset's parameters; "custom" (or an unknown id) takes the user's own. */
    public static Params paramsFor(String preset, Params custom) {
        Params p = PRESETS.get(preset);
        return p != null ? p : custom == null ? NEUTRAL : custom;
    }

    static double clamp(double v, double lo, double hi) { return Double.isNaN(v) ? lo : Math.max(lo, Math.min(hi, v)); }

    /* --------------------------------------------------------------- FFT */

    /** In-place radix-2 complex FFT of one size. */
    public static final class Fft {
        final int n;
        private final double[] cos, sin;
        private final int[] rev;

        public Fft(int n) {
            if (n < 2 || (n & (n - 1)) != 0) throw new IllegalArgumentException("FFT size must be a power of two");
            this.n = n;
            cos = new double[n / 2];
            sin = new double[n / 2];
            for (int i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
            rev = new int[n];
            int bits = Integer.numberOfTrailingZeros(n);
            for (int i = 0; i < n; i++) rev[i] = Integer.reverse(i) >>> (32 - bits);
        }

        /** Forward (e^-i) or inverse (e^+i, not divided by n). */
        public void transform(double[] re, double[] im, boolean inverse) {
            for (int i = 0; i < n; i++) {
                int j = rev[i];
                if (j > i) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
            }
            double sign = inverse ? 1 : -1;
            for (int size = 2; size <= n; size <<= 1) {
                int half = size >> 1, step = n / size;
                for (int start = 0; start < n; start += size) {
                    for (int k = 0; k < half; k++) {
                        double wr = cos[k * step], wi = sign * sin[k * step];
                        int a = start + k, b = a + half;
                        double tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
                        re[b] = re[a] - tr; im[b] = im[a] - ti;
                        re[a] += tr; im[a] += ti;
                    }
                }
            }
        }
    }

    /** xorshift32 — the same numbers as voice-fx.ts makeNoise for the same seed. */
    static final class Noise {
        private int s;
        Noise(int seed) { s = seed == 0 ? 1 : seed; }
        double next() {
            s ^= s << 13;
            s ^= s >>> 17;
            s ^= s << 5;
            return (s & 0xFFFFFFFFL) / 4294967296.0;
        }
    }

    /** The STFT frame for a sample rate. */
    public static int frameSizeFor(int sampleRate) { return sampleRate > 32_000 ? 1024 : 512; }

    /* ---------------------------------------------------- spectral voice */

    static final class Spectral {
        final int size, half, hop, latency;
        private final Fft fft;
        private final double[] win, inFifo, outFifo, accum, re, im;
        private final double[] lastPhase, sumPhase, anaMag, anaFreq, synMag, synFreq, env, tmp;
        private final int smoothHalf;
        private final double follow;
        private final Noise rand;
        private int rover;
        private double pitchRatio = 1, formantRatio = 1, whisper = 0, level = 1, powIn = 0, powOut = 0, makeup = 1;
        private boolean active;

        Spectral(int sampleRate, int seed) {
            int n = frameSizeFor(sampleRate);
            size = n; half = n / 2; hop = n / 4; latency = n;
            fft = new Fft(n);
            win = new double[n];
            for (int i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
            inFifo = new double[n];
            outFifo = new double[n];
            accum = new double[2 * n];
            re = new double[n];
            im = new double[n];
            int bins = half + 1;
            lastPhase = new double[bins]; sumPhase = new double[bins]; anaMag = new double[bins]; anaFreq = new double[bins];
            synMag = new double[bins]; synFreq = new double[bins]; env = new double[bins]; tmp = new double[bins];
            smoothHalf = Math.max(2, (int) Math.ceil(200 / ((double) sampleRate / n)));
            rover = n - hop;
            rand = new Noise(seed);
            follow = 1 / (0.3 * sampleRate);
        }

        void set(double pitch, double formant, double whisper) {
            pitchRatio = Math.pow(2, pitch / 12);
            formantRatio = Math.pow(2, formant / 12);
            this.whisper = clamp(whisper, 0, 1);
            boolean on = pitch != 0 || formant != 0 || whisper > 0;
            if (on && !active) {
                java.util.Arrays.fill(lastPhase, 0); java.util.Arrays.fill(sumPhase, 0); java.util.Arrays.fill(accum, 0);
                level = 1; powIn = 0; powOut = 0; makeup = 1;
            }
            active = on;
        }

        void process(double[] buf, int len) {
            int n = size;
            for (int i = 0; i < len; i++) {
                double x = buf[i];
                inFifo[rover] = x;
                double y = outFifo[rover - (n - hop)];
                if (active) {
                    powIn += follow * (x * x - powIn);
                    powOut += follow * (y * y - powOut);
                    double want = clamp(Math.sqrt((powIn + 1e-9) / (powOut + 1e-9)), 0.5, 3);
                    makeup += follow * (want - makeup);
                    y *= makeup;
                }
                buf[i] = y;
                rover++;
                if (rover >= n) {
                    rover = n - hop;
                    if (active) frame();
                    else System.arraycopy(inFifo, 0, outFifo, 0, hop);
                    System.arraycopy(inFifo, hop, inFifo, 0, n - hop);
                }
            }
        }

        private void frame() {
            int n = size, osamp = n / hop;
            double expct = 2 * Math.PI * hop / n;
            for (int k = 0; k < n; k++) { re[k] = inFifo[k] * win[k]; im[k] = 0; }
            fft.transform(re, im, false);
            for (int k = 0; k <= half; k++) {
                double mag = Math.hypot(re[k], im[k]);
                double phase = Math.atan2(im[k], re[k]);
                double d = phase - lastPhase[k];
                lastPhase[k] = phase;
                d -= k * expct;
                d -= 2 * Math.PI * Math.floor(d / (2 * Math.PI) + 0.5); // JS Math.round
                anaMag[k] = mag;
                anaFreq[k] = k + osamp * d / (2 * Math.PI);
            }
            smooth(anaMag, tmp);
            smooth(tmp, env);
            double peak = 0;
            for (int k = 0; k <= half; k++) if (env[k] > peak) peak = env[k];
            double floor = peak * 1e-4 + 1e-12;
            java.util.Arrays.fill(synMag, 0);
            java.util.Arrays.fill(synFreq, 0);
            for (int k = 0; k <= half; k++) {
                int j = (int) Math.floor(k * pitchRatio + 0.5);
                if (j > half) break;
                synMag[j] += anaMag[k] / Math.max(env[k], floor);
                synFreq[j] = anaFreq[k] * pitchRatio;
            }
            double w = whisper, energyIn = 0, energyOut = 0;
            for (int k = 0; k <= half; k++) energyIn += anaMag[k] * anaMag[k];
            for (int j = 0; j <= half; j++) {
                double at = j / formantRatio;
                int a = (int) Math.floor(at);
                double e = a >= half ? 0 : env[a] + (env[a + 1] - env[a]) * (at - a);
                double d = synFreq[j] - j;
                d = 2 * Math.PI * d / osamp + j * expct;
                sumPhase[j] += d;
                double voiced = (1 - w) * synMag[j] * e;
                double r = voiced * Math.cos(sumPhase[j]), i = voiced * Math.sin(sumPhase[j]);
                if (w > 0) {
                    double ph = 2 * Math.PI * rand.next();
                    r += w * e * Math.cos(ph);
                    i += w * e * Math.sin(ph);
                }
                re[j] = r;
                im[j] = i;
                energyOut += r * r + i * i;
            }
            double target = energyOut > 1e-20 ? Math.sqrt(energyIn / energyOut) : 1;
            level = level * 0.5 + clamp(target, 0.1, 10) * 0.5;
            for (int j = 0; j <= half; j++) {
                double g = (j == 0 || j == half ? 1 : 2) * level;
                re[j] *= g;
                im[j] *= g;
            }
            for (int j = half + 1; j < n; j++) { re[j] = 0; im[j] = 0; }
            fft.transform(re, im, true);
            double scale = 1.0 / (n * 1.5);
            for (int k = 0; k < n; k++) accum[k] += win[k] * re[k] * scale;
            System.arraycopy(accum, 0, outFifo, 0, hop);
            System.arraycopy(accum, hop, accum, 0, n);
            java.util.Arrays.fill(accum, n, n + hop, 0);
        }

        private void smooth(double[] src, double[] dst) {
            int m = src.length, h = smoothHalf, count = 0;
            double sum = 0;
            for (int k = 0; k < Math.min(h, m); k++) { sum += src[k]; count++; }
            for (int k = 0; k < m; k++) {
                int add = k + h, drop = k - h - 1;
                if (add < m) { sum += src[add]; count++; }
                if (drop >= 0) { sum -= src[drop]; count--; }
                dst[k] = sum / count;
            }
        }
    }

    /* ------------------------------------------------------- small units */

    /** x · sin(2π f t). */
    static final class Ring {
        private final int rate;
        private double phase, step;
        Ring(int rate) { this.rate = rate; }
        void set(double hz) { step = hz > 0 ? 2 * Math.PI * hz / rate : 0; if (hz == 0) phase = 0; }
        boolean on() { return step > 0; }
        double next(double x) {
            phase += step;
            if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
            return x * Math.sin(phase);
        }
    }

    /** y = x + mix · d[t-D];  d[t] = x + fb · d[t-D]. */
    static final class Echo {
        private final int rate;
        private final double[] buf;
        private int at, delay = 1;
        private double mix, feedback;
        Echo(int rate) { this.rate = rate; buf = new double[(int) Math.ceil(rate * 1.001) + 1]; }
        void set(double mix, double ms, double feedback) {
            if (mix <= 0 && this.mix > 0) java.util.Arrays.fill(buf, 0);
            this.mix = clamp(mix, 0, 1);
            this.feedback = clamp(feedback, 0, 0.9);
            delay = (int) clamp(Math.round(ms / 1000 * rate), 1, buf.length - 1);
        }
        boolean on() { return mix > 0; }
        double next(double x) {
            int len = buf.length, r = at - delay;
            if (r < 0) r += len;
            double d = buf[r];
            buf[at] = x + feedback * d;
            at = at + 1 == len ? 0 : at + 1;
            return x + mix * d;
        }
    }

    /** Above 0.8 the level bends softly toward 1 (never past it). */
    public static double softLimit(double x) {
        double a = Math.abs(x);
        if (a <= 0.8) return x;
        return Math.signum(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
    }

    /* --------------------------------------------------------- the chain */

    public final int sampleRate;
    private final Spectral spectral;
    private final Ring ring;
    private final Echo echo;
    private Params params = NEUTRAL;
    private double gain = 1;
    private double[] work = new double[0];

    public VoiceFx(int sampleRate, Params params) { this(sampleRate, params, 1); }

    public VoiceFx(int sampleRate, Params params, int seed) {
        this.sampleRate = sampleRate;
        spectral = new Spectral(sampleRate, seed);
        ring = new Ring(sampleRate);
        echo = new Echo(sampleRate);
        set(params);
    }

    /** The delay the chain adds, in samples. */
    public int latency() { return spectral.latency; }

    public Params params() { return params; }

    public void set(Params p) {
        params = p == null ? NEUTRAL : p;
        spectral.set(params.pitch, params.formant, params.whisper);
        ring.set(params.robot);
        echo.set(params.echo, params.echoMs, params.echoFeedback);
        gain = Math.pow(10, params.gain / 20);
    }

    /** Mono samples (-1 … 1) changed in place. */
    public void process(double[] buf, int len) {
        spectral.process(buf, len);
        boolean r = ring.on(), e = echo.on();
        for (int i = 0; i < len; i++) {
            double x = buf[i];
            if (r) x = ring.next(x);
            if (e) x = echo.next(x);
            buf[i] = softLimit(x * gain);
        }
    }

    /** 16-bit PCM (mono, or interleaved channels mixed down and spread back) changed in place. */
    public void process(short[] pcm, int offset, int frames, int channels) {
        if (work.length < frames) work = new double[frames];
        int ch = Math.max(1, channels);
        for (int f = 0; f < frames; f++) {
            double s = 0;
            for (int c = 0; c < ch; c++) s += pcm[offset + f * ch + c];
            work[f] = s / ch / 32768.0;
        }
        process(work, frames);
        for (int f = 0; f < frames; f++) {
            short v = (short) Math.max(-32768, Math.min(32767, Math.round(work[f] * 32767)));
            for (int c = 0; c < ch; c++) pcm[offset + f * ch + c] = v;
        }
    }
}
