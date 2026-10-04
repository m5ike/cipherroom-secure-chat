// @vitest-environment node
//
// State that callers without an account can write (6.7, audit V4 and S9).
// V4: POST /api/settings kept any JSON up to the 256 kB body limit, for any
// number of device ids, in memory — ~5.6 MB of heap per request, an OOM from
// one address in an hour or two. Now: 16 kB per device as text, at most
// MAX_DEVICE_RECORDS devices (the oldest write goes), expired by retention.
// S9: POST /api/chat/message-audit took the actor ("guest:<client>") from the
// body and let a guest write 6000 journal rows a minute; the actor is now who
// the server knows, and each caller has an hourly budget of entries.

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.hoisted(() => {
  const base = process.env.TMPDIR?.replace(/\/$/, "") || "/tmp";
  process.env.ACCOUNTS_DIR = `${base}/m5cet-unauth-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = process.env.ACCOUNTS_DIR;
});

import express from "express";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage/service";
import { consentLedger, deviceSettings, getDeviceSettings, putConsent, putDeviceSettings, MAX_DEVICE_RECORDS, MAX_SETTINGS_BYTES } from "../server/device-state";
import { MESSAGE_AUDIT_BUDGET, resetMessageAuditBudgets, takeMessageAuditBudget } from "../server/message-audit";
import { audit } from "../server/monitor/audit";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  server = createServer(app);
  await registerRoutes(server, app);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  storage.close();
  rmSync(process.env.ACCOUNTS_DIR!, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("V4 — /api/settings is bounded", () => {
  beforeEach(() => { deviceSettings.clear(); consentLedger.clear(); });

  it("refuses a settings document over the size cap and keeps a normal one", async () => {
    const big = await post("/api/settings", { deviceId: "dev-big-1", settings: { blob: "x".repeat(64 * 1024) } });
    expect(big.status).toBe(413);
    expect(deviceSettings.has("dev-big-1")).toBe(false);
    // The amplifying shape from the audit ({} nested in arrays) is measured as text too.
    const nested = await post("/api/settings", { deviceId: "dev-big-2", settings: { a: Array.from({ length: 20_000 }, () => ({})) } });
    expect(nested.status).toBe(413);

    const ok = await post("/api/settings", { deviceId: "dev-ok-1", settings: { theme: "dark", lang: "cs" } });
    expect(ok.status).toBe(200);
    const got = await (await fetch(`${base}/api/settings?deviceId=dev-ok-1`)).json() as { settings: unknown };
    expect(got.settings).toEqual({ theme: "dark", lang: "cs" });
    // Stored as text: what the cap measures is what memory holds.
    expect(typeof deviceSettings.get("dev-ok-1")?.payload).toBe("string");
  });

  it("keeps at most MAX_DEVICE_RECORDS devices, dropping the oldest write", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_DEVICE_RECORDS + 50; i++) expect(putDeviceSettings(`dev-${i}`, { i }, now + i).ok).toBe(true);
    expect(deviceSettings.size).toBe(MAX_DEVICE_RECORDS);
    expect(deviceSettings.has("dev-0")).toBe(false);
    expect(deviceSettings.has(`dev-${MAX_DEVICE_RECORDS + 49}`)).toBe(true);
    // A device that writes again moves to the back of the line.
    putDeviceSettings("dev-60", { again: true }, now + MAX_DEVICE_RECORDS + 60);
    for (let i = 0; i < 100; i++) putDeviceSettings(`late-${i}`, {}, now + MAX_DEVICE_RECORDS + 100 + i);
    expect(deviceSettings.has("dev-60")).toBe(true);
    expect(deviceSettings.has("dev-61")).toBe(false);
    expect(MAX_SETTINGS_BYTES).toBeLessThanOrEqual(16 * 1024);
  });

  it("an expired record is gone on read, and consent records are bounded the same way", () => {
    const now = Date.now();
    putDeviceSettings("dev-old", { x: 1 }, now - 400 * 86_400_000);
    expect(getDeviceSettings("dev-old", now)).toBeNull();
    expect(deviceSettings.has("dev-old")).toBe(false);
    for (let i = 0; i < MAX_DEVICE_RECORDS + 10; i++) putConsent(`c-${i}`, true, now + i);
    expect(consentLedger.size).toBe(MAX_DEVICE_RECORDS);
  });
});

describe("S9 — the message audit journal", () => {
  beforeEach(() => resetMessageAuditBudgets());

  it("does not take the actor from the body", async () => {
    const res = await post("/api/chat/message-audit", { action: "delete", messageId: "spoof-1", room: "r", client: "admin" });
    expect(res.status).toBe(200);
    const entry = audit.recent({ category: "message" }).find((e) => (e.detail as { messageId?: string })?.messageId === "spoof-1");
    expect(entry?.actor).toBe("guest");
    expect(entry?.detail).toMatchObject({ claimedClient: "admin" });
  });

  it("a guest address has an hourly budget of entries", async () => {
    const batch = (n: number, from: number) => ({ actions: Array.from({ length: n }, (_, i) => ({ action: "hide", messageId: `flood-${from + i}`, room: "r", until: 0 })) });
    let recorded = 0;
    let status = 200;
    for (let i = 0; status === 200 && i < 20; i++) {
      const res = await post("/api/chat/message-audit", batch(50, i * 50));
      status = res.status;
      if (res.ok) recorded += ((await res.json()) as { recorded: number }).recorded;
    }
    expect(recorded).toBe(MESSAGE_AUDIT_BUDGET.guestPerHour);
    expect(status).toBe(429);
  });

  it("the budget is per caller and per hour", () => {
    const t = Date.now();
    expect(takeMessageAuditBudget("a", 10, 15, t)).toBe(10);
    expect(takeMessageAuditBudget("a", 10, 15, t)).toBe(5);
    expect(takeMessageAuditBudget("a", 1, 15, t)).toBe(0);
    expect(takeMessageAuditBudget("b", 3, 15, t)).toBe(3);
    expect(takeMessageAuditBudget("a", 4, 15, t + 60 * 60 * 1000)).toBe(4);
  });
});

describe("N10 — /metrics has a budget for refused requests", () => {
  it("wrong tokens are cut off after 30 attempts (it is outside /api's limiter)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer guess-${i}` } })).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });
});
