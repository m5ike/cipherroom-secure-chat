// Service databases at rest (6.12, F-18 / G-07).
//
// functions.db (runs with their inputs and outputs, tokens, webhook logs) and
// telephony.db (numbers, SMS, transcripts, TSA sessions, the event log) were
// plain SQLite files. They are now SQLCipher databases like the users' ones,
// keyed with a subkey of the storage master key (keys.ts derivedKey) — one
// HKDF label per database, so the two never share a key:
//
//   functions.db   derivedKey("service-db:functions")
//   telephony.db   derivedKey("service-db:telephony")
//
// The main and the admin service both open them; they derive the same key
// from the same STORAGE_MASTER_KEY / storage.key.
//
// An existing plain database is converted on the first start after the
// upgrade, under a lock file both services respect:
//
//   1. the plain database is checkpointed and copied (VACUUM INTO) to
//      <file>.encrypting, which is then encrypted in place (PRAGMA rekey);
//   2. the copy is opened with the key, must pass integrity_check and hold
//      as many rows in every table as the original;
//   3. only then does it replace the plain file (rename). The plain file's
//      pages are overwritten with zeros before it goes — unless
//      SERVICE_DB_PLAIN_BACKUP=1, which keeps it as <file>.plain-backup (the
//      operator removes that once the upgrade is confirmed).
//
// A failed step leaves the plain file as it was (and is retried next start).
// Without the master key (storage off: an unreadable key file, a bad
// STORAGE_MASTER_KEY) the database stays plain as before, with a warning in
// the log, the console's overview and /api/admin/overview → health.security.

import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeSync, fsyncSync, chmodSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadSqliteDriver, type SqliteDatabase } from "./db";
import { derivedKey, keyToSqlcipher } from "./keys";

export type ServiceDbLabel = "functions" | "telephony";

export type ServiceDbState = {
  label: ServiceDbLabel;
  file: string;
  /** The database is SQLCipher-encrypted with its master-key subkey. */
  encrypted: boolean;
  /** This process converted a plain database (and when). */
  migratedAt?: number;
  /** Why it is not encrypted, or what went wrong (empty when all is well). */
  warning: string;
};

const states = new Map<ServiceDbLabel, ServiceDbState>();

/** What each service database of this process is (the overview and health read it). */
export function serviceDbStates(): ServiceDbState[] {
  return [...states.values()].map((s) => ({ ...s }));
}

const PLAIN_MAGIC = "SQLite format 3\u0000";

/** plain | encrypted | empty | missing — from the first bytes (and the WAL of an unwritten plain file). */
export function fileKind(file: string): "plain" | "encrypted" | "empty" | "missing" {
  if (!existsSync(file)) return "missing";
  let head = "";
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(16);
      const n = readSync(fd, buf, 0, 16, 0);
      head = buf.subarray(0, n).toString("latin1");
    } finally { closeSync(fd); }
  } catch { return "missing"; }
  if (head === PLAIN_MAGIC) return "plain";
  if (head.length === 0) {
    // A plain database in WAL mode may not have written its first page yet.
    try { if (statSync(`${file}-wal`).size > 0) return "plain"; } catch { /* no WAL */ }
    return "empty";
  }
  return "encrypted";
}

/* --------------------------------------------------------------- the lock */

const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 120_000;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A lock file next to the database, so the main and the admin service never convert it twice. */
async function withLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = `${file}.migrate-lock`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: { pid?: number; at?: number } = {};
      try { holder = JSON.parse(readFileSync(lock, "utf8")) as typeof holder; } catch { /* being written */ }
      const age = Date.now() - (Number(holder.at) || 0);
      const stale = (holder.pid !== undefined && !pidAlive(Number(holder.pid))) || (holder.at !== undefined && age > LOCK_STALE_MS);
      if (stale) { try { unlinkSync(lock); } catch { /* the other one took it */ } continue; }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`${lock} is held by another process (pid ${holder.pid ?? "?"}); remove it if no M5cet service is starting`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch { /* gone */ }
  }
}

/* ------------------------------------------------------------- migration */

type Driver = NonNullable<Awaited<ReturnType<typeof loadSqliteDriver>>>;

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function tableCounts(db: SqliteDatabase): Record<string, number> {
  const out: Record<string, number> = {};
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  for (const { name } of tables) {
    out[name] = Number((db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n);
  }
  return out;
}

function removeSiblings(file: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${file}${suffix}`, { force: true });
}

/** Overwrites what an open descriptor of a (just replaced) file holds with zeros. Best effort. */
function zeroFill(fd: number): void {
  try {
    const size = fstatSync(fd).size;
    const block = Buffer.alloc(Math.min(1 << 20, Math.max(1, size)));
    for (let pos = 0; pos < size; pos += block.length) writeSync(fd, block, 0, Math.min(block.length, size - pos), pos);
    fsyncSync(fd);
  } catch { /* the file is unlinked either way */ }
}

/**
 * Converts a plain database to an encrypted one (see the header). Returns
 * the row counts it verified. Throws — leaving the plain file untouched —
 * when any step fails.
 */
export function encryptPlainDatabase(Ctor: Driver, file: string, key: Buffer, opts: { keepBackup?: boolean } = {}): Record<string, number> {
  const tmp = `${file}.encrypting`;
  rmSync(tmp, { force: true });
  removeSiblings(tmp);
  // 1. A consistent, compact plain copy (the WAL included).
  const plain = new Ctor(file, { timeout: 5000 });
  let counts: Record<string, number>;
  try {
    try { plain.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* busy: VACUUM INTO still reads through the WAL */ }
    counts = tableCounts(plain);
    plain.exec(`VACUUM INTO ${sqlString(tmp)}`);
  } finally {
    plain.close();
  }
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  try {
    // 2. Encrypt the copy (rekey needs a rollback journal, not WAL).
    const copy = new Ctor(tmp, { timeout: 5000 });
    try {
      copy.pragma("journal_mode = DELETE");
      copy.pragma("cipher = 'sqlcipher'");
      copy.pragma(`rekey = "${keyToSqlcipher(key)}"`);
    } finally { copy.close(); }
    if (fileKind(tmp) !== "encrypted") throw new Error("the copy did not come out encrypted");
    // 3. Verify it with the key.
    const check = new Ctor(tmp, { timeout: 5000, fileMustExist: true });
    try {
      check.pragma("cipher = 'sqlcipher'");
      check.pragma(`key = "${keyToSqlcipher(key)}"`);
      const integrity = String(check.pragma("integrity_check", { simple: true }));
      if (integrity !== "ok") throw new Error(`integrity_check of the encrypted copy: ${integrity.slice(0, 200)}`);
      const after = tableCounts(check);
      for (const [table, n] of Object.entries(counts)) {
        if (after[table] !== n) throw new Error(`table ${table}: ${n} rows in the plain database, ${after[table] ?? "none"} in the encrypted copy`);
      }
    } finally { check.close(); }
  } catch (err) {
    rmSync(tmp, { force: true });
    removeSiblings(tmp);
    throw err;
  }
  // 4. Swap. The plain file's descriptor stays open so its pages can be wiped once it is unlinked.
  const fd = openSync(file, "r+");
  try {
    removeSiblings(file);
    if (opts.keepBackup) {
      const backup = `${file}.plain-backup`;
      rmSync(backup, { force: true });
      try { linkSync(file, backup); } catch { copyFileSync(file, backup); }
      try { chmodSync(backup, 0o600); } catch { /* ignore */ }
    }
    renameSync(tmp, file);
    if (!opts.keepBackup) zeroFill(fd);
  } finally {
    closeSync(fd);
  }
  return counts;
}

/* ------------------------------------------------------------------ open */

const keepBackup = () => process.env.SERVICE_DB_PLAIN_BACKUP === "1";

function warn(label: string, message: string): void {
  console.warn(`[${label}] ${message}`);
}

function tune(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
}

/**
 * Opens a service database: encrypted with its subkey (converting a plain
 * one first), or — without the master key — plain as before, with a warning.
 * Throws when the file cannot be opened (a wrong key: STORAGE_MASTER_KEY or
 * storage.key changed); the stores then keep their records in memory and
 * say why, as they did when SQLite itself was missing. Null without the
 * SQLite driver.
 */
export async function openServiceDatabase(file: string, label: ServiceDbLabel): Promise<SqliteDatabase | null> {
  const Ctor = await loadSqliteDriver();
  if (!Ctor) return null;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let key: Buffer | null = null;
  let reason = "";
  try { key = derivedKey(`service-db:${label}`); } catch (err) { reason = (err as Error).message; }

  if (!key) {
    if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
    try { chmodSync(file, 0o600); } catch { /* not ours */ }
    if (fileKind(file) === "encrypted") throw new Error(`${file} is encrypted, but the storage master key is unavailable (${reason})`);
    const db = new Ctor(file, { timeout: 5000 });
    try { tune(db); } catch (err) { db.close(); throw err; }
    const warning = `${label}.db is NOT encrypted at rest: the storage master key is unavailable (${reason})`;
    states.set(label, { label, file, encrypted: false, warning });
    warn(label, warning);
    return db;
  }

  let migratedAt: number | undefined;
  const kind = fileKind(file);
  if (kind !== "encrypted") {
    await withLock(file, () => {
      const now = fileKind(file);
      if (now === "plain") {
        const counts = encryptPlainDatabase(Ctor, file, key!, { keepBackup: keepBackup() });
        migratedAt = Date.now();
        const rows = Object.values(counts).reduce((a, b) => a + b, 0);
        console.log(`[${label}] ${file} was a plain SQLite file: encrypted with SQLCipher (${Object.keys(counts).length} tables, ${rows} rows verified)${keepBackup() ? `; the plain copy is kept as ${file}.plain-backup — delete it once the upgrade is confirmed` : "; the plain file was overwritten and removed"}.`);
      } else if (now === "missing" || now === "empty") {
        // A new database: written (salt and first page) before the lock goes,
        // so a second process never initializes the same file differently.
        if (now === "missing") closeSync(openSync(file, "a", 0o600));
        const db = new Ctor(file, { timeout: 5000 });
        try {
          db.pragma("cipher = 'sqlcipher'");
          db.pragma(`key = "${keyToSqlcipher(key!)}"`);
          db.exec("CREATE TABLE IF NOT EXISTS m5_service_db (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
          db.prepare("INSERT OR IGNORE INTO m5_service_db (k, v) VALUES ('created', ?)").run(String(Date.now()));
        } finally { db.close(); }
      }
    });
  }
  try { chmodSync(file, 0o600); } catch { /* not ours */ }
  const db = new Ctor(file, { timeout: 5000, fileMustExist: true });
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`key = "${keyToSqlcipher(key)}"`);
    // Any read proves the key (a wrong one: "file is not a database").
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    tune(db);
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    const code = String((err as { code?: unknown }).code ?? "");
    const message = code === "SQLITE_NOTADB"
      ? `${file} does not open with the key derived from the storage master key (was STORAGE_MASTER_KEY or storage.key changed?)`
      : (err as Error).message;
    states.set(label, { label, file, encrypted: true, warning: message });
    throw Object.assign(new Error(message), { code });
  }
  states.set(label, { label, file, encrypted: true, warning: "", ...(migratedAt ? { migratedAt } : {}) });
  return db;
}

/** Tests: forget what this process reported. */
export function _resetServiceDbStatesForTests(): void { states.clear(); }
