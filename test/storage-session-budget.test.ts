// @vitest-environment node
//
// Anonymous storage sessions cannot fill the disk (6.7, audit S7). Before:
// 16 MB per session, 30 new sessions per hour per client, 5000 live, no byte
// budget — one address could hold ~80 GB for a week. Now a client holds at
// most `liveSessionsPerClient` live sessions, and all session databases share
// a byte budget: when it is spent, no session starts and none grows.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StorageService, STORAGE_LIMITS, type StorageOptions } from "../server/storage/service";
import { QuotaExceededError, SessionLimitError } from "../server/storage/db";
import { _resetMasterKeyForTests } from "../server/storage/keys";

let dir = "";
let storage: StorageService;

async function start(options: StorageOptions = {}) {
  storage = new StorageService(join(dir, `s-${randomBytes(3).toString("hex")}`), options);
  expect((await storage.init()).ok).toBe(true);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-sbudget-"));
  _resetMasterKeyForTests();
  process.env.STORAGE_MASTER_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  storage?.close();
  delete process.env.STORAGE_MASTER_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("S7 — anonymous sessions are bounded per client and in bytes", () => {
  it("has sane defaults", () => {
    expect(STORAGE_LIMITS.liveSessionsPerClient).toBeGreaterThan(0);
    expect(STORAGE_LIMITS.liveSessionsPerClient).toBeLessThanOrEqual(STORAGE_LIMITS.sessionsPerClientPerHour);
    expect(STORAGE_LIMITS.sessionBudgetBytes).toBeGreaterThan(0);
  });

  it("a client holds at most liveSessionsPerClient live sessions; another client is not affected", async () => {
    await start({ limits: { liveSessionsPerClient: 3, sessionsPerClientPerHour: 100 } });
    for (let i = 0; i < 3; i++) storage.startSession(undefined, { clientKey: "203.0.113.0/24" });
    expect(() => storage.startSession(undefined, { clientKey: "203.0.113.0/24" })).toThrow(SessionLimitError);
    expect(storage.startSession(undefined, { clientKey: "198.51.100.0/24" }).sessionId).toMatch(/^sess-/);
  });

  it("a session that ends frees its client's slot", async () => {
    await start({ limits: { liveSessionsPerClient: 1, sessionsPerClientPerHour: 100 } });
    const s = storage.startSession(undefined, { clientKey: "c1" });
    expect(() => storage.startSession(undefined, { clientKey: "c1" })).toThrow(SessionLimitError);
    expect(storage.forget({ sessionId: s.sessionId }).removed).toBe(true);
    expect(storage.startSession(undefined, { clientKey: "c1" }).sessionId).toMatch(/^sess-/);
  });

  it("when the shared byte budget is spent, no session starts and an existing one cannot grow", async () => {
    await start({ limits: { sessionBudgetBytes: 256 * 1024, sessionsPerClientPerHour: 100, liveSessionsPerClient: 100 } });
    const a = storage.startSession(undefined, { clientKey: "a" });
    const db = storage.openSession(a.sessionId)!;
    // Fill past the budget (each value well under the per-value cap): the
    // budget is checked against the index, refreshed when a database is used.
    for (let i = 0; i < 12; i++) db.put(`k${i}`, { blob: randomBytes(24 * 1024).toString("base64") });
    db.checkpoint();
    storage.global.touchDatabase(a.databaseId);
    // The service caches the total for a few seconds; ask for a fresh one.
    expect(storage.sessionBytes(Date.now() + 10_000)).toBeGreaterThanOrEqual(256 * 1024);
    expect(() => db.put("more", { blob: randomBytes(24 * 1024).toString("base64") })).toThrow(QuotaExceededError);
    expect(() => storage.startSession(undefined, { clientKey: "b" })).toThrow(SessionLimitError);
    // Reading still works, and a write that does not grow the file is fine.
    expect(db.get("k0")).toBeTruthy();
  });
});
