// Route audio (6.9): a TSA's route_audio tool found the caller's code in the
// inroute table (m5.telephony.inroute.add); this connects the call's audio,
// both ways, to what the code names:
//
//   room   every member of the room who joins the call's audio hears the
//          caller and each other; the caller hears all of them mixed
//          (mixer.ts: 20 ms frames at 16 kHz, a jitter buffer per member,
//          sums with a soft limiter, nobody hears themselves). Members who
//          do not join just see the "phone call in the room" card. Members
//          may join and leave at any time — those who connect to the room
//          during the call are offered it too.
//   user   one member — by their name in the room, or "@account" wherever
//          that account is connected — takes the call in the browser (the
//          6.0 bridge's way, without a lent number or a second code).
//
// The provider streams the call over /media/tel/<token> (bridge.ts serves the
// WebSocket path and hands our tokens here): Twilio <Connect><Stream> (JSON,
// µ-law 8 kHz), Telnyx streaming_start (JSON, PCMU 8 kHz), Vonage connect
// websocket (binary 16-bit PCM 16 kHz). Each member's browser has its own
// /media/tel/client/<token>: 16-bit PCM 16 kHz both ways, JSON for control.
//
// Nobody takes the audio (nobody connected, or nobody joins within
// routeLimits.joinSec): mode "fail" → on_failed; mode "text" → speech ↔ chat:
// what the caller says is transcribed (AI & speech) and shown to the room /
// the member, their written replies are spoken back.
//
// The routed audio ends while the call is still up (everyone left, a member
// ended it, the longest time, nobody spoke for a long time) → the TSA is
// resumed with { kind: "route", ok: true } and continues at on_success; its
// next actions are run on the live call. The caller hanging up ends it all.
//
// 6.12 (G-09): a room's audio and a member named by display name reach only
// members who proved they hold the room key when they joined (the hub's join
// proof, signaling/proof.ts › reachable): in a room where at least one member
// proved, the unproven ones are not offered the call; in a room where nobody
// proves (only clients before 6.12) everyone is, as before — unless
// HUB_REQUIRE_ROOM_PROOF=1, then proven members only. "@account" is
// authenticated by the member's session and needs no proof.
//
// Privacy: the room is found on the signaling hub by its blind id (r3.…) —
// the only id a v3 room has there; its name never reaches the server. Only
// the room the code names is ever routed to (an "@account" member found in
// another room gets the call without the caller's number). The log (telLog)
// has the room's hash, counts and durations — never the audio, never what
// was said, never the blind id or a member's name.

import type { RawData } from "ws";
import { WebSocket } from "ws";
import { adapter } from "./providers";
import { FINAL_CALL_STATUSES, type CallAction, type MediaFormat, type ProviderAdapter } from "./providers/types";
import { execute, mediaUrl } from "./engine";
import { telId, telStore, telToken } from "./tel-store";
import { claimMedia } from "./bridge";
import { telHooks, telLog, telPermissions, type RouteAudioResult, type TsaCallRef } from "./control/hooks";
import type { InrouteEntry, TelLogEntry } from "./control/types";
import type { TsaEvent } from "./tsa/types";
import { Framer, Segmenter, StreamResampler, mulawDecode, mulawEncode, pcm16FromLE, pcm16ToLE, resample, rms, tone, wavDecode, wavEncode } from "./audio";
import { MIX_FRAME, MIX_RATE, Mixer } from "./mixer";
import { hashRoom } from "../monitor/traffic";
import { stt, tts, type Caller as AiCaller } from "../ai/service";
import { reachable } from "../signaling/proof";

/** Limits of a routed call (tests shorten them). */
export const routeLimits = {
  /** Members mixed at once. */
  maxMembers: 16,
  /** The first member must join the audio within this (then: mode fail → on_failed, text → text mode). */
  joinSec: 30,
  /** The provider must open its stream within this. */
  streamSec: 20,
  /** Everyone left: this long for somebody to come back before the TSA goes on. */
  leaveGraceSec: 6,
  /** Nobody spoke (audio) / nothing was said or written (text) for this long: the routed audio ends. */
  idleSec: 300,
  textIdleSec: 180,
  /** Membership, the call's state and the timers are checked this often. */
  pollMs: 2_000,
  /** The simulator's routed audio "ends" after this. */
  simulatedMs: 1_500,
};

/** The longest routed audio: the module's permissions (outbound.maxMinutes), 1 – 240 min. */
export const routeMaxSec = (): number => 60 * Math.max(1, Math.min(240, Math.round(telPermissions().outbound.maxMinutes || 30)));

/** A level (RMS, 0 … 1) above this is somebody speaking (-40 dBFS). */
const VOICE_LEVEL = 0.01;
const env = (name: string): string => process.env[name]?.trim() || "";
const language = () => env("TELEPHONY_ROUTE_LANGUAGE") || "cs";

/* ------------------------------------------------------------ the hub */

/** 6.12 `proven`: the member's join proved the room key (signaling/proof.ts); absent = not proven. */
export type RouteMember = { peerId: string; name: string; accountId?: string; proven?: boolean };

/** What routing needs from the signaling hub (main service: routes.ts sets it). */
export type RouteHub = {
  /** The members of a room open here, by the room's id on the hub (the blind id). */
  members(room: string): RouteMember[];
  /** A frame of the server's own to one member. */
  send(room: string, peerId: string, payload: Record<string, unknown>): boolean;
  /** Where an account is connected here (room ids as the hub keys them). */
  accountMembers(accountId: string): Array<{ room: string; peerId: string; name: string }>;
};
let hub: RouteHub | null = null;
export function setRouteHub(h: RouteHub | null): void { hub = h; }

/** A v3 room's blind id — the only room id routing accepts (never a name). */
export const BLIND_ROOM_ID = /^r3\.[A-Za-z0-9_-]{16,128}$/;
export const isBlindRoomId = (v: unknown): v is string => typeof v === "string" && BLIND_ROOM_ID.test(v);

/** Who gets the call: a member's connection, and whether it is in the room the code names. */
export type RouteTarget = { room: string; peerId: string; name: string; inRoom: boolean };

/** Who an entry routes to right now. `problem` = it cannot be routed at all; no targets = nobody connected. */
export function routeTargets(entry: Pick<InrouteEntry, "type" | "room" | "user">, h: RouteHub | null): { targets: RouteTarget[]; problem: string } {
  if (!isBlindRoomId(entry.room)) return { targets: [], problem: "the code's room is not a blind room id (r3.…)" };
  if (!h) return { targets: [], problem: "the chat's signaling hub is not in this process" };
  const members = h.members(entry.room);
  // 6.12 (G-09): by room or by display name, only members the server may reach (proven ones once anyone proved).
  const proven = reachable(members);
  const here = (list: RouteMember[]): RouteTarget[] => list.map((m) => ({ room: entry.room, peerId: m.peerId, name: m.name, inRoom: true }));
  if (entry.type === "room") return { targets: here(proven), problem: "" };
  if (entry.type !== "user") return { targets: [], problem: `unknown route type "${String(entry.type)}"` };
  const user = String(entry.user ?? "").trim();
  if (!user) return { targets: [], problem: "the code names no member" };
  if (user.startsWith("@")) {
    const account = user.slice(1).toLowerCase();
    if (!account) return { targets: [], problem: "the code names no account" };
    const inRoom = members.filter((m) => m.accountId?.toLowerCase() === account);
    if (inRoom.length) return { targets: here(inRoom), problem: "" };
    // Elsewhere: only rooms with a blind id (a v2 room's id would be its name).
    return { targets: h.accountMembers(account).filter((m) => isBlindRoomId(m.room)).map((m) => ({ ...m, inRoom: m.room === entry.room })), problem: "" };
  }
  const name = user.toLowerCase();
  return { targets: here(proven.filter((m) => m.name.toLowerCase() === name)), problem: "" };
}

export type RouteDecision =
  | { ok: true; targets: RouteTarget[]; textOnly: boolean; detail: string }
  | { ok: false; reason: "code" | "failed"; detail: string };

/** Can this entry be routed now, and to whom (pure over the hub). */
export function decideRoute(entry: InrouteEntry, mode: "fail" | "text", h: RouteHub | null, now = Date.now()): RouteDecision {
  if (!entry || (entry.type !== "room" && entry.type !== "user")) return { ok: false, reason: "code", detail: "not a route code" };
  if (entry.expiresAt && entry.expiresAt <= now) return { ok: false, reason: "code", detail: "the code expired" };
  const { targets, problem } = routeTargets(entry, h);
  if (problem) return { ok: false, reason: "failed", detail: problem };
  const what = entry.type === "room" ? `room ${hashRoom(entry.room)}` : `a member of room ${hashRoom(entry.room)}`;
  if (!targets.length) {
    if (mode === "text") return { ok: true, targets, textOnly: true, detail: `${what}: nobody is connected — text mode` };
    return { ok: false, reason: "failed", detail: `${what}: nobody is connected` };
  }
  return { ok: true, targets, textOnly: false, detail: `${what}: ${targets.length} connection${targets.length === 1 ? "" : "s"}` };
}

/* ----------------------------------------------------- provider frames */

export type ProviderFrame = { kind: "start"; streamSid: string } | { kind: "media"; pcm: Int16Array; streamSid: string } | { kind: "stop" } | null;

/** One message of a provider's media stream, as samples at the provider's rate. */
export function parseProviderFrame(fmt: MediaFormat, data: RawData, isBinary: boolean): ProviderFrame {
  if (fmt.transport === "binary-l16") {
    if (isBinary) return { kind: "media", pcm: pcm16FromLE(new Uint8Array(data as Buffer)), streamSid: "" };
    // The first text frame is websocket:connected (with the headers asked for).
    let f: { event?: string } = {};
    try { f = JSON.parse(String(data)); } catch { return null; }
    return f.event === "websocket:connected" || !f.event ? { kind: "start", streamSid: "" } : null;
  }
  if (isBinary) return null;
  let f: { event?: string; streamSid?: string; stream_id?: string; start?: { streamSid?: string }; media?: { payload?: string; track?: string } } = {};
  try { f = JSON.parse(String(data)); } catch { return null; }
  const sid = f.start?.streamSid ?? f.streamSid ?? f.stream_id ?? "";
  if (f.event === "start") return { kind: "start", streamSid: sid };
  if (f.event === "media" && f.media?.payload && (!f.media.track || f.media.track.startsWith("inbound"))) {
    return { kind: "media", pcm: mulawDecode(new Uint8Array(Buffer.from(f.media.payload, "base64"))), streamSid: sid };
  }
  if (f.event === "stop") return { kind: "stop" };
  return null;
}

/** One frame (the provider's rate) as the provider wants it on its stream. */
export function providerMessage(fmt: MediaFormat, streamSid: string, frame: Int16Array): Buffer | string {
  if (fmt.transport === "binary-l16") return Buffer.from(pcm16ToLE(frame));
  const payload = Buffer.from(mulawEncode(frame)).toString("base64");
  return JSON.stringify(fmt.transport === "json-mulaw" ? { event: "media", streamSid, media: { payload } } : { event: "media", media: { payload } });
}

/* --------------------------------------------------------- a routed call */

type Leg = {
  id: string;
  token: string;
  target: RouteTarget;
  ws: WebSocket | null;
  inAudio: boolean;
  joinedAt: number | null;
  audioSec: number;
};

type State = "waiting" | "ringing" | "audio" | "text" | "ended";
type EndHow = "hangup" | "ended" | "failed";

const mask = (code: string) => (code ? `${"•".repeat(Math.max(0, code.length - 1))}${code.slice(-1)}` : "");
/** The ringing tone while nobody has joined yet: 425 Hz, 1 s on, 4 s off (CEPT). */
const RING = tone(425, 1000, MIX_RATE, 0.12);
const RING_PERIOD_MS = 5000;

const routes = new Map<string, RoutedCall>();
const byMediaToken = new Map<string, RoutedCall>();
const byClientToken = new Map<string, { route: RoutedCall; leg: Leg }>();

class RoutedCall {
  readonly id = telId("tr");
  readonly mediaToken = telToken();
  state: State = "waiting";
  done = false;
  private provider: { ws: WebSocket; streamSid: string } | null = null;
  private providerClosing = false;
  readonly legs = new Map<string, Leg>();
  private readonly byPeer = new Map<string, Leg>();
  private readonly mixer = new Mixer();
  private readonly fromCaller: StreamResampler;
  private readonly toCaller: StreamResampler;
  private readonly framer: Framer;
  private segmenter = new Segmenter({ rate: MIX_RATE });
  private sttQueue: Promise<void> = Promise.resolve();
  private clock: ReturnType<typeof setInterval> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private grace: ReturnType<typeof setTimeout> | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private t0 = 0;
  private ticks = 0;
  readonly createdAt = Date.now();
  connectedAt = 0;
  private lastVoiceAt = Date.now();
  readonly stats = { joins: 0, maxInAudio: 0, memberSec: 0, callerSec: 0, heard: 0, replies: 0, textMode: false };
  readonly fmt: MediaFormat;

  constructor(readonly call: TsaCallRef, readonly entry: InrouteEntry, readonly mode: "fail" | "text", readonly sessionId: string, a: ProviderAdapter, targets: RouteTarget[], private readonly textOnly: boolean) {
    this.fmt = a.media!;
    this.fromCaller = new StreamResampler(this.fmt.rate, MIX_RATE);
    this.toCaller = new StreamResampler(MIX_RATE, this.fmt.rate);
    this.framer = new Framer(Math.round(this.fmt.rate / 50));
    for (const t of targets) this.legFor(t);
    routes.set(this.id, this);
    byMediaToken.set(this.mediaToken, this);
    this.poller = setInterval(() => this.poll(), routeLimits.pollMs);
    this.poller.unref?.();
    this.later(routeLimits.streamSec * 1000, () => { if (!this.provider && !this.done) void this.finish("failed", "the provider did not open the call's audio stream"); });
  }

  get inAudio(): Leg[] { return [...this.legs.values()].filter((l) => l.inAudio); }

  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    t.unref?.();
    this.timers.push(t);
    return t;
  }

  private log(kind: "call" | "inroute", summary: string, level: TelLogEntry["level"] = "info", parsed: Record<string, unknown> = {}): void {
    telLog({ kind, level, provider: this.call.provider, direction: this.call.direction, summary, callId: this.call.id, tsaSession: this.sessionId, parsed: { route: this.id, type: this.entry.type, room: hashRoom(this.entry.room), ...parsed } });
  }

  /* ----------------------------------------------------- the members */

  private legFor(t: RouteTarget): Leg {
    const key = `${t.room}|${t.peerId}`;
    let leg = this.byPeer.get(key);
    if (!leg) {
      leg = { id: telId("rl"), token: telToken(), target: t, ws: null, inAudio: false, joinedAt: null, audioSec: 0 };
      this.byPeer.set(key, leg);
      this.legs.set(leg.token, leg);
      byClientToken.set(leg.token, { route: this, leg });
      // Already streaming: a member who connected meanwhile is offered the call now.
      if (this.provider) this.offer(leg);
    }
    return leg;
  }

  private frame(leg: Leg, event: string, extra: Record<string, unknown> = {}): boolean {
    return hub?.send(leg.target.room, leg.target.peerId, {
      type: "phone-bridge", event, session: this.id, number: this.call.did || this.call.to, label: this.entry.label, route: this.entry.type, ...extra,
    }) ?? false;
  }

  /** The "incoming" card for one member (their own media token; the caller's number only in the room the code names). */
  private offer(leg: Leg): void {
    this.frame(leg, "incoming", {
      token: leg.token, from: leg.target.inRoom ? this.call.from : "", mode: "audio", channel: this.state === "text" ? "text" : "audio",
      members: this.inAudio.length, clientRate: MIX_RATE, maxCallSec: routeMaxSec(),
    });
  }

  /** Everyone offered the call hears how many are in it (the card), those in it over their socket too. */
  private roster(): void {
    const members = this.inAudio.length;
    const channel = this.state === "text" ? "text" : "audio";
    for (const leg of this.legs.values()) {
      this.frame(leg, "status", { members, channel });
      if (leg.ws?.readyState === WebSocket.OPEN) leg.ws.send(JSON.stringify({ type: "roster", members, channel }));
    }
  }

  attachLeg(leg: Leg, ws: WebSocket): void {
    if (leg.ws && leg.ws !== ws) { try { leg.ws.close(4009, "taken elsewhere"); } catch { /* gone */ } }
    leg.ws = ws;
    ws.on("message", (data, isBinary) => {
      if (this.done) return;
      if (isBinary) {
        if (!leg.inAudio) return;
        const pcm = pcm16FromLE(new Uint8Array(data as Buffer));
        leg.audioSec += pcm.length / MIX_RATE;
        if (rms(pcm) > VOICE_LEVEL) this.lastVoiceAt = Date.now();
        this.mixer.push(leg.id, pcm);
        return;
      }
      let m: { type?: string; text?: string; wav?: string } = {};
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === "audio") this.join(leg);
      else if (m.type === "leave") this.leave(leg, "left");
      else if (m.type === "hangup" || m.type === "end") {
        this.log("call", "a member ended the routed audio", "notice");
        void this.finish("ended", "a member ended it");
      } else if (m.type === "text-mode") { if (this.state === "ringing" && this.entry.type === "user") this.enterText("the member chose text"); }
      else if (m.type === "say" && m.text) void this.speak(String(m.text).slice(0, 1_000));
      else if (m.type === "wav" && m.wav) { try { this.playWav(Buffer.from(m.wav, "base64")); } catch { /* not a WAV */ } }
    });
    ws.on("close", () => { if (leg.ws === ws) { leg.ws = null; if (leg.inAudio) this.leave(leg, "disconnected"); } });
    ws.send(JSON.stringify({ type: "hello", session: this.id, rate: MIX_RATE, route: this.entry.type, channel: this.state === "text" ? "text" : "audio", members: this.inAudio.length }));
  }

  private join(leg: Leg): void {
    if (leg.inAudio) return;
    if (this.inAudio.length >= routeLimits.maxMembers) {
      leg.ws?.send(JSON.stringify({ type: "error", message: `the call is full (${routeLimits.maxMembers} members)` }));
      return;
    }
    // One member's call: a second device takes it over.
    if (this.entry.type === "user") {
      for (const other of this.inAudio) {
        this.leave(other, "taken elsewhere");
        try { other.ws?.send(JSON.stringify({ type: "ended", reason: "taken elsewhere" })); other.ws?.close(4009, "taken elsewhere"); } catch { /* gone */ }
      }
    }
    leg.inAudio = true;
    leg.joinedAt = Date.now();
    this.mixer.add(leg.id, { target: MIX_FRAME * 4, max: MIX_FRAME * 15 });
    this.mixer.add("caller", { target: MIX_FRAME * 2, max: MIX_FRAME * 10 });
    if (this.grace) { clearTimeout(this.grace); this.grace = null; }
    if (this.joinTimer) { clearTimeout(this.joinTimer); this.joinTimer = null; }
    if (this.state === "ringing" || this.state === "text") {
      this.state = "audio";
      this.mixer.remove("tone");
    }
    this.lastVoiceAt = Date.now();
    this.stats.joins += 1;
    this.stats.maxInAudio = Math.max(this.stats.maxInAudio, this.inAudio.length);
    this.log("call", `a member joined the call's audio (${this.inAudio.length} in)`, "info", { members: this.inAudio.length });
    this.roster();
  }

  private leave(leg: Leg, why: string): void {
    if (!leg.inAudio) return;
    leg.inAudio = false;
    this.mixer.remove(leg.id);
    const sec = leg.joinedAt ? Math.round((Date.now() - leg.joinedAt) / 1000) : 0;
    this.stats.memberSec += sec;
    leg.joinedAt = null;
    if (this.done) return;
    this.log("call", `a member left the call's audio (${why}, ${sec} s; ${this.inAudio.length} in)`, "info", { members: this.inAudio.length, durationSec: sec });
    this.roster();
    if (!this.inAudio.length && this.state === "audio" && !this.grace) {
      this.grace = setTimeout(() => {
        this.grace = null;
        if (!this.inAudio.length && !this.done) void this.finish("ended", "everyone left the call's audio");
      }, routeLimits.leaveGraceSec * 1000);
      this.grace.unref?.();
    }
  }

  /* ----------------------------------------------------- the provider */

  attachProvider(ws: WebSocket): void {
    // One stream per routed call: a second connection with the same token is refused.
    if (this.provider || this.providerClosing) { try { ws.close(1008, "already streaming"); } catch { /* gone */ } return; }
    let side: { ws: WebSocket; streamSid: string } | null = null;
    const start = (sid: string) => {
      side = { ws, streamSid: sid };
      const first = !this.provider;
      this.provider = side;
      if (first) this.connected();
    };
    ws.on("message", (data, isBinary) => {
      if (this.done) return;
      const f = parseProviderFrame(this.fmt, data, isBinary);
      if (!f) return;
      if (f.kind === "start") { if (!side) start(f.streamSid); return; }
      if (f.kind === "media") {
        if (!side) start(f.streamSid);
        this.fromCallerPcm(f.pcm);
        return;
      }
      if (f.kind === "stop") this.providerGone();
    });
    ws.on("close", () => { if (side && this.provider === side) this.providerGone(); });
  }

  /** The stream is up: the members are offered the call, the mixer's clock starts. */
  private connected(): void {
    this.connectedAt = Date.now();
    this.lastVoiceAt = this.connectedAt;
    this.later(routeMaxSec() * 1000, () => void this.finish("ended", "the longest routed time passed"));
    this.t0 = performance.now();
    this.ticks = 0;
    this.clock = setInterval(() => this.pump(), 20);
    this.clock.unref?.();
    const offered = this.legs.size;
    this.log("call", `the call's audio is connected (${this.entry.type}, ${offered} offered)`, "notice", { offered });
    if (this.textOnly && !offered) { this.state = "ringing"; this.enterText("nobody is connected"); return; }
    this.state = "ringing";
    this.mixer.add("tone", { target: MIX_FRAME, max: MIX_FRAME * 4 });
    for (const leg of this.legs.values()) this.offer(leg);
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      if (this.state !== "ringing" || this.done) return;
      if (this.mode === "text") this.enterText("nobody joined in time");
      else void this.finish("failed", "nobody took the call's audio");
    }, routeLimits.joinSec * 1000);
    this.joinTimer.unref?.();
  }

  /** The caller's audio (the provider's rate). */
  private fromCallerPcm(pcm: Int16Array): void {
    this.stats.callerSec += pcm.length / this.fmt.rate;
    const at16 = this.fromCaller.push(pcm);
    if (rms(at16) > VOICE_LEVEL) this.lastVoiceAt = Date.now();
    if (this.state === "audio") this.mixer.push("caller", at16);
    else if (this.state === "text") for (const u of this.segmenter.push(at16)) this.transcribe(u.pcm);
  }

  /** 20 ms ticks against the clock (a late timer catches up, a stalled loop skips ahead instead of bursting). */
  private pump(): void {
    if (this.done) return;
    let due = Math.floor((performance.now() - this.t0) / 20) - this.ticks;
    if (due > 10) { this.ticks += due - 2; due = 2; }
    for (let i = 0; i < due; i++) { this.ticks += 1; this.mixOnce(); }
  }

  private mixOnce(): void {
    if (this.state === "ringing") {
      const at = (this.ticks * 20) % RING_PERIOD_MS;
      if (at < 1000) this.mixer.push("tone", RING.subarray(at * (MIX_RATE / 1000), (at + 20) * (MIX_RATE / 1000)));
    }
    const members = this.inAudio;
    const r = this.mixer.tick(["caller", ...members.map((l) => l.id)]);
    this.sendCaller(r.out.get("caller")!);
    for (const leg of members) {
      const o = r.out.get(leg.id);
      if (o && leg.ws?.readyState === WebSocket.OPEN) leg.ws.send(pcm16ToLE(o));
    }
  }

  private sendCaller(pcm16: Int16Array): void {
    const p = this.provider;
    if (!p || p.ws.readyState !== WebSocket.OPEN) return;
    const frames = this.framer.push(this.toCaller.push(pcm16));
    for (const f of frames) p.ws.send(providerMessage(this.fmt, p.streamSid, f));
  }

  /** The provider's stream stopped without us: usually the caller hung up — a stream lost with the call still up goes back to the TSA. */
  private providerGone(): void {
    if (this.done || this.providerClosing) return;
    this.providerClosing = true;
    this.provider = null;
    this.later(1_500, () => {
      if (this.done) return;
      const tc = telStore.calls.get(this.call.id);
      const up = Boolean(tc && !FINAL_CALL_STATUSES.includes(tc.status));
      void this.finish(up ? "ended" : "hangup", up ? "the call's audio stream closed" : "the caller hung up");
    });
  }

  /* -------------------------------------------------------- text mode */

  private enterText(why: string): void {
    if (this.state === "text" || this.done) return;
    this.state = "text";
    this.stats.textMode = true;
    this.mixer.remove("tone");
    this.lastVoiceAt = Date.now();
    this.log("call", `${why}: text mode (speech ↔ chat messages)`, "notice");
    const cs = language().startsWith("cs");
    this.tell(`☎ ${cs ? "telefonní hovor se přepisuje do textu; odpovězte zprávou na kartě hovoru" : "the phone call is transcribed; answer in writing on the call's card"}`);
    this.roster();
  }

  /** A notice (the chat shows it) to everyone the call is for — the room's members as they are now, or the member. */
  private tell(text: string): void {
    if (!hub) return;
    const seen = new Set<string>();
    const targets = [...this.legs.values()].map((l) => l.target);
    if (this.entry.type === "room") for (const t of routeTargets(this.entry, hub).targets) targets.push(t);
    for (const t of targets) {
      const key = `${t.room}|${t.peerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const from = `☎ ${(t.inRoom && this.call.from) || this.entry.label || this.call.did || "phone"}`.slice(0, 60);
      hub.send(t.room, t.peerId, { type: "server-notice", id: telId("pn"), kind: "message", text: text.slice(0, 2000), level: "info", from, at: Date.now() });
    }
  }

  private transcribe(pcm: Int16Array): void {
    this.sttQueue = this.sttQueue.then(async () => {
      if (this.done) return;
      try {
        const out = await stt({ audio: wavEncode(pcm, MIX_RATE), mime: "audio/wav", language: language().slice(0, 2) }, aiCaller());
        const text = out.text.trim();
        if (!text || this.done) return;
        this.stats.heard += 1;
        this.lastVoiceAt = Date.now();
        this.tell(text);
        for (const leg of this.legs.values()) {
          this.frame(leg, "transcript", { text });
          if (leg.ws?.readyState === WebSocket.OPEN) leg.ws.send(JSON.stringify({ type: "transcript", text, at: Date.now() }));
        }
      } catch (err) {
        this.log("call", `speech to text failed: ${(err as Error).message.slice(0, 160)}`, "warn");
      }
    });
  }

  /** A written reply → speech → the caller (and the members in the audio). */
  async speak(text: string): Promise<void> {
    try {
      const out = await tts({ text, format: "wav" }, aiCaller());
      if (this.done) return;
      this.playWav(out.audio);
      this.stats.replies += 1;
      this.lastVoiceAt = Date.now();
      this.log("call", `a written reply was spoken (${text.length} characters)`);
    } catch (err) {
      this.log("call", `text to speech failed: ${(err as Error).message.slice(0, 160)}`, "warn");
      for (const leg of this.legs.values()) if (leg.ws?.readyState === WebSocket.OPEN) leg.ws.send(JSON.stringify({ type: "error", message: "text to speech failed" }));
    }
  }

  private playWav(bytes: Uint8Array): void {
    const w = wavDecode(bytes);
    this.mixer.add("speech", { target: MIX_FRAME, max: MIX_RATE * 120 });
    this.mixer.push("speech", resample(w.pcm, w.rate, MIX_RATE));
  }

  /* ------------------------------------------------------------ timers */

  private poll(): void {
    if (this.done) return;
    // The caller hung up (the provider's status reached the call's record).
    const tc = this.call.id.startsWith("sim:") ? null : telStore.calls.get(this.call.id);
    if (tc && FINAL_CALL_STATUSES.includes(tc.status)) { void this.finish("hangup", `the call ended (${tc.status})`); return; }
    if (!this.provider) return;
    // Members who connected since: offered the call too.
    const { targets } = routeTargets(this.entry, hub);
    if (this.entry.type === "room" || !this.inAudio.length) for (const t of targets) this.legFor(t);
    const now = Date.now();
    if (this.state === "audio" && now - this.lastVoiceAt > routeLimits.idleSec * 1000) void this.finish("ended", "nobody spoke for a long time");
    else if (this.state === "text" && now - this.lastVoiceAt > routeLimits.textIdleSec * 1000) void this.finish("ended", "nothing was said or written for a long time");
  }

  /**
   * The end. "hangup": the caller is gone — everything closes. "ended" /
   * "failed": the call is still up — the TSA is resumed (on_success /
   * on_failed) and its next actions run on the call.
   */
  async finish(how: EndHow, detail: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    const wasText = this.state === "text";
    this.state = "ended";
    for (const t of this.timers) clearTimeout(t);
    if (this.clock) clearInterval(this.clock);
    if (this.poller) clearInterval(this.poller);
    if (this.grace) clearTimeout(this.grace);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    for (const leg of this.legs.values()) this.leave(leg, "the call ended");
    const reason = how === "hangup" ? "the caller hung up" : detail;
    for (const leg of this.legs.values()) {
      this.frame(leg, "ended", { reason });
      try { leg.ws?.send(JSON.stringify({ type: "ended", reason })); leg.ws?.close(1000, "ended"); } catch { /* gone */ }
      byClientToken.delete(leg.token);
    }
    routes.delete(this.id);
    byMediaToken.delete(this.mediaToken);
    const durationSec = this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0;
    this.log("call", `routed audio ended — ${detail} (${durationSec} s, ${this.stats.joins} join${this.stats.joins === 1 ? "" : "s"}, up to ${this.stats.maxInAudio} in)`, how === "failed" ? "notice" : "info", {
      how, durationSec, joins: this.stats.joins, maxMembers: this.stats.maxInAudio, memberSec: this.stats.memberSec, callerSec: Math.round(this.stats.callerSec),
      heard: this.stats.heard, replies: this.stats.replies, text: wasText || this.stats.textMode,
    });
    const closeProvider = () => { const p = this.provider; this.provider = null; try { p?.ws.close(1000, "ended"); } catch { /* gone */ } };
    if (how === "hangup") { closeProvider(); return; }
    const ev: TsaEvent = how === "failed" ? { kind: "route", ok: false, reason: "failed", detail } : { kind: "route", ok: true, detail };
    // Its next actions replace the stream on the live call; then our side of the stream closes.
    await continueTsa(this.call, this.sessionId, ev).catch(() => undefined);
    closeProvider();
  }
}

const aiCaller = (): AiCaller => ({ source: "function", actor: "telephony-route", account: "", groups: ["user"], console: false });

/**
 * Tells the TSA how the routed audio ended and runs what it does next on the
 * live call (the provider's stream is replaced). No TSA to tell, or it ended:
 * the call is hung up.
 */
export async function continueTsa(ref: TsaCallRef, sessionId: string, ev: TsaEvent): Promise<"resumed" | "hung-up" | "gone"> {
  const tc = ref.id.startsWith("sim:") ? null : telStore.calls.get(ref.id);
  if (tc && FINAL_CALL_STATUSES.includes(tc.status)) return "gone";
  if (telHooks.tsa) {
    try {
      const turn = await telHooks.tsa.resume(sessionId, ev);
      if (tc && turn.actions.length) { await execute(tc, turn.actions); return "resumed"; }
      if (turn.actions.length || (turn.session.status !== "ended" && turn.session.status !== "failed")) return "resumed";
    } catch (err) {
      telLog({ kind: "call", level: "warn", provider: ref.provider, direction: ref.direction, summary: `the TSA could not go on after the routed audio: ${(err as Error).message.slice(0, 160)}`, callId: ref.id, tsaSession: sessionId });
    }
  }
  if (tc?.providerCallId) await adapter(tc.provider)?.hangup?.(tc.providerCallId).catch(() => undefined);
  return "hung-up";
}

/* ------------------------------------------------------------- the hook */

/**
 * telHooks.routeAudio: the actions that start the call's media stream (an
 * announcement first, when given), or why the code cannot be routed.
 */
export async function routeAudio(call: TsaCallRef, entry: InrouteEntry, opts: { announce?: string; mode: "fail" | "text"; sessionId: string }): Promise<RouteAudioResult> {
  const mode = opts.mode === "text" ? "text" : "fail";
  const logOf = (summary: string, level: TelLogEntry["level"], parsed: Record<string, unknown> = {}) => telLog({
    kind: "inroute", level, provider: call.provider, direction: call.direction, summary, callId: call.id, tsaSession: opts.sessionId,
    parsed: { code: mask(entry?.code ?? ""), type: entry?.type, room: hashRoom(entry?.room), mode, ...parsed },
  });
  const d = decideRoute(entry, mode, hub);
  if (!d.ok) {
    logOf(`route code ${mask(entry?.code ?? "")}: ${d.detail}`, "notice", { reason: d.reason });
    return d;
  }
  const announce = String(opts.announce ?? "").trim().slice(0, 1_000);
  const sayFirst: CallAction[] = announce ? [{ say: { text: announce } }] : [];

  // The simulator has no media: nobody is rung; the routed audio "ends" a moment later.
  if (call.id.startsWith("sim:")) {
    logOf(`route code ${mask(entry.code)}: simulated — ${d.detail}`, "info", { simulated: true });
    const t = setTimeout(() => { void telHooks.tsa?.resume(opts.sessionId, { kind: "route", ok: true, detail: "simulated: the routed audio ended" }).catch(() => undefined); }, routeLimits.simulatedMs);
    t.unref?.();
    return { ok: true, detail: `simulated: ${d.detail}`, actions: sayFirst };
  }

  const fail = (detail: string): RouteAudioResult => { logOf(`route code ${mask(entry.code)}: ${detail}`, "warn", { reason: "failed" }); return { ok: false, reason: "failed", detail }; };
  const a = adapter(call.provider);
  if (!a?.media) return fail(`${a?.label ?? (call.provider || "the provider")} cannot stream a call's audio`);
  // A call has one routed audio at a time (a TSA that routes again replaces it).
  for (const r of routes.values()) if (r.call.id === call.id) { r.done = true; routes.delete(r.id); byMediaToken.delete(r.mediaToken); }
  let url = "";
  const route = new RoutedCall(call, entry, mode, opts.sessionId, a, d.targets, d.textOnly);
  try { url = mediaUrl(route.mediaToken); } catch (err) {
    route.done = true;
    routes.delete(route.id);
    byMediaToken.delete(route.mediaToken);
    return fail((err as Error).message);
  }
  logOf(`route code ${mask(entry.code)} accepted: ${d.detail}`, "notice", { route: route.id, offered: d.targets.length });
  return { ok: true, detail: d.detail, actions: [...sayFirst, { stream: { url, params: { route: route.id }, codec: a.media.codec, rate: a.media.rate } }] };
}

claimMedia((side, token) => {
  if (side === "provider") {
    const r = byMediaToken.get(token);
    return r && !r.done ? (ws: WebSocket) => r.attachProvider(ws) : null;
  }
  const x = byClientToken.get(token);
  return x && !x.route.done ? (ws: WebSocket) => x.route.attachLeg(x.leg, ws) : null;
});

telHooks.routeAudio = routeAudio;

/** Live routed calls (the console, tests). */
export function liveRoutes(): Array<{ id: string; callId: string; type: string; room: string | undefined; state: string; members: number; offered: number }> {
  return [...routes.values()].map((r) => ({ id: r.id, callId: r.call.id, type: r.entry.type, room: hashRoom(r.entry.room), state: r.state, members: r.inAudio.length, offered: r.legs.size }));
}

/** Shutting down (and tests): every routed call ends as if the caller hung up. */
export async function closeRoutes(): Promise<void> {
  await Promise.all([...routes.values()].map((r) => r.finish("hangup", "the server is stopping")));
}
