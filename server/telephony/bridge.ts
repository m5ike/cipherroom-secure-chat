// The phone ↔ chat audio bridge (6.0): m5.telephony.did.allocate lends a
// phone number (a DID) for a while — 10 minutes by default — with a 5-digit
// access code, for one member of one room. Whoever calls the number types the
// code and # on the dial pad; with the right code the call's audio is
// connected to that member:
//
//   audio  the member takes the call in the browser: the call's audio comes
//          to them over a WebSocket (/media/tel/client/<token>) and their
//          microphone goes back — the server transcodes (G.711 µ-law 8 kHz,
//          16-bit PCM 8/16 kHz) and resamples between the two
//   text   the member does not (or cannot) take audio: what the caller says
//          is cut into utterances, transcribed (AI & speech) and sent to the
//          member as a private message; the member writes back and the text
//          is spoken to the caller (text to speech), or records a reply
//
// The provider streams the call over its own WebSocket (/media/tel/<token>):
// Twilio <Connect><Stream> (JSON, µ-law 8 kHz), Telnyx streaming_start (JSON,
// RTP payload, PCMU here), Vonage NCCO connect (binary 16-bit PCM 16 kHz).
// Every attempt (with the code masked), connection and end is logged.
//
// Where the number comes from: TELEPHONY_DID_POOL ("+420…, vonage:+44…" —
// numbers the operator owns), the number the function names, or one bought
// for the session (buy: true — released when it ends). The number's inbound
// calls must reach /wh/tel/in/<provider> (Twilio: set on allocation), the
// Vonage application's answer URL (/wh/vonage/answer) or the Telnyx
// connection's webhook (/wh/telnyx/events); the bridge hooks into those.

import { createHash, randomInt } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { adapter, adapters, pick } from "./providers";
import { FINAL_CALL_STATUSES, type CallAction, type NormalizedCallEvent, type ProviderAdapter, type ProviderId } from "./providers/types";
import { hookUrl, mediaUrl, note, rendered, save, setBridgeHooks, TelError, telBase, type WebhookReply } from "./engine";
import { telId, telStore, telToken, type BridgeSession, type TelCall, type TelOwner } from "./tel-store";
import { isE164 } from "./types";
import { publicBaseUrl } from "./connectors";
import { stt, tts, type Caller as AiCaller } from "../ai/service";
import { Framer, Segmenter, StreamResampler, mulawDecode, mulawEncode, pcm16FromLE, pcm16ToLE, resample, wavDecode, wavEncode } from "./audio";

const env = (name: string): string => (process.env[name]?.trim() || "");

export const BRIDGE_DEFAULT_MINUTES = 10;
const MAX_MINUTES = 24 * 60;
const MAX_PIN_TRIES = 3;
/** The member's side: 16-bit little-endian PCM, 16 kHz mono (a browser's AudioWorklet resamples to it). */
export const CLIENT_RATE = 16_000;

/* ------------------------------------------------------------- texts */

const TEXT: Record<string, Record<string, string>> = {
  cs: { prompt: "Dobrý den. Zadejte pětimístný přístupový kód a stiskněte mřížku.", wrong: "Nesprávný kód. Zkuste to znovu.", bye: "Kód nebyl zadán správně. Na shledanou.", connecting: "Spojuji.", gone: "Toto číslo teď nikoho nespojí. Na shledanou.", ended: "Hovor skončil." },
  en: { prompt: "Hello. Please enter your five-digit access code followed by the pound key.", wrong: "That code is not right. Please try again.", bye: "The code was not entered correctly. Goodbye.", connecting: "Connecting.", gone: "This number is not connecting anyone right now. Goodbye.", ended: "The call has ended." },
  de: { prompt: "Guten Tag. Bitte geben Sie den fünfstelligen Zugangscode ein und drücken Sie die Raute-Taste.", wrong: "Der Code ist nicht richtig. Bitte versuchen Sie es noch einmal.", bye: "Der Code wurde nicht richtig eingegeben. Auf Wiederhören.", connecting: "Ich verbinde.", gone: "Diese Nummer verbindet gerade niemanden. Auf Wiederhören.", ended: "Das Gespräch ist beendet." },
};
const say = (lang: string, key: string) => (TEXT[lang.slice(0, 2)] ?? TEXT.en)[key] ?? TEXT.en[key];
const voiceLang = (lang: string) => ({ cs: "cs-CZ", en: "en-US", de: "de-DE" } as Record<string, string>)[lang.slice(0, 2)] ?? lang;

/* ------------------------------------------------------------- the pool */

export type PoolNumber = { provider: ProviderId | ""; number: string };

/** TELEPHONY_DID_POOL: "+420222111000, vonage:+442079460000" (no provider: the default voice provider). */
export function didPool(): PoolNumber[] {
  return env("TELEPHONY_DID_POOL").split(/[,\s]+/).filter(Boolean).map((p) => {
    const m = /^(twilio|telnyx|vonage):(\+\d{6,15})$/.exec(p);
    return m ? { provider: m[1] as ProviderId, number: m[2] } : { provider: "" as const, number: p };
  }).filter((p) => isE164(p.number));
}

const LIVE = new Set(["waiting", "ringing", "verifying", "connected"]);
const liveOn = (number: string) => telStore.bridges.list({ device: number, limit: 200, filter: (b) => LIVE.has(b.status) && (b.status !== "waiting" || b.expiresAt > Date.now()) });

/* --------------------------------------------------------------- views */

export type BridgeView = Omit<BridgeSession, "clientToken" | "mediaToken" | "owner">;
export function bridgeView(b: BridgeSession): BridgeView {
  const { clientToken: _c, mediaToken: _m, owner: _o, ...rest } = b;
  return { ...rest, attempts: b.attempts.map((a) => ({ ...a, digits: mask(a.digits) })) };
}
const mask = (digits: string) => (digits ? `${"•".repeat(Math.max(0, digits.length - 1))}${digits.slice(-1)}` : "");

function log(b: BridgeSession, summary: string, level: "info" | "notice" | "warn" | "error" = "info", detail: Record<string, unknown> = {}): void {
  telStore.record({ kind: "bridge", level, ref: b.id, provider: b.provider, summary, detail: { number: b.number, room: b.roomHash, ...detail } });
}

/* ----------------------------------------------------------- allocation */

export type AllocateSpec = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));

function memberOf(v: unknown): BridgeSession["member"] {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const m = { ...(o.peerId ? { peerId: str(o.peerId) } : {}), ...(o.accountId ? { accountId: str(o.accountId) } : {}), ...(o.name ? { name: str(o.name) } : {}) };
    if (Object.keys(m).length) return m;
  }
  const s = str(v);
  if (!s) throw new TelError("bad-argument", "member: whom the call is for — a peer id, an account id or a name in the room");
  return s.startsWith("p-") ? { peerId: s } : { name: s };
}

function roomHashOf(v: unknown): string {
  const s = str(v);
  if (/^[0-9a-f]{16}$/.test(s)) return s;
  if (s && typeof v === "object" && (v as { id?: unknown }).id) return roomHashOf((v as { id: unknown }).id);
  if (!s) throw new TelError("bad-argument", "room: the room (its id, or its 16-character hash)");
  // A room id / name: hashed the way the server knows rooms (monitor/traffic.ts).
  return createHash("sha256").update(`m5cet:room:${s}`).digest("hex").slice(0, 16);
}

/** A 5-digit code no other live session on this number has. */
function freshCode(number: string): string {
  const taken = new Set(liveOn(number).map((b) => b.code));
  for (let i = 0; i < 50; i++) {
    const c = String(randomInt(0, 100_000)).padStart(5, "0");
    if (!taken.has(c) && !/^(\d)\1{4}$/.test(c) && c !== "12345") return c;
  }
  throw new TelError("busy", `too many sessions on ${number} at once`);
}

export async function allocateBridge(spec: AllocateSpec, who: { owner: TelOwner | null; caller: string }): Promise<BridgeSession> {
  await telStore.ready();
  telBase(); // the provider must reach us
  const minutes = Math.max(1, Math.min(MAX_MINUTES, Math.round(Number(spec.minutes) || BRIDGE_DEFAULT_MINUTES)));
  const maxCallMinutes = Math.max(1, Math.min(MAX_MINUTES, Math.round(Number(spec.maxCallMinutes) || minutes)));
  const language = str(spec.language) || "cs";
  let provider = str(spec.provider) as ProviderId | "";
  let number = str(spec.number);
  let bought = false;
  let numberId = "";
  if (!number && spec.buy === true) {
    const a = voiceAdapter(provider);
    if (!a.searchNumbers || !a.buyNumber) throw new TelError("unsupported", `${a.label} cannot buy numbers`);
    const found = await a.searchNumbers({ country: str(spec.country) || "CZ", voice: true, limit: 1 });
    if (!found.length) throw new TelError("not-found", `no number to buy in ${str(spec.country) || "CZ"}`);
    const owned = await a.buyNumber(found[0].number, { country: found[0].country, voiceUrl: inboundUrl(a.id) });
    number = owned.number; numberId = owned.id; provider = a.id; bought = true;
  }
  if (!number) {
    const pool = didPool().filter((p) => !provider || !p.provider || p.provider === provider);
    if (!pool.length) throw new TelError("not-configured", "no number to lend: set TELEPHONY_DID_POOL (numbers you own), pass number, or buy: true");
    // The least busy number of the pool.
    number = pool.map((p) => ({ p, n: liveOn(p.number).length })).sort((x, y) => x.n - y.n)[0].p.number;
    provider = provider || didPool().find((p) => p.number === number)?.provider || "";
  }
  if (!isE164(number)) throw new TelError("bad-argument", "number must be E.164 (+420…)");
  const a = voiceAdapter(provider);
  const now = Date.now();
  const b: BridgeSession = {
    id: telId("tb"), clientToken: telToken(), mediaToken: telToken(), number, provider: a.id, code: freshCode(number),
    roomHash: roomHashOf(spec.room), member: memberOf(spec.member), label: str(spec.label).slice(0, 80),
    mode: spec.mode === "audio" || spec.mode === "text" ? spec.mode : "auto", language, voice: str(spec.voice),
    status: "waiting", createdAt: now, expiresAt: now + minutes * 60_000, connectedAt: null, endedAt: null, maxCallSec: maxCallMinutes * 60,
    attempts: [], callId: "", caller: who.caller, owner: who.owner, channel: "", stats: { heardSegments: 0, spokenReplies: 0, audioInSec: 0, audioOutSec: 0 },
    bought, numberId,
  };
  telStore.bridges.put(b);
  // Point the number's calls here (Twilio per number; Vonage and Telnyx per application / connection).
  if (!bought && env("TELEPHONY_DID_ASSIGN") !== "0" && a.assignNumber) {
    await a.assignNumber(number, { voiceUrl: inboundUrl(a.id) }).catch((err) => log(b, `could not point ${number} here: ${(err as Error).message.slice(0, 160)} (set its voice webhook in the provider's console)`, "warn"));
  }
  log(b, `number ${number} lent for ${minutes} min to a member of room ${b.roomHash}`, "notice", { minutes, mode: b.mode, bought });
  return b;
}

function voiceAdapter(provider: string): ProviderAdapter {
  const a = provider ? adapter(provider) : pick("call");
  if (!a || !a.status().configured.includes("call")) throw new TelError("not-configured", provider ? `${provider} is not configured for calls` : "no provider is configured for calls");
  if (!a.media) throw new TelError("unsupported", `${a.label} cannot stream a call's audio`);
  return a;
}

/** Where a number's inbound calls go (Twilio's VoiceUrl; the others use their application / connection webhook). */
export const inboundUrl = (provider: string) => `${telBase()}/wh/tel/in/${provider}`;

export async function getBridge(id: string): Promise<BridgeSession | null> { await telStore.ready(); return telStore.bridges.get(id); }

export async function listBridges(f: Record<string, unknown>, modelId?: string): Promise<BridgeSession[]> {
  await telStore.ready();
  return telStore.bridges.list({ limit: Math.min(Number(f.limit) || 50, 500), filter: (b) => (!modelId || b.owner?.modelId === modelId) && (!f.status || b.status === f.status) && (!f.live || LIVE.has(b.status)) });
}

export async function releaseBridge(id: string, reason: string): Promise<boolean> {
  const b = await getBridge(id);
  if (!b || !LIVE.has(b.status)) return false;
  await endBridge(b, "released", reason);
  return true;
}

async function endBridge(found: BridgeSession, status: "ended" | "expired" | "released", reason: string): Promise<void> {
  // The live media side holds the session object that it keeps saving: end that one.
  const b = media.get(found.id)?.b ?? found;
  if (!LIVE.has(b.status)) return;
  b.status = status;
  b.endedAt = Date.now();
  telStore.bridges.put(b);
  log(b, `${status}: ${reason}`, "notice", { attempts: b.attempts.length, ...b.stats });
  media.get(b.id)?.close(reason);
  if (b.callId) {
    const call = telStore.calls.get(b.callId);
    if (call && call.providerCallId && !FINAL_CALL_STATUSES.includes(call.status)) await adapter(call.provider)?.hangup?.(call.providerCallId).catch(() => undefined);
  }
  if (b.bought && b.numberId) await adapter(b.provider)?.releaseNumber?.(b.numberId).catch((err) => log(b, `could not release ${b.number}: ${(err as Error).message}`, "warn"));
  notify(b, { event: "ended", reason });
}

/* ------------------------------------------------------ inbound calls */

/**
 * An inbound call to a number: when a live session lends it, it becomes a
 * call of the bridge (asked for the code); otherwise null — the provider
 * webhook answers as it always did.
 */
export async function inboundBridge(provider: ProviderId, ev: NormalizedCallEvent): Promise<{ call: TelCall; reply: WebhookReply } | null> {
  await telStore.ready();
  const to = ev.to ?? "";
  const number = to.startsWith("+") ? to : `+${to.replace(/^\+/, "")}`;
  const sessions = liveOn(number).filter((b) => b.provider === provider || !b.provider);
  if (!sessions.length || !ev.callId) return null;
  const existing = telStore.callByProviderId(provider, ev.callId);
  const lang = sessions[0].language;
  const now = Date.now();
  const call: TelCall = existing ?? {
    id: telId("tc"), token: telToken(), provider, providerCallId: ev.callId, direction: "inbound", from: ev.from ?? "", to: number, status: "ringing",
    mode: "sync", actions: [], handlers: {}, owner: null, pending: [], waitFor: null, gatherFn: "", events: [], seq: 0, timeoutSec: 0, timeLimitSec: 0,
    createdAt: now, updatedAt: now, answeredAt: null, endedAt: null, durationSec: null, bridge: "pin", error: "", steer: null,
  };
  save(call);
  telStore.record({ kind: "bridge", level: "info", ref: call.id, provider, summary: `call from ${call.from || "unknown"} to ${number}: asking for the code`, detail: {} });
  const actions = pinPrompt(call, lang, "prompt");
  if (provider === "telnyx") {
    // Call Control: answer now; ask for the code when call.answered arrives.
    call.actions = actions;
    save(call);
    await adapter("telnyx")?.answer?.(ev.callId, { clientState: call.id }).catch((err) => note(call, `answer failed: ${(err as Error).message}`, "warn"));
    return { call, reply: { status: 200, type: "application/json", body: "{\"ok\":true}" } };
  }
  return { call, reply: rendered(call, actions) };
}

function pinPrompt(call: TelCall, lang: string, key: "prompt" | "wrong"): CallAction[] {
  const text = key === "prompt" ? say(lang, "prompt") : `${say(lang, "wrong")} ${say(lang, "prompt")}`;
  return [{ gather: { action: hookUrl(call.token, "gather"), prompt: text, language: voiceLang(lang), digits: 5, finishOnKey: "#", timeout: 10 } }];
}

/** The digits of a bridge call: the right code connects, a wrong one asks again (three times). */
async function onDigits(call: TelCall, digits: string): Promise<CallAction[]> {
  const typed = digits.replace(/[^0-9]/g, "").slice(0, 8);
  const sessions = liveOn(call.to).filter((b) => b.provider === call.provider);
  const hit = sessions.find((b) => b.status === "waiting" && b.code === typed && b.expiresAt > Date.now());
  const lang = hit?.language ?? sessions[0]?.language ?? "en";
  const tries = call.events.filter((e) => e.kind === "gather").length;
  for (const b of sessions) {
    b.attempts.push({ at: Date.now(), from: call.from, ok: b === hit, digits: typed, callId: call.id });
    if (b.attempts.length > 50) b.attempts.splice(0, b.attempts.length - 50);
    telStore.bridges.put(b);
  }
  if (!hit) {
    telStore.record({ kind: "bridge", level: "warn", ref: call.id, provider: call.provider, summary: `wrong code from ${call.from || "unknown"} on ${call.to} (try ${tries})`, detail: { typed: mask(typed) } });
    if (!sessions.length) return [{ say: { text: say(lang, "gone"), language: voiceLang(lang) } }, { hangup: {} }];
    if (tries >= MAX_PIN_TRIES) return [{ say: { text: say(lang, "bye"), language: voiceLang(lang) } }, { hangup: {} }];
    return pinPrompt(call, lang, "wrong");
  }
  hit.status = "verifying";
  hit.callId = call.id;
  telStore.bridges.put(hit);
  call.bridge = hit.id;
  save(call);
  log(hit, `code accepted from ${call.from || "unknown"}: connecting the call's audio`, "notice");
  const a = adapter(call.provider)!;
  const fmt = a.media!;
  return [
    { say: { text: say(lang, "connecting"), language: voiceLang(lang) } },
    { stream: { url: mediaUrl(hit.mediaToken), params: { session: hit.id }, codec: fmt.codec, rate: fmt.rate } },
  ];
}

/** A bridge call's status: when it ends, the session does. */
function onCallEvents(call: TelCall, events: NormalizedCallEvent[]): void {
  if (!call.bridge || call.bridge === "pin") return;
  const final = events.find((e) => e.status && FINAL_CALL_STATUSES.includes(e.status));
  if (!final) return;
  const b = telStore.bridges.get(call.bridge);
  if (b && LIVE.has(b.status)) void endBridge(b, "ended", `the call ended (${final.status})`);
}

setBridgeHooks(onDigits, onCallEvents);

/* ---------------------------------------------------------- the member */

export type BridgeFrame = { event: "incoming" | "transcript" | "status" | "ended"; [k: string]: unknown };
/** Sends a frame to the member (main service: the signaling hub). Returns how many sockets got it. */
export type BridgeNotifier = (roomHash: string, member: BridgeSession["member"], payload: Record<string, unknown>) => number;
let notifier: BridgeNotifier | null = null;
export function setBridgeNotifier(fn: BridgeNotifier | null): void { notifier = fn; }

function notify(b: BridgeSession, frame: BridgeFrame): number {
  return notifier?.(b.roomHash, b.member, { type: "phone-bridge", session: b.id, number: b.number, label: b.label, ...frame }) ?? 0;
}

/** A private text for the member (what the caller said) — as an operator notice every client shows. */
function tellMember(b: BridgeSession, text: string): void {
  notifier?.(b.roomHash, b.member, { type: "server-notice", id: telId("pn"), kind: "message", text, level: "info", from: `☎ ${b.label || b.number}`, at: Date.now() });
}

/* ------------------------------------------------------------ media */

type ProviderSide = { ws: WebSocket; kind: ProviderId; streamSid: string; rate: number };

/** One connected call: the provider's stream on one side, the member (audio or text) on the other. */
class MediaBridge {
  provider: ProviderSide | null = null;
  client: WebSocket | null = null;
  private toClient: StreamResampler;
  private fromClient: StreamResampler;
  private segmenter: Segmenter;
  private framer: Framer;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private autoText: ReturnType<typeof setTimeout> | null = null;
  private sttQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(public b: BridgeSession, private readonly rate: number) {
    this.toClient = new StreamResampler(rate, CLIENT_RATE);
    this.fromClient = new StreamResampler(CLIENT_RATE, rate);
    this.segmenter = new Segmenter({ rate: CLIENT_RATE });
    this.framer = new Framer(Math.round(rate / 50));
  }

  attachProvider(side: ProviderSide): void {
    this.provider = side;
    this.b.status = "connected";
    this.b.connectedAt = Date.now();
    telStore.bridges.put(this.b);
    log(this.b, "the call's audio is connected", "notice");
    const n = notify(this.b, { event: "incoming", token: this.b.clientToken, from: telStore.calls.get(this.b.callId)?.from ?? "", mode: this.b.mode, maxCallSec: this.b.maxCallSec, clientRate: CLIENT_RATE });
    if (!n) log(this.b, "the member is not connected to the room: speech is transcribed for when they come back", "warn");
    this.timer = setTimeout(() => void endBridge(this.b, "ended", "the longest call time passed"), this.b.maxCallSec * 1000);
    this.timer.unref?.();
    // auto: the member has a few seconds to take the audio; then speech ↔ text.
    if (this.b.mode === "text") this.useText();
    else if (this.b.mode === "auto") { this.autoText = setTimeout(() => { if (!this.client) this.useText(); }, 8_000); this.autoText.unref?.(); }
  }

  private useText(): void {
    if (this.b.channel) return;
    this.b.channel = "text";
    telStore.bridges.put(this.b);
    tellMember(this.b, `☎ ${telStore.calls.get(this.b.callId)?.from ?? ""} — ${this.b.language.startsWith("cs") ? "hovor se přepisuje do textu; odpovězte zprávou" : "the call is transcribed; answer in writing"}`);
  }

  attachClient(ws: WebSocket): void {
    if (this.client) { try { this.client.close(4009, "taken elsewhere"); } catch { /* gone */ } }
    this.client = ws;
    if (this.autoText) clearTimeout(this.autoText);
    ws.on("message", (data, isBinary) => {
      if (isBinary) { if (this.b.channel !== "text") this.fromMember(pcm16FromLE(new Uint8Array(data as Buffer))); return; }
      let m: { type?: string; text?: string; mode?: string; wav?: string } = {};
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === "audio" && !this.b.channel) { this.b.channel = "audio"; telStore.bridges.put(this.b); log(this.b, "the member took the call's audio"); }
      if (m.type === "text-mode") this.useText();
      if (m.type === "say" && m.text) void this.speak(String(m.text).slice(0, 1_000));
      if (m.type === "wav" && m.wav) void this.playWav(Buffer.from(m.wav, "base64"));
      if (m.type === "hangup") void endBridge(this.b, "ended", "the member hung up");
    });
    ws.on("close", () => { if (this.client === ws) this.client = null; });
    ws.send(JSON.stringify({ type: "hello", session: this.b.id, rate: CLIENT_RATE, mode: this.b.mode, channel: this.b.channel }));
  }

  /** Audio from the caller (the provider's rate) → the member. */
  fromCaller(pcm: Int16Array): void {
    this.b.stats.audioInSec += pcm.length / this.rate;
    const at16 = this.toClient.push(pcm);
    if (this.client && this.b.channel !== "text" && this.client.readyState === WebSocket.OPEN) {
      this.client.send(pcm16ToLE(at16));
      return;
    }
    for (const u of this.segmenter.push(at16)) this.transcribe(u.pcm);
  }

  private transcribe(pcm: Int16Array): void {
    this.sttQueue = this.sttQueue.then(async () => {
      try {
        const out = await stt({ audio: wavEncode(pcm, CLIENT_RATE), mime: "audio/wav", language: this.b.language.slice(0, 2) }, this.aiCaller());
        const text = out.text.trim();
        if (!text) return;
        this.b.stats.heardSegments += 1;
        telStore.bridges.put(this.b);
        tellMember(this.b, text);
        if (this.client?.readyState === WebSocket.OPEN) this.client.send(JSON.stringify({ type: "transcript", text, at: Date.now() }));
      } catch (err) {
        log(this.b, `speech to text failed: ${(err as Error).message.slice(0, 160)}`, "warn");
      }
    });
  }

  /** The member's microphone (16 kHz) → the caller. */
  private fromMember(pcm: Int16Array): void {
    this.b.stats.audioOutSec += pcm.length / CLIENT_RATE;
    this.toCaller(this.fromClient.push(pcm));
  }

  /** Text → speech → the caller. */
  async speak(text: string): Promise<void> {
    try {
      const out = await tts({ text, format: "wav", ...(this.b.voice ? { voice: this.b.voice } : {}) }, this.aiCaller());
      await this.playWav(out.audio);
      this.b.stats.spokenReplies += 1;
      telStore.bridges.put(this.b);
      log(this.b, `a written reply was spoken (${text.length} characters)`);
    } catch (err) {
      log(this.b, `text to speech failed: ${(err as Error).message.slice(0, 160)}`, "warn");
      if (this.client?.readyState === WebSocket.OPEN) this.client.send(JSON.stringify({ type: "error", message: "text to speech failed" }));
    }
  }

  async playWav(bytes: Uint8Array): Promise<void> {
    const w = wavDecode(bytes);
    // A whole reply: its last few milliseconds too (padded to a frame).
    this.toCaller(resample(w.pcm, w.rate, this.rate), true);
  }

  private toCaller(pcm: Int16Array, end = false): void {
    const p = this.provider;
    if (!p || p.ws.readyState !== WebSocket.OPEN) return;
    const frames = this.framer.push(pcm);
    if (end) { const rest = this.framer.flush(); if (rest) frames.push(rest); }
    for (const frame of frames) {
      if (p.kind === "vonage") p.ws.send(pcm16ToLE(frame));
      else {
        const payload = Buffer.from(mulawEncode(frame)).toString("base64");
        p.ws.send(JSON.stringify(p.kind === "twilio" ? { event: "media", streamSid: p.streamSid, media: { payload } } : { event: "media", media: { payload } }));
      }
    }
  }

  private aiCaller(): AiCaller {
    const c = this.b.owner?.caller;
    return { source: "function", actor: `telephony-bridge${c?.name ? `:${c.name}` : ""}`, account: c?.account ?? "", groups: [...new Set([...(c?.groups ?? []), "user"])], console: false };
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    media.delete(this.b.id);
    if (this.timer) clearTimeout(this.timer);
    if (this.autoText) clearTimeout(this.autoText);
    for (const u of [this.segmenter.flush()].filter(Boolean)) this.transcribe(u!.pcm);
    try { this.client?.send(JSON.stringify({ type: "ended", reason })); this.client?.close(1000, "ended"); } catch { /* gone */ }
    try { this.provider?.ws.close(1000, "ended"); } catch { /* gone */ }
    media.delete(this.b.id);
  }
}

const media = new Map<string, MediaBridge>();

async function sessionBy(field: "mediaToken" | "clientToken", token: string): Promise<BridgeSession | null> {
  await telStore.ready();
  return telStore.bridges.list({ limit: 1, filter: (b) => b[field] === token && LIVE.has(b.status) })[0] ?? null;
}

function bridgeFor(b: BridgeSession): MediaBridge {
  let m = media.get(b.id);
  if (!m) {
    const a = adapter(b.provider);
    m = new MediaBridge(b, a?.media?.rate ?? 8_000);
    media.set(b.id, m);
  }
  return m;
}

/** The provider's media stream: Twilio / Telnyx JSON events, Vonage binary frames. */
function providerSocket(found: BridgeSession, ws: WebSocket): void {
  const m = bridgeFor(found);
  const b = m.b;
  const kind = b.provider;
  let side: ProviderSide | null = null;
  ws.on("message", (data, isBinary) => {
    if (kind === "vonage") {
      if (isBinary) { m.fromCaller(pcm16FromLE(new Uint8Array(data as Buffer))); return; }
      // The first text frame: websocket:connected (with the headers we asked for).
      if (!side) { side = { ws, kind, streamSid: "", rate: 16_000 }; m.attachProvider(side); }
      return;
    }
    let f: { event?: string; streamSid?: string; stream_id?: string; start?: { streamSid?: string }; media?: { payload?: string; track?: string } } = {};
    try { f = JSON.parse(String(data)); } catch { return; }
    if (f.event === "start" && !side) { side = { ws, kind, streamSid: f.start?.streamSid ?? f.streamSid ?? f.stream_id ?? "", rate: 8_000 }; m.attachProvider(side); return; }
    if (f.event === "media" && f.media?.payload && (!f.media.track || f.media.track.startsWith("inbound"))) {
      if (!side) { side = { ws, kind, streamSid: f.streamSid ?? f.stream_id ?? "", rate: 8_000 }; m.attachProvider(side); }
      m.fromCaller(mulawDecode(new Uint8Array(Buffer.from(f.media.payload, "base64"))));
      return;
    }
    if (f.event === "stop") void endBridge(b, "ended", "the provider stopped the stream");
  });
  ws.on("close", () => { if (media.get(b.id) === m && b.status === "connected") void endBridge(b, "ended", "the call's stream closed"); });
}

/** The member's side: audio both ways (binary PCM 16 kHz) and control (JSON). */
function clientSocket(b: BridgeSession, ws: WebSocket): void {
  bridgeFor(b).attachClient(ws);
}

let wss: WebSocketServer | null = null;
let sweeper: ReturnType<typeof setInterval> | null = null;

/** Main service: the media WebSockets (/media/tel/…) and the sweep of expired sessions. */
export function attachBridgeMedia(server: Server): void {
  wss ??= new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let path = "";
    try { path = new URL(req.url ?? "/", "http://x").pathname; } catch { return; }
    const m = /^\/media\/tel\/(client\/)?([A-Za-z0-9_-]{16,64})$/.exec(path);
    if (!m || !wss) return;
    void (async () => {
      const b = await sessionBy(m[1] ? "clientToken" : "mediaToken", m[2]);
      if (!b) { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      wss!.handleUpgrade(req, socket, head, (ws) => (m[1] ? clientSocket(b, ws) : providerSocket(b, ws)));
    })();
  });
  sweeper ??= setInterval(() => void sweep(), 30_000);
  sweeper.unref?.();
}

/** Shutting down (and tests): every media socket closes, the sweep stops. */
export function closeBridgeMedia(): void {
  for (const m of [...media.values()]) m.close("the server is stopping");
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  if (wss) { for (const ws of wss.clients) ws.terminate(); wss.close(); wss = null; }
}

/** Sessions nobody called before they ran out end (and a bought number goes back). */
export async function sweep(now = Date.now()): Promise<number> {
  await telStore.ready();
  let n = 0;
  for (const b of telStore.bridges.list({ limit: 500, filter: (x) => x.status === "waiting" && x.expiresAt <= now })) { await endBridge(b, "expired", "nobody called in time"); n++; }
  return n;
}

/* ------------------------------------------------------------ tests */

export const __test = { media, onDigits, pinPrompt, didPool, publicBaseUrl, adapters };
