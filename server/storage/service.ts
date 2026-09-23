// The storage service: sessions, keys, and the promotion that turns a
// session database into a passkey-owned one.
//
// Who owns what:
//
//   session   Someone using the server-enhanced mode without a passkey. The
//             server registers a database for their session, keys it
//             randomly and keeps that key wrapped (keys.ts). The file is
//             only created when the session first reads or writes. It lives
//             for a day after the last activity, and never more than a week
//             after it was created. "Clear everything and leave" deletes it
//             at once. New sessions are capped per client and per server.
//
//   account   Someone signed in with a passkey. Their database is opened
//             with a key their browser derived from the passkey's PRF
//             secret. The server holds that key in memory while at least one
//             of the user's signed-in sessions (a "holder") uses it, and at
//             most 12 hours after its last use; then it is zeroed. It is
//             never written down, so once released the file is opaque again.
//             An account database expires when the user says so, not before.
//
// Registering a passkey while a session database exists promotes it: the
// account database absorbs everything in one transaction, the counts are
// verified, and only then is the session database deleted.
//
// Every write is bounded: a quota per database (64 MB for an account, 16 MB
// for a session), a size cap per value and per message, a byte budget per
// read, and hourly quotas on what a caller may log.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { MailQueue } from "../accounts/mailqueue";
import type { AuditEntry } from "../monitor/audit";
import { GlobalStore, type DatabaseRow, type LogEntry, type TransferRecord } from "./global-store";
import { UserDatabasePool, type MovedCounts, type UserDatabase, type UserLimits } from "./user-store";
import {
  classifyOpenError, driverError, loadSqliteDriver, QuotaExceededError, SessionLimitError, StorageUnavailableError,
  type OpenFailure,
} from "./db";
import {
  checkMasterKey, digestKey, KEY_BYTES, keyCheckValue, newDatabaseKey, openValue, parseClientKey, sameDigest, sealValue, sessionRef, storageDir, wrapKey,
} from "./keys";
import { USER_MIGRATIONS } from "./schema";

/** How long an anonymous session's data lives after its last activity. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** …and never longer than this after it was created. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type StorageLimits = {
  accountQuotaBytes: number;
  sessionQuotaBytes: number;
  maxOpenHandles: number;
  idleHandleMs: number;
  /** New anonymous sessions one client (clientKey) may start per hour. */
  sessionsPerClientPerHour: number;
  /** Live session databases on the whole server. */
  maxLiveSessions: number;
  logLinesPerHour: number;
  transfersPerHour: number;
  /** A client-supplied log / transfer detail, as JSON. */
  clientDetailBytes: number;
  /** A database's index row is refreshed at most this often. */
  touchIntervalMs: number;
  /** An account key nobody used for this long is forgotten. */
  accountKeyIdleMs: number;
  logRetentionMs: number;
  transferRetentionMs: number;
  auditRetentionMs: number;
};

export const STORAGE_LIMITS: Readonly<StorageLimits> = {
  accountQuotaBytes: 64 * 1024 * 1024,
  sessionQuotaBytes: 16 * 1024 * 1024,
  maxOpenHandles: 200,
  idleHandleMs: 5 * 60 * 1000,
  sessionsPerClientPerHour: 30,
  maxLiveSessions: 5_000,
  logLinesPerHour: 600,
  transfersPerHour: 200,
  clientDetailBytes: 1024,
  touchIntervalMs: 60 * 1000,
  accountKeyIdleMs: 12 * HOUR,
  logRetentionMs: 30 * DAY,
  transferRetentionMs: 90 * DAY,
  auditRetentionMs: 90 * DAY,
};

export type StorageOptions = {
  limits?: Partial<StorageLimits>;
  /** Per-database limits (message size, read budget…), for tests and tuning. */
  userLimits?: Partial<UserLimits>;
};

export type SessionHandle = {
  /** Opaque token the browser keeps; it addresses the session database.
   *  The server stores only an HMAC of it. */
  sessionId: string;
  databaseId: string;
  expiresAt: number;
};

export type OpenFailureCode = "no-key" | OpenFailure;

export type OpenResult =
  | { ok: true; databaseId: string; keyMode: "prf" | "wrapped"; expiresAt: number; summary: ReturnType<UserDatabase["summary"]> }
  | { ok: false; reason: string; code?: OpenFailureCode };

export type PromoteResult =
  | { ok: true; databaseId: string; moved: { messages: number; keys: number; mailbox: number } & Partial<MovedCounts> }
  | { ok: false; reason: string };

/** What the bridge does with the account vault's file copy (bridge.ts). */
export type VaultFileHooks = {
  /** The account database just opened: bring a newer file copy into it. */
  migrate(accountId: string, db: UserDatabase): void;
  /** The account is being forgotten: the file copy goes too. */
  remove(accountId: string): void;
};

type HeldKey = { key: Buffer; holders: Set<string>; lastUsedAt: number };

/** The holder of a key opened without saying who holds it. */
const ANY_HOLDER = "*";

const OPEN_REASONS: Record<OpenFailure, string> = {
  "wrong-key": "this key does not open the stored database",
  missing: "the stored database file is missing",
  corrupt: "the stored database is damaged",
  io: "the database could not be opened right now; try again",
};

/** Fixed hourly windows per key — cheap, and bounded by the minute sweep. */
class HourlyQuota {
  private windows = new Map<string, { start: number; count: number }>();

  take(key: string, max: number, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || now - window.start >= HOUR) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 100_000) this.prune(now);
      return max > 0;
    }
    if (window.count >= max) return false;
    window.count += 1;
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, window] of this.windows) if (now - window.start >= HOUR) this.windows.delete(key);
  }

  clear(): void { this.windows.clear(); }
}

export class StorageService {
  readonly global: GlobalStore;
  readonly limits: StorageLimits;
  private readonly userLimits: Partial<UserLimits>;
  private readonly pool: UserDatabasePool;
  /** Account keys held in this process: memory only, zeroed on release. */
  private accountKeys = new Map<string, HeldKey>();
  private available = false;
  private reason: string | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** When each database's index row was last refreshed. */
  private touched = new Map<string, number>();
  private quotas = { session: new HourlyQuota(), log: new HourlyQuota(), transfer: new HourlyQuota() };
  private mailQueue: MailQueue | null = null;
  private vaultHooks: VaultFileHooks | null = null;

  constructor(private readonly dir: string = storageDir(), options: StorageOptions = {}) {
    this.limits = { ...STORAGE_LIMITS, ...(options.limits ?? {}) };
    this.userLimits = options.userLimits ?? {};
    this.global = new GlobalStore(dir);
    this.pool = new UserDatabasePool(this.limits.idleHandleMs, this.limits.maxOpenHandles);
  }

  /** Loads the driver and the master key and opens the global database.
   *  Safe to call twice. */
  async init(): Promise<{ ok: boolean; reason?: string }> {
    if (this.available) return { ok: true };
    const driver = await loadSqliteDriver();
    if (!driver) {
      this.reason = driverError() ?? "SQLite driver unavailable";
      return { ok: false, reason: this.reason };
    }
    // Without its master key the storage does not start at all — it never
    // runs on a stand-in key that would orphan every session database.
    const master = checkMasterKey();
    if (!master.ok) {
      this.reason = master.reason;
      console.warn(`[storage] ${this.reason}; server-side storage is off.`);
      return { ok: false, reason: this.reason };
    }
    try {
      this.global.open();
      this.available = true;
      this.reason = null;
      this.startSweep();
      return { ok: true };
    } catch (err) {
      this.reason = (err as Error).message;
      console.warn(`[storage] global database unavailable (${this.reason}); server-side storage is off.`);
      return { ok: false, reason: this.reason };
    }
  }

  get isAvailable(): boolean { return this.available; }
  get unavailableReason(): string | null { return this.reason; }

  private require(): void {
    if (!this.available) throw new StorageUnavailableError(this.reason ?? "storage is not available");
  }

  /** Spends one unit of a caller's hourly quota ("log", "transfer"); false
   *  when it is used up. */
  consume(bucket: "log" | "transfer", callerKey: string, now = Date.now()): boolean {
    const max = bucket === "log" ? this.limits.logLinesPerHour : this.limits.transfersPerHour;
    return this.quotas[bucket].take(callerKey, max, now);
  }

  /** Refreshes a database's index row — at most once a minute per database,
   *  because it costs a stat and a write. */
  private touch(row: DatabaseRow, expiresAt: number | undefined, now = Date.now(), force = false): void {
    const last = this.touched.get(row.id) ?? 0;
    if (!force && now - last < this.limits.touchIntervalMs) return;
    this.touched.set(row.id, now);
    try { this.global.touchDatabase(row.id, expiresAt === undefined ? {} : { expiresAt }); } catch { /* bookkeeping only */ }
  }

  private options(kind: "account" | "session", row: DatabaseRow) {
    return {
      mustExist: row.schemaVersion > 0,
      quotaBytes: kind === "account" ? this.limits.accountQuotaBytes : this.limits.sessionQuotaBytes,
      limits: this.userLimits,
    };
  }

  private created(row: DatabaseRow): void {
    if (row.schemaVersion >= USER_MIGRATIONS.length) return;
    try { this.global.markDatabaseCreated(row.id, USER_MIGRATIONS.length); } catch { /* next time */ }
  }

  /* ------------------------------------------------------------ sessions */

  private sessionLive(row: DatabaseRow, now: number): boolean {
    return (row.expiresAt === 0 || row.expiresAt > now) && now - row.createdAt < SESSION_MAX_AGE_MS;
  }

  /** A day after the last activity, capped at a week after creation. */
  private sessionExpiry(row: DatabaseRow, now: number): number {
    return Math.min(now + SESSION_TTL_MS, row.createdAt + SESSION_MAX_AGE_MS);
  }

  /**
   * Starts (or resumes) a database for a browser without a passkey. Nothing
   * is opened or created on disk yet — that waits for the first read or
   * write. `clientKey` identifies the caller for the per-client cap (the
   * route passes the truncated IP); throws SessionLimitError when that cap
   * or the server-wide one is reached.
   */
  startSession(existingId?: string, meta: { clientKey?: string } = {}): SessionHandle {
    this.require();
    const now = Date.now();
    if (existingId && isSessionId(existingId)) {
      const resumed = this.resumeSession(existingId, now);
      if (resumed) return resumed;
    }
    if (this.global.countLiveSessions(now) >= this.limits.maxLiveSessions) {
      this.log({ level: "warn", source: "server", event: "storage.session.capacity" });
      throw new SessionLimitError("global", "this server is holding as many temporary databases as it can; try again later");
    }
    if (meta.clientKey !== undefined && !this.quotas.session.take(`c:${meta.clientKey.slice(0, 80)}`, this.limits.sessionsPerClientPerHour, now)) {
      throw new SessionLimitError("client", "too many new sessions from this address; try again later");
    }
    const sessionId = `sess-${randomBytes(18).toString("base64url")}`;
    const expiresAt = now + SESSION_TTL_MS;
    // The key is generated here and only ever stored as ciphertext.
    const key = newDatabaseKey();
    let row: DatabaseRow;
    try {
      row = this.global.registerDatabase({ ownerKind: "session", ownerId: sessionId, keyMode: "wrapped", key, expiresAt });
    } finally {
      key.fill(0);
    }
    this.touched.set(row.id, now);
    this.log({ level: "info", source: "server", event: "storage.session.created", sessionId, detail: { databaseId: row.id } });
    return { sessionId, databaseId: row.id, expiresAt };
  }

  private resumeSession(sessionId: string, now: number): SessionHandle | null {
    const row = this.global.findDatabase("session", sessionId);
    if (!row) return null;
    if (!this.sessionLive(row, now)) {
      this.dropDatabase(row);
      return null;
    }
    // A session whose key no longer unwraps could never be opened: start a
    // fresh one instead of handing this one back.
    const key = this.global.databaseKey(row.id);
    if (!key) {
      this.log({ level: "warn", source: "server", event: "storage.session.unreadable", detail: { databaseId: row.id } });
      this.dropDatabase(row);
      return null;
    }
    key.fill(0);
    const expiresAt = this.sessionExpiry(row, now);
    this.touch(row, expiresAt, now, true);
    return { sessionId, databaseId: row.id, expiresAt };
  }

  /** Whether a session id names a live session (without opening anything). */
  sessionExists(sessionId: string): boolean {
    if (!this.available || !isSessionId(sessionId)) return false;
    const row = this.global.findDatabase("session", sessionId);
    return Boolean(row && this.sessionLive(row, Date.now()));
  }

  /** The database of an anonymous session, opened with its wrapped key —
   *  or the handle already open, without unwrapping anything again. */
  openSession(sessionId: string): UserDatabase | null {
    this.require();
    if (!isSessionId(sessionId)) return null;
    const now = Date.now();
    const row = this.global.findDatabase("session", sessionId);
    if (!row) return null;
    if (!this.sessionLive(row, now)) {
      this.dropDatabase(row);
      return null;
    }
    let handle = this.pool.get(row.id);
    if (!handle) {
      const key = this.global.databaseKey(row.id);
      if (!key) return null;
      try {
        handle = this.pool.open(row.id, this.global.databasePath(row), key, this.options("session", row));
      } catch (err) {
        const kind = classifyOpenError(err);
        this.log({ level: "warn", source: "server", event: "storage.session.open-failed", detail: { databaseId: row.id, kind, error: (err as Error).message } });
        // Disk full, too many open files: not the caller's fault, say so.
        if (kind === "io") throw err;
        if (kind === "missing") this.dropDatabase(row);
        return null;
      } finally {
        key.fill(0);
      }
      this.created(row);
    }
    this.touch(row, this.sessionExpiry(row, now), now);
    return handle;
  }

  /* ------------------------------------------------------------ accounts */

  /**
   * Opens (or creates) the database of a signed-in user with the key their
   * passkey produced. `holder` names who holds it open (the routes pass the
   * hash of the bearer token); the key stays in memory until every holder
   * released it, or 12 hours without use. A key is only kept once it has
   * been proven to open the database.
   */
  openAccount(accountId: string, clientKey: unknown, holder?: string): OpenResult {
    this.require();
    const given = clientKey instanceof Buffer ? (clientKey.length === KEY_BYTES ? Buffer.from(clientKey) : null) : parseClientKey(clientKey);
    const held = this.accountKeys.get(accountId);
    if (!given && !held) return { ok: false, reason: "a database key derived from the passkey is required", code: "no-key" };
    const key = given ?? held!.key;
    const row = this.global.registerDatabase({ ownerKind: "account", ownerId: accountId, keyMode: "prf" });
    const check = keyCheckValue(key, row.id);
    const known = this.global.databaseKeyCheck(row.id);
    const fail = (code: OpenFailure, error?: string): OpenResult => {
      given?.fill(0);
      this.log({ level: "warn", source: "server", event: "storage.account.open-failed", accountId, detail: { kind: code, ...(error ? { error } : {}) } });
      return { ok: false, reason: OPEN_REASONS[code], code };
    };
    // The index knows which key belongs here: a different one is refused
    // without touching the file.
    if (known && !sameDigest(known, check)) return fail("wrong-key");
    // A key already held is the proven one; a different key is wrong.
    if (given && held && !sameDigest(digestKey(given), digestKey(held.key))) return fail("wrong-key");

    let handle: UserDatabase;
    try {
      handle = this.pool.open(row.id, this.global.databasePath(row), key, this.options("account", row));
    } catch (err) {
      let kind = classifyOpenError(err);
      // The key is the right one but the file will not open: the file is
      // the problem, not the user.
      if (kind === "wrong-key" && known) kind = "corrupt";
      return fail(kind, (err as Error).message);
    }

    const now = Date.now();
    if (held) {
      if (given && given !== held.key) given.fill(0);
      held.holders.add(holder ?? ANY_HOLDER);
      held.lastUsedAt = now;
    } else {
      this.accountKeys.set(accountId, { key: given!, holders: new Set([holder ?? ANY_HOLDER]), lastUsedAt: now });
    }
    if (!known) {
      try { this.global.setDatabaseKeyCheck(row.id, check); } catch { /* next time */ }
    }
    this.created(row);
    this.touch(row, undefined, now, true);
    if (this.vaultHooks) {
      try { this.vaultHooks.migrate(accountId, handle); } catch (err) {
        this.log({ level: "warn", source: "server", event: "storage.vault.migrate-failed", accountId, detail: { error: (err as Error).message } });
      }
    }
    return { ok: true, databaseId: row.id, keyMode: row.keyMode, expiresAt: row.expiresAt, summary: handle.summary() };
  }

  /** The open database of a signed-in user, if this process holds its key. */
  account(accountId: string): UserDatabase | null {
    if (!this.available) return null;
    const held = this.accountKeys.get(accountId);
    if (!held) return null;
    const row = this.global.findDatabase("account", accountId);
    if (!row) return null;
    const now = Date.now();
    held.lastUsedAt = now;
    let handle = this.pool.get(row.id);
    if (!handle) {
      try {
        handle = this.pool.open(row.id, this.global.databasePath(row), held.key, this.options("account", row));
      } catch {
        return null;
      }
    }
    this.touch(row, undefined, now);
    return handle;
  }

  /**
   * A holder lets go of an account's key (a device signed out). The key is
   * forgotten — zeroed, and the file closed — only when no holder is left.
   * Without `holder` every holder is dropped at once (sign out everywhere,
   * the operator, account deletion).
   */
  releaseAccount(accountId: string, holder?: string): void {
    const held = this.accountKeys.get(accountId);
    if (held && holder !== undefined) {
      held.holders.delete(holder);
      if (held.holders.size > 0) return;
    }
    this.lockAccount(accountId);
  }

  /** Whether this process holds an account's key right now. */
  isAccountOpen(accountId: string): boolean {
    return this.accountKeys.has(accountId);
  }

  private lockAccount(accountId: string): void {
    const held = this.accountKeys.get(accountId);
    if (held) {
      held.key.fill(0);
      held.holders.clear();
      this.accountKeys.delete(accountId);
    }
    if (!this.available) return;
    try {
      const row = this.global.findDatabase("account", accountId);
      if (row) this.pool.release(row.id);
    } catch { /* the pool closes it on the next sweep */ }
  }

  /* ----------------------------------------------------------- promotion */

  /**
   * A session user registered a passkey: give them a database keyed by that
   * passkey and move everything into it — all of it, in one transaction on
   * the account database, verified row for row. Only then is the session
   * database deleted; if anything fails it stays as it was.
   */
  promoteSession(sessionId: string, accountId: string, clientKey: unknown, holder?: string): PromoteResult {
    this.require();
    const usable = clientKey instanceof Buffer ? clientKey.length === KEY_BYTES : Boolean(parseClientKey(clientKey));
    if (!usable) return { ok: false, reason: "a database key derived from the passkey is required" };

    const opened = this.openAccount(accountId, clientKey, holder);
    if (!opened.ok) return { ok: false, reason: opened.reason };
    const target = this.account(accountId);
    if (!target) return { ok: false, reason: "could not open the new database" };

    const nothing = { messages: 0, keys: 0, mailbox: 0 };
    const now = Date.now();
    const sessionRow = isSessionId(sessionId) ? this.global.findDatabase("session", sessionId) : null;
    if (!sessionRow) return { ok: true, databaseId: opened.databaseId, moved: nothing };
    if (!this.sessionLive(sessionRow, now)) {
      this.dropDatabase(sessionRow);
      return { ok: true, databaseId: opened.databaseId, moved: nothing };
    }
    const path = this.global.databasePath(sessionRow);
    const key = this.global.databaseKey(sessionRow.id);
    if (!key) {
      // Nobody can read it any more — not even this server.
      this.log({ level: "warn", source: "server", event: "storage.session.unreadable", detail: { databaseId: sessionRow.id } });
      this.dropDatabase(sessionRow);
      return { ok: true, databaseId: opened.databaseId, moved: nothing };
    }
    try {
      if (!existsSync(path)) {
        // Registered but never written to: nothing to move.
        this.dropDatabase(sessionRow);
        return { ok: true, databaseId: opened.databaseId, moved: nothing };
      }
      // Bring the session file to the current schema, then let go of it so
      // the account database can attach it.
      this.pool.open(sessionRow.id, path, key, { ...this.options("session", sessionRow), mustExist: true });
      this.pool.release(sessionRow.id);
      const moved = target.absorb(path, key);
      this.dropDatabase(sessionRow);
      target.addEvent({ at: Date.now(), kind: "storage.promoted", meta: moved });
      this.log({ level: "info", source: "server", event: "storage.session.promoted", accountId, detail: moved });
      return { ok: true, databaseId: opened.databaseId, moved };
    } catch (err) {
      this.log({ level: "warn", source: "server", event: "storage.session.promote-failed", accountId, detail: { error: (err as Error).message } });
      return {
        ok: false,
        reason: err instanceof QuotaExceededError
          ? "the account database has no room for the session's data; nothing was moved"
          : "could not move the session's data; it was kept as it was",
      };
    } finally {
      key.fill(0);
    }
  }

  /* -------------------------------------------------------------- wiping */

  /** "Clear everything and leave" for a session, or a user asking to erase
   *  their account data: the database, the vault's file copy, the offline
   *  queue and everything logged about them. Returns whether a database
   *  was removed. */
  forget(owner: { accountId?: string; sessionId?: string }): { removed: boolean } {
    if (!this.available) return { removed: false };
    if (owner.accountId) {
      const accountId = owner.accountId;
      const row = this.global.findDatabase("account", accountId);
      this.lockAccount(accountId);
      if (row) this.dropDatabase(row);
      try { this.vaultHooks?.remove(accountId); } catch { /* best effort */ }
      try { this.queue()?.purgeAccount(accountId); } catch { /* best effort */ }
      try { this.global.purgeOwner({ accountId }); } catch { /* best effort */ }
      this.log({ level: "info", source: "server", event: "storage.forgotten", detail: { owner: "account" } });
      return { removed: Boolean(row) };
    }
    if (owner.sessionId) {
      const row = isSessionId(owner.sessionId) ? this.global.findDatabase("session", owner.sessionId) : null;
      if (row) this.dropDatabase(row);
      if (isSessionId(owner.sessionId)) {
        try { this.global.purgeOwner({ sessionId: owner.sessionId }); } catch { /* best effort */ }
      }
      this.log({ level: "info", source: "server", event: "storage.forgotten", detail: { owner: "session" } });
      return { removed: Boolean(row) };
    }
    return { removed: false };
  }

  private dropDatabase(row: DatabaseRow): void {
    this.pool.release(row.id);
    this.touched.delete(row.id);
    this.global.dropDatabase(row.id);
  }

  /* ---------------------------------------------------------------- hooks */

  /** Installed by bridge.ts: what to do with the vault's file copy. */
  setVaultFileHooks(hooks: VaultFileHooks | null): void {
    this.vaultHooks = hooks;
  }

  /** The offline queue, in the global database; null while storage is off. */
  queue(): MailQueue | null {
    if (!this.available) return null;
    if (!this.mailQueue) {
      try {
        // Metadata at rest (who sent it, status details) is sealed with the
        // master key and bound to its row (accounts/mailqueue.ts).
        this.mailQueue = new MailQueue(this.global.handleForQueue(), Date.now, {
          seal: (text, aad) => sealValue(text, aad).toString("base64"),
          open: (sealed, aad) => openValue(Buffer.from(sealed, "base64"), aad),
        });
      } catch (err) {
        this.log({ level: "error", source: "server", event: "storage.queue.unavailable", detail: { error: (err as Error).message } });
        return null;
      }
    }
    return this.mailQueue;
  }

  /* ------------------------------------------------- backup & integrity */

  /** Paths of the encrypted user database files, with open ones checkpointed first. */
  userDatabaseFiles(): string[] {
    this.require();
    this.pool.forEachOpen((_id, db) => db.checkpoint());
    return this.global.listDatabases(1000).map((row) => this.global.databasePath(row));
  }

  /** quick_check of the global database and of every open user database
   *  (a locked account database cannot be read without its owner's key). */
  integrityCheck(): { global: string; databases: Array<{ id: string; result: string }>; locked: number } {
    this.require();
    const databases: Array<{ id: string; result: string }> = [];
    this.pool.forEachOpen((id, db) => databases.push({ id, result: db.quickCheck() }));
    const locked = Math.max(0, this.global.listDatabases(1000).length - databases.length);
    return { global: this.global.quickCheck(), databases, locked };
  }

  /* ------------------------------------------------------------ retention */

  /** Expired session databases go, and so do orphan files; logs, transfers
   *  and audit rows are pruned by age (when a cutoff is given) and count;
   *  idle handles close, idle keys are forgotten, the queue is swept. */
  sweep(now = Date.now(), cutoffs: { logs?: number; transfers?: number; audit?: number } = {}): {
    databases: number; logs: number; transfers: number; closed: number; orphans: number; audit: number; keys: number;
  } {
    const result = { databases: 0, logs: 0, transfers: 0, closed: 0, orphans: 0, audit: 0, keys: 0 };
    if (!this.available) return result;
    for (const row of this.global.expiredDatabases(now, SESSION_MAX_AGE_MS)) {
      this.dropDatabase(row);
      result.databases += 1;
    }
    result.orphans = this.global.sweepOrphans(now);
    result.logs = this.global.pruneLogs(cutoffs.logs ?? 0);
    result.transfers = this.global.pruneTransfers(cutoffs.transfers ?? 0);
    result.audit = this.global.pruneAudit(cutoffs.audit ?? 0);
    try { this.queue()?.sweep(); } catch { /* next hour */ }
    const idle = this.sweepIdle(now);
    result.closed = idle.closed;
    result.keys = idle.keys;
    if (result.databases > 0 || result.orphans > 0) {
      this.log({ level: "info", source: "server", event: "storage.sweep", detail: { databases: result.databases, orphans: result.orphans, logs: result.logs, transfers: result.transfers } });
    }
    return result;
  }

  /** The cheap, frequent part: idle handles close, account keys unused for
   *  12 hours are zeroed, and the quota windows are trimmed. */
  sweepIdle(now = Date.now()): { closed: number; keys: number } {
    let keys = 0;
    for (const [accountId, held] of this.accountKeys) {
      if (now - held.lastUsedAt > this.limits.accountKeyIdleMs) {
        this.lockAccount(accountId);
        keys += 1;
      }
    }
    const closed = this.pool.sweepIdle(now);
    for (const quota of Object.values(this.quotas)) quota.prune(now);
    for (const [id, at] of this.touched) if (now - at > HOUR) this.touched.delete(id);
    return { closed, keys };
  }

  private startSweep(): void {
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        const now = Date.now();
        try {
          this.sweep(now, { logs: now - this.limits.logRetentionMs, transfers: now - this.limits.transferRetentionMs, audit: now - this.limits.auditRetentionMs });
        } catch { /* keep serving */ }
      }, HOUR);
      this.sweepTimer.unref?.();
    }
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => {
        try { this.sweepIdle(Date.now()); } catch { /* keep serving */ }
      }, 60 * 1000);
      this.idleTimer.unref?.();
    }
  }

  stopSweep(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }

  /* ---------------------------------------------------------- log + stats */

  log(entry: Omit<LogEntry, "at"> & { at?: number }): void {
    if (!this.available) return;
    try { this.global.log({ ...entry, at: entry.at ?? Date.now() }); } catch { /* logging must never break a request */ }
  }

  /** For audit.setSink(): persists a journal entry into the global
   *  database. Quiet when storage is off, and never throws. */
  appendAudit(entry: AuditEntry): void {
    if (!this.available) return;
    try { this.global.appendAudit(entry); } catch { /* the journal keeps it in memory */ }
  }

  /** Records (or updates) a transfer; false when nothing was written. */
  recordTransfer(record: TransferRecord): boolean {
    if (!this.available) return false;
    try { return this.global.recordTransfer(record); } catch { return false; }
  }

  /** Everything, for the operator (the public status op shows far less). */
  status(): {
    available: boolean;
    reason: string | null;
    engine: string;
    dir: string;
    openDatabases: number;
    heldKeys: number;
    stats: ReturnType<GlobalStore["stats"]> | null;
  } {
    let stats: ReturnType<GlobalStore["stats"]> | null = null;
    if (this.available) {
      try { stats = this.global.stats(); } catch { stats = null; }
    }
    return {
      available: this.available,
      reason: this.reason,
      engine: "sqlite+sqlcipher",
      dir: this.dir,
      openDatabases: this.pool.size,
      heldKeys: this.accountKeys.size,
      stats,
    };
  }

  /** Shutdown (and test seam): closes every database, zeroes every key. */
  close(): void {
    this.stopSweep();
    this.pool.closeAll();
    for (const held of this.accountKeys.values()) {
      held.key.fill(0);
      held.holders.clear();
    }
    this.accountKeys.clear();
    this.touched.clear();
    for (const quota of Object.values(this.quotas)) quota.clear();
    this.mailQueue = null;
    this.global.close();
    this.available = false;
  }
}

/** A room name never reaches the global database in the clear. */
export function roomHash(room: string): string {
  return createHash("sha256").update(`m5cet:room:${room}`).digest("hex").slice(0, 32);
}

export function isSessionId(value: string): boolean {
  return /^sess-[A-Za-z0-9_-]{16,64}$/.test(value);
}

/** Wraps a key for callers that store one themselves (tests, tooling). */
export { wrapKey, sessionRef };

export const storage = new StorageService();

/** For SIGTERM / SIGINT: closes every database and zeroes every key. */
export function shutdownStorage(service: StorageService = storage): void {
  try { service.close(); } catch (err) {
    console.warn(`[storage] shutdown: ${(err as Error).message}`);
  }
}
