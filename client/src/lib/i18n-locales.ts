// 6.13: the languages that are not compiled in — one module (and so one
// chunk) each, lib/i18n-locales/<lang>.ts, which bundles that language's
// i18n/locales/<lang>/web*.json. Only the chosen language is downloaded.

import type { Locale } from "./locales";

/** The files of one language, by name without ".json" (web, web-sysmsg, web-nfc-fn, web-extra). */
export type LocaleFiles = Partial<Record<string, Record<string, string>>>;

/** The JSON files the web client reads, in the order they are merged (a later file wins a shared key). */
export const LOCALE_FILE_NAMES = ["web-sysmsg", "web", "web-extra", "web-nfc-fn"] as const;

/**
 * import.meta.glob's result → { web: {...}, "web-extra": {...} }. Null when
 * the glob is not available (plain Node / tsx: the caller reads the disk).
 */
export function collectLocaleFiles(glob: () => Record<string, Record<string, string>>): LocaleFiles | null {
  let found: Record<string, Record<string, string>>;
  try { found = glob(); } catch { return null; }
  const out: LocaleFiles = {};
  for (const [path, texts] of Object.entries(found ?? {})) {
    const name = path.split("/").pop()?.replace(/\.json$/, "");
    if (name && texts && typeof texts === "object") out[name] = texts;
  }
  return out;
}

type LocaleModule = { default: LocaleFiles | null };

/** The loaders of the lazily loaded languages (dynamic import → a chunk per language). */
export const LOCALE_MODULES: Partial<Record<Locale, () => Promise<LocaleModule>>> = {
  es: () => import("./i18n-locales/es"),
  it: () => import("./i18n-locales/it"),
  fr: () => import("./i18n-locales/fr"),
  sk: () => import("./i18n-locales/sk"),
  sl: () => import("./i18n-locales/sl"),
  fi: () => import("./i18n-locales/fi"),
};
