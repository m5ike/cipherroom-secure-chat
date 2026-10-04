// The TSA simulator (6.9): the console runs a TSA — the draft being drawn, or
// the published version — as an inbound call without a provider, no cost,
// turn by turn in the browser. The runtime is the same as on a real call; only
// the "provider" is fake: a turn's actions become what the caller would hear
// (SimTurn.play — spoken text, and for AI & speech voices the synthesized
// audio as a data: URL) and what the TSA waits for (SimTurn.waiting); the
// console answers with events (keypad digits, speech as text or a WAV to
// transcribe, a recording, a dial's outcome, the end of routed audio, hang up).
//
// What the simulator never does: dial, send an SMS, call a web service, run a
// function, post into a room, route audio or add a real route code — those
// steps say what they WOULD do. Route audio looks the code up for real (in the
// inroute table, and among codes the same simulation added) and waits for a
// "route" event the tester sends to end it.

import { randomBytes } from "node:crypto";
import type { SimTurn } from "../control/api-contract";
import type { TsaCallRef } from "../control/hooks";
import { tsaDb, type StoredSession } from "./db";
import { tsaDeps } from "./deps";
import { readAudioFile } from "./files";
import { normalizeEvent, publicSession, resumeTsa, startTsa } from "./runtime";
import { tsaStore } from "./store";
import type { CallAction } from "../providers/types";
import type { TsaSession } from "./types";

export class SimError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "SimError"; }
}

/** How many "played" redirects one request follows on its own (a TSA that only talks). */
const AUTO_CONTINUE = 50;
const PREVIEW_MAX = 2 * 1024 * 1024;

const isSim = (s: StoredSession | null): s is StoredSession => Boolean(s && s.callId.startsWith("sim:"));

type Converted = { play: SimTurn["play"]; steps: string[]; redirect: boolean; details: Partial<NonNullable<SimTurn["waiting"]>>; ended: string | null };

function convert(actions: CallAction[]): Converted {
  const out: Converted = { play: [], steps: [], redirect: false, details: {}, ended: null };
  for (const a of actions) {
    if ("say" in a) out.play.push({ kind: "say", text: a.say.text, ...(a.say.language ? { language: a.say.language } : {}), ...(a.say.loop && a.say.loop > 1 ? { loop: a.say.loop } : {}) });
    else if ("play" in a) {
      const loop = a.play.loop && a.play.loop > 1 ? { loop: a.play.loop } : {};
      const audio = /^sim:\/wh\/tsa\/audio\/([A-Za-z0-9_-]+)$/.exec(a.play.url);
      const file = /^sim:\/wh\/tsa\/file\/([a-z0-9_]+)$/.exec(a.play.url);
      if (audio) {
        const row = tsaDb.audio.get(audio[1]);
        out.play.push({ kind: "say", ...(row ? { text: row.text, audio: `data:${row.mime};base64,${row.data}` } : { text: "(the synthesized audio is gone)" }), ...loop });
      } else if (file) {
        const f = readAudioFile(file[1]);
        out.play.push(f && f.bytes.length <= PREVIEW_MAX
          ? { kind: "play", text: f.file.name, audio: `data:${f.file.mime};base64,${f.bytes.toString("base64")}`, ...loop }
          : { kind: "play", text: f ? `${f.file.name} (too big to preview here)` : "(the file is gone)", ...loop });
      } else out.play.push({ kind: "play", url: a.play.url, ...loop });
    } else if ("pause" in a) out.steps.push(`(silence ${a.pause.seconds} s)`);
    else if ("sendDigits" in a) out.play.push({ kind: "tone", text: a.sendDigits.digits });
    else if ("gather" in a) {
      if (a.gather.prompt) out.play.push({ kind: "say", text: a.gather.prompt, ...(a.gather.language ? { language: a.gather.language } : {}) });
      out.details = { ...(a.gather.digits ? { maxDigits: a.gather.digits } : {}), ...(a.gather.finishOnKey ? { finishOnKey: a.gather.finishOnKey } : {}), ...(a.gather.timeout ? { timeoutSec: a.gather.timeout } : {}) };
    } else if ("record" in a) {
      if (a.record.beep) out.play.push({ kind: "beep" });
      out.details = { ...(a.record.maxSeconds ? { maxSeconds: a.record.maxSeconds } : {}), ...(a.record.finishOnKey ? { finishOnKey: a.record.finishOnKey } : {}) };
    } else if ("dial" in a) out.details = { ...(a.dial.timeout ? { timeoutSec: a.dial.timeout } : {}) };
    else if ("stream" in a) out.steps.push(`(audio stream to ${a.stream.url.slice(0, 80)})`);
    else if ("redirect" in a) { if (/[?&]e=played\b/.test(a.redirect.url)) out.redirect = true; }
    else if ("hangup" in a) out.ended = "hangup";
    else if ("reject" in a) out.ended = a.reject.reason;
  }
  return out;
}

const traceLine = (e: TsaSession["trace"][number]) => `${e.level === "error" ? "✖ " : e.level === "warn" ? "⚠ " : ""}${e.node} (${e.type})${e.port ? ` → ${e.port}` : ""}${e.note ? `: ${e.note}` : ""}`;

/** Runs the turn's actions through the fake provider (following "played" redirects) into a SimTurn. */
async function settle(sessionId: string, first: CallAction[], mark: number): Promise<SimTurn> {
  const play: SimTurn["play"] = [];
  const extra: string[] = [];
  let actions = first;
  let c = convert(actions);
  for (let i = 0; ; i++) {
    play.push(...c.play);
    extra.push(...c.steps);
    if (!c.redirect || i >= AUTO_CONTINUE) break;
    actions = (await resumeTsa(sessionId, { kind: "played" })).actions;
    c = convert(actions);
  }
  const s = tsaDb.sessions.get(sessionId)!;
  const fresh = Math.max(0, Math.min(s.trace.length, s.traceCount - mark));
  const steps = [...s.trace.slice(s.trace.length - fresh).map(traceLine), ...extra];
  const lastError = [...s.trace].reverse().find((e) => e.level === "error");
  const ended = s.status === "ended" || s.status === "failed"
    ? { how: s.status === "failed" ? "failed" : c.ended ?? "hangup", ...(s.status === "failed" && lastError?.note ? { cause: lastError.note } : {}) }
    : null;
  return {
    session: s.id,
    status: s.status,
    at: s.at,
    play,
    waiting: s.waiting && s.waiting.for !== "played" ? { for: s.waiting.for, node: s.waiting.node, ...c.details, ...(s.waiting.timeoutSec && !c.details.timeoutSec ? { timeoutSec: s.waiting.timeoutSec } : {}) } : null,
    steps,
    ended,
  };
}

/** POST /admin/telephony/sim: { tsa, draft?, from?, to?, vars? } → the first turn. The draft is simulated unless draft: false. */
export async function simStart(body: Record<string, unknown>): Promise<{ session: TsaSession; turn: SimTurn }> {
  const id = typeof body.tsa === "string" ? body.tsa : "";
  const tsa = id ? tsaStore.get(id) : null;
  if (!tsa) throw new SimError(404, `No TSA "${id.slice(0, 48)}".`);
  const draft = body.draft !== false;
  if (!draft && !tsa.published) throw new SimError(409, `"${id}" is not published yet — simulate the draft.`);
  const num = (v: unknown, dflt: string) => (typeof v === "string" && /^(\+?\d{3,15}|sip:[^\s]{3,120})$/.test(v.trim()) ? v.trim() : dflt);
  const call: TsaCallRef = {
    id: `sim:${randomBytes(8).toString("hex")}`, token: `sim${randomBytes(12).toString("hex")}`, provider: "sim", direction: "inbound",
    from: num(body.from, "+420600000001"), to: num(body.to, "+420200000000"), did: num(body.to, "+420200000000"),
  };
  await tsaDb.ready();
  const turn = await startTsa(call, id, { draft, ...(body.vars && typeof body.vars === "object" ? { vars: body.vars as Record<string, unknown> } : {}) });
  const simTurn = await settle(turn.session.id, turn.actions, 0);
  return { session: publicSession(tsaDb.sessions.get(turn.session.id)!), turn: simTurn };
}

/** POST /admin/telephony/sim/:session/event: a TsaEvent (speech may carry `audio`, a WAV data URL to transcribe). */
export async function simEvent(sessionId: string, raw: Record<string, unknown>): Promise<{ session: TsaSession; turn: SimTurn }> {
  await tsaDb.ready();
  const s = tsaDb.sessions.get(sessionId);
  if (!isSim(s)) throw new SimError(404, "No such simulation (it may have ended an hour ago).");
  let event: Record<string, unknown> = { ...raw };
  if (raw.kind === "speech" && typeof raw.audio === "string" && raw.audio.startsWith("data:")) {
    const rec = await tsaDeps().fetchRecording("sim", raw.audio, { allowData: true }).catch((err: Error) => { throw new SimError(400, `The audio is not usable: ${err.message.slice(0, 120)}`); });
    try {
      event = { kind: "speech", text: await tsaDeps().stt({ audio: rec.bytes, mime: rec.mime, language: s.lang, console: true, actor: `tsa-sim:${s.tsaId}` }) };
    } catch (err) { throw new SimError(502, `Speech to text failed: ${(err as Error).message.slice(0, 200)}`); }
  }
  if (raw.kind === "recording" && typeof raw.audio === "string" && !raw.url) {
    const bytes = Math.max(0, raw.audio.length * 0.75 - 44);
    event = { kind: "recording", url: raw.audio, durationSec: typeof raw.durationSec === "number" ? raw.durationSec : Math.round(bytes / 32_000) || 1, ...(typeof raw.digit === "string" ? { digit: raw.digit } : {}) };
  }
  if (event.kind === "recording" && typeof event.url === "string" && !event.url.startsWith("data:") && !/^https:\/\//.test(event.url)) throw new SimError(400, "A simulated recording is a data: URL (or an https URL).");
  const ev = normalizeEvent(event);
  if (!ev) throw new SimError(400, "Not an event: kind is digits, speech, recording, played, dial, route, hangup or error.");
  const mark = s.traceCount;
  const turn = await resumeTsa(sessionId, ev);
  const simTurn = await settle(sessionId, turn.actions, mark);
  return { session: publicSession(tsaDb.sessions.get(sessionId)!), turn: simTurn };
}

/**
 * GET /admin/telephony/sim/:session — a simulation's session. A real call's
 * session is not served here: its values hold what a caller typed (route codes).
 */
export async function simGet(sessionId: string): Promise<TsaSession | null> {
  await tsaDb.ready();
  const s = tsaDb.sessions.get(sessionId);
  return isSim(s) ? publicSession(s) : null;
}
