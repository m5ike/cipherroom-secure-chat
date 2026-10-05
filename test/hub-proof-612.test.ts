// @vitest-environment node
//
// 6.12 — the hub join proof (protocol 4, § 13; security analysis G-09):
// the hello's nonce, a proof registering a room's verifier, the same key
// proving again, another key / a bad signature / a proof replayed from
// another socket refused and audited by room hash only, joins without a proof
// admitted as legacy and shown unproven, plain room names never proven,
// HUB_REQUIRE_ROOM_PROOF, the TTL, the per-address limit on failed proofs,
// verifiers in SQLite, `proven` in held and remote (cluster) views — and the
// server-side features that reach a room by itself (route audio, the phone
// bridge's member by name) addressing only proven members.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { SignalingHub } from "../server/signaling/hub";
import { MemoryNetwork } from "../server/cluster/bus";
import {
  MemoryVerifiers, PROOF_FAILURES, RoomProofs, SqliteVerifiers, canProve, hubJoinMessage, proofSettings, reachable, verifyHubProof,
  type VerifierStore,
} from "../server/signaling/proof";
import { audit } from "../server/monitor/audit";
import { hashRoom } from "../server/monitor/traffic";
import { loadSqliteDriver, openPlainDatabase } from "../server/storage/db";
import { routeTargets } from "../server/telephony/route-audio";
import type { InrouteEntry } from "../server/telephony/control/types";
import type { StoredCredential } from "../server/accounts/webauthn";
import { WsClient } from "./helpers/ws-client";

/* ------------------------------------------------------------- helpers */

const blindRoom = () => `r3.${randomBytes(24).toString("base64url")}`;

/** A room key's hub key pair (a client derives it from the room secret: LABEL.hubSeed). */
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

async function startHub(opts: { proofs?: RoomProofs; cluster?: ReturnType<MemoryNetwork["bus"]>; store?: AccountStore } = {}): Promise<Hub> {
  const store = opts.store ?? new AccountStore(dir);
  const queue = new MemoryQueue();
  const hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
    roomProofs: opts.proofs ?? RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }),
    ...(opts.cluster ? { cluster: opts.cluster } : {}),
  });
  const server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const h = { hub, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
  hubs.push(h);
  return h;
}

beforeEach(() => { dir = mkdtempSync(joinPath(tmpdir(), "m5cet-proof-")); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const h of hubs.splice(0)) {
    await h.hub.shutdown();
    h.server.closeAllConnections?.();
    await new Promise((r) => h.server.close(r));
  }
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HUB_REQUIRE_ROOM_PROOF;
});

async function connect(h: Hub) {
  const c = await WsClient.connect(h.base);
  clients.push(c);
  const hello = await c.next("hello");
  return { c, nonce: String(hello.nonce), hello };
}

/** Joins `room`; `prove` signs the socket's nonce (or replaces the proof entirely). */
async function join(h: Hub, room: string, name: string, extra: { key?: ReturnType<typeof roomKey>; proof?: unknown; auth?: string } = {}) {
  const { c, nonce, hello } = await connect(h);
  const proof = extra.proof ?? (extra.key ? extra.key.prove(room, nonce) : undefined);
  c.send({ type: "join", protocol: 2, room, name, peerId: hello.peerId, ...(proof ? { proof } : {}), ...(extra.auth ? { auth: extra.auth } : {}) });
  return { c, nonce };
}

async function joined(h: Hub, room: string, name: string, extra: Parameters<typeof join>[3] = {}) {
  const { c, nonce } = await join(h, room, name, extra);
  const j = await c.next("joined");
  return { c, nonce, joined: j, peerId: String(j.peerId) };
}

function account(store: AccountStore, name: string) {
  const credential: StoredCredential = { credentialId: `cred-${name}-000000000`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = store.create(credential, name);
  if (!r.ok) throw new Error(r.reason);
  return { id: r.account.id, token: store.issueToken(r.account.id) };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

/* ---------------------------------------------------------------- hub */

describe("hello nonce and join proof", () => {
  it("greets every socket with its own 24-byte nonce", async () => {
    const h = await startHub();
    const a = await connect(h);
    const b = await connect(h);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(a.nonce, "base64url")).toHaveLength(24);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("registers the room's verifier with the first proven join; the same key proves again — both shown proven", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    const a = await joined(h, room, "Alice", { key });
    expect(a.joined.proven).toBe(true);
    expect(h.hub.proofs.status().rooms).toBe(1);
    const registered = audit.recent({ event: "join.room-verifier-registered", limit: 5 }).find((e) => e.roomHash === hashRoom(room));
    expect(registered).toBeTruthy();

    const b = await joined(h, room, "Bob", { key });
    expect(b.joined.proven).toBe(true);
    expect(b.joined.peers).toEqual([expect.objectContaining({ peerId: a.peerId, proven: true })]);
    expect(await a.c.next("peer-joined")).toMatchObject({ peerId: b.peerId, proven: true });
    expect(h.hub.roomMembers(room).map((m) => m.proven)).toEqual([true, true]);
  });

  it("refuses a proof with another key, and audits it by the room's hash only", async () => {
    const h = await startHub();
    const room = blindRoom();
    const a = await joined(h, room, "Alice", { key: roomKey() });
    const intruder = await join(h, room, "Mallory", { key: roomKey() });
    expect(await intruder.c.next("error")).toMatchObject({ code: "room-proof" });
    expect(await intruder.c.none("joined")).toBe(true);
    expect(await a.c.none("peer-joined")).toBe(true);
    expect(h.hub.roomMembers(room)).toHaveLength(1);

    const refused = audit.recent({ event: "join.room-proof-refused", limit: 20 }).filter((e) => e.roomHash === hashRoom(room));
    expect(refused).toEqual([expect.objectContaining({ category: "security", status: "mismatch" })]);
    expect(JSON.stringify(audit.recent({ limit: 2000 }))).not.toContain(room);
  });

  it("refuses a bad signature and a proof replayed from another socket (its nonce)", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    const a = await joined(h, room, "Alice", { key });
    // A proof made for Alice's socket, sent on another one.
    const replay = await join(h, room, "Replay", { proof: key.prove(room, a.nonce) });
    expect(await replay.c.next("error")).toMatchObject({ code: "room-proof" });
    expect(await replay.c.none("joined")).toBe(true);
    // A signature over the right nonce but another room.
    const other = await connect(h);
    other.c.send({ type: "join", protocol: 2, room, name: "Other", proof: key.prove(blindRoom(), other.nonce) });
    expect(await other.c.next("error")).toMatchObject({ code: "room-proof" });
    // Not a signature at all.
    const junk = await join(h, room, "Junk", { proof: { pub: key.pub, sig: Buffer.alloc(64, 7).toString("base64") } });
    expect(await junk.c.next("error")).toMatchObject({ code: "room-proof" });
    expect(audit.recent({ event: "join.room-proof-refused", limit: 50 }).filter((e) => e.roomHash === hashRoom(room)).map((e) => e.status)).toEqual(["bad-signature", "bad-signature", "bad-signature"]);
    expect(h.hub.roomMembers(room)).toHaveLength(1);
  });

  it("refuses a malformed proof as an invalid frame", async () => {
    const h = await startHub();
    const bad = await join(h, blindRoom(), "Bad", { proof: { pub: "not base64!", sig: 5 } });
    expect(await bad.c.next("error")).toMatchObject({ code: "invalid-frame" });
  });

  it("admits a join without a proof (clients before 6.12) and shows it unproven to everyone", async () => {
    const h = await startHub();
    const room = blindRoom();
    const a = await joined(h, room, "Alice", { key: roomKey() });
    const legacy = await joined(h, room, "Old client");
    expect(legacy.joined.proven).toBe(false);
    expect(legacy.joined.peers).toEqual([expect.objectContaining({ peerId: a.peerId, proven: true })]);
    expect(await a.c.next("peer-joined")).toMatchObject({ peerId: legacy.peerId, proven: false });
  });

  it("never proves a room joined by its plain name (protocol 2): legacy, no verifier", async () => {
    const h = await startHub();
    const key = roomKey();
    expect(canProve("plain room")).toBe(false);
    const a = await joined(h, "plain-room", "Alice", { key });
    expect(a.joined.proven).toBe(false);
    expect(h.hub.proofs.status().rooms).toBe(0);
  });

  it("keeps `proven` on a held member (connection gone) and in the joined.held list", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    const a = await joined(h, room, "Alice", { key });
    const b = await joined(h, room, "Bob", { key });
    a.c.socket.terminate();
    expect(await b.c.next("peer-left")).toMatchObject({ peerId: a.peerId, held: true, proven: true });
    const late = await joined(h, room, "Late");
    expect(late.joined.held).toEqual([expect.objectContaining({ peerId: a.peerId, proven: true })]);
  });

  it("HUB_REQUIRE_ROOM_PROOF: a blind room refuses joins without a proof; plain names stay legacy", async () => {
    expect(proofSettings({ HUB_REQUIRE_ROOM_PROOF: "1" }).required).toBe(true);
    expect(proofSettings({ HUB_REQUIRE_ROOM_PROOF: "0" }).required).toBe(false);
    expect(proofSettings({}).ttlMs).toBe(365 * 86_400_000);
    expect(proofSettings({ HUB_ROOM_PROOF_TTL_DAYS: "30" }).ttlMs).toBe(30 * 86_400_000);
    expect(proofSettings({ HUB_ROOM_PROOF_TTL_DAYS: "-4" }).ttlMs).toBe(365 * 86_400_000);

    const h = await startHub({ proofs: RoomProofs.inMemory({ required: true, ttlMs: 86_400_000 }) });
    const room = blindRoom();
    const old = await join(h, room, "Old client");
    expect(await old.c.next("error")).toMatchObject({ code: "room-proof-required" });
    expect(await old.c.none("joined")).toBe(true);
    expect(audit.recent({ event: "join.room-proof-required", limit: 10 }).some((e) => e.roomHash === hashRoom(room))).toBe(true);
    const ok = await joined(h, room, "New client", { key: roomKey() });
    expect(ok.joined.proven).toBe(true);
    const plain = await joined(h, "plain-required", "Plain");
    expect(plain.joined.proven).toBe(false);
  });
});

/* ------------------------------------------------------------ checker */

describe("RoomProofs", () => {
  const sign = (key: ReturnType<typeof roomKey>, room: string, nonce = "nonce-1") => ({ nonce, proof: key.prove(room, nonce) });

  it("verifies exactly join(LABEL.hubJoin, roomId, nonce)", () => {
    const key = roomKey();
    const room = blindRoom();
    expect(hubJoinMessage(room, "n").toString()).toBe(`m5cet/hub-join/4|${room}|n`);
    expect(verifyHubProof(key.prove(room, "n"), room, "n")).toBe(true);
    expect(verifyHubProof(key.prove(room, "n"), room, "m")).toBe(false);
    expect(verifyHubProof({ pub: key.pub, sig: "AAAA" }, room, "n")).toBe(false);
    expect(verifyHubProof({ pub: "AAAA", sig: key.prove(room, "n").sig }, room, "n")).toBe(false);
  });

  it("forgets a verifier nobody proved for the TTL: then another key registers", () => {
    let now = 1_000_000;
    const ttlMs = 10 * 86_400_000;
    const proofs = RoomProofs.inMemory({ required: false, ttlMs }, () => now);
    const room = blindRoom();
    const first = roomKey();
    const second = roomKey();
    const p1 = sign(first, room);
    expect(proofs.check(room, p1.nonce, p1.proof, "1.1.1.1")).toEqual({ kind: "proven", registered: true });
    now += ttlMs - 1;
    const p2 = sign(second, room);
    expect(proofs.check(room, p2.nonce, p2.proof, "1.1.1.2")).toMatchObject({ kind: "refused", reason: "mismatch" });
    now += 2;
    expect(proofs.check(room, p2.nonce, p2.proof, "1.1.1.2")).toEqual({ kind: "proven", registered: true });
    // The sweep drops what nobody proved since.
    now += ttlMs + 1;
    expect(proofs.sweep(now)).toBe(1);
    expect(proofs.status().rooms).toBe(0);
  });

  it("reset(): the operator forgets a squatted room's verifier; the real key registers again", () => {
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 });
    const room = blindRoom();
    const squatter = roomKey();
    const real = roomKey();
    const ps = sign(squatter, room);
    expect(proofs.check(room, ps.nonce, ps.proof, "9.9.9.9")).toEqual({ kind: "proven", registered: true });
    const pr = sign(real, room);
    expect(proofs.check(room, pr.nonce, pr.proof, "1.1.1.1")).toMatchObject({ kind: "refused", reason: "mismatch" });
    expect(proofs.reset(room)).toBe(true);
    expect(proofs.reset(room)).toBe(false);
    expect(proofs.reset("plain-room-name")).toBe(false);
    expect(proofs.check(room, pr.nonce, pr.proof, "1.1.1.1")).toEqual({ kind: "proven", registered: true });
  });

  it("refuses proofs unchecked from an address with too many failures, until the window passes", () => {
    let now = 5_000_000;
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 86_400_000 }, () => now);
    const room = blindRoom();
    const key = roomKey();
    const good = sign(key, room);
    expect(proofs.check(room, good.nonce, good.proof, "9.9.9.9").kind).toBe("proven");
    for (let i = 0; i < PROOF_FAILURES.max; i += 1) {
      expect(proofs.check(room, "nonce-x", key.prove(room, "other"), "6.6.6.6")).toMatchObject({ kind: "refused", reason: "bad-signature" });
    }
    expect(proofs.check(room, good.nonce, good.proof, "6.6.6.6")).toMatchObject({ kind: "refused", code: "room-proof", reason: "rate-limited" });
    expect(proofs.check(room, good.nonce, good.proof, "9.9.9.9").kind).toBe("proven");
    now += PROOF_FAILURES.windowMs + 1;
    expect(proofs.check(room, good.nonce, good.proof, "6.6.6.6").kind).toBe("proven");
  });

  it("a verifier store that fails: legacy when proofs are optional, refused when required", () => {
    const broken: VerifierStore = {
      persistent: true,
      get: () => { throw new Error("SQLITE_BUSY"); },
      register: () => { throw new Error("SQLITE_BUSY"); },
      touch: () => undefined, remove: () => undefined, sweep: () => 0, count: () => 0,
    };
    const room = blindRoom();
    const p = sign(roomKey(), room);
    expect(new RoomProofs(broken, randomBytes(32), { required: false, ttlMs: 1 }).check(room, p.nonce, p.proof, "ip")).toMatchObject({ kind: "legacy", error: "SQLITE_BUSY" });
    expect(new RoomProofs(broken, randomBytes(32), { required: true, ttlMs: 1 }).check(room, p.nonce, p.proof, "ip")).toMatchObject({ kind: "refused", reason: "store-error" });
  });

  it("memory verifiers are bounded (the least recently proven goes)", () => {
    const store = new MemoryVerifiers(2);
    store.register("a", "", "A", 1);
    store.register("b", "", "B", 2);
    store.register("c", "", "C", 3);
    expect(store.count()).toBe(2);
    expect(store.get("a")).toBeNull();
  });

  describe("in SQLite", () => {
    beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });

    it("keeps verifiers across a restart, keyed by an HMAC — the database never holds the blind id", () => {
      const file = joinPath(dir, "m5cet.db");
      const secret = randomBytes(32);
      const room = blindRoom();
      const key = roomKey();
      const db = openPlainDatabase(file, []);
      const first = new RoomProofs(new SqliteVerifiers(db), secret, { required: false, ttlMs: 86_400_000 });
      const p = sign(key, room);
      expect(first.check(room, p.nonce, p.proof, "ip").kind).toBe("proven");
      db.close();

      const again = openPlainDatabase(file, []);
      const second = new RoomProofs(new SqliteVerifiers(again), secret, { required: false, ttlMs: 86_400_000 });
      expect(second.status()).toMatchObject({ persistent: true, rooms: 1 });
      const other = sign(roomKey(), room, "nonce-2");
      expect(second.check(room, other.nonce, other.proof, "ip")).toMatchObject({ kind: "refused", reason: "mismatch" });
      const same = sign(key, room, "nonce-3");
      expect(second.check(room, same.nonce, same.proof, "ip")).toMatchObject({ kind: "proven", registered: false });
      const row = again.prepare("SELECT * FROM hub_room_verifiers").get() as Record<string, unknown>;
      expect(row.room_key).toBe(second.roomKey(room));
      expect(row.room_hash).toBe(hashRoom(room));
      again.close();
      for (const f of [file, `${file}-wal`]) {
        let bytes = "";
        try { bytes = readFileSync(f).toString("latin1"); } catch { continue; }
        expect(bytes).not.toContain(room);
      }
    });
  });
});

/* ------------------------------------------- proven-only server features */

describe("server features reach proven members only (G-09)", () => {
  const ROOM = "r3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const entry = (over: Partial<InrouteEntry> = {}): InrouteEntry => ({
    code: "4321", type: "room", room: ROOM, user: "", label: "Recepce", ttlSec: 600, createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    createdBy: { kind: "console", id: "boss" }, uses: 0, maxUses: 0, ...over,
  });
  const fake = (members: Array<{ peerId: string; name: string; accountId?: string; proven?: boolean }>) => ({
    members: (room: string) => (room === ROOM ? members : []),
    send: () => true,
    accountMembers: () => [],
  });

  it("reachable(): proven only once anyone proved; everyone in a room where nobody proves; proven only when required", () => {
    const mixed = [{ id: "a", proven: true }, { id: "b", proven: false }, { id: "c" }];
    expect(reachable(mixed, false).map((m) => m.id)).toEqual(["a"]);
    expect(reachable([{ id: "b", proven: false }, { id: "c" }], false).map((m) => m.id)).toEqual(["b", "c"]);
    expect(reachable([{ id: "b", proven: false }], true)).toEqual([]);
    expect(reachable(mixed, true).map((m) => m.id)).toEqual(["a"]);
  });

  it("route audio: the room's audio and a member by name only among proven members; @account needs no proof", () => {
    const hub = fake([
      { peerId: "p-eva", name: "Eva", proven: true },
      { peerId: "p-karel", name: "Karel", proven: false },
      { peerId: "p-acc", name: "Signed", accountId: "acc01", proven: false },
    ]);
    expect(routeTargets(entry(), hub).targets.map((t) => t.peerId)).toEqual(["p-eva"]);
    expect(routeTargets(entry({ type: "user", user: "Karel" }), hub).targets).toEqual([]);
    expect(routeTargets(entry({ type: "user", user: "eva" }), hub).targets.map((t) => t.peerId)).toEqual(["p-eva"]);
    expect(routeTargets(entry({ type: "user", user: "@ACC01" }), hub).targets.map((t) => t.peerId)).toEqual(["p-acc"]);
  });

  it("route audio in a room where nobody proves: everyone, as before — unless HUB_REQUIRE_ROOM_PROOF=1", () => {
    const hub = fake([{ peerId: "p-1", name: "One" }, { peerId: "p-2", name: "Two", proven: false }]);
    expect(routeTargets(entry(), hub).targets.map((t) => t.peerId)).toEqual(["p-1", "p-2"]);
    expect(routeTargets(entry({ type: "user", user: "two" }), hub).targets.map((t) => t.peerId)).toEqual(["p-2"]);
    process.env.HUB_REQUIRE_ROOM_PROOF = "1";
    expect(routeTargets(entry(), hub).targets).toEqual([]);
    expect(routeTargets(entry({ type: "user", user: "two" }), hub).targets).toEqual([]);
  });

  it("on the hub: route members carry `proven`; the phone bridge's member by name reaches only a proven one, by account anyone", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    const signed = account(h.store, "Signed");
    const eva = await joined(h, room, "Eva", { key });
    const legacyEva = await joined(h, room, "Eva");
    const acc = await joined(h, room, "Acc", { auth: signed.token });
    expect(h.hub.roomMembers(room).map((m) => [m.name, m.proven])).toEqual([["Eva", true], ["Eva", false], ["Acc", false]]);

    const routeHub = { members: (r: string) => h.hub.roomMembers(r), send: () => true, accountMembers: (a: string) => h.hub.accountMembers(a) };
    expect(routeTargets({ type: "room", room, user: "" }, routeHub).targets.map((t) => t.peerId)).toEqual([eva.peerId]);
    expect(routeTargets({ type: "user", room, user: `@${signed.id}` }, routeHub).targets.map((t) => t.peerId)).toEqual([acc.peerId]);

    const hash = hashRoom(room)!;
    expect(h.hub.sendToMembers(hash, { type: "phone-bridge", event: "incoming", session: "b1" }, { name: "eva" })).toBe(1);
    expect(await eva.c.next("phone-bridge")).toMatchObject({ session: "b1" });
    expect(await legacyEva.c.none("phone-bridge")).toBe(true);
    // By peer id: the unproven member is not reachable while someone proved.
    expect(h.hub.sendToMembers(hash, { type: "phone-bridge", event: "incoming", session: "b2" }, { peerId: legacyEva.peerId })).toBe(0);
    // By account: authenticated by the session.
    expect(h.hub.sendToMembers(hash, { type: "phone-bridge", event: "incoming", session: "b3" }, { accountId: signed.id })).toBe(1);
    expect(await acc.c.next("phone-bridge")).toMatchObject({ session: "b3" });
  });
});

/* -------------------------------------------------------------- cluster */

describe("in a cluster", () => {
  it("members on another instance are shown with `proven`, and a room shares its verifier through the database", async () => {
    const network = new MemoryNetwork();
    const store = new AccountStore(dir);
    // One verifier table for both instances, as with one DATA_DIR.
    const verifiers = new MemoryVerifiers();
    const secret = randomBytes(32);
    const settings = { required: false, ttlMs: 86_400_000 };
    const a = await startHub({ store, cluster: network.bus("inst-a", "s"), proofs: new RoomProofs(verifiers, secret, settings) });
    const b = await startHub({ store, cluster: network.bus("inst-b", "s"), proofs: new RoomProofs(verifiers, secret, settings) });
    await settle();
    const room = blindRoom();
    const key = roomKey();
    const alice = await joined(a, room, "Alice", { key });
    await settle();
    const bob = await joined(b, room, "Bob");
    expect(bob.joined.peers).toEqual([expect.objectContaining({ peerId: alice.peerId, proven: true })]);
    const carol = await joined(b, room, "Carol", { key });
    expect(carol.joined.proven).toBe(true);
    await settle();
    expect(await alice.c.next("peer-joined")).toMatchObject({ peerId: bob.peerId, proven: false });
    expect(await alice.c.next("peer-joined")).toMatchObject({ peerId: carol.peerId, proven: true });
    // Another key on the other instance is refused there too.
    const mallory = await join(b, room, "Mallory", { key: roomKey() });
    expect(await mallory.c.next("error")).toMatchObject({ code: "room-proof" });
  });
});
