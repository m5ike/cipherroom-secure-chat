// Telnyx adapter for m5.telephony: Call Control v2 (asynchronous commands),
// messaging, WhatsApp, Number Lookup and numbers. Bearer API key, JSON bodies.
// Field names follow the official OpenAPI spec (team-telnyx/openapi spec3.json).
//
// Call Control has no synchronous "answer with logic": a call is dialled (or
// answered), and every step is a command whose outcome arrives later as a
// webhook. executeActions therefore sends the commands up to and including
// the first one that waits (speak, playback, gather, stream, record) and
// stops; the engine continues with the rest (telnyxPendingActions) when the
// matching webhook arrives (telnyxWaitsFor → call.speak.ended, …).
//
// Gotchas: timeout_secs has a minimum of 5; client_state must be base64;
// events can be duplicated or out of order (dedupe on data.id); there is no
// separate busy / no-answer event — call.hangup's hangup_cause says it.

import { isE164 } from "../types";
import {
  ProviderError, ProviderNotConfigured,
  type AvailableNumber, type CallAction, type CallStatus, type Capability, type ChatChannel, type ChatMessageInput,
  type ChatMessageResult, type LookupField, type LookupResult, type MediaFormat, type NormalizedCallEvent,
  type NumberSearch, type OwnedNumber, type PlaceCallInput, type PlaceCallResult, type ProviderAdapter,
  type ProviderStatus, type SmsInput, type SmsResult,
} from "./types";

const API = "https://api.telnyx.com/v2";
const TIMEOUT_MS = 15_000;

const KEY = "TELNYX_API_KEY";
const FROM = "TELNYX_FROM";
const CONNECTION = "TELNYX_CONNECTION_ID";
const PROFILE = "TELNYX_MESSAGING_PROFILE_ID";
const WA_FROM = "TELNYX_WHATSAPP_FROM";

const env = (name: string): string => process.env[name]?.trim() || "";
const cut = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}…` : s);
const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));

/* ----------------------------------------------------------------- status */

const CAPABILITIES: Capability[] = ["call", "sms", "lookup", "whatsapp", "numbers", "media"];
const REQUIRED: Record<string, string[]> = {
  call: [KEY, CONNECTION], media: [KEY, CONNECTION], sms: [KEY], lookup: [KEY], numbers: [KEY], whatsapp: [KEY, WA_FROM],
};
const NEEDS: Partial<Record<Capability, string[]>> = {
  call: [KEY, CONNECTION, FROM], sms: [KEY, FROM, PROFILE], lookup: [KEY], whatsapp: [KEY, WA_FROM, PROFILE],
  numbers: [KEY, CONNECTION, PROFILE], media: [KEY, CONNECTION],
};

function statusOf(id: "telnyx", label: string, caps: Capability[], required: Record<string, string[]>, needs: ProviderStatus["needs"]): ProviderStatus {
  const has = (n: string) => env(n).length > 0;
  const configured = caps.filter((c) => required[c].every(has));
  const groups = new Map<string, Capability[]>();
  for (const c of caps.filter((x) => !configured.includes(x))) {
    const key = required[c].filter((n) => !has(n)).join(", ");
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const reason = groups.size ? `Set ${[...groups].map(([vars, cs]) => `${vars} (${cs.join(", ")})`).join("; ")}.` : undefined;
  return { id, label, capabilities: [...caps], configured, needs, reason };
}

function apiKey(capability: Capability): string {
  const key = env(KEY);
  if (!key) throw new ProviderNotConfigured("telnyx", capability, `Telnyx ${capability} is not configured: set ${KEY}.`);
  return key;
}

function connectionId(capability: Capability): string {
  const id = env(CONNECTION);
  if (!id) throw new ProviderNotConfigured("telnyx", capability, `Telnyx ${capability} needs the Call Control application: set ${CONNECTION}.`);
  return id;
}

function badRequest(message: string): ProviderError {
  return new ProviderError("telnyx", 400, cut(`Telnyx: ${message}`));
}

function requireE164(n: string, what = "to"): string {
  const v = String(n ?? "").trim();
  if (!isE164(v)) throw badRequest(`"${what}" must be an E.164 number like +420123456789 (got "${cut(v)}").`);
  return v;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/* ------------------------------------------------------------------- HTTP */

async function request(key: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined
        ? { Authorization: `Bearer ${key}`, Accept: "application/json" }
        : { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new ProviderError("telnyx", 504, `Telnyx: no answer within ${TIMEOUT_MS / 1000} s.`);
    throw new ProviderError("telnyx", 502, cut(`Telnyx: request failed: ${e?.message || String(err)}`));
  }
  const text = await res.text();
  if (!res.ok) {
    // {"errors":[{"code":"10015","title":"Invalid value","detail":"…","source":{…}}]}
    let message = text || res.statusText;
    let code: string | undefined;
    try {
      const first = (JSON.parse(text) as { errors?: Array<{ code?: string | number; title?: string; detail?: string }> }).errors?.[0];
      if (first) {
        message = [first.title, first.detail].filter(Boolean).join(": ") || message;
        if (first.code !== undefined) code = String(first.code);
      }
    } catch { /* not JSON */ }
    throw new ProviderError("telnyx", res.status, cut(`Telnyx ${res.status}: ${message}`), code);
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError("telnyx", 502, cut(`Telnyx ${res.status}: the answer is not JSON: ${text}`));
  }
}

const dataOf = (j: Record<string, unknown>) => (j.data ?? {}) as Record<string, unknown>;

/* ------------------------------------------------------- call-control plan */

/** The webhook that ends a waiting action, or null for one that runs on at once. */
export function telnyxWaitsFor(action: CallAction): string | null {
  if ("say" in action || "pause" in action) return "call.speak.ended";
  if ("play" in action) return "call.playback.ended";
  if ("gather" in action) return "call.gather.ended";
  // A stream holds the call like Twilio's <Connect><Stream> / Vonage's connect:
  // what follows it runs when the stream stops.
  if ("stream" in action) return "streaming.stopped";
  // record_start with a silence timeout ends like Twilio's <Record>.
  if ("record" in action) return "call.recording.saved";
  return null;
}

/**
 * Split actions into [now, later]: `now` runs up to and including the first
 * action that waits for the caller (see telnyxWaitsFor); `later` runs when its
 * webhook arrives. Nothing runs after a hangup.
 */
export function telnyxPendingActions(actions: CallAction[]): [CallAction[], CallAction[]] {
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    if ("hangup" in a) return [actions.slice(0, i + 1), []];
    if (telnyxWaitsFor(a)) return [actions.slice(0, i + 1), actions.slice(i + 1)];
  }
  return [actions.slice(), []];
}

/** Other-provider voice names → Telnyx: woman/man → female/male, Polly.X → AWS.Polly.X. */
export function telnyxVoice(voice?: string): string {
  if (!voice || voice === "woman" || voice === "alice") return "female";
  if (voice === "man") return "male";
  if (voice.startsWith("Polly.")) return `AWS.${voice}`;
  return voice;
}

/** speak / gather_using_speak voice fields. The gender voices belong to the
 *  basic service level, which only speaks en-US; everything else is premium. */
function voiceFields(voice: string | undefined, language: string | undefined): Record<string, unknown> {
  const v = telnyxVoice(voice);
  const lang = language || "en-US";
  const basic = (v === "female" || v === "male") && lang === "en-US";
  return { voice: v, language: lang, ...(basic ? { service_level: "basic" } : {}) };
}

/** Silence of n seconds as SSML (Telnyx has no pause command; SSML <break> is at most 10 s). */
function silenceSsml(seconds: number): string {
  let left = Math.max(1, Math.round(seconds));
  const parts: string[] = [];
  while (left > 0) { const s = Math.min(10, left); parts.push(`<break time="${s}s"/>`); left -= s; }
  return `<speak>${parts.join("")}</speak>`;
}

function command(action: CallAction, clientState?: string): { cmd: string; body: Record<string, unknown> } {
  const cs = clientState ? { client_state: b64(clientState) } : {};
  if ("say" in action) {
    const s = action.say;
    return { cmd: "speak", body: { payload: s.text, payload_type: "text", ...voiceFields(s.voice, s.language), ...(s.loop ? { loop: s.loop } : {}), ...cs } };
  }
  if ("pause" in action) {
    // (verify) SSML needs the premium service level, so a premium voice; it says nothing.
    return { cmd: "speak", body: { payload: silenceSsml(action.pause.seconds), payload_type: "ssml", voice: "AWS.Polly.Joanna-Neural", service_level: "premium", ...cs } };
  }
  if ("play" in action) {
    return { cmd: "playback_start", body: { audio_url: action.play.url, ...(action.play.loop ? { loop: action.play.loop } : {}), ...cs } };
  }
  if ("gather" in action) {
    const g = action.gather;
    const digits: Record<string, unknown> = {};
    if (g.digits) { digits.minimum_digits = g.digits; digits.maximum_digits = g.digits; }
    // finishOnKey "" disables the terminator; Telnyx's default is "#" like Twilio's.
    const finish = g.finishOnKey ?? "#";
    if (finish) digits.terminating_digit = finish;
    if (g.timeout) digits.timeout_millis = Math.round(g.timeout * 1000);
    if (g.prompt) {
      return { cmd: "gather_using_speak", body: { payload: g.prompt, payload_type: "text", ...voiceFields(g.voice, g.language), ...digits, ...cs } };
    }
    return { cmd: "gather", body: { ...digits, ...cs } };
  }
  if ("stream" in action) {
    const st = action.stream;
    const codec = st.codec ?? "PCMU";
    return {
      cmd: "streaming_start",
      body: {
        stream_url: st.url,
        stream_track: "inbound_track",
        ...(st.codec ? { stream_codec: st.codec } : {}),
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: codec,
        ...(st.rate ? { stream_bidirectional_sampling_rate: st.rate } : {}),
        stream_bidirectional_target_legs: "opposite",
        ...(st.params && Object.keys(st.params).length
          ? { custom_parameters: Object.entries(st.params).map(([name, value]) => ({ name, value })) }
          : {}),
        ...cs,
      },
    };
  }
  if ("record" in action) {
    const r = action.record;
    // timeout_secs: stop after that much silence, like Twilio's <Record> (its default is 5 s).
    return {
      cmd: "record_start",
      body: { format: "mp3", channels: "single", play_beep: r.beep ?? true, ...(r.maxSeconds ? { max_length: r.maxSeconds } : {}), timeout_secs: 5, ...cs },
    };
  }
  if ("hangup" in action) return { cmd: "hangup", body: { ...cs } };
  if ("redirect" in action) throw badRequest("Call Control has no redirect: run the next logic with executeActions instead.");
  throw badRequest(`unknown call action ${cut(JSON.stringify(action))}.`);
}

/* ---------------------------------------------------------------- mapping */

/** call.hangup hangup_cause → CallStatus (there is no separate busy / no-answer event). */
export const TELNYX_HANGUP_STATUS: Record<string, CallStatus> = {
  normal_clearing: "completed", time_limit: "completed",
  user_busy: "busy",
  timeout: "no-answer", no_answer: "no-answer",
  originator_cancel: "canceled",
  call_rejected: "failed", not_found: "failed", unspecified: "failed",
};

const LINE_TYPES: Record<string, string> = {
  "fixed line": "landline", mobile: "mobile", voip: "voip", "fixed line or mobile": "landline-or-mobile",
  "toll free": "toll-free", "premium rate": "premium", "shared cost": "shared-cost", "personal number": "personal",
  pager: "pager", uan: "uan", voicemail: "voicemail", unknown: "unknown",
};

function hangupStatus(p: Record<string, unknown>): CallStatus {
  const cause = String(p.hangup_cause ?? "");
  const mapped = TELNYX_HANGUP_STATUS[cause];
  if (mapped) return mapped;
  const sip = Number(p.sip_hangup_cause);
  return Number.isFinite(sip) && sip >= 400 ? "failed" : "completed";
}

/* ---------------------------------------------------------------- adapter */

export class TelnyxAdapter implements ProviderAdapter {
  readonly id = "telnyx" as const;
  readonly label = "Telnyx";
  readonly channels: ChatChannel[] = ["whatsapp"];
  readonly media: MediaFormat = { transport: "json-rtp", codec: "PCMU", rate: 8000 };

  status(): ProviderStatus {
    return statusOf(this.id, this.label, CAPABILITIES, REQUIRED, NEEDS);
  }

  /* ---------------------------------------------------------------- calls */

  /**
   * Dial. Call Control carries no logic at dial time: answerUrl and actions are
   * not sent — the engine runs the actions with executeActions() once
   * call.answered arrives at eventUrl. raw.texml needs a TeXML application,
   * which this adapter does not drive.
   */
  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    const to = requireE164(input.to);
    if (input.raw?.texml) throw badRequest("raw.texml needs a TeXML application; this adapter drives Call Control (use actions).");
    if (!input.eventUrl) throw badRequest("eventUrl is required.");
    const key = apiKey("call");
    const connection = connectionId("call");
    const from = input.from || env(FROM);
    if (!from) throw new ProviderNotConfigured("telnyx", "call", `Telnyx call has no caller id: set ${FROM} or pass from.`);
    const body: Record<string, unknown> = {
      connection_id: connection,
      to,
      from,
      // The API minimum is 5 s (maximum 600).
      timeout_secs: Math.min(600, Math.max(5, Math.round(input.timeout))),
      webhook_url: input.eventUrl,
      webhook_url_method: "POST",
    };
    if (input.timeLimit) body.time_limit_secs = Math.min(14400, Math.max(30, Math.round(input.timeLimit)));
    if (input.clientState) body.client_state = b64(input.clientState);
    if (input.machineDetection) body.answering_machine_detection = "detect";
    const j = await request(key, "POST", "/calls", body);
    const d = dataOf(j);
    return { id: String(d.call_control_id ?? ""), provider: this.id, status: "initiated", raw: j };
  }

  async answer(callId: string, ctx?: { clientState?: string }): Promise<void> {
    const key = apiKey("call");
    await request(key, "POST", `/calls/${encodeURIComponent(callId)}/actions/answer`, ctx?.clientState ? { client_state: b64(ctx.clientState) } : {});
  }

  /**
   * Run the actions as call-control commands: only those up to and including
   * the first waiting one (telnyxPendingActions); the caller runs the rest when
   * that action's webhook arrives. Every action is checked before any command is sent.
   */
  async executeActions(callId: string, actions: CallAction[], ctx?: { clientState?: string }): Promise<void> {
    const key = apiKey("call");
    const [now] = telnyxPendingActions(actions);
    const commands = now.map((a) => command(a, ctx?.clientState));
    for (const later of actions.slice(now.length)) command(later); // validate the rest too
    for (const c of commands) {
      await request(key, "POST", `/calls/${encodeURIComponent(callId)}/actions/${c.cmd}`, c.body);
    }
  }

  async hangup(callId: string): Promise<void> {
    const key = apiKey("call");
    await request(key, "POST", `/calls/${encodeURIComponent(callId)}/actions/hangup`, {});
  }

  /**
   * A v2 webhook envelope {data:{event_type, id, payload}} → one event. Only call
   * and streaming events are call events; anything else (message.*) → [].
   * call.initiated for an incoming call is kind "answer" (it waits for answer()).
   */
  parseCallEvent(body: unknown): NormalizedCallEvent[] {
    let j: unknown = body;
    if (typeof body === "string") { try { j = JSON.parse(body); } catch { return []; } }
    const data = (j as { data?: Record<string, unknown> } | null)?.data;
    if (!data || typeof data !== "object") return [];
    const type = String(data.event_type ?? "");
    if (!type.startsWith("call.") && !type.startsWith("streaming.")) return [];
    const p = (data.payload ?? {}) as Record<string, unknown>;
    const callId = str(p.call_control_id);
    if (!callId) return [];
    const dir = str(p.direction);
    const ev: NormalizedCallEvent = {
      provider: this.id,
      callId,
      status: null,
      kind: "other",
      from: str(p.from),
      to: str(p.to),
      direction: dir === "incoming" ? "inbound" : dir === "outgoing" ? "outbound" : undefined,
      eventId: str(data.id),
      raw: j,
    };
    if (typeof p.client_state === "string" && p.client_state) {
      try { ev.clientState = unb64(p.client_state); } catch { /* keep undefined */ }
    }
    switch (type) {
      case "call.initiated":
        ev.status = "initiated";
        ev.kind = dir === "incoming" ? "answer" : "status";
        break;
      case "call.answered":
        ev.status = "answered"; ev.kind = "status";
        break;
      case "call.hangup":
        ev.status = hangupStatus(p); ev.kind = "status";
        ev.cause = str(p.hangup_cause);
        ev.sipCode = str(p.sip_hangup_cause);
        break;
      case "call.gather.ended":
        ev.kind = "gather"; ev.digits = String(p.digits ?? ""); ev.cause = str(p.status);
        break;
      case "call.dtmf.received":
        ev.kind = "dtmf"; ev.digits = str(p.digit);
        break;
      case "call.speak.ended":
        ev.kind = "speak-ended"; ev.cause = str(p.status);
        break;
      case "call.playback.ended":
        ev.kind = "playback-ended"; ev.cause = str(p.status);
        break;
      case "call.machine.detection.ended":
      case "call.machine.premium.detection.ended": {
        const result = String(p.result ?? "");
        ev.kind = "machine"; ev.cause = result || undefined;
        ev.status = result === "machine" ? "machine" : null;
        break;
      }
      default:
        if (type.startsWith("streaming.")) { ev.kind = "stream"; ev.cause = str(p.failure_reason) ?? type.slice("streaming.".length); }
    }
    return [ev];
  }

  /* ------------------------------------------------------------ messaging */

  async sendSms(input: SmsInput): Promise<SmsResult> {
    const to = requireE164(input.to);
    const key = apiKey("sms");
    const o = input.options ?? {};
    const from = input.from || env(FROM);
    const profile = o.messagingProfileId || env(PROFILE);
    if (!from && !profile) throw new ProviderNotConfigured("telnyx", "sms", `Telnyx SMS has no sender: set ${FROM} or ${PROFILE}, or pass from.`);
    const body: Record<string, unknown> = { to, text: input.text };
    if (from) body.from = from;
    if (profile) body.messaging_profile_id = profile;
    if (o.unicode) body.encoding = "ucs2";
    if (o.statusUrl) body.webhook_url = o.statusUrl;
    if (o.sendAt) body.send_at = o.sendAt;
    // ttl / clientRef: /v2/messages has no validity or client-reference field.
    const j = await request(key, "POST", "/messages", body);
    const d = dataOf(j);
    const first = ((d.to ?? []) as Array<{ status?: string }>)[0];
    const cost = d.cost as { amount?: string; currency?: string } | null | undefined;
    return {
      id: String(d.id ?? ""), provider: this.id, status: first?.status ?? "queued",
      parts: typeof d.parts === "number" ? d.parts : undefined,
      price: cost?.amount ? `${cost.amount}${cost.currency ? ` ${cost.currency}` : ""}` : undefined,
      raw: j,
    };
  }

  /** WhatsApp through /v2/messages/whatsapp (the Meta Cloud API message shape). */
  async sendChat(input: ChatMessageInput): Promise<ChatMessageResult> {
    if (input.channel !== "whatsapp") throw badRequest(`the ${input.channel} channel is not supported by Telnyx.`);
    const to = requireE164(input.to);
    const key = apiKey("whatsapp");
    const from = input.from || env(WA_FROM);
    if (!from) throw new ProviderNotConfigured("telnyx", "whatsapp", `Telnyx WhatsApp has no sender: set ${WA_FROM} or pass from.`);
    let message: Record<string, unknown>;
    if (input.template) {
      const t = input.template;
      message = {
        type: "template",
        template: {
          name: t.name,
          language: { policy: "deterministic", code: t.language },
          ...(t.params?.length ? { components: [{ type: "body", parameters: t.params.map((text) => ({ type: "text", text })) }] } : {}),
        },
      };
    } else if (input.media) {
      const type = input.media.type === "file" ? "document" : input.media.type;
      message = { type, [type]: { link: input.media.url, ...(input.text && type !== "audio" ? { caption: input.text } : {}) } };
    } else if (input.text) {
      message = { type: "text", text: { body: input.text } };
    } else {
      throw badRequest("text, media or template is required.");
    }
    const body: Record<string, unknown> = { from, to, whatsapp_message: message };
    if (env(PROFILE)) body.messaging_profile_id = env(PROFILE);
    if (input.statusUrl) body.webhook_url = input.statusUrl;
    const j = await request(key, "POST", "/messages/whatsapp", body);
    const d = dataOf(j);
    const first = Array.isArray(d.to) ? (d.to as Array<{ status?: string }>)[0] : undefined;
    return { id: String(d.id ?? ""), provider: this.id, channel: "whatsapp", status: first?.status ?? "queued", raw: j };
  }

  /* --------------------------------------------------------------- lookup */

  async lookup(number: string, fields: LookupField[]): Promise<LookupResult> {
    const n = requireE164(number, "number");
    const key = apiKey("lookup");
    const types: string[] = [];
    // Portability data comes with the carrier lookup (verify).
    if (fields.some((f) => f === "carrier" || f === "line_type" || f === "portability")) types.push("carrier");
    if (fields.includes("caller_name")) types.push("caller-name");
    const qs = types.map((t) => `type=${t}`).join("&");
    const j = await request(key, "GET", `/number_lookup/${encodeURIComponent(n)}${qs ? `?${qs}` : ""}`);
    const d = dataOf(j);
    const carrier = d.carrier as { name?: string; type?: string; mobile_country_code?: string; mobile_network_code?: string } | null | undefined;
    const cname = d.caller_name as { caller_name?: string } | null | undefined;
    const port = d.portability as { ported_status?: string; city?: string; state?: string } | null | undefined;
    const type = carrier?.type ? (LINE_TYPES[carrier.type] ?? carrier.type.toLowerCase()) : undefined;
    const result: LookupResult = {
      number: str(d.phone_number) ?? n,
      provider: this.id,
      national: str(d.national_format),
      country: d.country_code ? { code: String(d.country_code) } : undefined,
      raw: j,
    };
    if (carrier) {
      result.type = type;
      result.carrier = { name: str(carrier.name), mcc: str(carrier.mobile_country_code), mnc: str(carrier.mobile_network_code), type };
    }
    if (cname) result.callerName = str(cname.caller_name);
    if (port) {
      result.ported = port.ported_status === "Y" ? true : port.ported_status === "N" ? false : null;
      if (port.city || port.state) result.region = { city: str(port.city), state: str(port.state) };
    }
    return result;
  }

  /* -------------------------------------------------------------- numbers */

  async searchNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    const key = apiKey("numbers");
    const country = String(q.country ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw badRequest(`country must be an ISO 3166 alpha-2 code like CZ (got "${cut(country)}").`);
    const qs = new URLSearchParams();
    qs.append("filter[country_code]", country);
    if (q.type) qs.append("filter[phone_number_type]", q.type === "tollfree" ? "toll_free" : q.type);
    if (q.voice) qs.append("filter[features][]", "voice");
    if (q.sms) qs.append("filter[features][]", "sms");
    if (q.contains) qs.append("filter[phone_number][contains]", q.contains);
    qs.append("filter[limit]", String(Math.min(100, Math.max(1, q.limit ?? 10))));
    const j = await request(key, "GET", `/available_phone_numbers?${qs.toString()}`);
    const list = (j.data ?? []) as Array<Record<string, unknown>>;
    return list.map((n) => {
      const regions = (n.region_information ?? []) as Array<{ region_type?: string; region_name?: string }>;
      const region = (t: string) => regions.find((r) => r.region_type === t)?.region_name;
      const cost = n.cost_information as { monthly_cost?: string; upfront_cost?: string; currency?: string } | undefined;
      return {
        number: String(n.phone_number ?? ""),
        country: region("country_code") ?? country,
        region: region("state"),
        locality: region("location") ?? region("rate_center"),
        capabilities: ((n.features ?? []) as Array<{ name?: string }>).map((f) => String(f.name ?? "")).filter(Boolean),
        cost: cost?.monthly_cost ? `${cost.monthly_cost}${cost.currency ? ` ${cost.currency}` : ""}/month` : undefined,
        raw: n,
      };
    });
  }

  /**
   * Order a number. The order completes asynchronously (number_order.complete),
   * so the returned id is the E.164 number, which assign/release accept. With
   * TELNYX_CONNECTION_ID the number is attached to the Call Control application;
   * voiceUrl is not a per-number setting on Telnyx (the application's webhook is).
   */
  async buyNumber(number: string): Promise<OwnedNumber> {
    const n = requireE164(number, "number");
    const key = apiKey("numbers");
    const body: Record<string, unknown> = { phone_numbers: [{ phone_number: n }] };
    if (env(CONNECTION)) body.connection_id = env(CONNECTION);
    if (env(PROFILE)) body.messaging_profile_id = env(PROFILE);
    const j = await request(key, "POST", "/number_orders", body);
    return { id: n, number: n, provider: this.id, raw: j };
  }

  /** A phone-number id as is; an E.164 number is looked up among the account's numbers. */
  private async numberId(key: string, idOrNumber: string): Promise<string> {
    const v = String(idOrNumber ?? "").trim();
    if (!v.startsWith("+")) {
      if (!/^\d+$/.test(v)) throw badRequest(`"${cut(v)}" is neither a Telnyx phone-number id nor an E.164 number.`);
      return v;
    }
    const n = requireE164(v, "idOrNumber");
    const j = await request(key, "GET", `/phone_numbers?${new URLSearchParams({ "filter[phone_number]": n.slice(1) }).toString()}`);
    const hit = ((j.data ?? []) as Array<{ id?: string | number; phone_number?: string }>).find((x) => x.phone_number === n)
      ?? ((j.data ?? []) as Array<{ id?: string | number }>)[0];
    if (!hit?.id) throw new ProviderError("telnyx", 404, cut(`Telnyx: ${n} is not a number on this account.`));
    return String(hit.id);
  }

  /** Point the number at the Call Control application (its webhook receives the calls). */
  async assignNumber(idOrNumber: string): Promise<void> {
    const key = apiKey("numbers");
    const connection = connectionId("numbers");
    const id = await this.numberId(key, idOrNumber);
    await request(key, "PATCH", `/phone_numbers/${encodeURIComponent(id)}`, { connection_id: connection });
  }

  async releaseNumber(idOrNumber: string): Promise<void> {
    const key = apiKey("numbers");
    const id = await this.numberId(key, idOrNumber);
    await request(key, "DELETE", `/phone_numbers/${encodeURIComponent(id)}`);
  }
}
