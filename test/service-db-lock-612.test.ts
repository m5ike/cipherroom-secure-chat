// @vitest-environment node
//
// 6.12 review S12 — converting a plain service database (service-db.ts) while
// the main and the admin service start together: the migration lock names its
// holder (pid, host, token) and is stale only when its process is gone, when
// it is a previous run's with our own pid (a restarted container's PID 1), or
// when it is old; a stale lock is taken over atomically; the conversion holds
// the plain database's write lock until the swap and swaps only while it
// still holds the lock file — never two converters, no commit lost; files
// that may hold plaintext are wiped before they go.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDriver, sqliteDriver } from "../server/storage/db";
import { _resetMasterKeyForTests, derivedKey } from "../server/storage/keys";
import { _resetServiceDbStatesForTests, _setLockWaitForTests, encryptPlainDatabase, fileKind, lockIsStale, openServiceDatabase } from "../server/storage/service-db";

const saved = { ...process.env };
let dir = "";

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5svclock-"));
  process.env.STORAGE_DIR = join(dir, "storage");
  process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 19).toString("hex");
  delete process.env.SERVICE_DB_PLAIN_BACKUP;
  _resetMasterKeyForTests();
  _resetServiceDbStatesForTests();
  _setLockWaitForTests(120_000, 100);
});
afterEach(() => { process.env = { ...saved }; _resetMasterKeyForTests(); _setLockWaitForTests(120_000, 100); rmSync(dir, { recursive: true, force: true }); });

function plainDb(file: string, rows = 50): void {
  const Ctor = sqliteDriver()!;
  const db = new Ctor(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, inputs TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO runs (id, inputs) VALUES (?, ?)");
  for (let i = 0; i < rows; i++) ins.run(`run_${i}`, `PLAINTEXT-${i}`);
  db.close();
}

const self = { pid: 4242, host: "this-host", token: "tok", alive: (pid: number) => pid === 777 };

describe("lockIsStale", () => {
  it("decides by the holder's process, its token and the file's age", () => {
    // Another live process here: respected (however long it takes, up to the stale age).
    expect(lockIsStale({ pid: 777, host: "this-host", token: "x.1" }, 5_000, self)).toBe(false);
    // A process that is gone.
    expect(lockIsStale({ pid: 778, host: "this-host", token: "x.1" }, 5_000, self)).toBe(true);
    // Our own pid: another open of this very process (our token) — or a previous run's (a restarted container's PID 1).
    expect(lockIsStale({ pid: 4242, host: "this-host", token: "tok.abc" }, 5_000, self)).toBe(false);
    expect(lockIsStale({ pid: 4242, host: "this-host", token: "old.abc" }, 5_000, self)).toBe(true);
    expect(lockIsStale({ pid: 4242, at: 1 }, 5_000, self)).toBe(true); // a lock of before the review, our pid
    // Another host (a container on the same volume): only the age.
    expect(lockIsStale({ pid: 778, host: "other", token: "y.1" }, 5_000, self)).toBe(false);
    expect(lockIsStale({ pid: 778, host: "other", token: "y.1" }, 11 * 60_000, self)).toBe(true);
    // Old, even if a process of that pid lives (a pid reused after a reboot).
    expect(lockIsStale({ pid: 777, host: "this-host", token: "x.1" }, 11 * 60_000, self)).toBe(true);
    // Being written / unreadable: stale only after 30 s.
    expect(lockIsStale(null, 5_000, self)).toBe(false);
    expect(lockIsStale(null, 31_000, self)).toBe(true);
  });
});

describe("the migration lock", () => {
  it("a lock a previous run left with our own pid (container restart) does not make the start wait", async () => {
    const file = join(dir, "functions.db");
    plainDb(file, 5);
    writeFileSync(`${file}.migrate-lock`, JSON.stringify({ pid: process.pid, host: hostname(), token: "previous-run.1", at: Date.now() }));
    _setLockWaitForTests(1_000);
    const started = Date.now();
    const db = (await openServiceDatabase(file, "functions"))!;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 5 });
    db.close();
    expect(fileKind(file)).toBe("encrypted");
    expect(existsSync(`${file}.migrate-lock`)).toBe(false);
  });

  it("a live process's lock is respected; once it is gone the next start converts", async () => {
    const file = join(dir, "telephony.db");
    plainDb(file, 7);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      writeFileSync(`${file}.migrate-lock`, JSON.stringify({ pid: holder.pid, host: hostname(), token: "other-process.1", at: Date.now() }));
      _setLockWaitForTests(300);
      await expect(openServiceDatabase(file, "telephony")).rejects.toThrow(/held by another process/);
      expect(fileKind(file)).toBe("plain");
    } finally {
      holder.kill("SIGKILL");
      await new Promise((r) => holder.once("exit", r));
    }
    const db = (await openServiceDatabase(file, "telephony"))!;
    expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 7 });
    db.close();
  });

  it("another host's lock waits for its age; an old one is taken over", async () => {
    const file = join(dir, "functions.db");
    plainDb(file, 3);
    const lock = `${file}.migrate-lock`;
    writeFileSync(lock, JSON.stringify({ pid: 1, host: "some-other-container", token: "c.1", at: Date.now() }));
    _setLockWaitForTests(300);
    await expect(openServiceDatabase(file, "functions")).rejects.toThrow(/held by another process \(pid 1 on some-other-container\)/);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(lock, old, old);
    const db = (await openServiceDatabase(file, "functions"))!;
    expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 3 });
    db.close();
    expect(existsSync(lock)).toBe(false);
  });
});

describe("the conversion", () => {
  it("holds the plain database's write lock until the swap: nobody commits a row the swap would lose", () => {
    const file = join(dir, "telephony.db");
    plainDb(file, 20);
    const Ctor = sqliteDriver()!;
    let refused = "";
    const counts = encryptPlainDatabase(Ctor, file, derivedKey("service-db:telephony"), {
      beforeSwap: () => {
        const other = new Ctor(file, { timeout: 50 });
        try { other.prepare("INSERT INTO runs (id, inputs) VALUES ('late', '{}')").run(); } catch (err) { refused = String((err as { code?: string }).code ?? (err as Error).message); } finally { other.close(); }
      },
    });
    expect(refused).toMatch(/BUSY/);
    expect(counts).toEqual({ runs: 20 });
    expect(fileKind(file)).toBe("encrypted");
  });

  it("does not swap when the lock was lost (beforeSwap refuses): the plain file stays, the copy is wiped", () => {
    const file = join(dir, "functions.db");
    plainDb(file, 4);
    expect(() => encryptPlainDatabase(sqliteDriver()!, file, derivedKey("service-db:functions"), { beforeSwap: () => { throw new Error("lost the lock"); } })).toThrow(/lost the lock/);
    expect(fileKind(file)).toBe("plain");
    expect(existsSync(`${file}.encrypting`)).toBe(false);
    // The plain database still works (its write lock was released).
    const db = new (sqliteDriver()!)(file);
    db.prepare("INSERT INTO runs (id, inputs) VALUES ('after', '{}')").run();
    db.close();
  });

  it("a plaintext copy a crashed run left behind is wiped first", async () => {
    const file = join(dir, "functions.db");
    plainDb(file, 2);
    writeFileSync(`${file}.encrypting`, "PLAINTEXT-LEFTOVER");
    (await openServiceDatabase(file, "functions"))!.close();
    expect(existsSync(`${file}.encrypting`)).toBe(false);
    expect(readFileSync(file).includes("PLAINTEXT-")).toBe(false);
  });

  it("two processes starting together convert it once, and both open it", async () => {
    const file = join(dir, "telephony.db");
    plainDb(file, 300);
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const run = () => new Promise<{ ok: boolean; rows?: number; migrated?: boolean; error?: string }>((resolve, reject) => {
      execFile(tsx, [join(process.cwd(), "test", "helpers", "service-db-open.ts"), file, "telephony"], { env: { ...process.env }, timeout: 60_000 }, (err, stdout) => {
        if (err) return reject(err);
        // The last line is the result (the conversion logs a line before it).
        try { resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")); } catch { reject(new Error(`no JSON: ${stdout}`)); }
      });
    });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toMatchObject({ ok: true, rows: 300 });
    expect(b).toMatchObject({ ok: true, rows: 300 });
    expect([a.migrated, b.migrated].filter(Boolean)).toHaveLength(1);
    expect(fileKind(file)).toBe("encrypted");
    expect(existsSync(`${file}.migrate-lock`)).toBe(false);
  }, 90_000);
});
