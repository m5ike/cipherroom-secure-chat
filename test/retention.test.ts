import { describe, it, expect } from "vitest";
import { planRetention, RETENTION, __resetRetentionForTests } from "../server/retention";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number, base = Date.now()): number {
  return base - days * MS_PER_DAY;
}

describe("planRetention", () => {
  __resetRetentionForTests();

  it("counts only stale settings", () => {
    const now = Date.now();
    const plan = planRetention({
      deviceSettings: [
        { deviceId: "fresh-A", updatedAt: now },
        { deviceId: "fresh-B", updatedAt: now - RETENTION.settings * MS_PER_DAY + 60_000 }, // ~59 minutes inside the window
        { deviceId: "stale-C", updatedAt: daysAgo(RETENTION.settings + 1, now) },
      ],
    }, now);
    expect(plan.removed.deviceSettings).toBe(1);
  });

  it("counts all stale categories", () => {
    const now = Date.now();
    const chain = daysAgo(1000, now);
    const plan = planRetention({
      deviceSettings: [{ deviceId: "d1", updatedAt: chain }],
      deviceAuditLog: [{ deviceId: "d2", entries: [{ at: chain }, { at: chain + 1000 }, { at: now }] }],
      pushSubscriptions: [{ id: "p1", createdAt: chain }],
      consentLedger: [{ deviceId: "c1", updatedAt: chain }],
      events: [{ id: "e1", ts: chain }],
    }, now);
    expect(plan.removed.deviceSettings).toBe(1);
    expect(plan.removed.auditEntries).toBe(2); // two stale audit entries
    expect(plan.removed.pushSubscriptions).toBe(1);
    expect(plan.removed.consentRecords).toBe(1);
    expect(plan.removed.events).toBe(1);
  });

  it("returns zeros when nothing is stale", () => {
    const now = Date.now();
    const plan = planRetention({
      deviceSettings: [{ deviceId: "d1", updatedAt: now }],
      deviceAuditLog: [{ deviceId: "d2", entries: [{ at: now }] }],
      pushSubscriptions: [{ id: "p1", createdAt: now }],
      consentLedger: [{ deviceId: "c1", updatedAt: now }],
      events: [{ id: "e1", ts: now }],
    }, now);
    expect(plan.removed.deviceSettings).toBe(0);
    expect(plan.removed.auditEntries).toBe(0);
    expect(plan.removed.pushSubscriptions).toBe(0);
    expect(plan.removed.consentRecords).toBe(0);
    expect(plan.removed.events).toBe(0);
  });
});
