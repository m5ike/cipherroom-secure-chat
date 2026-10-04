// @vitest-environment node
// Timers do not take the process down (6.7, audit N7). The scheduled backup
// fired `void this.run()` and a bare `this.integrity()` from setInterval: a
// rejected backup became an unhandled rejection and a throwing integrity
// check (SQLITE_BUSY, a full disk) an uncaught exception — either ends Node.

import { describe, it, expect, afterEach, vi } from "vitest";
import { BackupManager } from "../server/storage/backup";
import type { StorageService } from "../server/storage/service";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete process.env.BACKUP_DIR; });

describe("N7 — the scheduled backup survives its own failures", () => {
  it("a failing backup and a throwing integrity check are reported, not thrown", async () => {
    process.env.BACKUP_DIR = "/nonexistent-m5cet-backup-test";
    const storage = { integrityCheck: () => { throw new Error("SQLITE_BUSY: database is locked"); } } as unknown as StorageService;
    const manager = new BackupManager(storage, "/nonexistent-m5cet-storage");
    vi.spyOn(manager, "run").mockRejectedValue(new Error("SQLITE_FULL: database or disk is full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    manager.start();
    expect(() => vi.advanceTimersByTime(manager.intervalHours * 60 * 60 * 1000 + 10)).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
    manager.stop();
    await Promise.resolve();
    expect(manager.run).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/integrity check failed[\s\S]*|scheduled backup failed/);
  });
});
