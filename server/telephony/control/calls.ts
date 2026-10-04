// Calls through the rules and calls that run a TSA (6.9), on the main service.
//
// Inbound: every call that reaches a provider's voice webhook — Twilio's
// Voice URL (/wh/twilio/voice, /wh/tel/in/twilio, a SIP Domain's), the
// Vonage application's answer URL (/wh/vonage/answer, PSIP domains too), a
// Telnyx call.initiated on /wh/telnyx/events (SIP subdomain / connection
// calls too) — and is not for a number the audio bridge lends, is asked of
// the inbound rules (telHooks.decide) with the provider and the service it
// came by ("sip" when it arrived over SIP, else "app"). A call to the test
// SIP address counts as a call to its test DID. The answer:
//   state   busy / congestion / rejected / hangup, rendered for the provider
//           (Twilio <Reject>, Telnyx reject, Vonage: an NCCO cannot refuse —
//           the call ends at once)
//   tsa     a TelCall with its webhook token and telHooks.tsa.start → the
//           first turn's actions (TwiML / NCCO as the webhook's answer;
//           Telnyx: answer, then run the commands on call.answered)
// No rules part (no decide) or no TSA runtime → null: the webhook answers as
// it always did. Limits (telPermissions().inbound): concurrent inbound calls
// and calls per caller per hour → busy.
//
// A TSA call's later webhooks come here through the engine (call.tsa):
//   /wh/tel/<token>/tsa?s=<session>&n=<node>[&e=played]   a turn's callback
//     Twilio: Gather / Record / Dial action, a Redirect; Vonage: input /
//     record / connect events, a notify — turned into a TsaEvent and
//     telHooks.tsa.resume(s, event) → the next turn, rendered
//   the call's own events (answer, status; Telnyx: everything) — a final
//     status resumes the session with { kind: "hangup" }
// Telnyx Call Control is asynchronous: the turn's commands run up to the
// first one that waits, and the provider event that ends the wait (speak
// ended, gather ended, a final transcription, the recording saved, the
// dialled leg's hangup) resumes the session — see telnyxRun below.

import type { Request } from "express";
import { adapter } from "../providers";
import { FINAL_CALL_STATUSES, type CallAction, type NormalizedCallEvent, type ProviderId } from "../providers/types";
import { renderTwiml, TWILIO_DIAL_STATUS } from "../providers/twilio";
import { renderNcco, type VonageAdapter } from "../providers/vonage";
import { telnyxCommands, telnyxDialStatus, type TelnyxAdapter } from "../providers/telnyx";
import { isSipAddress, sipHost, sipUser } from "../providers/sip-uri";
import { applyCallEvent, save, setTsaCallHandler, type WebhookReply } from "../engine";
import { telId, telStore, telToken, type TelCall, type TelTsaWait } from "../tel-store";
import { loadTelephonyFile } from "../store";
import { telHooks, telPermissions, type TsaCallRef, type TsaTurn } from "./hooks";
import type { RouteDecision, RouteState, TestSipAddress } from "./types";
import type { TsaEvent } from "../tsa/types";
import { redact, redactString, writeLog } from "./log";
import { whContext, whNote } from "./wh-context";

const env = (name: string): string => process.env[name]?.trim() || "";
const isFinal = (s: TelCall["status"]) => FINAL_CALL_STATUSES.includes(s);

const json = (status: number, v: unknown): WebhookReply => ({ status, type: "application/json", body: JSON.stringify(v) });
const OK = (): WebhookReply => json(200, { ok: true });
/** Vonage: "go on with the NCCO you have" (an empty answer to an event). */
const CONTINUE = (): WebhookReply => ({ status: 204, type: "application/json", body: "" });

/** Vonage numbers come digits only; Twilio / Telnyx in E.164. SIP URIs stay. */
export function e164(provider: string, n: string | undefined): string {
  const v = String(n ?? "").trim();
  if (!v || isSipAddress(v) || v.includes("@")) return v;
  if (/^\d{6,15}$/.test(v)) return `+${v}`;
  return v;
}

/* ------------------------------------------------------- test SIP address */

/** The test inbound SIP address (the telephony data file; written by the admin service). */
export function testSipAddress(): TestSipAddress | null {
  try { return loadTelephonyFile().data.testSip ?? null; } catch { return null; }
}

/** Is `uri` (the SIP address a call was made to) the test address? Its user part decides; hosts, when both known, must agree. */
export function isTestSipCall(uri: string, addr: TestSipAddress | null): boolean {
  if (!addr || !addr.enabled || !uri) return false;
  const user = sipUser(uri).toLowerCase();
  if (!user || user !== sipUser(addr.uri).toLowerCase()) return false;
  const h = sipHost(uri);
  const want = sipHost(addr.uri);
  return !h || !want || h === want;
}

/* --------------------------------------------------------------- helpers */

function callRef(call: TelCall): TsaCallRef {
  return { id: call.id, token: call.token, provider: call.provider, direction: call.direction, from: call.from, to: call.to, did: call.tsa?.did ?? call.to };
}

/** A URL with one more query parameter. */
function withParam(url: string, key: string, value: string): string {
  try { const u = new URL(url); u.searchParams.set(key, value); return u.toString(); } catch { return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`; }
}

const speechOnly = (g: { input?: Array<"dtmf" | "speech"> }) => Boolean(g.input?.length && !g.input.includes("dtmf"));
const wantsSpeech = (g: { input?: Array<"dtmf" | "speech"> }) => Boolean(g.input?.includes("speech"));

/** What a list of actions is, briefly (for the log). */
const actionNames = (actions: CallAction[]) => actions.map((a) => Object.keys(a)[0]).join(", ") || "nothing";

function logRoute(call: TelCall, decision: RouteDecision, extra: Record<string, unknown>, req?: Request): void {
  const t = decision.target;
  const target = t.kind === "tsa" ? `TSA ${t.tsa}` : t.kind === "state" ? t.state : "pass";
  writeLog({
    kind: "route", level: t.kind === "state" ? "notice" : "info", provider: call.provider, direction: call.direction,
    summary: `${call.direction} ${call.from || "unknown"} → ${String(extra.did ?? call.to)}${extra.service === "sip" ? " (SIP)" : ""}: ${target} — ${decision.rule ? `rule ${decision.ruleLabel || decision.rule}` : decision.ruleLabel || "default"}`,
    callId: call.id, rule: decision.rule ?? "", parsed: { decision, ...extra },
  });
  if (req) { const ctx = whContext(req); ctx.callId = call.id; ctx.rule = decision.rule ?? ""; ctx.direction = call.direction; whNote(req, { route: { target, rule: decision.rule, reasons: decision.reasons } }); }
}

function logTsa(call: TelCall, what: string, ev: TsaEvent | null, turn: TsaTurn | null, level: "info" | "warn" | "error" = "info"): void {
  writeLog({
    kind: "tsa", level, provider: call.provider, direction: call.direction,
    summary: `TSA ${call.tsa?.id ?? "?"} ${what}${ev ? ` ← ${ev.kind}${ev.kind === "dial" ? ` ${ev.status}` : ""}` : ""}${turn ? ` → ${actionNames(turn.actions)}${turn.session.status === "ended" || turn.session.status === "failed" ? ` (${turn.session.status})` : ""}` : ""}`,
    callId: call.id, tsaSession: call.tsa?.session ?? "", rule: call.tsa?.rule ?? "",
    parsed: { event: ev, ...(turn ? { actions: turn.actions, session: { status: turn.session.status, at: turn.session.at, waiting: turn.session.waiting } } : {}) },
  });
}

/* ---------------------------------------------------------------- inbound */

/** Why an inbound call from `from` is refused by the module's limits, or "". */
export function inboundLimit(from: string, now = Date.now()): string {
  const p = telPermissions().inbound;
  if (p.maxConcurrentCalls > 0) {
    const live = telStore.calls.count((c) => c.direction === "inbound" && !c.endedAt && !isFinal(c.status) && c.createdAt > now - 4 * 3_600_000);
    if (live >= p.maxConcurrentCalls) return `${live} inbound calls are live (at most ${p.maxConcurrentCalls} at once)`;
  }
  if (from && p.perCallerPerHour > 0) {
    const n = telStore.calls.count((c) => c.direction === "inbound" && c.from === from && c.createdAt > now - 3_600_000);
    if (n >= p.perCallerPerHour) return `${from} has called ${n} times in the last hour (at most ${p.perCallerPerHour})`;
  }
  return "";
}

/** The console's own outbound test call (connectors.ts) answered at /wh/vonage/answer: not an inbound call. */
const ownVonageNumber = (from: string | undefined) => Boolean(from) && env("VONAGE_FROM").replace(/^\+/, "") === String(from).replace(/^\+/, "");

/**
 * An inbound call through the rules (see the header). Null: not ours —
 * no rules, an outbound call, a known call, a TSA without its runtime —
 * and the webhook answers as before.
 */
export async function inboundThroughRules(provider: ProviderId, ev: NormalizedCallEvent, req?: Request): Promise<WebhookReply | null> {
  if (!telHooks.decide || !ev.callId) return null;
  if (ev.direction === "outbound") return null;
  if (provider === "telnyx" && ev.kind !== "answer") return null;
  if (provider === "vonage" && ev.direction !== "inbound" && ownVonageNumber(ev.from)) return null;
  await telStore.ready();
  if (telStore.callByProviderId(provider, ev.callId)) return null;

  const sip = ev.sipUri || (isSipAddress(ev.to) ? String(ev.to) : "");
  const service = sip ? "sip" as const : "app" as const;
  const test = sip ? testSipAddress() : null;
  const isTest = isTestSipCall(sip, test) && (!test!.provider || test!.provider === provider);
  const did = isTest ? test!.did : sip || e164(provider, ev.to);
  const from = e164(provider, ev.from);

  const limited = inboundLimit(from);
  let decision: RouteDecision;
  if (limited) {
    decision = { direction: "inbound", rule: null, ruleLabel: "limits", service: null, target: { kind: "state", state: "busy" }, reasons: [limited] };
  } else {
    try {
      decision = await telHooks.decide({ direction: "inbound", from, to: did, provider, service });
    } catch (err) {
      writeLog({ kind: "route", level: "error", provider, direction: "inbound", summary: `inbound ${from} → ${did}: the rules failed: ${(err as Error).message.slice(0, 200)}`, callId: ev.callId });
      return null;
    }
  }
  const target = decision.target;
  if (target.kind !== "tsa" && target.kind !== "state") return null;
  if (target.kind === "tsa" && !telHooks.tsa) {
    writeLog({ kind: "route", level: "warn", provider, direction: "inbound", summary: `inbound ${from} → ${did}: TSA ${target.tsa} chosen, but the TSA runtime is not loaded — answered as before`, callId: ev.callId, rule: decision.rule ?? "", parsed: { decision } });
    return null;
  }
  const now = Date.now();
  const call: TelCall = {
    id: telId("tc"), token: telToken(), provider, providerCallId: ev.callId, direction: "inbound", from, to: sip || e164(provider, ev.to) || did, status: "ringing",
    mode: "async", actions: [], handlers: {}, owner: null, pending: [], waitFor: null, gatherFn: "", events: [], seq: 0, timeoutSec: 0, timeLimitSec: 0,
    createdAt: now, updatedAt: now, answeredAt: null, endedAt: null, durationSec: null, bridge: "", error: "", steer: null,
  };
  logRoute(call, decision, { did, service, test: isTest, sipUri: sip || undefined, limited: limited || undefined }, req);
  if (target.kind === "state") return refuse(call, target.state);
  call.tsa = { id: target.tsa, rule: decision.rule ?? "", did, service, session: "", status: "pending", queue: [], wait: null, dial: null };
  save(call);
  return startTsa(call, false);
}

/** Refuses (or ends) an unanswered inbound call with a state. */
async function refuse(call: TelCall, state: RouteState): Promise<WebhookReply> {
  call.status = state === "busy" ? "busy" : state === "hangup" ? "completed" : "failed";
  call.endedAt = Date.now();
  call.durationSec = 0;
  call.error = `refused: ${state}`;
  save(call);
  const action: CallAction = state === "hangup" ? { hangup: {} } : { reject: { reason: state } };
  if (call.provider === "telnyx") {
    await telnyxEnd(call, action, false);
    return OK();
  }
  return renderFor(call, [action], false);
}

/* ------------------------------------------------------------------- turns */

async function startTsa(call: TelCall, answered: boolean): Promise<WebhookReply> {
  const st = call.tsa!;
  st.status = "running";
  save(call);
  let turn: TsaTurn;
  try {
    turn = await telHooks.tsa!.start(callRef(call), st.id);
  } catch (err) {
    st.status = "ended";
    save(call);
    logTsa(call, `failed to start: ${(err as Error).message.slice(0, 200)}`, null, null, "error");
    // Not answered yet: refused as busy (no charge on Twilio); answered: ended.
    const end: CallAction = answered ? { hangup: {} } : { reject: { reason: "busy" } };
    if (call.provider === "telnyx") { await telnyxEnd(call, end, answered); return OK(); }
    return renderFor(call, [end], answered);
  }
  st.session = turn.session.id;
  if (turn.session.status === "ended" || turn.session.status === "failed") st.status = "ended";
  save(call);
  logTsa(call, "started", null, turn);
  return deliverTurn(call, turn.actions, answered);
}

/** Resumes the call's session with an event; null when there is no session or the runtime failed. */
async function resumeTurn(call: TelCall, ev: TsaEvent): Promise<TsaTurn | null> {
  const st = call.tsa!;
  if (!telHooks.tsa || !st.session) return null;
  st.wait = null;
  try {
    const turn = await telHooks.tsa.resume(st.session, ev);
    if (turn.session.status === "ended" || turn.session.status === "failed") st.status = "ended";
    save(call);
    logTsa(call, "resumed", ev, turn);
    return turn;
  } catch (err) {
    save(call);
    logTsa(call, `failed to resume: ${(err as Error).message.slice(0, 200)}`, ev, null, "error");
    return null;
  }
}

/** A turn's actions to the provider: rendered (Twilio, Vonage) or run (Telnyx). */
async function deliverTurn(call: TelCall, actions: CallAction[], answered: boolean): Promise<WebhookReply> {
  if (call.provider === "telnyx") {
    const st = call.tsa!;
    if (!answered) {
      // An inbound call: refused without answering when the flow starts so; else answered,
      // and the turn runs when call.answered arrives.
      const first = actions[0];
      if (first && ("reject" in first || "hangup" in first)) { await telnyxEnd(call, first, false); return OK(); }
      st.queue = actions;
      st.wait = null;
      save(call);
      const tx = adapter("telnyx");
      await tx?.answer?.(call.providerCallId, { clientState: call.id }).catch((err) => logTsa(call, `answer failed: ${(err as Error).message.slice(0, 200)}`, null, null, "warn"));
      return OK();
    }
    await telnyxRun(call, actions);
    return OK();
  }
  return renderFor(call, actions, answered);
}

/**
 * The provider's quirks for a TSA turn:
 *   Twilio  a <Gather> / <Record> that gets nothing goes on to the next verb —
 *           a Redirect to the same callback says it timed out; a <Reject>
 *           only refuses as the first verb of an unanswered call (later: a hang-up)
 *   Vonage  the input action always reports (timeouts too); redirects become
 *           notify (renderNcco); DTMF goes through the REST API
 */
export function tsaFixups(provider: string, actions: CallAction[], answered: boolean): CallAction[] {
  if (provider !== "twilio") return actions;
  const out: CallAction[] = [];
  actions.forEach((a, i) => {
    if ("reject" in a && (answered || i > 0)) { out.push({ hangup: {} }); return; }
    out.push(a);
    if ("gather" in a) out.push({ redirect: { url: withParam(a.gather.action, "timeout", speechOnly(a.gather) ? "speech" : "digits") } });
    if ("record" in a) out.push({ redirect: { url: withParam(a.record.action, "timeout", "recording") } });
  });
  return out;
}

/** Renders actions as the provider's answer to a webhook (TwiML, NCCO). */
function renderFor(call: TelCall, actions: CallAction[], answered: boolean): WebhookReply {
  const fixed = tsaFixups(call.provider, actions, answered);
  if (call.provider === "twilio") return { status: 200, type: "text/xml", body: renderTwiml(fixed) };
  if (call.provider === "vonage") {
    const tones = fixed.filter((a): a is Extract<CallAction, { sendDigits: unknown }> => "sendDigits" in a);
    if (tones.length && answered && call.providerCallId) {
      const vg = adapter("vonage") as VonageAdapter | undefined;
      void (async () => { for (const t of tones) await vg?.sendDtmf(call.providerCallId, t.sendDigits.digits); })().catch((err) => logTsa(call, `DTMF failed: ${(err as Error).message.slice(0, 200)}`, null, null, "warn"));
    }
    return { status: 200, type: "application/json", body: JSON.stringify(renderNcco(fixed, { redirectAsNotify: true })) };
  }
  return OK();
}

/** What a turn would tell the provider — the console's route test. Secrets (trunk passwords) are masked first. */
export function previewActions(provider: string, actions: CallAction[]): { contentType: string; body: string } {
  const safe = redact(actions) as CallAction[];
  if (provider === "twilio") return { contentType: "text/xml", body: renderTwiml(tsaFixups("twilio", safe, false)) };
  if (provider === "vonage") return { contentType: "application/json", body: JSON.stringify(renderNcco(safe, { redirectAsNotify: true }), null, 2) };
  if (provider === "telnyx") {
    const answer = safe[0] && ("reject" in safe[0] || "hangup" in safe[0]) ? [] : [{ cmd: "answer", body: {} }];
    return { contentType: "application/json", body: JSON.stringify([...answer, ...telnyxCommands(safe)], null, 2) };
  }
  return { contentType: "application/json", body: JSON.stringify(safe) };
}

/* ------------------------------------------------------- the TSA callback */

const num = (v: unknown): number | undefined => { const n = v === undefined || v === null || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n : undefined; };
function fieldsOf(body: unknown): Record<string, unknown> {
  if (typeof body === "string") { try { return JSON.parse(body) as Record<string, unknown>; } catch { return Object.fromEntries(new URLSearchParams(body)); } }
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

const VONAGE_DIAL_FAIL: Record<string, Extract<TsaEvent, { kind: "dial" }>["status"]> = {
  busy: "busy", timeout: "no-answer", unanswered: "no-answer", failed: "failed", rejected: "failed", cancelled: "canceled",
};

/**
 * A TSA callback (/wh/tel/<token>/tsa?…) as a TsaEvent — Twilio (form) or
 * Vonage (JSON). Null: nothing to resume with (a dialled leg's progress, a
 * dial's recording, a transcription) — the caller acknowledges it.
 */
export function tsaEventFromCallback(provider: string, body: unknown, query: Record<string, string>): TsaEvent | null {
  const f = { ...query, ...fieldsOf(body) } as Record<string, unknown>;
  const s = (k: string) => (f[k] === undefined || f[k] === null ? "" : String(f[k]));
  if (query.x) return null; // x=dialrec / x=transcript: reports, not turns
  if (query.e === "played") return { kind: "played" };
  if (provider === "twilio") {
    if (query.timeout === "speech") return { kind: "speech", text: "", timedOut: true };
    if (query.timeout === "digits") return { kind: "digits", digits: "", timedOut: true };
    if (query.timeout === "recording") return { kind: "recording", url: "", durationSec: 0, timedOut: true };
    if (s("DialCallStatus")) return { kind: "dial", status: TWILIO_DIAL_STATUS[s("DialCallStatus")] ?? "failed", ...(num(f.DialCallDuration) !== undefined ? { durationSec: num(f.DialCallDuration)! } : {}) };
    if (s("RecordingUrl")) {
      const key = s("Digits");
      return { kind: "recording", url: s("RecordingUrl"), ...(s("RecordingSid") ? { id: s("RecordingSid") } : {}), durationSec: num(f.RecordingDuration) ?? 0, ...(key && key !== "hangup" ? { digit: key } : {}) };
    }
    if ("SpeechResult" in f) return { kind: "speech", text: s("SpeechResult"), ...(num(f.Confidence) !== undefined ? { confidence: num(f.Confidence)! } : {}) };
    if ("Digits" in f) return { kind: "digits", digits: s("Digits"), ...(s("FinishedOnKey") ? { finishedBy: s("FinishedOnKey") } : {}) };
    const status = s("CallStatus");
    if (["completed", "busy", "no-answer", "failed", "canceled"].includes(status)) return { kind: "hangup", cause: status };
    return null;
  }
  if (provider === "vonage") {
    // A notify's request carries its payload (as the body, or under "payload").
    const m5 = s("m5") || String((f.payload as { m5?: unknown } | undefined)?.m5 ?? "");
    if (m5 === "redirect") return { kind: "played" };
    if (m5 === "dial-ended") return { kind: "dial", status: "answered" };
    const dtmf = f.dtmf as { digits?: string; timed_out?: boolean } | undefined;
    const speech = f.speech as { results?: Array<{ text?: string; confidence?: string | number }>; timeout_reason?: string } | undefined;
    const typed = dtmf && typeof dtmf === "object" ? String(dtmf.digits ?? "") : "";
    if (typed) return { kind: "digits", digits: typed };
    const best = speech && Array.isArray(speech.results) ? speech.results[0] : undefined;
    if (best && String(best.text ?? "").trim()) return { kind: "speech", text: String(best.text), ...(num(best.confidence) !== undefined ? { confidence: num(best.confidence)! } : {}) };
    if (dtmf && typeof dtmf === "object") return { kind: "digits", digits: "", timedOut: true };
    if (speech && typeof speech === "object") return { kind: "speech", text: "", timedOut: true };
    if (s("recording_url")) {
      const start = Date.parse(s("start_time")); const end = Date.parse(s("end_time"));
      return { kind: "recording", url: s("recording_url"), ...(s("recording_uuid") ? { id: s("recording_uuid") } : {}), durationSec: Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : 0 };
    }
    const failed = VONAGE_DIAL_FAIL[s("status")];
    if (failed) return { kind: "dial", status: failed };
    return null;
  }
  return null;
}

async function tsaCallback(call: TelCall, events: NormalizedCallEvent[], body: unknown, query: Record<string, string>): Promise<WebhookReply> {
  const st = call.tsa!;
  if (!st.session || query.s !== st.session) {
    writeLog({ kind: "tsa", level: "warn", provider: call.provider, direction: call.direction, summary: `TSA callback for another session refused`, callId: call.id, tsaSession: st.session });
    return json(404, { ok: false });
  }
  if (call.provider === "telnyx") { await telnyxDialLeg(call, events); return OK(); }
  let ev = tsaEventFromCallback(call.provider, body, query);
  if (call.provider === "vonage") {
    const f = fieldsOf(body);
    const status = String(f.status ?? "");
    if (!ev) {
      // The dialled leg's progress: remember when it answered and how long it lasted.
      if (status === "answered") st.dial = { leg: String(f.uuid ?? ""), answeredAt: Date.now() };
      if (status === "completed" && st.dial) st.dial.durationSec = num(f.duration);
      save(call);
      return CONTINUE();
    }
    if (ev.kind === "dial" && ev.status === "answered") {
      const d = st.dial;
      const sec = d?.durationSec ?? (d?.answeredAt ? Math.round((Date.now() - d.answeredAt) / 1000) : undefined);
      ev = { kind: "dial", status: "answered", ...(sec !== undefined ? { durationSec: sec } : {}) };
      st.dial = null;
    }
  }
  if (!ev) ev = { kind: "error", message: "an unrecognized callback from the provider" };
  if (st.status === "ended") return renderFor(call, [{ hangup: {} }], true);
  const turn = await resumeTurn(call, ev);
  if (!turn) return renderFor(call, [{ hangup: {} }], true);
  return deliverTurn(call, turn.actions, true);
}

/** The session ends with the call (once). */
async function finishTsa(call: TelCall, cause: string): Promise<void> {
  const st = call.tsa!;
  if (st.status === "ended" || !st.session) { if (st.status !== "ended") { st.status = "ended"; save(call); } return; }
  st.status = "ended";
  st.wait = null;
  st.queue = [];
  save(call);
  if (!telHooks.tsa) return;
  try {
    const turn = await telHooks.tsa.resume(st.session, { kind: "hangup", cause });
    logTsa(call, "ended with the call", { kind: "hangup", cause }, turn);
  } catch (err) {
    logTsa(call, `hangup not delivered: ${(err as Error).message.slice(0, 200)}`, { kind: "hangup", cause }, null, "warn");
  }
}

/* ----------------------------------------------------- the engine's handler */

/** Every webhook of a call that runs a TSA (engine.handleCallWebhook hands it here). */
export async function tsaCallWebhook(call: TelCall, kind: string, body: unknown, query: Record<string, string>): Promise<WebhookReply> {
  const a = adapter(call.provider);
  const events = a?.parseCallEvent ? a.parseCallEvent(body, query) : [];
  if (kind === "tsa") return tsaCallback(call, events, body, query);
  const st = call.tsa!;
  // Telnyx: only the call's own leg moves its status (a dialled leg reports to the TSA URL).
  const own = call.provider === "telnyx" && call.providerCallId ? events.filter((e) => e.callId === call.providerCallId) : events;
  for (const ev of own) applyCallEvent(call, ev);
  save(call);

  if (kind === "answer") {
    if (!call.answeredAt) { call.answeredAt = Date.now(); save(call); }
    if (st.status === "pending") return startTsa(call, true);
    // Asked again (a provider retry): never run the flow twice.
    return renderFor(call, [{ hangup: {} }], true);
  }
  if (kind === "gather" || kind === "record") return renderFor(call, [{ hangup: {} }], true);

  if (call.provider === "telnyx") await telnyxEvents(call, own).catch((err) => logTsa(call, `event failed: ${(err as Error).message.slice(0, 200)}`, null, null, "warn"));
  const final = own.find((e) => e.status && isFinal(e.status));
  if (final) await finishTsa(call, final.cause ?? final.status ?? "completed");
  return OK();
}

setTsaCallHandler(tsaCallWebhook);

/* ------------------------------------------------------------------ Telnyx */

const telnyxType = (ev: NormalizedCallEvent): string => String(((ev.raw as { data?: { event_type?: string } } | null)?.data?.event_type) ?? "");
const MAX_STEPS = 60;

function telnyxWaitOf(a: CallAction): TelTsaWait | null {
  if ("say" in a || "pause" in a) return { event: "call.speak.ended", url: "", kind: "continue" };
  if ("play" in a) return { event: "call.playback.ended", url: "", kind: "continue" };
  if ("stream" in a) return { event: "streaming.stopped", url: "", kind: "continue" };
  if ("gather" in a) return wantsSpeech(a.gather)
    ? { event: "call.transcription", url: a.gather.action, kind: "speech", input: a.gather.input }
    : { event: "call.gather.ended", url: a.gather.action, kind: "digits" };
  if ("record" in a) return { event: "call.recording.saved", url: a.record.action, kind: "recording", finishOnKey: a.record.finishOnKey ?? "#" };
  if ("dial" in a) return { event: "call.hangup", url: a.dial.action, kind: "dial" };
  return null;
}

/** Ends a Telnyx call: refused when not answered (reject), else hung up. */
async function telnyxEnd(call: TelCall, a: CallAction, answered: boolean): Promise<void> {
  const tx = adapter("telnyx") as TelnyxAdapter | undefined;
  if (!tx || !call.providerCallId) return;
  const reason = "reject" in a ? a.reject.reason : null;
  const done = reason && !answered && !call.answeredAt ? tx.reject(call.providerCallId, reason, { clientState: call.id }) : tx.hangup(call.providerCallId);
  await done.catch((err) => writeLog({ kind: "call", level: "warn", provider: "telnyx", direction: call.direction, summary: `could not end the call: ${redactString((err as Error).message).slice(0, 200)}`, callId: call.id }));
}

/** A speech gather: the prompt, a transcription of the caller and a plain gather as the timer (and for keys). */
async function telnyxSpeechGather(tx: TelnyxAdapter, id: string, g: Extract<CallAction, { gather: unknown }>["gather"], cs: string): Promise<void> {
  if (g.prompt) { const [say] = telnyxCommands([{ say: { text: g.prompt, ...(g.voice ? { voice: g.voice } : {}), ...(g.language ? { language: g.language } : {}) } }], cs); await tx.sendCommand(id, say.cmd, say.body); }
  const [tr] = telnyxCommands([{ gather: { ...g, prompt: undefined, input: ["speech"] } }], cs);
  await tx.sendCommand(id, tr.cmd, tr.body);
  const dtmf = g.input?.includes("dtmf");
  // Telnyx has no speech start timeout: the timer is the wait for speech + its end + a margin.
  const ms = Math.min(120_000, Math.round(((g.timeout ?? 5) + (g.speechTimeout ?? 2) + 5) * 1000));
  await tx.sendCommand(id, "gather", { minimum_digits: 1, maximum_digits: dtmf ? Math.min(128, Math.max(1, g.digits ?? 32)) : 1, timeout_millis: ms, ...(dtmf && (g.finishOnKey ?? "#") ? { terminating_digit: g.finishOnKey ?? "#" } : {}), client_state: Buffer.from(cs).toString("base64") });
}

/** Runs a turn on a Telnyx call: commands up to the first that waits; a TSA redirect resumes the session at once. */
async function telnyxRun(call: TelCall, actions: CallAction[]): Promise<void> {
  const st = call.tsa!;
  const tx = adapter("telnyx") as TelnyxAdapter | undefined;
  if (!tx) return;
  const id = call.providerCallId;
  let list = [...actions];
  let steps = 0;
  st.wait = null;
  st.queue = [];
  while (list.length) {
    if (++steps > MAX_STEPS) {
      logTsa(call, "ran too many steps without waiting — hanging up", null, null, "error");
      await tx.hangup(id).catch(() => undefined);
      return;
    }
    const a = list.shift()!;
    if ("redirect" in a) {
      // The flow goes on (a TSA URL with e=played after a say / play): straight to the
      // runtime, no HTTP round trip. Call Control has no redirect to any other URL.
      if (!/\/wh\/tel\/[A-Za-z0-9_-]{16,64}\/tsa\b/.test(a.redirect.url)) logTsa(call, "a redirect to a URL outside the TSA (Call Control cannot fetch logic); the flow goes on", null, null, "warn");
      const turn = await resumeTurn(call, { kind: "played" });
      if (!turn) { await tx.hangup(id).catch(() => undefined); return; }
      list = [...turn.actions];
      continue;
    }
    if ("reject" in a || "hangup" in a) { save(call); await telnyxEnd(call, a, true); return; }
    try {
      if ("gather" in a && wantsSpeech(a.gather)) await telnyxSpeechGather(tx, id, a.gather, call.id);
      else { const [c] = telnyxCommands([a], call.id); await tx.sendCommand(id, c.cmd, c.body); }
      if ("dial" in a) st.dial = { leg: "", answeredAt: null };
    } catch (err) {
      logTsa(call, `${Object.keys(a)[0]} failed: ${redactString((err as Error).message).slice(0, 200)}`, null, null, "warn");
      const turn = await resumeTurn(call, { kind: "error", message: (err as Error).message.slice(0, 200) });
      if (!turn) { await tx.hangup(id).catch(() => undefined); return; }
      list = [...turn.actions];
      continue;
    }
    const wait = telnyxWaitOf(a);
    if (wait) { st.wait = wait; st.queue = list; save(call); return; }
  }
  save(call);
}

/** Resumes the session and runs what it says next (or hangs up when it cannot). */
async function telnyxResume(call: TelCall, ev: TsaEvent): Promise<void> {
  const turn = await resumeTurn(call, ev);
  if (turn) await telnyxRun(call, turn.actions);
  else await (adapter("telnyx") as TelnyxAdapter | undefined)?.hangup(call.providerCallId).catch(() => undefined);
}

const keyEnds = (finishOnKey: string | undefined, digit: string | undefined) => {
  if (!digit) return false;
  if (finishOnKey === undefined) return digit === "#";
  if (finishOnKey === "any") return true;
  return finishOnKey !== "" && finishOnKey.includes(digit);
};

/** The original leg's events of a Telnyx TSA call. */
async function telnyxEvents(call: TelCall, events: NormalizedCallEvent[]): Promise<void> {
  const st = call.tsa!;
  const tx = adapter("telnyx") as TelnyxAdapter | undefined;
  for (const ev of events) {
    const type = telnyxType(ev);
    if (type === "call.answered") {
      if (st.status === "pending") { await startTsa(call, true); continue; } // an outbound call
      if (!st.wait && st.queue.length) { const q = st.queue; await telnyxRun(call, q); } // an inbound call's first turn
      continue;
    }
    // (A flow that has ended may still have the rest of its last turn to run — a goodbye, then the hang-up.)
    const w = st.wait;
    if (!w) continue;
    if (w.kind === "continue" && type === w.event) {
      const q = st.queue;
      await telnyxRun(call, q);
    } else if (w.kind === "digits" && type === "call.gather.ended") {
      if (ev.cause === "cancelled") continue;
      await telnyxResume(call, { kind: "digits", digits: ev.digits ?? "", ...(ev.cause === "timeout" || ev.cause === "call_hangup" ? { timedOut: true } : {}) });
    } else if (w.kind === "speech") {
      if (type === "call.transcription" && ev.cause !== "interim" && (ev.speech ?? "").trim()) {
        st.wait = null; save(call);
        await tx?.sendCommand(call.providerCallId, "transcription_stop", {}).catch(() => undefined);
        await tx?.sendCommand(call.providerCallId, "gather_stop", {}).catch(() => undefined);
        await telnyxResume(call, { kind: "speech", text: String(ev.speech).trim(), ...(ev.confidence !== undefined ? { confidence: ev.confidence } : {}) });
      } else if (type === "call.gather.ended" && ev.cause !== "cancelled") {
        st.wait = null; save(call);
        await tx?.sendCommand(call.providerCallId, "transcription_stop", {}).catch(() => undefined);
        if (ev.digits && w.input?.includes("dtmf")) await telnyxResume(call, { kind: "digits", digits: ev.digits });
        else if (w.input?.includes("dtmf")) await telnyxResume(call, { kind: "digits", digits: "", timedOut: true });
        else await telnyxResume(call, { kind: "speech", text: "", timedOut: true });
      }
    } else if (w.kind === "recording") {
      if (type === "call.dtmf.received" && keyEnds(w.finishOnKey, ev.digits)) {
        w.key = ev.digits;
        save(call);
        await tx?.sendCommand(call.providerCallId, "record_stop", {}).catch(() => undefined);
      } else if (type === "call.recording.saved") {
        await telnyxResume(call, { kind: "recording", url: ev.recordingUrl ?? "", durationSec: ev.recordingSec ?? 0, ...(w.key ? { digit: w.key } : {}), ...(!ev.recordingSec ? { timedOut: true } : {}) });
      }
    }
  }
}

/** The dialled leg of a Telnyx transfer (its events come to the dial's TSA URL). */
async function telnyxDialLeg(call: TelCall, events: NormalizedCallEvent[]): Promise<void> {
  const st = call.tsa!;
  for (const ev of events) {
    if (ev.callId === call.providerCallId) continue;
    const type = telnyxType(ev);
    st.dial ??= { leg: ev.callId, answeredAt: null };
    if (!st.dial.leg) st.dial.leg = ev.callId;
    if (type === "call.answered" || type === "call.bridged") { st.dial.answeredAt ??= Date.now(); save(call); continue; }
    if (type === "call.hangup" && st.wait?.kind === "dial") {
      const answeredAt = st.dial.answeredAt;
      const status = telnyxDialStatus(ev.cause, Boolean(answeredAt));
      st.dial = null;
      st.wait = null;
      save(call);
      await telnyxResume(call, { kind: "dial", status, ...(answeredAt ? { durationSec: Math.round((Date.now() - answeredAt) / 1000) } : {}) });
    }
  }
}

export const __test = { telnyxWaitOf, keyEnds, refuse, deliverTurn, renderFor };
