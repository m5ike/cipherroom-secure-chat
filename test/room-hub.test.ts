// Several rooms at once (6.0): a background room speaks the same protocol as
// the room on screen — signed hello, pair and sender keys, validated payloads
// — counts unread messages and people, and hands its messages over.

import { describe, it, expect, beforeAll } from "vitest";
import { deriveRoomKeys, sealMessage, type RoomKeys } from "../client/src/lib/envelope";
import { SenderKeyStore } from "../client/src/lib/sender-keys";
import { keyId, keyFingerprint, type Identity } from "../client/src/lib/identity";
import { fromBase64, toBase64 } from "../client/src/lib/crypto";
import { BackgroundRoom, RoomHub, roomKeyOf, type HubDeps } from "../client/src/lib/room-hub";

const subtle = globalThis.crypto.subtle;
const b64 = (b: ArrayBuffer) => toBase64(new Uint8Array(b));

async function identity(): Promise<Identity> {
  const sign = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
  const publicKey = b64(await subtle.exportKey("spki", sign.publicKey));
  return {
    publicKey, dhPublicKey: b64(await subtle.exportKey("spki", dh.publicKey)), persistent: false,
    kid: await keyId(publicKey), fingerprint: await keyFingerprint(publicKey),
    sign: async (data) => b64(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sign.privateKey, data)),
    sharedSecret: async (peer) => new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("spki", fromBase64(peer), { name: "ECDH", namedCurve: "P-256" }, false, []) }, dh.privateKey, 256)),
  };
}

let keys: RoomKeys;
let me: Identity;
let alice: Identity;

beforeAll(async () => {
  keys = await deriveRoomKeys("team", "correct horse", { memoryKiB: 64, passes: 1 });
  me = await identity();
  alice = await identity();
});

const deps = (): HubDeps => ({
  wsUrl: () => "ws://test/ws",
  rtcConfig: async () => ({}),
  makeSocket: () => ({ send() {}, close() {}, readyState: 0 } as unknown as WebSocket),
  makePeer: () => { throw new Error("no WebRTC in this test"); },
  derive: async () => keys,
  identity: async () => me,
});

/** A background room and Alice (a web client) with a channel between them. */
async function channel() {
  const events: string[] = [];
  const room = new BackgroundRoom({ key: roomKeyOf("team"), room: "team", label: "Team", name: "Me", passphrase: "x" }, deps(), (e) => events.push(e.type));
  room.useKeys(keys, me, "p-me");
  const sent: Array<Record<string, unknown>> = [];
  await room.handleChannelOpen("p-alice", (t) => sent.push(JSON.parse(t)));
  const aliceStore = new SenderKeyStore();
  // Alice checks our hello, sends hers and her sender key.
  expect(sent[0]).toMatchObject({ kind: "hello", v: 3, check: keys.check, caps: [] });
  expect(await aliceStore.acceptHello(keys, alice, sent[0] as never, "p-me", "p-alice")).toBeNull();
  await room.handleChannelText("p-alice", JSON.stringify(await aliceStore.hello(keys, alice, "p-alice", "p-me")));
  expect(sent[1]).toMatchObject({ kind: "sender-key" });
  expect(await aliceStore.acceptSenderKey(keys, sent[1] as never, "p-me", "p-alice")).toBe(true);
  await room.handleChannelText("p-alice", JSON.stringify(await aliceStore.senderKeyFor(keys, "p-alice", "p-me")));
  return { room, aliceStore, sent, events };
}

const payload = (id: string, text: string, senderId = "p-alice") => ({ id, text, createdAt: Date.now(), senderId, senderName: "Alice" });

describe("a background room", () => {
  it("opens live messages, counts them, drops replays", async () => {
    const { room, aliceStore, events } = await channel();
    const env = await aliceStore.sealLive(keys, "msg-1", payload("msg-1", "ahoj"), alice);
    await room.handleChannelText("p-alice", JSON.stringify(env));
    await room.handleChannelText("p-alice", JSON.stringify(env)); // the same again
    expect(room.messages.map((m) => m.text)).toEqual(["ahoj"]);
    expect(room.messages[0]).toMatchObject({ sealedWith: "sender-key", identity: { state: "verified" }, mine: false });
    expect(room.unread).toBe(1);
    expect(room.view()).toMatchObject({ users: 2, unread: 1, last: { sender: "Alice", text: "ahoj" } });
    expect(events).toContain("message");
  });

  it("opens private messages and room-key messages", async () => {
    const { room, aliceStore } = await channel();
    await room.handleChannelText("p-alice", JSON.stringify(await aliceStore.sealPrivate(keys, "msg-p", payload("msg-p", "jen pro tebe"), "p-alice", "p-me", alice)));
    await room.handleChannelText("p-alice", JSON.stringify(await sealMessage(keys, "msg-r", payload("msg-r", "starý klient"))));
    expect(room.messages.map((m) => [m.text, m.sealedWith])).toEqual([["jen pro tebe", "pair"], ["starý klient", "room"]]);
  });

  it("refuses a payload that names another sender than the channel's peer", async () => {
    const { room } = await channel();
    await room.handleChannelText("p-alice", JSON.stringify(await sealMessage(keys, "msg-x", payload("msg-x", "I am Bob", "p-bob"))));
    expect(room.messages).toHaveLength(0);
  });

  it("says a file came (it is received in the foreground)", async () => {
    const { room } = await channel();
    await room.handleChannelText("p-alice", JSON.stringify({ kind: "file-meta", transferId: "xfer-1" }));
    expect(room.messages[0].senderId).toBe("system");
  });

  it("a wrong passphrase shows as a key mismatch", async () => {
    const room = new BackgroundRoom({ key: "k", room: "team", label: "Team", name: "Me", passphrase: "x" }, deps(), () => undefined);
    room.useKeys(keys, me, "p-me");
    await room.handleChannelOpen("p-eve", () => undefined);
    const other = await deriveRoomKeys("team", "wrong", { memoryKiB: 64, passes: 1 });
    await room.handleChannelText("p-eve", JSON.stringify(await new SenderKeyStore().hello(other, alice, "p-eve", "p-me")));
    expect(room.status).toBe("mismatch");
  });
});

describe("the hub", () => {
  it("keeps rooms, publishes views, hands messages over and respects the limit", async () => {
    const hub = new RoomHub(deps(), 2);
    let changes = 0;
    hub.subscribe(() => { changes++; });
    const heard: string[] = [];
    hub.onMessage((e) => heard.push(e.label));
    expect(hub.add({ key: "a", room: "team", label: "Team", name: "Me", passphrase: "x" })).toBe(true);
    expect(hub.add({ key: "b", room: "family", label: "Family", name: "Me", passphrase: "y" })).toBe(true);
    expect(hub.add({ key: "c", room: "work", label: "Work", name: "Me", passphrase: "z" })).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.list().map((v) => v.key).sort()).toEqual(["a", "b"]);
    expect(changes).toBeGreaterThan(0);
    const room = hub.room("a")!;
    room.useKeys(keys, me, "p-me");
    await room.handleChannelOpen("p-alice", () => undefined);
    const store = new SenderKeyStore();
    await room.handleChannelText("p-alice", JSON.stringify(await sealMessage(keys, "m1", payload("m1", "hello"))));
    expect(heard).toEqual(["Team"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.list().find((v) => v.key === "a")!.unread).toBe(1);
    hub.markRead("a");
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.list().find((v) => v.key === "a")!.unread).toBe(0);
    const taken = hub.take("a")!;
    expect(taken.target.room).toBe("team");
    expect(taken.messages.map((m) => m.text)).toEqual(["hello"]);
    expect(hub.has("a")).toBe(false);
    void store;
  });
});
