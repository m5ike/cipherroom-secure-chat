// m5.telephony for functions (6.0), host-side: who may call, text, look up
// or rent a number, and on whose account — then the engine
// (telephony/engine.ts) does it.
//
// Who may:
//   a person's run (chat, the console)  their own Telephony & SIP rights —
//        call, sms, message, lookup, hlr, did — and the numbers the rules
//        allow ("number:+420*"); a console owner may always
//   a run nobody started (a webhook, a schedule, the API, a call's handler
//        started by the provider)  the model's grant (Functions › model ›
//        Beyond the caller): the same rights, given to the model
// Paid operations are counted per model: TELEPHONY_FN_RATE a minute
// (default 30), so a loop cannot run up a bill.
//
// 6.9: every call and SMS then goes through the control plane (the outbound
// permissions and rules, telephony/control/enforce.ts) on the caller's
// hourly budget ("model:<id>", or the person for a draft) — and
// m5.telephony.inroute.* (the "inroute" right) adds, removes and lists the
// model's route codes (telephony/control/inroute.ts).

import { checkAccess, adminSubject, userSubject, type Subject } from "../access";
import { accountStore, usernameOf } from "../accounts/store";
import { clientConfigStore } from "../client-config";
import { compileRights, permits } from "../../client/src/lib/modules";
import { providerStatuses } from "../telephony/providers";
import {
  callView, getCall, hangup, messageView, placeCall, sendMessage, steer, TelError, waitCall,
  type PlaceCallOptions,
} from "../telephony/engine";
import { telStore, HANDLER_EVENTS, type HandlerEvent, type TelOwner } from "../telephony/tel-store";
import { lookupNumber, hlrNumber } from "../telephony/lookup";
import { allocateBridge, bridgeView, getBridge, listBridges, releaseBridge } from "../telephony/bridge";
import { InrouteError, inrouteAdd, inrouteDel, inrouteList } from "../telephony/control/inroute";
import type { InrouteEntry } from "../telephony/control/types";
import { parseEntry, type Caller, type Model } from "./types";

export class TelCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TelCallError"; }
}

export type TelContext = { model: Model; caller: Caller; runId: string; chainId: string };

/* ---------------------------------------------------------------- access */

const PERSONS = new Set(["console", "user", "guest"]);

function subjectOf(caller: Caller): Subject {
  if (caller.kind === "console") return adminSubject(caller.name, caller.adminRole ?? "operator");
  if (caller.kind === "user" && caller.account) {
    const acc = accountStore.get(caller.account);
    return userSubject(acc ? usernameOf(acc) : null);
  }
  return userSubject(null);
}

/** May this run do `right` (to `number`)? Throws with the reason when not. */
export function telAllowed(ctx: TelContext, right: string, number?: string): void {
  const rule = clientConfigStore.get().modules.telephony;
  if (rule && rule.enabled === false) throw new TelCallError("module-disabled", "the Telephony & SIP module is switched off (Modules & groups)");
  const needs: Array<readonly string[]> = [[right], ...(number ? [[`number:${number}`]] : [])];
  if (PERSONS.has(ctx.caller.kind)) {
    const c = checkAccess("telephony", subjectOf(ctx.caller), { right: needs, path: `m5.telephony.${right}${number ? ` → ${number}` : ""}`, via: "function" });
    if (!c.allowed) throw new TelCallError("telephony-denied", `${right}${number ? ` to ${number}` : ""} is not among ${ctx.caller.name || "the caller"}'s Telephony & SIP rights (Modules & groups)`);
    return;
  }
  const g = ctx.model.grants?.telephony;
  if (!g?.enabled) throw new TelCallError("telephony-denied", `this model may not use telephony on its own (a ${ctx.caller.kind} run): give it the rights in Functions › model › Beyond the caller`);
  if (!permits(compileRights(g.rights), ...needs)) throw new TelCallError("telephony-denied", `the model's telephony rights do not include ${right}${number ? ` to ${number}` : ""}`);
}

const RATE = () => Math.max(1, Number(process.env.TELEPHONY_FN_RATE) || 30);
const counts = new Map<string, { minute: number; n: number }>();
/** Counts a paid operation of a model; throws past the limit. */
function spend(ctx: TelContext): void {
  const key = ctx.model.id && ctx.model.id !== "__adhoc__" ? ctx.model.id : `console:${ctx.caller.name}`;
  const minute = Math.floor(Date.now() / 60_000);
  const c = counts.get(key);
  const next = c && c.minute === minute ? { minute, n: c.n + 1 } : { minute, n: 1 };
  if (next.n > RATE()) throw new TelCallError("telephony-limit", `at most ${RATE()} paid telephony operations a minute for one model (TELEPHONY_FN_RATE)`);
  counts.set(key, next);
  if (counts.size > 5_000) counts.delete(counts.keys().next().value!);
}

/** The model that placed something, for its handlers — null for code outside a model. */
function ownerOf(ctx: TelContext): TelOwner | null {
  if (!ctx.model.id || ctx.model.id === "__adhoc__") return null;
  const e = parseEntry(ctx.model.entry);
  if (!e) return null;
  return { modelId: ctx.model.id, entry: `${e.pkg}@${e.version}:${e.file}`, chainId: ctx.chainId, runId: ctx.runId, caller: ctx.caller, test: false };
}

/** 6.9: whose hourly budget a call / SMS counts against — the saved model, else the person running a draft. */
function byOf(ctx: TelContext): string {
  if (ctx.model.id && ctx.model.id !== "__adhoc__") return `model:${ctx.model.id}`;
  const c = ctx.caller;
  return c.kind === "console" ? `admin:${c.name}` : c.kind === "user" ? `user:${c.account || c.name}` : `${c.kind}:${c.client || c.name}`;
}

/** 6.9: the groups an outbound rule may name — the person's (Modules & groups); none for a run nobody started. */
const groupsOf = (ctx: TelContext): string[] => (PERSONS.has(ctx.caller.kind) ? subjectOf(ctx.caller).groups : []);

/* ------------------------------------------------------------------ calls */

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

function handlersOf(raw: unknown): Partial<Record<HandlerEvent, string>> {
  const out: Partial<Record<HandlerEvent, string>> = {};
  for (const [k, v] of Object.entries(obj(raw))) {
    const ev = k.replace(/^on_?/, "").replace(/[-_]/g, "").toLowerCase() as HandlerEvent;
    const fn = str(v);
    if (!(HANDLER_EVENTS as readonly string[]).includes(ev) || !fn) continue;
    if (!/^([\w./-]+\.(js|mjs|py)#)?[A-Za-z_$][\w$]*$/.test(fn)) throw new TelCallError("bad-argument", `a handler is a function name ("on_hangup") or "file#fn": ${fn.slice(0, 40)}`);
    out[ev] = fn;
  }
  return out;
}

async function call(ctx: TelContext, spec: Record<string, unknown>) {
  const to = str(spec.to);
  telAllowed(ctx, "call", to);
  const handlers = handlersOf(spec.handlers);
  const owner = ownerOf(ctx);
  if (Object.keys(handlers).length && !owner) throw new TelCallError("bad-argument", "handlers by name need a saved model (in a draft, wait for the call and use callbacks)");
  spend(ctx);
  const raw = spec.twiml || spec.ncco || spec.texml ? { ...(spec.twiml ? { twiml: str(spec.twiml) } : {}), ...(Array.isArray(spec.ncco) ? { ncco: spec.ncco } : {}), ...(spec.texml ? { texml: str(spec.texml) } : {}) } : undefined;
  const actions: unknown[] = Array.isArray(spec.actions) ? spec.actions : [];
  if (typeof spec.say === "string" && spec.say.trim()) actions.unshift({ say: { text: spec.say, ...(spec.voice ? { voice: str(spec.voice) } : {}), ...(spec.language ? { language: str(spec.language) } : {}) } });
  if (typeof spec.play === "string" && spec.play.trim()) actions.unshift({ play: { url: spec.play } });
  const o: PlaceCallOptions = {
    to, ...(spec.from ? { from: str(spec.from) } : {}), ...(spec.provider ? { provider: str(spec.provider) } : {}),
    timeout: spec.timeout === undefined ? 10 : Number(spec.timeout), ...(spec.timeLimit ? { timeLimit: Number(spec.timeLimit) } : {}),
    mode: raw ? "native" : spec.mode === "sync" ? "sync" : "async",
    actions: actions as PlaceCallOptions["actions"], ...(raw ? { raw } : {}), handlers,
    ...(spec.machineDetection ? { machineDetection: true } : {}),
    owner, by: byOf(ctx), groups: groupsOf(ctx), source: "function",
  };
  return callView(await placeCall(o));
}

/* ------------------------------------------------------- route codes (6.9) */

/** Whose route codes these are: the saved model, or the person's draft. */
function inrouteOwner(ctx: TelContext): InrouteEntry["createdBy"] {
  const id = ctx.model.id && ctx.model.id !== "__adhoc__" ? ctx.model.id : `draft:${ctx.caller.kind === "user" ? ctx.caller.account || ctx.caller.name : ctx.caller.name}`;
  return { kind: "model", id, ...(ctx.runId ? { run: ctx.runId } : {}) };
}

/**
 * m5.telephony.inroute.add(code, type = "room", ttl = 600, { room, user, label, maxUses }):
 * the room defaults to the run's room (m5.caller.room), a "user" code's member
 * to the person running it ("@account").
 */
async function inrouteAddOp(ctx: TelContext, spec: Record<string, unknown>): Promise<InrouteEntry> {
  telAllowed(ctx, "inroute");
  const type = str(spec.type) || "room";
  const room = str(spec.room) || str(ctx.caller.room);
  if (!room) throw new TelCallError("bad-argument", "room: the room's blind id (r3.…) — this run has none (m5.caller.room); pass { room }");
  let user = str(spec.user);
  if (type === "user" && !user && ctx.caller.kind === "user") user = `@${ctx.caller.name}`;
  return inrouteAdd({
    code: str(spec.code), ...(spec.digits !== undefined ? { digits: Number(spec.digits) } : {}),
    type: type as InrouteEntry["type"], room, user,
    ...(spec.ttl !== undefined && spec.ttl !== null ? { ttl: Number(spec.ttl) } : {}),
    label: str(spec.label), maxUses: Number(spec.maxUses ?? spec.max_uses) || 0,
    createdBy: inrouteOwner(ctx),
  });
}

/* --------------------------------------------------------------- the calls */

type Op = (ctx: TelContext, args: unknown[]) => Promise<unknown>;

const OPS: Record<string, Op> = {
  providers: async () => providerStatuses().map((p) => ({ id: p.id, label: p.label, capabilities: p.capabilities, configured: p.configured })),
  call: (ctx, a) => call(ctx, obj(a[0])),
  wait: async (_ctx, a) => waitCall(str(a[0]), Number(a[1]) || 0, Number(a[2]) || 15_000),
  "calls.get": async (_ctx, a) => { const c = await getCall(str(a[0])); return c ? { ...callView(c), events: c.events } : null; },
  "calls.list": async (ctx, a) => {
    await telStore.ready();
    const f = obj(a[0]);
    const mine = ownerOf(ctx)?.modelId;
    return telStore.calls.list({ limit: Math.min(Number(f.limit) || 50, 500), filter: (c) => (!mine || c.owner?.modelId === mine) && (!f.status || c.status === f.status) }).map(callView);
  },
  "calls.hangup": async (ctx, a) => { telAllowed(ctx, "call"); return hangup(str(a[0])); },
  "calls.steer": async (ctx, a) => { telAllowed(ctx, "call"); return steer(str(a[0]), a[1]); },
  sms: async (ctx, a) => {
    const s = obj(a[0]);
    const to = str(s.to);
    telAllowed(ctx, "sms", to);
    spend(ctx);
    return messageView(await sendMessage({ channel: "sms", to, ...(s.from ? { from: str(s.from) } : {}), text: str(s.text), ...(s.provider ? { provider: str(s.provider) } : {}), options: obj(s.options), ...(s.on_status || s.onStatus ? { onStatus: str(s.on_status ?? s.onStatus) } : {}), owner: ownerOf(ctx), by: byOf(ctx), source: "function" }));
  },
  message: async (ctx, a) => {
    const channel = str(a[0]) as "whatsapp" | "viber" | "messenger";
    if (!["whatsapp", "viber", "messenger"].includes(channel)) throw new TelCallError("bad-argument", "channel: whatsapp, viber or messenger");
    const s = obj(a[1]);
    const to = str(s.to);
    telAllowed(ctx, "message", channel === "messenger" ? undefined : to);
    spend(ctx);
    const tpl = obj(s.template);
    return messageView(await sendMessage({
      channel, to, ...(s.from ? { from: str(s.from) } : {}), ...(s.text ? { text: str(s.text) } : {}), ...(s.provider ? { provider: str(s.provider) } : {}),
      ...(tpl.name ? { template: { name: str(tpl.name), language: str(tpl.language) || "en", ...(Array.isArray(tpl.params) ? { params: tpl.params.map(str) } : {}) } } : {}),
      ...(obj(s.media).url ? { media: { url: str(obj(s.media).url), type: (["image", "audio", "video", "file"].includes(str(obj(s.media).type)) ? str(obj(s.media).type) : "image") as "image" } } : {}),
      ...(s.category ? { category: str(s.category) } : {}), ...(s.tag ? { tag: str(s.tag) } : {}),
      ...(s.on_status || s.onStatus ? { onStatus: str(s.on_status ?? s.onStatus) } : {}), owner: ownerOf(ctx), by: byOf(ctx), source: "function",
    }));
  },
  "messages.get": async (_ctx, a) => { await telStore.ready(); const m = telStore.messages.get(str(a[0])); return m ? messageView(m) : null; },
  lookup: async (ctx, a) => {
    const o = obj(a[1]);
    // The offline part costs nothing; asking providers is a paid lookup.
    const paid = o.offline !== true;
    if (paid) { telAllowed(ctx, "lookup"); spend(ctx); }
    return lookupNumber(str(a[0]), { offline: !paid, ...(Array.isArray(o.fields) ? { fields: o.fields.map(str) } : {}), ...(Array.isArray(o.providers) ? { providers: o.providers.map(str) } : o.provider ? { providers: [str(o.provider)] } : {}), ...(o.country ? { country: str(o.country) } : {}) });
  },
  hlr: async (ctx, a) => { telAllowed(ctx, "hlr"); spend(ctx); return hlrNumber(str(a[0]), obj(a[1]).provider ? str(obj(a[1]).provider) : undefined); },
  "did.allocate": async (ctx, a) => {
    telAllowed(ctx, "did");
    spend(ctx);
    return bridgeView(await allocateBridge(obj(a[0]), { owner: ownerOf(ctx), caller: ctx.caller.name || ctx.caller.kind }));
  },
  "did.get": async (_ctx, a) => { const b = await getBridge(str(a[0])); return b ? bridgeView(b) : null; },
  "did.list": async (ctx, a) => (await listBridges(obj(a[0]), ownerOf(ctx)?.modelId)).map(bridgeView),
  "did.release": async (ctx, a) => { telAllowed(ctx, "did"); return releaseBridge(str(a[0]), "released by the function"); },
  // 6.9: the inroute table — the model's own route codes.
  "inroute.add": (ctx, a) => inrouteAddOp(ctx, obj(a[0])),
  "inroute.del": async (ctx, a) => { telAllowed(ctx, "inroute"); return inrouteDel(str(a[0]), { owner: inrouteOwner(ctx), by: inrouteOwner(ctx).id }); },
  "inroute.list": async (ctx, a) => { telAllowed(ctx, "inroute"); return inrouteList({ owner: inrouteOwner(ctx), limit: Number(obj(a[0]).limit) || 1000 }); },
  log: async (_ctx, a) => {
    await telStore.ready();
    const f = obj(a[0]);
    return telStore.log.list({ limit: Math.min(Number(f.limit) || 100, 1000), ...(f.ref ? { device: str(f.ref) } : {}), filter: (e) => (!f.kind || e.kind === f.kind) && (!f.level || e.level === f.level) });
  },
};

export const TEL_OPERATIONS = Object.keys(OPS);

/** One m5.telephony call. */
export async function hostTelephony(op: string, args: unknown[], ctx: TelContext): Promise<unknown> {
  const fn = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : undefined;
  if (!fn) throw new TelCallError("unknown-call", `m5.telephony: no such call "${op.slice(0, 40)}"`);
  try { return await fn(ctx, args); }
  catch (err) {
    if (err instanceof TelCallError) throw err;
    if (err instanceof TelError || err instanceof InrouteError) throw new TelCallError(err.code, err.message);
    const e = err as { name?: string; status?: number; message?: string };
    if (e.name === "ProviderNotConfigured") throw new TelCallError("not-configured", e.message ?? "not configured");
    if (e.name === "ProviderError") throw new TelCallError(e.status === 400 ? "bad-argument" : "provider-error", e.message ?? "provider error");
    throw err;
  }
}
