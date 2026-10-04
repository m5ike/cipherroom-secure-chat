// The conference mixer of a routed call (6.9, route_audio into a room):
// the caller and every member who joined the call's audio are sources; each
// of them hears everyone else — the caller hears all the members mixed, a
// member hears the caller and the other members — never themselves.
//
//   20 ms frames   everything is mixed at MIX_RATE (16 kHz, the members' own
//                  rate) in frames of 320 samples; the caller's line is
//                  resampled into it and out of it (route-audio.ts)
//   jitter         a member's browser sends ~43 ms chunks, the provider 20 ms
//                  frames — each source has its own small buffer: it starts
//                  playing once it holds `target` samples, an underrun plays
//                  what is there (padded with silence) and buffers again, and
//                  a source that runs ahead is cut back to `target` (latency
//                  never grows)
//   sum            32-bit sums of 16-bit PCM; above a knee (75 % of full
//                  scale) a soft limiter (tanh) bends the peaks so a loud
//                  room never wraps or clips hard — below it nothing changes
//
// Pure and synchronous: no timers, no I/O. route-audio.ts calls tick() every
// 20 ms (a drift-corrected clock); tests call it directly.

export const MIX_RATE = 16_000;
/** 20 ms at MIX_RATE. */
export const MIX_FRAME = 320;
/** Below this nothing is changed; above it the peaks are bent smoothly towards full scale. */
export const LIMIT_KNEE = 24_576;
const FULL = 32_767;

/** A summed sample (any size) → 16 bits: identity up to the knee, then a tanh curve that never reaches past full scale. */
export function softLimit(x: number): number {
  const a = x < 0 ? -x : x;
  if (a <= LIMIT_KNEE) return x;
  const span = FULL - LIMIT_KNEE;
  const y = Math.round(LIMIT_KNEE + span * Math.tanh((a - LIMIT_KNEE) / span));
  return x < 0 ? -y : y;
}

/** Plain clipping (for comparison and for callers that want it). */
export function hardClip(x: number): number {
  return x > FULL ? FULL : x < -32_768 ? -32_768 : x;
}

export type JitterOptions = {
  /** Samples per frame (MIX_FRAME). */
  frame?: number;
  /** Samples to hold before playing (and after an underrun). */
  target?: number;
  /** More than this and the oldest audio is dropped down to `target`. */
  max?: number;
};

/** One source's buffer: whatever chunk sizes come in, whole frames go out. */
export class JitterBuffer {
  readonly frame: number;
  readonly target: number;
  readonly max: number;
  private buf: Int16Array;
  private start = 0;
  private end = 0;
  private primed = false;
  readonly stats = { underruns: 0, dropped: 0, frames: 0 };

  constructor(o: JitterOptions = {}) {
    this.frame = o.frame ?? MIX_FRAME;
    this.target = Math.max(this.frame, o.target ?? this.frame * 3);
    this.max = Math.max(this.target + this.frame, o.max ?? this.frame * 15);
    this.buf = new Int16Array(this.max + this.frame * 8);
  }

  get buffered(): number { return this.end - this.start; }
  get playing(): boolean { return this.primed; }

  push(pcm: Int16Array): void {
    if (!pcm.length) return;
    // A chunk longer than the whole buffer: only its newest part matters.
    const chunk = pcm.length > this.max ? pcm.subarray(pcm.length - this.max) : pcm;
    this.stats.dropped += pcm.length - chunk.length;
    if (this.end + chunk.length > this.buf.length) this.compact(chunk.length);
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
    if (this.buffered > this.max) {
      const drop = this.buffered - this.target;
      this.start += drop;
      this.stats.dropped += drop;
    }
  }

  /** One frame, or null (silence) while it fills up. */
  pull(): Int16Array | null {
    if (!this.primed) {
      if (this.buffered < this.target) return null;
      this.primed = true;
    }
    const out = new Int16Array(this.frame);
    const n = Math.min(this.frame, this.buffered);
    out.set(this.buf.subarray(this.start, this.start + n));
    this.start += n;
    if (n < this.frame) {
      // Ran dry: play what was there, then fill up again.
      this.stats.underruns += 1;
      this.primed = false;
      this.start = this.end = 0;
      if (n === 0) return null;
    }
    this.stats.frames += 1;
    return out;
  }

  clear(): void { this.start = this.end = 0; this.primed = false; }

  private compact(incoming: number): void {
    const live = this.buf.subarray(this.start, this.end);
    if (live.length + incoming > this.buf.length) {
      const bigger = new Int16Array(live.length + incoming + this.frame * 8);
      bigger.set(live);
      this.buf = bigger;
    } else {
      this.buf.copyWithin(0, this.start, this.end);
    }
    this.end = live.length;
    this.start = 0;
  }
}

export type MixResult = {
  /** What each listener hears this frame (everyone else, limited). */
  out: Map<string, Int16Array>;
  /** The sources that had audio this frame. */
  active: string[];
  /** Each active source's level this frame (RMS, 0 … ~1). */
  levels: Map<string, number>;
};

/**
 * Sources push audio at any time; listeners are asked for at each tick. A
 * listener that is also a source (the caller, a member) does not hear itself
 * (mix-minus); a source that is not a listener (a spoken reply, a ringing
 * tone) is heard by everyone.
 */
export class Mixer {
  readonly frame: number;
  private readonly sources = new Map<string, JitterBuffer>();
  private readonly total: Int32Array;

  constructor(frame = MIX_FRAME) {
    this.frame = frame;
    this.total = new Int32Array(frame);
  }

  add(id: string, o: JitterOptions = {}): JitterBuffer {
    let b = this.sources.get(id);
    if (!b) { b = new JitterBuffer({ frame: this.frame, ...o }); this.sources.set(id, b); }
    return b;
  }

  remove(id: string): boolean { return this.sources.delete(id); }
  has(id: string): boolean { return this.sources.has(id); }
  get size(): number { return this.sources.size; }
  source(id: string): JitterBuffer | undefined { return this.sources.get(id); }

  /** Audio from a source (dropped when it is not one). */
  push(id: string, pcm: Int16Array): void { this.sources.get(id)?.push(pcm); }

  /** One frame for each listener. */
  tick(listeners: Iterable<string>): MixResult {
    const total = this.total;
    total.fill(0);
    const own = new Map<string, Int16Array>();
    const levels = new Map<string, number>();
    for (const [id, b] of this.sources) {
      const f = b.pull();
      if (!f) continue;
      own.set(id, f);
      let sq = 0;
      for (let i = 0; i < f.length; i++) { total[i] += f[i]; sq += f[i] * f[i]; }
      levels.set(id, Math.sqrt(sq / f.length) / 32_768);
    }
    const out = new Map<string, Int16Array>();
    for (const id of listeners) {
      const mine = own.get(id);
      const o = new Int16Array(this.frame);
      if (own.size > (mine ? 1 : 0)) {
        for (let i = 0; i < o.length; i++) o[i] = softLimit(mine ? total[i] - mine[i] : total[i]);
      }
      out.set(id, o);
    }
    return { out, active: [...own.keys()], levels };
  }
}
