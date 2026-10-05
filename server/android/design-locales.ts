// The Android design's texts in the six languages translators added in 6.13
// (i18n/locales/<lang>/android.json — flat { key: text } for every key of
// i18n/source/android.json; npx tsx script/i18n-check.ts <lang> checks one).
// Imported, not read at run time: the server ships as one bundle (dist/),
// without the i18n directory. A language without a table yet has {} here —
// the app then falls back along its chain (Slovak → Czech → English).

import type { Locale } from "../../client/src/lib/locales";
import es from "../../i18n/locales/es/android.json";
import it from "../../i18n/locales/it/android.json";
import fr from "../../i18n/locales/fr/android.json";
import sk from "../../i18n/locales/sk/android.json";
import sl from "../../i18n/locales/sl/android.json";
import fi from "../../i18n/locales/fi/android.json";

/** The languages whose design texts come from translators' tables (en, cs, de are the design's TypeScript). */
export const TRANSLATED_LANGS = ["es", "it", "fr", "sk", "sl", "fi"] as const satisfies readonly Locale[];
export type TranslatedLang = typeof TRANSLATED_LANGS[number];

export const ANDROID_TRANSLATIONS: Record<TranslatedLang, Record<string, string>> = {
  es: es as Record<string, string>,
  it: it as Record<string, string>,
  fr: fr as Record<string, string>,
  sk: sk as Record<string, string>,
  sl: sl as Record<string, string>,
  fi: fi as Record<string, string>,
};
