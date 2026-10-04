// The Telephony & SIP control plane (6.9): who may do what (permissions), how
// calls are routed (inbound and outbound rules), the inroute table (route
// codes that connect a caller's audio to a room or a member), the event log
// and the tests. The CONTRACT the server store and API (control/*), the
// providers' webhooks, the TSA runtime and the console page share. Pure types.
//
// Routing, in one paragraph
//   An INBOUND call reaches the server through a provider — its application
//   (a webhook on the number: Twilio Voice URL, the Vonage application's
//   answer URL, a Telnyx Call Control / TeXML application) or a SIP trunk
//   (the operator's trunk delivers to the provider's SIP domain / connection,
//   which hands the call to the same webhook). The inbound rules, in order,
//   pick the first that matches the number called (DID), the caller, the
//   provider, the service and the time; its target is a TSA (the call runs
//   it) or a state (busy, congestion, hangup, rejected). No rule matched →
//   the module's default (permissions.defaults.inbound).
//   An OUTBOUND call (m5.telephony.call, a TSA's Dial, a console test) asks
//   the outbound rules which provider and which service carry it — the
//   provider's application (its API key and secret) or a SIP trunk (dialled
//   through the provider, with the rule's caller ID) — and what runs when it
//   is answered (a TSA, or the caller's own actions = "pass"); a state
//   refuses it.

import type { ProviderId } from "../providers/types";

export type TelService = "app" | "sip";

/** Caller ID shown on an outbound call (a SIP trunk, or an application where the provider allows it). */
export type CallerId = {
  /** E.164; must be a number the provider lets you present (owned / verified). Empty = the trunk's or provider's default. */
  number: string;
  /** Display name where the network carries one (SIP From display name, CNAM-capable carriers). */
  name: string;
  /** "restricted" = withheld / anonymous (Privacy: id). */
  presentation: "allowed" | "restricted";
};

/** Which provider and which of its services carry a call. */
export type RouteService =
  /** The provider's application, authenticated by its API key and secret (env, never stored here). */
  | { kind: "app"; provider: ProviderId }
  /** A SIP trunk (sip.ts), dialled through the provider that terminates it, with its own caller ID. */
  | { kind: "sip"; provider: ProviderId; trunk: string; callerId: CallerId };

export type RouteState = "busy" | "congestion" | "hangup" | "rejected";

/** What happens to a routed call. */
export type RouteTarget =
  /** The call runs this TSA (its published version). */
  | { kind: "tsa"; tsa: string }
  /** The call is refused / ended with a state. */
  | { kind: "state"; state: RouteState }
  /** Outbound only: the call goes as its caller asked (m5.telephony.call's actions / handlers). */
  | { kind: "pass" };

/** A weekly window in a time zone ("mon-fri 08:00-17:00"). */
export type TimeWindow = { timezone: string; days: string; from: string; to: string };

/**
 * Number patterns (DIDs, callers, destinations):
 *   "+420123456789"  exactly          "+4202*"  a prefix          "*"  anything
 *   "sip:*@example.com"  a SIP URI (glob)    "-+1900*"  NOT this (a leading "-"; denies win)
 */
export type NumberPattern = string;

export type InboundRule = {
  id: string;
  label: string;
  enabled: boolean;
  /** Lower runs first; the console keeps them 10, 20, 30… */
  priority: number;
  match: {
    /** The number called (the DID) or the SIP URI dialled. [] = any. */
    numbers: NumberPattern[];
    /** The caller. [] = anyone. */
    from: NumberPattern[];
    /** "" = any provider / service. */
    provider: ProviderId | "";
    service: TelService | "";
    /** Only inside this window (null = always). */
    hours: TimeWindow | null;
  };
  target: RouteTarget;
  /** Record the whole call (the provider's recording; kept with the call). */
  record: boolean;
  note: string;
};

export type OutboundRule = {
  id: string;
  label: string;
  enabled: boolean;
  priority: number;
  match: {
    /** The destination. [] = any. */
    to: NumberPattern[];
    /** Who places the call: groups of the caller (Modules & groups). [] = anyone allowed by the permissions. */
    groups: string[];
    /** What places it. [] = any. */
    sources: Array<"function" | "tsa" | "console" | "api">;
    hours: TimeWindow | null;
  };
  service: RouteService;
  target: RouteTarget;
  note: string;
};

/** The rules engine's answer (also the console's dry run, POST /admin/telephony/rules/test). */
export type RouteDecision = {
  direction: "inbound" | "outbound";
  /** The rule that matched, or null (the default applied). */
  rule: string | null;
  ruleLabel: string;
  service: RouteService | null;
  target: RouteTarget;
  /** Human explanation: which rules were skipped and why, which matched. */
  reasons: string[];
};

/** A dry-run question: what would happen to this call. */
export type RouteQuestion = {
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  provider?: ProviderId | "";
  service?: TelService | "";
  /** Outbound: the caller's groups and what places the call. */
  groups?: string[];
  source?: "function" | "tsa" | "console" | "api";
  /** Default: now. */
  at?: number;
};

/**
 * The module's policy, beyond Modules & groups (which already decides which
 * user groups and which administrators have which telephony rights: call, sms,
 * did, inroute, number:+420*, the console's settings / test / routing / tsa /
 * log). These are limits and defaults that apply to everyone.
 */
export type TelPermissions = {
  outbound: {
    /** ISO 3166 alpha-2 countries calls and SMS may go to ([] = any). */
    countries: string[];
    /** Never dialled whatever a rule says (premium, satellite…): patterns as above. */
    blocked: NumberPattern[];
    maxConcurrentCalls: number;
    /** Per caller (account / model) and hour. */
    callsPerHour: number;
    smsPerHour: number;
    /** Longest outbound call (minutes). */
    maxMinutes: number;
  };
  inbound: {
    maxConcurrentCalls: number;
    /** Calls from one caller number per hour before it gets "busy" (toll / flood protection). */
    perCallerPerHour: number;
  };
  inroute: {
    /** Longest TTL a code may get (seconds). */
    maxTtlSec: number;
    /** Live codes per model (or console administrator). */
    maxActivePerOwner: number;
    /** Wrong codes in one call; the one that reaches it ends the call (6.10, G-05 — before: on_code_error from then on). */
    maxAttemptsPerCall: number;
    /** Wrong codes from one caller number per hour before it is refused outright (the caller ID can be faked — see below). */
    maxFailuresPerCallerPerHour: number;
    /** 6.10 (G-05): wrong codes on one number called (DID) per hour; then route codes on it pause (a lockout that doubles, 1 min … 1 h). */
    maxFailuresPerDidPerHour: number;
    /** 6.10 (G-05): wrong codes on the whole module per minute and per hour; then route codes pause for everyone (the same lockout). */
    maxFailuresPerMinute: number;
    maxFailuresPerHour: number;
  };
  tsa: {
    /** The http tool: hosts it may reach (exact or *.example.com); [] = the tool is off. */
    httpHosts: string[];
    /** The function tool may run models. */
    functions: boolean;
    /** Recordings are kept this long (days). */
    recordingDays: number;
  };
  log: {
    /** Event log retention (days); webhooks' parsed payloads included. */
    days: number;
    /** Keep the provider's raw payload (secrets removed) next to the parsed one. */
    keepRaw: boolean;
  };
  defaults: {
    /** No inbound rule matched. */
    inbound: RouteTarget;
    /** No outbound rule matched: "pass" through the default voice provider (registry.ts), or a state. */
    outbound: RouteTarget;
  };
};

export const DEFAULT_PERMISSIONS: TelPermissions = {
  outbound: { countries: [], blocked: ["+1900*", "+1976*", "+44870*", "+44871*", "+44872*", "+44873*", "+4290*", "+42097*", "+881*", "+882*", "+883*"], maxConcurrentCalls: 5, callsPerHour: 30, smsPerHour: 60, maxMinutes: 30 },
  inbound: { maxConcurrentCalls: 10, perCallerPerHour: 20 },
  inroute: { maxTtlSec: 86_400, maxActivePerOwner: 50, maxAttemptsPerCall: 3, maxFailuresPerCallerPerHour: 10, maxFailuresPerDidPerHour: 30, maxFailuresPerMinute: 10, maxFailuresPerHour: 100 },
  tsa: { httpHosts: [], functions: true, recordingDays: 30 },
  log: { days: 30, keepRaw: true },
  defaults: { inbound: { kind: "state", state: "busy" }, outbound: { kind: "pass" } },
};

/* ------------------------------------------------------------- inroute */

/**
 * A route code (m5.telephony.inroute.add): whoever calls one of the inbound
 * numbers and reaches a TSA's Route audio with this code gets their audio
 * routed both ways — to the whole room (every member connected with audio,
 * mixed) or to one member. Codes are 4–6 digits, unique among live codes,
 * and expire after their TTL (default 600 s). 6.10 (G-05): a code that lives
 * longer than INROUTE_SHORT_TTL needs 6 digits, and at most 1 in
 * INROUTE_SPARSENESS codes of each length is live at a time.
 */
export type InrouteType = "room" | "user";

export type InrouteEntry = {
  code: string;
  type: InrouteType;
  /** The room's blind id (r3.…) — never its name. */
  room: string;
  /** type "user": the member's name in the room, or an account username ("@alice"). */
  user: string;
  label: string;
  ttlSec: number;
  createdAt: number;
  expiresAt: number;
  /** Who made it: a model (m5.telephony.inroute.add), a TSA, the console. */
  createdBy: { kind: "model" | "tsa" | "console"; id: string; run?: string };
  /** Times it routed a call. */
  uses: number;
  /** Removed after this many uses (0 = unlimited until it expires). */
  maxUses: number;
};

export const INROUTE_CODE = /^\d{4,6}$/;
export const INROUTE_DEFAULT_TTL = 600;
/** 6.10 (G-05): codes that live longer than this (seconds) are 6 digits. */
export const INROUTE_SHORT_TTL = 600;
/** 6.10 (G-05): at most 10^digits / this many live codes of one length (4 digits: 10, 5: 100, 6: 1000). */
export const INROUTE_SPARSENESS = 1000;
/** The fewest digits a code with this TTL may have. */
export const inrouteMinDigits = (ttlSec: number): number => (ttlSec > INROUTE_SHORT_TTL ? 6 : 4);

/* ----------------------------------------------------------------- log */

export type TelLogKind = "webhook" | "call" | "sms" | "tsa" | "route" | "inroute" | "test" | "config" | "sip";

/**
 * One event of the module (Telephony › Log). The list shows the summary; a
 * click opens the full entry: the parsed (normalized) data and, when kept,
 * the provider's raw payload with secrets removed.
 */
export type TelLogEntry = {
  id: string;
  at: number;
  kind: TelLogKind;
  level: "debug" | "info" | "notice" | "warn" | "error";
  provider: string;
  direction: "inbound" | "outbound" | "";
  /** One line for the list. */
  summary: string;
  /** Links to what it belongs to. */
  callId: string;
  tsaSession: string;
  rule: string;
  /** Webhooks: was the provider's signature verified. */
  verified: boolean | null;
  http: { method: string; path: string; status: number; ms: number } | null;
  /** Normalized data (NormalizedCallEvent, a decision, a test's checks…). */
  parsed: unknown;
  /** The provider's payload as received (secrets and auth headers removed), when permissions.log.keepRaw. */
  raw: unknown;
};

export type TelLogQuery = { kind?: TelLogKind | ""; provider?: string; level?: string; callId?: string; q?: string; before?: number; limit?: number };

/* --------------------------------------------------------------- tests */

/** One check of a test (the console shows them as a checklist). */
export type TelCheck = { id: string; label: string; ok: boolean | null; detail: string; ms?: number };

export type TelTestResult = { ok: boolean; checks: TelCheck[]; log: string[]; at: number };

/**
 * The test inbound SIP address (Telephony › Tests): a SIP URI the operator can
 * call from any SIP phone or softphone to exercise the inbound routing and a
 * TSA without buying a DID — terminated by a provider's SIP domain /
 * connection that sends the call to this server's webhook as if it came to
 * `did`.
 */
export type TestSipAddress = {
  provider: ProviderId;
  /** sip:test-<token>@<domain> */
  uri: string;
  /** The number the routing treats it as (a test DID, e.g. "+000100"). */
  did: string;
  /** How it was set up at the provider (the domain / connection id) and when. */
  setup: { resource: string; at: number; by: string };
  /** Optional digest credentials when the provider's SIP domain requires them (the password is never returned). */
  username: string;
  enabled: boolean;
};
