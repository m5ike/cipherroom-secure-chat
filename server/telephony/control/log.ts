// The Telephony & SIP event log (6.9, Telephony › Log): every webhook of
// every provider and path, calls placed, messages sent, routing decisions,
// TSA steps, tests and configuration changes — one TelLogEntry each, in
// telephony.db (table tel_log, next to the calls; SQLite is the channel
// between the main service, where webhooks land, and the admin service,
// where the console reads). Retention: telPermissions().log.days.
//
// A webhook line carries: was the provider's signature verified, the HTTP
// method / path / status / time, the NORMALIZED event(s) and — when
// permissions.log.keepRaw — the provider's payload as received, with every
// secret removed first (auth headers, signatures, tokens, passwords, API
// keys and secrets, JWTs, a call's webhook capability in its URL). 6.12
// (G-07): what the caller typed (DTMF, route codes) and said (speech results)
// is masked too (maskCallerInput); keepRaw is off by default and the log is
// kept 14 days (DEFAULT_PERMISSIONS in types.ts).
//
// Registers telHooks.log when loaded, and mirrors the older per-call log
// (tel-store record(): calls placed, SMS sent, the audio bridge) into it.

import type { Request, RequestHandler, Response } from "express";
import { adapter } from "../providers";
import type { NormalizedCallEvent } from "../providers/types";
import { telId, telStore, type TelLogEntry as RecordLine } from "../tel-store";
import { telHooks, telPermissions } from "./hooks";
import type { TelLogEntry, TelLogKind, TelLogQuery } from "./types";
import { whContext } from "./wh-context";

/* ------------------------------------------------------------- redaction */

/** Keys whose values are secrets wherever they appear (headers, bodies, queries). */
const SECRET_KEY = /authorization|signature|^sig$|token|secret|passw|^pwd$|api[_-]?key|apikey|jwt|credential|cookie|private[_-]?key|^auth$|^x-api-key$/i;
const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const QUERY_SECRET = /([?&;](?:api_secret|api_key|apikey|password|passwd|pass|token|secret|sig|signature|access_token|auth)=)[^&#\s"']*/gi;
const SIP_USERINFO = /(sips?:[^:@\s/"']+):[^@\s"']+@/gi;
const AUTH_SCHEME = /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/g;
/** A call's / message's webhook capability: /wh/tel/<token>/… (not /wh/tel/in/…). */
const CAPABILITY = /\/wh\/tel\/(?!in\/)([A-Za-z0-9_-]{16,64})/g;

export const REDACTED = "[redacted]";

/** A string with the secrets it may carry cut out. */
export function redactString(s: string): string {
  return String(s)
    .replace(JWT, "[jwt]")
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(QUERY_SECRET, `$1${REDACTED}`)
    .replace(SIP_USERINFO, `$1:${REDACTED}@`)
    .replace(CAPABILITY, (_m, tok: string) => `/wh/tel/${tok.slice(0, 6)}…`);
}

/** A deep copy without secrets: secret keys emptied, strings cleaned, depth and size bounded. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactString(value.length > 4000 ? `${value.slice(0, 4000)}…` : value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (depth > 8) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (++n > 300) { out["…"] = "more keys omitted"; break; }
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== "" ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/* ------------------------------------------------- what the caller typed / said */

// 6.12 (G-07): DTMF (a PIN, a card number, a route code — the key to a room's
// audio) and recognised speech are what the caller entered, not diagnostics.
// The log keeps their shape — how many keys, how long the utterance — not the
// content, in the parsed events and in the raw payload alike.
const DTMF_KEY = /^(digits?|dtmf|dtmf_?digits?)$/i;
const SPEECH_KEY = /^(speech|speech_?result|unstable_?speech_?result|stable_?speech_?result|transcript|transcription|transcription_?text|heard)$/i;
/** A route code under a generic name: only 4–6 digits are masked ("code": "busy" stays). */
const CODE_KEY = /^(code|route_?code|inroute_?code)$/i;

const maskDigits = (s: string): string => (s.length > 1 ? "•".repeat(s.length - 1) + s.slice(-1) : "•");
const maskSpeech = (s: string): string => (s ? `[speech: ${s.length} chars]` : s);

/** A copy with DTMF digits, route codes and recognised speech masked (see above). */
export function maskCallerInput(value: unknown, mode: "none" | "dtmf" | "speech" = "none", depth = 0): unknown {
  if (value === null || value === undefined || depth > 10) return value ?? null;
  if (typeof value === "string") return mode === "dtmf" ? maskDigits(value) : mode === "speech" ? maskSpeech(value) : value;
  if (typeof value === "number" && mode === "dtmf") return maskDigits(String(value));
  if (Array.isArray(value)) return value.map((v) => maskCallerInput(v, mode, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = mode !== "none" ? mode : DTMF_KEY.test(k) ? "dtmf" : SPEECH_KEY.test(k) ? "speech" : "none";
      if (next === "none" && CODE_KEY.test(k) && typeof v === "string" && /^\d{4,6}$/.test(v)) { out[k] = maskDigits(v); continue; }
      // Inside a masked value strings (and DTMF numbers) are hidden; confidence, timed_out and the like stay.
      out[k] = maskCallerInput(v, next, depth + 1);
    }
    return out;
  }
  return value;
}

const MAX_JSON = 64_000;
/** Bounded for storage: a huge payload keeps a preview. */
function capped(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (s === undefined || s.length <= MAX_JSON) return v;
    return { truncated: true, size: s.length, preview: s.slice(0, 4000) };
  } catch {
    return { unserializable: true };
  }
}

/* ------------------------------------------------------------------ write */

let lastAt = 0;
let pending: Promise<void> = Promise.resolve();
let lastPrune = 0;

/** Writes one entry (asynchronously: the store may still be opening). Never throws. */
export function writeLog(e: Partial<TelLogEntry> & Pick<TelLogEntry, "kind" | "summary">): TelLogEntry {
  const keepRaw = telPermissions().log.keepRaw;
  // Strictly increasing within the process, so a page boundary never splits one millisecond
  // (an explicit time — an imported or a back-dated line — is kept as given).
  const at = e.at !== undefined ? e.at : Math.max(Date.now(), lastAt + 1);
  if (at > lastAt) lastAt = at;
  const entry: TelLogEntry = {
    id: e.id ?? telId("tlg"),
    at,
    kind: e.kind,
    level: e.level ?? "info",
    provider: String(e.provider ?? "").slice(0, 40),
    direction: e.direction ?? "",
    summary: redactString(String(e.summary)).slice(0, 300),
    callId: String(e.callId ?? "").slice(0, 120),
    tsaSession: String(e.tsaSession ?? "").slice(0, 120),
    rule: String(e.rule ?? "").slice(0, 120),
    verified: e.verified ?? null,
    http: e.http ? { method: e.http.method, path: redactString(e.http.path).slice(0, 300), status: e.http.status, ms: Math.max(0, Math.round(e.http.ms)) } : null,
    // 6.12 (G-07): keys and speech the caller entered are masked in both.
    parsed: capped(maskCallerInput(redact(e.parsed ?? null))),
    raw: keepRaw ? capped(maskCallerInput(redact(e.raw ?? null))) : null,
  };
  pending = pending
    .then(() => telStore.ready())
    .then(() => { telStore.events.put(entry); pruneSoon(); })
    .catch(() => { /* the log never breaks a call */ });
  return entry;
}

/** Resolves when every entry written so far is stored (tests; a test endpoint before it answers). */
export function logFlushed(): Promise<void> { return pending; }

/** Retention: entries older than permissions.log.days go (at most once a minute). */
export function pruneLog(now = Date.now()): number {
  lastPrune = now;
  const days = Math.max(1, Number(telPermissions().log.days) || 30);
  return telStore.events.pruneBefore(now - days * 86_400_000);
}
function pruneSoon(): void { if (Date.now() - lastPrune > 60_000) pruneLog(); }

/* ------------------------------------------------------------------ read */

const LEVELS = ["debug", "info", "notice", "warn", "error"];
export type LogRow = Omit<TelLogEntry, "parsed" | "raw">;
const row = ({ parsed: _p, raw: _r, ...rest }: TelLogEntry): LogRow => rest;

/**
 * Newest first. kind / provider exact; level = at least this severe; callId
 * the call it belongs to; q a substring of the summary, call, session or
 * rule; before = the `next` of the previous page.
 */
export async function queryLog(q: TelLogQuery): Promise<{ entries: LogRow[]; next: number | null }> {
  await logFlushed();
  await telStore.ready();
  pruneLog();
  const limit = Math.max(1, Math.min(500, Math.round(Number(q.limit) || 100)));
  const min = q.level ? LEVELS.indexOf(q.level) : -1;
  const text = (q.q ?? "").trim().toLowerCase().slice(0, 200);
  const before = q.before !== undefined && Number.isFinite(Number(q.before)) ? Number(q.before) : undefined;
  const filter = (e: TelLogEntry) =>
    (!q.kind || e.kind === q.kind)
    && (!q.provider || e.provider === q.provider)
    && (min < 0 || LEVELS.indexOf(e.level) >= min)
    && (!text || `${e.summary} ${e.callId} ${e.tsaSession} ${e.rule} ${e.provider}`.toLowerCase().includes(text));
  const needsFilter = Boolean(q.kind || q.provider || min > 0 || text);
  const list = telStore.events.list({ limit: limit + 1, ...(before !== undefined ? { before } : {}), ...(q.callId ? { device: String(q.callId) } : {}), ...(needsFilter ? { filter } : {}) });
  const page = list.slice(0, limit);
  return { entries: page.map(row), next: list.length > limit ? page[page.length - 1].at : null };
}

export async function getLogEntry(id: string): Promise<TelLogEntry | null> {
  await logFlushed();
  await telStore.ready();
  return telStore.events.get(id);
}

/** Clears the log; returns how many entries went. */
export async function clearLog(): Promise<number> {
  await logFlushed();
  await telStore.ready();
  return telStore.events.pruneBefore(Number.MAX_SAFE_INTEGER);
}

/** Entries today (the overview's counts). */
export async function logCounts(since: number): Promise<{ events: number; errors: number }> {
  await telStore.ready();
  const list = telStore.events.list({ limit: 5000, filter: (e) => e.at >= since });
  return { events: list.length, errors: list.filter((e) => e.level === "error" || e.level === "warn").length };
}

/* --------------------------------------------------------------- webhooks */

const SAFE_HEADERS = ["content-type", "content-length", "user-agent", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "telnyx-timestamp", "i-twilio-idempotency-token", "x-home-region"];

const providerOfPath = (path: string): string => {
  const m = /^\/wh\/(twilio|telnyx|vonage)\//.exec(path) ?? /^\/wh\/tel\/in\/(twilio|telnyx|vonage)/.exec(path);
  return m ? m[1] : "";
};

/** The normalized call events of a webhook (the adapter's parser), without the raw copy. */
function callEventsOf(provider: string, body: unknown, query: Record<string, string>): Array<Omit<NormalizedCallEvent, "raw">> {
  const a = provider ? adapter(provider) : undefined;
  if (!a?.parseCallEvent) return [];
  try {
    return a.parseCallEvent(body, query).map(({ raw: _raw, ...rest }) => rest);
  } catch {
    return [];
  }
}

const describe = (ev: Omit<NormalizedCallEvent, "raw">): string => {
  const what = ev.kind === "status" ? (ev.status ?? "status") : ev.kind === "dial" ? `dial ${ev.dialStatus ?? ""}` : ev.kind;
  return `${what}${ev.from ? ` from ${ev.from}` : ""}${ev.to ? ` to ${ev.to}` : ""}`.trim();
};

function stringQuery(q: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (q && typeof q === "object") for (const [k, v] of Object.entries(q as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

/** One line for a webhook that has been answered. */
export function logWebhook(req: Request, res: Response, ms: number): TelLogEntry {
  const ctx = whContext(req);
  const path = (req.originalUrl || req.url || "").split("?")[0];
  const query = stringQuery(req.query);
  const provider = ctx.provider || providerOfPath(path);
  const events = callEventsOf(provider, req.body, query);
  const status = res.statusCode;
  const verified = ctx.verified ?? null;
  const level: TelLogEntry["level"] = status >= 500 ? "error" : status >= 400 ? "warn" : verified === false ? "notice" : "info";
  const test = Boolean(ctx.test || query.m5test);
  const type = ctx.type || path.split("/").filter(Boolean).at(-1) || "";
  const what = ctx.summary || (events.length ? events.map(describe).join("; ") : (ctx.event as { summary?: string } | undefined)?.summary || type);
  const headers: Record<string, string> = {};
  for (const h of SAFE_HEADERS) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
  return writeLog({
    kind: "webhook",
    level,
    provider,
    direction: ctx.direction ?? (events.find((e) => e.direction)?.direction ?? ""),
    summary: `${test ? "[test] " : ""}${provider || "?"} ${type}: ${what} → ${status}${verified === true ? " (verified)" : verified === false ? " (NOT verified)" : ""}`,
    callId: ctx.callId || events[0]?.callId || "",
    tsaSession: ctx.tsaSession ?? "",
    rule: ctx.rule ?? "",
    verified,
    http: { method: req.method, path, status, ms },
    parsed: { events, ...(ctx.event ? { event: ctx.event } : {}), ...(ctx.notes ? ctx.notes : {}), ...(test ? { test: true } : {}), enforced: ctx.enforced ?? null },
    raw: { query, body: req.body ?? null, headers },
  });
}

const mounted = new WeakSet<object>();

/** Mount on the main app before the /wh routes: logs every webhook once its answer has gone. */
export function mountWebhookLog(app: { use: (path: string, fn: RequestHandler) => unknown }): void {
  if (mounted.has(app)) return;
  mounted.add(app);
  app.use("/wh", (req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => { try { logWebhook(req, res, Date.now() - t0); } catch { /* never breaks a webhook */ } });
    next();
  });
}

/* ------------------------------------------------------------ registration */

const OLD_KIND: Record<string, TelLogKind> = { webhook: "webhook", sms: "sms", whatsapp: "sms", viber: "sms", messenger: "sms" };

/** The older per-call log line (tel-store record()) as an event log entry. */
export function mirrorRecord(e: RecordLine): void {
  writeLog({ kind: OLD_KIND[e.kind] ?? "call", level: e.level, provider: e.provider, summary: e.summary, callId: e.ref, parsed: { source: e.kind, ...e.detail } });
}

telHooks.log = (e) => { writeLog(e); };
telStore.setRecordMirror(mirrorRecord);
