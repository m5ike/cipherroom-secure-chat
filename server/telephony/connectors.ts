// Real REST connectors for SMS + voice. Keys live in the environment, are never
// returned, and a connector without its key reports not-configured and refuses
// to run (never an open, billable proxy by default). Plain fetch — no SDK.
//
// Webhooks: when PUBLIC_BASE_URL is set (e.g. https://chat.example.org), every
// send/call also tells the provider to report back to this app at
// /wh/{provider}/{type} (see webhooks.ts), and installProviderWebhooks() pushes
// those URLs into the provider's own configuration so inbound SMS / calls and
// delivery receipts reach us too.

import { readFileSync } from "node:fs";
import { signJwtRS256 } from "./jwt";
import {
  TelephonyNotConfiguredError,
  type SmsConnector, type SmsInput, type SmsResult,
  type VoiceConnector, type VoiceInput, type VoiceResult,
  type ConnectorStatus, type TelephonyProvider, type WebhookSpec, type InstallResult,
} from "./types";

const env = (name: string): string => (process.env[name]?.trim() || "");

/* -------------------------------------------------------- public base URL */

/** Where providers can reach this app, e.g. https://chat.example.org (no trailing slash). */
export function publicBaseUrl(): string {
  return env("PUBLIC_BASE_URL").replace(/\/+$/, "");
}

/** Absolute webhook URL for a path, or "" when PUBLIC_BASE_URL is not set. */
export function webhookUrl(path: string): string {
  const base = publicBaseUrl();
  return base ? `${base}${path}` : "";
}

/** Spoken on a test call answered by our own webhook (Twilio TwiML / Vonage NCCO). */
export function greetingText(): string {
  return env("TELEPHONY_GREETING") || "Hello. This is a test call from M5cet.";
}

/* ------------------------------------------------------------------ Twilio */
// SMS:   POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
// Voice: POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Calls.json
// Basic auth SID:token, x-www-form-urlencoded body.

const TWILIO_API = "https://api.twilio.com/2010-04-01";
function twilioSid() { return env("TWILIO_ACCOUNT_SID"); }
function twilioToken() { return env("TWILIO_AUTH_TOKEN"); }
function twilioFrom() { return env("TWILIO_FROM"); }
function twilioAuthHeader() { return `Basic ${Buffer.from(`${twilioSid()}:${twilioToken()}`).toString("base64")}`; }
async function twilioForm(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(twilioSid())}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: twilioAuthHeader() },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json() as Record<string, unknown>;
}

export class TwilioSmsConnector implements SmsConnector {
  readonly id = "twilio";
  readonly kind = "sms" as const;
  readonly label = "Twilio SMS";
  readonly needs = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"];
  status(): ConnectorStatus {
    const ok = twilioSid().length > 0 && twilioToken().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, needs: this.needs, reason: ok ? undefined : "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." };
  }
  async sendSms(input: SmsInput): Promise<SmsResult> {
    if (!twilioSid() || !twilioToken()) throw new TelephonyNotConfiguredError(this.id, "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
    const from = input.from || twilioFrom();
    if (!from) throw new TelephonyNotConfiguredError(this.id, "Set TWILIO_FROM or pass from.");
    const params: Record<string, string> = { To: input.to, From: from, Body: input.text };
    const cb = webhookUrl("/wh/twilio/sms_status");
    if (cb) params.StatusCallback = cb;
    const json = await twilioForm("/Messages.json", params);
    return { id: String(json.sid || ""), provider: this.id };
  }
}

export class TwilioVoiceConnector implements VoiceConnector {
  readonly id = "twilio";
  readonly kind = "voice" as const;
  readonly label = "Twilio Voice";
  readonly needs = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_VOICE_URL"];
  /** TwiML source for an outbound call: TWILIO_VOICE_URL, else our own answer webhook, else Twilio's demo. */
  private voiceUrl() { return env("TWILIO_VOICE_URL") || webhookUrl("/wh/twilio/voice") || "http://demo.twilio.com/docs/voice.xml"; }
  status(): ConnectorStatus {
    const ok = twilioSid().length > 0 && twilioToken().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, needs: this.needs, reason: ok ? undefined : "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." };
  }
  async placeCall(input: VoiceInput): Promise<VoiceResult> {
    if (!twilioSid() || !twilioToken()) throw new TelephonyNotConfiguredError(this.id, "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
    const from = input.from || twilioFrom();
    if (!from) throw new TelephonyNotConfiguredError(this.id, "Set TWILIO_FROM or pass from.");
    const params: Record<string, string> = { To: input.to, From: from };
    if (input.twiml) params.Twiml = input.twiml;
    else params.Url = input.url || this.voiceUrl();
    const cb = webhookUrl("/wh/twilio/voice_status");
    if (cb) { params.StatusCallback = cb; params.StatusCallbackEvent = "initiated ringing answered completed"; }
    const json = await twilioForm("/Calls.json", params);
    return { id: String(json.sid || ""), provider: this.id };
  }
}

/* ------------------------------------------------------------------ Telnyx */
// SMS:   POST https://api.telnyx.com/v2/messages   (Bearer, JSON)
// Voice: POST https://api.telnyx.com/v2/calls      (Bearer, JSON)

const TELNYX_API = "https://api.telnyx.com/v2";
function telnyxKey() { return env("TELNYX_API_KEY"); }
function telnyxFrom() { return env("TELNYX_FROM"); }
function telnyxConnectionId() { return env("TELNYX_CONNECTION_ID"); }
function telnyxMessagingProfileId() { return env("TELNYX_MESSAGING_PROFILE_ID"); }
async function telnyxJson(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${TELNYX_API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${telnyxKey()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Telnyx ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json() as Record<string, unknown>;
}

export class TelnyxSmsConnector implements SmsConnector {
  readonly id = "telnyx";
  readonly kind = "sms" as const;
  readonly label = "Telnyx SMS";
  readonly needs = ["TELNYX_API_KEY", "TELNYX_FROM", "TELNYX_MESSAGING_PROFILE_ID"];
  status(): ConnectorStatus {
    const ok = telnyxKey().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, needs: this.needs, reason: ok ? undefined : "Set TELNYX_API_KEY." };
  }
  async sendSms(input: SmsInput): Promise<SmsResult> {
    if (!telnyxKey()) throw new TelephonyNotConfiguredError(this.id, "Set TELNYX_API_KEY.");
    const from = input.from || telnyxFrom();
    if (!from) throw new TelephonyNotConfiguredError(this.id, "Set TELNYX_FROM or pass from.");
    const body: Record<string, unknown> = { from, to: input.to, text: input.text };
    const cb = webhookUrl("/wh/telnyx/events");
    if (cb) body.webhook_url = cb;
    const json = await telnyxJson("POST", "/messages", body);
    return { id: String((json.data as { id?: string } | undefined)?.id || ""), provider: this.id };
  }
}

export class TelnyxVoiceConnector implements VoiceConnector {
  readonly id = "telnyx";
  readonly kind = "voice" as const;
  readonly label = "Telnyx Voice";
  readonly needs = ["TELNYX_API_KEY", "TELNYX_FROM", "TELNYX_CONNECTION_ID"];
  status(): ConnectorStatus {
    const ok = telnyxKey().length > 0 && telnyxConnectionId().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, needs: this.needs, reason: ok ? undefined : "Set TELNYX_API_KEY and TELNYX_CONNECTION_ID." };
  }
  async placeCall(input: VoiceInput): Promise<VoiceResult> {
    if (!telnyxKey() || !telnyxConnectionId()) throw new TelephonyNotConfiguredError(this.id, "Set TELNYX_API_KEY and TELNYX_CONNECTION_ID.");
    const from = input.from || telnyxFrom();
    if (!from) throw new TelephonyNotConfiguredError(this.id, "Set TELNYX_FROM or pass from.");
    const body: Record<string, unknown> = { connection_id: telnyxConnectionId(), to: input.to, from };
    const cb = webhookUrl("/wh/telnyx/events");
    if (cb) body.webhook_url = cb;
    const json = await telnyxJson("POST", "/calls", body);
    const data = (json.data ?? {}) as { call_control_id?: string; call_leg_id?: string };
    return { id: data.call_control_id || data.call_leg_id || "", provider: this.id };
  }
}

/* ------------------------------------------------------------------ Vonage */
// SMS:   POST https://rest.nexmo.com/sms/json  (api_key/api_secret in the body)
// Voice: POST https://api.nexmo.com/v1/calls   (Bearer JWT, RS256 over the
//        application private key — VONAGE_APPLICATION_ID + VONAGE_JWT_KEY)

const VONAGE_API = "https://api.nexmo.com";
function vonageKey() { return env("VONAGE_API_KEY"); }
function vonageSecret() { return env("VONAGE_API_SECRET"); }
function vonageFrom() { return env("VONAGE_FROM"); }
function vonageAppId() { return env("VONAGE_APPLICATION_ID"); }
/** Vonage numbers are digits only (no "+"); alphanumeric sender ids pass through. */
const vonageNumber = (n: string) => n.replace(/^\+/, "");

/** The application's RSA private key: VONAGE_JWT_KEY (PEM; "\n" escapes allowed),
 *  VONAGE_PRIVATE_KEY (alias) or VONAGE_PRIVATE_KEY_PATH (file). */
export function vonagePrivateKey(): string {
  const inline = env("VONAGE_JWT_KEY") || env("VONAGE_PRIVATE_KEY");
  if (inline) return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  const path = env("VONAGE_PRIVATE_KEY_PATH");
  if (path) { try { return readFileSync(path, "utf8"); } catch { return ""; } }
  return "";
}

/** Mint a short-lived Vonage application JWT (the Voice API bearer token). */
export function vonageJwt(ttlSec = 900): string {
  const key = vonagePrivateKey();
  const appId = vonageAppId();
  if (!key || !appId) throw new TelephonyNotConfiguredError("vonage", "Set VONAGE_APPLICATION_ID and VONAGE_JWT_KEY.");
  return signJwtRS256({ application_id: appId }, key, ttlSec);
}

export class VonageSmsConnector implements SmsConnector {
  readonly id = "vonage";
  readonly kind = "sms" as const;
  readonly label = "Vonage (Nexmo) SMS";
  readonly needs = ["VONAGE_API_KEY", "VONAGE_API_SECRET", "VONAGE_FROM"];
  status(): ConnectorStatus {
    const ok = vonageKey().length > 0 && vonageSecret().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, needs: this.needs, reason: ok ? undefined : "Set VONAGE_API_KEY and VONAGE_API_SECRET." };
  }
  async sendSms(input: SmsInput): Promise<SmsResult> {
    if (!vonageKey() || !vonageSecret()) throw new TelephonyNotConfiguredError(this.id, "Set VONAGE_API_KEY and VONAGE_API_SECRET.");
    const from = input.from || vonageFrom();
    if (!from) throw new TelephonyNotConfiguredError(this.id, "Set VONAGE_FROM or pass from.");
    const body = new URLSearchParams({ api_key: vonageKey(), api_secret: vonageSecret(), from, to: vonageNumber(input.to), text: input.text });
    const cb = webhookUrl("/wh/vonage/sms_status");
    if (cb) body.set("callback", cb);
    const res = await fetch("https://rest.nexmo.com/sms/json", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    if (!res.ok) throw new Error(`Vonage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { messages?: Array<{ status?: string; "message-id"?: string; "error-text"?: string }> };
    const msg = json.messages?.[0];
    if (msg && msg.status && msg.status !== "0") throw new Error(`Vonage error ${msg.status}: ${msg["error-text"] || "send failed"}`);
    return { id: msg?.["message-id"] || "", provider: this.id };
  }
}

export class VonageVoiceConnector implements VoiceConnector {
  readonly id = "vonage";
  readonly kind = "voice" as const;
  readonly label = "Vonage (Nexmo) Voice";
  readonly needs = ["VONAGE_APPLICATION_ID", "VONAGE_JWT_KEY", "VONAGE_FROM"];
  status(): ConnectorStatus {
    const ok = vonageAppId().length > 0 && vonagePrivateKey().length > 0;
    return {
      id: this.id, kind: this.kind, label: this.label, configured: ok, needs: this.needs,
      reason: ok ? undefined : "Set VONAGE_APPLICATION_ID and VONAGE_JWT_KEY (the application's private key PEM; or VONAGE_PRIVATE_KEY_PATH).",
    };
  }
  async placeCall(input: VoiceInput): Promise<VoiceResult> {
    const from = input.from || vonageFrom();
    if (!from) throw new TelephonyNotConfiguredError(this.id, "Set VONAGE_FROM or pass from.");
    const token = vonageJwt(); // throws TelephonyNotConfiguredError when unconfigured
    const body: Record<string, unknown> = {
      to: [{ type: "phone", number: vonageNumber(input.to) }],
      from: { type: "phone", number: vonageNumber(from) },
    };
    const answer = input.url || webhookUrl("/wh/vonage/answer");
    if (answer) body.answer_url = [answer]; else body.ncco = [{ action: "talk", text: greetingText() }];
    const events = webhookUrl("/wh/vonage/events");
    if (events) { body.event_url = [events]; body.event_method = "POST"; }
    const res = await fetch(`${VONAGE_API}/v1/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Vonage Voice ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { uuid?: string };
    return { id: json.uuid || "", provider: this.id };
  }
}

/* ---------------------------------------------------------------- builders */

export function buildSmsConnectors(): SmsConnector[] {
  return [new TwilioSmsConnector(), new TelnyxSmsConnector(), new VonageSmsConnector()];
}
export function buildVoiceConnectors(): VoiceConnector[] {
  return [new TwilioVoiceConnector(), new TelnyxVoiceConnector(), new VonageVoiceConnector()];
}

/* ---------------------------------------------------- webhook specs/install */

function spec(provider: TelephonyProvider, type: string, method: WebhookSpec["method"], verify: WebhookSpec["verify"], description: string): WebhookSpec {
  const path = `/wh/${provider}/${type}`;
  return { provider, type, path, url: webhookUrl(path), method, description, verify };
}

/** Every webhook this app serves for a provider (what to point the provider at). */
export function providerWebhookSpecs(provider: TelephonyProvider): WebhookSpec[] {
  switch (provider) {
    case "twilio": return [
      spec("twilio", "sms", "POST", "twilio-hmac", "Inbound SMS to your Twilio number"),
      spec("twilio", "sms_status", "POST", "twilio-hmac", "Delivery status of SMS we sent"),
      spec("twilio", "voice", "POST", "twilio-hmac", "Answer URL (returns TwiML) for inbound + our outbound test calls"),
      spec("twilio", "voice_status", "POST", "twilio-hmac", "Call progress: initiated / ringing / answered / completed"),
    ];
    case "telnyx": return [
      spec("telnyx", "events", "POST", "telnyx-ed25519", "All messaging + call-control events (single endpoint)"),
    ];
    case "vonage": return [
      spec("vonage", "sms", "ANY", "vonage-sig", "Inbound SMS (SMS API; set in the Vonage dashboard)"),
      spec("vonage", "sms_status", "ANY", "vonage-sig", "SMS delivery receipts (SMS API)"),
      spec("vonage", "answer", "ANY", "vonage-jwt", "Voice answer URL (returns NCCO)"),
      spec("vonage", "events", "POST", "vonage-jwt", "Voice + Messages API events"),
    ];
  }
}

/** Push our webhook URLs into the provider's configuration (real API calls). */
export async function installProviderWebhooks(provider: TelephonyProvider): Promise<InstallResult> {
  const base = publicBaseUrl();
  if (!base) return { ok: false, provider, message: "Set PUBLIC_BASE_URL (e.g. https://chat.example.org) first.", details: [] };
  const details: string[] = [];
  try {
    if (provider === "twilio") {
      if (!twilioSid() || !twilioToken()) return { ok: false, provider, message: "Twilio is not configured.", details };
      if (!twilioFrom()) return { ok: false, provider, message: "Set TWILIO_FROM (the number to configure).", details };
      const lookup = await fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(twilioSid())}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(twilioFrom())}`, { headers: { Authorization: twilioAuthHeader() } });
      if (!lookup.ok) throw new Error(`Twilio ${lookup.status}: ${(await lookup.text()).slice(0, 200)}`);
      const list = await lookup.json() as { incoming_phone_numbers?: Array<{ sid: string }> };
      const pn = list.incoming_phone_numbers?.[0]?.sid;
      if (!pn) return { ok: false, provider, message: `No incoming phone number ${twilioFrom()} found on this Twilio account.`, details };
      await twilioForm(`/IncomingPhoneNumbers/${pn}.json`, {
        SmsUrl: `${base}/wh/twilio/sms`, SmsMethod: "POST",
        VoiceUrl: `${base}/wh/twilio/voice`, VoiceMethod: "POST",
        StatusCallback: `${base}/wh/twilio/voice_status`, StatusCallbackMethod: "POST",
      });
      details.push(`Number ${twilioFrom()} (${pn}): SmsUrl, VoiceUrl, StatusCallback set.`);
      details.push("SMS delivery receipts are requested per message (StatusCallback) automatically.");
      return { ok: true, provider, message: "Twilio webhooks installed.", details };
    }
    if (provider === "telnyx") {
      if (!telnyxKey()) return { ok: false, provider, message: "Telnyx is not configured.", details };
      let any = false;
      if (telnyxMessagingProfileId()) {
        await telnyxJson("PATCH", `/messaging_profiles/${encodeURIComponent(telnyxMessagingProfileId())}`, { webhook_url: `${base}/wh/telnyx/events`, webhook_api_version: "2" });
        details.push(`Messaging profile ${telnyxMessagingProfileId()}: webhook_url set.`); any = true;
      } else details.push("TELNYX_MESSAGING_PROFILE_ID not set — inbound SMS webhook left as configured in the portal.");
      if (telnyxConnectionId()) {
        await telnyxJson("PATCH", `/call_control_applications/${encodeURIComponent(telnyxConnectionId())}`, { webhook_event_url: `${base}/wh/telnyx/events`, webhook_api_version: "2" });
        details.push(`Call control application ${telnyxConnectionId()}: webhook_event_url set.`); any = true;
      } else details.push("TELNYX_CONNECTION_ID not set — call events webhook left as configured in the portal.");
      return { ok: any, provider, message: any ? "Telnyx webhooks installed." : "Nothing to install: set TELNYX_MESSAGING_PROFILE_ID and/or TELNYX_CONNECTION_ID.", details };
    }
    // vonage
    if (!vonageAppId()) return { ok: false, provider, message: "Set VONAGE_APPLICATION_ID.", details };
    if (!vonageKey() || !vonageSecret()) return { ok: false, provider, message: "Set VONAGE_API_KEY and VONAGE_API_SECRET (application settings are edited with the account key).", details };
    const auth = `Basic ${Buffer.from(`${vonageKey()}:${vonageSecret()}`).toString("base64")}`;
    const cur = await fetch(`${VONAGE_API}/v2/applications/${encodeURIComponent(vonageAppId())}`, { headers: { Authorization: auth } });
    if (!cur.ok) throw new Error(`Vonage ${cur.status}: ${(await cur.text()).slice(0, 200)}`);
    const app = await cur.json() as { name?: string; capabilities?: Record<string, unknown> };
    const capabilities = { ...(app.capabilities ?? {}) } as Record<string, unknown>;
    capabilities.voice = { ...((capabilities.voice as Record<string, unknown>) ?? {}), webhooks: {
      answer_url: { address: `${base}/wh/vonage/answer`, http_method: "POST" },
      event_url: { address: `${base}/wh/vonage/events`, http_method: "POST" },
    } };
    capabilities.messages = { ...((capabilities.messages as Record<string, unknown>) ?? {}), webhooks: {
      inbound_url: { address: `${base}/wh/vonage/events`, http_method: "POST" },
      status_url: { address: `${base}/wh/vonage/events`, http_method: "POST" },
    } };
    const put = await fetch(`${VONAGE_API}/v2/applications/${encodeURIComponent(vonageAppId())}`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ name: app.name || "M5cet", capabilities }),
    });
    if (!put.ok) throw new Error(`Vonage ${put.status}: ${(await put.text()).slice(0, 200)}`);
    details.push(`Application ${vonageAppId()}: voice answer/event + messages inbound/status webhooks set.`);
    details.push(`SMS API (legacy) inbound + delivery-receipt URLs are account-level: set ${base}/wh/vonage/sms and ${base}/wh/vonage/sms_status in the Vonage dashboard → Settings.`);
    return { ok: true, provider, message: "Vonage application webhooks installed.", details };
  } catch (err) {
    return { ok: false, provider, message: (err as Error).message, details };
  }
}
