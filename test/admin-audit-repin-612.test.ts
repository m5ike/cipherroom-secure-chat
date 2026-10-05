// @vitest-environment node
//
// 6.12 review S01: POST /api/admin/audit/repin — the owner's explicit re-pin of
// the audit journal (a lost audit-signing.pin is no longer re-created by itself).

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
  const base = process.env.TMPDIR?.replace(/\/$/, "") || "/tmp";
  process.env.ACCOUNTS_DIR = `${base}/m5cet-repin-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = process.env.ACCOUNTS_DIR;
  process.env.ADMIN_API_TOKEN = "admin-token-for-the-repin-test";
});

import express from "express";
import { createServer, type Server } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage/service";
import { audit } from "../server/monitor/audit";
import { storageDir } from "../server/storage/keys";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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

const admin = (path: string, init: { method?: string; body?: unknown } = {}) => fetch(`${base}${path}`, {
  method: init.method ?? "GET",
  headers: { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`, ...(init.body ? { "content-type": "application/json" } : {}) },
  ...(init.body ? { body: JSON.stringify(init.body) } : {}),
});

describe("POST /api/admin/audit/repin", () => {
  it("needs a confirmation, re-pins a journal whose pin was lost, and is audited", async () => {
    expect(storage.isAvailable).toBe(true);
    for (let i = 0; i < 5; i += 1) storage.global.appendAudit({ id: 0, at: Date.now(), category: "security", level: "info", event: `t.${i}` });
    storage.global.auditCheckpoint("test");
    const pin = join(storageDir(), "audit-signing.pin");
    expect(existsSync(pin)).toBe(true);
    rmSync(pin);
    storage.global.close();
    storage.global.open();
    const broken = await (await admin("/api/admin/audit/verify")).json() as { intact: boolean; problems: Array<{ kind: string }> };
    expect(broken.intact).toBe(false);
    expect(broken.problems.map((p) => p.kind)).toContain("pin-missing");

    expect((await admin("/api/admin/audit/repin", { method: "POST", body: {} })).status).toBe(400);
    const res = await admin("/api/admin/audit/repin", { method: "POST", body: { confirm: "repin" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, keys: 0, coverFrom: expect.any(Number) });
    expect(existsSync(pin)).toBe(true);
    const fixed = await (await admin("/api/admin/audit/verify")).json() as { intact: boolean };
    expect(fixed.intact).toBe(true);
    expect(audit.recent({ event: "admin.audit.repin", limit: 5 })).toHaveLength(1);
  });
});
