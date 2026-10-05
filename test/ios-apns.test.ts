// @vitest-environment node
// APNs (6.14, server/ios/apns.ts and commands.ts) without the network: a fake
// HTTP/2 session records every request. The provider token (ES256 JWT, kid +
// iss + iat, reused ≤ 50 min, renewed once on ExpiredProviderToken), the
// request (path, topic, push type, priority, expiration, collapse id, host by
// environment), the outcomes (410 / BadDeviceToken forget the token, 429 / 5xx
// and a broken connection are retried, an oversized payload never leaves),
// and the payload the Notification Service Extension gets: the same signed,
// ECIES-sealed control message as FCM's, under "m5", with a neutral alert.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, generateKeyPairSync, verify as nodeVerify } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "m5-ios-apns-"));
process.env.DATA_DIR = dir;
const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyFile = join(dir, "AuthKey_ABCDE12345.p8");
writeFileSync(keyFile, apnsKey.privateKey.export({ type: "pkcs8", format: "pem" }));
Object.assign(process.env, { APNS_KEY_FILE: keyFile, APNS_KEY_ID: "ABCDE12345", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "cz.m5cet.app", APNS_ENV: "production" });

const apns = await import("../server/ios/apns");
const crypto = await import("../server/mobile/crypto");
const { iosStore } = await import("../server/ios/store");
const { sendIosCommand, sendIosNotify, neutralAlert } = await import("../server/ios/commands");
const { forgetIosConfig } = await import("../server/ios/config");

type Sent = { origin: string; headers: Record<string, string>; body: string };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "network-error";

const sent: Sent[] = [];
let replies: Reply[] = [];
let connects = 0;
let clock = Date.parse("2026-10-05T10:00:00Z");

class FakeStream extends EventEmitter {
  constructor(private readonly origin: string, private readonly headers: Record<string, string>) { super(); }
  end(body?: string) {
    sent.push({ origin: this.origin, headers: this.headers, body: String(body ?? "") });
    const reply = replies.shift() ?? { status: 200, headers: { "apns-id": "11111111-2222-3333-4444-555555555555" } };
    setImmediate(() => {
      if (reply === "network-error") { this.emit("error", new Error("socket hang up")); return; }
      this.emit("response", { ":status": reply.status, ...(reply.headers ?? {}) });
      if (reply.body !== undefined) this.emit("data", Buffer.from(JSON.stringify(reply.body)));
      this.emit("end");
    });
  }
  close() { /* cancelled */ }
}
class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  constructor(private readonly origin: string) { super(); }
  request(headers: Record<string, string>) { return new FakeStream(this.origin, headers); }
  close() { this.closed = true; }
  unref() { /* not a socket */ }
}

beforeAll(() => {
  apns.setApnsTransport({ connect: (origin) => { connects++; return new FakeSession(origin); }, sleep: async () => undefined, now: () => clock });
});
afterAll(() => { apns.setApnsTransport(null); iosStore.reset(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { sent.length = 0; replies = []; });

const TOKEN = "a1".repeat(32);
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

describe("the provider token", () => {
  it("is ES256 over {alg, kid}.{iss, iat}, a 64-byte JOSE signature that verifies", () => {
    const jwt = apns.apnsJwt(apnsKey.privateKey, "ABCDE12345", "TEAM123456", 1_760_000_000);
    const [h, c, s] = jwt.split(".");
    expect(decode(h)).toEqual({ alg: "ES256", kid: "ABCDE12345" });
    expect(decode(c)).toEqual({ iss: "TEAM123456", iat: 1_760_000_000 });
    const sig = Buffer.from(s, "base64url");
    expect(sig).toHaveLength(64);
    expect(nodeVerify("sha256", Buffer.from(`${h}.${c}`), { key: createPublicKey(apnsKey.privateKey), dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("is reused for at most 50 minutes", async () => {
    const send = () => apns.apnsSend({ token: TOKEN, type: "background", priority: 5, payload: { aps: { "content-available": 1 } } });
    await send();
    clock += 49 * 60_000;
    await send();
    clock += 2 * 60_000;
    await send();
    const auth = sent.map((x) => x.headers.authorization);
    expect(auth[0]).toBe(auth[1]);
    expect(auth[2]).not.toBe(auth[1]);
    expect(decode(auth[2].split(" ")[1].split(".")[1]).iat).toBe(Math.floor(clock / 1000));
  });

  it("is made again (once) when Apple calls it expired", async () => {
    clock += 60_000;
    replies = [{ status: 403, body: { reason: "ExpiredProviderToken" } }, { status: 200, headers: { "apns-id": "x" } }];
    const r = await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: { aps: { alert: "x" } } });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(sent[0].headers.authorization).not.toBe(sent[1].headers.authorization);
    replies = [{ status: 403, body: { reason: "InvalidProviderToken" } }, { status: 403, body: { reason: "InvalidProviderToken" } }];
    const twice = await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: {} });
    expect(twice).toMatchObject({ ok: false, status: 403, reason: "InvalidProviderToken", attempts: 2 });
  });
});

describe("the request", () => {
  it("names the device, the topic, the push type, the priority, the expiry and the collapse id", async () => {
    const r = await apns.apnsSend({ token: TOKEN, type: "background", priority: 5, payload: { aps: { "content-available": 1 } }, expiration: 1_760_003_600, collapseId: "m5-status" });
    expect(r.ok).toBe(true);
    const x = sent[0];
    expect(x.origin).toBe("https://api.push.apple.com");
    expect(x.headers).toMatchObject({
      ":method": "POST", ":path": `/3/device/${TOKEN}`, "apns-topic": "cz.m5cet.app", "apns-push-type": "background",
      "apns-priority": "5", "apns-expiration": "1760003600", "apns-collapse-id": "m5-status", "content-type": "application/json",
    });
    expect(x.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(x.body)).toEqual({ aps: { "content-available": 1 } });
  });

  it("VoIP goes to <topic>.voip; a sandbox device to the sandbox host; one connection per host is reused", async () => {
    const before = connects;
    await apns.apnsSend({ token: TOKEN, type: "voip", priority: 10, payload: { m5: {} }, env: "sandbox" });
    await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: {}, env: "sandbox" });
    expect(sent[0].origin).toBe("https://api.sandbox.push.apple.com");
    expect(sent[0].headers["apns-topic"]).toBe("cz.m5cet.app.voip");
    expect(sent[0].headers["apns-push-type"]).toBe("voip");
    expect(sent[1].headers["apns-topic"]).toBe("cz.m5cet.app");
    expect(connects - before).toBe(1);
  });

  it("410 and BadDeviceToken mark the token dead; the error never carries the whole token", async () => {
    replies = [{ status: 410, body: { reason: "Unregistered", timestamp: 1 } }];
    const gone = await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: {} });
    expect(gone).toMatchObject({ ok: false, status: 410, unregistered: true, attempts: 1 });
    expect(gone.ok ? "" : gone.error).not.toContain(TOKEN);
    expect(gone.ok ? "" : gone.error).toContain(apns.maskToken(TOKEN));
    replies = [{ status: 400, body: { reason: "BadDeviceToken" } }];
    expect(await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: {} })).toMatchObject({ ok: false, status: 400, reason: "BadDeviceToken", unregistered: true });
    replies = [{ status: 400, body: { reason: "BadCollapseId" } }];
    expect(await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: {} })).toMatchObject({ ok: false, status: 400, reason: "BadCollapseId", unregistered: false, attempts: 1 });
  });

  it("retries 429, 5xx and a broken connection (three tries), then gives up", async () => {
    replies = [{ status: 503, body: { reason: "ServiceUnavailable" } }, "network-error", { status: 200, headers: { "apns-id": "ok" } }];
    const before = connects;
    expect(await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: {} })).toMatchObject({ ok: true, apnsId: "ok", attempts: 3 });
    expect(connects - before).toBe(1); // a new connection after the broken one
    replies = [{ status: 429, body: { reason: "TooManyRequests" } }, { status: 429, body: { reason: "TooManyRequests" } }, { status: 429, body: { reason: "TooManyRequests" } }];
    expect(await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: {} })).toMatchObject({ ok: false, status: 429, attempts: 3, unregistered: false });
  });

  it("refuses an oversized payload and a token that is not one, without the network", async () => {
    const big = await apns.apnsSend({ token: TOKEN, type: "alert", priority: 10, payload: { pad: "x".repeat(4100) } });
    expect(big).toMatchObject({ ok: false, reason: "PayloadTooLarge", attempts: 0 });
    expect(await apns.apnsSend({ token: TOKEN, type: "voip", priority: 10, payload: { pad: "x".repeat(4100) } })).toMatchObject({ ok: true });
    expect(await apns.apnsSend({ token: "not-hex", type: "alert", priority: 10, payload: {} })).toMatchObject({ ok: false, reason: "BadDeviceToken", attempts: 0 });
    expect(sent).toHaveLength(1);
  });

  it("is not ready without the key settings, or when ios.json switches it off", () => {
    expect(apns.apnsReady()).toMatchObject({ ready: true, topic: "cz.m5cet.app", env: "production", keyId: "ABCDE12345", teamId: "TEAM123456" });
    expect(apns.apnsSettings({ APNS_KEY_FILE: keyFile, APNS_KEY_ID: "short", APNS_TEAM_ID: "TEAM123456" }).problems.join()).toMatch(/APNS_KEY_ID/);
    expect(apns.apnsSettings({ APNS_KEY_ID: "ABCDE12345", APNS_TEAM_ID: "TEAM123456" }).problems.join()).toMatch(/APNS_KEY_FILE/);
    expect(apns.apnsSettings({ APNS_KEY_FILE: keyFile, APNS_KEY_ID: "ABCDE12345", APNS_TEAM_ID: "TEAM123456", APNS_ENV: "staging" }).problems.join()).toMatch(/APNS_ENV/);
  });
});

describe("control messages and notifications over APNs", () => {
  const dev = { sign: crypto.newP256(), enc: crypto.newP256() };
  const device = {
    id: "ios_test1", name: "Test iPhone", model: "iPhone18,1", modelName: "iPhone 17 Pro", idiom: "phone", os: "iOS", osVersion: "26.0",
    appVersion: "6.14.0", appCode: 61400, locale: "cs-CZ", signKey: crypto.spkiOf(dev.sign.publicKey), encKey: crypto.spkiOf(dev.enc.publicKey), kid: "k",
    apnsToken: TOKEN, voipToken: "b2".repeat(32), apnsEnv: "" as const, status: "active" as const, enrolledAt: 1, enrolledWith: "open", lastSeen: 1, lastIp: "", state: {}, notes: "",
  };
  const server = () => iosStore.signingKey().publicKey;

  beforeAll(async () => { await iosStore.ready(); forgetIosConfig(); iosStore.devices.put(device); });

  it("an alert command: a neutral text in the device's language, mutable-content, the sealed signed message under m5 — nothing that names a room", async () => {
    const out = await sendIosCommand(device, "push", { title: "Secret title", body: "Secret body", room: "r3.secret-room" }, "tester");
    expect(out.via).toBe("apns");
    expect(out.command.status).toBe("sent");
    const x = sent[0];
    expect(x.headers["apns-push-type"]).toBe("alert");
    expect(x.headers["apns-priority"]).toBe("10");
    expect(x.headers["apns-collapse-id"]).toBeUndefined();
    expect(Number(x.headers["apns-expiration"])).toBe(Math.floor(out.command.expiresAt / 1000));
    const payload = JSON.parse(x.body);
    expect(payload.aps).toEqual({ alert: { title: "M5cet", body: "Nové upozornění" }, "mutable-content": 1, sound: "default" });
    expect(payload.aps["thread-id"]).toBeUndefined();
    expect(x.body).not.toContain("Secret");
    expect(x.body).not.toContain("secret-room");
    const wire = payload.m5;
    expect(Object.keys(wire).sort()).toEqual(["ct", "e", "i", "iv", "m5", "s"]);
    expect(crypto.verifyP1363(server(), crypto.pushSignedString(device.id, wire.i, wire), wire.s)).toBe(true);
    const content = JSON.parse(crypto.eciesOpen(dev.enc.privateKey, device.id, "push", wire).toString());
    expect(content).toMatchObject({ id: out.command.id, kind: "push", payload: { title: "Secret title", body: "Secret body", room: "r3.secret-room" } });
  });

  it("a background command: content-available, priority 5, collapsed by kind", async () => {
    await sendIosCommand(device, "status", { logs: true }, "tester");
    const x = sent[0];
    expect(x.headers).toMatchObject({ "apns-push-type": "background", "apns-priority": "5", "apns-collapse-id": "m5-status" });
    const payload = JSON.parse(x.body);
    expect(payload.aps).toEqual({ "content-available": 1 });
    expect(payload.m5.m5).toBe("1");
  });

  it("lock and wipe show only a security notice", () => {
    expect(neutralAlert("lock", "en")).toEqual({ title: "M5cet", body: "Security notice" });
    expect(neutralAlert("wipe", "de-AT")).toEqual({ title: "M5cet", body: "Sicherheitshinweis" });
    expect(neutralAlert("notify", "xx", "call").body).toBe("Incoming call");
  });

  it("a dead token is forgotten and the command waits for the check-in", async () => {
    replies = [{ status: 410, body: { reason: "Unregistered" } }];
    const out = await sendIosCommand(device, "flash", { text: "hi" }, "tester");
    expect(out.via).toBe("poll");
    expect(out.error).toMatch(/410 Unregistered/);
    const now = iosStore.devices.get(device.id)!;
    expect(now.apnsToken).toBe("");
    expect(now.apnsError).toBe("Unregistered");
    const again = await sendIosCommand(now, "ping", {}, "tester");
    expect(again.via).toBe("poll");
    expect(sent).toHaveLength(1);
    iosStore.devices.put({ ...now, apnsToken: TOKEN, apnsError: undefined });
  });

  it("a call notification goes over PushKit (VoIP) when the device has a VoIP token; others are alerts grouped only by kind", async () => {
    const base = { v: 1 as const, id: "n1", title: "M5cet", body: "Alice calls", tpl: { title: "", body: "" }, vars: {}, privacy: "sender" as const, tag: "room-r3.secret", icon: "", accent: "", sound: true, vibrate: true, sticky: false, actions: false, url: "", lang: "en" as const, at: 1 };
    const d = iosStore.devices.get(device.id)!;
    expect(await sendIosNotify(d, { ...base, kind: "call", group: "room", room: "r3.secret" })).toEqual({ ok: true });
    expect(sent[0].headers["apns-push-type"]).toBe("voip");
    expect(sent[0].headers["apns-topic"]).toBe("cz.m5cet.app.voip");
    expect(sent[0].headers[":path"]).toBe(`/3/device/${"b2".repeat(32)}`);
    expect(JSON.parse(sent[0].body).aps).toBeUndefined();
    expect(sent[0].body).not.toContain("Alice");
    await sendIosNotify(d, { ...base, kind: "message", group: "kind" });
    expect(sent[1].headers["apns-push-type"]).toBe("alert");
    expect(sent[1].headers["apns-collapse-id"]).toBe("m5-notify-message");
    expect(JSON.parse(sent[1].body).aps.alert).toEqual({ title: "M5cet", body: "New message" });
    await sendIosNotify(d, { ...base, kind: "mention", group: "room", room: "r3.secret" });
    expect(sent[2].headers["apns-collapse-id"]).toBeUndefined();
    expect(sent[2].body).not.toContain("r3.secret");
    expect(iosStore.commands.list({ device: device.id, limit: 50, filter: (c) => c.kind === "notify" }).every((c) => c.status === "sent" && c.via === "apns")).toBe(true);
  });
});
