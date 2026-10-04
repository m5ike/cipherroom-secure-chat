// The voice changer (6.7): the effect chain on synthetic signals (pitch and
// formant move separately, robot, echo, whisper, the limiter, a constant
// delay), the presets and the operator's gate as test/fixtures/voice-fx.json
// has them — the JVM test (VoiceFxTest) reads the same file, so the web and
// Android agree.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Echo, Fft, NEUTRAL_FX, RingMod, SpectralVoice, VOICE_FX_LIMITS, VOICE_FX_PRESETS, VOICE_FX_PRESET_IDS, VoiceFx,
  fxParamsFor, frameSizeFor, isNeutralFx, makeNoise, sanitizeFxParams, softLimit,
} from "../client/src/lib/voice-fx";
import { DEFAULT_VOICE_FX, getVoiceFx, loadVoiceFx, onVoiceFxChange, resetVoiceFxForTests, sanitizeVoiceFxSettings, setVoiceFx, settingsParams } from "../client/src/lib/voice-fx-settings";
import { decide, MODULE_BY_ID, moduleAllowed, moduleOfPanel, sanitizeModules } from "../client/src/lib/modules";

const FIX = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", "voice-fx.json"), "utf8")) as {
  keys: string[]; presetIds: string[]; presets: Record<string, Record<string, number>>; limits: Record<string, [number, number]>;
  defaults: { on: boolean; preset: string; custom: Record<string, number> };
  frames: Array<{ rate: number; size: number }>;
  sines: Array<{ rate: number; hz: number; params: Record<string, number>; peakHz: number }>;
  rings: Array<{ rate: number; hz: number; robot: number; sidebands: [number, number] }>;
  gate: Array<{ about: string; rule: Record<string, unknown> | null; groups: string[]; allowed: boolean }>;
};

const sine = (rate: number, hz: number, seconds: number, amp = 0.5) => Float64Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

/** Magnitude spectrum (Hann) of `len` samples from `from`. */
function spectrum(x: ArrayLike<number>, from: number, len: number) {
  const n = 1 << Math.floor(Math.log2(len));
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  new Fft(n).transform(re, im);
  return { mags: Float64Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k])), n };
}
function peakHz(x: ArrayLike<number>, rate: number, from: number, len: number) {
  const { mags, n } = spectrum(x, from, len);
  let best = 1;
  for (let k = 1; k < mags.length; k++) if (mags[k] > mags[best]) best = k;
  return (best * rate) / n;
}
function levelAt(x: ArrayLike<number>, rate: number, hz: number, from: number, len: number) {
  const { mags, n } = spectrum(x, from, len);
  const k = Math.round((hz * n) / rate);
  return Math.max(mags[k - 1], mags[k], mags[k + 1]);
}
const rms = (x: ArrayLike<number>, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

/** A vowel: a pulse train at f0 through one resonance (the formant). */
function vowel(rate: number, f0: number, formant: number, seconds: number) {
  const len = Math.round(rate * seconds), x = new Float64Array(len), period = Math.round(rate / f0);
  const r = Math.exp((-Math.PI * 120) / rate), th = (2 * Math.PI * formant) / rate, a1 = 2 * r * Math.cos(th), a2 = -r * r;
  let y1 = 0, y2 = 0, peak = 0;
  for (let i = 0; i < len; i++) { const y = (i % period === 0 ? 1 : 0) + a1 * y1 + a2 * y2; y2 = y1; y1 = y; x[i] = y; peak = Math.max(peak, Math.abs(y)); }
  for (let i = 0; i < len; i++) x[i] = (0.5 * x[i]) / peak;
  return x;
}
/** Where the smoothed spectrum peaks (the formant). */
function envelopePeak(x: ArrayLike<number>, rate: number) {
  const { mags, n } = spectrum(x, rate / 6, 32768);
  const binHz = rate / n, h = Math.round(250 / binHz);
  let best = 0, top = 0;
  for (let k = h; k < mags.length - h; k++) { let s = 0; for (let j = -h; j <= h; j++) s += mags[k + j]; if (s > top) { top = s; best = k; } }
  return best * binHz;
}
/** The fundamental (the first strong autocorrelation peak). */
function f0(x: ArrayLike<number>, rate: number) {
  const a = Math.round(rate / 3), n = 8192, lo = Math.round(rate / 500), hi = Math.round(rate / 60);
  const c: number[] = [];
  for (let lag = lo; lag <= hi; lag++) { let s = 0; for (let i = 0; i < n; i++) s += x[a + i] * x[a + i + lag]; c.push(s); }
  const max = Math.max(...c);
  for (let i = 1; i < c.length - 1; i++) if (c[i] >= 0.85 * max && c[i] >= c[i - 1] && c[i] >= c[i + 1]) return rate / (lo + i);
  return 0;
}
function run(params: Partial<typeof NEUTRAL_FX>, input: Float64Array, rate: number) {
  const out = new Float64Array(input.length);
  new VoiceFx(rate, params).process(input, out);
  return out;
}

describe("the presets (shared with Android)", () => {
  it("are the fixture's — the same ids, order and numbers", () => {
    expect([...VOICE_FX_PRESET_IDS]).toEqual(FIX.presetIds);
    expect(Object.keys(VOICE_FX_PRESETS)).toEqual(FIX.presetIds.filter((p) => p !== "custom"));
    for (const [id, p] of Object.entries(FIX.presets)) expect({ ...VOICE_FX_PRESETS[id as keyof typeof VOICE_FX_PRESETS] }).toEqual(p);
    expect(Object.keys(NEUTRAL_FX)).toEqual(FIX.keys);
    for (const [k, range] of Object.entries(FIX.limits)) expect([...VOICE_FX_LIMITS[k as keyof typeof VOICE_FX_LIMITS]]).toEqual(range);
    expect({ on: DEFAULT_VOICE_FX.on, preset: DEFAULT_VOICE_FX.preset, custom: { ...DEFAULT_VOICE_FX.custom } }).toEqual(FIX.defaults);
    for (const f of FIX.frames) expect(frameSizeFor(f.rate)).toBe(f.size);
  });

  it("clamps what comes in, a robot under 20 Hz is off, custom takes the user's values", () => {
    expect(sanitizeFxParams({ pitch: 40, formant: -99, robot: 5, echo: 2, echoMs: 5, echoFeedback: 3, whisper: -1, gain: "x" })).toEqual({
      pitch: 12, formant: -12, robot: 0, echo: 1, echoMs: 40, echoFeedback: 0.9, whisper: 0, gain: 0,
    });
    expect(fxParamsFor("deep")).toEqual(FIX.presets.deep);
    expect(fxParamsFor("custom", { pitch: 3 })).toEqual({ ...NEUTRAL_FX, pitch: 3 });
    expect(isNeutralFx(fxParamsFor("off"))).toBe(true);
    expect(isNeutralFx(fxParamsFor("echo"))).toBe(false);
  });
});

describe("the effect chain", () => {
  it("FFT: forward then inverse gives the signal back", () => {
    const n = 256, fft = new Fft(n);
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + 0.2 * Math.cos(i * 1.7));
    const re = Float64Array.from(x), im = new Float64Array(n);
    fft.transform(re, im);
    fft.transform(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i] / n).toBeCloseTo(x[i], 9);
    expect(() => new Fft(100)).toThrow();
  });

  it("idle: the input comes out unchanged, a frame later (the delay does not change with the preset)", () => {
    for (const rate of [48000, 16000]) {
      const x = sine(rate, 440, 0.3);
      const out = run(NEUTRAL_FX, x, rate);
      const d = new SpectralVoice(rate).latency;
      expect(d).toBe(frameSizeFor(rate));
      for (let i = d; i < x.length; i += 97) expect(out[i]).toBeCloseTo(x[i - d], 12);
      for (let i = 0; i < d; i++) expect(out[i]).toBe(0);
    }
  });

  it("pitch: a sine moves by the ratio (the fixture's cases), and stays about as loud", () => {
    for (const c of FIX.sines) {
      const x = sine(c.rate, c.hz, 1);
      const out = run(c.params, x, c.rate);
      const found = peakHz(out, c.rate, Math.round(c.rate * 0.3), Math.round(c.rate * 0.6));
      expect(Math.abs(found - c.peakHz) / c.peakHz).toBeLessThan(0.03);
      const ratio = rms(out, c.rate / 2, c.rate) / rms(x, c.rate / 2, c.rate);
      expect(ratio).toBeGreaterThan(0.6);
      expect(ratio).toBeLessThan(1.5);
    }
  });

  it("pitch and formant move separately on a vowel", () => {
    const rate = 48000, x = vowel(rate, 150, 700, 1);
    expect(f0(x, rate)).toBeCloseTo(150, 0);
    const formantIn = envelopePeak(x, rate);
    // Pitch up an octave: the fundamental doubles, the formant stays.
    const up = run({ pitch: 12 }, x, rate);
    expect(Math.abs(f0(up, rate) - 300) / 300).toBeLessThan(0.04);
    expect(Math.abs(envelopePeak(up, rate) - formantIn) / formantIn).toBeLessThan(0.15);
    // Formant up an octave: the formant moves up, the fundamental stays.
    const wide = run({ formant: 12 }, x, rate);
    expect(Math.abs(f0(wide, rate) - 150) / 150).toBeLessThan(0.04);
    expect(envelopePeak(wide, rate)).toBeGreaterThan(formantIn * 1.6);
    // Formant down: lower; pitch down: the fundamental drops by 2^(-7/12).
    expect(envelopePeak(run({ formant: -7 }, x, rate), rate)).toBeLessThan(formantIn * 0.9);
    expect(Math.abs(f0(run({ pitch: -7 }, x, rate), rate) - 150 * 2 ** (-7 / 12)) / 100).toBeLessThan(0.04);
  });

  it("robot: a ring modulator — the sidebands, not the tone", () => {
    for (const c of FIX.rings) {
      const x = sine(c.rate, c.hz, 1);
      const out = run({ robot: c.robot }, x, c.rate);
      const from = c.rate / 4, len = c.rate / 2;
      const [lo, hi] = c.sidebands;
      const side = Math.min(levelAt(out, c.rate, lo, from, len), levelAt(out, c.rate, hi, from, len));
      expect(side).toBeGreaterThan(20 * levelAt(out, c.rate, c.hz, from, len));
    }
    const ring = new RingMod(1000);
    ring.set(250); // a quarter turn per sample
    expect([1, 1, 1, 1].map((v) => ring.next(v)).map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0, -1, -0]);
  });

  it("echo: the delayed copy, then each repeat times the feedback", () => {
    const e = new Echo(1000);
    e.set(0.5, 100, 0.4);
    const out = Array.from({ length: 400 }, (_, i) => e.next(i === 0 ? 1 : 0));
    expect(out[0]).toBe(1);
    expect(out[100]).toBeCloseTo(0.5, 12);
    expect(out[200]).toBeCloseTo(0.2, 12);
    expect(out[300]).toBeCloseTo(0.08, 12);
    expect(out.filter((v, i) => v !== 0 && i % 100 !== 0)).toEqual([]);
  });

  it("whisper: noise under the voice's envelope, about as loud; the same seed gives the same noise", () => {
    const rate = 16000, x = vowel(rate, 140, 600, 1);
    const a = run({ whisper: 1 }, x, rate), b = run({ whisper: 1 }, x, rate);
    expect([...a]).toEqual([...b]);
    const ratio = rms(a, rate / 2, rate) / rms(x, rate / 2, rate);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
    expect(f0(a, rate)).not.toBeCloseTo(140, 0); // no pitch left in a whisper
    const n = makeNoise(7), m = makeNoise(7);
    expect([n(), n(), n()]).toEqual([m(), m(), m()]);
  });

  it("the limiter never lets the level past 1, and leaves a normal level alone", () => {
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(-0.8)).toBe(-0.8);
    for (const v of [0.9, 1.5, 10, -3]) { expect(Math.abs(softLimit(v))).toBeLessThanOrEqual(1); expect(Math.abs(softLimit(v))).toBeGreaterThan(0.8); expect(Math.sign(softLimit(v))).toBe(Math.sign(v)); }
    expect(softLimit(0.9)).toBeLessThan(0.9);
    const out = run({ gain: 12 }, sine(16000, 300, 0.5, 0.9), 16000);
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it("changes presets live without a gap (the delay stays)", () => {
    const rate = 16000, x = sine(rate, 300, 1), fx = new VoiceFx(rate, VOICE_FX_PRESETS.deep), out = new Float64Array(x.length);
    const half = x.length / 2;
    fx.process(x.subarray(0, half), out.subarray(0, half));
    fx.setParams(VOICE_FX_PRESETS.off);
    fx.process(x.subarray(half), out.subarray(half));
    const d = fx.latency;
    // A frame after the switch the input comes through unchanged again.
    for (let i = half + 2 * d; i < x.length; i += 31) expect(out[i]).toBeCloseTo(x[i - d], 9);
  });

  it("runs much faster than real time (10 s of 48 kHz voice)", () => {
    const rate = 48000, x = vowel(rate, 120, 700, 10), out = new Float64Array(x.length);
    const t0 = performance.now();
    new VoiceFx(rate, VOICE_FX_PRESETS.anonymous).process(x, out);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe("the user's settings", () => {
  beforeEach(() => { resetVoiceFxForTests(); try { localStorage.clear(); } catch { /* none */ } });

  it("are off by default, kept in this browser, and tell who listens", () => {
    expect(getVoiceFx()).toEqual(sanitizeVoiceFxSettings({}));
    expect(getVoiceFx().on).toBe(false);
    const seen: boolean[] = [];
    const off = onVoiceFxChange((s) => seen.push(s.on));
    setVoiceFx({ on: true, preset: "robot" });
    expect(loadVoiceFx()).toMatchObject({ on: true, preset: "robot" });
    setVoiceFx({ custom: { ...NEUTRAL_FX, pitch: 30 } as never });
    expect(getVoiceFx().custom.pitch).toBe(12);
    off();
    setVoiceFx({ on: false });
    expect(seen).toEqual([true, true]);
    expect(sanitizeVoiceFxSettings({ on: "yes", preset: "nope" })).toMatchObject({ on: false, preset: "deep" });
    expect(settingsParams({ ...DEFAULT_VOICE_FX, preset: "custom" })).toEqual(DEFAULT_VOICE_FX.custom);
  });
});

describe("the module (the operator's gate)", () => {
  it("is off until the operator turns it on, then follows the usual access rules (the fixture's cases)", () => {
    expect(MODULE_BY_ID.voiceChanger?.offByDefault).toBe(true);
    expect(moduleOfPanel("voiceChanger")).toBe("voiceChanger");
    for (const c of FIX.gate) {
      const groups = [{ id: "staff", label: "Staff", members: [] }, { id: "kids", label: "Kids", members: [] }];
      const policy = c.rule ? sanitizeModules({ voiceChanger: c.rule }, groups) : {};
      expect(moduleAllowed(policy, "voiceChanger", c.groups), c.about).toBe(c.allowed);
    }
    expect(decide({}, "voiceChanger", ["user"]).reason).toBe("off");
    // Other modules keep "no rule = everyone".
    expect(moduleAllowed({}, "speech", ["guest"])).toBe(true);
  });
});
