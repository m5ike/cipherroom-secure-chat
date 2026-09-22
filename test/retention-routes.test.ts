// @vitest-environment node
//
// Retention in the main service: the operator routes need the admin token;
// a sweep deletes each category by ITS OWN cutoff (settings used to be
// purged with the `data` cutoff); expired events leave the ring; and the
// unref'd timer sweeps on its own.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Before the modules below read their env at import time: distinct
// settings / data windows (to catch a mixed-up cutoff) and event logging on.
vi.hoisted(() => {
  process.env.SETTINGS_RETENTION_DAYS = "10";
  process.env.DATA_RETENTION_DAYS = "40";
  process.env.AUDIT_RETENTION_DAYS = "60";
  process.env.PUSH_RETENTION_DAYS = "90";
  process.env.EVENT_RETENTION_DAYS = "7";
  process.env.LOG_EVENTS = "1";
});

import express from "express";
import type { AddressInfo } from "node:net";
import { registerRetentionRoutes, startRetentionSchedule, sweepNow } from "../server/retention-routes";
import { consentLedger, deviceAuditLog, deviceSettings } from "../server/device-state";
import { pushSubscriptions } from "../server/routes-admin-shared";
import { eventStore } from "../server/events";
import { RETENTION, __resetRetentionForTests, getLastSweep, planRetention, retentionIntervalMs, startRetentionTimer } from "../server/retention";

const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "retention-op-token";

function seed(now: number) {
  deviceSettings.clear(); deviceAuditLog.clear(); consentLedger.clear(); pushSubscriptions.clear();
  // settings window 10 d: 20 d old → expired (the old code used the 40 d data window and kept it)
  deviceSettings.set("set-old", { deviceId: "set-old", updatedAt: now - 20 * DAY, payload: {} });
  deviceSettings.set("set-new", { deviceId: "set-new", updatedAt: now - 2 * DAY, payload: {} });
  // audit window 60 d
  deviceAuditLog.set("dev-a", [{ kind: "x", at: now - 70 * DAY }, { kind: "y", at: now - 1 * DAY }]);
  deviceAuditLog.set("dev-b", [{ kind: "z", at: now - 80 * DAY }]);
  // push window 90 d
  pushSubscriptions.set("p-old", { endpoint: "https://push.example/old", createdAt: now - 100 * DAY });
  pushSubscriptions.set("p-new", { endpoint: "https://push.example/new", createdAt: now - 1 * DAY });
  // consent window = data 40 d: 20 d old → kept, 50 d old → expired
  consentLedger.set("c-mid", { deviceId: "c-mid", analyticsConsent: true, updatedAt: now - 20 * DAY });
  consentLedger.set("c-old", { deviceId: "c-old", analyticsConsent: false, updatedAt: now - 50 * DAY });
}

function seedEvents(now: number) {
  eventStore.pruneOlderThan(Number.POSITIVE_INFINITY); // empty the ring
  vi.setSystemTime(now - 30 * DAY);
  eventStore.record({ kind: "old-one" });
  eventStore.record({ kind: "old-two" });
  vi.setSystemTime(now - 1 * DAY);
  eventStore.record({ kind: "recent" });
  vi.setSystemTime(now);
}

describe("retention policy", () => {
  it("reads distinct windows per category", () => {
    expect(RETENTION).toMatchObject({ settings: 10, data: 40, audit: 60, push: 90, event: 7 });
  });
  it("planRetention counts settings by the settings window, consent by the data window", () => {
    const now = Date.now();
    const plan = planRetention({
      deviceSettings: [{ deviceId: "a", updatedAt: now - 20 * DAY }],
      consentLedger: [{ deviceId: "b", updatedAt: now - 20 * DAY }],
    }, now);
    expect(plan.removed.deviceSettings).toBe(1);
    expect(plan.removed.consentRecords).toBe(0);
  });
});

describe("sweep", () => {
  beforeEach(() => { vi.useFakeTimers(); __resetRetentionForTests(); });
  afterEach(() => { vi.useRealTimers(); });

  it("deletes each category by its own cutoff and prunes expired events from the ring", () => {
    const now = Date.UTC(2026, 8, 22, 12);
    vi.setSystemTime(now);
    seed(now);
    seedEvents(now);
    const r = sweepNow(now, "manual");
    expect(r.removed).toEqual({ deviceSettings: 1, auditEntries: 2, pushSubscriptions: 1, consentRecords: 1, events: 2 });
    expect([...deviceSettings.keys()]).toEqual(["set-new"]);
    expect(deviceAuditLog.get("dev-a")?.map((e) => e.kind)).toEqual(["y"]);
    expect(deviceAuditLog.has("dev-b")).toBe(false); // emptied logs are dropped
    expect([...pushSubscriptions.keys()]).toEqual(["p-new"]);
    expect([...consentLedger.keys()]).toEqual(["c-mid"]);
    const kinds = eventStore.recent(500).map((e) => e.kind);
    expect(kinds).not.toContain("old-one");
    expect(kinds).toContain("recent");
    expect(kinds).toContain("retention-sweep"); // the sweep itself is logged
    expect(getLastSweep()).toMatchObject({ total: 7, trigger: "manual" });
  });

  it("runs on its own on the (unref'd) timer", () => {
    const now = Date.UTC(2026, 8, 22, 12);
    vi.setSystemTime(now);
    seed(now);
    const stop = startRetentionSchedule(60_000);
    expect(startRetentionSchedule(60_000)).toBe(stop); // one schedule per process
    expect(deviceSettings.has("set-old")).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(deviceSettings.has("set-old")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(deviceSettings.has("set-old")).toBe(false);
    expect(pushSubscriptions.has("p-old")).toBe(false);
    expect(getLastSweep()).toMatchObject({ trigger: "timer" });
    // Data that ages past its window later is caught by a later tick.
    deviceSettings.set("ages", { deviceId: "ages", updatedAt: Date.now() - 9.99 * DAY, payload: {} });
    vi.advanceTimersByTime(60_000);
    expect(deviceSettings.has("ages")).toBe(true);
    vi.setSystemTime(Date.now() + 1 * DAY);
    vi.advanceTimersByTime(60_000);
    expect(deviceSettings.has("ages")).toBe(false);
    stop();
    deviceSettings.set("after-stop", { deviceId: "after-stop", updatedAt: 0, payload: {} });
    vi.advanceTimersByTime(10 * 60_000);
    expect(deviceSettings.has("after-stop")).toBe(true);
  });

  it("interval comes from RETENTION_SWEEP_MINUTES (default 60, clamped)", () => {
    const saved = process.env.RETENTION_SWEEP_MINUTES;
    delete process.env.RETENTION_SWEEP_MINUTES;
    expect(retentionIntervalMs()).toBe(60 * 60_000);
    process.env.RETENTION_SWEEP_MINUTES = "0.1";
    expect(retentionIntervalMs()).toBe(60_000);
    process.env.RETENTION_SWEEP_MINUTES = "99999";
    expect(retentionIntervalMs()).toBe(24 * 60 * 60_000);
    if (saved === undefined) delete process.env.RETENTION_SWEEP_MINUTES; else process.env.RETENTION_SWEEP_MINUTES = saved;
  });
});

describe("timer handle", () => {
  it("is unref'd: the sweep never keeps the process alive on its own", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const stop = startRetentionTimer(() => {}, 60_000);
    const handle = spy.mock.results[0]?.value as { hasRef?: () => boolean };
    expect(typeof handle?.hasRef).toBe("function");
    expect(handle.hasRef!()).toBe(false);
    stop();
    spy.mockRestore();
  });
});

describe("operator routes", () => {
  let base = "";
  let close: (() => void) | null = null;
  const saved = process.env.ADMIN_API_TOKEN;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    registerRetentionRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    close?.(); close = null;
    if (saved === undefined) delete process.env.ADMIN_API_TOKEN; else process.env.ADMIN_API_TOKEN = saved;
  });

  const get = (auth?: string) => fetch(`${base}/api/admin/retention`, { headers: auth ? { Authorization: auth } : {} });
  const run = (auth?: string) => fetch(`${base}/api/admin/retention/run`, { method: "POST", headers: auth ? { Authorization: auth } : {} });

  it("503 while no ADMIN_API_TOKEN is configured — and nothing is deleted", async () => {
    delete process.env.ADMIN_API_TOKEN;
    seed(Date.now());
    expect((await get("Bearer x")).status).toBe(503);
    expect((await run("Bearer x")).status).toBe(503);
    expect(deviceSettings.has("set-old")).toBe(true);
  });

  it("401 without or with a wrong token — and nothing is deleted", async () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    seed(Date.now());
    expect((await get()).status).toBe(401);
    expect((await run()).status).toBe(401);
    expect((await run("Bearer nope")).status).toBe(401);
    expect((await run(TOKEN)).status).toBe(401); // "Bearer " prefix required
    expect(deviceSettings.has("set-old")).toBe(true);
  });

  it("with the token: policy + schedule, and a sweep that deletes", async () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    seed(Date.now());
    const g = await get(`Bearer ${TOKEN}`);
    expect(g.status).toBe(200);
    const gj = await g.json() as { policy: typeof RETENTION; intervalMinutes: number };
    expect(gj.policy).toEqual(RETENTION);
    expect(gj.intervalMinutes).toBeGreaterThan(0);
    const r = await run(`Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    const rj = await r.json() as { ok: boolean; removed: Record<string, number>; trigger: string };
    expect(rj.ok).toBe(true);
    expect(rj.trigger).toBe("manual");
    expect(rj.removed.deviceSettings).toBe(1);
    expect(deviceSettings.has("set-old")).toBe(false);
    const after = await (await get(`Bearer ${TOKEN}`)).json() as { lastSweep: { trigger: string } | null };
    expect(after.lastSweep?.trigger).toBe("manual");
  });
});
