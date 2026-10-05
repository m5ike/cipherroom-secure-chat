// Key transparency (protocol 4, docs/protocol-v4.md § 14): an append-only
// Merkle log of account keys and device certificates, kept in the global
// SQLite database, and the server's signed tree heads.
//
//   kt_leaves  idx (0, 1, 2, … without gaps), u, kind, the entry's canonical
//              JSON exactly as hashed, its leaf hash (b64), ts. UPDATE and
//              DELETE are refused by triggers: the log is never rewritten.
//   kt_sth     the first tree head signed for each size (size, root, ts, sig)
//
// Every row is checked when it is read — the index without gaps, the text
// canonical, the stored leaf hash the hash of the text — and the newest
// stored tree head must still be the root of the leaves under it and verify
// with this server's KT key. Anything else puts the log in a FAILED state:
// every route answers 503 and nothing is appended until the operator restores
// the database (or its master key). It is never rebuilt or "repaired".
//
// Before a new tree head is signed, the server proves to itself — with the
// shared verifier of client/src/lib/p4/merkle.ts — that the new tree extends
// the last head it signed (verifyConsistency). Instances of a cluster share the
// database (one DATA_DIR): an append takes the write lock (BEGIN IMMEDIATE),
// and every read first catches up with leaves another instance wrote.
//
// The KT key is Ed25519 from a seed derived from the storage master key
// (keys.ts serverSubkey "kt-signing-key"): it is never stored on its own,
// never in the environment, never logged. Replacing the master key changes it
// — the stored heads then no longer verify and the log fails closed (clients
// pinned the old key anyway).

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { migrate, type SqliteDatabase, type SqliteStatement } from "../storage/db";
import type { Migration } from "../storage/schema";
import { serverSubkey } from "../storage/keys";
import { LABEL, type KtConsistency, type KtEntry, type KtLookup, type SignedTreeHead } from "../../client/src/lib/p4/contract";
import { verifyConsistency } from "../../client/src/lib/p4/merkle";
import { leafHashOf, MerkleTree } from "./tree";

export const KT_MIGRATIONS: Migration[] = [
  {
    name: "kt-001-log",
    sql: `
      CREATE TABLE IF NOT EXISTS kt_leaves (
        idx       INTEGER PRIMARY KEY,
        u         TEXT NOT NULL,
        kind      TEXT NOT NULL,
        entry     TEXT NOT NULL,
        leaf_hash TEXT NOT NULL,
        ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kt_leaves_u ON kt_leaves(u, idx);
      CREATE TRIGGER IF NOT EXISTS kt_leaves_no_update BEFORE UPDATE ON kt_leaves
        BEGIN SELECT RAISE(ABORT, 'the key transparency log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS kt_leaves_no_delete BEFORE DELETE ON kt_leaves
        BEGIN SELECT RAISE(ABORT, 'the key transparency log is append-only'); END;

      CREATE TABLE IF NOT EXISTS kt_sth (
        size INTEGER PRIMARY KEY,
        root TEXT NOT NULL,
        ts   INTEGER NOT NULL,
        sig  TEXT NOT NULL
      );
    `,
  },
];

export const KT_LIMITS = {
  /** A lookup returns at most this many entries of one user (the newest). */
  lookupEntries: 500,
  /** A tree head older than this is signed again (same size, a fresh ts). */
  sthMaxAgeMs: 60 * 60 * 1000,
} as const;

/* ------------------------------------------------------------- entries */

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const isTs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown, re: RegExp, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && re.test(v);

/** The canonical text of an entry: keys in the order of KtEntry (contract.ts), no spaces. */
export function canonicalEntry(e: KtEntry): string {
  switch (e.t) {
    case "acct": return JSON.stringify({ t: e.t, u: e.u, apk: e.apk, ts: e.ts });
    case "dev": return JSON.stringify({ t: e.t, u: e.u, apk: e.apk, dpk: e.dpk, exp: e.exp, ts: e.ts });
    case "rev": return JSON.stringify({ t: e.t, u: e.u, apk: e.apk, dpk: e.dpk, ts: e.ts });
  }
}

/** An entry of a known kind with well-formed fields, else null. */
export function parseEntry(v: unknown): KtEntry | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  if (!isStr(e.u, B64URL, 64) || !isStr(e.apk, B64, 64) || !isTs(e.ts)) return null;
  if (e.t === "acct") return { t: "acct", u: e.u, apk: e.apk, ts: e.ts };
  if (!isStr(e.dpk, B64, 512)) return null;
  if (e.t === "dev") return isTs(e.exp) ? { t: "dev", u: e.u, apk: e.apk, dpk: e.dpk, exp: e.exp, ts: e.ts } : null;
  if (e.t === "rev") return { t: "rev", u: e.u, apk: e.apk, dpk: e.dpk, ts: e.ts };
  return null;
}

/** The text a tree head's signature covers: join(LABEL.ktSth, size, root, ts). */
export function sthMessage(size: number, root: string, ts: number): Buffer {
  return Buffer.from(`${LABEL.ktSth}|${size}|${root}|${ts}`, "utf8");
}

/* -------------------------------------------------------------- signer */

export type KtSigner = {
  /** Raw Ed25519 public key (32 bytes). */
  readonly publicKey: Buffer;
  sign(message: Buffer): Buffer;
  verify(message: Buffer, signature: Buffer): boolean;
};

// PKCS#8 / SPKI wrapping of raw Ed25519 keys (RFC 8410).
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** An Ed25519 public key object from its raw 32 bytes. */
export function ed25519PublicKey(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new RangeError("an Ed25519 public key is 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
}

/** A signer from a 32-byte seed (the seed is not kept). */
export function ktSignerFromSeed(seed: Buffer): KtSigner {
  if (seed.length !== 32) throw new RangeError("an Ed25519 seed is 32 bytes");
  const der = Buffer.concat([PKCS8_ED25519, seed]);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
  const publicKeyObject = createPublicKey(privateKey);
  const publicKey = (publicKeyObject.export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI_ED25519.length);
  return {
    publicKey: Buffer.from(publicKey),
    sign: (message) => edSign(null, message, privateKey),
    verify: (message, signature) => {
      try { return edVerify(null, message, publicKeyObject, signature); } catch { return false; }
    },
  };
}

/** The server's KT signer: its seed is derived from the storage master key. */
export function ktSignerFromMasterKey(): KtSigner {
  const seed = serverSubkey("kt-signing-key");
  try {
    return ktSignerFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

/* ----------------------------------------------------------------- log */

/** Why the log cannot answer: off (no database), failed (corrupt — closed for good), busy (try again). */
export class KtUnavailableError extends Error {
  constructor(readonly code: "off" | "failed" | "busy", message: string) {
    super(message);
    this.name = "KtUnavailableError";
  }
}

export type KtStatus = { state: "ok" | "failed"; size: number; root: string; sth: SignedTreeHead | null; reason?: string };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class KtLog {
  private readonly tree = new MerkleTree();
  private failure: string | null = null;
  /** The newest head signed (memory; refreshed when the size changes or it ages). */
  private current: SignedTreeHead | null = null;
  /** The newest STORED head this process checked: every new head must extend it. */
  private anchor: { size: number; root: Buffer } | null = null;
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(private readonly db: SqliteDatabase, private readonly signer: KtSigner, private readonly now: () => number = Date.now) {
    migrate(db, KT_MIGRATIONS);
    this.refresh();
    if (!this.failure) this.checkAnchor();
  }

  private sql(source: string): SqliteStatement {
    let s = this.statements.get(source);
    if (!s) {
      s = this.db.prepare(source);
      this.statements.set(source, s);
    }
    return s;
  }

  /** The log is corrupt: closed until the operator restores it. Never repaired here. */
  private fail(reason: string): void {
    if (this.failure) return;
    this.failure = reason;
    this.current = null;
    console.error(`[kt] key transparency is closed: ${reason}`);
  }

  get failed(): string | null {
    return this.failure;
  }

  /** Reads leaves another instance (or an earlier run) wrote, checking each. */
  private refresh(): void {
    if (this.failure) return;
    let rows: Array<{ idx: number; u: string; kind: string; entry: string; leaf_hash: string }>;
    try {
      rows = this.sql("SELECT idx, u, kind, entry, leaf_hash FROM kt_leaves WHERE idx >= ? ORDER BY idx ASC").all(this.tree.size) as typeof rows;
    } catch (err) {
      throw new KtUnavailableError("busy", `the key transparency log could not be read (${(err as Error).message})`);
    }
    for (const row of rows) {
      const at = this.tree.size;
      if (Number(row.idx) !== at) return this.fail(`leaf ${at} is missing (found ${row.idx})`);
      const text = String(row.entry);
      let parsed: KtEntry | null = null;
      try { parsed = parseEntry(JSON.parse(text)); } catch { parsed = null; }
      if (!parsed || canonicalEntry(parsed) !== text || parsed.u !== row.u || parsed.t !== row.kind) return this.fail(`leaf ${at} is not a canonical entry`);
      const leaf = leafHashOf(text);
      if (b64(leaf) !== row.leaf_hash) return this.fail(`leaf ${at} does not match its hash`);
      this.tree.push(leaf);
    }
  }

  /** The newest stored head must still be the root of the leaves under it, signed with this key. */
  private checkAnchor(): void {
    const row = this.sql("SELECT size, root, ts, sig FROM kt_sth ORDER BY size DESC LIMIT 1").get() as { size: number; root: string; ts: number; sig: string } | undefined;
    if (!row) return;
    const size = Number(row.size);
    if (size > this.tree.size) return this.fail(`the log has ${this.tree.size} leaves but a signed head covers ${size}`);
    const root = this.tree.root(size);
    if (b64(root) !== row.root) return this.fail(`the leaves under the signed head of size ${size} changed`);
    if (!this.signer.verify(sthMessage(size, row.root, Number(row.ts)), Buffer.from(String(row.sig), "base64"))) {
      return this.fail(`the signed head of size ${size} does not verify with this server's KT key (was the storage master key replaced?)`);
    }
    this.anchor = { size, root };
  }

  /** Throws unless the log can answer; catches up with other writers first. */
  private ready(): void {
    if (this.failure) throw new KtUnavailableError("failed", this.failure);
    this.refresh();
    if (this.failure) throw new KtUnavailableError("failed", this.failure);
  }

  get size(): number {
    return this.tree.size;
  }

  /** The KT public key (raw Ed25519, b64). */
  key(): string {
    return b64(this.signer.publicKey);
  }

  /** Appends one entry; returns its index. */
  append(entry: KtEntry): number {
    const clean = parseEntry(entry);
    if (!clean) throw new RangeError("not a key transparency entry");
    this.ready();
    const text = canonicalEntry(clean);
    const leaf = leafHashOf(text);
    let index: number;
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      throw new KtUnavailableError("busy", `the key transparency log is busy (${(err as Error).message})`);
    }
    try {
      const row = this.sql("SELECT max(idx) AS m FROM kt_leaves").get() as { m: number | null };
      index = row.m === null || row.m === undefined ? 0 : Number(row.m) + 1;
      this.sql("INSERT INTO kt_leaves (idx, u, kind, entry, leaf_hash, ts) VALUES (?, ?, ?, ?, ?, ?)").run(index, clean.u, clean.t, text, b64(leaf), clean.ts);
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
      throw new KtUnavailableError("busy", `the entry could not be appended (${(err as Error).message})`);
    }
    this.refresh();
    return index;
  }

  /** The current signed tree head (signed anew when the log grew or the last one aged). */
  async sth(): Promise<SignedTreeHead> {
    this.ready();
    const size = this.tree.size;
    const now = this.now();
    if (this.current && this.current.size === size && now - this.current.ts < KT_LIMITS.sthMaxAgeMs && now >= this.current.ts) return this.current;
    const root = this.tree.root(size);
    const anchor = this.anchor;
    if (anchor && anchor.size > size) {
      this.fail(`the log shrank below a signed head (${anchor.size} > ${size})`);
      throw new KtUnavailableError("failed", this.failure!);
    }
    if (anchor) {
      // The server's own check, with the clients' verifier: the new tree extends the last signed one.
      const proof = this.tree.consistency(anchor.size, size);
      const ok = await verifyConsistency(anchor.size, size, new Uint8Array(anchor.root), new Uint8Array(root), proof.map((p) => new Uint8Array(p)));
      if (!ok) {
        this.fail(`the tree of size ${size} does not extend the signed head of size ${anchor.size}`);
        throw new KtUnavailableError("failed", this.failure!);
      }
    }
    if (this.failure) throw new KtUnavailableError("failed", this.failure);
    const rootB64 = b64(root);
    const head: SignedTreeHead = { size, root: rootB64, ts: now, sig: b64(this.signer.sign(sthMessage(size, rootB64, now))) };
    try {
      this.sql("INSERT OR IGNORE INTO kt_sth (size, root, ts, sig) VALUES (?, ?, ?, ?)").run(size, head.root, head.ts, head.sig);
    } catch { /* the head is still valid; the next one is stored */ }
    if (!this.anchor || size >= this.anchor.size) this.anchor = { size, root };
    this.current = head;
    return head;
  }

  /** Every entry of user `u` (the newest KT_LIMITS.lookupEntries), each with its inclusion proof in `sth`. */
  async lookup(u: string): Promise<KtLookup> {
    const sth = await this.sth();
    const rows = this.sql("SELECT idx, entry FROM kt_leaves WHERE u = ? AND idx < ? ORDER BY idx DESC LIMIT ?").all(u, sth.size, KT_LIMITS.lookupEntries) as Array<{ idx: number; entry: string }>;
    const entries = rows.reverse().map((r) => {
      const index = Number(r.idx);
      const text = String(r.entry);
      // The row as read now must still be the leaf the tree was built from.
      if (!leafHashOf(text).equals(this.tree.leaf(index))) {
        this.fail(`leaf ${index} changed after it was read`);
        throw new KtUnavailableError("failed", this.failure!);
      }
      return { entry: JSON.parse(text) as KtEntry, index, proof: this.tree.inclusion(index, sth.size).map(b64) };
    });
    return { sth, entries };
  }

  /** The newest entries of user `u` (no proofs), oldest first — for the server's own decisions. */
  entriesOf(u: string, limit: number = KT_LIMITS.lookupEntries): KtEntry[] {
    this.ready();
    const rows = this.sql("SELECT entry FROM kt_leaves WHERE u = ? ORDER BY idx DESC LIMIT ?").all(u, limit) as Array<{ entry: string }>;
    return rows.reverse().map((r) => JSON.parse(String(r.entry)) as KtEntry);
  }

  /** Proof that the tree of `from` leaves is a prefix of the tree of `to` (both at most the current size). */
  consistency(from: number, to: number): KtConsistency {
    this.ready();
    if (!(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && from <= to && to <= this.tree.size)) {
      throw new RangeError("tree sizes out of order or beyond the log");
    }
    return { from, to, proof: this.tree.consistency(from, to).map(b64) };
  }

  status(): KtStatus {
    try { this.refresh(); } catch { /* the last known state */ }
    return {
      state: this.failure ? "failed" : "ok",
      size: this.tree.size,
      root: this.failure ? "" : b64(this.tree.root()),
      sth: this.current,
      ...(this.failure ? { reason: this.failure } : {}),
    };
  }
}
