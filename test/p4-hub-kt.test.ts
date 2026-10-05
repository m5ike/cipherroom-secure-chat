import { describe, expect, it } from "vitest";
import {
  b64, b64url, buildHubProof, canonicalEntry, consistencyProof, deviceStatus, ed25519FromSeed, entryLeafHash, hubKeyPair, hubSeed,
  inclusionProof, KtState, ktUser, LABEL, MemoryKtStore, signSth, treeHash, verifyHubProof, verifyLookup, verifySth,
  type Hash, type KtEntry, type KtLookup, type SignedTreeHead,
} from "../client/src/lib/p4";
import { deriveRoomKeys } from "../client/src/lib/envelope";
import { ROOM } from "./p4-support";

const NONCE = b64url(new Uint8Array(24).map((_, i) => i * 7));

describe("p4 hub join proof (§ 13)", () => {
  it("derives the same key from the same seed and verifies a proof for the room and nonce only", async () => {
    const seed = new Uint8Array(32).fill(0x42);
    expect((await hubKeyPair(seed)).pub).toBe((await hubKeyPair(seed.slice())).pub);
    expect((await hubKeyPair(new Uint8Array(32).fill(0x43))).pub).not.toBe((await hubKeyPair(seed)).pub);
    const proof = await buildHubProof(seed, ROOM, NONCE);
    expect(proof).toEqual(await buildHubProof(seed, ROOM, NONCE)); // Ed25519 is deterministic
    expect(await verifyHubProof(proof.pub, proof.sig, ROOM, NONCE)).toBe(true);
    const other = b64url(new Uint8Array(24).fill(1));
    expect(await verifyHubProof(proof.pub, proof.sig, ROOM, other)).toBe(false);
    expect(await verifyHubProof(proof.pub, proof.sig, "r3.other", NONCE)).toBe(false);
    const stranger = await buildHubProof(new Uint8Array(32).fill(9), ROOM, NONCE);
    expect(await verifyHubProof(proof.pub, stranger.sig, ROOM, NONCE)).toBe(false);
    for (const bad of [[1, proof.sig, ROOM, NONCE], [proof.pub, "x", ROOM, NONCE], [proof.pub, proof.sig, ROOM, "short"], [proof.pub, proof.sig, "a|b", NONCE]] as const) {
      expect(await verifyHubProof(...bad)).toBe(false);
    }
  });

  it("takes its seed from the room keys", async () => {
    const keys = await deriveRoomKeys("team", "correct horse", { iterations: 1000 });
    const seed = await hubSeed(keys);
    expect(b64(seed)).toBe(b64(await keys.derive(LABEL.hubSeed, 256)));
    const again = await deriveRoomKeys("team", "correct horse", { iterations: 1000 });
    expect((await hubKeyPair(await hubSeed(again))).pub).toBe((await hubKeyPair(seed)).pub);
  });
});

/* -------------------------------------------------------------------- KT */

const KT_SEED = new Uint8Array(32).fill(0x17);

async function ktServer() {
  const { privateKey, publicKey } = await ed25519FromSeed(KT_SEED);
  const entries: KtEntry[] = [];
  const leaves: Hash[] = [];
  let ts = 1_700_000_000_000;
  return {
    key: b64(publicKey),
    async append(e: KtEntry) { entries.push(e); leaves.push(await entryLeafHash(e)); },
    async sth(size = leaves.length): Promise<SignedTreeHead> { return signSth(privateKey, size, await treeHash(leaves, 0, size), ts++); },
    /** A size it never had: the best the server can do is a proof that fails. */
    async consistency(from: number, to: number) { return { from, to, proof: to > leaves.length ? [] : (await consistencyProof(leaves, from, to)).map(b64) }; },
    async lookup(u: string, size = leaves.length): Promise<KtLookup> {
      const sth = await this.sth(size);
      const found = [];
      for (let i = 0; i < size; i++) if (entries[i].u === u) found.push({ entry: entries[i], index: i, proof: (await inclusionProof(leaves, i, size)).map(b64) });
      return { sth, entries: found };
    },
    leaves,
    privateKey,
  };
}

const APK = b64(new Uint8Array(32).fill(1));
const DPK = b64(new Uint8Array(91).fill(2));

describe("p4 key transparency (§ 14)", () => {
  it("writes entries canonically (KtEntry key order, no spaces) whatever the input order", async () => {
    const u = await ktUser("alice");
    expect(u).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const reordered = { ts: 5, dpk: DPK, exp: 9, apk: APK, u, t: "dev" } as unknown as KtEntry;
    expect(canonicalEntry(reordered)).toBe(`{"t":"dev","u":"${u}","apk":"${APK}","dpk":"${DPK}","exp":9,"ts":5}`);
    expect(canonicalEntry({ t: "acct", u, apk: APK, ts: 1 })).toBe(`{"t":"acct","u":"${u}","apk":"${APK}","ts":1}`);
    expect(() => canonicalEntry({ t: "acct", u: "a\"b", apk: APK, ts: 1 })).toThrow();
    expect(() => canonicalEntry({ t: "acct", u, apk: APK, ts: -1 })).toThrow();
    expect(() => canonicalEntry({ t: "nope" } as unknown as KtEntry)).toThrow();
  });

  it("verifies signed tree heads with the pinned key", async () => {
    const server = await ktServer();
    await server.append({ t: "acct", u: await ktUser("a"), apk: APK, ts: 1 });
    const sth = await server.sth();
    expect(await verifySth(sth, server.key)).toBe(true);
    expect(await verifySth({ ...sth, size: 2 }, server.key)).toBe(false);
    expect(await verifySth({ ...sth, ts: sth.ts + 1 }, server.key)).toBe(false);
    expect(await verifySth(sth, b64(new Uint8Array(32)))).toBe(false);
  });

  it("keeps the newest consistent head and raises a persistent alert on a rewritten history", async () => {
    const server = await ktServer();
    const store = new MemoryKtStore();
    const kt = new KtState(store);
    expect(await kt.pinKey("https://chat", server.key)).toBe("new");
    expect(await kt.pinKey("https://chat", server.key)).toBe("match");
    for (let i = 0; i < 3; i++) await server.append({ t: "acct", u: await ktUser(`u${i}`), apk: APK, ts: i });
    const fetch = (from: number, to: number) => server.consistency(from, to);
    expect((await kt.update("https://chat", await server.sth(), fetch)).status).toBe("ok");
    for (let i = 3; i < 7; i++) await server.append({ t: "acct", u: await ktUser(`u${i}`), apk: APK, ts: i });
    const s7 = await server.sth();
    expect((await kt.update("https://chat", s7, fetch)).status).toBe("ok");
    expect((await kt.newest("https://chat"))?.size).toBe(7);
    // An older head that is a prefix: fine, the newest stays.
    expect((await kt.update("https://chat", await server.sth(5), fetch)).status).toBe("ok");
    expect((await kt.newest("https://chat"))?.size).toBe(7);
    // The server rewrites entry 2 and grows: inconsistent.
    server.leaves[2] = await entryLeafHash({ t: "acct", u: await ktUser("u2"), apk: b64(new Uint8Array(32).fill(9)), ts: 2 });
    await server.append({ t: "acct", u: await ktUser("u7"), apk: APK, ts: 7 });
    const forged = await server.sth();
    const res = await kt.update("https://chat", forged, fetch);
    expect(res.status).toBe("inconsistent");
    expect((await kt.alert("https://chat"))?.kind).toBe("inconsistent");
    expect((await new KtState(store).alert("https://chat"))?.kind).toBe("inconsistent"); // persistent
    expect((await kt.newest("https://chat"))?.size).toBe(7);
    // Same size, another root: inconsistent as well.
    const kt2 = new KtState();
    await kt2.pinKey("o", server.key);
    await kt2.update("o", s7, fetch);
    expect((await kt2.update("o", await server.sth(7), fetch)).status).toBe("inconsistent");
    // A head not signed by the pinned key is ignored, not adopted.
    const kt3 = new KtState();
    await kt3.pinKey("o", b64(new Uint8Array(32).fill(3)));
    expect((await kt3.update("o", s7, fetch)).status).toBe("bad-signature");
    expect(await kt3.pinKey("o", server.key)).toBe("changed");
    expect((await kt3.alert("o"))?.kind).toBe("key-changed");
  });

  it("compares a peer's head (gossip): ok, need consistency, split view", async () => {
    const server = await ktServer();
    for (let i = 0; i < 6; i++) await server.append({ t: "acct", u: await ktUser(`u${i}`), apk: APK, ts: i });
    const fetch = (from: number, to: number) => server.consistency(from, to);
    const kt = new KtState();
    await kt.pinKey("o", server.key);
    await kt.update("o", await server.sth(4), fetch);
    expect((await kt.gossip("o", await server.sth(4))).status).toBe("ok");
    const peer6 = await server.sth(6);
    expect(await kt.gossip("o", peer6)).toEqual({ status: "need-consistency", from: 4, to: 6 });
    expect((await kt.resolveGossip("o", peer6, fetch)).status).toBe("ok");
    expect((await kt.newest("o"))?.size).toBe(6);
    // A split view: the server showed the peer another tree of the same size.
    const { privateKey } = await ed25519FromSeed(KT_SEED);
    const fake = await signSth(privateKey, 6, new Uint8Array(32).fill(5), 1);
    expect((await kt.gossip("o", fake)).status).toBe("split-view");
    const kt2 = new KtState();
    await kt2.pinKey("o", server.key);
    await kt2.update("o", await server.sth(4), fetch);
    const fake8 = await signSth(privateKey, 8, new Uint8Array(32).fill(5), 1);
    expect((await kt2.resolveGossip("o", fake8, fetch)).status).toBe("split-view");
    expect((await kt2.alert("o"))?.kind).toBe("split-view");
    expect((await kt2.gossip("o", { ...fake8, sig: b64(new Uint8Array(64)) })).status).toBe("ignored");
    expect((await new KtState().gossip("o", fake8)).status).toBe("unknown");
  });

  it("checks lookups: inclusion of every entry, the user, and what they say about a device", async () => {
    const server = await ktServer();
    const alice = await ktUser("alice");
    const bob = await ktUser("bob");
    const now = 1_800_000_000_000;
    await server.append({ t: "acct", u: alice, apk: APK, ts: 1 });
    await server.append({ t: "acct", u: bob, apk: APK, ts: 2 });
    await server.append({ t: "dev", u: alice, apk: APK, dpk: DPK, exp: now + 1000, ts: 3 });
    const lookup = await server.lookup(alice);
    const ok = await verifyLookup(lookup, server.key, alice);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.entries.map((e) => e.index)).toEqual([0, 2]);
    expect(deviceStatus(ok.entries, APK, DPK, now)).toEqual({ account: true, device: true, revoked: false, ok: true });
    expect(deviceStatus(ok.entries, APK, DPK, now + 1000).device).toBe(false);
    expect((await verifyLookup(lookup, server.key, bob))).toEqual({ ok: false, why: "wrong-user" });
    const moved = { ...lookup, entries: [{ ...lookup.entries[1], index: 1 }] };
    expect(await verifyLookup(moved, server.key, alice)).toEqual({ ok: false, why: "not-included" });
    // Revoked after certification; certified again after that.
    await server.append({ t: "rev", u: alice, apk: APK, dpk: DPK, ts: 4 });
    const revoked = await verifyLookup(await server.lookup(alice), server.key, alice);
    expect(revoked.ok && deviceStatus(revoked.entries, APK, DPK, now).revoked).toBe(true);
    await server.append({ t: "dev", u: alice, apk: APK, dpk: DPK, exp: now + 5000, ts: 5 });
    const again = await verifyLookup(await server.lookup(alice), server.key, alice);
    expect(again.ok && deviceStatus(again.entries, APK, DPK, now).ok).toBe(true);
    // The account key changed: the old one is no longer current.
    await server.append({ t: "acct", u: alice, apk: b64(new Uint8Array(32).fill(8)), ts: 6 });
    const changed = await verifyLookup(await server.lookup(alice), server.key, alice);
    expect(changed.ok && deviceStatus(changed.entries, APK, DPK, now).account).toBe(false);
    // Through the state: the head is checked for consistency first.
    const kt = new KtState();
    await kt.pinKey("o", server.key);
    expect((await kt.lookup("o", await server.lookup(alice), alice, (f, t) => server.consistency(f, t))).ok).toBe(true);
  });
});
