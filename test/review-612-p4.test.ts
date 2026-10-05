// REVIEW-612 — proofs of concept for the protocol-4 client findings of the
// 6.12 security review (docs/review-612.md, findings P01–P14).
//
// Every test here asserts the SECURE behaviour. The ones that fail on
// de2874d3 are `it.skip` with a `// REVIEW-612 Pxx` note so the suite stays
// green; un-skip a test when its finding is fixed (each one was run un-skipped
// and failed for the reason given in the note). The plain `it` tests pass
// today and pin behaviour the fixes must keep.

import { beforeAll, describe, expect, it } from "vitest";
import { deriveRoomKeys, type RoomKeys } from "../client/src/lib/envelope";
import { createPinStore, keyFingerprint, keyId, type Identity } from "../client/src/lib/identity";
import { fromBase64, toBase64 } from "../client/src/lib/crypto";
import {
  b64, certifyDeviceV2, createBundle, DEVICE_CERT_LIFETIME_MS, ed25519FromSeed, entryLeafHash, isMailboxItem, isMailboxSet, ktUser,
  Mailbox, MAILBOX_LIFETIME_MS, MemoryBundleStore, MemoryReplayStore, PairHandshake, ReplayGuard, signSth, treeHash,
  type DirectoryDevice, type Hash, type KtEntry, type MailboxItem, type MailboxSet, type SignedTreeHead,
} from "../client/src/lib/p4";
import { P4Room } from "../client/src/lib/p4-session";
import { LocalVault, LocalKtStore, memoryBackend, VaultBundleStore, type KvBackend } from "../client/src/lib/p4-store";
import { evaluateIdentity, TrustBook } from "../client/src/lib/p4-trust";
import { sealForAway } from "../client/src/lib/p4-away";
import { KtClient } from "../client/src/lib/p4-kt";
import { BackgroundRoom, roomKeyOf, type HubDeps } from "../client/src/lib/room-hub";
import { forwardIndex, verifyForward, verifyQuote } from "../client/src/lib/validate";

const subtle = globalThis.crypto.subtle;
const b64buf = (b: ArrayBuffer) => toBase64(new Uint8Array(b));
const DAY = 24 * 60 * 60 * 1000;

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

const msg = (id: string, text: string, senderId: string, senderName = senderId) => ({ id, text, createdAt: Date.now(), senderId, senderName });

/** A device certified by an account (what the server's `key-bundles` answers with), with its mailbox. */
async function certifiedDevice(accountSeed: number, now = Date.now()) {
  const account = await ed25519FromSeed(new Uint8Array(32).fill(accountSeed));
  const apk = b64(account.publicKey);
  const dev = await identity();
  const mailbox = new Mailbox(new MemoryBundleStore(), dev);
  const cert = await certifyDeviceV2(account.privateKey, dev.publicKey, now + DEVICE_CERT_LIFETIME_MS, now);
  const directory: DirectoryDevice = { pk: dev.publicKey, apk, cert, bundle: (await mailbox.current(now)).bundle };
  return { dev, apk, mailbox, directory };
}

/* ---------------------------------------------------------------- P01 */

describe("REVIEW-612 P01 — messages for away members and the server's key directory", () => {
  // REVIEW-612 P01: the App's pinnedAccount (App.tsx:1746) reads the account key from TrustBook.devicesOfRef, which
  // drops devices whose remembered bundle has expired (p4-trust.ts:132) — 7 days after we last saw Bob, his pin is
  // gone and sealForAway (p4-away.ts:70-78) seals to ANY device the server lists, e.g. one certified by the server's
  // own account key. Fails today: per["ref-bob"] is an item for the server's device, and the server opens it.
  it.skip("a member whose account we pinned is not sealed to a device of another account once his bundle expired", async () => {
    const now = Date.now();
    const seen = now - 8 * DAY;
    const bob = await certifiedDevice(0x0b, seen);
    const book = new TrustBook(null);
    book.rememberDevice(bob.dev.publicKey, { mb: (await bob.mailbox.current(seen)).bundle, apk: bob.apk }, seen);
    book.rememberRef(keys.roomId, "ref-bob", bob.dev.publicKey, seen);
    expect((await bob.mailbox.current(seen)).bundle.exp).toBeLessThan(now); // a week later
    // The server answers `key-bundles` for Bob's reference with a device of its own account.
    const server = await certifiedDevice(0x5e, now);
    const alice = await identity();
    const sealed = await sealForAway({
      roomId: keys.roomId, id: "away-p01a", payload: msg("away-p01a", "for Bob only", "p-alice"), refs: ["ref-bob"],
      mailbox: new Mailbox(new MemoryBundleStore(), alice), senderPk: alice.publicKey, now,
      known: (ref) => book.devicesOfRef(keys.roomId, ref, now),
      directory: async () => [server.directory],
      // exactly what App.tsx:1746 passes
      pinnedAccount: (ref) => book.devicesOfRef(keys.roomId, ref, now).find((d) => d.apk)?.apk ?? null,
    });
    const item = sealed.per["ref-bob"] as MailboxItem | MailboxSet | undefined;
    if (item) expect(await server.mailbox.open<{ text: string }>(item, keys.roomId, now)).toBeNull();
    expect(sealed.per["ref-bob"]).toBeUndefined();
  });

  // REVIEW-612 P01: devices remembered behind a reference (TrustBook.devicesOfRef) are sealed to with no account check
  // at all — the `pinned` filter of sealForAway applies to directory devices only (p4-away.ts:69). The reference a
  // device is remembered under comes from the server (relay `from`, App.tsx:2224-2225; hub peer refs, App.tsx:2839-2840),
  // so the server can plant a device of its own behind Bob's reference with one relay item. Fails today: two items.
  it.skip("a device planted behind a member's reference is not sealed to when it is not of the member's pinned account", async () => {
    const now = Date.now();
    const bob = await certifiedDevice(0x0b, now);
    const planted = await certifiedDevice(0x5e, now);
    const book = new TrustBook(null);
    book.rememberDevice(bob.dev.publicKey, { mb: bob.directory.bundle, apk: bob.apk }, now);
    book.rememberRef(keys.roomId, "ref-bob", bob.dev.publicKey, now);
    // A mailbox item the server relayed with `from` = Bob's reference, sealed by a device it controls:
    // App.tsx handleRelayDelivery remembers that device behind Bob's reference.
    book.rememberDevice(planted.dev.publicKey, { mb: planted.directory.bundle, apk: null }, now);
    book.rememberRef(keys.roomId, "ref-bob", planted.dev.publicKey, now);
    const alice = await identity();
    const sealed = await sealForAway({
      roomId: keys.roomId, id: "away-p01b", payload: msg("away-p01b", "for Bob only", "p-alice"), refs: ["ref-bob"],
      mailbox: new Mailbox(new MemoryBundleStore(), alice), senderPk: alice.publicKey, now,
      known: (ref) => book.devicesOfRef(keys.roomId, ref, now),
      pinnedAccount: (ref) => book.devicesOfRef(keys.roomId, ref, now).find((d) => d.apk)?.apk ?? null,
    });
    const item = sealed.per["ref-bob"] as MailboxItem | MailboxSet;
    expect(await planted.mailbox.open(item, keys.roomId, now)).toBeNull();
    expect(isMailboxItem(item)).toBe(true);
  });

  // REVIEW-612 P01 (design): a member we never met gets the message sealed to whatever the server lists — in 6.11 the
  // server held a room-key envelope it could not open; in 6.12 it can answer `key-bundles` with its own device and read
  // the message. Without a pinned account (or a KT-verified, user-confirmed one) the directory must not be trusted.
  it.skip("a never-seen member's message is not sealed to an unverified directory device", async () => {
    const now = Date.now();
    const server = await certifiedDevice(0x5e, now);
    const alice = await identity();
    const sealed = await sealForAway({
      roomId: keys.roomId, id: "away-p01c", payload: msg("away-p01c", "x", "p-alice"), refs: ["ref-carol"],
      mailbox: new Mailbox(new MemoryBundleStore(), alice), senderPk: alice.publicKey, now,
      known: () => [], directory: async () => [server.directory], pinnedAccount: () => null,
    });
    expect(sealed.per["ref-carol"]).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- P02 */

describe("REVIEW-612 P02 — hello v4 fields outside sig4", () => {
  async function hellos() {
    const a = await identity();
    const b = await identity();
    const start = (me: Identity, self: string, peer: string, sth: SignedTreeHead | null) => PairHandshake.start({
      roomId: keys.roomId, check: keys.check, selfPeerId: self, peerPeerId: peer,
      v3: { check: keys.check, pk: me.publicKey, dh: me.dhPublicKey, sig: "c2lnLXYz", caps: ["bin", "media"], user: `${self}-user` },
      signer: me, mb: null, acc: null, sth,
    });
    const kt = await ed25519FromSeed(new Uint8Array(32).fill(0x17));
    const sth = await signSth(kt.privateKey, 1, new Uint8Array(32).fill(1), 1);
    return { ha: await start(a, "p-a", "p-b", null), hb: await start(b, "p-b", "p-a", sth) };
  }

  // REVIEW-612 P02: helloSig4Data (handshake.ts:64-66) signs check, pk, dh, e, k, n, mb, acc — not `caps`, `sth`
  // or `user`. Whoever can rewrite the data channel (the server swapping DTLS fingerprints in signaling it can
  // open with the room key, i.e. server + an ex-member) strips "media" (App.tsx:2872: no protocol-4 media key is
  // sent, frames go unsealed — the call is protected by the attacker's DTLS-SRTP only) and `sth` (KT gossip off).
  // Fixed: sig4 covers capsDigest, userDigest and sthDigest (spec § 2).
  it("a hello whose caps or tree head were changed in transit does not verify", async () => {
    const { ha, hb } = await hellos();
    const stripped = { ...hb.hello, caps: hb.hello.caps.filter((c) => c !== "media") };
    expect((await ha.acceptHello(stripped)).verdict.ok).toBe(false);
    const { ha: ha2, hb: hb2 } = await hellos();
    expect((await ha2.acceptHello({ ...hb2.hello, sth: null })).verdict.ok).toBe(false);
  });

  it("(control) the untouched hello verifies", async () => {
    const { ha, hb } = await hellos();
    expect((await ha.acceptHello(hb.hello)).verdict.ok).toBe(true);
  });
});

/* ---------------------------------------------------------------- P03 */

type Frame = { from: string; to: string; text: string };

class Net {
  readonly queue: Frame[] = [];
  readonly rooms = new Map<string, P4Room>();
  drop: ((f: Frame) => boolean) | null = null;
  send(from: string, to: string, text: string): boolean { this.queue.push({ from, to, text }); return true; }
  async drain(): Promise<void> {
    while (this.queue.length) {
      const f = this.queue.shift()!;
      if (this.drop?.(f)) continue;
      await this.rooms.get(f.to)!.handle(f.from, JSON.parse(f.text) as Record<string, unknown>);
    }
  }
}

function room(net: Net, id: string, me: Identity, book: TrustBook): P4Room {
  const r = new P4Room({
    keys, identity: me, selfId: () => id, send: (peerId, text) => net.send(id, peerId, text),
    helloExtra: () => ({ caps: ["bin", "media"] }), local: () => ({ mb: null, acc: null, sth: null }), book,
  });
  net.rooms.set(id, r);
  return r;
}

describe("REVIEW-612 P03 — the room-key fallback for a peer that is still 'pending'", () => {
  // REVIEW-612 P03: App.tsx deliverToPeers waits 2.5 s for a "pending" peer (line 2575) and then seals for it with
  // the ROOM key (lines 2608-2612) — also a private message, and also for a device key once seen with protocol 4:
  // the downgrade marker is consulted only for a protocol-3 hello (p4-session.ts:274). Withholding the peer's
  // p4-kem (or its hello) keeps it pending, so everything it gets is under the room key. Fails today: "pending".
  it.skip("a device once seen with protocol 4 whose handshake does not complete is never left 'pending' (room-key eligible)", async () => {
    const aId = await identity();
    const bId = await identity();
    const book = new TrustBook(null);
    book.markP4(bId.publicKey); // we spoke protocol 4 with this device before
    const net = new Net();
    const a = room(net, "p-a", aId, book);
    const b = room(net, "p-b", bId, new TrustBook(null));
    net.drop = (f) => f.from === "p-b" && (JSON.parse(f.text) as { kind?: string }).kind === "p4-kem";
    await Promise.all([a.open("p-b"), b.open("p-a")]);
    await net.drain();
    expect(a.info("p-b")?.pk).toBe(bId.publicKey); // its valid hello v4 is in hand
    expect(await a.settled("p-b", 50)).not.toBe("pending");
  });
});

/* ---------------------------------------------------------------- P05 */

describe("REVIEW-612 P05 — key-transparency alerts the server can suppress", () => {
  const storage = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } };
  };

  // REVIEW-612 P05: KtState.resolveGossip/update call fetchConsistency OUTSIDE their try (kt.ts:280-287); a server
  // that answers the consistency request with an error makes them throw, KtClient.gossip/refresh swallow it
  // (p4-kt.ts:82, :113) — no alert, ever. A forked server simply refuses to prove consistency between two heads
  // it signed. Fixed: the proof is owed (KtState.owe); refused twice it is the "unproven" alert.
  it("a server that will not prove consistency between two heads it signed raises the alert", async () => {
    const { privateKey, publicKey } = await ed25519FromSeed(new Uint8Array(32).fill(0x17));
    const leaves: Hash[] = [];
    for (let i = 0; i < 3; i++) leaves.push(await entryLeafHash({ t: "acct", u: await ktUser(`u${i}`), apk: b64(new Uint8Array(32).fill(i)), ts: i } as KtEntry));
    const ours = await signSth(privateKey, 2, await treeHash(leaves, 0, 2), 1);
    const fork = await signSth(privateKey, 3, new Uint8Array(32).fill(9), 2); // another history, signed by the same key
    const get = async (path: string): Promise<unknown> => {
      if (path === "/api/kt/key") return { key: b64(publicKey) };
      if (path === "/api/kt/sth") return ours;
      throw new Error("kt 400"); // the consistency proof is refused
    };
    const kt = new KtClient("https://chat.example", new LocalKtStore(storage()), get);
    await kt.refresh();
    expect(kt.newest()?.size).toBe(2);
    await kt.gossip(fork); // a peer saw a tree of 3 the server cannot prove extends ours
    await kt.gossip(fork);
    await kt.refresh();
    expect(kt.current().state).toBe("alert");
  });
});

/* ---------------------------------------------------------------- P06 */

describe("REVIEW-612 P06 — background rooms and changed keys", () => {
  // REVIEW-612 P06: BackgroundRoom.accept (room-hub.ts:434-436) gives every signed message the state "new" — no pin
  // check — and App.tsx:3429-3432 merges what it collected into the room on screen as it is. A second device that
  // uses a pinned member's name is not "changed", its messages are not held (App.tsx:468) and they reach
  // notifications. Fails today: both messages are "new".
  it.skip("a second key under the same name in a background room is 'changed', not 'new'", async () => {
    const me = await identity();
    const sockets: Array<{ sent: string[]; onopen?: () => void; onmessage?: (e: { data: string }) => void }> = [];
    const deps: HubDeps = {
      wsUrl: () => "ws://test/ws", rtcConfig: async () => ({}),
      makeSocket: () => { const s = { sent: [] as string[], readyState: 1, send(t: string) { this.sent.push(t); }, close() {} }; sockets.push(s); return s as unknown as WebSocket; },
      makePeer: () => { throw new Error("no WebRTC here"); },
      derive: async () => keys, identity: async () => me, replay: new ReplayGuard(new MemoryReplayStore()),
    };
    const bg = new BackgroundRoom({ key: roomKeyOf("team"), room: "team", label: "Team", name: "Me", passphrase: "x" }, deps, () => undefined);
    await bg.start();
    sockets[0].onopen!();
    sockets[0].onmessage!({ data: JSON.stringify({ type: "joined", peerId: "p-me", peers: [] }) });
    await new Promise((r) => setTimeout(r, 10));
    const net = new Net();
    const fake = { handle: async (from: string, raw: Record<string, unknown>) => { await bg.handleChannelText(from, JSON.stringify(raw)); return true; } } as unknown as P4Room;
    net.rooms.set("p-me", fake);
    for (const [peerId, text] of [["p-bob", "real Bob"], ["p-mallory", "fake Bob"]] as const) {
      const other = room(net, peerId, await identity(), new TrustBook(null));
      await bg.handleChannelOpen(peerId, (t) => { net.send("p-me", peerId, t); });
      await other.open("p-me");
      await net.drain();
      const sealed = await other.sealRoom(`m-${peerId}`, msg(`m-${peerId}`, text, peerId, "Bob"), ["p-me"]);
      net.send(peerId, "p-me", JSON.stringify(sealed!.envelope));
      await net.drain();
    }
    expect(bg.messages.map((m) => [m.text, m.senderName])).toEqual([["real Bob", "Bob"], ["fake Bob", "Bob"]]);
    expect(bg.messages[1].identity?.state).toBe("changed");
    bg.stop();
  });
});

/* ---------------------------------------------------------------- P08 */

describe("REVIEW-612 P08 — a verified account under any name", () => {
  // REVIEW-612 P08: evaluateIdentity (p4-trust.ts:186) shows "verified" whenever the ACCOUNT was verified once, for
  // whatever display name the message carries — the name is pinned to the account on first sight (TOFU) in the same
  // call. A contact the user verified joins another room as "Alice" and every message shows a green "verified Alice".
  // Fails today: "verified".
  it.skip("a verified account's first message under a new name in a new room is not shown as verified", async () => {
    const pins = createPinStore(null);
    const book = new TrustBook(null);
    const mallory = await identity();
    const apk = b64(new Uint8Array(32).fill(4));
    book.verifyAccount(apk); // the user once compared safety numbers with Mallory
    const id = await evaluateIdentity({ signer: { publicKey: mallory.publicKey, valid: true, account: { publicKey: apk, valid: true } }, certVersion: 2, protocol: 4, room: "board", name: "Alice" }, pins, book);
    expect(id.state).not.toBe("verified");
  });
});

/* ---------------------------------------------------------------- P09 */

describe("REVIEW-612 P09 — 'forwarded from' checked against messages of anyone", () => {
  // REVIEW-612 P09: forwardIndex (validate.ts:276-280) keys on the CLAIMED senderName and text of every message —
  // including messages that are held as "changed" and messages of the forwarder itself under another name. Mallory
  // posts "pay 100 to X" as "Bob" (held, or in a room where Bob is not pinned) and then forwards it "from Bob":
  // App.tsx:6017 shows the forward as verified. Fails today: true.
  it.skip("a forward is not verified by a message whose sender identity is not the named member's", () => {
    const messages = [
      { id: "m1", senderId: "p-mallory", senderName: "Bob", text: "pay 100 to X", identity: { state: "changed" as const } },
    ];
    expect(verifyForward("Bob", "pay 100 to X", forwardIndex(messages))).not.toBe(true);
  });
});

/* ---------------------------------------------------------------- P14 */

describe("REVIEW-612 P14 — a held message shown through a quote", () => {
  // REVIEW-612 P14: a message from a changed key is held behind a warning (App.tsx:468), but quoteIndex
  // (App.tsx:1006) holds every message and verifyQuote (validate.ts:260-270) shows the STORED text and sender of
  // the quoted message — so a reply to the held message (from the attacker's own, unheld identity) displays the
  // held text as an authentic quote of "Bob". Fails today: the held text is shown.
  it.skip("a quote of a held (changed-key) message does not show its text", () => {
    const held = { id: "m1", senderName: "Bob", text: "pay 100 to X", identity: { state: "changed" as const } };
    const view = verifyQuote({ id: "m1", senderName: "Bob", text: "" }, held);
    expect(view?.text).not.toBe("pay 100 to X");
  });
});

/* ---------------------------------------------------------------- P11, P12 */

describe("REVIEW-612 P11/P12 — the device vault", () => {
  // REVIEW-612 P11: VaultBundleStore caches the row list per instance (p4-store.ts:167-185) and writes it whole —
  // two tabs (two instances on one IndexedDB) that each make a bundle keep only the last writer's list: the other
  // bundle's ML-KEM key is gone and every item sealed to that bundle (it was in hellos and the directory) is lost.
  // VaultReplayStore (p4-store.ts:258-266) has the same last-writer-wins race for the replay window.
  // Fixed: one row per bundle; the replay window merges on write (test/review-612-fixes.test.ts).
  it("two tabs that each create a mailbox bundle both keep their keys", async () => {
    const backend = memoryBackend();
    const dev = await identity();
    const tab1 = new VaultBundleStore(new LocalVault(backend));
    const tab2 = new VaultBundleStore(new LocalVault(backend));
    await tab1.all();
    await tab2.all();
    const k1 = await createBundle(dev);
    const k2 = await createBundle(dev);
    await tab1.put(k1);
    await tab2.put(k2);
    const later = new VaultBundleStore(new LocalVault(backend));
    expect((await later.all()).map((k) => k.bundle.id).sort()).toEqual([k1.bundle.id, k2.bundle.id].sort());
  });

  // REVIEW-612 P12: LocalVault.wrapKey (p4-store.ts:96-99) treats a FAILED read of the wrapping key like a missing
  // one: it generates a new key and stores it over the old one. One transient IndexedDB error and every sealed row —
  // the mailbox bundles' ML-KEM keys, the replay windows — no longer opens (silently: getJson returns null; an
  // empty replay window re-admits relayed replays). Fixed: the read is retried, then VaultUnavailable; only an
  // absent key is created, with `add`.
  it("a failed read of the wrapping key does not replace it", async () => {
    const backend = memoryBackend();
    await new LocalVault(backend).putJson("replay:x", [["k", 1]]);
    let fail = true;
    const flaky: KvBackend = {
      persistent: true,
      get: async (id) => { if (id === "wrap" && fail) { fail = false; throw new Error("IDB transaction aborted"); } return backend.get(id); },
      put: (id, v) => backend.put(id, v), delete: (id) => backend.delete(id), clear: () => backend.clear(),
    };
    await new LocalVault(flaky).getJson("replay:x");
    expect(await new LocalVault(backend).getJson("replay:x")).toEqual([["k", 1]]);
  });
});

/* ---------------------------------------------------------- unchanged */

describe("REVIEW-612 — checked and correct (keep)", () => {
  it("a set item from another message, or an expired bundle, is refused by the library", async () => {
    const now = Date.now();
    const dev = await identity();
    const mb = new Mailbox(new MemoryBundleStore(), dev);
    const bundle = (await mb.current(now)).bundle;
    expect(bundle.exp).toBe(now + MAILBOX_LIFETIME_MS);
    const sender = await identity();
    const smb = new Mailbox(new MemoryBundleStore(), sender);
    await expect(smb.seal({ roomId: keys.roomId, id: "x", payload: { id: "x" }, recipient: { pk: dev.publicKey, bundle }, senderPk: sender.publicKey, now: bundle.exp + 1 })).rejects.toMatchObject({ code: "expired" });
    const item = await smb.seal({ roomId: keys.roomId, id: "x", payload: { id: "x" }, recipient: { pk: dev.publicKey, bundle }, senderPk: sender.publicKey, now });
    await expect(mb.open({ v: 4, kind: "mb-set", id: "y", items: [item] } as MailboxSet, keys.roomId, now)).rejects.toMatchObject({ code: "malformed" });
    expect(isMailboxSet({ v: 4, kind: "mb-set", id: "y", items: [item] })).toBe(true);
  });
});
