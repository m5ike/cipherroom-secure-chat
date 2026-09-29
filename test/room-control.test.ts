// @vitest-environment node
//
// The operator's hand in a room (6.0, signaling/hub.ts + room-registry.ts):
// a notice to everyone or to one member, a disconnect, a room closed by the
// registry (refused at join), a member limit, and a pinned message that
// everyone who joins gets. The server knows a room only by its hash.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { SignalingHub } from "../server/signaling/hub";
import { hashRoom } from "../server/monitor/traffic";
import { roomRegistry } from "../server/room-registry";
import { WsClient } from "./helpers/ws-client";

let dir = "";
let hub: SignalingHub;
let server: Server;
let base = "";
const clients: WsClient[] = [];
const saved = { ...process.env };

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), "m5cet-roomctl-"));
  process.env.DATA_DIR = dir;
  const store = new AccountStore(dir);
  const queue = new MemoryQueue();
  hub = new SignalingHub({
    accounts: store, queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
  });
  server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await hub.shutdown();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

async function open(room: string, name: string) {
  const client = await WsClient.connect(base);
  clients.push(client);
  const hello = await client.next("hello");
  client.send({ type: "join", protocol: 2, room, name, peerId: hello.peerId });
  return client;
}
async function join(room: string, name: string) {
  const client = await open(room, name);
  const joined = await client.next("joined");
  return { client, peerId: String(joined.peerId) };
}

describe("operator notices", () => {
  it("a wall message reaches everyone; a flash only the member it names", async () => {
    const a = await join("r3.alpha", "Eva");
    const b = await join("r3.alpha", "Karel");
    const hash = hashRoom("r3.alpha")!;
    expect(hub.notice(hash, { kind: "wall", text: "Údržba ve 22:00", level: "warning" })).toBe(2);
    for (const c of [a, b]) expect(await c.client.next("server-notice")).toMatchObject({ kind: "wall", text: "Údržba ve 22:00", level: "warning", from: "operator" });
    expect(hub.notice(hash, { kind: "flash", text: "Jen pro Karla", level: "bogus" }, { name: "karel" })).toBe(1);
    expect(await b.client.next("server-notice")).toMatchObject({ kind: "flash", text: "Jen pro Karla", level: "info" });
    expect(hub.notice("0000000000000000", { kind: "wall", text: "nobody" })).toBe(0);
  });

  it("disconnects one member, or everyone", async () => {
    const a = await join("r3.beta", "Eva");
    const b = await join("r3.beta", "Karel");
    const hash = hashRoom("r3.beta")!;
    expect(hub.disconnectRoom(hash, "bye", { peerId: a.peerId })).toBe(1);
    expect(await a.client.next("closed-by-server")).toMatchObject({ reason: "bye" });
    expect(hub.disconnectRoom(hash, "closing")).toBe(1);
    expect(await b.client.next("closed-by-server")).toMatchObject({ reason: "closing" });
  });
});

describe("the registry at join", () => {
  it("a closed room refuses everyone; opened again, it lets them in", async () => {
    const hash = hashRoom("r3.gamma")!;
    roomRegistry.set(hash, { blocked: { reason: "maintenance" } }, "test");
    const c = await open("r3.gamma", "Eva");
    expect(await c.next("error")).toMatchObject({ code: "room-blocked", message: "maintenance" });
    roomRegistry.set(hash, { blocked: null }, "test");
    await join("r3.gamma", "Eva");
  });

  it("an expired block does not count", async () => {
    const hash = hashRoom("r3.delta")!;
    roomRegistry.set(hash, { blocked: { reason: "soon over", until: Date.now() + 50 } }, "test");
    await new Promise((r) => setTimeout(r, 80));
    await join("r3.delta", "Eva");
  });

  it("a limit keeps newcomers out of a full room", async () => {
    const hash = hashRoom("r3.epsilon")!;
    roomRegistry.set(hash, { maxMembers: 1 }, "test");
    await join("r3.epsilon", "Eva");
    const late = await open("r3.epsilon", "Karel");
    expect(await late.next("error")).toMatchObject({ code: "room-full", max: 1 });
  });

  it("a pinned message greets everyone who joins", async () => {
    const hash = hashRoom("r3.zeta")!;
    roomRegistry.set(hash, { wall: { text: "Vítejte", level: "success" } }, "test");
    const { client } = await join("r3.zeta", "Eva");
    expect(await client.next("server-notice")).toMatchObject({ kind: "wall", text: "Vítejte", level: "success", pinned: true });
  });
});
