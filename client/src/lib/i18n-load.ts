// 6.13: loading a language that is not compiled in (es, it, fr, sk, sl, fi).
//
//   await loadLocale("sk")   → i18n/locales/sk/web*.json registered (and cs,
//                              its fallback, is built in) — t("sk", …) works
//
// In the browser and in vitest the files come from the language's own chunk
// (lib/i18n-locales/<lang>.ts, import.meta.glob); under plain Node (the
// server's tsx) from the disk: $M5_I18N_DIR or <cwd>/i18n/locales. A missing
// or broken file is not an error — t() falls back along localeChain to
// English and finally shows the key. Resolves true when the language's main
// file (web.json) was found.

import { hasLocale, isBuiltinLang, registerLocale, type Lang } from "./i18n";
import { registerNfcFnStrings } from "./i18n-nfc-fn";
import { LOCALE_FILE_NAMES, LOCALE_MODULES, type LocaleFiles } from "./i18n-locales";
import { isLocale, localeChain } from "./locales";

const loading = new Map<Lang, Promise<boolean>>();
const found = new Map<Lang, boolean>();

type NodeProcess = { versions?: { node?: string }; cwd?: () => string; env?: Record<string, string | undefined> };

/** Plain Node (no import.meta.glob): read i18n/locales/<lang>/web*.json from the disk. */
async function fromDisk(lang: Lang): Promise<LocaleFiles | null> {
  const proc = (globalThis as { process?: NodeProcess }).process;
  if (!proc?.versions?.node || typeof proc.cwd !== "function") return null;
  try {
    // Names in variables: a bundler leaves them alone (the browser never gets here).
    const fsName = "node:fs/promises", pathName = "node:path";
    const fs = (await import(/* @vite-ignore */ fsName)) as typeof import("node:fs/promises");
    const path = (await import(/* @vite-ignore */ pathName)) as typeof import("node:path");
    const dir = path.join(proc.env?.M5_I18N_DIR?.trim() || path.join(proc.cwd(), "i18n", "locales"), lang);
    const out: LocaleFiles = {};
    for (const name of LOCALE_FILE_NAMES) {
      try { out[name] = JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), "utf8")) as Record<string, string>; } catch { /* absent */ }
    }
    return out;
  } catch {
    return null;
  }
}

async function filesOf(lang: Lang): Promise<LocaleFiles | null> {
  const load = LOCALE_MODULES[lang];
  if (load) {
    try {
      const files = (await load()).default;
      if (files) return files;
    } catch { /* outside Vite: import.meta.glob threw, or the chunk failed to load */ }
  }
  return fromDisk(lang);
}

/** Merges a language's files into one table and registers it (main texts and the NFC-in-Functions strings). */
export function applyLocaleFiles(lang: Lang, files: LocaleFiles): boolean {
  const merged: Record<string, string> = {};
  for (const name of LOCALE_FILE_NAMES) {
    const texts = files[name];
    if (!texts || typeof texts !== "object") continue;
    for (const [k, v] of Object.entries(texts)) if (typeof v === "string") merged[k] = v;
  }
  registerLocale(lang, merged);
  if (files["web-nfc-fn"]) registerNfcFnStrings(lang, files["web-nfc-fn"]);
  return Boolean(files.web && Object.keys(files.web).length);
}

async function loadOne(lang: Lang): Promise<boolean> {
  const files = await filesOf(lang);
  const ok = files ? applyLocaleFiles(lang, files) : false;
  if (!files || !hasLocale(lang)) registerLocale(lang, {});
  found.set(lang, ok);
  return ok;
}

/**
 * Makes a language's texts available (and those of its fallbacks). Built-in
 * languages resolve at once. Never rejects; true when the language has its
 * own translation (web.json), false when it shows the fallback texts.
 */
export function loadLocale(lang: Lang): Promise<boolean> {
  if (!isLocale(lang)) return Promise.resolve(false);
  if (isBuiltinLang(lang)) return Promise.resolve(true);
  const had = loading.get(lang);
  if (had) return had;
  const p = (async () => {
    // The chain's other lazily loaded languages first (none today: sk falls back to the built-in cs).
    for (const l of localeChain(lang)) if (l !== lang && !isBuiltinLang(l)) await loadLocale(l);
    try { return await loadOne(lang); } catch { found.set(lang, false); return false; }
  })();
  loading.set(lang, p);
  return p;
}

/** Whether loadLocale() has finished for a language (built-in ones: always). */
export function isLocaleLoaded(lang: Lang): boolean {
  return isBuiltinLang(lang) || found.has(lang);
}

/** Whether the language has its own texts (web.json) — false: it shows its fallbacks. */
export function hasOwnTranslation(lang: Lang): boolean {
  return isBuiltinLang(lang) || found.get(lang) === true;
}
