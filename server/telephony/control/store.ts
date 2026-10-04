// The Telephony & SIP control plane's settings (6.9): TelPermissions and the
// inbound / outbound routing rules. They live in the telephony data file
// (../store.ts — atomic write, mode 0600) as the sections "permissions" and
// "rules", next to the SIP trunks and the default providers. The admin
// service writes them; the main service re-reads them whenever the file's
// content changes, so a saved rule applies to the next call without a
// restart.
//
// Everything that comes in is checked here: rule ids, priorities (= the
// list's order: 10, 20, 30…), number patterns and SIP URI globs, time
// windows (IANA zones), caller ID numbers (E.164), SIP trunks that exist,
// providers that can carry a call, TSA ids and states; limits are clamped to
// sane ranges (and the clamping is reported). A save with problems is
// refused with all of them. A hand-edited file is read leniently: a broken
// rule is switched off, a broken limit falls back to its default, and the
// reason goes to the module's log once.

import { randomBytes } from "node:crypto";
import {
  DEFAULT_PERMISSIONS,
  type CallerId, type InboundRule, type OutboundRule, type RouteService, type RouteTarget, type TelPermissions, type TimeWindow,
} from "./types";
import { TSA_ID } from "../tsa/types";
import { dataFilePath, dataFileSignature, loadTelephonyFile, saveTelephonyFile } from "../store";
import { sipStore } from "../sip";
import { isE164 } from "../types";
import { GROUP_ID_RE } from "../../../client/src/lib/modules";
import { patternProblem, windowProblem } from "./match";
import { telHooks, telLog } from "./hooks";
import { setTsaUsageSource, tsaStore } from "../tsa/store";

export type Problem = { path: string; message: string };
type StateTarget = Extract<RouteTarget, { kind: "state" }>;

/** The providers that can carry a call (an application or a SIP trunk through them). */
export const CALL_PROVIDERS = ["twilio", "telnyx", "vonage"] as const;
export const ROUTE_STATES = ["busy", "congestion", "hangup", "rejected"] as const;
export const ROUTE_SOURCES = ["function", "tsa", "console", "api"] as const;
export const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const RULE_LIMITS = { rules: 200, patterns: 100, groups: 50, label: 80, note: 500, countries: 250, hosts: 100, callerName: 64 } as const;

/** [min, max] of every number in TelPermissions (the console shows them next to the fields). */
export const PERMISSION_BOUNDS = {
  "outbound.maxConcurrentCalls": [1, 1000],
  "outbound.callsPerHour": [1, 10_000],
  "outbound.smsPerHour": [1, 10_000],
  "outbound.maxMinutes": [1, 1440],
  "inbound.maxConcurrentCalls": [1, 1000],
  "inbound.perCallerPerHour": [1, 10_000],
  "inroute.maxTtlSec": [60, 604_800],
  "inroute.maxActivePerOwner": [1, 10_000],
  "inroute.maxAttemptsPerCall": [1, 10],
  "inroute.maxFailuresPerCallerPerHour": [1, 1000],
  "tsa.recordingDays": [1, 3650],
  "log.days": [1, 3650],
} as const satisfies Record<string, readonly [number, number]>;

/* ------------------------------------------------------------- checking */

class Checker {
  problems: Problem[] = [];
  notes: string[] = [];
  problem(path: string, message: string): void { if (this.problems.length < 200) this.problems.push({ path, message }); }
  note(text: string): void { if (this.notes.length < 200) this.notes.push(text); }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
// eslint-disable-next-line no-control-regex
const text = (v: unknown, max: number): string => str(v).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
const freshId = (prefix: string) => `${prefix}-${randomBytes(3).toString("hex")}`;

function num(c: Checker, path: keyof typeof PERMISSION_BOUNDS, v: unknown, fallback: number): number {
  const [min, max] = PERMISSION_BOUNDS[path];
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) { c.problem(path, "a number"); return fallback; }
  const r = Math.round(n);
  const out = Math.max(min, Math.min(max, r));
  if (out !== r) c.note(`${path}: ${r} → ${out} (allowed ${min}–${max})`);
  return out;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function patterns(c: Checker, path: string, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { c.problem(path, "a list of patterns"); return []; }
  if (raw.length > RULE_LIMITS.patterns) c.problem(path, `at most ${RULE_LIMITS.patterns} patterns`);
  const out: string[] = [];
  raw.slice(0, RULE_LIMITS.patterns).forEach((p, i) => {
    const why = patternProblem(p);
    if (why) c.problem(`${path}[${i}]`, why);
    else if (!out.includes((p as string).trim())) out.push((p as string).trim());
  });
  return out;
}

function timeWindow(c: Checker, path: string, raw: unknown): TimeWindow | null {
  if (raw === undefined || raw === null || raw === false || raw === "") return null;
  const o = obj(raw);
  const w: TimeWindow = { timezone: str(o.timezone) || "UTC", days: str(o.days) || "*", from: str(o.from) || "00:00", to: str(o.to) || "24:00" };
  const why = windowProblem(w);
  if (why) c.problem(path, why);
  return w;
}

function target(c: Checker, path: string, raw: unknown, allowPass: boolean): RouteTarget {
  const t = obj(raw);
  const kind = str(t.kind);
  if (kind === "tsa") {
    const id = str(t.tsa);
    if (!TSA_ID.test(id)) c.problem(`${path}.tsa`, "a TSA id (a-z, 0-9, -; 2–48 characters)");
    return { kind: "tsa", tsa: id };
  }
  if (kind === "state") {
    const state = str(t.state);
    if (!(ROUTE_STATES as readonly string[]).includes(state)) c.problem(`${path}.state`, `one of ${ROUTE_STATES.join(", ")}`);
    return { kind: "state", state: (ROUTE_STATES as readonly string[]).includes(state) ? state as StateTarget["state"] : "busy" };
  }
  if (kind === "pass") {
    if (!allowPass) c.problem(path, "\"pass\" is for outbound calls only — an inbound call needs a TSA or a state");
    return { kind: "pass" };
  }
  c.problem(path, allowPass ? "the target: tsa, state or pass" : "the target: tsa or state");
  return { kind: "state", state: "busy" };
}

function callerId(c: Checker, path: string, raw: unknown): CallerId {
  const o = obj(raw);
  const number = str(o.number);
  if (number && !isE164(number)) c.problem(`${path}.number`, "an E.164 number (+420…) the provider lets you present, or empty");
  // A SIP display name: no quotes / angle brackets / backslashes (header injection), no control characters.
  const name = text(o.name, RULE_LIMITS.callerName).replace(/["<>\\]/g, "").trim();
  const p = str(o.presentation);
  if (p && p !== "allowed" && p !== "restricted") c.problem(`${path}.presentation`, "allowed or restricted");
  return { number, name, presentation: p === "restricted" ? "restricted" : "allowed" };
}

function service(c: Checker, path: string, raw: unknown, checkTrunks: boolean): RouteService {
  const s = obj(raw);
  const kind = str(s.kind);
  const provider = str(s.provider);
  if (!(CALL_PROVIDERS as readonly string[]).includes(provider)) c.problem(`${path}.provider`, `a provider that carries calls: ${CALL_PROVIDERS.join(", ")}`);
  const p = provider as RouteService["provider"];
  if (kind === "sip") {
    const trunk = str(s.trunk);
    if (!trunk) c.problem(`${path}.trunk`, "the SIP trunk (Telephony › SIP trunks)");
    else if (checkTrunks && !sipStore.get(trunk)) c.problem(`${path}.trunk`, `no SIP trunk "${trunk.slice(0, 64)}" (Telephony › SIP trunks)`);
    return { kind: "sip", provider: p, trunk, callerId: callerId(c, `${path}.callerId`, s.callerId) };
  }
  if (kind !== "app") c.problem(`${path}.kind`, "app (the provider's application: its API key and secret) or sip (a SIP trunk)");
  return { kind: "app", provider: p };
}

function ruleList(c: Checker, raw: unknown, dir: string): unknown[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(obj(raw).rules) ? obj(raw).rules as unknown[] : null;
  if (!list) { c.problem(dir, "a list of rules"); return []; }
  if (list.length > RULE_LIMITS.rules) c.problem(dir, `at most ${RULE_LIMITS.rules} rules`);
  return list.slice(0, RULE_LIMITS.rules);
}

function ruleHead(c: Checker, o: Record<string, unknown>, path: string, i: number, prefix: string, ids: Set<string>) {
  const id = str(o.id) || freshId(prefix);
  if (!RULE_ID.test(id)) c.problem(`${path}.id`, "a rule id: letters, digits, - and _ (up to 64)");
  else if (ids.has(id.toLowerCase())) c.problem(`${path}.id`, `the id "${id}" is used twice`);
  ids.add(id.toLowerCase());
  return { id, label: text(o.label, RULE_LIMITS.label) || id, enabled: o.enabled !== false, priority: (i + 1) * 10 };
}

/** Strict checks a save; lenient switches off a rule with problems (a hand-edited file). */
type Mode = { lenient: boolean; checkTrunks: boolean };
const STRICT: Mode = { lenient: false, checkTrunks: true };

/** The inbound list (order = priority: 10, 20, 30…). */
export function checkInbound(raw: unknown, mode: Mode = STRICT): { rules: InboundRule[]; problems: Problem[]; notes: string[] } {
  const c = new Checker();
  const ids = new Set<string>();
  const rules = ruleList(c, raw, "inbound").map((r, i): InboundRule => {
    const o = obj(r);
    const path = `inbound[${i}]`;
    const before = c.problems.length;
    const m = obj(o.match);
    const provider = str(m.provider);
    if (provider && !(CALL_PROVIDERS as readonly string[]).includes(provider)) c.problem(`${path}.match.provider`, `empty (any) or ${CALL_PROVIDERS.join(", ")}`);
    const svc = str(m.service);
    if (svc && svc !== "app" && svc !== "sip") c.problem(`${path}.match.service`, "empty (any), app or sip");
    const rule: InboundRule = {
      ...ruleHead(c, o, path, i, "in", ids),
      match: {
        numbers: patterns(c, `${path}.match.numbers`, m.numbers),
        from: patterns(c, `${path}.match.from`, m.from),
        provider: provider as InboundRule["match"]["provider"],
        service: svc as InboundRule["match"]["service"],
        hours: timeWindow(c, `${path}.match.hours`, m.hours),
      },
      target: target(c, `${path}.target`, o.target, false),
      record: o.record === true,
      note: text(o.note, RULE_LIMITS.note),
    };
    if (mode.lenient && c.problems.length > before) { rule.enabled = false; c.note(`inbound rule "${rule.id}" switched off: ${c.problems[before].path}: ${c.problems[before].message}`); }
    return rule;
  });
  return { rules, problems: mode.lenient ? [] : c.problems, notes: c.notes };
}

/** The outbound list (order = priority). */
export function checkOutbound(raw: unknown, mode: Mode = STRICT): { rules: OutboundRule[]; problems: Problem[]; notes: string[] } {
  const c = new Checker();
  const ids = new Set<string>();
  const rules = ruleList(c, raw, "outbound").map((r, i): OutboundRule => {
    const o = obj(r);
    const path = `outbound[${i}]`;
    const before = c.problems.length;
    const m = obj(o.match);
    const groups: string[] = [];
    for (const g of Array.isArray(m.groups) ? m.groups : []) {
      const id = str(g).toLowerCase();
      if (!GROUP_ID_RE.test(id)) c.problem(`${path}.match.groups`, `"${id.slice(0, 32)}" is not a group id (Modules & groups)`);
      else if (!groups.includes(id)) groups.push(id);
    }
    if (m.groups !== undefined && !Array.isArray(m.groups)) c.problem(`${path}.match.groups`, "a list of group ids");
    if (groups.length > RULE_LIMITS.groups) c.problem(`${path}.match.groups`, `at most ${RULE_LIMITS.groups} groups`);
    const sources: OutboundRule["match"]["sources"] = [];
    for (const s of Array.isArray(m.sources) ? m.sources : []) {
      const v = str(s);
      if (!(ROUTE_SOURCES as readonly string[]).includes(v)) c.problem(`${path}.match.sources`, `one of ${ROUTE_SOURCES.join(", ")}`);
      else if (!(sources as string[]).includes(v)) sources.push(v as OutboundRule["match"]["sources"][number]);
    }
    const rule: OutboundRule = {
      ...ruleHead(c, o, path, i, "out", ids),
      match: { to: patterns(c, `${path}.match.to`, m.to), groups: groups.slice(0, RULE_LIMITS.groups), sources, hours: timeWindow(c, `${path}.match.hours`, m.hours) },
      service: service(c, `${path}.service`, o.service, mode.checkTrunks),
      target: target(c, `${path}.target`, o.target, true),
      note: text(o.note, RULE_LIMITS.note),
    };
    if (mode.lenient && c.problems.length > before) { rule.enabled = false; c.note(`outbound rule "${rule.id}" switched off: ${c.problems[before].path}: ${c.problems[before].message}`); }
    return rule;
  });
  return { rules, problems: mode.lenient ? [] : c.problems, notes: c.notes };
}

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * TelPermissions over `base` (the stored ones): what `raw` leaves out stays,
 * numbers are clamped, lists are checked item by item.
 */
export function checkPermissions(raw: unknown, base: TelPermissions = DEFAULT_PERMISSIONS): { permissions: TelPermissions; problems: Problem[]; notes: string[] } {
  const c = new Checker();
  const r = obj(raw);
  const ob = obj(r.outbound), ib = obj(r.inbound), ir = obj(r.inroute), ts = obj(r.tsa), lg = obj(r.log), df = obj(r.defaults);

  let countries = base.outbound.countries;
  if (ob.countries !== undefined) {
    countries = [];
    if (!Array.isArray(ob.countries)) c.problem("outbound.countries", "a list of ISO 3166 codes (CZ, SK, DE…); empty = any");
    for (const x of Array.isArray(ob.countries) ? ob.countries : []) {
      const code = str(x).toUpperCase();
      if (!/^([A-Z]{2}|001)$/.test(code)) c.problem("outbound.countries", `"${code.slice(0, 8)}" is not an ISO 3166 alpha-2 code`);
      else if (!countries.includes(code)) countries.push(code);
    }
    if (countries.length > RULE_LIMITS.countries) c.problem("outbound.countries", `at most ${RULE_LIMITS.countries}`);
  }
  const blocked = ob.blocked !== undefined ? patterns(c, "outbound.blocked", ob.blocked) : base.outbound.blocked;

  let httpHosts = base.tsa.httpHosts;
  if (ts.httpHosts !== undefined) {
    httpHosts = [];
    if (!Array.isArray(ts.httpHosts)) c.problem("tsa.httpHosts", "a list of hosts (api.example.com, *.example.com)");
    for (const x of Array.isArray(ts.httpHosts) ? ts.httpHosts : []) {
      const host = str(x).toLowerCase();
      if (!HOST_RE.test(host) || host.length > 253) c.problem("tsa.httpHosts", `"${host.slice(0, 40)}" is not a host name (api.example.com or *.example.com)`);
      else if (!httpHosts.includes(host)) httpHosts.push(host);
    }
    if (httpHosts.length > RULE_LIMITS.hosts) c.problem("tsa.httpHosts", `at most ${RULE_LIMITS.hosts}`);
  }

  const permissions: TelPermissions = {
    outbound: {
      countries: countries.slice(0, RULE_LIMITS.countries),
      blocked,
      maxConcurrentCalls: num(c, "outbound.maxConcurrentCalls", ob.maxConcurrentCalls, base.outbound.maxConcurrentCalls),
      callsPerHour: num(c, "outbound.callsPerHour", ob.callsPerHour, base.outbound.callsPerHour),
      smsPerHour: num(c, "outbound.smsPerHour", ob.smsPerHour, base.outbound.smsPerHour),
      maxMinutes: num(c, "outbound.maxMinutes", ob.maxMinutes, base.outbound.maxMinutes),
    },
    inbound: {
      maxConcurrentCalls: num(c, "inbound.maxConcurrentCalls", ib.maxConcurrentCalls, base.inbound.maxConcurrentCalls),
      perCallerPerHour: num(c, "inbound.perCallerPerHour", ib.perCallerPerHour, base.inbound.perCallerPerHour),
    },
    inroute: {
      maxTtlSec: num(c, "inroute.maxTtlSec", ir.maxTtlSec, base.inroute.maxTtlSec),
      maxActivePerOwner: num(c, "inroute.maxActivePerOwner", ir.maxActivePerOwner, base.inroute.maxActivePerOwner),
      maxAttemptsPerCall: num(c, "inroute.maxAttemptsPerCall", ir.maxAttemptsPerCall, base.inroute.maxAttemptsPerCall),
      maxFailuresPerCallerPerHour: num(c, "inroute.maxFailuresPerCallerPerHour", ir.maxFailuresPerCallerPerHour, base.inroute.maxFailuresPerCallerPerHour),
    },
    tsa: {
      httpHosts: httpHosts.slice(0, RULE_LIMITS.hosts),
      functions: bool(ts.functions, base.tsa.functions),
      recordingDays: num(c, "tsa.recordingDays", ts.recordingDays, base.tsa.recordingDays),
    },
    log: {
      days: num(c, "log.days", lg.days, base.log.days),
      keepRaw: bool(lg.keepRaw, base.log.keepRaw),
    },
    defaults: {
      inbound: df.inbound !== undefined ? target(c, "defaults.inbound", df.inbound, false) : base.defaults.inbound,
      outbound: df.outbound !== undefined ? target(c, "defaults.outbound", df.outbound, true) : base.defaults.outbound,
    },
  };
  return { permissions, problems: c.problems, notes: c.notes };
}

/* ---------------------------------------------------------- persistence */

type RulesSection = { inbound: InboundRule[]; outbound: OutboundRule[]; updatedAt: number; updatedBy: string };
type Loaded = { permissions: TelPermissions; inbound: InboundRule[]; outbound: OutboundRule[]; meta: { permissions: { updatedAt: number; updatedBy: string }; rules: { updatedAt: number; updatedBy: string } } };

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x); }
  return v;
}

let cache: { sig: string; file: string; loaded: Loaded } | null = null;

/** The stored settings, re-read when the file's content changes (the other process saved). Frozen. */
function loaded(): Loaded {
  const file = dataFilePath();
  const sig = dataFileSignature();
  if (cache && cache.sig === sig && cache.file === file) return cache.loaded;
  const { data } = loadTelephonyFile();
  const lenient: Mode = { lenient: true, checkTrunks: false };
  const p = data.permissions === undefined ? { permissions: DEFAULT_PERMISSIONS, problems: [], notes: [] } : checkPermissions(data.permissions);
  const rs = obj(data.rules);
  const ib = checkInbound(Array.isArray(rs.inbound) ? rs.inbound : [], lenient);
  const ob = checkOutbound(Array.isArray(rs.outbound) ? rs.outbound : [], lenient);
  const issues = [...p.problems.map((x) => `permissions ${x.path}: ${x.message}`), ...ib.notes, ...ob.notes];
  if (issues.length) telLog({ kind: "config", level: "warn", summary: `the telephony data file's routing settings have problems (${issues.length}); read leniently`, parsed: { file, issues: issues.slice(0, 50) } });
  const pm = obj(data.permissionsMeta);
  const loadedNow: Loaded = deepFreeze({
    permissions: p.permissions,
    inbound: ib.rules,
    outbound: ob.rules,
    meta: {
      permissions: { updatedAt: Number(pm.updatedAt) || 0, updatedBy: str(pm.updatedBy) },
      rules: { updatedAt: Number(rs.updatedAt) || 0, updatedBy: str(rs.updatedBy) },
    },
  });
  cache = { sig, file, loaded: loadedNow };
  return loadedNow;
}

export function getPermissions(): TelPermissions { return loaded().permissions; }
export function getRules(): { inbound: InboundRule[]; outbound: OutboundRule[] } { const l = loaded(); return { inbound: l.inbound, outbound: l.outbound }; }
export function controlMeta(): Loaded["meta"] { return loaded().meta; }

export type SaveResult<T> = { ok: true; value: T; notes: string[] } | { ok: false; message: string; problems: Problem[] };

const refused = (problems: Problem[]): { ok: false; message: string; problems: Problem[] } =>
  ({ ok: false, message: `${problems.length === 1 ? "A problem" : `${problems.length} problems`}: ${problems[0].path} — ${problems[0].message}`, problems });

/** PUT /admin/telephony/permissions. */
export function savePermissions(raw: unknown, by: string): SaveResult<TelPermissions> {
  const r = checkPermissions(raw, loaded().permissions);
  if (r.problems.length) return refused(r.problems);
  const { data } = loadTelephonyFile(); // read-modify-write keeps the other sections
  const w = saveTelephonyFile({ ...data, permissions: r.permissions, permissionsMeta: { updatedAt: Date.now(), updatedBy: by.slice(0, 80) } });
  if (!w.ok) return { ok: false, message: w.message, problems: [] };
  cache = null;
  telLog({ kind: "config", level: "notice", summary: `permissions saved by ${by.slice(0, 80)}${r.notes.length ? ` (${r.notes.length} value(s) clamped)` : ""}`, parsed: { permissions: r.permissions, notes: r.notes } });
  return { ok: true, value: getPermissions(), notes: r.notes };
}

/** PUT /admin/telephony/rules/inbound|outbound — replaces the list (its order is the priority). */
export function saveRules(direction: "inbound" | "outbound", raw: unknown, by: string): SaveResult<InboundRule[] | OutboundRule[]> {
  const r = direction === "inbound" ? checkInbound(raw) : checkOutbound(raw);
  // 6.9: a rule's TSA should exist and be published — said as a note (a TSA can also be
  // created or deleted later; its calls fail with a log line until it is there).
  for (const rule of r.rules) {
    if (rule.target.kind !== "tsa") continue;
    const tsa = tsaStore.get(rule.target.tsa);
    if (!tsa) r.notes.push(`${rule.label || rule.id}: there is no TSA "${rule.target.tsa}" — its calls fail until there is`);
    else if (!tsa.published) r.notes.push(`${rule.label || rule.id}: the TSA "${tsa.name}" is not published yet — its calls fail until it is`);
  }
  if (r.problems.length) return refused(r.problems);
  const { data } = loadTelephonyFile();
  const cur = obj(data.rules);
  const next: RulesSection = {
    inbound: direction === "inbound" ? r.rules as InboundRule[] : Array.isArray(cur.inbound) ? cur.inbound as InboundRule[] : [],
    outbound: direction === "outbound" ? r.rules as OutboundRule[] : Array.isArray(cur.outbound) ? cur.outbound as OutboundRule[] : [],
    updatedAt: Date.now(),
    updatedBy: by.slice(0, 80),
  };
  const w = saveTelephonyFile({ ...data, rules: next });
  if (!w.ok) return { ok: false, message: w.message, problems: [] };
  cache = null;
  telLog({ kind: "config", level: "notice", summary: `${direction} rules saved by ${by.slice(0, 80)}: ${r.rules.length} rule(s)`, parsed: { direction, rules: r.rules } });
  return { ok: true, value: direction === "inbound" ? getRules().inbound : getRules().outbound, notes: r.notes };
}

/** Tests: forget the cached settings. */
export function resetControlCache(): void { cache = null; }

// The current TelPermissions for every part (telPermissions() in hooks.ts).
telHooks.permissions = getPermissions;

// 6.9: which rules (and defaults) use a TSA — the TSA list's "used by" and its delete guard.
setTsaUsageSource((id) => {
  const out: string[] = [];
  const { inbound, outbound } = getRules();
  for (const r of inbound) if (r.target.kind === "tsa" && r.target.tsa === id) out.push(`inbound: ${r.label || r.id}`);
  for (const r of outbound) if (r.target.kind === "tsa" && r.target.tsa === id) out.push(`outbound: ${r.label || r.id}`);
  const d = getPermissions().defaults;
  if (d.inbound.kind === "tsa" && d.inbound.tsa === id) out.push("default: inbound");
  if (d.outbound.kind === "tsa" && d.outbound.tsa === id) out.push("default: outbound");
  return out;
});
