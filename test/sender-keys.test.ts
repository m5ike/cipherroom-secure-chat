// @vitest-environment node
//
// Sender keys, pair keys and forward secrecy (client/src/lib/sender-keys.ts).

import { describe, it, expect, beforeAll } from "vitest";
import { deriveRoomKeys, openMessage, sealMessage, type RoomKeys } from "../client/src/lib/envelope";
import { loadIdentity, _resetIdentityForTests, type Identity } from "../client/src/lib/identity";
import { envelopeKind, MAX_SKIP, SenderKeyStore } from "../client/src/lib/sender-keys";

let keys: RoomKeys;
let alice: Identity;
let bob: Identity;
let carol: Identity;

beforeAll(async () => {
  keys = await deriveRoomKeys("alpha", "pw", { iterations: 1_000 });
  _resetIdentityForTests(); alice = await loadIdentity();
  _resetIdentityForTests(); bob = await loadIdentity();
  _resetIdentityForTests(); carol = await loadIdentity();
});

/** Two stores that said hello to each other and exchanged sender keys. */
async function connect(a: SenderKeyStore, aId: Identity, aPeer: string, b: SenderKeyStore, bId: Identity, bPeer: string) {
  const helloA = await a.hello(keys, aId, aPeer, bPeer);
  const helloB = await b.hello(keys, bId, bPeer, aPeer);
  expect(await b.acceptHello(keys, bId, helloA, aPeer, bPeer)).toBeNull();
  expect(await a.acceptHello(keys, aId, helloB, bPeer, aPeer)).toBeNull();
  expect(await b.acceptSenderKey(keys, (await a.senderKeyFor(keys, aPeer, bPeer))!, aPeer, bPeer)).toBe(true);
  expect(await a.acceptSenderKey(keys, (await b.senderKeyFor(keys, bPeer, aPeer))!, bPeer, aPeer)).toBe(true);
}

describe("hello", () => {
  it("refuses a different passphrase and a forged signature", async () => {
    const a = new SenderKeyStore();
    const b = new SenderKeyStore();
    const hello = await a.hello(keys, alice, "p-a", "p-b");
    const other = await deriveRoomKeys("alpha", "not-pw", { iterations: 1_000 });
    expect(await b.acceptHello(other, bob, hello, "p-a", "p-b")).toBe("key-mismatch");
    expect(await b.acceptHello(keys, bob, { ...hello, dh: bob.dhPublicKey }, "p-a", "p-b")).toBe("bad-signature");
    // A hello replayed to someone else (another "to") does not verify either.
    expect(await b.acceptHello(keys, bob, hello, "p-a", "p-c")).toBe("bad-signature");
  });
});

describe("sender keys", () => {
  it("carry live messages, signed, and survive messages the reader never got", async () => {
    const a = new SenderKeyStore();
    const b = new SenderKeyStore();
    await connect(a, alice, "p-a", b, bob, "p-b");
    const first = await a.sealLive(keys, "m1", { id: "m1", text: "one" }, alice);
    expect(envelopeKind(first)).toBe("sender-key");
    expect(await b.openLive(keys, first, "p-a")).toMatchObject({ payload: { text: "one" }, signer: { publicKey: alice.publicKey, valid: true } });
    await a.sealLive(keys, "m2", { id: "m2" }); // sent to someone else
    await a.sealLive(keys, "m3", { id: "m3" });
    const fourth = await a.sealLive(keys, "m4", { id: "m4", text: "four" });
    expect((await b.openLive<{ text: string }>(keys, fourth, "p-a")).payload.text).toBe("four");
  });

  it("cannot open the same message key twice (the chain moved on)", async () => {
    const a = new SenderKeyStore();
    const b = new SenderKeyStore();
    await connect(a, alice, "p-a", b, bob, "p-b");
    const env = await a.sealLive(keys, "m1", { id: "m1" });
    await b.openLive(keys, env, "p-a");
    await expect(b.openLive(keys, env, "p-a")).rejects.toThrow(/already used/);
  });

  it("does not hand a new chain to someone who left", async () => {
    const a = new SenderKeyStore();
    const b = new SenderKeyStore();
    const c = new SenderKeyStore();
    await connect(a, alice, "p-a", b, bob, "p-b");
    await connect(a, alice, "p-a", c, carol, "p-c");
    const before = await a.sealLive(keys, "m1", { id: "m1" });
    await c.openLive(keys, before, "p-a");
    // Carol leaves: Alice starts a new chain; Bob gets it, Carol does not.
    a.forgetPeer("p-c");
    expect(a.hasOurKey("p-b")).toBe(false); // the new chain has to go out first
    await b.acceptSenderKey(keys, (await a.senderKeyFor(keys, "p-a", "p-b"))!, "p-a", "p-b");
    const after = await a.sealLive(keys, "m2", { id: "m2", text: "after" });
    await expect(c.openLive(keys, after, "p-a")).rejects.toThrow();
    expect((await b.openLive<{ text: string }>(keys, after, "p-a")).payload.text).toBe("after");
  });

  it("refuses a chain claimed by another peer, and messages too far ahead", async () => {
    const a = new SenderKeyStore();
    const b = new SenderKeyStore();
    await connect(a, alice, "p-a", b, bob, "p-b");
    const env = await a.sealLive(keys, "m1", { id: "m1" });
    await expect(b.openLive(keys, env, "p-evil")).rejects.toThrow(/no sender key/);
    await expect(b.openLive(keys, { ...env, n: MAX_SKIP + 5 }, "p-a")).rejects.toThrow(/too far/);
  });
});

describe("private messages", () => {
  it("open only for the peer they were sealed for", async () => {
    const a = new SenderKeyStore();
    const b = new SenderKeyStore();
    const c = new SenderKeyStore();
    await connect(a, alice, "p-a", b, bob, "p-b");
    await connect(a, alice, "p-a", c, carol, "p-c");
    const toBob = (await a.sealPrivate(keys, "pm1", { id: "pm1", text: "just you" }, "p-a", "p-b", alice))!;
    expect(envelopeKind(toBob)).toBe("pair");
    expect((await b.openPrivate<{ text: string }>(keys, toBob, "p-a", "p-b")).payload.text).toBe("just you");
    // Carol has the passphrase and her own pair with Alice — still nothing.
    await expect(c.openPrivate(keys, toBob, "p-a", "p-c")).rejects.toThrow();
    await expect(openMessage(keys, toBob)).rejects.toThrow();
  });

  it("leaves room-key envelopes as they were", async () => {
    const env = await sealMessage(keys, "r1", { id: "r1" });
    expect(envelopeKind(env)).toBe("room");
  });
});
