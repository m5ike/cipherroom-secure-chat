// The one place that hands out the microphone (6.7, client/src/lib/mic.ts):
// raw when the voice changer is off (or the operator's module is), through
// the AudioWorklet graph when it is on; presets reach the running graph live;
// stopping the processed track stops the microphone and closes the graph;
// anything failing hands out the raw microphone instead of nothing.
// WebAudio and getUserMedia are pretend ones here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isProcessed, lastFallback, openGraphs, openMic, processStream, releaseMic, setMicEnvForTests, setVoiceFxAllowed, voiceFxActive, activeFxParams } from "../client/src/lib/mic";
import { resetVoiceFxForTests, setVoiceFx } from "../client/src/lib/voice-fx-settings";
import { NEUTRAL_FX, VOICE_FX_PRESETS } from "../client/src/lib/voice-fx";

class Track {
  readyState: "live" | "ended" = "live";
  enabled = true;
  stopped = 0;
  private ended: Array<() => void> = [];
  constructor(public kind: "audio" | "video", public label = kind) {}
  stop() { this.stopped += 1; this.readyState = "ended"; }
  addEventListener(type: string, fn: () => void) { if (type === "ended") this.ended.push(fn); }
  end() { this.readyState = "ended"; this.ended.forEach((f) => f()); }
}
class Stream {
  constructor(public tracks: Track[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
}
class Node {
  messages: unknown[] = [];
  connected: unknown[] = [];
  disconnected = 0;
  port = { postMessage: (m: unknown) => { this.messages.push(m); } };
  constructor(public params: unknown) {}
  connect(to: unknown) { this.connected.push(to); return to; }
  disconnect() { this.disconnected += 1; }
}
class Ctx {
  static made: Ctx[] = [];
  state = "suspended";
  closed = 0;
  modules: string[] = [];
  out = new Track("audio", "processed");
  failModule = false;
  audioWorklet = { addModule: async (url: string) => { if (this.failModule) throw new Error("no worklet"); this.modules.push(url); } };
  constructor() { Ctx.made.push(this); }
  async resume() { this.state = "running"; }
  async close() { this.closed += 1; this.state = "closed"; }
  createMediaStreamSource(s: Stream) { return { stream: s, connect: (n: Node) => n }; }
  createMediaStreamDestination() { return { stream: new Stream([this.out]) }; }
}

let gum: Array<MediaStreamConstraints> = [];
let nodes: Node[] = [];
let failGum: Error | null = null;
let failNextModule = false;
let graphsBefore = 0;

beforeEach(() => {
  resetVoiceFxForTests();
  try { localStorage.clear(); } catch { /* none */ }
  Ctx.made = [];
  gum = [];
  nodes = [];
  failGum = null;
  failNextModule = false;
  // A browser with AudioWorklet (what voiceFxSupported() looks for).
  vi.stubGlobal("AudioContext", class { get audioWorklet() { return {}; } });
  vi.stubGlobal("AudioWorkletNode", class {});
  setMicEnvForTests({
    getUserMedia: async (c) => {
      gum.push(c);
      if (failGum) throw failGum;
      return new Stream([new Track("audio", "mic"), ...(c.video ? [new Track("video", "cam")] : [])]) as unknown as MediaStream;
    },
    createContext: () => { const c = new Ctx(); if (failNextModule) c.failModule = true; return c as unknown as AudioContext; },
    createNode: (_ctx, params) => { const n = new Node(params); nodes.push(n); return n as unknown as AudioWorkletNode; },
    workletUrl: async () => "/assets/voice-fx.worklet.js",
    makeStream: (tracks) => new Stream(tracks as unknown as Track[]) as unknown as MediaStream,
  });
  setVoiceFxAllowed(false);
  graphsBefore = openGraphs();
});
afterEach(() => {
  graphsBefore = 0;
  setMicEnvForTests(null);
  vi.unstubAllGlobals();
});

const audioOf = (s: MediaStream) => s.getAudioTracks()[0] as unknown as Track;

describe("openMic", () => {
  it("hands out the raw microphone while the operator's module is off, whatever the user chose", async () => {
    setVoiceFx({ on: true });
    const s = await openMic({ audio: true });
    expect(audioOf(s).label).toBe("mic");
    expect(isProcessed(s)).toBe(false);
    expect(Ctx.made).toHaveLength(0);
    expect(voiceFxActive()).toBe(false);
    expect(activeFxParams()).toEqual(NEUTRAL_FX);
  });

  it("hands out the raw microphone while the user has it off", async () => {
    setVoiceFxAllowed(true);
    const s = await openMic();
    expect(isProcessed(s)).toBe(false);
    expect(Ctx.made).toHaveLength(0);
  });

  it("module on + switched on: the processed track, the video kept, the preset in the worklet", async () => {
    setVoiceFxAllowed(true);
    setVoiceFx({ on: true, preset: "deep" });
    const s = await openMic({ audio: true, video: true });
    expect(isProcessed(s)).toBe(true);
    expect(audioOf(s).label).toBe("processed");
    expect((s.getVideoTracks()[0] as unknown as Track).label).toBe("cam");
    expect(Ctx.made[0].modules).toEqual(["/assets/voice-fx.worklet.js"]);
    expect(Ctx.made[0].state).toBe("running");
    expect(nodes[0].params).toEqual(VOICE_FX_PRESETS.deep);
    expect(openGraphs()).toBe(graphsBefore + 1);
    releaseMic(s);
  });

  it("a preset chosen later reaches the running graph; switched off it becomes transparent (no new track)", async () => {
    setVoiceFxAllowed(true);
    setVoiceFx({ on: true, preset: "deep" });
    const s = await openMic();
    setVoiceFx({ preset: "robot" });
    expect(nodes[0].messages.at(-1)).toEqual({ params: VOICE_FX_PRESETS.robot });
    setVoiceFx({ on: false });
    expect(nodes[0].messages.at(-1)).toEqual({ params: NEUTRAL_FX });
    setVoiceFxAllowed(false);
    expect(nodes[0].messages.at(-1)).toEqual({ params: NEUTRAL_FX });
    releaseMic(s);
  });

  it("stopping the processed track (what every caller does) stops the microphone and closes the graph", async () => {
    setVoiceFxAllowed(true);
    setVoiceFx({ on: true });
    const s = await openMic();
    const raw = (Ctx.made[0].createMediaStreamSource as unknown) && gum.length;
    expect(raw).toBe(1);
    s.getTracks().forEach((t) => t.stop());
    expect(Ctx.made[0].closed).toBe(1);
    expect(nodes[0].messages).toContainEqual({ close: true });
    expect(nodes[0].disconnected).toBe(1);
    expect(openGraphs()).toBe(graphsBefore);
    // The raw microphone track was stopped too.
    expect(Ctx.made[0].out.stopped).toBe(1);
  });

  it("the microphone going away (unplugged) ends the processed track", async () => {
    setVoiceFxAllowed(true);
    setVoiceFx({ on: true });
    let mic!: Track;
    setMicEnvForTests({
      getUserMedia: async () => { mic = new Track("audio", "mic"); return new Stream([mic]) as unknown as MediaStream; },
      createContext: () => new Ctx() as unknown as AudioContext,
      createNode: (_c, p) => { const n = new Node(p); nodes.push(n); return n as unknown as AudioWorkletNode; },
      workletUrl: async () => "/w.js",
      makeStream: (tracks) => new Stream(tracks as unknown as Track[]) as unknown as MediaStream,
    });
    const s = await openMic();
    mic.end();
    expect(audioOf(s).stopped).toBe(1);
    expect(openGraphs()).toBe(graphsBefore);
  });

  it("no worklet: the raw microphone, and why (the call still works)", async () => {
    setVoiceFxAllowed(true);
    setVoiceFx({ on: true });
    failNextModule = true;
    const s = await openMic();
    expect(isProcessed(s)).toBe(false);
    expect(audioOf(s).label).toBe("mic");
    expect(lastFallback()).toBe("no worklet");
    expect(Ctx.made[0].closed).toBe(1);
  });

  it("no permission: the error comes through and the audio context is closed", async () => {
    setVoiceFxAllowed(true);
    setVoiceFx({ on: true });
    failGum = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    await expect(openMic()).rejects.toThrow("denied");
    expect(Ctx.made[0].closed).toBe(1);
  });

  it("a running call switches over: the same capture through the graph, no second permission prompt", async () => {
    setVoiceFxAllowed(true);
    const raw = await openMic();
    expect(isProcessed(raw)).toBe(false);
    setVoiceFx({ on: true, preset: "echo" });
    const next = await processStream(raw);
    expect(isProcessed(next)).toBe(true);
    expect(gum).toHaveLength(1);
    expect(nodes[0].params).toEqual(VOICE_FX_PRESETS.echo);
    expect(await processStream(next)).toBe(next); // already processed
    releaseMic(next);
    expect(audioOf(raw).stopped).toBe(1);
  });
});
