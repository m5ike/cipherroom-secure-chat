// @vitest-environment node
//
// The wake-up half of the away relay (server/accounts/relay.ts): when a
// message is stored for an away user, their linked devices get a Web Push
// "flash message" pointing at /signin — throttled, and pruned when an
// endpoint is gone for good.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { AccountStore, type PushTarget } from "../server/accounts/store";
import { AwayRelay, type RelayPeer } from "../server/accounts/relay";
import type { StoredCredential } from "../server/accounts/webauthn";

const credential = (id: string): StoredCredential => ({ credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });
const ENVELOPE = { iv: "aXY=", ciphertext: "Y3Q=" };

let dir = "";
let store: AccountStore;
let rooms: Map<string, Map<string, RelayPeer>>;
let sent: Array<{ socket: WebSocket; payload: Record<string, unknown> }>;
let pushed: Array<{ target: PushTarget; payload: { url: string; body: string } }>;
let pushResult: { ok: boolean; error?: string };
let now = 1_700_000_000_000;

function peer(id: string, room: string | null, name: string, extra: Partial<RelayPeer> = {}): RelayPeer {
  const socket = { id } as unknown as WebSocket;
  const p: RelayPeer = { id, room, name, socket, ...extra };
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
    (socket, payload) => sent.push({ socket, payload: payload as Record<string, unknown> }),
    async (target, payload) => { pushed.push({ target, payload }); return pushResult; },
    () => now,
  );
}

function account(name: string) {
  const r = store.create(credential(`cred-${name}-0000000`), name, now);
  if (!r.ok) throw new Error(r.reason);
  return r.account;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-relay-push-"));
  store = new AccountStore(dir);
  rooms = new Map();
  sent = [];
  pushed = [];
  pushResult = { ok: true };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const statuses = () => sent.filter((s) => s.payload.type === "relay-status").map((s) => s.payload.state);

describe("waking an away user", () => {
  it("pushes a flash message that opens /signin", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/alice", keys: { p256dh: "p", auth: "a" } }, now);
    store.setAway(acc.id, "alpha", "Alice", now);
    const bob = peer("bob", "alpha", "Bob");

    await relay.relay(bob, { messageId: "m1", to: [acc.id], envelope: ENVELOPE });

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
    store.setAway(acc.id, "alpha", "Alice", now);
    const bob = peer("bob", "alpha", "Bob");

    for (const id of ["m1", "m2", "m3"]) await relay.relay(bob, { messageId: id, to: [acc.id], envelope: ENVELOPE });
    expect(pushed).toHaveLength(1);
    expect(store.mailbox(acc.id, "alpha")).toHaveLength(3); // all three still waiting

    now += 31_000; // past the throttle window
    await relay.relay(bob, { messageId: "m4", to: [acc.id], envelope: ENVELOPE });
    expect(pushed).toHaveLength(2);
  });

  it("forgets an endpoint the push service reports as gone", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.addPush(acc.id, { endpoint: "https://push.example/dead", keys: { p256dh: "p", auth: "a" } }, now);
    store.setAway(acc.id, "alpha", "Alice", now);
    pushResult = { ok: false, error: "Received unexpected response code 410" };

    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: [acc.id], envelope: ENVELOPE });
    expect(store.get(acc.id)!.push).toHaveLength(0);
    // The message itself is still waiting for her.
    expect(store.mailbox(acc.id, "alpha")).toHaveLength(1);
  });

  it("stores without a push when no device is linked", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.setAway(acc.id, "alpha", "Alice", now);
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: [acc.id], envelope: ENVELOPE });
    expect(pushed).toHaveLength(0);
    expect(statuses()).toEqual(["stored"]);
  });
});

describe("relay limits", () => {
  it("rejects a message that does not fit the mailbox", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.setAway(acc.id, "alpha", "Alice", now);
    const huge = { iv: "aXY=", ciphertext: "A".repeat(200_000) };
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: [acc.id], envelope: huge });
    expect(statuses()).toEqual(["rejected"]);
    expect(store.mailbox(acc.id)).toHaveLength(0);
  });

  it("stops a socket that floods the relay", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.setAway(acc.id, "alpha", "Alice", now);
    const bob = peer("bob", "alpha", "Bob");
    for (let i = 0; i < 130; i++) await relay.relay(bob, { messageId: `m${i}`, to: [acc.id], envelope: ENVELOPE });
    expect(sent.some((s) => s.payload.type === "error" && String(s.payload.message).includes("rate limit"))).toBe(true);
  });

  it("ignores a relay from a client that is not in a room", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.setAway(acc.id, "alpha", "Alice", now);
    await relay.relay(peer("nomad", null, "Nomad"), { messageId: "m1", to: [acc.id], envelope: ENVELOPE });
    expect(sent).toHaveLength(0);
    expect(store.mailbox(acc.id)).toHaveLength(0);
  });
});

describe("signing out", () => {
  it("stops the server answering for the account and tells the room", () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.setAway(acc.id, "alpha", "Alice", now);
    peer("bob", "alpha", "Bob");

    relay.forget(acc.id);

    expect(store.isAway(acc.id, "alpha")).toBe(false);
    expect(sent.map((s) => s.payload)).toEqual([{ type: "peer-gone", accountId: acc.id }]);
  });
});

describe("delivery to a returning user", () => {
  it("sends the mailbox in batches and only for the room they joined", async () => {
    const relay = makeRelay();
    const acc = account("Alice");
    store.setAway(acc.id, "alpha", "Alice", now);
    store.setAway(acc.id, "beta", "Alice", now);
    const bob = peer("bob", "alpha", "Bob");
    const carol = peer("carol", "beta", "Carol");
    for (let i = 0; i < 60; i++) await relay.relay(bob, { messageId: `a${i}`, to: [acc.id], envelope: ENVELOPE });
    await relay.relay(carol, { messageId: "b1", to: [acc.id], envelope: ENVELOPE });

    sent = [];
    const alice = peer("alice-1", "alpha", "Alice", { accountId: acc.id, awayEnabled: true });
    relay.onJoin(alice);

    const deliveries = sent.filter((s) => s.payload.type === "relay-deliver");
    expect(deliveries).toHaveLength(2); // 60 items → batches of 50
    const ids = deliveries.flatMap((d) => (d.payload.items as Array<{ messageId: string }>).map((i) => i.messageId));
    expect(ids).toHaveLength(60);
    expect(ids).not.toContain("b1"); // the other room waits
    expect(store.isAway(acc.id, "alpha")).toBe(false);
    expect(store.isAway(acc.id, "beta")).toBe(true);
  });
});

describe("clock", () => {
  it("uses the injected clock for timestamps", async () => {
    vi.useFakeTimers();
    const relay = makeRelay();
    const acc = account("Alice");
    store.setAway(acc.id, "alpha", "Alice", now);
    await relay.relay(peer("bob", "alpha", "Bob"), { messageId: "m1", to: [acc.id], envelope: ENVELOPE });
    expect(sent[0].payload.at).toBe(now);
    vi.useRealTimers();
  });
});
