// @vitest-environment node
//
// Notifications (6.7), the server: the templates (variables, optional parts,
// escaping, privacy levels, quiet hours), the operator's settings, the
// notifier (channel order, fallback, never the sender or someone present,
// throttles, limits, the log), the three channels over stand-ins for their
// services (FCM, a push service, an SMTP relay), and the HTTP routes — the
// user's settings and test, unlinking a browser, the console, and an Android
// device asking to be woken for an account.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Server as NetServer } from "node:net";
import type { Server } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "m5-notify-"));
process.env.DATA_DIR = dir;
process.env.VAPID_PUBLIC_KEY = "BPub-test-key";
process.env.VAPID_PRIVATE_KEY = "priv-test-key";

const tpl = await import("../client/src/lib/notify-template");
const cfgMod = await import("../server/notify/config");
const { NotifyStore } = await import("../server/notify/store");
const { Notifier } = await import("../server/notify/dispatch");
const channels = await import("../server/notify/channels");
const smtp = await import("../server/notify/smtp");
const { AccountStore, accountStore } = await import("../server/accounts/store");
const push = await import("../server/push");
const crypto = await import("../server/android/crypto");
const { androidStore } = await import("../server/android/store");
const { setFcmFetch } = await import("../server/android/fcm");
const { saveAndroidConfig, androidConfig, forgetAndroidConfig } = await import("../server/android/config");

type Channel = import("../server/notify/channels").Channel;
type Attempt = import("../server/notify/channels").Attempt;
type NotifyPayload = import("../server/notify/channels").NotifyPayload;

afterAll(() => { androidStore.reset(); setFcmFetch(null); push.setWebPushModule(null); rmSync(dir, { recursive: true, force: true }); });

const credential = (id: string) => ({ credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });

/* ================================================================ templates */

describe("templates", () => {
  const v = (vars: Record<string, string | number>, privacy: import("../client/src/lib/notify-template").NotifyPrivacy = "content") => tpl.visibleVars(vars, privacy);

  it("puts variables in, drops an optional part with an empty one, and uses fallbacks", () => {
    const vars = v({ app: "M5cet", sender: "Bob" });
    expect(tpl.renderTemplate("{app}[ · {room}]", vars)).toBe("M5cet");
    expect(tpl.renderTemplate("[{sender}: ]{preview|New message}", vars)).toBe("Bob: New message");
    expect(tpl.renderTemplate("{sender|Someone} is calling", v({}))).toBe("Someone is calling");
    expect(tpl.renderTemplate("{nonsense}x{app}", v({ app: "A" }))).toBe("xA");
    expect(tpl.renderTemplate("a [b {room|r} c] d", v({}))).toBe("a b r c d"); // a fallback keeps the part
  });

  it("each privacy level shows only its own variables", () => {
    const all = { app: "M5cet", sender: "Bob", room: "Team", preview: "Hello", count: 3, time: "10:00", channel: "android" };
    const t = { title: tpl.DEFAULT_TEMPLATES.message.title, body: tpl.DEFAULT_TEMPLATES.message.body };
    expect(tpl.renderNotification(t, "en", all, "neutral")).toEqual({ title: "M5cet", body: "New message (3)" });
    expect(tpl.renderNotification(t, "en", all, "sender")).toEqual({ title: "M5cet", body: "Bob: New message (3)" });
    expect(tpl.renderNotification(t, "en", all, "room")).toEqual({ title: "M5cet · Team", body: "Bob: New message (3)" });
    expect(tpl.renderNotification(t, "en", all, "content")).toEqual({ title: "M5cet · Team", body: "Bob: Hello (3)" });
    expect(tpl.renderNotification(t, "cs", all, "neutral").body).toBe("Nová zpráva (3)");
    expect(tpl.renderNotification(t, "de", all, "sender").body).toBe("Bob: Neue Nachricht (3)");
  });

  it("a value is never read as a template, and loses control and bidi characters", () => {
    const vars = v({ sender: "{room} [x] \\{", room: "Secret" });
    expect(tpl.renderTemplate("{sender}", vars)).toBe("{room} [x] \\{");
    const evil = v({ sender: "Eve\u202e\u2066gnp.exe\r\nBcc: x\u0000\u200b" });
    expect(evil.sender).toBe("Evegnp.exe Bcc: x");
    expect(tpl.renderTemplate("\\{app\\} \\[{app}\\]", v({ app: "A" }))).toBe("{app} [A]");
    expect(tpl.renderTemplate("{app", v({ app: "A" }))).toBe("{app"); // no closing brace: as it is
  });

  it("bounds every value and the result", () => {
    const vars = v({ sender: "x".repeat(500), preview: "y".repeat(1000) });
    expect(vars.sender.length).toBe(64);
    expect(vars.preview.length).toBe(200);
    expect(tpl.renderTemplate("{sender}{sender}{sender}{sender}", vars, 100).length).toBe(100);
    expect(tpl.renderNotification({ title: { cs: "", en: "{preview}", de: "" }, body: { cs: "", en: "", de: "" } }, "en", { preview: "y".repeat(1000) }, "content").title.length).toBeLessThanOrEqual(tpl.TITLE_MAX);
  });

  it("an empty title falls back to the app's name", () => {
    expect(tpl.renderNotification({ title: { cs: "", en: "[{room}]", de: "" }, body: { cs: "", en: "x", de: "" } }, "en", { app: "Chat" }, "neutral").title).toBe("Chat");
  });

  it("the user's privacy is capped by what the operator allows", () => {
    expect(tpl.effectivePrivacy({ privacy: "neutral", maxPrivacy: "room" }, { privacy: "content" })).toBe("room");
    expect(tpl.effectivePrivacy({ privacy: "sender", maxPrivacy: "content" }, { privacy: "" })).toBe("sender");
    expect(tpl.effectivePrivacy({ privacy: "sender", maxPrivacy: "content" }, { privacy: "neutral" })).toBe("neutral");
  });

  it("quiet hours, across midnight and in the user's time zone", () => {
    const at = Date.UTC(2026, 9, 4, 22, 30); // 22:30 UTC = 00:30 in Prague (CEST)
    expect(tpl.inQuietHours({ on: true, from: "22:00", to: "07:00", tz: "UTC" }, at)).toBe(true);
    expect(tpl.inQuietHours({ on: true, from: "08:00", to: "17:00", tz: "UTC" }, at)).toBe(false);
    expect(tpl.inQuietHours({ on: true, from: "00:00", to: "01:00", tz: "Europe/Prague" }, at)).toBe(true);
    expect(tpl.inQuietHours({ on: false, from: "22:00", to: "07:00", tz: "UTC" }, at)).toBe(false);
    expect(tpl.timeIn(at, "Europe/Prague")).toBe("00:30");
  });

  it("a user's choice is cleaned: unknown kinds, channels and times are dropped", () => {
    const p = tpl.sanitizeUserPrefs({ on: false, kinds: { message: false, bogus: true, call: "yes" }, privacy: "everything", order: ["webpush", "sms", "webpush", "android"], quiet: { on: true, from: "25:00", to: "06:30", tz: "Europe/Prague; rm" }, lang: "fr" });
    expect(p).toEqual({ on: false, kinds: { message: false }, privacy: "", order: ["webpush", "android"], quiet: { on: true, from: "22:00", to: "06:30", tz: "" }, lang: "en" });
  });
});

/* ================================================================== config */

describe("the operator's settings", () => {
  it("caps a kind's privacy by its maximum and refuses bad icons, colours and senders", () => {
    const c = cfgMod.sanitizeNotifyConfig({
      templates: { call: { privacy: "content", maxPrivacy: "sender", accent: "red", icon: "<svg>", title: { en: "Hi\nthere" } } },
      email: { from: "Robot <bot@example.org>", host: "smtp.example.org; rm -rf" },
      channels: [{ id: "webpush", on: true }, "sms"],
    });
    expect(c.templates.call).toMatchObject({ privacy: "sender", maxPrivacy: "sender", accent: "", icon: "phone" });
    expect(c.templates.call.title.en).toBe("Hi there");
    expect(c.email.from).toBe("Robot <bot@example.org>");
    expect(c.email.host).toBe("");
    expect(c.channels).toEqual([{ id: "webpush", on: true }, { id: "android", on: false }, { id: "email", on: false }]);
  });

  it("keeps the SMTP password sealed on disk and out of what the console sees", () => {
    const store = new cfgMod.NotifyConfigStore(() => join(dir, "cfg-test"));
    const c = store.get();
    const saved = store.save({ ...c, email: { ...c.email, host: "smtp.example.org", pass: cfgMod.sealSmtpPassword("hunter2") } }, "tester");
    expect(readFileSync(join(dir, "cfg-test", "config.json"), "utf8")).not.toContain("hunter2");
    expect(cfgMod.openSmtpPassword(saved.email.pass)).toBe("hunter2");
    const pub = cfgMod.publicNotifyConfig(saved) as unknown as { email: Record<string, unknown> };
    expect(pub.email.pass).toBeUndefined();
    expect(pub.email.hasPassword).toBe(true);
    store.reset();
    expect(store.get().email.host).toBe("smtp.example.org");
    expect(store.get().updatedBy).toBe("tester");
  });
});

/* ================================================================ notifier */

type Fake = Channel & { sent: NotifyPayload[]; result: Partial<Attempt> | Error; count: number; isReady: boolean };

function fake(id: "android" | "webpush" | "email", result: Partial<Attempt> | Error = { ok: true }): Fake {
  const ch: Fake = {
    id, sent: [], result, count: 1, isReady: true,
    ready: () => (ch.isReady ? { ready: true, reason: "" } : { ready: false, reason: "not set up" }),
    targets: async () => ch.count,
    send: async ({ payload }) => {
      ch.sent.push(payload);
      if (ch.result instanceof Error) throw ch.result;
      return [{ channel: id, target: `${id}-1`, ok: false, ms: 1, ...ch.result }];
    },
  };
  return ch;
}

describe("the notifier", () => {
  let accounts: InstanceType<typeof AccountStore>;
  let store: InstanceType<typeof NotifyStore>;
  let config: ReturnType<typeof cfgMod.sanitizeNotifyConfig>;
  let now: number;
  let present: Set<string>;
  let acc: string;
  let android: Fake, web: Fake, mail: Fake;
  const make = () => new Notifier({ accounts, store, config: () => config, channels: [android, web, mail], present: (a, r) => present.has(`${a}|${r}`), now: () => now });

  beforeEach(() => {
    const d = mkdtempSync(join(dir, "n-"));
    accounts = new AccountStore(join(d, "acc"));
    store = new NotifyStore(() => join(d, "notify"));
    config = cfgMod.sanitizeNotifyConfig({ channels: [{ id: "android", on: true }, { id: "webpush", on: true }, { id: "email", on: true }] });
    now = Date.UTC(2026, 9, 4, 12, 0);
    present = new Set();
    const r = accounts.create(credential(`cred-${randomBytes(4).toString("hex")}-000000`), "Alice", now);
    if (!r.ok) throw new Error(r.reason);
    acc = r.account.id;
    android = fake("android", { ok: false, error: "UNREGISTERED" });
    web = fake("webpush", { ok: true });
    mail = fake("email", { ok: true });
  });

  it("falls back to the next channel when one fails, and records every attempt", async () => {
    const n = make();
    const out = await n.notify({ accountId: acc, kind: "message", room: "r3.room", from: { name: "Bob" } });
    expect(out).toMatchObject({ ok: true, channel: "webpush", order: ["android", "webpush", "email"] });
    expect(out.attempts.map((a) => [a.channel, a.ok])).toEqual([["android", false], ["webpush", true]]);
    expect(mail.sent).toHaveLength(0);
    const [entry] = n.log();
    expect(entry).toMatchObject({ outcome: "sent", channel: "webpush", kind: "message", account: acc });
    expect(entry.room).toMatch(/^[0-9a-f]{16}$/); // a hash, never the room id
    expect(JSON.stringify(n.log())).not.toContain("Bob");
    expect(n.stats()).toMatchObject({ sent: 1, channels: { android: { ok: 0, failed: 1 }, webpush: { ok: 1, failed: 0 } } });
  });

  it("a channel that throws counts as failed", async () => {
    android.result = new Error("boom");
    const out = await make().notify({ accountId: acc, kind: "message" });
    expect(out.channel).toBe("webpush");
    expect(out.attempts[0]).toMatchObject({ channel: "android", ok: false, error: "boom" });
  });

  it("says so when every channel failed", async () => {
    web.result = { ok: false, error: "500" };
    mail.result = { ok: false, error: "421" };
    const n = make();
    const out = await n.notify({ accountId: acc, kind: "message" });
    expect(out.ok).toBe(false);
    expect(out.attempts).toHaveLength(3);
    expect(n.log()[0]).toMatchObject({ outcome: "failed" });
  });

  it("follows the user's order, and leaves out the channels they removed", async () => {
    store.setPrefs(acc, { order: ["email", "webpush"] });
    const out = await make().notify({ accountId: acc, kind: "message" });
    expect(out).toMatchObject({ channel: "email", order: ["email", "webpush"] });
    expect(android.sent).toHaveLength(0);
  });

  it("uses only what the operator switched on, the server can use, and the account has", async () => {
    config.channels = config.channels.map((c) => (c.id === "webpush" ? { ...c, on: false } : c));
    mail.isReady = false;
    android.count = 0;
    const out = await make().notify({ accountId: acc, kind: "message" });
    expect(out.ok).toBe(false);
    expect(out.skipped).toMatch(/^no channel \(email: not set up; android: no endpoint\)|no channel \(android: no endpoint; email: not set up\)$/);
  });

  it("never notifies the sender, someone present, or an account that is gone", async () => {
    const n = make();
    expect((await n.notify({ accountId: acc, kind: "message", from: { accountId: acc, name: "Alice" } })).skipped).toBe("the sender themselves");
    present.add(`${acc}|r3.room`);
    expect((await n.notify({ accountId: acc, kind: "message", room: "r3.room" })).skipped).toBe("present in the room");
    expect((await n.notify({ accountId: "nobody-here", kind: "message" })).skipped).toBe("no such account");
    expect(web.sent).toHaveLength(0);
  });

  it("respects the user's and the operator's switches and quiet hours — a test goes through anyway", async () => {
    const n = make();
    store.setPrefs(acc, { kinds: { mention: false } });
    expect((await n.notify({ accountId: acc, kind: "mention" })).skipped).toBe("mention: off (user)");
    config.templates.function.on = false;
    expect((await n.notify({ accountId: acc, kind: "function" })).skipped).toBe("function: off (operator)");
    store.setPrefs(acc, { quiet: { on: true, from: "11:00", to: "13:00", tz: "UTC" } });
    expect((await n.notify({ accountId: acc, kind: "message" })).skipped).toBe("quiet hours");
    store.setPrefs(acc, { on: false });
    expect((await n.notify({ accountId: acc, kind: "message" })).skipped).toBe("off (user)");
    expect((await n.notify({ accountId: acc, kind: "test" })).ok).toBe(true);
    config.enabled = false;
    expect((await n.notify({ accountId: acc, kind: "test" })).skipped).toBe("notifications are off (operator)");
  });

  it("throttles per kind, account and room, and caps an account's hour", async () => {
    const n = make();
    expect((await n.notify({ accountId: acc, kind: "message", room: "a" })).ok).toBe(true);
    expect((await n.notify({ accountId: acc, kind: "message", room: "a" })).skipped).toBe("throttled");
    expect((await n.notify({ accountId: acc, kind: "message", room: "b" })).ok).toBe(true); // another room
    expect((await n.notify({ accountId: acc, kind: "mention", room: "a" })).ok).toBe(true); // another kind
    now += 31_000;
    expect((await n.notify({ accountId: acc, kind: "message", room: "a" })).ok).toBe(true);
    config.limits.perHour = 4;
    now += 31_000;
    expect((await n.notify({ accountId: acc, kind: "message", room: "a" })).skipped).toBe("hourly limit");
    now += 3_600_000;
    expect((await n.notify({ accountId: acc, kind: "message", room: "a" })).ok).toBe(true);
  });

  it("the payload carries what the privacy level allows — the room id only from 'room' on, never content", async () => {
    const n = make();
    await n.notify({ accountId: acc, kind: "message", room: "r3.secret", from: { name: "Bob" }, count: 2 });
    let p = web.sent[0];
    expect(p).toMatchObject({ v: 1, kind: "message", privacy: "neutral", title: "M5cet", body: "New message (2)", url: "/signin", tag: expect.stringMatching(/^m5-[0-9a-f]{16}$/) });
    expect(p.room).toBeUndefined();
    expect(p.vars.sender).toBeUndefined();
    expect(p.tpl.body).toBe(tpl.DEFAULT_TEMPLATES.message.body.en);

    store.setPrefs(acc, { privacy: "content", lang: "cs" });
    now += 60_000;
    await n.notify({ accountId: acc, kind: "message", room: "r3.secret", from: { name: "Bob" } });
    p = web.sent[web.sent.length - 1];
    expect(p).toMatchObject({ privacy: "content", room: "r3.secret", lang: "cs", body: "Bob: Nová zpráva", vars: { sender: "Bob", app: "M5cet" } });
    expect(p.vars.preview).toBeUndefined(); // the server has no content to give
  });
});

/* ================================================================ channels */

describe("the web push channel", () => {
  it("passes RFC 8030 options and prunes a subscription the push service says is gone", async () => {
    const accounts = new AccountStore(mkdtempSync(join(dir, "wp-")));
    const r = accounts.create(credential("cred-webpush-0000000"), "Wendy");
    if (!r.ok) throw new Error(r.reason);
    const id = r.account.id;
    accounts.addPush(id, { endpoint: "https://fcm.googleapis.com/fcm/send/dead", keys: { p256dh: "p", auth: "a" } });
    accounts.addPush(id, { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/live", keys: { p256dh: "p", auth: "a" } });
    const calls: Array<{ endpoint: string; payload: Record<string, unknown>; options: Record<string, unknown> }> = [];
    push.setWebPushModule({
      setVapidDetails: () => undefined,
      sendNotification: async (sub, payload, options) => {
        calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options: options as Record<string, unknown> });
        if (sub.endpoint.endsWith("dead")) throw Object.assign(new Error("Received unexpected response code"), { statusCode: 410 });
        return {};
      },
    });
    const ch = channels.webPushChannel(channels.defaultWebPushDeps(accounts));
    const payload = new Notifier({ accounts, store: new NotifyStore(() => join(dir, "wp-n")), config: () => cfgMod.DEFAULT_NOTIFY_CONFIG, channels: [] }).payloadFor({ accountId: id, kind: "call", room: "r3.x", from: { name: "Bob" } }, tpl.DEFAULT_USER_PREFS, cfgMod.DEFAULT_NOTIFY_CONFIG);
    const attempts = await ch.send({ accountId: id, payload, config: cfgMod.DEFAULT_NOTIFY_CONFIG });
    expect(attempts.map((a) => [a.ok, a.status, a.gone])).toEqual([[false, 410, true], [true, undefined, undefined]]);
    expect(attempts[0].target).toBe("fcm.googleapis.com/…d/dead");
    expect(accounts.get(id)!.push.map((p) => p.endpoint)).toEqual(["https://updates.push.services.mozilla.com/wpush/v2/live"]);
    expect(calls[0].options).toMatchObject({ TTL: 60, urgency: "high", timeout: 10_000 });
    expect(String(calls[0].options.topic)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(calls[0].payload).toMatchObject({ kind: "call", requireInteraction: true, body: "Bob is calling you" });
    push.setWebPushModule(null);
  });
});

describe("the Android channel", () => {
  const devKeys = { sign: crypto.newP256(), enc: crypto.newP256() };
  const device = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: "Pixel", model: "Pixel 9", manufacturer: "Google", os: "Android 16", sdk: 36, appVersion: "6.7.0", appCode: 67000, locale: "en",
    signKey: crypto.spkiOf(devKeys.sign.publicKey), encKey: crypto.spkiOf(devKeys.enc.publicKey), kid: "k", fcmToken: "tok-1",
    status: "active" as const, enrolledAt: 1, enrolledWith: "open", lastSeen: 1, lastIp: "", state: {}, notes: "", ...extra,
  });
  let fcmCalls: Array<{ url: string; body: string }>;
  let fcmAnswer: () => Response;

  beforeAll(async () => {
    await androidStore.ready();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = { type: "service_account", project_id: "m5-test", client_email: "fcm@m5-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.example/token" };
    const { sealServiceAccount } = await import("../server/android/config");
    saveAndroidConfig({ ...androidConfig(), fcm: { enabled: true, serviceAccount: sealServiceAccount(JSON.stringify(sa)), serviceAccountEmail: sa.client_email, projectId: "m5-test", client: { apiKey: "AIzaSyTEST_KEY_1234567890abcdefghi", appId: "1:1234567890:android:abcdef123456", senderId: "1234567890", projectId: "m5-test" } } }, "test");
    forgetAndroidConfig();
    setFcmFetch((async (url: string | URL | Request, init?: RequestInit) => {
      fcmCalls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      return fcmAnswer();
    }) as typeof fetch);
  });
  beforeEach(() => { fcmCalls = []; fcmAnswer = () => new Response(JSON.stringify({ name: "projects/m5-test/messages/1" }), { status: 200 }); });

  it("sends a sealed, signed 'notify' message only the device opens, and remembers it as sent", async () => {
    const store = new NotifyStore(() => join(dir, "and-1"));
    androidStore.devices.put(device("and_n1"));
    store.linkDevice("acc-a", "and_n1", "token-aaaaaaaaaaaaaaaaaaaaaa");
    const ch = channels.androidChannel(channels.defaultAndroidDeps(store));
    expect(ch.ready(cfgMod.DEFAULT_NOTIFY_CONFIG).ready).toBe(true);
    const payload = new Notifier({ accounts: new AccountStore(join(dir, "and-acc")), store, config: () => cfgMod.DEFAULT_NOTIFY_CONFIG, channels: [] })
      .payloadFor({ accountId: "acc-a", kind: "message", room: "r3.abc", from: { name: "Bob" } }, { ...tpl.DEFAULT_USER_PREFS, privacy: "room" }, cfgMod.DEFAULT_NOTIFY_CONFIG);
    const attempts = await ch.send({ accountId: "acc-a", payload, config: cfgMod.DEFAULT_NOTIFY_CONFIG });
    expect(attempts).toMatchObject([{ channel: "android", ok: true, target: "and_n1 (Pixel)" }]);
    const msg = JSON.parse(fcmCalls.find((c) => c.url.includes("messages:send"))!.body).message;
    expect(msg.android.priority).toBe("HIGH");
    // FCM sees only ciphertext: no name, no room id. (The ciphertext and signature are random base64 that may
    // contain "Bob" by chance — about once in a few hundred runs — so they are left out of this check.)
    const readable = JSON.stringify(msg).replace(/"[A-Za-z0-9+/_=-]{24,}"/g, '"…"');
    expect(readable).not.toContain("Bob");
    expect(readable).not.toContain("r3.abc");
    const server = androidStore.signingKey();
    expect(crypto.verifyP1363(server.publicKey, crypto.pushSignedString("and_n1", msg.data.i, msg.data), msg.data.s)).toBe(true);
    const content = JSON.parse(crypto.eciesOpen(devKeys.enc.privateKey, "and_n1", "push", msg.data).toString());
    expect(content).toMatchObject({ kind: "notify", payload: { kind: "message", room: "r3.abc", vars: { sender: "Bob" }, privacy: "room" } });
    expect(androidStore.commands.get(msg.data.i)).toMatchObject({ kind: "notify", status: "sent", via: "fcm" });
  });

  it("an unregistered token fails (the device checks in for a new one); a wiped device is unlinked", async () => {
    const store = new NotifyStore(() => join(dir, "and-2"));
    androidStore.devices.put(device("and_n2"));
    androidStore.devices.put(device("and_n3", { status: "wiped" }));
    store.linkDevice("acc-b", "and_n2", "token-bbbbbbbbbbbbbbbbbbbbbb");
    store.linkDevice("acc-b", "and_n3", "token-bbbbbbbbbbbbbbbbbbbbbb");
    fcmAnswer = () => new Response(JSON.stringify({ error: { status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 });
    const ch = channels.androidChannel(channels.defaultAndroidDeps(store));
    const payload = { ...new Notifier({ accounts: new AccountStore(join(dir, "and-acc2")), store, config: () => cfgMod.DEFAULT_NOTIFY_CONFIG, channels: [] }).payloadFor({ accountId: "acc-b", kind: "test" }, tpl.DEFAULT_USER_PREFS, cfgMod.DEFAULT_NOTIFY_CONFIG) };
    const attempts = await ch.send({ accountId: "acc-b", payload, config: cfgMod.DEFAULT_NOTIFY_CONFIG });
    expect(attempts.map((a) => [a.target.split(" ")[0], a.ok, Boolean(a.gone)])).toEqual([["and_n2", false, false], ["and_n3", false, true]]);
    expect(androidStore.devices.get("and_n2")!.fcmToken).toBe("");
    expect(store.devices("acc-b").map((d) => d.deviceId)).toEqual(["and_n2"]);
    // A failed notification is not delivered hours later at check-in.
    const failed = androidStore.commands.list({ device: "and_n2", limit: 5 })[0];
    expect(failed.status).toBe("failed");
  });
});

/** An SMTP relay on localhost that keeps what it is given. */
function fakeSmtp(opts: { rcpt?: string } = {}) {
  const mails: Array<{ from: string; to: string; auth: string; data: string }> = [];
  const server: NetServer = createServer((sock) => {
    sock.setEncoding("utf8");
    sock.write("220 fake ESMTP\r\n");
    let buf = "";
    let inData = false;
    let cur = { from: "", to: "", auth: "", data: "" };
    sock.on("data", (d: string) => {
      buf += d;
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          mails.push(cur);
          cur = { from: "", to: "", auth: "", data: "" };
          sock.write("250 queued\r\n");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO /.test(line)) sock.write("250-fake.example\r\n250-SIZE 1000000\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("AUTH PLAIN ")) { cur.auth = Buffer.from(line.slice(11), "base64").toString("utf8"); sock.write("235 ok\r\n"); }
        else if (line.startsWith("MAIL FROM:")) { cur.from = line.slice(10); sock.write("250 ok\r\n"); }
        else if (line.startsWith("RCPT TO:")) { cur.to = line.slice(8); sock.write(`${opts.rcpt ?? "250 ok"}\r\n`); }
        else if (line === "DATA") { inData = true; sock.write("354 go on\r\n"); }
        else if (line === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("502 what\r\n");
      }
    });
  });
  return { mails, server, listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))) };
}

const partOf = (data: string, type: string) => {
  const m = new RegExp(`Content-Type: ${type}; charset=utf-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`).exec(data);
  return m ? Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8") : "";
};

describe("the e-mail channel", () => {
  it("writes only to a confirmed address, with the title as subject and the HTML escaped", async () => {
    const relay = fakeSmtp();
    const port = await relay.listen();
    const store = new NotifyStore(() => join(dir, "mail-1"));
    const config = cfgMod.sanitizeNotifyConfig({ email: { host: "127.0.0.1", port, secure: "none", user: "bot", from: "M5cet <bot@example.org>" } });
    config.email.pass = cfgMod.sealSmtpPassword("s3cret");
    const ch = channels.emailChannel({ ...channels.defaultEmailDeps(store), baseUrl: () => "https://chat.example.org" });
    expect(ch.ready(config).ready).toBe(true);
    expect(ch.ready(cfgMod.DEFAULT_NOTIFY_CONFIG)).toMatchObject({ ready: false });

    const set = store.setEmail("acc-m", "Alice@Example.org");
    expect("token" in set).toBe(true);
    expect(await ch.targets("acc-m")).toBe(0); // not confirmed yet
    expect(store.confirmEmail((set as { token: string }).token)).toBe("acc-m");
    expect(await ch.targets("acc-m")).toBe(1);

    const payload = new Notifier({ accounts: new AccountStore(join(dir, "mail-acc")), store, config: () => config, channels: [] })
      .payloadFor({ accountId: "acc-m", kind: "message", from: { name: "<script>alert(1)</script>" } }, { ...tpl.DEFAULT_USER_PREFS, privacy: "sender" }, config);
    const attempts = await ch.send({ accountId: "acc-m", payload, config });
    expect(attempts).toMatchObject([{ channel: "email", ok: true, target: "a***@example.org", status: 250 }]);
    const mail = relay.mails[0];
    expect(mail.from).toBe("<bot@example.org>");
    expect(mail.to).toBe("<alice@example.org>");
    expect(mail.auth).toBe("\0bot\0s3cret");
    expect(mail.data).toContain("Subject: M5cet\r\n");
    expect(partOf(mail.data, "text/plain")).toContain("<script>alert(1)</script>: New message");
    const html = partOf(mail.data, "text/html");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;: New message");
    expect(html).not.toContain("<script>");
    expect(html).toContain("https://chat.example.org/signin");
    relay.server.close();
  });

  it("forgets an address the relay refuses for good", async () => {
    const relay = fakeSmtp({ rcpt: "550 no such user" });
    const port = await relay.listen();
    const store = new NotifyStore(() => join(dir, "mail-2"));
    const config = cfgMod.sanitizeNotifyConfig({ email: { host: "127.0.0.1", port, secure: "none", from: "bot@example.org" } });
    const set = store.setEmail("acc-x", "gone@example.org") as { token: string };
    store.confirmEmail(set.token);
    const ch = channels.emailChannel(channels.defaultEmailDeps(store));
    const payload = new Notifier({ accounts: new AccountStore(join(dir, "mail-acc2")), store, config: () => config, channels: [] }).payloadFor({ accountId: "acc-x", kind: "test" }, tpl.DEFAULT_USER_PREFS, config);
    const [a] = await ch.send({ accountId: "acc-x", payload, config });
    expect(a).toMatchObject({ ok: false, status: 550, gone: true });
    expect(store.email("acc-x")).toBeNull();
    relay.server.close();
  });

  it("builds a message no header value can break", () => {
    const raw = smtp.buildMessage({ from: "Bot <bot@example.org>", to: "a@example.org", subject: "Hi\r\nBcc: victim@example.org", text: "line\r\n.\r\nnext" });
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(smtp.encodeHeader("Nová zpráva")).toBe(`=?UTF-8?B?${Buffer.from("Nová zpráva").toString("base64")}?=`);
    expect(smtp.addressOf("Name <x@y.cz>")).toBe("x@y.cz");
  });
});

/* =================================================================== HTTP */

describe("the HTTP routes", () => {
  let server: Server;
  let base = "";
  let token = "";
  let accountId = "";
  const sentMail: Array<{ to: string; text: string }> = [];
  const dev = { id: "and_http1", sign: crypto.newP256(), enc: crypto.newP256() };
  let notifyStore: InstanceType<typeof NotifyStore>;

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerNotifyRoutes } = await import("../server/notify/routes");
    const { registerAndroidRoutes } = await import("../server/android/routes");
    const { createNotifierService } = await import("../server/notify/service");
    await androidStore.ready();
    const svc = createNotifierService(accountStore);
    notifyStore = svc.store;
    const app = express();
    app.use("/api/android", express.raw({ type: () => true, limit: "1mb" }));
    app.use(express.json());
    app.use((req, res, next) => { if (req.path.startsWith("/api/admin")) { res.locals.adminName = "tester"; res.locals.adminRole = "owner"; } next(); });
    registerNotifyRoutes(app, { accounts: accountStore, ...svc, sendMail: async (_cfg, msg) => { sentMail.push({ to: msg.to, text: msg.text }); return { ok: true, code: 250 }; } });
    registerAndroidRoutes(app);
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = accountStore.create(credential("cred-http-000000000"), "Harriet");
    if (!r.ok) throw new Error(r.reason);
    accountId = r.account.id;
    token = accountStore.issueToken(accountId);
    androidStore.devices.put({
      id: dev.id, name: "Fold", model: "SM-F956B", manufacturer: "Samsung", os: "Android 16", sdk: 36, appVersion: "6.7.0", appCode: 67000, locale: "cs",
      signKey: crypto.spkiOf(dev.sign.publicKey), encKey: crypto.spkiOf(dev.enc.publicKey), kid: "k", fcmToken: "tok-http",
      status: "active", enrolledAt: 1, enrolledWith: "open", lastSeen: 1, lastIp: "", state: {}, notes: "",
    });
  });
  afterAll(() => server?.close());

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
  };
  const signed = async (path: string, body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    const time = String(Date.now());
    const nonce = randomBytes(16).toString("base64url");
    const sig = crypto.signP1363(dev.sign.privateKey, crypto.requestSignedString("POST", path, time, nonce, raw));
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "x-m5-device": dev.id, "x-m5-time": time, "x-m5-nonce": nonce, "x-m5-signature": sig, "content-type": "application/json" }, body: raw });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };

  it("anyone reads the templates; nobody reads the SMTP relay there", async () => {
    const r = await call("GET", "/api/notify/config", undefined, false);
    expect(r.json.templates.message.body.en).toBe(tpl.DEFAULT_TEMPLATES.message.body.en);
    expect(r.json.email).toBeUndefined();
  });

  it("a signed-in user reads and saves their own choice; others are turned away", async () => {
    expect((await call("GET", "/api/account/notify", undefined, false)).status).toBe(401);
    const first = await call("GET", "/api/account/notify");
    expect(first.json).toMatchObject({ ok: true, saved: false, prefs: { on: true, privacy: "" }, endpoints: { android: [], webpush: 0, email: null } });
    const saved = await call("PUT", "/api/account/notify", { privacy: "sender", order: ["webpush", "android"], kinds: { function: false }, lang: "de", quiet: { on: true, from: "23:00", to: "06:00", tz: "Europe/Berlin" } });
    expect(saved.json.prefs).toMatchObject({ privacy: "sender", order: ["webpush", "android"], kinds: { function: false }, lang: "de" });
    expect((await call("GET", "/api/account/notify")).json.saved).toBe(true);
  });

  it("an Android device asks to be woken for the account, with its key and the account's session", async () => {
    expect((await signed("/api/android/notify", { token: "not-a-session-token-at-all" })).status).toBe(401);
    const ok = await signed("/api/android/notify", { token, on: true });
    expect(ok.json).toEqual({ ok: true, linked: true });
    expect(notifyStore.devices(accountId).map((d) => d.deviceId)).toEqual([dev.id]);
    const me = await call("GET", "/api/account/notify");
    expect(me.json.endpoints.android).toMatchObject([{ id: dev.id, name: "Fold", fcm: true }]);
    // Signing out of that session ends the link.
    const other = accountStore.issueToken(accountId);
    await signed("/api/android/notify", { token: other, on: true });
    accountStore.revokeToken(other);
    expect(notifyStore.devices(accountId)).toHaveLength(0);
    await signed("/api/android/notify", { token, on: true });
    expect((await signed("/api/android/notify", { on: false })).json.linked).toBe(false);
    expect(notifyStore.devices(accountId)).toHaveLength(0);
  });

  it("the user's test goes through the channels and says what happened", async () => {
    const r = await call("POST", "/api/account/notify/test", {});
    expect(r.status).toBe(409); // nothing linked yet
    expect(r.json.skipped).toMatch(/^no channel/);
    accountStore.addPush(accountId, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } });
    push.setWebPushModule({ setVapidDetails: () => undefined, sendNotification: async () => ({}) });
    const ok = await call("POST", "/api/account/notify/test", { channel: "webpush" });
    expect(ok.json).toMatchObject({ ok: true, channel: "webpush" });
    push.setWebPushModule(null);
  });

  it("a browser that turns notifications off stops being woken", async () => {
    expect((await call("DELETE", "/api/account/push", { endpoint: "https://10.0.0.5/x" })).status).toBe(400);
    expect((await call("DELETE", "/api/account/push", { endpoint: "https://fcm.googleapis.com/fcm/send/abc" })).json.ok).toBe(true);
    expect(accountStore.get(accountId)!.push).toHaveLength(0);
  });

  it("an e-mail address needs the operator's relay and its owner's confirmation", async () => {
    expect((await call("POST", "/api/account/notify/email", { address: "h@example.org" })).status).toBe(409);
    await call("PUT", "/api/admin/notify", { channels: [{ id: "android", on: true }, { id: "webpush", on: true }, { id: "email", on: true }], email: { host: "smtp.example.org", port: 587, from: "bot@example.org", pass: "pw" } });
    expect((await call("POST", "/api/account/notify/email", { address: "not an address" })).status).toBe(400);
    const r = await call("POST", "/api/account/notify/email", { address: "h@example.org" });
    expect(r.json).toMatchObject({ ok: true, email: { address: "h@example.org", confirmed: false } });
    const link = /https?:\/\/\S+confirm\?t=(\S+)/.exec(sentMail[0].text)!;
    expect(sentMail[0].to).toBe("h@example.org");
    const page = await fetch(`${base}/api/notify/email/confirm?t=${link[1]}`);
    expect(page.status).toBe(200);
    expect((await call("GET", "/api/account/notify")).json.endpoints.email).toMatchObject({ address: "h@example.org", confirmed: true });
    expect((await fetch(`${base}/api/notify/email/confirm?t=${link[1]}`)).status).toBe(400); // once only
  });

  it("the console reads and changes the settings, previews a template and reads the log", async () => {
    const r = await call("GET", "/api/admin/notify", undefined, false);
    expect(r.status).toBe(200);
    expect(r.json.config.email).toMatchObject({ host: "smtp.example.org", hasPassword: true });
    expect(r.json.config.email.pass).toBeUndefined();
    expect(r.json.channels.map((c: { id: string }) => c.id)).toEqual(["android", "webpush", "email"]);
    const saved = await call("PUT", "/api/admin/notify", { appName: "Firma", templates: { message: { body: { en: "[{sender} wrote]{preview|}" }, accent: "#ff0066" } }, email: { pass: "" } }, false);
    expect(saved.json.config.templates.message).toMatchObject({ accent: "#ff0066", body: { en: "[{sender} wrote]{preview|}", cs: tpl.DEFAULT_TEMPLATES.message.body.cs } });
    expect(saved.json.config.email.hasPassword).toBe(true); // "" keeps it
    // A template in part: the rest of it stays.
    const part = await call("PUT", "/api/admin/notify", { templates: { message: { sound: false, title: { de: "{app}!" } } } }, false);
    expect(part.json.config.templates.message).toMatchObject({ sound: false, accent: "#ff0066", body: { en: "[{sender} wrote]{preview|}" }, title: { de: "{app}!", en: tpl.DEFAULT_TEMPLATES.message.title.en } });
    const preview = await call("POST", "/api/admin/notify/preview", { kind: "message", lang: "en", privacy: "sender", vars: { sender: "Bob", room: "Team", preview: "Hi" } }, false);
    expect(preview.json).toMatchObject({ title: "Firma", body: "Bob wrote", visible: expect.arrayContaining(["app", "sender"]) });
    const log = await call("GET", `/api/admin/notify/log?account=${accountId}`, undefined, false);
    expect(log.json.entries.length).toBeGreaterThan(0);
    expect(log.json.entries.every((e: { account: string }) => e.account === accountId)).toBe(true);
    const test = await call("POST", "/api/admin/notify/test", { username: "nobody" }, false);
    expect(test.status).toBe(404);
  });

  it("deleting the account forgets its notification settings", async () => {
    expect(notifyStore.hasPrefs(accountId)).toBe(true);
    accountStore.deleteAccount(accountId);
    expect(notifyStore.hasPrefs(accountId)).toBe(false);
    expect(notifyStore.email(accountId)).toBeNull();
  });
});
