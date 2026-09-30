// Android settings (6.0): how devices enrol, the policy every device follows
// (lock, attempts, wipe, polling, updates), Firebase Cloud Messaging, and what
// an APK must be to be offered as an update. $DATA_DIR/android/config.json
// (0600, atomic writes). The FCM service account is sealed with the storage
// master key (storage/keys.ts sealValue) — the file never holds it in clear.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { openValue, sealValue } from "../storage/keys";
import { androidDir } from "./store";

export type BiometricMode = "required" | "optional" | "off";
export type LockPolicy = {
  /** required: biometrics to open (PIN only as the fallback the system offers); optional: the user chooses; off: PIN only. */
  biometric: BiometricMode;
  pinLength: number;
  /** Failed unlocks (PIN or biometrics) before the device acts. */
  maxAttempts: number;
  /** Wipe every local datum after maxAttempts (otherwise: lock out for an hour). */
  wipe: boolean;
  /** A growing wait from the third failure on (30 s × 2^n, at most an hour). */
  backoff: boolean;
  /** Lock again after this long in the background (0 = at once). */
  autolockSeconds: number;
  /** Allow screenshots and the recents thumbnail (FLAG_SECURE off). */
  screenshots: boolean;
};

export type AndroidPolicy = {
  lock: LockPolicy;
  /** Without FCM: how often a device checks in (JobScheduler, network only). */
  pollMinutes: number;
  update: { channel: "stable" | "beta" | "dev"; checkHours: number; wifiOnly: boolean; autoDownload: boolean };
  rooms: { max: number };
  /** What devices send besides their events: nothing, errors, or everything (on request). */
  logs: "off" | "errors" | "all";
  /**
   * 6.1: position tracking. A device sends its position only when the user
   * switched it on in the app (Settings › Location) AND the operator allows it
   * here; points are kept for `days`.
   */
  location: { track: boolean; days: number; minSeconds: number };
};

export type FcmClient = { apiKey: string; appId: string; senderId: string; projectId: string; storageBucket?: string };

export type AndroidConfig = {
  enrollment: "open" | "code" | "closed";
  policy: AndroidPolicy;
  fcm: { enabled: boolean; client: FcmClient | null; serviceAccount: string | null; serviceAccountEmail: string; projectId: string };
  /** The application id every release must have. */
  packageName: string;
  /** SHA-256 (hex) of the certificates releases may be signed with; learned from the first release when empty. */
  certSha256: string[];
  /**
   * 6.4: further certificates trusted for passkeys ONLY (assetlinks.json and
   * the WebAuthn app origin) — e.g. a developer's debug build. Never accepted
   * for a release upload; that is what certSha256 decides.
   */
  passkeyCertSha256: string[];
  rev: string;
  updatedAt: number;
  updatedBy: string;
};

export const DEFAULT_POLICY: AndroidPolicy = {
  lock: { biometric: "optional", pinLength: 6, maxAttempts: 8, wipe: true, backoff: true, autolockSeconds: 60, screenshots: false },
  pollMinutes: 30,
  update: { channel: "stable", checkHours: 12, wifiOnly: false, autoDownload: true },
  rooms: { max: 8 },
  logs: "errors",
  location: { track: true, days: 30, minSeconds: 15 },
};

export const DEFAULT_CONFIG: AndroidConfig = {
  enrollment: "open",
  policy: DEFAULT_POLICY,
  fcm: { enabled: false, client: null, serviceAccount: null, serviceAccountEmail: "", projectId: "" },
  packageName: "cz.m5cet.app",
  certSha256: [],
  passkeyCertSha256: [],
  rev: "",
  updatedAt: 0,
  updatedBy: "",
};

const configFile = () => join(androidDir(), "config.json");
const SA_AAD = "android:fcm:service-account";

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
};
const oneOf = <T extends string>(v: unknown, all: readonly T[], dflt: T): T => (typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : dflt);
const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function sanitizePolicy(raw: unknown): AndroidPolicy {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<AndroidPolicy> & { lock?: Partial<LockPolicy>; update?: Partial<AndroidPolicy["update"]>; rooms?: Partial<AndroidPolicy["rooms"]>; location?: Partial<AndroidPolicy["location"]> };
  const l: Partial<LockPolicy> = p.lock ?? {};
  const d = DEFAULT_POLICY;
  return {
    lock: {
      biometric: oneOf(l.biometric, ["required", "optional", "off"] as const, d.lock.biometric),
      pinLength: clampInt(l.pinLength, 4, 12, d.lock.pinLength),
      maxAttempts: clampInt(l.maxAttempts, 3, 20, d.lock.maxAttempts),
      wipe: bool(l.wipe, d.lock.wipe),
      backoff: bool(l.backoff, d.lock.backoff),
      autolockSeconds: clampInt(l.autolockSeconds, 0, 86_400, d.lock.autolockSeconds),
      screenshots: bool(l.screenshots, d.lock.screenshots),
    },
    pollMinutes: clampInt(p.pollMinutes, 15, 24 * 60, d.pollMinutes),
    update: {
      channel: oneOf(p.update?.channel, ["stable", "beta", "dev"] as const, d.update.channel),
      checkHours: clampInt(p.update?.checkHours, 1, 24 * 7, d.update.checkHours),
      wifiOnly: bool(p.update?.wifiOnly, d.update.wifiOnly),
      autoDownload: bool(p.update?.autoDownload, d.update.autoDownload),
    },
    rooms: { max: clampInt(p.rooms?.max, 1, 16, d.rooms.max) },
    logs: oneOf(p.logs, ["off", "errors", "all"] as const, d.logs),
    location: {
      track: bool(p.location?.track, d.location.track),
      days: clampInt(p.location?.days, 1, 3650, d.location.days),
      minSeconds: clampInt(p.location?.minSeconds, 5, 3600, d.location.minSeconds),
    },
  };
}

export function sanitizeFcmClient(raw: unknown): FcmClient | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const client: FcmClient = { apiKey: str(r.apiKey, 120), appId: str(r.appId, 120), senderId: str(r.senderId, 40), projectId: str(r.projectId, 100) };
  const bucket = str(r.storageBucket, 200);
  if (bucket) client.storageBucket = bucket;
  if (!/^[A-Za-z0-9_\-]{20,}$/.test(client.apiKey) || !/^\d+:\d+:android:[0-9a-f]+$/.test(client.appId) || !/^\d{4,}$/.test(client.senderId) || !/^[a-z0-9-]{4,}$/.test(client.projectId)) return null;
  return client;
}

/** A Google service account (JSON key) as FCM HTTP v1 needs it; null when it is not one. */
export function parseServiceAccount(json: string): { client_email: string; private_key: string; project_id: string; token_uri: string } | null {
  try {
    const sa = JSON.parse(json) as Record<string, unknown>;
    if (sa.type !== "service_account") return null;
    const email = str(sa.client_email, 200);
    const key = typeof sa.private_key === "string" ? sa.private_key : "";
    const project = str(sa.project_id, 100);
    if (!email.includes("@") || !key.includes("PRIVATE KEY") || !project) return null;
    return { client_email: email, private_key: key, project_id: project, token_uri: str(sa.token_uri, 200) || "https://oauth2.googleapis.com/token" };
  } catch {
    return null;
  }
}

function sanitizeConfig(raw: unknown): AndroidConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<AndroidConfig>;
  const fcm = (c.fcm && typeof c.fcm === "object" ? c.fcm : {}) as Partial<AndroidConfig["fcm"]>;
  const pkg = str(c.packageName, 150);
  return {
    enrollment: oneOf(c.enrollment, ["open", "code", "closed"] as const, DEFAULT_CONFIG.enrollment),
    policy: sanitizePolicy(c.policy),
    fcm: {
      enabled: bool(fcm.enabled, false),
      client: sanitizeFcmClient(fcm.client),
      serviceAccount: typeof fcm.serviceAccount === "string" && fcm.serviceAccount ? fcm.serviceAccount : null,
      serviceAccountEmail: str(fcm.serviceAccountEmail, 200),
      projectId: str(fcm.projectId, 100),
    },
    packageName: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg) ? pkg : DEFAULT_CONFIG.packageName,
    certSha256: Array.isArray(c.certSha256) ? c.certSha256.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)).slice(0, 8) : [],
    passkeyCertSha256: Array.isArray(c.passkeyCertSha256) ? c.passkeyCertSha256.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)).slice(0, 8) : [],
    rev: str(c.rev, 40),
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
    updatedBy: str(c.updatedBy, 120),
  };
}

let cached: AndroidConfig | null = null;

export function androidConfig(): AndroidConfig {
  if (cached) return cached;
  try {
    cached = sanitizeConfig(JSON.parse(readFileSync(configFile(), "utf8")));
  } catch {
    cached = structuredClone(DEFAULT_CONFIG);
  }
  return cached;
}

export function saveAndroidConfig(next: AndroidConfig, by: string): AndroidConfig {
  const clean = sanitizeConfig({ ...next, rev: randomBytes(6).toString("hex"), updatedAt: Date.now(), updatedBy: by });
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cached = clean;
  return clean;
}

/** Tests: read the file again. */
export function forgetAndroidConfig(): void { cached = null; }

export const sealServiceAccount = (json: string): string => sealValue(json, SA_AAD).toString("base64");
export const openServiceAccount = (sealed: string | null): string | null => (sealed ? openValue(Buffer.from(sealed, "base64"), SA_AAD) : null);

/** The config as the console sees it: the service account only by its e-mail. */
export function publicConfig(c: AndroidConfig) {
  return { ...c, fcm: { ...c.fcm, serviceAccount: undefined, hasServiceAccount: Boolean(c.fcm.serviceAccount) } };
}
