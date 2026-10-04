// The m5.telephony engine (6.0): what a function's call, SMS, chat message
// or lookup becomes — a provider request (providers/*), a record (tel-store),
// and webhooks made for it before it starts.
//
// Every call gets its own webhook URLs, /wh/tel/<token>/<kind>:
//   answer   the provider asks what to do when the call is answered (Twilio,
//            Vonage): the call's actions, or its "answer" handler's answer,
//            rendered as TwiML / NCCO
//   gather   digits the caller typed (a gather action) → the "digits" handler
//   event    progress: initiated, ringing, answered, completed, busy… — and,
//            for Telnyx (Call Control is asynchronous), where the engine runs
//            the actions as commands one step at a time
//   status   delivery of an SMS or a chat message
// The token in the URL finds the record; the provider's signature
// (webhooks.ts) proves the sender. A handler is a function of the model that
// placed the call ("on_hangup" in its file); it runs in the model's
// processing session, so m5.model.calls shows the whole conversation.
//
// Modes:
//   async   the run goes on; handlers run later (the default)
//   sync    the run waits for the call (m5.telephony.call({ wait: true }) or
//           in-run callbacks) and may steer it while it lasts
//   native  the provider's own logic as given (TwiML, NCCO, TeXML)

import type { Request } from "express";
import { adapter, pick } from "./providers";
import {
  FINAL_CALL_STATUSES, ProviderError, ProviderNotConfigured,
  type CallAction, type CallStatus, type ChatChannel, type NormalizedCallEvent, type PlaceCallInput, type ProviderAdapter, type ProviderId,
} from "./providers/types";
import { telnyxPendingActions, telnyxWaitsFor } from "./providers/telnyx";
import { publicBaseUrl } from "./connectors";
import { stringParams, verifyRequest } from "./webhooks";
import { telId, telStore, telToken, type HandlerEvent, type TelCall, type TelMessage, type TelOwner } from "./tel-store";
import { isE164, isProvider } from "./types";

export class TelError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TelError"; }
}

/** Where providers reach our webhooks (PUBLIC_BASE_URL) — a call without it cannot report back. */
export function telBase(): string {
  const base = publicBaseUrl();
  if (!base) throw new TelError("not-configured", "Set PUBLIC_BASE_URL (e.g. https://chat.example.org): the providers report a call's progress to its webhooks there.");
  return base;
}
export const hookUrl = (token: string, kind: string, query: Record<string, string> = {}): string => {
  const q = new URLSearchParams(query).toString();
  return `${telBase()}/wh/tel/${token}/${kind}${q ? `?${q}` : ""}`;
};
/** The media WebSocket of the audio bridge (wss://…/media/tel/<token>). */
export const mediaUrl = (token: string): string => `${telBase().replace(/^http/, "ws")}/media/tel/${token}`;

/* ------------------------------------------------------------- handlers */

/**
 * Runs a handler of the model that placed a call or a message: `fn` in its
 * file, with these inputs, in its processing session. Set by the functions
 * layer (host-telephony.ts) — the engine does not know the runner. Resolves
 * with what the handler returned (plain data), or null.
 */
export type HandlerRunner = (owner: TelOwner, fn: string, inputs: Record<string, unknown>) => Promise<unknown>;
let runHandler: HandlerRunner | null = null;
export function setHandlerRunner(fn: HandlerRunner | null): void { runHandler = fn; }

/**
 * The audio bridge (bridge.ts) takes the digits of its own calls (the access
 * code) and follows how they end; the engine does not import it (it imports
 * the engine), so it registers here.
 */
export type DigitsInterceptor = (call: TelCall, digits: string) => Promise<CallAction[]>;
export type CallObserver = (call: TelCall, events: NormalizedCallEvent[]) => void;
let bridgeDigits: DigitsInterceptor | null = null;
let bridgeObserver: CallObserver | null = null;
export function setBridgeHooks(digits: DigitsInterceptor | null, observer: CallObserver | null): void { bridgeDigits = digits; bridgeObserver = observer; }

/**
 * 6.9: a call that runs a TSA (call.tsa) is driven by the control layer
 * (control/calls.ts): its answer, events and the TSA's own callbacks
 * (/wh/tel/<token>/tsa). It registers here — it imports the engine.
 */
export type TsaCallHandler = (call: TelCall, kind: string, body: unknown, query: Record<string, string>) => Promise<WebhookReply>;
let tsaCalls: TsaCallHandler | null = null;
export function setTsaCallHandler(fn: TsaCallHandler | null): void { tsaCalls = fn; }

/** How long an answer / gather webhook waits for a handler (the provider waits ~10 s; Vonage 5). */
const SYNC_HANDLER_MS = 4_500;

async function handler(call: TelCall, event: HandlerEvent, fnOverride = ""): Promise<unknown> {
  const fn = fnOverride || call.handlers[event];
  if (!fn || !call.owner || !runHandler) return null;
  const inputs = { event, call: callView(call) };
  try {
    return await runHandler(call.owner, fn, inputs);
  } catch (err) {
    note(call, `handler ${fn} failed: ${(err as Error).message}`, "warn");
    return null;
  }
}

/** A handler within the provider's patience: its answer, or null when it takes too long. */
async function handlerInTime(call: TelCall, event: HandlerEvent, fn = ""): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), SYNC_HANDLER_MS); });
  try { return await Promise.race([handler(call, event, fn), late]); }
  finally { if (timer) clearTimeout(timer); }
}

/* --------------------------------------------------------------- actions */

/** What a script may give as call logic: an action, a list of them, { actions }, or text (said). */
export function actionsOf(v: unknown): CallAction[] | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() ? [{ say: { text: v } }] : null;
  const list = Array.isArray(v) ? v : typeof v === "object" && Array.isArray((v as { actions?: unknown }).actions) ? (v as { actions: unknown[] }).actions : [v];
  const out: CallAction[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const k = Object.keys(a)[0];
    if (["say", "play", "pause", "gather", "stream", "record", "redirect", "hangup"].includes(k)) out.push(a as CallAction);
  }
  return out.length ? out : null;
}

/** SDK actions → provider actions: a gather's `fn` and a record's handler become this call's webhook URLs. */
function resolveActions(call: TelCall, actions: CallAction[]): CallAction[] {
  return actions.map((a) => {
    if ("gather" in a) {
      const g = a.gather as { action?: string; fn?: string } & Record<string, unknown>;
      const fn = typeof g.fn === "string" ? g.fn : "";
      const { fn: _fn, ...rest } = g;
      return { gather: { ...rest, action: hookUrl(call.token, "gather", fn ? { fn } : {}) } } as CallAction;
    }
    if ("record" in a) {
      const r = a.record as { fn?: string } & Record<string, unknown>;
      const { fn: _fn, ...rest } = r;
      return { record: { ...rest, action: hookUrl(call.token, "record", r.fn ? { fn: String(r.fn) } : {}) } } as CallAction;
    }
    if ("stream" in a && !/^wss?:\/\//.test(a.stream.url)) return { stream: { ...a.stream, url: mediaUrl(a.stream.url) } };
    return a;
  });
}

/** A run waits on the call and may steer it: until then, keep the line open (and ask again). */
function holdActions(call: TelCall): CallAction[] {
  if (call.provider === "vonage") {
    // NCCO has no redirect: a silent digit wait that comes back here when it times out.
    return [{ gather: { action: hookUrl(call.token, "answer", { hold: "1" }), digits: 1, finishOnKey: "", timeout: 15 } }];
  }
  return [{ pause: { seconds: 5 } }, { redirect: { url: hookUrl(call.token, "answer", { hold: "1" }) } }];
}

/** The logic for an answered call: a steer from the waiting run, the answer handler, the call's actions — or hang up. */
async function answerLogic(call: TelCall): Promise<CallAction[]> {
  if (call.steer?.actions.length) return resolveActions(call, call.steer.actions);
  if (call.handlers.answer) {
    const fromHandler = actionsOf(await handlerInTime(call, "answer"));
    if (fromHandler) return resolveActions(call, fromHandler);
  }
  if (call.actions.length) return resolveActions(call, call.actions);
  if (call.mode === "sync") return holdActions(call);
  return [{ hangup: {} }];
}

/* ---------------------------------------------------------------- views */

export type CallView = {
  id: string; provider: ProviderId; providerCallId: string; direction: string; from: string; to: string; status: CallStatus;
  mode: string; answered: boolean; final: boolean; durationSec: number | null; createdAt: number; answeredAt: number | null; endedAt: number | null;
  seq: number; lastEvent: TelCall["events"][number] | null; error: string;
};
export function callView(c: TelCall): CallView {
  return {
    id: c.id, provider: c.provider, providerCallId: c.providerCallId, direction: c.direction, from: c.from, to: c.to, status: c.status,
    mode: c.mode, answered: Boolean(c.answeredAt), final: FINAL_CALL_STATUSES.includes(c.status), durationSec: c.durationSec,
    createdAt: c.createdAt, answeredAt: c.answeredAt, endedAt: c.endedAt, seq: c.seq, lastEvent: c.events.at(-1) ?? null, error: c.error,
  };
}

export function note(call: TelCall, summary: string, level: "info" | "notice" | "warn" | "error" = "info", detail: Record<string, unknown> = {}): void {
  telStore.record({ kind: "call", level, ref: call.id, provider: call.provider, summary, detail: { to: call.to, from: call.from, ...detail } });
}

export function save(call: TelCall): TelCall { call.updatedAt = Date.now(); telStore.calls.put(call); return call; }

/* ------------------------------------------------------------------ calls */

export type PlaceCallOptions = {
  to: string;
  from?: string;
  provider?: string;
  /** Ring timeout, seconds (default 10). */
  timeout?: number;
  timeLimit?: number;
  mode?: "async" | "sync" | "native";
  actions?: CallAction[];
  raw?: { twiml?: string; ncco?: unknown[]; texml?: string };
  handlers?: Partial<Record<HandlerEvent, string>>;
  machineDetection?: boolean;
  owner: TelOwner | null;
  /** 6.9: carried over the operator's SIP trunk (an outbound rule's "sip" service). */
  via?: PlaceCallInput["via"];
  /** 6.9: the call runs this TSA when answered (an outbound rule's target, a console test). */
  tsa?: { id: string; rule?: string };
};

/** Places a call; its record exists (with its webhooks) before the provider is asked. */
export async function placeCall(o: PlaceCallOptions): Promise<TelCall> {
  await telStore.ready();
  if (!isE164(o.to)) throw new TelError("bad-argument", "to must be an E.164 number, e.g. +420603123456");
  if (o.from && !isE164(o.from) && !/^sip:/.test(o.from)) throw new TelError("bad-argument", "from must be an E.164 number (or empty: the provider's default)");
  const a = pickAdapter("call", o.provider);
  const now = Date.now();
  const mode = o.raw ? "native" : o.mode ?? "async";
  const call: TelCall = {
    id: telId("tc"), token: telToken(), provider: a.id, providerCallId: "", direction: "outbound",
    from: o.from ?? "", to: o.to, status: "queued", mode,
    actions: o.actions ?? [], handlers: o.handlers ?? {}, owner: o.owner,
    pending: [], waitFor: null, gatherFn: "", events: [], seq: 0,
    timeoutSec: clampTimeout(o.timeout), timeLimitSec: Math.max(0, Math.floor(o.timeLimit ?? 0)),
    createdAt: now, updatedAt: now, answeredAt: null, endedAt: null, durationSec: null, bridge: "", error: "", steer: null,
    ...(o.tsa ? { tsa: { id: o.tsa.id, rule: o.tsa.rule ?? "", did: o.from ?? "", service: o.via ? "sip" as const : "app" as const, session: "", status: "pending" as const, queue: [], wait: null, dial: null } } : {}),
  };
  save(call);
  try {
    const telnyx = a.id === "telnyx";
    const r = await a.placeCall!({
      to: o.to, from: o.from ?? "", timeout: call.timeoutSec, ...(call.timeLimitSec ? { timeLimit: call.timeLimitSec } : {}),
      ...(o.via ? { via: o.via } : {}),
      eventUrl: hookUrl(call.token, "event"),
      // Twilio / Vonage ask for the logic when answered; Telnyx is told on call.answered.
      ...(o.raw ? { raw: o.raw } : telnyx ? {} : { answerUrl: hookUrl(call.token, "answer") }),
      clientState: call.id,
      ...(o.machineDetection ? { machineDetection: true } : {}),
    });
    call.providerCallId = r.id;
    call.status = r.status;
    if (!call.from) call.from = "";
    save(call);
    note(call, `call to ${call.to} placed (${a.id}, ${mode})`, "info", { timeout: call.timeoutSec });
    return call;
  } catch (err) {
    call.status = "failed";
    call.error = (err as Error).message.slice(0, 300);
    call.endedAt = Date.now();
    save(call);
    note(call, `call to ${call.to} failed to start: ${call.error}`, "warn");
    throw err;
  }
}

const clampTimeout = (t?: number) => Math.max(1, Math.min(600, Math.round(Number(t) || 10)));

function pickAdapter(capability: "call" | "sms" | "hlr" | "lookup" | ChatChannel, provider?: string): ProviderAdapter {
  if (provider) {
    const a = adapter(provider);
    if (!a) throw new TelError("bad-argument", `no provider "${provider.slice(0, 20)}" (twilio, telnyx, vonage, hlrlookups, meta)`);
    if (!a.status().configured.includes(capability)) throw new TelError("not-configured", `${a.label} is not configured for ${capability}${a.status().needs[capability] ? ` (${a.status().needs[capability]!.join(", ")})` : ""}`);
    return a;
  }
  const a = pick(capability);
  if (!a) throw new TelError("not-configured", `no provider is configured for ${capability} (Telephony & SIP in the console, or the provider's variables in .env)`);
  return a;
}

export async function getCall(id: string): Promise<TelCall | null> { await telStore.ready(); return telStore.calls.get(id); }

/** Hangs up a live call. */
export async function hangup(id: string): Promise<boolean> {
  const call = await getCall(id);
  if (!call || !call.providerCallId || FINAL_CALL_STATUSES.includes(call.status)) return false;
  const a = adapter(call.provider);
  if (!a?.hangup) throw new TelError("unsupported", `${call.provider} cannot hang up a call`);
  await a.hangup(call.providerCallId);
  note(call, "hung up by the function");
  return true;
}

/** Changes what a live call does (say something, gather digits, hang up…). */
export async function steer(id: string, raw: unknown): Promise<boolean> {
  const call = await getCall(id);
  if (!call) return false;
  const actions = actionsOf(raw);
  if (!actions) throw new TelError("bad-argument", "actions: say, play, pause, gather, stream, record, redirect, hangup");
  if (FINAL_CALL_STATUSES.includes(call.status)) return false;
  call.steer = { seq: call.seq, actions };
  save(call);
  // Not answered yet: the answer webhook picks it up. Answered: change the live call now.
  if (call.answeredAt && call.providerCallId) await execute(call, resolveActions(call, actions));
  return true;
}

/** Runs actions on a live call (Telnyx: the first steps now, the rest when they end). */
export async function execute(call: TelCall, actions: CallAction[]): Promise<void> {
  const a = adapter(call.provider);
  if (!a?.executeActions) throw new TelError("unsupported", `${call.provider} cannot change a live call`);
  if (call.provider === "telnyx") {
    const [now, later] = telnyxPendingActions(actions);
    call.pending = later;
    const last = now.at(-1);
    call.waitFor = last ? telnyxWaitsFor(last) : null;
    const g = now.find((x) => "gather" in x) as { gather: { action: string } } | undefined;
    call.gatherFn = g ? new URL(g.gather.action).searchParams.get("fn") ?? "" : "";
    save(call);
    await a.executeActions(call.providerCallId, now, { clientState: call.id });
    return;
  }
  await a.executeActions(call.providerCallId, actions);
}

/* ---------------------------------------------------------------- waiting */

/** A waiting run asks what happened after `cursor` (it polls: the webhook may land in another process). */
export async function waitCall(id: string, cursor: number, timeoutMs: number): Promise<{ call: CallView; events: TelCall["events"] } | null> {
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 25_000));
  for (;;) {
    const call = await getCall(id);
    if (!call) return null;
    const final = FINAL_CALL_STATUSES.includes(call.status);
    if (call.seq > cursor || final || Date.now() >= deadline) return { call: callView(call), events: call.events.filter((e) => e.seq > cursor) };
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ---------------------------------------------------------------- events */

const HANDLER_OF: Partial<Record<CallStatus, HandlerEvent>> = { completed: "hangup", busy: "busy", "no-answer": "noanswer", failed: "failed", canceled: "failed", machine: "machine" };

/** Applies one provider event to a call; returns true when the status moved. (6.9: also the TSA layer's.) */
export function applyCallEvent(call: TelCall, ev: NormalizedCallEvent): boolean { return apply(call, ev); }

function apply(call: TelCall, ev: NormalizedCallEvent): boolean {
  if (ev.eventId && call.events.some((e) => e.note === ev.eventId)) return false; // a retried webhook
  const was = call.status;
  if (ev.status && !FINAL_CALL_STATUSES.includes(call.status)) call.status = ev.status;
  if (ev.status === "answered" && !call.answeredAt) call.answeredAt = Date.now();
  if (ev.status && FINAL_CALL_STATUSES.includes(ev.status) && !call.endedAt) {
    call.endedAt = Date.now();
    call.durationSec = ev.durationSec ?? (call.answeredAt ? Math.round((call.endedAt - call.answeredAt) / 1000) : 0);
  }
  if (!call.providerCallId && ev.callId) call.providerCallId = ev.callId;
  call.seq += 1;
  call.events.push({ seq: call.seq, at: Date.now(), kind: ev.kind, status: ev.status, ...(ev.digits ? { digits: ev.digits } : {}), ...(ev.cause ? { cause: ev.cause } : {}), ...(ev.sipCode ? { sipCode: ev.sipCode } : {}), ...(ev.durationSec !== undefined ? { durationSec: ev.durationSec } : {}), ...(ev.eventId ? { note: ev.eventId } : {}) });
  if (call.events.length > 200) call.events.splice(0, call.events.length - 200);
  return call.status !== was;
}

/** The Telnyx event type behind a parsed event (its raw envelope). */
const telnyxType = (ev: NormalizedCallEvent): string => String(((ev.raw as { data?: { event_type?: string } } | null)?.data?.event_type) ?? "");

export type WebhookReply = { status: number; type: string; body: string };
const ok = (): WebhookReply => ({ status: 200, type: "application/json", body: "{\"ok\":true}" });

export function rendered(call: TelCall, actions: CallAction[]): WebhookReply {
  const a = adapter(call.provider);
  if (!a?.renderActions) return ok();
  const r = a.renderActions(actions);
  return { status: 200, type: r.contentType, body: r.body };
}

/** A request to /wh/tel/<token>/<kind>. */
export async function handleCallWebhook(call: TelCall, kind: string, body: unknown, query: Record<string, string>): Promise<WebhookReply> {
  if (call.tsa && tsaCalls) return tsaCalls(call, kind, body, query);
  if (kind === "tsa") return { status: 404, type: "application/json", body: "{\"ok\":false}" };
  const a = adapter(call.provider);
  const events = a?.parseCallEvent ? a.parseCallEvent(body, query) : [];
  const finals: HandlerEvent[] = [];
  let answeredNow = false;
  for (const ev of events) {
    const moved = apply(call, ev);
    if (moved && ev.status === "answered") answeredNow = true;
    if (moved && ev.status && HANDLER_OF[ev.status]) finals.push(HANDLER_OF[ev.status]!);
  }
  save(call);
  for (const ev of events) if (ev.status && FINAL_CALL_STATUSES.includes(ev.status)) note(call, `call ${ev.status}${ev.cause ? ` (${ev.cause})` : ""}`, ev.status === "completed" ? "info" : "notice", { durationSec: call.durationSec });
  if (call.bridge && bridgeObserver && events.length) bridgeObserver(call, events);

  // Final statuses and "status" run their handlers after the provider has its answer.
  const later = () => {
    for (const h of finals) void handler(call, h);
    if (call.handlers.status && events.length) void handler(call, "status");
  };

  if (kind === "answer") {
    if (!call.answeredAt) { call.answeredAt = Date.now(); save(call); }
    // hold=1: the line kept open for a waiting run — its steer when there is one, else keep holding.
    const actions = query.hold ? (call.steer?.actions.length ? resolveActions(call, call.steer.actions) : holdActions(call)) : await answerLogic(call);
    if (call.steer) { call.steer = null; save(call); }
    later();
    return rendered(call, actions);
  }
  if (kind === "gather" && call.bridge && bridgeDigits) {
    const digits = events.find((e) => e.digits !== undefined)?.digits ?? "";
    return rendered(call, await bridgeDigits(call, digits));
  }
  if (kind === "gather" || kind === "record") {
    const fn = query.fn || call.handlers.digits || "";
    const out = actionsOf(await handlerInTime(call, "digits", fn));
    later();
    if (out) return rendered(call, resolveActions(call, out));
    // A waiting run reads the digits (m5.telephony.wait) and steers; nobody waits: the call ends.
    return rendered(call, call.mode === "sync" ? holdActions(call) : [{ hangup: {} }]);
  }

  // "event": progress — and, for Telnyx, the next step of the call.
  if (call.provider === "telnyx") {
    for (const ev of events) {
      const type = telnyxType(ev);
      if (answeredNow && type === "call.answered") {
        const actions = await answerLogic(call);
        await execute(call, actions).catch((err) => note(call, `actions failed: ${(err as Error).message}`, "warn"));
      } else if (call.waitFor && type === call.waitFor) {
        call.waitFor = null;
        if (type === "call.gather.ended" && call.bridge && bridgeDigits) {
          call.pending = [];
          await execute(call, await bridgeDigits(call, ev.digits ?? "")).catch((err) => note(call, `actions failed: ${(err as Error).message}`, "warn"));
        } else if (type === "call.gather.ended") {
          const out = actionsOf(await handler(call, "digits", call.gatherFn));
          const next = out ? resolveActions(call, out) : call.pending.length ? call.pending : call.mode === "sync" ? [] : [{ hangup: {} } as CallAction];
          call.pending = [];
          if (next.length) await execute(call, next).catch((err) => note(call, `actions failed: ${(err as Error).message}`, "warn"));
        } else if (call.pending.length) {
          const next = call.pending;
          call.pending = [];
          await execute(call, next).catch((err) => note(call, `actions failed: ${(err as Error).message}`, "warn"));
        }
        save(call);
      }
    }
  }
  // Twilio / Vonage asked the answer webhook for the logic already; their "answered" status only records.
  later();
  return ok();
}

/* --------------------------------------------------------------- messages */

export type SendMessageOptions = {
  channel: "sms" | ChatChannel;
  to: string;
  from?: string;
  text?: string;
  provider?: string;
  template?: { name: string; language: string; params?: string[] };
  media?: { url: string; type: "image" | "audio" | "video" | "file" };
  category?: string;
  tag?: string;
  options?: Record<string, unknown>;
  onStatus?: string;
  owner: TelOwner | null;
};

export async function sendMessage(o: SendMessageOptions): Promise<TelMessage> {
  await telStore.ready();
  if (o.channel !== "messenger" && !isE164(o.to)) throw new TelError("bad-argument", "to must be an E.164 number, e.g. +420603123456");
  const a = pickAdapter(o.channel, o.provider);
  const now = Date.now();
  const msg: TelMessage = {
    id: telId("tm"), token: telToken(), provider: a.id, providerId: "", channel: o.channel, from: o.from ?? "", to: o.to, status: "queued",
    owner: o.owner, onStatus: o.onStatus ?? "", events: [], createdAt: now, updatedAt: now, parts: null, price: "",
  };
  telStore.messages.put(msg);
  let statusUrl = "";
  try { statusUrl = hookUrl(msg.token, "status"); } catch { /* no PUBLIC_BASE_URL: no delivery reports */ }
  try {
    if (o.channel === "sms") {
      const text = String(o.text ?? "");
      if (!text.trim()) throw new TelError("bad-argument", "text is required");
      const opts = (o.options ?? {}) as Record<string, unknown>;
      const r = await a.sendSms!({ to: o.to, ...(o.from ? { from: o.from } : {}), text: text.slice(0, 1600), options: {
        ...(typeof opts.unicode === "boolean" ? { unicode: opts.unicode } : {}),
        ...(typeof opts.ttl === "number" ? { ttl: opts.ttl } : {}),
        ...(typeof opts.clientRef === "string" ? { clientRef: opts.clientRef } : {}),
        ...(typeof opts.messagingServiceSid === "string" ? { messagingServiceSid: opts.messagingServiceSid } : {}),
        ...(typeof opts.messagingProfileId === "string" ? { messagingProfileId: opts.messagingProfileId } : {}),
        ...(typeof opts.sendAt === "string" ? { sendAt: opts.sendAt } : {}),
        ...(statusUrl ? { statusUrl } : {}),
      } });
      msg.providerId = r.id; msg.status = r.status; msg.parts = r.parts ?? null; msg.price = r.price ?? "";
    } else {
      if (!a.sendChat) throw new TelError("unsupported", `${a.label} cannot send ${o.channel}`);
      const r = await a.sendChat({ channel: o.channel, to: o.to, ...(o.from ? { from: o.from } : {}), ...(o.text ? { text: o.text } : {}), ...(o.template ? { template: o.template } : {}), ...(o.media ? { media: o.media } : {}), ...(o.category ? { category: o.category } : {}), ...(o.tag ? { tag: o.tag } : {}), ...(statusUrl ? { statusUrl } : {}) });
      msg.providerId = r.id; msg.status = r.status;
    }
    msg.updatedAt = Date.now();
    telStore.messages.put(msg);
    telStore.record({ kind: o.channel, level: "info", ref: msg.id, provider: a.id, summary: `${o.channel} to ${o.to}: ${msg.status}`, detail: { parts: msg.parts } });
    return msg;
  } catch (err) {
    msg.status = "failed";
    msg.events.push({ at: Date.now(), status: "failed", error: (err as Error).message.slice(0, 300) });
    telStore.messages.put(msg);
    telStore.record({ kind: o.channel, level: "warn", ref: msg.id, provider: a.id, summary: `${o.channel} to ${o.to} failed: ${(err as Error).message.slice(0, 200)}`, detail: {} });
    throw err;
  }
}

/** A delivery report → the message's status (and its handler). */
export function messageStatusOf(provider: ProviderId, body: unknown, query: Record<string, string>): { providerId: string; status: string; error: string } {
  const p = { ...query, ...stringParams(body) };
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (provider === "twilio") return { providerId: p.MessageSid || p.SmsSid || "", status: (p.MessageStatus || p.SmsStatus || "").toLowerCase(), error: p.ErrorCode || "" };
  if (provider === "telnyx") {
    const payload = ((b.data as { payload?: Record<string, unknown> } | undefined)?.payload ?? {}) as { id?: string; to?: Array<{ status?: string }>; errors?: Array<{ detail?: string }> };
    return { providerId: String(payload.id ?? ""), status: String(payload.to?.[0]?.status ?? (b.data as { event_type?: string } | undefined)?.event_type ?? ""), error: String(payload.errors?.[0]?.detail ?? "") };
  }
  // Vonage: SMS API delivery receipts (messageId, status) or Messages API (message_uuid, status).
  return { providerId: p.messageId || p["message-id"] || String(b.message_uuid ?? ""), status: (p.status || String(b.status ?? "")).toLowerCase(), error: p["err-code"] && p["err-code"] !== "0" ? p["err-code"] : String((b.error as { title?: string } | undefined)?.title ?? "") };
}

export async function handleMessageWebhook(msg: TelMessage, body: unknown, query: Record<string, string>): Promise<WebhookReply> {
  const s = messageStatusOf(msg.provider, body, query);
  if (s.status && s.status !== msg.status) {
    msg.status = s.status;
    msg.events.push({ at: Date.now(), status: s.status, ...(s.error ? { error: s.error.slice(0, 200) } : {}) });
    if (msg.events.length > 50) msg.events.splice(0, msg.events.length - 50);
    msg.updatedAt = Date.now();
    telStore.messages.put(msg);
    if (msg.onStatus && msg.owner && runHandler) void runHandler(msg.owner, msg.onStatus, { event: "status", message: messageView(msg) }).catch(() => undefined);
  }
  return ok();
}

export type MessageView = Omit<TelMessage, "token" | "owner" | "onStatus">;
export function messageView(m: TelMessage): MessageView { const { token: _t, owner: _o, onStatus: _s, ...rest } = m; return rest; }

/* ---------------------------------------------------------------- routes */

type Req = Request & { rawBody?: Buffer };

/** /wh/tel/<token>/<kind> — mounted on the main app next to the provider webhooks. */
export async function telWebhook(req: Req, token: string, kind: string): Promise<WebhookReply> {
  await telStore.ready();
  const query = stringParams(req.query);
  const call = kind === "status" ? null : telStore.callByToken(token);
  const msg = call ? null : telStore.messageByToken(token);
  const provider = call?.provider ?? msg?.provider;
  if (!provider || !isProvider(provider)) return { status: 404, type: "application/json", body: "{\"ok\":false}" };
  const type = msg && provider === "vonage" && msg.channel === "sms" ? "sms_status" : kind;
  const v = verifyRequest(provider, type, req);
  if (v.enforced && !v.verified) {
    telStore.record({ kind: "webhook", level: "warn", ref: call?.id ?? msg?.id ?? "", provider, summary: `webhook ${kind}: signature verification FAILED (refused)`, detail: {} });
    return { status: 403, type: "application/json", body: "{\"ok\":false,\"message\":\"signature verification failed\"}" };
  }
  if (msg) return handleMessageWebhook(msg, req.body, query);
  return handleCallWebhook(call!, kind, req.body, query);
}

export { ProviderError, ProviderNotConfigured };
