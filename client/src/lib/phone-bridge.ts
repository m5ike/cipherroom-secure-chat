// The phone bridge in the browser (6.0): someone called a number a function
// lent (m5.telephony.did) and typed the code — the server offers the call to
// this member ("phone-bridge" frames on the signaling socket). Taken as
// audio, the call's sound plays here and the microphone goes back; taken as
// text, the server transcribes the caller and speaks the replies written
// here. Both travel over one WebSocket, /media/tel/client/<token>:
//   binary  16-bit little-endian PCM, 16 kHz mono, both ways
//   text    JSON: { type: "audio" | "text-mode" | "say" | "hangup" } up,
//           { type: "hello" | "transcript" | "ended" | "error" } down
//
// This is not the room's end-to-end encrypted audio: the phone network
// carries it, and the server bridges it (the panel says so).
//
// 6.9 (route_audio): a TSA routes a call by a route code — to one member
// ("user", like the bridge) or into a whole room ("room"): every member gets
// the card, those who join hear the caller and each other (the server mixes),
// the rest see a slim "phone call in the room" notice. The same frames carry
// `route` and `members`; "status" updates how many are in the call and
// whether the server went over to text. Up, "leave" takes this member out of
// the audio (the call goes on), "hangup" ends the routed audio for everyone;
// down, "roster" says how many are in.

import { openMic } from "./mic";

export const BRIDGE_RATE = 16_000;

/** 6.9: "ignored" — a routed call the member did not join (or left): a slim notice, Join still there. */
export type PhoneCallState = "ringing" | "connecting" | "audio" | "text" | "ignored" | "ended";

export type PhoneCall = {
  session: string;
  token: string;
  number: string;
  from: string;
  label: string;
  mode: "auto" | "audio" | "text";
  state: PhoneCallState;
  transcripts: Array<{ text: string; at: number; mine: boolean }>;
  startedAt: number;
  reason: string;
  muted: boolean;
  /** 6.9: routed by a TSA's route code — into the room, or to this member; "" = the 6.0 bridge. */
  route: "" | "room" | "user";
  /** 6.9: members in the call's audio now. */
  members: number;
  /** 6.9: the audio level here (what is heard or said), 0 … 5 bars. */
  level: number;
  /** 6.9: the signaling socket the call was offered on (a background room's may be another server's). */
  socketUrl?: string;
};

const routeOf = (v: unknown): PhoneCall["route"] => (v === "room" || v === "user" ? v : "");
const countOf = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : fallback);

/** A "phone-bridge" frame → a call (or an update of one). */
export function callFromFrame(frame: Record<string, unknown>, prev?: PhoneCall): PhoneCall | null {
  const session = typeof frame.session === "string" ? frame.session : "";
  if (!session) return null;
  if (frame.event === "incoming") {
    return {
      session, token: String(frame.token ?? ""), number: String(frame.number ?? ""), from: String(frame.from ?? ""),
      label: String(frame.label ?? ""), mode: frame.mode === "audio" || frame.mode === "text" ? frame.mode : "auto",
      state: frame.channel === "text" ? "text" : "ringing", transcripts: [], startedAt: Date.now(), reason: "", muted: false,
      route: routeOf(frame.route), members: countOf(frame.members, 0), level: 0,
    };
  }
  if (!prev) return null;
  if (frame.event === "ended") return { ...prev, state: "ended", reason: String(frame.reason ?? ""), level: 0 };
  if (frame.event === "status") {
    // The server went over to text (nobody took the audio): the card offers the written reply.
    const state = frame.channel === "text" && prev.state === "ringing" ? "text" : prev.state;
    return { ...prev, state, members: countOf(frame.members, prev.members) };
  }
  if (frame.event === "transcript" && typeof frame.text === "string") return { ...prev, transcripts: [...prev.transcripts, { text: frame.text, at: Date.now(), mine: false }].slice(-50) };
  return prev;
}

/** 32-bit float samples at `from` Hz → 16-bit PCM at `to` Hz (linear; the browser's rate is 44.1 or 48 kHz). */
export function downsample(input: Float32Array, from: number, to: number): Int16Array {
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    // Average the samples this one covers (a cheap low-pass), then scale.
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const v = end > start ? sum / (end - start) : input[start] ?? 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

/** The level of float samples as 0 … 5 bars (RMS on a dB scale, -50 … -10 dBFS). */
export function levelBars(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sq = 0;
  for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
  const db = 20 * Math.log10(Math.sqrt(sq / samples.length) || 1e-9);
  return Math.max(0, Math.min(5, Math.round((db + 50) / 8)));
}

/** 16-bit little-endian PCM bytes → float samples. */
export function pcmToFloat(bytes: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes);
  const out = new Float32Array(new ArrayBuffer(Math.floor(bytes.byteLength / 2) * 4));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** The media socket's URL, from the signaling socket's (the same server). */
export function bridgeUrl(signalingUrl: string, token: string): string {
  const u = new URL(signalingUrl);
  return `${u.protocol}//${u.host}/media/tel/client/${encodeURIComponent(token)}`;
}

type Handlers = {
  onTranscript: (text: string) => void;
  onEnded: (reason: string) => void;
  onError: (message: string) => void;
  /** 6.9: how many are in a routed call's audio. */
  onMembers?: (members: number) => void;
  /** 6.9: the level here, 0 … 5 bars (a few times a second while in the audio). */
  onLevel?: (bars: number) => void;
};

const LEVEL_EVERY_MS = 150;

/** One call taken in this browser: the socket, and in audio mode the microphone and the speaker. */
export class PhoneBridgeClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private playAt = 0;
  private heard = 0;
  private said = 0;
  private levelAt = 0;
  private lastLevel = -1;
  muted = false;

  constructor(private readonly url: string, private readonly h: Handlers) {}

  private open(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return Promise.resolve(this.ws);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("the phone bridge is not reachable"));
      ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.stopAudio(); } };
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) { this.play(ev.data); return; }
        let m: { type?: string; text?: string; reason?: string; message?: string; members?: number } = {};
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.type === "roster" && typeof m.members === "number") this.h.onMembers?.(m.members);
        else if (m.type === "transcript" && m.text) this.h.onTranscript(m.text);
        else if (m.type === "ended") { this.h.onEnded(m.reason ?? ""); this.close(); }
        else if (m.type === "error") this.h.onError(m.message ?? "error");
      };
      this.ws = ws;
    });
  }

  /** Takes the call as audio: the caller plays here, the microphone goes to them. */
  async takeAudio(): Promise<void> {
    const ws = await this.open();
    // 6.7: mic.ts — through the voice changer when it is on.
    this.mic = await openMic({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.mic);
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    const rate = this.ctx.sampleRate;
    this.node.onaudioprocess = (e) => {
      if (this.muted || ws.readyState !== WebSocket.OPEN) { this.said = 0; return; }
      const input = e.inputBuffer.getChannelData(0);
      this.said = levelBars(input);
      this.meter();
      const pcm = downsample(input, rate, BRIDGE_RATE);
      ws.send(pcm.buffer as ArrayBuffer);
    };
    source.connect(this.node);
    // A ScriptProcessor runs only when connected to the output (it writes silence there).
    this.node.connect(this.ctx.destination);
    ws.send(JSON.stringify({ type: "audio" }));
  }

  /** Takes the call as text: the server transcribes the caller and speaks the replies. */
  async takeText(): Promise<void> {
    const ws = await this.open();
    ws.send(JSON.stringify({ type: "text-mode" }));
  }

  /** A written reply, spoken to the caller. */
  async say(text: string): Promise<void> {
    const ws = await this.open();
    ws.send(JSON.stringify({ type: "say", text: text.slice(0, 1000) }));
  }

  hangup(): void {
    try { this.ws?.send(JSON.stringify({ type: "hangup" })); } catch { /* closing */ }
    this.close();
  }

  /** 6.9: out of a routed call's audio — the call goes on for the others (Join again reopens it). */
  leave(): void {
    try { this.ws?.send(JSON.stringify({ type: "leave" })); } catch { /* closing */ }
    this.close();
  }

  /** The louder of what is heard and what is said, a few times a second, only when it changes. */
  private meter(): void {
    const now = Date.now();
    if (now - this.levelAt < LEVEL_EVERY_MS) return;
    this.levelAt = now;
    const bars = Math.max(this.heard, this.muted ? 0 : this.said);
    if (bars !== this.lastLevel) { this.lastLevel = bars; this.h.onLevel?.(bars); }
  }

  private play(bytes: ArrayBuffer): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const samples = pcmToFloat(bytes);
    this.heard = levelBars(samples);
    this.meter();
    const buffer = ctx.createBuffer(1, samples.length, BRIDGE_RATE);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    // A small cushion (80 ms) against the network's jitter.
    const now = ctx.currentTime;
    if (this.playAt < now + 0.02) this.playAt = now + 0.08;
    src.start(this.playAt);
    this.playAt += buffer.duration;
  }

  private stopAudio(): void {
    try { this.node?.disconnect(); } catch { /* gone */ }
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.node = null; this.mic = null; this.ctx = null;
    this.heard = this.said = 0;
    if (this.lastLevel > 0) { this.lastLevel = 0; this.h.onLevel?.(0); }
  }

  close(): void {
    this.stopAudio();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000, "done"); } catch { /* closed */ }
  }
}
