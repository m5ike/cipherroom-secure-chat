// @vitest-environment node
//
// REVIEW 6.12 (server) — the hub join proof (signaling/proof.ts, hub.ts):
// adversarial checks. Each test asserts the SECURE behaviour; the ones that
// fail on de2874d3 are `it.skip` with a `REVIEW-612 Snn` note (run them
// un-skipped to see the failure).

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
import { MemoryVerifiers, PROOF_FAILURES, RoomProofs } from "../server/signaling/proof";
import { hashRoom } from "../server/monitor/traffic";
import { routeTargets } from "../server/telephony/route-audio";
import type { StoredCredential } from "../server/accounts/webauthn";
import type { DirectoryDevice } from "../client/src/lib/p4/contract";
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

const FAKE_DEVICE: DirectoryDevice = {
  pk: "pk", apk: "apk-stable-across-rooms", cert: { v: 2, exp: Date.now() + 86_400_000, sig: "sig" },
  bundle: { id: "id", dh: "dh", kem: "kem", exp: Date.now() + 86_400_000, sig: "sig" },
};

async function startHub(directory?: HubDirectory): Promise<Hub> {
  const store = new AccountStore(dir);
  const queue = new MemoryQueue();
  const hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
    roomProofs: RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }),
    ...(directory ? { directory } : {}),
  });
  const server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const h = { hub, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
  hubs.push(h);
  return h;
}

beforeEach(() => { dir = mkdtempSync(joinPath(tmpdir(), "m5cet-review-hub-")); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const h of hubs.splice(0)) {
    await h.hub.shutdown();
    h.server.closeAllConnections?.();
    await new Promise((r) => h.server.close(r));
  }
  rmSync(dir, { recursive: true, force: true });
});

async function joined(h: Hub, room: string, name: string, extra: { key?: ReturnType<typeof roomKey>; auth?: string } = {}) {
  const c = await WsClient.connect(h.base);
  clients.push(c);
  const hello = await c.next("hello");
  const nonce = String(hello.nonce);
  const proof = extra.key ? extra.key.prove(room, nonce) : undefined;
  c.send({ type: "join", protocol: 2, room, name, ...(proof ? { proof } : {}), ...(extra.auth ? { auth: extra.auth } : {}) });
  const j = await c.next("joined");
  return { c, joined: j, peerId: String(j.peerId) };
}

function account(store: AccountStore, name: string) {
  const credential: StoredCredential = { credentialId: `cred-${name}-${randomBytes(6).toString("hex")}`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = store.create(credential, name);
  if (!r.ok) throw new Error(r.reason);
  return { id: r.account.id, token: store.issueToken(r.account.id) };
}

/* ------------------------------------------------------------------ S05 */

describe("server notices by display name in a proven room (G-09 'proven only')", () => {
  // REVIEW-612 S05 (fixed): hub.notice() (console room notice, a function's m5room.user_msg / user_flash) targets by display name or
  // peer id WITHOUT reachable(): an unproven impostor who named themselves like a proven member gets the private notice.
  it("a notice to 'Alice' reaches only the proven Alice, not an unproven impostor of the same name", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    const alice = await joined(h, room, "Alice", { key });
    expect(alice.joined.proven).toBe(true);
    // Knows only the blind id: joins without a proof (admitted as legacy) under the same display name.
    const mallory = await joined(h, room, "Alice");
    expect(mallory.joined.proven).toBe(false);

    const sent = h.hub.notice(hashRoom(room)!, { kind: "message", text: "your one-time code is 4711", from: "fn" }, { name: "Alice" });
    expect((await alice.c.next("server-notice")).text).toContain("4711");
    // Secure: the impostor gets nothing and only one socket was reached — as sendToMembers() does for the phone bridge.
    expect(await mallory.c.none("server-notice", 300)).toBe(true);
    expect(sent).toBe(1);
  });

  it("(contrast) sendToMembers() — the phone bridge path — already filters the impostor", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    const alice = await joined(h, room, "Alice", { key });
    const mallory = await joined(h, room, "Alice");
    const sent = h.hub.sendToMembers(hashRoom(room)!, { type: "phone-bridge", event: "incoming" }, { name: "Alice" });
    expect(sent).toBe(1);
    await alice.c.next("phone-bridge");
    expect(await mallory.c.none("phone-bridge", 300)).toBe(true);
  });
});

/* ------------------------------------------------------------------ S07 */

describe("'proven only' follows who is connected right now, not whether the room has a verifier", () => {
  // REVIEW-612 S07 (fixed): reachable() switches to "proven only" only while a proven member is CONNECTED on the hub. When every proven
  // member is away (socket gone → held; a phone in the background), the room counts as "nobody proves" and route audio for the
  // room (and a member by name) goes to whoever is connected — an unproven joiner who knows only the blind id gets the call
  // alone (the caller's number on the card, the audio, the transcripts). The room's verifier is still registered all along.
  it("a room with a registered verifier routes the call to nobody unproven, also while its proven members are away", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    const alice = await joined(h, room, "Alice", { key });
    expect(alice.joined.proven).toBe(true);
    expect(h.hub.proofs.status().rooms).toBe(1);
    await alice.c.close(); // connection gone: Alice is held (away), not left
    await new Promise((r) => setTimeout(r, 60));

    const mallory = await joined(h, room, "Mallory");
    expect(mallory.joined.proven).toBe(false);
    const routeHub = {
      members: (r: string) => h.hub.roomMembers(r),
      send: (r: string, p: string, payload: Record<string, unknown>) => h.hub.sendToPeer(r, p, payload),
      accountMembers: (a: string) => h.hub.accountMembers(a),
    };
    const { targets } = routeTargets({ type: "room", room, user: "" } as never, routeHub);
    expect(targets.map((t) => t.name)).toEqual([]);
    // Same for the phone bridge's member by name.
    expect(h.hub.sendToMembers(hashRoom(room)!, { type: "phone-bridge", event: "incoming" }, { name: "Mallory" })).toBe(0);
  });
});

/* ------------------------------------------------------------------ S08 */

describe("route audio legs address a peer id, checked only when the leg is created", () => {
  // REVIEW-612 S08 (fixed): route-audio.ts filters members with reachable() once (routeTargets), then every later frame of the call —
  // "incoming" with the leg's media token when the provider connects (offer, :424), "status", "transcript" (the caller's speech
  // as text), tell() notices — goes through hub.sendToPeer(room, peerId) with no proof check. A peer id freed by a clean leave
  // is free for anybody: an unproven joiner who asks for it gets it and receives those frames.
  it("sendToPeer() does not deliver to an unproven member who took a proven member's freed peer id", async () => {
    const h = await startHub();
    const room = blindRoom();
    const key = roomKey();
    await joined(h, room, "Alice", { key }); // the room stays "proven" (reachable() = proven only)
    const bob = await joined(h, room, "Bob", { key });
    expect(bob.joined.proven).toBe(true);
    bob.c.send({ type: "leave", away: false });
    await new Promise((r) => setTimeout(r, 60));

    // Mallory knows only the blind id and saw Bob's peer id in the room.
    const c = await WsClient.connect(h.base);
    clients.push(c);
    await c.next("hello");
    c.send({ type: "join", protocol: 2, room, name: "Bob", peerId: bob.peerId });
    const j = await c.next("joined");
    expect(j.proven).toBe(false);
    expect(j.peerId).toBe(bob.peerId); // the freed id is hers

    const delivered = h.hub.sendToPeer(room, bob.peerId, { type: "phone-bridge", event: "transcript", text: "caller: my PIN is 1234" });
    // Secure: a server frame by peer id in a proven room reaches proven members only (as sendToMembers does).
    expect(delivered).toBe(false);
    expect(await c.none("phone-bridge", 300)).toBe(true);
  });
});

/* ------------------------------------------------------------------ S06 */

describe("key directory over the hub for members who never proved (G-09)", () => {
  // REVIEW-612 S06 (fixed): key-bundles / kt-lookup are answered to any socket in the room, also an unproven joiner who knows only the
  // blind id, in a room where members prove. It learns every signed-in member's account key (apk — stable across rooms) and,
  // through kt-lookup, u = SHA-256(label ‖ username) (see review-612-server-kt S03).
  it("an unproven joiner in a proven room gets no devices of a signed-in member", async () => {
    const h = await startHub({ devices: () => [FAKE_DEVICE], lookup: async () => null });
    const room = blindRoom();
    const key = roomKey();
    const acc = account(h.store, "alice-acc");
    const alice = await joined(h, room, "Alice", { key, auth: acc.token });
    expect(alice.joined.proven).toBe(true);
    const mallory = await joined(h, room, "Mallory");
    expect(mallory.joined.proven).toBe(false);
    const peers = mallory.joined.peers as Array<{ name: string; account?: string }>;
    const ref = peers.find((p) => p.name === "Alice")?.account;
    expect(ref).toBeTruthy();
    mallory.c.send({ type: "key-bundles", ref });
    const answer = await mallory.c.next("key-bundles");
    // Secure: like the server's own frames (reachable()), the directory answers only proven members once someone proved.
    expect(answer.devices).toEqual([]);
  });
});

/* ------------------------------------------------------------------ S04 */

describe("the failed-proof limit (PROOF_FAILURES)", () => {
  // REVIEW-612 S04a (fixed): a 'mismatch' (a VALID signature by another key — what every real member of a squatted room sends) counts
  // as a failure of the address, and a blocked address is refused for EVERY room, unchecked. A squatted room therefore locks
  // its real members out of all their other rooms too (with HUB_REQUIRE_ROOM_PROOF=1: out of the server) after 10 reconnects.
  it("10 mismatches in a squatted room do not stop the same address from proving another room", () => {
    let now = 1_700_000_000_000;
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }, () => now);
    const squatted = blindRoom();
    const other = blindRoom();
    const squatter = roomKey();
    const realSquatted = roomKey();
    const realOther = roomKey();
    expect(proofs.check(squatted, "n-s", squatter.prove(squatted, "n-s"), "198.51.100.9").kind).toBe("proven");
    expect(proofs.check(other, "n-o", realOther.prove(other, "n-o"), "203.0.113.5").kind).toBe("proven");
    for (let i = 0; i < PROOF_FAILURES.max; i += 1) {
      const r = proofs.check(squatted, `v${i}`, realSquatted.prove(squatted, `v${i}`), "203.0.113.5");
      expect(r).toMatchObject({ kind: "refused", reason: "mismatch" });
      now += 1000;
    }
    // Same member, same address, its OTHER room with the right key:
    expect(proofs.check(other, "n-o2", realOther.prove(other, "n-o2"), "203.0.113.5")).toMatchObject({ kind: "proven" });
  });

  // REVIEW-612 S04b (fixed): failures are keyed by the full address. From one IPv6 /64 (what any host gets) every address has its own
  // budget, so the limit never engages; and the map grows without bound while entries are fresh (it only drops stale ones
  // above 10 000, by scanning the whole map on every further failure — quadratic).
  it("addresses of one IPv6 /64 share the budget", () => {
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }, () => 1_700_000_000_000);
    const room = blindRoom();
    const bad = { pub: Buffer.alloc(32, 1).toString("base64"), sig: Buffer.alloc(64, 2).toString("base64") };
    for (let i = 1; i <= PROOF_FAILURES.max; i += 1) {
      expect(proofs.check(room, "n", bad, `2001:db8:1:2::${i.toString(16)}`)).toMatchObject({ reason: "bad-signature" });
    }
    expect(proofs.check(room, "n", bad, "2001:db8:1:2::ffff")).toMatchObject({ kind: "refused", reason: "rate-limited" });
  });

  // REVIEW-612 S15 (fixed): registering a verifier costs nothing — any socket may join 10 rooms/s ("signaling" bucket), each a fresh
  // r3.<random> id with a proof by a key of its own. SQLite: one persistent row per room for 365 days, no cap. Memory (no
  // storage): the 100 000 cap evicts the least recently proven verifier (an O(n) scan per registration) — a real room whose
  // members have not joined lately is pushed out, and whoever knows its blind id registers a key of their own for it.
  it("a flood of throw-away rooms cannot evict a real room's verifier (and let it be re-registered)", () => {
    let now = 1_700_000_000_000;
    const proofs = new RoomProofs(new MemoryVerifiers(1_000), randomBytes(32), { required: false, ttlMs: 365 * 86_400_000 }, () => now);
    const target = blindRoom();
    const real = roomKey();
    expect(proofs.check(target, "n0", real.prove(target, "n0"), "203.0.113.1")).toMatchObject({ kind: "proven", registered: true });
    now += 60_000;
    const junk = roomKey();
    for (let i = 0; i < 1_000; i += 1) { const r = blindRoom(); proofs.check(r, `j${i}`, junk.prove(r, `j${i}`), "198.51.100.66"); }
    const squatter = roomKey();
    expect(proofs.check(target, "n1", squatter.prove(target, "n1"), "198.51.100.66")).toMatchObject({ kind: "refused", reason: "mismatch" });
  });

  it("the failure map stays bounded under many fresh addresses", () => {
    const proofs = RoomProofs.inMemory({ required: false, ttlMs: 365 * 86_400_000 }, () => 1_700_000_000_000);
    const room = blindRoom();
    const bad = { pub: Buffer.alloc(32, 1).toString("base64"), sig: Buffer.alloc(64, 2).toString("base64") };
    for (let i = 0; i < 12_000; i += 1) proofs.check(room, "n", bad, `2001:db8::${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}`);
    const size = (proofs as unknown as { failures: Map<string, number[]> }).failures.size;
    expect(size).toBeLessThanOrEqual(10_000);
  });
});
