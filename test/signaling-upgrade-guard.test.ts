// @vitest-environment node
//
// Upgrade requests that never become a WebSocket (6.7, audit V3 and S3).
// V3: a handshake the ws library refuses (bad Sec-WebSocket-Key, version,
// method) or a client that leaves mid-handshake never reached the hub's
// callback, so the connection gate's slot was never returned — 20 bad
// handshakes locked an address out until a restart, 5000 the whole server.
// S3: an upgrade to a path nobody serves stayed open forever.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { WebSocket } from "ws";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { SignalingHub } from "../server/signaling/hub";
import { ConnectionGate } from "../server/signaling/limits";
import { claimUpgradePath } from "../server/upgrade-guard";

let dir = "";
let hub: SignalingHub;
let server: Server;
let port = 0;

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), "m5cet-upg-"));
  const store = new AccountStore(dir);
  const queue = new MemoryQueue();
  hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
    // Generous per minute, strict on concurrent slots: a leak shows at once.
    gate: new ConnectionGate({ perMinute: 1000, concurrentPerClient: 5, concurrentTotal: 50 }),
  });
  server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await hub.shutdown();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/** Sends a raw upgrade request; resolves with the status line and whether the server closed the socket. */
function rawUpgrade(path: string, headers: Record<string, string>, waitMs = 1500): Promise<{ status: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = netConnect(port, "127.0.0.1");
    let data = "";
    let done = false;
    const end = (closed: boolean) => { if (done) return; done = true; s.destroy(); resolve({ status: data.split("\r\n")[0] ?? "", closed }); };
    s.on("data", (d) => { data += d.toString("latin1"); });
    s.on("close", () => end(true));
    s.on("error", () => end(true));
    setTimeout(() => end(false), waitMs);
    s.on("connect", () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      s.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
  });
}

function open(): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once("open", () => { ws.close(); resolve(101); });
    ws.once("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.once("error", () => undefined);
  });
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe("V3 — a failed handshake gives its gate slot back", () => {
  it("25 handshakes with a bad key leave no slot taken, and a real client still connects", async () => {
    for (let i = 0; i < 25; i++) {
      const r = await rawUpgrade("/ws", { "Sec-WebSocket-Key": "x", "Sec-WebSocket-Version": "13" });
      expect(r.status).toMatch(/^HTTP\/1\.1 400/);
    }
    await until(() => hub.gate.stats().total === 0);
    expect(hub.gate.stats()).toEqual({ total: 0, clients: 0 });
    expect(await open()).toBe(101);
  });

  it("a wrong version or method is refused without keeping a slot", async () => {
    for (let i = 0; i < 8; i++) {
      await rawUpgrade("/ws", { "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "99" });
    }
    await until(() => hub.gate.stats().total === 0);
    expect(hub.gate.stats().total).toBe(0);
    expect(await open()).toBe(101);
  });

  it("a client that leaves mid-handshake does not keep a slot", async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((resolve) => {
        const s = netConnect(port, "127.0.0.1", () => {
          s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
          s.destroy();
          resolve();
        });
      });
    }
    await until(() => hub.gate.stats().total === 0);
    expect(hub.gate.stats().total).toBe(0);
    expect(await open()).toBe(101);
  });

  it("an open socket still holds its slot until it closes", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.once("open", r));
    expect(hub.gate.stats().total).toBe(1);
    ws.close();
    await until(() => hub.gate.stats().total === 0);
    expect(hub.gate.stats().total).toBe(0);
  });
});

describe("S3 — an upgrade to a path nobody serves is closed", () => {
  it("answers 404 and closes the socket instead of leaving it open", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => rawUpgrade("/not-ws", { "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" })));
    for (const r of results) {
      expect(r.closed).toBe(true);
      expect(r.status).toMatch(/^HTTP\/1\.1 404/);
    }
    expect(hub.gate.stats().total).toBe(0);
  });

  it("a malformed URL is closed too, and a claimed path is left to its owner", async () => {
    expect((await rawUpgrade("//[bad", {})).closed).toBe(true);
    // Another endpoint on the same server keeps its sockets.
    let seen = 0;
    claimUpgradePath(server, /^\/other\//);
    server.on("upgrade", (req, socket) => {
      if (req.url?.startsWith("/other/")) { seen++; socket.write("HTTP/1.1 418 I'm a teapot\r\nConnection: close\r\n\r\n"); socket.end(); }
    });
    const r = await rawUpgrade("/other/x", {});
    expect(seen).toBe(1);
    expect(r.status).toMatch(/^HTTP\/1\.1 418/);
    expect(await open()).toBe(101);
  });
});
