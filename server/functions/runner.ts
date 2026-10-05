// The runner (4.15): turns a model and its inputs into a run and carries it
// out. It resolves the entry's package version and its dependencies from the
// store, builds the spec, hands it to a sandbox process (pool.ts — one child
// per run, so a loop or a crash never touches the main service), streams logs
// and outputs into the store as they arrive, answers the run's m5.* host
// calls (session and cache, backed by the store), and records the finished
// run.
//
// Runs are executed in-process here: the weight of a model is in its sandbox
// child, not in this event loop, which only shuttles small JSON messages. A
// separate `m5cet-runner` daemon can later own the queue for scale; the
// execute() path is written so it can move there unchanged.

import { EventEmitter } from "node:events";
import { SandboxPool, type RunHandlers } from "./sandbox/pool";
import { DEFAULT_LIMITS, MAX_LIMITS, type ModelContext, type Output, type Rejected, type RunLimits, type RunSpec } from "./sandbox/protocol";
import { buildInfo } from "../build-info";
import { functionsStore, newId } from "./store";
import { validateInputs } from "./inputs";
import { httpRequest, dnsResolve } from "./host-net";
import { hostCrypto } from "./host-crypto";
import { hostCode } from "./host-codes";
import { hostAi, AI_RUN_TOKEN_CAP } from "./host-ai";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { ENDPOINT_TYPES, formatEntry, parseEntry, type Caller, type Chain, type ChainCall, type Endpoint, type EndpointType, type Lang, type Model, type Run, type RunLog } from "./types";
import { commandsFor } from "./visibility";
import { storedInputs } from "./webhook-log";
import { endpointOf, endpointTypes, endpointsOf, entryOf, eventInputs } from "./endpoints";
import { admInfo, endAdmRun, hostAdm, type AdmContext } from "./host-adm";
import { consoleGrant, isAdmArea } from "./adm-token";
import { hostTelephony } from "./host-telephony";
import { nfcAllowed, nfcSpend, sanitizeNfcCommand, sanitizeNfcResult } from "./host-nfc";
import { setHandlerRunner } from "../telephony/engine";
import type { TelOwner } from "../telephony/tel-store";
import { openerOf } from "./chain-access";
import { defineStore } from "../define"; // 6.3 define: the operator's typed constants/variables

/** Bytes a sandbox sent as {"$b": base64}; null for anything else. */
function taggedBytes(v: unknown): Buffer | null {
  return v && typeof v === "object" && typeof (v as { $b?: unknown }).$b === "string" ? Buffer.from((v as { $b: string }).$b, "base64") : null;
}

export class RunRefused extends Error {
  /** 6.11: more for the caller — bad-input: { problems } (inputs.ts InputProblem[]). */
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "RunRefused";
  }
}

let pool: SandboxPool | null = null;
function thePool(): SandboxPool {
  pool ??= new SandboxPool({ warmPerLang: Number(process.env.FUNCTIONS_WARM ?? 1) });
  return pool;
}
export function closeRunner(): void { pool?.close(); pool = null; }

/** Live run events for the console (SSE): a log line, an output, progress, a state change. */
export const runEvents = new EventEmitter();
runEvents.setMaxListeners(0);

/* -------------------------------------------------------------- limits */

function limitsFor(model: Model): RunLimits {
  const l = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(l) as (keyof RunLimits)[]) {
    const v = model.limits[k];
    // A model may lower a limit; only the owner's ceiling (MAX_LIMITS) caps it.
    if (typeof v === "number" && v > 0) l[k] = Math.min(v, MAX_LIMITS[k]);
  }
  return l;
}

/* -------------------------------------------------------- build a spec */

/** Resolves a model's entry and its package dependencies into a run spec. */
export function buildSpec(model: Model, inputs: Record<string, unknown>, caller: Caller, executor: string, opts: { test: boolean; runId: string; sessionId: string; parent: string | null; entry?: string; model?: ModelContext }): RunSpec {
  const entrySpec = opts.entry || model.entry;
  const entry = parseEntry(entrySpec);
  if (!entry) throw new RunRefused("bad-entry", `The entry point "${entrySpec}" is malformed.`);
  const version = functionsStore.versionByName(entry.pkg, entry.version);
  if (!version) throw new RunRefused("no-package", `The package ${entry.pkg}@${entry.version} is not published.`);
  if (!Object.prototype.hasOwnProperty.call(version.files, entry.file)) throw new RunRefused("no-file", `${entry.pkg}@${entry.version} has no file ${entry.file}.`);

  const deps: RunSpec["deps"] = {};
  const seen = new Set<string>();
  const resolveDeps = (name: string, ver: string, chain: string[]): void => {
    const key = `${name}@${ver}`;
    if (seen.has(key)) return;
    if (chain.includes(name)) throw new RunRefused("dep-cycle", `The packages import each other in a circle (${[...chain, name].join(" → ")}).`);
    seen.add(key);
    const dv = functionsStore.versionByName(name, ver);
    if (!dv) throw new RunRefused("no-package", `The dependency ${name}@${ver} is not published.`);
    deps[name] = { version: ver, main: dv.manifest.main, files: dv.files };
    for (const [dn, dver] of Object.entries(dv.manifest.dependencies ?? {})) resolveDeps(dn, dver, [...chain, name]);
  };
  for (const [name, ver] of Object.entries(version.manifest.dependencies ?? {})) resolveDeps(name, ver, [entry.pkg]);

  const limits = limitsFor(model);
  const now = Date.now();
  return {
    id: opts.runId,
    lang: version.manifest.language,
    files: version.files,
    deps,
    entry: { file: entry.file, fn: entry.fn },
    inputs,
    context: {
      run: { id: opts.runId, model: model.id, executor, parent: opts.parent, startedAt: now, deadline: now + limits.wallMs, test: opts.test, entry: entrySpec },
      caller: { kind: caller.kind, name: caller.name, groups: caller.groups, room: caller.room, client: caller.client, lang: caller.lang, tz: caller.tz },
      sys: { version: buildInfo().version, instance: process.env.INSTANCE_ID?.trim() || "m5cet" },
      session: { id: opts.sessionId },
      ...(opts.model ? { model: opts.model } : {}),
      define: defineStore.values("both"), // 6.3 define: per-run snapshot of m5mobile.define
    },
    limits,
  };
}

/* ------------------------------------------------ processing sessions (5.3) */

/** Calls a processing session may have (m5.model.calls); a longer conversation starts a new one. */
export const CHAIN_MAX_CALLS = 500;
/** Bytes of one call's parms / result kept in the session (the rest is cut, with a preview). */
const CHAIN_VALUE_MAX = 64_000;
/** Bytes of m5.model.calls a run gets: the oldest results make way first. */
const CHAIN_CONTEXT_MAX = 512_000;

function capValue(v: unknown, max = CHAIN_VALUE_MAX): unknown {
  let s: string;
  try { s = JSON.stringify(v ?? null) ?? "null"; } catch { return String(v); }
  return s.length <= max ? JSON.parse(s) : { truncated: true, bytes: s.length, preview: s.slice(0, 2000) };
}

/** A new processing session — the first call (execute, a webhook) opens one. */
export function newChain(modelId: string, source: Chain["source"] = { kind: "model" }): Chain {
  // 96 random bits: a message carries it, and a click or a reply needs it (with the model's own access check).
  const id = `chn_${Date.now().toString(36)}${randomBytes(12).toString("hex")}`;
  const now = Date.now();
  return { id, modelId, sessionId: functionsStore.session(modelId, `chain\0${id}`), source, calls: [], createdAt: now, updatedAt: now };
}

/** m5.model.calls as a run gets it: everything, unless it is too big — then the oldest results are left out. */
function callsForContext(calls: ChainCall[]): ModelContext["calls"] {
  const list = calls.map((c) => ({ ...c }));
  let size = JSON.stringify(list).length;
  for (let i = 0; size > CHAIN_CONTEXT_MAX && i < list.length - 1; i++) {
    const before = JSON.stringify(list[i]).length;
    list[i] = { ...list[i], result: { truncated: true }, parms: { truncated: true } };
    size -= before - JSON.stringify(list[i]).length;
  }
  return list;
}

function modelContext(model: Pick<Model, "id" | "name" | "keyword"> & Partial<Model>, chain: Chain, callId: number, type: EndpointType, endpointId: string, types: EndpointType[]): ModelContext {
  return { id: model.id || null, name: model.name ?? "", keyword: model.keyword ?? "", type, endpoint: endpointId, chain: chain.id, call: callId, calls: callsForContext(chain.calls), endpoints: types };
}

/** Records the start of a call in its processing session (and returns its index). */
function openCall(chain: Chain, call: Omit<ChainCall, "id" | "result" | "status" | "err_msg">): number {
  if (chain.calls.length >= CHAIN_MAX_CALLS) throw new RunRefused("chain-full", `This conversation with the model has ${CHAIN_MAX_CALLS} calls; start it again.`);
  const id = chain.calls.length;
  chain.calls.push({ id, ...call, parms: capValue(call.parms) as Record<string, unknown>, result: null, status: "running", err_msg: "" });
  chain.updatedAt = Date.now();
  functionsStore.saveChain(chain);
  return id;
}

/** Records how a call ended (re-read first: another call may have joined meanwhile). */
function closeCall(chainId: string, callId: number, patch: Pick<ChainCall, "status" | "err_msg" | "result">): void {
  const chain = functionsStore.chain(chainId);
  if (!chain || !chain.calls[callId]) return;
  chain.calls[callId] = { ...chain.calls[callId], status: patch.status, err_msg: patch.err_msg, result: capValue(patch.result) };
  chain.updatedAt = Date.now();
  functionsStore.saveChain(chain);
}

/* ---------------------------------------------------- live interactions */

type InteractionKind = "prompt" | "form" | "nfc";

/** 6.7 (F-18): runs that read a card (an answered m5.nfc call) — their
 *  record is marked sensitive and pruned after FUNCTIONS_NFC_RUN_HOURS. */
const cardRuns = new Set<string>();
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; kind?: InteractionKind; spec?: unknown; at?: number };
const interactions = new Map<string, Map<string, Pending>>();
const PROMPT_TTL_MS = 5 * 60 * 1000;

class InteractionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "InteractionError"; }
}

/** Delivers the caller's answer to a waiting m5.prompt / m5.form. Returns
 *  false when there is no such open question (already answered, or timed out). */
export function answerRun(runId: string, interactionId: string, value: unknown): boolean {
  const forRun = interactions.get(runId);
  const pending = forRun?.get(interactionId);
  if (!pending || !forRun) return false;
  clearTimeout(pending.timer);
  forRun.delete(interactionId);
  if (!forRun.size) interactions.delete(runId);
  pending.resolve(value);
  return true;
}

/** 5.2: a run's open questions (m5.prompt / m5.form) — for webhook callers that poll and answer. */
export function openInteractions(runId: string): Array<{ id: string; kind: string; spec: unknown; at: number }> {
  const forRun = interactions.get(runId);
  return forRun ? [...forRun.entries()].map(([id, p]) => ({ id, kind: p.kind ?? "prompt", spec: p.spec ?? {}, at: p.at ?? 0 })) : [];
}

/** Public: cancel a run's open questions because the caller went away. */
export function endInteractionsFor(runId: string): void { endInteractions(runId, "the caller left"); }

/** 6.11: a run's network work (m5.http, m5.ai) — aborted when the run is cancelled. */
const runAborts = new Map<string, AbortController>();
/** 6.11: runs cancelled before their sandbox took them (the caller left at once): run id → when. */
const cancelRequests = new Map<string, { at: number; why: string }>();
const CANCEL_REQUEST_TTL_MS = 10 * 60_000;
/** Runs told to stop while in their sandbox (run id → why): however the sandbox then ends, a run that did not finish was cancelled. */
const cancelling = new Map<string, string>();

/**
 * 6.11: stops a run — its caller went away (the chat's stream closed): its
 * open questions are cancelled, its HTTP / AI calls aborted, and its sandbox
 * stops; the run is recorded as "cancelled" (and its error entry point does
 * not run — nobody is there for its answer). A run that has not reached its
 * sandbox yet is stopped as it gets there. True when a running run was told.
 */
export function cancelRun(runId: string, why = "the run was cancelled"): boolean {
  if (pool?.cancel(runId, why)) {
    cancelling.set(runId, why);
    endInteractions(runId, why);
    runAborts.get(runId)?.abort(new Error(why));
    return true;
  }
  endInteractions(runId, why);
  const now = Date.now();
  for (const [id, r] of cancelRequests) if (now - r.at > CANCEL_REQUEST_TTL_MS) cancelRequests.delete(id);
  cancelRequests.set(runId, { at: now, why });
  return false;
}

/* ------------------------------------------- 6.11: "still waiting" notices */

/**
 * While a run waits on the host (DNS, HTTP, AI, telephony, m5adm, a webhook…)
 * its compute watchdog is paused — and its caller hears nothing. The chat
 * gives up on a run that sends no event for 30 s (pings do not count), so a
 * run whose oldest host call has waited WAIT_NOTICE_MS, and that has sent
 * nothing for WAIT_EVERY_MS, gets a `progress` event naming what it waits for:
 *   { runId, type: "progress", p: <its last p, or null>, text: "Waiting for DNS answers (3 of 17)…",
 *     waiting: { kind: "dns", pending: 3, total: 17, ms: 12000 } }
 * A run that reports progress itself, or calls that answer quickly, get none.
 * The caller's own questions (m5.prompt / m5.form / NFC) are not counted: the
 * chat pauses its clock while one is open.
 */
export type WaitKind = "dns" | "http" | "ai" | "telephony" | "adm" | "crypto" | "codes" | "webhook";
const WAIT_TEXT: Record<WaitKind, [one: string, many: string]> = {
  dns: ["a DNS answer", "DNS answers"],
  http: ["a web server", "web servers"],
  ai: ["the AI model", "the AI model"],
  telephony: ["the telephony provider", "the telephony provider"],
  adm: ["the administration", "the administration"],
  crypto: ["a cryptographic operation", "cryptographic operations"],
  codes: ["a code to be drawn", "codes to be drawn"],
  webhook: ["a webhook", "webhooks"],
};
/** Read at each check, so an operator (or a test) may tune them: the first notice after this much waiting… */
const waitNoticeMs = () => Math.max(50, Number(process.env.FUNCTIONS_WAIT_NOTICE_MS) || 10_000);
/** …and then at most this long without any event to the caller. */
const waitEveryMs = () => Math.max(50, Number(process.env.FUNCTIONS_WAIT_EVERY_MS) || 10_000);

type RunWaits = {
  calls: Map<number, { kind: WaitKind; since: number }>;
  batches: Map<WaitKind, { total: number; pending: number }>;
  timer: ReturnType<typeof setInterval> | null;
  lastP: number | null;
  /** The last event the caller got (a progress, an output, a question, a notice). */
  lastEvent: number;
};
const runWaits = new Map<string, RunWaits>();
let waitSeq = 0;

function waitsOf(runId: string): RunWaits {
  let w = runWaits.get(runId);
  if (!w) { w = { calls: new Map(), batches: new Map(), timer: null, lastP: null, lastEvent: Date.now() }; runWaits.set(runId, w); }
  return w;
}
/** The run told its caller something (it counts as a sign of life). */
function runActivity(runId: string, p?: number): void {
  const w = runWaits.get(runId);
  if (!w) return;
  w.lastEvent = Date.now();
  if (typeof p === "number" && Number.isFinite(p)) w.lastP = p;
}
/** The text of a notice: the oldest kind first ("Waiting for DNS answers (3 of 17) and a web server…"). */
function waitText(w: RunWaits): { text: string; kind: WaitKind; pending: number; total: number } {
  const byAge = [...w.calls.values()].sort((a, b) => a.since - b.since);
  const kinds = [...new Set(byAge.map((c) => c.kind))].slice(0, 2);
  const part = (k: WaitKind) => { const b = w.batches.get(k) ?? { total: 1, pending: 1 }; return b.total > 1 ? `${WAIT_TEXT[k][1]} (${b.pending} of ${b.total})` : WAIT_TEXT[k][0]; };
  const first = w.batches.get(kinds[0]) ?? { total: 1, pending: 1 };
  return { text: `Waiting for ${kinds.map(part).join(" and ")}…`, kind: kinds[0], pending: first.pending, total: first.total };
}
function waitTick(runId: string, w: RunWaits): void {
  if (!w.calls.size) return;
  const now = Date.now();
  const oldest = Math.min(...[...w.calls.values()].map((c) => c.since));
  if (now - oldest < waitNoticeMs() || now - w.lastEvent < waitEveryMs()) return;
  const t = waitText(w);
  w.lastEvent = now;
  runEvents.emit("run", { runId, type: "progress", p: w.lastP, text: t.text, waiting: { kind: t.kind, pending: t.pending, total: t.total, ms: now - oldest } });
}
/** Counts a host call the run waits on (see above); the notices stop when nothing is pending. */
function hostWait<T>(runId: string, kind: WaitKind, p: Promise<T>): Promise<T> {
  const w = waitsOf(runId);
  const id = ++waitSeq;
  w.calls.set(id, { kind, since: Date.now() });
  const batch = w.batches.get(kind) ?? { total: 0, pending: 0 };
  batch.total++; batch.pending++;
  w.batches.set(kind, batch);
  if (!w.timer) {
    w.timer = setInterval(() => waitTick(runId, w), Math.max(25, Math.min(waitNoticeMs(), waitEveryMs()) / 4));
    w.timer.unref?.();
  }
  const done = () => {
    w.calls.delete(id);
    if (--batch.pending <= 0 && w.batches.get(kind) === batch) w.batches.delete(kind);
    if (!w.calls.size && w.timer) { clearInterval(w.timer); w.timer = null; }
  };
  return p.then((v) => { done(); return v; }, (e) => { done(); throw e; });
}
function endWaits(runId: string): void {
  const w = runWaits.get(runId);
  if (w?.timer) clearInterval(w.timer);
  runWaits.delete(runId);
}

/** Runs the spec in a sandbox — unless the run was cancelled before it got there. */
async function runSandboxed(spec: RunSpec, handlers: RunHandlers): Promise<Awaited<ReturnType<SandboxPool["run"]>>> {
  const early = cancelRequests.get(spec.id);
  if (early) { cancelRequests.delete(spec.id); return { ok: false, error: { type: "Cancelled", message: early.why }, ms: 0, memMb: 0, engine: "" }; }
  runAborts.set(spec.id, new AbortController());
  waitsOf(spec.id).lastEvent = Date.now();
  try {
    const r = await thePool().run(spec, handlers);
    const why = cancelling.get(spec.id);
    // A question that failed, a call that was cut: the run stopped because it was cancelled.
    return why !== undefined && !r.ok ? { ...r, error: { type: "Cancelled", message: why } } : r;
  } finally { runAborts.delete(spec.id); cancelling.delete(spec.id); endWaits(spec.id); }
}

/** A finished sandbox run's status. */
const statusOf = (r: Awaited<ReturnType<SandboxPool["run"]>>): Run["status"] => (r.ok ? "done" : r.error.type === "TimeLimit" ? "timed-out" : r.error.type === "Cancelled" ? "cancelled" : "failed");

/** Cancels every open question of a run (it finished, failed or was cancelled). */
function endInteractions(runId: string, why: string): void {
  const forRun = interactions.get(runId);
  if (!forRun) return;
  interactions.delete(runId);
  for (const p of forRun.values()) { clearTimeout(p.timer); p.reject(new InteractionError("cancelled", why)); }
}

/** Registers a question and waits for its answer (or a timeout). `ttlMs`
 *  overrides the default wait (an NFC op may sit waiting for a card). */
function ask(runId: string, kind: InteractionKind, spec: unknown, control: Parameters<RunHandlers["host"]>[2], ttlMs = PROMPT_TTL_MS): Promise<unknown> {
  const id = newId("int");
  return control.wait(new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      const forRun = interactions.get(runId);
      forRun?.delete(id);
      if (forRun && !forRun.size) interactions.delete(runId);
      reject(new InteractionError("timeout", "the question was not answered in time"));
    }, Math.max(1000, Math.min(ttlMs, PROMPT_TTL_MS)));
    timer.unref?.();
    let forRun = interactions.get(runId);
    if (!forRun) { forRun = new Map(); interactions.set(runId, forRun); }
    forRun.set(id, { resolve, reject, timer, kind, spec, at: Date.now() });
    runActivity(runId);
    runEvents.emit("run", { runId, type: "interaction", interaction: { id, kind, spec } });
  }));
}

/* ------------------------------------------------------- run webhooks */

type Mailbox = { runId: string; delivered: unknown[]; waiter: ((v: unknown) => void) | null; timer: ReturnType<typeof setTimeout> | null };
const mailboxes = new Map<string, Mailbox>();
const runTokens = new Map<string, Set<string>>();
/** AI tokens spent per run, for the per-run budget (AI_RUN_TOKEN_CAP). */
const aiTokens = new Map<string, number>();

/** The public base URL for webhook URLs; empty when not configured (the path
 *  is still returned so a reverse proxy or the caller can prefix it). */
export function functionsPublicUrl(): string {
  return (process.env.PUBLIC_URL || process.env.M5CET_PUBLIC_URL || "").trim().replace(/\/+$/, "");
}

function makeWebhook(runId: string, spec: { once?: boolean; durable?: boolean; ttl?: unknown }, model: Model, sessionId: string, caller: Caller): { token: string; url: string; path: string; durable: boolean } {
  const token = randomBytes(24).toString("base64url");
  mailboxes.set(token, { runId, delivered: [], waiter: null, timer: null });
  let set = runTokens.get(runId);
  if (!set) { set = new Set(); runTokens.set(runId, set); }
  set.add(token);
  // Durable: persist so an inbound POST after the run ends (even after a
  // restart) runs the model's on_event in a new run of this session.
  const durable = Boolean(spec.durable) && Boolean(model.onEvent);
  if (durable) {
    const ttlMs = ttlToMs(spec.ttl);
    functionsStore.saveWebhook({ token, modelId: model.id, sessionId, caller, entry: model.onEvent, once: Boolean(spec.once), expiresAt: ttlMs ? Date.now() + ttlMs : null, createdAt: Date.now() });
  }
  const path = `/hooks/r/${token}`;
  return { token, url: `${functionsPublicUrl()}${path}`, path, durable };
}

function ttlToMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(v).trim());
  if (!m) return null;
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || "ms"] ?? 1);
}

/** An inbound POST to a durable webhook: run the model's on_event in a new run
 *  of the saved session. Returns false when the token is not a durable webhook. */
export async function triggerDurableWebhook(token: string, payload: unknown): Promise<boolean> {
  await functionsStore.ready();
  const hook = functionsStore.webhook(token);
  if (!hook) return false;
  const model = functionsStore.model(hook.modelId);
  if (!model || !model.onEvent) { functionsStore.deleteWebhook(token); return false; }
  if (hook.once) functionsStore.deleteWebhook(token);
  const event = { type: "webhook", ...(payload && typeof payload === "object" ? payload as object : { body: payload }) };
  await execute(model, event as Record<string, unknown>, hook.caller, { executor: "webhook", entry: hook.entry, sessionId: hook.sessionId, skipValidation: true, parent: null, callType: "webhook" }).catch((err) => { console.warn(`[functions] on_event ${token}: ${(err as Error).message}`); });
  return true;
}

/** Delivers an inbound webhook body to a run waiting on it (m5.webhook.wait),
 *  or holds it until the run waits. Returns false for an unknown token. */
export function deliverWebhook(token: string, payload: unknown): boolean {
  const box = mailboxes.get(token);
  if (!box) return false;
  if (box.waiter) { const w = box.waiter; box.waiter = null; if (box.timer) { clearTimeout(box.timer); box.timer = null; } w(payload); }
  else box.delivered.push(payload);
  return true;
}

function waitWebhook(token: string, timeoutMs: number, control: Parameters<RunHandlers["host"]>[2]): Promise<unknown> {
  const box = mailboxes.get(token);
  if (!box) return Promise.reject(new InteractionError("no-webhook", "that webhook does not exist (create it first)"));
  if (box.delivered.length) return Promise.resolve(box.delivered.shift());
  return control.wait(new Promise((resolve, reject) => {
    box.waiter = resolve;
    box.timer = setTimeout(() => { if (box.waiter) { box.waiter = null; reject(new InteractionError("timeout", "no webhook arrived in time")); } }, Math.max(1000, Math.min(timeoutMs || 10 * 60_000, 24 * 3600_000)));
    box.timer.unref?.();
  }));
}

function endWebhooks(runId: string): void {
  aiTokens.delete(runId);
  const set = runTokens.get(runId);
  if (!set) return;
  runTokens.delete(runId);
  for (const token of set) { const box = mailboxes.get(token); if (box?.timer) clearTimeout(box.timer); if (box?.waiter) box.waiter(null); mailboxes.delete(token); }
}

/* ------------------------------------------------------------ host calls */

/** 6.0: what a run may do in the administration (m5adm): the model's grant, or — a draft in the
 *  console — what its administrator could do there. */
function admContext(model: Model, caller: Caller, runId: string): AdmContext {
  const who = (caller.name || caller.kind).slice(0, 40);
  if (model.id === "__adhoc__") {
    return caller.kind === "console" && caller.adminRole
      ? { grant: consoleGrant(caller.adminRole), model: "console", caller: who, runId }
      : { grant: null, why: "code outside a model reaches the administration only in the console", model: "adhoc", caller: who, runId };
  }
  const g = model.grants?.admin;
  if (!g?.enabled) return { grant: null, why: "this model has no access to the administration (Functions › model › Administration — an owner grants it)", model: model.keyword || model.id, caller: who, runId };
  return { grant: { role: g.role, areas: g.areas.filter(isAdmArea) }, model: model.keyword || model.id, caller: who, runId };
}

/** The session, cache, interaction and webhook calls a run may make, scoped to it. */
function hostHandler(model: Model, sessionId: string, runId: string, caller: Caller, chain?: { id: string; sessionId: string }): RunHandlers["host"] {
  return async (fn, args, control) => {
    if (fn === "prompt" || fn === "form") return ask(runId, fn, args[0] ?? {}, control);
    // 6.11: a cancelled run's requests stop too; a long wait is announced to the caller (hostWait).
    if (fn === "http.request") return control.wait(hostWait(runId, "http", httpRequest(args[0] as never, taggedBytes, runAborts.get(runId)?.signal)));
    // 6.11: a lookup has a time limit (4 s by default; { timeoutMs } within 250 ms – 15 s).
    if (fn === "dns.resolve") return control.wait(hostWait(runId, "dns", dnsResolve(args[0], args[1], args[2])));
    if (fn === "crypto") return control.wait(hostWait(runId, "crypto", hostCrypto(String(args[0]), args.slice(1))));
    if (fn === "codes") return control.wait(hostWait(runId, "codes", hostCode((args[0] ?? {}) as never)));
    if (fn === "ai") {
      if ((aiTokens.get(runId) ?? 0) >= AI_RUN_TOKEN_CAP) throw new RunRefused("ai-budget", "this run has reached its AI token budget");
      return control.wait(hostWait(runId, "ai", hostAi(String(args[0]), args.slice(1), caller, (t) => aiTokens.set(runId, (aiTokens.get(runId) ?? 0) + t), runAborts.get(runId)?.signal)));
    }
    // 5.2: the commands the caller may run (for /help and menus).
    if (fn === "functions.list") return commandsFor(caller);
    // 6.0: the administration, as the owner granted it (host-adm.ts → /api/admin/*).
    if (fn === "adm") return control.wait(hostWait(runId, "adm", hostAdm(String(args[0] ?? ""), String(args[1] ?? ""), Array.isArray(args[2]) ? args[2] : [], admContext(model, caller, runId))));
    if (fn === "adm.info") return admInfo(admContext(model, caller, runId));
    // 6.0: m5.telephony — calls, SMS, chat messages, lookups, the audio bridge.
    if (fn === "telephony") return control.wait(hostWait(runId, "telephony", hostTelephony(String(args[0] ?? ""), Array.isArray(args[1]) ? args[1] : [], { model, caller, runId, chainId: chain?.id ?? "" })));
    // 6.3: m5.nfc — the op runs on the caller's DEVICE. Gate (a person's own NFC
    // access, or the model's grant for a run nobody started), strip any raw key /
    // PIN, then ask the device as an "nfc" interaction and wait for the NfcResult.
    // Works for a streaming caller and for a webhook caller that polls the run's
    // open interactions (openInteractions) and answers them.
    if (fn === "nfc") {
      const nctx = { model, caller, runId };
      nfcAllowed(nctx);
      nfcSpend(nctx);
      const command = sanitizeNfcCommand(args[0]);
      const ttlMs = (command.timeout ? command.timeout * 1000 : 20_000) + 20_000;
      return ask(runId, "nfc", { command }, control, ttlMs).then((result) => { cardRuns.add(runId); return sanitizeNfcResult(result); });
    }
    if (fn === "webhook.create") return makeWebhook(runId, (args[0] ?? {}) as { once?: boolean; durable?: boolean; ttl?: unknown }, model, sessionId, caller);
    if (fn === "webhook.wait") { const token = String(args[0] ?? ""); return hostWait(runId, "webhook", waitWebhook(token, Number(args[1]) || 0, control)); }
    const scopeName = (raw: unknown): string => {
      const s = String(raw ?? "model");
      // 5.3: "chain" — m5.model.cache, the processing session's own cache.
      if (s === "chain") { if (!chain) throw new RunRefused("no-chain", "m5.model.cache needs a processing session"); return `chain:${chain.id}`; }
      const scope = s === "run" || s === "session" || s === "model" || s === "global" ? s : "model";
      return scope === "global" ? "global" : scope === "model" ? `model:${model.id}` : scope === "session" ? `session:${sessionId}` : `session:${sessionId}`;
    };
    if (fn.startsWith("model.session.")) {
      if (!chain) throw new RunRefused("no-chain", "m5.model.session needs a processing session");
      const sid = chain.sessionId;
      switch (fn) {
        case "model.session.get": return functionsStore.sessionGet(sid, String(args[0]));
        case "model.session.set": functionsStore.sessionSet(sid, String(args[0]), args[1], ttlToMs(args[2])); return true;
        case "model.session.delete": functionsStore.sessionDelete(sid, String(args[0])); return true;
        case "model.session.keys": return functionsStore.sessionKeys(sid);
      }
    }
    const ttl = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return v > 0 ? v : null;
      const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(v).trim());
      if (!m) return null;
      const n = Number(m[1]); const unit = m[2] || "ms";
      return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1);
    };
    switch (fn) {
      case "session.get": return functionsStore.sessionGet(sessionId, String(args[0]));
      case "session.set": functionsStore.sessionSet(sessionId, String(args[0]), args[1], ttl(args[2])); return true;
      case "session.delete": functionsStore.sessionDelete(sessionId, String(args[0])); return true;
      case "session.keys": return functionsStore.sessionKeys(sessionId);
      case "cache.get": return functionsStore.cacheGet(scopeName(args[0]), String(args[1]));
      case "cache.set": functionsStore.cacheSet(scopeName(args[0]), String(args[1]), args[2], ttl(args[3])); return true;
      case "cache.incr": return functionsStore.cacheIncr(scopeName(args[0]), String(args[1]), Number(args[2]) || 1, ttl(args[3]));
      case "cache.delete": functionsStore.cacheDelete(scopeName(args[0]), String(args[1])); return true;
      case "cache.lock": case "cache.unlock": return null; // etapa 4
      default: throw new RunRefused("unknown-call", `m5: no such host call "${String(fn).slice(0, 60)}"`);
    }
  };
}

/* ------------------------------------------------------------- execute */

export type ExecuteOptions = {
  executor: string;
  test?: boolean;
  parent?: string | null;
  /** Reuse a session (repeat runs of the same model, caller and room share one). */
  sessionScope?: string;
  /** A caller-chosen id (a streaming caller subscribes to it before starting). */
  runId?: string;
  /** Pass the inputs through unchecked (a webhook sends arbitrary JSON). */
  skipValidation?: boolean;
  /** Run a different entry than the model's (e.g. its on_event). */
  entry?: string;
  /** Use this exact session (durable continuation) instead of deriving one. */
  sessionId?: string;
  /** 5.3: the entry point to run (default: the model's execute). */
  endpoint?: Endpoint;
  /** 5.3: continue this processing session (a reply, a click, a form, an error); else a new one opens. */
  chainId?: string;
  /** 5.3: the call's type in m5.model.calls when it is not the entry point's own (a durable webhook). */
  callType?: EndpointType;
  /** 5.3: a webhook call's URL (token masked), method, query and body — m5.model.calls[i].http. */
  http?: ChainCall["http"];
  /** 5.3: do not run the error entry point on failure (the error entry point itself). */
  noErrorEndpoint?: boolean;
};

/** The result the caller (chat, console) sees. */
export type ExecuteResult = {
  run: Run;
  outputs: Output[];
  /** The first returned output (older callers). */
  value: Output | null;
  /** 5.3: what the entry function returned, as outputs; and as plain data. */
  values: Output[];
  result: unknown;
  /** 5.3: the processing session and the call's index in it. */
  chain: string;
  call: number;
  /** 5.3: the call failed (or returned a bad item) and the error entry point answered: its run and outputs. */
  handled?: { run: Run; outputs: Output[] };
};

const scopeKey = (model: Model, caller: Caller): string => `${model.id}\0${caller.account || caller.client || "anon"}\0${caller.room ?? ""}`;

/**
 * Validates the inputs, records a run, carries it out in a sandbox process,
 * streams logs and outputs to the store (and to runEvents for the console),
 * and finalizes the run. Never throws for a function's own failure — that is
 * a finished run with an error; it throws only when the run cannot start
 * (RunRefused: an unknown model, an unpublished package, bad inputs).
 */
export async function execute(model: Model, rawInputs: Record<string, unknown>, caller: Caller, opts: ExecuteOptions): Promise<ExecuteResult> {
  await functionsStore.ready();
  const ep = opts.endpoint ?? endpointOf(model, "execute") ?? { id: "execute", type: "execute" as const, fn: "", inputs: model.inputs, enabled: true };
  const inputs = opts.skipValidation ? rawInputs : validateInputs(ep.type === "execute" ? model.inputs : ep.inputs, rawInputs); // throws RunRefused on a bad input
  const runId = opts.runId ?? newId("run");
  const sessionId = opts.sessionId ?? functionsStore.session(model.id, opts.sessionScope ?? scopeKey(model, caller));
  const entry = opts.entry || (ep.fn ? entryOf(model, ep) : model.entry);

  // The processing session: the one this call continues, or a new one.
  let chain: Chain;
  if (opts.chainId) {
    const found = functionsStore.chain(opts.chainId);
    if (!found || found.modelId !== model.id) throw new RunRefused("no-chain", "That conversation with the model is over (or belongs to another model).");
    chain = found;
  } else {
    chain = newChain(model.id);
    // 6.7: who may continue it from the app (chain-access.ts).
    chain.opener = openerOf(model, caller, opts.executor);
  }
  const callType = opts.callType ?? ep.type;
  const callId = openCall(chain, { type: callType, parms: storedInputs(inputs), http: opts.http ?? null, run: runId, at: Date.now(), by: caller.name });
  const context = modelContext(model, chain, callId, callType, ep.id, endpointTypes(model));
  let spec: RunSpec;
  try { spec = buildSpec(model, inputs, caller, opts.executor, { test: Boolean(opts.test), runId, sessionId, parent: opts.parent ?? null, entry, model: context }); }
  catch (err) { closeCall(chain.id, callId, { status: "failed", err_msg: (err as Error).message, result: null }); throw err; }

  const run: Run = {
    id: runId, modelId: model.id, entry, lang: spec.lang as Lang, executor: opts.executor, caller, sessionId, parent: opts.parent ?? null,
    status: "running", inputs: storedInputs(inputs), outputs: [], error: null, test: Boolean(opts.test), queuedAt: Date.now(), startedAt: Date.now(), finishedAt: null, ms: 0, memMb: 0,
    chainId: chain.id, callId, endpoint: callType,
  };
  functionsStore.saveRun(run);
  runEvents.emit("run", { runId, type: "status", status: "running", modelId: model.id });

  const outputs: Output[] = [];
  let seq = 0;
  const buffer: RunLog[] = [];
  const flush = () => { if (buffer.length) { functionsStore.addLogs(buffer.splice(0)); } };
  const log = (level: RunLog["level"], msg: string, fields?: Record<string, unknown>) => {
    const entry: RunLog = { runId, seq: seq++, ts: Date.now(), level, msg, fields: fields ?? null };
    buffer.push(entry);
    runEvents.emit("run", { type: "log", ...entry });
    if (buffer.length >= 20) flush();
  };
  const flushTimer = setInterval(flush, 500);

  const rejectedLive: string[] = [];
  const handlers: RunHandlers = {
    host: hostHandler(model, sessionId, runId, caller, { id: chain.id, sessionId: chain.sessionId }),
    onLog: (level, msg, fields) => log(level as RunLog["level"], msg, fields),
    onOutput: (out) => { outputs.push(out); runActivity(runId); runEvents.emit("run", { runId, type: "output", output: out }); },
    onProgress: (p, text) => { runActivity(runId, p); runEvents.emit("run", { runId, type: "progress", p, text }); },
    onRejected: (reason) => { rejectedLive.push(reason); log("error", `a sent output was left out: ${reason}`); },
  };

  const result = await runSandboxed(spec, handlers);
  endInteractions(runId, "the run ended");
  endWebhooks(runId);
  endAdmRun(runId);
  clearInterval(flushTimer);

  const values = result.ok ? result.values : [];
  const rejected: Rejected[] = result.ok ? result.rejected : [];
  for (const r of rejected) log("error", `result[${r.index}] was left out: ${r.reason}`, { index: r.index });
  if (!result.ok && result.error.type === "Cancelled") log("warn", `cancelled: ${result.error.message}`);
  flush();
  const finalOutputs = [...outputs, ...values];
  run.status = statusOf(result);
  run.outputs = finalOutputs;
  run.error = result.ok ? null : result.error;
  run.finishedAt = Date.now();
  run.ms = result.ms;
  run.memMb = result.memMb;
  if (cardRuns.delete(runId)) run.sensitive = true;
  functionsStore.saveRun(run);
  runEvents.emit("run", { runId, type: "status", status: run.status, error: run.error, ms: run.ms, memMb: run.memMb });
  const problems = [...rejectedLive, ...rejected.map((r) => `result[${r.index}]: ${r.reason}`)];
  closeCall(chain.id, callId, { status: run.status, err_msg: run.error ? run.error.message : problems.join("; "), result: result.ok ? result.result : null });

  const out: ExecuteResult = { run, outputs: finalOutputs, value: values[0] ?? null, values, result: result.ok ? result.result : null, chain: chain.id, call: callId };
  // The error entry point: the function failed, or returned something that is not an output.
  // (6.11: not for a cancelled run — its caller is gone.)
  if (!opts.noErrorEndpoint && callType !== "error" && run.status !== "cancelled" && (run.error || problems.length)) {
    const errEp = endpointOf(model, "error");
    if (errEp) {
      const error = run.error ?? { type: "BadResult", message: problems.join("; ").slice(0, 2000) };
      const handled = await runErrorEndpoint(model, errEp, chain.id, { error, failed: { call: callId, type: callType, parms: run.inputs }, source: "server" }, caller, { executor: opts.executor, test: Boolean(opts.test), parent: runId });
      if (handled) out.handled = handled;
    }
  }
  return out;
}

/** Runs the model's error entry point in a processing session; null when it could not start. */
export async function runErrorEndpoint(model: Model, errEp: Endpoint, chainId: string, payload: { error: unknown; failed: unknown; source: "server" | "client" }, caller: Caller, opts: { executor: string; test?: boolean; parent?: string | null }): Promise<{ run: Run; outputs: Output[] } | null> {
  try {
    const inputs = eventInputs(errEp, {}, payload);
    const r = await execute(model, inputs, caller, { executor: opts.executor, test: opts.test, parent: opts.parent ?? null, endpoint: errEp, chainId, skipValidation: true, noErrorEndpoint: true });
    return { run: r.run, outputs: r.outputs };
  } catch (err) {
    console.warn(`[functions] error entry point of ${model.id}: ${(err as Error).message}`);
    return null;
  }
}

/** The entry point of a type, when a model has it switched on. */
export { endpointOf, endpointsOf, ENDPOINT_TYPES };

/* ------------------------------------------------------- ad-hoc test run */

export type AdhocSpec = {
  lang: Lang;
  files: Record<string, string>;
  deps?: RunSpec["deps"];
  entry: { file: string; fn: string };
  inputs: Record<string, unknown>;
  limits?: Partial<RunLimits>;
  /** A run id chosen up front (the console's live runs subscribe before it starts). */
  runId?: string;
  /** 5.3: the package draft the code is from — a button or a form in the result then runs its function of that name. */
  source?: { packageId: string; file: string };
  /** 5.3: continue a processing session (a click on a draft run's button). */
  chainId?: string;
  /** 5.3: the entry point type this call is (default: the function's name when it is one, else execute). */
  type?: EndpointType;
};

const DRAFT_MODEL = "__draft__";

/**
 * Runs code straight from the editor (the current draft), before it is a
 * published model — the console's "Run" button. It is always a test run,
 * scoped to its own throwaway session, and streams to runEvents like any run.
 * (5.3) It has a processing session too, so a draft's buttons and forms call
 * its `button` / `form` functions, and a failure its `error` function.
 */
export async function runAdhoc(spec: AdhocSpec, caller: Caller, handlers?: Partial<RunHandlers>): Promise<ExecuteResult> {
  await functionsStore.ready();
  const runId = spec.runId ?? newId("run");
  const sessionId = functionsStore.session("__adhoc__", `adhoc\0${runId}`);
  const limits = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(limits) as (keyof RunLimits)[]) { const v = spec.limits?.[k]; if (typeof v === "number" && v > 0) limits[k] = Math.min(v, MAX_LIMITS[k]); }
  const now = Date.now();
  const type: EndpointType = spec.type ?? ((ENDPOINT_TYPES as readonly string[]).includes(spec.entry.fn) ? spec.entry.fn as EndpointType : "execute");
  let chain: Chain;
  const found = spec.chainId ? functionsStore.chain(spec.chainId) : null;
  if (found && found.modelId === DRAFT_MODEL) chain = found;
  else {
    // Inline code (the tutorial, the builder) keeps its files with the session (up to 256 kB), so its buttons and forms work too.
    const inline = !spec.source && JSON.stringify(spec.files).length <= 256_000 ? { lang: spec.lang, files: spec.files } : undefined;
    chain = newChain(DRAFT_MODEL, spec.source ? { kind: "draft", packageId: spec.source.packageId, file: spec.source.file } : { kind: "draft", packageId: "", file: spec.entry.file, ...(inline ? { inline } : {}) });
  }
  const callId = openCall(chain, { type, parms: spec.inputs, http: null, run: runId, at: now, by: caller.name });
  const draftTypes = (ENDPOINT_TYPES as readonly EndpointType[]).filter((t) => exportsFunction(spec.lang, spec.files[chain.source.kind === "draft" && chain.source.file ? chain.source.file : spec.entry.file] ?? "", t));
  const full: RunSpec = {
    id: runId, lang: spec.lang, files: spec.files, deps: spec.deps ?? {}, entry: spec.entry, inputs: spec.inputs,
    context: {
      run: { id: runId, model: null, executor: "console", parent: null, startedAt: now, deadline: now + limits.wallMs, test: true, entry: `${spec.entry.file}#${spec.entry.fn}` },
      caller: { kind: caller.kind, name: caller.name, groups: caller.groups, room: caller.room, client: caller.client, lang: caller.lang, tz: caller.tz },
      sys: { version: buildInfo().version, instance: process.env.INSTANCE_ID?.trim() || "m5cet" },
      session: { id: sessionId },
      model: modelContext({ id: "", name: "draft", keyword: "" }, chain, callId, type, type, draftTypes.length ? draftTypes : ["execute"]),
      define: defineStore.values("both"), // 6.3 define: per-run snapshot of m5mobile.define
    },
    limits,
  };
  const run: Run = { id: runId, modelId: "", entry: full.context.run.entry, lang: spec.lang, executor: "console", caller, sessionId, parent: null, status: "running", inputs: spec.inputs, outputs: [], error: null, test: true, queuedAt: now, startedAt: now, finishedAt: null, ms: 0, memMb: 0, chainId: chain.id, callId, endpoint: type };
  functionsStore.saveRun(run);
  runEvents.emit("run", { runId, type: "status", status: "running", modelId: "" });

  const outputs: Output[] = [];
  let seq = 0;
  const logLine = (level: string, msg: string, fields?: Record<string, unknown>) => { const e = { runId, seq: seq++, ts: Date.now(), level: level as RunLog["level"], msg, fields: fields ?? null }; functionsStore.addLogs([e]); runEvents.emit("run", { type: "log", ...e }); handlers?.onLog?.(level, msg, fields); };
  const rejectedLive: string[] = [];
  const runHandlers: RunHandlers = {
    host: hostHandler({ id: "__adhoc__", onEvent: "" } as Model, sessionId, runId, caller, { id: chain.id, sessionId: chain.sessionId }),
    onLog: logLine,
    onOutput: (out) => { outputs.push(out); runActivity(runId); runEvents.emit("run", { runId, type: "output", output: out }); handlers?.onOutput?.(out); },
    onProgress: (p, text) => { runActivity(runId, p); runEvents.emit("run", { runId, type: "progress", p, text }); handlers?.onProgress?.(p, text); },
    onRejected: (reason) => { rejectedLive.push(reason); logLine("error", `a sent output was left out: ${reason}`); },
  };
  const result = await runSandboxed(full, runHandlers);
  endInteractions(runId, "the run ended");
  endWebhooks(runId);
  endAdmRun(runId);
  const values = result.ok ? result.values : [];
  const rejected = result.ok ? result.rejected : [];
  for (const r of rejected) logLine("error", `result[${r.index}] was left out: ${r.reason}`, { index: r.index });
  const finalOutputs = [...outputs, ...values];
  run.status = statusOf(result);
  run.outputs = finalOutputs; run.error = result.ok ? null : result.error; run.finishedAt = Date.now(); run.ms = result.ms; run.memMb = result.memMb;
  if (cardRuns.delete(runId)) run.sensitive = true;
  functionsStore.saveRun(run);
  runEvents.emit("run", { runId, type: "status", status: run.status, error: run.error, ms: run.ms, memMb: run.memMb });
  const problems = [...rejectedLive, ...rejected.map((r) => `result[${r.index}]: ${r.reason}`)];
  closeCall(chain.id, callId, { status: run.status, err_msg: run.error ? run.error.message : problems.join("; "), result: result.ok ? result.result : null });
  const out: ExecuteResult = { run, outputs: finalOutputs, value: values[0] ?? null, values, result: result.ok ? result.result : null, chain: chain.id, call: callId };
  // The draft's own error function, when it has one.
  if (type !== "error" && run.status !== "cancelled" && (run.error || problems.length) && draftTypes.includes("error")) {
    const error = run.error ?? { type: "BadResult", message: problems.join("; ").slice(0, 2000) };
    const handled = await runAdhoc({ ...spec, runId: undefined, entry: { file: spec.entry.file, fn: "error" }, inputs: { error, failed: { call: callId, type, parms: spec.inputs }, source: "server" }, chainId: chain.id, type: "error" }, caller).catch(() => null);
    if (handled) out.handled = { run: handled.run, outputs: handled.outputs };
  }
  return out;
}

/** Whether a module's source exports a function of that name (a quick look, not a parse). */
export function exportsFunction(lang: Lang, source: string, name: string): boolean {
  if (!source || !/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  return lang === "py"
    ? new RegExp(`^(async\\s+)?def\\s+${name}\\s*\\(`, "m").test(source)
    : new RegExp(`export\\s+(async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(|export\\s+(const|let|var)\\s+${name}\\s*=|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source);
}

/** The functions a module's source exports (the console's entry point picker). */
export function exportedFunctions(lang: Lang, source: string): string[] {
  const out = new Set<string>();
  if (!source) return [];
  if (lang === "py") { for (const m of source.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm)) if (!m[1].startsWith("_")) out.add(m[1]); }
  else {
    for (const m of source.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
    for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
    for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(",")) { const name = part.trim().split(/\s+as\s+/).pop()?.trim(); if (name && /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") out.add(name); }
  }
  return [...out];
}

export { formatEntry };

/* ------------------------------------------ telephony handlers (6.0) */

/**
 * A call or a message placed by a model reports back (telephony/engine.ts):
 * its handler — a function in the model's file ("on_hangup"), or "file#fn" —
 * runs in the model's processing session, as the run that placed it.
 */
setHandlerRunner(async (owner: TelOwner, fn: string, inputs: Record<string, unknown>) => {
  await functionsStore.ready();
  const model = functionsStore.model(owner.modelId);
  if (!model || !model.enabled) return null;
  const base = owner.entry; // package@version:file
  const entry = fn.includes("#") ? `${base.slice(0, base.indexOf(":") + 1)}${fn}` : `${base}#${fn}`;
  const chainId = owner.chainId && functionsStore.chain(owner.chainId) ? owner.chainId : undefined;
  const r = await execute(model, inputs, owner.caller, { executor: "telephony", entry, skipValidation: true, callType: "webhook", ...(chainId ? { chainId } : {}) });
  return r.result ?? null;
});
