// @vitest-environment node
//
// 6.12 security review — the hub join proof's server findings, fixed:
//   S07  "proven only" follows the room's verifier, not who is connected now
//   S05  notices by name / peer id reach proven members only (in a room that proves)
//   S08  sendToPeer checks at every delivery; "@account" legs need no proof
//   S06  key-bundles / kt-lookup answer an unproven requester like a foreign reference
//   S04  failed proofs: per address (bad signatures) and per room + address (mismatches), /64, bounded
//   S14  a `room-proof` refusal says whether a join without proof would be admitted
//   S15  registering verifiers is limited per address; a full memory store never evicts a fresh one

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { SignalingHub, type HubDirectory } from "../server/signaling/hub";
import { MemoryVerifiers, PROOF_FAILURES, PROOF_REGISTRATIONS, RoomProofs, proofSettings } from "../server/signaling/proof";
import { audit } from "../server/monitor/audit";
import { hashRoom } from "../server/monitor/traffic";
import { routeTargets } from "../server/telephony/route-audio";
import type { StoredCredential } from "../server/accounts/webauthn";
import type { KtLookup } from "../client/src/lib/p4/contract";
import { WsClient } from "./helpers/ws-client";

const blindRoom = () => `r3.${randomBytes(24).toString("base64url")}`;

function roomKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("base64");
  return {
    pub,
    prove: (room: string, nonce: string) => ({ pub, sig: edSign(null, Buffer.from(`m5cet/hub-join/4|${room}|${nonce}`, "utf8"), privateKey).toString("base64") }),
  };
}

type Hub = { hub: SignalingHub; server: Server; base: string; store: AccountStore };
let dir = "";
const hubs: Hub[] = [];
const clients: WsClient[] = [];

async function startHub(opts: { proofs?: RoomProofs; directory?: HubDirectory } = {}): Promise<Hub> {
  const store = new AccountStore(dir);
  const queue = new MemoryQueue();
  const hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
    roomProofs: opts.proofs ?? RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }),
    ...(opts.directory ? { directory: opts.directory } : {}),
  });
  const server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const h = { hub, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
  hubs.push(h);
  return h;
}

beforeEach(() => { dir = mkdtempSync(joinPath(tmpdir(), "m5cet-proof-review-")); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const h of hubs.splice(0)) {
    await h.hub.shutdown();
    h.server.closeAllConnections?.();
    await new Promise((r) => h.server.close(r));
  }
  rmSync(dir, { recursive: true, force: true });
});

async function join(h: Hub, room: string, name: string, extra: { key?: ReturnType<typeof roomKey>; auth?: string } = {}) {
  const c = await WsClient.connect(h.base);
  clients.push(c);
  const hello = await c.next("hello");
  const proof = extra.key ? extra.key.prove(room, String(hello.nonce)) : undefined;
  c.send({ type: "join", protocol: 2, room, name, ...(proof ? { proof } : {}), ...(extra.auth ? { auth: extra.auth } : {}) });
  return c;
}

async function joined(h: Hub, room: string, name: string, extra: Parameters<typeof join>[3] = {}) {
  const c = await join(h, room, name, extra);
  const j = await c.next("joined");
  return { c, joined: j, peerId: String(j.peerId) };
}

function account(store: AccountStore, name: string) {
  const credential: StoredCredential = { credentialId: `cred-${name}-${randomBytes(6).toString("hex")}`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = store.create(credential, name);
  if (!r.ok) throw new Error(r.reason);
  return { id: r.account.id, token: store.issueToken(r.account.id) };
}

const routeHubOf = (h: Hub) => ({
  members: (r: string) => h.hub.roomMembers(r),
  send: (r: string, p: string, payload: Record<string, unknown>, a?: string) => h.hub.sendToPeer(r, p, payload, a),
  accountMembers: (a: string) => h.hub.accountMembers(a),
  reachable: (r: string, p: string, a?: string) => h.hub.stillReachable(r, p, a),
});

/* ------------------------------------------------------------------ S07 */

describe("S07: a room with a verifier serves proven members only — whoever is connected", () => {
  it("after its only proven member LEFT (not held), an unproven joiner gets no call, no notice by name, no frame by peer id", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    const alice = await joined(h, room, "Alice", { key });
    expect(alice.joined.proven).toBe(true);
    alice.c.send({ type: "leave", away: false }); // a clean leave: nobody proven is listed any more
    await new Promise((r) => setTimeout(r, 60));
    expect(h.hub.held.list(room)).toEqual([]);

    const mallory = await joined(h, room, "Mallory");
    expect(mallory.joined.proven).toBe(false);
    expect(h.hub.provenOnly(room)).toBe(true);
    expect(h.hub.roomMembers(room)).toEqual([expect.objectContaining({ name: "Mallory", proven: false, reachable: false })]);
    expect(routeTargets({ type: "room", room, user: "" }, routeHubOf(h)).targets).toEqual([]);
    expect(routeTargets({ type: "user", room, user: "Mallory" }, routeHubOf(h)).targets).toEqual([]);
    const hash = hashRoom(room)!;
    expect(h.hub.sendToMembers(hash, { type: "phone-bridge", event: "incoming" }, { name: "Mallory" })).toBe(0);
    expect(h.hub.notice(hash, { kind: "message", text: "code 1234" }, { name: "mallory" })).toBe(0);
    expect(h.hub.sendToPeer(room, mallory.peerId, { type: "phone-bridge", event: "status" })).toBe(false);
    expect(await mallory.c.none("phone-bridge", 200)).toBe(true);
    expect(await mallory.c.none("server-notice", 50)).toBe(true);
    // A room-wide notice (no target) is still the operator speaking to everyone in the room.
    expect(h.hub.notice(hash, { kind: "wall", text: "maintenance tonight" })).toBe(1);
  });

  it("a room where nobody ever proved still reaches everyone (clients before 6.12); the owner's reset makes it so again", async () => {
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 });
    const h = await startHub({ proofs });
    const legacyRoom = blindRoom();
    const old = await joined(h, legacyRoom, "Old");
    expect(h.hub.provenOnly(legacyRoom)).toBe(false);
    expect(routeTargets({ type: "room", room: legacyRoom, user: "" }, routeHubOf(h)).targets.map((t) => t.peerId)).toEqual([old.peerId]);
    expect(h.hub.sendToPeer(legacyRoom, old.peerId, { type: "phone-bridge", event: "status" })).toBe(true);

    const room = blindRoom();
    const key = roomKey();
    const a = await joined(h, room, "Alice", { key });
    a.c.send({ type: "leave", away: false });
    await new Promise((r) => setTimeout(r, 60));
    const m = await joined(h, room, "Mallory");
    expect(h.hub.provenOnly(room)).toBe(true);
    expect(proofs.reset(room)).toBe(true);
    expect(h.hub.provenOnly(room)).toBe(false);
    expect(routeTargets({ type: "room", room, user: "" }, routeHubOf(h)).targets.map((t) => t.peerId)).toEqual([m.peerId]);
  });

  it("hasVerifier(): only blind ids, cached, and an expired verifier does not count", () => {
    let now = 1_700_000_000_000;
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 10_000 }, () => now);
    const room = blindRoom();
    const key = roomKey();
    expect(proofs.hasVerifier(room)).toBe(false);
    expect(proofs.hasVerifier("plain-room-name")).toBe(false);
    expect(proofs.check(room, "n", key.prove(room, "n"), "198.51.100.1")).toMatchObject({ kind: "proven", registered: true });
    expect(proofs.hasVerifier(room)).toBe(true); // updated at once by the registration
    now += 120_000; // past the TTL and the cache
    expect(proofs.hasVerifier(room)).toBe(false);
  });
});

/* ------------------------------------------------------------------ S08 */

describe("S08: frames by peer id are checked when they are delivered", () => {
  it("a route to '@account' reaches its signed-in member without a proof; anyone else unproven gets nothing", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    await joined(h, room, "Alice", { key });
    const acc = account(h.store, "bob-acc");
    const bob = await joined(h, room, "Bob", { auth: acc.token }); // an older client: signed in, no proof
    expect(bob.joined.proven).toBe(false);
    expect(h.hub.sendToPeer(room, bob.peerId, { type: "phone-bridge", event: "status" })).toBe(false);
    expect(h.hub.sendToPeer(room, bob.peerId, { type: "phone-bridge", event: "status", n: 2 }, acc.id.toUpperCase())).toBe(true);
    expect(await bob.c.next("phone-bridge")).toMatchObject({ n: 2 });
    expect(h.hub.sendToPeer(room, bob.peerId, { type: "phone-bridge" }, "someone-else")).toBe(false);
    const targets = routeTargets({ type: "user", room, user: `@${acc.id}` }, routeHubOf(h)).targets;
    expect(targets).toEqual([expect.objectContaining({ peerId: bob.peerId, accountId: acc.id.toLowerCase() })]);
    // stillReachable: the leg for "@account" stays; a plain leg for the same peer id does not; a vanished peer keeps its leg.
    expect(h.hub.stillReachable(room, bob.peerId, acc.id)).toBe(true);
    expect(h.hub.stillReachable(room, bob.peerId)).toBe(false);
    expect(h.hub.stillReachable(room, "p-gone")).toBe(true);
  });
});

/* ------------------------------------------------------------------ S06 */

describe("S06: the key directory over the hub", () => {
  it("kt-lookup: an unproven requester in a room that proves gets the head and no entries", async () => {
    const asked: Array<string | null> = [];
    const sth = { size: 1, root: "cm9vdA==", ts: 1, sig: "c2ln" };
    const directory: HubDirectory = {
      devices: () => [],
      lookup: async (id) => { asked.push(id); return { sth, entries: id ? [{ entry: { t: "acct", u: "u", apk: "a", ts: 1 }, index: 0, proof: [] }] : [] } as KtLookup; },
    };
    const h = await startHub({ directory });
    const room = blindRoom();
    const key = roomKey();
    const acc = account(h.store, "alice-kt");
    const alice = await joined(h, room, "Alice", { key, auth: acc.token });
    const mallory = await joined(h, room, "Mallory");
    const ref = (mallory.joined.peers as Array<{ name: string; account?: string }>).find((p) => p.name === "Alice")?.account;
    expect(ref).toBeTruthy();
    mallory.c.send({ type: "kt-lookup", ref });
    expect(await mallory.c.next("kt-lookup")).toMatchObject({ ref, lookup: { sth, entries: [] } });
    // The proven member gets the entries.
    alice.c.send({ type: "kt-lookup", ref });
    expect(((await alice.c.next("kt-lookup")).lookup as KtLookup).entries).toHaveLength(1);
    expect(asked).toEqual([null, acc.id]);
  });
});

/* ------------------------------------------------------------------ S14 */

describe("S14: a room-proof refusal says whether a join without proof is admitted", () => {
  it("legacyAllowed: true when proofs are optional — and the join without proof then gets in, unproven", async () => {
    const h = await startHub();
    const room = blindRoom();
    await joined(h, room, "Squatter", { key: roomKey() });
    const member = await join(h, room, "Real", { key: roomKey() });
    expect(await member.next("error")).toMatchObject({ code: "room-proof", legacyAllowed: true });
    member.send({ type: "join", protocol: 2, room, name: "Real" });
    expect(await member.next("joined")).toMatchObject({ proven: false });
  });

  it("legacyAllowed: false when proofs are required", async () => {
    const h = await startHub({ proofs: RoomProofs.inMemory({ required: true, ttlMs: 365 * 86_400_000 }) });
    const room = blindRoom();
    await joined(h, room, "Squatter", { key: roomKey() });
    const member = await join(h, room, "Real", { key: roomKey() });
    expect(await member.next("error")).toMatchObject({ code: "room-proof", legacyAllowed: false });
    const old = await join(h, room, "Old");
    expect(await old.next("error")).toMatchObject({ code: "room-proof-required", legacyAllowed: false });
  });
});

/* ------------------------------------------------------------------ S04 */

describe("S04: the failed-proof limit", () => {
  it("mismatches block that room for that address only; bad signatures block the address everywhere", () => {
    let now = 1_700_000_000_000;
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }, () => now);
    const squatted = blindRoom();
    const other = blindRoom();
    const squatter = roomKey();
    const real = roomKey();
    expect(proofs.check(squatted, "s", squatter.prove(squatted, "s"), "198.51.100.9").kind).toBe("proven");
    expect(proofs.check(other, "o", real.prove(other, "o"), "203.0.113.5").kind).toBe("proven");
    for (let i = 0; i < PROOF_FAILURES.max; i += 1) expect(proofs.check(squatted, `m${i}`, real.prove(squatted, `m${i}`), "203.0.113.5")).toMatchObject({ reason: "mismatch" });
    expect(proofs.check(squatted, "m", real.prove(squatted, "m"), "203.0.113.5")).toMatchObject({ kind: "refused", reason: "rate-limited" });
    expect(proofs.check(other, "o2", real.prove(other, "o2"), "203.0.113.5")).toMatchObject({ kind: "proven" });
    // Bad signatures: the address, every room.
    const bad = { pub: real.pub, sig: Buffer.alloc(64, 7).toString("base64") };
    for (let i = 0; i < PROOF_FAILURES.max; i += 1) expect(proofs.check(blindRoom(), "x", bad, "203.0.113.77")).toMatchObject({ reason: "bad-signature" });
    expect(proofs.check(other, "o3", real.prove(other, "o3"), "203.0.113.77")).toMatchObject({ reason: "rate-limited" });
    now += PROOF_FAILURES.windowMs + 1;
    expect(proofs.check(other, "o4", real.prove(other, "o4"), "203.0.113.77")).toMatchObject({ kind: "proven" });
    expect(proofs.check(squatted, "m2", real.prove(squatted, "m2"), "203.0.113.5")).toMatchObject({ reason: "mismatch" });
  });

  it("the failure maps stay bounded under many IPv4 addresses", () => {
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }, () => 1_700_000_000_000);
    const room = blindRoom();
    const bad = { pub: Buffer.alloc(32, 1).toString("base64"), sig: Buffer.alloc(64, 2).toString("base64") };
    for (let i = 0; i < 12_000; i += 1) proofs.check(room, "n", bad, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    const maps = proofs as unknown as { failures: { size: number }; roomFailures: { size: number } };
    expect(maps.failures.size).toBeLessThanOrEqual(PROOF_FAILURES.maxAddresses);
    expect(maps.roomFailures.size).toBeLessThanOrEqual(PROOF_FAILURES.maxAddresses);
  });
});

/* ------------------------------------------------------------------ S15 */

describe("S15: registering verifiers", () => {
  it("is limited per address (a /64 for IPv6): over the limit the join is admitted unproven and registers nothing", () => {
    let now = 1_700_000_000_000;
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000, registrationsPerHour: 3 }, () => now);
    const key = roomKey();
    for (let i = 0; i < 3; i += 1) {
      const r = blindRoom();
      expect(proofs.check(r, "n", key.prove(r, "n"), `2001:db8:9:9::${i + 1}`)).toMatchObject({ kind: "proven", registered: true });
    }
    const fourth = blindRoom();
    expect(proofs.check(fourth, "n", key.prove(fourth, "n"), "2001:db8:9:9::ff")).toEqual({ kind: "legacy", deferred: "registration-limit" });
    expect(proofs.hasVerifier(fourth)).toBe(false);
    // Another address registers it; a known room proves from the limited address as before.
    expect(proofs.check(fourth, "n", key.prove(fourth, "n"), "198.51.100.3")).toMatchObject({ kind: "proven", registered: true });
    expect(proofs.check(fourth, "n2", key.prove(fourth, "n2"), "2001:db8:9:9::ff")).toMatchObject({ kind: "proven", registered: false });
    now += PROOF_REGISTRATIONS.windowMs + 1;
    const fifth = blindRoom();
    expect(proofs.check(fifth, "n", key.prove(fifth, "n"), "2001:db8:9:9::1")).toMatchObject({ kind: "proven", registered: true });
  });

  it("with proofs required, a deferred registration is refused (not admitted)", () => {
    const proofs = RoomProofs.inMemory({ required: true, ttlMs: 365 * 86_400_000, registrationsPerHour: 1 });
    const key = roomKey();
    const a = blindRoom();
    const b = blindRoom();
    expect(proofs.check(a, "n", key.prove(a, "n"), "198.51.100.4").kind).toBe("proven");
    expect(proofs.check(b, "n", key.prove(b, "n"), "198.51.100.4")).toMatchObject({ kind: "refused", code: "room-proof", reason: "registration-limit" });
  });

  it("a full memory store refuses a new room (admitted unproven) and keeps every room proven within the TTL", () => {
    const now = 1_700_000_000_000;
    const proofs = new RoomProofs(new MemoryVerifiers(2), randomBytes(32), { required: false, ttlMs: 365 * 86_400_000 }, () => now);
    const key = roomKey();
    const rooms = [blindRoom(), blindRoom(), blindRoom()];
    expect(proofs.check(rooms[0], "n", key.prove(rooms[0], "n"), "198.51.100.5").kind).toBe("proven");
    expect(proofs.check(rooms[1], "n", key.prove(rooms[1], "n"), "198.51.100.6").kind).toBe("proven");
    expect(proofs.check(rooms[2], "n", key.prove(rooms[2], "n"), "198.51.100.7")).toEqual({ kind: "legacy", deferred: "verifiers-full" });
    expect(proofs.status().rooms).toBe(2);
    const squatter = roomKey();
    expect(proofs.check(rooms[0], "s", squatter.prove(rooms[0], "s"), "198.51.100.8")).toMatchObject({ reason: "mismatch" });
  });

  it("HUB_ROOM_REGISTRATIONS_PER_HOUR (default 20, 1 – 100 000)", () => {
    expect(proofSettings({}).registrationsPerHour).toBe(20);
    expect(proofSettings({ HUB_ROOM_REGISTRATIONS_PER_HOUR: "5" }).registrationsPerHour).toBe(5);
    expect(proofSettings({ HUB_ROOM_REGISTRATIONS_PER_HOUR: "0" }).registrationsPerHour).toBe(20);
    expect(proofSettings({ HUB_ROOM_REGISTRATIONS_PER_HOUR: "lots" }).registrationsPerHour).toBe(20);
  });

  it("on the hub: a deferred registration is audited, and the member is admitted unproven", async () => {
    const h = await startHub({ proofs: RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000, registrationsPerHour: 1 }) });
    const key = roomKey();
    await joined(h, blindRoom(), "First", { key });
    const room = blindRoom();
    const second = await joined(h, room, "Second", { key });
    expect(second.joined.proven).toBe(false);
    expect(audit.recent({ event: "join.room-verifier-deferred", limit: 20 }).some((e) => e.roomHash === hashRoom(room) && e.status === "registration-limit")).toBe(true);
  });
});
