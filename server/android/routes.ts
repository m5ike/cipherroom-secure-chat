// The device API of the Android app (6.0), /api/android/*:
//
//   GET  /info                 public: the server's Android key, enrolment mode, FCM app settings
//   POST /enroll               register a device (its keys, proof of holding them, a code if required)
//   POST /checkin        (s)   report state, get the policy, pending commands, the newest bundle / release
//   POST /ack            (s)   the outcome of a command
//   POST /events         (s)   security and update events (also signed long ago: after a wipe)
//   GET  /bundles/:id    (s)   a published build, its key wrapped for this device
//   GET  /releases/:id   (s)   an APK release and the server's signature over it
//   GET  /releases/:id/apk (s) the APK
//
// (s) = signed by the device key: X-M5-Device, X-M5-Time, X-M5-Nonce,
// X-M5-Signature over "m5android/1|METHOD|path?query|time|nonce|b64(sha256(body))"
// (docs/android-architecture.md §1.4). The body is read raw for that.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { audit } from "../monitor/audit";
import { truncateIp } from "../monitor/traffic";
import { buildInfo } from "../build-info";
import { androidConfig } from "./config";
import { enrollSignedString, publicKeyOf, releaseSignedString, requestSignedString, verifyP1363, kidOf } from "./crypto";
import { acknowledge, pendingFor } from "./commands";
import { deployFile, latestBuildFor, MIN_APP_CODE } from "./bundle";
import { fcmReady } from "./fcm";
import { recordMessageAction, sanitizeMessageAudit } from "../message-audit";
import { androidStore, newId, type AndroidEvent, type Device, type DeviceState, type EventLevel, type LocationPoint, type Release } from "./store";

const MAX_SKEW = 5 * 60 * 1000;
/** Events signed before a wipe may arrive much later (the device was offline). */
const EVENT_SKEW = 30 * 24 * 60 * 60 * 1000;

const nonces = new Map<string, number>();
function nonceFresh(nonce: string, now: number): boolean {
  if (nonces.size > 50_000) for (const [n, until] of nonces) if (until < now) nonces.delete(n);
  if (nonces.has(nonce)) return false;
  nonces.set(nonce, now + 2 * MAX_SKEW);
  return true;
}

type Signed = Request & { device?: Device; json?: Record<string, unknown> };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown, min: number, max: number, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d);

function bodyJson(req: Signed): Record<string, unknown> {
  if (req.json) return req.json;
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  if (!raw.length) return (req.json = {});
  try {
    const v = JSON.parse(raw.toString("utf8")) as unknown;
    req.json = v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    req.json = {};
  }
  return req.json;
}

/** Checks a device-signed request; answers 401/403 itself. */
function signedBy(opts: { skew?: number; allowStatus?: Device["status"][] } = {}) {
  return (req: Signed, res: Response, next: NextFunction) => {
    const id = str(req.header("x-m5-device"), 64);
    const time = str(req.header("x-m5-time"), 20);
    const nonce = str(req.header("x-m5-nonce"), 40);
    const sig = str(req.header("x-m5-signature"), 200);
    const device = id ? androidStore.devices.get(id) : null;
    const now = Date.now();
    const t = Number(time);
    const refuse = (status: number, code: string, message: string) => {
      audit.add({ category: "security", level: "notice", event: "android.request.refused", target: id || undefined, ip: truncateIp(req.ip), status: code });
      res.status(status).json({ ok: false, code, message });
    };
    if (!device) return refuse(401, "unknown-device", "This device is not enrolled on this server.");
    if (!Number.isFinite(t) || Math.abs(now - t) > (opts.skew ?? MAX_SKEW)) return refuse(401, "clock", "The request time is too far from the server's — check the device clock.");
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(nonce) || !nonceFresh(`${id}:${nonce}`, now)) return refuse(401, "replay", "This request was already used.");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyP1363(device.signKey, requestSignedString(req.method, req.originalUrl, time, nonce, raw), sig)) return refuse(401, "bad-signature", "The request signature is not valid.");
    if (device.status !== "active" && !(opts.allowStatus ?? []).includes(device.status)) return refuse(403, `device-${device.status}`, `This device is ${device.status}.`);
    req.device = device;
    next();
  };
}

function sanitizeState(raw: unknown): DeviceState {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bundle = s.bundle && typeof s.bundle === "object" ? s.bundle as Record<string, unknown> : null;
  return {
    battery: int(s.battery, -1, 100, -1),
    charging: s.charging === true,
    network: str(s.network, 20),
    locked: s.locked === true,
    rooms: int(s.rooms, 0, 64),
    bundle: bundle ? { id: str(bundle.id, 64), version: str(bundle.version, 40), state: str(bundle.state, 20) } : null,
    push: s.push === "fcm" || s.push === "poll" ? s.push : "none",
    lockMode: str(s.lockMode, 20),
    failedAttempts: int(s.failedAttempts, 0, 100),
    storage: int(s.storage, 0, 1e12),
    permissions: Array.isArray(s.permissions) ? s.permissions.filter((p): p is string => typeof p === "string").slice(0, 30).map((p) => p.slice(0, 60)) : [],
    at: Date.now(),
  };
}

export const EVENT_TYPES: Record<string, { level: EventLevel; security?: boolean }> = {
  "unlock-failed": { level: "notice", security: true },
  "lockout": { level: "warn", security: true },
  "wipe": { level: "warn", security: true },
  "remote-wipe": { level: "warn", security: true },
  "integrity": { level: "warn", security: true },
  "key-invalidated": { level: "notice", security: true },
  "unlock": { level: "info" },
  "bundle-installed": { level: "info" },
  "bundle-failed": { level: "warn" },
  "bundle-rollback": { level: "warn" },
  "update-available": { level: "info" },
  "update-installed": { level: "info" },
  "update-failed": { level: "warn" },
  "crash": { level: "error" },
  "push-received": { level: "info" },
  "log": { level: "info" },
};

const releasePublic = (r: Release) => ({ id: r.id, versionCode: r.versionCode, versionName: r.versionName, packageName: r.packageName, apkSha256: r.apkSha256, certSha256: r.certSha256, size: r.size, minSdk: r.minSdk, mandatory: r.mandatory, notes: r.notes, channel: r.channel });

function latestReleaseFor(device: Device): Release | null {
  const channel = androidConfig().policy.update.channel;
  const order = channel === "dev" ? ["dev", "beta", "stable"] : channel === "beta" ? ["beta", "stable"] : ["stable"];
  return androidStore.releases.list({ limit: 100, filter: (r) => r.status === "published" && order.includes(r.channel) && r.versionCode > device.appCode && r.minSdk <= (device.sdk || 99) })[0] ?? null;
}

function codeMatches(code: string): string | null {
  const hash = createHash("sha256").update(code.replace(/[^A-Za-z0-9]/g, "").toUpperCase()).digest();
  const now = Date.now();
  for (const c of androidStore.codes.list({ limit: 500 })) {
    if (c.usesLeft <= 0 || c.expiresAt < now) continue;
    const stored = Buffer.from(c.hash, "hex");
    if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
      androidStore.codes.put({ ...c, usesLeft: c.usesLeft - 1, used: c.used + 1 });
      return c.label || c.id;
    }
  }
  return null;
}

export function registerAndroidRoutes(app: Express): void {
  const r = express.Router();
  // The body is read raw: the signature covers the exact bytes.
  r.use(express.raw({ type: () => true, limit: "1mb" }));
  r.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); void androidStore.ready().then(() => next(), next); });
  const enrollLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many enrolment attempts." } });

  r.get("/info", (_req, res) => {
    const c = androidConfig();
    const key = androidStore.signingKey();
    res.json({
      ok: true, name: "M5cet", version: buildInfo().version, protocol: 2, enrollment: c.enrollment,
      server: { kid: key.kid, publicKey: key.publicKey, fingerprint: key.fingerprint },
      fcm: c.fcm.enabled && c.fcm.client ? c.fcm.client : null, minAppCode: MIN_APP_CODE, packageName: c.packageName,
    });
  });

  r.post("/enroll", enrollLimiter, (req: Signed, res) => {
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
      const label = codeMatches(str(b.code, 64));
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
      server: { kid: key.kid, publicKey: key.publicKey, fingerprint: key.fingerprint },
      fcm: c.fcm.enabled && c.fcm.client ? c.fcm.client : null,
    });
  });

  r.post("/checkin", signedBy(), (req: Signed, res) => {
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
      fcm: c.fcm.enabled && c.fcm.client ? c.fcm.client : null, push: fcmReady().ready ? "fcm" : "poll",
      commands: pendingFor(updated),
      bundle: build ? { id: build.id, number: build.number, version: build.version, size: build.fileSize, minAppCode: build.minAppCode, notes: build.notes } : null,
      release: release ? releasePublic(release) : null,
    });
  });

  r.post("/ack", signedBy(), (req: Signed, res) => {
    const b = bodyJson(req);
    const device = req.device!;
    const cmd = acknowledge(device, str(b.id, 64), b.ok !== false, b.result ?? null, str(b.error, 500));
    if (!cmd) return res.status(404).json({ ok: false, message: "No such command for this device." });
    // A status or ping answer refreshes what the console shows.
    if ((cmd.kind === "ping" || cmd.kind === "status") && b.result && typeof b.result === "object") {
      const state = (b.result as { state?: unknown }).state;
      if (state) androidStore.devices.put({ ...device, lastSeen: Date.now(), state: sanitizeState(state) });
    }
    if (cmd.kind === "wipe" && cmd.status === "done") {
      androidStore.devices.put({ ...device, status: "wiped", fcmToken: "" });
      audit.add({ category: "security", level: "warn", event: "android.device.remote-wiped", target: device.id, detail: { by: cmd.createdBy } });
    }
    res.json({ ok: true, status: cmd.status });
  });

  r.post("/events", signedBy({ skew: EVENT_SKEW, allowStatus: ["wiped"] }), (req: Signed, res) => {
    const b = bodyJson(req);
    const device = req.device!;
    const list = Array.isArray(b.events) ? b.events.slice(0, 100) : [];
    let stored = 0;
    let wiped = false;
    for (const raw of list) {
      const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const type = str(e.type, 40);
      const def = EVENT_TYPES[type];
      const eid = str(e.id, 64);
      if (!def || !/^[A-Za-z0-9_-]{8,64}$/.test(eid)) continue;
      const id = `ev_${device.id}_${eid}`;
      if (androidStore.events.get(id)) continue; // the same event again (a retry)
      const detail = e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? e.detail as Record<string, unknown> : {};
      const text = JSON.stringify(detail);
      const event: AndroidEvent = {
        id, deviceId: device.id, type, level: def.level, at: int(e.at, 0, 1e15, Date.now()), receivedAt: Date.now(),
        detail: text.length > 16_000 ? { truncated: true } : detail, ip: truncateIp(req.ip),
      };
      androidStore.events.put(event);
      stored++;
      if (def.security || def.level === "warn" || def.level === "error") {
        audit.add({ category: def.security ? "security" : "system", level: def.level === "info" ? "info" : def.level, event: `android.${type}`, target: device.id, ip: event.ip, detail: { name: device.name, ...detail } });
      }
      if (type === "wipe" || type === "remote-wipe") wiped = true;
    }
    if (wiped) androidStore.devices.put({ ...device, status: "wiped", fcmToken: "", lastSeen: Date.now() });
    res.json({ ok: true, stored });
  });

  // 6.2: a message hidden or deleted in the app's own view — into the audit journal
  // (server/message-audit.ts); the message itself never comes here.
  r.post("/message-audit", signedBy(), (req: Signed, res) => {
    const device = req.device!;
    const b = bodyJson(req);
    const list = Array.isArray(b.actions) ? b.actions.slice(0, 50) : [b];
    const account = typeof b.account === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(b.account) ? b.account : "";
    let recorded = 0;
    for (const raw of list) {
      const input = sanitizeMessageAudit(raw);
      if (!input) continue;
      recordMessageAction(input, { actor: account || `device:${device.id}`, deviceId: device.id, ip: truncateIp(req.ip), via: "android" });
      recorded++;
    }
    if (!recorded) return res.status(400).json({ ok: false, message: "Not a message action." });
    res.json({ ok: true, recorded });
  });

  // 6.1: positions for tracking — only when the user switched it on in the app and
  // the policy allows it. At most 100 points a request; a point closer in time to
  // the device's last one than policy.location.minSeconds is dropped.
  const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
  r.post("/location", signedBy(), (req: Signed, res) => {
    const policy = androidConfig().policy.location;
    if (!policy.track) return res.status(403).json({ ok: false, code: "location-off", message: "The server does not keep device positions." });
    const device = req.device!;
    const b = bodyJson(req);
    const list = Array.isArray(b.points) ? b.points.slice(0, 100) : [];
    const last = androidStore.locations.list({ device: device.id, limit: 1 })[0];
    let lastAt = last?.at ?? 0;
    let stored = 0;
    const now = Date.now();
    for (const raw of list) {
      const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const lat = num(p.lat, -90, 90), lon = num(p.lon, -180, 180);
      const at = int(p.at, 0, now + 5 * 60_000, 0);
      if (lat === null || lon === null || !at || at < now - 7 * 86_400_000) continue;
      if (at - lastAt < policy.minSeconds * 1000 && at >= lastAt) continue;
      const point: LocationPoint = {
        id: `loc_${device.id}_${at}`, deviceId: device.id, at, receivedAt: now, lat, lon,
        acc: num(p.acc, 0, 100_000) ?? 0, alt: num(p.alt, -1000, 20_000), speed: num(p.speed, 0, 400), heading: num(p.heading, 0, 360),
      };
      if (androidStore.locations.get(point.id)) continue;
      androidStore.locations.put(point);
      lastAt = Math.max(lastAt, at);
      stored++;
    }
    res.json({ ok: true, stored, minSeconds: policy.minSeconds });
  });

  r.get("/bundles/:id", signedBy(), (req: Signed, res) => {
    const build = androidStore.builds.get(String(req.params.id));
    if (!build || build.status !== "published") return res.status(404).json({ ok: false, message: "No such published build." });
    if (build.minAppCode > req.device!.appCode) return res.status(409).json({ ok: false, message: "This app is too old for the build." });
    try {
      const file = deployFile(build, [req.device!]);
      res.setHeader("Content-Type", "application/vnd.m5cet.bundle");
      res.setHeader("Content-Disposition", `attachment; filename="${build.id}.m5ab"`);
      res.send(file);
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  r.get("/releases/:id", signedBy(), (req: Signed, res) => {
    const release = androidStore.releases.get(String(req.params.id));
    if (!release || release.status !== "published") return res.status(404).json({ ok: false, message: "No such published release." });
    res.json({ ok: true, release: releasePublic(release), signed: releaseSignedString(release), signature: release.signature, kid: androidStore.signingKey().kid });
  });

  r.get("/releases/:id/apk", signedBy(), (req: Signed, res) => {
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
  const days = Math.max(7, Number(process.env.ANDROID_EVENT_DAYS) || 180);
  const prune = () => {
    void androidStore.ready().then(() => {
      const now = Date.now();
      androidStore.events.pruneBefore(now - days * 86_400_000);
      androidStore.commands.pruneBefore(now - 60 * 86_400_000, (c) => c.status === "queued" && c.expiresAt > now);
      androidStore.locations.pruneBefore(now - androidConfig().policy.location.days * 86_400_000);
    }).catch(() => undefined);
  };
  setTimeout(prune, 60_000).unref?.();
  setInterval(prune, 6 * 60 * 60 * 1000).unref?.();
}
