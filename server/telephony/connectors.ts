// Real REST connectors for SMS + voice. Same rules as the AI/speech ones:
// keys live in the environment, are never returned, and a connector without
// its key reports not-configured and refuses to run (never an open, billable
// proxy by default). Each provider talks plain HTTP via fetch — no SDK.

import {
  TelephonyNotConfiguredError,
  type SmsConnector, type SmsInput, type SmsResult,
  type VoiceConnector, type VoiceInput, type VoiceResult,
  type ConnectorStatus,
} from "./types";

const env = (name: string): string => (process.env[name]?.trim() || "");

/* ------------------------------------------------------------------ Twilio */
// SMS:   POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
// Voice: POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Calls.json
// Basic auth SID:token, x-www-form-urlencoded body.

function twilioSid() { return env("TWILIO_ACCOUNT_SID"); }
function twilioToken() { return env("TWILIO_AUTH_TOKEN"); }
function twilioFrom() { return env("TWILIO_FROM"); }
function twilioAuthHeader() { return `Basic ${Buffer.from(`${twilioSid()}:${twilioToken()}`).toString("base64")}`; }

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
    const body = new URLSearchParams({ To: input.to, From: from, Body: input.text });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid())}/Messages.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: twilioAuthHeader() },
      body,
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { sid?: string };
    return { id: json.sid || "", provider: this.id };
  }
}

export class TwilioVoiceConnector implements VoiceConnector {
  readonly id = "twilio";
  readonly kind = "voice" as const;
  readonly label = "Twilio Voice";
  readonly needs = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_VOICE_URL"];
  private voiceUrl() { return env("TWILIO_VOICE_URL") || "http://demo.twilio.com/docs/voice.xml"; }
  status(): ConnectorStatus {
    const ok = twilioSid().length > 0 && twilioToken().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, needs: this.needs, reason: ok ? undefined : "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." };
  }
  async placeCall(input: VoiceInput): Promise<VoiceResult> {
    if (!twilioSid() || !twilioToken()) throw new TelephonyNotConfiguredError(this.id, "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
    const from = input.from || twilioFrom();
    if (!from) throw new TelephonyNotConfiguredError(this.id, "Set TWILIO_FROM or pass from.");
    const params: Record<string, string> = { To: input.to, From: from };
    // Twilio needs TwiML content: inline <Twiml> or a URL that returns it.
    if (input.twiml) params.Twiml = input.twiml;
    else params.Url = input.url || this.voiceUrl();
    const body = new URLSearchParams(params);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid())}/Calls.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: twilioAuthHeader() },
      body,
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { sid?: string };
    return { id: json.sid || "", provider: this.id };
  }
}

/* ------------------------------------------------------------------ Telnyx */
// SMS:   POST https://api.telnyx.com/v2/messages   (Bearer, JSON)
// Voice: POST https://api.telnyx.com/v2/calls      (Bearer, JSON)

function telnyxKey() { return env("TELNYX_API_KEY"); }
function telnyxFrom() { return env("TELNYX_FROM"); }
function telnyxConnectionId() { return env("TELNYX_CONNECTION_ID"); }

export class TelnyxSmsConnector implements SmsConnector {
  readonly id = "telnyx";
  readonly kind = "sms" as const;
  readonly label = "Telnyx SMS";
  readonly needs = ["TELNYX_API_KEY", "TELNYX_FROM"];
  status(): ConnectorStatus {
    const ok = telnyxKey().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, needs: this.needs, reason: ok ? undefined : "Set TELNYX_API_KEY." };
  }
  async sendSms(input: SmsInput): Promise<SmsResult> {
    if (!telnyxKey()) throw new TelephonyNotConfiguredError(this.id, "Set TELNYX_API_KEY.");
    const from = input.from || telnyxFrom();
    if (!from) throw new TelephonyNotConfiguredError(this.id, "Set TELNYX_FROM or pass from.");
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${telnyxKey()}` },
      body: JSON.stringify({ from, to: input.to, text: input.text }),
    });
    if (!res.ok) throw new Error(`Telnyx ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { data?: { id?: string } };
    return { id: json.data?.id || "", provider: this.id };
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
    const res = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${telnyxKey()}` },
      body: JSON.stringify({ connection_id: telnyxConnectionId(), to: input.to, from }),
    });
    if (!res.ok) throw new Error(`Telnyx ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { data?: { call_control_id?: string; call_leg_id?: string } };
    return { id: json.data?.call_control_id || json.data?.call_leg_id || "", provider: this.id };
  }
}

/* ------------------------------------------------------------------ Vonage */
// SMS:   POST https://rest.nexmo.com/sms/json  (api_key/api_secret in the body)
// Voice: POST https://api.nexmo.com/v1/calls   (needs a signed JWT — NOT wired)

function vonageKey() { return env("VONAGE_API_KEY"); }
function vonageSecret() { return env("VONAGE_API_SECRET"); }
function vonageFrom() { return env("VONAGE_FROM"); }

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
    // The legacy Nexmo SMS API expects the destination in international format
    // without a leading "+". `from` may be an alphanumeric sender id, kept as-is.
    const body = new URLSearchParams({
      api_key: vonageKey(), api_secret: vonageSecret(),
      from, to: input.to.replace(/^\+/, ""), text: input.text,
    });
    const res = await fetch("https://rest.nexmo.com/sms/json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`Vonage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as { messages?: Array<{ status?: string; "message-id"?: string; "error-text"?: string }> };
    const msg = json.messages?.[0];
    if (msg && msg.status && msg.status !== "0") {
      throw new Error(`Vonage error ${msg.status}: ${msg["error-text"] || "send failed"}`);
    }
    return { id: msg?.["message-id"] || "", provider: this.id };
  }
}

export class VonageVoiceConnector implements VoiceConnector {
  readonly id = "vonage";
  readonly kind = "voice" as const;
  readonly label = "Vonage (Nexmo) Voice";
  readonly needs = ["VONAGE_APPLICATION_ID", "VONAGE_FROM"];
  // Vonage Voice authenticates with a per-request JWT signed by an application
  // private key. Minting that JWT (RS256 over the application key) is out of
  // scope here, so this connector is deliberately reported as not-configured.
  private readonly reason = "Vonage voice needs a signed JWT application; not yet wired";
  status(): ConnectorStatus {
    return { id: this.id, kind: this.kind, label: this.label, configured: false, needs: this.needs, reason: this.reason };
  }
  async placeCall(_input: VoiceInput): Promise<VoiceResult> {
    throw new TelephonyNotConfiguredError(this.id, this.reason);
  }
}

/* ---------------------------------------------------------------- builders */

export function buildSmsConnectors(): SmsConnector[] {
  return [new TwilioSmsConnector(), new TelnyxSmsConnector(), new VonageSmsConnector()];
}
export function buildVoiceConnectors(): VoiceConnector[] {
  return [new TwilioVoiceConnector(), new TelnyxVoiceConnector(), new VonageVoiceConnector()];
}
