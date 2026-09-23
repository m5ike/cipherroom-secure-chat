// @vitest-environment node
//
// Two signaling hubs as two instances behind one load balancer, linked by
// an in-process cluster bus (server/cluster/bus.ts MemoryNetwork): a room
// spans both, signals and relayed files find members on the other
// instance, a client that reconnects to the other instance keeps its peer
// id, and signing out on one instance reaches sockets on the other.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { SignalingHub } from "../server/signaling/hub";
import { MemoryNetwork, type MemoryBus } from "../server/cluster/bus";
import type { StoredCredential } from "../server/accounts/webauthn";
import { encodeChunk, FRAME_PROXY_CHUNK } from "../client/src/lib/binary-frames";
import { WsClient } from "./helpers/ws-client";

type Instance = { hub: SignalingHub; server: Server; base: string; store: AccountStore; bus: MemoryBus };

let dir = "";
let network: MemoryNetwork;
let a: Instance;
let b: Instance;
const clients: WsClient[] = [];

async function instance(name: string): Promise<Instance> {
  // Both instances use one data directory, as on one host.
  const store = new AccountStore(dir);
  const bus = network.bus(name, "cluster-test-secret");
  const queue = new MemoryQueue();
  const hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
    cluster: bus,
  });
  const server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { hub, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, bus };
}

async function stop(i: Instance) {
  await i.hub.shutdown();
  i.server.closeAllConnections?.();
  await new Promise((r) => i.server.close(r));
}

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), "m5cet-cluster-"));
  network = new MemoryNetwork();
  a = await instance("inst-a");
  b = await instance("inst-b");
  await settle();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const i of [a, b]) await stop(i).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 30));

async function join(on: Instance, room: string, name: string, extra: Record<string, unknown> = {}) {
  const client = await WsClient.connect(on.base);
  clients.push(client);
  const hello = await client.next("hello");
  client.send({ type: "join", protocol: 2, room, name, peerId: extra.peerId ?? hello.peerId, ...extra });
  const joined = await client.next("joined");
  await settle();
  return { client, joined, peerId: String(joined.peerId) };
}

describe("one room on two instances", () => {
  it("lists members of the other instance and tells about arrivals and departures", async () => {
    const alice = await join(a, "shared", "Alice");
    const bob = await join(b, "shared", "Bob");
    expect(bob.joined.peers).toEqual([expect.objectContaining({ peerId: alice.peerId, name: "Alice" })]);
    expect(await alice.client.next("peer-joined")).toMatchObject({ peerId: bob.peerId, name: "Bob" });
    // Nothing internal leaks to clients.
    expect(JSON.stringify(bob.joined.peers)).not.toMatch(/resumeHash|inst/);

    bob.client.send({ type: "leave" });
    expect(await alice.client.next("peer-left")).toMatchObject({ peerId: bob.peerId });
  });

  it("routes signals to a member on the other instance", async () => {
    const alice = await join(a, "sig", "Alice");
    const bob = await join(b, "sig", "Bob");
    alice.client.send({ type: "signal", target: bob.peerId, payload: { type: "offer", sdp: "v=0\r\n" } });
    expect(await bob.client.next("signal")).toMatchObject({ source: alice.peerId, payload: { type: "offer" } });
    alice.client.send({ type: "signal", target: "p-nobody-here-000", payload: { type: "offer", sdp: "v=0\r\n" } });
    expect(await alice.client.next("signal-undeliverable")).toMatchObject({ target: "p-nobody-here-000" });
  });

  it("relays a file across instances, binary where understood, and carries repeat requests back", async () => {
    const alice = await join(a, "files", "Alice", { features: ["bin"] });
    const bob = await join(b, "files", "Bob", { features: ["bin"] });
    const carol = await join(b, "files", "Carol");

    const transferId = "xfer-cluster";
    alice.client.send({ type: "proxy-meta", transferId, iv: "aXY=", ciphertext: "bWV0YQ==" });
    expect(await bob.client.next("proxy-meta")).toMatchObject({ transferId, from: alice.peerId });
    expect(await carol.client.next("proxy-meta")).toMatchObject({ transferId });

    const chunk = encodeChunk({ type: FRAME_PROXY_CHUNK, version: 3, transferId, seq: 0, iv: new Uint8Array(12), data: new Uint8Array(40).fill(7) });
    alice.client.sendBinary(chunk);
    const got = await bob.client.next("binary");
    expect(Buffer.compare(got.data as Buffer, Buffer.from(chunk))).toBe(0);
    expect(await carol.client.next("proxy-chunk")).toMatchObject({ transferId, seq: 0, v: 3 });

    carol.client.send({ type: "proxy-need", transferId, seqs: [0] });
    expect(await alice.client.next("proxy-need")).toMatchObject({ transferId, seqs: [0] });
  });

  it("lets the same client come back on the other instance with its peer id", async () => {
    const alice = await join(a, "resume", "Alice");
    const bob = await join(a, "resume", "Bob");
    // Alice's connection to instance A is still open when she reconnects to B.
    const again = await join(b, "resume", "Alice", { peerId: alice.peerId, resume: alice.joined.resume });
    expect(again.peerId).toBe(alice.peerId);
    expect(await alice.client.next("replaced")).toBeTruthy();
    expect(again.joined.peers).toEqual([expect.objectContaining({ peerId: bob.peerId })]);

    // Without the secret the id stays with its holder.
    const mallory = await join(a, "resume", "Mallory", { peerId: alice.peerId, resume: "A".repeat(32) });
    expect(mallory.peerId).not.toBe(alice.peerId);
  });

  it("forgets the members of an instance that stops", async () => {
    const alice = await join(a, "bye", "Alice");
    const bob = await join(b, "bye", "Bob");
    await alice.client.next("peer-joined");
    await b.hub.shutdown();
    expect(await alice.client.next("peer-left")).toMatchObject({ peerId: bob.peerId });
  });

  it("ends a signed-in session on the other instance too", async () => {
    const cred: StoredCredential = { credentialId: "cluster-credential-01", publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 0 };
    const created = a.store.create(cred, "Alice");
    if (!created.ok) throw new Error(created.reason);
    const token = a.store.issueToken(created.account.id);
    // Instance B reads the shared directory: it knows the new session at once.
    const alice = await join(b, "acct", "Alice", { auth: token });
    expect(alice.joined.account).toMatchObject({ account: expect.any(String) });

    a.store.revokeToken(token);
    expect(await alice.client.next("account-revoked")).toMatchObject({ reason: "sign-out" });
    expect(b.store.resolveToken(token)).toBeNull();
  });

  it("drops cluster messages that are not signed with the cluster secret", async () => {
    const alice = await join(a, "forged", "Alice");
    a.bus.inject(JSON.stringify({ t: "room", from: "inst-evil", room: "forged", payload: { type: "closed-by-server", reason: "forged" } }));
    a.bus.inject(JSON.stringify({ m: "AAAA", b: JSON.stringify({ t: "room", from: "inst-evil", room: "forged", payload: { type: "closed-by-server", reason: "forged" } }) }));
    expect(await alice.client.none("closed-by-server")).toBe(true);
    expect(a.bus.status().dropped).toBe(2);
    expect(a.hub.stats().cluster).toMatchObject({ kind: "memory", signed: true, instances: [expect.objectContaining({ id: "inst-b" })] });
  });
});
