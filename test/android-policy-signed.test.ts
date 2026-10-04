// @vitest-environment node
// 6.7 (security analysis F-16): the Android device policy (lock, wipe, screenshots, logs…)
// comes signed by the server's Android key for one device, with its time — at enrolment
// and at every check-in. The app applies nothing else (android/…/security/SignedPolicy.java).
// Also audit N12: a forged request does not use up a device's nonce.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "m5-android-policy-"));
process.env.DATA_DIR = dir;

const crypto = await import("../server/android/crypto");
const { androidStore } = await import("../server/android/store");

type Wire = { at: number; policy: string; sig: string };

describe("6.7 F-16: the signed device policy", () => {
  let server: Server;
  let base = "";
  const dev = { sign: crypto.newP256(), enc: crypto.newP256(), id: "" };
  let serverKey = "";

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerAndroidRoutes } = await import("../server/android/routes");
    const app = express();
    app.use("/api/android", express.raw({ type: () => true, limit: "1mb" }));
    registerAndroidRoutes(app);
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server?.close(); androidStore.reset(); rmSync(dir, { recursive: true, force: true }); });

  const verify = (w: Wire, deviceId: string) => crypto.verifyP1363(serverKey, crypto.policySignedString(deviceId, w.at, w.policy), w.sig);

  it("signs the policy at enrolment and at check-in, for this device only", async () => {
    serverKey = ((await (await fetch(`${base}/api/android/info`)).json()) as { server: { publicKey: string } }).server.publicKey;
    const signKey = crypto.spkiOf(dev.sign.publicKey), encKey = crypto.spkiOf(dev.enc.publicKey), time = Date.now();
    const enrolled = await (await fetch(`${base}/api/android/enroll`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Policy phone", signKey, encKey, time, proof: crypto.signP1363(dev.sign.privateKey, crypto.enrollSignedString(signKey, encKey, time)) }) })).json() as { deviceId: string; policy: unknown; policySigned: Wire };
    dev.id = enrolled.deviceId;
    expect(verify(enrolled.policySigned, dev.id)).toBe(true);
    expect(JSON.parse(enrolled.policySigned.policy)).toEqual(enrolled.policy);
    expect(verify(enrolled.policySigned, "and_someone_else")).toBe(false);

    const raw = Buffer.from(JSON.stringify({ state: {} }));
    const t = String(Date.now()), nonce = randomBytes(16).toString("base64url");
    const sig = crypto.signP1363(dev.sign.privateKey, crypto.requestSignedString("POST", "/api/android/checkin", t, nonce, raw));
    const check = await (await fetch(`${base}/api/android/checkin`, { method: "POST", headers: { "x-m5-device": dev.id, "x-m5-time": t, "x-m5-nonce": nonce, "x-m5-signature": sig, "content-type": "application/json" }, body: raw })).json() as { policySigned: Wire };
    expect(verify(check.policySigned, dev.id)).toBe(true);
    expect(check.policySigned.at).toBeGreaterThanOrEqual(enrolled.policySigned.at);
    // A changed policy (a proxy switching screenshots on) no longer verifies.
    const forged = { ...check.policySigned, policy: check.policySigned.policy.replace('"screenshots":false', '"screenshots":true') };
    expect(forged.policy).not.toBe(check.policySigned.policy);
    expect(verify(forged, dev.id)).toBe(false);
  });

  it("N12: a request with a bad signature does not use up its nonce", async () => {
    const raw = Buffer.from(JSON.stringify({ state: {} }));
    const t = String(Date.now()), nonce = randomBytes(16).toString("base64url");
    const post = (sig: string) => fetch(`${base}/api/android/checkin`, { method: "POST", headers: { "x-m5-device": dev.id, "x-m5-time": t, "x-m5-nonce": nonce, "x-m5-signature": sig, "content-type": "application/json" }, body: raw });
    const forged = crypto.signP1363(crypto.newP256().privateKey, crypto.requestSignedString("POST", "/api/android/checkin", t, nonce, raw));
    expect((await post(forged)).status).toBe(401);
    const good = crypto.signP1363(dev.sign.privateKey, crypto.requestSignedString("POST", "/api/android/checkin", t, nonce, raw));
    expect((await post(good)).status).toBe(200);
    expect((await post(good)).status).toBe(401); // and the real one only once
  });
});
