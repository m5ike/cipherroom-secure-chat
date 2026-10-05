// Hub join proof (protocol 4, § 13; security analysis G-09).
//
// Until 6.12 the hub admitted anyone who knew a room's blind id (r3.…) — the
// id is an address, not a secret. Now a 6.12 client proves it holds the room
// KEY: from the room secret it derives an Ed25519 key pair (hubSeed =
// HKDF(room secret, LABEL.hubSeed)) and signs the socket's nonce:
//
//   hello  { …, nonce }                 24 random bytes (b64url), one per socket
//   join   { …, proof: { pub, sig } }   pub = raw Ed25519 key (b64, 32 B),
//                                       sig = Ed25519(seed, join("m5cet/hub-join/4", roomId, nonce)) (b64, 64 B)
//
// The first proven join of a room registers its verifier (`pub`); every later
// proof must carry the same `pub` and a good signature. A verifier nobody
// proved for HUB_ROOM_PROOF_TTL_DAYS (default 365) is forgotten — the next
// proven join registers anew. A proof with another `pub` or a bad signature is
// refused (`room-proof`) and audited (security, room hash only); failed proofs
// are limited per client address.
//
// Joins WITHOUT a proof (clients before 6.12) are admitted as before and shown
// as `proven: false`, unless HUB_REQUIRE_ROOM_PROOF=1 — then a blind room
// refuses them (`room-proof-required`). Rooms joined by a plain name
// (protocol 2 / v2 keys) cannot prove: they stay legacy rooms (admitted,
// never proven), also when proofs are required.
//
// Verifiers live in the global SQLite database (hub_room_verifiers), keyed by
// an HMAC of the room id under a subkey of the storage master key — the
// database never holds a blind id (an offline oracle of the passphrase, F-04).
// Instances of a cluster share that database (one DATA_DIR), so a room has one
// verifier everywhere. Without server-side storage the verifiers are in memory:
// per instance, and forgotten on a restart (the first proven join after it
// registers again) — a documented limit.
//
// Trust on first use: whoever proves first for a room that has no verifier
// registers it. Someone who knows only the blind id can therefore squat a room
// that no 6.12 client has proven yet; real members are then refused until the
// TTL ends. They were never admitted on a key they did not have — the squatter
// gains no access a legacy join did not already give (docs/protocol-v4.md § 13).

import { createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { LABEL } from "../../client/src/lib/p4/contract";
import { migrate, type SqliteDatabase, type SqliteStatement } from "../storage/db";
import type { Migration } from "../storage/schema";
import { hashRoom } from "../monitor/traffic";

export const HUB_NONCE_BYTES = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A verifier's "last proven" is written at most this often. */
const TOUCH_EVERY_MS = 60 * 60 * 1000;
/** Failed proofs per client address in FAIL_WINDOW_MS before proofs from it are refused unchecked. */
export const PROOF_FAILURES = { max: 10, windowMs: 10 * 60 * 1000 } as const;

/** A v3 room's blind id: the only kind of room that can prove (a plain name cannot). */
const BLIND_ROOM_ID = /^r3\.[A-Za-z0-9_-]{16,128}$/;
export const canProve = (room: string): boolean => BLIND_ROOM_ID.test(room);

export const ROOM_PROOF_MIGRATIONS: Migration[] = [
  {
    name: "hub-001-room-verifiers",
    sql: `
      CREATE TABLE IF NOT EXISTS hub_room_verifiers (
        room_key       TEXT PRIMARY KEY,
        room_hash      TEXT NOT NULL,
        pub            TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_proven_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hub_room_verifiers_seen ON hub_room_verifiers(last_proven_at);
    `,
  },
];

/* ------------------------------------------------------------- settings */

export type ProofSettings = { required: boolean; ttlMs: number };

/** HUB_REQUIRE_ROOM_PROOF (1/true/yes) and HUB_ROOM_PROOF_TTL_DAYS (default 365, 1 – 3650). */
export function proofSettings(env: NodeJS.ProcessEnv = process.env): ProofSettings {
  const required = /^(1|true|yes|on)$/i.test(env.HUB_REQUIRE_ROOM_PROOF?.trim() ?? "");
  const days = Number(env.HUB_ROOM_PROOF_TTL_DAYS?.trim() || "");
  const ttlDays = Number.isFinite(days) && days >= 1 && days <= 3650 ? days : 365;
  return { required, ttlMs: Math.round(ttlDays * DAY_MS) };
}

/**
 * Members the server may reach by room (G-09): telephony route audio, calls
 * offered to a room, a member named by display name. With proofs required:
 * proven members only. Otherwise: proven members only as soon as one member of
 * the room has proven; in a room where nobody proves (older clients) everyone,
 * as before 6.12.
 */
export function reachable<T extends { proven?: boolean }>(members: readonly T[], required = proofSettings().required): T[] {
  if (required || members.some((m) => m.proven === true)) return members.filter((m) => m.proven === true);
  return [...members];
}

/* ------------------------------------------------------------ signatures */

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export function newHubNonce(): string {
  return randomBytes(HUB_NONCE_BYTES).toString("base64url");
}

/** The bytes a join proof signs: join(LABEL.hubJoin, roomId, nonce). */
export function hubJoinMessage(roomId: string, nonce: string): Buffer {
  return Buffer.from(`${LABEL.hubJoin}|${roomId}|${nonce}`, "utf8");
}

function canonicalB64(v: string, bytes: number): Buffer | null {
  if (v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return buf.length === bytes && buf.toString("base64") === v ? buf : null;
}

/** Is `sig` an Ed25519 signature by `pub` over join(LABEL.hubJoin, roomId, nonce)? */
export function verifyHubProof(proof: { pub: string; sig: string }, roomId: string, nonce: string): boolean {
  const pub = canonicalB64(proof.pub, 32);
  const sig = canonicalB64(proof.sig, 64);
  if (!pub || !sig) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, pub]), format: "der", type: "spki" });
    return verify(null, hubJoinMessage(roomId, nonce), key, sig);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- verifiers */

export type Verifier = { pub: string; createdAt: number; lastProvenAt: number };

export interface VerifierStore {
  readonly persistent: boolean;
  get(roomKey: string): Verifier | null;
  /** Registers `pub` unless the room has a verifier; returns the one kept (first writer wins). */
  register(roomKey: string, roomHash: string, pub: string, now: number): Verifier;
  touch(roomKey: string, now: number): void;
  remove(roomKey: string): void;
  /** Forgets verifiers last proven before `cutoff`; returns how many. */
  sweep(cutoff: number): number;
  count(): number;
}

export class MemoryVerifiers implements VerifierStore {
  readonly persistent = false;
  private readonly map = new Map<string, Verifier>();
  constructor(private readonly max = 100_000) {}

  get(roomKey: string): Verifier | null { return this.map.get(roomKey) ?? null; }
  register(roomKey: string, _roomHash: string, pub: string, now: number): Verifier {
    const known = this.map.get(roomKey);
    if (known) return known;
    if (this.map.size >= this.max) {
      // The least recently proven goes first.
      let oldest: string | null = null;
      let at = Infinity;
      for (const [k, v] of this.map) if (v.lastProvenAt < at) { at = v.lastProvenAt; oldest = k; }
      if (oldest) this.map.delete(oldest);
    }
    const v = { pub, createdAt: now, lastProvenAt: now };
    this.map.set(roomKey, v);
    return v;
  }
  touch(roomKey: string, now: number): void {
    const v = this.map.get(roomKey);
    if (v) v.lastProvenAt = now;
  }
  remove(roomKey: string): void { this.map.delete(roomKey); }
  sweep(cutoff: number): number {
    let n = 0;
    for (const [k, v] of this.map) if (v.lastProvenAt < cutoff) { this.map.delete(k); n += 1; }
    return n;
  }
  count(): number { return this.map.size; }
}

export class SqliteVerifiers implements VerifierStore {
  readonly persistent = true;
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(private readonly db: SqliteDatabase) {
    migrate(db, ROOM_PROOF_MIGRATIONS);
  }

  private sql(source: string): SqliteStatement {
    let s = this.statements.get(source);
    if (!s) { s = this.db.prepare(source); this.statements.set(source, s); }
    return s;
  }

  get(roomKey: string): Verifier | null {
    const r = this.sql("SELECT pub, created_at, last_proven_at FROM hub_room_verifiers WHERE room_key = ?").get(roomKey) as { pub: string; created_at: number; last_proven_at: number } | undefined;
    return r ? { pub: String(r.pub), createdAt: Number(r.created_at), lastProvenAt: Number(r.last_proven_at) } : null;
  }
  register(roomKey: string, roomHash: string, pub: string, now: number): Verifier {
    this.sql("INSERT OR IGNORE INTO hub_room_verifiers (room_key, room_hash, pub, created_at, last_proven_at) VALUES (?, ?, ?, ?, ?)").run(roomKey, roomHash, pub, now, now);
    return this.get(roomKey) ?? { pub, createdAt: now, lastProvenAt: now };
  }
  touch(roomKey: string, now: number): void {
    this.sql("UPDATE hub_room_verifiers SET last_proven_at = ? WHERE room_key = ? AND last_proven_at < ?").run(now, roomKey, now);
  }
  remove(roomKey: string): void {
    this.sql("DELETE FROM hub_room_verifiers WHERE room_key = ?").run(roomKey);
  }
  sweep(cutoff: number): number {
    return this.sql("DELETE FROM hub_room_verifiers WHERE last_proven_at < ?").run(cutoff).changes;
  }
  count(): number {
    return Number((this.sql("SELECT count(*) AS n FROM hub_room_verifiers").get() as { n: number }).n);
  }
}

/* --------------------------------------------------------------- checker */

export type ProofOutcome =
  | { kind: "proven"; registered: boolean }
  | { kind: "legacy"; error?: string }
  | { kind: "refused"; code: "room-proof" | "room-proof-required"; reason: "mismatch" | "bad-signature" | "rate-limited" | "required" | "store-error"; message: string };

const SWEEP_EVERY_MS = 60 * 60 * 1000;

export class RoomProofs {
  private readonly failures = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    readonly store: VerifierStore,
    private readonly roomKeySecret: Buffer,
    readonly settings: ProofSettings = proofSettings(),
    private readonly now: () => number = Date.now,
  ) {
    if (roomKeySecret.length < 32) throw new RangeError("the room key secret is 32 bytes");
  }

  /** In memory with a random key (no storage, tests). */
  static inMemory(settings: ProofSettings = proofSettings(), now: () => number = Date.now): RoomProofs {
    return new RoomProofs(new MemoryVerifiers(), randomBytes(32), settings, now);
  }

  /** The name a room's verifier is kept under: never the blind id itself. */
  roomKey(roomId: string): string {
    return createHmac("sha256", this.roomKeySecret).update(`m5cet/hub-room|${roomId}`, "utf8").digest("base64url");
  }

  private blocked(ip: string, now: number): boolean {
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < PROOF_FAILURES.windowMs);
    if (recent.length) this.failures.set(ip, recent); else this.failures.delete(ip);
    return recent.length >= PROOF_FAILURES.max;
  }

  private failed(ip: string, now: number): void {
    const list = this.failures.get(ip) ?? [];
    list.push(now);
    this.failures.set(ip, list.slice(-PROOF_FAILURES.max));
    if (this.failures.size > 10_000) {
      for (const [k, times] of this.failures) if (!times.some((t) => now - t < PROOF_FAILURES.windowMs)) this.failures.delete(k);
    }
  }

  /** Decides a join: proven, admitted as legacy, or refused. */
  check(roomId: string, nonce: string, proof: { pub: string; sig: string } | undefined, ip: string): ProofOutcome {
    if (!canProve(roomId)) return { kind: "legacy" };
    if (!proof) {
      return this.settings.required
        ? { kind: "refused", code: "room-proof-required", reason: "required", message: "This server admits only members who prove they hold the room key — update the app." }
        : { kind: "legacy" };
    }
    const now = this.now();
    if (this.blocked(ip, now)) {
      return { kind: "refused", code: "room-proof", reason: "rate-limited", message: "Too many failed room proofs from this address; wait a few minutes." };
    }
    if (!verifyHubProof(proof, roomId, nonce)) {
      this.failed(ip, now);
      return { kind: "refused", code: "room-proof", reason: "bad-signature", message: "The room proof does not verify." };
    }
    const key = this.roomKey(roomId);
    try {
      let v = this.store.get(key);
      if (v && now - v.lastProvenAt > this.settings.ttlMs) {
        this.store.remove(key);
        v = null;
      }
      let registered = false;
      if (!v) {
        v = this.store.register(key, hashRoom(roomId) ?? "", proof.pub, now);
        registered = v.pub === proof.pub && v.createdAt === now;
      }
      if (v.pub !== proof.pub) {
        this.failed(ip, now);
        return { kind: "refused", code: "room-proof", reason: "mismatch", message: "The room proof is for another key than this room's." };
      }
      if (!registered && now - v.lastProvenAt > TOUCH_EVERY_MS) this.store.touch(key, now);
      return { kind: "proven", registered };
    } catch (err) {
      const error = (err as Error).message;
      return this.settings.required
        ? { kind: "refused", code: "room-proof", reason: "store-error", message: "The server could not check the room proof; try again." }
        : { kind: "legacy", error };
    }
  }

  /** Forgets verifiers past their TTL (at most once an hour). */
  sweep(now = this.now()): number {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return 0;
    this.lastSweep = now;
    try { return this.store.sweep(now - this.settings.ttlMs); } catch { return 0; }
  }

  status() {
    let rooms = 0;
    try { rooms = this.store.count(); } catch { /* unknown */ }
    return { persistent: this.store.persistent, required: this.settings.required, ttlDays: Math.round(this.settings.ttlMs / DAY_MS), rooms };
  }
}
