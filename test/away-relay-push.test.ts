// @vitest-environment node
//
// The away relay as a unit (server/signaling/relay.ts) over the in-memory
// queue: waking an away user (6.7: through the notifier, here with its web
// push channel and a stand-in for the push service), quotas, signing out,
// ordered delivery under a lease, and the rules that keep receipts honest.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { QUEUE_LIMITS } from "../server/accounts/mailqueue";
import { AwayRelay, type RelayPeer, type WakeRequest } from "../server/signaling/relay";
import { accountRef } from "../server/signaling/refs";
import type { StoredCredential } from "../server/accounts/webauthn";
import { Notifier } from "../server/notify/dispatch";
import { NotifyStore } from "../server/notify/store";
import { webPushChannel } from "../server/notify/channels";
import { DEFAULT_NOTIFY_CONFIG } from "../server/notify/config";
import type { WebPushResult } from "../server/push";

const credential = (id: string): StoredCredential => ({ credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });
const ENVELOPE = { iv: "aXY=", ciphertext: "Y3Q=" };

let dir = "";
let store: AccountStore;
let notifyStore: NotifyStore;
let queue: MemoryQueue;
let rooms: Map<string, Map<string, RelayPeer>>;
let sent: Array<{ socket: WebSocket; payload: Record<string, unknown> }>;
let pushed: Array<{ endpoint: string; payload: Record<string, unknown> }>;
let wakes: WakeRequest[];
let pushResult: WebPushResult;
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
  let relay: AwayRelay | null = null;
  const notifier = new Notifier({
    accounts: store,
    store: notifyStore,
    config: () => DEFAULT_NOTIFY_CONFIG,
    channels: [webPushChannel({ accounts: store, ready: () => true, send: async (target, payload) => { pushed.push({ endpoint: target.endpoint, payload }); return pushResult; } })],
    present: (accountId, room) => relay?.present(accountId, room) ?? false,
    now: () => now,
  });
  relay = new AwayRelay(
    store,
    rooms,
    (socket, payload) => { sent.push({ socket, payload: payload as Record<string, unknown> }); return true; },
    () => queue,
    async (req) => { wakes.push(req); return notifier.notify(req); },
    () => now,
  );
  return relay;
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
  notifyStore = new NotifyStore(() => join(dir, "notify"));
  queue = new MemoryQueue(() => now);
  rooms = new Map();
  sent = [];
  pushed = [];
  wakes = [];
  pushResult = { ok: true };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("waking an away user", () => {
  it("pushes a notification that opens /signin — no content, and by default no sender or room", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/alice", keys: { p256dh: "p", auth: "a" } }, now);
    away(relay, acc.id, "alpha", "Alice");
    const bob = peer("bob", "alpha", "Bob");

    await relay.relay(bob, { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });

    expect(statuses()).toEqual(["stored"]);
    expect(wakes).toEqual([{ accountId: acc.id, room: "alpha", kind: "message", from: { name: "Bob" }, count: 1 }]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].payload).toMatchObject({ url: "/signin", kind: "message", title: "M5cet", body: "New message", privacy: "neutral" });
    // A locked screen shows it: no content, no sender, no room.
    const text = JSON.stringify(pushed[0].payload);
    expect(text).not.toContain(ENVELOPE.ciphertext);
    expect(text).not.toContain("Bob");
    expect(text).not.toContain("alpha");
    expect(store.get(acc.id)!.audit.map((e) => e.kind)).toContain("push-sent");
  });

  it("shows the sender only when the user chose it", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/alice", keys: { p256dh: "p", auth: "a" } }, now);
    notifyStore.setPrefs(acc.id, { privacy: "sender" });
    away(relay, acc.id, "alpha", "Alice");
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(pushed[0].payload).toMatchObject({ body: "Bob: New message", privacy: "sender" });
    expect(JSON.stringify(pushed[0].payload)).not.toContain("alpha"); // the room id only from "room" on
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
    expect(pushed[1].payload.body).toBe("New message (4)");
  });

  it("forgets an endpoint the push service reports as gone (the status, not the message text)", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/dead", keys: { p256dh: "p", auth: "a" } }, now);
    away(relay, acc.id, "alpha", "Alice");
    // What sendWebPush makes of web-push's WebPushError("Received unexpected response code", 410).
    pushResult = { ok: false, status: 410, gone: true, error: "410: Received unexpected response code" };

    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(store.get(acc.id)!.push).toHaveLength(0);
    // The message itself is still waiting for her.
    expect(queue.pending(acc.id, "alpha")).toHaveLength(1);
  });

  it("keeps an endpoint that failed for another reason", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/busy", keys: { p256dh: "p", auth: "a" } }, now);
    away(relay, acc.id, "alpha", "Alice");
    pushResult = { ok: false, status: 503, gone: false, error: "503: Received unexpected response code" };
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(store.get(acc.id)!.push).toHaveLength(1);
  });

  it("stores without a push when no device is linked", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    away(relay, acc.id, "alpha", "Alice");
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(pushed).toHaveLength(0);
    expect(statuses()).toEqual(["stored"]);
  });

  it("names the kind from the sender's hints: a mention for the mentioned only, a call for all", async () => {
    const relay = makeRelay();
    const alice = account("Alice");
    const carol = account("Carol");
    away(relay, alice.id, "alpha", "Alice");
    away(relay, carol.id, "alpha", "Carol");
    const bob = peer("bob", "alpha", "Bob");
    const refs = [accountRef("alpha", alice.id), accountRef("alpha", carol.id)];
    await relay.relay(bob, { messageId: "m1", to: refs, envelope: ENVELOPE, mention: [refs[1]] });
    expect(wakes.map((w) => [w.accountId, w.kind])).toEqual([[alice.id, "message"], [carol.id, "mention"]]);
    wakes = [];
    await relay.relay(bob, { messageId: "m2", to: refs, envelope: ENVELOPE, call: true });
    expect(wakes.map((w) => w.kind)).toEqual(["call", "call"]);
  });

  it("an operator's summons goes through the notifier as its own kind", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/alice", keys: { p256dh: "p", auth: "a" } }, now);
    expect(await relay.summon(acc.id, "alpha")).toBe(true);
    expect(pushed[0].payload).toMatchObject({ kind: "summon", body: "The operator asks you back" });
    const none = account("Nobody");
    expect(await relay.summon(none.id, "alpha")).toBe(false); // no endpoint: nothing sent
  });

  it("never wakes a member who is present in the room", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/alice", keys: { p256dh: "p", auth: "a" } }, now);
    away(relay, acc.id, "alpha", "Alice");
    // An awake tab of hers in the room (the away entry is stale).
    peer("alice-tab", "alpha", "Alice", { accountId: acc.id });
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: to("alpha", acc.id), envelope: ENVELOPE });
    expect(pushed).toHaveLength(0);
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
