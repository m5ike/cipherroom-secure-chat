// Tests for the fixes of the 6.12 security review's protocol-4 client findings
// (docs/review-612.md P01–P14, S14 client side). The PoCs themselves are in
// test/review-612-p4.test.ts (un-skipped as fixed); these cover the rest of
// each fix: the paths around the PoC, the honest states, and that nothing a
// legitimate member does stops working.

import { beforeAll, describe, expect, it } from "vitest";
import {
  b64, certifyDeviceV2, consistencyProof, createBundle, DEVICE_CERT_LIFETIME_MS, ed25519FromSeed, entryLeafHash, inclusionProof, isMailboxItem, ktUser,
  KT_PROOF_DEADLINE_MS, KtState, Mailbox, MemoryBundleStore, MemoryKtStore, ReplayGuard, signSth, treeHash,
  type DirectoryDevice, type Hash, type KtEntry, type KtLookup, type MailboxItem, type SignedTreeHead,
} from "../client/src/lib/p4";
import { sealForAway } from "../client/src/lib/p4-away";
import { createOutbox, perPeerSender } from "../client/src/lib/outbox";
import { KtClient, KtHttpError } from "../client/src/lib/p4-kt";
import { LocalKtStore, LocalVault, memoryBackend, VaultBundleStore, VaultReplayStore, VaultUnavailable, type KvBackend } from "../client/src/lib/p4-store";
import { P4Room, type P4Events } from "../client/src/lib/p4-session";
import { TrustBook } from "../client/src/lib/p4-trust";
import { deriveRoomKeys, type RoomKeys } from "../client/src/lib/envelope";
import { keyFingerprint, keyId, type Identity } from "../client/src/lib/identity";
import { fromBase64, toBase64 } from "../client/src/lib/crypto";

const memoryStorage = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } };
};

/* ------------------------------------------------------------ KT (P04, P05) */

async function ktServer() {
  const { privateKey, publicKey } = await ed25519FromSeed(new Uint8Array(32).fill(0x17));
  const entries: KtEntry[] = [];
  const leaves: Hash[] = [];
  let ts = 1_700_000_000_000;
  return {
    key: b64(publicKey),
    privateKey,
    async append(e: KtEntry) { entries.push(e); leaves.push(await entryLeafHash(e)); },
    async sth(size = leaves.length): Promise<SignedTreeHead> { return signSth(privateKey, size, await treeHash(leaves, 0, size), ts++); },
    async consistency(from: number, to: number) { return { from, to, proof: (await consistencyProof(leaves, from, to)).map(b64) }; },
    async lookup(u: string): Promise<KtLookup> {
      const sth = await this.sth();
      const found = [];
      for (let i = 0; i < leaves.length; i++) if (entries[i].u === u) found.push({ entry: entries[i], index: i, proof: (await inclusionProof(leaves, i)).map(b64) });
      return { sth, entries: found };
    },
  };
}

describe("REVIEW-612 P05 — consistency proofs the server owes", () => {
  it("a transient failure (network, kt-busy) is not a refusal: the alert comes only after the deadline", async () => {
    let now = 1_800_000_000_000;
    const { privateKey, publicKey } = await ed25519FromSeed(new Uint8Array(32).fill(0x17));
    const leaves: Hash[] = [];
    for (let i = 0; i < 3; i++) leaves.push(await entryLeafHash({ t: "acct", u: await ktUser(`u${i}`), apk: b64(new Uint8Array(32).fill(i)), ts: i } as KtEntry));
    const ours = await signSth(privateKey, 2, await treeHash(leaves, 0, 2), 1);
    const theirs = await signSth(privateKey, 3, await treeHash(leaves, 0, 3), 2);
    const kt = new KtState(new MemoryKtStore(), () => now);
    await kt.pinKey("o", b64(publicKey));
    expect((await kt.update("o", ours, async () => { throw new Error("unused"); })).status).toBe("ok");
    const busy = async () => { throw new KtHttpError(503); };
    for (let i = 0; i < 5; i++) expect(await kt.resolveGossip("o", theirs, busy)).toEqual({ status: "unproven", alert: null });
    expect(await kt.pending("o")).toHaveLength(1);
    expect((await kt.pending("o"))[0].refusals).toBe(0);
    // A network error (fetch's TypeError) neither.
    expect(await kt.resolveGossip("o", theirs, async () => { throw new TypeError("Failed to fetch"); })).toEqual({ status: "unproven", alert: null });
    now += KT_PROOF_DEADLINE_MS;
    const late = await kt.retryPending("o", busy);
    expect(late).toMatchObject({ kind: "unproven" });
    expect(await kt.alert("o")).toMatchObject({ kind: "unproven" });
  });

  it("a proof that comes later settles what was owed; a head owed a proof is not kept", async () => {
    const server = await ktServer();
    for (let i = 0; i < 4; i++) await server.append({ t: "acct", u: await ktUser(`x${i}`), apk: b64(new Uint8Array(32).fill(i)), ts: i });
    const kt = new KtState(new MemoryKtStore());
    await kt.pinKey("o", server.key);
    await kt.update("o", await server.sth(2), async () => { throw new Error("unused"); });
    const newer = await server.sth(4);
    expect(await kt.update("o", newer, async () => { throw new KtHttpError(503); })).toEqual({ status: "unproven", alert: null });
    expect((await kt.newest("o"))?.size).toBe(2); // not kept without the proof
    expect(await kt.retryPending("o", (from, to) => server.consistency(from, to))).toBeNull();
    expect(await kt.pending("o")).toEqual([]);
    expect((await kt.update("o", newer, (from, to) => server.consistency(from, to))).status).toBe("ok");
    expect((await kt.newest("o"))?.size).toBe(4);
  });

  it("an answer that does not verify is the alert at once (whatever its cause)", async () => {
    const server = await ktServer();
    for (let i = 0; i < 4; i++) await server.append({ t: "acct", u: await ktUser(`x${i}`), apk: b64(new Uint8Array(32).fill(i)), ts: i });
    const kt = new KtState(new MemoryKtStore());
    await kt.pinKey("o", server.key);
    await kt.update("o", await server.sth(2), async () => { throw new Error("unused"); });
    expect(await kt.update("o", await server.sth(4), async (from, to) => ({ from, to, proof: [] }))).toMatchObject({ status: "inconsistent", alert: { kind: "inconsistent" } });
  });

  it("the KtClient: refused proofs survive a reload and are asked for at every refresh; a lookup under an unproven head is unverified", async () => {
    const server = await ktServer();
    const u = await ktUser("alice");
    const apk = b64(new Uint8Array(32).fill(1));
    const dpk = b64(new Uint8Array(91).fill(2));
    await server.append({ t: "acct", u, apk, ts: 1 });
    await server.append({ t: "dev", u, apk, dpk, exp: Date.now() + 86_400_000, ts: 2 });
    let refuse = true;
    const get = async (path: string): Promise<unknown> => {
      if (path === "/api/kt/key") return { key: server.key };
      if (path === "/api/kt/sth") return server.sth(2);
      const m = /from=(\d+)&to=(\d+)/.exec(path);
      if (m) { if (refuse) throw new KtHttpError(400); return server.consistency(Number(m[1]), Number(m[2])); }
      throw new Error(path);
    };
    const storage = memoryStorage();
    const kt = new KtClient("https://chat.example", new LocalKtStore(storage), get);
    expect((await kt.refresh()).state).toBe("ok");
    await server.append({ t: "acct", u: await ktUser("bob"), apk, ts: 3 });
    // A lookup whose head (size 3) the server will not prove consistent with ours: never used.
    expect(await kt.checkDevice(await server.lookup(u), apk, dpk)).toEqual({ status: "unverified" });
    // Reload: the owed proof is still there; the next refresh asks again — the second refusal is the alert.
    const reloaded = new KtClient("https://chat.example", new LocalKtStore(storage), get);
    const status = await reloaded.refresh();
    expect(status).toMatchObject({ state: "alert", alert: { kind: "unproven" } });
    // A server that gives the proof in time: no alert.
    refuse = false;
    const fresh = new KtClient("https://other.example", new LocalKtStore(memoryStorage()), get);
    await fresh.refresh();
    expect(await fresh.checkDevice(await server.lookup(u), apk, dpk)).toEqual({ status: "ok" });
    expect(fresh.current().state).toBe("ok");
  });
});

describe("REVIEW-612 P04 — the user's own entries in the key log (self-monitoring)", () => {
  it("reports a device certified for our account that we do not know, and another account key", async () => {
    const server = await ktServer();
    const u = await ktUser("alice");
    const apk = b64(new Uint8Array(32).fill(1));
    const mine = b64(new Uint8Array(91).fill(2));
    const planted = b64(new Uint8Array(91).fill(3));
    const expired = b64(new Uint8Array(91).fill(4));
    const revoked = b64(new Uint8Array(91).fill(5));
    await server.append({ t: "acct", u, apk, ts: 1 });
    await server.append({ t: "dev", u, apk, dpk: mine, exp: Date.now() + 86_400_000, ts: 2 });
    await server.append({ t: "dev", u, apk, dpk: planted, exp: Date.now() + 86_400_000, ts: 3 });
    await server.append({ t: "dev", u, apk, dpk: expired, exp: Date.now() - 1, ts: 4 });
    await server.append({ t: "dev", u, apk, dpk: revoked, exp: Date.now() + 86_400_000, ts: 5 });
    await server.append({ t: "rev", u, apk, dpk: revoked, ts: 6 });
    await server.append({ t: "acct", u: await ktUser("bob"), apk: b64(new Uint8Array(32).fill(9)), ts: 7 });
    const get = async (path: string): Promise<unknown> => {
      if (path === "/api/kt/key") return { key: server.key };
      if (path === "/api/kt/sth") return server.sth();
      if (path.startsWith("/api/kt/lookup?u=")) return server.lookup(decodeURIComponent(path.slice("/api/kt/lookup?u=".length)));
      const m = /from=(\d+)&to=(\d+)/.exec(path);
      if (m) return server.consistency(Number(m[1]), Number(m[2]));
      throw new Error(path);
    };
    const kt = new KtClient("https://chat.example", new LocalKtStore(memoryStorage()), get);
    await kt.refresh();
    const known = new Set([mine]);
    const own = await kt.checkOwn("alice", apk, (dpk) => known.has(dpk));
    expect(own.status).toBe("ok");
    expect(own.unknown.map((d) => d.dpk)).toEqual([planted]);
    expect(own.foreignAccount).toBeUndefined();
    // Acknowledged as ours: no longer reported.
    known.add(planted);
    expect((await kt.checkOwn("alice", apk, (dpk) => known.has(dpk))).unknown).toEqual([]);
    // The server put another account key for us in the log.
    const other = b64(new Uint8Array(32).fill(7));
    await server.append({ t: "acct", u, apk: other, ts: 8 });
    expect((await kt.checkOwn("alice", apk, (dpk) => known.has(dpk))).foreignAccount).toBe(other);
  });

  it("a lookup that does not verify, or a server without a log, is said as such", async () => {
    const off = new KtClient("https://old.example", new LocalKtStore(memoryStorage()), async () => { throw new KtHttpError(503); });
    await off.refresh();
    expect(await off.checkOwn("alice", "apk", () => false)).toEqual({ status: "off", unknown: [] });
    const server = await ktServer();
    await server.append({ t: "acct", u: await ktUser("alice"), apk: b64(new Uint8Array(32).fill(1)), ts: 1 });
    const lying = new KtClient("https://chat.example", new LocalKtStore(memoryStorage()), async (path) => {
      if (path === "/api/kt/key") return { key: server.key };
      if (path === "/api/kt/sth") return server.sth();
      if (path.startsWith("/api/kt/lookup")) return { ...(await server.lookup(await ktUser("alice"))), entries: [{ entry: { t: "acct", u: await ktUser("alice"), apk: b64(new Uint8Array(32).fill(8)), ts: 1 }, index: 0, proof: [] }] };
      throw new Error(path);
    });
    await lying.refresh();
    expect(await lying.checkOwn("alice", b64(new Uint8Array(32).fill(1)), () => false)).toEqual({ status: "unverified", unknown: [] });
  });
});

/* ------------------------------------------------- P4Room on a simulated channel */

type Frame = { from: string; to: string; text: string };

class Net {
  readonly queue: Frame[] = [];
  readonly rooms = new Map<string, P4Room>();
  readonly log: Frame[] = [];
  drop: ((f: Frame) => boolean) | null = null;
  /** The sender's channel refuses this frame (`send` returns false). */
  refuse: ((f: Frame) => boolean) | null = null;
  send(from: string, to: string, text: string): boolean {
    if (this.refuse?.({ from, to, text })) return false;
    const f = { from, to, text };
    this.queue.push(f);
    this.log.push(f);
    return true;
  }
  async drain(): Promise<void> {
    for (let i = 0; i < 10_000 && this.queue.length; i++) {
      const f = this.queue.shift()!;
      if (this.drop?.(f)) continue;
      await this.rooms.get(f.to)?.handle(f.from, JSON.parse(f.text) as Record<string, unknown>);
    }
  }
}

let roomKeys: RoomKeys;
beforeAll(async () => { roomKeys = await deriveRoomKeys("team", "correct horse", { memoryKiB: 64, passes: 1 }); });

async function device(): Promise<Identity> {
  const subtle = globalThis.crypto.subtle;
  const b64buf = (b: ArrayBuffer) => toBase64(new Uint8Array(b));
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

function p4room(net: Net, id: string, me: Identity, book = new TrustBook(null), events: P4Events = {}): P4Room {
  const r = new P4Room({
    keys: roomKeys, identity: me, selfId: () => id, send: (peerId, text) => net.send(id, peerId, text),
    helloExtra: () => ({ caps: ["bin", "media"], user: `${id}-user` }), local: () => ({ mb: null, acc: null, sth: null }), book, events,
  });
  net.rooms.set(id, r);
  return r;
}

describe("REVIEW-612 P13 — a chain counts as handed out only once its frame went", () => {
  it("a failed send hands the chain out again with the next room message", async () => {
    const net = new Net();
    const a = p4room(net, "p-a", await device());
    const b = p4room(net, "p-b", await device());
    // The ratchet frame with a's chain (sent as the session comes up) cannot go out.
    let refused = 0;
    net.refuse = (f) => f.from === "p-a" && (JSON.parse(f.text) as { kind?: string }).kind === "p4" && ++refused > 0;
    await Promise.all([a.open("p-b"), b.open("p-a")]);
    await net.drain();
    net.refuse = null;
    expect(refused).toBe(1);
    expect(a.isP4("p-b")).toBe(true);
    expect(a.sk.hasOurChain("p-b")).toBe(false);
    const sealed = await a.sealRoom("m1", { id: "m1", text: "hi" }, ["p-b"]);
    expect(sealed?.to).toEqual(["p-b"]);
    net.send("p-a", "p-b", JSON.stringify(sealed!.envelope));
    const got: string[] = [];
    for (const f of net.queue.splice(0)) {
      const raw = JSON.parse(f.text) as Record<string, unknown>;
      if (!(await net.rooms.get(f.to)!.handle(f.from, raw)) && f.to === "p-b") got.push((await b.openRoom<{ text: string }>(f.from, raw)).payload.text);
    }
    expect(got).toEqual(["hi"]);
  });

  it("the sender-key layer: chainFor alone does not mark the peer, handedOut does (unit)", async () => {
    const net = new Net();
    const a = p4room(net, "p-a", await device());
    await a.sk.prepare();
    const inner = a.sk.chainFor("p-z");
    expect(a.sk.hasOurChain("p-z")).toBe(false);
    a.sk.handedOut("p-z", inner.keyId);
    expect(a.sk.hasOurChain("p-z")).toBe(true);
  });
});

/* ------------------------------------------------------------ the vault (P11, P12) */

describe("REVIEW-612 P11/P12 — the device vault", () => {
  it("a read that keeps failing is reported (VaultUnavailable), replaces nothing, and is tried afresh later", async () => {
    const backend = memoryBackend();
    await new LocalVault(backend).putJson("row", { v: 1 });
    const wrap = await backend.get("wrap");
    let failing = true;
    const flaky: KvBackend = {
      persistent: true,
      get: async (id) => { if (failing) throw new Error("IDB transaction aborted"); return backend.get(id); },
      put: (id, v) => backend.put(id, v), delete: (id) => backend.delete(id), clear: () => backend.clear(),
      add: (id, v) => backend.add!(id, v),
    };
    const vault = new LocalVault(flaky);
    await expect(vault.getJson("row")).rejects.toBeInstanceOf(VaultUnavailable);
    await expect(vault.putJson("other", { v: 2 })).rejects.toBeInstanceOf(VaultUnavailable);
    expect(await backend.get("wrap")).toBe(wrap); // never replaced
    failing = false;
    expect(await vault.getJson("row")).toEqual({ v: 1 }); // the same instance recovers
  });

  it("a key that is really absent is created once, even by two tabs at the same moment", async () => {
    const backend = memoryBackend();
    const [a, b] = [new LocalVault(backend), new LocalVault(backend)];
    await Promise.all([a.putJson("x", 1), b.putJson("y", 2)]);
    expect(await new LocalVault(backend).getJson("x")).toBe(1);
    expect(await new LocalVault(backend).getJson("y")).toBe(2);
  });

  it("bundles: one row each — a removal in one tab and a new bundle in another both hold; the 6.12 list row is migrated", async () => {
    const backend = memoryBackend();
    const dev = await device();
    const k1 = await createBundle(dev);
    const k2 = await createBundle(dev);
    // A 6.12 single-list row, as the first 6.12 build wrote it.
    const vault = new LocalVault(backend);
    await vault.putRaw(`mailbox:dh:${k1.bundle.id}`, k1.dh);
    await vault.putJson("mailbox", [{ bundle: k1.bundle, kemDk: toBase64(k1.kemDk), created: k1.created }]);
    const tab1 = new VaultBundleStore(new LocalVault(backend));
    const tab2 = new VaultBundleStore(new LocalVault(backend));
    expect((await tab1.all()).map((k) => k.bundle.id)).toEqual([k1.bundle.id]);
    expect(await backend.get("mailbox")).toBeUndefined();
    await tab2.put(k2);
    expect((await tab1.all()).map((k) => k.bundle.id).sort()).toEqual([k1.bundle.id, k2.bundle.id].sort()); // seen by the other tab
    await tab1.remove(k1.bundle.id);
    expect((await tab2.all()).map((k) => k.bundle.id)).toEqual([k2.bundle.id]);
    // The keys still open what was sealed to them.
    const reopened = (await new VaultBundleStore(new LocalVault(backend)).all())[0];
    expect(toBase64(reopened.kemDk)).toBe(toBase64(k2.kemDk));
  });

  it("replay window: two tabs' writes merge; an id one tab accepted is a replay in the other after its flush", async () => {
    const backend = memoryBackend();
    // Writes only when flushed here (no timer in between).
    const tab1 = new VaultReplayStore(new LocalVault(backend), 3_600_000);
    const tab2 = new VaultReplayStore(new LocalVault(backend), 3_600_000);
    const g1 = new ReplayGuard(tab1);
    const g2 = new ReplayGuard(tab2);
    const now = Date.now();
    expect(await g1.check(roomKeys.roomId, "m-1", now)).toBe("ok");
    expect(await g2.check(roomKeys.roomId, "m-2", now)).toBe("ok");
    await tab2.flush();
    await tab1.flush(); // merges: m-2 of the other tab is kept (and learned here)
    const reload = new ReplayGuard(new VaultReplayStore(new LocalVault(backend), 0));
    expect(await reload.check(roomKeys.roomId, "m-1", now)).toBe("replay");
    expect(await reload.check(roomKeys.roomId, "m-2", now)).toBe("replay");
    expect(await g1.check(roomKeys.roomId, "m-2", now)).toBe("replay");
    tab1.close();
    tab2.close();
  });

  it("replay window shared between tabs (BroadcastChannel): an id one tab accepts is a replay in the other at once", async () => {
    const backend = memoryBackend();
    const tab1 = new VaultReplayStore(new LocalVault(backend), 60_000, { share: true });
    const tab2 = new VaultReplayStore(new LocalVault(backend), 60_000, { share: true });
    const g1 = new ReplayGuard(tab1);
    const g2 = new ReplayGuard(tab2);
    const now = Date.now();
    expect(await g2.check(roomKeys.roomId, "m-0", now)).toBe("ok"); // tab 2 has the room loaded
    expect(await g1.check(roomKeys.roomId, "m-shared", now)).toBe("ok");
    await new Promise((r) => setTimeout(r, 50));
    expect(await g2.check(roomKeys.roomId, "m-shared", now)).toBe("replay");
    tab1.close();
    tab2.close();
  });

  it("replay window: a store that cannot be read is not taken as empty (the check throws; the app fails closed)", async () => {
    const flaky: KvBackend = { persistent: true, get: async () => { throw new Error("quota"); }, put: async () => undefined, delete: async () => undefined, clear: async () => undefined };
    const guard = new ReplayGuard(new VaultReplayStore(new LocalVault(flaky), 0));
    await expect(guard.check(roomKeys.roomId, "m-x", Date.now())).rejects.toBeInstanceOf(VaultUnavailable);
  });
});

/* ------------------------------------------------------------ P01: whom away messages are sealed to */

const DAY = 24 * 60 * 60 * 1000;

/** A device certified (v2) by an account, with its mailbox — as the hello's `acc` and the directory list it. */
async function attested(accountSeed: number, now = Date.now()) {
  const account = await ed25519FromSeed(new Uint8Array(32).fill(accountSeed));
  const apk = b64(account.publicKey);
  const dev = await device();
  const mailbox = new Mailbox(new MemoryBundleStore(), dev);
  const cert = await certifyDeviceV2(account.privateKey, dev.publicKey, now + DEVICE_CERT_LIFETIME_MS, now);
  const bundle = (await mailbox.current(now)).bundle;
  return { dev, apk, mailbox, acc: { apk, ac: cert.sig, cv: 2 as const, exp: cert.exp }, directory: { pk: dev.publicKey, apk, cert, bundle } as DirectoryDevice, bundle };
}

describe("REVIEW-612 P01 — away members: only devices this client authenticated", () => {
  it("the account pin outlives the bundles: a week later Bob's NEW device (his account) is sealed to, the server's is not", async () => {
    const now = Date.now();
    const seen = now - 8 * DAY;
    const bob = await attested(0x0b, seen);
    const book = new TrustBook(null);
    // A live session with Bob 8 days ago: a valid hello with his account.
    book.rememberDevice(bob.dev.publicKey, { mb: bob.bundle, apk: bob.apk, acc: bob.acc, hello: true }, seen);
    expect(book.pinAccount(roomKeys.roomId, "ref-bob", bob.apk, seen)).toBe("new");
    expect(book.rememberRef(roomKeys.roomId, "ref-bob", bob.dev.publicKey, seen)).toBe(true);
    // His bundle has expired; the pin has not.
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-bob", now)).toEqual([]);
    expect(book.accountOf(roomKeys.roomId, "ref-bob")).toBe(bob.apk);
    const bobNew = await attested(0x0b, now); // a new device of Bob's account (the directory)
    const server = await attested(0x5e, now); // the server's own account
    const alice = await device();
    const sealed = await sealForAway({
      roomId: roomKeys.roomId, id: "a1", payload: { id: "a1", text: "for Bob" }, refs: ["ref-bob"], mailbox: new Mailbox(new MemoryBundleStore(), alice), senderPk: alice.publicKey, now,
      known: (ref) => book.sealableDevicesOfRef(roomKeys.roomId, ref, now),
      directory: async () => [server.directory, bobNew.directory],
      pinnedAccount: (ref) => book.accountOf(roomKeys.roomId, ref),
    });
    const item = sealed.per["ref-bob"] as MailboxItem;
    expect(isMailboxItem(item)).toBe(true);
    expect(await server.mailbox.open(item, roomKeys.roomId, now)).toBeNull();
    expect((await bobNew.mailbox.open<{ text: string }>(item, roomKeys.roomId, now))?.payload.text).toBe("for Bob");
    expect(sealed.sealing).toEqual([{ ref: "ref-bob", form: "mailbox", devices: 1, account: bob.apk }]);
  });

  it("a device the server puts behind a member's reference is refused; one seen only in a relayed item is never sealed to", async () => {
    const now = Date.now();
    const bob = await attested(0x0b, now);
    const planted = await attested(0x5e, now);
    const book = new TrustBook(null);
    book.rememberDevice(bob.dev.publicKey, { mb: bob.bundle, apk: bob.apk, acc: bob.acc, hello: true }, now);
    book.pinAccount(roomKeys.roomId, "ref-bob", bob.apk, now);
    book.rememberRef(roomKeys.roomId, "ref-bob", bob.dev.publicKey, now);
    // A device of another account, seen in a live hello under Bob's reference (the hub mislabels a peer): refused.
    book.rememberDevice(planted.dev.publicKey, { mb: planted.bundle, apk: planted.apk, acc: planted.acc, hello: true }, now);
    expect(book.rememberRef(roomKeys.roomId, "ref-bob", planted.dev.publicKey, now)).toBe(false);
    expect(book.pinAccount(roomKeys.roomId, "ref-bob", planted.apk, now)).toBe("conflict");
    expect(book.accountOf(roomKeys.roomId, "ref-bob")).toBe(bob.apk);
    // A device without an account, learned from a relayed item only (no hello): not sealable even behind an unpinned reference.
    const stranger = await device();
    const strangerMb = new Mailbox(new MemoryBundleStore(), stranger);
    book.rememberDevice(stranger.publicKey, { mb: (await strangerMb.current(now)).bundle }, now);
    expect(book.rememberRef(roomKeys.roomId, "ref-carol", stranger.publicKey, now)).toBe(true);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-carol", now)).toEqual([]);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-bob", now).map((d) => d.pk)).toEqual([bob.dev.publicKey]);
  });

  it("a member without an account: its device seen in a hello is sealed to; that device cannot be moved to another reference", async () => {
    const now = Date.now();
    const dana = await device();
    const danaMb = new Mailbox(new MemoryBundleStore(), dana);
    const book = new TrustBook(null);
    book.rememberDevice(dana.publicKey, { mb: (await danaMb.current(now)).bundle, hello: true }, now);
    expect(book.rememberRef(roomKeys.roomId, "ref-dana", dana.publicKey, now)).toBe(true);
    expect(book.rememberRef(roomKeys.roomId, "ref-eve", dana.publicKey, now)).toBe(false);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-dana", now).map((d) => d.pk)).toEqual([dana.publicKey]);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-eve", now)).toEqual([]);
  });

  it("a pinned member's device whose v2 certificate expired, or that key transparency revoked, is not sealed to", async () => {
    const now = Date.now();
    const bob = await attested(0x0b, now);
    const book = new TrustBook(null);
    book.rememberDevice(bob.dev.publicKey, { mb: bob.bundle, apk: bob.apk, acc: { ...bob.acc, exp: now - 1 }, hello: true }, now);
    book.pinAccount(roomKeys.roomId, "ref-bob", bob.apk, now);
    book.rememberRef(roomKeys.roomId, "ref-bob", bob.dev.publicKey, now);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-bob", now)).toEqual([]);
    book.rememberDevice(bob.dev.publicKey, { acc: bob.acc, apk: bob.apk, hello: true }, now);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-bob", now)).toHaveLength(1);
    book.markRevoked(bob.dev.publicKey, now);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-bob", now)).toEqual([]);
  });

  it("accepting a changed key re-pins the member's account; old devices of the old account no longer count", async () => {
    const now = Date.now();
    const old = await attested(0x01, now);
    const fresh = await attested(0x02, now);
    const book = new TrustBook(null);
    book.rememberDevice(old.dev.publicKey, { mb: old.bundle, apk: old.apk, acc: old.acc, hello: true }, now);
    book.pinAccount(roomKeys.roomId, "ref-x", old.apk, now);
    book.rememberRef(roomKeys.roomId, "ref-x", old.dev.publicKey, now);
    book.repinAccount(roomKeys.roomId, "ref-x", fresh.apk, now);
    expect(book.accountOf(roomKeys.roomId, "ref-x")).toBe(fresh.apk);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-x", now)).toEqual([]);
    book.rememberDevice(fresh.dev.publicKey, { mb: fresh.bundle, apk: fresh.apk, acc: fresh.acc, hello: true }, now);
    expect(book.rememberRef(roomKeys.roomId, "ref-x", fresh.dev.publicKey, now)).toBe(true);
    expect(book.sealableDevicesOfRef(roomKeys.roomId, "ref-x", now).map((d) => d.pk)).toEqual([fresh.dev.publicKey]);
  });

  it("account pins survive the book's trimming before plain device rows do", async () => {
    const book = new TrustBook(null);
    book.pinAccount(roomKeys.roomId, "ref-keep", b64(new Uint8Array(32).fill(3)), 1);
    for (let i = 0; i < 520; i++) book.rememberRef(roomKeys.roomId, `ref-${i}`, `pk-${i}`, 10 + i);
    expect(book.accountOf(roomKeys.roomId, "ref-keep")).toBe(b64(new Uint8Array(32).fill(3)));
  });
});

/* ------------------------------------------------------------ P03: no room key for a protocol-4 device */

describe("REVIEW-612 P03 — the room-key fallback", () => {
  const kind = (f: Frame) => (JSON.parse(f.text) as { kind?: string }).kind;

  it("the downgrade marker is set when a valid hello v4 is accepted, before the session; the peer is 'p4-pending', never room-key eligible", async () => {
    const net = new Net();
    const book = new TrustBook(null);
    const a = p4room(net, "p-a", await device(), book);
    const bId = await device();
    p4room(net, "p-b", bId);
    net.drop = (f) => f.from === "p-b" && kind(f) === "p4-kem"; // the KEM answer is withheld
    expect(a.mayUseRoomKey("p-b")).toBe(true); // nothing known yet
    await Promise.all([a.open("p-b"), net.rooms.get("p-b")!.open("p-a")]);
    await net.drain();
    expect(book.p4Seen(bId.publicKey)).toBe(true);
    expect(a.protocolOf("p-b")).toBe("p4-pending");
    expect(a.mayUseRoomKey("p-b")).toBe(false);
    expect(a.negotiating("p-b")).toBe(true);
    // `session: true` waits it out (bounded): still p4-pending, so the app holds the message.
    expect(await a.settled("p-b", 30, { session: true })).toBe("p4-pending");
    // The channel closes and a new one opens: still known as a protocol-4 device (this page saw its key).
    a.channelClosed("p-b");
    expect(a.protocolOf("p-b")).toBe("pending");
    expect(a.mayUseRoomKey("p-b")).toBe(false);
  });

  it("settled({session}) resolves at once when the session comes up", async () => {
    const net = new Net();
    const a = p4room(net, "p-a", await device());
    const b = p4room(net, "p-b", await device());
    const waiting = a.settled("p-b", 5_000, { session: true });
    await Promise.all([a.open("p-b"), b.open("p-a")]);
    await net.drain();
    expect(await waiting).toBe(4);
    expect(a.mayUseRoomKey("p-b")).toBe(false);
  });

  it("a protocol-3 peer (6.11) stays room-key eligible; a refused downgrade is not", async () => {
    const net = new Net();
    const book = new TrustBook(null);
    const a = p4room(net, "p-a", await device(), book);
    const old = new P4Room({
      keys: roomKeys, identity: await device(), selfId: () => "p-old", send: (peerId, text) => net.send("p-old", peerId, text),
      helloExtra: () => ({ caps: [] }), local: () => ({ mb: null, acc: null, sth: null }), book: new TrustBook(null), disableP4: true,
    });
    net.rooms.set("p-old", old);
    await Promise.all([a.open("p-old"), old.open("p-a")]);
    await net.drain();
    expect(a.protocolOf("p-old")).toBe(3);
    expect(a.mayUseRoomKey("p-old")).toBe(true);
    // The same device key once spoke protocol 4 (another room, another day): a protocol-3 hello is a downgrade.
    const dev = await device();
    book.markP4(dev.publicKey);
    const down = new P4Room({
      keys: roomKeys, identity: dev, selfId: () => "p-down", send: (peerId, text) => net.send("p-down", peerId, text),
      helloExtra: () => ({ caps: [] }), local: () => ({ mb: null, acc: null, sth: null }), book: new TrustBook(null), disableP4: true,
    });
    net.rooms.set("p-down", down);
    await Promise.all([a.open("p-down"), down.open("p-a")]);
    await net.drain();
    expect(a.protocolOf("p-down")).toBe("refused");
    expect(a.mayUseRoomKey("p-down")).toBe(false);
  });

  it("the outbox waits per peer: a held peer gets it once its session is up, the others are not sent it twice", async () => {
    const ready = new Set<string>(["p-b"]);
    const got: Record<string, number> = {};
    const outbox = createOutbox<string>(perPeerSender(async (_entry, targets, only) => {
      const peers = targets ? [...targets] : ["p-b", "p-c"];
      const to = peers.filter((p) => ready.has(p));
      for (const p of to) got[p] = (got[p] ?? 0) + 1;
      expect(only).toBe(Boolean(targets) && _entry.only === true);
      return { to, held: peers.filter((p) => !ready.has(p)) };
    }));
    outbox.add({ messageId: "m1", room: "r", envelope: "x", targets: [], toNames: [], createdAt: Date.now(), expiresAt: 0 });
    await outbox.flush();
    expect(outbox.list()[0]).toMatchObject({ targets: ["p-c"], only: true });
    await outbox.flush(); // p-c still not ready: nothing new, nobody twice
    expect(got).toEqual({ "p-b": 1 });
    ready.add("p-c");
    const done = await outbox.flush();
    expect(done.delivered).toBe(1);
    expect(outbox.size()).toBe(0);
    expect(got).toEqual({ "p-b": 1, "p-c": 1 });
    // A private message for two: whoever is ready gets it; it waits for the other.
    ready.delete("p-c");
    outbox.add({ messageId: "m2", room: "r", envelope: "x", targets: ["p-b", "p-c"], toNames: [], createdAt: Date.now(), expiresAt: 0 });
    await outbox.flush();
    expect(outbox.list()[0].targets).toEqual(["p-c"]);
  });
});
