// Tests for the fixes of the 6.12 security review's protocol-4 client findings
// (docs/review-612.md P01–P14, S14 client side). The PoCs themselves are in
// test/review-612-p4.test.ts (un-skipped as fixed); these cover the rest of
// each fix: the paths around the PoC, the honest states, and that nothing a
// legitimate member does stops working.

import { beforeAll, describe, expect, it } from "vitest";
import {
  b64, consistencyProof, ed25519FromSeed, entryLeafHash, inclusionProof, ktUser, KT_PROOF_DEADLINE_MS, KtState, MemoryKtStore,
  signSth, treeHash, type Hash, type KtEntry, type KtLookup, type SignedTreeHead,
} from "../client/src/lib/p4";
import { KtClient, KtHttpError } from "../client/src/lib/p4-kt";
import { LocalKtStore } from "../client/src/lib/p4-store";
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
