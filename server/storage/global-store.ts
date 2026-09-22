// The global database: what the server itself has to know.
//
//   users / passkeys   who is registered and which public keys belong to
//                      them (public material only — no secret ever lands
//                      here, and the vault key least of all)
//   databases          the index of every encrypted database: who owns it,
//                      how it is keyed, when it expires, how big it is
//   logs               server and client log / debug lines, payload sealed
//   transfers          one detailed row per file transfer, payload sealed
//
// Everything that could describe a conversation is sealed with the master
// key before it is written (keys.ts), so this file holds counts, timestamps
// and opaque ids rather than content.

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { databaseBytes, openPlainDatabase, StorageUnavailableError, type SqliteDatabase } from "./db";
import { GLOBAL_MIGRATIONS } from "./schema";
import { openValue, sealValue, storageDir, unwrapKey, wrapKey, type KeyMode } from "./keys";

export type OwnerKind = "account" | "session";

export type DatabaseRow = {
  id: string;
  ownerKind: OwnerKind;
  ownerId: string;
  keyMode: KeyMode;
  fileName: string;
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

const LOG_KEEP = 50_000;

export class GlobalStore {
  private db: SqliteDatabase | null = null;

  constructor(private readonly dir: string = storageDir()) {}

  /** Opens (and migrates) the global database. Throws when the driver is
   *  missing — callers treat that as "storage is off". */
  open(): SqliteDatabase {
    if (this.db?.open) return this.db;
    this.db = openPlainDatabase(join(this.dir, "m5cet.db"), GLOBAL_MIGRATIONS);
    return this.db;
  }

  get isOpen(): boolean {
    return Boolean(this.db?.open);
  }

  close(): void {
    try { this.db?.close(); } catch { /* already gone */ }
    this.db = null;
  }

  private handle(): SqliteDatabase {
    if (!this.db?.open) return this.open();
    return this.db;
  }

  /* ------------------------------------------------------------- users */

  upsertUser(user: { id: string; userName: string; createdAt?: number }): void {
    const now = Date.now();
    this.handle().prepare(`
      INSERT INTO users (id, user_name, created_at, last_login_at, login_count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET user_name = excluded.user_name
    `).run(user.id, user.userName.slice(0, 64), user.createdAt ?? now, 0);
  }

  getUser(accountId: string): UserRow | null {
    const row = this.handle().prepare("SELECT * FROM users WHERE id = ?").get(accountId) as Record<string, unknown> | undefined;
    return row ? toUser(row) : null;
  }

  listUsers(limit = 200): UserRow[] {
    return (this.handle().prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(1000, limit))) as Array<Record<string, unknown>>).map(toUser);
  }

  recordLogin(accountId: string, at = Date.now()): void {
    this.handle().prepare("UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?").run(at, accountId);
  }

  deleteUser(accountId: string): void {
    const db = this.handle();
    db.prepare("DELETE FROM passkeys WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM users WHERE id = ?").run(accountId);
  }

  /* ---------------------------------------------------------- passkeys */

  addPasskey(entry: { credentialId: string; accountId: string; publicKey: JsonWebKey; alg: number; signCount: number; label?: string; transports?: string[] }): void {
    const now = Date.now();
    this.handle().prepare(`
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
    const row = this.handle().prepare("SELECT * FROM passkeys WHERE credential_id = ?").get(credentialId) as Record<string, unknown> | undefined;
    return row ? toPasskey(row) : null;
  }

  listPasskeys(accountId: string): PasskeyRow[] {
    return (this.handle().prepare("SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at").all(accountId) as Array<Record<string, unknown>>).map(toPasskey);
  }

  updateSignCount(credentialId: string, signCount: number, at = Date.now()): void {
    this.handle().prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?").run(signCount, at, credentialId);
  }

  removePasskey(credentialId: string): boolean {
    return this.handle().prepare("DELETE FROM passkeys WHERE credential_id = ?").run(credentialId).changes > 0;
  }

  /* --------------------------------------------------- database index */

  /** Registers a database for an owner, or returns the one already there. */
  registerDatabase(entry: {
    ownerKind: OwnerKind;
    ownerId: string;
    keyMode: KeyMode;
    wrappedKey?: Buffer | null;
    expiresAt?: number;
  }): DatabaseRow {
    const existing = this.findDatabase(entry.ownerKind, entry.ownerId);
    if (existing) return existing;
    const id = `db-${randomBytes(12).toString("hex")}`;
    const now = Date.now();
    this.handle().prepare(`
      INSERT INTO databases (id, owner_kind, owner_id, key_mode, wrapped_key, file_name, schema_version, created_at, last_opened_at, expires_at, bytes, status)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, 'active')
    `).run(id, entry.ownerKind, entry.ownerId, entry.keyMode, entry.wrappedKey ?? null, `${id}.db`, now, entry.expiresAt ?? 0);
    return this.findDatabase(entry.ownerKind, entry.ownerId)!;
  }

  findDatabase(ownerKind: OwnerKind, ownerId: string): DatabaseRow | null {
    const row = this.handle().prepare("SELECT * FROM databases WHERE owner_kind = ? AND owner_id = ?").get(ownerKind, ownerId) as Record<string, unknown> | undefined;
    return row ? toDatabase(row) : null;
  }

  getDatabase(id: string): DatabaseRow | null {
    const row = this.handle().prepare("SELECT * FROM databases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toDatabase(row) : null;
  }

  /** The key of a `wrapped` database, unwrapped with the master key. */
  databaseKey(id: string): Buffer | null {
    const row = this.handle().prepare("SELECT wrapped_key FROM databases WHERE id = ?").get(id) as { wrapped_key?: Buffer | Uint8Array | null } | undefined;
    if (!row?.wrapped_key) return null;
    return unwrapKey(Buffer.from(row.wrapped_key), `m5cet:db:${id}`);
  }

  setDatabaseKey(id: string, key: Buffer): void {
    this.handle().prepare("UPDATE databases SET wrapped_key = ?, key_mode = 'wrapped' WHERE id = ?").run(wrapKey(key, `m5cet:db:${id}`), id);
  }

  /** Marks a database as opened and refreshes its size (and TTL window). */
  touchDatabase(id: string, opts: { expiresAt?: number } = {}): void {
    const row = this.getDatabase(id);
    if (!row) return;
    const bytes = databaseBytes(this.databasePath(row));
    this.handle().prepare("UPDATE databases SET last_opened_at = ?, bytes = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?")
      .run(Date.now(), bytes, opts.expiresAt ?? null, id);
  }

  listDatabases(limit = 200): DatabaseRow[] {
    return (this.handle().prepare("SELECT * FROM databases ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(1000, limit))) as Array<Record<string, unknown>>).map(toDatabase);
  }

  /** Databases past their expiry (session ones only — accounts never expire). */
  expiredDatabases(now = Date.now()): DatabaseRow[] {
    return (this.handle().prepare("SELECT * FROM databases WHERE expires_at > 0 AND expires_at < ?").all(now) as Array<Record<string, unknown>>).map(toDatabase);
  }

  databasePath(row: DatabaseRow | { fileName: string }): string {
    return join(this.dir, "db", row.fileName);
  }

  /** Forgets a database: the index row goes, and so does the file. */
  dropDatabase(id: string): boolean {
    const row = this.getDatabase(id);
    if (!row) return false;
    const path = this.databasePath(row);
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${path}${suffix}`, { force: true }); } catch { /* ignore */ }
    }
    this.handle().prepare("DELETE FROM databases WHERE id = ?").run(id);
    return true;
  }

  /* --------------------------------------------------------------- logs */

  log(entry: LogEntry): void {
    const detail = entry.detail === undefined ? null : sealValue(JSON.stringify(entry.detail).slice(0, 8_000), "m5cet:log");
    this.handle().prepare(`
      INSERT INTO logs (at, level, source, event, account_id, session_id, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entry.at || Date.now(), entry.level, entry.source, entry.event.slice(0, 120), entry.accountId ?? null, entry.sessionId ?? null, detail);
  }

  /** Newest first. `detail` comes back decrypted. */
  readLogs(filter: { level?: LogLevel; accountId?: string; since?: number; limit?: number } = {}): Array<LogEntry & { id: number }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.level) { clauses.push("level = ?"); params.push(filter.level); }
    if (filter.accountId) { clauses.push("account_id = ?"); params.push(filter.accountId); }
    if (filter.since) { clauses.push("at >= ?"); params.push(filter.since); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(1000, filter.limit ?? 100)));
    const rows = this.handle().prepare(`SELECT * FROM logs ${where} ORDER BY at DESC, id DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      level: String(row.level) as LogLevel,
      source: String(row.source) as LogEntry["source"],
      event: String(row.event),
      accountId: (row.account_id as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      detail: parseSealed(row.detail as Buffer | null, "m5cet:log"),
    }));
  }

  /** Keeps the log table bounded; returns how many rows went. */
  pruneLogs(cutoff: number, keep = LOG_KEEP): number {
    const db = this.handle();
    const byAge = db.prepare("DELETE FROM logs WHERE at < ?").run(cutoff).changes;
    const byCount = db.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY at DESC, id DESC LIMIT ?)`).run(keep).changes;
    return byAge + byCount;
  }

  /* ---------------------------------------------------------- transfers */

  recordTransfer(record: TransferRecord): void {
    const detail = record.detail === undefined ? null : sealValue(JSON.stringify(record.detail).slice(0, 8_000), "m5cet:transfer");
    this.handle().prepare(`
      INSERT INTO transfers (id, at, finished_at, direction, transport, status, account_id, session_id, room_hash, bytes, chunks, resent_chunks, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        finished_at = excluded.finished_at,
        status = excluded.status,
        bytes = excluded.bytes,
        chunks = excluded.chunks,
        resent_chunks = excluded.resent_chunks,
        detail = COALESCE(excluded.detail, transfers.detail)
    `).run(
      record.id, record.at || Date.now(), record.finishedAt ?? 0, record.direction, record.transport, record.status,
      record.accountId ?? null, record.sessionId ?? null, (record.roomHash ?? "").slice(0, 64),
      record.bytes ?? 0, record.chunks ?? 0, record.resentChunks ?? 0, detail,
    );
  }

  readTransfers(filter: { accountId?: string; sessionId?: string; since?: number; limit?: number } = {}): Array<TransferRecord & { detail: unknown }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.accountId) { clauses.push("account_id = ?"); params.push(filter.accountId); }
    if (filter.sessionId) { clauses.push("session_id = ?"); params.push(filter.sessionId); }
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
      detail: parseSealed(row.detail as Buffer | null, "m5cet:transfer"),
    }));
  }

  pruneTransfers(cutoff: number): number {
    return this.handle().prepare("DELETE FROM transfers WHERE at < ?").run(cutoff).changes;
  }

  /* --------------------------------------------------------------- misc */

  stats(): { users: number; passkeys: number; databases: number; sessions: number; logs: number; transfers: number; bytes: number } {
    const db = this.handle();
    const one = (sql: string) => Number((db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
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
    createdAt: Number(row.created_at),
    lastOpenedAt: Number(row.last_opened_at),
    expiresAt: Number(row.expires_at),
    bytes: Number(row.bytes),
    status: String(row.status ?? "active"),
  };
}

export { StorageUnavailableError };
