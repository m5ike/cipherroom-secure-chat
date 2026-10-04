// @vitest-environment node
// 6.10 — the Android NFC tool runs application templates
// (server/android/design-610-nfc.ts; android/…/nfc/TemplateRunner,
// TemplateViews, ApduTemplates; ui/parts/NfcWorkbench): the JVM tests read the
// standard set from a fixture that must stay the contract's
// (client/src/lib/nfc/apdu-templates.ts STANDARD_APDU_TEMPLATES); every text the
// app shows of it exists in Czech, English and German; the readable view's
// English fallbacks say what the design says; the area adds texts only, so a
// build does not need a newer app for them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DESIGN, DEFAULT_STRINGS } from "../server/android/design";
import { designMinAppCode } from "../server/android/bundle";
import { AREA, NFC_610_STRINGS } from "../server/android/design-610-nfc";
import { STANDARD_APDU_TEMPLATES, standardTemplatesJson, templateProblems } from "../client/src/lib/nfc/apdu-templates";

const root = join(__dirname, "..");
const java = (p: string) => readFileSync(join(root, "android/app/src/main/java/cz/m5cet/app", p), "utf8");
const LANGS = ["cs", "en", "de"] as const;
const strings = DEFAULT_STRINGS as Record<(typeof LANGS)[number], Record<string, string>>;

describe("android NFC application templates (6.10)", () => {
  it("the JVM tests' standard set is the contract's", () => {
    const fixture = JSON.parse(readFileSync(join(root, "android/app/src/test/resources/nfc/standard-apdu-templates.json"), "utf8"));
    expect(fixture).toEqual(standardTemplatesJson());
    expect(fixture.length).toBe(STANDARD_APDU_TEMPLATES.length);
    for (const t of fixture) expect(templateProblems(t)).toEqual([]);
  });

  it("every text of the area exists in Czech, English and German, and reaches the design", () => {
    const keys = Object.keys(NFC_610_STRINGS.en).sort();
    expect(keys.length).toBeGreaterThan(100);
    for (const lang of LANGS) {
      expect(Object.keys(NFC_610_STRINGS[lang]).sort()).toEqual(keys);
      for (const k of keys) {
        expect(NFC_610_STRINGS[lang][k as keyof typeof NFC_610_STRINGS.en].trim(), `${lang} ${k}`).not.toBe("");
        expect(strings[lang][k], `${lang} ${k}`).toBe(NFC_610_STRINGS[lang][k as keyof typeof NFC_610_STRINGS.en]);
      }
    }
    // Natural Czech, with its diacritics.
    expect(NFC_610_STRINGS.cs["nfc.tpl.hold"]).toBe("Přiložte kartu k telefonu — šablona provede všechny své kroky.");
    expect(NFC_610_STRINGS.cs["nfc.out.toMyself"]).toBe("Ponechat jen pro sebe");
    expect(NFC_610_STRINGS.de["nfc.out.forward"]).toBe("An einen Benutzer weiterleiten");
    // The placeholders are the same in every language.
    for (const k of keys) {
      const ph = (s: string) => (s.match(/\{\d\}/g) ?? []).sort().join();
      for (const lang of LANGS) expect(ph(NFC_610_STRINGS[lang][k as keyof typeof NFC_610_STRINGS.en]), `${lang} ${k}`).toBe(ph(NFC_610_STRINGS.en[k as keyof typeof NFC_610_STRINGS.en]));
    }
  });

  it("every key the app's NFC tool uses is in the design, in all three languages", () => {
    const used = new Set<string>();
    for (const src of [java("ui/parts/NfcWorkbench.java"), java("nfc/TemplateRunner.java"), java("nfc/TemplateViews.java")])
      for (const m of src.matchAll(/"(nfc\.(?:tpl|out|emv|eid)\.[A-Za-z0-9.]+)"/g)) used.add(m[1]);
    // t("nfc.tpl.group." + g) — the groups by card type.
    for (const g of ["emv", "emrtd", "desfire", "iso7816", "other"]) used.add(`nfc.tpl.group.${g}`);
    used.delete("nfc.tpl.group.");
    expect(used.size).toBeGreaterThan(120);
    for (const k of used) for (const lang of LANGS) expect(strings[lang][k], `${lang} ${k}`).toBeTruthy();
  });

  it("the readable view's English fallbacks say what the design says", () => {
    const src = java("nfc/TemplateViews.java");
    const pairs = [...src.matchAll(/en\("([^"]+)", "((?:[^"\\]|\\.)*)"\)/g)].map((m) => [m[1], JSON.parse(`"${m[2]}"`)] as const);
    expect(pairs.length).toBeGreaterThan(100);
    for (const [k, v] of pairs) expect(strings.en[k], k).toBe(v);
    // Every note the runner gives a step has its words.
    const notes = [...java("nfc/TemplateRunner.java").matchAll(/note\("(nfc\.tpl\.n\.[A-Za-z]+)"/g)].map((m) => m[1]);
    expect(notes.length).toBeGreaterThan(10);
    for (const k of notes) expect(pairs.some(([p]) => p === k), k).toBe(true);
  });

  it("the area adds texts only — no element, action or screen a build would need a newer app for", () => {
    expect(AREA.elements ?? []).toEqual([]);
    expect(AREA.actions ?? []).toEqual([]);
    expect(AREA.trees ?? {}).toEqual({});
    expect(designMinAppCode(DEFAULT_DESIGN)).toBeLessThanOrEqual(61000);
  });
});
