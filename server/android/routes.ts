// The device API of the Android app (6.0), /api/android/*:
//
//   GET  /info                 public: the server's Android key, enrolment mode, FCM app settings
//   POST /enroll               register a device (its keys, proof of holding them, a code if required)
//   POST /checkin        (s)   report state, get the policy, pending commands, the newest bundle / release
//   POST /ack            (s)   the outcome of a command
//   POST /notify         (s)   6.7: { token, on } wake this device for the signed-in account (server/notify)
//   POST /events         (s)   security and update events (also signed long ago: after a wipe)
//   GET  /bundles/:id    (s)   a published build, its key wrapped for this device
//   GET  /releases/:id   (s)   an APK release and the server's signature over it
//   GET  /releases/:id/apk (s) the APK
//
// (s) = signed by the device key: X-M5-Device, X-M5-Time, X-M5-Nonce,
// X-M5-Signature over "m5android/1|METHOD|path?query|time|nonce|b64(sha256(body))"
// (docs/android-architecture.md §1.4). The body is read raw for that.
//
// 6.14: signing, replay protection and the routes every platform shares (ack,
// notify, events, message-audit, location, bundles) are server/mobile/device-api.ts
// — the iOS app's API (server/ios/routes.ts) is the same code.

import express, { type Express } from "express";
import { EXACT_ROUTER } from "../exact-routing";
import { rateLimit } from "express-rate-limit";
import { createReadStream, existsSync, statSync } from "node:fs";
import { audit } from "../monitor/audit";
import { truncateIp } from "../monitor/traffic";
import { buildInfo } from "../build-info";
import { androidConfig } from "./config";
import { enrollSignedString, publicKeyOf, releaseSignedString, verifyP1363, kidOf, signPolicy } from "./crypto";
import { pendingFor } from "./commands";
import { deployFile, latestBuildFor, MIN_APP_CODE } from "./bundle";
import { fcmReady } from "./fcm";
import { accountStore } from "../accounts/store";
import { androidNotifyLink } from "../notify/routes";
import { notifyStore } from "../notify/store";
import { bodyJson, codeMatches, int, MAX_SKEW, registerSharedDeviceRoutes, sanitizeState, signedBy, startPruning, str, type Signed } from "../mobile/device-api";
import { channelOrder } from "../mobile/bundle";
import { androidStore, newId, type Device, type Release } from "./store";

export { EVENT_TYPES } from "../mobile/device-api";

const releasePublic = (r: Release) => ({ id: r.id, versionCode: r.versionCode, versionName: r.versionName, packageName: r.packageName, apkSha256: r.apkSha256, certSha256: r.certSha256, size: r.size, minSdk: r.minSdk, mandatory: r.mandatory, notes: r.notes, channel: r.channel });

function latestReleaseFor(device: Device): Release | null {
  const order = channelOrder(androidConfig().policy.update.channel);
  return androidStore.releases.list({ limit: 100, filter: (r) => r.status === "published" && order.includes(r.channel) && r.versionCode > device.appCode && r.minSdk <= (device.sdk || 99) })[0] ?? null;
}

export function registerAndroidRoutes(app: Express): void {
  const r = express.Router(EXACT_ROUTER);
  // The body is read raw: the signature covers the exact bytes.
  r.use(express.raw({ type: () => true, limit: "1mb" }));
  r.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); void androidStore.ready().then(() => next(), next); });
  const enrollLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many enrolment attempts." } });
  const signed = signedBy(androidStore);

  r.get("/info", (_req, res) => {
    const c = androidConfig();
    const key = androidStore.signingKey();
    res.json({
      ok: true, name: "M5cet", version: buildInfo().version, protocol: 2, enrollment: c.enrollment,
      server: { kid: key.kid, publicKey: key.publicKey, fingerprint: key.fingerprint },
      fcm: c.fcm.enabled && c.fcm.client ? c.fcm.client : null, minAppCode: MIN_APP_CODE, packageName: c.packageName,
    });
  });

  r.post("/enroll", enrollLimiter, (req: Signed<Device>, res) => {
    const b = bodyJson(req);
    const c = androidConfig();
    const ip = truncateIp(req.ip);
    const fail = (status: number, code: string, message: string) => {
      audit.add({ category: "security", level: "notice", event: "android.enroll.refused", ip, status: code });
      res.status(status).json({ ok: false, code, message });
    };
    if (c.enrollment === "closed") return fail(403, "closed", "This server does not enrol new devices.");
    const signKey = str(b.signKey, 400);
    const encKey = str(b.encKey, 400);
    const time = typeof b.time === "number" ? b.time : NaN;
    try { publicKeyOf(signKey); publicKeyOf(encKey); } catch { return fail(400, "bad-key", "The device keys are not P-256 keys."); }
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > MAX_SKEW) return fail(400, "clock", "The device clock is off.");
    if (!verifyP1363(signKey, enrollSignedString(signKey, encKey, time), str(b.proof, 200))) return fail(400, "bad-proof", "The device could not prove it holds its key.");
    let enrolledWith = "open";
    if (c.enrollment === "code") {
      const label = codeMatches(androidStore, str(b.code, 64));
      if (!label) return fail(403, "bad-code", "The enrolment code is wrong, used up or expired.");
      enrolledWith = `code:${label}`;
    }
    const existing = androidStore.devices.list({ limit: 1, filter: (d) => d.signKey === signKey })[0];
    if (existing && existing.status !== "active") return fail(403, `device-${existing.status}`, `This device is ${existing.status}.`);
    const now = Date.now();
    const device: Device = existing ?? {
      id: newId("and"), name: "", model: "", manufacturer: "", os: "", sdk: 0, appVersion: "", appCode: 0, locale: "",
      signKey, encKey, kid: kidOf(signKey), fcmToken: "", status: "active", enrolledAt: now, enrolledWith, lastSeen: now, lastIp: ip, state: {}, notes: "",
    };
    Object.assign(device, {
      name: str(b.name, 80) || str(b.model, 80) || "Android", model: str(b.model, 80), manufacturer: str(b.manufacturer, 80), os: str(b.os, 40),
      sdk: int(b.sdk, 0, 100), appVersion: str(b.appVersion, 40), appCode: int(b.appCode, 0, 1e9), locale: str(b.locale, 20),
      fcmToken: str(b.fcmToken, 400), lastSeen: now, lastIp: ip, encKey,
    });
    androidStore.devices.put(device);
    audit.add({ category: "admin", level: "notice", event: existing ? "android.device.re-enrolled" : "android.device.enrolled", target: device.id, ip, detail: { name: device.name, model: device.model, via: enrolledWith } });
    const key = androidStore.signingKey();
    res.json({
      ok: true, deviceId: device.id, policy: c.policy, pollSeconds: c.policy.pollMinutes * 60,
      policySigned: signPolicy(key.privateKey, device.id, c.policy), // 6.7 (F-16): the app applies only this
      server: { kid: key.kid, publicKey: key.publicKey, fingerprint: key.fingerprint },
      fcm: c.fcm.enabled && c.fcm.client ? c.fcm.client : null,
    });
  });

  r.post("/checkin", signed, (req: Signed<Device>, res) => {
    const b = bodyJson(req);
    const device = req.device!;
    const c = androidConfig();
    const updated: Device = {
      ...device, lastSeen: Date.now(), lastIp: truncateIp(req.ip), state: sanitizeState(b.state),
      appVersion: str(b.appVersion, 40) || device.appVersion, appCode: int(b.appCode, 0, 1e9, device.appCode), sdk: int(b.sdk, 0, 100, device.sdk),
      locale: str(b.locale, 20) || device.locale,
      fcmToken: typeof b.fcmToken === "string" ? str(b.fcmToken, 400) : device.fcmToken,
    };
    // 6.4: which certificate signed this build — the console compares it with assetlinks.json.
    const cert = str(b.certSha256, 64).toLowerCase();
    if (/^[0-9a-f]{64}$/.test(cert)) updated.certSha256 = cert;
    androidStore.devices.put(updated);
    const build = latestBuildFor(updated.appCode, c.policy.update.channel);
    const release = latestReleaseFor(updated);
    res.json({
      ok: true, time: Date.now(), policy: c.policy, pollSeconds: c.policy.pollMinutes * 60,
      policySigned: signPolicy(androidStore.signingKey().privateKey, updated.id, c.policy), // 6.7 (F-16)
      fcm: c.fcm.enabled && c.fcm.client ? c.fcm.client : null, push: fcmReady().ready ? "fcm" : "poll",
      commands: pendingFor(updated),
      bundle: build ? { id: build.id, number: build.number, version: build.version, size: build.fileSize, minAppCode: build.minAppCode, notes: build.notes } : null,
      release: release ? releasePublic(release) : null,
    });
  });

  // ack, notify, events, message-audit, location, bundles/:id (server/mobile/device-api.ts).
  registerSharedDeviceRoutes(r, {
    store: androidStore,
    wiped: { fcmToken: "" },
    sanitizeState: (raw) => sanitizeState(raw),
    location: () => androidConfig().policy.location,
    notifyLink: (device, body) => androidNotifyLink(notifyStore, accountStore, device, body),
    deployFile: (build, devices) => deployFile(build, devices),
  });

  r.get("/releases/:id", signed, (req: Signed<Device>, res) => {
    const release = androidStore.releases.get(String(req.params.id));
    if (!release || release.status !== "published") return res.status(404).json({ ok: false, message: "No such published release." });
    res.json({ ok: true, release: releasePublic(release), signed: releaseSignedString(release), signature: release.signature, kid: androidStore.signingKey().kid });
  });

  r.get("/releases/:id/apk", signed, (req: Signed<Device>, res) => {
    const release = androidStore.releases.get(String(req.params.id));
    const file = release ? androidStore.releaseFile(release.id) : "";
    if (!release || release.status !== "published" || !existsSync(file)) return res.status(404).json({ ok: false, message: "No such published release." });
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Length", String(statSync(file).size));
    res.setHeader("X-M5-Sha256", release.apkSha256);
    createReadStream(file).pipe(res);
  });

  app.use("/api/android", r);

  // Old events and finished commands go after a while (ANDROID_EVENT_DAYS, default 180).
  startPruning(androidStore, () => androidConfig().policy.location.days);
}
