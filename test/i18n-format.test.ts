// 6.13: formatting in the nine languages — Intl with each language's tag
// for dates, numbers, sizes, durations and relative times; plural forms
// (Intl.PluralRules: Czech / Slovak few, Slovenian dual, Finnish, French 0);
// collation (Intl.Collator: "ch" after "h" in Czech, "å ä ö" last in
// Finnish); the menu / layout template filters; fonts that draw every letter.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatBytes, formatDateTime, formatDuration, formatFullDate, formatRelative, formatSpeed, formatTime } from "../client/src/lib/format";
import { collator, compareText, formatNumber, langTag, pluralCategory } from "../client/src/lib/i18n-intl";
import { t, tp } from "../client/src/lib/i18n";
import { loadLocale } from "../client/src/lib/i18n-load";
import { LOCALES, type Locale } from "../client/src/lib/locales";
import { renderTemplate } from "../client/src/lib/menu-template";
import { FONTS, FONT_SAMPLES, GOOGLE_FONTS, LATIN_EXT_LANGS, fontSample, googleCssUrl, needsLatinExt } from "../client/src/lib/fonts";
import { fold, matchText } from "../client/src/lib/suggest";

const root = resolve(import.meta.dirname, "..");
const LAZY: Locale[] = ["es", "it", "fr", "sk", "sl", "fi"];
const spaces = (s: string) => s.replace(/[  ]/g, " ");
// 2026-09-22 14:05 UTC
const TS = Date.UTC(2026, 8, 22, 14, 5, 0);

beforeAll(async () => { await Promise.all(LAZY.map((l) => loadLocale(l))); });

describe("Intl per language", () => {
  it("every language has its BCP 47 tag", () => {
    expect(LOCALES.map(langTag)).toEqual(["en-GB", "cs-CZ", "de-DE", "es-ES", "it-IT", "fr-FR", "sk-SK", "sl-SI", "fi-FI"]);
    expect(langTag("xx")).toBe("en-GB");
    expect(langTag("sk-SK")).toBe("sk-SK");
  });

  it("spells the month in the language", () => {
    const months: Record<Locale, RegExp> = {
      en: /22 September 2026/, cs: /22\. září 2026/, de: /22\. September 2026/, es: /22 de septiembre de 2026/, it: /22 settembre 2026/,
      fr: /22 septembre 2026/, sk: /22\. septembra 2026/, sl: /22\. september 2026/, fi: /22\. syyskuuta 2026/,
    };
    for (const l of LOCALES) {
      const s = spaces(formatFullDate(TS, l, "UTC"));
      expect(s, l).toMatch(months[l]);
      expect(s, l).toMatch(/14[:.]05/);
    }
  });

  it("writes the clock in the language's notation", () => {
    expect(formatTime(TS, "en", "UTC")).toBe("14:05:00");
    expect(formatTime(TS, "fi", "UTC")).toBe("14.05.00");
    expect(formatTime(TS, "sk", "Europe/Bratislava")).toMatch(/16:05:00/);
    expect(formatDateTime(TS, "cs", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" })).toMatch(/22\.\s?09\.\s?26|22\. 9\. 26/);
    expect(formatDateTime(null, "cs")).toBe("");
  });

  it("formats numbers: decimal comma, the right grouping", () => {
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
    expect(spaces(formatNumber(1234.5, "cs"))).toBe("1 234,5");
    expect(formatNumber(1234.5, "de")).toBe("1.234,5");
    expect(spaces(formatNumber(1234.5, "fr"))).toBe("1 234,5");
    expect(spaces(formatNumber(12345.5, "es"))).toBe("12.345,5");
    expect(formatNumber(12345.5, "it")).toBe("12.345,5");
    expect(spaces(formatNumber(1234.5, "sk"))).toBe("1 234,5");
    expect(formatNumber(12345.5, "sl")).toBe("12.345,5");
    expect(spaces(formatNumber(1234.5, "fi"))).toBe("1 234,5");
  });

  it("formats sizes with the language's units (French octets, Finnish tavu)", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
    expect(spaces(formatBytes(2048, "cs"))).toBe("2,0 kB");
    expect(spaces(formatBytes(2048, "fr"))).toBe("2,0 ko");
    expect(spaces(formatBytes(512, "fr"))).toBe("512 o");
    expect(spaces(formatBytes(3.5 * 1024 * 1024, "fi"))).toBe("3,5 Mt");
    expect(spaces(formatBytes(1.5 * 1024 ** 3, "de"))).toBe("1,5 GB");
    expect(spaces(formatSpeed(1_200_000, "sk"))).toBe("1,1 MB/s");
    expect(formatSpeed(0, "sk")).toBe("—");
  });

  it("formats durations — compact, or spelled out with Intl's own plural", () => {
    expect(formatDuration(45_000, "en")).toBe("45 s");
    expect(formatDuration(65 * 60_000, "en")).toBe("1 h 5 min");
    expect(formatDuration(65 * 60_000, "cs")).toBe("1 h 5 min");
    expect(spaces(formatDuration(65 * 60_000, "de"))).toBe("1 Std. 5 Min.");
    expect(spaces(formatDuration(7 * 60_000, "cs", "long"))).toBe("7 minut");
    expect(spaces(formatDuration(3 * 60_000, "cs", "long"))).toBe("3 minuty");
    expect(spaces(formatDuration(2 * 60_000, "sl", "long"))).toBe("2 minuti");
    expect(spaces(formatDuration(5 * 60_000, "fi", "long"))).toBe("5 minuuttia");
  });

  it("says how long ago in every language (Intl.RelativeTimeFormat)", () => {
    const now = TS, at = now - 5 * 60_000;
    const want: Record<Locale, string> = {
      en: "5 min ago", cs: "před 5 min", de: "vor 5 Min.", es: "hace 5 min", it: "5 min fa",
      fr: "il y a 5 min", sk: "pred 5 min", sl: "pred 5 min.", fi: "5 min sitten",
    };
    for (const l of LOCALES) expect(spaces(formatRelative(at, l, now)!), l).toBe(want[l]);
  });
});

describe("plural forms", () => {
  it("Intl.PluralRules gives each language its categories", () => {
    expect([1, 2, 3, 5].map((n) => pluralCategory("cs", n))).toEqual(["one", "few", "few", "other"]);
    expect([1, 4, 5, 0].map((n) => pluralCategory("sk", n))).toEqual(["one", "few", "other", "other"]);
    expect([1, 2, 3, 5, 101, 102, 103].map((n) => pluralCategory("sl", n))).toEqual(["one", "two", "few", "other", "one", "two", "few"]);
    expect([0, 1, 2].map((n) => pluralCategory("fr", n))).toEqual(["one", "one", "other"]);
    expect([1, 2].map((n) => pluralCategory("fi", n))).toEqual(["one", "other"]);
    expect([1, 2].map((n) => pluralCategory("de", n))).toEqual(["one", "other"]);
  });

  it("tp() picks the form: Czech one / few / other", () => {
    expect(tp("cs", "away.received", 1)).toBe("Doručena 1 zpráva, která přišla během vaší nepřítomnosti.");
    expect(tp("cs", "away.received", 3)).toBe("Doručeny 3 zprávy, které přišly během vaší nepřítomnosti.");
    expect(tp("cs", "away.received", 5)).toBe("Doručeno 5 zpráv, které přišly během vaší nepřítomnosti.");
    expect(tp("en", "app.recipients", 1)).toBe("1 recipient");
    expect(tp("en", "app.recipients", 2)).toBe("2 recipients");
    expect(spaces(tp("cs", "ai.stats", 1234, { s: "1,2" }))).toBe("1,2 s · 1 234 tokenů");
  });

  it("Slovak few, Slovenian dual and few, Finnish, French zero", () => {
    expect(tp("sk", "files.active", 1)).toBe("Prebieha 1 prenos:");
    expect(tp("sk", "files.active", 3)).toBe("Prebiehajú 3 prenosy:");
    expect(tp("sk", "files.active", 7)).toBe("Prebieha 7 prenosov:");
    expect(tp("sl", "acc.loaded", 1)).toBe("Podatki dešifrirani in naloženi (1 sporočilo).");
    expect(tp("sl", "acc.loaded", 2)).toBe("Podatki dešifrirani in naloženi (2 sporočili).");
    expect(tp("sl", "acc.loaded", 4)).toBe("Podatki dešifrirani in naloženi (4 sporočila).");
    expect(tp("sl", "acc.loaded", 5)).toBe("Podatki dešifrirani in naloženi (5 sporočil).");
    expect(tp("sl", "acc.loaded", 102)).toBe("Podatki dešifrirani in naloženi (102 sporočili).");
    expect(tp("fi", "notify.channel.devices", 1)).toBe("1 laite");
    expect(tp("fi", "notify.channel.devices", 2)).toBe("2 laitetta");
    expect(tp("fr", "data.restored", 0)).toBe("0 message restauré.");
    expect(tp("fr", "data.restored", 2)).toBe("2 messages restaurés.");
  });

  it("falls back to the plain key, then along the chain, then to the key", () => {
    // Spanish has no forms for this one: its plain text.
    expect(tp("es", "rooms.bar.unreadCount", 3)).toBe("3 sin leer");
    // A counter the translators' web.json has plain, without forms in that language: the plain text, {n} filled.
    expect(tp("es", "suggest.more", 4)).toContain("4");
    expect(tp("fi", "no.such.counter", 2)).toBe("no.such.counter");
  });
});

describe("collation (Intl.Collator)", () => {
  it("sorts Czech with ch after h and the háčky after their letter", () => {
    const names = ["Šárka", "Zdeněk", "Chrudoš", "Čeněk", "Hana", "Cyril", "Sára", "Řehoř", "Radek"];
    expect([...names].sort(compareText("cs"))).toEqual(["Cyril", "Čeněk", "Hana", "Chrudoš", "Radek", "Řehoř", "Sára", "Šárka", "Zdeněk"]);
  });

  it("sorts Finnish å ä ö after z, Slovak ä after a, Spanish ñ after n", () => {
    expect(["Öljy", "Åke", "Zorro", "Äiti", "Aatu"].sort(compareText("fi"))).toEqual(["Aatu", "Zorro", "Åke", "Äiti", "Öljy"]);
    expect(["bábka", "bäčik", "bazén"].sort(compareText("sk"))[0]).toBe("bábka");
    expect(["ñu", "nube", "oso"].sort(compareText("es"))).toEqual(["nube", "ñu", "oso"]);
  });

  it("ignores case, compares numbers as numbers, and treats NFC and NFD alike", () => {
    expect(collator("en").compare("room 9", "room 10")).toBeLessThan(0);
    expect(compareText("cs")("žena", "Žena".toLowerCase())).toBe(0);
    expect(compareText("sk")("ľ".normalize("NFD"), "ľ")).toBe(0);
  });
});

describe("the template language in nine languages", () => {
  const translate = (lang: Locale) => (key: string) => t(lang, key);

  it("{$n|tp:'key'} and {$x|tf:'key':'name'}", () => {
    expect(renderTemplate("{$n|tp:'files.active'}", { n: 3 }, { translate: translate("cs"), lang: "cs" })).toBe("Probíhají 3 přenosy:");
    expect(renderTemplate("{$n|tp:'files.active'}", { n: 2 }, { translate: translate("sl"), lang: "sl" })).toBe("V teku sta 2 prenosa:");
    expect(renderTemplate("{$d|tf:'trust.since':'date'}", { d: "1. 10." }, { translate: translate("de"), lang: "de" })).toBe("seit 1. 10.");
  });

  it("bytes, duration and the weekday follow the language", () => {
    expect(spaces(renderTemplate("{$x|bytes}", { x: 2048 }, { lang: "fr" }))).toBe("2,0 ko");
    expect(renderTemplate("{$x|bytes}", { x: 2048 }, {})).toBe("2,0 kB");
    expect(spaces(renderTemplate("{$x|duration}", { x: 300_000 }, { lang: "de" }))).toBe("5 Min.");
    const monday = new Date(2026, 9, 5, 12, 0, 0).getTime();
    expect(renderTemplate("{$d|date:'D'}", { d: monday }, {})).toBe("Po");
    expect(renderTemplate("{$d|date:'D'}", { d: monday }, { lang: "fi" })).toBe("ma");
  });
});

describe("characters", () => {
  it("search ignores diacritics in every language's letters", () => {
    expect(fold("Ľubomír Šťastný · Ñandú · Œuvre · Åsa Öberg · Straße · Čeština").text).toBe("lubomir stastny · nandu · oeuvre · asa oberg · strasse · cestina");
    expect(matchText("zofie", "Žofie")?.tier).toBe("exact");
    expect(matchText("lub", "Ľubica")?.tier).toBe("prefix");
    expect(matchText("rene", "René".normalize("NFD"))?.tier).toBe("exact");
  });

  it("every font stack ends in a generic family (a system font that draws any letter a web font lacks)", () => {
    for (const f of FONTS.filter((x) => x.id !== "theme")) expect(f.stack, f.id).toMatch(/(sans-serif|serif|monospace|cursive)$/);
    // A Google family is never alone: system fonts follow it in its stack.
    for (const f of GOOGLE_FONTS) expect(f.stack.split(",").length, f.id).toBeGreaterThan(2);
  });

  it("Google families come through css2 with every unicode-range subset (latin-ext where the family has it)", () => {
    for (const f of GOOGLE_FONTS) {
      const url = googleCssUrl(f);
      expect(url).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=/);
      expect(url).not.toMatch(/[&?](text|subset)=/);
    }
    // Verified against fonts.googleapis.com (6.13): only Orbitron lacks latin-ext — its stack's system fonts draw č ř ž.
    expect(GOOGLE_FONTS.filter((f) => !f.czech).map((f) => f.label)).toEqual(["Orbitron"]);
    expect([...LATIN_EXT_LANGS]).toEqual(["cs", "sk", "sl"]);
    expect(needsLatinExt("sk") && !needsLatinExt("fi")).toBe(true);
  });

  it("the theme stacks (themes.css, index.css) end in a generic family", () => {
    for (const file of ["themes.css", "index.css"]) {
      const css = readFileSync(join(root, "client", "src", file), "utf8");
      for (const m of css.matchAll(/--font-(sans|mono|serif)\s*:\s*([^;]+);/g)) expect(m[2].trim(), `${file} ${m[0]}`).toMatch(/(sans-serif|serif|monospace|var\(--[\w-]+\))$/);
    }
  });

  it("the font preview shows each language's own letters", () => {
    expect(fontSample("sk")).toMatch(/[ľĺŕôä]/);
    expect(fontSample("sl")).toMatch(/[čšž]/);
    expect(fontSample("fi")).toMatch(/[åäö]/);
    expect(fontSample("fr")).toMatch(/[œçé]/);
    expect(fontSample("es")).toMatch(/[ñü]/);
    expect(fontSample("xx")).toBe(FONT_SAMPLES.cs);
  });

  it("every HTML page the client ships declares UTF-8 first and a language", () => {
    const pages = readdirSync(join(root, "client")).filter((f) => f.endsWith(".html"));
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages) {
      const html = readFileSync(join(root, "client", page), "utf8");
      expect(html, page).toMatch(/<head>\s*<meta charset="UTF-8"\s*\/?>/i);
      expect(html, page).toMatch(/<html lang="[a-z]{2}/);
    }
  });
});
