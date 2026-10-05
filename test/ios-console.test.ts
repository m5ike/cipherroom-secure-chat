// The console's iOS page (admin-ui/public/ios-console.js, 6.14) on a stand-in
// for console.js, with the real builder kit, preview language and Android
// page underneath (android-console.js — the iOS page is its code on
// /api/admin/ios): the same tabs as Android; APNs instead of FCM (settings,
// a test push with Apple's answer); release records with App Store /
// TestFlight links (no APK upload); iPhone / iPad frames in the design
// builder and its iOS check; Define the same set as Android's, labelled
// "shared with Android"; the bundle id and store links on Security, the
// AASA card instead of assetlinks — and Android's page still Android's.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATA_DIR = join(__dirname, ".no-such-dir-ios-console");
const { iosCatalog, IOS_DEFAULT_DESIGN, sanitizeIosDesign } = await import("../server/ios/design");
const { androidCatalog, DEFAULT_DESIGN, sanitizeDesign } = await import("../server/android/design");

const calls: Array<{ path: string; method: string; body?: any }> = [];
const routes = new Map<string, [string, string, () => Promise<void>]>();
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function h(tag: string, attrs: Record<string, any> = {}, ...children: any[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign((el as HTMLElement).dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const iosDesign = { ...sanitizeIosDesign(IOS_DEFAULT_DESIGN), rev: "r-ios" };
const androidDesign = { ...sanitizeDesign(DEFAULT_DESIGN), rev: "r-android" };
const policy = { lock: { biometric: "optional", pinLength: 6, maxAttempts: 8, wipe: true, backoff: true, autolockSeconds: 60, screenshots: false }, pollMinutes: 30, update: { channel: "stable", checkHours: 12, wifiOnly: false, autoDownload: true }, rooms: { max: 8 }, logs: "errors", location: { track: true, days: 30, minSeconds: 15 } };
const signing = { kid: "AbCdEf0123456789", publicKey: "MFk…", fingerprint: "1A2B 3C4D" };
const iosOverview = () => ({
  ok: true, store: { persistent: true, file: "/data/ios/ios.db", reason: "" },
  config: { enrollment: "open", policy, bundleId: "cz.m5cet.app", minAppBuild: 0, appStoreUrl: "https://apps.apple.com/app/m5cet/id1", testFlightUrl: "", apns: { enabled: true, env: "", topic: "" }, rev: "", updatedAt: 0, updatedBy: "" },
  apns: { ready: true, reason: "", env: "production", topic: "cz.m5cet.app", keyId: "ABCDE12345", teamId: "TEAM123456" },
  publicUrl: "https://chat.example.com", signing,
  counts: { devices: 2, active: 2, wiped: 0, seen24h: 1, apns: 2, voip: 1, phones: 1, pads: 1, builds: 0, releases: 1, events24h: 0 },
  app: { version: "6.14.0", versionCode: 61400, minAppCode: 61400, minBuild: 0 },
  design: { rev: "r-ios", updatedAt: 0, updatedBy: "" }, appSite: { teamId: "TEAM123456", bundleId: "cz.m5cet.app", published: true },
});
const androidOverview = () => ({
  ok: true, store: { persistent: true, file: "/data/android/android.db", reason: "" },
  config: { enrollment: "open", policy, packageName: "cz.m5cet.app", certSha256: [], passkeyCertSha256: [], fcm: { enabled: false, client: null, serviceAccountEmail: "", projectId: "", hasServiceAccount: false } },
  fcm: { ready: false, reason: "FCM is switched off" }, publicUrl: "https://chat.example.com", signing,
  counts: { devices: 0, active: 0, wiped: 0, seen24h: 0, builds: 0, releases: 0, events24h: 0 },
  app: { version: "6.14.0", versionCode: 61400, minAppCode: 60000 }, design: { rev: "r-android", updatedAt: 0, updatedBy: "" },
});
const iphone = { id: "ios_1", name: "Mike's iPhone", model: "iPhone18,1", modelName: "iPhone 17 Pro", idiom: "phone", os: "iOS", osVersion: "26.0", appVersion: "6.14.0", appCode: 61400, status: "active", lastSeen: Date.now(), lastIp: "10.0.0.0", state: { battery: 80, bundle: null }, push: "apns", voip: true, apnsEnv: "production", kid: "k" };
const release = { id: "irel_1", version: "6.14.1", build: 61401, bundleId: "cz.m5cet.app", channel: "stable", store: "appstore", url: "https://apps.apple.com/app/m5cet/id1", notes: { en: "Fixes" }, minBuild: 0, rollout: 100, status: "draft", createdAt: 1, createdBy: "eva", publishedAt: null, updatedAt: 1, signature: "s" };
const defineSet = { version: 1, updatedAt: 1, defs: [{ name: "greeting", kind: "variable", scope: "both", maxSize: 0, node: { type: "string", value: "hi" } }] };

async function api(path: string, opts: { method?: string; body?: any } = {}) {
  const method = opts.method ?? "GET";
  calls.push({ path, method, body: opts.body });
  const [p] = path.split("?");
  if (p === "/api/admin/ios" && method === "GET") return iosOverview();
  if (p === "/api/admin/android" && method === "GET") return androidOverview();
  if (p === "/api/admin/ios/catalog") return { ok: true, catalog: plain(iosCatalog()) };
  if (p === "/api/admin/android/catalog") return { ok: true, catalog: plain(androidCatalog()) };
  if (p === "/api/admin/ios/devices") return { ok: true, devices: [iphone] };
  if (p === "/api/admin/android/devices") return { ok: true, devices: [] };
  if (p === "/api/admin/ios/releases" && method === "GET") return { ok: true, releases: [release] };
  if (p === "/api/admin/ios/releases" && method === "POST") return { ok: true, release: { ...release, id: "irel_2", version: opts.body.version, build: 61402 } };
  if (p === "/api/admin/ios/config" && method === "PUT") return { ok: true, config: iosOverview().config };
  if (p === "/api/admin/android/config" && method === "PUT") return { ok: true };
  if (p === "/api/admin/ios/push/test") return { ok: true, via: "apns", command: "cmd_1", error: null, apns: iosOverview().apns, result: { ok: true, status: 200, apnsId: "1234-abcd", attempts: 1 } };
  if (p === "/api/admin/define") return { ok: true, define: structuredClone(defineSet) };
  if (p === "/api/admin/ios/design" && method === "GET") return { ok: true, design: structuredClone(iosDesign) };
  if (p === "/api/admin/android/design" && method === "GET") return { ok: true, design: structuredClone(androidDesign) };
  if (p === "/api/admin/ios/design/validate") return { ok: true, valid: true, problems: [], warnings: ["nfc.emulate — screen nfc: card emulation (HCE) needs Apple's HCE entitlement"], rev: "x", minAppCode: 61400 };
  if (p === "/api/admin/ios/codes" || p === "/api/admin/android/codes") return { ok: true, codes: [] };
  if (p === "/api/admin/ios/app-site") return { ok: true, teamId: "TEAM123456", bundleId: "cz.m5cet.app", published: true, association: { webcredentials: { apps: ["TEAM123456.cz.m5cet.app"] } }, path: "/.well-known/apple-app-site-association" };
  if (p === "/api/admin/android/passkeys") return { ok: true, local: { ok: false, statements: [] }, google: { ok: false }, certs: [], devices: [], package: "cz.m5cet.app", rpId: "chat.example.com" };
  throw new Error(`unexpected ${method} ${path}`);
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[];
const tick = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));
const lastCall = (path: string, method = "GET") => calls.filter((c) => c.path.split("?")[0] === path && c.method === method).pop();
const tab = async (root: string, id: string) => { ($(`#${root} [data-tab="${id}"]`)).click(); await tick(20); };

beforeAll(async () => {
  // (#androidConsoleCss: the page's stylesheet counts as added — no fetch of it here.)
  document.body.innerHTML = '<div id="androidConsoleCss" hidden></div><section data-panel="android"><div id="androidRoot"></div></section><section data-panel="ios"><div id="iosRoot"></div></section>';
  (window as any).M5Console = {
    h, api, toast: vi.fn(), can: () => true, applyRoleGates: () => undefined,
    clear: (el: Element) => { while (el.firstChild) el.firstChild.remove(); return el; },
    $: (s: string, r: ParentNode = document) => r.querySelector(s), $$: (s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)),
    icon: () => document.createElement("span"), moduleAccess: () => ({ allowed: true, rights: ["*"] }),
    raw: async () => new Response("<svg xmlns='http://www.w3.org/2000/svg'></svg>", { status: 200, headers: { "X-M5-Link": "m5cet://enroll?server=x" } }),
    addRoute: (name: string, entry: [string, string, () => Promise<void>]) => { routes.set(name, entry); },
  };
  const load = (file: string) => new Function(readFileSync(join(__dirname, "..", "admin-ui", "public", file), "utf8"))();
  load("builder-kit.js");
  load("android-expr.js");
  load("android-console.js");
  load("ios-console.js");
  await routes.get("ios")![2]();
  await tick(20);
});

describe("the iOS page", () => {
  it("registers next to Android's and shows the fleet, the shared key and how to get the app", () => {
    expect([...routes.keys()]).toEqual(["android", "ios"]);
    expect(routes.get("ios")![0]).toBe("iOS");
    const root = $("#iosRoot");
    expect(root.textContent).toContain("iPhone / iPad");
    expect(root.textContent).toContain("1 / 1");
    expect($('[data-testid="ios-key"]').textContent).toContain("The same key as Android's");
    expect($('[data-testid="ios-get-app"]').textContent).toContain("https://apps.apple.com/app/m5cet/id1");
    expect($("#androidRoot").childElementCount).toBe(0);
  });

  it("has the Android page's tabs", () => {
    expect($$("#iosRoot [data-tab]").map((b) => b.dataset.tab)).toEqual(["overview", "devices", "push", "design", "define", "builds", "releases", "security", "events"]);
  });

  it("devices: the iOS model, system and push columns", async () => {
    await tab("iosRoot", "devices");
    const row = $("#iosRoot tbody tr");
    expect(row.textContent).toContain("iPhone 17 Pro · iPhone");
    expect(row.textContent).toContain("iOS 26.0");
    expect(row.textContent).toContain("APNs + VoIP");
    expect(lastCall("/api/admin/ios/devices")).toBeTruthy();
  });

  it("push: APNs settings saved to ios.json and a test push with Apple's answer", async () => {
    await tab("iosRoot", "push");
    const card = $('[data-testid="apns-card"]');
    expect(card.textContent).toContain("Apple Push Notification service");
    expect(card.textContent).toContain("cz.m5cet.app.voip");
    expect($("#iosRoot").textContent).not.toContain("Firebase");
    const env = $('[data-testid="apns-env"]') as HTMLSelectElement;
    env.value = "sandbox";
    Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Save")!.click();
    await tick(20);
    expect(lastCall("/api/admin/ios/config", "PUT")!.body).toEqual({ apns: { enabled: true, env: "sandbox", topic: "" } });
    await tab("iosRoot", "push");
    Array.from($('[data-testid="apns-card"]').querySelectorAll("button")).find((b) => b.textContent === "Test push")!.click();
    await tick(20);
    expect(lastCall("/api/admin/ios/push/test", "POST")!.body).toEqual({ device: "ios_1", type: "background" });
    expect($('[data-testid="apns-test-result"]').textContent).toContain("apns-id 1234-abcd");
  });

  it("releases: records with App Store / TestFlight links — no APK upload", async () => {
    await tab("iosRoot", "releases");
    const root = $("#iosRoot");
    expect(root.querySelector('input[type="file"]')).toBeNull();
    expect(root.textContent).not.toContain("APK");
    expect(root.querySelector('[data-release="irel_1"]')!.textContent).toContain("App Store");
    ($('[data-testid="rel-version"]') as HTMLInputElement).value = "6.14.2";
    const cs = root.querySelector('textarea[data-lang="cs"]') as HTMLTextAreaElement;
    cs.value = "Opravy";
    $('[data-testid="rel-create"]').click();
    await tick(20);
    expect(lastCall("/api/admin/ios/releases", "POST")!.body).toMatchObject({ version: "6.14.2", channel: "stable", store: "appstore", minBuild: 0, rollout: 100, notes: { cs: "Opravy" } });
  });

  it("define: the same set as Android's, labelled shared", async () => {
    await tab("iosRoot", "define");
    await tick(20);
    expect($('[data-testid="define-shared"]').textContent).toBe("shared with Android");
    expect(lastCall("/api/admin/define")).toBeTruthy();
    expect($("#iosRoot").textContent).toContain("m5mobile.define.greeting");
  });

  it("design: iPhone and iPad frames in iOS style, the iOS look, and the check for iOS", async () => {
    await tab("iosRoot", "design");
    await tick(30);
    const phone = $("#iosRoot .and-phone");
    expect(phone.classList.contains("and-phone--ios")).toBe(true);
    const devices = Array.from(document.querySelectorAll('#iosRoot select[aria-label="Device"] option')).map((o) => o.textContent);
    expect(devices[0]).toMatch(/^iPhone 17/);
    expect(devices.some((d) => d!.startsWith("iPad Pro 13"))).toBe(true);
    expect(lastCall("/api/admin/ios/design")).toBeTruthy();
    $('[data-testid="ios-design-validate"]').click();
    await tick(20);
    expect(lastCall("/api/admin/ios/design/validate", "POST")!.body.design.theme.light.primary).toBe("#0064e0");
    expect($('[data-testid="ios-design-check"]').textContent).toContain("nfc.emulate");
    (document.querySelector(".mb-overlay .mb-dialog__head button") as HTMLElement)?.click();
  });

  it("security: bundle id, oldest build and store links; passkeys by apple-app-site-association", async () => {
    await tab("iosRoot", "security");
    await tick(30);
    const root = $("#iosRoot");
    expect(root.textContent).not.toContain("Package name");
    expect(root.textContent).toContain("Background check-in without APNs");
    ($('[data-testid="ios-min-build"]') as HTMLInputElement).value = "61401";
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Save the policy")!.click();
    await tick(20);
    expect(lastCall("/api/admin/ios/config", "PUT")!.body).toMatchObject({ enrollment: "open", bundleId: "cz.m5cet.app", minAppBuild: 61401, appStoreUrl: "https://apps.apple.com/app/m5cet/id1", testFlightUrl: "", policy: { lock: { maxAttempts: 8 } } });
    expect(lastCall("/api/admin/ios/config", "PUT")!.body.packageName).toBeUndefined();
    expect($('[data-testid="ios-passkeys"]').textContent).toContain("TEAM123456.cz.m5cet.app");
  });
});

describe("the Android page after it", () => {
  it("is still Android's: its API, FCM, the package name — and the iOS page keeps its place", async () => {
    calls.length = 0;
    await routes.get("android")![2]();
    await tick(20);
    expect(calls.every((c) => !c.path.startsWith("/api/admin/ios"))).toBe(true);
    expect(lastCall("/api/admin/android")).toBeTruthy();
    const root = $("#androidRoot");
    expect(root.textContent).toContain("APK versions");
    await tab("androidRoot", "security");
    await tick(30);
    expect(root.textContent).toContain("Package name");
    expect(root.textContent).toContain("Check-in without FCM");
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Save the policy")!.click();
    await tick(20);
    expect(lastCall("/api/admin/android/config", "PUT")!.body).toMatchObject({ enrollment: "open", packageName: "cz.m5cet.app" });
    await tab("androidRoot", "design");
    await tick(30);
    expect($("#androidRoot .and-phone").classList.contains("and-phone--ios")).toBe(false);
    expect(Array.from(document.querySelectorAll('#androidRoot select[aria-label="Device"] option')).map((o) => o.textContent)[0]).toBe("Compact 360 × 740");
    // Back to iOS: where it was (Security), its own API.
    calls.length = 0;
    await routes.get("ios")![2]();
    await tick(20);
    expect($('#iosRoot [data-tab="security"]').getAttribute("aria-pressed")).toBe("true");
    expect(calls.every((c) => !c.path.startsWith("/api/admin/android"))).toBe(true);
  });
});
