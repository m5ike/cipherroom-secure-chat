// Vonage adapter for m5.telephony:
//   Voice API     https://api.nexmo.com/v1/calls        Bearer RS256 application JWT (vonageJwt())
//   Messages API  https://api.nexmo.com/v1/messages     Bearer JWT (WhatsApp, Viber, Messenger)
//   SMS API       https://rest.nexmo.com/sms/json       api_key + api_secret in the form body
//   Number Insight https://api.nexmo.com/ni/{level}/json Basic key:secret (as the official SDK)
//   Numbers       https://rest.nexmo.com/number/*       Basic key:secret, form bodies
// Numbers are digits only on Vonage (no "+").
//
// NOTE: Number Insight v1 is sunset on 4 February 2027. Its successor
// (Identity Insights) has no roaming, reachability or caller name, so hlr()
// and the reachability part of lookup() stop working then — HLR-Lookups.com
// (hlrlookups.ts) is the replacement for live HLR data.

import { TelephonyNotConfiguredError, isE164 } from "../types";
import { vonageJwt, vonageVoiceReadiness } from "../connectors";
import {
  ProviderError, ProviderNotConfigured,
  type AvailableNumber, type CallAction, type CallStatus, type Capability, type ChatChannel, type ChatMessageInput,
  type ChatMessageResult, type HlrResult, type LookupField, type LookupResult, type MediaFormat, type NormalizedCallEvent,
  type NumberSearch, type OwnedNumber, type PlaceCallInput, type PlaceCallResult, type ProviderAdapter,
  type ProviderStatus, type RenderedLogic, type SmsInput, type SmsResult,
} from "./types";

const API = "https://api.nexmo.com";
const REST = "https://rest.nexmo.com";
const MESSAGES_URL = `${API}/v1/messages`;
const MESSAGES_SANDBOX_URL = "https://messages-sandbox.nexmo.com/v1/messages";
const TIMEOUT_MS = 15_000;

const KEY = "VONAGE_API_KEY";
const SECRET = "VONAGE_API_SECRET";
const FROM = "VONAGE_FROM";
const APP = "VONAGE_APPLICATION_ID";
const JWT_KEY = "VONAGE_JWT_KEY";
const WA_FROM = "VONAGE_WHATSAPP_FROM";
const VIBER_FROM = "VONAGE_VIBER_FROM";
const MESSENGER_PAGE = "VONAGE_MESSENGER_PAGE_ID";
const SANDBOX = "VONAGE_MESSAGES_SANDBOX";

const env = (name: string): string => process.env[name]?.trim() || "";
const cut = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}…` : s);
const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));
/** Vonage wants digits only; alphanumeric sender ids pass through. */
const digits = (n: string) => String(n).trim().replace(/^\+/, "");

/* ----------------------------------------------------------------- status */

const CAPABILITIES: Capability[] = ["call", "sms", "lookup", "hlr", "whatsapp", "viber", "messenger", "numbers", "media"];
/** Voice / Messages readiness is the parsed JWT key (vonageVoiceReadiness), marked "@jwt". */
const REQUIRED: Record<string, string[]> = {
  call: ["@jwt"], media: ["@jwt"],
  sms: [KEY, SECRET], lookup: [KEY, SECRET], hlr: [KEY, SECRET], numbers: [KEY, SECRET],
  whatsapp: ["@jwt", WA_FROM], viber: ["@jwt", VIBER_FROM], messenger: ["@jwt", MESSENGER_PAGE],
};
const NEEDS: Partial<Record<Capability, string[]>> = {
  call: [APP, JWT_KEY, FROM], media: [APP, JWT_KEY],
  sms: [KEY, SECRET, FROM], lookup: [KEY, SECRET], hlr: [KEY, SECRET], numbers: [KEY, SECRET, APP],
  whatsapp: [APP, JWT_KEY, WA_FROM, SANDBOX], viber: [APP, JWT_KEY, VIBER_FROM, SANDBOX], messenger: [APP, JWT_KEY, MESSENGER_PAGE, SANDBOX],
};

function statusOf(): ProviderStatus {
  const voice = vonageVoiceReadiness();
  const has = (n: string) => (n === "@jwt" ? voice.ok : env(n).length > 0);
  const name = (n: string) => (n === "@jwt" ? `${APP} + ${JWT_KEY}` : n);
  const configured = CAPABILITIES.filter((c) => REQUIRED[c].every(has));
  const groups = new Map<string, Capability[]>();
  for (const c of CAPABILITIES.filter((x) => !configured.includes(x))) {
    const key = REQUIRED[c].filter((n) => !has(n)).map(name).join(", ");
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  let reason = groups.size ? `Set ${[...groups].map(([vars, cs]) => `${vars} (${cs.join(", ")})`).join("; ")}.` : undefined;
  if (reason && !voice.ok) reason += ` ${voice.reason}`;
  return { id: "vonage", label: "Vonage", capabilities: [...CAPABILITIES], configured, needs: NEEDS, reason };
}

function jwt(capability: Capability): string {
  try {
    return vonageJwt();
  } catch (err) {
    if (err instanceof TelephonyNotConfiguredError) throw new ProviderNotConfigured("vonage", capability, `Vonage ${capability}: ${err.message}`);
    throw err;
  }
}

function basic(capability: Capability): string {
  const key = env(KEY);
  const secret = env(SECRET);
  if (!key || !secret) throw new ProviderNotConfigured("vonage", capability, `Vonage ${capability} is not configured: set ${KEY} and ${SECRET}.`);
  return `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
}

function badRequest(message: string): ProviderError {
  return new ProviderError("vonage", 400, cut(`Vonage: ${message}`));
}

function requireE164(n: string, what = "to"): string {
  const v = String(n ?? "").trim();
  if (!isE164(v)) throw badRequest(`"${what}" must be an E.164 number like +420123456789 (got "${cut(v)}").`);
  return v;
}

/* ------------------------------------------------------------------- HTTP */

type Body = { json: unknown } | { form: URLSearchParams } | undefined;

async function request(auth: string | null, method: "GET" | "POST" | "PUT", url: string, body?: Body): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth) headers.Authorization = auth;
  let payload: string | URLSearchParams | undefined;
  if (body && "json" in body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body.json); }
  if (body && "form" in body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = body.form; }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const e = err as Error;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new ProviderError("vonage", 504, `Vonage: no answer within ${TIMEOUT_MS / 1000} s.`);
    throw new ProviderError("vonage", 502, cut(`Vonage: request failed: ${e?.message || String(err)}`));
  }
  const text = await res.text();
  if (!res.ok) {
    // Voice / Messages: RFC 7807 {type, title, detail, instance}; Numbers: {"error-code","error-code-label"}.
    let message = text || res.statusText;
    let code: string | undefined;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const t = [j.title, j.detail].filter((x) => typeof x === "string" && x).join(": ");
      if (t) message = t;
      else if (typeof j["error-code-label"] === "string") message = j["error-code-label"] as string;
      if (j["error-code"] !== undefined) code = String(j["error-code"]);
      else if (typeof j.type === "string") code = j.type;
    } catch { /* not JSON */ }
    if (res.status === 401 && auth?.startsWith("Bearer ")) {
      message = `token rejected — the private key does not belong to ${APP}, or the application lacks this capability. ${message}`;
    }
    throw new ProviderError("vonage", res.status, cut(`Vonage ${res.status}: ${message}`), code);
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError("vonage", 502, cut(`Vonage ${res.status}: the answer is not JSON: ${text}`));
  }
}

/* ------------------------------------------------------------------- NCCO */

/** SSML silence (NCCO has no pause action; a <break> is at most 10 s). */
function silence(seconds: number): Record<string, unknown> {
  let left = Math.max(1, Math.round(seconds));
  const parts: string[] = [];
  while (left > 0) { const s = Math.min(10, left); parts.push(`<break time="${s}s"/>`); left -= s; }
  return { action: "talk", text: `<speak>${parts.join("")}</speak>` };
}

/**
 * The actions as an NCCO. A talk / stream right before a gather gets bargeIn,
 * so the caller can type while it plays. There is no NCCO hangup action: the
 * call ends when the NCCO runs out, so rendering stops at a hangup. NCCO has
 * no redirect either (see VonageAdapter.executeActions).
 */
export function renderNcco(actions: CallAction[]): Record<string, unknown>[] {
  const ncco: Record<string, unknown>[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    const next = actions[i + 1];
    const bargeIn = !!next && "gather" in next;
    if ("hangup" in a) break;
    if ("say" in a) {
      // Vonage talk has language + style (a number), not voice names.
      ncco.push({ action: "talk", text: a.say.text, ...(a.say.language ? { language: a.say.language } : {}), ...(a.say.loop ? { loop: a.say.loop } : {}), ...(bargeIn ? { bargeIn: true } : {}) });
    } else if ("play" in a) {
      ncco.push({ action: "stream", streamUrl: [a.play.url], ...(a.play.loop ? { loop: a.play.loop } : {}), ...(bargeIn ? { bargeIn: true } : {}) });
    } else if ("pause" in a) {
      ncco.push(silence(a.pause.seconds));
    } else if ("gather" in a) {
      const g = a.gather;
      if (g.prompt) ncco.push({ action: "talk", text: g.prompt, ...(g.language ? { language: g.language } : {}), bargeIn: true });
      const dtmf: Record<string, unknown> = {
        maxDigits: Math.min(20, Math.max(1, g.digits ?? 20)),
        // finishOnKey defaults to "#" as on Twilio; any other key cannot be expressed.
        submitOnHash: (g.finishOnKey ?? "#") === "#",
      };
      if (g.timeout) dtmf.timeOut = Math.min(30, Math.max(1, Math.round(g.timeout)));
      ncco.push({ action: "input", type: ["dtmf"], dtmf, eventUrl: [g.action], eventMethod: "POST" });
    } else if ("stream" in a) {
      const rate = a.stream.rate ?? 16000;
      ncco.push({
        action: "connect",
        endpoint: [{ type: "websocket", uri: a.stream.url, "content-type": `audio/l16;rate=${rate}`, headers: { ...(a.stream.params ?? {}) } }],
      });
    } else if ("record" in a) {
      // A record action only blocks the NCCO while a stop condition is set (verify):
      // "#", 5 s of silence (Twilio's default) or the length limit.
      ncco.push({
        action: "record", eventUrl: [a.record.action], eventMethod: "POST",
        beepStart: a.record.beep ?? true, endOnKey: "#", endOnSilence: 5,
        ...(a.record.maxSeconds ? { timeOut: Math.min(7200, Math.max(3, Math.round(a.record.maxSeconds))) } : {}),
      });
    } else if ("redirect" in a) {
      throw badRequest("NCCO has no redirect action; use executeActions([{ redirect }]) (a transfer to the URL) instead.");
    } else {
      throw badRequest(`unknown call action ${cut(JSON.stringify(a))}.`);
    }
  }
  return ncco;
}

/* ---------------------------------------------------------------- mapping */

/** Voice event `status` → CallStatus. */
export const VONAGE_CALL_STATUS: Record<string, CallStatus> = {
  started: "initiated", ringing: "ringing", answered: "answered", completed: "completed",
  busy: "busy", cancelled: "canceled", unanswered: "no-answer", timeout: "no-answer",
  rejected: "failed", failed: "failed", machine: "machine",
};

const NETWORK_TYPES: Record<string, string> = {
  mobile: "mobile", landline: "landline", landline_premium: "premium", landline_tollfree: "toll-free",
  virtual: "voip", pager: "pager", unknown: "unknown",
};

const SMS_ERROR_HTTP: Record<string, number> = { 1: 429, 4: 401, 5: 502, 8: 403, 9: 402 };

type Carrier = { network_code?: string; name?: string; country?: string; network_type?: string };

function carrierOf(c: Carrier | undefined | null) {
  if (!c) return undefined;
  const code = String(c.network_code ?? "");
  return { name: str(c.name), mcc: code.length >= 5 ? code.slice(0, 3) : undefined, mnc: code.length >= 5 ? code.slice(3) : undefined, country: str(c.country), type: c.network_type ? (NETWORK_TYPES[c.network_type] ?? c.network_type) : undefined };
}

const portedOf = (p: unknown): boolean | null | undefined => {
  if (p === undefined) return undefined;
  if (p === "ported" || p === "assumed_ported") return true;
  if (p === "not_ported" || p === "assumed_not_ported") return false;
  return null;
};

const validOf = (v: unknown): boolean | null | undefined => {
  if (v === undefined) return undefined;
  if (v === "valid" || v === "inferred") return true;
  if (v === "not_valid" || v === "inferred_not_valid") return false;
  return null;
};

type Roaming = { status?: string; roaming_country_code?: string; roaming_network_code?: string; roaming_network_name?: string } | string | undefined;
function roamingOf(r: Roaming) {
  if (r === undefined) return undefined;
  if (typeof r === "string") return { status: r };
  if (!r || !r.status) return null;
  return { status: r.status, country: str(r.roaming_country_code), network: str(r.roaming_network_name) ?? str(r.roaming_network_code) };
}

function fields(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    try { return JSON.parse(body) as Record<string, unknown>; } catch { return Object.fromEntries(new URLSearchParams(body)); }
  }
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/* ---------------------------------------------------------------- adapter */

export class VonageAdapter implements ProviderAdapter {
  readonly id = "vonage" as const;
  readonly label = "Vonage";
  readonly channels: ChatChannel[] = ["whatsapp", "viber", "messenger"];
  readonly media: MediaFormat = { transport: "binary-l16", codec: "L16", rate: 16000 };

  status(): ProviderStatus {
    return statusOf();
  }

  /* ---------------------------------------------------------------- calls */

  renderActions(actions: CallAction[]): RenderedLogic {
    return { contentType: "application/json", body: JSON.stringify(renderNcco(actions)) };
  }

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    const to = requireE164(input.to);
    if (!input.eventUrl) throw badRequest("eventUrl is required.");
    const from = input.from || env(FROM);
    if (!from) throw new ProviderNotConfigured("vonage", "call", `Vonage call has no caller id: set ${FROM} or pass from.`);
    const body: Record<string, unknown> = {
      to: [{ type: "phone", number: digits(to) }],
      from: { type: "phone", number: digits(from) },
      ringing_timer: Math.min(120, Math.max(1, Math.round(input.timeout))),
      event_url: [input.eventUrl],
      event_method: "POST",
    };
    if (input.timeLimit) body.length_timer = Math.min(86400, Math.max(1, Math.round(input.timeLimit)));
    // One source of logic: raw.ncco, then inline actions, then the answer URL.
    if (input.raw?.ncco) body.ncco = input.raw.ncco;
    else if (input.actions?.length) body.ncco = renderNcco(input.actions);
    else if (input.answerUrl) { body.answer_url = [input.answerUrl]; body.answer_method = "POST"; } // default would be GET
    else throw badRequest("placeCall needs answerUrl, actions or raw.ncco.");
    if (input.machineDetection) body.machine_detection = "continue";
    // clientState: Vonage has no echo field; the engine keeps it in eventUrl's query.
    const token = jwt("call");
    const j = await request(`Bearer ${token}`, "POST", `${API}/v1/calls`, { json: body });
    return { id: String(j.uuid ?? ""), provider: this.id, status: VONAGE_CALL_STATUS[String(j.status)] ?? "initiated", raw: j };
  }

  /**
   * Replace the live call's NCCO (a transfer). [redirect, …] transfers to that
   * URL's NCCO; an NCCO that renders empty (starts with hangup) hangs up.
   */
  async executeActions(callId: string, actions: CallAction[]): Promise<void> {
    const first = actions[0];
    let destination: Record<string, unknown>;
    if (first && "redirect" in first) destination = { type: "ncco", url: [first.redirect.url] };
    else {
      const ncco = renderNcco(actions);
      if (!ncco.length) return this.hangup(callId);
      destination = { type: "ncco", ncco };
    }
    const token = jwt("call");
    await request(`Bearer ${token}`, "PUT", `${API}/v1/calls/${encodeURIComponent(callId)}`, { json: { action: "transfer", destination } });
  }

  async hangup(callId: string): Promise<void> {
    const token = jwt("call");
    await request(`Bearer ${token}`, "PUT", `${API}/v1/calls/${encodeURIComponent(callId)}`, { json: { action: "hangup" } });
  }

  /**
   * An answer / event / input webhook (JSON body, or the query for a GET) → one event:
   *   dtmf → "gather"; status machine / human → "machine"; any other status → "status";
   *   no status (the answer_url request) → "answer"; recording_url → "other".
   */
  parseCallEvent(body: unknown, query: Record<string, string>): NormalizedCallEvent[] {
    const f = { ...(query ?? {}), ...fields(body) } as Record<string, unknown>;
    const callId = str(f.uuid) ?? str(f.call_uuid);
    if (!callId) return [];
    const status = str(f.status);
    const dtmf = f.dtmf as { digits?: string; timed_out?: boolean } | undefined;
    const dir = str(f.direction);
    const ev: NormalizedCallEvent = {
      provider: this.id,
      callId,
      status: null,
      kind: "other",
      from: str(f.from),
      to: str(f.to),
      direction: dir === "inbound" ? "inbound" : dir === "outbound" ? "outbound" : undefined,
      sipCode: str(f.sip_code),
      cause: str(f.detail),
      eventId: status && f.timestamp ? `${callId}:${status}:${String(f.timestamp)}` : undefined,
      raw: f,
    };
    if (dtmf && typeof dtmf === "object") {
      ev.kind = "gather";
      ev.digits = String(dtmf.digits ?? "");
      if (dtmf.timed_out) ev.cause = "timeout";
    } else if (status === "machine" || status === "human") {
      ev.kind = "machine";
      ev.status = status === "machine" ? "machine" : null;
      ev.cause = status;
    } else if (status) {
      ev.status = VONAGE_CALL_STATUS[status] ?? null;
      ev.kind = ev.status ? "status" : "other";
      if (f.duration !== undefined && f.duration !== "") {
        const d = Number(f.duration);
        if (Number.isFinite(d)) ev.durationSec = d;
      }
    } else if (!f.recording_url) {
      ev.kind = "answer";
    }
    return [ev];
  }

  /* ------------------------------------------------------------ messaging */

  /** SMS API. Non-GSM text goes as type "unicode" unless options.unicode says otherwise. */
  async sendSms(input: SmsInput): Promise<SmsResult> {
    const to = requireE164(input.to);
    const key = env(KEY);
    const secret = env(SECRET);
    if (!key || !secret) throw new ProviderNotConfigured("vonage", "sms", `Vonage sms is not configured: set ${KEY} and ${SECRET}.`);
    const from = input.from || env(FROM);
    if (!from) throw new ProviderNotConfigured("vonage", "sms", `Vonage SMS has no sender: set ${FROM} or pass from.`);
    const o = input.options ?? {};
    const form = new URLSearchParams({ api_key: key, api_secret: secret, from: digits(from), to: digits(to), text: input.text });
    // Rough GSM-7 check: anything outside ASCII is sent as unicode (safe, maybe more parts).
    const unicode = o.unicode ?? /[^\u0000-\u007f]/.test(input.text);
    if (unicode) form.append("type", "unicode");
    if (o.ttl) form.append("ttl", String(Math.min(604_800_000, Math.max(20_000, Math.round(o.ttl * 1000)))));
    if (o.statusUrl) { form.append("callback", o.statusUrl); form.append("status-report-req", "1"); }
    if (o.clientRef) form.append("client-ref", o.clientRef.slice(0, 100));
    const j = await request(null, "POST", `${REST}/sms/json`, { form });
    const msgs = (j.messages ?? []) as Array<Record<string, string | undefined>>;
    const bad = msgs.find((m) => m.status !== undefined && m.status !== "0");
    if (bad) {
      const status = String(bad.status);
      throw new ProviderError("vonage", SMS_ERROR_HTTP[status] ?? 400, cut(`Vonage SMS error ${status}: ${bad["error-text"] || "send failed"}`), status);
    }
    const price = msgs.reduce((sum, m) => sum + (Number(m["message-price"]) || 0), 0);
    return {
      id: msgs[0]?.["message-id"] ?? "", provider: this.id, status: "submitted",
      parts: j["message-count"] !== undefined ? Number(j["message-count"]) : msgs.length,
      price: msgs.some((m) => m["message-price"] !== undefined) ? `${Number(price.toFixed(8))} EUR` : undefined,
      raw: j,
    };
  }

  /** WhatsApp, Viber (viber_service) and Messenger through the Messages API. */
  async sendChat(input: ChatMessageInput): Promise<ChatMessageResult> {
    const channel = input.channel;
    const body: Record<string, unknown> = {};
    if (channel === "whatsapp" || channel === "viber") {
      body.to = digits(requireE164(input.to));
    } else if (channel === "messenger") {
      const psid = String(input.to ?? "").trim();
      if (!psid) throw badRequest(`"to" must be the recipient's page-scoped id (PSID).`);
      body.to = psid;
    } else {
      throw badRequest(`unknown channel ${cut(String(channel))}.`);
    }
    const fromVar = channel === "whatsapp" ? WA_FROM : channel === "viber" ? VIBER_FROM : MESSENGER_PAGE;
    const from = input.from || env(fromVar);
    if (!from) throw new ProviderNotConfigured("vonage", channel, `Vonage ${channel} has no sender: set ${fromVar} or pass from.`);
    body.from = channel === "whatsapp" ? digits(from) : from;
    body.channel = channel === "viber" ? "viber_service" : channel;

    if (channel === "whatsapp" && input.template) {
      const t = input.template;
      // Meta-native template form (message_type custom); the sandbox has no templates.
      body.message_type = "custom";
      body.custom = {
        type: "template",
        template: {
          name: t.name,
          language: { policy: "deterministic", code: t.language },
          ...(t.params?.length ? { components: [{ type: "body", parameters: t.params.map((text) => ({ type: "text", text })) }] } : {}),
        },
      };
    } else if (input.media) {
      const type = input.media.type;
      if (channel === "viber" && type === "audio") throw badRequest("Viber has no audio messages.");
      body.message_type = type;
      // A caption travels with WhatsApp image / video / file only.
      body[type] = { url: input.media.url, ...(input.text && type !== "audio" && channel === "whatsapp" ? { caption: input.text } : {}) };
    } else if (input.text) {
      body.message_type = "text";
      body.text = input.text;
    } else {
      throw badRequest("text, media or template is required.");
    }
    if (channel === "viber" && input.category) body.viber_service = { category: input.category.toLowerCase() };
    if (channel === "messenger" && (input.category || input.tag)) {
      // Only HUMAN_AGENT still works among the tags (Meta removed the others in 2026).
      const category = (input.category || "MESSAGE_TAG").toLowerCase();
      body.messenger = { category, ...(input.tag ? { tag: input.tag } : {}) };
    }
    if (input.clientRef) body.client_ref = input.clientRef.slice(0, 100);
    if (input.statusUrl) body.webhook_url = input.statusUrl;

    const token = jwt(channel);
    const url = env(SANDBOX) === "1" ? MESSAGES_SANDBOX_URL : MESSAGES_URL;
    const j = await request(`Bearer ${token}`, "POST", url, { json: body });
    return { id: String(j.message_uuid ?? ""), provider: this.id, channel, status: "submitted", raw: j };
  }

  /* ---------------------------------------------------------- lookup, HLR */

  private async insight(capability: Capability, level: "basic" | "standard" | "advanced", number: string, cnam: boolean): Promise<Record<string, unknown>> {
    const n = requireE164(number, "number");
    const auth = basic(capability);
    const qs = new URLSearchParams({ number: digits(n) });
    if (cnam) qs.append("cnam", "true");
    const j = await request(auth, "GET", `${API}/ni/${level}/json?${qs.toString()}`);
    const status = Number(j.status ?? 0);
    // 0 success; 43/44/45 = the advanced lookup could not reach the network (data is partial).
    if (status !== 0 && ![43, 44, 45].includes(status)) {
      const http = status === 1 ? 429 : status === 4 ? 401 : status === 5 ? 502 : 400;
      throw new ProviderError("vonage", http, cut(`Vonage Number Insight ${status}: ${String(j.status_message ?? "lookup failed")}`), String(status));
    }
    return j;
  }

  /**
   * Number Insight: basic (free) for format/country; standard for carrier,
   * line type, ported and caller name (US CNAM); advanced for reachability
   * (line_status) and validity. sim_swap is not available here.
   */
  async lookup(number: string, fields: LookupField[]): Promise<LookupResult> {
    const advanced = fields.includes("line_status") || fields.includes("validation");
    const standard = fields.some((f) => f === "carrier" || f === "line_type" || f === "portability" || f === "caller_name");
    const level = advanced ? "advanced" : standard ? "standard" : "basic";
    const j = await this.insight("lookup", level, number, fields.includes("caller_name"));
    const current = carrierOf(j.current_carrier as Carrier | undefined);
    const result: LookupResult = {
      number: j.international_format_number ? `+${String(j.international_format_number)}` : requireE164(number, "number"),
      provider: this.id,
      valid: validOf(j.valid_number),
      national: str(j.national_format_number),
      country: j.country_code ? { code: String(j.country_code), name: str(j.country_name), prefix: j.country_prefix ? `+${String(j.country_prefix)}` : undefined } : undefined,
      raw: j,
    };
    if (current) {
      result.type = current.type;
      result.carrier = { name: current.name, mcc: current.mcc, mnc: current.mnc, type: current.type };
    }
    if (j.caller_name !== undefined) result.callerName = str(j.caller_name);
    if (j.caller_type !== undefined) result.callerType = str(j.caller_type);
    const ported = portedOf(j.ported);
    if (ported !== undefined) result.ported = ported;
    if (j.reachable !== undefined) result.reachable = str(j.reachable);
    const roaming = roamingOf(j.roaming as Roaming);
    if (roaming !== undefined) result.roaming = roaming;
    return result;
  }

  /** Live HLR through Number Insight Advanced (reachable, roaming, valid_number). Sunset 2027-02-04. */
  async hlr(number: string): Promise<HlrResult> {
    const j = await this.insight("hlr", "advanced", number, false);
    const reachable = str(j.reachable);
    const valid = validOf(j.valid_number);
    let status: HlrResult["status"] = "undetermined";
    if (reachable === "bad_number" || valid === false) status = "invalid";
    else if (reachable === "reachable") status = "connected";
    else if (reachable === "absent" || reachable === "undeliverable") status = "absent";
    const current = carrierOf(j.current_carrier as Carrier | undefined);
    const original = carrierOf(j.original_carrier as Carrier | undefined);
    const roaming = roamingOf(j.roaming as Roaming);
    return {
      number: j.international_format_number ? `+${String(j.international_format_number)}` : requireE164(number, "number"),
      provider: this.id,
      status,
      valid,
      reachable,
      network: current ? { name: current.name, mcc: current.mcc, mnc: current.mnc, country: current.country } : undefined,
      original: original ? { name: original.name, country: original.country } : undefined,
      ported: portedOf(j.ported),
      roaming,
      cost: j.request_price !== undefined ? `${String(j.request_price)} EUR` : undefined,
      raw: j,
    };
  }

  /* -------------------------------------------------------------- numbers */

  private async numbersCall(path: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    const auth = basic("numbers");
    const j = await request(auth, "POST", `${REST}${path}`, { form });
    const code = str(j["error-code"]);
    if (code && code !== "200") {
      throw new ProviderError("vonage", Number(code) >= 400 && Number(code) < 600 ? Number(code) : 400, cut(`Vonage ${path}: ${String(j["error-code-label"] ?? code)}`), code);
    }
    return j;
  }

  async searchNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    const auth = basic("numbers");
    const country = String(q.country ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw badRequest(`country must be an ISO 3166 alpha-2 code like CZ (got "${cut(country)}").`);
    const qs = new URLSearchParams({ country });
    if (q.type) qs.append("type", q.type === "mobile" ? "mobile-lvn" : q.type === "tollfree" ? "landline-toll-free" : "landline");
    const features = [q.sms ? "SMS" : "", q.voice ? "VOICE" : ""].filter(Boolean);
    if (features.length) qs.append("features", features.join(","));
    if (q.contains) { qs.append("pattern", q.contains); qs.append("search_pattern", "1"); }
    qs.append("size", String(Math.min(100, Math.max(1, q.limit ?? 10))));
    const j = await request(auth, "GET", `${REST}/number/search?${qs.toString()}`);
    return ((j.numbers ?? []) as Array<Record<string, unknown>>).map((n) => ({
      number: `+${String(n.msisdn ?? "")}`,
      country: String(n.country ?? country),
      capabilities: ((n.features ?? []) as string[]).map((f) => String(f).toLowerCase()),
      cost: n.cost !== undefined ? `${String(n.cost)} EUR/month` : undefined,
      raw: n,
    }));
  }

  /** Buy; with voiceUrl (and VONAGE_APPLICATION_ID) the number is also linked to the application. */
  async buyNumber(number: string, opts: { country: string; voiceUrl?: string }): Promise<OwnedNumber> {
    const n = requireE164(number, "number");
    const country = String(opts?.country ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw badRequest("buyNumber needs opts.country (ISO 3166 alpha-2).");
    const j = await this.numbersCall("/number/buy", new URLSearchParams({ country, msisdn: digits(n) }));
    if (opts.voiceUrl) await this.assignNumber(n, { country, voiceUrl: opts.voiceUrl });
    return { id: digits(n), number: n, provider: this.id, raw: j };
  }

  /**
   * Link the number to VONAGE_APPLICATION_ID: its calls then hit the
   * application's answer_url (installProviderWebhooks sets it). voiceUrl is
   * not a per-number setting on Vonage.
   */
  async assignNumber(idOrNumber: string, opts: { voiceUrl?: string; country?: string }): Promise<void> {
    const n = digits(idOrNumber);
    if (!/^\d{3,15}$/.test(n)) throw badRequest(`"${cut(String(idOrNumber))}" is not a phone number.`);
    const country = String(opts?.country ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw badRequest("assignNumber needs opts.country (ISO 3166 alpha-2).");
    const app = env(APP);
    if (!app) throw new ProviderNotConfigured("vonage", "numbers", `Vonage numbers: set ${APP} (the application the number is linked to).`);
    await this.numbersCall("/number/update", new URLSearchParams({ country, msisdn: n, app_id: app }));
  }

  async releaseNumber(idOrNumber: string, opts?: { country?: string }): Promise<void> {
    const n = digits(idOrNumber);
    if (!/^\d{3,15}$/.test(n)) throw badRequest(`"${cut(String(idOrNumber))}" is not a phone number.`);
    const country = String(opts?.country ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw badRequest("releaseNumber needs opts.country (ISO 3166 alpha-2).");
    await this.numbersCall("/number/cancel", new URLSearchParams({ country, msisdn: n }));
  }
}
