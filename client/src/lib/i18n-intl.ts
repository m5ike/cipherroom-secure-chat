// 6.13: Intl for the nine languages — the BCP 47 tag of a language
// (lib/locales.ts › LOCALE_INFO[code].tag) and cached formatters, collators
// and plural rules built with it. PURE (no DOM): the client, vitest and the
// server's tsx use the same code. Every formatter falls back to something
// readable when the runtime's Intl does not know a locale or an option.

import { LOCALE_INFO, isLocale, type Locale } from "./locales";

/** The BCP 47 tag for Intl and <html lang> ("cs" → "cs-CZ"); a tag stays as it is ("sk-SK", <html lang>); anything else → English. */
export function langTag(lang: string | null | undefined): string {
  if (isLocale(lang)) return LOCALE_INFO[lang].tag;
  if (typeof lang === "string" && /^[a-z]{2,3}-[A-Za-z0-9]{2,8}$/.test(lang)) return lang;
  return LOCALE_INFO.en.tag;
}

/** The language the page is shown in (<html lang>, set by the app), for code that is not handed one. */
export function documentLang(): string {
  return (typeof document !== "undefined" && document.documentElement?.getAttribute("lang")) || "en";
}

const cache = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  let v = cache.get(key) as T | undefined;
  if (v === undefined) { v = make(); cache.set(key, v); }
  return v;
}

/** Intl.NumberFormat for a language (cached per options). */
export function numberFormat(lang: string, opts: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const tag = langTag(lang);
  return cached(`n|${tag}|${JSON.stringify(opts)}`, () => {
    try { return new Intl.NumberFormat(tag, opts); } catch { return new Intl.NumberFormat("en-GB", opts.style === "unit" ? { maximumFractionDigits: opts.maximumFractionDigits } : opts); }
  });
}

/** Intl.DateTimeFormat for a language and a time zone (cached). */
export function dateFormat(lang: string, opts: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  const tag = langTag(lang);
  return cached(`d|${tag}|${JSON.stringify(opts)}`, () => {
    try { return new Intl.DateTimeFormat(tag, opts); } catch { const { timeZone: _tz, ...rest } = opts; return new Intl.DateTimeFormat(tag, rest); }
  });
}

/** Intl.RelativeTimeFormat ("před 5 min", "vor 5 Min.", "il y a 5 min"). */
export function relativeFormat(lang: string, style: Intl.RelativeTimeFormatStyle = "short"): Intl.RelativeTimeFormat | null {
  const tag = langTag(lang);
  return cached(`r|${tag}|${style}`, () => {
    try { return new Intl.RelativeTimeFormat(tag, { numeric: "always", style }); } catch { return null; }
  });
}

/** Intl.PluralRules (cardinal) for a language. */
export function pluralRules(lang: string): Intl.PluralRules | null {
  const tag = langTag(lang);
  return cached(`p|${tag}`, () => {
    try { return new Intl.PluralRules(tag); } catch { return null; }
  });
}

/** The plural category of n in a language: one / two / few / many / other (zero only where the language has it). */
export function pluralCategory(lang: string, n: number): Intl.LDMLPluralRule {
  const rules = pluralRules(lang);
  if (rules) { try { return rules.select(n); } catch { /* not a number */ } }
  return n === 1 ? "one" : "other";
}

/** Intl.Collator for sorting names and labels (base sensitivity: "č" sorts as Czech, case does not matter). */
export function collator(lang: string, opts: Intl.CollatorOptions = {}): Intl.Collator {
  const tag = langTag(lang);
  return cached(`c|${tag}|${JSON.stringify(opts)}`, () => {
    try { return new Intl.Collator(tag, { sensitivity: "base", numeric: true, ...opts }); } catch { return new Intl.Collator(undefined, { numeric: true, ...opts }); }
  });
}

/** A comparator for Array.prototype.sort: by the language's collation, then NFC code points (stable for equal names). */
export function compareText(lang: string): (a: string, b: string) => number {
  const c = collator(lang);
  return (a, b) => {
    const x = (a ?? "").normalize("NFC"), y = (b ?? "").normalize("NFC");
    return c.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0);
  };
}

/** A number in the language's notation (1 234,5 · 1,234.5 · 1.234,5). */
export function formatNumber(n: number, lang: string, opts: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(n)) return String(n);
  return numberFormat(lang, opts).format(n);
}

export type { Locale };
