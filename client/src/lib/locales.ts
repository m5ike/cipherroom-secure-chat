// The languages M5cet speaks (6.13) — the CONTRACT shared by the web client,
// the server (notifications, share pages, the Android design) and the Android
// app (a Java copy: A/core/Locales.java). Pure.
//
// English is the source language and the last fallback. Texts of a language
// live in i18n/locales/<code>/*.json (flat { key: text }); en / cs / de keep
// their TypeScript tables, the rest are generated from i18n/source/*.json
// (script/i18n-extract.ts) by translators — see i18n/GLOSSARY.md, docs/i18n.md.

export const LOCALES = ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"] as const;
export type Locale = typeof LOCALES[number];

export type LocaleInfo = {
  code: Locale;
  /** The language's own name, as the language picker shows it. */
  native: string;
  /** English name (console, logs). */
  english: string;
  /** BCP 47 tag for Intl (dates, numbers, collation, plural rules) and <html lang>. */
  tag: string;
  /** Where a missing text comes from, in order, before English. */
  fallback: readonly Locale[];
};

export const LOCALE_INFO: Readonly<Record<Locale, LocaleInfo>> = {
  en: { code: "en", native: "English", english: "English", tag: "en-GB", fallback: [] },
  cs: { code: "cs", native: "Čeština", english: "Czech", tag: "cs-CZ", fallback: [] },
  de: { code: "de", native: "Deutsch", english: "German", tag: "de-DE", fallback: [] },
  es: { code: "es", native: "Español", english: "Spanish", tag: "es-ES", fallback: [] },
  it: { code: "it", native: "Italiano", english: "Italian", tag: "it-IT", fallback: [] },
  fr: { code: "fr", native: "Français", english: "French", tag: "fr-FR", fallback: [] },
  sk: { code: "sk", native: "Slovenčina", english: "Slovak", tag: "sk-SK", fallback: ["cs"] },
  sl: { code: "sl", native: "Slovenščina", english: "Slovenian", tag: "sl-SI", fallback: [] },
  fi: { code: "fi", native: "Suomi", english: "Finnish", tag: "fi-FI", fallback: [] },
};

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** The best supported language for a list of BCP 47 tags (navigator.languages, Accept-Language, Android locales). */
export function pickLocale(preferred: readonly string[] | string | undefined | null, fallback: Locale = "en"): Locale {
  const list = Array.isArray(preferred) ? preferred : typeof preferred === "string" ? preferred.split(",") : [];
  for (const raw of list) {
    const code = raw.trim().split(";")[0].toLowerCase().split(/[-_]/)[0];
    if (isLocale(code)) return code;
  }
  return fallback;
}

/** The chain a text is looked up in: the language, its fallbacks, then English. */
export function localeChain(code: Locale): Locale[] {
  const chain: Locale[] = [code, ...LOCALE_INFO[code].fallback];
  if (!chain.includes("en")) chain.push("en");
  return chain;
}
