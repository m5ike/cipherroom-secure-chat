// @vitest-environment node
//
// Protocol version 2 of the signaling socket (server/signaling/hub.ts):
// who may take which peer id, what the upgrade refuses, how frames are
// validated and rate-limited, who may steer a proxied file transfer, and
// how signing in and out works without leaving the room.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { WebSocket } from "ws";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { SignalingHub, clientAddress } from "../server/signaling/hub";
import { ConnectionGate } from "../server/signaling/limits";
import { MAX_FRAME_BYTES } from "../server/signaling/frames";
import { accountRef } from "../server/signaling/refs";
import type { StoredCredential } from "../server/accounts/webauthn";
import { WsClient } from "./helpers/ws-client";

let dir = "";
let store: AccountStore;
let hub: SignalingHub;
let server: Server;
let base = "";
const clients: WsClient[] = [];

async function start(gate?: ConnectionGate) {
  dir = mkdtempSync(joinPath(tmpdir(), "m5cet-hub-"));
  store = new AccountStore(dir);
  const queue = new MemoryQueue();
  hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
    gate,
  });
  server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => { await start(); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await hub.shutdown();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

async function connect(): Promise<WsClient> {
  const c = await WsClient.connect(base);
  clients.push(c);
  return c;
}

async function join(room: string, name: string, extra: Record<string, unknown> = {}) {
  const client = await connect();
  const hello = await client.next("hello");
  client.send({ type: "join", protocol: 2, room, name, peerId: hello.peerId, ...extra });
  const joined = await client.next("joined");
  return { client, hello, joined, peerId: String(joined.peerId) };
}

function account(name: string) {
  const credential: StoredCredential = { credentialId: `cred-${name}-000000000`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = store.create(credential, name);
  if (!r.ok) throw new Error(r.reason);
  return { id: r.account.id, token: store.issueToken(r.account.id) };
}

/** Opens a raw socket and resolves with the HTTP status of a refused upgrade (or 101). */
function upgradeStatus(headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, { headers });
    ws.once("open", () => { ws.close(); resolve(101); });
    ws.once("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.once("error", () => undefined);
  });
}

describe("hello and join", () => {
  it("greets with the protocol version and a server-made peer id", async () => {
    const c = await connect();
    const hello = await c.next("hello");
    expect(hello).toMatchObject({ protocol: 2, limits: { maxFrameBytes: MAX_FRAME_BYTES } });
    expect(String(hello.peerId)).toMatch(/^p-/);
  });

  it("does not let a newcomer take over a peer id that is in use", async () => {
    const room = "takeover";
    const owner = await join(room, "Owner", { peerId: "peer-owner-1" });
    expect(owner.peerId).toBe("peer-owner-1");

    const thief = await join(room, "Thief", { peerId: "peer-owner-1" });
    expect(thief.peerId).not.toBe("peer-owner-1");
    // The owner still gets its signals.
    thief.client.send({ type: "signal", target: "peer-owner-1", payload: { type: "offer", sdp: "v=0" } });
    expect(await owner.client.next("signal")).toMatchObject({ source: thief.peerId });
  });

  it("gives the id back to the same client when it proves it with the resume secret", async () => {
    const room = "resume";
    const first = await join(room, "Me", { peerId: "peer-me-0001" });
    const again = await join(room, "Me", { peerId: "peer-me-0001", resume: first.joined.resume });
    expect(again.peerId).toBe("peer-me-0001");
    expect(await first.client.next("replaced")).toBeTruthy();
    expect(again.joined.resume).not.toBe(first.joined.resume);
  });
});

describe("upgrade", () => {
  it("refuses a page from another origin", async () => {
    expect(await upgradeStatus({ Origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus({ Origin: base })).toBe(101);
    expect(await upgradeStatus()).toBe(101); // not a browser
  });

  it("refuses an address that opens too many connections", async () => {
    await hub.shutdown();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await start(new ConnectionGate({ perMinute: 2, concurrentPerClient: 20, concurrentTotal: 100 }));
    expect(await upgradeStatus()).toBe(101);
    expect(await upgradeStatus()).toBe(101);
    expect(await upgradeStatus()).toBe(429);
  });

  it("reads the client address only from trusted proxies", () => {
    const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} }) as never;
    expect(clientAddress(req("127.0.0.1", "203.0.113.9"), "loopback")).toBe("203.0.113.9");
    // Straight from the internet: a forged header changes nothing.
    expect(clientAddress(req("198.51.100.7", "203.0.113.9"), "loopback")).toBe("198.51.100.7");
    expect(clientAddress(req("127.0.0.1", "203.0.113.9"), false)).toBe("127.0.0.1");
    expect(clientAddress(req("10.0.0.2", "1.2.3.4, 203.0.113.9"), 1)).toBe("203.0.113.9");
  });
});

describe("frames", () => {
  it("answers malformed and unknown frames with an error", async () => {
    const c = await connect();
    await c.next("hello");
    c.socket.send("{not json");
    expect(await c.next("error")).toMatchObject({ code: "invalid-frame" });
    c.send({ type: "teleport" });
    expect(await c.next("error")).toMatchObject({ code: "unknown-type" });
    c.send({ type: "signal", target: "x", payload: { type: "offer", sdp: 42 } });
    expect(await c.next("error")).toMatchObject({ code: "invalid-frame" });
  });

  it("closes a socket that sends a frame over the size limit", async () => {
    const c = await connect();
    await c.next("hello");
    const closed = new Promise<number>((r) => c.socket.once("close", (code) => r(code)));
    c.socket.send(JSON.stringify({ type: "ping", pad: "x".repeat(MAX_FRAME_BYTES) }));
    expect(await closed).toBe(1009);
  });

  it("forwards only the validated parts of a signal", async () => {
    const a = await join("sig", "A");
    const b = await join("sig", "B");
    b.client.send({ type: "signal", target: a.peerId, payload: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0, evil: "<script>" }, extra: 1 });
    const got = await a.client.next("signal");
    expect(got).toEqual({ type: "signal", source: b.peerId, payload: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
  });

  it("tells the sender when a signal target is not in the room", async () => {
    const a = await join("sig2", "A");
    a.client.send({ type: "signal", target: "p-nobody", payload: { type: "offer", sdp: "v=0" } });
    expect(await a.client.next("signal-undeliverable")).toMatchObject({ target: "p-nobody" });
  });

  it("rate-limits a flood and names the frame", async () => {
    const a = await join("flood", "A");
    for (let i = 0; i < 40; i++) a.client.send({ type: "presence", away: false });
    expect(await a.client.next("rate-limited")).toMatchObject({ frame: "presence", retryAfterMs: expect.any(Number) });
  });
});

describe("file proxy ownership", () => {
  const META = { iv: "aXY=", ciphertext: "bWV0YQ==" };
  const CHUNK = { iv: "aXY=", ciphertext: "Y2h1bms=" };

  it("routes a resend request to the sender only, and refuses chunks from anyone else", async () => {
    const room = "proxy";
    const sender = await join(room, "Sender");
    const receiver = await join(room, "Receiver");
    const bystander = await join(room, "Bystander");

    sender.client.send({ type: "proxy-meta", transferId: "xfer-0001", ...META });
    expect(await sender.client.next("proxy-ack")).toMatchObject({ accepted: true });
    expect(await receiver.client.next("proxy-meta")).toMatchObject({ kind: "proxy-meta", transferId: "xfer-0001", from: sender.peerId, transport: "proxy" });

    receiver.client.send({ type: "proxy-need", transferId: "xfer-0001", seqs: [3, 4] });
    expect(await sender.client.next("proxy-need")).toMatchObject({ seqs: [3, 4], from: receiver.peerId });
    expect(await bystander.client.none("proxy-need")).toBe(true);

    bystander.client.send({ type: "proxy-chunk", transferId: "xfer-0001", seq: 0, ...CHUNK });
    expect(await bystander.client.next("error")).toMatchObject({ code: "proxy-refused" });
    expect(await receiver.client.none("proxy-chunk")).toBe(true);
  });

  it("lets a receiver decline without cancelling the transfer for the others", async () => {
    const room = "proxy-cancel";
    const sender = await join(room, "Sender");
    const r1 = await join(room, "R1");
    const r2 = await join(room, "R2");
    sender.client.send({ type: "proxy-meta", transferId: "xfer-0002", ...META });
    await sender.client.next("proxy-ack");

    r1.client.send({ type: "proxy-cancel", transferId: "xfer-0002" });
    expect(await sender.client.next("proxy-cancel")).toMatchObject({ from: r1.peerId });
    expect(await r2.client.none("proxy-cancel")).toBe(true);

    sender.client.send({ type: "proxy-chunk", transferId: "xfer-0002", seq: 0, ...CHUNK });
    expect(await r2.client.next("proxy-chunk")).toMatchObject({ seq: 0 });
  });

  it("ends the transfers of a sender whose socket goes", async () => {
    const room = "proxy-gone";
    const sender = await join(room, "Sender");
    const receiver = await join(room, "Receiver");
    sender.client.send({ type: "proxy-meta", transferId: "xfer-0003", ...META });
    await sender.client.next("proxy-ack");
    await sender.client.close();
    expect(await receiver.client.next("proxy-cancel")).toMatchObject({ transferId: "xfer-0003", reason: "sender disconnected" });
  });
});

describe("accounts on an open socket", () => {
  it("signs in and out without leaving the room", async () => {
    const room = "auth";
    const acc = account("Nora");
    const nora = await join(room, "Nora");
    const watcher = await join(room, "Watcher");

    nora.client.send({ type: "auth", token: acc.token, away: true });
    expect(await nora.client.next("auth-result")).toMatchObject({ ok: true, account: { account: accountRef(room, acc.id), away: true } });
    expect(await watcher.client.next("peer-updated")).toMatchObject({ peerId: nora.peerId, account: accountRef(room, acc.id) });

    nora.client.send({ type: "auth", token: null, away: false });
    expect(await nora.client.next("auth-result")).toMatchObject({ ok: true, account: null });
    expect(await watcher.client.next("peer-updated")).toMatchObject({ account: null });
  });

  it("ends the account on the socket when its session is revoked", async () => {
    const room = "revoke";
    const acc = account("Otto");
    const otto = await join(room, "Otto", { auth: acc.token, away: true });
    const watcher = await join(room, "Watcher");
    expect(otto.joined.account).toMatchObject({ away: true });

    store.revokeToken(acc.token);
    expect(await otto.client.next("account-revoked")).toMatchObject({ reason: "sign-out" });
    expect(await watcher.client.next("peer-updated")).toMatchObject({ peerId: otto.peerId, account: null });

    // Gone now means gone, not away.
    await otto.client.close();
    await watcher.client.next("peer-left");
    expect(await watcher.client.none("peer-away")).toBe(true);
  });

  it("reports an invalid token without revealing anything else", async () => {
    const r = await join("bad-token", "Pat", { auth: "x".repeat(43) });
    expect(r.joined.account).toEqual({ invalid: true });
  });
});

describe("operator view", () => {
  it("shows rooms by hash only and can close a connection", async () => {
    const a = await join("secret-room-name", "A");
    const snap = hub.snapshot();
    expect(JSON.stringify(snap)).not.toContain("secret-room-name");
    const connId = snap[0].peers[0].connId;
    expect(hub.closeConnection(connId, "test")).toBe(true);
    expect(await a.client.next("closed-by-server")).toMatchObject({ reason: "test" });
  });
});

describe("crypto version 2 on the wire", () => {
  it("routes a sealed signal without being able to read it", async () => {
    const a = await join("sealed", "A");
    const b = await join("sealed", "B");
    const sealed = { sealed: { v: 2, iv: "aXZpdml2aXZpdml2", ciphertext: "Y2lwaGVy" } };
    b.client.send({ type: "signal", target: a.peerId, payload: sealed });
    expect(await a.client.next("signal")).toEqual({ type: "signal", source: b.peerId, payload: sealed });
  });

  it("carries the version and the signed digest of a proxied file", async () => {
    const room = "proxy-v2";
    const sender = await join(room, "Sender");
    const receiver = await join(room, "Receiver");
    sender.client.send({ type: "proxy-meta", transferId: "xfer-v2", v: 2, iv: "aXY=", ciphertext: "bWV0YQ==" });
    expect(await receiver.client.next("proxy-meta")).toMatchObject({ v: 2 });
    sender.client.send({ type: "proxy-chunk", transferId: "xfer-v2", seq: 0, v: 2, iv: "aXY=", ciphertext: "Y2h1bms=" });
    expect(await receiver.client.next("proxy-chunk")).toMatchObject({ v: 2, seq: 0 });
    sender.client.send({ type: "proxy-end", transferId: "xfer-v2", v: 2, iv: "aXY=", ciphertext: "ZW5k" });
    expect(await receiver.client.next("proxy-end")).toMatchObject({ v: 2, iv: "aXY=", ciphertext: "ZW5k" });
  });
});
