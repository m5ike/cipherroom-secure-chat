// @vitest-environment node
//
// The global database (server/storage/global-store.ts): the audit journal
// table, the operator's inspection, transfer rows that belong to one owner,
// details sealed to their row, bounded tables and the orphan-file sweep.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StorageService } from "../server/storage/service";
import { _resetMasterKeyForTests } from "../server/storage/keys";
import type { AuditEntry } from "../server/monitor/audit";

const DAY = 24 * 60 * 60 * 1000;

let dir = "";
let storage: StorageService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-global-"));
  _resetMasterKeyForTests();
  process.env.STORAGE_MASTER_KEY = randomBytes(32).toString("base64");
  storage = new StorageService(dir);
  expect((await storage.init()).ok).toBe(true);
});

afterEach(() => {
  storage.close();
  delete process.env.STORAGE_MASTER_KEY;
  rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<AuditEntry>): AuditEntry => ({ id: 1, at: Date.now(), category: "security", level: "info", event: "test", ...over });

describe("the audit table", () => {
  it("appends entries and reads them back newest first, detail decrypted", () => {
    const now = Date.now();
    storage.global.appendAudit(entry({ at: now - 3_000, category: "account", level: "info", event: "account.sign-in", actor: "acc-alice", accountId: "acc-alice", ip: "198.51.100.7", status: "ok", detail: { note: "a sealed remark" } }));
    storage.global.appendAudit(entry({ at: now - 2_000, category: "security", level: "warn", event: "security.rate-limit", actor: "peer-9", peerId: "peer-9", bytes: 512, status: "rejected" }));
    storage.global.appendAudit(entry({ at: now - 1_000, category: "storage", level: "error", event: "storage.open-failed", target: "acc-alice", sessionId: "sess-abcdefghijklmnopqrstuv" }));

    const all = storage.global.readAudit({});
    expect(all.map((e) => e.event)).toEqual(["storage.open-failed", "security.rate-limit", "account.sign-in"]);
    expect(all[2]).toMatchObject({ category: "account", actor: "acc-alice", ip: "198.51.100.7", status: "ok", detail: { note: "a sealed remark" } });
    expect(all[1]).toMatchObject({ bytes: 512, peerId: "peer-9" });
    // The session id is stored as its reference, never in the clear.
    expect(all[0].sessionId).toMatch(/^sr-/);
    expect(all[0]).not.toHaveProperty("detail");

    // The detail is sealed on disk.
    expect(readFileSync(join(dir, "m5cet.db")).includes(Buffer.from("a sealed remark"))).toBe(false);
  });

  it("filters by category, level, actor, account, peer, event prefix, search and time", () => {
    const now = Date.now();
    const rows: Array<Partial<AuditEntry>> = [
      { at: now - 50_000, category: "account", level: "debug", event: "account.touch", actor: "acc-alice" },
      { at: now - 40_000, category: "account", level: "notice", event: "account.sign-out", actor: "acc-alice", target: "acc-bob" },
      { at: now - 30_000, category: "security", level: "warn", event: "security.bad-token", ip: "203.0.113.50", status: "401" },
      { at: now - 20_000, category: "communication", level: "info", event: "relay.stored", actor: "peer-1", target: "peer-2", peerId: "peer-1" },
      { at: now - 10_000, category: "admin", level: "error", event: "admin.command", actor: "admin@127.0.0.1", status: "failed_50%" },
    ];
    for (const row of rows) storage.global.appendAudit(entry(row));

    expect(storage.global.readAudit({ category: "account" })).toHaveLength(2);
    expect(storage.global.readAudit({ minLevel: "notice" }).map((e) => e.level)).toEqual(["error", "warn", "notice"]);
    expect(storage.global.readAudit({ minLevel: "warn" }).map((e) => e.event)).toEqual(["admin.command", "security.bad-token"]);
    expect(storage.global.readAudit({ actor: "acc-alice" })).toHaveLength(2);
    expect(storage.global.readAudit({ accountId: "acc-bob" }).map((e) => e.event)).toEqual(["account.sign-out"]);
    expect(storage.global.readAudit({ peerId: "peer-2" }).map((e) => e.event)).toEqual(["relay.stored"]);
    expect(storage.global.readAudit({ event: "account." })).toHaveLength(2);
    expect(storage.global.readAudit({ search: "203.0.113" }).map((e) => e.event)).toEqual(["security.bad-token"]);
    // LIKE wildcards in the needle are literal.
    expect(storage.global.readAudit({ search: "50%" }).map((e) => e.event)).toEqual(["admin.command"]);
    expect(storage.global.readAudit({ search: "relay_stored" })).toHaveLength(0);
    expect(storage.global.readAudit({ since: now - 25_000 })).toHaveLength(2);
    expect(storage.global.readAudit({ limit: 1 })).toHaveLength(1);
  });

  it("does not open a detail moved to another row", () => {
    const at = Date.now();
    storage.global.appendAudit(entry({ at, category: "admin", event: "admin.secret", detail: { token: "abc" } }));
    storage.global.appendAudit(entry({ at, category: "admin", event: "admin.other" }));
    const db = storage.global.handleForQueue();
    db.prepare("UPDATE audit SET detail = (SELECT detail FROM audit WHERE event = 'admin.secret') WHERE event = 'admin.other'").run();
    const read = storage.global.readAudit({ category: "admin" });
    expect(read.find((e) => e.event === "admin.secret")!.detail).toEqual({ token: "abc" });
    expect(read.find((e) => e.event === "admin.other")!.detail).toBeUndefined();
  });

  it("prunes by age and by count, and the hourly sweep does it too", () => {
    const now = Date.now();
    storage.global.appendAudit(entry({ at: now - 100 * DAY, event: "old" }));
    for (let i = 0; i < 5; i += 1) storage.global.appendAudit(entry({ at: now - i, event: `recent-${i}` }));
    expect(storage.global.pruneAudit(now - 90 * DAY, 3)).toBe(3);
    expect(storage.global.readAudit({}).map((e) => e.event)).toEqual(["recent-0", "recent-1", "recent-2"]);

    storage.global.appendAudit(entry({ at: now - 91 * DAY, event: "old-again" }));
    expect(storage.sweep(now, { audit: now - 90 * DAY }).audit).toBe(1);
  });
});

describe("inspect()", () => {
  it("describes the file, its pages and every table", () => {
    storage.global.upsertUser({ id: "acc-alice", userName: "Alice" });
    storage.log({ level: "info", source: "server", event: "hello" });
    const info = storage.global.inspect();
    expect(info.file).toBe(join(dir, "m5cet.db"));
    expect(info.bytes).toBeGreaterThan(0);
    expect(info.pageSize).toBeGreaterThan(0);
    expect(info.pageCount).toBeGreaterThan(0);
    expect(info.freelist).toBeGreaterThanOrEqual(0);
    expect(info.walBytes).toBeGreaterThanOrEqual(0);
    expect(info.journalMode).toBe("wal");
    const tables = Object.fromEntries(info.tables.map((t) => [t.name, t.rows]));
    expect(tables).toMatchObject({ users: 1, logs: 1, audit: 0, databases: 0, transfers: 0 });
  });
});

describe("transfers and logs", () => {
  it("keeps one row per owner: nobody can overwrite someone else's record", () => {
    const session = storage.startSession();
    storage.recordTransfer({ id: "xfer-1", at: Date.now(), direction: "out", transport: "p2p", status: "started", sessionId: session.sessionId, bytes: 10, detail: { name: "mine.bin" } });
    // Somebody else, same transfer id.
    storage.recordTransfer({ id: "xfer-1", at: Date.now(), direction: "in", transport: "proxy", status: "failed", accountId: "acc-mallory", bytes: 0, detail: { name: "theirs.bin" } });
    // The owner updates their own.
    storage.recordTransfer({ id: "xfer-1", at: Date.now(), direction: "out", transport: "p2p", status: "completed", sessionId: session.sessionId, bytes: 99 });

    const mine = storage.global.readTransfers({ sessionId: session.sessionId });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "completed", bytes: 99, detail: { name: "mine.bin" } });
    expect(mine[0].sessionId).toMatch(/^sr-/);
    expect(storage.global.readTransfers({ accountId: "acc-mallory" })[0]).toMatchObject({ status: "failed", detail: { name: "theirs.bin" } });
  });

  it("does not open a log detail moved to another row", () => {
    storage.log({ level: "warn", source: "client", event: "one", accountId: "acc-alice", detail: { secret: 1 } });
    storage.log({ level: "warn", source: "client", event: "two", accountId: "acc-bob" });
    storage.global.handleForQueue().prepare("UPDATE logs SET detail = (SELECT detail FROM logs WHERE event = 'one') WHERE event = 'two'").run();
    const logs = storage.global.readLogs({ level: "warn" });
    expect(logs.find((l) => l.event === "one")!.detail).toEqual({ secret: 1 });
    expect(logs.find((l) => l.event === "two")!.detail).toBeNull();
  });

  it("bounds logs and transfers by count as well as age", () => {
    for (let i = 0; i < 8; i += 1) {
      storage.log({ level: "info", source: "server", event: `line-${i}` });
      storage.recordTransfer({ id: `x-${i}`, at: Date.now(), direction: "out", transport: "p2p", status: "completed" });
    }
    expect(storage.global.pruneLogs(0, 5)).toBe(3);
    expect(storage.global.readLogs({ limit: 100 }).map((l) => l.event)).toEqual(["line-7", "line-6", "line-5", "line-4", "line-3"]);
    expect(storage.global.pruneTransfers(0, 2)).toBe(6);
    expect(storage.global.readTransfers().map((t) => t.id).sort()).toEqual(["x-6", "x-7"]);
  });
});

describe("files", () => {
  it("removes db files no index row knows, once they are an hour old", () => {
    const session = storage.startSession();
    storage.openSession(session.sessionId)!.put("x", 1);
    const known = storage.global.databasePath(storage.global.getDatabase(session.databaseId)!);

    const old = join(dir, "db", `db-${"a".repeat(24)}.db`);
    const fresh = join(dir, "db", `db-${"b".repeat(24)}.db`);
    const unrelated = join(dir, "db", "notes.txt");
    for (const path of [old, `${old}-wal`, fresh, unrelated]) writeFileSync(path, "x");
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    utimesSync(`${old}-wal`, twoHoursAgo, twoHoursAgo);

    expect(storage.sweep().orphans).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(`${old}-wal`)).toBe(false);
    expect(existsSync(fresh)).toBe(true);      // might be mid-creation
    expect(existsSync(unrelated)).toBe(true);  // not ours
    expect(existsSync(known)).toBe(true);
  });

  it("drops the index row before the file, so a failed delete leaves only an orphan", () => {
    const session = storage.startSession();
    storage.openSession(session.sessionId)!.put("x", 1);
    storage.forget({ sessionId: session.sessionId });
    expect(storage.global.getDatabase(session.databaseId)).toBeNull();
  });
});

describe("the offline queue", () => {
  it("lives in the global database, and forget() empties an account's share of it", () => {
    const queue = storage.queue()!;
    expect(queue).toBe(storage.queue());
    const from = { peerId: "peer-bob", name: "Bob" };
    queue.enqueue({ accountId: "acc-alice", room: "alpha", kind: "message", messageId: "m1", from, envelope: { iv: "aQ==", ciphertext: "Yw==" } });
    queue.enqueue({ accountId: "acc-carol", room: "alpha", kind: "message", messageId: "m1", from, envelope: { iv: "aQ==", ciphertext: "Yw==" } });
    expect(storage.global.inspect().tables.find((t) => t.name === "mail_queue")!.rows).toBe(2);

    storage.forget({ accountId: "acc-alice" });
    expect(queue.pending("acc-alice")).toHaveLength(0);
    expect(queue.pending("acc-carol")).toHaveLength(1);
  });
});
