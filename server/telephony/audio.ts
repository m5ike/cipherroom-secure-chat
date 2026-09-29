// Audio plumbing for phone calls — no dependency, no Node API.
//
// Provider media WebSockets (Twilio, Telnyx, Vonage) carry 8 or 16 kHz audio
// as G.711 or raw 16-bit PCM; speech-to-text wants 16 kHz PCM cut into
// utterances; text-to-speech hands back WAV or PCM at 16/22/24/48 kHz; the
// browser plays PCM. This module converts between all of those:
//
//   mulawEncode / mulawDecode, alawEncode / alawDecode   G.711 (ITU-T)
//   pcm16FromLE / pcm16ToLE / pcm16FromBE / pcm16ToBE   bytes <-> samples
//   resample, StreamResampler                            rate conversion
//   wavEncode / wavDecode                                RIFF/WAVE files
//   rms / dbfs                                           levels
//   Segmenter                                            voice activity -> utterances
//   Framer                                               exact 20 ms frames for providers
//   tone / silence                                       synthesis for tests and prompts
//
// Samples are always Int16Array (mono unless a function says otherwise) and
// bytes are always Uint8Array (a Node Buffer is one). Every function copies:
// nothing returned aliases its input, so callers may reuse their buffers.

/* ------------------------------------------------------------------ G.711 */

// µ-law, the classic 16-bit algorithm: add a bias of 0x84 so every segment
// starts on a power of two, find the segment from the top bits, keep four
// mantissa bits, invert everything. Clipping at 32635 keeps sample+bias
// inside 15 bits.
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

// Segment (exponent) of (sample + bias) >> 7: the position of its top bit.
const MULAW_EXP = new Uint8Array(256);
for (let i = 2; i < 256; i++) MULAW_EXP[i] = MULAW_EXP[i >> 1] + 1;

const MULAW_TABLE = new Int16Array(256);
for (let b = 0; b < 256; b++) {
  const u = ~b & 0xff;
  const t = (((u & 0x0f) << 3) + MULAW_BIAS) << ((u & 0x70) >> 4);
  MULAW_TABLE[b] = u & 0x80 ? MULAW_BIAS - t : t - MULAW_BIAS;
}

function mulawByte(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  let s = sign ? -sample : sample;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  const exp = MULAW_EXP[(s >> 7) & 0xff];
  const mantissa = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mantissa) & 0xff;
}

/** 16-bit PCM -> G.711 µ-law, one byte per sample. */
export function mulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = mulawByte(pcm[i]);
  return out;
}

/** G.711 µ-law -> 16-bit PCM. 0xFF and 0x7F are both zero. */
export function mulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_TABLE[bytes[i]];
  return out;
}

// A-law works on 13 bits: segments 0 and 1 share one step size, every later
// segment doubles it, and the even bits are inverted (XOR 0x55) so a silent
// line still has transitions.
const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

const ALAW_TABLE = new Int16Array(256);
for (let b = 0; b < 256; b++) {
  const a = b ^ 0x55;
  const seg = (a & 0x70) >> 4;
  let t = (a & 0x0f) << 4;
  if (seg === 0) t += 8;
  else t = (t + 0x108) << (seg - 1);
  ALAW_TABLE[b] = a & 0x80 ? t : -t;
}

function alawByte(sample: number): number {
  let v = sample >> 3;
  let mask: number;
  if (v >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    v = -v - 1;
  }
  let seg = 0;
  while (seg < 8 && v > ALAW_SEG_END[seg]) seg++;
  if (seg >= 8) return 0x7f ^ mask; // unreachable from 16-bit input; kept for safety
  const quant = (seg < 2 ? v >> 1 : v >> seg) & 0x0f;
  return ((seg << 4) | quant) ^ mask;
}

/** 16-bit PCM -> G.711 A-law, one byte per sample. */
export function alawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = alawByte(pcm[i]);
  return out;
}

/** G.711 A-law -> 16-bit PCM. */
export function alawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ALAW_TABLE[bytes[i]];
  return out;
}

/* ------------------------------------------------------------ byte order */

// Byte by byte on purpose: the input is often a Buffer slice at an odd
// offset, and an Int16Array view over it would throw (or, on a big-endian
// host, read the wrong way round). A trailing odd byte is ignored.

/** Little-endian 16-bit bytes (WAV, Vonage L16, most TTS output) -> samples. */
export function pcm16FromLE(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0, p = 0; i < out.length; i++, p += 2) out[i] = bytes[p] | (bytes[p + 1] << 8);
  return out;
}

/** Samples -> little-endian 16-bit bytes. */
export function pcm16ToLE(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  for (let i = 0, p = 0; i < pcm.length; i++, p += 2) {
    out[p] = pcm[i] & 0xff;
    out[p + 1] = (pcm[i] >> 8) & 0xff;
  }
  return out;
}

/** Big-endian 16-bit bytes (network order, RTP L16) -> samples. */
export function pcm16FromBE(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0, p = 0; i < out.length; i++, p += 2) out[i] = (bytes[p] << 8) | bytes[p + 1];
  return out;
}

/** Samples -> big-endian 16-bit bytes. */
export function pcm16ToBE(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  for (let i = 0, p = 0; i < pcm.length; i++, p += 2) {
    out[p] = (pcm[i] >> 8) & 0xff;
    out[p + 1] = pcm[i] & 0xff;
  }
  return out;
}

/* ------------------------------------------------------------ resampling */

// Downsampling first runs a Hamming-windowed sinc low-pass so energy above
// the new Nyquist does not fold back as audible aliasing (16k -> 8k would
// otherwise turn a 6 kHz hiss into a 2 kHz whistle). The cutoff sits at 90%
// of the new Nyquist and the filter grows with the ratio, so the transition
// band is the same width in output terms: 8 kHz output keeps ~3.2 kHz flat
// and is down ~50 dB by 4 kHz. Upsampling is plain linear interpolation.
const LP_HALF_TAPS_PER_RATIO = 16;
const LP_CUTOFF = 0.9;

function lowPass(ratio: number): Float64Array {
  const half = Math.ceil(LP_HALF_TAPS_PER_RATIO * ratio);
  const n = 2 * half + 1;
  const fc = (0.5 * LP_CUTOFF) / ratio; // cycles per input sample
  const taps = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const k = i - half;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    taps[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
    sum += taps[i];
  }
  // Unity gain at DC, so a constant stays exactly that constant.
  for (let i = 0; i < n; i++) taps[i] /= sum;
  return taps;
}

function checkRate(rate: number, name: string): void {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`${name} must be a positive number of Hz (got ${rate})`);
}

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/**
 * Rate conversion for a live stream: push() audio in any chunk size (a
 * 20 ms frame, say) and get back every output sample that can already be
 * computed. State carries across chunks, so frame edges never click: the
 * output of push()...push() + flush() is sample-for-sample what resample()
 * gives for the whole stream at once.
 *
 * push() holds back a few input samples (the filter's half-length, ~2 ms)
 * until the audio after them arrives. flush() emits those, treating the
 * stream as ending there, and resets the resampler for a new stream.
 */
export class StreamResampler {
  readonly fromRate: number;
  readonly toRate: number;
  private readonly taps: Float64Array | null;
  private readonly half: number;
  private hist = new Int16Array(0); // input still needed, from absolute index histBase
  private histBase = 0;
  private received = 0; // input samples pushed since the stream started
  private first = 0; // sample 0; stands in for everything before the stream
  private next = 0; // absolute index of the next output sample

  constructor(fromRate: number, toRate: number) {
    checkRate(fromRate, "fromRate");
    checkRate(toRate, "toRate");
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.taps = fromRate > toRate ? lowPass(fromRate / toRate) : null;
    this.half = this.taps ? (this.taps.length - 1) / 2 : 0;
  }

  push(chunk: Int16Array): Int16Array {
    if (this.fromRate === this.toRate) {
      this.received += chunk.length;
      return chunk.slice();
    }
    if (chunk.length === 0) return new Int16Array(0);
    if (this.received === 0) this.first = chunk[0];
    const merged = new Int16Array(this.hist.length + chunk.length);
    merged.set(this.hist);
    merged.set(chunk, this.hist.length);
    this.hist = merged;
    this.received += chunk.length;
    const out = this.produce(Infinity, false);
    this.trim();
    return out;
  }

  /** The held-back tail; the output then totals round(input * to / from). */
  flush(): Int16Array {
    const out =
      this.fromRate === this.toRate
        ? new Int16Array(0)
        : this.produce(Math.round((this.received * this.toRate) / this.fromRate), true);
    this.hist = new Int16Array(0);
    this.histBase = 0;
    this.received = 0;
    this.first = 0;
    this.next = 0;
    return out;
  }

  // Output j sits at input position j * from / to. Integer arithmetic on the
  // numerator keeps that exact over hours of audio (no drifting accumulator).
  private produce(limit: number, atEnd: boolean): Int16Array {
    const { fromRate: from, toRate: to } = this;
    const bound = Math.min(limit, Math.ceil((this.received * to) / from) + 1);
    const out = new Int16Array(Math.max(0, bound - this.next));
    let k = 0;
    while (this.next < limit) {
      const num = this.next * from;
      let i0 = Math.floor(num / to);
      let rem = num - i0 * to;
      if (rem < 0) { i0--; rem += to; } // only with non-integer rates, if the division rounded up
      if (!atEnd && i0 + (rem > 0 ? 1 : 0) + this.half > this.received - 1) break;
      let v = this.filtered(i0);
      if (rem > 0) v += (this.filtered(i0 + 1) - v) * (rem / to);
      out[k++] = clamp16(Math.round(v));
      this.next++;
    }
    return k === out.length ? out : out.slice(0, k);
  }

  // Input sample n, with the stream's first and last samples repeated past
  // either end (so a constant stays constant right up to the edges).
  private at(n: number): number {
    if (n < 0) return this.first;
    if (n >= this.received) return this.hist[this.hist.length - 1];
    return this.hist[n - this.histBase];
  }

  private filtered(i: number): number {
    const { taps, half, hist, histBase } = this;
    if (!taps) return this.at(i);
    let acc = 0;
    const lo = i - half;
    if (lo >= histBase && i + half < this.received) {
      const off = lo - histBase;
      for (let t = 0; t < taps.length; t++) acc += taps[t] * hist[off + t];
    } else {
      for (let t = 0; t < taps.length; t++) acc += taps[t] * this.at(lo + t);
    }
    return acc;
  }

  // Drop input that no future output can reach; always keep the last sample.
  private trim(): void {
    const i0 = Math.floor((this.next * this.fromRate) / this.toRate);
    const keepFrom = Math.min(Math.max(0, i0 - this.half), this.received - 1);
    if (keepFrom > this.histBase) {
      this.hist = this.hist.slice(keepFrom - this.histBase);
      this.histBase = keepFrom;
    }
  }
}

/**
 * Convert a whole buffer from one sample rate to another. The output has
 * exactly round(length * toRate / fromRate) samples; the same rate returns
 * a copy.
 */
export function resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  checkRate(fromRate, "fromRate");
  checkRate(toRate, "toRate");
  if (fromRate === toRate) return pcm.slice();
  const r = new StreamResampler(fromRate, toRate);
  return concat(r.push(pcm), r.flush());
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const out = new Int16Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/* ------------------------------------------------------------------- WAV */

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_ALAW = 6;
const WAVE_FORMAT_MULAW = 7;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export type WavAudio = {
  /** Always mono: several channels are averaged into one. */
  pcm: Int16Array;
  rate: number;
  /** How many channels the file had (before the down-mix). */
  channels: number;
};

function putAscii(out: Uint8Array, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/** Interleaved 16-bit PCM -> a canonical 44-byte-header RIFF/WAVE file. */
export function wavEncode(pcm: Int16Array, rate: number, channels = 1): Uint8Array {
  if (!Number.isInteger(rate) || rate < 1 || rate > 0xffffffff) throw new RangeError(`wavEncode: bad sample rate ${rate}`);
  if (!Number.isInteger(channels) || channels < 1 || channels > 0xffff) throw new RangeError(`wavEncode: bad channel count ${channels}`);
  if (pcm.length % channels !== 0) throw new RangeError(`wavEncode: ${pcm.length} samples do not split into ${channels} channels`);
  const dataLen = pcm.length * 2;
  if (36 + dataLen > 0xffffffff || rate * channels * 2 > 0xffffffff) throw new RangeError("wavEncode: too large for a RIFF file");
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  putAscii(out, 0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  putAscii(out, 8, "WAVE");
  putAscii(out, 12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, WAVE_FORMAT_PCM, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  putAscii(out, 36, "data");
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + 2 * i, pcm[i], true);
  return out;
}

type WavFormat = { tag: number; channels: number; rate: number; bits: number };

function parseFmt(dv: DataView, at: number, size: number): WavFormat {
  if (size < 16) throw new Error(`WAV: fmt chunk too short (${size} bytes, need 16)`);
  let tag = dv.getUint16(at, true);
  const channels = dv.getUint16(at + 2, true);
  const rate = dv.getUint32(at + 4, true);
  const bits = dv.getUint16(at + 14, true);
  if (tag === WAVE_FORMAT_EXTENSIBLE) {
    if (size < 40) throw new Error(`WAV: WAVE_FORMAT_EXTENSIBLE fmt chunk too short (${size} bytes, need 40)`);
    // The sub-format GUID starts with the classic 16-bit format tag.
    tag = dv.getUint16(at + 24, true);
  }
  if (channels < 1) throw new Error("WAV: fmt chunk says 0 channels");
  if (rate < 1) throw new Error("WAV: fmt chunk says 0 Hz");
  return { tag, channels, rate, bits };
}

// Reads one sample at byte offset p, scaled to the 16-bit range (it may be
// fractional; rounding happens once, after the down-mix).
type SampleReader = (dv: DataView, bytes: Uint8Array, p: number) => number;

function sampleReader(tag: number, bits: number): SampleReader | null {
  if (tag === WAVE_FORMAT_PCM) {
    if (bits === 8) return (_dv, b, p) => (b[p] - 128) * 256; // 8-bit WAV is unsigned
    if (bits === 16) return (dv, _b, p) => dv.getInt16(p, true);
    if (bits === 24) return (_dv, b, p) => (((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8) >> 8) / 256;
    if (bits === 32) return (dv, _b, p) => dv.getInt32(p, true) / 65536;
  }
  if (tag === WAVE_FORMAT_IEEE_FLOAT && bits === 32) {
    return (dv, _b, p) => {
      const f = dv.getFloat32(p, true);
      if (!(f === f)) return 0; // NaN
      const c = f > 1 ? 1 : f < -1 ? -1 : f;
      return c < 0 ? c * 32768 : c * 32767;
    };
  }
  if (tag === WAVE_FORMAT_MULAW && bits === 8) return (_dv, b, p) => MULAW_TABLE[b[p]];
  if (tag === WAVE_FORMAT_ALAW && bits === 8) return (_dv, b, p) => ALAW_TABLE[b[p]];
  return null;
}

/**
 * Parse a WAV file into mono 16-bit PCM. Understands 8-bit unsigned, 16/24/32
 * -bit integer, 32-bit float, µ-law and A-law, plain or WAVE_FORMAT_EXTENSIBLE;
 * skips chunks it does not need (LIST, fact, ...). Throws an Error naming the
 * problem on anything it cannot decode.
 *
 * Lenient where it costs nothing: the RIFF size and the header's block align
 * and byte rate are not trusted (writers get them wrong), a data size of
 * 0xFFFFFFFF means "until the end of the file" (streamed WAV), and a
 * trailing partial sample frame is dropped.
 */
export function wavDecode(bytes: Uint8Array): WavAudio {
  if (bytes.length < 12) throw new Error(`WAV: ${bytes.length} bytes is too short for a RIFF header`);
  if (fourcc(bytes, 0) !== "RIFF") throw new Error(`WAV: not a RIFF file (starts with ${JSON.stringify(fourcc(bytes, 0))})`);
  if (fourcc(bytes, 8) !== "WAVE") throw new Error(`WAV: RIFF form is ${JSON.stringify(fourcc(bytes, 8))}, not "WAVE"`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let fmt: WavFormat | null = null;
  let dataStart = -1;
  let dataEnd = -1;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = fourcc(bytes, off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    const avail = bytes.length - body;
    if (id === "data" && size === 0xffffffff) {
      dataStart = body;
      dataEnd = bytes.length;
      break;
    }
    if (size > avail) {
      // Broken metadata after complete audio does not spoil the audio.
      if (fmt && dataStart >= 0 && id !== "data" && id !== "fmt ") break;
      throw new Error(`WAV: ${JSON.stringify(id)} chunk truncated (header says ${size} bytes, ${avail} present)`);
    }
    if (id === "fmt ") fmt = parseFmt(dv, body, size);
    else if (id === "data") {
      dataStart = body;
      dataEnd = body + size;
    }
    off = body + size + (size & 1); // chunks are padded to an even length
  }
  if (!fmt) throw new Error("WAV: no fmt chunk");
  if (dataStart < 0) throw new Error("WAV: no data chunk");

  const { tag, channels, rate, bits } = fmt;
  const read = sampleReader(tag, bits);
  if (!read) throw new Error(`WAV: unsupported encoding (format ${tag}, ${bits}-bit)`);
  const width = bits / 8;
  const frameBytes = width * channels;
  const frames = Math.floor((dataEnd - dataStart) / frameBytes);
  const pcm = new Int16Array(frames);
  for (let f = 0, p = dataStart; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++, p += width) sum += read(dv, bytes, p);
    pcm[f] = clamp16(Math.round(sum / channels));
  }
  return { pcm, rate, channels };
}

/* ---------------------------------------------------------------- levels */

/** Root-mean-square level, 0 (silence) to ~1 (full-scale square wave). */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length) / 32768;
}

/** Level in dB relative to full scale; -Infinity for digital silence. */
export function dbfs(pcm: Int16Array): number {
  const r = rms(pcm);
  return r > 0 ? 20 * Math.log10(r) : -Infinity;
}

/* ------------------------------------------------ voice activity detection */

export type Utterance = {
  /** The speech, plus up to preRollMs of audio before startMs and after endMs. */
  pcm: Int16Array;
  /** Start of the first loud frame, in ms of stream time. */
  startMs: number;
  /** End of the last loud frame, in ms of stream time. */
  endMs: number;
};

export type SegmenterOptions = {
  rate: number;
  frameMs?: number;
  startDb?: number;
  stopDb?: number;
  minSpeechMs?: number;
  hangoverMs?: number;
  maxUtteranceMs?: number;
  preRollMs?: number;
};

// The start threshold rides this far above the learned noise floor.
const NOISE_MARGIN_DB = 12;
// Time constant of the noise-floor average: slow, so a word does not move it.
const NOISE_TAU_MS = 1000;
// Quieter frames are digital silence (a line before media flows, µ-law
// 0xFF/0x7F), not noise; learning from them would drag the floor to nothing.
const NOISE_MIN_DB = -90;

/**
 * Energy-based voice activity detection that cuts a live stream into
 * utterances for speech-to-text.
 *
 * Audio is judged in frames of frameMs. An utterance starts on a frame at or
 * above the start threshold, stays open while frames reach the (lower) stop
 * threshold, and ends after hangoverMs below it. One whose speech spans less
 * than minSpeechMs (a click, a cough) is dropped; one that reaches
 * maxUtteranceMs is cut there and the next begins straight after.
 *
 * The start threshold is max(startDb, noiseFloor + 12 dB); the stop threshold
 * keeps the same gap below it (never under stopDb). The floor is a slow
 * average of the frames judged quiet, so steady hiss that sits above stopDb
 * still lets utterances end. Hiss that is already above startDb when the
 * stream begins is taken for speech: nothing quiet is ever seen to learn from.
 *
 * Time is counted in samples, never read from a clock, so the same audio gives
 * the same utterances whatever the chunk sizes.
 */
export class Segmenter {
  readonly rate: number;
  readonly frameSamples: number;
  private readonly startDb: number;
  private readonly stopDb: number;
  private readonly minSpeech: number; // samples
  private readonly hangover: number;
  private readonly maxUtterance: number;
  private readonly preRoll: number;
  private readonly alpha: number; // noise-floor averaging weight per frame

  private frame: Int16Array;
  private fill = 0;
  private clock = 0; // samples consumed (frames judged + flushed tails)
  private floor: number | null = null;

  // Recent audio for pre-roll and the utterance itself, from absolute sample storeBase.
  private store = new Int16Array(4096);
  private storeBase = 0;
  private storeLen = 0;

  private inSpeech = false;
  private uttStart = 0; // first loud sample
  private loudEnd = 0; // end of the last loud frame
  private emittedEnd = 0; // pre-roll never reaches back before audio already emitted

  constructor(opts: SegmenterOptions) {
    const {
      rate, frameMs = 20, startDb = -42, stopDb = -48, minSpeechMs = 250,
      hangoverMs = 700, maxUtteranceMs = 15000, preRollMs = 200,
    } = opts;
    checkRate(rate, "rate");
    const samples = (ms: number, name: string): number => {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Segmenter: ${name} must be >= 0 ms (got ${ms})`);
      return Math.round((ms * rate) / 1000);
    };
    this.rate = rate;
    this.frameSamples = samples(frameMs, "frameMs");
    if (this.frameSamples < 1) throw new RangeError(`Segmenter: frameMs ${frameMs} is shorter than one sample`);
    if (!(stopDb <= startDb)) throw new RangeError(`Segmenter: stopDb (${stopDb}) must not exceed startDb (${startDb})`);
    this.startDb = startDb;
    this.stopDb = stopDb;
    this.minSpeech = samples(minSpeechMs, "minSpeechMs");
    this.hangover = samples(hangoverMs, "hangoverMs");
    this.maxUtterance = Math.max(samples(maxUtteranceMs, "maxUtteranceMs"), this.frameSamples);
    this.preRoll = samples(preRollMs, "preRollMs");
    this.alpha = Math.min(1, (this.frameSamples * 1000) / rate / NOISE_TAU_MS);
    this.frame = new Int16Array(this.frameSamples);
  }

  /** The learned noise floor in dBFS, or null before any quiet frame. */
  get noiseFloorDb(): number | null {
    return this.floor;
  }

  /** Feed audio of any length; returns the utterances it completed. */
  push(pcm: Int16Array): Utterance[] {
    const out: Utterance[] = [];
    let i = 0;
    while (i < pcm.length) {
      const n = Math.min(this.frameSamples - this.fill, pcm.length - i);
      this.frame.set(pcm.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.frameSamples) {
        this.judge(this.frame, out);
        this.fill = 0;
      }
    }
    return out;
  }

  /**
   * End of stream (or of a turn): returns the utterance in progress if its
   * speech is long enough, else null. A partial frame still buffered joins
   * the audio but is not judged. The clock and noise floor carry on.
   */
  flush(): Utterance | null {
    if (this.fill > 0) {
      this.append(this.frame.subarray(0, this.fill));
      this.clock += this.fill;
      this.fill = 0;
    }
    let result: Utterance | null = null;
    if (this.inSpeech) {
      result = this.emit(this.clock);
      this.inSpeech = false;
    }
    this.trimTo(this.clock - this.preRoll);
    return result;
  }

  private judge(frame: Int16Array, out: Utterance[]): void {
    const start = this.clock;
    const end = start + frame.length;
    this.append(frame);
    this.clock = end;

    const level = dbfs(frame);
    const startThr = this.floor === null ? this.startDb : Math.max(this.startDb, this.floor + NOISE_MARGIN_DB);
    const stopThr = Math.max(this.stopDb, startThr - (this.startDb - this.stopDb));

    if (this.inSpeech) {
      if (level < stopThr) {
        this.learn(level);
        if (end - this.loudEnd >= this.hangover) {
          const u = this.emit(end);
          if (u) out.push(u);
          this.inSpeech = false;
          this.trimTo(end - this.preRoll);
        }
        return;
      }
      if (end - this.uttStart <= this.maxUtterance) {
        this.loudEnd = end;
        return;
      }
      // Too long: cut before this frame, then judge the frame afresh, so
      // speech that carries on opens the next utterance right here.
      const u = this.emit(start);
      if (u) out.push(u);
      this.inSpeech = false;
    }

    if (level >= startThr) {
      this.inSpeech = true;
      this.uttStart = start;
      this.loudEnd = end;
    } else {
      this.learn(level);
      this.trimTo(end - this.preRoll);
    }
  }

  private learn(level: number): void {
    if (!(level >= NOISE_MIN_DB)) return;
    this.floor = this.floor === null ? level : this.floor + this.alpha * (level - this.floor);
  }

  // Close the open utterance; tailLimit is the last sample it may include.
  private emit(tailLimit: number): Utterance | null {
    if (this.loudEnd - this.uttStart < this.minSpeech) return null;
    const from = Math.max(this.uttStart - this.preRoll, this.emittedEnd, this.storeBase);
    const to = Math.min(this.loudEnd + this.preRoll, tailLimit, this.storeBase + this.storeLen);
    this.emittedEnd = to;
    return {
      pcm: this.store.slice(from - this.storeBase, to - this.storeBase),
      startMs: (this.uttStart * 1000) / this.rate,
      endMs: (this.loudEnd * 1000) / this.rate,
    };
  }

  private append(pcm: Int16Array): void {
    const need = this.storeLen + pcm.length;
    if (need > this.store.length) {
      let cap = this.store.length * 2;
      while (cap < need) cap *= 2;
      const grown = new Int16Array(cap);
      grown.set(this.store.subarray(0, this.storeLen));
      this.store = grown;
    }
    this.store.set(pcm, this.storeLen);
    this.storeLen = need;
  }

  // Forget audio before absolute sample `abs` (only ever called while no
  // utterance is open, so nothing still needed is lost).
  private trimTo(abs: number): void {
    const drop = Math.min(abs - this.storeBase, this.storeLen);
    if (drop <= 0) return;
    this.store.copyWithin(0, drop, this.storeLen);
    this.storeLen -= drop;
    this.storeBase += drop;
  }
}

/* --------------------------------------------------------------- framing */

/**
 * Splits outgoing audio into frames of exactly samplesPerFrame samples, the
 * size a provider media stream expects: 160 (20 ms at 8 kHz) for Twilio and
 * Telnyx, 320 (20 ms at 16 kHz) for Vonage. Leftover samples wait for the
 * next push(). Every frame returned is a fresh array.
 */
export class Framer {
  readonly samplesPerFrame: number;
  private buf: Int16Array;
  private fill = 0;

  constructor(samplesPerFrame: number) {
    if (!Number.isInteger(samplesPerFrame) || samplesPerFrame < 1) {
      throw new RangeError(`Framer: samplesPerFrame must be a positive integer (got ${samplesPerFrame})`);
    }
    this.samplesPerFrame = samplesPerFrame;
    this.buf = new Int16Array(samplesPerFrame);
  }

  push(pcm: Int16Array): Int16Array[] {
    const out: Int16Array[] = [];
    let i = 0;
    while (i < pcm.length) {
      const n = Math.min(this.samplesPerFrame - this.fill, pcm.length - i);
      this.buf.set(pcm.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.samplesPerFrame) {
        out.push(this.buf);
        this.buf = new Int16Array(this.samplesPerFrame);
        this.fill = 0;
      }
    }
    return out;
  }

  /**
   * The leftover samples, or null if there are none. By default they are
   * padded with silence to a whole frame, so even the last frame is exact;
   * pass false to get just the leftover.
   */
  flush(pad = true): Int16Array | null {
    if (this.fill === 0) return null;
    const rest = pad ? this.buf : this.buf.slice(0, this.fill);
    this.buf = new Int16Array(this.samplesPerFrame);
    this.fill = 0;
    return rest;
  }
}

/* ------------------------------------------------------------- synthesis */

function sampleCount(ms: number, rate: number): number {
  checkRate(rate, "rate");
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`duration must be >= 0 ms (got ${ms})`);
  return Math.round((ms * rate) / 1000);
}

/** A sine wave; amplitude is a fraction of full scale (clamped to 0..1). */
export function tone(freqHz: number, ms: number, rate: number, amplitude = 0.3): Int16Array {
  const out = new Int16Array(sampleCount(ms, rate));
  const a = Math.max(0, Math.min(1, amplitude)) * 32767;
  const w = (2 * Math.PI * freqHz) / rate;
  for (let i = 0; i < out.length; i++) out[i] = Math.round(a * Math.sin(w * i));
  return out;
}

/** ms of digital silence. */
export function silence(ms: number, rate: number): Int16Array {
  return new Int16Array(sampleCount(ms, rate));
}
