// Dictation (6.7, client/src/lib/dictation.ts): the state machine that
// keeps listening until it is stopped — and always stops when asked: the
// last words still come, a pending restart is cancelled, an engine that
// does not end is aborted, a late event of an old session changes nothing.
// Then the two engines: the browser's recogniser (a pretend
// SpeechRecognition) and the server's transcription (a pretend recorder).

import { describe, it, expect } from "vitest";
import {
  Dictation, DictatedText, FATAL_DICTATION_ERRORS, browserEngine, dictationLang, serverEngine,
  type DictationEngine, type DictationState, type EngineEvents, type Timers,
} from "../client/src/lib/dictation";

/** Timers run by hand. */
function clock() {
  let now = 0, next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = { set: (fn, ms) => { const id = next++; queue.set(id, { at: now + ms, fn }); return id; }, clear: (id) => { queue.delete(id as number); } };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...queue.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      queue.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance, pending: () => queue.size };
}

type Session = { ev: EngineEvents; lang: string; stops: number; aborts: number };
function fakeEngine(opts: { restarts?: boolean; finishMs?: number; throws?: boolean } = {}) {
  const sessions: Session[] = [];
  const engine: DictationEngine = {
    kind: "browser",
    restarts: opts.restarts ?? true,
    finishMs: opts.finishMs,
    start(lang, ev) {
      if (opts.throws) throw Object.assign(new Error("nope"), { name: "InvalidStateError" });
      const s: Session = { ev, lang, stops: 0, aborts: 0 };
      sessions.push(s);
      return { stop: () => { s.stops += 1; }, abort: () => { s.aborts += 1; } };
    },
  };
  return { engine, sessions };
}

function setup(opts: Parameters<typeof fakeEngine>[0] = {}, extra: Partial<ConstructorParameters<typeof Dictation>[1]> = {}) {
  const { engine, sessions } = fakeEngine(opts);
  const c = clock();
  const texts: Array<[string, boolean]> = [];
  const states: DictationState[] = [];
  const errors: string[] = [];
  const d = new Dictation(engine, { lang: "cs-CZ", timers: c.timers, onText: (t, f) => texts.push([t, f]), onState: (s) => states.push(s), onError: (e) => errors.push(e), ...extra });
  return { d, sessions, c, texts, states, errors, last: () => sessions[sessions.length - 1] };
}

describe("the dictation state machine", () => {
  it("start → listening → text → stop: the last words still come, then idle", () => {
    const { d, sessions, texts, states, last } = setup();
    expect(d.start()).toBe(true);
    expect(d.state).toBe("starting");
    expect(last().lang).toBe("cs-CZ");
    last().ev.start();
    expect(d.state).toBe("listening");
    last().ev.partial("ahoj");
    last().ev.final("ahoj jak");
    d.toggle(); // the same button again
    expect(d.state).toBe("stopping");
    expect(last().stops).toBe(1);
    last().ev.final("se máš");
    last().ev.end();
    expect(d.state).toBe("idle");
    expect(texts).toEqual([["ahoj", false], ["ahoj jak", true], ["se máš", true]]);
    expect(states).toEqual(["starting", "listening", "stopping", "idle"]);
    expect(sessions).toHaveLength(1);
    expect(d.start()).toBe(true); // and it can start again
  });

  it("a stop always ends it: an engine that never ends is aborted after finishMs, its late events are ignored", () => {
    const { d, c, texts, last } = setup({}, { finishMs: 1500 });
    d.start();
    const s = last();
    s.ev.start();
    d.stop();
    c.advance(1499);
    expect(d.state).toBe("stopping");
    c.advance(1);
    expect(d.state).toBe("idle");
    expect(s.aborts).toBe(1);
    s.ev.final("too late");
    s.ev.end();
    expect(texts).toEqual([]);
    expect(d.state).toBe("idle");
  });

  it("keeps listening after a pause (the engine ends by itself) and starts again", () => {
    const { d, sessions, c, states, last } = setup();
    d.start();
    last().ev.start();
    last().ev.final("one");
    last().ev.end();
    expect(d.state).toBe("restarting");
    c.advance(250);
    expect(sessions).toHaveLength(2);
    expect(d.state).toBe("starting");
    last().ev.start();
    expect(d.state).toBe("listening");
    expect(states).toEqual(["starting", "listening", "restarting", "starting", "listening"]);
  });

  it("stop between two sessions: nothing more starts, it is idle at once", () => {
    const { d, sessions, c, last } = setup();
    d.start();
    last().ev.start();
    last().ev.end();
    expect(d.state).toBe("restarting");
    d.stop();
    expect(d.state).toBe("idle");
    c.advance(10_000);
    expect(sessions).toHaveLength(1);
    expect(c.pending()).toBe(0);
  });

  it("a late end of an old session does not touch the new one", () => {
    const { d, c, sessions, texts } = setup();
    d.start();
    const first = sessions[0];
    first.ev.start();
    first.ev.end();
    c.advance(250);
    const second = sessions[1];
    second.ev.start();
    first.ev.end();
    first.ev.final("ghost");
    expect(d.state).toBe("listening");
    expect(texts).toEqual([]);
    d.stop();
    expect(second.stops).toBe(1);
    second.ev.end();
    expect(d.state).toBe("idle");
  });

  it("a fatal error (no permission) stops it for good and says so; a network hiccup is reported and it goes on", () => {
    const a = setup();
    a.d.start();
    a.last().ev.error("not-allowed");
    expect(a.d.state).toBe("idle");
    expect(a.errors).toEqual(["not-allowed"]);
    expect(a.last().aborts).toBe(1);
    a.c.advance(5000);
    expect(a.sessions).toHaveLength(1);

    const b = setup();
    b.d.start();
    b.last().ev.start();
    b.last().ev.error("network");
    b.last().ev.error("no-speech");
    b.last().ev.end();
    expect(b.errors).toEqual(["network"]);
    b.c.advance(250);
    expect(b.sessions).toHaveLength(2);
    for (const code of ["not-allowed", "audio-capture", "service-not-allowed", "language-not-supported"]) expect(FATAL_DICTATION_ERRORS.has(code)).toBe(true);
  });

  it("gives up after ending again and again with nothing heard", () => {
    const { d, c, errors, sessions, last } = setup({}, { maxIdleRestarts: 2 });
    d.start();
    for (let i = 0; i < 3; i++) { last().ev.start(); last().ev.end(); c.advance(250); }
    expect(d.state).toBe("idle");
    expect(errors).toEqual(["ended"]);
    expect(sessions).toHaveLength(3);
  });

  it("heard words reset the count; an engine that does not restart ends with the session", () => {
    const { d, c, errors, last } = setup({}, { maxIdleRestarts: 1 });
    d.start();
    for (let i = 0; i < 4; i++) { last().ev.start(); last().ev.final(`w${i}`); last().ev.end(); c.advance(250); }
    expect(d.state).toBe("starting");
    expect(errors).toEqual([]);

    const s = setup({ restarts: false });
    s.d.start();
    s.last().ev.start();
    s.last().ev.end();
    expect(s.d.state).toBe("idle");
  });

  it("abort: idle at once, the engine aborted, nothing more arrives", () => {
    const { d, texts, last } = setup();
    d.start();
    last().ev.start();
    d.abort();
    expect(d.state).toBe("idle");
    expect(last().aborts).toBe(1);
    last().ev.final("x");
    expect(texts).toEqual([]);
  });

  it("an engine that cannot start: idle, and why", () => {
    const { d, errors, states } = setup({ throws: true });
    expect(d.start()).toBe(false);
    expect(d.state).toBe("idle");
    expect(errors).toEqual(["unsupported"]);
    expect(states).toEqual(["starting", "idle"]);
  });
});

describe("the dictated text in the field", () => {
  it("keeps what was there, replaces the partial piece, keeps the finished ones", () => {
    const t = new DictatedText("Hi");
    expect(t.add("how", false)).toBe("Hi how");
    expect(t.add("how are", false)).toBe("Hi how are");
    expect(t.add("how are you", true)).toBe("Hi how are you ");
    expect(t.add("fine", false)).toBe("Hi how are you fine");
    expect(t.finished).toBe("Hi how are you");
    expect(new DictatedText("").add("ahoj", true)).toBe("ahoj ");
    expect(dictationLang("cs")).toBe("cs-CZ");
    expect(dictationLang("de")).toBe("de-DE");
  });
});

/* ------------------------------------------------------------- engines */

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = ""; interimResults = false; continuous = false; maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  calls: string[] = [];
  constructor() { FakeRecognition.last = this; }
  start() { this.calls.push("start"); }
  stop() { this.calls.push("stop"); }
  abort() { this.calls.push("abort"); }
  results(list: Array<[string, boolean]>, index = 0) {
    this.onresult?.({ resultIndex: index, results: list.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal })) });
  }
}

describe("the browser's recogniser", () => {
  it("is used when the browser has one, listens continuously with partial results, and stops / aborts it", () => {
    expect(browserEngine({})).toBeNull();
    const engine = browserEngine({ webkitSpeechRecognition: FakeRecognition })!;
    expect(engine.kind).toBe("browser");
    const c = clock();
    const texts: Array<[string, boolean]> = [];
    const d = new Dictation(engine, { lang: "de-DE", timers: c.timers, onText: (t, f) => texts.push([t, f]) });
    d.start();
    const rec = FakeRecognition.last!;
    expect(rec).toMatchObject({ lang: "de-DE", continuous: true, interimResults: true, calls: ["start"] });
    rec.onstart?.();
    expect(d.state).toBe("listening");
    rec.results([["Hallo", true], ["wie ge", false]]);
    rec.results([["Hallo", true], ["wie geht's", true], ["dir", false]], 1);
    d.stop();
    expect(rec.calls).toEqual(["start", "stop"]);
    rec.results([["Hallo", true], ["wie geht's", true], ["dir", true]], 2);
    rec.onend?.();
    expect(d.state).toBe("idle");
    expect(texts).toEqual([["Hallo", true], ["wie ge", false], ["wie geht's", true], ["dir", false], ["dir", true]]);
    // An error event is passed on; abort aborts.
    d.start();
    const again = FakeRecognition.last!;
    again.onerror?.({ error: "not-allowed" });
    expect(again.calls).toEqual(["start", "abort"]);
    expect(d.state).toBe("idle");
  });
});

class FakeTrack { stopped = 0; stop() { this.stopped += 1; } }
class FakeRecorder {
  static last: FakeRecorder | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown) { FakeRecorder.last = this; }
  start() { this.state = "recording"; }
  stop() { if (this.state === "inactive") return; this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["pcm"], { type: "audio/webm" }) }); this.onstop?.(); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the server's transcription", () => {
  function server(answer: { ok: true; text: string } | { ok: false; message: string } = { ok: true, text: "dobrý den" }) {
    const track = new FakeTrack();
    const sent: Blob[] = [];
    const engine = serverEngine({
      open: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
      transcribe: async (b) => { sent.push(b); return answer; },
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    return { engine, track, sent };
  }

  it("records until stop, sends it, gives the text, lets go of the microphone", async () => {
    const { engine, track, sent } = server();
    expect(engine.restarts).toBe(false);
    const texts: Array<[string, boolean]> = [];
    const d = new Dictation(engine, { lang: "cs-CZ", onText: (t, f) => texts.push([t, f]) });
    d.start();
    await flush();
    expect(d.state).toBe("listening");
    expect(FakeRecorder.last!.state).toBe("recording");
    d.stop();
    expect(d.state).toBe("stopping");
    await flush();
    await flush();
    expect(sent).toHaveLength(1);
    expect(texts).toEqual([["dobrý den", true]]);
    expect(d.state).toBe("idle");
    expect(track.stopped).toBeGreaterThan(0);
  });

  it("a stop before the microphone opened still stops; abort drops the recording unsent", async () => {
    const a = server();
    const d = new Dictation(a.engine, { lang: "cs-CZ" });
    d.start();
    d.stop(); // before open() resolved
    await flush();
    await flush();
    await flush();
    expect(d.state).toBe("idle");
    expect(a.track.stopped).toBeGreaterThan(0);

    const b = server();
    const e = new Dictation(b.engine, { lang: "cs-CZ" });
    e.start();
    await flush();
    e.abort();
    await flush();
    expect(e.state).toBe("idle");
    expect(b.sent).toHaveLength(0);
    expect(b.track.stopped).toBeGreaterThan(0);
  });

  it("a failed transcription is said", async () => {
    const { engine } = server({ ok: false, message: "503" });
    const errors: string[] = [];
    const d = new Dictation(engine, { lang: "cs-CZ", onError: (e) => errors.push(e) });
    d.start();
    await flush();
    d.stop();
    await flush();
    await flush();
    expect(errors).toEqual(["transcription"]);
    expect(d.state).toBe("idle");
  });
});
