// Provider adapters for m5.telephony (6.0): one neutral contract over
// Twilio, Telnyx, Vonage, HLR-Lookups.com and Meta (Messenger). The engine
// (server/telephony/engine.ts) and the Functions SDK speak only these types;
// each adapter maps them to its provider's REST API and back.
//
// Rules every adapter follows:
//   - credentials come from the environment at call time (never cached,
//     never returned, never logged); status() names the env vars only
//   - plain fetch (globalThis.fetch, so tests stub it), JSON / form bodies
//     exactly as the provider documents them, a 15 s timeout
//   - a missing credential throws ProviderNotConfigured; a provider error
//     throws ProviderError with the HTTP status and a short message (the
//     body is cut to 300 characters; no credentials in it)
//   - numbers are E.164 in and out ("+420…"); an adapter strips the "+"
//     where its API wants digits only (Vonage)
//   - every result keeps the provider's answer in `raw` (secrets removed)

export type ProviderId = "twilio" | "telnyx" | "vonage" | "hlrlookups" | "meta";
export const PROVIDER_IDS: readonly ProviderId[] = ["twilio", "telnyx", "vonage", "hlrlookups", "meta"];

export type Capability = "call" | "sms" | "hlr" | "lookup" | "whatsapp" | "viber" | "messenger" | "numbers" | "media";

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  /** What this provider can do at all (by its API), and what is configured now. */
  capabilities: Capability[];
  configured: Capability[];
  /** Env var names (never values) each capability needs. */
  needs: Partial<Record<Capability, string[]>>;
  /** Why something is not configured (which variable to set). */
  reason?: string;
};

export class ProviderNotConfigured extends Error {
  constructor(readonly provider: ProviderId, readonly capability: Capability, message: string) {
    super(message);
    this.name = "ProviderNotConfigured";
  }
}

export class ProviderError extends Error {
  constructor(readonly provider: ProviderId, readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/* ------------------------------------------------------------ call logic */

/**
 * Provider-neutral call control. An adapter renders a list of these as TwiML
 * (Twilio; Telnyx TeXML), NCCO (Vonage) — or, for Telnyx Call Control, runs
 * them as commands one after another (executeActions).
 */
export type CallAction =
  | { say: { text: string; voice?: string; language?: string; loop?: number } }
  | { play: { url: string; loop?: number } }
  | { pause: { seconds: number } }
  /** Collects digits. `action` is the absolute URL the digits are POSTed to. With
   *  finishOnKey "#" and no fixed length the caller types any number of digits and "#". */
  | { gather: { action: string; prompt?: string; voice?: string; language?: string; digits?: number; finishOnKey?: string; timeout?: number } }
  /** Bidirectional audio over a WebSocket (wss://…); `params` travel in the start message. */
  | { stream: { url: string; params?: Record<string, string>; codec?: "PCMU" | "L16"; rate?: 8000 | 16000 } }
  | { record: { action: string; maxSeconds?: number; beep?: boolean } }
  | { redirect: { url: string } }
  | { hangup: Record<string, never> };

export type RenderedLogic = { contentType: string; body: string };

/* ----------------------------------------------------------------- calls */

export type CallStatus =
  | "queued" | "initiated" | "ringing" | "answered" | "completed"
  | "busy" | "no-answer" | "failed" | "canceled" | "machine";

export const FINAL_CALL_STATUSES: readonly CallStatus[] = ["completed", "busy", "no-answer", "failed", "canceled"];

export type PlaceCallInput = {
  to: string;
  from: string;
  /** Ring timeout in seconds (the SDK's default is 10). */
  timeout: number;
  /** Longest the call may last, seconds (optional). */
  timeLimit?: number;
  /** Where the provider asks for the call logic when answered (sync logic). */
  answerUrl?: string;
  /** Inline call logic (rendered by the adapter). */
  actions?: CallAction[];
  /** Provider-native logic, passed through unchanged. */
  raw?: { twiml?: string; ncco?: unknown[]; texml?: string };
  /** Status / progress events for this call (absolute URL). */
  eventUrl: string;
  /** Echoed back in every event (Telnyx client_state, base64 by the adapter). */
  clientState?: string;
  machineDetection?: boolean;
};

export type PlaceCallResult = { id: string; provider: ProviderId; status: CallStatus; raw: unknown };

export type NormalizedCallEvent = {
  provider: ProviderId;
  /** The provider's call id (Twilio CallSid, Telnyx call_control_id, Vonage uuid). */
  callId: string;
  status: CallStatus | null;
  kind: "status" | "answer" | "dtmf" | "gather" | "speak-ended" | "playback-ended" | "stream" | "machine" | "other";
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
  digits?: string;
  durationSec?: number;
  sipCode?: string;
  /** The provider's own cause / detail (normal_clearing, user_busy, timeout…). */
  cause?: string;
  /** Telnyx client_state, decoded. */
  clientState?: string;
  /** The provider's event id (dedupe). */
  eventId?: string;
  raw: unknown;
};

/* ------------------------------------------------------------ messaging */

export type SmsInput = {
  to: string;
  from?: string;
  text: string;
  options?: {
    unicode?: boolean;
    /** Validity in seconds. */
    ttl?: number;
    statusUrl?: string;
    clientRef?: string;
    /** Twilio: send through a Messaging Service (MG…). */
    messagingServiceSid?: string;
    /** Telnyx: messaging profile. */
    messagingProfileId?: string;
    /** ISO time to send at (where the provider supports scheduling). */
    sendAt?: string;
  };
};

export type SmsResult = { id: string; provider: ProviderId; status: string; parts?: number; price?: string; raw: unknown };

export type ChatChannel = "whatsapp" | "viber" | "messenger";

export type ChatMessageInput = {
  channel: ChatChannel;
  /** WhatsApp: E.164; Viber: E.164; Messenger: the page-scoped id (PSID). */
  to: string;
  /** WhatsApp: the business number; Viber: the service message id; Messenger: the page id. */
  from?: string;
  text?: string;
  /** WhatsApp template (outside the 24-hour window). */
  template?: { name: string; language: string; params?: string[] };
  media?: { url: string; type: "image" | "audio" | "video" | "file" };
  /** Viber: transaction | promotion. Messenger: RESPONSE | UPDATE | MESSAGE_TAG. */
  category?: string;
  /** Messenger message tag (only HUMAN_AGENT still works, 2026). */
  tag?: string;
  statusUrl?: string;
  clientRef?: string;
};

export type ChatMessageResult = { id: string; provider: ProviderId; channel: ChatChannel; status: string; raw: unknown };

/* ------------------------------------------------------ lookup, HLR */

export type LookupField = "carrier" | "caller_name" | "line_type" | "portability" | "sim_swap" | "line_status" | "validation";

export type LookupResult = {
  number: string;
  provider: ProviderId;
  valid?: boolean | null;
  national?: string;
  country?: { code: string; name?: string; prefix?: string };
  /** mobile, landline, voip, toll-free… (lower case, provider words mapped). */
  type?: string;
  carrier?: { name?: string; mcc?: string; mnc?: string; type?: string };
  callerName?: string;
  callerType?: string;
  ported?: boolean | null;
  region?: { city?: string; state?: string };
  reachable?: string;
  roaming?: { status: string; country?: string; network?: string } | null;
  simSwap?: { at?: string; period?: string } | null;
  raw: unknown;
};

export type HlrResult = {
  number: string;
  provider: ProviderId;
  /** CONNECTED / ABSENT / INVALID / UNDETERMINED, or the provider's words mapped to these. */
  status: "connected" | "absent" | "invalid" | "undetermined";
  valid?: boolean | null;
  reachable?: string;
  network?: { name?: string; mcc?: string; mnc?: string; country?: string };
  original?: { name?: string; country?: string };
  ported?: boolean | null;
  roaming?: { status: string; country?: string; network?: string } | null;
  imsi?: string;
  cost?: string;
  raw: unknown;
};

/* --------------------------------------------------------------- numbers */

export type NumberSearch = { country: string; type?: "local" | "mobile" | "tollfree"; contains?: string; limit?: number; voice?: boolean; sms?: boolean };
export type AvailableNumber = { number: string; country: string; region?: string; locality?: string; capabilities: string[]; cost?: string; raw: unknown };
export type OwnedNumber = { id: string; number: string; provider: ProviderId; raw: unknown };

/* --------------------------------------------------------------- media */

/** How the provider streams call audio over a WebSocket. */
export type MediaFormat = {
  /** "json-mulaw": Twilio (base64 µ-law 8 kHz in JSON); "json-rtp": Telnyx (base64 payload of the
   *  chosen codec in JSON); "binary-l16": Vonage (raw 16-bit little-endian PCM frames). */
  transport: "json-mulaw" | "json-rtp" | "binary-l16";
  codec: "PCMU" | "L16";
  rate: 8000 | 16000;
};

/* --------------------------------------------------------------- adapter */

/** Everything optional that a provider cannot do is simply absent. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  status(): ProviderStatus;

  placeCall?(input: PlaceCallInput): Promise<PlaceCallResult>;
  hangup?(callId: string): Promise<void>;
  /** Replace the logic of a live call (Twilio: update Twiml; Vonage: transfer NCCO;
   *  Telnyx: run the actions as call-control commands). */
  executeActions?(callId: string, actions: CallAction[], ctx?: { clientState?: string }): Promise<void>;
  /** The logic as the provider wants it in an answer / action webhook response. */
  renderActions?(actions: CallAction[]): RenderedLogic;
  /** A webhook body (form or JSON) + query → the events it carries (usually one). */
  parseCallEvent?(body: unknown, query: Record<string, string>): NormalizedCallEvent[];
  /** Answer an inbound call (Telnyx Call Control needs it; others answer by returning logic). */
  answer?(callId: string, ctx?: { clientState?: string }): Promise<void>;

  sendSms?(input: SmsInput): Promise<SmsResult>;
  sendChat?(input: ChatMessageInput): Promise<ChatMessageResult>;
  channels?: ChatChannel[];

  lookup?(number: string, fields: LookupField[]): Promise<LookupResult>;
  hlr?(number: string): Promise<HlrResult>;

  searchNumbers?(q: NumberSearch): Promise<AvailableNumber[]>;
  buyNumber?(number: string, opts: { country: string; voiceUrl?: string }): Promise<OwnedNumber>;
  /** Point an owned number's voice webhook here (Twilio VoiceUrl, Vonage app, Telnyx connection). */
  assignNumber?(idOrNumber: string, opts: { voiceUrl?: string; country?: string }): Promise<void>;
  releaseNumber?(idOrNumber: string, opts?: { country?: string }): Promise<void>;

  readonly media?: MediaFormat;
}
