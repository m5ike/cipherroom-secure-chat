// @vitest-environment node
//
// 6.12 — key transparency (protocol 4, § 14) on the server: the cached Merkle
// tree against the shared client code (client/src/lib/p4/merkle.ts — the same
// roots and proofs, verified with its verifyInclusion / verifyConsistency),
// the append-only log in SQLite with canonical entries and signed tree heads,
// the /api/kt routes and their input checks, and failing CLOSED on a corrupt
// store or a changed key — never rebuilding. Plus the scale it is built for.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes, verify as edVerify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDriver, openPlainDatabase, type SqliteDatabase } from "../server/storage/db";
import { MerkleTree, leafHashOf } from "../server/kt/tree";
import { KtLog, KtUnavailableError, canonicalEntry, ed25519PublicKey, ktSignerFromSeed, parseEntry, sthMessage, KT_LIMITS } from "../server/kt/log";
import { KtService, ktUser } from "../server/kt/service";
import { registerKtRoutes } from "../server/kt/routes";
import { AccountStore, usernameOf } from "../server/accounts/store";
import type { StoredCredential } from "../server/accounts/webauthn";
import { consistencyProof, inclusionProof, leafHash, treeHash, verifyConsistency, verifyInclusion, type Hash } from "../client/src/lib/p4/merkle";
import type { KtConsistency, KtEntry, KtLookup, SignedTreeHead } from "../client/src/lib/p4/contract";

const u8 = (b: Uint8Array): Uint8Array => new Uint8Array(b);
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/* ---------------------------------------------------------------- tree */

describe("the cached Merkle tree matches merkle.ts", () => {
  const leavesFor = async (n: number) => {
    const out: Hash[] = [];
    for (let i = 0; i < n; i += 1) out.push(await leafHash(`leaf ${i}`));
    return out;
  };

  it("leaf hashes, roots, inclusion and consistency proofs for every size up to 40", async () => {
    const leaves = await leavesFor(40);
    const tree = new MerkleTree();
    expect(hex(tree.root(0))).toBe(hex(await treeHash([])));
    for (let i = 0; i < leaves.length; i += 1) {
      expect(hex(leafHashOf(`leaf ${i}`))).toBe(hex(leaves[i]));
      tree.push(leafHashOf(`leaf ${i}`));
    }
    for (let size = 1; size <= 40; size += 1) {
      const root = await treeHash(leaves, 0, size);
      expect(hex(tree.root(size))).toBe(hex(root));
      for (let index = 0; index < size; index += 1) {
        const mine = tree.inclusion(index, size);
        expect(mine.map(hex)).toEqual((await inclusionProof(leaves, index, size)).map(hex));
        expect(await verifyInclusion(leaves[index], index, size, mine.map(u8), root)).toBe(true);
      }
      for (let first = 0; first <= size; first += 1) {
        const mine = tree.consistency(first, size);
        expect(mine.map(hex)).toEqual((await consistencyProof(leaves, first, size)).map(hex));
        expect(await verifyConsistency(first, size, await treeHash(leaves, 0, first), root, mine.map(u8))).toBe(true);
      }
    }
  });

  it("refuses indexes and sizes outside the tree", () => {
    const tree = new MerkleTree();
    tree.push(leafHashOf("a"));
    expect(() => tree.root(2)).toThrow(RangeError);
    expect(() => tree.inclusion(1, 1)).toThrow(RangeError);
    expect(() => tree.consistency(2, 1)).toThrow(RangeError);
    expect(() => tree.push(Buffer.alloc(31))).toThrow(RangeError);
  });

  it("scales: 100 000 leaves, then roots and proofs from the cache", async () => {
    const tree = new MerkleTree();
    const started = Date.now();
    for (let i = 0; i < 100_000; i += 1) tree.push(leafHashOf(`entry ${i}`));
    const root = tree.root();
    const sample = [0, 1, 4_095, 65_536, 99_998, 99_999];
    for (const index of sample) {
      expect(await verifyInclusion(leafHashOf(`entry ${index}`), index, 100_000, tree.inclusion(index).map(u8), root)).toBe(true);
    }
    expect(await verifyConsistency(77_777, 100_000, tree.root(77_777), root, tree.consistency(77_777).map(u8))).toBe(true);
    for (let i = 0; i < 2_000; i += 1) tree.inclusion((i * 7919) % 100_000);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

/* ----------------------------------------------------------------- log */

describe("the key transparency log", () => {
  let dir = "";
  let file = "";
  let db: SqliteDatabase;
  const seed = randomBytes(32);
  const signer = () => ktSignerFromSeed(seed);

  beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m5cet-kt-"));
    file = join(dir, "m5cet.db");
    db = openPlainDatabase(file, []);
  });
  afterEach(() => {
    try { db.close(); } catch { /* closed by the test */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const alice = ktUser("alice-0001");
  const bob = ktUser("bob-0000002");
  const apk = Buffer.alloc(32, 1).toString("base64");
  const dpk = Buffer.alloc(91, 2).toString("base64");
  const fill = (log: KtLog) => {
    log.append({ t: "acct", u: alice, apk, ts: 1000 });
    log.append({ t: "dev", u: alice, apk, dpk, exp: 9_000, ts: 1001 });
    log.append({ t: "acct", u: bob, apk, ts: 1002 });
    log.append({ t: "rev", u: alice, apk, dpk, ts: 1003 });
  };
  const verifySth = (sth: SignedTreeHead, key: string) =>
    edVerify(null, sthMessage(sth.size, sth.root, sth.ts), ed25519PublicKey(Buffer.from(key, "base64")), Buffer.from(sth.sig, "base64"));

  it("names users by u = b64url(SHA-256(\"m5cet/kt/user|\" + username)) and writes canonical entries (KtEntry's key order, no spaces)", () => {
    expect(ktUser("alice")).toBe(createHash("sha256").update("m5cet/kt/user|alice").digest("base64url"));
    expect(canonicalEntry({ ts: 5, apk: "A", u: "U", t: "acct" } as KtEntry)).toBe('{"t":"acct","u":"U","apk":"A","ts":5}');
    expect(canonicalEntry({ exp: 7, dpk: "D", ts: 5, apk: "A", u: "U", t: "dev" } as KtEntry)).toBe('{"t":"dev","u":"U","apk":"A","dpk":"D","exp":7,"ts":5}');
    expect(canonicalEntry({ t: "rev", u: "U", apk: "A", dpk: "D", ts: 5 })).toBe('{"t":"rev","u":"U","apk":"A","dpk":"D","ts":5}');
    expect(parseEntry({ t: "other", u: "U", apk: "A", ts: 1 })).toBeNull();
    expect(parseEntry({ t: "dev", u: "U", apk: "A", dpk: "D", ts: 1 })).toBeNull();
  });

  it("appends, signs heads, proves every entry of a user and the log's growth — all checked with merkle.ts", async () => {
    const log = new KtLog(db, signer());
    const empty = await log.sth();
    expect(empty).toMatchObject({ size: 0 });
    expect(verifySth(empty, log.key())).toBe(true);
    fill(log);
    const sth = await log.sth();
    expect(sth.size).toBe(4);
    expect(verifySth(sth, log.key())).toBe(true);

    const lookup = await log.lookup(alice);
    expect(lookup.entries.map((e) => [e.index, e.entry.t])).toEqual([[0, "acct"], [1, "dev"], [3, "rev"]]);
    for (const e of lookup.entries) {
      const ok = await verifyInclusion(await leafHash(canonicalEntry(e.entry)), e.index, sth.size, e.proof.map(fromB64), fromB64(sth.root));
      expect(ok).toBe(true);
    }
    expect((await log.lookup(ktUser("nobody"))).entries).toEqual([]);

    log.append({ t: "acct", u: bob, apk: Buffer.alloc(32, 9).toString("base64"), ts: 1004 });
    const later = await log.sth();
    expect(later.size).toBe(5);
    const c = log.consistency(sth.size, later.size);
    expect(await verifyConsistency(sth.size, later.size, fromB64(sth.root), fromB64(later.root), c.proof.map(fromB64))).toBe(true);
    expect(() => log.consistency(3, 6)).toThrow(RangeError);
    expect(() => log.consistency(4, 3)).toThrow(RangeError);
    // A head at the same size is reused until it ages.
    expect(await log.sth()).toBe(later);
  });

  it("the KT key never changes for the same master key, and survives a restart with the same log", async () => {
    const log = new KtLog(db, signer());
    fill(log);
    const before = await log.sth();
    db.close();
    db = openPlainDatabase(file, []);
    const again = new KtLog(db, signer());
    expect(again.key()).toBe(log.key());
    expect(again.size).toBe(4);
    const after = await again.sth();
    expect(after.root).toBe(before.root);
    expect(again.status()).toMatchObject({ state: "ok", size: 4, root: before.root });
  });

  it("is append-only in the database itself: UPDATE and DELETE are refused", () => {
    const log = new KtLog(db, signer());
    fill(log);
    expect(() => db.prepare("UPDATE kt_leaves SET entry = 'x' WHERE idx = 0").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM kt_leaves WHERE idx = 3").run()).toThrow(/append-only/);
    expect(log.size).toBe(4);
  });

  it("another instance's appends are seen before answering (one database, two processes)", async () => {
    const a = new KtLog(db, signer());
    const otherHandle = openPlainDatabase(file, []);
    try {
      const b = new KtLog(otherHandle, signer());
      a.append({ t: "acct", u: alice, apk, ts: 1 });
      expect(b.append({ t: "acct", u: bob, apk, ts: 2 })).toBe(1);
      expect((await a.sth()).size).toBe(2);
      expect((await a.sth()).root).toBe((await b.sth()).root);
    } finally {
      otherHandle.close();
    }
  });

  describe("fails closed — never rebuilt", () => {
    /** Tampers with the file the way an attacker with disk access would (the triggers dropped first). */
    const tamper = async (sql: string) => {
      const log = new KtLog(db, signer());
      fill(log);
      await log.sth();
      db.exec("DROP TRIGGER kt_leaves_no_update; DROP TRIGGER kt_leaves_no_delete;");
      db.exec(sql);
      return new KtLog(db, signer());
    };

    it.each([
      ["an entry rewritten", "UPDATE kt_leaves SET entry = replace(entry, '\"ts\":1001', '\"ts\":1999') WHERE idx = 1"],
      ["an entry and its hash rewritten", "UPDATE kt_leaves SET entry = replace(entry, '\"ts\":1001', '\"ts\":1999'), leaf_hash = 'AAAA' WHERE idx = 1"],
      ["a leaf deleted (a gap)", "DELETE FROM kt_leaves WHERE idx = 1"],
      ["the newest leaves cut off", "DELETE FROM kt_leaves WHERE idx >= 2"],
      ["an entry not canonical", "UPDATE kt_leaves SET entry = '{ \"t\":\"acct\" }' WHERE idx = 0"],
    ])("%s", async (_why, sql) => {
      const log = await tamper(sql);
      expect(log.failed).toBeTruthy();
      expect(log.status().state).toBe("failed");
      await expect(log.sth()).rejects.toBeInstanceOf(KtUnavailableError);
      await expect(log.lookup(alice)).rejects.toBeInstanceOf(KtUnavailableError);
      expect(() => log.append({ t: "acct", u: alice, apk, ts: 5 })).toThrow(KtUnavailableError);
      // Nothing was rewritten or added back.
      expect(Number((db.prepare("SELECT count(*) AS n FROM kt_leaves").get() as { n: number }).n)).toBeLessThanOrEqual(4);
    });

    it("a consistent rewrite of the whole history is caught by the signed head", async () => {
      // Rewrite an entry AND its leaf hash consistently: only the stored, signed head still knows the old root.
      const log = new KtLog(db, signer());
      fill(log);
      await log.sth();
      db.exec("DROP TRIGGER kt_leaves_no_update;");
      const text = canonicalEntry({ t: "dev", u: alice, apk, dpk: Buffer.alloc(91, 3).toString("base64"), exp: 9_000, ts: 1001 });
      db.prepare("UPDATE kt_leaves SET entry = ?, leaf_hash = ? WHERE idx = 1").run(text, leafHashOf(text).toString("base64"));
      const reopened = new KtLog(db, signer());
      expect(reopened.failed).toMatch(/signed head/);
    });

    it("another KT key (a replaced master key) cannot vouch for the stored heads", async () => {
      const log = new KtLog(db, signer());
      fill(log);
      await log.sth();
      const other = new KtLog(db, ktSignerFromSeed(randomBytes(32)));
      expect(other.failed).toMatch(/KT key/);
    });

    it("a log that cannot be opened is failed, not off — and the service refuses appends", () => {
      db.close();
      const service = KtService.open(db, signer);
      expect(service.mode).toBe("failed");
      expect(() => service.append({ t: "acct", u: alice, apk, ts: 1 })).toThrow(KtUnavailableError);
      expect(KtService.off("no storage").append({ t: "acct", u: alice, apk, ts: 1 })).toBeNull();
    });
  });

  it("caps a lookup to the newest entries", async () => {
    const log = new KtLog(db, signer());
    for (let i = 0; i < KT_LIMITS.lookupEntries + 5; i += 1) log.append({ t: "acct", u: alice, apk, ts: i });
    const lookup = await log.lookup(alice);
    expect(lookup.entries).toHaveLength(KT_LIMITS.lookupEntries);
    expect(lookup.entries[0].index).toBe(5);
  });

  it("loads and checks 20 000 stored leaves quickly", async () => {
    new KtLog(db, signer());
    const insert = db.prepare("INSERT INTO kt_leaves (idx, u, kind, entry, leaf_hash, ts) VALUES (?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < 20_000; i += 1) {
      const e: KtEntry = { t: "acct", u: i % 2 ? alice : ktUser(`user-${i}`), apk, ts: i };
      const text = canonicalEntry(e);
      insert.run(i, e.u, e.t, text, leafHashOf(text).toString("base64"), i);
    }
    db.exec("COMMIT");
    const started = Date.now();
    const log = new KtLog(db, signer());
    const sth = await log.sth();
    const lookup = await log.lookup(alice);
    expect(sth.size).toBe(20_000);
    expect(lookup.entries).toHaveLength(KT_LIMITS.lookupEntries);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/* -------------------------------------------------------------- routes */

describe("GET /api/kt/*", () => {
  let dir = "";
  let db: SqliteDatabase;
  let server: Server;
  let base = "";
  let service: KtService;
  let accounts: AccountStore;
  /** A signed-in account (6.12 review S03: a lookup needs a session and answers its own u). */
  let carol: { token: string; u: string };

  beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "m5cet-kt-routes-"));
    db = openPlainDatabase(join(dir, "m5cet.db"), []);
    service = KtService.open(db, () => ktSignerFromSeed(Buffer.alloc(32, 5)));
    accounts = new AccountStore(dir);
    const credential: StoredCredential = { credentialId: `cred-kt-${randomBytes(6).toString("hex")}`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
    const r = accounts.create(credential, { username: `carol${randomBytes(4).toString("hex")}` });
    if (!r.ok) throw new Error(r.reason);
    carol = { token: accounts.issueToken(r.account.id), u: ktUser(usernameOf(r.account)) };
    const app = express();
    registerKtRoutes(app, () => service, accounts);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    try { db.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (path: string, token: string | null = carol.token) => {
    const res = await fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get("cache-control") };
  };

  it("lookups need a session and answer only the caller's own entries (review S03)", async () => {
    const other = ktUser("someone-else");
    service.append({ t: "acct", u: other, apk: Buffer.alloc(32, 2).toString("base64"), ts: 1 });
    service.append({ t: "acct", u: carol.u, apk: Buffer.alloc(32, 3).toString("base64"), ts: 2 });
    expect(await get(`/api/kt/lookup?u=${other}`, null)).toMatchObject({ status: 401, body: { code: "signed-out" } });
    expect(await get(`/api/kt/lookup?u=${other}`, "not-a-token")).toMatchObject({ status: 401 });
    expect(await get(`/api/kt/lookup?u=${other}`)).toMatchObject({ status: 403, body: { code: "not-yours" } });
    const own = (await get("/api/kt/lookup")).body as unknown as KtLookup;
    expect(own.entries.map((e) => e.entry.u)).toEqual([carol.u]);
    expect(((await get(`/api/kt/lookup?u=${carol.u}`)).body as unknown as KtLookup).entries).toHaveLength(1);
    // The head and the key stay public (clients pin and gossip them).
    expect((await get("/api/kt/sth", null)).status).toBe(200);
    expect((await get("/api/kt/key", null)).status).toBe(200);
  });

  it("serves the key, the head, lookups and consistency proofs", async () => {
    const u = carol.u;
    service.append({ t: "acct", u, apk: Buffer.alloc(32, 1).toString("base64"), ts: 1 });
    const key = await get("/api/kt/key");
    expect(key.status).toBe(200);
    expect(Buffer.from(String(key.body.key), "base64")).toHaveLength(32);
    expect(key.cache).toBe("no-store");

    const first = (await get("/api/kt/sth")).body as unknown as SignedTreeHead;
    expect(first.size).toBe(1);
    expect(edVerify(null, sthMessage(first.size, first.root, first.ts), ed25519PublicKey(Buffer.from(String(key.body.key), "base64")), Buffer.from(first.sig, "base64"))).toBe(true);

    service.append({ t: "dev", u, apk: Buffer.alloc(32, 1).toString("base64"), dpk: "AAAA", exp: 5, ts: 2 });
    const lookup = (await get(`/api/kt/lookup?u=${u}`)).body as unknown as KtLookup;
    expect(lookup.sth.size).toBe(2);
    expect(lookup.entries.map((e) => e.entry.t)).toEqual(["acct", "dev"]);
    for (const e of lookup.entries) {
      expect(await verifyInclusion(await leafHash(canonicalEntry(e.entry)), e.index, lookup.sth.size, e.proof.map(fromB64), fromB64(lookup.sth.root))).toBe(true);
    }
    const c = (await get(`/api/kt/consistency?from=1&to=2`)).body as unknown as KtConsistency;
    expect(c).toMatchObject({ from: 1, to: 2 });
    expect(await verifyConsistency(1, 2, fromB64(first.root), fromB64(lookup.sth.root), c.proof.map(fromB64))).toBe(true);
    expect((await get(`/api/kt/consistency?from=0&to=0`)).body).toEqual({ from: 0, to: 0, proof: [] });
  });

  it("checks its input", async () => {
    for (const path of [
      "/api/kt/lookup?u=", "/api/kt/lookup?u=short", "/api/kt/lookup?u=" + "A".repeat(44), "/api/kt/lookup?u=" + "%2B".repeat(43), "/api/kt/lookup?u=a&u=b",
      "/api/kt/consistency", "/api/kt/consistency?from=1", "/api/kt/consistency?from=2&to=1", "/api/kt/consistency?from=-1&to=1",
      "/api/kt/consistency?from=1.5&to=2", "/api/kt/consistency?from=01&to=2", "/api/kt/consistency?from=0&to=99999999999999999999",
      "/api/kt/consistency?from=0&to=5",
    ]) {
      const r = await get(path);
      expect({ path, status: r.status }).toEqual({ path, status: 400 });
      expect(r.body).toMatchObject({ ok: false, code: "bad-request" });
    }
  });

  it("answers 503 when key transparency is off or closed", async () => {
    service = KtService.off("no storage");
    for (const path of ["/api/kt/key", "/api/kt/sth", `/api/kt/lookup?u=${carol.u}`, "/api/kt/consistency?from=0&to=0"]) {
      expect(await get(path)).toMatchObject({ status: 503, body: { code: "kt-off" } });
    }
    db.close();
    service = KtService.open(db, () => ktSignerFromSeed(Buffer.alloc(32, 5)));
    expect(await get("/api/kt/sth")).toMatchObject({ status: 503, body: { code: "kt-failed" } });
  });
});
