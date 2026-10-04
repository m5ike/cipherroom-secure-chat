// The Telephony & SIP console's API (6.9) — the contract between the new
// console page (admin-ui/public/telephony-console.js, tsa-editor.js) and the
// admin service (server/telephony/control/routes.ts). Paths are on the admin
// service, behind its authentication and consoleGuard("telephony", …): GET
// needs the module, a change the right named in `right` (Modules & groups ›
// Telephony & SIP: settings, routing, tsa, test, log).
//
// Every answer is JSON { ok: true, …fields } or { ok: false, message, problems? }.
// The older endpoints (GET /admin/telephony, /settings, /webhooks/install,
// /events, /test, /sip/trunks, /sip/route, /admin/telephony/sdk…) stay; the new
// page uses them for providers, default providers, webhooks and SIP trunks.

import type { InboundRule, OutboundRule, RouteDecision, RouteQuestion, TelPermissions, InrouteEntry, TelLogEntry, TelLogQuery, TelTestResult, TestSipAddress } from "./types";
import type { Tsa, TsaGraph, TsaProblem, TsaSession, TsaEvent } from "../tsa/types";
import type { TsaToolDef } from "../tsa/catalog";

export type Endpoint = { method: "GET" | "PUT" | "POST" | "DELETE"; path: string; right: string | null; summary: string };

export const TELEPHONY_API: Endpoint[] = [
  // overview
  { method: "GET", path: "/admin/telephony/overview", right: null, summary: "Providers (configured capabilities), counts (rules, TSAs, live calls, live inroute codes, events today), warnings (no PUBLIC_BASE_URL, unsigned webhooks…)." },
  // permissions
  { method: "GET", path: "/admin/telephony/permissions", right: null, summary: "TelPermissions + the module's access (Modules & groups: groups → rights) for display." },
  { method: "PUT", path: "/admin/telephony/permissions", right: "settings", summary: "Saves TelPermissions (validated, clamped)." },
  // routing rules
  { method: "GET", path: "/admin/telephony/rules", right: null, summary: "{ inbound: InboundRule[], outbound: OutboundRule[] } in priority order." },
  { method: "PUT", path: "/admin/telephony/rules/inbound", right: "routing", summary: "Replaces the inbound list (order = priority); { rules: InboundRule[] } → problems or the saved list." },
  { method: "PUT", path: "/admin/telephony/rules/outbound", right: "routing", summary: "Replaces the outbound list." },
  { method: "POST", path: "/admin/telephony/rules/test", right: null, summary: "Dry run: RouteQuestion → RouteDecision (which rule, why)." },
  // TSA
  { method: "GET", path: "/admin/telephony/tsa/catalog", right: null, summary: "{ tools: TsaToolDef[], groups, limits } — the editor's palette." },
  { method: "GET", path: "/admin/telephony/tsa", right: null, summary: "TSA list (id, name, description, version, published?, updatedAt, used by which rules)." },
  { method: "POST", path: "/admin/telephony/tsa", right: "tsa", summary: "Creates { id?, name, description, template? } — a Start + Hangup, or a template (ivr-menu, route-code, voicemail, opening-hours)." },
  { method: "GET", path: "/admin/telephony/tsa/:id", right: null, summary: "The TSA with its draft graph and the published one." },
  { method: "PUT", path: "/admin/telephony/tsa/:id", right: "tsa", summary: "Saves the draft { name, description, graph, tags } (validated; errors refuse, warnings return)." },
  { method: "POST", path: "/admin/telephony/tsa/:id/validate", right: null, summary: "{ graph } → { problems: TsaProblem[] } (the editor validates live)." },
  { method: "POST", path: "/admin/telephony/tsa/:id/publish", right: "tsa", summary: "Publishes the draft (no errors allowed) → version + 1." },
  { method: "POST", path: "/admin/telephony/tsa/:id/duplicate", right: "tsa", summary: "Copy under a new id." },
  { method: "DELETE", path: "/admin/telephony/tsa/:id", right: "tsa", summary: "Refused while a rule uses it." },
  { method: "GET", path: "/admin/telephony/tsa/:id/export", right: null, summary: "The TSA as a JSON file." },
  { method: "POST", path: "/admin/telephony/tsa/import", right: "tsa", summary: "A TSA JSON file (validated)." },
  // simulator (turn-based, in the browser; no provider, no cost)
  { method: "POST", path: "/admin/telephony/sim", right: "test", summary: "{ tsa, draft?: boolean, from, to } → { session, turn } — runs the TSA as an inbound call in the simulator." },
  { method: "POST", path: "/admin/telephony/sim/:session/event", right: "test", summary: "TsaEvent (digits from the keypad, speech audio or text, a recording, hangup) → the next turn." },
  { method: "GET", path: "/admin/telephony/sim/:session", right: null, summary: "The session (TsaSession with its trace) — the editor highlights the running node." },
  // inroute
  { method: "GET", path: "/admin/telephony/inroute", right: null, summary: "The live inroute table (InrouteEntry[]; codes shown in full to the console)." },
  { method: "POST", path: "/admin/telephony/inroute", right: "settings", summary: "Adds a code from the console (tests): { code?, type, room, user?, ttl?, label?, maxUses? }." },
  { method: "DELETE", path: "/admin/telephony/inroute/:code", right: "settings", summary: "Removes a code." },
  // log
  { method: "GET", path: "/admin/telephony/log", right: null, summary: "TelLogQuery → { entries: summary rows (no parsed / raw), next }." },
  { method: "GET", path: "/admin/telephony/log/:id", right: "log", summary: "One TelLogEntry in full (parsed + raw)." },
  { method: "DELETE", path: "/admin/telephony/log", right: "settings", summary: "Clears the log (itself logged in the audit log)." },
  // tests
  { method: "POST", path: "/admin/telephony/tests/provider", right: "test", summary: "{ provider } → TelTestResult: credentials present, API reachable (an account / balance read), numbers owned, webhook URLs installed." },
  { method: "POST", path: "/admin/telephony/tests/webhook", right: "test", summary: "{ provider } → a signed synthetic event delivered to the main service's /wh/… (proves PUBLIC_BASE_URL, the proxy and the signature check)." },
  { method: "POST", path: "/admin/telephony/tests/route", right: "test", summary: "RouteQuestion → RouteDecision plus what the provider would be told (rendered TwiML / NCCO / commands)." },
  { method: "POST", path: "/admin/telephony/tests/call", right: "test", summary: "{ provider?, to, tsa?, say? } → a real outbound call (billable) through the outbound rules; its events appear in the log." },
  { method: "POST", path: "/admin/telephony/tests/sms", right: "test", summary: "{ provider?, to, text } → a real SMS." },
  { method: "POST", path: "/admin/telephony/tests/room-voice", right: "test", summary: "{ room, user?, type, ttl? } → an inroute code + the number to call: dial it, type the code, the audio goes to the room / member." },
  { method: "GET", path: "/admin/telephony/tests/sip-address", right: null, summary: "TestSipAddress | null." },
  { method: "POST", path: "/admin/telephony/tests/sip-address", right: "test", summary: "{ provider, did? } → creates (or rotates) the test inbound SIP address at the provider." },
  { method: "DELETE", path: "/admin/telephony/tests/sip-address", right: "test", summary: "Removes it at the provider." },
];

/* ---------------------------------------------- request / answer shapes */

export type OverviewAnswer = {
  providers: Array<{ id: string; label: string; capabilities: string[]; configured: string[]; reason?: string; services: { app: boolean; sip: boolean } }>;
  counts: { inboundRules: number; outboundRules: number; tsa: number; tsaPublished: number; liveCalls: number; inroute: number; eventsToday: number; errorsToday: number };
  publicBaseUrl: string;
  warnings: string[];
};

export type RulesAnswer = { inbound: InboundRule[]; outbound: OutboundRule[] };
export type RulesTestAnswer = RouteDecision & { rendered?: { contentType: string; body: string } };
export type PermissionsAnswer = { permissions: TelPermissions; access: Array<{ group: string; allow: string[]; deny: string[] }> };
export type CatalogAnswer = { tools: TsaToolDef[]; groups: Array<{ id: string; label: string }>; limits: Record<string, number> };
export type TsaListRow = Pick<Tsa, "id" | "name" | "description" | "version" | "updatedAt" | "updatedBy" | "tags"> & { published: boolean; publishedVersion: number; usedBy: string[]; nodes: number };
export type TsaSaveAnswer = { tsa: Tsa; problems: TsaProblem[] };
export type ValidateAnswer = { problems: TsaProblem[] };

/**
 * One simulator turn: what the caller would hear and what the TSA waits for.
 * `audio` items carry spoken text (and, when the AI & speech TTS is used, a
 * data: URL of the audio) so the browser can play them; the keypad / mic
 * answers with POST …/event.
 */
export type SimTurn = {
  session: string;
  status: TsaSession["status"];
  at: string | null;
  play: Array<{ kind: "say" | "play" | "beep" | "tone"; text?: string; url?: string; audio?: string; language?: string; loop?: number }>;
  waiting: { for: TsaEvent["kind"]; node: string; maxDigits?: number; finishOnKey?: string; timeoutSec?: number; maxSeconds?: number } | null;
  /** What happened between the last event and this turn (the trace's new entries, as text). */
  steps: string[];
  ended: { how: string; cause?: string } | null;
};

export type InrouteAddBody = { code?: string; type: InrouteEntry["type"]; room: string; user?: string; ttl?: number; label?: string; maxUses?: number };
export type LogAnswer = { entries: Array<Omit<TelLogEntry, "parsed" | "raw">>; next: number | null };
export type LogQueryParams = TelLogQuery;
export type TestAnswer = TelTestResult;
export type SipAddressAnswer = { address: TestSipAddress | null; providers: Array<{ id: string; can: boolean; how: string }> };
export type TsaPutBody = { name: string; description: string; graph: TsaGraph; tags?: string[] };
