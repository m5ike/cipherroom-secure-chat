// @vitest-environment node
// 6.12 (F-18, G-07): functions.db and telephony.db at rest. A new database is
// SQLCipher under a subkey of the storage master key; a plain one from before
// is converted on the first start — verified, then the plain file is wiped
// (or kept as *.plain-backup with SERVICE_DB_PLAIN_BACKUP=1); without the
// master key it stays plain, with a warning.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDriver, sqliteDriver } from "../server/storage/db";
import { _resetMasterKeyForTests } from "../server/storage/keys";
import { _resetServiceDbStatesForTests, fileKind, openServiceDatabase, serviceDbStates } from "../server/storage/service-db";

const saved = { ...process.env };
let dir = "";

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5svcdb-"));
  process.env.STORAGE_DIR = join(dir, "storage");
  process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 9).toString("hex");
  delete process.env.SERVICE_DB_PLAIN_BACKUP;
  _resetMasterKeyForTests();
  _resetServiceDbStatesForTests();
});
afterEach(() => { process.env = { ...saved }; _resetMasterKeyForTests(); rmSync(dir, { recursive: true, force: true }); });

/** A plain database as 6.11 left it: WAL mode, rows still partly in the WAL. */
function plainDb(file: string, rows = 250): void {
  const Ctor = sqliteDriver()!;
  const db = new Ctor(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, inputs TEXT NOT NULL); CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO runs (id, inputs) VALUES (?, ?)");
  for (let i = 0; i < rows; i++) ins.run(`run_${i}`, JSON.stringify({ pan: "4111111111111111", i }));
  db.prepare("INSERT INTO kv (k, v) VALUES ('secret', 'PLAINTEXT-MARKER')").run();
  db.close();
}

describe("service databases at rest", () => {
  it("creates a new database encrypted", async () => {
    const file = join(dir, "functions.db");
    const db = (await openServiceDatabase(file, "functions"))!;
    db.exec("CREATE TABLE t (v TEXT)");
    db.prepare("INSERT INTO t VALUES ('PLAINTEXT-MARKER')").run();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    expect(fileKind(file)).toBe("encrypted");
    expect(readFileSync(file).includes("PLAINTEXT-MARKER")).toBe(false);
    expect(serviceDbStates()).toEqual([expect.objectContaining({ label: "functions", encrypted: true, warning: "" })]);
  });

  it("converts a plain database, keeps every row and wipes the plain file", async () => {
    const file = join(dir, "telephony.db");
    plainDb(file);
    expect(fileKind(file)).toBe("plain");
    const db = (await openServiceDatabase(file, "telephony"))!;
    expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 250 });
    expect(db.prepare("SELECT v FROM kv WHERE k = 'secret'").get()).toEqual({ v: "PLAINTEXT-MARKER" });
    db.close();
    expect(fileKind(file)).toBe("encrypted");
    expect(readFileSync(file).includes("PLAINTEXT-MARKER")).toBe(false);
    expect(readFileSync(file).includes("4111111111111111")).toBe(false);
    for (const leftover of [".plain-backup", ".encrypting", ".migrate-lock", "-journal"]) expect(existsSync(`${file}${leftover}`)).toBe(false);
    expect(serviceDbStates()[0]).toMatchObject({ label: "telephony", encrypted: true, migratedAt: expect.any(Number) });
    // The next start opens it as it is.
    _resetServiceDbStatesForTests();
    const again = (await openServiceDatabase(file, "telephony"))!;
    expect(again.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 250 });
    again.close();
    expect(serviceDbStates()[0].migratedAt).toBeUndefined();
  });

  it("keeps a plain backup only when the operator asks for one", async () => {
    process.env.SERVICE_DB_PLAIN_BACKUP = "1";
    const file = join(dir, "functions.db");
    plainDb(file, 10);
    (await openServiceDatabase(file, "functions"))!.close();
    expect(fileKind(file)).toBe("encrypted");
    expect(fileKind(`${file}.plain-backup`)).toBe("plain");
    expect(readFileSync(`${file}.plain-backup`).includes("PLAINTEXT-MARKER")).toBe(true);
  });

  it("two processes' worth of opens convert it once", async () => {
    const file = join(dir, "telephony.db");
    plainDb(file, 50);
    const [a, b] = await Promise.all([openServiceDatabase(file, "telephony"), openServiceDatabase(file, "telephony")]);
    expect(a!.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 50 });
    expect(b!.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 50 });
    a!.prepare("INSERT INTO runs (id, inputs) VALUES ('x', '{}')").run();
    expect(b!.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 51 });
    a!.close(); b!.close();
  });

  it("each database has its own key; another master key does not open it", async () => {
    const file = join(dir, "functions.db");
    (await openServiceDatabase(file, "functions"))!.close();
    // Same master key, the other label's subkey: refused.
    await expect(openServiceDatabase(file, "telephony")).rejects.toThrow(/does not open with the key/);
    process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 1).toString("hex");
    _resetMasterKeyForTests();
    await expect(openServiceDatabase(file, "functions")).rejects.toThrow(/does not open with the key/);
    expect(fileKind(file)).toBe("encrypted");
  });

  it("without the master key a database stays plain, with a warning", async () => {
    process.env.STORAGE_MASTER_KEY = "not-a-key";
    _resetMasterKeyForTests();
    const file = join(dir, "functions.db");
    plainDb(file, 5);
    const db = (await openServiceDatabase(file, "functions"))!;
    expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 5 });
    db.close();
    expect(fileKind(file)).toBe("plain");
    expect(serviceDbStates()[0]).toMatchObject({ encrypted: false, warning: expect.stringMatching(/NOT encrypted at rest/) });
  });

  it("a stale lock of a process that is gone does not block the start", async () => {
    const file = join(dir, "functions.db");
    plainDb(file, 3);
    writeFileSync(`${file}.migrate-lock`, JSON.stringify({ pid: 2_147_483_000, at: Date.now() }));
    const db = (await openServiceDatabase(file, "functions"))!;
    expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 3 });
    db.close();
    expect(existsSync(`${file}.migrate-lock`)).toBe(false);
  });
});

describe("the stores on top", () => {
  it("functions.db of 6.11 keeps its packages after the upgrade", async () => {
    const file = join(dir, "functions.db");
    process.env.FUNCTIONS_DB_FILE = file;
    const Ctor = sqliteDriver()!;
    const old = new Ctor(file);
    old.pragma("journal_mode = WAL");
    old.exec(`CREATE TABLE packages (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, language TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      draft TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '')`);
    old.prepare("INSERT INTO packages (id, name, language, description, created_at, updated_at) VALUES ('pkg_1', 'weather', 'js', 'from 6.11', 1, 1)").run();
    old.close();
    const { functionsStore } = await import("../server/functions/store");
    await functionsStore.ready();
    expect(functionsStore.status()).toMatchObject({ persistent: true, encrypted: true, warning: "" });
    expect(functionsStore.packageByName("weather")).toMatchObject({ id: "pkg_1", description: "from 6.11" });
    expect(fileKind(file)).toBe("encrypted");
  });
});
