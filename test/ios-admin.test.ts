// @vitest-environment node
// The console's iOS API (6.14) through the real module guard: the Android
// module's rights decide (devices, push, wipe, builds, releases, publish,
// settings) and an administrator without the module gets nothing of iOS. The
// iOS design: its own document with the iOS look, the same checks as Android's,
// /validate and /preview without saving, the §5 limits as warnings; builds of
// it compile and bundle; the notifier wakes a linked iOS device over APNs.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "m5-ios-admin-"));
process.env.DATA_DIR = dir;
for (const k of ["APNS_KEY_FILE", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC", "APNS_ENV"]) delete process.env[k];

const express = (await import("express")).default;
const { consoleGuard } = await import("../server/access");
const { clientConfigStore } = await import("../server/client-config");
const { registerIosAdminRoutes, iosConsoleRight } = await import("../server/ios/admin-routes");
const { iosStore } = await import("../server/ios/store");
const design = await import("../server/ios/design");
const androidDesign = await import("../server/android/design");
const bundle = await import("../server/mobile/bundle");
const crypto = await import("../server/mobile/crypto");
const { androidStore } = await import("../server/android/store");

let server: Server;
let base = "";
let role = "owner";

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use((_req, res, next) => { res.locals.adminName = "eva"; res.locals.adminRole = role; next(); });
  registerIosAdminRoutes(app);
  // The Android page answers too (the same module): a guard test may compare.
  app.use("/api/admin/android", consoleGuard("android"), (_req, res) => { res.json({ ok: true }); });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  iosStore.reset();
  androidStore.reset();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api/admin/ios${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() as Record<string, any> };
};

/** The Android module's rule for the duration of `fn` (and the role of the administrator). */
async function withRule(rule: Record<string, unknown> | null, as: string, fn: () => Promise<void>) {
  const cfg = clientConfigStore.get();
  const modules = { ...cfg.modules };
  if (rule) modules.android = rule as never; else delete modules.android;
  clientConfigStore.set({ ...cfg, modules });
  role = as;
  try { await fn(); } finally { role = "owner"; clientConfigStore.set(cfg); }
}

describe("rights (the Android module's)", () => {
  it("needs the same rights as the Android page, and push for a test push", () => {
    const req = (method: string, path: string, body?: unknown) => ({ method, path, body }) as never;
    expect(iosConsoleRight(req("GET", "/devices"))).toBeNull();
    expect(iosConsoleRight(req("GET", "/devices/ios_1/locations"))).toEqual(["devices"]);
    expect(iosConsoleRight(req("PUT", "/config"))).toEqual(["settings"]);
    expect(iosConsoleRight(req("POST", "/codes"))).toEqual(["settings"]);
    expect(iosConsoleRight(req("POST", "/devices/ios_1/commands", { kind: "wipe" }))).toEqual(["wipe"]);
    expect(iosConsoleRight(req("POST", "/commands", { kind: "lock" }))).toEqual(["push"]);
    expect(iosConsoleRight(req("POST", "/push/test"))).toEqual(["push"]);
    expect(iosConsoleRight(req("POST", "/releases"))).toEqual(["releases"]);
    expect(iosConsoleRight(req("POST", "/releases/irel_1/publish"))).toEqual(["publish"]);
    expect(iosConsoleRight(req("POST", "/builds/ibld_1/publish"))).toEqual(["publish"]);
    expect(iosConsoleRight(req("PUT", "/design"))).toEqual(["builds"]);
    expect(iosConsoleRight(req("POST", "/design/validate"))).toEqual(["builds"]);
  });

  it("an operator granted only devices reads everything, changes devices — not the settings, a push or a release", async () => {
    await withRule({ enabled: true, defaultAccess: "deny", groupAccess: "allow", groups: [], grants: [{ group: "admin-operator", rights: ["devices"] }], log: "off" }, "operator", async () => {
      expect((await call("GET", "")).status).toBe(200);
      expect((await call("GET", "/devices")).status).toBe(200);
      const denied = await call("PUT", "/config", { enrollment: "closed" });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: "module-denied", module: "android" });
      expect((await call("POST", "/push/test", { device: "ios_x" })).status).toBe(403);
      expect((await call("POST", "/releases", { version: "6.15.0" })).status).toBe(403);
      expect((await call("POST", "/devices/ios_none/commands", { kind: "wipe" })).status).toBe(403);
      expect((await call("PATCH", "/devices/ios_none", { name: "x" })).status).toBe(404); // allowed — the device just is not there
    });
  });

  it("an administrator without the module gets no iOS page at all; an owner always may", async () => {
    await withRule({ enabled: true, defaultAccess: "deny", groupAccess: "deny", groups: [], grants: [], log: "off" }, "operator", async () => {
      const r = await call("GET", "");
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("module-denied");
      expect((await call("GET", "/design")).status).toBe(403);
    });
    await withRule({ enabled: true, defaultAccess: "deny", groupAccess: "deny", groups: [], grants: [], log: "off" }, "owner", async () => {
      expect((await call("GET", "")).status).toBe(200);
    });
  });
});

describe("the iOS design", () => {
  it("is Android's default design with the iOS look, and passes the same checks", () => {
    const clean = design.sanitizeIosDesign(design.IOS_DEFAULT_DESIGN);
    expect(Object.keys(clean.screens).sort()).toEqual([...androidDesign.SCREEN_IDS].sort());
    // The screens are Android's, but Settings › Notifications has the Apple Watch switch, Settings › Calls lacks
    // what iOS cannot do, Settings › Security's shuffle hint is not doubly wrapped and the update notice names no
    // size an iOS release does not have (design.IOS_CHANGED_SCREENS, test/ios-assets.test.ts).
    const android = androidDesign.sanitizeDesign(androidDesign.DEFAULT_DESIGN).screens;
    const iosNotify = clean.screens["settings.notify"], androidNotify = android["settings.notify"];
    const same = (screens: Record<string, unknown>) => Object.fromEntries(Object.entries(screens).filter(([id]) => !design.IOS_CHANGED_SCREENS.includes(id)));
    expect(design.IOS_CHANGED_SCREENS).toEqual(["settings.notify", "settings.calls", "settings.security", "update"]);
    expect(same(clean.screens)).toEqual(same(android));
    expect(JSON.stringify(iosNotify)).toContain('"setting":"watch.on"');
    expect(JSON.stringify(androidNotify)).not.toContain("watch.on");
    expect(clean.theme.light.primary).toBe("#0064e0");
    expect(clean.theme.dark.background).toBe("#000000");
    expect(clean.animations.screen).toMatchObject({ type: "slide-left", ms: 350 });
    // What a saved design lacks comes from the iOS defaults, not Android's.
    const partial = design.sanitizeIosDesign({ theme: { light: { primary: "#112233" } } });
    expect(partial.theme.light.primary).toBe("#112233");
    expect(partial.theme.light.background).toBe(design.IOS_THEME.light.background);
    expect(androidDesign.sanitizeDesign({ theme: { light: { primary: "#112233" } } }).theme.light.background).toBe(androidDesign.DEFAULT_THEME.light.background);
  });

  it("text on the iOS colours reads (WCAG AA 4.5:1)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    for (const tone of ["light", "dark"] as const) {
      const t = design.IOS_THEME[tone];
      for (const [fg, bg] of [["onPrimary", "primary"], ["onSurface", "surface"], ["onSurface", "background"], ["onBubbleIn", "bubbleIn"], ["onBubbleOut", "bubbleOut"], ["muted", "surface"]]) {
        expect(ratio(t[fg], t[bg]), `${tone} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("says what iOS cannot do (§ 5) without refusing it", () => {
    const d = structuredClone(design.IOS_DEFAULT_DESIGN);
    d.libraries = { ...d.libraries, card: { description: "", steps: [{ do: "nfc.emulate" }, { do: "nfc.reader", arg: "usb" }, { do: "nfc.reader", arg: "internal" }] } };
    const warnings = design.iosDesignWarnings(design.sanitizeIosDesign(d));
    expect(warnings.join("\n")).toMatch(/nfc\.emulate — .*library card.*HCE/);
    expect(warnings.join("\n")).toMatch(/nfc\.reader \(usb\)/);
    // nfc.reader internal is fine on an iPhone: only the usb step is named.
    expect(warnings.filter((w) => w.startsWith("nfc.reader"))).toHaveLength(1);
  });

  it("the API: catalog with the iOS defaults, save, validate and preview (nothing stored), reset", async () => {
    const cat = (await call("GET", "/catalog")).body.catalog;
    expect(cat.platform).toBe("ios");
    expect(cat.defaults.theme.light.primary).toBe("#0064e0");
    expect(cat.themes[0].id).toBe("ios");
    expect(cat.iosLimits.map((l: { action: string }) => l.action)).toContain("nfc.emulate");
    const d = (await call("GET", "/design")).body.design;
    expect(d.theme.light.primary).toBe("#0064e0");

    const bad = structuredClone(d);
    bad.screens.splash.children.push({ id: "bad", el: "icon", props: { icon: "nope" } });
    const v = await call("POST", "/design/validate", { design: bad });
    expect(v.body).toMatchObject({ ok: true, valid: false });
    expect(v.body.problems.join()).toMatch(/unknown icon/);
    const good = await call("POST", "/design/validate", { design: d });
    expect(good.body).toMatchObject({ valid: true, problems: [] });
    expect(good.body.minAppCode).toBeGreaterThanOrEqual(61400);

    const before = (await call("GET", "/design")).body.design.rev;
    const preview = await call("POST", "/design/preview", {});
    expect(preview.status).toBe(200);
    expect(preview.body.manifest.files["theme.json"].size).toBeGreaterThan(0);
    expect(preview.body.minAppCode).toBe(good.body.minAppCode);
    expect(iosStore.builds.count()).toBe(0);
    expect((await call("GET", "/design")).body.design.rev).toBe(before);

    d.theme.light.primary = "#123456";
    const saved = await call("PUT", "/design", { design: d });
    expect(saved.body.design.theme.light.primary).toBe("#123456");
    expect((await call("PUT", "/design", { design: bad })).status).toBe(400);
    const reset = await call("POST", "/design/reset", {});
    expect(reset.body.design.theme.light.primary).toBe("#0064e0");
  });

  it("a build of it compiles, bundles and reads back to the same design; its minimum is an iOS app", () => {
    const meta = { id: "ibld_t", number: 1, version: "6.14.0-b1", channel: "stable", created: 1, minAppCode: 61400, notes: "" };
    const { plaintext } = bundle.compileDesign(design.IOS_DEFAULT_DESIGN, meta);
    const content = bundle.readContent(plaintext);
    const back = bundle.designOfContent(content.files, design.IOS_DEFAULT_DESIGN);
    expect(androidDesign.designRev(back)).toBe(androidDesign.designRev(design.sanitizeIosDesign(design.IOS_DEFAULT_DESIGN)));
    expect(design.iosDesignMinAppCode(design.IOS_DEFAULT_DESIGN)).toBeGreaterThanOrEqual(61400);
    expect(design.iosDesignMinAppCode(design.IOS_DEFAULT_DESIGN)).toBe(Math.max(61400, bundle.designMinAppCode(design.IOS_DEFAULT_DESIGN)));
    const server = crypto.newP256();
    const sealed = crypto.sealBundle({ id: meta.id, number: 1, version: meta.version, channel: "stable", created: 1, minAppCode: 61400 }, plaintext, { privateKey: server.privateKey, kid: "k" });
    const dev = crypto.newP256();
    const file = crypto.bundleFile({ ...sealed.header, recipients: [crypto.wrapBundleKey(sealed.cek, sealed.header, { id: "ios_1", encKey: crypto.spkiOf(dev.publicKey) })] }, sealed.body);
    expect(crypto.openBundleFile(file, { id: "ios_1", privateKey: dev.privateKey }, crypto.spkiOf(server.publicKey)).plaintext.equals(plaintext)).toBe(true);
  });

  it("ships its own assets: the iOS default design, the icons and the templates (iOS first)", async () => {
    const { iosAssets } = await import("../server/ios/assets");
    const a = iosAssets();
    expect(JSON.parse(a["default-design.json"]).theme.light.primary).toBe("#0064e0");
    expect(Object.keys(JSON.parse(a["icons.json"])).length).toBeGreaterThan(100);
    const themes = JSON.parse(a["themes.json"]) as Array<{ id: string }>;
    expect(themes[0].id).toBe("ios");
    expect(themes.length).toBeGreaterThan(5);
  });
});

describe("passkeys on iOS", () => {
  it("publishes apple-app-site-association (webcredentials) only with the team id", async () => {
    const { appSiteAssociation, registerAppSiteAssociation } = await import("../server/ios/app-site");
    const app = express();
    registerAppSiteAssociation(app);
    const s = await new Promise<Server>((resolve) => { const x = app.listen(0, "127.0.0.1", () => resolve(x)); });
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/.well-known/apple-app-site-association`;
    try {
      expect(appSiteAssociation()).toBeNull();
      expect((await fetch(url)).status).toBe(404);
      process.env.APNS_TEAM_ID = "TEAM123456";
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ webcredentials: { apps: ["TEAM123456.cz.m5cet.app"] } });
      expect((await call("GET", "/app-site")).body).toMatchObject({ teamId: "TEAM123456", published: true, path: "/.well-known/apple-app-site-association" });
    } finally {
      delete process.env.APNS_TEAM_ID;
      s.close();
    }
  });
});

describe("the notifier's app channel", () => {
  it("wakes a linked iOS device over APNs (and drops a wiped one)", async () => {
    const { androidChannel } = await import("../server/notify/channels");
    const links: Array<{ deviceId: string; tokenHash: string; at: number }> = [{ deviceId: "ios_n1", tokenHash: "h", at: 1 }, { deviceId: "ios_gone", tokenHash: "h", at: 1 }];
    const unlinked: string[] = [];
    const store = { devices: () => links, unlinkDevice: (id: string) => { unlinked.push(id); return 1; } };
    const sentTo: string[] = [];
    const device = (id: string) => (id === "ios_n1" ? { id, name: "iPad", status: "active" } : id === "ios_gone" ? { id, name: "old", status: "wiped" } : null);
    const ch = androidChannel({
      store: store as never, device: () => null, putDevice: () => undefined, putCommand: () => undefined,
      ready: () => ({ ready: false, reason: "FCM is switched off" }), send: async () => ({ ok: true, name: "x" }), wire: () => ({}),
      ios: { device: device as never, send: async (d) => { sentTo.push(d.id); return { ok: true }; } },
    });
    const payload = { v: 1, id: "n", kind: "message", title: "", body: "", tpl: { title: "", body: "" }, vars: {}, privacy: "neutral", tag: "t", group: "room", icon: "", accent: "", sound: true, vibrate: true, sticky: false, actions: false, url: "", lang: "en", at: 1 } as never;
    const attempts = await ch.send({ accountId: "acc", payload, config: {} as never });
    expect(sentTo).toEqual(["ios_n1"]);
    expect(attempts).toEqual([
      expect.objectContaining({ channel: "android", target: "ios_n1 (iPad)", ok: true }),
      expect.objectContaining({ channel: "android", target: "ios_gone (old)", ok: false, gone: true }),
    ]);
    expect(unlinked).toEqual(["ios_gone"]);
  });
});
