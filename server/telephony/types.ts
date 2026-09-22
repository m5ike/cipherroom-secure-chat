// Connector contracts for the optional server-side TELEPHONY module (voice
// calls + SMS to real phone numbers). Mirrors server/plugins/types.ts: a
// "connector" wraps one provider (Twilio, Telnyx, Vonage…), is built from
// operator-supplied environment config, and reports whether it is usable.
//
// NO API KEY / AUTH TOKEN is ever hard-coded or returned to a client: keys live
// only in the server process env, connectors read them, and status() exposes
// only whether the key is present, never its value.

export type TelephonyKind = "sms" | "voice";

export type ConnectorStatus = {
  id: string;
  kind: TelephonyKind;
  label: string;
  configured: boolean;
  /** Human reason when not configured (which env var to set). */
  reason?: string;
  /** Advisory shown next to a configured connector (e.g. a JWT that will expire). */
  note?: string;
  /** Names of the env vars this connector reads (never their values). */
  needs: string[];
};

export type SmsInput = { to: string; from?: string; text: string };
export type SmsResult = { id: string; provider: string };

export type VoiceInput = { to: string; from?: string; url?: string; twiml?: string };
export type VoiceResult = { id: string; provider: string };

export interface BaseConnector {
  readonly id: string;
  readonly kind: TelephonyKind;
  readonly label: string;
  readonly needs: string[];
  status(): ConnectorStatus;
}

export interface SmsConnector extends BaseConnector {
  readonly kind: "sms";
  sendSms(input: SmsInput): Promise<SmsResult>;
}

export interface VoiceConnector extends BaseConnector {
  readonly kind: "voice";
  placeCall(input: VoiceInput): Promise<VoiceResult>;
}

export type AnyTelephonyConnector = SmsConnector | VoiceConnector;

export type TelephonyProvider = "twilio" | "telnyx" | "vonage";
export const PROVIDERS: readonly TelephonyProvider[] = ["twilio", "telnyx", "vonage"] as const;
export const isProvider = (v: unknown): v is TelephonyProvider => PROVIDERS.includes(v as TelephonyProvider);

/** How an inbound webhook for a provider is authenticated. */
export type WebhookVerify = "twilio-hmac" | "telnyx-ed25519" | "vonage-jwt" | "vonage-sig" | "none";

/** One webhook endpoint the app serves for a provider, at /wh/{provider}/{type}. */
export type WebhookSpec = {
  provider: TelephonyProvider;
  type: string;
  path: string; // e.g. /wh/vonage/events
  url: string; // absolute when PUBLIC_BASE_URL is set, else ""
  method: "POST" | "GET" | "ANY";
  description: string;
  verify: WebhookVerify;
};

/** Outcome of pushing our webhook URLs into the provider's configuration. */
export type InstallResult = { ok: boolean; provider: TelephonyProvider; message: string; details: string[] };

/** Thrown when a connector is invoked without its required configuration. */
export class TelephonyNotConfiguredError extends Error {
  constructor(public connectorId: string, reason: string) {
    super(reason);
    this.name = "TelephonyNotConfiguredError";
  }
}

/**
 * E.164 validation: a leading "+", a non-zero leading digit, and 2–15 digits
 * total. This is the format every provider below expects for `to`.
 */
export function isE164(s: string): boolean {
  return typeof s === "string" && /^\+[1-9]\d{1,14}$/.test(s.trim());
}
