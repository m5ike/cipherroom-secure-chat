// Human-readable formatting helpers shared by the client UI.
//
// 6.13: every one in the language's own notation through Intl with the
// language's BCP 47 tag (lib/locales.ts › LOCALE_INFO[code].tag): dates and
// times, numbers, file sizes (fr "ko", fi "kt"), durations ("5 Min.",
// "1 h 5 min") and relative times ("před 5 min", "il y a 5 min"). PURE — the
// server's tsx imports it through menu-template.ts.

import type { Lang } from "./i18n";
import { dateFormat, formatNumber, numberFormat, relativeFormat } from "./i18n-intl";

export { formatNumber };

const tz = (timezone?: string) => (timezone ? { timeZone: timezone } : {});

export function formatTime(value: number, lang: Lang, timezone: string) {
  try {
    return dateFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", ...tz(timezone) }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleTimeString();
  }
}

/** Full date + time with the month spelled out, e.g. "22. září 2026 14:05". */
export function formatFullDate(value: number, lang: Lang, timezone: string) {
  try {
    return dateFormat(lang, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", ...tz(timezone) }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

/** Compact date and time for log rows: "23. 9. 21:35:04". */
export function formatLogTime(value: number, lang: Lang, timezone: string) {
  try {
    return dateFormat(lang, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", ...tz(timezone) }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

/** A date and time in the language (what Date.prototype.toLocaleString(lang) meant), "" for no time. */
export function formatDateTime(value: number | string | Date | null | undefined, lang: Lang, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  try { return dateFormat(lang, opts).format(d); } catch { return d.toLocaleString(); }
}

/** A clock time in the language: "21:35:04" / "9:35:04 PM" (log rows, "last activity"). */
export function formatClock(value: number | null | undefined, lang: Lang): string {
  if (!value) return "—";
  try { return dateFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); } catch { return new Date(value).toLocaleTimeString(); }
}

/** The byte symbol where a language does not write "B" (French octet, Finnish tavu). */
const BYTE: Partial<Record<Lang, string>> = { fr: "o", fi: "t" };
const UNITS = ["kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** 512 B · 2.0 kB · 3,5 MB · 1,2 Go — binary steps (1024), one decimal from kB up. English when no language is given. */
export function formatBytes(value: number, lang: Lang = "en") {
  if (!Number.isFinite(value)) return "";
  const n = Math.max(0, value);
  if (n < 1024) return `${formatNumber(Math.round(n), lang)} ${BYTE[lang] ?? "B"}`;
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1; }
  try {
    return numberFormat(lang, { style: "unit", unit: UNITS[i], unitDisplay: "short", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
  } catch {
    return `${v.toFixed(1)} ${["kB", "MB", "GB", "TB"][i]}`;
  }
}

/** A transfer speed: "1.2 MB/s". */
export function formatSpeed(bytesPerSecond: number, lang: Lang = "en"): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond, lang)}/s`;
}

const unit = (n: number, u: "second" | "minute" | "hour" | "day", lang: Lang, display: "short" | "long" | "narrow") => {
  if (lang === "en" && display === "short") return `${formatNumber(n, lang)} ${u === "second" ? "s" : u === "minute" ? "min" : u === "hour" ? "h" : "d"}`;
  try { return numberFormat(lang, { style: "unit", unit: u, unitDisplay: display }).format(n); } catch { return `${n} ${u[0]}`; }
};

/**
 * A length of time: "45 s", "5 min", "1 h 5 min", "3 d 4 h" (short), or
 * "5 minutes" / "5 minut" / "5 Minuten" (long — Intl does the plural).
 * English short keeps the compact s / min / h / d.
 */
export function formatDuration(ms: number, lang: Lang = "en", display: "short" | "long" = "short"): string {
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return unit(sec, "second", lang, display);
  const min = Math.floor(sec / 60);
  if (min < 60) return unit(min, "minute", lang, display);
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${unit(h, "hour", lang, display)} ${unit(min % 60, "minute", lang, display)}` : unit(h, "hour", lang, display);
  const d = Math.floor(h / 24);
  return h % 24 ? `${unit(d, "day", lang, display)} ${unit(h % 24, "hour", lang, display)}` : unit(d, "day", lang, display);
}

/** How long ago: "5 min ago", "před 5 min", "vor 5 Min." (Intl.RelativeTimeFormat); null when the runtime cannot. */
export function formatRelative(at: number, lang: Lang, now = Date.now(), style: Intl.RelativeTimeFormatStyle = "short"): string | null {
  const rtf = relativeFormat(lang, style);
  if (!rtf || !Number.isFinite(at)) return null;
  const diff = Math.max(0, now - at);
  const min = Math.floor(diff / 60_000);
  if (min < 60) return rtf.format(-Math.max(1, min), "minute");
  const h = Math.floor(min / 60);
  if (h < 24) return rtf.format(-h, "hour");
  return rtf.format(-Math.floor(h / 24), "day");
}
