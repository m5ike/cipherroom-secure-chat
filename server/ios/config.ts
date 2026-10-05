// iOS settings (6.14): how devices enrol, the policy every device follows
// (the same policy as Android's: lock, attempts, wipe, polling, updates,
// rooms, logs, location — server/android/config.ts sanitizePolicy), the app's
// identity and where it is installed from, and APNs. $DATA_DIR/ios/ios.json
// (0600, atomic writes).
//
// The APNs key (.p8) never lives here: APNS_KEY_FILE, APNS_KEY_ID and
// APNS_TEAM_ID come from the environment (apns.ts); this file may switch push
// off, pick the environment and override the topic.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_POLICY, sanitizePolicy, type AndroidPolicy } from "../android/config";
import { mobileDir } from "../mobile/store";

export type IosPolicy = AndroidPolicy;

export type IosConfig = {
  enrollment: "open" | "code" | "closed";
  policy: IosPolicy;
  /** The app's bundle identifier (CFBundleIdentifier) — the APNs topic unless overridden, and the AASA app id. */
  bundleId: string;
  /** Apps below this build (major·10000 + minor·100 + patch) are told to update before anything else; 0 = none. */
  minAppBuild: number;
  /** Where the app is installed from (the console's "Getting the app", the default of a new release). */
  appStoreUrl: string;
  testFlightUrl: string;
  apns: {
    /** Send control messages over APNs (when the key is configured); off = devices only check in. */
    enabled: boolean;
    /** "" = APNS_ENV (production unless set); devices that report their own environment use theirs. */
    env: "" | "production" | "sandbox";
    /** "" = APNS_TOPIC, else the bundle id. */
    topic: string;
  };
  rev: string;
  updatedAt: number;
  updatedBy: string;
};

export const DEFAULT_IOS_CONFIG: IosConfig = {
  enrollment: "open",
  policy: DEFAULT_POLICY,
  bundleId: "cz.m5cet.app",
  minAppBuild: 0,
  appStoreUrl: "",
  testFlightUrl: "",
  apns: { enabled: true, env: "", topic: "" },
  rev: "",
  updatedAt: 0,
  updatedBy: "",
};

const configFile = () => join(mobileDir("ios"), "ios.json");

const oneOf = <T extends string>(v: unknown, all: readonly T[], dflt: T): T => (typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : dflt);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** The hosts an install link may point to — the app opens it, so only Apple's. */
const APPLE_HOSTS = new Set(["apps.apple.com", "itunes.apple.com", "testflight.apple.com"]);

/** An https link to the App Store or TestFlight; "" for anything else. */
export function appleUrl(v: unknown): string {
  const s = str(v, 500);
  if (!/^https:\/\/[^\s"'<>]+$/.test(s)) return "";
  try { return APPLE_HOSTS.has(new URL(s).hostname.toLowerCase()) ? s : ""; } catch { return ""; }
}

export function sanitizeIosConfig(raw: unknown): IosConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<IosConfig>;
  const apns = (c.apns && typeof c.apns === "object" ? c.apns : {}) as Partial<IosConfig["apns"]>;
  const bundleId = str(c.bundleId, 155);
  const topic = str(apns.topic, 160);
  const build = typeof c.minAppBuild === "number" && Number.isFinite(c.minAppBuild) ? Math.max(0, Math.min(99_999_999, Math.round(c.minAppBuild))) : 0;
  return {
    enrollment: oneOf(c.enrollment, ["open", "code", "closed"] as const, DEFAULT_IOS_CONFIG.enrollment),
    policy: sanitizePolicy(c.policy),
    bundleId: BUNDLE_ID_RE.test(bundleId) ? bundleId : DEFAULT_IOS_CONFIG.bundleId,
    minAppBuild: build,
    appStoreUrl: appleUrl(c.appStoreUrl),
    testFlightUrl: appleUrl(c.testFlightUrl),
    apns: {
      enabled: typeof apns.enabled === "boolean" ? apns.enabled : DEFAULT_IOS_CONFIG.apns.enabled,
      env: oneOf(apns.env, ["", "production", "sandbox"] as const, ""),
      topic: BUNDLE_ID_RE.test(topic) ? topic : "",
    },
    rev: str(c.rev, 40),
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
    updatedBy: str(c.updatedBy, 120),
  };
}

let cached: IosConfig | null = null;

export function iosConfig(): IosConfig {
  if (cached) return cached;
  try {
    cached = sanitizeIosConfig(JSON.parse(readFileSync(configFile(), "utf8")));
  } catch {
    cached = structuredClone(DEFAULT_IOS_CONFIG);
  }
  return cached;
}

export function saveIosConfig(next: IosConfig, by: string): IosConfig {
  const clean = sanitizeIosConfig({ ...next, rev: randomBytes(6).toString("hex"), updatedAt: Date.now(), updatedBy: by });
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cached = clean;
  return clean;
}

/** Tests: read the file again. */
export function forgetIosConfig(): void { cached = null; }
