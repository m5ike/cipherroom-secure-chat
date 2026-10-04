// One place that hands out the microphone (6.7). Every part of the app that
// listens — calls (WebRTC), voice messages (MediaRecorder), the phone bridge,
// dictation that records for the server, the voice changer's own test — asks
// here instead of calling getUserMedia, so when the voice changer is on (the
// operator's "voiceChanger" module AND the user's switch) the audio first
// passes the effect chain (voice-fx.ts in an AudioWorklet, on this device)
// and only the changed voice goes on. Nothing here sends anything anywhere.
//
// A processed stream holds the raw capture inside: stopping its audio track
// (what every caller already does) stops the microphone and closes the
// graph. Presets change live (the worklet gets the new parameters); turning
// the switch off mid-call makes the chain transparent (same delay, no gap).
// Without AudioWorklet, or when the graph cannot start, the raw microphone is
// handed out and lastFallback() says why — the call still works.

import { NEUTRAL_FX, type VoiceFxParams } from "./voice-fx";
import { getVoiceFx, onVoiceFxChange, settingsParams } from "./voice-fx-settings";

/* ------------------------------------------------------------ the gate */

let allowed = false;

/** The operator's module (App.tsx sets it from the client configuration and the user's groups). */
export function setVoiceFxAllowed(on: boolean): void {
  if (allowed === on) return;
  allowed = on;
  pushParams();
}

export function voiceFxAllowed(): boolean { return allowed; }

/** The module is on and the user switched it on. */
export function voiceFxActive(): boolean { return allowed && getVoiceFx().on; }

/** What the chain should do now (transparent when it is off). */
export function activeFxParams(): VoiceFxParams {
  return voiceFxActive() ? settingsParams(getVoiceFx()) : { ...NEUTRAL_FX };
}

export function voiceFxSupported(): boolean {
  if (typeof window === "undefined" || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") return false;
  return "audioWorklet" in AudioContext.prototype;
}

export function micAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/* ------------------------------------------------------------- the env */

/** What the browser gives (tests put fakes in). */
export type MicEnv = {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  createContext: () => AudioContext;
  createNode: (ctx: AudioContext, params: VoiceFxParams) => AudioWorkletNode;
  workletUrl: () => Promise<string>;
  makeStream: (tracks: MediaStreamTrack[]) => MediaStream;
};

function defaultEnv(): MicEnv {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createContext: () => new AudioContext({ latencyHint: "interactive" }),
    createNode: (ctx, params) => new AudioWorkletNode(ctx, "m5-voice-fx", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { params } }),
    workletUrl: async () => (await import("./voice-fx.worklet.ts?worker&url")).default,
    makeStream: (tracks) => new MediaStream(tracks),
  };
}

let env: MicEnv = defaultEnv();

export function setMicEnvForTests(e: Partial<MicEnv> | null): void {
  env = e ? { ...defaultEnv(), ...e } : defaultEnv();
}

/* ------------------------------------------------------------ the graphs */

type Graph = { ctx: AudioContext; node: AudioWorkletNode; raw: MediaStreamTrack; out: MediaStreamTrack; done: boolean };

const graphs = new Set<Graph>();
const processed = new WeakMap<MediaStream, Graph>();
let fallback: string | null = null;

/** Why the last stream went out unchanged although the voice changer was on (null: it did not). */
export function lastFallback(): string | null { return fallback; }

/** How many processed microphones are open (the panel shows it; tests count it). */
export function openGraphs(): number { return graphs.size; }

export function isProcessed(stream: MediaStream | null | undefined): boolean {
  return Boolean(stream && processed.has(stream));
}

function pushParams(): void {
  const params = activeFxParams();
  for (const g of graphs) { try { g.node.port.postMessage({ params }); } catch { /* closed */ } }
}

onVoiceFxChange(() => pushParams());

function teardown(g: Graph, stopRaw = true): void {
  if (g.done) return;
  g.done = true;
  graphs.delete(g);
  try { g.node.port.postMessage({ close: true }); } catch { /* closed */ }
  try { g.node.disconnect(); } catch { /* not connected */ }
  void g.ctx.close().catch(() => undefined);
  if (stopRaw) g.raw.stop();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A microphone (and any video asked for) — through the voice changer when
 * it is on. Throws what getUserMedia throws (no permission, no device).
 */
export async function openMic(constraints: MediaStreamConstraints = { audio: true }): Promise<MediaStream> {
  // The audio context is made before the permission prompt, while the tap still counts as a gesture.
  let ctx: AudioContext | null = null;
  if (constraints.audio && voiceFxActive() && voiceFxSupported()) {
    try { ctx = env.createContext(); } catch (err) { fallback = (err as Error).message; }
  }
  let raw: MediaStream;
  try {
    raw = await env.getUserMedia(constraints);
  } catch (err) {
    void ctx?.close().catch(() => undefined);
    throw err;
  }
  return ctx ? processStream(raw, ctx) : raw;
}

/**
 * The same capture through the chain: a new stream with the changed audio
 * (and the raw stream's video). openMic uses it, and a running call that
 * switches the voice changer on (App.tsx replaces the sender's track).
 */
export async function processStream(raw: MediaStream, given?: AudioContext): Promise<MediaStream> {
  const track = raw.getAudioTracks()[0];
  if (processed.has(raw) || !track || track.readyState === "ended") {
    void given?.close().catch(() => undefined);
    return raw;
  }
  let ctx: AudioContext | null = given ?? null;
  try {
    ctx ??= env.createContext();
    await ctx.audioWorklet.addModule(await env.workletUrl());
    if (ctx.state !== "running") await Promise.race([ctx.resume(), sleep(1500)]);
    if (ctx.state !== "running") throw new Error("the audio context did not start");
    const source = ctx.createMediaStreamSource(env.makeStream([track]));
    const node = env.createNode(ctx, activeFxParams());
    const dest = ctx.createMediaStreamDestination();
    source.connect(node);
    node.connect(dest);
    const out = dest.stream.getAudioTracks()[0];
    if (!out) throw new Error("no processed track");
    const graph: Graph = { ctx, node, raw: track, out, done: false };
    // Stopping the processed track (every caller does) stops the microphone too.
    const stop = out.stop.bind(out);
    out.stop = () => { stop(); teardown(graph); };
    // The microphone went away (unplugged, revoked): so does the processed track.
    track.addEventListener("ended", () => { stop(); teardown(graph, false); }, { once: true });
    graphs.add(graph);
    const stream = env.makeStream([out, ...raw.getVideoTracks()]);
    processed.set(stream, graph);
    fallback = null;
    return stream;
  } catch (err) {
    fallback = (err as Error).message || String(err);
    void ctx?.close().catch(() => undefined);
    return raw;
  }
}

/** Stops every track of a stream (the processed ones close their graph and the microphone). */
export function releaseMic(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}
