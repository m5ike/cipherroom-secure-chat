// The storage service: sessions, keys, and the promotion that turns a
// day-old session database into a passkey-owned one.
//
// Who owns what:
//
//   session   Someone using the server-enhanced mode without a passkey. The
//             server makes a database for their session, keys it randomly,
//             keeps that key wrapped with the master key, and gives it a
//             one-day life. "Clear everything and leave" deletes it at once.
//
//   account   Someone signed in with a passkey. Their database is opened
//             with a key their browser derived from the passkey's PRF
//             secret and sent for this session only; the server never
//             writes it down, so once the session ends the file is opaque
//             again. It expires when the user says so, not before.
//
// Registering a passkey while a session database exists promotes it: a new
// database is created under the account, everything is copied across, the
// old one is deleted and the client is told to use the new id from now on.

import { createHash, randomBytes } from "node:crypto";
import { GlobalStore, type DatabaseRow, type LogEntry, type TransferRecord } from "./global-store";
import { UserDatabasePool, type UserDatabase } from "./user-store";
import { driverError, loadSqliteDriver, StorageUnavailableError } from "./db";
import { newDatabaseKey, parseClientKey, storageDir, wrapKey } from "./keys";

/** How long an anonymous session's data lives without a passkey. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type SessionHandle = {
  /** Opaque token the browser keeps; it addresses the session database. */
  sessionId: string;
  databaseId: string;
  expiresAt: number;
};

export type OpenResult =
  | { ok: true; databaseId: string; keyMode: "prf" | "wrapped"; expiresAt: number; summary: ReturnType<UserDatabase["summary"]> }
  | { ok: false; reason: string };

export class StorageService {
  readonly global: GlobalStore;
  private readonly pool: UserDatabasePool;
  /** Account databases opened in this process, and the key they were opened
   *  with — memory only, so a restart re-locks them. */
  private accountKeys = new Map<string, Buffer>();
  private available = false;
  private reason: string | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dir: string = storageDir()) {
    this.global = new GlobalStore(dir);
    this.pool = new UserDatabasePool();
  }

  /** Loads the driver and opens the global database. Safe to call twice. */
  async init(): Promise<{ ok: boolean; reason?: string }> {
    if (this.available) return { ok: true };
    const driver = await loadSqliteDriver();
    if (!driver) {
      this.reason = driverError() ?? "SQLite driver unavailable";
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

  /* ------------------------------------------------------------ sessions */

  /** Starts (or resumes) a database for a browser without a passkey. */
  startSession(existingId?: string): SessionHandle {
    this.require();
    const now = Date.now();
    if (existingId && isSessionId(existingId)) {
      const row = this.global.findDatabase("session", existingId);
      if (row && (row.expiresAt === 0 || row.expiresAt > now)) {
        const expiresAt = now + SESSION_TTL_MS;
        this.global.touchDatabase(row.id, { expiresAt });
        return { sessionId: existingId, databaseId: row.id, expiresAt };
      }
    }
    const sessionId = `sess-${randomBytes(18).toString("base64url")}`;
    const row = this.global.registerDatabase({
      ownerKind: "session",
      ownerId: sessionId,
      keyMode: "wrapped",
      expiresAt: now + SESSION_TTL_MS,
    });
    // The key is generated here and only ever leaves as ciphertext.
    const key = newDatabaseKey();
    this.global.setDatabaseKey(row.id, key);
    this.pool.open(row.id, this.global.databasePath(row), key);
    this.global.touchDatabase(row.id, { expiresAt: now + SESSION_TTL_MS });
    this.log({ level: "info", source: "server", event: "storage.session.created", sessionId, detail: { databaseId: row.id } });
    return { sessionId, databaseId: row.id, expiresAt: now + SESSION_TTL_MS };
  }

  /** The database of an anonymous session, opened with its wrapped key. */
  openSession(sessionId: string): UserDatabase | null {
    this.require();
    if (!isSessionId(sessionId)) return null;
    const row = this.global.findDatabase("session", sessionId);
    if (!row) return null;
    if (row.expiresAt > 0 && row.expiresAt < Date.now()) {
      this.dropDatabase(row);
      return null;
    }
    const key = this.global.databaseKey(row.id);
    if (!key) return null;
    const handle = this.pool.open(row.id, this.global.databasePath(row), key);
    this.global.touchDatabase(row.id, { expiresAt: Date.now() + SESSION_TTL_MS });
    return handle;
  }

  /* ------------------------------------------------------------ accounts */

  /** Opens (or creates) the database of a signed-in user. The key comes
   *  from their passkey and is held for this process's lifetime only. */
  openAccount(accountId: string, clientKey: unknown): OpenResult {
    this.require();
    const given = clientKey instanceof Buffer && clientKey.length === 32 ? clientKey : parseClientKey(clientKey);
    const key = given ?? this.accountKeys.get(accountId) ?? null;
    if (!key) return { ok: false, reason: "a database key derived from the passkey is required" };
    const row = this.global.registerDatabase({ ownerKind: "account", ownerId: accountId, keyMode: "prf" });
    try {
      const handle = this.pool.open(row.id, this.global.databasePath(row), key);
      this.accountKeys.set(accountId, key);
      this.global.touchDatabase(row.id);
      return { ok: true, databaseId: row.id, keyMode: row.keyMode, expiresAt: row.expiresAt, summary: handle.summary() };
    } catch (err) {
      // A wrong key is the usual cause: SQLCipher refuses to read the file.
      this.log({ level: "warn", source: "server", event: "storage.account.open-failed", accountId, detail: { error: (err as Error).message } });
      return { ok: false, reason: "this key does not open the stored database" };
    }
  }

  /** The open database of a signed-in user, if this process has its key. */
  account(accountId: string): UserDatabase | null {
    if (!this.available) return null;
    const row = this.global.findDatabase("account", accountId);
    if (!row) return null;
    const cached = this.pool.get(row.id);
    if (cached) return cached;
    const key = this.accountKeys.get(accountId);
    if (!key) return null;
    try {
      const handle = this.pool.open(row.id, this.global.databasePath(row), key);
      this.global.touchDatabase(row.id);
      return handle;
    } catch {
      return null;
    }
  }

  /** Signing out: close the file and forget the key. */
  releaseAccount(accountId: string): void {
    if (!this.available) return;
    const row = this.global.findDatabase("account", accountId);
    if (row) this.pool.release(row.id);
    this.accountKeys.delete(accountId);
  }

  /* ----------------------------------------------------------- promotion */

  /**
   * A session user registered a passkey: give them a database keyed by that
   * passkey, move everything into it and delete the old one. The client gets
   * the new database id and writes there from now on.
   */
  promoteSession(sessionId: string, accountId: string, clientKey: unknown): { ok: true; databaseId: string; moved: { messages: number; keys: number; mailbox: number } } | { ok: false; reason: string } {
    this.require();
    if (!parseClientKey(clientKey)) return { ok: false, reason: "a database key derived from the passkey is required" };

    const sessionRow = this.global.findDatabase("session", sessionId);
    const opened = this.openAccount(accountId, clientKey);
    if (!opened.ok) return { ok: false, reason: opened.reason };
    const target = this.account(accountId);
    if (!target) return { ok: false, reason: "could not open the new database" };

    let moved = { messages: 0, keys: 0, mailbox: 0 };
    if (sessionRow) {
      const source = this.openSession(sessionId);
      if (source) {
        const data = source.exportAll();
        target.importAll(data);
        moved = { messages: data.messages.length, keys: data.kv.length, mailbox: data.mailbox.length };
        target.addEvent({ at: Date.now(), kind: "storage.promoted", meta: moved });
      }
      // The temporary database and its key go, whatever happened above.
      this.dropDatabase(sessionRow);
    }
    this.log({ level: "info", source: "server", event: "storage.session.promoted", accountId, sessionId, detail: moved });
    return { ok: true, databaseId: opened.databaseId, moved };
  }

  /* -------------------------------------------------------------- wiping */

  /** "Clear everything and leave" for a session, or a user asking to erase
   *  their account data. Returns what was removed. */
  forget(owner: { accountId?: string; sessionId?: string }): { removed: boolean } {
    if (!this.available) return { removed: false };
    const row = owner.accountId
      ? this.global.findDatabase("account", owner.accountId)
      : owner.sessionId ? this.global.findDatabase("session", owner.sessionId) : null;
    if (!row) return { removed: false };
    if (owner.accountId) this.accountKeys.delete(owner.accountId);
    this.dropDatabase(row);
    this.log({ level: "info", source: "server", event: "storage.forgotten", accountId: owner.accountId ?? null, sessionId: owner.sessionId ?? null });
    return { removed: true };
  }

  private dropDatabase(row: DatabaseRow): void {
    this.pool.release(row.id);
    this.global.dropDatabase(row.id);
  }

  /* ------------------------------------------------------------ retention */

  /** Expired session databases go; so do old logs and transfer rows. */
  sweep(now = Date.now(), cutoffs: { logs?: number; transfers?: number } = {}): { databases: number; logs: number; transfers: number; closed: number } {
    if (!this.available) return { databases: 0, logs: 0, transfers: 0, closed: 0 };
    let databases = 0;
    for (const row of this.global.expiredDatabases(now)) {
      this.dropDatabase(row);
      databases += 1;
    }
    const logs = cutoffs.logs ? this.global.pruneLogs(cutoffs.logs) : 0;
    const transfers = cutoffs.transfers ? this.global.pruneTransfers(cutoffs.transfers) : 0;
    const closed = this.pool.sweepIdle(now);
    if (databases > 0) this.log({ level: "info", source: "server", event: "storage.sweep", detail: { databases, logs, transfers } });
    return { databases, logs, transfers, closed };
  }

  private startSweep(): void {
    if (this.sweepTimer) return;
    const hour = 60 * 60 * 1000;
    this.sweepTimer = setInterval(() => {
      try { this.sweep(Date.now(), { logs: Date.now() - 30 * 24 * hour, transfers: Date.now() - 90 * 24 * hour }); } catch { /* keep serving */ }
    }, hour);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  /* ---------------------------------------------------------- log + stats */

  log(entry: Omit<LogEntry, "at"> & { at?: number }): void {
    if (!this.available) return;
    try { this.global.log({ ...entry, at: entry.at ?? Date.now() }); } catch { /* logging must never break a request */ }
  }

  recordTransfer(record: TransferRecord): void {
    if (!this.available) return;
    try { this.global.recordTransfer(record); } catch { /* ditto */ }
  }

  status(): {
    available: boolean;
    reason: string | null;
    engine: string;
    dir: string;
    openDatabases: number;
    stats: ReturnType<GlobalStore["stats"]> | null;
  } {
    return {
      available: this.available,
      reason: this.reason,
      engine: "sqlite+sqlcipher",
      dir: this.dir,
      openDatabases: this.pool.size,
      stats: this.available ? this.global.stats() : null,
    };
  }

  /** Test seam / shutdown. */
  close(): void {
    this.stopSweep();
    this.pool.closeAll();
    this.global.close();
    this.accountKeys.clear();
    this.available = false;
  }
}

/** A room name never reaches the global database in the clear. */
export function roomHash(room: string): string {
  return createHash("sha256").update(`m5cet:room:${room}`).digest("hex").slice(0, 32);
}

function isSessionId(value: string): boolean {
  return /^sess-[A-Za-z0-9_-]{16,64}$/.test(value);
}

/** Wraps a key for callers that store one themselves (tests, tooling). */
export { wrapKey };

export const storage = new StorageService();
