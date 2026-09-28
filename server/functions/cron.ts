// A small cron matcher for scheduled functions (4.15, stage 4). Standard
// five fields — minute hour day-of-month month day-of-week — with `*`, `*/n`,
// `a-b`, `a-b/n` and comma lists, plus the usual named shortcuts. It answers
// "does this expression fire at this minute (in this time zone)?"; the
// scheduler checks every enabled schedule each minute, so nothing more is
// needed than a per-minute match.

export class CronError extends Error {
  constructor(message: string) { super(message); this.name = "CronError"; }
}

const SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};

const RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day of week (0 = Sunday)
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(field: string, index: number): Set<number> {
  const { min, max } = RANGES[index];
  const out = new Set<number>();
  for (let part of field.split(",")) {
    part = part.trim().toLowerCase();
    if (index === 3) for (let i = 0; i < MONTHS.length; i++) part = part.replace(MONTHS[i], String(i + 1));
    if (index === 4) { for (let i = 0; i < DOWS.length; i++) part = part.replace(DOWS[i], String(i)); part = part.replace(/\b7\b/g, "0"); }
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) { step = Number(part.slice(slash + 1)); part = part.slice(0, slash); if (!Number.isInteger(step) || step < 1) throw new CronError(`bad step in "${field}"`); }
    let lo = min, hi = max;
    if (part === "*" || part === "") { /* full range */ }
    else if (part.includes("-")) { const [a, b] = part.split("-").map(Number); if (!Number.isInteger(a) || !Number.isInteger(b)) throw new CronError(`bad range in "${field}"`); lo = a; hi = b; }
    else { const n = Number(part); if (!Number.isInteger(n)) throw new CronError(`bad value "${part}" in cron field`); lo = hi = n; }
    if (lo < min || hi > max || lo > hi) throw new CronError(`"${field}" is out of range (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domRestricted: boolean; dowRestricted: boolean };

export function parseCron(expr: string): Cron {
  const raw = (SHORTCUTS[expr.trim().toLowerCase()] ?? expr).trim().replace(/\s+/g, " ");
  const fields = raw.split(" ");
  if (fields.length !== 5) throw new CronError("a cron expression has five fields (minute hour day month weekday), or a @shortcut");
  return {
    minute: parseField(fields[0], 0),
    hour: parseField(fields[1], 1),
    dom: parseField(fields[2], 2),
    month: parseField(fields[3], 3),
    dow: parseField(fields[4], 4),
    domRestricted: fields[2].trim() !== "*",
    dowRestricted: fields[4].trim() !== "*",
  };
}

/** The wall-clock fields of `date` in `tz` (IANA name); falls back to UTC. */
function partsIn(date: Date, tz: string): { minute: number; hour: number; dom: number; month: number; dow: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour12: false, minute: "2-digit", hour: "2-digit", day: "2-digit", month: "2-digit", weekday: "short" });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { minute: Number(p.minute), hour: Number(p.hour) % 24, dom: Number(p.day), month: Number(p.month), dow: dowMap[p.weekday] ?? 0 };
  } catch {
    return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), dom: date.getUTCDate(), month: date.getUTCMonth() + 1, dow: date.getUTCDay() };
  }
}

/** Does the expression fire at `date` (to the minute) in `tz`? Vixie-cron rule:
 *  when both day-of-month and day-of-week are restricted, either matching fires. */
export function cronMatches(cron: Cron, date: Date, tz = "UTC"): boolean {
  const p = partsIn(date, tz);
  if (!cron.minute.has(p.minute) || !cron.hour.has(p.hour) || !cron.month.has(p.month)) return false;
  const dom = cron.dom.has(p.dom);
  const dow = cron.dow.has(p.dow);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

/** Validates an expression (for the console); returns the error text or null. */
export function cronError(expr: string): string | null {
  try { parseCron(expr); return null; } catch (err) { return (err as Error).message; }
}
