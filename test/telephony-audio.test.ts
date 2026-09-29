// @vitest-environment node
//
// Call audio plumbing (server/telephony/audio.ts): G.711 against the ITU-T
// reference values, byte order at unaligned offsets, resampling (lengths,
// frequency, aliasing, chunked == one-shot), WAV files built by hand, levels,
// the voice-activity segmenter on synthetic tone bursts with and without line
// hiss, and provider framing.

import { describe, it, expect } from "vitest";
import {
  mulawEncode, mulawDecode, alawEncode, alawDecode,
  pcm16FromLE, pcm16ToLE, pcm16FromBE, pcm16ToBE,
  resample, StreamResampler,
  wavEncode, wavDecode,
  rms, dbfs,
  Segmenter, Framer,
  tone, silence,
  type Utterance, type SegmenterOptions,
} from "../server/telephony/audio";

/* ---------------------------------------------------------------- helpers */

function cat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function mix(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(-32768, Math.min(32767, a[i] + (b[i] ?? 0)));
  return out;
}

// Deterministic white noise at a given level (uniform: rms = peak / sqrt 3).
function noise(ms: number, rate: number, db: number, seed = 1): Int16Array {
  const out = new Int16Array(Math.round((ms * rate) / 1000));
  const peak = 10 ** (db / 20) * 32768 * Math.sqrt(3);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = Math.round((s / 2 ** 32 * 2 - 1) * peak);
  }
  return out;
}

function zeroCrossings(pcm: Int16Array): number {
  let n = 0;
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) n++;
  return n;
}

function maxAbsDiff(a: Int16Array, b: Int16Array): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function u16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function u32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }

function chunk(id: string, body: Uint8Array | number[], declared?: number): Uint8Array {
  const b = body instanceof Uint8Array ? body : Uint8Array.from(body);
  const pad = b.length & 1;
  const out = new Uint8Array(8 + b.length + pad);
  out.set(ascii(id));
  out.set(u32(declared ?? b.length), 4);
  out.set(b, 8);
  return out;
}

function riff(...chunks: Uint8Array[]): Uint8Array {
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(ascii("RIFF"));
  out.set(u32(4 + body), 4);
  out.set(ascii("WAVE"), 8);
  let at = 12;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function fmt(tag: number, channels: number, rate: number, bits: number): Uint8Array {
  const block = channels * (bits / 8);
  return chunk("fmt ", [...u16(tag), ...u16(channels), ...u32(rate), ...u32(rate * block), ...u16(block), ...u16(bits)]);
}

// WAVE_FORMAT_EXTENSIBLE: cbSize 22, valid bits, channel mask, sub-format GUID.
function fmtExtensible(subTag: number, channels: number, rate: number, bits: number): Uint8Array {
  const block = channels * (bits / 8);
  const guidTail = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
  return chunk("fmt ", [
    ...u16(0xfffe), ...u16(channels), ...u32(rate), ...u32(rate * block), ...u16(block), ...u16(bits),
    ...u16(22), ...u16(bits), ...u32(channels === 2 ? 3 : 4), ...u16(subTag), ...guidTail,
  ]);
}

function le16(...samples: number[]): Uint8Array { return pcm16ToLE(Int16Array.from(samples)); }

function f32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return out;
}

const LIST = chunk("LIST", [...ascii("INFOISFT"), ...u32(5), ...ascii("m5ce"), 0]); // 17 bytes: exercises padding

/* ----------------------------------------------------------------- G.711 */

describe("G.711 µ-law", () => {
  it("matches the reference vectors", () => {
    expect(Array.from(mulawEncode(Int16Array.of(0, -1, 32767, -32768)))).toEqual([0xff, 0x7f, 0x80, 0x00]);
    expect(Array.from(mulawDecode(Uint8Array.of(0xff, 0x7f, 0x80, 0x00)))).toEqual([0, 0, 32124, -32124]);
  });

  it("round-trips within the quantisation error", () => {
    const all = Int16Array.from({ length: 65536 }, (_, i) => i - 32768);
    const back = mulawDecode(mulawEncode(all));
    let worst = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < all.length; i++) {
      const x = all[i];
      if (Math.abs(x) < 1000) continue; // mid-range and up; tiny values have a fixed step
      const rel = Math.abs(back[i] - x) / Math.abs(x);
      worst = Math.max(worst, rel);
      sum += rel;
      n++;
    }
    // Half a step is 1/32 of the segment start (~3.1%), a touch more where the bias bites.
    expect(worst).toBeLessThan(0.035);
    expect(sum / n).toBeLessThan(0.015);
    // Small values: never off by more than half the smallest step.
    for (let x = -999; x < 1000; x++) expect(Math.abs(mulawDecode(mulawEncode(Int16Array.of(x)))[0] - x)).toBeLessThanOrEqual(32);
  });

  it("re-encodes every decoded code to itself, except negative zero", () => {
    const codes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const again = mulawEncode(mulawDecode(codes));
    for (let b = 0; b < 256; b++) expect(again[b]).toBe(b === 0x7f ? 0xff : b);
  });
});

describe("G.711 A-law", () => {
  it("matches the reference vectors", () => {
    expect(Array.from(alawEncode(Int16Array.of(0, -1, 32767, -32768)))).toEqual([0xd5, 0x55, 0xaa, 0x2a]);
    expect(Array.from(alawDecode(Uint8Array.of(0xd5, 0x55, 0xaa, 0x2a)))).toEqual([8, -8, 32256, -32256]);
  });

  it("round-trips within the quantisation error", () => {
    const all = Int16Array.from({ length: 65536 }, (_, i) => i - 32768);
    const back = alawDecode(alawEncode(all));
    let worst = 0;
    for (let i = 0; i < all.length; i++) {
      if (Math.abs(all[i]) < 1000) continue;
      worst = Math.max(worst, Math.abs(back[i] - all[i]) / Math.abs(all[i]));
    }
    expect(worst).toBeLessThan(0.035);
  });

  it("re-encodes every decoded code to itself", () => {
    const codes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(alawEncode(alawDecode(codes)))).toEqual(Array.from(codes));
  });
});

/* ------------------------------------------------------------ byte order */

describe("byte order", () => {
  const pcm = Int16Array.of(0x1234, -2, 32767, -32768, 0, 1);

  it("lays bytes out little- and big-endian", () => {
    expect(Array.from(pcm16ToLE(Int16Array.of(0x1234, -2)))).toEqual([0x34, 0x12, 0xfe, 0xff]);
    expect(Array.from(pcm16ToBE(Int16Array.of(0x1234, -2)))).toEqual([0x12, 0x34, 0xff, 0xfe]);
  });

  it("round-trips at an odd byteOffset, copying rather than aliasing", () => {
    for (const [to, from] of [[pcm16ToLE, pcm16FromLE], [pcm16ToBE, pcm16FromBE]] as const) {
      const backing = new Uint8Array(1 + pcm.length * 2 + 1);
      backing.set(to(pcm), 1);
      const view = backing.subarray(1, 1 + pcm.length * 2);
      expect(view.byteOffset).toBe(1);
      const back = from(view);
      expect(Array.from(back)).toEqual(Array.from(pcm));
      backing.fill(0);
      expect(Array.from(back)).toEqual(Array.from(pcm)); // not a view of the input
    }
  });

  it("reads a Buffer slice and ignores a trailing odd byte", () => {
    const buf = Buffer.concat([Buffer.from([9]), Buffer.from(pcm16ToLE(pcm)), Buffer.from([7])]).subarray(1);
    expect(Array.from(pcm16FromLE(buf))).toEqual(Array.from(pcm));
  });
});

/* ------------------------------------------------------------ resampling */

describe("resample", () => {
  it("returns round(len * to / from) samples", () => {
    const cases: Array<[number, number, number, number]> = [
      [16000, 8000, 320, 160], [8000, 16000, 160, 320], [48000, 8000, 960, 160], [48000, 16000, 960, 320],
      [44100, 16000, 882, 320], [24000, 8000, 480, 160], [8000, 11025, 100, 138], [16000, 8000, 1, 1],
      [8000, 16000, 1, 2], [22050, 8000, 7, 3], [16000, 8000, 0, 0],
    ];
    for (const [from, to, len, want] of cases) {
      expect(want).toBe(Math.round((len * to) / from));
      expect(resample(tone(440, (len * 1000) / from, from), from, to).length).toBe(want);
    }
  });

  it("returns a copy at the same rate", () => {
    const x = tone(440, 20, 8000);
    const y = resample(x, 8000, 8000);
    expect(y).not.toBe(x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it("keeps a 1 kHz tone at 1 kHz through 8k -> 16k -> 8k", () => {
    const x = tone(1000, 1000, 8000, 0.5);
    const up = resample(x, 8000, 16000);
    const down = resample(up, 16000, 8000);
    expect(zeroCrossings(up) / 2).toBeCloseTo(1000, -1);
    expect(zeroCrossings(down) / 2).toBeCloseTo(1000, -1);
    expect(Math.abs(zeroCrossings(down) - zeroCrossings(x))).toBeLessThanOrEqual(2);
    expect(rms(down) / rms(x)).toBeGreaterThan(0.9);
  });

  it("filters out what would alias when downsampling", () => {
    // 6 kHz at 16 kHz would fold to 2 kHz at 8 kHz; 5 kHz at 48 kHz to 3 kHz.
    expect(rms(resample(tone(6000, 500, 16000, 0.5), 16000, 8000))).toBeLessThan(0.01 * rms(tone(6000, 500, 16000, 0.5)));
    expect(rms(resample(tone(5000, 500, 48000, 0.5), 48000, 8000))).toBeLessThan(0.01 * rms(tone(5000, 500, 48000, 0.5)));
    // ...while speech-band content passes.
    for (const f of [300, 1000, 3000]) {
      const x = tone(f, 500, 16000, 0.5);
      expect(rms(resample(x, 16000, 8000)) / rms(x)).toBeGreaterThan(0.95);
    }
  });

  it("keeps a constant constant, right up to the edges", () => {
    const dc = new Int16Array(4800).fill(1000);
    for (const [from, to] of [[48000, 8000], [8000, 48000], [44100, 16000]]) {
      expect(new Set(resample(dc, from, to))).toEqual(new Set([1000]));
    }
  });

  it("rejects nonsense rates", () => {
    expect(() => resample(new Int16Array(4), 0, 8000)).toThrow(RangeError);
    expect(() => new StreamResampler(8000, Number.NaN)).toThrow(RangeError);
  });
});

describe("StreamResampler", () => {
  const speechy = (rate: number) =>
    mix(cat(tone(300, 400, rate, 0.4), tone(2500, 300, rate, 0.2), tone(1000, 300, rate, 0.5)), noise(1000, rate, -30));

  it("gives the one-shot result when fed 20 ms frames", () => {
    for (const [from, to] of [[16000, 8000], [8000, 16000], [48000, 8000], [44100, 16000], [24000, 8000], [8000, 11025]]) {
      const x = speechy(from);
      const oneShot = resample(x, from, to);
      const r = new StreamResampler(from, to);
      const frame = Math.round(from / 50);
      const parts: Int16Array[] = [];
      for (let i = 0; i < x.length; i += frame) parts.push(r.push(x.subarray(i, i + frame)));
      parts.push(r.flush());
      const chunked = cat(...parts);
      expect(Math.abs(chunked.length - oneShot.length)).toBeLessThanOrEqual(2);
      expect(maxAbsDiff(chunked, oneShot)).toBeLessThanOrEqual(2);
      expect(Array.from(chunked)).toEqual(Array.from(oneShot)); // in fact identical, by construction
    }
  });

  it("keeps up with a live stream: one frame out per frame in, after a ~2 ms delay", () => {
    const r = new StreamResampler(16000, 8000);
    const x = speechy(16000);
    const sizes: number[] = [];
    for (let i = 0; i < x.length; i += 320) sizes.push(r.push(x.subarray(i, i + 320)).length);
    expect(sizes[0]).toBeGreaterThan(160 - 20);
    expect(sizes.slice(1).every((n) => n === 160)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0) + r.flush().length).toBe(8000);
  });

  it("starts a fresh stream after flush()", () => {
    const r = new StreamResampler(8000, 16000);
    const x = tone(700, 100, 8000);
    const a = cat(r.push(x), r.flush());
    const b = cat(r.push(x), r.flush());
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});

/* ------------------------------------------------------------------- WAV */

describe("WAV", () => {
  it("encodes a canonical 44-byte header and decodes back", () => {
    const pcm = tone(440, 50, 16000);
    const wav = wavEncode(pcm, 16000);
    expect(wav.length).toBe(44 + pcm.length * 2);
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(dv.getUint32(4, true)).toBe(36 + pcm.length * 2);
    expect(String.fromCharCode(...wav.subarray(8, 16))).toBe("WAVEfmt ");
    expect([dv.getUint32(16, true), dv.getUint16(20, true), dv.getUint16(22, true)]).toEqual([16, 1, 1]);
    expect([dv.getUint32(24, true), dv.getUint32(28, true), dv.getUint16(32, true), dv.getUint16(34, true)]).toEqual([16000, 32000, 2, 16]);
    expect(String.fromCharCode(...wav.subarray(36, 40))).toBe("data");
    expect(dv.getUint32(40, true)).toBe(pcm.length * 2);
    const back = wavDecode(wav);
    expect(back.rate).toBe(16000);
    expect(back.channels).toBe(1);
    expect(Array.from(back.pcm)).toEqual(Array.from(pcm));
  });

  it("down-mixes an encoded stereo file", () => {
    const wav = wavEncode(Int16Array.of(1000, 3000, -2000, -4000), 8000, 2);
    expect(wavDecode(wav)).toEqual({ pcm: Int16Array.of(2000, -3000), rate: 8000, channels: 2 });
    expect(() => wavEncode(Int16Array.of(1, 2, 3), 8000, 2)).toThrow(RangeError);
  });

  it("decodes 8-bit unsigned PCM", () => {
    const wav = riff(fmt(1, 1, 8000, 8), chunk("data", [128, 255, 0, 192, 64]));
    expect(Array.from(wavDecode(wav).pcm)).toEqual([0, 32512, -32768, 16384, -16384]);
  });

  it("decodes 32-bit float, clamping out-of-range values", () => {
    const wav = riff(fmt(3, 1, 24000, 32), LIST, chunk("data", f32(0, 0.5, -0.5, 1, -1, 2, -3, Number.NaN)));
    const out = wavDecode(wav);
    expect(out.rate).toBe(24000);
    expect(Array.from(out.pcm)).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768, 0]);
  });

  it("decodes µ-law and A-law", () => {
    const mu = riff(fmt(7, 1, 8000, 8), chunk("fact", u32(3)), chunk("data", [0xff, 0x80, 0x00]));
    expect(Array.from(wavDecode(mu).pcm)).toEqual([0, 32124, -32124]);
    const a = riff(fmt(6, 1, 8000, 8), chunk("data", [0xd5, 0xaa, 0x2a]));
    expect(Array.from(wavDecode(a).pcm)).toEqual([8, 32256, -32256]);
  });

  it("averages a stereo file to mono, past a padded LIST chunk", () => {
    expect(LIST.length).toBe(8 + 17 + 1); // odd body, so a pad byte follows
    const wav = riff(fmt(1, 2, 16000, 16), LIST, chunk("data", le16(1000, 3000, -2000, -4000, 32767, 32767)));
    expect(wavDecode(wav)).toEqual({ pcm: Int16Array.of(2000, -3000, 32767), rate: 16000, channels: 2 });
  });

  it("reads WAVE_FORMAT_EXTENSIBLE by its sub-format", () => {
    const pcm = riff(fmtExtensible(1, 2, 48000, 16), LIST, chunk("data", le16(100, 300, -100, -300)));
    expect(wavDecode(pcm)).toEqual({ pcm: Int16Array.of(200, -200), rate: 48000, channels: 2 });
    const pcm24 = riff(fmtExtensible(1, 1, 48000, 24), chunk("data", [0x00, 0x00, 0x80, 0xff, 0xff, 0x7f, 0x00, 0x01, 0x00]));
    expect(Array.from(wavDecode(pcm24).pcm)).toEqual([-32768, 32767, 1]);
    const float = riff(fmtExtensible(3, 1, 16000, 32), chunk("data", f32(0.25)));
    expect(Array.from(wavDecode(float).pcm)).toEqual([8192]);
  });

  it("accepts chunks in any order and a streamed (unknown) data size", () => {
    const body = le16(5, -5, 7);
    const streamed = riff(fmt(1, 1, 8000, 16), chunk("data", body, 0xffffffff));
    expect(Array.from(wavDecode(streamed).pcm)).toEqual([5, -5, 7]);
    // fmt after data, and a Buffer at an odd offset in its pool.
    const reordered = riff(chunk("data", body), fmt(1, 1, 8000, 16));
    const odd = Buffer.concat([Buffer.from([0]), Buffer.from(reordered)]).subarray(1);
    expect(Array.from(wavDecode(odd).pcm)).toEqual([5, -5, 7]);
  });

  it("throws a clear error on malformed input", () => {
    const good = wavEncode(tone(440, 10, 8000), 8000);
    expect(() => wavDecode(good.subarray(0, 8))).toThrow(/too short/);
    expect(() => wavDecode(good.subarray(0, 60))).toThrow(/"data" chunk truncated/);
    expect(() => wavDecode(good.subarray(0, 30))).toThrow(/"fmt " chunk truncated/);
    expect(() => wavDecode(good.subarray(0, 36))).toThrow(/no data chunk/);
    expect(() => wavDecode(ascii("OggS\0\0\0\0\0\0\0\0\0\0\0\0"))).toThrow(/not a RIFF file/);
    expect(() => wavDecode(new TextEncoder().encode("RIFF\x04\0\0\0AVI LIST"))).toThrow(/not "WAVE"/);
    expect(() => wavDecode(riff(chunk("data", [1, 2])))).toThrow(/no fmt chunk/);
    expect(() => wavDecode(riff(chunk("fmt ", [1, 0, 1, 0]), chunk("data", [1, 2])))).toThrow(/fmt chunk too short/);
    expect(() => wavDecode(riff(fmt(2, 1, 8000, 4), chunk("data", [1, 2])))).toThrow(/unsupported encoding \(format 2, 4-bit\)/);
    expect(() => wavDecode(riff(fmt(1, 0, 8000, 16), chunk("data", [1, 2])))).toThrow(/0 channels/);
    expect(() => wavDecode(riff(chunk("fmt ", [0xfe, 0xff, 1, 0, 0x40, 0x1f, 0, 0, 0, 0, 0, 0, 2, 0, 16, 0]), chunk("data", [1, 2]))))
      .toThrow(/EXTENSIBLE fmt chunk too short/);
  });
});

/* ---------------------------------------------------------------- levels */

describe("levels", () => {
  it("measures rms and dBFS", () => {
    expect(rms(new Int16Array(0))).toBe(0);
    expect(dbfs(silence(20, 8000))).toBe(-Infinity);
    expect(rms(tone(1000, 1000, 8000, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(dbfs(tone(1000, 1000, 8000, 0.5))).toBeCloseTo(-9.03, 1);
    const square = Int16Array.from({ length: 160 }, (_, i) => (i % 2 ? 32767 : -32768));
    expect(dbfs(square)).toBeCloseTo(0, 3);
  });
});

/* ------------------------------------------------------------- Segmenter */

function segmentAll(opts: SegmenterOptions, pcm: Int16Array, chunkSize = 160): { utterances: Utterance[]; seg: Segmenter } {
  const seg = new Segmenter(opts);
  const utterances: Utterance[] = [];
  for (let i = 0; i < pcm.length; i += chunkSize) utterances.push(...seg.push(pcm.subarray(i, i + chunkSize)));
  const last = seg.flush();
  if (last) utterances.push(last);
  return { utterances, seg };
}

// Three "words" separated by pauses longer than the hangover, deliberately
// not aligned to 20 ms frames. Truth in ms.
function bursts(rate: number): { pcm: Int16Array; truth: Array<[number, number]> } {
  const parts: Int16Array[] = [];
  const truth: Array<[number, number]> = [];
  let t = 0;
  const add = (p: Int16Array) => { parts.push(p); t += (p.length * 1000) / rate; };
  add(silence(513, rate));
  for (const [f, ms, gap] of [[440, 807, 1000], [620, 611, 1200], [300, 402, 1000]]) {
    const start = t;
    add(tone(f, ms, rate, 0.3));
    truth.push([start, t]);
    add(silence(gap, rate));
  }
  return { pcm: cat(...parts), truth };
}

function expectNear(utterances: Utterance[], truth: Array<[number, number]>, frameMs = 20): void {
  expect(utterances.length).toBe(truth.length);
  utterances.forEach((u, i) => {
    expect(Math.abs(u.startMs - truth[i][0])).toBeLessThanOrEqual(2 * frameMs);
    expect(Math.abs(u.endMs - truth[i][1])).toBeLessThanOrEqual(2 * frameMs);
  });
}

describe("Segmenter", () => {
  it("finds tone bursts separated by silence, with pre-roll around each", () => {
    for (const rate of [8000, 16000]) {
      const { pcm, truth } = bursts(rate);
      const seg = new Segmenter({ rate });
      const found: Utterance[] = [];
      for (let i = 0; i < pcm.length; i += 160) found.push(...seg.push(pcm.subarray(i, i + 160)));
      expectNear(found, truth); // all three complete during push(): the trailing silence outlasts the hangover
      expect(seg.flush()).toBeNull();
      for (const u of found) {
        // 200 ms of context either side, all available here.
        expect(u.pcm.length).toBe(Math.round(((u.endMs - u.startMs + 400) * rate) / 1000));
      }
    }
  });

  it("still segments with steady hiss between the stop and start thresholds", () => {
    const rate = 8000;
    const { pcm, truth } = bursts(rate);
    const hiss = noise((pcm.length * 1000) / rate, rate, -45);
    // Louder than stopDb (-48): with fixed thresholds no utterance would ever end.
    expect(dbfs(hiss)).toBeGreaterThan(-48);
    expect(dbfs(hiss)).toBeLessThan(-42);
    const { utterances, seg } = segmentAll({ rate }, mix(pcm, hiss));
    expectNear(utterances, truth);
    expect(seg.noiseFloorDb).not.toBeNull();
    expect(Math.abs((seg.noiseFloorDb ?? 0) - dbfs(hiss))).toBeLessThan(1.5);
  });

  it("learns a hiss that starts after digital silence", () => {
    const rate = 8000;
    const { pcm, truth } = bursts(rate);
    const lead = silence(1000, rate);
    const hiss = cat(new Int16Array(lead.length), noise((pcm.length * 1000) / rate, rate, -44, 7));
    const { utterances } = segmentAll({ rate }, mix(cat(lead, pcm), hiss));
    expectNear(utterances, truth.map(([s, e]) => [s + 1000, e + 1000]));
  });

  it("cuts speech longer than maxUtteranceMs into back-to-back pieces", () => {
    const rate = 8000;
    const pcm = cat(silence(300, rate), tone(440, 16000, rate), silence(1000, rate));
    const { utterances } = segmentAll({ rate }, pcm);
    expect(utterances.map((u) => [u.startMs, u.endMs])).toEqual([[300, 15300], [15300, 16300]]);
    // No audio twice: the second piece starts where the first ended.
    expect(utterances[0].pcm.length).toBe((200 + 15000) * 8);
    expect(utterances[1].pcm.length).toBe((1000 + 200) * 8);

    const short = segmentAll({ rate, maxUtteranceMs: 2000 }, cat(tone(440, 5000, rate), silence(1000, rate))).utterances;
    expect(short.map((u) => [u.startMs, u.endMs])).toEqual([[0, 2000], [2000, 4000], [4000, 5000]]);
  });

  it("ignores clicks and blips shorter than minSpeechMs", () => {
    const rate = 8000;
    const click = Int16Array.of(30000, -30000, 20000, -20000);
    const pcm = cat(silence(500, rate), click, silence(1000, rate), tone(440, 200, rate, 0.5), silence(1000, rate), click, silence(300, rate));
    expect(segmentAll({ rate }, pcm).utterances).toEqual([]);
    // ...but a 300 ms word gets through.
    const word = cat(silence(500, rate), tone(440, 300, rate, 0.5), silence(1000, rate));
    expect(segmentAll({ rate }, word).utterances).toHaveLength(1);
  });

  it("returns the utterance in progress from flush(), if long enough", () => {
    const rate = 16000;
    const seg = new Segmenter({ rate });
    expect(seg.push(cat(silence(400, rate), tone(440, 600, rate)))).toEqual([]);
    const u = seg.flush();
    expect(u).not.toBeNull();
    expect(u!.startMs).toBe(400);
    expect(u!.endMs).toBe(1000);
    expect(seg.flush()).toBeNull();
    // Too short at the end of the stream: nothing.
    const seg2 = new Segmenter({ rate });
    seg2.push(cat(silence(400, rate), tone(440, 100, rate)));
    expect(seg2.flush()).toBeNull();
  });

  it("gives the same result for chunks of 37 and of 1000 samples", () => {
    const rate = 8000;
    const { pcm } = bursts(rate);
    const noisy = mix(cat(pcm, tone(500, 700, rate)), noise((pcm.length * 1000) / rate + 700, rate, -46, 3));
    const a = segmentAll({ rate }, noisy, 37).utterances;
    const b = segmentAll({ rate }, noisy, 1000).utterances;
    expect(a).toHaveLength(4); // the last one comes from flush()
    expect(a).toEqual(b);
  });

  it("rejects impossible options", () => {
    expect(() => new Segmenter({ rate: 0 })).toThrow(RangeError);
    expect(() => new Segmenter({ rate: 8000, frameMs: 0 })).toThrow(RangeError);
    expect(() => new Segmenter({ rate: 8000, startDb: -50, stopDb: -40 })).toThrow(RangeError);
  });
});

/* ---------------------------------------------------------------- Framer */

describe("Framer", () => {
  it("cuts exact 160-sample frames and keeps the remainder", () => {
    const f = new Framer(160);
    const x = Int16Array.from({ length: 400 }, (_, i) => i + 1);
    expect(f.push(x.subarray(0, 100))).toEqual([]);
    const frames = f.push(x.subarray(100));
    expect(frames.map((fr) => fr.length)).toEqual([160, 160]);
    expect(Array.from(cat(...frames))).toEqual(Array.from(x.subarray(0, 320)));
    const rest = f.flush(false);
    expect(Array.from(rest!)).toEqual(Array.from(x.subarray(320)));
    expect(f.flush()).toBeNull();
  });

  it("pads the last frame with silence by default", () => {
    const f = new Framer(320);
    expect(f.push(tone(440, 30, 16000)).map((fr) => fr.length)).toEqual([320]);
    const last = f.flush()!;
    expect(last.length).toBe(320);
    expect(Array.from(last.subarray(160))).toEqual(new Array(160).fill(0));
    expect(Array.from(last.subarray(0, 160))).toEqual(Array.from(tone(440, 30, 16000).subarray(320)));
  });

  it("hands out frames that do not share memory", () => {
    const f = new Framer(4);
    const [a, b] = f.push(Int16Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    a[0] = 99;
    expect(Array.from(b)).toEqual([5, 6, 7, 8]);
    expect(() => new Framer(0)).toThrow(RangeError);
    expect(() => new Framer(1.5)).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------- synthesis */

describe("tone and silence", () => {
  it("synthesises the requested length and level", () => {
    expect(tone(440, 20, 8000).length).toBe(160);
    expect(silence(20, 16000)).toEqual(new Int16Array(320));
    const t = tone(1000, 1000, 8000);
    expect(Math.max(...t)).toBeLessThanOrEqual(Math.round(0.3 * 32767));
    expect(zeroCrossings(t) / 2).toBeCloseTo(1000, -1);
    expect(Math.max(...tone(2000, 10, 8000, 5))).toBe(32767); // amplitude clamped to full scale
  });
});
