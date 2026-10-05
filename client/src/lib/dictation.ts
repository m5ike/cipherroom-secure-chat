// Dictation (6.7): speech into text that keeps listening until it is
// stopped — the composer's dictation button and the Speech panel. One state
// machine over an engine:
//   - the browser's recogniser (Web Speech: Chrome, Edge, Android) — the
//     browser listens itself; no audio passes through this app;
//   - the server's transcription (only when the operator turned Speech on):
//     the microphone is recorded through mic.ts (so through the voice changer
//     when it is on) and sent when dictation stops.
//
//   idle ─start→ starting ─(the engine started)→ listening
//   listening ─(the engine ended by itself: a pause, the network)→ restarting → starting …
//   starting / listening / restarting ─stop→ stopping ─(last words, end — or finishMs)→ idle
//   any ─abort, or a fatal error (no permission, no microphone)→ idle
//
// A stop always ends it: the engine is asked to stop (so the last words still
// come), a pending restart is cancelled, and if the engine has not ended
// within finishMs it is aborted. Events of an engine session that is over
// are ignored — a late "end" never restarts a stopped dictation.

import { releaseMic } from "./mic";
import { LOCALE_INFO, isLocale } from "./locales";

export type DictationState = "idle" | "starting" | "listening" | "restarting" | "stopping";

export type EngineEvents = {
  start(): void;
  partial(text: string): void;
  final(text: string): void;
  error(code: string): void;
  end(): void;
};

export type EngineSession = { stop(): void; abort(): void };

export type DictationEngine = {
  kind: "browser" | "server";
  /** How long a stop may take before it is aborted (the server transcribes after the stop). */
  finishMs?: number;
  /** Ends by itself after a pause (the browser's) and is started again; the server's records until stopped. */
  restarts?: boolean;
  /** Starts listening; throws when it cannot. */
  start(lang: string, events: EngineEvents): EngineSession;
};

/** Errors after which listening again is pointless. */
export const FATAL_DICTATION_ERRORS: ReadonlySet<string> = new Set([
  "not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "bad-grammar", "unsupported", "no-microphone",
]);

export type Timers = { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
const REAL_TIMERS: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

export type DictationOptions = {
  lang: string;
  /** Partial text (replaced by the next one) and finished pieces (to keep). */
  onText?: (text: string, final: boolean) => void;
  onState?: (state: DictationState) => void;
  /** A fatal error, a failed transcription, or "ended" (it kept ending with nothing heard). */
  onError?: (code: string) => void;
  finishMs?: number;
  restartMs?: number;
  /** Restarts in a row with nothing heard before it gives up (default 6). */
  maxIdleRestarts?: number;
  timers?: Timers;
};

export class Dictation {
  private s: DictationState = "idle";
  private session: EngineSession | null = null;
  private gen = 0;
  private restartTimer: unknown = null;
  private finishTimer: unknown = null;
  private idleRestarts = 0;
  private opts: DictationOptions;
  private readonly timers: Timers;

  constructor(private readonly engine: DictationEngine, opts: DictationOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? REAL_TIMERS;
  }

  get state(): DictationState { return this.s; }
  get active(): boolean { return this.s !== "idle"; }
  get kind(): DictationEngine["kind"] { return this.engine.kind; }

  setOptions(patch: Partial<DictationOptions>): void { this.opts = { ...this.opts, ...patch }; }

  /** Starts (when idle); false when the engine could not. */
  start(): boolean {
    if (this.s !== "idle") return false;
    this.idleRestarts = 0;
    return this.open();
  }

  /** Stops and finishes the text (the last words still come). */
  stop(): void {
    if (this.s === "idle" || this.s === "stopping") return;
    this.clearRestart();
    const session = this.session;
    if (!session) { this.finish(); return; } // between two sessions: nothing listens
    this.set("stopping");
    const gen = this.gen;
    try { session.stop(); } catch { /* already over */ }
    this.finishTimer = this.timers.set(() => {
      this.finishTimer = null;
      if (gen === this.gen && this.s === "stopping") { this.abortSession(); this.finish(); }
    }, this.opts.finishMs ?? this.engine.finishMs ?? 2000);
  }

  /** Stops at once; what was not finished is dropped. */
  abort(): void {
    if (this.s === "idle") return;
    this.abortSession();
    this.finish();
  }

  /** The button: start when idle, else stop. */
  toggle(): void {
    if (this.s === "idle") this.start();
    else this.stop();
  }

  private set(next: DictationState): void {
    if (this.s === next) return;
    this.s = next;
    this.opts.onState?.(next);
  }

  private open(): boolean {
    const gen = ++this.gen;
    this.set("starting");
    const mine = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { if (gen === this.gen) fn(...a); };
    try {
      this.session = this.engine.start(this.opts.lang, {
        start: mine(() => { if (this.s === "starting") this.set("listening"); }),
        partial: mine((text: string) => { if (text) { this.idleRestarts = 0; this.opts.onText?.(text, false); } }),
        final: mine((text: string) => { if (text) { this.idleRestarts = 0; this.opts.onText?.(text, true); } }),
        error: mine((code: string) => this.onError(code)),
        end: mine(() => this.onEnd()),
      });
      return true;
    } catch (err) {
      this.session = null;
      this.finish();
      const name = (err as { name?: string })?.name;
      this.opts.onError?.(name === "NotAllowedError" ? "not-allowed" : "unsupported");
      return false;
    }
  }

  private onError(code: string): void {
    if (FATAL_DICTATION_ERRORS.has(code) && this.s !== "stopping") {
      this.abortSession();
      this.finish();
      this.opts.onError?.(code);
      return;
    }
    // A pause ("no-speech") or our own abort is nothing to report; the rest is, and listening goes on.
    if (code !== "no-speech" && code !== "aborted") this.opts.onError?.(code);
  }

  private onEnd(): void {
    this.session = null;
    if (this.s === "stopping" || this.s === "idle" || this.engine.restarts === false) { this.finish(); return; }
    // It ended by itself (a pause, the network): dictation goes on.
    this.idleRestarts += 1;
    if (this.idleRestarts > (this.opts.maxIdleRestarts ?? 6)) {
      this.finish();
      this.opts.onError?.("ended");
      return;
    }
    this.set("restarting");
    this.restartTimer = this.timers.set(() => {
      this.restartTimer = null;
      if (this.s === "restarting") this.open();
    }, this.opts.restartMs ?? 250);
  }

  private abortSession(): void {
    const s = this.session;
    this.session = null;
    this.gen += 1;
    try { s?.abort(); } catch { /* already over */ }
  }

  private clearRestart(): void {
    if (this.restartTimer !== null) { this.timers.clear(this.restartTimer); this.restartTimer = null; }
  }

  private finish(): void {
    this.clearRestart();
    if (this.finishTimer !== null) { this.timers.clear(this.finishTimer); this.finishTimer = null; }
    this.session = null;
    this.gen += 1;
    this.set("idle");
  }
}

/* --------------------------------------------------------------- engines */

type ResultList = ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((ev: { results: ResultList; resultIndex: number }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

/** The browser's recogniser (Web Speech), or null when there is none. */
export function browserEngine(w: unknown = typeof window !== "undefined" ? window : undefined): DictationEngine | null {
  const W = (w ?? {}) as Record<string, unknown>;
  const Ctor = (W.SpeechRecognition || W.webkitSpeechRecognition) as (new () => Recognition) | undefined;
  if (!Ctor) return null;
  return {
    kind: "browser",
    finishMs: 2000,
    restarts: true,
    start(lang, ev) {
      const rec = new Ctor();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      rec.onstart = () => ev.start();
      rec.onresult = (e) => {
        let interim = "", fin = "";
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const r = e.results[i];
          if (r.isFinal) fin += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (fin.trim()) ev.final(fin.trim());
        if (interim.trim()) ev.partial(interim.trim());
      };
      rec.onerror = (e) => ev.error(e?.error || "error");
      rec.onend = () => ev.end();
      rec.start();
      return { stop: () => rec.stop(), abort: () => rec.abort() };
    },
  };
}

export type Transcribe = (audio: Blob) => Promise<{ ok: true; text: string } | { ok: false; message: string }>;

/**
 * The server's transcription: records the microphone (mic.ts — through the
 * voice changer when it is on) until stop, then sends it and gives the text.
 * Abort drops the recording unsent.
 */
export function serverEngine(deps: { open: () => Promise<MediaStream>; transcribe: Transcribe; Recorder?: typeof MediaRecorder }): DictationEngine {
  return {
    kind: "server",
    finishMs: 120_000,
    restarts: false,
    start(_lang, ev) {
      const Recorder = deps.Recorder ?? (typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined);
      if (!Recorder) throw new Error("no MediaRecorder");
      let stream: MediaStream | null = null;
      let rec: MediaRecorder | null = null;
      let cancelled = false, stopAsked = false;
      const chunks: Blob[] = [];
      deps.open().then((s) => {
        if (cancelled) { releaseMic(s); ev.end(); return; }
        stream = s;
        const r = new Recorder(s);
        rec = r;
        r.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        r.onstop = () => {
          releaseMic(stream);
          if (cancelled || chunks.length === 0) { ev.end(); return; }
          void deps.transcribe(new Blob(chunks, { type: r.mimeType || "audio/webm" })).then((t) => {
            if (t.ok && t.text.trim()) ev.final(t.text.trim());
            else if (!t.ok) ev.error("transcription");
            ev.end();
          }, () => { ev.error("transcription"); ev.end(); });
        };
        r.start(1000);
        ev.start();
        if (stopAsked) r.stop();
      }, (err: { name?: string }) => {
        ev.error(err?.name === "NotAllowedError" ? "not-allowed" : "no-microphone");
        ev.end();
      });
      return {
        stop: () => { stopAsked = true; if (rec && rec.state !== "inactive") rec.stop(); },
        abort: () => {
          cancelled = true;
          if (rec && rec.state !== "inactive") rec.stop();
          else releaseMic(stream);
        },
      };
    },
  };
}

/** The recogniser's language for the app's (cs → cs-CZ, sk → sk-SK …; English as en-US, the recognisers' best model). */
export function dictationLang(lang: string): string {
  if (lang === "en") return "en-US";
  return isLocale(lang) ? LOCALE_INFO[lang].tag : lang;
}

/**
 * What the dictated text makes of the field: the text that was there when
 * dictation started (base), the finished pieces, and the partial one.
 */
export class DictatedText {
  private base: string;
  private partial = "";

  constructor(start: string) {
    this.base = start && !/\s$/.test(start) ? `${start} ` : start;
  }

  /** The field's text after this piece. */
  add(text: string, final: boolean): string {
    if (final) { this.base = `${this.base}${text} `; this.partial = ""; }
    else this.partial = text;
    return this.value;
  }

  get value(): string { return `${this.base}${this.partial}`.replace(/\s+$/, this.partial ? "" : " ").trimStart(); }

  /** The finished text, without the trailing space. */
  get finished(): string { return this.base.trim(); }
}
