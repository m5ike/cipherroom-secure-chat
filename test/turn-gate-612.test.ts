// @vitest-environment node
// 6.12 (F-28): /api/turn gives TURN credentials only to an address that holds
// a live hub connection; anyone else gets STUN alone, marked pending with an
// expiry of "now" (the web client asks again before its next call). Plus a
// per-address limit. TURN_REQUIRE_HUB=0 restores the old behaviour.

import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.hoisted(() => {
  const base = process.env.TMPDIR?.replace(/\/$/, "") || "/tmp";
  process.env.ACCOUNTS_DIR = `${base}/m5cet-turngate-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = process.env.ACCOUNTS_DIR;
  process.env.TURN_SERVER_URL = "turn:turn.example.org:3478";
  process.env.TURN_SECRET = "test-turn-secret-not-real";
  process.env.TURN_RATE_LIMIT = "5";
});

import express from "express";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage/service";
import { mayGetTurn, pendingTurnAnswer, turnRateLimit } from "../server/turn-gate";
import { traffic } from "../server/monitor/traffic";
import { turnAnswer, type TurnAnswer } from "../server/turn";

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
  for (const k of ["TURN_SERVER_URL", "TURN_SECRET", "TURN_RATE_LIMIT", "TURN_REQUIRE_HUB"]) delete process.env[k];
});
afterEach(() => { delete process.env.TURN_REQUIRE_HUB; });

const turn = async () => { const r = await fetch(`${base}/api/turn`); return { status: r.status, body: await r.json() as TurnAnswer & { pending?: boolean } }; };
const hasTurn = (a: TurnAnswer) => a.iceServers.some((s) => s.username && s.credential);

describe("the TURN gate", () => {
  it("STUN only (pending, expiring now) without a hub connection; TURN once the address holds one", async () => {
    const before = await turn();
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ ok: true, configured: true, pending: true, ttlSeconds: 0 });
    expect(hasTurn(before.body)).toBe(false);
    expect(before.body.iceServers.length).toBeGreaterThan(0);
    expect(before.body.expiresAt).toBeLessThanOrEqual(Date.now());

    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    try {
      const after = await turn();
      expect(after.body.pending).toBeUndefined();
      expect(after.body.mode).toBe("ephemeral");
      expect(hasTurn(after.body)).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("TURN_REQUIRE_HUB=0 answers as before", () => {
    process.env.TURN_REQUIRE_HUB = "0";
    expect(mayGetTurn("198.51.100.1", () => false)).toBe(true);
    delete process.env.TURN_REQUIRE_HUB;
    expect(mayGetTurn("198.51.100.1", () => false)).toBe(false);
  });

  it("matches the exact address the hub saw (IPv4-mapped too)", () => {
    const conn = traffic.openConnection({ ip: "::ffff:203.0.113.5" });
    try {
      expect(traffic.hasLiveConnectionFrom("203.0.113.5")).toBe(true);
      expect(traffic.hasLiveConnectionFrom("203.0.113.6")).toBe(false);
      expect(traffic.addressOf(conn.id)).toBe("203.0.113.5");
      // The monitor's own view keeps only the network.
      expect(conn.ip).toBe("203.0.113.0/24");
    } finally { traffic.closeConnection(conn.id); }
    expect(traffic.hasLiveConnectionFrom("203.0.113.5")).toBe(false);
  });

  it("the pending answer never carries credentials", () => {
    const full = turnAnswer() as TurnAnswer;
    expect(hasTurn(full)).toBe(true);
    const p = pendingTurnAnswer(full, 1000);
    expect(hasTurn(p)).toBe(false);
    expect(p.iceServers.every((s) => !JSON.stringify(s.urls).includes("turn:"))).toBe(true);
    expect(p).toMatchObject({ pending: true, expiresAt: 1000 });
  });

  it("limits requests per address", async () => {
    expect(turnRateLimit()).toBe(5);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch(`${base}/api/turn`)).status);
    expect(statuses).toContain(429);
  });
});
