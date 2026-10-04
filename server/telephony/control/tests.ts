// Telephony › Tests and Telephony › Log on the ADMIN service (6.9):
//
//   POST /admin/telephony/tests/provider     credentials, the API (account, balance), numbers, webhooks installed
//   POST /admin/telephony/tests/webhook      a correctly signed synthetic event to the main service's public URL
//   POST /admin/telephony/tests/route        RouteQuestion → the decision + what the provider would be told
//   POST /admin/telephony/tests/call         a real call (billable) through the outbound rules
//   POST /admin/telephony/tests/sms          a real SMS (billable)
//   POST /admin/telephony/tests/room-voice   an inroute code + the number to call (voice into a room)
//   GET|POST|DELETE /admin/telephony/tests/sip-address   the test inbound SIP address
//   GET /admin/telephony/log, GET …/log/:id, DELETE …/log   the event log
//
// Behind the admin service's authentication and consoleGuard("telephony")
// (admin.ts: a change under /test… needs "test" or "settings"; the log's
// full entry needs "log" or "settings", checked here). Every test answers a
// TelTestResult — a checklist — and says plainly what is missing (a
// variable, a part of the module) instead of failing obscurely. Each is
// written to the log (kind "test").

import { createHash, randomBytes } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { consoleCan, consolePrincipal } from "../../access";
import { publicBaseUrl } from "../connectors";
import { signJwtHS256 } from "../jwt";
import { pick, providerStatuses } from "../providers";
import type { CallAction, ProviderId } from "../providers/types";
import { sipTarget } from "../providers/sip-uri";
import { callView, messageView, placeCall, sendMessage, TelError } from "../engine";
import { didPool } from "../bridge";
import { twilioSignature, webhookVerificationStatus } from "../webhooks";
import { isE164, isProvider } from "../types";
import { telHooks, telPermissions } from "./hooks";
import type { NumberPattern, RouteDecision, RouteQuestion, TelCheck, TelLogKind, TelTestResult } from "./types";
import { clearLog, getLogEntry, logFlushed, queryLog, writeLog } from "./log";
import { previewActions, testSipAddress } from "./calls";
import { api, apiMessage, credsOf, type ApiAnswer } from "./provider-api";
import { trunkView, trunkWithSecret } from "./trunks";
import { createTestSipAddress, deleteTestSipAddress, readTestSip, sipAddressProviders } from "./sip-address";
import { numberInfo } from "../numbers";

const env = (name: string): string => process.env[name]?.trim() || "";
const VOICE: readonly ProviderId[] = ["twilio", "telnyx", "vonage"];

/* ---------------------------------------------------------------- results */

class Checklist {
  readonly checks: TelCheck[] = [];
  readonly log: string[] = [];
  add(id: string, label: string, ok: boolean | null, detail: string, ms?: number): boolean | null {
    this.checks.push({ id, label, ok, detail: detail.slice(0, 600), ...(ms !== undefined ? { ms } : {}) });
    this.log.push(`${ok === true ? "✓" : ok === false ? "✗" : "–"} ${label}: ${detail.slice(0, 300)}`);
    return ok;
  }
  get ok(): boolean { return this.checks.length > 0 && this.checks.every((c) => c.ok !== false); }
  result(): TelTestResult { return { ok: this.ok, checks: this.checks, log: this.log, at: Date.now() }; }
}

function who(req: Request, res: Response): string {
  return consolePrincipal(req, res)?.name ?? "console";
}

function record(kind: TelLogKind, provider: string, what: string, r: TelTestResult, by: string, extra: Record<string, unknown> = {}): void {
  writeLog({ kind, level: r.ok ? "info" : "warn", provider, summary: `${what}: ${r.ok ? "passed" : "FAILED"} (by ${by})`, parsed: { checks: r.checks, ...extra } });
}

const body = (req: Request) => (req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {});
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/* -------------------------------------------------------------- patterns */

/** "+4202*" a prefix, "*" anything, "-…" never (denies win); exact otherwise. */
export function matchesPattern(pattern: NumberPattern, value: string): boolean {
  const p = pattern.replace(/^-/, "").trim();
  if (!p) return false;
  if (p === "*") return true;
  if (p.endsWith("*")) return value.startsWith(p.slice(0, -1));
  return value === p;
}

/** The module's outbound limits that a test can check by itself: blocked numbers, allowed countries. */
export function outboundRefusal(to: string): string {
  const p = telPermissions().outbound;
  const blocked = p.blocked.find((b) => matchesPattern(b, to));
  if (blocked) return `${to} is blocked (${blocked}) by the module's permissions`;
  if (p.countries.length) {
    const iso = numberInfo(to)?.iso2 ?? "";
    if (!iso || !p.countries.map((c) => c.toUpperCase()).includes(iso)) return `${to}${iso ? ` (${iso})` : ""} is not in the allowed countries (${p.countries.join(", ")})`;
  }
  return "";
}

/* -------------------------------------------------------------- provider */

async function probe(c: Checklist, id: string, label: string, run: () => Promise<{ ok: boolean | null; detail: string }>): Promise<void> {
  const t0 = Date.now();
  try {
    const r = await run();
    c.add(id, label, r.ok, r.detail, Date.now() - t0);
  } catch (err) {
    c.add(id, label, false, (err as Error).message, Date.now() - t0);
  }
}

const fail = (a: ApiAnswer) => ({ ok: false, detail: apiMessage(a) });

/** POST …/tests/provider: credentials present, the API answers a harmless read, numbers owned, webhooks pointing here. */
export async function testProvider(provider: string): Promise<TelTestResult> {
  const c = new Checklist();
  if (!VOICE.includes(provider as ProviderId)) { c.add("provider", "Provider", false, "provider: twilio, telnyx or vonage"); return c.result(); }
  const base = publicBaseUrl();
  c.add("base", "PUBLIC_BASE_URL", base ? true : false, base || "not set — providers cannot reach the webhooks (set PUBLIC_BASE_URL, e.g. https://chat.example.org)");
  const status = providerStatuses().find((s) => s.id === provider)!;
  c.add("credentials", "Credentials", status.configured.length > 0, status.configured.length ? `configured for ${status.configured.join(", ")}${status.reason ? ` — ${status.reason}` : ""}` : status.reason ?? "not configured");
  const sig = webhookVerificationStatus(provider as "twilio" | "telnyx" | "vonage");
  c.add("signature", "Webhook signature check", sig.configured ? true : false, sig.configured ? `${sig.verify} (enforced)` : `${sig.needs} is not set — webhooks are accepted unverified`);
  const creds = credsOf(provider)!;
  if (creds.missing.length) {
    for (const [id, label] of [["account", "API reachable"], ["numbers", "Numbers owned"], ["webhooks", "Webhooks installed"]]) c.add(id, label, null, `skipped: set ${creds.missing.join(", ")}`);
    return c.result();
  }
  let numbers: Array<{ number: string; voiceUrl?: string; app?: string }> = [];
  if (provider === "twilio") {
    await probe(c, "account", "API reachable (account)", async () => {
      const a = await api("GET", `${creds.base}.json`, creds.auth);
      if (!a.ok) return fail(a);
      const b = await api("GET", `${creds.base}/Balance.json`, creds.auth).catch(() => null);
      return { ok: a.json.status === "active", detail: `${String(a.json.friendly_name ?? "")} — ${String(a.json.status ?? "?")}${b?.ok ? `, balance ${String(b.json.balance)} ${String(b.json.currency ?? "")}` : ""}` };
    });
    await probe(c, "numbers", "Numbers owned", async () => {
      const a = await api("GET", `${creds.base}/IncomingPhoneNumbers.json?PageSize=50`, creds.auth);
      if (!a.ok) return fail(a);
      numbers = ((a.json.incoming_phone_numbers ?? []) as Array<{ phone_number?: string; voice_url?: string }>).map((n) => ({ number: String(n.phone_number ?? ""), voiceUrl: String(n.voice_url ?? "") }));
      return { ok: numbers.length > 0, detail: numbers.length ? numbers.slice(0, 10).map((n) => n.number).join(", ") + (numbers.length > 10 ? ` … (${numbers.length})` : "") : "no numbers on the account (calls can still come over a SIP Domain)" };
    });
    await probe(c, "webhooks", "Webhooks installed (Voice URL)", async () => {
      if (!base) return { ok: null, detail: "skipped: no PUBLIC_BASE_URL" };
      const here = numbers.filter((n) => n.voiceUrl && n.voiceUrl.startsWith(`${base}/wh/`));
      return { ok: numbers.length ? here.length > 0 : null, detail: numbers.length ? `${here.length} of ${numbers.length} numbers point here${here.length < numbers.length ? ` (others: ${numbers.filter((n) => !here.includes(n)).slice(0, 5).map((n) => `${n.number} → ${n.voiceUrl || "nothing"}`).join("; ")}) — Webhooks › Install` : ""}` : "no numbers to check" };
    });
  } else if (provider === "telnyx") {
    await probe(c, "account", "API reachable (balance)", async () => {
      const a = await api("GET", `${creds.base}/balance`, creds.auth);
      if (!a.ok) return fail(a);
      const d = (a.json.data ?? {}) as Record<string, unknown>;
      return { ok: true, detail: `balance ${String(d.balance ?? "?")} ${String(d.currency ?? "")}${d.available_credit !== undefined ? `, available ${String(d.available_credit)}` : ""}` };
    });
    await probe(c, "numbers", "Numbers owned", async () => {
      const a = await api("GET", `${creds.base}/phone_numbers?page%5Bsize%5D=50`, creds.auth);
      if (!a.ok) return fail(a);
      numbers = ((a.json.data ?? []) as Array<{ phone_number?: string; connection_id?: string }>).map((n) => ({ number: String(n.phone_number ?? ""), app: String(n.connection_id ?? "") }));
      const app = env("TELNYX_CONNECTION_ID");
      const linked = app ? numbers.filter((n) => n.app === app).length : 0;
      return { ok: numbers.length > 0, detail: numbers.length ? `${numbers.slice(0, 10).map((n) => n.number).join(", ")}${numbers.length > 10 ? " …" : ""}${app ? ` — ${linked} on the Call Control application` : ""}` : "no numbers on the account" };
    });
    await probe(c, "webhooks", "Webhooks installed (Call Control application)", async () => {
      const app = env("TELNYX_CONNECTION_ID");
      if (!app) return { ok: false, detail: "set TELNYX_CONNECTION_ID (the Call Control application)" };
      const a = await api("GET", `${creds.base}/call_control_applications/${encodeURIComponent(app)}`, creds.auth);
      if (!a.ok) return fail(a);
      const d = (a.json.data ?? {}) as { webhook_event_url?: string; inbound?: { sip_subdomain?: string } };
      const want = base ? `${base}/wh/telnyx/events` : "";
      return { ok: want ? d.webhook_event_url === want : null, detail: `webhook_event_url ${d.webhook_event_url || "(none)"}${want && d.webhook_event_url !== want ? ` — should be ${want} (Webhooks › Install)` : ""}${d.inbound?.sip_subdomain ? `; SIP subdomain ${d.inbound.sip_subdomain}.sip.telnyx.com` : ""}` };
    });
  } else {
    await probe(c, "account", "API reachable (balance)", async () => {
      const a = await api("GET", `${creds.base}/account/get-balance`, creds.auth);
      if (!a.ok) return fail(a);
      return { ok: true, detail: `balance ${String(a.json.value ?? "?")} EUR${a.json.autoReload ? " (auto reload)" : ""}` };
    });
    await probe(c, "numbers", "Numbers owned", async () => {
      const a = await api("GET", `${creds.base}/account/numbers?size=50`, creds.auth);
      if (!a.ok) return fail(a);
      numbers = ((a.json.numbers ?? []) as Array<{ msisdn?: string; app_id?: string }>).map((n) => ({ number: `+${String(n.msisdn ?? "")}`, app: String(n.app_id ?? "") }));
      const app = env("VONAGE_APPLICATION_ID");
      const linked = app ? numbers.filter((n) => n.app === app).length : 0;
      return { ok: numbers.length > 0, detail: numbers.length ? `${numbers.slice(0, 10).map((n) => n.number).join(", ")}${app ? ` — ${linked} linked to the application` : ""}` : "no numbers on the account" };
    });
    await probe(c, "webhooks", "Webhooks installed (Voice application)", async () => {
      const app = env("VONAGE_APPLICATION_ID");
      if (!app) return { ok: false, detail: "set VONAGE_APPLICATION_ID" };
      const a = await api("GET", `https://api.nexmo.com/v2/applications/${encodeURIComponent(app)}`, creds.auth);
      if (!a.ok) return fail(a);
      const voice = ((a.json.capabilities ?? {}) as { voice?: { webhooks?: { answer_url?: { address?: string }; event_url?: { address?: string } }; signed_callbacks?: boolean } }).voice;
      const answer = voice?.webhooks?.answer_url?.address ?? "";
      const event = voice?.webhooks?.event_url?.address ?? "";
      const ok = base ? answer === `${base}/wh/vonage/answer` && event === `${base}/wh/vonage/events` : null;
      return { ok, detail: `answer ${answer || "(none)"}, event ${event || "(none)"}${voice?.signed_callbacks === false ? ", signed callbacks OFF" : ""}${ok === false ? " — Webhooks › Install" : ""}` };
    });
  }
  return c.result();
}

/* --------------------------------------------------------------- webhook */

/** POST …/tests/webhook: a synthetic event, signed as the provider signs, to the main service's public URL. */
export async function testWebhook(provider: string): Promise<TelTestResult & { delivered?: { url: string; status: number; ms: number } }> {
  const c = new Checklist();
  if (!VOICE.includes(provider as ProviderId)) { c.add("provider", "Provider", false, "provider: twilio, telnyx or vonage"); return c.result(); }
  const base = publicBaseUrl();
  if (!c.add("base", "PUBLIC_BASE_URL", base ? true : false, base || "not set — there is no public URL to deliver to")) return c.result();
  const id = `m5test${randomBytes(6).toString("hex")}`;
  const sig = webhookVerificationStatus(provider as "twilio" | "telnyx" | "vonage");
  let path = ""; let headers: Record<string, string> = {}; let payload = ""; let expect = 200;
  if (provider === "twilio") {
    path = `/wh/twilio/voice_status?m5test=${id}`;
    const params: Record<string, string> = { CallSid: `CA${id}`, AccountSid: env("TWILIO_ACCOUNT_SID") || "AC-test", CallStatus: "completed", From: "+000100", To: "+000100", Direction: "outbound-api", CallbackSource: "call-progress-events", SequenceNumber: "0", CallDuration: "0" };
    payload = new URLSearchParams(params).toString();
    headers = { "content-type": "application/x-www-form-urlencoded" };
    const token = env("TWILIO_AUTH_TOKEN");
    if (token) headers["x-twilio-signature"] = twilioSignature(`${base}${path}`, params, token);
    c.add("signed", "Signed as Twilio signs", token ? true : null, token ? "X-Twilio-Signature over the public URL + parameters" : "TWILIO_AUTH_TOKEN not set — sent unsigned");
  } else if (provider === "telnyx") {
    path = `/wh/telnyx/events?m5test=${id}`;
    payload = JSON.stringify({ data: { record_type: "event", event_type: "call.hangup", id, occurred_at: new Date().toISOString(), payload: { call_control_id: id, hangup_cause: "normal_clearing", from: "+000100", to: "+000100" } } });
    headers = { "content-type": "application/json" };
    // Telnyx signs with its own private key (Ed25519); only Telnyx can make a valid signature.
    // With TELNYX_PUBLIC_KEY set, the main service must REFUSE this unsigned event.
    expect = sig.configured ? 403 : 200;
    c.add("signed", "Signed as Telnyx signs", null, sig.configured ? "cannot be: Telnyx signs with its private key — the test checks that an unsigned event is refused (403)" : "TELNYX_PUBLIC_KEY not set — the event is accepted unverified");
  } else {
    path = `/wh/vonage/events?m5test=${id}`;
    payload = JSON.stringify({ uuid: id, conversation_uuid: `CON-${id}`, status: "completed", direction: "outbound", from: "000100", to: "000100", timestamp: new Date().toISOString(), duration: "0" });
    headers = { "content-type": "application/json" };
    const secret = env("VONAGE_SIGNATURE_SECRET");
    if (secret) headers.authorization = `Bearer ${signJwtHS256({ payload_hash: createHash("sha256").update(payload).digest("hex"), api_key: env("VONAGE_API_KEY") || "test" }, secret, 300)}`;
    c.add("signed", "Signed as Vonage signs", secret ? true : null, secret ? "Bearer HS256 JWT with payload_hash (VONAGE_SIGNATURE_SECRET)" : "VONAGE_SIGNATURE_SECRET not set — sent unsigned");
  }
  const url = `${base}${path}`;
  const t0 = Date.now();
  let status = 0;
  try {
    const res = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(15_000) });
    status = res.status;
    await res.text().catch(() => "");
    c.add("reachable", "Public URL reaches the main service", true, `${url.replace(/\?.*$/, "")} answered HTTP ${status}`, Date.now() - t0);
  } catch (err) {
    c.add("reachable", "Public URL reaches the main service", false, `${url.replace(/\?.*$/, "")}: ${(err as Error).message.slice(0, 200)} — check PUBLIC_BASE_URL, DNS, TLS and the proxy's /wh/ location`, Date.now() - t0);
    return c.result();
  }
  const ms = Date.now() - t0;
  if (status === 404) c.add("answer", "Webhook route", false, "404 — the proxy does not pass /wh/ to the main service (nginx: location /wh/)");
  else c.add("answer", expect === 403 ? "Unsigned event refused" : "Accepted", status === expect, status === expect ? `HTTP ${status} as expected` : status === 403 ? "403 — the signature check failed (is PUBLIC_BASE_URL exactly the public address? does the proxy rewrite the path?)" : `HTTP ${status}, expected ${expect}`);
  // The main service logs it (telephony.db is shared): its view of the signature.
  if (status === 200 || status === 403) {
    let entry: Awaited<ReturnType<typeof queryLog>>["entries"][number] | undefined;
    for (let i = 0; i < 12 && !entry; i++) {
      entry = (await queryLog({ kind: "webhook", q: id, limit: 5 })).entries[0];
      if (!entry) await new Promise((r) => setTimeout(r, 250));
    }
    if (!entry) c.add("logged", "Logged by the main service", null, "not in the log yet (does the main service use the same telephony.db / DATA_DIR?)");
    else c.add("logged", "Logged by the main service", status === 403 ? true : entry.verified === true || !sig.configured, `verified: ${String(entry.verified)}${entry.verified === false && sig.configured && status === 200 ? " — the signature was not verified although it is enforced?" : ""}`);
  }
  return { ...c.result(), delivered: { url: url.replace(/\?.*$/, ""), status, ms } };
}

/* ----------------------------------------------------------------- route */

function defaultVoice(): ProviderId | "" {
  return (pick("call")?.id as ProviderId | undefined) ?? "";
}

/** POST …/tests/route: the decision, and what the provider would be told (the TSA's first turn, rendered). */
export async function testRoute(q: RouteQuestion): Promise<TelTestResult & { decision?: RouteDecision; provider?: string; rendered?: { contentType: string; body: string }; placement?: Record<string, unknown> }> {
  const c = new Checklist();
  if (q.direction !== "inbound" && q.direction !== "outbound") { c.add("question", "Question", false, "direction: inbound or outbound"); return c.result(); }
  if (!q.to) { c.add("question", "Question", false, "to: the number (or SIP URI) called"); return c.result(); }
  if (!telHooks.decide) { c.add("rules", "Routing rules", false, "the routing rules are not loaded in this service (the control store / rules part is missing)"); return c.result(); }
  let decision: RouteDecision;
  try { decision = await telHooks.decide(q); } catch (err) { c.add("rules", "Routing rules", false, (err as Error).message); return c.result(); }
  const t = decision.target;
  c.add("decision", "Decision", true, `${decision.rule ? `rule ${decision.ruleLabel || decision.rule}` : "no rule matched — the default"}: ${t.kind === "tsa" ? `TSA ${t.tsa}` : t.kind === "state" ? t.state : "pass"}${decision.service ? ` via ${decision.service.provider} ${decision.service.kind === "sip" ? `SIP trunk ${decision.service.trunk}` : "application"}` : ""}`);
  const provider = (decision.service?.provider || q.provider || defaultVoice() || "twilio") as ProviderId;
  let placement: Record<string, unknown> | undefined;
  if (q.direction === "outbound" && decision.service) {
    const s = decision.service;
    if (s.kind === "sip") {
      const trunk = trunkWithSecret(s.trunk);
      c.add("trunk", "SIP trunk", trunk ? true : false, trunk ? `${trunk.label} (${trunk.host})${trunk.password ? ", with credentials" : ", no password"}` : `trunk ${s.trunk} not found`);
      placement = { provider, service: "sip", to: trunk ? sipTarget(q.to, "number", trunk) : q.to, from: s.callerId.number || trunk?.callerIdNumber || "(the provider's default)", callerName: s.callerId.name || trunk?.callerIdName || "", presentation: s.callerId.presentation, trunk: trunk ? trunkView(trunk) : null };
    } else placement = { provider, service: "app", to: q.to, auth: "the provider's API key and secret (environment)" };
    const refusal = outboundRefusal(q.to);
    if (refusal) c.add("permissions", "Permissions", false, refusal);
  }
  let actions: CallAction[] | null = null;
  if (t.kind === "state") actions = [t.state === "hangup" ? { hangup: {} } : { reject: { reason: t.state } }];
  else if (t.kind === "tsa") {
    if (!telHooks.tsa) c.add("tsa", "TSA runtime", false, "the TSA runtime is not loaded in this service — nothing to render");
    else {
      try {
        const turn = await telHooks.tsa.start({ id: `sim:route-test-${randomBytes(4).toString("hex")}`, token: `routetest${randomBytes(8).toString("hex")}`, provider, direction: q.direction, from: q.from, to: q.to, did: q.to }, t.tsa);
        actions = turn.actions;
        c.add("tsa", "TSA first turn", true, `${turn.actions.map((a) => Object.keys(a)[0]).join(", ") || "nothing"}${turn.session.waiting ? ` — then waits for ${turn.session.waiting.for}` : ""}`);
      } catch (err) {
        c.add("tsa", "TSA first turn", false, (err as Error).message.slice(0, 300));
      }
    }
  } else c.add("pass", "Logic", null, "pass: the call runs the logic of whatever placed it");
  const rendered = actions ? previewActions(provider, actions) : undefined;
  return { ...c.result(), decision, provider, ...(rendered ? { rendered } : {}), ...(placement ? { placement } : {}) };
}

/* ---------------------------------------------------------------- call, sms */

/** POST …/tests/call: a real outbound call through the outbound rules. */
export async function testCall(b: Record<string, unknown>, by: string): Promise<TelTestResult & { call?: ReturnType<typeof callView>; decision?: RouteDecision }> {
  const c = new Checklist();
  const to = str(b.to, 32);
  if (!c.add("to", "Number", isE164(to), isE164(to) ? to : "to must be an E.164 number, e.g. +420603123456")) return c.result();
  const refusal = outboundRefusal(to);
  if (refusal) { c.add("permissions", "Permissions", false, refusal); return c.result(); }
  const asked = str(b.provider, 20);
  let decision: RouteDecision | undefined;
  if (telHooks.decide) {
    try {
      decision = await telHooks.decide({ direction: "outbound", from: str(b.from, 32), to, provider: isProvider(asked) ? asked : "", source: "console", groups: [] });
    } catch (err) { c.add("rules", "Outbound rules", false, (err as Error).message); return c.result(); }
    const t = decision.target;
    if (t.kind === "state") { c.add("rules", "Outbound rules", false, `refused (${t.state}) by ${decision.rule ? `rule ${decision.ruleLabel || decision.rule}` : "the default"}`); return { ...c.result(), decision }; }
    c.add("rules", "Outbound rules", true, `${decision.rule ? `rule ${decision.ruleLabel || decision.rule}` : "the default"}: ${t.kind === "tsa" ? `TSA ${t.tsa}` : "pass"}${decision.service ? ` via ${decision.service.provider} ${decision.service.kind}` : ""}`);
  } else c.add("rules", "Outbound rules", null, "not loaded — the provider asked for (or the default) places it");
  const service = decision?.service ?? null;
  const provider = service?.provider || (isProvider(asked) ? asked : "") || undefined;
  let via: Parameters<typeof placeCall>[0]["via"];
  let from = str(b.from, 32);
  if (service?.kind === "sip") {
    const trunk = trunkWithSecret(service.trunk);
    if (!c.add("trunk", "SIP trunk", trunk ? true : false, trunk ? `${trunk.label} (${trunk.host})` : `trunk ${service.trunk} not found (SIP trunks)`)) return { ...c.result(), decision };
    via = { kind: "sip", trunk: { id: trunk!.id, host: trunk!.host, ...(trunk!.username ? { username: trunk!.username } : {}), ...(trunk!.password ? { password: trunk!.password } : {}), ...(trunk!.transport ? { transport: trunk!.transport } : {}) }, ...(service.callerId.name || trunk!.callerIdName ? { callerName: service.callerId.name || trunk!.callerIdName } : {}), presentation: service.callerId.presentation };
    from = from || service.callerId.number || trunk!.callerIdNumber;
  }
  const tsa = str(b.tsa, 48) || (decision?.target.kind === "tsa" ? decision.target.tsa : "");
  if (tsa && !telHooks.tsa) { c.add("tsa", "TSA runtime", false, "the TSA runtime is not loaded — cannot run a TSA on the call"); return { ...c.result(), decision }; }
  const say = str(b.say, 500) || "This is a test call from M5cet.";
  try {
    const call = await placeCall({
      to, ...(from ? { from } : {}), ...(provider ? { provider } : {}), timeout: 30, mode: "async", owner: null,
      actions: tsa ? [] : [{ say: { text: say } }, { hangup: {} }],
      ...(via ? { via } : {}), ...(tsa ? { tsa: { id: tsa, rule: decision?.rule ?? `console:${by}` } } : {}),
    });
    c.add("placed", "Call placed", true, `${call.provider} ${call.providerCallId || "(no id yet)"} — ${tsa ? `runs TSA ${tsa} when answered` : `says "${say.slice(0, 80)}"`}; follow it in the log`);
    return { ...c.result(), call: callView(call), ...(decision ? { decision } : {}) };
  } catch (err) {
    const e = err as Error;
    c.add("placed", "Call placed", false, e instanceof TelError ? e.message : e.message.slice(0, 300));
    return { ...c.result(), ...(decision ? { decision } : {}) };
  }
}

/** POST …/tests/sms: a real SMS. */
export async function testSms(b: Record<string, unknown>): Promise<TelTestResult & { message?: ReturnType<typeof messageView> }> {
  const c = new Checklist();
  const to = str(b.to, 32);
  const text = typeof b.text === "string" ? b.text.slice(0, 1600) : "";
  if (!c.add("to", "Number", isE164(to), isE164(to) ? to : "to must be an E.164 number, e.g. +420603123456")) return c.result();
  if (!c.add("text", "Text", text.trim().length > 0, text.trim() ? `${text.length} characters` : "text is required")) return c.result();
  const refusal = outboundRefusal(to);
  if (refusal) { c.add("permissions", "Permissions", false, refusal); return c.result(); }
  const asked = str(b.provider, 20);
  try {
    const m = await sendMessage({ channel: "sms", to, text, ...(asked ? { provider: asked } : {}), ...(str(b.from, 32) ? { from: str(b.from, 32) } : {}), owner: null });
    c.add("sent", "SMS sent", true, `${m.provider} ${m.providerId} — ${m.status}${m.parts ? `, ${m.parts} part(s)` : ""}`);
    return { ...c.result(), message: messageView(m) };
  } catch (err) {
    c.add("sent", "SMS sent", false, (err as Error).message.slice(0, 300));
    return c.result();
  }
}

/* ------------------------------------------------------------ room voice */

/** POST …/tests/room-voice: an inroute code for a room (or a member) and the number that reaches a Route audio. */
export async function testRoomVoice(b: Record<string, unknown>, by: string): Promise<TelTestResult & { code?: string; expiresAt?: number; numbers?: Array<{ number: string; provider: string; via: string }>; instructions?: string }> {
  const c = new Checklist();
  const room = str(b.room, 120);
  const type = b.type === "user" ? "user" : "room";
  const user = str(b.user, 120);
  const ttl = Math.max(60, Math.min(telPermissions().inroute.maxTtlSec, Math.round(Number(b.ttl) || 600)));
  if (!c.add("room", "Room", room.length > 0, room || "room: the room's blind id (r3.…)")) return c.result();
  if (type === "user" && !c.add("user", "Member", user.length > 0, user || "user: the member's name in the room, or @username")) return c.result();
  if (!telHooks.inroute) { c.add("inroute", "Inroute table", false, "the inroute table is not loaded in this service"); return c.result(); }
  let entry;
  try {
    entry = await telHooks.inroute.add({ type, room, ...(user ? { user } : {}), ttl, label: "console test", maxUses: 0, createdBy: { kind: "console", id: by } });
    c.add("code", "Route code", true, `${entry.code} for ${type === "room" ? `room ${room}` : `${user} in ${room}`}, ${entry.ttlSec} s`);
  } catch (err) {
    c.add("code", "Route code", false, (err as Error).message.slice(0, 300));
    return c.result();
  }
  // Which numbers lead to a TSA (that should have a Route audio): the DID pool, the providers'
  // numbers, the test SIP address — as the inbound rules route them now.
  const candidates: Array<{ number: string; provider: string }> = [
    ...didPool().map((p) => ({ number: p.number, provider: p.provider })),
    ...(env("TWILIO_FROM") ? [{ number: env("TWILIO_FROM"), provider: "twilio" }] : []),
    ...(env("TELNYX_FROM") ? [{ number: env("TELNYX_FROM"), provider: "telnyx" }] : []),
    ...(env("VONAGE_FROM") && /^\+?\d{6,15}$/.test(env("VONAGE_FROM")) ? [{ number: `+${env("VONAGE_FROM").replace(/^\+/, "")}`, provider: "vonage" }] : []),
  ];
  const sip = testSipAddress();
  const numbers: Array<{ number: string; provider: string; via: string }> = [];
  const seen = new Set<string>();
  for (const cand of candidates) {
    if (seen.has(cand.number)) continue;
    seen.add(cand.number);
    if (!telHooks.decide) { numbers.push({ ...cand, via: "unchecked (no routing rules loaded)" }); continue; }
    const d = await telHooks.decide({ direction: "inbound", from: "", to: cand.number, provider: (cand.provider || "") as ProviderId | "", service: "app" }).catch(() => null);
    if (d?.target.kind === "tsa") numbers.push({ ...cand, via: `TSA ${d.target.tsa}${d.rule ? ` (rule ${d.ruleLabel || d.rule})` : ""}` });
  }
  if (sip?.enabled && telHooks.decide) {
    const d = await telHooks.decide({ direction: "inbound", from: "", to: sip.did, provider: sip.provider, service: "sip" }).catch(() => null);
    if (d?.target.kind === "tsa") numbers.push({ number: sip.uri, provider: sip.provider, via: `TSA ${d.target.tsa} (the test SIP address, as ${sip.did})` });
  }
  c.add("numbers", "Numbers to call", numbers.length > 0 ? true : null, numbers.length ? numbers.map((n) => `${n.number} → ${n.via}`).join("; ") : "no number routes to a TSA yet — add an inbound rule to a TSA with a Route audio (Read DTMF → Route audio)");
  const first = numbers[0]?.number ?? "(a number routed to a TSA with Route audio)";
  const instructions = `Call ${first}. When the flow asks for the code, type ${entry.code} and #. Your voice goes to ${type === "room" ? `everyone in the room ${room} who has audio on` : `${user} in the room ${room}`} until you hang up. The code expires in ${Math.round(entry.ttlSec / 60)} min.`;
  return { ...c.result(), code: entry.code, expiresAt: entry.expiresAt, numbers, instructions };
}

/* -------------------------------------------------------------- routes */

/** Logs every console change under /admin/telephony (not its tests and log, which log themselves). */
function configLog(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || /^\/(tests|log|sim)(\/|$)/.test(req.path)) return next();
  const t0 = Date.now();
  const path = `/admin/telephony${req.path}`.slice(0, 200);
  // The older one-click test (POST /admin/telephony/test) places a real call or SMS.
  const kind: TelLogKind = /^\/test(\/|$)/.test(req.path) ? "test" : "config";
  res.on("finish", () => {
    try {
      const b = body(req);
      writeLog({ kind, level: res.statusCode >= 400 ? "warn" : "notice", provider: typeof b.provider === "string" ? b.provider.slice(0, 20) : "", summary: `${req.method} ${path} → ${res.statusCode} (by ${who(req, res)})`, http: { method: req.method, path, status: res.statusCode, ms: Date.now() - t0 }, parsed: { fields: Object.keys(b).slice(0, 50) } });
    } catch { /* never breaks the console */ }
  });
  next();
}

const send = (res: Response, r: TelTestResult & Record<string, unknown>) => res.json({ ...r, ok: r.ok });

export function registerTelTestRoutes(app: Express): void {
  app.use("/admin/telephony", configLog);

  /* ------------------------------------------------------------- log */
  app.get("/admin/telephony/log", async (req: Request, res: Response) => {
    const q = req.query as Record<string, unknown>;
    const s = (k: string) => (typeof q[k] === "string" ? String(q[k]).slice(0, 200) : undefined);
    const r = await queryLog({ kind: (s("kind") ?? "") as TelLogKind | "", provider: s("provider"), level: s("level"), callId: s("callId"), q: s("q"), ...(s("before") ? { before: Number(s("before")) } : {}), ...(s("limit") ? { limit: Number(s("limit")) } : {}) });
    res.json({ ok: true, ...r });
  });
  app.get("/admin/telephony/log/:id", async (req: Request, res: Response) => {
    if (!consoleCan(req, res, "telephony", [["log", "settings"]])) return res.status(403).json({ ok: false, code: "module-denied", message: "Your access to Telephony & SIP does not include the log's full entries (log)." });
    const e = await getLogEntry(String(req.params.id).slice(0, 80));
    if (!e) return res.status(404).json({ ok: false, message: "no such entry (older than the retention?)" });
    res.json({ ok: true, entry: e });
  });
  app.delete("/admin/telephony/log", async (req: Request, res: Response) => {
    const n = await clearLog();
    writeLog({ kind: "config", level: "notice", summary: `the log was cleared (${n} entries) by ${who(req, res)}` });
    await logFlushed();
    res.json({ ok: true, removed: n });
  });

  /* ----------------------------------------------------------- tests */
  app.post("/admin/telephony/tests/provider", async (req: Request, res: Response) => {
    const provider = str(body(req).provider, 20);
    const r = await testProvider(provider);
    record("test", provider, `provider test (${provider || "?"})`, r, who(req, res));
    send(res, r);
  });
  app.post("/admin/telephony/tests/webhook", async (req: Request, res: Response) => {
    const provider = str(body(req).provider, 20);
    const r = await testWebhook(provider);
    record("test", provider, `webhook test (${provider || "?"})`, r, who(req, res), { delivered: r.delivered });
    send(res, r);
  });
  app.post("/admin/telephony/tests/route", async (req: Request, res: Response) => {
    const b = body(req);
    const q: RouteQuestion = {
      direction: b.direction === "outbound" ? "outbound" : b.direction === "inbound" ? "inbound" : (str(b.direction, 10) as RouteQuestion["direction"]),
      from: str(b.from, 120), to: str(b.to, 120),
      ...(isProvider(b.provider) ? { provider: b.provider } : {}),
      ...(b.service === "app" || b.service === "sip" ? { service: b.service } : {}),
      ...(Array.isArray(b.groups) ? { groups: b.groups.filter((g): g is string => typeof g === "string").slice(0, 50) } : {}),
      ...(["function", "tsa", "console", "api"].includes(String(b.source)) ? { source: b.source as RouteQuestion["source"] } : {}),
      ...(Number.isFinite(Number(b.at)) && b.at ? { at: Number(b.at) } : {}),
    };
    const r = await testRoute(q);
    record("test", r.provider ?? "", `route test (${q.direction} ${q.from || "?"} → ${q.to || "?"})`, r, who(req, res), { decision: r.decision });
    send(res, r);
  });
  app.post("/admin/telephony/tests/call", async (req: Request, res: Response) => {
    const by = who(req, res);
    const r = await testCall(body(req), by);
    record("test", r.call?.provider ?? "", `test call to ${str(body(req).to, 32) || "?"}`, r, by, { call: r.call, decision: r.decision });
    send(res, r);
  });
  app.post("/admin/telephony/tests/sms", async (req: Request, res: Response) => {
    const r = await testSms(body(req));
    record("test", r.message?.provider ?? "", `test SMS to ${str(body(req).to, 32) || "?"}`, r, who(req, res), { message: r.message });
    send(res, r);
  });
  app.post("/admin/telephony/tests/room-voice", async (req: Request, res: Response) => {
    const by = who(req, res);
    const r = await testRoomVoice(body(req), by);
    record("test", "", `room voice test (${str(body(req).room, 40) || "?"})`, r, by, { numbers: r.numbers });
    send(res, r);
  });
  app.get("/admin/telephony/tests/sip-address", (_req: Request, res: Response) => {
    res.json({ ok: true, address: readTestSip(), providers: sipAddressProviders() });
  });
  app.post("/admin/telephony/tests/sip-address", async (req: Request, res: Response) => {
    const b = body(req);
    const r = await createTestSipAddress({ provider: str(b.provider, 20), ...(str(b.did, 20) ? { did: str(b.did, 20) } : {}), ...(Array.isArray(b.acl) ? { acl: b.acl.filter((x): x is string => typeof x === "string") } : {}), ...(str(b.region, 4) ? { region: str(b.region, 4) } : {}), by: who(req, res) });
    // The password is shown once (for the softphone) and kept nowhere here.
    res.status(r.ok ? 200 : 400).json({ ok: r.ok, address: r.address, ...(r.password ? { password: r.password } : {}), checks: r.checks, providers: sipAddressProviders(), ...(r.message ? { message: r.message } : {}) });
  });
  app.delete("/admin/telephony/tests/sip-address", async (req: Request, res: Response) => {
    const r = await deleteTestSipAddress(who(req, res));
    res.json({ ok: r.ok, checks: r.checks, address: readTestSip(), providers: sipAddressProviders() });
  });
}

export const __test = { outboundRefusal, matchesPattern };
