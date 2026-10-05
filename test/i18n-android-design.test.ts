// @vitest-environment node
//
// 6.13: the Android design in nine languages — the contract's languages, the
// translators' tables (i18n/locales/<lang>/android.json) taken whole into the
// default design with their placeholders intact, 6.13's own texts (what the
// Java side used to say in English only) in all nine, plural forms, operator
// designs with fewer languages, the bundle's files, the gating of designs an
// older app cannot follow, the sizes along the download path, and the
// vectors the app's JVM tests check Locales.java / Plurals.java against.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { LOCALES, LOCALE_INFO, localeChain } from "../client/src/lib/locales";
import * as design from "../server/android/design";
import { STRINGS_613, PLURAL_KEYS_613 } from "../server/android/design-613";
import { ANDROID_TRANSLATIONS, TRANSLATED_LANGS } from "../server/android/design-locales";
import { androidAssets, androidTestVectors } from "../server/android/assets";
import { compileDesign, designFiles, designMinAppCode, LOCALES_APP_CODE, needsLocalesApp, MIN_APP_CODE } from "../server/android/bundle";

const root = join(__dirname, "..");
const SOURCE = JSON.parse(readFileSync(join(root, "i18n", "source", "android.json"), "utf8")) as Record<string, { en: string; cs: string; de: string }>;

/** The tokens script/i18n-check.ts compares: {placeholders}, $variables, %s/%d, tags, line breaks. */
const tokens = (s: string): string => [
  ...(s.match(/\{[^{}\s]+\}/g) ?? []),
  ...(s.match(/\$[A-Za-z_][\w.]*/g) ?? []),
  ...(s.match(/%[sd]/g) ?? []),
  ...(s.match(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi) ?? []).map((t) => t.replace(/\s.*>$/, ">")),
  ...Array((s.match(/\n/g) ?? []).length).fill("\\n"),
].sort().join(" ");

describe("the design's languages are the contract's", () => {
  it("LANGS is the nine, the catalog names them", () => {
    expect([...design.LANGS].sort()).toEqual([...LOCALES].sort());
    const cat = design.androidCatalog();
    expect(cat.langs).toEqual(design.LANGS);
    for (const l of LOCALES) expect(cat.locales[l].native).toBe(LOCALE_INFO[l].native);
    expect(design.ACTIONS.find((a) => a.action === "lang.set")!.arg).toMatch(/sk \| sl \| fi/);
  });

  it("the vectors the JVM tests use are current (npx tsx script/android-assets.ts)", () => {
    for (const [name, content] of Object.entries(androidTestVectors())) {
      expect(readFileSync(join(root, "android", "app", "src", "test", "resources", "cz", "m5cet", "app", "core", name), "utf8")).toBe(content);
    }
    const v = JSON.parse(androidTestVectors()["locales-vectors.json"]) as { locales: Array<{ code: string; chain: string[] }>; pick: unknown[]; plurals: Record<string, Record<string, string>> };
    expect(v.locales.map((l) => l.code)).toEqual([...LOCALES]);
    expect(v.locales.find((l) => l.code === "sk")!.chain).toEqual(localeChain("sk"));
    expect(v.plurals["sl-SI"]["102"]).toBe("two");
    expect(v.plurals["cs-CZ"]["3"]).toBe("few");
  });
});

describe("the translators' tables are the design's", () => {
  it("there is a table for each of the six languages, with every source key", () => {
    expect([...TRANSLATED_LANGS].sort()).toEqual(["es", "fi", "fr", "it", "sk", "sl"]);
    for (const l of TRANSLATED_LANGS) {
      expect(existsSync(join(root, "i18n", "locales", l, "android.json")), l).toBe(true);
      const table = ANDROID_TRANSLATIONS[l];
      for (const key of Object.keys(SOURCE)) expect(typeof table[key], `${l} ${key}`).toBe("string");
    }
  });

  it("each translated text is in the default design as written, its placeholders as English's", () => {
    let checked = 0;
    for (const l of TRANSLATED_LANGS) {
      for (const [key, src] of Object.entries(SOURCE)) {
        const text = design.DEFAULT_STRINGS[l][key];
        if (key in STRINGS_613[l]) continue; // 6.13 replaced it (a plural's plain form)
        expect(text, `${l} ${key}`).toBe(ANDROID_TRANSLATIONS[l][key]);
        expect(tokens(text), `${l} ${key}`).toBe(tokens(src.en));
        if (src.en.trim()) expect(text.trim(), `${l} ${key} is empty`).not.toBe("");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(6 * 1400);
  });

  it("the texts are in their own scripts — diacritics, not ASCII stand-ins", () => {
    const all = (l: string) => Object.values(design.DEFAULT_STRINGS[l as keyof typeof design.DEFAULT_STRINGS]).join(" ");
    expect(all("sk")).toMatch(/[ľĺŕôä]/);
    expect(all("sl")).toMatch(/[čšž]/);
    expect(all("fi")).toMatch(/[äö]/);
    expect(all("fr")).toMatch(/[éèêàçœ]/);
    expect(all("es")).toMatch(/[ñáíóú¿¡]/);
    expect(all("it")).toMatch(/[àèéìòù]/);
    expect(design.DEFAULT_STRINGS.sk["settings.language"]).toBe("Jazyk");
    expect(design.DEFAULT_STRINGS.sk["settings.languageSystem"]).toBe("Podľa telefónu");
  });
});

describe("6.13's own texts", () => {
  const all613 = Object.keys(STRINGS_613.en);

  it("every key in all nine languages, placeholders as English's, plural forms per language", () => {
    for (const l of LOCALES) {
      for (const key of all613) {
        const text = STRINGS_613[l][key];
        expect(text, `${l} ${key}`).toBeTruthy();
        expect(design.DEFAULT_STRINGS[l][key], `${l} ${key}`).toBe(text);
        expect(tokens(text), `${l} ${key}`).toBe(tokens(STRINGS_613.en[key]));
      }
      for (const key of PLURAL_KEYS_613) expect(STRINGS_613[l][`${key}#other`], `${l} ${key}#other`).toMatch(/\{n\}/);
    }
    // Czech and Slovak have "few", Slovenian "two" and "few"
    for (const key of PLURAL_KEYS_613) {
      expect(STRINGS_613.cs[`${key}#few`], key).toBeTruthy();
      expect(STRINGS_613.sk[`${key}#few`], key).toBeTruthy();
      expect(STRINGS_613.sl[`${key}#two`], key).toBeTruthy();
      expect(STRINGS_613.sl[`${key}#few`], key).toBeTruthy();
    }
    // the plain keys of 6.12 stay (an older app reads them); their forms are added
    expect(design.DEFAULT_STRINGS.cs["p4.heldDropped"]).toBe(SOURCE["p4.heldDropped"].cs);
    expect(design.DEFAULT_STRINGS.es["set.security.duress.length"]).toBe(ANDROID_TRANSLATIONS.es["set.security.duress.length"]);
  });

  it("every key the Java side asks for by name is in every language", () => {
    const java = join(root, "android", "app", "src", "main", "java");
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".java")) files.push(p); } };
    walk(java);
    const keys = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/Texts\.[tfn]\("([\w.-]+)"/g)) keys.add(m[1]);
      for (const m of src.matchAll(/\.tn\("([\w.-]+)"/g)) keys.add(m[1]);
      for (const m of src.matchAll(/P4Texts\.tn\(app, "([\w.-]+)"/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(30);
    for (const key of keys) for (const l of LOCALES) expect(design.DEFAULT_STRINGS[l][key], `${l} ${key}`).toBeTruthy();
    // the outputs' words (fn/Words.java) too
    for (const m of readFileSync(join(java, "cz", "m5cet", "app", "fn", "Words.java"), "utf8").matchAll(/EN\.put\("([\w.-]+)"/g)) {
      for (const l of LOCALES) expect(design.DEFAULT_STRINGS[l][m[1]], `${l} ${m[1]}`).toBeTruthy();
    }
  });
});

describe("designs and bundles", () => {
  it("an operator's design with three languages keeps the rest from the defaults; plural keys are accepted", () => {
    const raw = structuredClone(design.DEFAULT_DESIGN) as unknown as Record<string, unknown>;
    raw.strings = { cs: { "rooms.title": "Pokoje" }, en: { "rooms.title": "Spaces" }, de: {}, sk: { "rooms.title": "Izby", "x.count#few": "{n} kusy", "bad key!": "x", "y#plenty": "no" } };
    const clean = design.sanitizeDesign(raw);
    expect(Object.keys(clean.strings).sort()).toEqual([...LOCALES].sort());
    expect(clean.strings.cs["rooms.title"]).toBe("Pokoje");
    expect(clean.strings.sk["rooms.title"]).toBe("Izby");
    expect(clean.strings.sk["x.count#few"]).toBe("{n} kusy");
    expect(clean.strings.sk["bad key!"]).toBeUndefined();
    expect(clean.strings.sk["y#plenty"]).toBeUndefined();
    expect(clean.strings.fi["rooms.title"]).toBe(design.DEFAULT_STRINGS.fi["rooms.title"]);
    expect(design.STRING_KEY_RE.test("a.b#many")).toBe(true);
  });

  it("a bundle carries strings/<lang>.json for all nine and says so in its manifest", () => {
    const files = designFiles(design.DEFAULT_DESIGN).map(([p]) => p);
    for (const l of LOCALES) expect(files).toContain(`strings/${l}.json`);
    const { manifest, plaintext } = compileDesign(design.DEFAULT_DESIGN, { id: "bld_t", number: 1, version: "6.13.0-b1", channel: "stable", created: 1, minAppCode: MIN_APP_CODE, notes: "" });
    expect([...manifest.languages].sort()).toEqual([...LOCALES].sort());
    // the app accepts up to 80 MB from the server (net/Server.bundle) and 64 MB unpacked (BundleFile.MAX_CONTENT)
    expect(plaintext.length).toBeLessThan(2 * 1024 * 1024);
  });

  it("only a design that switches to a language an older app does not know needs 6.13", () => {
    expect(needsLocalesApp(design.DEFAULT_DESIGN)).toBe(false);
    expect(designMinAppCode(design.DEFAULT_DESIGN)).toBeLessThan(LOCALES_APP_CODE);
    const withMenu = (arg: string) => {
      const d = structuredClone(design.DEFAULT_DESIGN);
      d.menus.main = [...d.menus.main, { id: "lang", icon: "languages", label: "Slovensky", action: "lang.set", arg }];
      return d;
    };
    expect(designMinAppCode(withMenu("de"))).toBeLessThan(LOCALES_APP_CODE);
    expect(designMinAppCode(withMenu("sk"))).toBe(LOCALES_APP_CODE);
    expect(designMinAppCode(withMenu("system"))).toBe(LOCALES_APP_CODE);
    const lib = structuredClone(design.DEFAULT_DESIGN);
    lib.libraries.fi = { description: "", steps: [{ do: "lang.set", arg: "fi" }] };
    expect(designMinAppCode(lib)).toBe(LOCALES_APP_CODE);
  });

  it("the built-in design (default-design.json) is current and within every limit on its way", () => {
    const content = androidAssets()["default-design.json"];
    expect(readFileSync(join(root, "android", "app", "src", "main", "assets", "m5", "default-design.json"), "utf8")).toBe(content);
    const bytes = Buffer.byteLength(content);
    expect(bytes).toBeGreaterThan(600 * 1024); // nine languages
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(gzipSync(content).length).toBeLessThan(512 * 1024); // in the APK and in a bundle, compressed
    // the console saves a design as JSON: the admin body limit is 8 MB (admin-limits.ts), with up to 2 MB of assets
    expect(bytes + (design.LIMITS.assets * 4) / 3).toBeLessThan(8 * 1024 * 1024);
    const parsed = JSON.parse(content) as { strings: Record<string, Record<string, string>> };
    for (const l of LOCALES) expect(Object.keys(parsed.strings[l]).length, l).toBeGreaterThanOrEqual(Object.keys(parsed.strings.en).length);
    for (const l of LOCALES) expect(Object.keys(parsed.strings[l]).length).toBeLessThanOrEqual(design.LIMITS.strings);
  });

  it("the templates' names (Settings › Appearance) in every language", () => {
    const themes = JSON.parse(androidAssets()["themes.json"]) as Array<{ id: string; label: Record<string, string> }>;
    const forest = themes.find((t) => t.id === "forest");
    if (forest) for (const l of LOCALES) expect(forest.label[l], l).toBeTruthy();
    for (const t of themes) expect(t.label.en, t.id).toBeTruthy();
  });
});
