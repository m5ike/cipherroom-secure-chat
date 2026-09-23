// Opening databases: the plain global one and the encrypted per-user ones.
//
// SQLCipher comes from better-sqlite3-multiple-ciphers, imported once at
// startup (as push.ts does with web-push) so a server whose install could
// not build the native module still boots and relays — it simply reports
// storage as unavailable instead of crashing.
//
// Every database runs with WAL, a busy timeout and foreign keys on, and is
// migrated on open (see schema.ts). A user database's key is given to
// `openUserDatabase` and never written anywhere by this module.
//
// Files are private from the first byte: the directory is 0700, and a new
// database file is created empty with mode 0600 *before* SQLite opens it, so
// the -wal / -shm files SQLite creates next to it inherit that mode.
//
// The typed errors every layer above uses live here too, so the API can map
// them to status codes without guessing from message text.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { keyToSqlcipher } from "./keys";
import type { Migration } from "./schema";

/** The slice of better-sqlite3 we use. */
export type SqliteStatement = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
};

export type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  /** better-sqlite3's online backup (pages copied while the database stays in use). */
  backup?(destination: string): Promise<unknown>;
  close(): void;
  readonly open: boolean;
  readonly name: string;
};

type DatabaseConstructor = new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }) => SqliteDatabase;

let ctor: DatabaseConstructor | null = null;
let loadError: string | null = null;
let loading: Promise<DatabaseConstructor | null> | null = null;

/** Imports the native driver once; call before anything opens a database. */
export function loadSqliteDriver(): Promise<DatabaseConstructor | null> {
  if (ctor || loadError) return Promise.resolve(ctor);
  loading ??= (async () => {
    try {
      // The package ships types that its own "exports" map hides, so the
      // import is untyped here and shaped by DatabaseConstructor above.
      const mod = await import(/* @vite-ignore */ "better-sqlite3-multiple-ciphers" as string) as { default?: DatabaseConstructor };
      ctor = (mod.default ?? mod) as unknown as DatabaseConstructor;
    } catch (err) {
      loadError = (err as Error).message;
      console.warn(`[storage] SQLite/SQLCipher driver unavailable (${loadError}); server-side storage is off.`);
    }
    return ctor;
  })();
  return loading;
}

/** The driver, once loaded. Null while it is missing or not loaded yet. */
export function sqliteDriver(): DatabaseConstructor | null {
  return ctor;
}

export function driverError(): string | null {
  return loadError;
}

/* ------------------------------------------------------------------ errors */

export class StorageUnavailableError extends Error {}

/** Why a database would not open. Only `wrong-key` means the key is wrong:
 *  a full disk, too many open files or a damaged file are not the user's
 *  fault and must not be reported as if they were. */
export type OpenFailure = "wrong-key" | "missing" | "corrupt" | "io";

export class DatabaseOpenError extends Error {
  constructor(readonly kind: OpenFailure, message: string, readonly code?: string) {
    super(message);
    this.name = "DatabaseOpenError";
  }
}

/** A write would take the owner's database past its quota. */
export class QuotaExceededError extends Error {
  constructor(readonly usedBytes: number, readonly quotaBytes: number) {
    super(`storage quota exceeded (${usedBytes} of ${quotaBytes} bytes)`);
    this.name = "QuotaExceededError";
  }
}

/** One value or message is bigger than a single item may be. */
export class PayloadTooLargeError extends Error {
  constructor(message = "value too large") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/** A key only the server itself may write (the vault). */
export class ReservedKeyError extends Error {
  constructor(readonly key: string) {
    super(`"${key}" is reserved`);
    this.name = "ReservedKeyError";
  }
}

/** Too many anonymous sessions: from one client, or on the whole server. */
export class SessionLimitError extends Error {
  constructor(readonly scope: "client" | "global", message: string) {
    super(message);
    this.name = "SessionLimitError";
  }
}

/** What kind of failure an error from the driver (or the file system) is. */
export function classifyOpenError(err: unknown): OpenFailure {
  if (err instanceof DatabaseOpenError) return err.kind;
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  if (code === "SQLITE_NOTADB") return "wrong-key";
  if (code.startsWith("SQLITE_CORRUPT")) return "corrupt";
  if (code === "ENOENT") return "missing";
  return "io";
}

function asOpenError(err: unknown): DatabaseOpenError {
  if (err instanceof DatabaseOpenError) return err;
  const kind = classifyOpenError(err);
  const code = String((err as { code?: unknown } | null)?.code ?? "") || undefined;
  return new DatabaseOpenError(kind, (err as Error)?.message ?? String(err), code);
}

/* ------------------------------------------------------------ file modes */

/** Creates a directory (and parents) and makes it private to this user. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

/** Creates an empty file with mode 0600 if there is none, before SQLite
 *  opens it — so the journal files SQLite adds inherit the same mode. */
export function ensurePrivateFile(path: string): void {
  const fd = openSync(path, "a", 0o600);
  closeSync(fd);
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

function tune(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}

function protect(path: string): void {
  // The database (and its -wal / -shm siblings) is for this user only.
  for (const suffix of ["", "-wal", "-shm"]) {
    try { chmodSync(`${path}${suffix}`, 0o600); } catch { /* not created yet */ }
  }
}

/** Runs the migrations this database has not seen yet. */
export function migrate(db: SqliteDatabase, migrations: Migration[]): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set((db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((r) => r.name));
  let ran = 0;
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(migration.name, Date.now());
      db.exec("COMMIT");
      ran += 1;
    } catch (err) {
      db.exec("ROLLBACK");
      // Keep the driver's code: a disk-full during a migration is not a
      // wrong key.
      throw Object.assign(new Error(`migration ${migration.name} failed: ${(err as Error).message}`), { code: (err as { code?: unknown }).code });
    }
  }
  return ran;
}

export function openPlainDatabase(path: string, migrations: Migration[]): SqliteDatabase {
  const Ctor = sqliteDriver();
  if (!Ctor) throw new StorageUnavailableError(loadError ?? "SQLite driver not installed");
  ensurePrivateDir(dirname(path));
  ensurePrivateFile(path);
  const db = new Ctor(path, { timeout: 5000 });
  try {
    tune(db);
    // This file is not encrypted: what is deleted (pruned logs, dropped
    // rows, rewritten ids) is overwritten, not left in free pages.
    db.pragma("secure_delete = ON");
    migrate(db, migrations);
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    throw err;
  }
  protect(path);
  return db;
}

/**
 * Opens (or creates) an encrypted database. A wrong key fails here, when the
 * first read touches the header — never silently as empty data — and comes
 * back as DatabaseOpenError("wrong-key"); anything else (disk full, too many
 * open files, a damaged file) comes back with its own kind.
 *
 * `mustExist`: the index says this database was created before, so a missing
 * file is an error, not an invitation to start an empty one.
 */
export function openUserDatabase(path: string, key: Buffer, migrations: Migration[], options: { mustExist?: boolean } = {}): SqliteDatabase {
  const Ctor = sqliteDriver();
  if (!Ctor) throw new StorageUnavailableError(loadError ?? "SQLite driver not installed");
  let db: SqliteDatabase;
  try {
    ensurePrivateDir(dirname(path));
    if (options.mustExist) {
      if (!existsSync(path)) throw new DatabaseOpenError("missing", "the database file is missing");
    } else {
      ensurePrivateFile(path);
    }
    db = new Ctor(path, { timeout: 5000, fileMustExist: Boolean(options.mustExist) });
  } catch (err) {
    throw asOpenError(err);
  }
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`key = "${keyToSqlcipher(key)}"`);
    // Any read proves the key: with a wrong one SQLite reports "file is not
    // a database" rather than handing back an empty schema.
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    tune(db);
    migrate(db, migrations);
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    throw asOpenError(err);
  }
  protect(path);
  return db;
}

/** Bytes on disk, including the write-ahead log. */
export function databaseBytes(path: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { total += statSync(`${path}${suffix}`).size; } catch { /* missing */ }
  }
  return total;
}
