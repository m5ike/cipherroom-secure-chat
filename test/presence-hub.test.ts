// @vitest-environment node
//
// 6.7 presence on the signaling socket (server/signaling/hub.ts +
// presence.ts): a member whose connection goes without a goodbye stays in
// the room as held (away) and comes back as the same peer; an explicit leave
// and the server's removal (the operator, a revoked session, the maximum
// away time) take them off the list; every member carries foreground and
// lastSeen, and none of it reaches another room.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { SignalingHub } from "../server/signaling/hub";
import { accountRef } from "../server/signaling/refs";
import { hashRoom } from "../server/monitor/traffic";
import type { StoredCredential } from "../server/accounts/webauthn";
import { WsClient, type Frame } from "./helpers/ws-client";

const MAX_AWAY_MS = 60_000;

let dir = "";
let store: AccountStore;
let hub: SignalingHub;
let server: Server;
let base = "";
const clients: WsClient[] = [];

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), "m5cet-presence-"));
  store = new AccountStore(dir);
  const queue = new MemoryQueue();
  hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
    maxAwayMs: MAX_AWAY_MS,
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
  rmSync(dir, { recursive: true, force: true });
});

async function join(room: string, name: string, extra: Record<string, unknown> = {}) {
  const client = await WsClient.connect(base);
  clients.push(client);
  const hello = await client.next("hello");
  client.send({ type: "join", protocol: 2, room, name, peerId: hello.peerId, ...extra });
  const joined = await client.next("joined");
  return { client, joined, peerId: String(joined.peerId), resume: String(joined.resume) };
}

/** The network goes: no leave, no close handshake. */
async function drop(c: WsClient) {
  await new Promise<void>((resolve) => { c.socket.once("close", () => resolve()); c.socket.terminate(); });
}

function account(name: string) {
  const credential: StoredCredential = { credentialId: `cred-${name}-000000000`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = store.create(credential, name);
  if (!r.ok) throw new Error(r.reason);
  return { id: r.account.id, token: store.issueToken(r.account.id) };
}

const heldOf = (joined: Frame) => (joined.held as Array<Record<string, unknown>>) ?? [];
const peersOf = (joined: Frame) => joined.peers as Array<Record<string, unknown>>;

describe("a connection that goes is not a goodbye", () => {
  it("keeps the member in the room as held, with when they were last seen", async () => {
    const alice = await join("held", "Alice");
    const bob = await join("held", "Bob");
    const before = Date.now();
    await drop(alice.client);

    const left = await bob.client.next("peer-left");
    expect(left).toMatchObject({ peerId: alice.peerId, held: true, name: "Alice" });
    expect(left.lastSeen as number).toBeGreaterThanOrEqual(before - 50);
    expect(left.since as number).toBeGreaterThanOrEqual(before - 50);

    // A newcomer sees her listed as held, not as a live peer.
    const carol = await join("held", "Carol");
    expect(heldOf(carol.joined)).toEqual([expect.objectContaining({ peerId: alice.peerId, name: "Alice", lastSeen: left.lastSeen })]);
    expect(peersOf(carol.joined).map((p) => p.peerId)).toEqual([bob.peerId]);
    expect(hub.snapshot().find((r) => r.roomHash === hashRoom("held"))?.held).toHaveLength(1);
  });

  it("gives the same client its place back: the same peer id, no second entry", async () => {
    const alice = await join("resume", "Alice", { peerId: "peer-alice-0001" });
    const bob = await join("resume", "Bob");
    await drop(alice.client);
    await bob.client.next("peer-left");

    const again = await join("resume", "Alice", { peerId: "peer-alice-0001", resume: alice.resume });
    expect(again.peerId).toBe("peer-alice-0001");
    expect(await bob.client.next("peer-joined")).toMatchObject({ peerId: "peer-alice-0001", name: "Alice", foreground: true });
    expect(hub.held.total()).toBe(0);

    const carol = await join("resume", "Carol");
    expect(heldOf(carol.joined)).toEqual([]);
    expect(peersOf(carol.joined).filter((p) => p.peerId === "peer-alice-0001")).toHaveLength(1);
  });

  it("does not hand a held member's peer id to anyone without the resume secret", async () => {
    const alice = await join("guard", "Alice", { peerId: "peer-alice-0002" });
    await drop(alice.client);
    await new Promise((r) => setTimeout(r, 30));
    const mallory = await join("guard", "Mallory", { peerId: "peer-alice-0002", resume: "bm90LXRoZS1yaWdodC1zZWNyZXQ" });
    expect(mallory.peerId).not.toBe("peer-alice-0002");
    expect(heldOf(mallory.joined).map((h) => h.peerId)).toEqual(["peer-alice-0002"]);
  });

  it("replaces a signed-in member's held entry when the same account comes back on a new connection", async () => {
    const acc = account("Dana");
    const dana = await join("account", "Dana", { auth: acc.token });
    const bob = await join("account", "Bob");
    await drop(dana.client);
    expect(await bob.client.next("peer-left")).toMatchObject({ peerId: dana.peerId, held: true, account: accountRef("account", acc.id) });

    // A reload lost the resume secret: a fresh peer id, but the same account.
    const back = await join("account", "Dana", { auth: acc.token });
    expect(back.peerId).not.toBe(dana.peerId);
    const gone = await bob.client.next("peer-left");
    expect(gone).toEqual({ type: "peer-left", peerId: dana.peerId });
    expect(await bob.client.next("peer-joined")).toMatchObject({ peerId: back.peerId });
    expect(hub.held.total()).toBe(0);
  });
});

describe("leaving and being removed", () => {
  it("removes a member who leaves on purpose", async () => {
    const alice = await join("bye", "Alice");
    const bob = await join("bye", "Bob");
    alice.client.send({ type: "leave", away: false });
    expect(await bob.client.next("peer-left")).toEqual({ type: "peer-left", peerId: alice.peerId });
    await alice.client.close();
    const carol = await join("bye", "Carol");
    expect(heldOf(carol.joined)).toEqual([]);
    expect(hub.held.total()).toBe(0);
  });

  it("removes a held member the operator disconnects", async () => {
    const alice = await join("operator", "Alice");
    const bob = await join("operator", "Bob");
    await drop(alice.client);
    await bob.client.next("peer-left");

    expect(hub.disconnectRoom(hashRoom("operator")!, "bye", { peerId: alice.peerId })).toBe(1);
    expect(await bob.client.next("peer-left")).toEqual({ type: "peer-left", peerId: alice.peerId });
    expect(hub.held.total()).toBe(0);
  });

  it("finds a room where everybody is away for the operator", async () => {
    const alice = await join("empty", "Alice");
    await drop(alice.client);
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.snapshot().find((r) => r.roomHash === hashRoom("empty"))?.peers).toEqual([]);
    expect(hub.disconnectRoom(hashRoom("empty")!, "closing")).toBe(1);
    expect(hub.held.total()).toBe(0);
  });

  it("does not hold a connection the operator closed", async () => {
    const alice = await join("closed", "Alice");
    const bob = await join("closed", "Bob");
    const conn = hub.snapshot().find((r) => r.roomHash === hashRoom("closed"))!.peers.find((p) => p.peerId === alice.peerId)!.connId;
    expect(hub.closeConnection(conn, "enough")).toBe(true);
    expect(await bob.client.next("peer-left")).toEqual({ type: "peer-left", peerId: alice.peerId });
    expect(hub.held.total()).toBe(0);
  });

  it("removes the held entry of a session that was revoked", async () => {
    const acc = account("Erin");
    const erin = await join("revoked", "Erin", { auth: acc.token });
    const bob = await join("revoked", "Bob");
    await drop(erin.client);
    await bob.client.next("peer-left");
    store.revokeToken(acc.token);
    expect(await bob.client.next("peer-left")).toEqual({ type: "peer-left", peerId: erin.peerId });
    expect(hub.held.total()).toBe(0);
  });

  it("lets held members go after the maximum away time", async () => {
    const alice = await join("expire", "Alice");
    const bob = await join("expire", "Bob");
    await drop(alice.client);
    await bob.client.next("peer-left");

    expect(hub.sweepHeld(Date.now() + MAX_AWAY_MS / 2)).toBe(0);
    expect(hub.sweepHeld(Date.now() + MAX_AWAY_MS + 1_000)).toBe(1);
    expect(await bob.client.next("peer-left")).toEqual({ type: "peer-left", peerId: alice.peerId });
  });
});

describe("foreground, background and last seen", () => {
  it("tells the room when a member's app goes to the background and comes back", async () => {
    const alice = await join("fg", "Alice");
    const bob = await join("fg", "Bob");
    expect(peersOf(bob.joined)[0]).toMatchObject({ peerId: alice.peerId, foreground: true, lastSeen: expect.any(Number) });

    const t0 = Date.now();
    alice.client.send({ type: "presence", away: false, foreground: false });
    const bg = await bob.client.next("peer-presence");
    expect(bg).toEqual({ type: "peer-presence", peerId: alice.peerId, foreground: false, lastSeen: expect.any(Number) });
    expect(bg.lastSeen as number).toBeGreaterThanOrEqual(t0 - 50);
    expect(await alice.client.none("peer-presence")).toBe(true); // not to herself

    // A newcomer sees when she was last seen, not "now".
    await new Promise((r) => setTimeout(r, 40));
    const carol = await join("fg", "Carol");
    expect(peersOf(carol.joined).find((p) => p.peerId === alice.peerId)).toMatchObject({ foreground: false, lastSeen: bg.lastSeen });

    alice.client.send({ type: "presence", away: false, foreground: true });
    expect(await bob.client.next("peer-presence")).toMatchObject({ peerId: alice.peerId, foreground: true });
    // The same state again is not news.
    alice.client.send({ type: "presence", away: false, foreground: true });
    expect(await bob.client.none("peer-presence")).toBe(true);
  });

  it("keeps the last seen of a member whose connection went while the app was in the background", async () => {
    const alice = await join("bg-drop", "Alice", { peerId: "peer-alice-0003" });
    const bob = await join("bg-drop", "Bob");
    alice.client.send({ type: "presence", away: false, foreground: false });
    const bg = await bob.client.next("peer-presence");
    await new Promise((r) => setTimeout(r, 40));
    await drop(alice.client);
    expect(await bob.client.next("peer-left")).toMatchObject({ held: true, lastSeen: bg.lastSeen });

    // Back, still in the background (a reconnect while hidden): last seen stays.
    const again = await join("bg-drop", "Alice", { peerId: "peer-alice-0003", resume: alice.resume, foreground: false });
    expect(again.peerId).toBe("peer-alice-0003");
    expect(await bob.client.next("peer-joined")).toMatchObject({ foreground: false, lastSeen: bg.lastSeen });
  });

  it("reads a presence frame of an older client (away only) as background", async () => {
    const alice = await join("legacy", "Alice");
    const bob = await join("legacy", "Bob");
    alice.client.send({ type: "presence", away: true });
    expect(await alice.client.next("presence-ack")).toMatchObject({ away: false });
    expect(await bob.client.next("peer-presence")).toMatchObject({ peerId: alice.peerId, foreground: false });
  });

  it("gives an away member's relay entry the time they were last seen", async () => {
    const acc = account("Fay");
    const fay = await join("relay-seen", "Fay", { auth: acc.token, away: true });
    const bob = await join("relay-seen", "Bob");
    fay.client.send({ type: "presence", away: false, foreground: false });
    const bg = await bob.client.next("peer-presence");
    await new Promise((r) => setTimeout(r, 40));
    await drop(fay.client);
    const away = await bob.client.next("peer-away");
    expect(away).toMatchObject({ account: accountRef("relay-seen", acc.id), lastSeen: bg.lastSeen });
    expect(store.get(acc.id)!.away[0]).toMatchObject({ lastSeen: bg.lastSeen });
  });
});

describe("privacy", () => {
  it("never tells another room about a member's presence or held entry", async () => {
    const aliceA = await join("room-a", "Alice");
    const watcherA = await join("room-a", "Watcher");
    const aliceB = await join("room-b", "Alice");
    const carolB = await join("room-b", "Carol");

    aliceA.client.send({ type: "presence", away: false, foreground: false });
    expect(await watcherA.client.next("peer-presence")).toMatchObject({ peerId: aliceA.peerId });
    expect(await carolB.client.none("peer-presence")).toBe(true);

    await drop(aliceA.client);
    expect(await watcherA.client.next("peer-left")).toMatchObject({ held: true });
    expect(await carolB.client.none("peer-left")).toBe(true);

    const daveB = await join("room-b", "Dave");
    expect(heldOf(daveB.joined)).toEqual([]);
    // In room B, Alice is a live member, in the foreground there.
    expect(peersOf(daveB.joined).find((p) => p.peerId === aliceB.peerId)).toMatchObject({ foreground: true });
  });
});
