// The global database: what the server itself has to know.
//
//   users / passkeys   who is registered and which public keys belong to
//                      them (public material only — no secret ever lands
//                      here, and the vault key least of all)
//   databases          the index of every encrypted database: who owns it,
//                      how it is keyed, when it expires, how big it is
//   logs               server and client log / debug lines, payload sealed
//   transfers          one detailed row per file transfer and owner, sealed
//   audit              the operator's audit journal, detail sealed
//   mail_queue         the offline queue (accounts/mailqueue.ts) lives here
//                      too, on the handle `handleForQueue` gives it
//
// Everything that could describe a conversation is sealed before it is
// written (keys.ts), with the AAD naming the row it belongs to, so this file
// holds counts, timestamps and opaque ids rather than content — and a sealed
// value copied onto another row does not open. Session ids never appear in
// the clear: they are stored as HMAC references (keys.ts sessionRef).

import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databaseBytes, ensurePrivateDir, openPlainDatabase, StorageUnavailableError, type SqliteDatabase, type SqliteStatement } from "./db";
import { GLOBAL_MIGRATIONS } from "./schema";
import { derivedKey, openValue, sealValue, sessionRef, storageDir, toSessionRef, unwrapKey, wrapKey, type KeyMode } from "./keys";
import type { AuditEntry } from "../monitor/audit";

export type OwnerKind = "account" | "session";

export type DatabaseRow = {
  id: string;
  ownerKind: OwnerKind;
  /** The account id, or — for a session — the HMAC reference of its id. */
  ownerId: string;
  keyMode: KeyMode;
  fileName: string;
  /** 0 until the file was first created and migrated. */
  schemaVersion: number;
  createdAt: number;
  lastOpenedAt: number;
  expiresAt: number;
  bytes: number;
  status: string;
};

export type PasskeyRow = {
  credentialId: string;
  accountId: string;
  publicKey: JsonWebKey;
  alg: number;
  signCount: number;
  label: string;
  createdAt: number;
  lastUsedAt: number;
};

export type UserRow = {
  id: string;
  userName: string;
  createdAt: number;
  lastLoginAt: number;
  loginCount: number;
  status: string;
};

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEntry = {
  at: number;
  level: LogLevel;
  source: "client" | "server" | "admin";
  event: string;
  accountId?: string | null;
  /** A session id or its reference; stored (and read back) as the reference. */
  sessionId?: string | null;
  detail?: unknown;
};

export type TransferRecord = {
  id: string;
  at: number;
  finishedAt?: number;
  direction: "in" | "out";
  transport: "p2p" | "proxy";
  status: "started" | "completed" | "cancelled" | "failed";
  accountId?: string | null;
  sessionId?: string | null;
  roomHash?: string;
  bytes?: number;
  chunks?: number;
  resentChunks?: number;
  detail?: unknown;
};

export type AuditFilter = {
  category?: string;
  minLevel?: string;
  actor?: string;
  accountId?: string;
  peerId?: string;
  event?: string;
  search?: string;
  since?: number;
  limit?: number;
};

export type GlobalInspection = {
  file: string;
  bytes: number;
  walBytes: number;
  pageSize: number;
  pageCount: number;
  freelist: number;
  journalMode: string;
  tables: Array<{ name: string; rows: number }>;
};

const LOG_KEEP = 50_000;
const TRANSFER_KEEP = 50_000;
const AUDIT_KEEP = 200_000;
const DETAIL_MAX = 8_000;
const AUDIT_LEVELS = ["debug", "info", "notice", "warn", "error"] as const;
/** Files the storage creates in db/: `db-<24 hex>.db` and its journals. */
const DB_FILE = /^(db-[0-9a-f]{24}\.db)(-wal|-shm|-journal)?$/;

/** JSON of a detail, or a marker when it is too big to keep. */
function capJson(value: unknown, max: number): string {
  const json = JSON.stringify(value) ?? "null";
  return json.length <= max ? json : JSON.stringify({ truncated: true, bytes: json.length });
}

/** The owner of a transfer row: account, session reference, or the server. */
function ownerTag(accountId: string | null, sessionRefValue: string | null): string {
  if (accountId) return `a:${accountId}`;
  if (sessionRefValue) return `s:${sessionRefValue}`;
  return "";
}

// Each sealed value names its row, so it cannot be moved to another one.
const logAad = (at: number, source: string, event: string, accountId: string | null, sref: string | null) =>
  `m5cet:log:v2:${at}:${source}:${event}:${accountId ?? ""}:${sref ?? ""}`;
const transferAad = (owner: string, id: string) => `m5cet:transfer:v2:${owner}:${id}`;
const auditAad = (category: string, event: string, at: number) => `m5cet:audit:v1:${category}:${event}:${at}`;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const optText = (value: unknown, max: number): string | null => (typeof value === "string" && value ? value.slice(0, max) : null);

/** How often (in rows) the head of the audit chain is signed. */
const AUDIT_CHECKPOINT_EVERY = 500;
/** 6.12 review S01: chained rows a valid checkpoint may lag behind the head (the cadence plus slack) before
 *  verification fails with "checkpoint-missing" — deleting the checkpoints no longer leaves a clean journal. */
export const AUDIT_UNSIGNED_TAIL_MAX = AUDIT_CHECKPOINT_EVERY + 10;

export type AuditVerification = {
  ok: boolean;
  checked: number;
  /** Rows from before the chain existed (3.0 and earlier). */
  unchained: number;
  checkpoints: number;
  signedCheckpoints: number;
  lastCheckpoint: { at: number; lastId: number } | null;
  /** The key checkpoints are signed with now (6.12: derived from the master key). */
  publicKey: string;
  /** 6.12 (F-23): what the verification trusts besides that key (audit-signing.pin), or null when nothing is pinned.
   *  `coverFrom` (review S01): from this row on, at most AUDIT_UNSIGNED_TAIL_MAX chained rows may follow the newest valid checkpoint. */
  pinned: { file: string; at: number; earlierKeys: number; chainFrom: number; coverFrom: number } | null;
  problems: Array<{
    id: number;
    kind: "row-altered" | "link-broken" | "rows-missing" | "row-unchained" | "checkpoint-signature" | "checkpoint-mismatch" | "checkpoint-missing"
      | "pin-invalid" | "pin-missing" | "key-not-pinned";
  }>;
};

/** 6.12 (F-23): audit-signing.pin — see GlobalStore.ensurePin. v2 (review S01) adds coverFrom to the MACed body. */
type AuditPin = { v: 1 | 2; keys: Array<{ publicKey: string; upTo: number | null }>; chainFrom: number; pinnedAt: number; coverFrom?: number; mac: string };

/** PKCS#8 DER header of an Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const safeEqualHex = (a: string, b: string) => /^[0-9a-f]+$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** A checkpoint row whose signature holds under the key the row itself names (only for pinning at the upgrade). */
function selfSigned(c: Record<string, unknown>): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(String(c.public_key), "base64"), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(checkpointMessage(Number(c.last_id), String(c.head_hash), Number(c.at))), key, Buffer.from(String(c.signature), "base64"));
  } catch { return false; }
}

type ChainedRow = {
  at: number; category: string; level: string; event: string; actor: string | null; target: string | null;
  accountId: string | null; sessionRef: string | null; peerId: string | null; roomHash: string | null;
  ip: string | null; bytes: number | null; status: string | null; detail: Buffer | Uint8Array | null;
};

/** SHA-256 over the previous hash and every column, in a fixed order. */
function auditRowHash(prev: string, row: ChainedRow): string {
  const detail = row.detail ? Buffer.from(row.detail).toString("base64") : null;
  const canonical = JSON.stringify([prev, row.at, row.category, row.level, row.event, row.actor, row.target, row.accountId, row.sessionRef, row.peerId, row.roomHash, row.ip, row.bytes, row.status, detail]);
  return createHash("sha256").update(canonical).digest("hex");
}

const checkpointMessage = (lastId: number, headHash: string, at: number) => `m5cet/audit-checkpoint/1|${lastId}|${headHash}|${at}`;

export class GlobalStore {
  private db: SqliteDatabase | null = null;
  private statements = new Map<string, SqliteStatement>();

  constructor(private readonly dir: string = storageDir()) {}

  /** Opens (and migrates) the global database. Throws when the driver is
   *  missing — callers treat that as "storage is off". */
  open(): SqliteDatabase {
    if (this.db?.open) return this.db;
    // The storage directory and its db/ folder are this user's only.
    ensurePrivateDir(this.dir);
    ensurePrivateDir(join(this.dir, "db"));
    this.statements.clear();
    this.db = openPlainDatabase(join(this.dir, "m5cet.db"), GLOBAL_MIGRATIONS);
    this.rehashLegacySessionIds();
    // 6.12 (F-23): the first start after the upgrade pins the audit journal's checkpoint keys.
    try { this.ensurePin(); } catch (err) { console.warn(`[storage] audit pin: ${(err as Error).message}`); }
    return this.db;
  }

  get isOpen(): boolean {
    return Boolean(this.db?.open);
  }

  close(): void {
    this.statements.clear();
    try { this.db?.close(); } catch { /* already gone */ }
    this.db = null;
    // What was read from the database and the pin file is read again on the next open.
    this.head = null;
    this.checkpointedId = null;
    this.pin = null;
    this.pinProblem = null;
  }

  private handle(): SqliteDatabase {
    if (!this.db?.open) return this.open();
    return this.db;
  }

  /** The global database, for the offline queue (accounts/mailqueue.ts),
   *  which keeps its own tables in it. */
  handleForQueue(): SqliteDatabase {
    return this.handle();
  }

  private sql(source: string): SqliteStatement {
    const db = this.handle();
    let statement = this.statements.get(source);
    if (!statement) {
      statement = db.prepare(source);
      this.statements.set(source, statement);
    }
    return statement;
  }

  /**
   * Rows written before session ids were stored as HMAC references still
   * hold the id itself (it starts with "sess-"); rewrite them, and re-wrap
   * those databases' keys under the wrapping subkey. Idempotent, and free
   * when there is nothing to do.
   */
  private rehashLegacySessionIds(): void {
    const db = this.db!;
    const databases = db.prepare("SELECT id, owner_id, wrapped_key FROM databases WHERE owner_kind = 'session' AND owner_id LIKE 'sess-%'").all() as Array<{ id: string; owner_id: string; wrapped_key: Buffer | null }>;
    const logs = db.prepare("SELECT DISTINCT session_id AS s FROM logs WHERE session_id LIKE 'sess-%'").all() as Array<{ s: string }>;
    const transfers = db.prepare("SELECT DISTINCT session_id AS s FROM transfers WHERE session_id LIKE 'sess-%'").all() as Array<{ s: string }>;
    if (databases.length === 0 && logs.length === 0 && transfers.length === 0) return;
    const run = db.transaction(() => {
      const setDb = db.prepare("UPDATE databases SET owner_id = ?, wrapped_key = ? WHERE id = ?");
      for (const row of databases) {
        const aad = `m5cet:db:${row.id}`;
        const key = row.wrapped_key ? unwrapKey(Buffer.from(row.wrapped_key), aad) : null;
        setDb.run(sessionRef(row.owner_id), key ? wrapKey(key, aad) : row.wrapped_key, row.id);
        key?.fill(0);
      }
      const setLog = db.prepare("UPDATE logs SET session_id = ? WHERE session_id = ?");
      for (const { s } of logs) setLog.run(sessionRef(s), s);
      const setTransfer = db.prepare("UPDATE OR REPLACE transfers SET session_id = ?, owner = ? WHERE session_id = ?");
      for (const { s } of transfers) {
        const ref = sessionRef(s);
        setTransfer.run(ref, `s:${ref}`, s);
      }
    });
    run();
    // Once: rebuild the file and fold the log back into it, so the ids that
    // were just replaced do not linger in old pages.
    try {
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      console.warn(`[storage] could not compact the global database after rewriting session ids (${(err as Error).message}).`);
    }
  }

  /* ------------------------------------------------------------- users */

  upsertUser(user: { id: string; userName: string; createdAt?: number }): void {
    const now = Date.now();
    this.sql(`
      INSERT INTO users (id, user_name, created_at, last_login_at, login_count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET user_name = excluded.user_name
    `).run(user.id, user.userName.slice(0, 64), user.createdAt ?? now, 0);
  }

  getUser(accountId: string): UserRow | null {
    const row = this.sql("SELECT * FROM users WHERE id = ?").get(accountId) as Record<string, unknown> | undefined;
    return row ? toUser(row) : null;
  }

  listUsers(limit = 200): UserRow[] {
    return (this.sql("SELECT * FROM users ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(1000, limit))) as Array<Record<string, unknown>>).map(toUser);
  }

  recordLogin(accountId: string, at = Date.now()): void {
    this.sql("UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?").run(at, accountId);
  }

  deleteUser(accountId: string): void {
    this.sql("DELETE FROM passkeys WHERE account_id = ?").run(accountId);
    this.sql("DELETE FROM users WHERE id = ?").run(accountId);
  }

  /* ---------------------------------------------------------- passkeys */

  addPasskey(entry: { credentialId: string; accountId: string; publicKey: JsonWebKey; alg: number; signCount: number; label?: string; transports?: string[] }): void {
    const now = Date.now();
    this.sql(`
      INSERT INTO passkeys (credential_id, account_id, public_key, alg, sign_count, transports, label, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(credential_id) DO UPDATE SET
        public_key = excluded.public_key, alg = excluded.alg, sign_count = excluded.sign_count
    `).run(
      entry.credentialId, entry.accountId, JSON.stringify(entry.publicKey), entry.alg, entry.signCount,
      (entry.transports ?? []).join(",").slice(0, 120), (entry.label ?? "").slice(0, 64), now,
    );
  }

  getPasskey(credentialId: string): PasskeyRow | null {
    const row = this.sql("SELECT * FROM passkeys WHERE credential_id = ?").get(credentialId) as Record<string, unknown> | undefined;
    return row ? toPasskey(row) : null;
  }

  listPasskeys(accountId: string): PasskeyRow[] {
    return (this.sql("SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at").all(accountId) as Array<Record<string, unknown>>).map(toPasskey);
  }

  updateSignCount(credentialId: string, signCount: number, at = Date.now()): void {
    this.sql("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?").run(signCount, at, credentialId);
  }

  removePasskey(credentialId: string): boolean {
    return this.sql("DELETE FROM passkeys WHERE credential_id = ?").run(credentialId).changes > 0;
  }

  /* --------------------------------------------------- database index */

  /** Registers a database for an owner, or returns the one already there.
   *  With `key`, the key is wrapped for the new row in the same insert. A
   *  session owner may be given as its id or its reference. */
  registerDatabase(entry: {
    ownerKind: OwnerKind;
    ownerId: string;
    keyMode: KeyMode;
    wrappedKey?: Buffer | null;
    key?: Buffer;
    expiresAt?: number;
  }): DatabaseRow {
    const ownerId = entry.ownerKind === "session" ? toSessionRef(entry.ownerId) : entry.ownerId;
    const existing = this.findDatabase(entry.ownerKind, ownerId);
    if (existing) return existing;
    const id = `db-${randomBytes(12).toString("hex")}`;
    const now = Date.now();
    const wrapped = entry.key ? wrapKey(entry.key, `m5cet:db:${id}`) : entry.wrappedKey ?? null;
    this.sql(`
      INSERT INTO databases (id, owner_kind, owner_id, key_mode, wrapped_key, file_name, schema_version, created_at, last_opened_at, expires_at, bytes, status)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, 'active')
    `).run(id, entry.ownerKind, ownerId, entry.keyMode, wrapped, `${id}.db`, now, entry.expiresAt ?? 0);
    return this.getDatabase(id)!;
  }

  findDatabase(ownerKind: OwnerKind, ownerId: string): DatabaseRow | null {
    const owner = ownerKind === "session" ? toSessionRef(ownerId) : ownerId;
    const row = this.sql("SELECT * FROM databases WHERE owner_kind = ? AND owner_id = ?").get(ownerKind, owner) as Record<string, unknown> | undefined;
    return row ? toDatabase(row) : null;
  }

  getDatabase(id: string): DatabaseRow | null {
    const row = this.sql("SELECT * FROM databases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toDatabase(row) : null;
  }

  /** The key of a `wrapped` database, unwrapped with the wrapping subkey. */
  databaseKey(id: string): Buffer | null {
    const row = this.sql("SELECT wrapped_key FROM databases WHERE id = ?").get(id) as { wrapped_key?: Buffer | Uint8Array | null } | undefined;
    if (!row?.wrapped_key) return null;
    return unwrapKey(Buffer.from(row.wrapped_key), `m5cet:db:${id}`);
  }

  setDatabaseKey(id: string, key: Buffer): void {
    this.sql("UPDATE databases SET wrapped_key = ?, key_mode = 'wrapped' WHERE id = ?").run(wrapKey(key, `m5cet:db:${id}`), id);
  }

  /** The key check value of a database (keys.ts keyCheckValue), if known. */
  databaseKeyCheck(id: string): Buffer | null {
    const row = this.sql("SELECT key_check FROM databases WHERE id = ?").get(id) as { key_check?: Buffer | Uint8Array | null } | undefined;
    return row?.key_check ? Buffer.from(row.key_check) : null;
  }

  setDatabaseKeyCheck(id: string, check: Buffer): void {
    this.sql("UPDATE databases SET key_check = ? WHERE id = ? AND key_check IS NULL").run(check, id);
  }

  /** The file exists and is migrated: from now on it must be there. */
  markDatabaseCreated(id: string, schemaVersion: number): void {
    this.sql("UPDATE databases SET schema_version = ? WHERE id = ? AND schema_version < ?").run(schemaVersion, id, schemaVersion);
  }

  /** Marks a database as opened and refreshes its size (and TTL window).
   *  Costs a stat and a write: the service calls it at most once a minute
   *  per database. */
  touchDatabase(id: string, opts: { expiresAt?: number } = {}): void {
    const row = this.getDatabase(id);
    if (!row) return;
    const bytes = databaseBytes(this.databasePath(row));
    this.sql("UPDATE databases SET last_opened_at = ?, bytes = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?")
      .run(Date.now(), bytes, opts.expiresAt ?? null, id);
  }

  listDatabases(limit = 200): DatabaseRow[] {
    return (this.sql("SELECT * FROM databases ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(1000, limit))) as Array<Record<string, unknown>>).map(toDatabase);
  }

  /** Bytes of the session databases that have not expired (6.7, S7: the shared budget). */
  liveSessionBytes(now = Date.now()): number {
    return Number((this.sql("SELECT COALESCE(sum(bytes), 0) AS n FROM databases WHERE owner_kind = 'session' AND (expires_at = 0 OR expires_at > ?)").get(now) as { n?: number } | undefined)?.n ?? 0);
  }

  /** Session databases that have not expired (the global cap counts these). */
  countLiveSessions(now = Date.now()): number {
    return Number((this.sql("SELECT count(*) AS n FROM databases WHERE owner_kind = 'session' AND (expires_at = 0 OR expires_at > ?)").get(now) as { n?: number } | undefined)?.n ?? 0);
  }

  /** Databases past their expiry (session ones only — accounts never
   *  expire), and sessions older than `maxSessionAgeMs`, whatever their
   *  expiry says. */
  expiredDatabases(now = Date.now(), maxSessionAgeMs?: number): DatabaseRow[] {
    const byAge = maxSessionAgeMs ? now - maxSessionAgeMs : 0;
    return (this.sql("SELECT * FROM databases WHERE (expires_at > 0 AND expires_at < ?) OR (owner_kind = 'session' AND created_at < ?)").all(now, byAge) as Array<Record<string, unknown>>).map(toDatabase);
  }

  databasePath(row: DatabaseRow | { fileName: string }): string {
    return join(this.dir, "db", row.fileName);
  }

  /** Forgets a database: the index row goes first (in a transaction), then
   *  the file. A crash in between leaves an orphan file, which the orphan
   *  sweep removes — never an index row pointing at nothing it expects. */
  dropDatabase(id: string): boolean {
    const row = this.getDatabase(id);
    if (!row) return false;
    const run = this.handle().transaction(() => this.sql("DELETE FROM databases WHERE id = ?").run(id).changes);
    if (run() === 0) return false;
    const path = this.databasePath(row);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { rmSync(`${path}${suffix}`, { force: true }); } catch { /* the orphan sweep will try again */ }
    }
    return true;
  }

  /** Files in db/ that no index row knows, older than `minAgeMs`: left
   *  behind by a crash between dropping a row and deleting its file. */
  sweepOrphans(now = Date.now(), minAgeMs = 60 * 60 * 1000): number {
    const dbDir = join(this.dir, "db");
    let names: string[];
    try { names = readdirSync(dbDir); } catch { return 0; }
    const known = new Set((this.sql("SELECT file_name FROM databases").all() as Array<{ file_name: string }>).map((r) => r.file_name));
    let removed = 0;
    for (const name of names) {
      const match = DB_FILE.exec(name);
      if (!match || known.has(match[1])) continue;
      const path = join(dbDir, name);
      try {
        if (now - statSync(path).mtimeMs < minAgeMs) continue;
        rmSync(path, { force: true });
        removed += 1;
      } catch { /* gone already */ }
    }
    return removed;
  }

  /* --------------------------------------------------------------- logs */

  log(entry: LogEntry): void {
    const at = Math.floor(entry.at || Date.now());
    const event = String(entry.event).slice(0, 120);
    const accountId = entry.accountId ?? null;
    const sref = entry.sessionId ? toSessionRef(entry.sessionId) : null;
    const detail = entry.detail === undefined ? null : sealValue(capJson(entry.detail, DETAIL_MAX), logAad(at, entry.source, event, accountId, sref));
    this.sql(`
      INSERT INTO logs (at, level, source, event, account_id, session_id, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(at, entry.level, entry.source, event, accountId, sref, detail);
  }

  /** Newest first. `detail` comes back decrypted (null for details sealed
   *  before the row-bound scheme). */
  readLogs(filter: { level?: LogLevel; accountId?: string; sessionId?: string; since?: number; limit?: number } = {}): Array<LogEntry & { id: number }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.level) { clauses.push("level = ?"); params.push(filter.level); }
    if (filter.accountId) { clauses.push("account_id = ?"); params.push(filter.accountId); }
    if (filter.sessionId) { clauses.push("session_id = ?"); params.push(toSessionRef(filter.sessionId)); }
    if (filter.since) { clauses.push("at >= ?"); params.push(filter.since); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(1000, filter.limit ?? 100)));
    const rows = this.handle().prepare(`SELECT * FROM logs ${where} ORDER BY at DESC, id DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const accountId = (row.account_id as string | null) ?? null;
      const sref = (row.session_id as string | null) ?? null;
      return {
        id: Number(row.id),
        at: Number(row.at),
        level: String(row.level) as LogLevel,
        source: String(row.source) as LogEntry["source"],
        event: String(row.event),
        accountId,
        sessionId: sref,
        detail: parseSealed(row.detail as Buffer | null, logAad(Number(row.at), String(row.source), String(row.event), accountId, sref)),
      };
    });
  }

  /** Keeps the log table bounded by age and by count (the newest `keep`
   *  stay); returns how many rows went. Both cuts use the time index. */
  pruneLogs(cutoff: number, keep = LOG_KEEP): number {
    const byAge = this.sql("DELETE FROM logs WHERE at < ?").run(cutoff).changes;
    const edge = this.sql("SELECT at, id FROM logs ORDER BY at DESC, id DESC LIMIT 1 OFFSET ?").get(Math.max(0, keep)) as { at: number; id: number } | undefined;
    const byCount = edge ? this.sql("DELETE FROM logs WHERE (at, id) <= (?, ?)").run(edge.at, edge.id).changes : 0;
    return byAge + byCount;
  }

  /* ---------------------------------------------------------- transfers */

  /**
   * One row per (owner, transfer id): a later record from the same owner
   * updates it, a record from anybody else can neither claim nor overwrite
   * it. Returns whether a row was written.
   */
  recordTransfer(record: TransferRecord): boolean {
    const id = String(record.id).slice(0, 80);
    const accountId = record.accountId ?? null;
    const sref = record.sessionId ? toSessionRef(record.sessionId) : null;
    const owner = ownerTag(accountId, sref);
    const detail = record.detail === undefined ? null : sealValue(capJson(record.detail, DETAIL_MAX), transferAad(owner, id));
    return this.sql(`
      INSERT INTO transfers (id, owner, at, finished_at, direction, transport, status, account_id, session_id, room_hash, bytes, chunks, resent_chunks, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner, id) DO UPDATE SET
        finished_at = excluded.finished_at,
        status = excluded.status,
        bytes = excluded.bytes,
        chunks = excluded.chunks,
        resent_chunks = excluded.resent_chunks,
        detail = COALESCE(excluded.detail, transfers.detail)
      WHERE transfers.account_id IS excluded.account_id AND transfers.session_id IS excluded.session_id
    `).run(
      id, owner, Math.floor(record.at || Date.now()), record.finishedAt ?? 0, record.direction, record.transport, record.status,
      accountId, sref, (record.roomHash ?? "").slice(0, 64),
      record.bytes ?? 0, record.chunks ?? 0, record.resentChunks ?? 0, detail,
    ).changes > 0;
  }

  readTransfers(filter: { accountId?: string; sessionId?: string; since?: number; limit?: number } = {}): Array<TransferRecord & { detail: unknown }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.accountId) { clauses.push("account_id = ?"); params.push(filter.accountId); }
    if (filter.sessionId) { clauses.push("session_id = ?"); params.push(toSessionRef(filter.sessionId)); }
    if (filter.since) { clauses.push("at >= ?"); params.push(filter.since); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(500, filter.limit ?? 100)));
    const rows = this.handle().prepare(`SELECT * FROM transfers ${where} ORDER BY at DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      at: Number(row.at),
      finishedAt: Number(row.finished_at),
      direction: String(row.direction) as "in" | "out",
      transport: String(row.transport) as "p2p" | "proxy",
      status: String(row.status) as TransferRecord["status"],
      accountId: (row.account_id as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      roomHash: String(row.room_hash),
      bytes: Number(row.bytes),
      chunks: Number(row.chunks),
      resentChunks: Number(row.resent_chunks),
      detail: parseSealed(row.detail as Buffer | null, transferAad(String(row.owner ?? ""), String(row.id))),
    }));
  }

  /** Keeps the transfer table bounded by age and by count. */
  pruneTransfers(cutoff: number, keep = TRANSFER_KEEP): number {
    const byAge = this.sql("DELETE FROM transfers WHERE at < ?").run(cutoff).changes;
    const edge = this.sql("SELECT at, rowid AS r FROM transfers ORDER BY at DESC, rowid DESC LIMIT 1 OFFSET ?").get(Math.max(0, keep)) as { at: number; r: number } | undefined;
    const byCount = edge ? this.sql("DELETE FROM transfers WHERE (at, rowid) <= (?, ?)").run(edge.at, edge.r).changes : 0;
    return byAge + byCount;
  }

  /** Everything logged about one owner goes (the owner asked to be forgotten). */
  purgeOwner(owner: { accountId?: string; sessionId?: string }): { logs: number; transfers: number } {
    let logs = 0;
    let transfers = 0;
    const run = this.handle().transaction(() => {
      if (owner.accountId) {
        logs += this.sql("DELETE FROM logs WHERE account_id = ?").run(owner.accountId).changes;
        transfers += this.sql("DELETE FROM transfers WHERE account_id = ?").run(owner.accountId).changes;
      }
      if (owner.sessionId) {
        const ref = toSessionRef(owner.sessionId);
        logs += this.sql("DELETE FROM logs WHERE session_id = ?").run(ref).changes;
        transfers += this.sql("DELETE FROM transfers WHERE session_id = ?").run(ref).changes;
      }
    });
    run();
    return { logs, transfers };
  }

  /* -------------------------------------------------------------- audit */

  /** Persists one audit journal entry (its in-memory id is not kept; the
   *  table numbers rows itself). The detail is sealed, bound to the row's
   *  category, event and time. */
  appendAudit(entry: AuditEntry): void {
    const at = Math.floor(Number(entry.at) || Date.now());
    const category = String(entry.category ?? "system").slice(0, 32);
    const event = String(entry.event ?? "").slice(0, 120);
    const level = (AUDIT_LEVELS as readonly string[]).includes(String(entry.level)) ? String(entry.level) : "info";
    const detail = entry.detail === undefined ? null : sealValue(capJson(entry.detail, DETAIL_MAX), auditAad(category, event, at));
    const bytes = typeof entry.bytes === "number" && Number.isFinite(entry.bytes) ? Math.round(entry.bytes) : null;
    const row = {
      at, category, level, event,
      actor: optText(entry.actor, 120), target: optText(entry.target, 120), accountId: optText(entry.accountId, 64),
      sessionRef: entry.sessionId ? toSessionRef(String(entry.sessionId)) : null,
      peerId: optText(entry.peerId, 64), roomHash: optText(entry.roomHash, 64), ip: optText(entry.ip, 64),
      bytes, status: optText(entry.status, 40), detail,
    };
    const prev = this.chainHead();
    const hash = auditRowHash(prev, row);
    const id = Number(this.sql(`
      INSERT INTO audit (at, category, level, event, actor, target, account_id, session_ref, peer_id, room_hash, ip, bytes, status, detail, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.at, row.category, row.level, row.event, row.actor, row.target, row.accountId, row.sessionRef,
      row.peerId, row.roomHash, row.ip, row.bytes, row.status, row.detail, prev, hash,
    ).lastInsertRowid);
    this.head = { id, hash };
    // 6.12 review S01: the cadence counts from the newest checkpoint in the database, not from this
    // process's start — a restart no longer lets up to twice the interval go unsigned.
    if (id - this.lastCheckpointId() >= AUDIT_CHECKPOINT_EVERY) this.auditCheckpoint("interval");
  }

  /* --------------------------------------------------- audit hash chain */

  private head: { id: number; hash: string } | null = null;
  /** The newest checkpoint's row (null until read from the database). */
  private checkpointedId: number | null = null;
  private signingKey: { privateKey: KeyObject; publicKey: string } | null = null;
  private pin: AuditPin | null = null;
  private pinProblem: "pin-invalid" | "pin-missing" | "key-not-pinned" | null = null;

  private lastCheckpointId(): number {
    if (this.checkpointedId === null) {
      const row = this.sql("SELECT max(last_id) AS id FROM audit_checkpoints").get() as { id: number | null } | undefined;
      this.checkpointedId = Number(row?.id ?? 0);
    }
    return this.checkpointedId;
  }

  /** The hash of the newest chained row ("" before the first). */
  private chainHead(): string {
    if (!this.head) {
      const last = this.sql("SELECT id, hash FROM audit WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string } | undefined;
      this.head = last ? { id: Number(last.id), hash: String(last.hash) } : { id: 0, hash: "" };
    }
    return this.head.hash;
  }

  /**
   * 6.12 (F-23): the Ed25519 key that signs checkpoints is derived from the
   * storage master key (keys.ts derivedKey("audit-signing")) — not a file next
   * to the database, and not taken from the checkpoint rows: whoever can
   * rewrite m5cet.db (or the storage directory, when the master key comes from
   * STORAGE_MASTER_KEY) cannot re-sign a forged journal. Before 6.12 it was
   * audit-signing.key (see ensurePin for the upgrade).
   */
  private auditSigner(): { privateKey: KeyObject; publicKey: string } {
    if (this.signingKey) return this.signingKey;
    const seed = derivedKey("audit-signing");
    const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
    this.signingKey = { privateKey, publicKey };
    return this.signingKey;
  }

  private pinFile(): string { return join(this.dir, "audit-signing.pin"); }

  private pinMac(body: Omit<AuditPin, "mac">): string {
    const fields: unknown[] = [body.v, body.keys.map((k) => [k.publicKey, k.upTo]), body.chainFrom, body.pinnedAt];
    if (body.v === 2) fields.push(body.coverFrom ?? null);
    return createHmac("sha256", derivedKey("audit-pin")).update(JSON.stringify(fields)).digest("hex");
  }

  /** A checkpoint row signed by the key derived from the master key (proof that this store was pinned). */
  private signedByDerivedKey(c: Record<string, unknown>): boolean {
    try {
      const key = createPublicKey({ key: Buffer.from(this.auditSigner().publicKey, "base64"), format: "der", type: "spki" });
      return edVerify(null, Buffer.from(checkpointMessage(Number(c.last_id), String(c.head_hash), Number(c.at))), key, Buffer.from(String(c.signature), "base64"));
    } catch { return false; }
  }

  private legacyKeyFile(): string { return join(this.dir, "audit-signing.key"); }

  /** The pre-6.12 audit-signing.key's public key, if the file is there. */
  private legacyPublicKey(): string | null {
    try { return createPublicKey(createPrivateKey(readFileSync(this.legacyKeyFile(), "utf8"))).export({ type: "spki", format: "der" }).toString("base64"); } catch { return null; }
  }

  private chainBounds(): { chainFrom: number; head: number } {
    const first = this.sql("SELECT min(id) AS id FROM audit WHERE hash IS NOT NULL").get() as { id: number | null } | undefined;
    const max = this.sql("SELECT max(id) AS id FROM audit").get() as { id: number | null } | undefined;
    const head = Number(max?.id ?? 0);
    return { chainFrom: first?.id ? Number(first.id) : head + 1, head };
  }

  private writePin(body: Omit<AuditPin, "mac">, replace: boolean): AuditPin {
    const pin: AuditPin = { ...body, mac: this.pinMac(body) };
    const file = this.pinFile();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!replace) {
      writeFileSync(file, JSON.stringify(pin, null, 1), { mode: 0o600, flag: "wx" });
    } else {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(pin, null, 1), { mode: 0o600 });
      renameSync(tmp, file);
    }
    return pin;
  }

  /**
   * 6.12 (F-23): what verifyAudit trusts besides the derived key, in
   * audit-signing.pin next to the database, MACed with a subkey of the master
   * key (a file anyone could edit would pin nothing):
   *
   *   keys       the checkpoint keys of before 6.12 — the old
   *              audit-signing.key's public key — each only for checkpoints
   *              up to the row it had signed (upTo);
   *   chainFrom  the first row id that must be chained: a row from there on
   *              without a hash is a failure, not "before the chain";
   *   coverFrom  (v2) from this row on, the newest valid checkpoint may lag
   *              the head by at most AUDIT_UNSIGNED_TAIL_MAX rows.
   *
   * Written on the first start after the upgrade (logged); the old private
   * key file is then removed, so it cannot sign anything new.
   *
   * 6.12 review S01 — deleting the file no longer re-pins:
   *   - once the store has signed a checkpoint with the derived key (every
   *     store does from its first 500 rows, or a manual/prune checkpoint), a
   *     missing pin is a verification failure ("pin-missing"), never
   *     re-created from what the database or the directory holds;
   *   - the first start with 6.12 (no pin, nothing signed with the derived
   *     key) is the one-time migration: the journal is trusted as it is
   *     (logged) — with the 6.11 key file there, its key and the keys whose
   *     checkpoints sign themselves are pinned; without it, keys a checkpoint
   *     row names are never pinned (a forger signs rows with a key of their
   *     own), and such unverifiable checkpoints make the whole chain count;
   *   - from coverFrom on, every AUDIT_UNSIGNED_TAIL_MAX chained rows need a
   *     valid checkpoint (verifyAudit, "checkpoint-missing"): checkpoints
   *     deleted and the head signed again later leave a gap;
   *   - re-pinning the journal as it is now is an explicit operator action
   *     (repinAudit: POST /api/admin/audit/repin, owner role, audited).
   * What stays possible: removing the pin AND every checkpoint makes the
   * journal look never pinned — it is then trusted as it is again (logged).
   */
  private ensurePin(): void {
    if (this.pin || this.pinProblem === "pin-invalid" || this.pinProblem === "pin-missing") return;
    const file = this.pinFile();
    let raw: string | null = null;
    try { raw = readFileSync(file, "utf8"); } catch { raw = null; }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as AuditPin;
        const ok = parsed && (parsed.v === 1 || (parsed.v === 2 && Number.isInteger(parsed.coverFrom))) && Array.isArray(parsed.keys) && Number.isInteger(parsed.chainFrom)
          && typeof parsed.mac === "string" && safeEqualHex(parsed.mac, this.pinMac(parsed));
        if (ok) { this.pin = parsed; this.pinProblem = null; return; }
      } catch { /* unreadable */ }
      this.pinProblem = "pin-invalid";
      console.warn(`[storage] ${file} does not verify against the storage master key: the audit journal's old checkpoint keys are NOT trusted (restore the file, or re-pin the journal from the console: Audit → Verify → Re-pin)`);
      return;
    }
    // A store that already signed with the derived key was pinned: the file was removed behind its back.
    const rows = this.sql("SELECT last_id, head_hash, at, signature, public_key FROM audit_checkpoints ORDER BY last_id ASC").all() as Array<Record<string, unknown>>;
    if (rows.some((c) => this.signedByDerivedKey(c))) {
      this.pinProblem = "pin-missing";
      console.warn(`[storage] ${file} is missing although this journal was pinned (it holds checkpoints signed with the derived key): the audit journal does NOT verify until the file is restored or the operator re-pins it (console: Audit → Verify → Re-pin)`);
      return;
    }
    // The first start with 6.12 (the one-time migration — trust on first use, logged): the journal is
    // taken as it is. With the 6.11 key file there (the upgrade), its key and any other key whose
    // checkpoints sign themselves (a key file 6.11 regenerated) are pinned, each for the checkpoints up to
    // the newest it signed; without the key file, keys rows name are never pinned (a forger's).
    const legacyPub = this.legacyPublicKey();
    const derived = this.auditSigner().publicKey;
    const upTo = new Map<string, number>();
    if (legacyPub) {
      for (const c of rows) {
        const key = String(c.public_key);
        if (key === derived || !selfSigned(c)) continue;
        upTo.set(key, Math.max(upTo.get(key) ?? 0, Number(c.last_id)));
      }
      if (legacyPub !== derived && !upTo.has(legacyPub)) upTo.set(legacyPub, 0);
    }
    const keys: AuditPin["keys"] = [...upTo].map(([publicKey, n]) => ({ publicKey, upTo: n }));
    const { chainFrom, head } = this.chainBounds();
    // Coverage starts after the rows that exist now — what 6.11 wrote (with its own, restartable cadence)
    // is not held to the 6.12 cadence. Only checkpoints that cannot be verified without the old key file
    // (it was removed behind the journal's back) make the whole chain count.
    const coverFrom = legacyPub || rows.length === 0 ? head + 1 : chainFrom;
    let pin: AuditPin;
    try {
      pin = this.writePin({ v: 2, keys, chainFrom, pinnedAt: Date.now(), coverFrom }, false);
    } catch (err) {
      this.pinProblem = "key-not-pinned";
      console.warn(`[storage] could not write ${file} (${(err as Error).message}): the audit journal's checkpoint keys are not pinned`);
      return;
    }
    this.pin = pin;
    this.pinProblem = null;
    console.log(`[storage] audit journal: checkpoints are signed with a key derived from the master key from now on; pinned ${keys.length} earlier key(s) and chained rows from #${chainFrom} in ${file}`);
    if (head > 0) console.warn(`[storage] audit journal: its first start with 6.12 trusted the ${head} row(s) already there as they are (trust on first use); from row #${coverFrom} on, a checkpoint is required every ${AUDIT_CHECKPOINT_EVERY} rows`);
    if (legacyPub) {
      try { rmSync(this.legacyKeyFile(), { force: true }); console.log(`[storage] removed ${this.legacyKeyFile()}: the pre-6.12 key signs nothing any more (its public key stays pinned)`); }
      catch { /* not ours to remove */ }
    }
  }

  /**
   * 6.12 review S01: the operator's explicit re-pin (POST /api/admin/audit/repin,
   * owner role, audited by the caller) — after a lost or damaged
   * audit-signing.pin, or a journal whose checkpoints are gone. Vouches for the
   * journal AS IT IS NOW: keeps the keys of a pin that still verifies, adds the
   * pre-6.12 key file's key if it is there, and — only with `trustRowKeys` —
   * every other key whose checkpoints sign themselves (pre-6.12 checkpoints of
   * a key file that was lost); coverage restarts at the head, which is signed
   * at once with the derived key. Returns what it pinned.
   */
  repinAudit(opts: { trustRowKeys?: boolean } = {}): { keys: number; chainFrom: number; coverFrom: number; checkpoint: number | null } {
    this.handle();
    let current: AuditPin | null = null;
    try {
      const parsed = JSON.parse(readFileSync(this.pinFile(), "utf8")) as AuditPin;
      if (parsed && Array.isArray(parsed.keys) && typeof parsed.mac === "string" && safeEqualHex(parsed.mac, this.pinMac(parsed))) current = parsed;
    } catch { current = null; }
    const upTo = new Map<string, number | null>();
    for (const k of current?.keys ?? []) upTo.set(k.publicKey, k.upTo);
    const rows = this.sql("SELECT last_id, head_hash, at, signature, public_key FROM audit_checkpoints ORDER BY last_id ASC").all() as Array<Record<string, unknown>>;
    const derived = this.auditSigner().publicKey;
    const legacyPub = this.legacyPublicKey();
    for (const c of rows) {
      const key = String(c.public_key);
      if (key === derived || !selfSigned(c)) continue;
      if (key !== legacyPub && !opts.trustRowKeys && !upTo.has(key)) continue;
      const known = upTo.get(key);
      if (known !== null) upTo.set(key, Math.max(known ?? 0, Number(c.last_id)));
    }
    if (legacyPub && legacyPub !== derived && !upTo.has(legacyPub)) upTo.set(legacyPub, 0);
    const keys = [...upTo].map(([publicKey, n]) => ({ publicKey, upTo: n }));
    const { chainFrom, head } = this.chainBounds();
    const pin = this.writePin({ v: 2, keys, chainFrom: current?.chainFrom ?? chainFrom, pinnedAt: Date.now(), coverFrom: head + 1 }, true);
    this.pin = pin;
    this.pinProblem = null;
    if (legacyPub) { try { rmSync(this.legacyKeyFile(), { force: true }); } catch { /* not ours to remove */ } }
    const checkpoint = this.auditCheckpoint("repin");
    console.warn(`[storage] the audit journal was re-pinned by the operator: ${keys.length} earlier key(s), coverage from row #${head + 1}`);
    return { keys: keys.length, chainFrom: pin.chainFrom, coverFrom: head + 1, checkpoint: checkpoint?.lastId ?? null };
  }

  /** Signs the current head of the chain. Called every N rows, before
   *  rows are pruned, and on demand. */
  auditCheckpoint(reason: string, at = Date.now()): { lastId: number; headHash: string } | null {
    this.chainHead();
    if (!this.head || this.head.id === 0) return null;
    this.ensurePin();
    const signer = this.auditSigner();
    const message = checkpointMessage(this.head.id, this.head.hash, at);
    const signature = edSign(null, Buffer.from(message), signer.privateKey).toString("base64");
    this.sql("INSERT INTO audit_checkpoints (at, last_id, head_hash, reason, signature, public_key) VALUES (?, ?, ?, ?, ?, ?)")
      .run(at, this.head.id, this.head.hash, reason.slice(0, 40), signature, signer.publicKey);
    this.checkpointedId = Math.max(this.checkpointedId ?? 0, this.head.id);
    return { lastId: this.head.id, headHash: this.head.hash };
  }

  /**
   * Walks the chain and the checkpoints. A row whose hash does not match
   * its contents, a broken link to the row before, a missing row inside the
   * chain (or at its end, behind a checkpoint), a row without a hash where
   * the chain runs (6.12), or a checkpoint whose signature does not hold
   * under a pinned key — each is reported with the first id where it
   * happens. The key a checkpoint row names is not trusted (6.12, F-23).
   */
  verifyAudit(): AuditVerification {
    this.ensurePin();
    const signer = this.auditSigner();
    const chainFrom = this.pin?.chainFrom ?? Number.POSITIVE_INFINITY;
    const rows = this.sql("SELECT * FROM audit ORDER BY id ASC").iterate() as Iterable<Record<string, unknown>>;
    const checkpoints = this.sql("SELECT * FROM audit_checkpoints ORDER BY last_id ASC").all() as Array<Record<string, unknown>>;
    const byLast = new Map(checkpoints.map((c) => [Number(c.last_id), c]));
    const problems: AuditVerification["problems"] = [];
    if (this.pinProblem) problems.push({ id: 0, kind: this.pinProblem });
    let checked = 0;
    let unchained = 0;
    let prevHash: string | null = null;
    let prevId = 0;
    let first = true;
    let firstChained = 0;
    let lastChained = 0;
    const hashes = new Map<number, string>();
    for (const r of rows) {
      const id = Number(r.id);
      if (r.hash === null || r.hash === undefined) {
        // Before the chain (3.0) is history; inside it, a row stripped of its hash.
        if (id >= chainFrom || !first) problems.push({ id, kind: "row-unchained" });
        else unchained += 1;
        continue;
      }
      const row = {
        at: Number(r.at), category: String(r.category), level: String(r.level), event: String(r.event),
        actor: r.actor as string | null, target: r.target as string | null, accountId: r.account_id as string | null,
        sessionRef: r.session_ref as string | null, peerId: r.peer_id as string | null, roomHash: r.room_hash as string | null,
        ip: r.ip as string | null, bytes: r.bytes === null ? null : Number(r.bytes), status: r.status as string | null,
        detail: (r.detail ?? null) as Buffer | null,
      };
      const expected = auditRowHash(String(r.prev_hash ?? ""), row);
      if (expected !== r.hash) problems.push({ id, kind: "row-altered" });
      if (first) {
        // The oldest kept row: its predecessor was pruned — a checkpoint
        // signed before pruning must vouch for the link.
        const anchor = byLast.get(id - 1);
        if (r.prev_hash && anchor && anchor.head_hash !== r.prev_hash) problems.push({ id, kind: "link-broken" });
        first = false;
        firstChained = id;
      } else {
        if (id !== prevId + 1) problems.push({ id, kind: "rows-missing" });
        if (r.prev_hash !== prevHash) problems.push({ id, kind: "link-broken" });
      }
      hashes.set(id, String(r.hash));
      prevHash = String(r.hash);
      prevId = id;
      lastChained = id;
      checked += 1;
    }
    const trusted = (lastId: number) => [
      signer.publicKey,
      ...(this.pin?.keys ?? []).filter((k) => k.upTo === null || lastId <= k.upTo).map((k) => k.publicKey),
    ];
    let signed = 0;
    /** Rows valid checkpoints vouch for (review S01). */
    const anchors: number[] = [];
    for (const c of checkpoints) {
      const lastId = Number(c.last_id);
      const message = Buffer.from(checkpointMessage(lastId, String(c.head_hash), Number(c.at)));
      const signature = Buffer.from(String(c.signature), "base64");
      const ok = trusted(lastId).some((pub) => {
        try { return edVerify(null, message, createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" }), signature); }
        catch { return false; }
      });
      if (!ok) problems.push({ id: lastId, kind: "checkpoint-signature" });
      const rowHash = hashes.get(lastId);
      if (rowHash !== undefined && rowHash !== c.head_hash) problems.push({ id: lastId, kind: "checkpoint-mismatch" });
      if (ok) signed += 1;
      if (ok && (rowHash === undefined || rowHash === c.head_hash) && lastId <= lastChained) anchors.push(lastId);
    }
    const last = checkpoints.at(-1);
    // Rows cut off the end: a checkpoint vouches for a row newer than the newest one left.
    if (last && lastChained > 0 && Number(last.last_id) > lastChained) problems.push({ id: Number(last.last_id), kind: "rows-missing" });
    // 6.12 review S01: a checkpoint is signed every AUDIT_CHECKPOINT_EVERY rows (and every hour, before pruning),
    // so from coverFrom on no run of more than AUDIT_UNSIGNED_TAIL_MAX chained rows goes without a valid one —
    // checkpoints deleted (the head signed again later) leave such a run. A v1 pin (6.12 builds before the
    // review) is held to the tail only.
    if (this.pin && lastChained > 0) {
      anchors.sort((a, b) => a - b);
      const coverFrom = this.pin.v === 2 ? Number(this.pin.coverFrom) : Math.max(this.pin.chainFrom, (anchors.at(-1) ?? 0) + 1);
      let from = Math.max(coverFrom - 1, firstChained - 1);
      if (lastChained > from) {
        let gap: number | null = null;
        for (const a of anchors) {
          if (a <= from) continue;
          if (a - from > AUDIT_UNSIGNED_TAIL_MAX && gap === null) gap = from + 1;
          from = a;
        }
        if (lastChained - from > AUDIT_UNSIGNED_TAIL_MAX && gap === null) gap = from + 1;
        if (gap !== null) problems.push({ id: gap, kind: "checkpoint-missing" });
      }
    }
    return {
      ok: problems.length === 0,
      checked,
      unchained,
      checkpoints: checkpoints.length,
      signedCheckpoints: signed,
      lastCheckpoint: last ? { at: Number(last.at), lastId: Number(last.last_id) } : null,
      publicKey: signer.publicKey,
      pinned: this.pin ? { file: this.pinFile(), at: this.pin.pinnedAt, earlierKeys: this.pin.keys.length, chainFrom: this.pin.chainFrom, coverFrom: this.pin.v === 2 ? Number(this.pin.coverFrom) : this.pin.chainFrom } : null,
      problems: problems.slice(0, 50),
    };
  }

  /** Newest first. `search` matches event, actor, target, status and ip;
   *  `event` is a prefix; `minLevel` follows debug < info < notice < warn
   *  < error. */
  readAudit(filter: AuditFilter = {}): AuditEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.category) { clauses.push("category = ?"); params.push(filter.category); }
    const rank = filter.minLevel ? (AUDIT_LEVELS as readonly string[]).indexOf(filter.minLevel) : -1;
    if (rank > 0) {
      const levels = AUDIT_LEVELS.slice(rank);
      clauses.push(`level IN (${levels.map(() => "?").join(", ")})`);
      params.push(...levels);
    }
    if (filter.actor) { clauses.push("actor = ?"); params.push(filter.actor); }
    if (filter.accountId) { clauses.push("(account_id = ? OR actor = ? OR target = ?)"); params.push(filter.accountId, filter.accountId, filter.accountId); }
    if (filter.peerId) { clauses.push("(peer_id = ? OR actor = ? OR target = ?)"); params.push(filter.peerId, filter.peerId, filter.peerId); }
    if (filter.event) { clauses.push("event LIKE ? ESCAPE '\\'"); params.push(`${escapeLike(filter.event)}%`); }
    if (filter.search) {
      const needle = `%${escapeLike(filter.search)}%`;
      clauses.push("(event LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR status LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')");
      params.push(needle, needle, needle, needle, needle);
    }
    if (filter.since) { clauses.push("at >= ?"); params.push(filter.since); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(2_000, Math.floor(Number(filter.limit) || 200))));
    const rows = this.handle().prepare(`SELECT * FROM audit ${where} ORDER BY at DESC, id DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
    return rows.map(toAudit);
  }

  /** Keeps the audit table bounded by age and by count. */
  pruneAudit(cutoff: number, keep = AUDIT_KEEP): number {
    // Sign the head first: the link from the pruned rows to the kept ones
    // stays verifiable.
    this.auditCheckpoint("prune");
    const byAge = this.sql("DELETE FROM audit WHERE at < ?").run(cutoff).changes;
    const edge = this.sql("SELECT at, id FROM audit ORDER BY at DESC, id DESC LIMIT 1 OFFSET ?").get(Math.max(0, keep)) as { at: number; id: number } | undefined;
    const byCount = edge ? this.sql("DELETE FROM audit WHERE (at, id) <= (?, ?)").run(edge.at, edge.id).changes : 0;
    return byAge + byCount;
  }

  /* --------------------------------------------------------------- misc */

  stats(): { users: number; passkeys: number; databases: number; sessions: number; logs: number; transfers: number; bytes: number } {
    const one = (sql: string) => Number((this.sql(sql).get() as { n?: number } | undefined)?.n ?? 0);
    return {
      users: one("SELECT count(*) AS n FROM users"),
      passkeys: one("SELECT count(*) AS n FROM passkeys"),
      databases: one("SELECT count(*) AS n FROM databases"),
      sessions: one("SELECT count(*) AS n FROM databases WHERE owner_kind = 'session'"),
      logs: one("SELECT count(*) AS n FROM logs"),
      transfers: one("SELECT count(*) AS n FROM transfers"),
      bytes: one("SELECT COALESCE(sum(bytes), 0) AS n FROM databases"),
    };
  }

  /** A consistent copy of this database while it stays in use. */
  async backupTo(path: string): Promise<void> {
    const db = this.handle();
    if (typeof db.backup === "function") { await db.backup(path); return; }
    db.prepare("VACUUM INTO ?").run(path);
  }

  quickCheck(): string {
    try { return String(this.handle().pragma("quick_check", { simple: true })); } catch (err) { return (err as Error).message; }
  }

  /** Planner statistics, and space from deleted rows given back (VACUUM). */
  optimize(vacuum = false): { before: number; after: number } {
    const size = () => { try { return statSync(join(this.dir, "m5cet.db")).size; } catch { return 0; } };
    const before = size();
    const db = this.handle();
    db.pragma("optimize");
    if (vacuum) db.exec("VACUUM");
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* busy */ }
    return { before, after: size() };
  }

  /** The file, its pages and every table's row count — for the operator. */
  inspect(): GlobalInspection {
    const db = this.handle();
    const file = join(this.dir, "m5cet.db");
    const size = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
    const pragma = (name: string) => db.pragma(name, { simple: true });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    return {
      file,
      bytes: size(file),
      walBytes: size(`${file}-wal`),
      pageSize: Number(pragma("page_size") ?? 0),
      pageCount: Number(pragma("page_count") ?? 0),
      freelist: Number(pragma("freelist_count") ?? 0),
      journalMode: String(pragma("journal_mode") ?? ""),
      tables: names.map((name) => ({
        name,
        rows: Number((db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n?: number } | undefined)?.n ?? 0),
      })),
    };
  }
}

/* --------------------------------------------------------------- helpers */

function parseSealed(sealed: Buffer | Uint8Array | null, aad: string): unknown {
  const raw = openValue(sealed, aad);
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function toUser(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    userName: String(row.user_name ?? ""),
    createdAt: Number(row.created_at),
    lastLoginAt: Number(row.last_login_at),
    loginCount: Number(row.login_count),
    status: String(row.status ?? "active"),
  };
}

function toPasskey(row: Record<string, unknown>): PasskeyRow {
  return {
    credentialId: String(row.credential_id),
    accountId: String(row.account_id),
    publicKey: JSON.parse(String(row.public_key)) as JsonWebKey,
    alg: Number(row.alg),
    signCount: Number(row.sign_count),
    label: String(row.label ?? ""),
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
  };
}

function toDatabase(row: Record<string, unknown>): DatabaseRow {
  return {
    id: String(row.id),
    ownerKind: String(row.owner_kind) as OwnerKind,
    ownerId: String(row.owner_id),
    keyMode: String(row.key_mode) as KeyMode,
    fileName: String(row.file_name),
    schemaVersion: Number(row.schema_version ?? 0),
    createdAt: Number(row.created_at),
    lastOpenedAt: Number(row.last_opened_at),
    expiresAt: Number(row.expires_at),
    bytes: Number(row.bytes),
    status: String(row.status ?? "active"),
  };
}

function toAudit(row: Record<string, unknown>): AuditEntry {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const at = Number(row.at);
  const category = String(row.category);
  const event = String(row.event);
  const detail = row.detail ? parseSealed(row.detail as Buffer, auditAad(category, event, at)) : undefined;
  const entry: AuditEntry = {
    id: Number(row.id),
    at,
    category: category as AuditEntry["category"],
    level: String(row.level) as AuditEntry["level"],
    event,
  };
  const optional: Partial<AuditEntry> = {
    actor: text(row.actor),
    target: text(row.target),
    accountId: text(row.account_id),
    sessionId: text(row.session_ref),
    peerId: text(row.peer_id),
    roomHash: text(row.room_hash),
    ip: text(row.ip),
    bytes: row.bytes === null || row.bytes === undefined ? undefined : Number(row.bytes),
    status: text(row.status),
    detail: detail === null ? undefined : detail,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (entry as Record<string, unknown>)[key] = value;
  }
  return entry;
}

export { StorageUnavailableError };
