// The TSA runtime (6.9): runs a Telephony & SIP Application on a live call —
// inbound or outbound — or in the console's simulator.
//
// A run is a sequence of TURNS. A turn starts when the call enters the TSA
// (start) or when the provider reports back (resume with a TsaEvent: digits,
// speech, a recording, a dial's outcome, the end of routed audio, "played").
// The runtime walks the graph from there, node after node:
//
//   · pure nodes (Condition, Switch, Set, Formula, Text, loops, Opening
//     hours, Log, Number info…) compute and go on;
//   · say / play / pause / DTMF add their CallAction to the turn and go on —
//     the provider performs a turn's actions in order, so a greeting and the
//     menu after it are one answer to the provider;
//   · a node that needs the caller or the provider (Read DTMF, Record, Speech
//     to text, Dial, Route audio) adds the action that makes the provider do
//     it and call back, and the turn ends: the session WAITS (stored in
//     telephony.db, so the callback may reach the other process);
//   · Hang up (or a dead end: a control output with no edge and no loop to go
//     back to) ends the call.
//
// Callbacks come to `${PUBLIC_BASE_URL}/wh/tel/<call token>/tsa?s=<session>&n=<node>`
// (the gather / record / dial `action`); a turn that must break before it
// needs the caller (its step budget is used up while there is audio to play,
// or a stream must stop after N seconds) ends with a redirect to the same URL
// plus `&e=played`, and goes on when the provider comes back.
//
// Limits (TSA_LIMITS): steps per turn without anything for the caller (a busy
// cycle ends the call), steps per call, loop rounds, the call's longest time.
// An error ends the call politely: a short apology in the Start's language,
// then hang up (or, not answered yet, a refusal) — and a line in the log.

import { randomBytes } from "node:crypto";
import { hashRoom } from "../../monitor/traffic";
import { publicBaseUrl } from "../connectors";
import { telHooks, telLog, telPermissions, type TsaCallRef, type TsaTurn } from "../control/hooks";
import { INROUTE_CODE, type InrouteEntry } from "../control/types";
import { normalizeNumber, numberInfo } from "../numbers";
import type { CallAction, ProviderId } from "../providers/types";
import { telId } from "../tel-store";
import { isE164 } from "../types";
import { dataInputs, toolOf } from "./catalog";
import { tsaDb, type Cursor, type StoredSession } from "./db";
import { tsaDeps } from "./deps";
import { getAudioFile } from "./files";
import { clockIn, formulaEquals, looksNumeric, runFormula, textOf, truthy, type FormulaScope } from "./formula";
import { tsaStore } from "./store";
import { renderTemplate, spellDigits } from "./template";
import { TSA_LIMITS, type Tsa, type TsaEvent, type TsaGraph, type TsaNode, type TsaSession, type TsaTraceEntry } from "./types";
import { dataSource, flowTarget, hostAllowed, indexGraph, parseDays, type GraphIndex } from "./validate";

/** Actions in one answer to the provider before the turn is split with a redirect. */
const MAX_TURN_ACTIONS = 40;
const TRACE_KEEP = 300;
const VALUE_MAX = 65_536;
/** Synthesized speech stays fetchable this long. */
const AUDIO_TTL_MS = 2 * 3600_000;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/* ------------------------------------------------------------- outcomes */

type Outcome =
  /** Follow this control output (then, `yield`: break the turn there with a redirect). */
  | { go: string; note?: string; level?: TsaTraceEntry["level"]; yield?: { streamSec?: number } }
  /** The call does this and calls back: the session waits for an event of this kind. */
  | { wait: TsaEvent["kind"]; actions: CallAction[]; timeoutSec?: number; note?: string; mode?: string }
  /** The call ends here. */
  | { end: CallAction[]; how: string }
  /** Break: leave the innermost loop. */
  | { brk: true }
  | { fail: string };

type Ctx = {
  s: StoredSession;
  g: TsaGraph;
  ix: GraphIndex;
  actions: CallAction[];
  turnSteps: number;
  /** The turn already has something for the caller to hear (a redirect can split it there). */
  audio: boolean;
  /** Index of a say a Read DTMF right after may take as its prompt (the TTS's "a key press stops it"). */
  bargeSay: number | null;
  sim: boolean;
  /** After the session is saved: streams to stop after N seconds. */
  timers: Array<{ node: string; ms: number }>;
};

class TsaFailure extends Error {}

/* --------------------------------------------------------------- helpers */

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

function param(node: TsaNode, key: string): unknown {
  if (node.params && Object.prototype.hasOwnProperty.call(node.params, key) && node.params[key] !== undefined) return node.params[key];
  return toolOf(node.type)?.params.find((p) => p.key === key)?.default;
}

function bounded(v: unknown): unknown {
  if (typeof v === "string") return v.length > VALUE_MAX ? v.slice(0, VALUE_MAX) : v;
  if (v === null || typeof v !== "object") return v === undefined ? null : v;
  try { const j = JSON.stringify(v); return j && j.length <= VALUE_MAX ? JSON.parse(j) : null; } catch { return null; }
}

function inputsOf(ctx: Ctx, node: TsaNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of dataInputs(node.type, node.inputs)) {
    const e = dataSource(ctx.ix, node.id, p.port);
    const v = e ? ctx.s.values[e.from.node]?.[e.from.port] : undefined;
    out[p.port] = v === undefined ? null : v;
  }
  return out;
}

function scopeOf(ctx: Ctx, node: TsaNode): FormulaScope {
  const d = tsaDeps();
  return { inputs: inputsOf(ctx, node), vars: ctx.s.vars, call: ctx.s.call, now: d.now, random: d.random };
}

const tpl = (ctx: Ctx, node: TsaNode, key: string, opts: Parameters<typeof renderTemplate>[2] = {}): string => renderTemplate(param(node, key), scopeOf(ctx, node), opts);

function setOut(ctx: Ctx, node: TsaNode, port: string, value: unknown): void {
  (ctx.s.values[node.id] ??= {})[port] = bounded(value);
}

function trace(ctx: Ctx, node: Pick<TsaNode, "id" | "type">, port?: string, note?: string, level?: TsaTraceEntry["level"]): void {
  const e: TsaTraceEntry = { at: tsaDeps().now(), node: node.id, type: node.type, ...(port ? { port } : {}), ...(note ? { note: note.slice(0, 500) } : {}), ...(level && level !== "info" ? { level } : {}) };
  ctx.s.trace.push(e);
  if (ctx.s.trace.length > TRACE_KEEP) ctx.s.trace.splice(0, ctx.s.trace.length - TRACE_KEEP);
  ctx.s.traceCount += 1;
}

function log(ctx: Ctx, level: "debug" | "info" | "notice" | "warn" | "error", summary: string, parsed?: unknown): void {
  if (ctx.sim) return;
  telLog({ kind: "tsa", level, summary: `${ctx.s.tsaId}: ${summary}`.slice(0, 300), callId: ctx.s.callId, tsaSession: ctx.s.id, provider: ctx.s.provider, direction: ctx.s.direction, ...(parsed !== undefined ? { parsed } : {}) });
}

const mask = (code: string) => (code.length > 2 ? `${"•".repeat(code.length - 2)}${code.slice(-2)}` : "••");

function base(ctx: Ctx): string {
  if (ctx.sim) return "sim:";
  const b = publicBaseUrl();
  if (!b) throw new TsaFailure("PUBLIC_BASE_URL is not set — the provider cannot report back");
  return b;
}

/** The URL a provider calls back to resume this session at this node. */
function cbUrl(ctx: Ctx, node: string, e?: string): string {
  return `${base(ctx)}/wh/tel/${encodeURIComponent(ctx.s.ref.token)}/tsa?s=${encodeURIComponent(ctx.s.id)}&n=${encodeURIComponent(node)}${e ? `&e=${e}` : ""}`;
}

/** Adds an action for the caller (none once the caller has hung up). */
function pushCall(ctx: Ctx, a: CallAction): boolean {
  if (ctx.s.offline) return false;
  ctx.actions.push(a);
  if ("say" in a || "play" in a || "pause" in a || "sendDigits" in a) ctx.audio = true;
  if (!("reject" in a) && !("hangup" in a)) ctx.s.answered = true;
  return true;
}

const APOLOGY: Record<string, string> = {
  cs: "Omlouváme se, nastala chyba. Na shledanou.",
  sk: "Ospravedlňujeme sa, nastala chyba. Dovidenia.",
  de: "Entschuldigung, ein Fehler ist aufgetreten. Auf Wiederhören.",
  pl: "Przepraszamy, wystąpił błąd. Do widzenia.",
  en: "We are sorry, something went wrong. Goodbye.",
};
const apology = (lang: string) => APOLOGY[lang.slice(0, 2)] ?? APOLOGY.en;

/** A finish key for the provider: "none" / "any" → "" for a gather (any key would end it at once). */
const gatherKey = (k: unknown) => (k === "#" || k === "*" ? k : "");
const recordKey = (k: unknown) => (k === "#" || k === "*" || k === "any" ? k : "");

/** "+1900*", "*", "sip:*@x" — a glob over a short value (no regular expression). */
export function globMatch(pattern: string, value: string): boolean {
  let p = 0, v = 0, star = -1, mark = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) { p++; v++; continue; }
    if (p < pattern.length && pattern[p] === "*") { star = p++; mark = v; continue; }
    if (star >= 0) { p = star + 1; v = ++mark; continue; }
    return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** May a TSA dial / text this number? The reason when not. */
export function numberRefused(to: string): string | null {
  const o = telPermissions().outbound;
  if (o.blocked.some((p) => globMatch(p.replace(/^-/, ""), to))) return "the permissions block this number";
  if (o.countries.length && to.startsWith("+")) {
    const iso = numberInfo(to)?.iso2 ?? "";
    if (!o.countries.includes(iso)) return `calls to ${iso || "this country"} are not allowed (Telephony › Permissions)`;
  }
  return null;
}

const hourKey = (ms: number) => Math.floor(ms / 3600_000);

/* -------------------------------------------------------------- the tools */

async function runNode(ctx: Ctx, node: TsaNode): Promise<Outcome> {
  const s = ctx.s;
  const d = tsaDeps();
  switch (node.type) {
    case "start": {
      s.lang = str(param(node, "language")) || "cs-CZ";
      const minutes = clamp(param(node, "maxMinutes"), 1, 240, 60);
      s.deadline = s.startedAt + Math.min(minutes * 60, TSA_LIMITS.maxCallSeconds) * 1000;
      s.answered = s.direction === "outbound" || param(node, "answer") !== false;
      for (const [port, v] of [["from", s.call.from], ["to", s.call.to], ["did", s.call.did], ["direction", s.call.direction], ["provider", s.call.provider], ["call_id", s.call.id]] as const) setOut(ctx, node, port, v);
      return { go: "next" };
    }

    case "hangup": {
      const as = str(param(node, "as")) || "hangup";
      if (as !== "hangup" && !s.answered && s.direction === "inbound") return { end: [{ reject: { reason: as as "busy" | "congestion" | "rejected" } }], how: as };
      return { end: [{ hangup: {} }], how: as === "hangup" ? "hung up" : `hung up (${as}, the call was answered already)` };
    }

    case "pause": {
      pushCall(ctx, { pause: { seconds: clamp(param(node, "seconds"), 0.5, 60, 1) } });
      return { go: "next" };
    }

    case "send_dtmf": {
      const digits = tpl(ctx, node, "digits").replace(/\s+/g, "");
      if (!digits || !/^[0-9*#A-Dw]{1,64}$/.test(digits)) return { go: "on_failed", note: `not dial-pad digits: "${digits.slice(0, 20)}"`, level: "warn" };
      const mode = str(param(node, "type")) as "rfc2833" | "inband" | "sip-info";
      pushCall(ctx, { sendDigits: { digits, mode: mode || "rfc2833", toneMs: clamp(param(node, "toneMs"), 100, 500, 250) } });
      return { go: "next", note: `sends ${digits.length} tone${digits.length === 1 ? "" : "s"}` };
    }

    case "tts": {
      const text = tpl(ctx, node, "text").trim();
      if (!text) return { go: "on_failed", note: "nothing to say (the text is empty)", level: "warn" };
      const language = str(param(node, "language")) || s.lang;
      const voice = str(param(node, "voice")) || undefined;
      const loop = Math.round(clamp(param(node, "loop"), 1, 10, 1));
      if (param(node, "provider") === "ai") {
        let url: string;
        try {
          const out = await d.tts({ text, ...(voice ? { voice } : {}), language, console: ctx.sim, actor: `tsa:${s.tsaId}` });
          url = storeAudio(ctx, applyVolume(out.audio, out.mime, clamp(param(node, "volume"), -12, 12, 0)), out.mime, text);
        } catch (err) {
          log(ctx, "warn", `text to speech failed: ${(err as Error).message.slice(0, 160)}`);
          return { go: "on_failed", note: `text to speech failed: ${(err as Error).message.slice(0, 120)}`, level: "warn" };
        }
        pushCall(ctx, { play: { url, loop } });
        ctx.bargeSay = null;
        return { go: "next", note: `says (AI voice): ${text.slice(0, 80)}` };
      }
      pushCall(ctx, { say: { text, ...(voice ? { voice } : {}), language, ...(loop > 1 ? { loop } : {}) } });
      ctx.bargeSay = param(node, "bargeIn") !== false && loop === 1 ? ctx.actions.length - 1 : null;
      return { go: "next", note: `says: ${text.slice(0, 80)}` };
    }

    case "play": {
      const source = str(param(node, "source")) || "url";
      const loop = Math.round(clamp(param(node, "loop"), 1, 100, 1));
      let url: string;
      if (source === "file") {
        const f = getAudioFile(str(param(node, "file")));
        if (!f) return { go: "on_failed", note: "the audio file is not there (Telephony › Files)", level: "warn" };
        url = `${base(ctx)}/wh/tsa/file/${f.id}`;
      } else {
        url = tpl(ctx, node, "url").trim();
        if (!/^https:\/\/[^\s]+$/i.test(url)) return { go: "on_failed", note: `not an https URL: "${url.slice(0, 60)}"`, level: "warn" };
      }
      pushCall(ctx, { play: { url, ...(loop > 1 ? { loop } : {}) } });
      ctx.bargeSay = null;
      if (source === "stream") return { go: "next", note: `streams ${url.slice(0, 80)}`, yield: { streamSec: clamp(param(node, "seconds"), 1, 3600, 30) } };
      return { go: "next", note: `plays ${source === "file" ? "a file" : url.slice(0, 80)}` };
    }

    case "record": {
      if (s.offline) return { end: [], how: "the caller hung up" };
      const maxSeconds = Math.round(clamp(param(node, "maxSeconds"), 1, 3600, 60));
      const language = str(param(node, "language")) || s.lang;
      return {
        wait: "recording", mode: "record", timeoutSec: maxSeconds + 15,
        actions: [{ record: { action: cbUrl(ctx, node.id), maxSeconds, beep: param(node, "beep") !== false, finishOnKey: recordKey(param(node, "finishOnKey")), silenceSeconds: clamp(param(node, "silenceSeconds"), 0, 60, 5), trim: param(node, "trim") !== false, transcribe: false, language } }],
        note: `records up to ${maxSeconds} s`,
      };
    }

    case "stt": {
      if (s.offline) return { end: [], how: "the caller hung up" };
      const language = str(param(node, "language")) || s.lang;
      const maxSeconds = Math.round(clamp(param(node, "maxSeconds"), 1, 120, 15));
      const silence = clamp(param(node, "silenceSeconds"), 0.5, 10, 1.5);
      if (param(node, "provider") === "ai") {
        return {
          wait: "recording", mode: "stt", timeoutSec: maxSeconds + 15, note: "listens (recorded for AI & speech)",
          actions: [{ record: { action: cbUrl(ctx, node.id), maxSeconds, beep: false, finishOnKey: "", silenceSeconds: Math.max(1, Math.round(silence)), trim: true, transcribe: false, language } }],
        };
      }
      const hints = Array.isArray(param(node, "hints")) ? (param(node, "hints") as unknown[]).map(str).map((h) => h.trim()).filter(Boolean).slice(0, 50) : [];
      return {
        wait: "speech", timeoutSec: clamp(param(node, "timeout"), 1, 60, 5) + maxSeconds, note: "listens",
        actions: [{ gather: { action: cbUrl(ctx, node.id), input: ["speech"], language, timeout: Math.round(clamp(param(node, "timeout"), 1, 60, 5)), speechTimeout: silence, ...(hints.length ? { hints } : {}) } }],
      };
    }

    case "read_dtmf": {
      if (s.offline) return { end: [], how: "the caller hung up" };
      const timeout = Math.round(clamp(param(node, "timeout"), 1, 60, 5));
      const gather: Extract<CallAction, { gather: unknown }>["gather"] = {
        action: cbUrl(ctx, node.id), digits: Math.round(clamp(param(node, "maxDigits"), 1, 32, 1)), finishOnKey: gatherKey(param(node, "finishOnKey")), timeout, input: ["dtmf"], language: s.lang,
      };
      const prompt = tpl(ctx, node, "prompt").trim();
      if (prompt) gather.prompt = prompt;
      else if (ctx.bargeSay !== null && ctx.bargeSay === ctx.actions.length - 1) {
        // The TTS right before may be interrupted by a key: it becomes the gather's prompt.
        const said = ctx.actions.pop() as Extract<CallAction, { say: unknown }>;
        gather.prompt = said.say.text;
        if (said.say.voice) gather.voice = said.say.voice;
        if (said.say.language) gather.language = said.say.language;
      }
      ctx.bargeSay = null;
      s.attempts[node.id] = s.attempts[node.id] ?? 0;
      return { wait: "digits", actions: [{ gather }], timeoutSec: timeout, note: `waits for up to ${gather.digits} digit${gather.digits === 1 ? "" : "s"}` };
    }

    case "route_audio": return routeAudio(ctx, node);

    case "dial": return dial(ctx, node);

    case "condition": {
      const r = runFormula(str(param(node, "formula")), scopeOf(ctx, node));
      if (!r.ok) return { fail: `the formula of "${node.id}" does not parse: ${r.error.message}` };
      const yes = truthy(r.value);
      return { go: yes ? "on_true" : "on_false", note: `${textOf(r.value).slice(0, 40) || "null"} → ${yes}` };
    }

    case "switch": {
      const v = inputsOf(ctx, node).IN1;
      const cases = (Array.isArray(param(node, "cases")) ? (param(node, "cases") as unknown[]) : []).map(str).filter((c) => c.trim() !== "");
      const fold = param(node, "ignoreCase") !== false
        ? (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
        : (x: string) => x.trim();
      const match = str(param(node, "match")) || "equals";
      const value = fold(textOf(v));
      const i = cases.findIndex((c) => {
        const k = fold(c);
        if (match === "contains") return k !== "" && value.includes(k);
        if (match === "prefix") return value.startsWith(k);
        return looksNumeric(value) && looksNumeric(k) ? formulaEquals(value, k) : value === k;
      });
      return { go: i >= 0 ? `case_${i + 1}` : "default", note: `"${textOf(v).slice(0, 40)}" → ${i >= 0 ? `case ${cases[i]}` : "default"}` };
    }

    case "for": {
      enterLoop(ctx, node);
      const sc = scopeOf(ctx, node);
      const nums: number[] = [];
      for (const k of ["from", "to", "step"]) {
        const r = runFormula(str(param(node, k)), sc);
        if (!r.ok) return { fail: `"${k}" of "${node.id}" does not parse: ${r.error.message}` };
        const n = Number(r.value);
        if (r.value === null || r.value === "" || !Number.isFinite(n)) return { fail: `"${k}" of "${node.id}" is not a number (${textOf(r.value).slice(0, 20) || "null"})` };
        nums.push(n);
      }
      const [from, to, step] = nums;
      s.rounds[node.id] = 0;
      if (step === 0) return { go: "done", note: "a step of 0 — the loop is skipped", level: "warn" };
      if (step > 0 ? from <= to : from >= to) {
        s.loops.push({ node: node.id, index: from, until: to, step });
        setOut(ctx, node, "index", from);
        return { go: "body", note: `index ${from}` };
      }
      return { go: "done", note: "nothing to repeat" };
    }

    case "while": {
      enterLoop(ctx, node);
      const max = Math.round(clamp(param(node, "maxRounds"), 1, TSA_LIMITS.loopIterations, 3));
      s.rounds[node.id] = 0;
      const r = runFormula(str(param(node, "formula")), scopeOf(ctx, node));
      if (!r.ok) return { fail: `the formula of "${node.id}" does not parse: ${r.error.message}` };
      if (truthy(r.value)) {
        s.loops.push({ node: node.id, index: 0, until: max });
        setOut(ctx, node, "index", 0);
        return { go: "body", note: "round 1" };
      }
      return { go: "done", note: "the condition does not hold" };
    }

    case "break": return { brk: true };

    case "set": {
      const name = str(param(node, "name")).replace(/^\$/, "");
      if (!VAR_NAME.test(name)) return { fail: `"${node.id}": "${name.slice(0, 40)}" is not a variable name` };
      const r = runFormula(str(param(node, "value")), scopeOf(ctx, node));
      if (!r.ok) return { fail: `the value of "${node.id}" does not parse: ${r.error.message}` };
      if (!(name in s.vars) && Object.keys(s.vars).length >= 200) return { fail: "more than 200 variables" };
      s.vars[name] = bounded(r.value);
      setOut(ctx, node, "value", r.value);
      return { go: "next", note: `$${name} = ${textOf(r.value).slice(0, 60) || "null"}` };
    }

    case "formula": {
      const r = runFormula(str(param(node, "formula")), scopeOf(ctx, node));
      if (!r.ok) return { fail: `the formula of "${node.id}" does not parse: ${r.error.message}` };
      setOut(ctx, node, "value", r.value);
      return { go: "next", note: `= ${textOf(r.value).slice(0, 60) || "null"}` };
    }

    case "text": {
      let t = tpl(ctx, node, "template");
      if (param(node, "spellDigits") === true) t = spellDigits(t);
      setOut(ctx, node, "text", t);
      return { go: "next", note: t.slice(0, 80) };
    }

    case "time_condition": {
      const open = isOpen(node, d.now());
      return { go: open ? "on_true" : "on_false", note: open ? "open" : "closed" };
    }

    case "sms": {
      let to = tpl(ctx, node, "to").trim() || s.call.from;
      to = normalizeNumber(to) ?? to;
      if (!isE164(to)) return { go: "on_failed", note: `not a phone number: "${to.slice(0, 30)}"`, level: "warn" };
      const text = tpl(ctx, node, "text").trim().slice(0, 1600);
      if (!text) return { go: "on_failed", note: "the text is empty", level: "warn" };
      const refused = numberRefused(to);
      if (refused) { log(ctx, "warn", `SMS to ${to} refused: ${refused}`); return { go: "on_failed", note: refused, level: "warn" }; }
      if (ctx.sim) return { go: "next", note: `SMS to ${to} (simulated, not sent): ${text.slice(0, 120)}` };
      const perHour = telPermissions().outbound.smsPerHour;
      if (tsaDb.bump(`sms:${s.tsaId}:${hourKey(d.now())}`, 3600_000) > perHour) { log(ctx, "warn", `SMS to ${to} refused: more than ${perHour} SMS an hour from this TSA`); return { go: "on_failed", note: "the hourly SMS limit", level: "warn" }; }
      try {
        const from = tpl(ctx, node, "from").trim();
        const r = await d.sendSms({ to, ...(from ? { from } : {}), text });
        log(ctx, "info", `SMS to ${to}: ${r.status}`);
        return { go: "next", note: `SMS to ${to}: ${r.status}` };
      } catch (err) {
        log(ctx, "warn", `SMS to ${to} failed: ${(err as Error).message.slice(0, 160)}`);
        return { go: "on_failed", note: `SMS failed: ${(err as Error).message.slice(0, 120)}`, level: "warn" };
      }
    }

    case "room_message": return roomMessage(ctx, node);

    case "http": return http(ctx, node);

    case "function": {
      if (!telPermissions().tsa.functions) return { go: "on_failed", note: "running functions is off (Telephony › Permissions › TSA)", level: "warn" };
      const model = str(param(node, "model")).trim();
      if (!model) return { go: "on_failed", note: "no model chosen", level: "warn" };
      const ins = inputsOf(ctx, node);
      const inputs: Record<string, unknown> = { call: { ...s.call } };
      for (const [k, v] of Object.entries(ins)) inputs[k.toLowerCase()] = v;
      if (ctx.sim) return { go: "next", note: `would run the model ${model} with ${Object.keys(inputs).join(", ")} (simulated)` };
      try {
        const result = await d.runFunction(model, inputs, { timeoutMs: clamp(param(node, "timeout"), 1, 60, 10) * 1000, name: `tsa:${s.tsaId}`, lang: s.lang });
        setOut(ctx, node, "result", result);
        return { go: "next", note: `the model ${model} answered` };
      } catch (err) {
        log(ctx, "warn", `function ${model} failed: ${(err as Error).message.slice(0, 160)}`);
        return { go: "on_failed", note: (err as Error).message.slice(0, 160), level: "warn" };
      }
    }

    case "lookup": {
      const n = textOf(inputsOf(ctx, node).IN1).trim() || s.call.from;
      const info = numberInfo(n);
      setOut(ctx, node, "country", info?.iso2 ?? "");
      setOut(ctx, node, "type", info?.type ?? "");
      setOut(ctx, node, "national", info?.formatted.national ?? "");
      setOut(ctx, node, "e164", info?.e164 ?? "");
      setOut(ctx, node, "valid", Boolean(info && info.validLength));
      return { go: "next", note: info ? `${info.iso2} ${info.type}` : "not a number" };
    }

    case "inroute_add": {
      const type = str(param(node, "type")) === "user" ? "user" : "room";
      const room = tpl(ctx, node, "room").trim();
      if (!room) return { go: "on_failed", note: "no room", level: "warn" };
      const user = type === "user" ? tpl(ctx, node, "user").trim() : "";
      if (type === "user" && !user) return { go: "on_failed", note: "no member", level: "warn" };
      const code = tpl(ctx, node, "code").trim();
      if (code && !INROUTE_CODE.test(code)) return { go: "on_failed", note: "a code is 4–6 digits", level: "warn" };
      const ttl = Math.round(clamp(param(node, "ttl"), 30, Math.min(86_400, telPermissions().inroute.maxTtlSec), 600));
      const digits = Math.round(clamp(param(node, "digits"), 4, 6, 6));
      if (ctx.sim) {
        const c = code || String(Math.floor(d.random() * 10 ** digits)).padStart(digits, "0");
        const now = d.now();
        const entry: InrouteEntry = { code: c, type, room, user, label: `TSA ${s.tsaId} (simulated)`, ttlSec: ttl, createdAt: now, expiresAt: now + ttl * 1000, createdBy: { kind: "tsa", id: s.tsaId, run: s.id }, uses: 0, maxUses: 0 };
        (s.sim ??= { inroute: {} }).inroute[c] = entry;
        setOut(ctx, node, "code", c);
        setOut(ctx, node, "expires", entry.expiresAt);
        return { go: "next", note: `route code ${c} → ${type === "user" ? `member ${user}` : "the room"} (simulated: only this simulation knows it)` };
      }
      if (!telHooks.inroute) { log(ctx, "warn", "route codes cannot be added: the inroute table is not there"); return { go: "on_failed", note: "no inroute table", level: "warn" }; }
      try {
        const e = await telHooks.inroute.add({ ...(code ? { code } : { digits }), type, room, ...(user ? { user } : {}), ttl, label: `TSA ${s.tsaId}`, createdBy: { kind: "tsa", id: s.tsaId, run: s.id } });
        setOut(ctx, node, "code", e.code);
        setOut(ctx, node, "expires", e.expiresAt);
        log(ctx, "info", `route code ${mask(e.code)} added (${type}, ${ttl} s)`);
        return { go: "next", note: `route code ${mask(e.code)} added` };
      } catch (err) {
        log(ctx, "warn", `route code not added: ${(err as Error).message.slice(0, 160)}`);
        return { go: "on_failed", note: (err as Error).message.slice(0, 160), level: "warn" };
      }
    }

    case "log": {
      const text = tpl(ctx, node, "text").trim() || "(empty)";
      const level = str(param(node, "level")) as "info" | "notice" | "warn" | "error";
      log(ctx, ["info", "notice", "warn", "error"].includes(level) ? level : "info", text);
      return { go: "next", note: text.slice(0, 200), level: level === "warn" || level === "error" ? level : "info" };
    }
  }
  return { fail: `the tool "${(node as TsaNode).type}" cannot run` };
}

/* ---------------------------------------------------- tools with a wait */

async function onEvent(ctx: Ctx, node: TsaNode, ev: TsaEvent): Promise<Outcome> {
  const s = ctx.s;
  switch (node.type) {
    case "read_dtmf": {
      if (ev.kind !== "digits" && ev.kind !== "speech") break;
      const key = gatherKey(param(node, "finishOnKey"));
      let digits = (ev.kind === "digits" ? ev.digits : ev.text).replace(/[^0-9*#A-D]/g, "");
      if (key && digits.endsWith(key)) digits = digits.slice(0, -1);
      if (!digits) {
        const n = (s.attempts[node.id] ?? 0) + 1;
        const retries = Math.round(clamp(param(node, "retries"), 0, 5, 0));
        if (n <= retries) {
          s.attempts[node.id] = n;
          const again = [...s.lastActions].reverse().find((a) => "gather" in a);
          if (again) return { wait: "digits", actions: [again], note: `no digit — asking again (${n} of ${retries})` };
        }
        s.attempts[node.id] = 0;
        return { go: "on_timeout", note: "no digit" };
      }
      s.attempts[node.id] = 0;
      setOut(ctx, node, "digits", digits);
      return { go: "next", note: `${digits.length} digit${digits.length === 1 ? "" : "s"}` };
    }

    case "record": {
      if (ev.kind !== "recording") break;
      if (!ev.url || !(ev.durationSec > 0)) return { go: "on_timeout", note: "nothing was recorded" };
      setOut(ctx, node, "url", ev.url.startsWith("data:") ? "(simulated recording)" : ev.url);
      setOut(ctx, node, "recording_id", ev.id ?? "");
      setOut(ctx, node, "duration", Math.round(ev.durationSec));
      setOut(ctx, node, "digit", ev.digit ?? "");
      setOut(ctx, node, "transcript", "");
      let note = `recorded ${Math.round(ev.durationSec)} s`;
      if (param(node, "transcribe") === true) {
        try {
          const text = await transcribe(ctx, ev.url, str(param(node, "language")) || s.lang);
          setOut(ctx, node, "transcript", text);
          note += `, transcribed (${text.length} characters)`;
        } catch (err) {
          log(ctx, "warn", `transcription failed: ${(err as Error).message.slice(0, 160)}`);
          note += `, transcription failed: ${(err as Error).message.slice(0, 80)}`;
        }
      }
      log(ctx, "info", `recording of ${Math.round(ev.durationSec)} s`, { url: ev.url.startsWith("data:") ? "(simulated)" : ev.url, id: ev.id ?? "" });
      return { go: "next", note };
    }

    case "stt": {
      let text = "";
      let confidence: number | null = null;
      if (ev.kind === "speech") { text = ev.text.trim(); confidence = typeof ev.confidence === "number" ? ev.confidence : null; }
      else if (ev.kind === "digits") text = ev.digits;
      else if (ev.kind === "recording") {
        if (!ev.url || !(ev.durationSec > 0)) return { go: "on_timeout", note: "nothing was said" };
        try { text = await transcribe(ctx, ev.url, str(param(node, "language")) || s.lang); }
        catch (err) { log(ctx, "warn", `speech to text failed: ${(err as Error).message.slice(0, 160)}`); return { go: "on_failed", note: `speech to text failed: ${(err as Error).message.slice(0, 100)}`, level: "warn" }; }
      } else break;
      if (!text) return { go: "on_timeout", note: "nothing was said" };
      setOut(ctx, node, "text", text.slice(0, TSA_LIMITS.textLength));
      setOut(ctx, node, "confidence", confidence);
      return { go: "next", note: `heard: ${text.slice(0, 80)}` };
    }

    case "dial": {
      if (ev.kind !== "dial") break;
      setOut(ctx, node, "status", ev.status);
      setOut(ctx, node, "duration", Math.round(ev.durationSec ?? 0));
      log(ctx, "info", `dial ended: ${ev.status}${ev.durationSec ? ` (${Math.round(ev.durationSec)} s)` : ""}`);
      const port = ev.status === "answered" ? "on_answered" : ev.status === "busy" ? "on_busy" : ev.status === "no-answer" ? "on_no_answer" : "on_failed";
      return { go: port, note: ev.status };
    }

    case "route_audio": {
      if (ev.kind === "played" || (ev.kind === "route" && ev.ok)) { log(ctx, "info", "routed audio ended"); return { go: "on_success", note: "the routed audio ended" }; }
      if (ev.kind !== "route") break;
      if (ev.reason === "code") return codeError(ctx, node, ev.detail || "the code was refused");
      log(ctx, "warn", `routing failed: ${(ev.detail ?? "").slice(0, 160)}`);
      return { go: "on_failed", note: ev.detail || "routing failed", level: "warn" };
    }
  }
  return { fail: `"${node.id}" (${node.type}) got an event it cannot use (${ev.kind})` };
}

async function transcribe(ctx: Ctx, url: string, language: string): Promise<string> {
  const d = tsaDeps();
  const rec = await d.fetchRecording(ctx.s.provider, url, { allowData: ctx.sim });
  return (await d.stt({ audio: rec.bytes, mime: rec.mime, language, console: ctx.sim, actor: `tsa:${ctx.s.tsaId}` })).slice(0, TSA_LIMITS.textLength);
}

function codeError(ctx: Ctx, node: TsaNode, why: string): Outcome {
  const s = ctx.s;
  s.routeAttempts += 1;
  if (!ctx.sim && s.call.from) tsaDb.bump(`rf:${s.call.from}:${hourKey(tsaDeps().now())}`, 3600_000);
  log(ctx, "notice", `wrong route code (${why}); attempt ${s.routeAttempts} of ${telPermissions().inroute.maxAttemptsPerCall}`);
  return { go: "on_code_error", note: why };
}

async function routeAudio(ctx: Ctx, node: TsaNode): Promise<Outcome> {
  const s = ctx.s;
  const d = tsaDeps();
  if (s.offline) return { end: [], how: "the caller hung up" };
  const perms = telPermissions().inroute;
  if (s.routeAttempts >= perms.maxAttemptsPerCall) return { go: "on_code_error", note: `no more codes in this call (${perms.maxAttemptsPerCall} wrong already)` };
  if (!ctx.sim && s.call.from && tsaDb.count(`rf:${s.call.from}:${hourKey(d.now())}`) >= perms.maxFailuresPerCallerPerHour) {
    log(ctx, "warn", `route codes from ${s.call.from} refused for this hour (${perms.maxFailuresPerCallerPerHour} wrong)`);
    return { go: "on_code_error", note: "too many wrong codes from this caller this hour" };
  }
  const key = textOf(inputsOf(ctx, node).KEY).trim();
  if (!INROUTE_CODE.test(key)) return codeError(ctx, node, key ? "not 4–6 digits" : "no code");
  let entry: InrouteEntry | null = ctx.sim ? s.sim?.inroute[key] ?? null : null;
  if (!entry) {
    if (!telHooks.inroute) { log(ctx, "warn", "route codes cannot be checked: the inroute table is not there"); return { go: "on_failed", note: "no inroute table", level: "warn" }; }
    try { entry = await telHooks.inroute.lookup(key); }
    catch (err) { log(ctx, "warn", `inroute lookup failed: ${(err as Error).message.slice(0, 120)}`); return { go: "on_failed", note: "the inroute lookup failed", level: "warn" }; }
  }
  if (!entry || entry.expiresAt <= d.now()) return codeError(ctx, node, entry ? "the code expired" : "no such code");
  const consume = param(node, "consume") === true;
  const usedKey = `used:${entry.code}:${entry.createdAt}`;
  if (consume && tsaDb.count(usedKey) > 0) return codeError(ctx, node, "the one-time code was used already");
  setOut(ctx, node, "type", entry.type);
  setOut(ctx, node, "target", entry.type === "user" ? entry.user : entry.room);
  // 6.10 (G-03): the log and the trace name the room by its hash, never its blind id.
  const what = entry.type === "user" ? `member ${entry.user} of room ${hashRoom(entry.room) ?? "?"}` : `room ${hashRoom(entry.room) ?? "?"}`;
  if (ctx.sim) {
    return { wait: "route", actions: [], note: `the code is right: the audio WOULD be routed to ${what} (simulated — send a "route" event to end it)` };
  }
  if (!telHooks.routeAudio) { log(ctx, "warn", "the code is right but nothing can route audio (the media bridge is not there)"); return { go: "on_failed", note: "no media bridge", level: "warn" }; }
  const mode = param(node, "mode") === "text" ? "text" : "fail";
  let r;
  try { r = await telHooks.routeAudio(s.ref, entry, { announce: tpl(ctx, node, "announce").trim(), mode, sessionId: s.id }); }
  catch (err) { log(ctx, "warn", `routing failed: ${(err as Error).message.slice(0, 160)}`); return { go: "on_failed", note: "routing failed", level: "warn" }; }
  if (!r.ok) {
    if (r.reason === "code") return codeError(ctx, node, r.detail || "the code was refused");
    log(ctx, "warn", `routing failed: ${r.detail.slice(0, 160)}`);
    return { go: "on_failed", note: r.detail || "routing failed", level: "warn" };
  }
  try { await telHooks.inroute?.used(entry.code); } catch { /* counting a use never breaks the call */ }
  if (consume) tsaDb.bump(usedKey, Math.max(60_000, entry.expiresAt - d.now()));
  log(ctx, "notice", `audio routed to ${what} by code ${mask(entry.code)}`, { type: entry.type, room: hashRoom(entry.room) ?? "", user: entry.user, detail: r.detail });
  const actions = [...r.actions];
  const last = actions.at(-1);
  if (!last || !("redirect" in last || "hangup" in last)) actions.push({ redirect: { url: cbUrl(ctx, node.id, "played") } });
  return { wait: "route", actions, note: `routed to ${what}` };
}

async function dial(ctx: Ctx, node: TsaNode): Promise<Outcome> {
  const s = ctx.s;
  const d = tsaDeps();
  if (s.offline) return { end: [], how: "the caller hung up" };
  const kind = param(node, "kind") === "sip" ? "sip" : "number";
  let to = tpl(ctx, node, "to").trim();
  if (kind === "number") {
    const n = isE164(to) ? to : normalizeNumber(to);
    if (!n) return { go: "on_failed", note: `not a phone number: "${to.slice(0, 30)}"`, level: "warn" };
    to = n;
    const refused = numberRefused(to);
    if (refused) { log(ctx, "warn", `dial ${to} refused: ${refused}`); return { go: "on_failed", note: refused, level: "warn" }; }
  } else {
    if (!/^sip:/i.test(to)) to = `sip:${to}`;
    if (!/^sip:[^\s@]+@[^\s@]+$/i.test(to)) return { go: "on_failed", note: `not a SIP URI: "${to.slice(0, 40)}"`, level: "warn" };
  }
  let callerId = tpl(ctx, node, "callerIdNumber").trim();
  let callerName = tpl(ctx, node, "callerIdName").trim();
  let presentation: "allowed" | "restricted" = "allowed";
  let trunk = null as Awaited<ReturnType<typeof d.trunk>>;
  const via = str(param(node, "via")) || "rules";
  const notes: string[] = [];
  if (via === "rules") {
    if (telHooks.decide) {
      try {
        const dec = await telHooks.decide({ direction: "outbound", from: callerId || s.call.did || s.call.to, to, provider: s.provider as ProviderId, source: "tsa" });
        if (dec.target.kind === "state") { log(ctx, "notice", `dial ${to} refused by the outbound rules (${dec.target.state}${dec.ruleLabel ? `, ${dec.ruleLabel}` : ""})`); return { go: "on_failed", note: `the outbound rules refuse it (${dec.target.state})`, level: "warn" }; }
        if (dec.service?.kind === "sip") {
          trunk = await d.trunk(dec.service.trunk, !ctx.sim);
          if (!trunk) return { go: "on_failed", note: `the rule's SIP trunk "${dec.service.trunk}" is not there`, level: "warn" };
          callerId ||= dec.service.callerId.number;
          callerName ||= dec.service.callerId.name;
          presentation = dec.service.callerId.presentation;
        }
        if (dec.service && dec.service.provider !== s.provider) notes.push(`the rule names ${dec.service.provider}; a transfer goes through this call's provider (${s.provider})`);
        if (dec.rule) notes.push(`rule ${dec.ruleLabel || dec.rule}`);
      } catch (err) { notes.push(`the outbound rules could not answer (${(err as Error).message.slice(0, 80)})`); }
    } else notes.push("no outbound rules — through the call's provider");
  } else if (via === "trunk") {
    trunk = await d.trunk(str(param(node, "trunk")), !ctx.sim);
    if (!trunk) return { go: "on_failed", note: `no SIP trunk "${str(param(node, "trunk")).slice(0, 40)}"`, level: "warn" };
  }
  callerId ||= s.direction === "inbound" ? s.call.did || s.call.to : s.call.from;
  const timeout = Math.round(clamp(param(node, "timeout"), 5, 120, 30));
  const action: CallAction = { dial: {
    to, kind, action: cbUrl(ctx, node.id), ...(callerId ? { callerId } : {}), ...(callerName ? { callerName } : {}), presentation, timeout,
    ...(param(node, "record") === true ? { record: true } : {}), ...(trunk ? { trunk } : {}),
  } };
  const where = `${to}${trunk ? ` over SIP trunk ${trunk.id}` : ""}`;
  log(ctx, "info", `dials ${where}`, { callerId, notes });
  return { wait: "dial", actions: [action], timeoutSec: timeout, note: `${ctx.sim ? "would dial" : "dials"} ${where}${notes.length ? ` — ${notes.join("; ")}` : ""}` };
}

async function roomMessage(ctx: Ctx, node: TsaNode): Promise<Outcome> {
  const s = ctx.s;
  const d = tsaDeps();
  const text = tpl(ctx, node, "text").trim();
  if (!text) return { go: "on_failed", note: "the text is empty", level: "warn" };
  let room = "";
  let member = tpl(ctx, node, "member").trim();
  if (param(node, "target") === "inroute") {
    const code = textOf(inputsOf(ctx, node).IN1).trim();
    let entry: InrouteEntry | null = ctx.sim ? s.sim?.inroute[code] ?? null : null;
    if (!entry && INROUTE_CODE.test(code) && telHooks.inroute) { try { entry = await telHooks.inroute.lookup(code); } catch { entry = null; } }
    if (!entry || entry.expiresAt <= d.now()) return { go: "on_failed", note: "no live inroute code in IN1", level: "warn" };
    room = entry.room;
    if (!member && entry.type === "user") member = entry.user;
  } else room = tpl(ctx, node, "room").trim();
  if (!room) return { go: "on_failed", note: "no room", level: "warn" };
  const hash = /^[0-9a-f]{16}$/.test(room) ? room : hashRoom(room)!;
  const target = member ? (member.startsWith("p-") ? { peerId: member } : { name: member.replace(/^@/, "") }) : undefined;
  if (ctx.sim) return { go: "next", note: `would post into the room${member ? ` (to ${member})` : ""} (simulated): ${text.slice(0, 120)}` };
  if (!d.notice) { log(ctx, "warn", "a room message can only be posted by the main service"); return { go: "on_failed", note: "rooms are not reachable from this process", level: "warn" }; }
  const n = d.notice(hash, { kind: "message", text: text.slice(0, 2000), level: "info", from: `☎ ${s.tsaName}`.slice(0, 60) }, target);
  if (!n) { log(ctx, "notice", `room message not delivered: nobody${member ? ` named ${member}` : ""} is connected in the room`); return { go: "on_failed", note: "nobody in the room is connected", level: "warn" }; }
  log(ctx, "info", `room message delivered to ${n} connection${n === 1 ? "" : "s"}`);
  return { go: "next", note: `posted to ${n} connection${n === 1 ? "" : "s"}` };
}

async function http(ctx: Ctx, node: TsaNode): Promise<Outcome> {
  const d = tsaDeps();
  const hosts = telPermissions().tsa.httpHosts;
  if (!hosts.length) return { go: "on_failed", note: "the HTTP tool is off: no host is allowed (Telephony › Permissions › TSA)", level: "warn" };
  const url = tpl(ctx, node, "url", { encode: encodeURIComponent }).trim();
  let u: URL;
  try { u = new URL(url); } catch { return { go: "on_failed", note: `not a URL: "${url.slice(0, 60)}"`, level: "warn" }; }
  if (u.protocol !== "https:") return { go: "on_failed", note: "only https://", level: "warn" };
  if (!hostAllowed(u.hostname, hosts)) { log(ctx, "warn", `HTTP to ${u.hostname} refused: not in the allowed hosts`); return { go: "on_failed", note: `${u.hostname} is not an allowed host`, level: "warn" }; }
  const method = (str(param(node, "method")) || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  const secret = ctx.sim ? undefined : (name: string) => process.env[`TSA_SECRET_${name.toUpperCase()}`]?.trim();
  for (const line of Array.isArray(param(node, "headers")) ? (param(node, "headers") as unknown[]).map(str) : []) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) continue;
    headers[name.toLowerCase()] = renderTemplate(line.slice(i + 1).trim(), scopeOf(ctx, node), { secret, max: 4096 }).replace(/[\r\n]/g, " ");
  }
  let body: string | undefined;
  if (["POST", "PUT", "PATCH"].includes(method)) {
    body = tpl(ctx, node, "body", { max: 65_536 });
    if (!headers["content-type"]) headers["content-type"] = /^\s*[{[]/.test(body) ? "application/json" : "text/plain; charset=utf-8";
  }
  if (ctx.sim) return { go: "on_success", note: `would call ${method} ${u.origin}${u.pathname} (simulated, not sent)` };
  try {
    const r = await d.http({ method, url: u.href, headers, ...(body !== undefined ? { body } : {}), timeoutMs: clamp(param(node, "timeout"), 1, 15, 5) * 1000, maxBytes: 256 * 1024 });
    setOut(ctx, node, "status", r.status);
    setOut(ctx, node, "body", r.text.slice(0, VALUE_MAX));
    setOut(ctx, node, "json", r.json === undefined ? null : r.json);
    const okStatus = r.status >= 200 && r.status < 300;
    log(ctx, okStatus ? "info" : "warn", `HTTP ${method} ${u.hostname}${u.pathname} → ${r.status}`);
    return { go: okStatus ? "on_success" : "on_failed", note: `${method} ${u.hostname} → ${r.status}`, ...(okStatus ? {} : { level: "warn" as const }) };
  } catch (err) {
    log(ctx, "warn", `HTTP ${method} ${u.hostname} failed: ${(err as Error).message.slice(0, 160)}`);
    return { go: "on_failed", note: (err as Error).message.slice(0, 160), level: "warn" };
  }
}

/** Opening hours: inside the window on the listed days, not on a closed date. */
export function isOpen(node: Pick<TsaNode, "type" | "params">, now: number): boolean {
  const p = (k: string) => param(node as TsaNode, k);
  const c = clockIn(now, str(p("timezone")) || "Europe/Prague");
  const date = `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
  const closed = Array.isArray(p("closedOn")) ? (p("closedOn") as unknown[]).map((x) => str(x).trim()) : [];
  if (closed.includes(date) || closed.includes(date.slice(5))) return false;
  const days = parseDays(str(p("days"))) ?? new Set([1, 2, 3, 4, 5, 6, 7]);
  const mins = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const from = mins(str(p("from"))) ?? 0;
  const to = mins(str(p("to"))) ?? 24 * 60;
  const t = c.hour * 60 + c.minute;
  if (from < to) return days.has(c.weekday) && t >= from && t < to;
  if (from === to) return days.has(c.weekday);
  // Overnight (22:00–06:00): the evening of a listed day and the morning after it.
  const prev = c.weekday === 1 ? 7 : c.weekday - 1;
  return (days.has(c.weekday) && t >= from) || (days.has(prev) && t < to);
}

/** WAV gain in dB (the TTS's volume); other formats unchanged. */
function applyVolume(audio: Uint8Array, mime: string, db: number): Uint8Array {
  if (!db || !/wav/i.test(mime) || audio.length < 44) return audio;
  const out = new Uint8Array(audio);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // Find the "data" chunk of a 16-bit PCM WAV.
  let off = 12;
  let bits = 16;
  while (off + 8 <= out.length) {
    const id = String.fromCharCode(out[off], out[off + 1], out[off + 2], out[off + 3]);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") bits = view.getUint16(off + 22, true);
    if (id === "data") {
      if (bits !== 16) return audio;
      const g = 10 ** (db / 20);
      for (let i = off + 8; i + 1 < Math.min(out.length, off + 8 + size); i += 2) view.setInt16(i, Math.max(-32768, Math.min(32767, Math.round(view.getInt16(i, true) * g))), true);
      return out;
    }
    off += 8 + size + (size % 2);
  }
  return audio;
}

function storeAudio(ctx: Ctx, audio: Uint8Array, mime: string, text: string): string {
  const token = randomBytes(18).toString("base64url");
  const now = tsaDeps().now();
  tsaDb.audio.put({ id: token, mime: mime || "audio/wav", data: Buffer.from(audio).toString("base64"), text: text.slice(0, 500), session: ctx.s.id, createdAt: now, expiresAt: now + AUDIO_TTL_MS });
  return `${base(ctx)}/wh/tsa/audio/${token}`;
}

/* ------------------------------------------------------------- the walk */

/** A loop entered through its "in" starts over: it and the loops inside it are dropped. */
function enterLoop(ctx: Ctx, node: TsaNode): void {
  const i = ctx.s.loops.findIndex((f) => f.node === node.id);
  if (i >= 0) ctx.s.loops.splice(i);
}

/** A body path ended: the innermost loop's next round, or its done. */
function loopReturn(ctx: Ctx): Cursor | null {
  const s = ctx.s;
  for (;;) {
    const f = s.loops.at(-1);
    if (!f) return null;
    const node = ctx.ix.nodes.get(f.node);
    if (!node) { s.loops.pop(); continue; }
    const rounds = (s.rounds[f.node] ?? 0) + 1;
    s.rounds[f.node] = rounds;
    if (node.type === "for") {
      f.index += f.step ?? 1;
      const inRange = (f.step ?? 1) > 0 ? f.index <= (f.until ?? f.index) : f.index >= (f.until ?? f.index);
      if (inRange && rounds < TSA_LIMITS.loopIterations) {
        setOut(ctx, node, "index", f.index);
        trace(ctx, node, "body", `index ${f.index}`);
        return { follow: { node: f.node, port: "body" } };
      }
    } else {
      f.index += 1;
      const max = Math.min(f.until ?? 3, TSA_LIMITS.loopIterations);
      if (f.index < max) {
        const r = runFormula(str(param(node, "formula")), scopeOf(ctx, node));
        if (r.ok && truthy(r.value)) {
          setOut(ctx, node, "index", f.index);
          trace(ctx, node, "body", `round ${f.index + 1}`);
          return { follow: { node: f.node, port: "body" } };
        }
      } else trace(ctx, node, undefined, `${max} rounds — the limit`, "warn");
    }
    s.loops.pop();
    trace(ctx, node, "done");
    return { follow: { node: f.node, port: "done" } };
  }
}

/** The node a trace line belongs to (by id; a stand-in when it is gone). */
const nodeRef = (ctx: Ctx, id: string | null | undefined): Pick<TsaNode, "id" | "type"> => ctx.ix.nodes.get(id ?? "") ?? { id: id || "start", type: "start" };

function finish(ctx: Ctx, how: string, actions: CallAction[] = [], at?: string): void {
  const s = ctx.s;
  for (const a of actions) pushCall(ctx, a);
  trace(ctx, nodeRef(ctx, at ?? s.at), undefined, how);
  s.status = "ended";
  s.at = null;
  s.waiting = null;
  s.cont = null;
  s.endedAt = tsaDeps().now();
  log(ctx, "info", `ended: ${how} (${s.steps} steps)`);
}

function fail(ctx: Ctx, message: string, node?: TsaNode): void {
  const s = ctx.s;
  trace(ctx, node ?? nodeRef(ctx, s.at), undefined, message, "error");
  log(ctx, "error", `stopped: ${message}`, { node: node?.id ?? s.at });
  if (!s.offline) {
    if (!s.answered && s.direction === "inbound") ctx.actions.push({ reject: { reason: "congestion" } });
    else ctx.actions.push({ say: { text: apology(s.lang), language: s.lang } }, { hangup: {} });
  }
  s.status = "failed";
  s.at = null;
  s.waiting = null;
  s.cont = null;
  s.endedAt = tsaDeps().now();
}

/** Ends the turn here with a redirect back: the session goes on at `cursor` when the provider returns. */
function yieldTurn(ctx: Ctx, cursor: Cursor, note: string): void {
  const s = ctx.s;
  const at = "run" in cursor ? cursor.run : cursor.follow.node;
  ctx.actions.push({ redirect: { url: cbUrl(ctx, at, "played") } });
  s.cont = cursor;
  s.waiting = { node: at, for: "played", since: tsaDeps().now() };
  s.status = "waiting";
  trace(ctx, nodeRef(ctx, at), undefined, note);
}

/** Counts a step against the limits; false when the turn is over (yielded, failed or past the call's time). */
function step(ctx: Ctx, cursor: Cursor): boolean {
  const s = ctx.s;
  if (s.steps + 1 > TSA_LIMITS.stepsPerCall) { fail(ctx, `more than ${TSA_LIMITS.stepsPerCall} steps in one call — a runaway flow`); return false; }
  if (ctx.turnSteps + 1 > TSA_LIMITS.stepsPerTurn || ctx.actions.length >= MAX_TURN_ACTIONS) {
    if (ctx.audio && !s.offline) { yieldTurn(ctx, cursor, "continues after the audio plays"); return false; }
    fail(ctx, `more than ${TSA_LIMITS.stepsPerTurn} steps without anything for the caller — a cycle that never waits`);
    return false;
  }
  if (tsaDeps().now() > s.deadline) {
    log(ctx, "notice", "the longest call time was reached");
    finish(ctx, "the longest call time was reached", [{ hangup: {} }]);
    return false;
  }
  s.steps += 1;
  ctx.turnSteps += 1;
  return true;
}

/** Applies a node's outcome: where to go on, or null when the turn is over. */
function apply(ctx: Ctx, node: TsaNode, out: Outcome): Cursor | null {
  const s = ctx.s;
  if ("fail" in out) { fail(ctx, out.fail, node); return null; }
  if ("end" in out) { finish(ctx, out.how, out.end, node.id); return null; }
  if ("brk" in out) {
    const f = s.loops.pop();
    trace(ctx, node, undefined, f ? `leaves the loop "${f.node}"` : "not in a loop — the flow ends");
    if (!f) { finish(ctx, "the flow ended (Break outside a loop)", [{ hangup: {} }], node.id); return null; }
    trace(ctx, ctx.ix.nodes.get(f.node) ?? node, "done");
    return { follow: { node: f.node, port: "done" } };
  }
  if ("wait" in out) {
    for (const a of out.actions) pushCall(ctx, a);
    s.waiting = { node: node.id, for: out.wait, since: tsaDeps().now(), ...(out.timeoutSec ? { timeoutSec: out.timeoutSec } : {}) };
    s.waitMode = out.mode ?? "";
    s.status = "waiting";
    trace(ctx, node, undefined, out.note ?? `waits for ${out.wait}`);
    return null;
  }
  trace(ctx, node, out.go, out.note, out.level);
  const next: Cursor = { follow: { node: node.id, port: out.go } };
  if (out.yield) {
    yieldTurn(ctx, next, out.yield.streamSec ? `the stream plays (up to ${out.yield.streamSec} s)` : "continues after the audio plays");
    if (out.yield.streamSec && !ctx.sim) ctx.timers.push({ node: node.id, ms: out.yield.streamSec * 1000 });
    return null;
  }
  return next;
}

async function drive(ctx: Ctx, from: Cursor): Promise<void> {
  let cursor: Cursor | null = from;
  while (cursor) {
    if ("follow" in cursor) {
      const { node: from, port } = cursor.follow;
      const target = flowTarget(ctx.ix, from, port);
      if (target) { cursor = { run: target }; continue; }
      if (ctx.s.loops.length) {
        if (!step(ctx, cursor)) return;
        cursor = loopReturn(ctx);
        if (cursor) continue;
      }
      finish(ctx, `the flow ended ("${port}" of "${from}" leads nowhere)`, [{ hangup: {} }], from);
      return;
    }
    const node = ctx.ix.nodes.get(cursor.run);
    if (!node) { fail(ctx, `the node "${cursor.run}" is not in the graph`); return; }
    if (!step(ctx, cursor)) return;
    ctx.s.at = node.id;
    let out: Outcome;
    try { out = await runNode(ctx, node); }
    catch (err) { out = { fail: err instanceof TsaFailure ? err.message : `"${node.id}" failed: ${(err as Error).message}` }; }
    cursor = apply(ctx, node, out);
  }
}

/* ------------------------------------------------------------- sessions */

/** Trunk passwords never stay in the stored session (a repeated webhook gets them looked up again). */
function redact(actions: CallAction[]): CallAction[] {
  return actions.map((a) => ("dial" in a && a.dial.trunk?.password ? { dial: { ...a.dial, trunk: { ...a.dial.trunk, password: undefined } } } : a)) as CallAction[];
}
async function rehydrate(actions: CallAction[], sim: boolean): Promise<CallAction[]> {
  const out: CallAction[] = [];
  for (const a of actions) {
    if ("dial" in a && a.dial.trunk && !sim) {
      const t = await tsaDeps().trunk(a.dial.trunk.id, true);
      out.push({ dial: { ...a.dial, trunk: t ?? a.dial.trunk } });
    } else out.push(a);
  }
  return out;
}

const SESSION_KEYS = ["id", "tsaId", "tsaVersion", "callId", "provider", "direction", "call", "vars", "values", "at", "waiting", "loops", "steps", "status", "startedAt", "updatedAt", "endedAt", "trace"] as const;

/** The session as the contract shows it (no call token, nothing internal). */
export function publicSession(s: StoredSession): TsaSession {
  const out: Record<string, unknown> = {};
  for (const k of SESSION_KEYS) out[k] = s[k];
  return JSON.parse(JSON.stringify(out)) as TsaSession;
}

function ctxOf(s: StoredSession, graph: TsaGraph): Ctx {
  return { s, g: graph, ix: indexGraph(graph), actions: [], turnSteps: 0, audio: false, bargeSay: null, sim: s.callId.startsWith("sim:"), timers: [] };
}

function save(ctx: Ctx): TsaTurn {
  const s = ctx.s;
  s.updatedAt = tsaDeps().now();
  s.lastActions = redact(ctx.actions);
  tsaDb.sessions.put(s);
  for (const t of ctx.timers) {
    const timer = setTimeout(() => { void stopStream(s.id, t.node); }, t.ms);
    timer.unref?.();
  }
  return { session: publicSession(s), actions: ctx.actions };
}

/** A stream's time is up: if the session still waits for it, the call is redirected on. */
async function stopStream(sessionId: string, node: string): Promise<void> {
  try {
    await tsaDb.ready();
    const s = tsaDb.sessions.get(sessionId);
    if (!s || s.waiting?.for !== "played" || s.waiting.node !== node || s.status !== "waiting") return;
    const b = publicBaseUrl();
    if (!b) return;
    await tsaDeps().steer(s.callId, [{ redirect: { url: `${b}/wh/tel/${encodeURIComponent(s.ref.token)}/tsa?s=${encodeURIComponent(s.id)}&n=${encodeURIComponent(node)}&e=played` } }]);
  } catch (err) {
    telLog({ kind: "tsa", level: "warn", summary: `a stream could not be stopped: ${(err as Error).message.slice(0, 160)}`, tsaSession: sessionId });
  }
}

const locks = new Map<string, Promise<unknown>>();
/** One turn of a session at a time (in this process). */
function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(id, tail);
  void tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}

function cleanVars(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 100)) {
    const name = k.replace(/^\$/, "");
    if (VAR_NAME.test(name)) out[name] = bounded(val);
  }
  return out;
}

let lastPrune = 0;

/** Starts a TSA on a call (its published version; `draft` for tests and the simulator). */
export async function startTsa(call: TsaCallRef, tsaId: string, opts: { draft?: boolean; vars?: Record<string, unknown> } = {}): Promise<TsaTurn> {
  await tsaDb.ready();
  const d = tsaDeps();
  const now = d.now();
  if (now - lastPrune > 10 * 60_000) { lastPrune = now; tsaDb.prune(now); }
  const tsa: Tsa | null = tsaStore.get(tsaId);
  const graph = tsa ? (opts.draft ? tsa.graph : tsa.published?.graph ?? null) : null;
  const s: StoredSession = {
    id: telId("ts"), tsaId, tsaVersion: opts.draft ? 0 : tsa?.published?.version ?? 0, callId: call.id, provider: call.provider, direction: call.direction,
    call: { id: call.id, from: call.from, to: call.to, did: call.did, direction: call.direction, provider: call.provider },
    vars: cleanVars(opts.vars), values: {}, at: null, waiting: null, loops: [], steps: 0, status: "running",
    startedAt: now, updatedAt: now, endedAt: null, trace: [],
    ref: { ...call }, graphKey: graph ? tsaDb.putGraph(graph) : "", tsaName: tsa?.name ?? tsaId, draft: Boolean(opts.draft), lang: "cs-CZ",
    answered: call.direction === "outbound", offline: false, attempts: {}, routeAttempts: 0, rounds: {}, cont: null, lastActions: [],
    deadline: now + TSA_LIMITS.maxCallSeconds * 1000, traceCount: 0, sim: call.id.startsWith("sim:") ? { inroute: {} } : null, waitMode: "",
  };
  const ctx = ctxOf(s, graph ?? { nodes: [], edges: [] });
  if (!graph) {
    fail(ctx, tsa ? `the TSA "${tsaId}" is not published` : `there is no TSA "${tsaId}"`);
    return save(ctx);
  }
  if (!ctx.ix.start) { fail(ctx, `the TSA "${tsaId}" has no Start`); return save(ctx); }
  log(ctx, "info", `started (${opts.draft ? "draft" : `v${s.tsaVersion}`}) on an ${call.direction} call from ${call.from || "?"} to ${call.to || "?"}`);
  return locked(s.id, async () => {
    try { await drive(ctx, { run: ctx.ix.start!.id }); }
    catch (err) { fail(ctx, (err as Error).message); }
    return save(ctx);
  });
}

/** Can this event answer what the session waits for? */
function accepts(w: NonNullable<TsaSession["waiting"]>, mode: string, ev: TsaEvent): boolean {
  if (ev.kind === w.for) return true;
  if (w.for === "speech" && ev.kind === "digits") return true;
  if (w.for === "recording" && mode === "stt" && ev.kind === "speech") return true;
  if (w.for === "route" && ev.kind === "played") return true;
  return false;
}

/** Resumes a waiting session with what happened on the call. */
export async function resumeTsa(sessionId: string, event: TsaEvent): Promise<TsaTurn> {
  await tsaDb.ready();
  return locked(sessionId, async () => {
    const s = tsaDb.sessions.get(sessionId);
    if (!s) throw new Error(`no TSA session "${String(sessionId).slice(0, 64)}"`);
    const ev = normalizeEvent(event);
    const sim = s.callId.startsWith("sim:");
    if (!ev) return { session: publicSession(s), actions: s.offline || s.status === "ended" || s.status === "failed" ? [] : await rehydrate(s.lastActions, sim) };
    if (s.status === "ended" || s.status === "failed") return { session: publicSession(s), actions: ev.kind === "hangup" ? [] : [{ hangup: {} }] };
    const stored = s.graphKey ? tsaDb.graphs.get(s.graphKey) : null;
    const ctx = ctxOf(s, stored?.graph ?? { nodes: [], edges: [] });
    if (!stored) { fail(ctx, "the graph this call runs is gone"); return save(ctx); }

    if (ev.kind === "hangup") {
      if (s.waiting?.for === "recording" && s.waitMode === "record") {
        // The recording is still on its way: the rest of the flow that needs no caller runs when it comes.
        s.offline = true;
        trace(ctx, nodeRef(ctx, s.waiting.node), undefined, `the caller hung up${ev.cause ? ` (${ev.cause})` : ""} — waiting for the recording`);
        ctx.actions = [];
        return save(ctx);
      }
      s.offline = true;
      finish(ctx, `the caller hung up${ev.cause ? ` (${ev.cause})` : ""}`);
      return save(ctx);
    }
    if (ev.kind === "error") { fail(ctx, `the provider reported an error: ${ev.message.slice(0, 200)}`); return save(ctx); }

    const w = s.waiting;
    if (!w || !accepts(w, s.waitMode, ev)) {
      // A repeated or stale callback (or "started" for a turn already given): the same answer again.
      trace(ctx, nodeRef(ctx, s.at), undefined, `${ev.kind} ignored (${w ? `waiting for ${w.for}` : "not waiting"})`);
      tsaDb.sessions.put({ ...s, updatedAt: tsaDeps().now() });
      return { session: publicSession(s), actions: s.offline ? [] : await rehydrate(s.lastActions, sim) };
    }
    s.waiting = null;
    s.status = "running";
    try {
      if (w.for === "played" && ev.kind === "played") {
        const cur = s.cont ?? { follow: { node: w.node, port: "next" } };
        s.cont = null;
        await drive(ctx, cur);
        return save(ctx);
      }
      const node = ctx.ix.nodes.get(w.node);
      if (!node) { fail(ctx, `the node "${w.node}" is not in the graph`); return save(ctx); }
      s.at = node.id;
      let out: Outcome;
      try { out = await onEvent(ctx, node, ev); }
      catch (err) { out = { fail: err instanceof TsaFailure ? err.message : `"${node.id}" failed: ${(err as Error).message}` }; }
      // After the caller left (offline) the same walk runs: what needs the caller ends it, the rest (a message, a log) runs.
      const next = apply(ctx, node, out);
      if (next) await drive(ctx, next);
    } catch (err) { fail(ctx, (err as Error).message); }
    return save(ctx);
  });
}

/** A TsaEvent from outside, checked and bounded; null when it is not one. */
export function normalizeEvent(raw: unknown): TsaEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const s = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== "" && v !== null && v !== undefined ? Number(v) : undefined);
  switch (e.kind) {
    case "started": return { kind: "started" };
    case "digits": return { kind: "digits", digits: s(e.digits, 64).replace(/[^0-9*#A-D]/g, ""), ...(e.timedOut === true ? { timedOut: true } : {}), ...(typeof e.finishedBy === "string" ? { finishedBy: s(e.finishedBy, 8) } : {}) };
    case "speech": return { kind: "speech", text: s(e.text, TSA_LIMITS.textLength), ...(n(e.confidence) !== undefined ? { confidence: n(e.confidence)! } : {}), ...(e.timedOut === true ? { timedOut: true } : {}) };
    case "recording": return { kind: "recording", url: s(e.url, 20_000_000), ...(typeof e.id === "string" ? { id: s(e.id, 200) } : {}), durationSec: Math.max(0, n(e.durationSec) ?? 0), ...(typeof e.digit === "string" ? { digit: s(e.digit, 4) } : {}), ...(e.timedOut === true ? { timedOut: true } : {}) };
    case "played": return { kind: "played" };
    case "dial": {
      const st = ["answered", "busy", "no-answer", "failed", "canceled"].includes(e.status as string) ? (e.status as "answered") : "failed";
      return { kind: "dial", status: st, ...(n(e.durationSec) !== undefined ? { durationSec: n(e.durationSec)! } : {}) };
    }
    case "route": return { kind: "route", ok: e.ok === true, ...(e.reason === "code" || e.reason === "failed" ? { reason: e.reason } : {}), ...(typeof e.detail === "string" ? { detail: s(e.detail, 300) } : {}) };
    case "hangup": return { kind: "hangup", ...(typeof e.cause === "string" ? { cause: s(e.cause, 120) } : {}) };
    case "error": return { kind: "error", message: s(e.message, 300) || "error" };
    default: return null;
  }
}

/** A stored session (the console, the simulator). */
export async function getTsaSession(id: string): Promise<StoredSession | null> {
  await tsaDb.ready();
  return tsaDb.sessions.get(id);
}

// The runtime is what the rest of the module calls (inbound rules, outbound calls, the simulator).
telHooks.tsa = { start: startTsa, resume: resumeTsa };
