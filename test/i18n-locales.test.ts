// 6.13: the six languages that are not compiled in (es, it, fr, sk, sl, fi):
// their files are complete against the sources, keep every placeholder and
// token, carry their own letters, and the loader brings them in — in vitest
// (import.meta.glob, as in the browser) and under plain Node (the server's
// tsx reads i18n/locales from the disk). A language whose files are not
// there yet is skipped, with the reason in the test's name.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { dictionary, extraDictionary, hasLocale, mainDictionary, t, tf, tp } from "../client/src/lib/i18n";
import { hasOwnTranslation, isLocaleLoaded, loadLocale } from "../client/src/lib/i18n-load";
import { NFC_FN_STRINGS, nfcFnText } from "../client/src/lib/i18n-nfc-fn";
import { SYSMSG_I18N } from "../client/src/lib/i18n-sysmsg";
import { LOCALE_INFO, type Locale } from "../client/src/lib/locales";

const root = resolve(import.meta.dirname, "..");
const LAZY = ["es", "it", "fr", "sk", "sl", "fi"] as const satisfies readonly Locale[];
const FORM = /#(zero|one|two|few|many|other)$/;
const base = (k: string) => k.replace(FORM, "");
const fileOf = (lang: string, name: string) => join(root, "i18n", "locales", lang, `${name}.json`);
const read = (lang: string, name: string) => JSON.parse(readFileSync(fileOf(lang, name), "utf8")) as Record<string, string>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

/** The letters each language cannot do without (its translation must use them, as real characters). */
const OWN_LETTERS: Record<(typeof LAZY)[number], string[]> = {
  es: ["ñ", "á", "é", "í", "ó", "ú"],
  it: ["à", "è", "é", "ò", "ù"],
  fr: ["é", "è", "à", "ç", "ê"],
  sk: ["ľ", "ô", "ä", "č", "š", "ž", "ť", "ň", "ď", "ý", "ĺ", "ŕ"],
  sl: ["č", "š", "ž"],
  fi: ["ä", "ö"],
};

/** The sources: what every language must have (the English of each key). */
const SOURCES: Record<string, Record<string, string>> = {
  web: mainDictionary("en") as Record<string, string>,
  "web-sysmsg": SYSMSG_I18N.en as Record<string, string>,
  "web-nfc-fn": NFC_FN_STRINGS.en,
  "web-extra": extraDictionary("en") as Record<string, string>,
};

describe.each(LAZY)("the %s translation", (lang) => {
  const present = existsSync(fileOf(lang, "web"));
  const maybe = present ? it : it.skip;
  const label = present ? "" : ` (skipped: i18n/locales/${lang}/web.json is not there yet)`;
  const cats = new Set<string>(new Intl.PluralRules(LOCALE_INFO[lang].tag).resolvedOptions().pluralCategories);

  for (const name of Object.keys(SOURCES)) {
    maybe(`${name}.json has every key of the source, none empty, none extra${label}`, () => {
      const src = SOURCES[name];
      const out = read(lang, name);
      // A plural form of the source is there as that form, or as the plain key, or the language has no such form.
      const missing = Object.keys(src).filter((k) => {
        if (k in out) return false;
        const form = FORM.exec(k)?.[1];
        return !(form && (base(k) in out || !cats.has(form)));
      });
      expect(missing).toEqual([]);
      const empty = Object.entries(out).filter(([k, v]) => !v.trim() && (src[k] ?? src[base(k)] ?? "x").trim()).map(([k]) => k);
      expect(empty).toEqual([]);
      const srcBases = new Set(Object.keys(src).map(base));
      const extra = Object.keys(out).filter((k) => !(k in src) && !(FORM.test(k) && srcBases.has(base(k)) && cats.has(FORM.exec(k)![1])));
      expect(extra).toEqual([]);
    });

    maybe(`${name}.json keeps every {placeholder}${label}`, () => {
      const src = SOURCES[name];
      const wrong: string[] = [];
      for (const [k, v] of Object.entries(read(lang, name))) {
        const en = src[k] ?? src[`${base(k)}#other`] ?? src[base(k)];
        if (en !== undefined && placeholders(en) !== placeholders(v)) wrong.push(`${k}: {${placeholders(v)}} vs en {${placeholders(en)}}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  maybe(`has the plural forms its rules use for every counter (one and other at least)${label}`, () => {
    const out = read(lang, "web-extra");
    const counters = new Set(Object.keys(SOURCES["web-extra"]).filter((k) => FORM.test(k)).map(base));
    const missing: string[] = [];
    for (const c of counters) for (const form of ["one", "other"]) if (!(`${c}#${form}` in out)) missing.push(`${c}#${form}`);
    expect(missing).toEqual([]);
    const bad = Object.keys(out).filter((k) => FORM.test(k) && !cats.has(FORM.exec(k)![1]));
    expect(bad).toEqual([]);
  });

  maybe(`is UTF-8, NFC, and written with the language's own letters${label}`, () => {
    let all = "";
    for (const name of Object.keys(SOURCES)) {
      const raw = readFileSync(fileOf(lang, name));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      expect(text.charCodeAt(0)).not.toBe(0xfeff); // no BOM
      for (const v of Object.values(JSON.parse(text) as Record<string, string>)) { expect(v).toBe(v.normalize("NFC")); all += v; }
    }
    for (const letter of OWN_LETTERS[lang]) expect(all, `${lang} uses ${letter}`).toContain(letter);
  });

  maybe(`loads lazily and is what t() / tp() / nfcFnText() show${label}`, async () => {
    expect(await loadLocale(lang)).toBe(true);
    expect(isLocaleLoaded(lang)).toBe(true);
    expect(hasOwnTranslation(lang)).toBe(true);
    expect(hasLocale(lang)).toBe(true);
    const web = read(lang, "web");
    for (const key of ["common.close", "menu.settings", "chat.empty.title", "sec.identity.changedFlash"]) expect(t(lang, key)).toBe(web[key]);
    expect(tf(lang, "app.peerEntered", { name: "Žofie" })).toBe(web["app.peerEntered"].replace("{name}", "Žofie"));
    const extra = read(lang, "web-extra");
    expect(t(lang, "tel.call")).toBe(extra["tel.call"]);
    const one = extra["away.received#one"].replace("{n}", "1");
    expect(tp(lang, "away.received", 1)).toBe(one);
    expect(nfcFnText(lang, "nfcfn.done")).toBe(read(lang, "web-nfc-fn")["nfcfn.done"]);
    // Every key of the English table resolves to the language's own text (nothing falls through to English by accident).
    const en = dictionary("en");
    const same = Object.keys(web).filter((k) => t(lang, k) !== web[k]);
    expect(same).toEqual([]);
    expect(Object.keys(en).every((k) => t(lang, k) !== k)).toBe(true);
  });
});

describe("the loader", () => {
  beforeAll(async () => { await Promise.all(LAZY.map((l) => loadLocale(l))); });

  it("leaves the built-in languages as they are and resolves at once", async () => {
    expect(await loadLocale("cs")).toBe(true);
    expect(t("cs", "common.close")).toBe("Zavřít");
    expect(t("de", "common.close")).toBe("Schließen");
  });

  it("shows the key for a key nobody has, in every language", () => {
    for (const l of [...LAZY, "en", "cs", "de"] as Locale[]) expect(t(l, "no.such.key")).toBe("no.such.key");
  });

  it("works under plain Node (the server's tsx): the files come from the disk", () => {
    const script = [
      "import { loadLocale } from './client/src/lib/i18n-load.ts';",
      "import { t, tp } from './client/src/lib/i18n.ts';",
      "const ok = await loadLocale('fi');",
      "console.log(JSON.stringify({ ok, close: t('fi', 'common.close'), call: t('fi', 'tel.call'), two: tp('fi', 'acc.loaded', 2) }));",
    ].join("\n");
    const out = execFileSync(join(root, "node_modules", ".bin", "tsx"), ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", timeout: 60_000 });
    const got = JSON.parse(out.trim().split("\n").pop()!) as { ok: boolean; close: string; call: string; two: string };
    expect(got.ok).toBe(existsSync(fileOf("fi", "web")));
    if (got.ok) {
      expect(got.close).toBe(read("fi", "web")["common.close"]);
      expect(got.call).toBe(read("fi", "web-extra")["tel.call"]);
      expect(got.two).toBe(read("fi", "web-extra")["acc.loaded#other"].replace("{n}", "2"));
    }
  }, 60_000);
});
