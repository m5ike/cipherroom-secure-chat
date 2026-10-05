// The device API of the iOS app (6.14), /api/ios/* — the same semantics,
// signatures and answers as /api/android/* (server/android/routes.ts):
//
//   GET  /info                 public: the server's key, enrolment mode, APNs topic and environment,
//                              the oldest app build allowed, where the app is installed from
//   POST /enroll               register a device (its keys, proof of holding them, a code if required,
//                              its APNs and PushKit tokens)
//   POST /checkin        (s)   report state and tokens, get the signed policy, pending commands,
//                              the newest bundle and release record
//   POST /ack            (s)   the outcome of a command
//   POST /notify         (s)   { token, on } wake this device for the signed-in account (server/notify)
//   POST /events         (s)   security and update events (also signed long ago: after a wipe)
//   POST /message-audit  (s)   a message hidden or deleted in the app's own view
//   POST /location       (s)   positions for tracking (policy permitting)
//   GET  /bundles/:id    (s)   a published iOS build, its key wrapped for this device
//   GET  /releases/:id   (s)   a release record (App Store / TestFlight link) and the server's signature
//
// (s) = signed by the device key exactly as on Android: X-M5-Device, X-M5-Time,
// X-M5-Nonce, X-M5-Signature = P-256 P1363 over
// "m5android/1|METHOD|/api/ios/…?query|time|nonce|b64(sha256(body))".
// Enrolment proof: "m5android/enroll/1|signKey|encKey|time". Policies,
// control messages and bundles are signed with the same server key as
// Android's (server/mobile/signing.ts). No APK: releases are records.

import express, { type Express } from "express";
import { EXACT_ROUTER } from "../exact-routing";
import { rateLimit } from "express-rate-limit";
import { audit } from "../monitor/audit";
import { truncateIp } from "../monitor/traffic";
import { buildInfo } from "../build-info";
import { accountStore } from "../accounts/store";
import { androidNotifyLink } from "../notify/routes";
import { notifyStore } from "../notify/store";
import { enrollSignedString, kidOf, publicKeyOf, signPolicy, verifyP1363 } from "../mobile/crypto";
import { bodyJson, codeMatches, int, MAX_SKEW, registerSharedDeviceRoutes, sanitizeState, signedBy, startPruning, str, type Signed } from "../mobile/device-api";
import { newId } from "../mobile/store";
import { iosConfig } from "./config";
import { apnsReady } from "./apns";
import { iosDeployFile, latestIosBuildFor } from "./bundle";
import { iosPendingFor } from "./commands";
import { IOS_MIN_APP_CODE } from "./design";
import { effectiveMinBuild, iosReleaseSignedString, latestIosReleaseFor, releasePublic } from "./releases";
import { iosStore, type IosDevice } from "./store";

const HEX_TOKEN = /^[0-9a-fA-F]{64,200}$/;
/** A push token as the app reports it: hex (any case, spaces and <> of a description dropped), else "". */
export const pushToken = (v: unknown): string => {
  const s = typeof v === "string" ? v.replace(/[\s<>]/g, "").toLowerCase() : "";
  return HEX_TOKEN.test(s) ? s : "";
};
const apnsEnvOf = (v: unknown): IosDevice["apnsEnv"] => (v === "production" || v === "sandbox" ? v : "");
const IDIOMS = new Set(["phone", "pad", "watch", "mac", "vision", "tv"]);

/** What a device may know of APNs: where it is registered — never the key. */
function apnsInfo() {
  const s = apnsReady();
  return s.ready ? { topic: s.topic, environment: s.env, voipTopic: `${s.topic}.voip` } : null;
}

/** Where the app comes from (the console's links). */
const storeLinks = () => { const c = iosConfig(); return { appStore: c.appStoreUrl || null, testFlight: c.testFlightUrl || null }; };

export function registerIosRoutes(app: Express): void {
  const r = express.Router(EXACT_ROUTER);
  // The body is read raw: the signature covers the exact bytes.
  r.use(express.raw({ type: () => true, limit: "1mb" }));
  r.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); void iosStore.ready().then(() => next(), next); });
  const enrollLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many enrolment attempts." } });
  const signed = signedBy(iosStore);

  r.get("/info", (_req, res) => {
    const c = iosConfig();
    const key = iosStore.signingKey();
    res.json({
      ok: true, name: "M5cet", platform: "ios", version: buildInfo().version, protocol: 2, enrollment: c.enrollment,
      server: { kid: key.kid, publicKey: key.publicKey, fingerprint: key.fingerprint },
      apns: apnsInfo(), minAppCode: IOS_MIN_APP_CODE, minBuild: effectiveMinBuild(), bundleId: c.bundleId, store: storeLinks(),
    });
  });

  r.post("/enroll", enrollLimiter, (req: Signed<IosDevice>, res) => {
    const b = bodyJson(req);
    const c = iosConfig();
    const ip = truncateIp(req.ip);
    const fail = (status: number, code: string, message: string) => {
      audit.add({ category: "security", level: "notice", event: "ios.enroll.refused", ip, status: code });
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
      const label = codeMatches(iosStore, str(b.code, 64));
      if (!label) return fail(403, "bad-code", "The enrolment code is wrong, used up or expired.");
      enrolledWith = `code:${label}`;
    }
    const existing = iosStore.devices.list({ limit: 1, filter: (d) => d.signKey === signKey })[0];
    if (existing && existing.status !== "active") return fail(403, `device-${existing.status}`, `This device is ${existing.status}.`);
    const now = Date.now();
    const device: IosDevice = existing ?? {
      id: newId("ios"), name: "", model: "", modelName: "", idiom: "", os: "", osVersion: "", appVersion: "", appCode: 0, locale: "",
      signKey, encKey, kid: kidOf(signKey), apnsToken: "", voipToken: "", apnsEnv: "",
      status: "active", enrolledAt: now, enrolledWith, lastSeen: now, lastIp: ip, state: {}, notes: "",
    };
    const idiom = str(b.idiom, 10).toLowerCase();
    Object.assign(device, {
      name: str(b.name, 80) || str(b.modelName, 80) || str(b.model, 80) || "iPhone", model: str(b.model, 80), modelName: str(b.modelName, 80),
      idiom: IDIOMS.has(idiom) ? idiom : "", os: str(b.os, 40), osVersion: str(b.osVersion, 20),
      appVersion: str(b.appVersion, 40), appCode: int(b.appCode, 0, 1e9), locale: str(b.locale, 20),
      apnsToken: pushToken(b.apnsToken), voipToken: pushToken(b.voipToken), apnsEnv: apnsEnvOf(b.apnsEnv), apnsError: undefined,
      lastSeen: now, lastIp: ip, encKey,
    });
    iosStore.devices.put(device);
    audit.add({ category: "admin", level: "notice", event: existing ? "ios.device.re-enrolled" : "ios.device.enrolled", target: device.id, ip, detail: { name: device.name, model: device.model, via: enrolledWith } });
    const key = iosStore.signingKey();
    res.json({
      ok: true, deviceId: device.id, policy: c.policy, pollSeconds: c.policy.pollMinutes * 60,
      policySigned: signPolicy(key.privateKey, device.id, c.policy), // the app applies only this (as Android, F-16)
      server: { kid: key.kid, publicKey: key.publicKey, fingerprint: key.fingerprint },
      apns: apnsInfo(), minBuild: effectiveMinBuild(),
    });
  });

  r.post("/checkin", signed, (req: Signed<IosDevice>, res) => {
    const b = bodyJson(req);
    const device = req.device!;
    const c = iosConfig();
    // A token the app sends replaces the one kept ("" = the user turned notifications off); absent = unchanged.
    const token = (field: "apnsToken" | "voipToken") => (typeof b[field] === "string" ? pushToken(b[field]) : device[field]);
    const apnsToken = token("apnsToken");
    const voipToken = token("voipToken");
    const updated: IosDevice = {
      ...device, lastSeen: Date.now(), lastIp: truncateIp(req.ip), state: sanitizeState(b.state, ["apns", "poll"], true),
      appVersion: str(b.appVersion, 40) || device.appVersion, appCode: int(b.appCode, 0, 1e9, device.appCode),
      os: str(b.os, 40) || device.os, osVersion: str(b.osVersion, 20) || device.osVersion,
      locale: str(b.locale, 20) || device.locale,
      apnsToken, voipToken, apnsEnv: b.apnsEnv === undefined ? device.apnsEnv : apnsEnvOf(b.apnsEnv),
      apnsError: apnsToken !== device.apnsToken || voipToken !== device.voipToken ? undefined : device.apnsError,
    };
    iosStore.devices.put(updated);
    const build = latestIosBuildFor(updated.appCode, c.policy.update.channel);
    const release = latestIosReleaseFor(updated);
    const minBuild = effectiveMinBuild();
    const apns = apnsInfo();
    res.json({
      ok: true, time: Date.now(), policy: c.policy, pollSeconds: c.policy.pollMinutes * 60,
      policySigned: signPolicy(iosStore.signingKey().privateKey, updated.id, c.policy),
      apns, push: apns && updated.apnsToken ? "apns" : "poll",
      commands: iosPendingFor(updated),
      bundle: build ? { id: build.id, number: build.number, version: build.version, size: build.fileSize, minAppCode: build.minAppCode, notes: build.notes } : null,
      release: release ? releasePublic(release, updated) : null,
      minBuild, updateRequired: updated.appCode > 0 && updated.appCode < minBuild,
    });
  });

  // ack, notify, events, message-audit, location, bundles/:id (server/mobile/device-api.ts).
  registerSharedDeviceRoutes(r, {
    store: iosStore,
    wiped: { apnsToken: "", voipToken: "" },
    sanitizeState: (raw) => sanitizeState(raw, ["apns", "poll"], true),
    location: () => iosConfig().policy.location,
    notifyLink: (device, body) => androidNotifyLink(notifyStore, accountStore, device, body, "ios"),
    deployFile: (build, devices) => iosDeployFile(build, devices),
  });

  r.get("/releases/:id", signed, (req: Signed<IosDevice>, res) => {
    const release = iosStore.releases.get(String(req.params.id));
    if (!release || release.status !== "published") return res.status(404).json({ ok: false, message: "No such published release." });
    res.json({ ok: true, release: releasePublic(release, req.device), signed: iosReleaseSignedString(release), signature: release.signature, kid: iosStore.signingKey().kid });
  });

  app.use("/api/ios", r);

  // Old events and finished commands go after a while (IOS_EVENT_DAYS, default 180).
  startPruning(iosStore, () => iosConfig().policy.location.days);
}
