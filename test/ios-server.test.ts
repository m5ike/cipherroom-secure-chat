// @vitest-environment node
// The iOS app's server side (6.14): a device's life through /api/ios/* —
// enrolment with the same proof as Android (and its APNs / PushKit tokens),
// signed check-ins (the same request signatures, replay protection, the
// signed policy), iOS builds (the same M5AB bundles, the iOS look, iOS app
// builds from 61400), release records (signed, staged, required below a
// minimum), control messages at check-in, events, positions, the define
// values — and that it is one server key with Android.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "m5-ios-"));
process.env.DATA_DIR = dir;
for (const k of ["APNS_KEY_FILE", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC", "APNS_ENV"]) delete process.env[k];

const crypto = await import("../server/mobile/crypto");
const bundle = await import("../server/mobile/bundle");
const { iosStore } = await import("../server/ios/store");
const { androidStore } = await import("../server/android/store");
const { iosReleaseSignedString, inRollout } = await import("../server/ios/releases");
const { IOS_THEME } = await import("../server/ios/design");

afterAll(() => { iosStore.reset(); androidStore.reset(); rmSync(dir, { recursive: true, force: true }); });

describe("an iOS device's life through the API", () => {
  let server: Server;
  let base = "";
  const dev = { sign: crypto.newP256(), enc: crypto.newP256(), id: "" };
  let serverKey = "";
  const APNS = "c0ffee".repeat(10) + "abcd";

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerIosRoutes } = await import("../server/ios/routes");
    const { registerIosAdminRoutes } = await import("../server/ios/admin-routes");
    const { registerAndroidRoutes } = await import("../server/android/routes");
    const { registerDefineRoutes } = await import("../server/define");
    const app = express();
    app.use(["/api/ios", "/api/android"], express.raw({ type: () => true, limit: "1mb" }));
    app.use(express.json({ limit: "8mb" }));
    app.use((_req, res, next) => { res.locals.adminName = "tester"; res.locals.adminRole = "owner"; next(); });
    registerIosAdminRoutes(app);
    registerIosRoutes(app);
    registerAndroidRoutes(app);
    registerDefineRoutes(app);
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server?.close(); });

  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/admin/ios${path}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };

  const signed = async (method: string, path: string, body?: unknown, opts: { time?: number; nonce?: string } = {}) => {
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const time = String(opts.time ?? Date.now());
    const nonce = opts.nonce ?? randomBytes(16).toString("base64url");
    const sig = crypto.signP1363(dev.sign.privateKey, crypto.requestSignedString(method, path, time, nonce, raw));
    return fetch(`${base}${path}`, { method, headers: { "x-m5-device": dev.id, "x-m5-time": time, "x-m5-nonce": nonce, "x-m5-signature": sig, "content-type": "application/json" }, body: method === "GET" ? undefined : raw });
  };
  const checkin = async (body: Record<string, unknown> = {}) => (await (await signed("POST", "/api/ios/checkin", { state: {}, ...body })).json()) as Record<string, any>;

  it("tells a new device the server key — the same key as Android's — and no APNs without the key", async () => {
    const info = await (await fetch(`${base}/api/ios/info`)).json() as Record<string, any>;
    const android = await (await fetch(`${base}/api/android/info`)).json() as Record<string, any>;
    expect(info.server.kid).toHaveLength(16);
    expect(info.server).toEqual(android.server);
    expect(info).toMatchObject({ platform: "ios", enrollment: "open", apns: null, minAppCode: 61400, bundleId: "cz.m5cet.app" });
    serverKey = info.server.publicKey;
  });

  it("enrols with the Android proof (and a code when codes are required), keeping the push tokens", async () => {
    const signKey = crypto.spkiOf(dev.sign.publicKey);
    const encKey = crypto.spkiOf(dev.enc.publicKey);
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`${base}/api/ios/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() as Record<string, any> };
    };
    const t0 = Date.now();
    expect((await post({ signKey, encKey, time: t0, proof: crypto.signP1363(crypto.newP256().privateKey, crypto.enrollSignedString(signKey, encKey, t0)) })).json.code).toBe("bad-proof");

    await admin("PUT", "/config", { enrollment: "code" });
    const created = await admin("POST", "/codes", { label: "ipad", uses: 1, days: 1 });
    const enrol = (code: string) => {
      const t = Date.now();
      return post({
        code, name: "Mike's iPhone", model: "iPhone18,1", modelName: "iPhone 17 Pro", idiom: "phone", os: "iOS", osVersion: "26.0",
        appVersion: "6.14.0", appCode: 61400, locale: "cs-CZ", signKey, encKey, apnsToken: `<${APNS.slice(0, 8)} ${APNS.slice(8).toUpperCase()}>`, voipToken: "ab".repeat(32), apnsEnv: "sandbox",
        time: t, proof: crypto.signP1363(dev.sign.privateKey, crypto.enrollSignedString(signKey, encKey, t)),
      });
    };
    expect((await enrol("AAAA-BBBB-CCCC")).status).toBe(403);
    const ok = await enrol(created.json.code);
    expect(ok.status).toBe(200);
    dev.id = ok.json.deviceId;
    expect(dev.id).toMatch(/^ios_/);
    expect(ok.json.server.publicKey).toBe(serverKey);
    const ps = ok.json.policySigned;
    expect(crypto.verifyP1363(serverKey, crypto.policySignedString(dev.id, ps.at, ps.policy), ps.sig)).toBe(true);
    expect(JSON.parse(ps.policy)).toEqual(ok.json.policy);
    await admin("PUT", "/config", { enrollment: "open" });

    const stored = iosStore.devices.get(dev.id)!;
    expect(stored).toMatchObject({ apnsToken: APNS, voipToken: "ab".repeat(32), apnsEnv: "sandbox", idiom: "phone", modelName: "iPhone 17 Pro", osVersion: "26.0", appCode: 61400 });
    // The console sees that it has tokens, never the tokens or keys.
    const shown = (await admin("GET", `/devices/${dev.id}`)).json.device;
    expect(shown).toMatchObject({ push: "apns", voip: true, name: "Mike's iPhone" });
    expect(JSON.stringify(shown)).not.toContain(APNS);
    expect(shown.signKey).toBeUndefined();
  });

  it("refuses unsigned, forged, stale and replayed requests; a signature for /api/android does not open /api/ios", async () => {
    expect((await fetch(`${base}/api/ios/checkin`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await signed("POST", "/api/ios/checkin", {}, { time: Date.now() - 10 * 60 * 1000 })).status).toBe(401);
    const nonce = randomBytes(16).toString("base64url");
    expect((await signed("POST", "/api/ios/checkin", { state: {} }, { nonce })).status).toBe(200);
    expect((await signed("POST", "/api/ios/checkin", { state: {} }, { nonce })).status).toBe(401);
    const time = String(Date.now());
    const n2 = randomBytes(16).toString("base64url");
    const raw = Buffer.from('{"state":{}}');
    const sigForAndroid = crypto.signP1363(dev.sign.privateKey, crypto.requestSignedString("POST", "/api/android/checkin", time, n2, raw));
    const crossed = await fetch(`${base}/api/ios/checkin`, { method: "POST", headers: { "x-m5-device": dev.id, "x-m5-time": time, "x-m5-nonce": n2, "x-m5-signature": sigForAndroid }, body: raw });
    expect(crossed.status).toBe(401);
    expect(((await crossed.json()) as Record<string, string>).code).toBe("bad-signature");
  });

  it("checks in: the signed policy, tokens replaced or cleared, a required update below the minimum build", async () => {
    const first = await checkin({ apnsToken: "ff".repeat(32), state: { battery: 80, push: "apns", locked: true, policyAt: 123, biometry: "faceID", lockMode: "biometric" } });
    expect(crypto.verifyP1363(serverKey, crypto.policySignedString(dev.id, first.policySigned.at, first.policySigned.policy), first.policySigned.sig)).toBe(true);
    expect(first).toMatchObject({ push: "poll", apns: null, minBuild: 0, updateRequired: false, release: null });
    const d = iosStore.devices.get(dev.id)!;
    expect(d.apnsToken).toBe("ff".repeat(32));
    expect(d.voipToken).toBe("ab".repeat(32)); // absent: kept
    expect(d.state).toMatchObject({ battery: 80, push: "apns", locked: true, policyAt: 123, biometry: "faceID", lockMode: "biometric" });
    await checkin({ voipToken: "" });
    expect(iosStore.devices.get(dev.id)!.voipToken).toBe("");

    await admin("PUT", "/config", { minAppBuild: 61500 });
    const behind = await checkin({ appCode: 61400 });
    expect(behind).toMatchObject({ minBuild: 61500, updateRequired: true });
    expect((await (await fetch(`${base}/api/ios/info`)).json() as Record<string, any>).minBuild).toBe(61500);
    await admin("PUT", "/config", { minAppBuild: 0 });
  });

  it("gets a published iOS build — the iOS look, for iOS apps from 61400 — encrypted for it, and opens it", async () => {
    const created = await admin("POST", "/builds", { notes: "first iOS look", channel: "stable" });
    expect(created.status).toBe(200);
    const b = created.json.build;
    expect(b.id).toMatch(/^ibld_/);
    expect(b.minAppCode).toBeGreaterThanOrEqual(61400);
    expect((await admin("POST", `/builds/${b.id}/publish`, { notify: false })).json.build.status).toBe("published");
    expect((await checkin({ appCode: 61399 })).bundle).toBeNull();
    const check = await checkin({ appCode: Math.max(61400, b.minAppCode) });
    expect(check.bundle).toMatchObject({ id: b.id, minAppCode: b.minAppCode });
    const file = Buffer.from(await (await signed("GET", `/api/ios/bundles/${b.id}`)).arrayBuffer());
    const opened = crypto.openBundleFile(file, { id: dev.id, privateKey: dev.enc.privateKey }, serverKey);
    const content = bundle.readContent(opened.plaintext);
    expect(content.manifest.screens).toContain("room");
    expect(JSON.parse(content.files.get("theme.json")!.toString()).light.primary).toBe(IOS_THEME.light.primary);
    // Not encrypted for anybody else; the console can look inside.
    expect(() => crypto.openBundleFile(file, { id: "ios_other", privateKey: crypto.newP256().privateKey }, serverKey)).toThrow();
    expect((await admin("GET", `/builds/${b.id}/content`)).json.design.theme.light.primary).toBe(IOS_THEME.light.primary);
    // An Android device's API knows nothing of it.
    expect(androidStore.builds.get(b.id)).toBeNull();
  });

  it("offers a signed release record — App Store link, notes, staged rollout, required below its minimum", async () => {
    expect((await admin("POST", "/releases", { version: "6.15.0", channel: "stable" })).json.message).toMatch(/App Store link/);
    expect((await admin("PUT", "/config", { appStoreUrl: "https://evil.example/app" })).status).toBe(400);
    await admin("PUT", "/config", { appStoreUrl: "https://apps.apple.com/app/m5cet/id1234567890" });
    const made = await admin("POST", "/releases", { version: "6.15.0", channel: "stable", notes: { en: "Faster", cs: "Rychlejší", xx: "dropped" }, rollout: 100 });
    expect(made.status).toBe(200);
    const rel = made.json.release;
    expect(rel).toMatchObject({ build: 61500, store: "appstore", url: "https://apps.apple.com/app/m5cet/id1234567890", status: "draft", notes: { en: "Faster", cs: "Rychlejší" } });
    expect(rel.notes.xx).toBeUndefined();
    expect((await admin("POST", "/releases", { version: "6.15.0" })).status).toBe(409);
    expect((await checkin({ appCode: 61400 })).release).toBeNull(); // a draft is offered to nobody
    await admin("POST", `/releases/${rel.id}/publish`, { notify: false });
    const check = await checkin({ appCode: 61400 });
    expect(check.release).toMatchObject({ id: rel.id, version: "6.15.0", build: 61500, mandatory: false, url: rel.url });
    const got = await (await signed("GET", `/api/ios/releases/${rel.id}`)).json() as Record<string, any>;
    expect(got.signed).toBe(iosReleaseSignedString(rel));
    expect(got.signed).toBe(`m5iosrelease/1|${rel.id}|6.15.0|61500|cz.m5cet.app|stable|appstore|https://apps.apple.com/app/m5cet/id1234567890|0`);
    expect(crypto.verifyP1363(serverKey, got.signed, got.signature)).toBe(true);
    expect(crypto.verifyP1363(serverKey, got.signed.replace("apps.apple.com", "evil.example"), got.signature)).toBe(false);
    // The version of a published release stays; the rollout may change (and is signed again — the record is).
    expect((await admin("PATCH", `/releases/${rel.id}`, { build: 61501 })).status).toBe(409);
    await admin("PATCH", `/releases/${rel.id}`, { rollout: 0 });
    expect((await checkin({ appCode: 61400 })).release).toBeNull();
    // Below its minimum the device is told whatever the rollout.
    await admin("PATCH", `/releases/${rel.id}`, { minBuild: 61450 });
    const must = await checkin({ appCode: 61400 });
    expect(must.release).toMatchObject({ id: rel.id, mandatory: true, minBuild: 61450 });
    expect(must).toMatchObject({ minBuild: 61450, updateRequired: true });
    await admin("POST", `/releases/${rel.id}/withdraw`, {});
    expect((await checkin({ appCode: 61400 })).release).toBeNull();
  });

  it("stages a rollout by device: the same devices each time, about the share asked", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `ios_${i}`);
    const share = ids.filter((id) => inRollout(id, "irel_x", 25)).length / ids.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
    expect(ids.filter((id) => inRollout(id, "irel_x", 25))).toEqual(ids.filter((id) => inRollout(id, "irel_x", 25)));
    expect(inRollout("ios_1", "irel_x", 0)).toBe(false);
    expect(inRollout("ios_1", "irel_x", 100)).toBe(true);
  });

  it("delivers a signed, sealed control message at check-in and takes the answer", async () => {
    const sent = await admin("POST", `/devices/${dev.id}/commands`, { kind: "lock", payload: { reason: "lost" } });
    expect(sent.json.via).toBe("poll"); // no APNs key here
    const check = await checkin();
    const wire = check.commands.find((c: { i: string }) => c.i === sent.json.command.id);
    expect(crypto.verifyP1363(serverKey, crypto.pushSignedString(dev.id, wire.i, wire), wire.s)).toBe(true);
    expect(JSON.parse(crypto.eciesOpen(dev.enc.privateKey, dev.id, "push", wire).toString())).toMatchObject({ kind: "lock", payload: { reason: "lost" } });
    const ack = await (await signed("POST", "/api/ios/ack", { id: wire.i, ok: true, result: { state: { locked: true } } })).json() as Record<string, any>;
    expect(ack.status).toBe("done");
    const pushTest = await admin("POST", "/push/test", { device: dev.id, type: "alert" });
    expect(pushTest.json).toMatchObject({ via: "poll", result: null });
    expect(pushTest.json.apns.ready).toBe(false);
  });

  it("keeps positions (policy permitting) and message actions; the define values are the mobile apps'", async () => {
    const now = Date.now();
    const res = await (await signed("POST", "/api/ios/location", { points: [{ lat: 50.08, lon: 14.42, acc: 5, at: now - 60_000 }, { lat: 50.09, lon: 14.43, acc: 5, at: now - 20_000 }] })).json() as Record<string, any>;
    expect(res.stored).toBe(2);
    expect((await admin("GET", `/devices/${dev.id}/locations`)).json.points).toHaveLength(2);
    const audited = await (await signed("POST", "/api/ios/message-audit", { action: "hide", messageId: "m1", room: "r3.room" })).json() as Record<string, any>;
    expect(audited).toMatchObject({ ok: true, recorded: 1 });
    const ios = await (await fetch(`${base}/api/define?scope=ios`)).json() as Record<string, any>;
    const android = await (await fetch(`${base}/api/define?scope=android`)).json() as Record<string, any>;
    expect(ios.values).toEqual(android.values);
  });

  it("records events; a wipe (even signed long ago) retires the device and forgets its tokens", async () => {
    const res = await signed("POST", "/api/ios/events", { events: [{ id: "evt-ios-0001", type: "unlock-failed", at: Date.now(), detail: { attempts: 2 } }] });
    expect((await res.json() as Record<string, any>).stored).toBe(1);
    const late = await signed("POST", "/api/ios/events", { events: [{ id: "evt-ios-wipe1", type: "wipe", at: Date.now() - 86_400_000 }] }, { time: Date.now() - 2 * 86_400_000 });
    expect(late.status).toBe(200);
    const d = iosStore.devices.get(dev.id)!;
    expect(d).toMatchObject({ status: "wiped", apnsToken: "", voipToken: "" });
    expect((await signed("POST", "/api/ios/checkin", { state: {} })).status).toBe(403);
    expect((await admin("GET", "/events?type=wipe")).json.events.map((e: { deviceId: string }) => e.deviceId)).toContain(dev.id);
  });
});
