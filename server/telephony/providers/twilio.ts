// Twilio adapter for m5.telephony: REST 2010-04-01 (calls, messages, numbers),
// Lookup v2 and TwiML. Basic auth AccountSid:AuthToken, form bodies.
//
// Docs: twilio.com/docs/voice/api/call-resource, …/voice/twiml, …/messaging/api/message-resource,
// …/lookup/v2-api, …/phone-numbers/api. Gotchas that shape this file:
//   - StatusCallbackEvent is a REPEATED form field (one per event); a single
//     space-separated value only works in TwiML attributes.
//   - <Gather numDigits="5"> submits right after 5 digits, so "5 digits then #"
//     omits numDigits and the length is checked on our side.
//   - <Stream url> must be wss:// without a query string; data goes in <Parameter>.
//   - Inline Twiml is capped at 4000 characters.
//   - Test credentials never fire status callbacks.

import { isE164 } from "../types";
import { degrade, isSipAddress, sipTarget } from "./sip-uri";
import {
  ProviderError, ProviderNotConfigured,
  type AvailableNumber, type CallAction, type CallStatus, type Capability, type ChatChannel, type ChatMessageInput, type ChatMessageResult,
  type LookupField, type LookupResult, type MediaFormat, type NormalizedCallEvent, type NumberSearch, type OwnedNumber,
  type PlaceCallInput, type PlaceCallResult, type ProviderAdapter, type ProviderStatus, type RenderedLogic,
  type SmsInput, type SmsResult,
} from "./types";

const API = "https://api.twilio.com/2010-04-01";
const LOOKUP_API = "https://lookups.twilio.com/v2/PhoneNumbers";
const TIMEOUT_MS = 15_000;
const TWIML_MAX = 4000;

const SID = "TWILIO_ACCOUNT_SID";
const TOKEN = "TWILIO_AUTH_TOKEN";
const FROM = "TWILIO_FROM";
const MSG_SERVICE = "TWILIO_MESSAGING_SERVICE_SID";
const WA_FROM = "TWILIO_WHATSAPP_FROM";
const MESSENGER_PAGE = "TWILIO_MESSENGER_PAGE_ID";

const env = (name: string): string => process.env[name]?.trim() || "";
const cut = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

/* ----------------------------------------------------------------- status */

const CAPABILITIES: Capability[] = ["call", "sms", "lookup", "whatsapp", "messenger", "numbers", "media"];
/** What must be set for a capability to count as configured. */
const REQUIRED: Record<string, string[]> = {
  call: [SID, TOKEN], sms: [SID, TOKEN], lookup: [SID, TOKEN], numbers: [SID, TOKEN], media: [SID, TOKEN],
  whatsapp: [SID, TOKEN, WA_FROM], messenger: [SID, TOKEN, MESSENGER_PAGE],
};
/** Every variable a capability reads (FROM-style ones can be passed per request instead). */
const NEEDS: Partial<Record<Capability, string[]>> = {
  call: [SID, TOKEN, FROM], sms: [SID, TOKEN, FROM, MSG_SERVICE], lookup: [SID, TOKEN],
  whatsapp: [SID, TOKEN, WA_FROM], messenger: [SID, TOKEN, MESSENGER_PAGE], numbers: [SID, TOKEN], media: [SID, TOKEN],
};

/** configured = the capabilities whose REQUIRED variables are all set; reason groups what is missing. */
function statusOf(id: "twilio", label: string, caps: Capability[], required: Record<string, string[]>, needs: ProviderStatus["needs"]): ProviderStatus {
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

type Creds = { sid: string; auth: string };

function creds(capability: Capability): Creds {
  const sid = env(SID);
  const token = env(TOKEN);
  if (!sid || !token) {
    throw new ProviderNotConfigured("twilio", capability, `Twilio ${capability} is not configured: set ${SID} and ${TOKEN}.`);
  }
  return { sid, auth: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` };
}

function badRequest(message: string): ProviderError {
  return new ProviderError("twilio", 400, cut(`Twilio: ${message}`));
}

function requireE164(n: string, what = "to"): string {
  const v = String(n ?? "").trim();
  if (!isE164(v)) throw badRequest(`"${what}" must be an E.164 number like +420123456789 (got "${cut(v)}").`);
  return v;
}

/* ------------------------------------------------------------------- HTTP */

async function request(c: Creds, method: "GET" | "POST" | "DELETE", url: string, form?: URLSearchParams): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: form
        ? { Authorization: c.auth, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }
        : { Authorization: c.auth, Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new ProviderError("twilio", 504, `Twilio: no answer within ${TIMEOUT_MS / 1000} s.`);
    throw new ProviderError("twilio", 502, cut(`Twilio: request failed: ${e?.message || String(err)}`));
  }
  const text = await res.text();
  if (!res.ok) {
    // Twilio errors: {"code":21211,"message":"The 'To' number … is not a valid phone number.","more_info":…,"status":400}
    let message = text || res.statusText;
    let code: string | undefined;
    try {
      const j = JSON.parse(text) as { code?: number | string; message?: string };
      if (j.message) message = j.message;
      if (j.code !== undefined && j.code !== null) code = String(j.code);
    } catch { /* not JSON */ }
    throw new ProviderError("twilio", res.status, cut(`Twilio ${res.status}: ${message}`), code);
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError("twilio", 502, cut(`Twilio ${res.status}: the answer is not JSON: ${text}`));
  }
}

const accountUrl = (c: Creds, path: string) => `${API}/Accounts/${encodeURIComponent(c.sid)}${path}`;

/* ------------------------------------------------------------------ TwiML */

export function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function attrs(pairs: Array<[string, string | number | boolean | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join("");
}

/** Neutral / other-provider voice names → Twilio's: female/male → woman/man, AWS.Polly.X → Polly.X. */
export function twilioVoice(voice?: string): string | undefined {
  if (!voice) return undefined;
  if (voice === "female") return "woman";
  if (voice === "male") return "man";
  if (voice.startsWith("AWS.Polly.")) return voice.slice(4);
  return voice;
}

/** A stream URL may not carry a query string: its parameters move into <Parameter> (explicit params win). */
export function splitStreamUrl(url: string, params?: Record<string, string>): { url: string; params: Record<string, string> } {
  const q = url.indexOf("?");
  if (q < 0) return { url, params: { ...(params ?? {}) } };
  const hash = url.indexOf("#", q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  return { url: url.slice(0, q), params: { ...Object.fromEntries(new URLSearchParams(query)), ...(params ?? {}) } };
}

function sayVerb(text: string, voice?: string, language?: string, loop?: number): string {
  return `<Say${attrs([["voice", twilioVoice(voice)], ["language", language], ["loop", loop]])}>${xmlEscape(text)}</Say>`;
}

/** Twilio's DialCallStatus → the neutral dial outcome ("completed" = it was answered and has ended). */
export const TWILIO_DIAL_STATUS: Record<string, NonNullable<NormalizedCallEvent["dialStatus"]>> = {
  completed: "answered", answered: "answered", busy: "busy", "no-answer": "no-answer", failed: "failed", canceled: "canceled",
};

/**
 * 6.9 <Dial>: a <Number>, or a <Sip> URI — a SIP address, or a number over the
 * operator's trunk (sip:+420…@host, the trunk's digest credentials as the
 * <Sip> username / password). callerId must be a number Twilio lets you
 * present (owned, verified, or the call's own To / From); towards SIP any
 * alphanumeric string, so "restricted" sends "anonymous" there. Twilio has no
 * caller name and no withheld number towards the PSTN (logged, not sent).
 */
function dialVerb(d: Extract<CallAction, { dial: unknown }>["dial"]): string {
  const viaSip = d.kind === "sip" || !!d.trunk;
  let callerId = d.callerId || undefined;
  if (d.presentation === "restricted") {
    if (viaSip) callerId = "anonymous";
    else degrade("twilio", "a withheld caller ID towards the phone network (<Dial> to a <Number>); the number is presented");
  }
  if (d.callerName) degrade("twilio", "a caller ID name on <Dial>; only the number is presented");
  const open = `<Dial${attrs([
    ["action", d.action], ["method", "POST"],
    ["timeout", d.timeout ? Math.min(600, Math.max(5, Math.round(d.timeout))) : undefined],
    ["callerId", callerId], ["record", d.record ? "record-from-answer" : undefined],
  ])}>`;
  if (!viaSip) return `${open}<Number>${xmlEscape(d.to)}</Number></Dial>`;
  const uri = sipTarget(d.to, d.kind, d.trunk);
  return `${open}<Sip${attrs([["username", d.trunk?.username || undefined], ["password", d.trunk?.password || undefined]])}>${xmlEscape(uri)}</Sip></Dial>`;
}

function verb(a: CallAction): string {
  if ("say" in a) return sayVerb(a.say.text, a.say.voice, a.say.language, a.say.loop);
  if ("play" in a) return `<Play${attrs([["loop", a.play.loop]])}>${xmlEscape(a.play.url)}</Play>`;
  if ("pause" in a) return `<Pause${attrs([["length", Math.max(1, Math.round(a.pause.seconds))]])}/>`;
  if ("gather" in a) {
    const g = a.gather;
    // numDigits submits as soon as that many digits arrive, so with a finish key
    // ("#" is Twilio's default when finishOnKey is not given) the length is
    // checked on our side; numDigits only when the finish key is disabled ("").
    const numDigits = g.digits && g.finishOnKey === "" ? g.digits : undefined;
    // 6.9: speech — Twilio's own recognition; the result comes to `action` as SpeechResult + Confidence.
    const input = g.input?.length ? [...new Set(g.input)].sort().join(" ") : "dtmf";
    const speech = input.includes("speech");
    const open = `<Gather${attrs([
      ["input", input], ["action", g.action], ["method", "POST"],
      ["timeout", g.timeout], ["finishOnKey", g.finishOnKey], ["numDigits", numDigits],
      ["speechTimeout", speech ? (g.speechTimeout ? Math.max(1, Math.round(g.speechTimeout)) : "auto") : undefined],
      ["language", speech ? g.language : undefined],
      ["hints", speech && g.hints?.length ? g.hints.map((h) => h.replace(/,/g, " ").trim()).filter(Boolean).slice(0, 500).join(",") : undefined],
    ])}>`;
    const prompt = g.prompt ? sayVerb(g.prompt, g.voice, g.language) : "";
    return `${open}${prompt}</Gather>`;
  }
  if ("dial" in a) return dialVerb(a.dial);
  // <Reject> refuses an unanswered call without billing it — only as the first verb
  // (later, Twilio has answered and it ends the call). Twilio knows busy and rejected;
  // congestion is played as busy.
  if ("reject" in a) {
    if (a.reject.reason === "congestion") degrade("twilio", "a congestion state (<Reject> knows busy and rejected); busy is played");
    return `<Reject${attrs([["reason", a.reject.reason === "rejected" ? "rejected" : "busy"]])}/>`;
  }
  // Dial-pad tones into the call: <Play digits> ("w" = 0.5 s, "W" = 1 s). Twilio sends them RFC 2833.
  if ("sendDigits" in a) {
    if (a.sendDigits.mode && a.sendDigits.mode !== "rfc2833") degrade("twilio", `DTMF as ${a.sendDigits.mode}; sent as RFC 2833 (<Play digits>)`);
    return `<Play${attrs([["digits", a.sendDigits.digits.replace(/[^0-9A-D*#wW]/g, "")]])}/>`;
  }
  if ("stream" in a) {
    const { url, params } = splitStreamUrl(a.stream.url, a.stream.params);
    const children = Object.entries(params).map(([name, value]) => `<Parameter${attrs([["name", name], ["value", value]])}/>`).join("");
    // Twilio streams µ-law 8 kHz only; codec / rate are ignored here.
    return `<Connect><Stream${attrs([["url", url]])}>${children}</Stream></Connect>`;
  }
  if ("record" in a) {
    const r = a.record;
    // 6.9: finishOnKey "any" = every key; "" cannot be expressed (Twilio's default ends on any key).
    if (r.finishOnKey === "") degrade("twilio", "a recording no key can end (<Record> always ends on a key); any key ends it");
    const finish = r.finishOnKey === "any" ? "1234567890*#" : r.finishOnKey ? r.finishOnKey.replace(/[^0-9*#]/g, "") || undefined : undefined;
    return `<Record${attrs([
      ["action", r.action], ["method", "POST"], ["maxLength", r.maxSeconds], ["playBeep", r.beep],
      // timeout = seconds of silence that end it; 0 turns that off
      ["timeout", r.silenceSeconds !== undefined ? Math.max(0, Math.round(r.silenceSeconds)) : undefined],
      ["finishOnKey", finish],
      ["trim", r.trim === undefined ? undefined : r.trim ? "trim-silence" : "do-not-trim"],
      ["transcribe", r.transcribe || undefined],
    ])}/>`;
  }
  if ("redirect" in a) return `<Redirect method="POST">${xmlEscape(a.redirect.url)}</Redirect>`;
  if ("hangup" in a) return "<Hangup/>";
  throw badRequest(`unknown call action ${cut(JSON.stringify(a))}.`);
}

/** The actions as a TwiML document; `declaration` adds the XML prolog (webhook answers). */
export function renderTwiml(actions: CallAction[], declaration = true): string {
  const body = `<Response>${actions.map(verb).join("")}</Response>`;
  return declaration ? `<?xml version="1.0" encoding="UTF-8"?>${body}` : body;
}

/* ---------------------------------------------------------------- mapping */

const CALL_STATUS: Record<string, CallStatus> = {
  queued: "queued", initiated: "initiated", ringing: "ringing", "in-progress": "answered",
  completed: "completed", busy: "busy", "no-answer": "no-answer", failed: "failed", canceled: "canceled",
};

const LINE_TYPES: Record<string, string> = {
  landline: "landline", mobile: "mobile", fixedVoip: "voip", nonFixedVoip: "voip", personal: "personal",
  tollFree: "toll-free", premium: "premium", sharedCost: "shared-cost", uan: "uan", voicemail: "voicemail",
  pager: "pager", unknown: "unknown",
};

const LOOKUP_FIELDS: Partial<Record<LookupField, string>> = {
  carrier: "line_type_intelligence", line_type: "line_type_intelligence", caller_name: "caller_name",
  sim_swap: "sim_swap", line_status: "line_status", validation: "validation",
  // portability: Lookup v2 has no ported flag
};

function formFields(body: unknown): Record<string, string> {
  if (typeof body === "string") return Object.fromEntries(new URLSearchParams(body));
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  if (body && typeof body === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v !== undefined && v !== null) out[k] = Array.isArray(v) ? String(v[v.length - 1]) : String(v);
    }
    return out;
  }
  return {};
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));

/* ---------------------------------------------------------------- adapter */

export class TwilioAdapter implements ProviderAdapter {
  readonly id = "twilio" as const;
  readonly label = "Twilio";
  readonly channels: ChatChannel[] = ["whatsapp", "messenger"];
  readonly media: MediaFormat = { transport: "json-mulaw", codec: "PCMU", rate: 8000 };

  status(): ProviderStatus {
    return statusOf(this.id, this.label, CAPABILITIES, REQUIRED, NEEDS);
  }

  /* ---------------------------------------------------------------- calls */

  renderActions(actions: CallAction[]): RenderedLogic {
    return { contentType: "text/xml", body: renderTwiml(actions) };
  }

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    const to = requireE164(input.to);
    const c = creds("call");
    const from = input.from || env(FROM);
    if (!from) throw new ProviderNotConfigured("twilio", "call", `Twilio call has no caller id: set ${FROM} or pass from.`);
    if (!input.eventUrl) throw badRequest("eventUrl is required.");

    const form = new URLSearchParams();
    // 6.9: over the operator's SIP trunk — To is sip:<number>@<trunk host>, the trunk's
    // digest credentials go as SipAuthUsername / SipAuthPassword, and From (towards SIP
    // the user part of P-Asserted-Identity) may be any string: "anonymous" withholds it.
    const via = input.via?.kind === "sip" ? input.via : null;
    if (via) {
      form.append("To", sipTarget(to, "number", via.trunk));
      form.append("From", via.presentation === "restricted" ? "anonymous" : from);
      if (via.trunk.username) form.append("SipAuthUsername", via.trunk.username);
      if (via.trunk.password) form.append("SipAuthPassword", via.trunk.password);
      if (via.callerName) degrade("twilio", "a caller ID name on an outbound call; only the number is presented");
    } else {
      form.append("To", to);
      form.append("From", from);
    }
    form.append("Timeout", String(Math.min(600, Math.max(1, Math.round(input.timeout)))));
    if (input.timeLimit) form.append("TimeLimit", String(Math.max(1, Math.round(input.timeLimit))));
    // One source of logic only: Twilio ignores Twiml when Url is given. The
    // provider-native raw.twiml wins, then inline actions, then the answer URL.
    const twiml = input.raw?.twiml ?? (input.actions?.length ? renderTwiml(input.actions, false) : undefined);
    if (twiml !== undefined) {
      if (twiml.length > TWIML_MAX) throw badRequest(`inline TwiML is ${twiml.length} characters, over Twilio's ${TWIML_MAX}; use answerUrl.`);
      form.append("Twiml", twiml);
    } else if (input.answerUrl) {
      form.append("Url", input.answerUrl);
      form.append("Method", "POST");
    } else {
      throw badRequest("placeCall needs answerUrl, actions or raw.twiml.");
    }
    form.append("StatusCallback", input.eventUrl);
    form.append("StatusCallbackMethod", "POST");
    for (const ev of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", ev);
    if (input.machineDetection) form.append("MachineDetection", "Enable");
    // clientState: Twilio has no echo field; the engine keeps it in eventUrl's query.

    const json = await request(c, "POST", accountUrl(c, "/Calls.json"), form);
    return { id: String(json.sid ?? ""), provider: this.id, status: CALL_STATUS[String(json.status)] ?? "queued", raw: json };
  }

  async executeActions(callId: string, actions: CallAction[]): Promise<void> {
    const c = creds("call");
    const twiml = renderTwiml(actions, false);
    if (twiml.length > TWIML_MAX) throw badRequest(`inline TwiML is ${twiml.length} characters, over Twilio's ${TWIML_MAX}.`);
    await request(c, "POST", accountUrl(c, `/Calls/${encodeURIComponent(callId)}.json`), new URLSearchParams({ Twiml: twiml }));
  }

  async hangup(callId: string): Promise<void> {
    const c = creds("call");
    // "completed" ends a live call; Twilio turns it into "canceled" while still queued / ringing.
    await request(c, "POST", accountUrl(c, `/Calls/${encodeURIComponent(callId)}.json`), new URLSearchParams({ Status: "completed" }));
  }

  /**
   * A Twilio voice webhook (form fields, or the query for GET) → one event:
   *   - Digits present → "gather" (the <Gather action> POST)
   *   - AnsweredBy machine_* / fax → "machine" (status "machine")
   *   - CallbackSource (call-progress-events) → "status" (StatusCallback)
   *   - RecordingUrl → "other" (the <Record action> POST)
   *   - otherwise → "answer": Twilio fetches call logic (VoiceUrl / Url)
   */
  parseCallEvent(body: unknown, query: Record<string, string>): NormalizedCallEvent[] {
    const f = { ...formFields(query), ...formFields(body) };
    const callId = f.CallSid;
    if (!callId) return [];
    const answeredBy = f.AnsweredBy || "";
    const isMachine = answeredBy.startsWith("machine") || answeredBy === "fax";
    // 6.9: a <Dial action> (DialCallStatus), a <Record action> (RecordingUrl — its
    // Digits is the key that ended it, or "hangup"), a speech <Gather> (SpeechResult).
    let kind: NormalizedCallEvent["kind"];
    if (f.DialCallStatus) kind = "dial";
    else if (f.RecordingUrl) kind = "recording";
    else if ("SpeechResult" in f) kind = "speech";
    else if ("Digits" in f) kind = "gather";
    else if (isMachine) kind = "machine";
    else if (f.CallbackSource) kind = "status";
    else kind = "answer";
    const direction = f.Direction ? (f.Direction === "inbound" ? "inbound" : "outbound") : undefined;
    const num = (v: string | undefined) => { const n = v !== undefined && v !== "" ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
    const recordingKey = kind === "recording" && f.Digits && f.Digits !== "hangup" ? f.Digits : undefined;
    const ev: NormalizedCallEvent = {
      provider: this.id,
      callId,
      status: isMachine ? "machine" : (CALL_STATUS[f.CallStatus] ?? null),
      kind,
      from: str(f.From),
      to: str(f.To),
      direction,
      digits: kind === "recording" ? recordingKey : "Digits" in f && kind === "gather" ? f.Digits : undefined,
      durationSec: kind === "dial" ? num(f.DialCallDuration) : num(f.CallDuration),
      sipCode: str(f.DialSipResponseCode) ?? str(f.SipResponseCode),
      cause: str(answeredBy) ?? str(f.ErrorCode) ?? (kind === "recording" && f.Digits === "hangup" ? "hangup" : undefined),
      eventId: f.SequenceNumber !== undefined ? `${callId}:${f.SequenceNumber}` : undefined,
      raw: f,
    };
    if (kind === "dial") ev.dialStatus = TWILIO_DIAL_STATUS[f.DialCallStatus] ?? "failed";
    if (kind === "speech") {
      ev.speech = f.SpeechResult;
      const c = num(f.Confidence);
      if (c !== undefined) ev.confidence = c;
    }
    if (f.RecordingUrl) { ev.recordingUrl = f.RecordingUrl; ev.recordingSec = num(f.RecordingDuration); }
    // A call to a SIP Domain: To (and often From) are SIP URIs; SipDomain names the domain.
    if (isSipAddress(f.To)) ev.sipUri = f.To;
    else if (f.SipDomain && isSipAddress(f.Called)) ev.sipUri = f.Called;
    return [ev];
  }

  /* ------------------------------------------------------------ messaging */

  async sendSms(input: SmsInput): Promise<SmsResult> {
    const to = requireE164(input.to);
    const c = creds("sms");
    const o = input.options ?? {};
    const form = new URLSearchParams();
    form.append("To", to);
    // Sender: an explicit Messaging Service, an explicit from, the configured
    // Messaging Service, then TWILIO_FROM.
    const service = o.messagingServiceSid || (!input.from ? env(MSG_SERVICE) : "");
    const from = input.from || env(FROM);
    if (service) form.append("MessagingServiceSid", service);
    else if (from) form.append("From", from);
    else throw new ProviderNotConfigured("twilio", "sms", `Twilio SMS has no sender: set ${FROM} or ${MSG_SERVICE}, or pass from.`);
    form.append("Body", input.text);
    // UCS-2 is chosen by Twilio automatically for non-GSM text; `unicode` needs no field.
    if (o.statusUrl) form.append("StatusCallback", o.statusUrl);
    if (o.ttl) form.append("ValidityPeriod", String(Math.min(36000, Math.max(1, Math.round(o.ttl)))));
    if (o.sendAt) {
      if (!service) throw badRequest("sendAt needs a Messaging Service (options.messagingServiceSid or TWILIO_MESSAGING_SERVICE_SID).");
      form.append("SendAt", o.sendAt);
      form.append("ScheduleType", "fixed");
    }
    // clientRef: Twilio has no client reference field on messages.
    const json = await request(c, "POST", accountUrl(c, "/Messages.json"), form);
    const parts = json.num_segments !== undefined && json.num_segments !== null ? Number(json.num_segments) : undefined;
    return {
      id: String(json.sid ?? ""), provider: this.id, status: String(json.status ?? "queued"),
      parts: parts !== undefined && Number.isFinite(parts) ? parts : undefined,
      price: str(json.price) ? `${json.price}${json.price_unit ? ` ${json.price_unit}` : ""}` : undefined,
      raw: json,
    };
  }

  async sendChat(input: ChatMessageInput): Promise<ChatMessageResult> {
    if (input.channel !== "whatsapp" && input.channel !== "messenger") {
      throw badRequest(`the ${input.channel} channel is not supported by Twilio.`);
    }
    const capability: Capability = input.channel;
    const form = new URLSearchParams();
    if (input.channel === "whatsapp") {
      const to = requireE164(input.to);
      const c0 = creds(capability);
      const from = input.from || env(WA_FROM);
      if (!from) throw new ProviderNotConfigured("twilio", capability, `Twilio WhatsApp has no sender: set ${WA_FROM} or pass from.`);
      form.append("From", `whatsapp:${from.replace(/^whatsapp:/, "")}`);
      form.append("To", `whatsapp:${to}`);
      this.chatContent(form, input);
      return this.postChat(c0, form, input);
    }
    // Messenger (Twilio Public Beta): From=messenger:<PageId>, To=messenger:<PSID>.
    const psid = String(input.to ?? "").trim();
    if (!psid) throw badRequest(`"to" must be the recipient's page-scoped id (PSID).`);
    const c1 = creds(capability);
    const page = input.from || env(MESSENGER_PAGE);
    if (!page) throw new ProviderNotConfigured("twilio", capability, `Twilio Messenger has no page: set ${MESSENGER_PAGE} or pass from.`);
    form.append("From", `messenger:${page.replace(/^messenger:/, "")}`);
    form.append("To", `messenger:${psid.replace(/^messenger:/, "")}`);
    this.chatContent(form, input);
    return this.postChat(c1, form, input);
  }

  private chatContent(form: URLSearchParams, input: ChatMessageInput): void {
    // WhatsApp templates are Content Templates (ContentSid HX…) with numbered variables.
    if (input.template && input.template.name.startsWith("HX")) {
      form.append("ContentSid", input.template.name);
      if (input.template.params?.length) {
        form.append("ContentVariables", JSON.stringify(Object.fromEntries(input.template.params.map((p, i) => [String(i + 1), p]))));
      }
    } else if (input.text) {
      form.append("Body", input.text);
    } else if (!input.media) {
      throw badRequest(input.template ? "a Twilio template is a Content SID (HX…); pass it as template.name, or send text." : "text, media or template is required.");
    }
    if (input.media) form.append("MediaUrl", input.media.url);
    if (input.statusUrl) form.append("StatusCallback", input.statusUrl);
  }

  private async postChat(c: Creds, form: URLSearchParams, input: ChatMessageInput): Promise<ChatMessageResult> {
    const json = await request(c, "POST", accountUrl(c, "/Messages.json"), form);
    return { id: String(json.sid ?? ""), provider: this.id, channel: input.channel, status: String(json.status ?? "queued"), raw: json };
  }

  /* --------------------------------------------------------------- lookup */

  async lookup(number: string, fields: LookupField[]): Promise<LookupResult> {
    const n = requireE164(number, "number");
    const c = creds("lookup");
    const wanted = [...new Set(fields.map((f) => LOOKUP_FIELDS[f]).filter((f): f is string => !!f))];
    const url = `${LOOKUP_API}/${encodeURIComponent(n)}${wanted.length ? `?Fields=${wanted.join(",")}` : ""}`;
    const j = await request(c, "GET", url);
    const lti = j.line_type_intelligence as { carrier_name?: string; type?: string; mobile_country_code?: string; mobile_network_code?: string } | null | undefined;
    const cn = j.caller_name as { caller_name?: string; caller_type?: string } | null | undefined;
    const ls = j.line_status as { status?: string } | null | undefined;
    const ss = j.sim_swap as { last_sim_swap?: { last_sim_swapped_date?: string; swapped_period?: string } } | null | undefined;
    const type = lti?.type ? (LINE_TYPES[lti.type] ?? lti.type.toLowerCase()) : undefined;
    const result: LookupResult = {
      number: str(j.phone_number) ?? n,
      provider: this.id,
      valid: typeof j.valid === "boolean" ? j.valid : null,
      national: str(j.national_format),
      country: j.country_code ? {
        code: String(j.country_code),
        prefix: j.calling_country_code ? `+${String(j.calling_country_code)}` : undefined,
      } : undefined,
      raw: j,
    };
    if (lti) {
      result.type = type;
      result.carrier = { name: str(lti.carrier_name), mcc: str(lti.mobile_country_code), mnc: str(lti.mobile_network_code), type };
    }
    if (cn) { result.callerName = str(cn.caller_name); result.callerType = str(cn.caller_type)?.toLowerCase(); }
    if (ls) result.reachable = str(ls.status);
    if (ss) result.simSwap = ss.last_sim_swap ? { at: str(ss.last_sim_swap.last_sim_swapped_date), period: str(ss.last_sim_swap.swapped_period) } : null;
    return result;
  }

  /* -------------------------------------------------------------- numbers */

  async searchNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    const c = creds("numbers");
    const country = String(q.country ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw badRequest(`country must be an ISO 3166 alpha-2 code like CZ (got "${cut(country)}").`);
    const kind = q.type === "mobile" ? "Mobile" : q.type === "tollfree" ? "TollFree" : "Local";
    const qs = new URLSearchParams();
    if (q.voice) qs.append("VoiceEnabled", "true");
    if (q.sms) qs.append("SmsEnabled", "true");
    if (q.contains) qs.append("Contains", q.contains);
    qs.append("PageSize", String(Math.min(50, Math.max(1, q.limit ?? 10))));
    const j = await request(c, "GET", accountUrl(c, `/AvailablePhoneNumbers/${country}/${kind}.json?${qs.toString()}`));
    const list = (j.available_phone_numbers ?? []) as Array<Record<string, unknown>>;
    return list.map((n) => ({
      number: String(n.phone_number ?? ""),
      country: String(n.iso_country ?? country),
      region: str(n.region),
      locality: str(n.locality),
      capabilities: Object.entries((n.capabilities ?? {}) as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k.toLowerCase()),
      raw: n,
    }));
  }

  async buyNumber(number: string, opts: { country: string; voiceUrl?: string }): Promise<OwnedNumber> {
    const n = requireE164(number, "number");
    const c = creds("numbers");
    const form = new URLSearchParams({ PhoneNumber: n });
    if (opts?.voiceUrl) { form.append("VoiceUrl", opts.voiceUrl); form.append("VoiceMethod", "POST"); }
    const j = await request(c, "POST", accountUrl(c, "/IncomingPhoneNumbers.json"), form);
    return { id: String(j.sid ?? ""), number: String(j.phone_number ?? n), provider: this.id, raw: j };
  }

  /** PN… sid as is; an E.164 number is looked up among the account's incoming numbers. */
  private async numberSid(c: Creds, idOrNumber: string): Promise<string> {
    const v = String(idOrNumber ?? "").trim();
    if (/^PN[0-9a-f]{32}$/i.test(v)) return v;
    const n = requireE164(v, "idOrNumber");
    const j = await request(c, "GET", accountUrl(c, `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(n)}`));
    const sid = ((j.incoming_phone_numbers ?? []) as Array<{ sid?: string }>)[0]?.sid;
    if (!sid) throw new ProviderError("twilio", 404, cut(`Twilio: ${n} is not a number on this account.`));
    return sid;
  }

  async assignNumber(idOrNumber: string, opts: { voiceUrl?: string; country?: string }): Promise<void> {
    if (!opts?.voiceUrl) throw badRequest("assignNumber needs voiceUrl.");
    const c = creds("numbers");
    const sid = await this.numberSid(c, idOrNumber);
    await request(c, "POST", accountUrl(c, `/IncomingPhoneNumbers/${sid}.json`), new URLSearchParams({ VoiceUrl: opts.voiceUrl, VoiceMethod: "POST" }));
  }

  async releaseNumber(idOrNumber: string): Promise<void> {
    const c = creds("numbers");
    const sid = await this.numberSid(c, idOrNumber);
    await request(c, "DELETE", accountUrl(c, `/IncomingPhoneNumbers/${sid}.json`));
  }
}
