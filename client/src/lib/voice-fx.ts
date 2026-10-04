// Voice changer (6.7): the shared presets and the effect chain. PURE — no
// DOM, no WebAudio: the browser runs it in an AudioWorklet on the microphone
// (voice-fx.worklet.ts, handed out by mic.ts), the tests on synthetic
// signals. The Android app has the same chain in Java (voice/VoiceFx.java)
// with the same presets; test/fixtures/voice-fx.json keeps the two equal.
//
// The chain, sample by sample on mono audio (-1 … 1):
//   1. spectral voice — an STFT phase vocoder that moves the excitation's
//      pitch and the spectral envelope's formants separately; "whisper"
//      swaps the excitation for noise under the same envelope;
//   2. robot — a ring modulator;
//   3. echo — a feedback delay;
//   4. gain and a soft limiter.
// While it runs the delay is constant (one STFT frame: 1024 samples at
// 48 kHz ≈ 21 ms, 512 at 16 kHz ≈ 32 ms), also when a preset leaves the
// spectral stage idle — switching presets live does not jump. Nothing here
// talks to a network.

export type VoiceFxParams = {
  /** Pitch of the voice, semitones (-12 … 12); the formants stay. */
  pitch: number;
  /** Formants (the "size" of the throat), semitones (-12 … 12); the pitch stays. */
  formant: number;
  /** Robot: the ring modulator's carrier in Hz (0 = off, 20 … 400). */
  robot: number;
  /** Echo: how much of the delayed voice is heard (0 = off … 1). */
  echo: number;
  /** Echo delay, ms (40 … 1000). */
  echoMs: number;
  /** Echo feedback (0 … 0.9): how long it rings. */
  echoFeedback: number;
  /** Whisper: the voiced sound replaced by breath noise (0 … 1). */
  whisper: number;
  /** Output gain, dB (-12 … 12), before the limiter. */
  gain: number;
};

export const VOICE_FX_PRESET_IDS = ["off", "higher", "lower", "deep", "robot", "echo", "whisper", "anonymous", "custom"] as const;
export type VoiceFxPreset = (typeof VOICE_FX_PRESET_IDS)[number];

export const NEUTRAL_FX: Readonly<VoiceFxParams> = Object.freeze({ pitch: 0, formant: 0, robot: 0, echo: 0, echoMs: 250, echoFeedback: 0.35, whisper: 0, gain: 0 });

/** The presets — the same names and numbers on Android (VoiceFx.PRESETS). */
export const VOICE_FX_PRESETS: Readonly<Record<Exclude<VoiceFxPreset, "custom">, Readonly<VoiceFxParams>>> = Object.freeze({
  off: NEUTRAL_FX,
  higher: { ...NEUTRAL_FX, pitch: 4, formant: 3 },
  lower: { ...NEUTRAL_FX, pitch: -4, formant: -3 },
  deep: { ...NEUTRAL_FX, pitch: -7, formant: -5 },
  robot: { ...NEUTRAL_FX, robot: 70, gain: 2 },
  echo: { ...NEUTRAL_FX, echo: 0.5, echoMs: 280, echoFeedback: 0.45 },
  whisper: { ...NEUTRAL_FX, whisper: 1, gain: 2 },
  anonymous: { ...NEUTRAL_FX, pitch: -3, formant: -6, whisper: 0.35, gain: 2 },
});

/** Each parameter's range (the custom sliders use them too). */
export const VOICE_FX_LIMITS: Readonly<Record<keyof VoiceFxParams, readonly [number, number]>> = Object.freeze({
  pitch: [-12, 12], formant: [-12, 12], robot: [0, 400], echo: [0, 1], echoMs: [40, 1000], echoFeedback: [0, 0.9], whisper: [0, 1], gain: [-12, 12],
});

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Whatever came in (settings, a message to the worklet) as valid parameters. */
export function sanitizeFxParams(raw: unknown): VoiceFxParams {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...NEUTRAL_FX } as VoiceFxParams;
  for (const key of Object.keys(VOICE_FX_LIMITS) as Array<keyof VoiceFxParams>) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clamp(v, VOICE_FX_LIMITS[key][0], VOICE_FX_LIMITS[key][1]);
  }
  // A carrier under 20 Hz is a tremolo, not a robot: off.
  if (out.robot > 0 && out.robot < 20) out.robot = 0;
  return out;
}

export function isFxPreset(v: unknown): v is VoiceFxPreset {
  return typeof v === "string" && (VOICE_FX_PRESET_IDS as readonly string[]).includes(v);
}

/** The parameters of a preset ("custom": the user's own). */
export function fxParamsFor(preset: VoiceFxPreset, custom?: Partial<VoiceFxParams>): VoiceFxParams {
  return preset === "custom" ? sanitizeFxParams({ ...NEUTRAL_FX, ...custom }) : { ...VOICE_FX_PRESETS[preset] };
}

/** Nothing would change the voice. */
export function isNeutralFx(p: VoiceFxParams): boolean {
  return p.pitch === 0 && p.formant === 0 && p.robot === 0 && p.echo === 0 && p.whisper === 0 && p.gain === 0;
}

/* ------------------------------------------------------------------- FFT */

/** In-place radix-2 complex FFT of one size (tables made once). */
export class Fft {
  readonly n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = Math.sin((2 * Math.PI * i) / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward (e^-i) or inverse (e^+i, NOT divided by n). */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = sign * this.sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

/* ---------------------------------------------------------------- noise */

/** xorshift32 — the same numbers on both platforms for the same seed. */
export function makeNoise(seed = 0x9e3779b9): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------- spectral voice */

/** The STFT frame for a sample rate: ~21 ms at 48 kHz, never under 512. */
export function frameSizeFor(sampleRate: number): number {
  return sampleRate > 32_000 ? 1024 : 512;
}

/**
 * The spectral stage: a phase vocoder (75 % overlap, Hann) that shifts the
 * excitation (the spectrum divided by its smoothed envelope) by the pitch
 * ratio and lays it under the envelope stretched by the formant ratio.
 * Output = input delayed by `latency` samples when idle.
 */
export class SpectralVoice {
  readonly size: number;
  readonly hop: number;
  /** Samples between a sample going in and coming out. */
  readonly latency: number;
  private readonly half: number;
  private readonly fft: Fft;
  private readonly win: Float64Array;
  private readonly inFifo: Float64Array;
  private readonly outFifo: Float64Array;
  private readonly accum: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly lastPhase: Float64Array;
  private readonly sumPhase: Float64Array;
  private readonly anaMag: Float64Array;
  private readonly anaFreq: Float64Array;
  private readonly synMag: Float64Array;
  private readonly synFreq: Float64Array;
  private readonly env: Float64Array;
  private readonly tmp: Float64Array;
  private readonly smoothHalf: number;
  private rover: number;
  private pitchRatio = 1;
  private formantRatio = 1;
  private whisper = 0;
  private active = false;
  /** The output level that matches the input's (smoothed over frames). */
  private level = 1;
  /** The loudness follower (time constant ~0.3 s): powers in and out, the make-up gain. */
  private readonly follow: number;
  private powIn = 0;
  private powOut = 0;
  private makeup = 1;
  private readonly rand: () => number;

  constructor(sampleRate: number, seed = 1) {
    const n = frameSizeFor(sampleRate);
    this.size = n;
    this.half = n / 2;
    this.hop = n / 4;
    this.latency = n;
    this.fft = new Fft(n);
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    this.inFifo = new Float64Array(n);
    this.outFifo = new Float64Array(n);
    this.accum = new Float64Array(2 * n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    const bins = this.half + 1;
    this.lastPhase = new Float64Array(bins);
    this.sumPhase = new Float64Array(bins);
    this.anaMag = new Float64Array(bins);
    this.anaFreq = new Float64Array(bins);
    this.synMag = new Float64Array(bins);
    this.synFreq = new Float64Array(bins);
    this.env = new Float64Array(bins);
    this.tmp = new Float64Array(bins);
    // The envelope: a box of ±200 Hz, twice — wider than the harmonics' spacing.
    this.smoothHalf = Math.max(2, Math.ceil(200 / (sampleRate / n)));
    this.rover = n - this.hop;
    this.rand = makeNoise(seed);
    this.follow = 1 / (0.3 * sampleRate);
  }

  /** Pitch and formant in semitones, whisper 0 … 1. */
  set(pitch: number, formant: number, whisper: number): void {
    this.pitchRatio = Math.pow(2, pitch / 12);
    this.formantRatio = Math.pow(2, formant / 12);
    this.whisper = clamp(whisper, 0, 1);
    const active = pitch !== 0 || formant !== 0 || whisper > 0;
    if (active && !this.active) {
      this.lastPhase.fill(0); this.sumPhase.fill(0); this.accum.fill(0);
      this.level = 1; this.powIn = 0; this.powOut = 0; this.makeup = 1;
    }
    this.active = active;
  }

  get running(): boolean { return this.active; }

  /** Streams `input` through (same length; may be the same array). */
  process(input: ArrayLike<number>, output: { [i: number]: number; length: number }): void {
    const n = this.size, hop = this.hop, a = this.follow;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.inFifo[this.rover] = x;
      let y = this.outFifo[this.rover - (n - hop)];
      if (this.active) {
        // Overlapping frames that no longer line up (a shifted pitch, noise)
        // add up quieter: a slow follower keeps the loudness of the input.
        this.powIn += a * (x * x - this.powIn);
        this.powOut += a * (y * y - this.powOut);
        const want = clamp(Math.sqrt((this.powIn + 1e-9) / (this.powOut + 1e-9)), 0.5, 3);
        this.makeup += a * (want - this.makeup);
        y *= this.makeup;
      }
      output[i] = y;
      this.rover++;
      if (this.rover >= n) {
        this.rover = n - hop;
        if (this.active) this.frame();
        else for (let k = 0; k < hop; k++) this.outFifo[k] = this.inFifo[k];
        for (let k = 0; k < n - hop; k++) this.inFifo[k] = this.inFifo[k + hop];
      }
    }
  }

  private frame(): void {
    const n = this.size, half = this.half, hop = this.hop, osamp = n / hop;
    const expct = (2 * Math.PI * hop) / n;
    const { re, im, win } = this;
    for (let k = 0; k < n; k++) { re[k] = this.inFifo[k] * win[k]; im[k] = 0; }
    this.fft.transform(re, im, false);
    // Analysis: each bin's magnitude and its true frequency (in bins).
    for (let k = 0; k <= half; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const phase = Math.atan2(im[k], re[k]);
      let d = phase - this.lastPhase[k];
      this.lastPhase[k] = phase;
      d -= k * expct;
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      this.anaMag[k] = mag;
      this.anaFreq[k] = k + (osamp * d) / (2 * Math.PI);
    }
    // The envelope: the magnitude smoothed (a box, twice).
    this.smooth(this.anaMag, this.tmp);
    this.smooth(this.tmp, this.env);
    let peak = 0;
    for (let k = 0; k <= half; k++) if (this.env[k] > peak) peak = this.env[k];
    const floor = peak * 1e-4 + 1e-12;
    // The excitation, moved by the pitch ratio.
    const p = this.pitchRatio, f = this.formantRatio;
    this.synMag.fill(0);
    this.synFreq.fill(0);
    for (let k = 0; k <= half; k++) {
      const j = Math.round(k * p);
      if (j > half) break;
      this.synMag[j] += this.anaMag[k] / Math.max(this.env[k], floor);
      this.synFreq[j] = this.anaFreq[k] * p;
    }
    // Synthesis: under the envelope moved by the formant ratio; whisper is noise under it.
    const w = this.whisper;
    let energyIn = 0, energyOut = 0;
    for (let k = 0; k <= half; k++) energyIn += this.anaMag[k] * this.anaMag[k];
    for (let j = 0; j <= half; j++) {
      const at = j / f;
      const a = Math.floor(at);
      const e = a >= half ? 0 : this.env[a] + (this.env[a + 1] - this.env[a]) * (at - a);
      let d = this.synFreq[j] - j;
      d = (2 * Math.PI * d) / osamp + j * expct;
      this.sumPhase[j] += d;
      const voiced = (1 - w) * this.synMag[j] * e;
      let r = voiced * Math.cos(this.sumPhase[j]);
      let i = voiced * Math.sin(this.sumPhase[j]);
      if (w > 0) {
        const ph = 2 * Math.PI * this.rand();
        r += w * e * Math.cos(ph);
        i += w * e * Math.sin(ph);
      }
      re[j] = r;
      im[j] = i;
      energyOut += r * r + i * i;
    }
    // As loud as what came in (a shift up leaves gaps between the bins, noise is spread thin).
    const target = energyOut > 1e-20 ? Math.sqrt(energyIn / energyOut) : 1;
    this.level = this.level * 0.5 + clamp(target, 0.1, 10) * 0.5;
    for (let j = 0; j <= half; j++) {
      // Only the positive half: double it, DC and Nyquist once.
      const g = (j === 0 || j === half ? 1 : 2) * this.level;
      re[j] *= g;
      im[j] *= g;
    }
    for (let j = half + 1; j < n; j++) { re[j] = 0; im[j] = 0; }
    this.fft.transform(re, im, true);
    // Overlap-add: Hann² at 75 % overlap sums to 1.5.
    const scale = 1 / (n * 1.5);
    for (let k = 0; k < n; k++) this.accum[k] += win[k] * re[k] * scale;
    for (let k = 0; k < hop; k++) this.outFifo[k] = this.accum[k];
    this.accum.copyWithin(0, hop, hop + n);
    this.accum.fill(0, n, n + hop);
  }

  /** A centred moving average of ±smoothHalf bins (edges: the bins there are). */
  private smooth(src: Float64Array, dst: Float64Array): void {
    const m = src.length, h = this.smoothHalf;
    let sum = 0, count = 0;
    for (let k = 0; k < Math.min(h, m); k++) { sum += src[k]; count++; }
    for (let k = 0; k < m; k++) {
      const add = k + h, drop = k - h - 1;
      if (add < m) { sum += src[add]; count++; }
      if (drop >= 0) { sum -= src[drop]; count--; }
      dst[k] = sum / count;
    }
  }
}

/* ---------------------------------------------------------- small units */

/** Ring modulator: x · sin(2π f t). */
export class RingMod {
  private phase = 0;
  private step = 0;
  constructor(private readonly sampleRate: number) {}
  set(hz: number): void { this.step = hz > 0 ? (2 * Math.PI * hz) / this.sampleRate : 0; if (!hz) this.phase = 0; }
  get on(): boolean { return this.step > 0; }
  next(x: number): number {
    this.phase += this.step;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return x * Math.sin(this.phase);
  }
}

/** Feedback delay: y = x + mix · d[t-D];  d[t] = x + fb · d[t-D]. */
export class Echo {
  private readonly buf: Float64Array;
  private at = 0;
  private delay = 1;
  private mix = 0;
  private feedback = 0;
  constructor(private readonly sampleRate: number) { this.buf = new Float64Array(Math.ceil(sampleRate * 1.001) + 1); }
  set(mix: number, ms: number, feedback: number): void {
    if (mix <= 0 && this.mix > 0) this.buf.fill(0);
    this.mix = clamp(mix, 0, 1);
    this.feedback = clamp(feedback, 0, 0.9);
    this.delay = clamp(Math.round((ms / 1000) * this.sampleRate), 1, this.buf.length - 1);
  }
  get on(): boolean { return this.mix > 0; }
  next(x: number): number {
    const len = this.buf.length;
    let r = this.at - this.delay;
    if (r < 0) r += len;
    const d = this.buf[r];
    this.buf[this.at] = x + this.feedback * d;
    this.at = this.at + 1 === len ? 0 : this.at + 1;
    return x + this.mix * d;
  }
}

/** Above 0.8 the level bends softly toward 1 (never past it). */
export function softLimit(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.8) return x;
  return Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
}

/* ------------------------------------------------------------ the chain */

export class VoiceFx {
  readonly sampleRate: number;
  private readonly spectral: SpectralVoice;
  private readonly ring: RingMod;
  private readonly echo: Echo;
  private params: VoiceFxParams = { ...NEUTRAL_FX };
  private gain = 1;

  constructor(sampleRate: number, params: Partial<VoiceFxParams> = NEUTRAL_FX, seed = 1) {
    this.sampleRate = sampleRate;
    this.spectral = new SpectralVoice(sampleRate, seed);
    this.ring = new RingMod(sampleRate);
    this.echo = new Echo(sampleRate);
    this.setParams(params);
  }

  /** The delay the chain adds (samples). */
  get latency(): number { return this.spectral.latency; }

  get current(): VoiceFxParams { return { ...this.params }; }

  setParams(raw: Partial<VoiceFxParams>): void {
    const p = sanitizeFxParams(raw);
    this.params = p;
    this.spectral.set(p.pitch, p.formant, p.whisper);
    this.ring.set(p.robot);
    this.echo.set(p.echo, p.echoMs, p.echoFeedback);
    this.gain = Math.pow(10, p.gain / 20);
  }

  /** Mono samples in → changed samples out (same length; may be the same array). */
  process(input: ArrayLike<number>, output: { [i: number]: number; length: number }): void {
    this.spectral.process(input, output);
    const ring = this.ring.on, echo = this.echo.on, g = this.gain;
    for (let i = 0; i < input.length; i++) {
      let x = output[i];
      if (ring) x = this.ring.next(x);
      if (echo) x = this.echo.next(x);
      output[i] = softLimit(x * g);
    }
  }
}
