// @vitest-environment node
// The iOS app's built-in design, icons and templates are generated from the
// server's (script/ios-assets.ts → ios/Design/m5/, copied into M5cet.app/m5/
// by the Xcode build phase "Copy design assets"): stale copies would make a
// fresh app look different from what the console shows. The iOS design is
// Android's default with the iOS look and the iOS-only items (the Apple Watch
// switch, the watch app's and the NFC sheet's texts) — which never reach
// Android's design.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { iosAssets } from "../server/ios/assets";
import { IOS_DEFAULT_DESIGN, IOS_STRINGS, IOS_WATCH_SETTING, sanitizeIosDesign } from "../server/ios/design";
import { DEFAULT_DESIGN, LANGS, LIMITS, sanitizeDesign, type ANode } from "../server/android/design";
import { androidAssets } from "../server/android/assets";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const walk = (n: ANode, out: ANode[] = []): ANode[] => { out.push(n); for (const c of n.children ?? []) walk(c, out); return out; };
/** The tokens script/i18n-check.ts compares: {placeholders}, $variables, %s/%d, tags, line breaks. */
const tokens = (s: string): string => [
  ...(s.match(/\{[^{}\s]+\}/g) ?? []),
  ...(s.match(/\$[A-Za-z_][\w.]*/g) ?? []),
  ...(s.match(/%[sd]/g) ?? []),
  ...(s.match(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi) ?? []).map((t) => t.replace(/\s.*>$/, ">")),
  ...Array((s.match(/\n/g) ?? []).length).fill("\\n"),
].sort().join(" ");

describe("ios assets", () => {
  for (const [name, content] of Object.entries(iosAssets())) {
    it(`${name} is up to date (npx tsx script/ios-assets.ts)`, () => {
      expect(read("ios", "Design", "m5", name)).toBe(content);
    });
  }

  it("the build phase copies them from ios/Design/m5 — not Android's, not a synchronized folder", () => {
    const pbx = read("ios", "M5cet.xcodeproj", "project.pbxproj");
    const phase = pbx.slice(pbx.indexOf("/* Copy design assets */ = {"), pbx.indexOf("/* End PBXShellScriptBuildPhase section */"));
    for (const f of ["default-design.json", "icons.json", "themes.json"]) {
      expect(phase).toContain(`"$(SRCROOT)/Design/m5/${f}",`);
      expect(phase).toContain(`"$(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/m5/${f}",`);
    }
    expect(phase).toContain('src=\\"${SRCROOT}/Design/m5\\"');
    expect(phase).not.toContain("android/app/src/main/assets");
  });

  it("are the iOS ones: the iOS look, Android's icons, the iOS template first; within the limits on the way", () => {
    const a = iosAssets();
    const d = JSON.parse(a["default-design.json"]);
    expect(d.theme.light.primary).toBe("#0064e0");
    expect(d.rev).toMatch(/^[0-9a-f]{16}$/);
    expect(a["icons.json"]).toBe(androidAssets()["icons.json"]);
    expect(JSON.parse(a["themes.json"])[0].id).toBe("ios");
    expect(Buffer.byteLength(a["default-design.json"])).toBeLessThan(2 * 1024 * 1024);
    for (const l of LANGS) expect(Object.keys(d.strings[l]).length, l).toBeLessThanOrEqual(LIMITS.strings);
  });
});

describe("the iOS-only items", () => {
  const ios = sanitizeIosDesign(IOS_DEFAULT_DESIGN);
  const android = sanitizeDesign(DEFAULT_DESIGN);

  it("Settings › Notifications has the Apple Watch switch (watch.on) after Hide on the lock screen", () => {
    const list = walk(ios.screens["settings.notify"]);
    const ids = list.map((n) => n.id);
    const sw = list.find((n) => n.el === "switch" && n.props?.setting === IOS_WATCH_SETTING);
    expect(sw?.id).toBe("watch-switch");
    const row = list.find((n) => n.id === "watch")!;
    expect(row.children!.map((c) => c.el)).toEqual(["icon", "text", "switch"]);
    expect(row.children![1].text).toBe("{_'watch.setting'}");
    expect(list.find((n) => n.id === "watch-hint")!.text).toBe("{_'watch.setting.hint'}");
    // in the shape of its neighbours
    const lockscreen = list.find((n) => n.id === "lockscreen")!;
    expect(row.style).toEqual(lockscreen.style);
    expect(ids.indexOf("watch")).toBeGreaterThan(ids.indexOf("lockscreen-hint"));
    expect(ids.indexOf("watch")).toBeLessThan(ids.indexOf("s-quiet"));
    // never a condition: the watch is not the notifications' switch
    expect(row.if).toBeUndefined();
  });

  it("every other screen, menu and library is Android's; Android's design has none of it", () => {
    for (const id of Object.keys(android.screens)) if (id !== "settings.notify") expect(ios.screens[id], id).toEqual(android.screens[id]);
    expect(ios.menus).toEqual(android.menus);
    expect(ios.libraries).toEqual(android.libraries);
    const a = JSON.stringify(android);
    expect(a).not.toContain(IOS_WATCH_SETTING);
    for (const key of Object.keys(IOS_STRINGS)) expect(a, key).not.toContain(`"${key}"`);
    expect(JSON.stringify(DEFAULT_DESIGN.screens["settings.notify"])).not.toContain("watch");
    // the shipped Android file too
    expect(read("android", "app", "src", "main", "assets", "m5", "default-design.json")).not.toContain(IOS_WATCH_SETTING);
  });

  it("the texts in all nine languages, placeholders as English's, Android's texts unchanged", () => {
    for (const l of LANGS) {
      for (const [key, texts] of Object.entries(IOS_STRINGS)) {
        expect(texts[l]?.trim(), `${l} ${key}`).toBeTruthy();
        expect(ios.strings[l][key], `${l} ${key}`).toBe(texts[l]);
        expect(tokens(texts[l]), `${l} ${key}`).toBe(tokens(texts.en));
      }
      for (const [key, text] of Object.entries(android.strings[l])) expect(ios.strings[l][key], `${l} ${key}`).toBe(text);
    }
    expect(IOS_STRINGS["nfc.ios.step"].en).toBe("{0}/{1} · {2}");
  });

  it("covers every key the iOS app asks for with an English fallback (watch app, NFC sheet)", () => {
    const wire = read("ios", "M5cet", "Platform", "Watch", "WatchWire.swift");
    const english = wire.slice(wire.indexOf("static let english"), wire.indexOf("static let quickKeys"));
    const watchKeys = [...english.matchAll(/"(watch\.[A-Za-z0-9.]+)":/g)].map((m) => m[1]);
    expect(watchKeys.length).toBeGreaterThanOrEqual(29);
    for (const k of watchKeys) expect(IOS_STRINGS[k], k).toBeDefined();
    const nfc = read("ios", "M5cet", "Platform", "NFC", "NfcSheetTexts.swift");
    const nfcKeys = [...nfc.matchAll(/"(nfc\.ios\.[A-Za-z]+)"/g)].map((m) => m[1]);
    expect(new Set(nfcKeys)).toEqual(new Set(["nfc.ios.hold", "nfc.ios.holdWrite", "nfc.ios.step", "nfc.ios.multipleTags"]));
    for (const k of nfcKeys) expect(IOS_STRINGS[k], k).toBeDefined();
    // the design's English is the app's fallback where the app has one (the watch's settings texts are the design's own)
    for (const k of watchKeys.filter((k) => !["watch.off.hint"].includes(k))) {
      const m = new RegExp(`"${k.replace(/\./g, "\\.")}": "((?:[^"\\\\]|\\\\.)*)"`).exec(english);
      expect(IOS_STRINGS[k].en, k).toBe(m![1].replace(/\\"/g, '"'));
    }
  });

  it("the setting exists in the app, off by default, out of a design action's reach (M5Design)", () => {
    const model = read("ios", "M5Kit", "Sources", "M5Design", "SettingsModel.swift");
    expect(model).toContain(`("${IOS_WATCH_SETTING}", false)`);
    const schema = read("ios", "M5Kit", "Sources", "M5Design", "SettingSchema.swift");
    const areas = /static let privateAreas = \[([^\]]*)\]/.exec(schema)![1];
    expect(areas).toContain('"watch."');
    // and the watch reads it there (WatchSetting.key)
    expect(read("ios", "M5cet", "Platform", "Watch", "WatchEnvironment.swift")).toContain(`static let key = "${IOS_WATCH_SETTING}"`);
  });
});
