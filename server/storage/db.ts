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

import { chmodSync, mkdirSync, statSync } from "node:fs";
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

export class StorageUnavailableError extends Error {}

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
      throw new Error(`migration ${migration.name} failed: ${(err as Error).message}`);
    }
  }
  return ran;
}

export function openPlainDatabase(path: string, migrations: Migration[]): SqliteDatabase {
  const Ctor = sqliteDriver();
  if (!Ctor) throw new StorageUnavailableError(loadError ?? "SQLite driver not installed");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Ctor(path, { timeout: 5000 });
  tune(db);
  migrate(db, migrations);
  protect(path);
  return db;
}

/**
 * Opens (or creates) an encrypted database. A wrong key fails here, when the
 * first read touches the header — never silently as empty data.
 */
export function openUserDatabase(path: string, key: Buffer, migrations: Migration[]): SqliteDatabase {
  const Ctor = sqliteDriver();
  if (!Ctor) throw new StorageUnavailableError(loadError ?? "SQLite driver not installed");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Ctor(path, { timeout: 5000 });
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
    throw err;
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
