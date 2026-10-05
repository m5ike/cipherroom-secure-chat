// 6.12: protocol 4 integrated in the web client (client/src/lib/p4-session.ts
// and its neighbours) — two in-process "clients" talking over a simulated,
// ordered data channel, the way App.tsx and room-hub.ts drive them:
//
//   v4 ↔ v4   hello v4 + KEM → pair ratchet; room messages with SenderKeys4,
//             private messages, media and file keys in the ratchet; a reset
//   v4 ↔ v3   a 6.11 peer: protocol 3 through SenderKeyStore, both ways
//   downgrade a device once seen with protocol 4 that says only protocol 3 is refused
//   files     protocol-4 transfers under a random FK, never the room key
//   mailbox   messages for away members sealed per device (relay `per`)
//   hub proof, replay window (persistent), identity states, KT alerts, outbox payloads

import { beforeAll, describe, expect, it } from "vitest";
import { deriveRoomKeys, type RoomKeys } from "../client/src/lib/envelope";
import { SenderKeyStore } from "../client/src/lib/sender-keys";
import { createPinStore, keyFingerprint, keyId, type Identity } from "../client/src/lib/identity";
import { fromBase64, toBase64 } from "../client/src/lib/crypto";
import {
  b64, consistencyProof, ed25519FromSeed, entryLeafHash, inclusionProof, isMailboxItem, isMailboxSet, ktUser, Mailbox, newFileKey, signSth,
  treeHash, verifyHubProof, buildHubProof, hubSeed, ReplayGuard, REPLAY,
  type Hash, type KtEntry, type KtLookup, type MailboxItem, type MailboxSet, type RatchetInner, type SignedTreeHead,
} from "../client/src/lib/p4";
import { isP4RoomEnvelope, P4Room, type PeerInfo } from "../client/src/lib/p4-session";
import { LocalVault, LocalKtStore, memoryBackend, PayloadSealer, VaultBundleStore, VaultReplayStore } from "../client/src/lib/p4-store";
import { acceptChanged, evaluateIdentity, markVerified, signerOf, TrustBook } from "../client/src/lib/p4-trust";
import { checkDirectoryDevice, helloAccountOf, sealForAway, uploadBundle } from "../client/src/lib/p4-away";
import { parseBundleRequest, verifyBundleSignature, verifyDeviceCert as serverVerifyDeviceCert } from "../server/keys/verify";
import { KtClient } from "../client/src/lib/p4-kt";
import { handleIncomingFrame, newIncomingRegistry, sendFile, type FileTransferEnvelope } from "../client/src/lib/file-transfer";
import { verifyHubProof as serverVerifyHubProof } from "../server/signaling/proof";
import { BackgroundRoom, roomKeyOf, type HubDeps } from "../client/src/lib/room-hub";

const subtle = globalThis.crypto.subtle;
const b64buf = (b: ArrayBuffer) => toBase64(new Uint8Array(b));

async function identity(): Promise<Identity> {
  const sign = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
  const publicKey = b64buf(await subtle.exportKey("spki", sign.publicKey));
  return {
    publicKey, dhPublicKey: b64buf(await subtle.exportKey("spki", dh.publicKey)), persistent: false,
    kid: await keyId(publicKey), fingerprint: await keyFingerprint(publicKey),
    sign: async (data) => b64buf(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sign.privateKey, data)),
    sharedSecret: async (peer) => new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("spki", fromBase64(peer), { name: "ECDH", namedCurve: "P-256" }, false, []) }, dh.privateKey, 256)),
  };
}

let keys: RoomKeys;
beforeAll(async () => {
  keys = await deriveRoomKeys("team", "correct horse", { memoryKiB: 64, passes: 1 });
});

/* ------------------------------------------------- two clients, one channel */

type Frame = { from: string; to: string; text: string };

/** An ordered "data channel" between clients: every frame goes through the receiver's handler in order. */
class Net {
  readonly queue: Frame[] = [];
  readonly clients = new Map<string, Client>();
  /** What crossed the wire (to inspect, or to replay). */
  readonly log: Frame[] = [];
  cut = new Set<string>();
  tamper: ((f: Frame) => Frame | null) | null = null;

  send(from: string, to: string, text: string): boolean {
    if (this.cut.has(`${from}>${to}`)) return false;
    const frame = { from, to, text };
    this.log.push(frame);
    this.queue.push(frame);
    return true;
  }

  async drain(): Promise<void> {
    for (let i = 0; i < 10_000 && this.queue.length; i++) {
      let f: Frame | null = this.queue.shift()!;
      if (this.tamper) f = this.tamper(f);
      if (!f) continue;
      await this.clients.get(f.to)!.receive(f.from, JSON.parse(f.text) as Record<string, unknown>);
    }
  }
}

type Client = {
  id: string;
  identity: Identity;
  room: P4Room;
  book: TrustBook;
  ready: PeerInfo[];
  inners: Array<{ from: string; inner: RatchetInner }>;
  roomMessages: Array<{ from: string; payload: { id: string; text?: string } }>;
  events: string[];
  receive(from: string, raw: Record<string, unknown>): Promise<void>;
};

async function client(net: Net, id: string, opts: { disableP4?: boolean; book?: TrustBook; identity?: Identity; mb?: () => Promise<{ mb: unknown }> } = {}): Promise<Client> {
  const me = opts.identity ?? await identity();
  const c: Partial<Client> = { id, identity: me, book: opts.book ?? new TrustBook(null), ready: [], inners: [], roomMessages: [], events: [] };
  const room = new P4Room({
    keys, identity: me, selfId: () => id,
    send: (peerId, text) => net.send(id, peerId, text),
    helloExtra: () => ({ caps: ["bin", "media"], user: `${id}-user` }),
    local: async () => ({ mb: (await opts.mb?.())?.mb as never ?? null, acc: null, sth: null }),
    book: c.book!,
    disableP4: opts.disableP4,
    events: {
      ready: (peerId, info) => { c.ready!.push(info); c.events!.push(`ready:${peerId}:${info.protocol}`); },
      downgrade: (peerId) => c.events!.push(`downgrade:${peerId}`),
      refused: (peerId, why) => c.events!.push(`refused:${peerId}:${why}`),
      inner: (peerId, inner) => { c.inners!.push({ from: peerId, inner }); },
      reset: (peerId, why, sent) => c.events!.push(`reset:${peerId}:${sent ? "sent" : "got"}`),
      close: (peerId) => c.events!.push(`close:${peerId}`),
      chainRefused: (peerId) => c.events!.push(`chain-refused:${peerId}`),
    },
  });
  c.room = room;
  c.receive = async (from, raw) => {
    if (await room.handle(from, raw)) return;
    if (isP4RoomEnvelope(raw)) {
      const opened = await room.openRoom<{ id: string; text?: string }>(from, raw);
      c.roomMessages!.push({ from, payload: opened.payload });
      return;
    }
    // A protocol-3 envelope (the app opens it with SenderKeyStore).
    if (raw.v === 3 && typeof raw.sk === "string" && typeof raw.n === "number") {
      const opened = await room.v3.openLive<{ id: string; text?: string }>(keys, raw as never, from);
      c.roomMessages!.push({ from, payload: opened.payload });
    }
  };
  net.clients.set(id, c as Client);
  return c as Client;
}

/** Both channel ends open (each sends its hello), then everything is delivered. */
async function connect(net: Net, a: Client, b: Client): Promise<void> {
  await Promise.all([a.room.open(b.id), b.room.open(a.id)]);
  await net.drain();
}

const msg = (id: string, text: string, senderId: string) => ({ id, text, createdAt: Date.now(), senderId, senderName: senderId });

describe("6.12 web client — two protocol-4 peers", () => {
  it("say hello v4, run the KEM and speak protocol 4 (the hello still carries the protocol-3 part)", async () => {
    const net = new Net();
    const a = await client(net, "p-a");
    const b = await client(net, "p-b");
    await connect(net, a, b);
    const hello = net.log.find((f) => f.from === "p-a" && JSON.parse(f.text).kind === "hello")!;
    expect(JSON.parse(hello.text)).toMatchObject({ kind: "hello", v: 4, check: keys.check, pk: a.identity.publicKey, dh: a.identity.dhPublicKey, caps: ["bin", "media", "p4"], user: "p-a-user" });
    expect(a.room.protocolOf("p-b")).toBe(4);
    expect(b.room.protocolOf("p-a")).toBe(4);
    expect(a.events).toContain("ready:p-b:4");
    // The downgrade markers: both device keys were seen with protocol 4.
    expect(a.book.p4Seen(b.identity.publicKey)).toBe(true);
    expect(b.book.p4Seen(a.identity.publicKey)).toBe(true);
    // The signer of their messages is their hello key — valid, no device signature on the message itself (F-30).
    expect(a.room.signer("p-b")).toEqual({ publicKey: b.identity.publicKey, valid: true });
  });

  it("room messages: each peer gets the chain over its ratchet first, then one sender-key message for all", async () => {
    const net = new Net();
    const a = await client(net, "p-a");
    const b = await client(net, "p-b");
    const c = await client(net, "p-c");
    await connect(net, a, b);
    await connect(net, a, c);
    const sealed = await a.room.sealRoom("m1", msg("m1", "ahoj všem", "p-a"), ["p-b", "p-c"]);
    expect(sealed?.to.sort()).toEqual(["p-b", "p-c"]);
    expect(sealed!.envelope).toMatchObject({ v: 4, id: "m1", n: 0 });
    for (const to of sealed!.to) net.send("p-a", to, JSON.stringify(sealed!.envelope));
    await net.drain();
    expect(b.roomMessages.map((m) => m.payload.text)).toEqual(["ahoj všem"]);
    expect(c.roomMessages.map((m) => m.payload.text)).toEqual(["ahoj všem"]);
    // The room key never sealed it: nothing on the wire opens with it.
    expect(net.log.every((f) => !JSON.parse(f.text).iv)).toBe(true);
    // A member that left takes no key with it: our next chain is new.
    const before = a.room.sk.currentKeyId;
    a.room.peerLeft("p-c");
    const next = await a.room.sealRoom("m2", msg("m2", "jen B", "p-a"), ["p-b"]);
    expect(a.room.sk.currentKeyId).not.toBe(before);
    net.send("p-a", "p-b", JSON.stringify(next!.envelope));
    await net.drain();
    expect(b.roomMessages.map((m) => m.payload.text)).toEqual(["ahoj všem", "jen B"]);
  });

  it("private messages, media keys and file keys travel as ratchet inner messages", async () => {
    const net = new Net();
    const a = await client(net, "p-a");
    const b = await client(net, "p-b");
    await connect(net, a, b);
    const frame = await a.room.sealPrivate("p-b", "pm1", msg("pm1", "jen pro tebe", "p-a"));
    expect(frame).toMatchObject({ kind: "p4", v: 4 });
    net.send("p-a", "p-b", JSON.stringify(frame));
    const media = await a.room.sendMediaKey("p-b", "call-1");
    const media2 = await a.room.sendMediaKey("p-b", "call-1"); // a renegotiation: a fresh key, the next epoch
    expect([media?.epoch, media2?.epoch]).toEqual([0, 1]);
    const { inner: fileInner } = newFileKey("xfer-1");
    expect(await a.room.sendInner("p-b", fileInner)).toBe(true);
    await net.drain();
    expect(b.inners.map((x) => x.inner.t)).toEqual(["msg", "media", "media", "file"]);
    expect(b.inners[0].inner).toMatchObject({ t: "msg", id: "pm1", p: { text: "jen pro tebe" } });
    expect(b.inners[1].inner).toMatchObject({ t: "media", call: "call-1", epoch: 0, key: b64(media!.raw) });
    expect(b.inners[3].inner).toEqual(fileInner);
  });

  it("a broken frame is dropped; a second failure resets the session — both sides start over and speak protocol 4 again", async () => {
    const net = new Net();
    const a = await client(net, "p-a");
    const b = await client(net, "p-b");
    await connect(net, a, b);
    const flip = (f: Frame) => {
      const raw = JSON.parse(f.text) as { kind?: string; c?: string };
      if (raw.kind !== "p4" || !raw.c) return f;
      const bytes = fromBase64(raw.c);
      bytes[0] ^= 1;
      return { ...f, text: JSON.stringify({ ...raw, c: toBase64(bytes) }) };
    };
    net.tamper = flip;
    for (const id of ["x1", "x2"]) net.send("p-a", "p-b", JSON.stringify(await a.room.sealPrivate("p-b", id, msg(id, "?", "p-a"))));
    await net.drain();
    net.tamper = null;
    await net.drain();
    expect(b.events).toContain("reset:p-a:sent");
    expect(a.events).toContain("reset:p-b:got");
    expect(b.inners).toHaveLength(0);
    expect(a.room.protocolOf("p-b")).toBe(4);
    expect(b.room.protocolOf("p-a")).toBe(4);
    net.send("p-a", "p-b", JSON.stringify(await a.room.sealPrivate("p-b", "ok", msg("ok", "znovu", "p-a"))));
    await net.drain();
    expect(b.inners.map((x) => (x.inner as { id?: string }).id)).toEqual(["ok"]);
    // A second reset within 10 s closes the channel instead.
    await b.room.reset("p-a", "test", true);
    expect(b.events).toContain("close:p-a");
    expect(b.room.protocolOf("p-a")).toBe("refused");
  });

  it("a chain re-announced by another member is refused (its cert names the real owner)", async () => {
    const net = new Net();
    const a = await client(net, "p-a");
    const b = await client(net, "p-b");
    const m = await client(net, "p-m");
    await connect(net, a, b);
    await connect(net, a, m);
    await connect(net, m, b);
    await a.room.sealRoom("m0", msg("m0", "x", "p-a"), ["p-b", "p-m"]);
    await net.drain();
    // Mallory holds A's chain (every member does) and hands it to B as her own, over her own session.
    const chainForB = a.room.sk.chainFor("p-b");
    await m.room.sendInner("p-b", chainForB);
    await net.drain();
    expect(b.events).toContain("chain-refused:p-m");
  });
});

describe("6.12 web client — protocol 3 fallback and the downgrade rule", () => {
  it("a 6.11 peer (protocol 3 only) and a 6.12 one speak protocol 3 both ways", async () => {
    const net = new Net();
    const a = await client(net, "p-a");
    const old = await client(net, "p-old", { disableP4: true });
    await connect(net, a, old);
    expect(a.room.protocolOf("p-old")).toBe(3);
    expect(old.room.protocolOf("p-a")).toBe(3);
    expect(a.events).toContain("ready:p-old:3");
    // Protocol 3 sender keys went both ways (the app seals with them).
    expect(a.room.v3.hasPair("p-old")).toBe(true);
    const env = await old.room.v3.sealLive(keys, "o1", msg("o1", "starý klient", "p-old"), old.identity);
    net.send("p-old", "p-a", JSON.stringify(env));
    await net.drain();
    expect(a.roomMessages.map((m) => m.payload.text)).toEqual(["starý klient"]);
    // Nothing goes to them as protocol 4.
    expect(await a.room.sealRoom("m", msg("m", "x", "p-a"), ["p-old"])).toBeNull();
    expect(a.book.p4Seen(old.identity.publicKey)).toBe(false);
    // Protocol-4 frames from a protocol-3 peer change nothing (no reset, no new hello).
    const before = net.log.length;
    await a.room.handle("p-old", { kind: "p4-reset", v: 4, why: "x" });
    await a.room.handle("p-old", { kind: "p4-kem", v: 4, ct: "AAAA", r: "AAAA" });
    expect(net.log.length).toBe(before);
    expect(a.room.protocolOf("p-old")).toBe(3);
    const env2 = await old.room.v3.sealLive(keys, "o2", msg("o2", "pořád funguje", "p-old"), old.identity);
    net.send("p-old", "p-a", JSON.stringify(env2));
    await net.drain();
    expect(a.roomMessages.map((m) => m.payload.text)).toEqual(["starý klient", "pořád funguje"]);
  });

  it("refuses a device key once seen with protocol 4 that now says only protocol 3 (downgrade)", async () => {
    const net = new Net();
    const book = new TrustBook(null);
    const a = await client(net, "p-a", { book });
    const b = await client(net, "p-b");
    await connect(net, a, b);
    expect(book.p4Seen(b.identity.publicKey)).toBe(true);
    // The same device comes back on a new channel with a protocol-3-only hello.
    const net2 = new Net();
    const a2 = await client(net2, "p-a", { book, identity: a.identity });
    const b2 = await client(net2, "p-b", { identity: b.identity, disableP4: true });
    await connect(net2, a2, b2);
    expect(a2.events).toContain("downgrade:p-b");
    expect(a2.room.protocolOf("p-b")).toBe("refused");
    expect(a2.room.v3.hasPair("p-b")).toBe(false); // nothing will be sealed to it
  });

  it("refuses another room key", async () => {
    const net = new Net();
    const a = await client(net, "p-a");
    const other = await deriveRoomKeys("team", "wrong", { memoryKiB: 64, passes: 1 });
    const eve = await identity();
    const hello = await new SenderKeyStore().hello(other, eve, "p-eve", "p-a");
    await a.room.handle("p-eve", { ...hello, caps: [] } as unknown as Record<string, unknown>);
    expect(a.events).toContain("refused:p-eve:key-mismatch");
  });
});

describe("6.12 web client — files (§ 8)", () => {
  it("a protocol-4 transfer opens only with the FK its sender's session handed over", async () => {
    const frames: FileTransferEnvelope[] = [];
    const ch = { readyState: "open", bufferedAmount: 0, send: (s: string) => frames.push(JSON.parse(s)), addEventListener() {}, removeEventListener() {} } as unknown as RTCDataChannel;
    const transferId = "xfer-p4-test";
    const { inner, fk } = newFileKey(transferId);
    const body = new Uint8Array(5000).map((_, i) => i % 251);
    const result = await sendFile({ key: keys, file: new File([body], "a.bin"), senderId: "p-a", senderName: "A", chunkSize: 1024, channels: [ch], p4: { transferId, fk } });
    expect(result).toMatchObject({ ok: true, transferId });
    expect(frames.every((f) => (f as { v?: number }).v === 4 || f.kind === "file-cancel")).toBe(true);
    // Without the FK (the room key only): refused.
    const errors: string[] = [];
    await handleIncomingFrame(keys, newIncomingRegistry(), frames[0], 1e9, { onError: (_id, m) => errors.push(m) }, "p-a");
    expect(errors[0]).toMatch(/No key for this file/);
    // With it: the file, checked against the sender's digest.
    let done: { size: number; version: number; verified: boolean; signer: unknown } | null = null;
    const registry = newIncomingRegistry();
    const lookup = (id: string, from?: string) => (id === transferId && from === "p-a" ? { fk: inner.key, signer: { publicKey: "pk-a", valid: true } } : null);
    for (const f of frames) {
      await handleIncomingFrame(keys, registry, f, 1e9, { onComplete: (_i, blob, _m, _t, proof) => { done = { size: blob.size, version: proof.version, verified: proof.verified, signer: proof.signer }; } }, "p-a", lookup);
    }
    expect(done).toEqual({ size: 5000, version: 4, verified: true, signer: { publicKey: "pk-a", valid: true } });
    // Another peer cannot use A's key for the transfer.
    const errs2: string[] = [];
    await handleIncomingFrame(keys, newIncomingRegistry(), frames[0], 1e9, { onError: (_id, m) => errs2.push(m) }, "p-mallory", lookup);
    expect(errs2[0]).toMatch(/No key/);
  });
});

describe("6.12 web client — away members (mailbox, § 7)", () => {
  it("seals per device of each away member (known from hellos), the room envelope only for members without a bundle", async () => {
    const aliceId = await identity();
    const bobId = await identity();
    const aliceMb = new Mailbox(new VaultBundleStore(new LocalVault(memoryBackend())), aliceId);
    const bobBackend = memoryBackend();
    const bobMb = new Mailbox(new VaultBundleStore(new LocalVault(bobBackend)), bobId);
    await bobMb.maintain();
    const bobBundle = (await bobMb.current()).bundle;
    // Alice saw Bob's hello (protocol 4) under his room reference.
    const book = new TrustBook(null);
    book.rememberDevice(bobId.publicKey, { mb: bobBundle });
    book.rememberRef(keys.roomId, "ref-bob", bobId.publicKey);
    const payload = msg("away-1", "zpráva pro nepřítomného Boba", "p-alice");
    const sealed = await sealForAway({
      roomId: keys.roomId, id: "away-1", payload, refs: ["ref-bob", "ref-carol"], mailbox: aliceMb, senderPk: aliceId.publicKey,
      known: (ref) => book.devicesOfRef(keys.roomId, ref),
    });
    expect(sealed.withoutBundle).toEqual(["ref-carol"]);
    expect(isMailboxItem(sealed.per["ref-bob"])).toBe(true);
    expect(JSON.stringify(sealed.per)).not.toContain("nepřítomného");
    // Bob comes back — in a new page: his bundle keys come out of the (encrypted) store.
    const bobAgain = new Mailbox(new VaultBundleStore(new LocalVault(bobBackend)), bobId);
    const opened = await bobAgain.open<typeof payload>(sealed.per["ref-bob"] as MailboxItem, keys.roomId);
    expect(opened?.payload.text).toBe("zpráva pro nepřítomného Boba");
    expect(opened?.spk).toBe(aliceId.publicKey);
    expect(signerOf(opened!.spk, null)).toEqual({ publicKey: aliceId.publicKey, valid: true });
    // Another room's id does not open it.
    await expect(bobAgain.open(sealed.per["ref-bob"] as MailboxItem, "r3.another-room-entirely")).rejects.toThrow();
  });

  it("an account with several devices gets an mb-set; directory devices are checked (cert v2, bundle signature, pinned account)", async () => {
    const aliceId = await identity();
    const aliceMb = new Mailbox(new VaultBundleStore(new LocalVault(memoryBackend())), aliceId);
    const account = await ed25519FromSeed(new Uint8Array(32).fill(7));
    const apk = b64(account.publicKey);
    const { certifyDeviceV2, DEVICE_CERT_LIFETIME_MS } = await import("../client/src/lib/p4");
    const devices = [];
    for (let i = 0; i < 2; i++) {
      const dev = await identity();
      const mb = new Mailbox(new VaultBundleStore(new LocalVault(memoryBackend())), dev);
      const cert = await certifyDeviceV2(account.privateKey, dev.publicKey, Date.now() + DEVICE_CERT_LIFETIME_MS);
      devices.push({ pk: dev.publicKey, apk, cert, bundle: (await mb.current()).bundle, mb });
    }
    expect(await checkDirectoryDevice(devices[0])).toMatchObject({ pk: devices[0].pk, apk });
    expect(await checkDirectoryDevice({ ...devices[0], cert: { ...devices[0].cert, exp: devices[0].cert.exp + 1 } })).toBeNull();
    expect(await checkDirectoryDevice({ ...devices[0], pk: devices[1].pk })).toBeNull();
    const sealed = await sealForAway({
      roomId: keys.roomId, id: "away-2", payload: msg("away-2", "pro všechna tvá zařízení", "p-alice"), refs: ["ref-dana"], mailbox: aliceMb, senderPk: aliceId.publicKey,
      known: () => [], directory: async () => devices.map(({ mb: _mb, ...d }) => d),
    });
    expect(isMailboxSet(sealed.per["ref-dana"])).toBe(true);
    for (const d of devices) expect((await d.mb.open<{ text: string }>(sealed.per["ref-dana"] as MailboxSet, keys.roomId))?.payload.text).toBe("pro všechna tvá zařízení");
    // A directory that answers with another account's devices than the one pinned for that member is not used.
    const pinned = await sealForAway({
      roomId: keys.roomId, id: "away-3", payload: msg("away-3", "x", "p-alice"), refs: ["ref-dana"], mailbox: aliceMb, senderPk: aliceId.publicKey,
      known: () => [], directory: async () => devices.map(({ mb: _mb, ...d }) => d), pinnedAccount: () => b64(new Uint8Array(32).fill(9)),
    });
    expect(pinned.withoutBundle).toEqual(["ref-dana"]);
  });

  it("the device's bundle and v2 certificate as PUT /api/keys/bundle sends them pass the server's checks", async () => {
    const dev = await identity();
    const account = await ed25519FromSeed(new Uint8Array(32).fill(11));
    const apk = b64(account.publicKey);
    const { certifyDeviceV2, DEVICE_CERT_LIFETIME_MS } = await import("../client/src/lib/p4");
    const cert = await certifyDeviceV2(account.privateKey, dev.publicKey, Date.now() + DEVICE_CERT_LIFETIME_MS);
    const bundle = (await new Mailbox(new VaultBundleStore(new LocalVault(memoryBackend())), dev).current()).bundle;
    let sent: { url: string; init: RequestInit } | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => { sent = { url, init }; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as typeof fetch;
    try {
      expect(await uploadBundle("tok", dev.publicKey, { accountKey: apk, cert: "v1", v2: { exp: cert.exp, sig: cert.sig } }, bundle)).toEqual({ ok: true });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent!.url).toBe("/api/keys/bundle");
    expect(sent!.init.method).toBe("PUT");
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(sent!.init.body));
    const parsed = parseBundleRequest(body);
    expect(parsed.ok).toBe(true);
    expect(serverVerifyDeviceCert(apk, dev.publicKey, cert.exp, cert.sig)).toBe(true);
    expect(verifyBundleSignature(dev.publicKey, bundle)).toBe(true);
    // Without a v2 certificate nothing is sent.
    expect(await uploadBundle("tok", dev.publicKey, { accountKey: apk, cert: "v1" }, bundle)).toEqual({ ok: false, code: "no-cert-v2" });
  });

  it("our hello's account: v2 while the certificate is valid, else v1 (without expiry)", () => {
    expect(helloAccountOf({ accountKey: "apk", cert: "c1", v2: { exp: Date.now() + 1000, sig: "c2" } })).toEqual({ apk: "apk", ac: "c2", cv: 2, exp: expect.any(Number) });
    expect(helloAccountOf({ accountKey: "apk", cert: "c1", v2: { exp: Date.now() - 1, sig: "c2" } })).toEqual({ apk: "apk", ac: "c1" });
    expect(helloAccountOf(null)).toBeNull();
  });
});

describe("6.12 web client — hub join proof (§ 13)", () => {
  it("proves the room key over the server's nonce; the server's check accepts it, for that nonce only", async () => {
    const nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX";
    const proof = await buildHubProof(await hubSeed(keys), keys.roomId, nonce);
    expect(await verifyHubProof(proof.pub, proof.sig, keys.roomId, nonce)).toBe(true);
    expect(serverVerifyHubProof(proof, keys.roomId, nonce)).toBe(true);
    expect(serverVerifyHubProof(proof, keys.roomId, "BBECAwQFBgcICQoLDA0ODxAREhMUFRYX")).toBe(false);
    const other = await deriveRoomKeys("team", "wrong", { memoryKiB: 64, passes: 1 });
    expect((await buildHubProof(await hubSeed(other), keys.roomId, nonce)).pub).not.toBe(proof.pub);
  });
});

describe("6.12 web client — replay window (§ 11)", () => {
  it("remembers accepted ids across a reload (encrypted store), refuses too old and too far ahead", async () => {
    const backend = memoryBackend();
    const store = new VaultReplayStore(new LocalVault(backend), 0);
    const guard = new ReplayGuard(store);
    const now = Date.now();
    expect(await guard.check(keys.roomId, "m-1", now)).toBe("ok");
    expect(await guard.check(keys.roomId, "m-1", now)).toBe("replay");
    expect(await guard.check(keys.roomId, "m-old", now - REPLAY.windowMs - 1000)).toBe("too-old");
    expect(await guard.check(keys.roomId, "m-future", now + REPLAY.futureMs + 60_000)).toBe("future");
    await store.flush();
    // A reload: a new store on the same device storage.
    const again = new ReplayGuard(new VaultReplayStore(new LocalVault(backend), 0));
    expect(await again.check(keys.roomId, "m-1", now)).toBe("replay");
    expect(await again.check(keys.roomId, "m-2", now)).toBe("ok");
    // History restored from the user's own store is exempt.
    expect(await again.check(keys.roomId, "m-1", 1, { restored: true })).toBe("ok");
  });

  it("the vault stores ciphertext under a non-extractable key", async () => {
    const backend = memoryBackend();
    const vault = new LocalVault(backend);
    await vault.putJson("x", { secret: "nikdo to nečte" });
    const raw = await backend.get("x");
    expect(JSON.stringify(raw)).not.toContain("nikdo");
    const wrap = await backend.get("wrap") as CryptoKey;
    expect(wrap.extractable).toBe(false);
    expect(await new LocalVault(backend).getJson("x")).toEqual({ secret: "nikdo to nečte" });
    expect(await new LocalVault(memoryBackend()).open("x", raw)).toBeNull(); // another device's key
  });
});

describe("6.12 web client — identity states (§ 12)", () => {
  const signer = (pk: string, apk?: string) => (apk ? { publicKey: pk, valid: true, account: { publicKey: apk, valid: true } } : { publicKey: pk, valid: true });

  it("first seen is new (not verified); verified only after the user compared; a different key is changed until accepted", async () => {
    const pins = createPinStore(null);
    const book = new TrustBook(null);
    const alice = await identity();
    const first = await evaluateIdentity({ signer: signer(alice.publicKey), protocol: 4, room: "team", name: "Alice" }, pins, book);
    expect(first).toMatchObject({ state: "new", firstSeen: true, protocol: 4 });
    const again = await evaluateIdentity({ signer: signer(alice.publicKey), protocol: 4, room: "team", name: "Alice" }, pins, book);
    expect(again.state).toBe("new");
    expect(again.firstSeen).toBeUndefined();
    await markVerified(pins, book, "team", "Alice", { pk: alice.publicKey });
    expect(await evaluateIdentity({ signer: signer(alice.publicKey), protocol: 4, room: "team", name: "Alice" }, pins, book)).toMatchObject({ state: "verified", checked: true });
    const impostor = await identity();
    const changed = await evaluateIdentity({ signer: signer(impostor.publicKey), protocol: 3, room: "team", name: "Alice" }, pins, book);
    expect(changed).toMatchObject({ state: "changed", protocol: 3 });
    await acceptChanged(pins, "team", "Alice", changed.kid!);
    expect((await evaluateIdentity({ signer: signer(impostor.publicKey), protocol: 3, room: "team", name: "Alice" }, pins, book)).state).toBe("new");
  });

  it("an account verified once is verified in every room; a v1 certificate is marked; a revoked device is changed", async () => {
    const pins = createPinStore(null);
    const book = new TrustBook(null);
    const dev = await identity();
    const apk = b64(new Uint8Array(32).fill(3));
    expect(await evaluateIdentity({ signer: signer(dev.publicKey, apk), certVersion: 1, protocol: 4, room: "team", name: "Bob" }, pins, book))
      .toMatchObject({ state: "new", account: true, certV1: true });
    await markVerified(pins, book, "team", "Bob", { pk: dev.publicKey, apk });
    expect(book.accountVerified(apk)).toBe(true);
    expect(await evaluateIdentity({ signer: signer(dev.publicKey, apk), certVersion: 2, protocol: 4, room: "another room", name: "Bobby" }, pins, book))
      .toMatchObject({ state: "verified", account: true, checked: true });
    book.markRevoked(dev.publicKey);
    expect(await evaluateIdentity({ signer: signer(dev.publicKey, apk), protocol: 4, room: "team", name: "Bob" }, pins, book)).toMatchObject({ state: "changed", revoked: true });
  });

  it("an invalid signature or certificate is invalid; no signer is unsigned", async () => {
    const pins = createPinStore(null);
    const book = new TrustBook(null);
    expect((await evaluateIdentity({ signer: { publicKey: (await identity()).publicKey, valid: false }, protocol: 3, room: "r", name: "X" }, pins, book)).state).toBe("invalid");
    expect((await evaluateIdentity({ signer: { publicKey: (await identity()).publicKey, valid: true, account: { publicKey: "apk", valid: false } }, protocol: 4, room: "r", name: "Y" }, pins, book)).state).toBe("invalid");
    expect(await evaluateIdentity({ signer: null, protocol: 3, room: "r", name: "Z" }, pins, book)).toEqual({ state: "unsigned", protocol: 3 });
  });
});

/* ------------------------------------------------------------- KT client */

async function ktServer() {
  const { privateKey, publicKey } = await ed25519FromSeed(new Uint8Array(32).fill(0x17));
  const entries: KtEntry[] = [];
  const leaves: Hash[] = [];
  let ts = 1_700_000_000_000;
  return {
    key: b64(publicKey),
    async append(e: KtEntry) { entries.push(e); leaves.push(await entryLeafHash(e)); },
    async sth(size = leaves.length): Promise<SignedTreeHead> { return signSth(privateKey, size, await treeHash(leaves, 0, size), ts++); },
    async consistency(from: number, to: number) { return { from, to, proof: to > leaves.length ? [] : (await consistencyProof(leaves, from, to)).map(b64) }; },
    async lookup(u: string): Promise<KtLookup> {
      const sth = await this.sth();
      const found = [];
      for (let i = 0; i < leaves.length; i++) if (entries[i].u === u) found.push({ entry: entries[i], index: i, proof: (await inclusionProof(leaves, i)).map(b64) });
      return { sth, entries: found };
    },
    privateKey,
  };
}

describe("6.12 web client — key transparency (§ 14)", () => {
  const memoryStorage = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } };
  };

  it("pins the key, keeps consistent heads, raises a persistent alert on a rewritten history, gossips, checks devices", async () => {
    const server = await ktServer();
    const u = await ktUser("alice");
    const apk = b64(new Uint8Array(32).fill(1));
    const dpk = (await identity()).publicKey;
    await server.append({ t: "acct", u, apk, ts: 1 });
    await server.append({ t: "dev", u, apk, dpk, exp: Date.now() + 86_400_000, ts: 2 });
    let current: () => Promise<SignedTreeHead> = () => server.sth();
    const get = async (path: string): Promise<unknown> => {
      if (path === "/api/kt/key") return { key: server.key };
      if (path === "/api/kt/sth") return current();
      const m = /from=(\d+)&to=(\d+)/.exec(path);
      if (m) return server.consistency(Number(m[1]), Number(m[2]));
      throw new Error(path);
    };
    const storage = memoryStorage();
    const kt = new KtClient("https://chat.example", new LocalKtStore(storage), get);
    expect((await kt.refresh()).state).toBe("ok");
    expect(kt.newest()?.size).toBe(2);
    // The account's device is in the log; a revocation would say so.
    expect(await kt.checkDevice(await server.lookup(u), apk, dpk, "alice")).toBe("ok");
    expect(await kt.checkDevice(await server.lookup(u), apk, (await identity()).publicKey, "alice")).toBe("absent");
    await server.append({ t: "rev", u, apk, dpk, ts: 3 });
    expect(await kt.checkDevice(await server.lookup(u), apk, dpk, "alice")).toBe("revoked");
    // Gossip: a peer's (consistent) newer head is fine.
    expect(await kt.gossip(await server.sth())).toBe("ok");
    // A head of the same size with another root (a fork): the alert, kept across a reload.
    const fork = await signSth(server.privateKey, 3, new Uint8Array(32).fill(5), Date.now());
    expect(await kt.gossip(fork)).toBe("split-view");
    expect(kt.current()).toMatchObject({ state: "alert", alert: { kind: "split-view" } });
    const reloaded = new KtClient("https://chat.example", new LocalKtStore(storage), get);
    expect((await reloaded.refresh()).state).toBe("alert");
    await reloaded.dismiss();
    expect(reloaded.current().state).toBe("ok");
    // The server rewrote its history: the next head is not an extension of the kept one.
    const other = await ktServer();
    for (let i = 0; i < 5; i++) await other.append({ t: "acct", u: await ktUser(`x${i}`), apk, ts: i });
    current = () => other.sth();
    const status = await reloaded.refresh();
    expect(status).toMatchObject({ state: "alert", alert: { kind: "inconsistent" } });
  });

  it("a server without key transparency: nothing pinned, nothing checked", async () => {
    const kt = new KtClient("https://old.example", new LocalKtStore(memoryStorage()), async () => { throw new Error("kt 503"); });
    expect((await kt.refresh()).state).toBe("off");
    expect(kt.newest()).toBeNull();
    expect(await kt.gossip({ size: 1, root: "x", ts: 1, sig: "y" })).toBe("ignored");
    expect(await kt.checkDevice(null, "a", "b")).toBe("unverified");
  });
});

describe("6.12 web client — background rooms (room-hub.ts)", () => {
  it("join with a proof over the server's nonce, speak protocol 4 with a 6.12 peer (room and private messages)", async () => {
    const me = await identity();
    const sockets: Array<{ sent: string[]; onopen?: () => void; onmessage?: (e: { data: string }) => void; readyState: number }> = [];
    const deps: HubDeps = {
      wsUrl: () => "ws://test/ws",
      rtcConfig: async () => ({}),
      makeSocket: () => {
        const s = { sent: [] as string[], readyState: 1, url: "ws://test/ws", send(t: string) { this.sent.push(t); }, close() {} };
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      makePeer: () => { throw new Error("no WebRTC here"); },
      derive: async () => keys,
      identity: async () => me,
    };
    const room = new BackgroundRoom({ key: roomKeyOf("team"), room: "team", label: "Team", name: "Me", passphrase: "x" }, deps, () => undefined);
    await room.start();
    const socket = sockets[0];
    socket.onopen!();
    const nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX";
    socket.onmessage!({ data: JSON.stringify({ type: "hello", nonce }) });
    await new Promise((r) => setTimeout(r, 50));
    const join = JSON.parse(socket.sent.find((t) => JSON.parse(t).type === "join")!) as { room: string; proof: { pub: string; sig: string } };
    expect(join.room).toBe(keys.roomId);
    expect(serverVerifyHubProof(join.proof, keys.roomId, nonce)).toBe(true);
    socket.onmessage!({ data: JSON.stringify({ type: "joined", peerId: "p-me", peers: [], proven: true }) });
    await new Promise((r) => setTimeout(r, 10));

    const net = new Net();
    const b = await client(net, "p-b");
    net.clients.set("p-me", { receive: (from: string, raw: Record<string, unknown>) => room.handleChannelText(from, JSON.stringify(raw)) } as unknown as Client);
    await room.handleChannelOpen("p-b", (t) => { net.send("p-me", "p-b", t); });
    await b.room.open("p-me");
    await net.drain();
    expect(room.protocolOf("p-b")).toBe(4);
    expect(b.room.protocolOf("p-me")).toBe(4);
    const sealed = await b.room.sealRoom("bg-1", msg("bg-1", "do pozadí", "p-b"), ["p-me"]);
    net.send("p-b", "p-me", JSON.stringify(sealed!.envelope));
    net.send("p-b", "p-me", JSON.stringify(await b.room.sealPrivate("p-me", "bg-2", msg("bg-2", "soukromě", "p-b"))));
    await net.drain();
    expect(room.messages.map((m) => [m.text, m.sealedWith, m.cryptoVersion, m.identity?.state])).toEqual([
      ["do pozadí", "p4-sk", 4, "new"],
      ["soukromě", "p4-pair", 4, "new"],
    ]);
    room.stop();
  });
});

describe("6.12 web client — the light-mode outbox", () => {
  it("keeps a waiting payload under a page-only key (it is sealed for each peer when it goes)", async () => {
    const sealer = new PayloadSealer();
    const payload = msg("q-1", "čeká na Boba", "p-a");
    const sealed = await sealer.seal("q-1", payload);
    expect(JSON.stringify(sealed)).not.toContain("Boba");
    expect(await sealer.open("q-1", sealed)).toEqual(payload);
    await expect(sealer.open("q-2", sealed)).rejects.toThrow(); // bound to its message id
    await expect(new PayloadSealer().open("q-1", sealed)).rejects.toThrow(); // another page's key
  });
});
