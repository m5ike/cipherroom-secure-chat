// The device API both mobile apps share (Android 6.0, iOS 6.14): request
// signing, replay protection, enrolment codes, the device's reported state,
// and the routes whose meaning is the same on every platform —
//
//   POST /ack            (s)   the outcome of a command
//   POST /notify         (s)   6.7: { token, on } wake this device for the signed-in account
//   POST /events         (s)   security and update events (also signed long ago: after a wipe)
//   POST /message-audit  (s)   6.2: a message hidden or deleted in the app's own view
//   POST /location       (s)   6.1: positions for tracking (policy permitting)
//   GET  /bundles/:id    (s)   a published build, its key wrapped for this device
//
// (s) = signed by the device key: X-M5-Device, X-M5-Time, X-M5-Nonce,
// X-M5-Signature over "m5android/1|METHOD|path?query|time|nonce|b64(sha256(body))"
// (docs/android-architecture.md §1.4 — the same string on iOS; the path,
// /api/android/… or /api/ios/…, binds a request to its API). The body is
// read raw for that. Each platform's routes.ts adds info, enroll and checkin.

import type { NextFunction, Request, Response, Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { audit } from "../monitor/audit";
import { truncateIp } from "../monitor/traffic";
import { recordMessageAction, sanitizeMessageAudit } from "../message-audit";
import { requestSignedString, verifyP1363 } from "./crypto";
import { acknowledgeCommand } from "./commands";
import type { BaseDevice, Build, DeviceState, EventLevel, LocationPoint, MobileEvent, MobilePlatformId, MobileStore } from "./store";

export const MAX_SKEW = 5 * 60 * 1000;
/** Events signed before a wipe may arrive much later (the device was offline). */
export const EVENT_SKEW = 30 * 24 * 60 * 60 * 1000;

const nonces = new Map<string, number>();
/**
 * A nonce is remembered for as long as its request's time is accepted (6.7,
 * audit N12): /events accepts a 30-day skew, but a nonce was forgotten after
 * 10 minutes — the same signed request could be replayed for a month. Only
 * requests whose signature verified get here, so the map holds what enrolled
 * devices sent. One map for both platforms: device ids never collide (and_…, ios_…).
 */
function nonceFresh(nonce: string, now: number, skew = MAX_SKEW): boolean {
  if (nonces.size > 50_000) for (const [n, until] of nonces) if (until < now) nonces.delete(n);
  // Still full of live nonces: the oldest goes (Map order is insertion order).
  while (nonces.size > 200_000) nonces.delete(nonces.keys().next().value as string);
  if (nonces.has(nonce)) return false;
  nonces.set(nonce, now + 2 * skew);
  return true;
}

export type Signed<D> = Request & { device?: D; json?: Record<string, unknown> };

export const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const int = (v: unknown, min: number, max: number, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d);

export function bodyJson<D>(req: Signed<D>): Record<string, unknown> {
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
export function signedBy<D extends BaseDevice, R extends { id: string }>(store: MobileStore<D, R>, opts: { skew?: number; allowStatus?: D["status"][] } = {}) {
  const platform = store.platform;
  return (req: Signed<D>, res: Response, next: NextFunction) => {
    const id = str(req.header("x-m5-device"), 64);
    const time = str(req.header("x-m5-time"), 20);
    const nonce = str(req.header("x-m5-nonce"), 40);
    const sig = str(req.header("x-m5-signature"), 200);
    const device = id ? store.devices.get(id) : null;
    const now = Date.now();
    const t = Number(time);
    const refuse = (status: number, code: string, message: string) => {
      audit.add({ category: "security", level: "notice", event: `${platform}.request.refused`, target: id || undefined, ip: truncateIp(req.ip), status: code });
      res.status(status).json({ ok: false, code, message });
    };
    if (!device) return refuse(401, "unknown-device", "This device is not enrolled on this server.");
    if (!Number.isFinite(t) || Math.abs(now - t) > (opts.skew ?? MAX_SKEW)) return refuse(401, "clock", "The request time is too far from the server's — check the device clock.");
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(nonce)) return refuse(401, "replay", "This request was already used.");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyP1363(device.signKey, requestSignedString(req.method, req.originalUrl, time, nonce, raw), sig)) return refuse(401, "bad-signature", "The request signature is not valid.");
    // 6.7 (N12): the nonce is spent only by a request that verified, and kept for the whole accepted window.
    if (!nonceFresh(`${id}:${nonce}`, now, opts.skew ?? MAX_SKEW)) return refuse(401, "replay", "This request was already used.");
    if (device.status !== "active" && !(opts.allowStatus ?? []).includes(device.status)) return refuse(403, `device-${device.status}`, `This device is ${device.status}.`);
    req.device = device;
    next();
  };
}

/** What a device reports about itself, bounded; `pushKinds` are the platform's push transports ("fcm" or "apns"). */
export function sanitizeState(raw: unknown, pushKinds: readonly string[] = ["fcm", "poll"], extra = false): DeviceState {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bundle = s.bundle && typeof s.bundle === "object" ? s.bundle as Record<string, unknown> : null;
  const state: DeviceState = {
    battery: int(s.battery, -1, 100, -1),
    charging: s.charging === true,
    network: str(s.network, 20),
    locked: s.locked === true,
    rooms: int(s.rooms, 0, 64),
    bundle: bundle ? { id: str(bundle.id, 64), version: str(bundle.version, 40), state: str(bundle.state, 20) } : null,
    push: typeof s.push === "string" && pushKinds.includes(s.push) ? s.push as DeviceState["push"] : "none",
    lockMode: str(s.lockMode, 20),
    failedAttempts: int(s.failedAttempts, 0, 100),
    storage: int(s.storage, 0, 1e12),
    permissions: Array.isArray(s.permissions) ? s.permissions.filter((p): p is string => typeof p === "string").slice(0, 30).map((p) => p.slice(0, 60)) : [],
    at: Date.now(),
  };
  // 6.14 (iOS): the signed policy the device applies, and its biometry.
  if (extra) {
    state.policyAt = int(s.policyAt, 0, 1e15);
    state.biometry = ["faceID", "touchID", "opticID", "none"].includes(String(s.biometry)) ? String(s.biometry) : "";
  }
  return state;
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

/** An enrolment code (any case, dashes or not) that still has uses left; spends one. Returns its label. */
export function codeMatches<D extends BaseDevice, R extends { id: string }>(store: MobileStore<D, R>, code: string): string | null {
  const hash = createHash("sha256").update(code.replace(/[^A-Za-z0-9]/g, "").toUpperCase()).digest();
  const now = Date.now();
  for (const c of store.codes.list({ limit: 500 })) {
    if (c.usesLeft <= 0 || c.expiresAt < now) continue;
    const stored = Buffer.from(c.hash, "hex");
    if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
      store.codes.put({ ...c, usesLeft: c.usesLeft - 1, used: c.used + 1 });
      return c.label || c.id;
    }
  }
  return null;
}

/** What each platform gives the shared routes. */
export type DeviceApiPlatform<D extends BaseDevice, R extends { id: string }> = {
  store: MobileStore<D, R>;
  /** What a wiped device's record loses besides its status (its push tokens). */
  wiped: Partial<D>;
  /** The device's reported state, bounded (a status/ping answer refreshes it). */
  sanitizeState: (raw: unknown) => DeviceState;
  /** policy.location of the platform's policy. */
  location: () => { track: boolean; days: number; minSeconds: number };
  /** 6.7: link the device to the signed-in account for notifications (server/notify). */
  notifyLink: (device: D, body: Record<string, unknown>) => { status: number; json: Record<string, unknown> };
  /** The build's file with its key wrapped for these devices. */
  deployFile: (build: Build, devices: D[]) => Buffer;
};

/** ack, notify, events, message-audit, location, bundles/:id — the same on every platform. */
export function registerSharedDeviceRoutes<D extends BaseDevice, R extends { id: string }>(r: Router, p: DeviceApiPlatform<D, R>): void {
  const store = p.store;
  const platform: MobilePlatformId = store.platform;
  const signed = signedBy(store);

  r.post("/ack", signed, (req: Signed<D>, res) => {
    const b = bodyJson(req);
    const device = req.device!;
    const cmd = acknowledgeCommand(store, device, str(b.id, 64), b.ok !== false, b.result ?? null, str(b.error, 500));
    if (!cmd) return res.status(404).json({ ok: false, message: "No such command for this device." });
    // A status or ping answer refreshes what the console shows.
    if ((cmd.kind === "ping" || cmd.kind === "status") && b.result && typeof b.result === "object") {
      const state = (b.result as { state?: unknown }).state;
      if (state) store.devices.put({ ...device, lastSeen: Date.now(), state: p.sanitizeState(state) });
    }
    if (cmd.kind === "wipe" && cmd.status === "done") {
      store.devices.put({ ...device, status: "wiped", ...p.wiped });
      audit.add({ category: "security", level: "warn", event: `${platform}.device.remote-wiped`, target: device.id, detail: { by: cmd.createdBy } });
    }
    res.json({ ok: true, status: cmd.status });
  });

  // 6.7: the device (its key) and the account (its session token) together: the
  // notifier wakes this device for that account from now on — or no longer.
  r.post("/notify", signed, (req: Signed<D>, res) => {
    const out = p.notifyLink(req.device!, bodyJson(req));
    res.status(out.status).json(out.json);
  });

  r.post("/events", signedBy(store, { skew: EVENT_SKEW, allowStatus: ["wiped"] }), (req: Signed<D>, res) => {
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
      if (store.events.get(id)) continue; // the same event again (a retry)
      const detail = e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? e.detail as Record<string, unknown> : {};
      const text = JSON.stringify(detail);
      const event: MobileEvent = {
        id, deviceId: device.id, type, level: def.level, at: int(e.at, 0, 1e15, Date.now()), receivedAt: Date.now(),
        detail: text.length > 16_000 ? { truncated: true } : detail, ip: truncateIp(req.ip),
      };
      store.events.put(event);
      stored++;
      if (def.security || def.level === "warn" || def.level === "error") {
        audit.add({ category: def.security ? "security" : "system", level: def.level === "info" ? "info" : def.level, event: `${platform}.${type}`, target: device.id, ip: event.ip, detail: { name: device.name, ...detail } });
      }
      if (type === "wipe" || type === "remote-wipe") wiped = true;
    }
    if (wiped) store.devices.put({ ...device, status: "wiped", ...p.wiped, lastSeen: Date.now() });
    res.json({ ok: true, stored });
  });

  // 6.2: a message hidden or deleted in the app's own view — into the audit journal
  // (server/message-audit.ts); the message itself never comes here.
  r.post("/message-audit", signed, (req: Signed<D>, res) => {
    const device = req.device!;
    const b = bodyJson(req);
    const list = Array.isArray(b.actions) ? b.actions.slice(0, 50) : [b];
    const account = typeof b.account === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(b.account) ? b.account : "";
    let recorded = 0;
    for (const raw of list) {
      const input = sanitizeMessageAudit(raw);
      if (!input) continue;
      recordMessageAction(input, { actor: account || `device:${device.id}`, deviceId: device.id, ip: truncateIp(req.ip), via: platform });
      recorded++;
    }
    if (!recorded) return res.status(400).json({ ok: false, message: "Not a message action." });
    res.json({ ok: true, recorded });
  });

  // 6.1: positions for tracking — only when the user switched it on in the app and
  // the policy allows it. At most 100 points a request; a point closer in time to
  // the device's last one than policy.location.minSeconds is dropped.
  const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
  r.post("/location", signed, (req: Signed<D>, res) => {
    const policy = p.location();
    if (!policy.track) return res.status(403).json({ ok: false, code: "location-off", message: "The server does not keep device positions." });
    const device = req.device!;
    const b = bodyJson(req);
    const list = Array.isArray(b.points) ? b.points.slice(0, 100) : [];
    const last = store.locations.list({ device: device.id, limit: 1 })[0];
    let lastAt = last?.at ?? 0;
    let stored = 0;
    const now = Date.now();
    for (const raw of list) {
      const pt = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const lat = num(pt.lat, -90, 90), lon = num(pt.lon, -180, 180);
      const at = int(pt.at, 0, now + 5 * 60_000, 0);
      if (lat === null || lon === null || !at || at < now - 7 * 86_400_000) continue;
      if (at - lastAt < policy.minSeconds * 1000 && at >= lastAt) continue;
      const point: LocationPoint = {
        id: `loc_${device.id}_${at}`, deviceId: device.id, at, receivedAt: now, lat, lon,
        acc: num(pt.acc, 0, 100_000) ?? 0, alt: num(pt.alt, -1000, 20_000), speed: num(pt.speed, 0, 400), heading: num(pt.heading, 0, 360),
      };
      if (store.locations.get(point.id)) continue;
      store.locations.put(point);
      lastAt = Math.max(lastAt, at);
      stored++;
    }
    res.json({ ok: true, stored, minSeconds: policy.minSeconds });
  });

  r.get("/bundles/:id", signed, (req: Signed<D>, res) => {
    const build = store.builds.get(String(req.params.id));
    if (!build || build.status !== "published") return res.status(404).json({ ok: false, message: "No such published build." });
    if (build.minAppCode > req.device!.appCode) return res.status(409).json({ ok: false, message: "This app is too old for the build." });
    try {
      const file = p.deployFile(build, [req.device!]);
      res.setHeader("Content-Type", "application/vnd.m5cet.bundle");
      res.setHeader("Content-Disposition", `attachment; filename="${build.id}.m5ab"`);
      res.send(file);
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });
}

/** Old events and finished commands go after a while (<PLATFORM>_EVENT_DAYS, default 180); positions after policy.location.days. */
export function startPruning<D extends BaseDevice, R extends { id: string }>(store: MobileStore<D, R>, locationDays: () => number): void {
  const days = Math.max(7, Number(process.env[store.platform === "android" ? "ANDROID_EVENT_DAYS" : "IOS_EVENT_DAYS"]) || 180);
  const prune = () => {
    void store.ready().then(() => {
      const now = Date.now();
      store.events.pruneBefore(now - days * 86_400_000);
      store.commands.pruneBefore(now - 60 * 86_400_000, (c) => c.status === "queued" && c.expiresAt > now);
      store.locations.pruneBefore(now - locationDays() * 86_400_000);
    }).catch(() => undefined);
  };
  setTimeout(prune, 60_000).unref?.();
  setInterval(prune, 6 * 60 * 60 * 1000).unref?.();
}
