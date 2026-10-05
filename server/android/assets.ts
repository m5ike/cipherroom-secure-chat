// The files the Android app ships with (script/android-assets.ts writes
// them): the default design and the icon set. Pure functions, so a test can
// compare them with what is committed.

import { MENU_ICONS } from "../../client/src/lib/menu-icons-data";
import { DEFAULT_DESIGN, designRev, sanitizeDesign } from "./design";
import { androidThemes } from "./themes";
import { THEMES_67_LOOK } from "./design-67-look";
import { LOCALES, LOCALE_INFO, localeChain, pickLocale } from "../../client/src/lib/locales";

/** Counts the plural vectors cover: 0–130, the hundreds' edges, and millions (es / it / fr "many"). */
const PLURAL_COUNTS = [...Array.from({ length: 131 }, (_, i) => i), 199, 200, 201, 202, 203, 204, 205, 211, 212, 1000, 1001, 1002, 1003, 1_000_000, 1_000_001, 2_000_000, 21_000_000];
/** Language lists pickLocale is asked about (arrays: Android's LocaleList; strings: Accept-Language). */
const PICK_CASES: Array<readonly string[] | string> = [
  ["sk-SK", "cs-CZ"], ["sk"], ["cs-CZ"], ["de-AT", "en-US"], ["en-US"], ["pl-PL", "fi-FI"], ["fil-PH", "sl-SI"], ["pt-BR"], [], ["zh_Hant_TW", "it_IT"],
  ["FR-ca"], [" es-419 "], ["nb-NO", "de-CH"],
  "sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7", "de-DE;q=0.9", "fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5", "*", "", "sl", "es-ES,es", "ja,zh;q=0.5", " it ; q=1",
];

/**
 * 6.13: what the app's JVM tests check core/Locales.java and core/Plurals.java
 * against — the contract (client/src/lib/locales.ts) and Intl.PluralRules,
 * written by script/android-assets.ts into the test resources.
 */
export function androidTestVectors(): Record<string, string> {
  const locales = LOCALES.map((code) => ({ ...LOCALE_INFO[code], fallback: [...LOCALE_INFO[code].fallback], chain: localeChain(code) }));
  const pick = PICK_CASES.map((input) => ({ in: typeof input === "string" ? input : [...input], out: pickLocale(input) }));
  const plurals = Object.fromEntries(LOCALES.map((code) => {
    const rules = new Intl.PluralRules(LOCALE_INFO[code].tag);
    return [LOCALE_INFO[code].tag, Object.fromEntries(PLURAL_COUNTS.map((n) => [String(n), rules.select(n)]))];
  }));
  return { "locales-vectors.json": `${JSON.stringify({ locales, pick, plurals }, null, 1)}\n` };
}

export function androidAssets(): Record<string, string> {
  const design = sanitizeDesign(DEFAULT_DESIGN);
  design.rev = designRev(design);
  // The icons without lucide's React keys: name → [[tag, attributes]].
  const icons = Object.fromEntries(Object.entries(MENU_ICONS).map(([name, children]) => [
    name,
    children.map(([tag, attrs]) => [tag, Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== "key"))]),
  ]));
  return {
    "default-design.json": `${JSON.stringify(design)}\n`,
    "icons.json": `${JSON.stringify(icons)}\n`,
    // 6.1: the web's templates, mapped onto the design's colour tokens (Settings › Appearance);
    // 6.7: then the app's own (design-67-look.ts), each with a light and a dark palette.
    "themes.json": `${JSON.stringify([...androidThemes(), ...THEMES_67_LOOK])}\n`,
  };
}
