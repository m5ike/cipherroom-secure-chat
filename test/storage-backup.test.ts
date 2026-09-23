// @vitest-environment node
//
// Backups and integrity checks (server/storage/backup.ts): a consistent copy
// of the global database, the encrypted user databases as they are, a
// manifest with checksums, rotation — and never the master key.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageService } from "../server/storage/service";
import { BackupManager } from "../server/storage/backup";
import { loadSqliteDriver } from "../server/storage/db";
import { _resetMasterKeyForTests } from "../server/storage/keys";

let dir = "";
let storage: StorageService;
const saved = { ...process.env };

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-backup-"));
  process.env.DATA_DIR = dir;
  process.env.STORAGE_DIR = join(dir, "storage");
  process.env.BACKUP_DIR = join(dir, "backups");
  process.env.BACKUP_KEEP = "2";
  _resetMasterKeyForTests();
  storage = new StorageService(join(dir, "storage"));
  expect((await storage.init()).ok).toBe(true);
});
afterEach(() => { storage.close(); process.env = { ...saved }; _resetMasterKeyForTests(); rmSync(dir, { recursive: true, force: true }); });

describe("backups", () => {
  it("copies the databases with a manifest of checksums, without the master key", async () => {
    const session = storage.startSession();
    storage.openSession(session.sessionId)!.putMessages([{ id: "m1", room: "r", createdAt: 1, payload: { text: "hello" } }]);
    storage.log({ level: "info", source: "server", event: "test.line" });
    const manager = new BackupManager(storage, join(dir, "storage"));
    const result = await manager.run("test");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = JSON.parse(readFileSync(join(result.path, "manifest.json"), "utf8")) as { files: Array<{ path: string; sha256: string }> };
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining(["m5cet.db", expect.stringMatching(/^db\//)]));
    for (const f of manifest.files) {
      expect(createHash("sha256").update(readFileSync(join(result.path, f.path))).digest("hex")).toBe(f.sha256);
    }
    expect(readdirSync(result.path)).not.toContain("storage.key");
    // The user database is still encrypted in the copy.
    const userDb = manifest.files.find((f) => f.path.startsWith("db/"))!;
    expect(readFileSync(join(result.path, userDb.path)).subarray(0, 15).toString()).not.toBe("SQLite format 3");
  });

  it("keeps only the newest BACKUP_KEEP backups", async () => {
    const manager = new BackupManager(storage, join(dir, "storage"));
    for (let i = 0; i < 3; i++) expect((await manager.run(`n${i}`)).ok).toBe(true);
    expect(manager.list()).toHaveLength(2);
    expect(existsSync(join(dir, "backups"))).toBe(true);
  });

  it("checks the integrity of the global and the open databases", () => {
    const session = storage.startSession();
    storage.openSession(session.sessionId);
    const r = new BackupManager(storage, join(dir, "storage")).integrity();
    expect(r).toMatchObject({ ok: true, global: "ok" });
    expect(r.databases.length).toBeGreaterThanOrEqual(1);
  });
});
