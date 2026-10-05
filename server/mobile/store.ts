// The mobile apps' store (Android 6.0; shared with iOS since 6.14): enrolled
// devices, builds (bundles), releases, the commands sent to devices, their
// events, positions and enrolment codes — one SQLite file per platform,
// $DATA_DIR/<platform>/<platform>.db (WAL), next to that platform's bundles.
// ANDROID_DATA_DIR / IOS_DATA_DIR move a platform's folder.
//
// Every table is the same shape: an id, a JSON document, a number to sort by
// and a device id to filter by. Without the SQLite driver the tables live in
// memory — everything works within one run of the process and the console
// says it will not survive a restart.
//
// The server's signing key (bundles, releases, control messages, policies) is
// ONE key for both platforms (signing.ts): a phone and a tablet of the same
// operator pin the same fingerprint.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadSqliteDriver, type SqliteDatabase } from "../storage/db";
import { DocTable as Table } from "../storage/doc-table";
import type { BundleHeader } from "./crypto";
import { forgetMobileSigningKey, mobileSigningKey, type MobileSigner } from "./signing";

export type MobilePlatformId = "android" | "ios";

/** A platform's folder: <PLATFORM>_DATA_DIR, else $DATA_DIR/<platform>, else ./.m5cet/<platform>. */
export function mobileDir(platform: MobilePlatformId): string {
  const explicit = process.env[platform === "android" ? "ANDROID_DATA_DIR" : "IOS_DATA_DIR"]?.trim();
  if (explicit) return resolve(explicit);
  const data = process.env.DATA_DIR?.trim();
  return data ? resolve(data, platform) : resolve(process.cwd(), ".m5cet", platform);
}

export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;

/* ------------------------------------------------------------------ types */

export type DeviceStatus = "active" | "blocked" | "wiped" | "retired";

/** What a device reports on check-in (all optional, all small). */
export type DeviceState = {
  battery?: number; charging?: boolean; network?: string; locked?: boolean; rooms?: number;
  bundle?: { id: string; version: string; state: string } | null;
  push?: "fcm" | "apns" | "poll" | "none"; lockMode?: string; failedAttempts?: number; storage?: number;
  permissions?: string[]; at?: number;
  /** 6.14 (iOS): the `at` of the signed policy the device applies, and its biometry (faceID, touchID, opticID, none). */
  policyAt?: number; biometry?: string;
};

/** What every platform's device record has (Android's and iOS's add their own). */
export type BaseDevice = {
  id: string; name: string; model: string; appVersion: string; appCode: number; locale: string;
  signKey: string; encKey: string; kid: string;
  status: DeviceStatus; enrolledAt: number; enrolledWith: string; lastSeen: number; lastIp: string;
  state: DeviceState; notes: string;
};

export type BuildStatus = "ready" | "published" | "withdrawn";
export type Build = {
  id: string; number: number; version: string; channel: string; status: BuildStatus; notes: string;
  createdAt: number; createdBy: string; publishedAt: number | null;
  minAppCode: number; designRev: string; size: number; fileSize: number; sha256: string;
  /** The content key, sealed with the storage master key (sealValue). */
  cekSealed: string;
  header: Omit<BundleHeader, "recipients">;
  summary: { screens: string[]; files: number; languages: string[]; libraries: string[] };
};

export type ReleaseStatus = "draft" | "published" | "withdrawn";

/** 6.7: "notify" — a notification by the server's template (server/notify), sent by the notifier, not from the console. */
export type CommandKind = "ping" | "status" | "flash" | "push" | "update" | "lock" | "wipe" | "config" | "notify";
export type CommandStatus = "queued" | "sent" | "delivered" | "done" | "failed" | "expired";
export type Command = {
  id: string; deviceId: string; kind: CommandKind; payload: Record<string, unknown>;
  status: CommandStatus; createdAt: number; createdBy: string; expiresAt: number;
  sentAt: number | null; via: "" | "fcm" | "apns" | "poll"; doneAt: number | null; result: unknown; error: string;
};

export type EventLevel = "info" | "notice" | "warn" | "error";
export type MobileEvent = {
  id: string; deviceId: string; type: string; level: EventLevel; at: number; receivedAt: number;
  detail: Record<string, unknown>; ip: string;
};

/** 6.1: a position a device reported (Settings › Location › tracking, allowed by the policy). */
export type LocationPoint = {
  id: string; deviceId: string; at: number; receivedAt: number;
  lat: number; lon: number; acc: number; alt: number | null; speed: number | null; heading: number | null;
};

export type EnrollCode = {
  id: string; hash: string; label: string; usesLeft: number; used: number; expiresAt: number;
  createdAt: number; createdBy: string;
};

/* ------------------------------------------------------------------ store */

export type MobileStoreOptions<R> = {
  platform: MobilePlatformId;
  /** "Android", "iOS" — in the console's messages. */
  label: string;
  /** How releases sort (newest first): Android's versionCode, iOS's build. */
  releaseSort: (r: R) => number;
  /** The extension of a release's file (Android's APK); none for a platform without files. */
  releaseExt?: string;
};

export class MobileStore<D extends BaseDevice, R extends { id: string }> {
  private db: SqliteDatabase | null = null;
  private opening: Promise<void> | null = null;
  private reason = "";

  readonly devices: Table<D>;
  readonly builds: Table<Build>;
  readonly releases: Table<R>;
  readonly commands: Table<Command>;
  readonly events: Table<MobileEvent>;
  readonly codes: Table<EnrollCode>;
  readonly locations: Table<LocationPoint>;

  constructor(readonly opts: MobileStoreOptions<R>) {
    this.devices = new Table<D>("devices", () => this.db, (v) => v.lastSeen || v.enrolledAt);
    this.builds = new Table<Build>("builds", () => this.db, (v) => v.number);
    this.releases = new Table<R>("releases", () => this.db, (v) => opts.releaseSort(v));
    this.commands = new Table<Command>("commands", () => this.db, (v) => v.createdAt, (v) => v.deviceId);
    this.events = new Table<MobileEvent>("events", () => this.db, (v) => v.receivedAt, (v) => v.deviceId);
    this.codes = new Table<EnrollCode>("enroll_codes", () => this.db, (v) => v.createdAt);
    this.locations = new Table<LocationPoint>("locations", () => this.db, (v) => v.at, (v) => v.deviceId);
  }

  get platform(): MobilePlatformId { return this.opts.platform; }
  dir(): string { return mobileDir(this.opts.platform); }
  dbPath(): string { return join(this.dir(), `${this.opts.platform}.db`); }
  buildsDir(): string { return join(this.dir(), "builds"); }
  releasesDir(): string { return join(this.dir(), "releases"); }

  private tables() { return [this.devices, this.builds, this.releases, this.commands, this.events, this.codes, this.locations]; }

  ready(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.opening ??= (async () => {
      const Driver = await loadSqliteDriver();
      if (!Driver) { this.reason = `the SQLite driver is not installed — ${this.opts.label} data is kept in memory only`; return; }
      const file = this.dbPath();
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
        try { chmodSync(file, 0o600); } catch { /* not ours */ }
        const db = new Driver(file, { timeout: 5000 });
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.pragma("secure_delete = ON");
        for (const t of this.tables()) db.exec(t.schema());
        this.db = db;
        this.reason = "";
      } catch (err) {
        this.reason = `cannot open ${file}: ${(err as Error).message} — ${this.opts.label} data is kept in memory only`;
      }
    })();
    return this.opening;
  }

  status(): { persistent: boolean; file: string; reason: string } {
    return { persistent: Boolean(this.db), file: this.dbPath(), reason: this.reason };
  }

  /** Tests: forget the open database and the in-memory rows. */
  reset(): void {
    try { this.db?.close(); } catch { /* closed */ }
    this.db = null;
    this.opening = null;
    forgetMobileSigningKey();
    for (const t of this.tables()) t.clearMemory();
  }

  /** The server's ECDSA P-256 key that signs bundles, releases, policies and push messages (signing.ts). */
  signingKey(): MobileSigner { return mobileSigningKey(); }

  /* ----------------------------------------------------------- files */

  buildFile(id: string): string { return join(this.buildsDir(), `${id.replace(/[^A-Za-z0-9_]/g, "")}.m5ab`); }
  releaseFile(id: string): string { return join(this.releasesDir(), `${id.replace(/[^A-Za-z0-9_]/g, "")}.${this.opts.releaseExt ?? "bin"}`); }

  writeFileAtomic(path: string, data: Buffer): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  }

  removeFile(path: string): void { try { rmSync(path, { force: true }); } catch { /* gone */ } }
}
