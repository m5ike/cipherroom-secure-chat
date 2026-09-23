// @vitest-environment node
//
// The away relay as a unit (server/signaling/relay.ts) over the in-memory
// queue: waking an away user with a push, quotas, signing out, ordered
// delivery under a lease, and the rules that keep receipts honest.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { AccountStore, type PushTarget } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { QUEUE_LIMITS } from "../server/accounts/mailqueue";
import { AwayRelay, type RelayPeer } from "../server/signaling/relay";
import { accountRef } from "../server/signaling/refs";
import type { StoredCredential } from "../server/accounts/webauthn";

const credential = (id: string): StoredCredential => ({ credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });
const ENVELOPE = { iv: "aXY=", ciphertext: "Y3Q=" };

let dir = "";
let store: AccountStore;
let queue: MemoryQueue;
let rooms: Map<string, Map<string, RelayPeer>>;
let sent: Array<{ socket: WebSocket; payload: Record<string, unknown> }>;
let pushed: Array<{ target: PushTarget; payload: { url: string; body: string } }>;
let pushResult: { ok: boolean; error?: string };
let now = 1_700_000_000_000;

function peer(id: string, room: string | null, name: string, extra: Partial<RelayPeer> = {}): RelayPeer {
  const socket = { id } as unknown as WebSocket;
  const p: RelayPeer = { id, connId: `c-${id}`, room, name, socket, ...extra };
  if (room) {
    if (!rooms.has(room)) rooms.set(room, new Map());
    rooms.get(room)!.set(id, p);
  }
  return p;
}

function makeRelay() {
  return new AwayRelay(
    store,
    rooms,
    (socket, payload) => { sent.push({ socket, payload: payload as Record<string, unknown> }); return true; },
    () => queue,
    async (target, payload) => { pushed.push({ target, payload }); return pushResult; },
    () => now,
  );
}

function account(name: string) {
  const r = store.create(credential(`cred-${name}-0000000`), name, now);
  if (!r.ok) throw new Error(r.reason);
  return r.account;
}

const away = (relay: AwayRelay, accountId: string, room: string, name: string) => relay.restore([{ accountId, room, name, since: now }]);
const statuses = () => sent.filter((s) => s.payload.type === "relay-status").map((s) => s.payload.state);
const to = (room: string, accountId: string) => [accountRef(room, accountId)];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-relay-push-"));
  store = new AccountStore(dir);
  queue = new MemoryQueue(() => now);
  rooms = new Map();
  sent = [];
  pushed = [];
  pushResult = { ok: true };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("waking an away user", () => {
  it("pushes a flash message that opens /signin", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/alice", keys: { p256dh: "p", auth: "a" } }, now);
    away(relay, acc.id, "alpha", "Alice");
    const bob = peer("bob", "alpha", "Bob");

    await relay.relay(bob, { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });

    expect(statuses()).toEqual(["stored"]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].payload.url).toBe("/signin");
    expect(pushed[0].payload.body).toContain("Bob");
    // The push says who and where — never what.
    expect(JSON.stringify(pushed[0].payload)).not.toContain(ENVELOPE.ciphertext);
    expect(store.get(acc.id)!.audit.map((e) => e.kind)).toContain("push-sent");
  });

  it("throttles a burst to one wake-up per room", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/alice", keys: { p256dh: "p", auth: "a" } }, now);
    away(relay, acc.id, "alpha", "Alice");
    const bob = peer("bob", "alpha", "Bob");

    for (const id of ["m1", "m2", "m3"]) await relay.relay(bob, { messageId: id, to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(pushed).toHaveLength(1);
    expect(queue.pending(acc.id, "alpha")).toHaveLength(3); // all three still waiting

    now += 31_000; // past the throttle window
    await relay.relay(bob, { messageId: "m4", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(pushed).toHaveLength(2);
  });

  it("forgets an endpoint the push service reports as gone", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/dead", keys: { p256dh: "p", auth: "a" } }, now);
    away(relay, acc.id, "alpha", "Alice");
    pushResult = { ok: false, error: "Received unexpected response code 410" };

    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(store.get(acc.id)!.push).toHaveLength(0);
    // The message itself is still waiting for her.
    expect(queue.pending(acc.id, "alpha")).toHaveLength(1);
  });

  it("stores without a push when no device is linked", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(pushed).toHaveLength(0);
    expect(statuses()).toEqual(["stored"]);
  });
});

describe("addressing", () => {
  it("only reaches accounts of this room, and says the same thing for every miss", async () => {
    const relay = makeRelay();
    const alice = account("Alice");
    const erin = account("Erin");
    away(relay, alice.id, "alpha", "Alice");
    const bob = peer("bob", "alpha", "Bob");

    // Erin's real id, Erin's reference for another room, and nonsense.
    await relay.relay(bob, { messageId: "m1", to: [erin.id, accountRef("beta", alice.id), "garbage"], envelope: ENVELOPE });
    const answers = sent.filter((s) => s.payload.type === "relay-status").map((s) => s.payload);
    expect(answers.map((a) => [a.state, a.reason])).toEqual([["rejected", "not reachable"], ["rejected", "not reachable"], ["rejected", "not reachable"]]);
    expect(queue.pending(alice.id)).toHaveLength(0);
  });

  it("uses a different, stable reference for the same account in each room", () => {
    const acc = account("Alice");
    expect(accountRef("alpha", acc.id)).toBe(accountRef("alpha", acc.id));
    expect(accountRef("alpha", acc.id)).not.toBe(accountRef("beta", acc.id));
    expect(accountRef("alpha", acc.id)).not.toContain(acc.id);
  });

  it("stores a message relayed twice only once", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    const bob = peer("bob", "alpha", "Bob");
    await relay.relay(bob, { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    await relay.relay(bob, { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(statuses()).toEqual(["stored", "duplicate"]);
    expect(queue.pending(acc.id)).toHaveLength(1);
  });
});

describe("relay limits", () => {
  it("rejects a message that does not fit the mailbox", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    const huge = { iv: "aXY=", ciphertext: "A".repeat(QUEUE_LIMITS.maxItemBytes + 10) };
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: huge });
    expect(statuses()).toEqual(["rejected"]);
    expect(queue.pending(acc.id)).toHaveLength(0);
  });

  it("stops one sender from filling the mailbox", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    const bob = peer("bob", "alpha", "Bob");
    for (let i = 0; i <= QUEUE_LIMITS.maxItemsPerSender; i++) await relay.relay(bob, { messageId: `m${i}`, to: to("alpha", acc.id), envelope: ENVELOPE });
    const last = sent.filter((s) => s.payload.type === "relay-status").at(-1)!.payload;
    expect(last).toMatchObject({ state: "rejected", reason: "mailbox full" });
    expect(queue.pending(acc.id)).toHaveLength(QUEUE_LIMITS.maxItemsPerSender);
  });

  it("ignores a relay from a client that is not in a room", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    await relay.relay(peer("nomad", null, "Nomad"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(sent).toHaveLength(0);
    expect(queue.pending(acc.id)).toHaveLength(0);
  });
});

describe("signing out", () => {
  it("stops the server answering for the account and tells the room", () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    peer("bob", "alpha", "Bob");

    relay.forget(acc.id);

    expect(relay.isAway(acc.id, "alpha")).toBe(false);
    const ref = accountRef("alpha", acc.id);
    expect(sent.map((s) => s.payload)).toEqual([{ type: "peer-gone", account: ref, accountId: ref }]);
  });
});

describe("delivery to a returning user", () => {
  it("sends the mailbox in order, in batches, and only for the room they joined", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    away(relay, acc.id, "beta", "Alice");
    const bob = peer("bob", "alpha", "Bob");
    const carol = peer("carol", "beta", "Carol");
    for (let i = 0; i < 60; i++) await relay.relay(bob, { messageId: `a${i}`, to: to("alpha", acc.id), envelope: ENVELOPE });
    await relay.relay(carol, { messageId: "b1", to: to("beta", acc.id), envelope: ENVELOPE });

    sent = [];
    const alice = peer("alice-1", "alpha", "Alice", { accountId: acc.id, awayEnabled: true });
    relay.onJoin(alice);

    const deliveries = sent.filter((s) => s.payload.type === "relay-deliver");
    expect(deliveries).toHaveLength(2); // 60 items → batches of 50
    const items = deliveries.flatMap((d) => d.payload.items as Array<{ messageId: string; seq: number }>);
    expect(items.map((i) => i.messageId)).toEqual(Array.from({ length: 60 }, (_, i) => `a${i}`));
    expect(items.map((i) => i.seq)).toEqual([...items.map((i) => i.seq)].sort((a, b) => a - b));
    expect(items.map((i) => i.messageId)).not.toContain("b1"); // the other room waits
    expect(relay.isAway(acc.id, "alpha")).toBe(false);
    expect(relay.isAway(acc.id, "beta")).toBe(true);
  });

  it("hands leased items out again at once when the socket goes before acknowledging", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });

    const tab1 = peer("alice-1", "alpha", "Alice", { accountId: acc.id, awayEnabled: true });
    expect(relay.deliver(tab1)).toBe(1);
    // A second delivery right away finds nothing: the item is leased.
    expect(relay.deliver(tab1)).toBe(0);
    // The tab reloads without acknowledging.
    relay.release(tab1);
    const tab2 = peer("alice-2", "alpha", "Alice", { accountId: acc.id, awayEnabled: true });
    expect(relay.deliver(tab2)).toBe(1);
  });

  it("stays present while another awake tab of the same account is in the room", () => {
    const relay = makeRelay();
    const acc = account("Alice");
    peer("bob", "alpha", "Bob");
    const tab1 = peer("alice-1", "alpha", "Alice", { accountId: acc.id, awayEnabled: true });
    peer("alice-2", "alpha", "Alice", { accountId: acc.id, awayEnabled: true });
    expect(relay.setPresence(tab1, true)).toBe(false);
    expect(relay.isAway(acc.id, "alpha")).toBe(false);
  });
});

describe("receipts", () => {
  it("routes a read receipt only for a message relayed to that reader", async () => {
    const relay = makeRelay();
    const alice = account("Alice");
    const mallory = account("Mallory");
    away(relay, alice.id, "alpha", "Alice");
    const bob = peer("bob", "alpha", "Bob");
    await relay.relay(bob, { messageId: "m1", to: to("alpha", alice.id), envelope: ENVELOPE });

    sent = [];
    // Mallory is in the room but the message was never relayed to her.
    const intruder = peer("mallory", "alpha", "Mallory", { accountId: mallory.id });
    expect(relay.receipt(intruder, ["m1"], "read")).toBe(0);
    // A message id nobody relayed.
    const reader = peer("alice-1", "alpha", "Alice", { accountId: alice.id });
    expect(relay.receipt(reader, ["never-relayed"], "read")).toBe(0);
    expect(sent).toHaveLength(0);

    expect(relay.receipt(reader, ["m1"], "read")).toBe(1);
    expect(sent.map((s) => s.payload)).toEqual([expect.objectContaining({ type: "relay-status", messageId: "m1", state: "read" })]);
    expect(sent[0].socket).toBe(bob.socket);
  });
});
