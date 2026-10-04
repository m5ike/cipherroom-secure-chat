// Outbound enforcement (6.9): what every call and message that leaves the
// server goes through before a provider is asked — m5.telephony.call / sms /
// whatsapp… (engine.ts), the app's POST /api/telephony/call|sms (routes.ts)
// and the console's tests.
//
//   1. the module's limits no rule overrides: the countries calls and
//      messages may go to, the blocked destinations (permissions.outbound)
//   2. the caller's hourly budget (callsPerHour / smsPerHour, per caller:
//      a model, an account, a console administrator, an address)
//   3. calls: how many may be live at once (maxConcurrentCalls, the module)
//   4. calls: the outbound rules (rules.ts) — a state refuses with the rule's
//      name; "app" picks the provider's application; "sip" dials over the
//      trunk (its credentials from sip.ts → PlaceCallInput.via) with the
//      rule's caller ID; "tsa" runs that TSA when the call is answered;
//      "pass" leaves the caller's own call logic
//   5. calls: the longest a call may last (maxMinutes → the provider's time limit)
// A refusal is an OutboundRefused (the engine turns it into a TelError with
// the same code); every decision is logged (kind "route").

import type { PlaceCallInput, ProviderId } from "../providers/types";
import { FINAL_CALL_STATUSES } from "../providers/types";
import type { RouteDecision, RouteService } from "./types";
import { sipStore } from "../sip";
import { isE164 } from "../types";
import { telStore } from "../tel-store";
import { getPermissions } from "./store";
import { decideNow, permissionRefusal, serviceText, targetText } from "./rules";
import { telLog } from "./hooks";

export class OutboundRefused extends Error {
  constructor(readonly code: string, message: string, readonly decision: RouteDecision | null = null) { super(message); this.name = "OutboundRefused"; }
}

export type OutboundSource = "function" | "tsa" | "console" | "api";

export type OutboundAsk = {
  kind: "call" | "sms" | "message";
  to: string;
  /** Who, for the hourly budget: "model:<id>", "user:<account>", "admin:<name>", "ip:<address>"… */
  by: string;
  /** The caller's groups (Modules & groups) — an outbound rule may name them. */
  groups?: string[];
  source: OutboundSource;
  /** The provider the caller asked for (a rule's service wins over it). */
  provider?: string;
  /** Ring timeout + call length the caller asked for, seconds (clamped to maxMinutes). */
  timeLimitSec?: number;
};

export type OutboundPlan = {
  decision: RouteDecision | null;
  /** The provider to use ("" = the caller's choice / the default). */
  provider: string;
  service: RouteService | null;
  /** A SIP trunk's dial details (the provider dials sip:<to>@<host>). */
  via?: PlaceCallInput["via"];
  /** The caller ID to present (the rule's, else the trunk's), "" = the caller's / provider's. */
  from: string;
  /** The TSA the answered call runs. */
  tsa: string;
  /** The longest the call may last (seconds). */
  timeLimitSec: number;
};

const HOUR = 3_600_000;

/* ----------------------------------------------------- budget, counted */

// The app's legacy routes (POST /api/telephony/call|sms) go through the old
// connectors, not tel-store: their sends are counted here, in this process.
const legacy = new Map<string, number[]>();
/** Counts a send that tel-store does not record (the legacy connectors). */
export function noteLegacySend(kind: "call" | "sms", by: string): void {
  const key = `${kind}|${by}`;
  const now = Date.now();
  legacy.set(key, [...(legacy.get(key) ?? []).filter((t) => t > now - HOUR), now].slice(-10_000));
  if (legacy.size > 10_000) legacy.delete(legacy.keys().next().value!);
}
const legacyCount = (kind: "call" | "sms", by: string, now: number) => (legacy.get(`${kind}|${by}`) ?? []).filter((t) => t > now - HOUR).length;

/** Calls / SMS this caller placed in the last hour (tel-store, both processes, + the legacy routes). */
export async function sentLastHour(kind: "call" | "sms", by: string, now = Date.now()): Promise<number> {
  await telStore.ready();
  const recorded = kind === "call"
    ? telStore.calls.list({ after: now - HOUR, limit: 5000, filter: (c) => c.direction === "outbound" && c.by === by }).length
    : telStore.messages.list({ after: now - HOUR, limit: 5000, filter: (m) => m.channel === "sms" && m.by === by }).length;
  return recorded + legacyCount(kind, by, now);
}

/** Outbound calls that are still going (not final), placed within the longest a call may last. */
export async function liveOutboundCalls(now = Date.now()): Promise<number> {
  await telStore.ready();
  const window = Math.max(HOUR, (getPermissions().outbound.maxMinutes + 15) * 60_000);
  return telStore.calls.list({ after: now - window, limit: 5000, filter: (c) => c.direction === "outbound" && !FINAL_CALL_STATUSES.includes(c.status) }).length;
}

/* ----------------------------------------------------------------- plan */

function refuse(ask: OutboundAsk, code: string, message: string, decision: RouteDecision | null = null): never {
  telLog({ kind: "route", level: "notice", direction: "outbound", rule: decision?.rule ?? "", summary: `${ask.kind} to ${ask.to} refused: ${message}`, parsed: { ask: { ...ask, groups: ask.groups ?? [] }, decision } });
  throw new OutboundRefused(code, message, decision);
}

/**
 * May this call / message go, and how? The plan, or an OutboundRefused:
 * route-refused (a rule's state, a blocked destination, a country),
 * telephony-limit (the hourly budget), telephony-busy (too many live calls),
 * not-configured (a rule's SIP trunk is gone).
 */
export async function planOutbound(ask: OutboundAsk): Promise<OutboundPlan> {
  const p = getPermissions();
  const maxSec = p.outbound.maxMinutes * 60;
  const timeLimitSec = Math.min(maxSec, ask.timeLimitSec && ask.timeLimitSec > 0 ? Math.floor(ask.timeLimitSec) : maxSec);
  const plain: OutboundPlan = { decision: null, provider: ask.provider ?? "", service: null, from: "", tsa: "", timeLimitSec };

  // Messenger's "to" is a page-scoped id, not a number: no country / pattern to check.
  if (ask.kind !== "message" || isE164(ask.to)) {
    const why = permissionRefusal(ask.to, p);
    if (why) refuse(ask, "route-refused", why);
  }
  if (ask.kind === "message") return plain;

  const budget = ask.kind === "call" ? p.outbound.callsPerHour : p.outbound.smsPerHour;
  if ((await sentLastHour(ask.kind, ask.by)) >= budget) refuse(ask, "telephony-limit", `at most ${budget} ${ask.kind === "call" ? "calls" : "SMS"} an hour for one caller (Telephony › Permissions)`);
  if (ask.kind === "sms") return plain;

  if ((await liveOutboundCalls()) >= p.outbound.maxConcurrentCalls) refuse(ask, "telephony-busy", `${p.outbound.maxConcurrentCalls} outbound calls are going on — the most at once (Telephony › Permissions)`);

  const decision = decideNow({ direction: "outbound", from: "", to: ask.to, groups: ask.groups ?? [], source: ask.source, ...(ask.provider ? { provider: ask.provider as ProviderId } : {}) });
  const t = decision.target;
  if (t.kind === "state") refuse(ask, "route-refused", decision.rule ? `the outbound rule "${decision.ruleLabel}" refuses it (${t.state})` : decision.ruleLabel === "permissions" ? decision.reasons[0] : `no outbound rule allows it — the default is ${t.state} (Telephony › Routing)`, decision);

  const plan: OutboundPlan = { ...plain, decision, service: decision.service, tsa: t.kind === "tsa" ? t.tsa : "" };
  const s = decision.service;
  if (s) plan.provider = s.provider;
  if (s?.kind === "sip") {
    const trunk = sipStore.dialCredentials(s.trunk);
    if (!trunk) refuse(ask, "not-configured", `the outbound rule "${decision.ruleLabel}" dials over the SIP trunk "${s.trunk}", which no longer exists (Telephony › SIP trunks)`, decision);
    plan.via = {
      kind: "sip",
      trunk: { id: trunk.id, host: trunk.host, ...(trunk.username ? { username: trunk.username } : {}), ...(trunk.password ? { password: trunk.password } : {}) },
      ...(s.callerId.name || trunk.callerIdName ? { callerName: s.callerId.name || trunk.callerIdName } : {}),
      presentation: s.callerId.presentation,
    };
    plan.from = s.callerId.number || trunk.callerIdNumber || "";
  }
  telLog({
    kind: "route", level: "info", direction: "outbound", rule: decision.rule ?? "",
    summary: `call to ${ask.to} → ${targetText(t)} through ${serviceText(s)}${decision.rule ? ` (rule "${decision.ruleLabel}")` : " (default)"}`,
    // The decision is logged; the trunk's password never is (plan.via is not).
    parsed: { ask: { ...ask, groups: ask.groups ?? [] }, decision, from: plan.from, timeLimitSec },
  });
  return plan;
}
