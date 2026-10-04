// @vitest-environment node
// 6.10 — the Android app's security fixes (docs/security-analysis.md, chapter 12,
// G-20 … G-24). The rules themselves are JVM-tested (ActionGuardTest,
// SettingSchemaTest, DesignUrlsTest, IntentSealTest, CallLogBridgeTest); here:
// the design's texts for the refusals (server/android/design-610-security.ts) in
// Czech, English and German, and that the app is wired the way the fixes need
// (the raw argument reaches the guard, a lock neutralizes the notifications,
// the reply and a notification's room carry the process's tag).

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { DEFAULT_STRINGS } from "../server/android/design";
import { STRINGS_610 } from "../server/android/design-610";
import { AREA } from "../server/android/design-610-security";

const app = (p: string) => readFileSync(new URL(`../android/app/src/main/${p}`, import.meta.url), "utf8");
const java = (p: string) => app(`java/cz/m5cet/app/${p}`);

describe("android 6.10 security — the texts", () => {
  it("every refusal text exists in Czech, English and German, also in the default design", () => {
    const keys = Object.keys(AREA.strings?.en ?? {});
    expect(keys.filter((k) => k.startsWith("security.")).sort()).toEqual(["security.refused", "security.urlRefused"]);
    for (const k of keys) {
      for (const l of ["cs", "en", "de"] as const) {
        expect(AREA.strings?.[l]?.[k], `${l} ${k}`).toBeTruthy();
        expect(STRINGS_610[l][k], `${l} ${k}`).toBe(AREA.strings?.[l]?.[k]);
        expect(DEFAULT_STRINGS[l][k], `${l} ${k}`).toBe(AREA.strings?.[l]?.[k]);
      }
      expect(new Set((["cs", "en", "de"] as const).map((l) => AREA.strings?.[l]?.[k])).size, k).toBe(3);
    }
    expect(DEFAULT_STRINGS.cs["security.urlRefused"]).toMatch(/[áčďéěíňóřšťúůýž]/);
    // The keys the Java asks for (and the neutral texts a lock falls back to).
    expect(java("ui/Actions.java")).toContain('app.t("security.refused")');
    expect(java("ui/DesignUrls.java")).toContain('t("security.urlRefused")');
    for (const k of ["notify.message", "ring.call", "ring.missed"]) for (const l of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[l][k], `${l} ${k}`).toBeTruthy();
  });
});

describe("android 6.10 security — G-17: a model's card read asks first", () => {
  it("the consent texts are the web's keys, and every one the app uses exists", () => {
    const used = new Set<string>();
    for (const f of ["nfc/ModelNfc.java", "ui/parts/NfcModelSheet.java"]) for (const m of java(f).matchAll(/"(nfc\.consent\.[A-Za-z]+)"/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(20);
    for (const k of used) for (const l of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[l][k], `${l} ${k}`).toBeTruthy();
    // The same keys as the web's prompt (client/src/lib/i18n-nfc.ts), plus the sheet's "not sent".
    const web = new Set([...readFileSync(new URL("../client/src/lib/i18n-nfc.ts", import.meta.url), "utf8").matchAll(/"(nfc\.consent\.[A-Za-z]+)":/g)].map((m) => m[1]));
    for (const k of web) expect(used.has(k) || k === "nfc.consent.notSent", k).toBe(true);
    // The placeholders the app fills.
    expect(DEFAULT_STRINGS.cs["nfc.consent.text"]).toContain("{model}");
    expect(DEFAULT_STRINGS.de["nfc.consent.emvApp"]).toMatch(/\{app\}.*\{pan\}.*\{expiry\}/);
  });

  it("the sheet asks before it answers, masked by default; closing is a no", () => {
    const sheet = java("ui/parts/NfcModelSheet.java");
    expect(sheet).toContain("ModelNfc.Consent consent = ModelNfc.consent(r);");
    expect(sheet).toMatch(/if \(consent\.sensitive && dialog\.isShowing\(\)\) \{ askConsent\(r, consent\); return; \}/);
    expect(sheet).toContain('t("nfc.consent.sendMasked"), "shield-check", true');
    expect(sheet).toContain("consented(ModelNfc.masked(r))");
    expect(sheet).toContain("consented(ModelNfc.declined(r))");
    expect(sheet).toContain("return r != null ? ModelNfc.declined(r) : ModelNfc.cancelled();");
  });
});

describe("android 6.10 security — the wiring", () => {
  it("G-20: every design action reaches the guard with its raw argument", () => {
    const renderer = java("ui/Renderer.java");
    expect(renderer).toContain('void action(String action, String raw, Object arg, Expr.Scope scope, View source);');
    expect(renderer).toContain('r.host.action(handler.optString("action"), arg, value, sc, source)');
    expect(renderer).toContain('r.host.action(change.optString("action"), arg, arg == null ? null');
    expect(renderer).toContain("(a, raw, arg, v) -> r.host.action(a, raw, arg, sc, v)");
    const actions = java("ui/Actions.java");
    expect(actions).toContain("ActionGuard.check(action, raw, arg,");
    expect(actions).toContain('run(a, st.getString("do"), arg, arg == null ? null');
    expect(actions).not.toMatch(/Log\.d\("action", action \+ \(s/);
    expect(java("ui/MainActivity.java")).toContain("action(act, a, a == null ? null : Expr.value(a, sc, tr()), sc, anchor)");
    expect(java("ui/look/Sheets.java")).toContain("base.action(action, raw, arg, scope, source)");
    expect(java("core/Settings.java")).toContain("SettingSchema.valid(key, v)");
    expect(java("core/Settings.java")).not.toContain('"unknown setting " + key');
  });

  it("G-22: a lock — also the auto-lock in the background and a new process — makes the notifications neutral", () => {
    expect(java("M5.java")).toMatch(/public void onLocked\(\) \{ whenLocked\(\); emit\("locked"\); \}/);
    expect(java("M5.java")).toContain("notify.neutralizeAll()");
    const conv = java("telecom/Conversations.java");
    expect(conv).toContain("private void onBackground() { armLockCheck(); }");
    expect(conv).toMatch(/if \(app\.lock\.isLocked\(\)\) app\.whenLocked\(\);/);
    expect(conv).toContain("get(app).lockCheck()");
    const notify = java("telecom/Notify.java");
    expect(notify).toContain("public void neutralizeAll()");
    expect(notify).toContain('neutralMark("notify.message", locked)');
    const ring = java("telecom/CallRing.java");
    expect(ring).toContain('Notify.neutralMark("ring.call"');
    expect(ring).toContain('Notify.neutralMark("ring.missed"');
    expect(notify + ring).not.toMatch(/lock screen always gets/);
  });

  it("G-23: a room only from the app's own intents; the reply's room is tagged", () => {
    const main = java("ui/MainActivity.java");
    expect(main).toContain("IntentSeal.valid(cz.m5cet.app.security.IntentSeal.OPEN, room, seal)");
    expect(main).toContain("if (app.rooms.session(k) != null)");
    expect(java("telecom/ReplyReceiver.java")).toContain("IntentSeal.valid(IntentSeal.REPLY, room, intent.getStringExtra(IntentSeal.EXTRA))");
    expect(java("telecom/Notify.java")).toContain("IntentSeal.tag(IntentSeal.REPLY, roomKey)");
    expect(java("telecom/CallRing.java")).toContain("Notify.openRoom(app, roomKey)");
  });

  it("G-24: the boot receiver, the History's secure dialogs and its list on a lock", () => {
    const manifest = app("AndroidManifest.xml");
    expect(manifest).toMatch(/\.telecom\.Conversations\$Boot" android:exported="false">\s*<intent-filter>\s*<action android:name="android\.intent\.action\.BOOT_COMPLETED" \/>/);
    expect(manifest).toContain("android.permission.RECEIVE_BOOT_COMPLETED");
    const log = java("ui/parts/CallLogUi.java");
    expect(log.match(/SecureDialog\.show\(a, new AlertDialog\.Builder/g)).toHaveLength(3);
    expect(log).not.toMatch(/\.setNegativeButton\([^;]*\)\.show\(\)/);
    expect(log).toContain("public static void forget()");
    expect(java("M5.java")).toContain("CallLogUi.forget()");
  });
});
