// What a routing rule's conditions mean (6.9): number patterns and weekly
// time windows. PURE — no I/O, no clock unless a time is passed — shared by
// the rules engine (rules.ts) and the validation of what the console saves
// (store.ts).
//
// Patterns (NumberPattern, types.ts):
//   "+420123456789"      exactly this number (spaces, dashes, "00" for "+" are tolerated
//                        in the value; "+" is optional on either side)
//   "+4202*"             a prefix
//   "*"                  anything (also an anonymous caller)
//   "sip:*@example.com"  a SIP URI, a glob ("*" any run, "?" one character; case-insensitive)
//   "-+1900*"            NOT this — a leading "-" excludes, and an exclusion always wins
// A number pattern also matches the user part of a SIP URI value
// ("sip:+420123456789@trunk.example.com" matches "+420*").
//
// Time windows (TimeWindow): days "mon-fri", "sat,sun", "fri-mon" (wraps),
// "*" / "" every day, "weekdays", "weekend"; from / to "HH:MM" in an IANA
// time zone; from > to is an overnight window (22:00-06:00 belongs to the day
// it starts on); from = to is the whole day.

import type { NumberPattern, TimeWindow } from "./types";

/* ------------------------------------------------------------- patterns */

const NUMBER_PATTERN = /^\+?\d{1,15}\*?$/;
const SIP_PATTERN = /^sips?:[^\s<>"'`\\]{1,200}$/i;
export const PATTERN_MAX = 200;

/** Why a pattern cannot be used, or null. */
export function patternProblem(raw: unknown): string | null {
  if (typeof raw !== "string") return "a pattern is text";
  const p = raw.trim();
  if (!p) return "an empty pattern";
  if (p.length > PATTERN_MAX) return `a pattern is at most ${PATTERN_MAX} characters`;
  const body = p.startsWith("-") ? p.slice(1) : p;
  if (body === "*" || NUMBER_PATTERN.test(body) || SIP_PATTERN.test(body)) return null;
  return `"${p.slice(0, 40)}" is neither a number pattern (+420123456789, +4202*, *) nor a SIP URI (sip:*@example.com)`;
}

/** "+420 603-123 456", "00420…" → "420603123456" (digits only), or "" when it is not a number. */
export function numberDigits(value: string): string {
  let v = value.trim().replace(/[\s().-]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  if (v.startsWith("+")) v = v.slice(1);
  return /^\d{1,20}$/.test(v) ? v : "";
}

const globCache = new Map<string, RegExp>();
function globRe(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    if (globCache.size > 2000) globCache.clear();
    globCache.set(pattern, re);
  }
  return re;
}

/** The user part of a SIP URI ("sip:+420…@host;transport=tls" → "+420…"), or null for a non-SIP value. */
function sipUser(value: string): string | null {
  const m = /^sips?:([^@;]+)@/i.exec(value.trim());
  return m ? decodeURIComponent(m[1]) : null;
}

/** Does one pattern (without its "-") match the value? */
export function patternMatches(pattern: NumberPattern, value: string): boolean {
  const p = pattern.trim();
  if (p === "*") return true;
  const v = (value ?? "").trim();
  if (/^sips?:/i.test(p)) return globRe(p).test(v);
  if (!NUMBER_PATTERN.test(p)) return false;
  const prefix = p.endsWith("*");
  const want = (prefix ? p.slice(0, -1) : p).replace(/^\+/, "");
  const digits = numberDigits(sipUser(v) ?? v);
  if (!digits) return false;
  return prefix ? digits.startsWith(want) : digits === want;
}

export type ListMatch = { ok: boolean; why: string };

/**
 * A list of patterns against a value: [] = anything; a "-" pattern that
 * matches refuses (whatever else matches); otherwise one of the positive
 * patterns must match (when there are any).
 */
export function listMatches(patterns: readonly NumberPattern[], value: string, what = "the number"): ListMatch {
  const shown = (value ?? "").trim() || "(withheld)";
  const deny = patterns.find((p) => p.trim().startsWith("-") && patternMatches(p.trim().slice(1), value));
  if (deny) return { ok: false, why: `${what} ${shown} is excluded by ${deny.trim()}` };
  const allow = patterns.map((p) => p.trim()).filter((p) => p && !p.startsWith("-"));
  if (allow.length && !allow.some((p) => patternMatches(p, value))) return { ok: false, why: `${what} ${shown} is not in [${allow.join(", ")}]` };
  return { ok: true, why: "" };
}

/* -------------------------------------------------------------- windows */

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_INDEX: Record<string, number> = Object.fromEntries(DAY_NAMES.map((d, i) => [d, i]));

/** "mon-fri", "sat,sun", "fri-mon", "*", "weekdays" → the days (0 = Sunday), or null when it does not parse. */
export function parseDays(spec: string): Set<number> | null {
  const s = (spec ?? "").trim().toLowerCase();
  if (!s || s === "*" || s === "all" || s === "daily" || s === "every day") return new Set([0, 1, 2, 3, 4, 5, 6]);
  if (s === "weekdays") return new Set([1, 2, 3, 4, 5]);
  if (s === "weekend" || s === "weekends") return new Set([0, 6]);
  const out = new Set<number>();
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^([a-z]{3})[a-z]*(?:\s*-\s*([a-z]{3})[a-z]*)?$/.exec(part);
    if (!m || DAY_INDEX[m[1]] === undefined || (m[2] && DAY_INDEX[m[2]] === undefined)) return null;
    const a = DAY_INDEX[m[1]];
    const b = m[2] ? DAY_INDEX[m[2]] : a;
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
  }
  return out.size ? out : null;
}

/** "08:00" → 480 minutes; "24:00" only where `end`; null when it does not parse. */
export function parseTime(s: string, end = false): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (min > 59) return null;
  if (h === 24 && min === 0 && end) return 1440;
  return h <= 23 ? h * 60 + min : null;
}

const zoneOk = new Map<string, boolean>();
/** Whether Intl knows the IANA time zone. */
export function validTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  let ok = zoneOk.get(tz);
  if (ok === undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); ok = true; } catch { ok = false; }
    if (zoneOk.size > 500) zoneOk.clear();
    zoneOk.set(tz, ok);
  }
  return ok;
}

/** Why a window cannot be used, or null. */
export function windowProblem(w: unknown): string | null {
  if (!w || typeof w !== "object") return "a time window is { timezone, days, from, to }";
  const t = w as Partial<TimeWindow>;
  if (!validTimeZone(String(t.timezone ?? ""))) return `unknown time zone "${String(t.timezone ?? "").slice(0, 40)}" (an IANA zone, e.g. Europe/Prague)`;
  if (!parseDays(String(t.days ?? ""))) return `days "${String(t.days ?? "").slice(0, 40)}": mon-fri, sat,sun, fri-mon, * …`;
  if (parseTime(String(t.from ?? "")) === null) return `from "${String(t.from ?? "").slice(0, 10)}": HH:MM`;
  if (parseTime(String(t.to ?? ""), true) === null) return `to "${String(t.to ?? "").slice(0, 10)}": HH:MM (24:00 for the end of the day)`;
  return null;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** The weekday (0 = Sunday) and minutes since midnight at `at` in the zone. */
export function localTime(at: number, timezone: string): { day: number; minutes: number; label: string } {
  let f = fmtCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (fmtCache.size > 200) fmtCache.clear();
    fmtCache.set(timezone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const day = DAY_INDEX[String(parts.weekday ?? "").slice(0, 3).toLowerCase()] ?? 0;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return { day, minutes: hour * 60 + minute, label: `${DAY_NAMES[day]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

export const windowText = (w: TimeWindow) => `${w.days || "*"} ${w.from}-${w.to} ${w.timezone}`;

/** Is `at` inside the window? With the local time, for the reasons. */
export function inWindow(w: TimeWindow, at: number): ListMatch {
  const problem = windowProblem(w);
  if (problem) return { ok: false, why: `the time window is broken: ${problem}` };
  const days = parseDays(w.days)!;
  const from = parseTime(w.from)!;
  const to = parseTime(w.to, true)!;
  const now = localTime(at, w.timezone);
  let ok: boolean;
  if (from === to || (from === 0 && to === 1440)) ok = days.has(now.day);
  else if (from < to) ok = days.has(now.day) && now.minutes >= from && now.minutes < to;
  // Overnight: the evening of a listed day, or the early hours after one.
  else ok = (days.has(now.day) && now.minutes >= from) || (days.has((now.day + 6) % 7) && now.minutes < to);
  return { ok, why: ok ? `inside ${windowText(w)} (${now.label})` : `outside ${windowText(w)} (it is ${now.label} there)` };
}
