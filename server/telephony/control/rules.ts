// The routing rules engine (6.9): which inbound / outbound rule a call meets,
// and — for the console's dry run and the log — why every rule before it did
// not. decideWith() is PURE: it gets the rules, the permissions and the time
// (RouteQuestion.at) and returns a RouteDecision with human reasons. decide()
// asks it with the stored rules (store.ts) and is registered as
// telHooks.decide, so the webhooks and the TSA runtime route through it.
//
//   inbound   the first enabled rule (by priority) whose numbers (the DID or
//             the SIP URI dialled), from (the caller), provider, service and
//             hours all match → its target (a TSA or a state); none →
//             permissions.defaults.inbound
//   outbound  first the module's own limits that no rule overrides — a
//             country outside permissions.outbound.countries, a destination
//             in permissions.outbound.blocked → "rejected"; then the first
//             rule whose destination, the caller's groups, the source and the
//             hours match → its service (application / SIP trunk) and target
//             (a TSA, a state, or "pass" = the caller's own call logic);
//             none → permissions.defaults.outbound through the default provider

import type { InboundRule, OutboundRule, RouteDecision, RouteQuestion, RouteService, RouteTarget, TelPermissions } from "./types";
import { numberInfo } from "../numbers";
import { inWindow, listMatches, patternMatches } from "./match";
import { getPermissions, getRules } from "./store";
import { telHooks } from "./hooks";

export type RuleSet = { inbound: readonly InboundRule[]; outbound: readonly OutboundRule[]; permissions: TelPermissions };

/* ----------------------------------------------------------------- text */

export function targetText(t: RouteTarget): string {
  if (t.kind === "tsa") return `TSA ${t.tsa}`;
  if (t.kind === "state") return `state ${t.state}`;
  return "pass (the caller's own call logic)";
}

export function serviceText(s: RouteService | null): string {
  if (!s) return "the default provider";
  if (s.kind === "app") return `the ${s.provider} application`;
  const cid = s.callerId.presentation === "restricted" ? ", caller ID withheld" : s.callerId.number ? `, caller ID ${s.callerId.number}${s.callerId.name ? ` "${s.callerId.name}"` : ""}` : "";
  return `SIP trunk ${s.trunk} via ${s.provider}${cid}`;
}

const ruleName = (r: { priority: number; label: string; id: string }) => `#${r.priority} "${r.label || r.id}"`;
const byPriority = <T extends { priority: number }>(list: readonly T[]): T[] => list.map((r, i) => ({ r, i })).sort((a, b) => a.r.priority - b.r.priority || a.i - b.i).map((x) => x.r);

/* ---------------------------------------------------------- permissions */

/**
 * The module's own outbound limits a rule cannot lift: the countries calls and
 * SMS may go to, and the blocked destinations. A refusal reason, or null.
 */
export function permissionRefusal(to: string, p: TelPermissions): string | null {
  const hit = p.outbound.blocked.find((b) => patternMatches(b.replace(/^-/, ""), to));
  if (hit) return `the destination ${to} is blocked (Telephony › Permissions: ${hit})`;
  if (p.outbound.countries.length && !/^sips?:/i.test(to)) {
    const info = numberInfo(to);
    const country = info?.iso2 ?? "";
    if (!country || !p.outbound.countries.includes(country)) return `calls and messages may go only to ${p.outbound.countries.join(", ")} — ${to} is ${country ? `in ${country}` : "not a number of a known country"} (Telephony › Permissions)`;
  }
  return null;
}

/* -------------------------------------------------------------- decide */

function inboundSkip(r: InboundRule, q: RouteQuestion, at: number): string | null {
  if (!r.enabled) return "disabled";
  const m = r.match;
  if (m.provider && m.provider !== (q.provider ?? "")) return `the provider is ${q.provider || "not known"}, the rule wants ${m.provider}`;
  if (m.service && m.service !== (q.service ?? "")) return `the service is ${q.service || "not known"}, the rule wants ${m.service === "sip" ? "a SIP trunk" : "the application"}`;
  const to = listMatches(m.numbers, q.to, "the number called");
  if (!to.ok) return to.why;
  const from = listMatches(m.from, q.from, "the caller");
  if (!from.ok) return from.why;
  if (m.hours) { const w = inWindow(m.hours, at); if (!w.ok) return w.why; }
  return null;
}

function outboundSkip(r: OutboundRule, q: RouteQuestion, at: number): string | null {
  if (!r.enabled) return "disabled";
  const m = r.match;
  const to = listMatches(m.to, q.to, "the destination");
  if (!to.ok) return to.why;
  if (m.groups.length && !(q.groups ?? []).some((g) => m.groups.includes(g))) return `the caller is not in ${m.groups.join(", ")}${q.groups?.length ? ` (their groups: ${q.groups.join(", ")})` : ""}`;
  if (m.sources.length && !(q.source && m.sources.includes(q.source))) return `the call comes from ${q.source ?? "an unknown source"}, the rule takes ${m.sources.join(", ")}`;
  if (m.hours) { const w = inWindow(m.hours, at); if (!w.ok) return w.why; }
  return null;
}

/** The decision for a call with these rules and permissions — pure. */
export function decideWith(q: RouteQuestion, set: RuleSet): RouteDecision {
  const at = q.at ?? Date.now();
  const reasons: string[] = [];
  if (q.direction === "outbound") {
    const refused = permissionRefusal(q.to, set.permissions);
    if (refused) {
      reasons.push(refused, "→ refused (state rejected) before any rule");
      return { direction: "outbound", rule: null, ruleLabel: "permissions", service: null, target: { kind: "state", state: "rejected" }, reasons };
    }
    for (const r of byPriority(set.outbound)) {
      const skip = outboundSkip(r, q, at);
      if (skip) { reasons.push(`${ruleName(r)} — skipped: ${skip}`); continue; }
      reasons.push(`${ruleName(r)} — matched → ${targetText(r.target)}${r.target.kind === "state" ? "" : ` through ${serviceText(r.service)}`}`);
      return { direction: "outbound", rule: r.id, ruleLabel: r.label, service: r.service, target: r.target, reasons };
    }
    const t = set.permissions.defaults.outbound;
    reasons.push(`${set.outbound.length ? "no rule matched" : "no outbound rules"} → the default: ${targetText(t)}${t.kind === "state" ? "" : " through the default provider"}`);
    return { direction: "outbound", rule: null, ruleLabel: "default", service: null, target: t, reasons };
  }
  for (const r of byPriority(set.inbound)) {
    const skip = inboundSkip(r, q, at);
    if (skip) { reasons.push(`${ruleName(r)} — skipped: ${skip}`); continue; }
    reasons.push(`${ruleName(r)} — matched → ${targetText(r.target)}${r.record ? " (recorded)" : ""}`);
    return { direction: "inbound", rule: r.id, ruleLabel: r.label, service: null, target: r.target, reasons };
  }
  const t = set.permissions.defaults.inbound;
  reasons.push(`${set.inbound.length ? "no rule matched" : "no inbound rules"} → the default: ${targetText(t)}`);
  return { direction: "inbound", rule: null, ruleLabel: "default", service: null, target: t, reasons };
}

/** The decision with the stored rules and permissions. */
export function decideNow(q: RouteQuestion): RouteDecision {
  const { inbound, outbound } = getRules();
  return decideWith(q, { inbound, outbound, permissions: getPermissions() });
}

/** The rule a decision named (its "record" flag, its note), when it still exists. */
export function ruleOf(d: RouteDecision): InboundRule | OutboundRule | null {
  if (!d.rule) return null;
  const { inbound, outbound } = getRules();
  return (d.direction === "inbound" ? inbound : outbound).find((r) => r.id === d.rule) ?? null;
}

// The webhooks, the TSA runtime and the tests route through this.
telHooks.decide = async (q) => decideNow(q);
