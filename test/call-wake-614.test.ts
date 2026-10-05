// @vitest-environment node
//
// 6.14 — call wake, the server side (docs/api.md › Buzení při hovoru): the
// relay frame's call fields (frames.ts), the relay turning a ring into a
// "call" wake and its end into the end of that ring, limited per sender and
// room (relay.ts), the notifier — the user's switch, the ring remembered, its
// end only where the ring went, a "missed call" in its place, never by e-mail
// (dispatch.ts) — and what each channel carries: web push (TTL 60, the call
// without its room), Android (sealed, the room for the app, 60 s, no end to an
// app before 6.14) and iOS (a VoIP push sealing the call itself — kind "call" /
// "call-end", expiry 60 s, no end after the ring is over; an alert device gets
// a neutral "Missed call" under the call's collapse id).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import type { WebSocket } from "ws";

const dir = mkdtempSync(join(tmpdir(), "m5-call-wake-"));
process.env.DATA_DIR = dir;
const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyFile = join(dir, "AuthKey_ABCDE12345.p8");
writeFileSync(keyFile, apnsKey.privateKey.export({ type: "pkcs8", format: "pem" }));
Object.assign(process.env, { APNS_KEY_FILE: keyFile, APNS_KEY_ID: "ABCDE12345", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "cz.m5cet.app", APNS_ENV: "production" });

const { parseFrame, KNOWN_FEATURES } = await import("../server/signaling/frames");
const { AwayRelay, CALL_WAKE_LIMITS } = await import("../server/signaling/relay");
const { accountRef } = await import("../server/signaling/refs");
const { AccountStore } = await import("../server/accounts/store");
const { MemoryQueue } = await import("../server/accounts/memqueue");
const { Notifier, CALL_WAKE } = await import("../server/notify/dispatch");
const { NotifyStore } = await import("../server/notify/store");
const channels = await import("../server/notify/channels");
const { DEFAULT_NOTIFY_CONFIG } = await import("../server/notify/config");
const tpl = await import("../client/src/lib/notify-template");
const { LOCALES } = await import("../client/src/lib/locales");
const apns = await import("../server/ios/apns");
const mobileCrypto = await import("../server/mobile/crypto");
const { iosStore } = await import("../server/ios/store");
const { sendIosNotify, voipCallContent, neutralAlert } = await import("../server/ios/commands");
const { forgetIosConfig } = await import("../server/ios/config");

type RelayPeer = import("../server/signaling/relay").RelayPeer;
type WakeRequest = import("../server/signaling/relay").WakeRequest;
type NotifyPayload = import("../server/notify/channels").NotifyPayload;
type Channel = import("../server/notify/channels").Channel;
type NotifyChannel = import("../client/src/lib/notify-template").NotifyChannel;
type StoredCredential = import("../server/accounts/webauthn").StoredCredential;

afterAll(() => { apns.setApnsTransport(null); iosStore.reset(); rmSync(dir, { recursive: true, force: true }); });

const ENVELOPE = { iv: "aXY=", ciphertext: "Y3Q=" };
const relayFrame = (extra: Record<string, unknown>) => parseFrame(JSON.stringify({ type: "relay", messageId: "cw_1:r", to: ["ref1"], envelope: ENVELOPE, ...extra }));

/* ================================================================ frames */

describe("the relay frame carries a call (frames.ts)", () => {
  it("the server says it in hello: clients send call wakes only to a server that does", () => {
    expect(KNOWN_FEATURES.has("call-wake")).toBe(true);
    expect(KNOWN_FEATURES.has("bin")).toBe(true);
  });

  it("a ring: call, callId, video — rebuilt from the validated fields", () => {
    expect(relayFrame({ call: true, callId: "cw_AbC-1", video: true })).toMatchObject({ type: "relay", call: true, callId: "cw_AbC-1", video: true });
    const plain = relayFrame({ call: true });
    expect(plain).toMatchObject({ call: true });
    expect(plain).not.toHaveProperty("callId");
    expect(plain).not.toHaveProperty("video");
  });

  it("an end needs the callId of its ring; ring and end exclude each other; a bad id is refused", () => {
    expect(relayFrame({ callEnd: true, callId: "cw_1" })).toMatchObject({ callEnd: true, callId: "cw_1" });
    expect(relayFrame({ callEnd: true, callId: "cw_1" })).not.toHaveProperty("call");
    expect(relayFrame({ callEnd: true })).toMatchObject({ code: "invalid-frame", message: expect.stringMatching(/callId/) });
    expect(relayFrame({ call: true, callEnd: true, callId: "cw_1" })).toMatchObject({ code: "invalid-frame" });
    expect(relayFrame({ call: true, callId: "room name with spaces" })).toMatchObject({ code: "invalid-frame" });
    expect(relayFrame({ call: true, callId: "x".repeat(97) })).toMatchObject({ code: "invalid-frame" });
  });

  it("without a call the call fields are dropped (a message stays a message); only `true` counts", () => {
    const f = relayFrame({ callId: "cw_1", video: true, callEnd: "yes", call: 1 });
    expect(f).toMatchObject({ type: "relay", messageId: "cw_1:r" });
    for (const k of ["call", "callEnd", "callId", "video"]) expect(f).not.toHaveProperty(k);
  });
});

/* ================================================================= relay */

const credential = (id: string): StoredCredential => ({ credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });

describe("the relay: a ring wakes with kind call, its end ends it, a flood wakes nobody (relay.ts)", () => {
  let store: InstanceType<typeof AccountStore>;
  let queue: InstanceType<typeof MemoryQueue>;
  let rooms: Map<string, Map<string, RelayPeer>>;
  let wakes: WakeRequest[];
  let statuses: string[];
  let now = 1_700_000_000_000;
  let sub = "";

  beforeEach(() => {
    sub = mkdtempSync(join(dir, "relay-"));
    store = new AccountStore(sub);
    queue = new MemoryQueue(() => now);
    rooms = new Map();
    wakes = [];
    statuses = [];
  });

  const relayOf = () => new AwayRelay(store, rooms, (_s, p) => { const x = p as { type: string; state?: string }; if (x.type === "relay-status") statuses.push(String(x.state)); return true; },
    () => queue, async (req) => { wakes.push(req); return { ok: true }; }, () => now);
  const peer = (id: string, room: string, name: string, extra: Partial<RelayPeer> = {}): RelayPeer => {
    const p: RelayPeer = { id, connId: `c-${id}`, room, name, socket: { id } as unknown as WebSocket, ...extra };
    if (!rooms.has(room)) rooms.set(room, new Map());
    rooms.get(room)!.set(id, p);
    return p;
  };
  const account = (name: string) => { const r = store.create(credential(`cred-${name}-0000000`), name, now); if (!r.ok) throw new Error(r.reason); return r.account; };

  it("a ring: one wake of kind call per away member with the call's id and video; stored like a message", async () => {
    const relay = relayOf();
    const alice = account("Alice");
    const carol = account("Carol");
    relay.restore([{ accountId: alice.id, room: "alpha", name: "Alice", since: now }, { accountId: carol.id, room: "alpha", name: "Carol", since: now }]);
    const bob = peer("bob", "alpha", "Bob");
    const refs = [accountRef("alpha", alice.id), accountRef("alpha", carol.id)];
    await relay.relay(bob, { messageId: "cw_9:r", to: refs, envelope: ENVELOPE, call: true, callId: "cw_9", video: true });
    expect(statuses).toEqual(["stored", "stored"]);
    expect(wakes).toEqual([
      { accountId: alice.id, room: "alpha", kind: "call", from: { name: "Bob" }, call: { id: "cw_9", video: true } },
      { accountId: carol.id, room: "alpha", kind: "call", from: { name: "Bob" }, call: { id: "cw_9", video: true } },
    ]);
    expect(queue.pending(alice.id, "alpha").map((i) => i.messageId)).toEqual(["cw_9:r"]);
  });

  it("an end: stored too (the record), and a wake that ends the ring — not limited", async () => {
    const relay = relayOf();
    const alice = account("Alice");
    relay.restore([{ accountId: alice.id, room: "alpha", name: "Alice", since: now }]);
    const bob = peer("bob", "alpha", "Bob", { accountId: account("Bob").id });
    const to = [accountRef("alpha", alice.id)];
    await relay.relay(bob, { messageId: "cw_9:r", to, envelope: ENVELOPE, call: true, callId: "cw_9" });
    now += 2_000;
    await relay.relay(bob, { messageId: "cw_9:e", to, envelope: ENVELOPE, callEnd: true, callId: "cw_9" });
    expect(wakes.map((w) => w.call)).toEqual([{ id: "cw_9", video: false }, { id: "cw_9", video: false, end: true }]);
    expect(wakes.every((w) => w.kind === "call" && w.count === undefined)).toBe(true);
    expect(queue.pending(alice.id, "alpha").map((i) => i.messageId)).toEqual(["cw_9:r", "cw_9:e"]);
  });

  it("someone awake in the room gets it handed over, nobody is woken", async () => {
    const relay = relayOf();
    const alice = account("Alice");
    peer("alice-tab", "alpha", "Alice", { accountId: alice.id });
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "cw_9:r", to: [accountRef("alpha", alice.id)], envelope: ENVELOPE, call: true, callId: "cw_9" });
    expect(statuses).toEqual(["forwarded"]);
    expect(wakes).toEqual([]);
  });

  it(`a sender rings at most every ${CALL_WAKE_LIMITS.gapMs / 1000} s and ${CALL_WAKE_LIMITS.max} times in ${CALL_WAKE_LIMITS.windowMs / 60_000} min per room — over it stored, nobody woken`, async () => {
    const relay = relayOf();
    const alice = account("Alice");
    relay.restore([{ accountId: alice.id, room: "alpha", name: "Alice", since: now }, { accountId: alice.id, room: "beta", name: "Alice", since: now }]);
    const bobId = account("Bob").id;
    const bob = peer("bob", "alpha", "Bob", { accountId: bobId });
    const to = [accountRef("alpha", alice.id)];
    const ring = (n: number, who = bob, room = "alpha") => relay.relay(who, { messageId: `cw_${n}:r`, to: [accountRef(room, alice.id)], envelope: ENVELOPE, call: true, callId: `cw_${n}` });
    await ring(1);
    now += 3_000;
    await ring(2); // too soon
    expect(wakes.map((w) => w.call?.id)).toEqual(["cw_1"]);
    expect(statuses).toEqual(["stored", "stored"]);
    expect(queue.pending(alice.id, "alpha")).toHaveLength(2);
    // Another member, or the same one in another room, is counted on its own.
    await ring(3, peer("dave", "alpha", "Dave", { accountId: account("Dave").id }));
    await ring(4, peer("bob-b", "beta", "Bob", { accountId: bobId }), "beta");
    expect(wakes.map((w) => w.call?.id)).toEqual(["cw_1", "cw_3", "cw_4"]);
    // At most `max` rings in the window (the one refused above does not count).
    for (let n = 5; n < 5 + CALL_WAKE_LIMITS.max; n++) { now += CALL_WAKE_LIMITS.gapMs; await ring(n); }
    expect(wakes.filter((w) => w.room === "alpha" && w.from.accountId === bobId).length).toBe(CALL_WAKE_LIMITS.max);
    // A new connection of the same account changes nothing; after the window it rings again.
    await relay.relay(peer("bob2", "alpha", "Bob", { accountId: bobId }), { messageId: "cw_50:r", to, envelope: ENVELOPE, call: true, callId: "cw_50" });
    expect(wakes.some((w) => w.call?.id === "cw_50")).toBe(false);
    now += CALL_WAKE_LIMITS.windowMs;
    await ring(51);
    expect(wakes.some((w) => w.call?.id === "cw_51")).toBe(true);
    // Its ends are never limited.
    await relay.relay(bob, { messageId: "cw_5:e", to, envelope: ENVELOPE, callEnd: true, callId: "cw_5" });
    expect(wakes[wakes.length - 1].call).toEqual({ id: "cw_5", video: false, end: true });
  });

  it("a guest without an account counts by its address, not by its connection", async () => {
    const relay = relayOf();
    const alice = account("Alice");
    relay.restore([{ accountId: alice.id, room: "alpha", name: "Alice", since: now }]);
    const to = [accountRef("alpha", alice.id)];
    await relay.relay(peer("g1", "alpha", "Guest", { ip: "203.0.113.7" }), { messageId: "cw_1:r", to, envelope: ENVELOPE, call: true, callId: "cw_1" });
    await relay.relay(peer("g2", "alpha", "Guest", { ip: "203.0.113.7" }), { messageId: "cw_2:r", to, envelope: ENVELOPE, call: true, callId: "cw_2" });
    expect(wakes.map((w) => w.call?.id)).toEqual(["cw_1"]);
  });

  it("a 6.7 ring without a callId still wakes, with an id the server gives it", async () => {
    const relay = relayOf();
    const alice = account("Alice");
    relay.restore([{ accountId: alice.id, room: "alpha", name: "Alice", since: now }]);
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m2", to: [accountRef("alpha", alice.id)], envelope: ENVELOPE, call: true });
    expect(wakes[0]).toMatchObject({ kind: "call", call: { id: "call-m2", video: false } });
  });
});

/* ============================================================== notifier */

type Sent = { channel: NotifyChannel; payload: NotifyPayload };

describe("the notifier: the switch, the ring, its end where the ring went (dispatch.ts)", () => {
  let accounts: InstanceType<typeof AccountStore>;
  let notifyStore: InstanceType<typeof NotifyStore>;
  let sent: Sent[];
  let now = Date.parse("2026-10-05T10:00:00Z");
  let present = false;
  let failing = new Set<NotifyChannel>();
  let alice = "";

  const fake = (id: NotifyChannel): Channel => ({
    id,
    ready: () => ({ ready: true, reason: "" }),
    targets: async () => 1,
    send: async ({ payload }) => {
      if (failing.has(id)) return [{ channel: id, target: "t", ok: false, error: "down", ms: 0 }];
      sent.push({ channel: id, payload });
      return [{ channel: id, target: "t", ok: true, ms: 0 }];
    },
  });
  const config = () => ({ ...DEFAULT_NOTIFY_CONFIG, channels: [{ id: "android" as const, on: true }, { id: "webpush" as const, on: true }, { id: "email" as const, on: true }] });
  const notifier = () => new Notifier({ accounts, store: notifyStore, config, channels: [fake("android"), fake("webpush"), fake("email")], present: () => present, now: () => now });
  const ring = (n: InstanceType<typeof Notifier>, id = "cw_1", video = false) => n.notify({ accountId: alice, kind: "call", room: "r3.alpha", from: { name: "Bob" }, call: { id, video } });
  const end = (n: InstanceType<typeof Notifier>, id = "cw_1") => n.notify({ accountId: alice, kind: "call", room: "r3.alpha", from: { name: "Bob" }, call: { id, video: false, end: true } });

  beforeEach(() => {
    const sub = mkdtempSync(join(dir, "notifier-"));
    accounts = new AccountStore(sub);
    notifyStore = new NotifyStore(() => join(sub, "notify"));
    const r = accounts.create(credential("cred-alice-00000000"), "Alice", now);
    if (!r.ok) throw new Error(r.reason);
    alice = r.account.id;
    sent = [];
    present = false;
    failing = new Set();
  });

  it("a ring: the call template, a tag of the call's own, `call` {id, video, at}; the room only for the app channel", async () => {
    notifyStore.setPrefs(alice, { privacy: "sender", order: ["webpush", "android"] });
    const n = notifier();
    expect(await ring(n, "cw_1", true)).toMatchObject({ ok: true, channel: "webpush" });
    expect(sent[0].payload).toMatchObject({ kind: "call", body: "Bob is calling you", tag: "m5-call-cw_1", sticky: true, sound: true, call: { id: "cw_1", video: true, at: now } });
    expect(sent[0].payload.call).not.toHaveProperty("room");
    expect(sent[0].payload).not.toHaveProperty("room"); // privacy "sender": no room at all for the browser
    const android = n.payloadFor({ accountId: alice, kind: "call", room: "r3.alpha", call: { id: "cw_1", video: false, at: 5 } }, notifyStore.prefs(alice), config(), "android");
    expect(android.call).toEqual({ id: "cw_1", video: false, at: 5, room: "r3.alpha" });
    expect(android).not.toHaveProperty("room");
  });

  it("calls switched off (or all, or quiet hours): no ring — and so no end", async () => {
    notifyStore.setPrefs(alice, { kinds: { call: false } });
    const n = notifier();
    expect(await ring(n)).toMatchObject({ ok: false, skipped: "call: off (user)" });
    expect(await end(n)).toMatchObject({ ok: false, skipped: expect.stringMatching(/no ring/) });
    notifyStore.setPrefs(alice, { kinds: { call: true }, on: false });
    expect(await ring(notifier(), "cw_2")).toMatchObject({ ok: false, skipped: "off (user)" });
    expect(sent).toEqual([]);
  });

  it("the end goes where the ring went — that channel only, as a quiet missed call in the ring's place — once", async () => {
    notifyStore.setPrefs(alice, { privacy: "sender", order: ["android", "webpush"] });
    failing.add("android");
    const n = notifier();
    expect(await ring(n)).toMatchObject({ ok: true, channel: "webpush" });
    failing.clear(); // android is back: the end still goes only by web push, where the ring is
    now += 20_000;
    const out = await end(n);
    expect(out).toMatchObject({ ok: true, channel: "webpush", order: ["webpush"] });
    const e = sent[1].payload;
    expect(e).toMatchObject({ kind: "call", tag: "m5-call-cw_1", body: "Bob: Missed call", sound: false, vibrate: false, sticky: false });
    expect(e.call).toEqual({ id: "cw_1", video: false, at: now - 20_000, end: true });
    expect(e.tpl.body).toBe(tpl.CALL_MISSED_BODY.en);
    expect(await end(n)).toMatchObject({ ok: false, skipped: expect.stringMatching(/no ring/) });
    expect(sent).toHaveLength(2);
  });

  it("the end of a ring that went by e-mail, of an unknown call, or too late is not sent; someone present sees the room", async () => {
    notifyStore.setPrefs(alice, { order: ["email"] });
    let n = notifier();
    await ring(n);
    expect(sent[0].channel).toBe("email");
    expect(await end(n)).toMatchObject({ ok: false, skipped: expect.stringMatching(/e-mail/) });
    notifyStore.setPrefs(alice, { order: ["android"] });
    n = notifier();
    expect(await end(n, "cw_unknown")).toMatchObject({ ok: false });
    await ring(n, "cw_2");
    now += CALL_WAKE.rememberMs + 1;
    expect(await end(n, "cw_2")).toMatchObject({ ok: false, skipped: expect.stringMatching(/no ring/) });
    now += 60_000;
    await ring(n, "cw_3");
    present = true;
    expect(await end(n, "cw_3")).toMatchObject({ ok: false, skipped: "present in the room" });
    expect(sent.map((s) => s.payload.call?.id)).toEqual(["cw_1", "cw_2", "cw_3"]);
  });

  it("the end passes the user's limits — its ring did", async () => {
    notifyStore.setPrefs(alice, { order: ["android"] });
    const n = notifier();
    await ring(n);
    notifyStore.setPrefs(alice, { order: ["android"], quiet: { on: true, from: "00:00", to: "23:59", tz: "UTC" } });
    expect(await end(n)).toMatchObject({ ok: true, channel: "android" });
  });

  it("the missed-call text speaks the nine languages with the template's variables", () => {
    const shape = (s: string) => ({ vars: [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort(), parts: (s.match(/\[/g) ?? []).length });
    for (const l of LOCALES) expect(shape(tpl.CALL_MISSED_BODY[l]), l).toEqual(shape(tpl.CALL_MISSED_BODY.en));
    expect(new Set(LOCALES.map((l) => tpl.CALL_MISSED_BODY[l])).size).toBeGreaterThanOrEqual(8);
    expect(tpl.renderNotification({ title: tpl.DEFAULT_TEMPLATES.call.title, body: tpl.CALL_MISSED_BODY }, "cs", { app: "M5cet", sender: "Žofie" }, "sender").body).toBe("Žofie: Zmeškaný hovor");
    expect(tpl.renderNotification({ title: tpl.DEFAULT_TEMPLATES.call.title, body: tpl.CALL_MISSED_BODY }, "de", { app: "M5cet", sender: "Žofie" }, "neutral").body).toBe("Verpasster Anruf");
  });
});

/* ============================================================== channels */

describe("what the channels carry (channels.ts)", () => {
  const payload = (over: Partial<NotifyPayload> = {}): NotifyPayload => ({
    v: 1, id: "n1", kind: "call", title: "M5cet", body: "Bob is calling you", tpl: { title: "", body: "" }, vars: { sender: "Bob" }, privacy: "sender",
    tag: "m5-call-cw_1", group: "kind", icon: "", accent: "", sound: true, vibrate: true, sticky: true, actions: false, url: "/signin", lang: "en", at: 1,
    call: { id: "cw_1", video: false, at: Date.now(), room: "r3.alpha" }, ...over,
  });

  it("web push: a ring and its end live 60 s, urgent", async () => {
    const calls: Array<{ payload: Record<string, unknown>; opts: Record<string, unknown> | undefined }> = [];
    const accounts = new AccountStore(mkdtempSync(join(dir, "wp-")));
    const r = accounts.create(credential("cred-wp-0000000000"), "Wp", 1);
    if (!r.ok) throw new Error(r.reason);
    accounts.addPush(r.account.id, { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } }, 1);
    const ch = channels.webPushChannel({ accounts, ready: () => true, send: async (_t, p, opts) => { calls.push({ payload: p, opts: opts as Record<string, unknown> }); return { ok: true }; } });
    await ch.send({ accountId: r.account.id, payload: payload({ call: { id: "cw_1", video: false, at: 1, end: true } }), config: DEFAULT_NOTIFY_CONFIG });
    expect(calls[0].opts).toMatchObject({ TTL: 60, urgency: "high" });
    expect(calls[0].payload).toMatchObject({ tag: "m5-call-cw_1", call: { id: "cw_1", end: true } });
  });

  it("Android: sealed per device, 60 s; an end only to an app from 6.14 on", async () => {
    const notifyStore = new NotifyStore(() => join(dir, "and-notify"));
    const devices: Record<string, import("../server/android/store").Device> = {};
    const dev = (id: string, appCode: number) => ({
      id, name: id, model: "Pixel", appVersion: "", appCode, locale: "en", signKey: "", encKey: "", kid: "", status: "active" as const, enrolledAt: 1, enrolledWith: "open",
      lastSeen: 1, lastIp: "", state: {}, notes: "", fcmToken: `fcm-${id}`,
    }) as unknown as import("../server/android/store").Device;
    devices.and_new = dev("and_new", 61400);
    devices.and_old = dev("and_old", 61300);
    notifyStore.linkDevice("acc-x", "and_new", "token-xxxxxxxxxxxxxxxxxxxxxx");
    notifyStore.linkDevice("acc-x", "and_old", "token-xxxxxxxxxxxxxxxxxxxxxx");
    const fcm: Array<{ token: string; data: Record<string, string>; opts: { ttlSeconds?: number; priority?: string } }> = [];
    const ch = channels.androidChannel({
      store: notifyStore, device: (id) => devices[id] ?? null, putDevice: () => undefined, putCommand: () => undefined,
      ready: () => ({ ready: true, reason: "" }),
      send: async (token, data, opts) => { fcm.push({ token, data, opts }); return { ok: true } as never; },
      wire: (_d, c) => ({ command: JSON.stringify(c) }),
    });
    const t0 = Date.now();
    const rang = await ch.send({ accountId: "acc-x", payload: payload(), config: DEFAULT_NOTIFY_CONFIG });
    expect(rang.map((a) => a.ok)).toEqual([true, true]);
    expect(fcm.map((f) => f.opts)).toMatchObject([{ ttlSeconds: 60, priority: "high" }, { ttlSeconds: 60, priority: "high" }]);
    const command = JSON.parse(fcm[0].data.command);
    expect(command.expiresAt - command.createdAt).toBe(60_000);
    expect(command.createdAt).toBeGreaterThanOrEqual(t0);
    expect(command.payload.call).toMatchObject({ id: "cw_1", room: "r3.alpha" });
    fcm.length = 0;
    const ended = await ch.send({ accountId: "acc-x", payload: payload({ sound: false, call: { id: "cw_1", video: false, at: 1, end: true, room: "r3.alpha" } }), config: DEFAULT_NOTIFY_CONFIG });
    expect(ended.map((a) => [a.target.split(" ")[0], a.ok])).toEqual([["and_new", true], ["and_old", false]]);
    expect(ended[1].error).toMatch(/6\.14/);
    expect(fcm.map((f) => f.token)).toEqual(["fcm-and_new"]);
  });
});

/* =================================================================== iOS */

type ApnsSent = { headers: Record<string, string>; body: string };
const apnsSent: ApnsSent[] = [];

class FakeStream extends EventEmitter {
  constructor(private readonly headers: Record<string, string>) { super(); }
  end(body?: string) {
    apnsSent.push({ headers: this.headers, body: String(body ?? "") });
    setImmediate(() => { this.emit("response", { ":status": 200, "apns-id": "1" }); this.emit("end"); });
  }
  close() { /* cancelled */ }
}
class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  request(headers: Record<string, string>) { return new FakeStream(headers); }
  close() { this.closed = true; }
  unref() { /* not a socket */ }
}

describe("iOS: a VoIP push seals the call itself (ios/commands.ts)", () => {
  const keys = { sign: mobileCrypto.newP256(), enc: mobileCrypto.newP256() };
  const VOIP = "b2".repeat(32);
  const APNS = "a1".repeat(32);
  const device = {
    id: "ios_cw1", name: "iPhone", model: "iPhone18,1", modelName: "iPhone 17 Pro", idiom: "phone", os: "iOS", osVersion: "26.0",
    appVersion: "6.14.0", appCode: 61400, locale: "cs-CZ", signKey: mobileCrypto.spkiOf(keys.sign.publicKey), encKey: mobileCrypto.spkiOf(keys.enc.publicKey), kid: "k",
    apnsToken: APNS, voipToken: VOIP, apnsEnv: "" as const, status: "active" as const, enrolledAt: 1, enrolledWith: "open", lastSeen: 1, lastIp: "", state: {}, notes: "",
  };
  const base = (call: NotifyPayload["call"], over: Partial<NotifyPayload> = {}): NotifyPayload => ({
    v: 1, id: "n1", kind: "call", title: "M5cet", body: "Bob is calling you", tpl: { title: "", body: "" }, vars: { app: "M5cet", sender: "Bob" }, privacy: "sender",
    tag: "m5-call-cw_7", group: "kind", icon: "", accent: "", sound: true, vibrate: true, sticky: true, actions: false, url: "/signin", lang: "cs", at: 5, call, ...over,
  });
  const open = (x: ApnsSent) => {
    const wire = JSON.parse(x.body).m5;
    expect(mobileCrypto.verifyP1363(iosStore.signingKey().publicKey, mobileCrypto.pushSignedString(device.id, wire.i, wire), wire.s)).toBe(true);
    return JSON.parse(mobileCrypto.eciesOpen(keys.enc.privateKey, device.id, "push", wire).toString());
  };

  beforeAll(async () => {
    apns.setApnsTransport({ connect: () => new FakeSession(), sleep: async () => undefined });
    await iosStore.ready();
    forgetIosConfig();
    iosStore.devices.put(device);
  });
  beforeEach(() => { apnsSent.length = 0; });

  it("a ring: VoIP, priority 10, expiry 60 s; sealed {kind: call, payload {call, room, who, video, at}} — nothing readable outside", async () => {
    const now = Date.now();
    expect(await sendIosNotify(device, base({ id: "cw_7", video: true, at: now - 1_000, room: "r3.secret-room" }), now)).toEqual({ ok: true });
    const x = apnsSent[0];
    expect(x.headers).toMatchObject({ "apns-push-type": "voip", "apns-topic": "cz.m5cet.app.voip", "apns-priority": "10", "apns-expiration": String(Math.floor((now + 60_000) / 1000)) });
    expect(x.headers[":path"]).toBe(`/3/device/${VOIP}`);
    expect(Object.keys(JSON.parse(x.body))).toEqual(["m5"]);
    expect(x.body).not.toContain("secret-room");
    expect(x.body).not.toContain("Bob");
    const content = open(x);
    expect(content).toEqual({ id: expect.stringMatching(/^cmd_/), kind: "call", at: now, exp: now + 60_000, payload: { call: "cw_7", room: "r3.secret-room", who: "Bob", video: true, at: now - 1_000 } });
    expect(iosStore.commands.get(content.id)).toMatchObject({ kind: "notify", status: "sent" });
  });

  it("the caller's name only as far as the privacy level lets it through", () => {
    const c = voipCallContent({ id: "cmd_1", createdAt: 10, expiresAt: 60_010 }, base({ id: "cw_7", video: false, at: 9, room: "r3.x" }, { vars: { app: "M5cet" } }));
    expect(c).toEqual({ id: "cmd_1", kind: "call", at: 10, exp: 60_010, payload: { call: "cw_7", room: "r3.x", who: "", video: false, at: 9 } });
  });

  it("an end within 60 s of the ring: VoIP kind call-end; later none (the phone ended the ring itself)", async () => {
    const now = Date.now();
    expect(await sendIosNotify(device, base({ id: "cw_7", video: false, at: now - 30_000, end: true, room: "r3.x" }, { sound: false }), now)).toEqual({ ok: true });
    expect(open(apnsSent[0])).toMatchObject({ kind: "call-end", payload: { call: "cw_7", room: "r3.x", at: now - 30_000 } });
    expect(await sendIosNotify(device, base({ id: "cw_7", video: false, at: now - 61_000, end: true, room: "r3.x" }, { sound: false }), now)).toEqual({ ok: true });
    expect(apnsSent).toHaveLength(1);
  });

  it("a device without a VoIP token: a neutral alert ring and a neutral, silent missed call under the call's collapse id", async () => {
    const alertOnly = { ...device, id: "ios_cw2", voipToken: "" };
    iosStore.devices.put(alertOnly);
    const now = Date.now();
    await sendIosNotify(alertOnly, base({ id: "cw_8", video: false, at: now }), now);
    await sendIosNotify(alertOnly, base({ id: "cw_8", video: false, at: now, end: true }, { sound: false }), now + 5_000);
    expect(apnsSent.map((x) => x.headers["apns-push-type"])).toEqual(["alert", "alert"]);
    expect(apnsSent.map((x) => x.headers["apns-collapse-id"])).toEqual(["m5-call-cw_8", "m5-call-cw_8"]);
    expect(JSON.parse(apnsSent[0].body).aps).toEqual({ alert: { title: "M5cet", body: "Příchozí hovor" }, "mutable-content": 1, sound: "default" });
    expect(JSON.parse(apnsSent[1].body).aps).toEqual({ alert: { title: "M5cet", body: "Zmeškaný hovor" }, "mutable-content": 1 });
    expect(neutralAlert("notify", "fi", "call", true).body).toBe("Vastaamaton puhelu");
  });
});
