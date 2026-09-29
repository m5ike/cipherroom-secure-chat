// The Android store (6.0): enrolled devices, builds (bundles), APK releases,
// the commands sent to devices, their events, enrolment codes — in
// $DATA_DIR/android/android.db (SQLite, WAL). ANDROID_DATA_DIR moves the
// folder (the bundles and APKs live next to the database).
//
// Every table is the same shape: an id, a JSON document, a number to sort by
// and a device id to filter by. Without the SQLite driver the tables live in
// memory — everything works within one run of the process and the console
// says it will not survive a restart.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes, createPublicKey, type KeyObject } from "node:crypto";
import { loadSqliteDriver, type SqliteDatabase } from "../storage/db";
import { fingerprintOf, kidOf, newP256, privateKeyFromPem, spkiOf, type BundleHeader } from "./crypto";

export function androidDir(): string {
  const explicit = process.env.ANDROID_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);
  const data = process.env.DATA_DIR?.trim();
  return data ? resolve(data, "android") : resolve(process.cwd(), ".m5cet", "android");
}
export const androidDbPath = (): string => join(androidDir(), "android.db");
export const buildsDir = (): string => join(androidDir(), "builds");
export const releasesDir = (): string => join(androidDir(), "releases");

export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;

/* ------------------------------------------------------------------ types */

export type DeviceStatus = "active" | "blocked" | "wiped" | "retired";

/** What a device reports on check-in (all optional, all small). */
export type DeviceState = {
  battery?: number; charging?: boolean; network?: string; locked?: boolean; rooms?: number;
  bundle?: { id: string; version: string; state: string } | null;
  push?: "fcm" | "poll" | "none"; lockMode?: string; failedAttempts?: number; storage?: number;
  permissions?: string[]; at?: number;
};

export type Device = {
  id: string; name: string; model: string; manufacturer: string; os: string; sdk: number;
  appVersion: string; appCode: number; locale: string;
  signKey: string; encKey: string; kid: string; fcmToken: string;
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
export type Release = {
  id: string; versionName: string; versionCode: number; packageName: string; channel: string; notes: string;
  apkSha256: string; certSha256: string; size: number; minSdk: number; mandatory: boolean;
  status: ReleaseStatus; createdAt: number; createdBy: string; publishedAt: number | null; signature: string;
  source: "upload" | "build";
};

export type CommandKind = "ping" | "status" | "flash" | "push" | "update" | "lock" | "wipe" | "config";
export type CommandStatus = "queued" | "sent" | "delivered" | "done" | "failed" | "expired";
export type Command = {
  id: string; deviceId: string; kind: CommandKind; payload: Record<string, unknown>;
  status: CommandStatus; createdAt: number; createdBy: string; expiresAt: number;
  sentAt: number | null; via: "" | "fcm" | "poll"; doneAt: number | null; result: unknown; error: string;
};

export type EventLevel = "info" | "notice" | "warn" | "error";
export type AndroidEvent = {
  id: string; deviceId: string; type: string; level: EventLevel; at: number; receivedAt: number;
  detail: Record<string, unknown>; ip: string;
};

export type EnrollCode = {
  id: string; hash: string; label: string; usesLeft: number; used: number; expiresAt: number;
  createdAt: number; createdBy: string;
};

/* ------------------------------------------------------------------ table */

type Row = { id: string; data: string; sort: number; device: string };

class Table<T extends { id: string }> {
  private mem = new Map<string, T>();
  constructor(
    private readonly name: string,
    private readonly db: () => SqliteDatabase | null,
    private readonly sortOf: (v: T) => number,
    private readonly deviceOf: (v: T) => string = () => "",
  ) {}

  schema(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.name} (id TEXT PRIMARY KEY, data TEXT NOT NULL, sort INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS ${this.name}_sort ON ${this.name}(sort);
            CREATE INDEX IF NOT EXISTS ${this.name}_device ON ${this.name}(device, sort);`;
  }

  get(id: string): T | null {
    const d = this.db();
    if (!d) return this.mem.get(id) ?? null;
    const row = d.prepare(`SELECT data FROM ${this.name} WHERE id = ?`).get(id) as Pick<Row, "data"> | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  put(value: T): T {
    const d = this.db();
    if (!d) { this.mem.set(value.id, structuredClone(value)); return value; }
    d.prepare(`INSERT INTO ${this.name} (id, data, sort, device) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, sort = excluded.sort, device = excluded.device`)
      .run(value.id, JSON.stringify(value), this.sortOf(value), this.deviceOf(value));
    return value;
  }

  delete(id: string): boolean {
    const d = this.db();
    if (!d) return this.mem.delete(id);
    return (d.prepare(`DELETE FROM ${this.name} WHERE id = ?`).run(id) as { changes: number }).changes > 0;
  }

  /** Newest first. */
  list(opts: { device?: string; limit?: number; before?: number; filter?: (v: T) => boolean } = {}): T[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const d = this.db();
    if (!d) {
      return [...this.mem.values()]
        .filter((v) => (!opts.device || this.deviceOf(v) === opts.device) && (opts.before === undefined || this.sortOf(v) < opts.before) && (!opts.filter || opts.filter(v)))
        .sort((a, b) => this.sortOf(b) - this.sortOf(a))
        .slice(0, limit)
        .map((v) => structuredClone(v));
    }
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.device) { where.push("device = ?"); args.push(opts.device); }
    if (opts.before !== undefined) { where.push("sort < ?"); args.push(opts.before); }
    const sql = `SELECT data FROM ${this.name}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sort DESC`;
    if (!opts.filter) return (d.prepare(`${sql} LIMIT ?`).all(...args, limit) as Array<Pick<Row, "data">>).map((r) => JSON.parse(r.data) as T);
    // A filter runs in JS: walk the rows until the limit is filled.
    const out: T[] = [];
    for (const r of d.prepare(sql).iterate(...args) as IterableIterator<Pick<Row, "data">>) {
      const v = JSON.parse(r.data) as T;
      if (opts.filter(v)) out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }

  count(filter?: (v: T) => boolean): number {
    const d = this.db();
    if (!d) return filter ? [...this.mem.values()].filter(filter).length : this.mem.size;
    if (!filter) return Number((d.prepare(`SELECT COUNT(*) AS n FROM ${this.name}`).get() as { n: number }).n);
    return this.list({ limit: 5000, filter }).length;
  }

  /** Removes rows sorted before `t` (events, commands); returns how many. */
  pruneBefore(t: number, keep?: (v: T) => boolean): number {
    const d = this.db();
    if (!d) {
      let n = 0;
      for (const [id, v] of this.mem) if (this.sortOf(v) < t && !(keep?.(v))) { this.mem.delete(id); n++; }
      return n;
    }
    if (!keep) return (d.prepare(`DELETE FROM ${this.name} WHERE sort < ?`).run(t) as { changes: number }).changes;
    let n = 0;
    for (const v of this.list({ before: t, limit: 5000 })) if (!keep(v)) { this.delete(v.id); n++; }
    return n;
  }

  clearMemory(): void { this.mem.clear(); }
}

/* ------------------------------------------------------------------ store */

class AndroidStore {
  private db: SqliteDatabase | null = null;
  private opening: Promise<void> | null = null;
  private reason = "";
  private signer: { privateKey: KeyObject; publicKey: string; kid: string; fingerprint: string } | null = null;

  readonly devices = new Table<Device>("devices", () => this.db, (v) => v.lastSeen || v.enrolledAt);
  readonly builds = new Table<Build>("builds", () => this.db, (v) => v.number);
  readonly releases = new Table<Release>("releases", () => this.db, (v) => v.versionCode);
  readonly commands = new Table<Command>("commands", () => this.db, (v) => v.createdAt, (v) => v.deviceId);
  readonly events = new Table<AndroidEvent>("events", () => this.db, (v) => v.receivedAt, (v) => v.deviceId);
  readonly codes = new Table<EnrollCode>("enroll_codes", () => this.db, (v) => v.createdAt);

  ready(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.opening ??= (async () => {
      const Driver = await loadSqliteDriver();
      if (!Driver) { this.reason = "the SQLite driver is not installed — Android data is kept in memory only"; return; }
      const file = androidDbPath();
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
        try { chmodSync(file, 0o600); } catch { /* not ours */ }
        const db = new Driver(file, { timeout: 5000 });
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.pragma("secure_delete = ON");
        for (const t of [this.devices, this.builds, this.releases, this.commands, this.events, this.codes]) db.exec(t.schema());
        this.db = db;
        this.reason = "";
      } catch (err) {
        this.reason = `cannot open ${file}: ${(err as Error).message} — Android data is kept in memory only`;
      }
    })();
    return this.opening;
  }

  status(): { persistent: boolean; file: string; reason: string } {
    return { persistent: Boolean(this.db), file: androidDbPath(), reason: this.reason };
  }

  /** Tests: forget the open database and the in-memory rows. */
  reset(): void {
    try { this.db?.close(); } catch { /* closed */ }
    this.db = null;
    this.opening = null;
    this.signer = null;
    for (const t of [this.devices, this.builds, this.releases, this.commands, this.events, this.codes]) t.clearMemory();
  }

  /* -------------------------------------------------------- signing key */

  /** The server's ECDSA P-256 key that signs bundles, releases and push
   *  messages: signing.key (PKCS#8 PEM, 0600) in the Android folder,
   *  created on first use. ANDROID_SIGNING_KEY_FILE moves it. */
  signingKey(): { privateKey: KeyObject; publicKey: string; kid: string; fingerprint: string } {
    if (this.signer) return this.signer;
    const file = process.env.ANDROID_SIGNING_KEY_FILE?.trim() ? resolve(process.env.ANDROID_SIGNING_KEY_FILE.trim()) : join(androidDir(), "signing.key");
    let privateKey: KeyObject;
    try {
      privateKey = privateKeyFromPem(readFileSync(file, "utf8"));
    } catch {
      privateKey = newP256().privateKey;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
      } catch {
        // Another process wrote it first: use theirs.
        privateKey = privateKeyFromPem(readFileSync(file, "utf8"));
      }
    }
    const publicKey = spkiOf(createPublicKey(privateKey));
    this.signer = { privateKey, publicKey, kid: kidOf(publicKey), fingerprint: fingerprintOf(publicKey) };
    return this.signer;
  }

  /* ----------------------------------------------------------- files */

  buildFile(id: string): string { return join(buildsDir(), `${id.replace(/[^A-Za-z0-9_]/g, "")}.m5ab`); }
  releaseFile(id: string): string { return join(releasesDir(), `${id.replace(/[^A-Za-z0-9_]/g, "")}.apk`); }

  writeFileAtomic(path: string, data: Buffer): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  }

  removeFile(path: string): void { try { rmSync(path, { force: true }); } catch { /* gone */ } }
}

export const androidStore = new AndroidStore();
