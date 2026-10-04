package cz.m5cet.app.voice;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.InteropTest;

/**
 * 6.7 voice changer on the phone: the same presets, ranges, defaults and
 * operator gate as the web (test/fixtures/voice-fx.json — test/voice-fx.test.ts
 * checks the web against the same file), and the chain on synthetic signals:
 * pitch moves a sine by the ratio, robot gives the sidebands, echo repeats,
 * the limiter holds, idle is a pure delay, 16-bit PCM in place.
 */
public class VoiceFxTest {
    static JSONObject fix;

    @BeforeClass public static void load() throws Exception {
        fix = new JSONObject(new String(Files.readAllBytes(InteropTest.fixtures().resolve("voice-fx.json")), StandardCharsets.UTF_8));
    }

    static double[] sine(int rate, double hz, double seconds, double amp) {
        double[] x = new double[(int) Math.round(rate * seconds)];
        for (int i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * hz * i / rate);
        return x;
    }

    /** Magnitudes (Hann) of n = the largest power of two ≤ len, from `from`. */
    static double[] mags(double[] x, int from, int len) {
        int n = Integer.highestOneBit(len);
        double[] re = new double[n], im = new double[n];
        for (int i = 0; i < n; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
        new VoiceFx.Fft(n).transform(re, im, false);
        double[] m = new double[n / 2];
        for (int k = 0; k < n / 2; k++) m[k] = Math.hypot(re[k], im[k]);
        return m;
    }

    static double peakHz(double[] x, int rate, int from, int len) {
        double[] m = mags(x, from, len);
        int best = 1;
        for (int k = 1; k < m.length; k++) if (m[k] > m[best]) best = k;
        return (double) best * rate / (m.length * 2);
    }

    static double levelAt(double[] x, int rate, double hz, int from, int len) {
        double[] m = mags(x, from, len);
        int k = (int) Math.round(hz * m.length * 2 / rate);
        return Math.max(m[k - 1], Math.max(m[k], m[k + 1]));
    }

    static VoiceFx.Params params(JSONObject o) throws Exception {
        VoiceFx.Params p = VoiceFx.NEUTRAL;
        for (String k : VoiceFx.KEYS) if (o.has(k)) p = p.with(k, o.getDouble(k));
        return p;
    }

    static double[] run(VoiceFx.Params p, double[] x, int rate) {
        double[] out = x.clone();
        new VoiceFx(rate, p).process(out, out.length);
        return out;
    }

    static double rms(double[] x, int a, int b) { double s = 0; for (int i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); }

    @Test public void thePresetsAreTheWebs() throws Exception {
        JSONArray ids = fix.getJSONArray("presetIds");
        assertEquals(ids.length(), VoiceFx.PRESET_IDS.length);
        for (int i = 0; i < ids.length(); i++) assertEquals(ids.getString(i), VoiceFx.PRESET_IDS[i]);
        JSONObject presets = fix.getJSONObject("presets");
        assertEquals(presets.length(), VoiceFx.PRESETS.size());
        for (java.util.Iterator<String> it = presets.keys(); it.hasNext(); ) {
            String id = it.next();
            JSONObject p = presets.getJSONObject(id);
            VoiceFx.Params mine = VoiceFx.PRESETS.get(id);
            for (String k : VoiceFx.KEYS) assertEquals(id + " " + k, p.getDouble(k), mine.get(k), 0);
        }
        JSONArray keys = fix.getJSONArray("keys");
        for (int i = 0; i < keys.length(); i++) assertEquals(keys.getString(i), VoiceFx.KEYS[i]);
        JSONObject limits = fix.getJSONObject("limits");
        for (String k : VoiceFx.KEYS) assertArrayEquals(k, new double[]{ limits.getJSONArray(k).getDouble(0), limits.getJSONArray(k).getDouble(1) }, VoiceFx.limits(k), 0);
        JSONArray frames = fix.getJSONArray("frames");
        for (int i = 0; i < frames.length(); i++) assertEquals(frames.getJSONObject(i).getInt("size"), VoiceFx.frameSizeFor(frames.getJSONObject(i).getInt("rate")));
    }

    @Test public void theDefaultsAreTheWebs() throws Exception {
        Map<String, Object> d = new HashMap<>();
        MicFx.defaults(d);
        JSONObject def = fix.getJSONObject("defaults");
        assertEquals(def.getBoolean("on"), d.get("voiceFx.on"));
        assertEquals(def.getString("preset"), d.get("voiceFx.preset"));
        JSONObject custom = def.getJSONObject("custom");
        for (String k : VoiceFx.KEYS) assertEquals(k, custom.getDouble(k), (Double) d.get("voiceFx." + k), 0);
        // The settings' parameters: a preset, or the custom values.
        assertEquals(-7, MicFx.fromSettings(d::get).pitch, 0);
        d.put("voiceFx.preset", "custom");
        assertEquals(-5, MicFx.fromSettings(d::get).pitch, 0);
        assertEquals(-3, MicFx.fromSettings(d::get).formant, 0);
    }

    @Test public void clampsWhatComesIn() throws Exception {
        VoiceFx.Params p = new VoiceFx.Params(40, -99, 5, 2, 5, 3, -1, 99);
        assertEquals(12, p.pitch, 0);
        assertEquals(-12, p.formant, 0);
        assertEquals(0, p.robot, 0); // under 20 Hz is off
        assertEquals(1, p.echo, 0);
        assertEquals(40, p.echoMs, 0);
        assertEquals(0.9, p.echoFeedback, 0);
        assertEquals(0, p.whisper, 0);
        assertEquals(12, p.gain, 0);
        assertTrue(VoiceFx.PRESETS.get("off").neutral());
        assertFalse(VoiceFx.PRESETS.get("echo").neutral());
        assertEquals(VoiceFx.NEUTRAL, VoiceFx.paramsFor("custom", null));
    }

    @Test public void fftRoundTrip() throws Exception {
        int n = 256;
        double[] x = new double[n], re = new double[n], im = new double[n];
        for (int i = 0; i < n; i++) { x[i] = Math.sin(i * 0.3) + 0.2 * Math.cos(i * 1.7); re[i] = x[i]; }
        VoiceFx.Fft f = new VoiceFx.Fft(n);
        f.transform(re, im, false);
        f.transform(re, im, true);
        for (int i = 0; i < n; i++) assertEquals(x[i], re[i] / n, 1e-9);
    }

    @Test public void idleIsAPureDelay() throws Exception {
        for (int rate : new int[]{ 48_000, 16_000 }) {
            double[] x = sine(rate, 440, 0.3, 0.5);
            double[] out = run(VoiceFx.NEUTRAL, x, rate);
            int d = new VoiceFx(rate, VoiceFx.NEUTRAL).latency();
            assertEquals(VoiceFx.frameSizeFor(rate), d);
            for (int i = d; i < x.length; i += 97) assertEquals(x[i - d], out[i], 1e-12);
            for (int i = 0; i < d; i++) assertEquals(0, out[i], 0);
        }
    }

    @Test public void pitchMovesASineByTheRatio() throws Exception {
        JSONArray sines = fix.getJSONArray("sines");
        for (int i = 0; i < sines.length(); i++) {
            JSONObject c = sines.getJSONObject(i);
            int rate = c.getInt("rate");
            double[] x = sine(rate, c.getDouble("hz"), 1, 0.5);
            double[] out = run(params(c.getJSONObject("params")), x, rate);
            double found = peakHz(out, rate, (int) (rate * 0.3), (int) (rate * 0.6));
            double want = c.getDouble("peakHz");
            assertTrue(c + " → " + found, Math.abs(found - want) / want < 0.03);
            double ratio = rms(out, rate / 2, rate) / rms(x, rate / 2, rate);
            assertTrue("loudness " + ratio, ratio > 0.6 && ratio < 1.5);
        }
    }

    @Test public void robotGivesTheSidebandsNotTheTone() throws Exception {
        JSONArray rings = fix.getJSONArray("rings");
        for (int i = 0; i < rings.length(); i++) {
            JSONObject c = rings.getJSONObject(i);
            int rate = c.getInt("rate");
            double hz = c.getDouble("hz");
            double[] out = run(VoiceFx.NEUTRAL.with("robot", c.getDouble("robot")), sine(rate, hz, 1, 0.5), rate);
            JSONArray side = c.getJSONArray("sidebands");
            double s = Math.min(levelAt(out, rate, side.getDouble(0), rate / 4, rate / 2), levelAt(out, rate, side.getDouble(1), rate / 4, rate / 2));
            assertTrue(c.toString(), s > 20 * levelAt(out, rate, hz, rate / 4, rate / 2));
        }
    }

    @Test public void echoRepeatsWithTheFeedback() throws Exception {
        VoiceFx.Echo e = new VoiceFx.Echo(1000);
        e.set(0.5, 100, 0.4);
        double[] out = new double[400];
        for (int i = 0; i < out.length; i++) out[i] = e.next(i == 0 ? 1 : 0);
        assertEquals(1, out[0], 0);
        assertEquals(0.5, out[100], 1e-12);
        assertEquals(0.2, out[200], 1e-12);
        assertEquals(0.08, out[300], 1e-12);
        for (int i = 1; i < out.length; i++) if (i % 100 != 0) assertEquals(0, out[i], 0);
    }

    @Test public void theLimiterHolds() throws Exception {
        assertEquals(0.5, VoiceFx.softLimit(0.5), 0);
        assertEquals(-0.8, VoiceFx.softLimit(-0.8), 0);
        for (double v : new double[]{ 0.9, 1.5, 10, -3 }) {
            assertTrue(Math.abs(VoiceFx.softLimit(v)) <= 1);
            assertTrue(Math.abs(VoiceFx.softLimit(v)) > 0.8);
        }
        double[] out = run(VoiceFx.NEUTRAL.with("gain", 12), sine(16_000, 300, 0.5, 0.9), 16_000);
        for (double v : out) assertTrue(Math.abs(v) <= 1);
    }

    @Test public void whisperIsTheSameNoiseForTheSameSeedAndAboutAsLoud() throws Exception {
        int rate = 16_000;
        double[] x = sine(rate, 300, 1, 0.5);
        for (int h = 2; h < 12; h++) { double[] y = sine(rate, 300 * h, 1, 0.5 / h); for (int i = 0; i < x.length; i++) x[i] += y[i]; }
        VoiceFx.Params w = VoiceFx.PRESETS.get("whisper");
        double[] a = run(w, x, rate), b = run(w, x, rate);
        assertArrayEquals(a, b, 0);
        double ratio = rms(a, rate / 2, rate) / rms(x, rate / 2, rate);
        assertTrue("whisper loudness " + ratio, ratio > 0.4 && ratio < 2.5);
        VoiceFx.Noise n = new VoiceFx.Noise(7), m = new VoiceFx.Noise(7);
        for (int i = 0; i < 5; i++) assertEquals(n.next(), m.next(), 0);
    }

    @Test public void sixteenBitPcmInPlaceAndStereoStaysStereo() throws Exception {
        int rate = 16_000;
        short[] pcm = new short[rate * 2];
        for (int f = 0; f < rate; f++) { short v = (short) (8000 * Math.sin(2 * Math.PI * 300 * f / rate)); pcm[f * 2] = v; pcm[f * 2 + 1] = v; }
        VoiceFx fx = new VoiceFx(rate, VoiceFx.PRESETS.get("deep"));
        fx.process(pcm, 0, rate, 2);
        int differ = 0;
        for (int f = 0; f < rate; f++) { assertEquals(pcm[f * 2], pcm[f * 2 + 1]); if (pcm[f * 2] != 0) differ++; }
        assertTrue(differ > rate / 2);
    }

    @Test public void aCallBufferChangesInPlace() throws Exception {
        int rate = 48_000, frames = 480;
        MicFx.use(VoiceFx.PRESETS.get("robot"));
        try {
            MicFx.Stream s = new MicFx.Stream(rate);
            short[] work = new short[0];
            ByteBuffer buf = ByteBuffer.allocateDirect(frames * 2).order(ByteOrder.LITTLE_ENDIAN);
            List<Short> before = new ArrayList<>(), after = new ArrayList<>();
            for (int block = 0; block < 20; block++) {
                for (int i = 0; i < frames; i++) buf.putShort(i * 2, (short) (8000 * Math.sin(2 * Math.PI * 440 * (block * frames + i) / rate)));
                if (block == 19) for (int i = 0; i < frames; i++) before.add(buf.getShort(i * 2));
                work = MicFx.processBuffer(s, buf, 1, frames * 2, work);
                if (block == 19) for (int i = 0; i < frames; i++) after.add(buf.getShort(i * 2));
            }
            assertTrue(work.length >= frames);
            assertTrue(s.latency() > 0);
            assertFalse(before.equals(after));
        } finally {
            MicFx.use(VoiceFx.NEUTRAL);
        }
    }

    @Test public void aStreamNeverOnTouchesNothing() throws Exception {
        MicFx.use(VoiceFx.NEUTRAL);
        MicFx.Stream s = new MicFx.Stream(16_000);
        short[] pcm = { 1, 2, 3, -4, 5 };
        s.process(pcm, 0, pcm.length, 1);
        assertArrayEquals(new short[]{ 1, 2, 3, -4, 5 }, pcm);
        assertEquals(0, s.latency());
    }
}
