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
// are limited per client address (6.12 review S04: bad signatures per address
// and per room + address, a valid proof by another key — what every real
// member of a squatted room sends — per room + address only; an IPv6 client
// counts by its /64; the maps are bounded). Registering a NEW verifier is
// limited per address too (review S15: HUB_ROOM_REGISTRATIONS_PER_HOUR,
// default 20) — a proof over the limit is admitted unproven and registers
// nothing (refused when proofs are required).
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
// registers again) — a documented limit. The in-memory store never evicts a
// verifier proven within the TTL to make room (review S15): when it is full,
// only expired verifiers go, and otherwise a new registration is refused.
//
// "Proven only" (review S07): a room counts as proving as soon as it HAS a
// registered verifier — not only while a proven member happens to be
// connected. Server features that reach members by room, name or peer id
// (route audio, calls offered to a room, `user` targets, notices, the key
// directory over the hub) then serve proven members only, also while every
// proven member is away (hasVerifier, cached).
//
// Trust on first use: whoever proves first for a room that has no verifier
// registers it. Someone who knows only the blind id can therefore squat a room
// that no 6.12 client has proven yet; real members are then refused until the
// TTL ends — or until an operator resets the room's verifier (`reset`,
// POST /api/admin/security/room-proof/reset, owner role). They were never
// admitted on a key they did not have — the squatter gains no access a legacy
// join did not already give (docs/protocol-v4.md § 13).

import { createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { LABEL } from "../../client/src/lib/p4/contract";
import { addressGroup } from "../address-group";
import { migrate, type SqliteDatabase, type SqliteStatement } from "../storage/db";
import type { Migration } from "../storage/schema";
import { hashRoom } from "../monitor/traffic";

export const HUB_NONCE_BYTES = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A verifier's "last proven" is written at most this often. */
const TOUCH_EVERY_MS = 60 * 60 * 1000;
/** Failed proofs per client address (and per room + address) in windowMs before proofs from it are refused
 *  unchecked; at most maxAddresses addresses are remembered (the least recently failed go first). */
export const PROOF_FAILURES = { max: 10, windowMs: 10 * 60 * 1000, maxAddresses: 10_000 } as const;
/** 6.12 review S15: new verifiers one address may register per hour (HUB_ROOM_REGISTRATIONS_PER_HOUR). */
export const PROOF_REGISTRATIONS = { perHour: 20, windowMs: 60 * 60 * 1000 } as const;
/** How long hasVerifier() trusts what it found (a registration or reset here updates it at once). */
const VERIFIER_CACHE = { yesMs: 60_000, noMs: 5_000, max: 20_000 } as const;

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

export type ProofSettings = {
  required: boolean;
  ttlMs: number;
  /** 6.12 review S15: new verifiers per address and hour (default PROOF_REGISTRATIONS.perHour). */
  registrationsPerHour?: number;
};

/** HUB_REQUIRE_ROOM_PROOF (1/true/yes), HUB_ROOM_PROOF_TTL_DAYS (default 365, 1 – 3650) and
 *  HUB_ROOM_REGISTRATIONS_PER_HOUR (default 20, 1 – 100 000). */
export function proofSettings(env: NodeJS.ProcessEnv = process.env): ProofSettings {
  const required = /^(1|true|yes|on)$/i.test(env.HUB_REQUIRE_ROOM_PROOF?.trim() ?? "");
  const days = Number(env.HUB_ROOM_PROOF_TTL_DAYS?.trim() || "");
  const ttlDays = Number.isFinite(days) && days >= 1 && days <= 3650 ? days : 365;
  const perHour = Number(env.HUB_ROOM_REGISTRATIONS_PER_HOUR?.trim() || "");
  const registrationsPerHour = Number.isInteger(perHour) && perHour >= 1 && perHour <= 100_000 ? perHour : PROOF_REGISTRATIONS.perHour;
  return { required, ttlMs: Math.round(ttlDays * DAY_MS), registrationsPerHour };
}

/**
 * Members the server may reach by room (G-09): telephony route audio, calls
 * offered to a room, a member named by display name. With proofs required:
 * proven members only. Otherwise: proven members only as soon as the room
 * proves — `roomProven`: it has a registered verifier (6.12 review S07: also
 * while every proven member is away), or one of `members` has proven; in a
 * room where nobody ever proved (older clients) everyone, as before 6.12.
 */
export function reachable<T extends { proven?: boolean }>(members: readonly T[], required = proofSettings().required, roomProven = false): T[] {
  if (required || roomProven || members.some((m) => m.proven === true)) return members.filter((m) => m.proven === true);
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
  /** Registers `pub` unless the room has a verifier; returns the one kept (first writer wins), or null when
   *  the store is full (6.12 review S15: only verifiers last proven before `expiredBefore` may make room). */
  register(roomKey: string, roomHash: string, pub: string, now: number, expiredBefore?: number): Verifier | null;
  touch(roomKey: string, now: number): void;
  remove(roomKey: string): void;
  /** Forgets verifiers last proven before `cutoff`; returns how many. */
  sweep(cutoff: number): number;
  count(): number;
}

export class MemoryVerifiers implements VerifierStore {
  readonly persistent = false;
  private readonly map = new Map<string, Verifier>();
  private lastFullSweep = Number.NEGATIVE_INFINITY;
  constructor(private readonly max = 100_000) {}

  get(roomKey: string): Verifier | null { return this.map.get(roomKey) ?? null; }
  register(roomKey: string, _roomHash: string, pub: string, now: number, expiredBefore = Number.NEGATIVE_INFINITY): Verifier | null {
    const known = this.map.get(roomKey);
    if (known) return known;
    if (this.map.size >= this.max) {
      // 6.12 review S15: a verifier proven within the TTL is never evicted to make room (a flood of
      // made-up rooms pushed real rooms out, which could then be squatted). Expired ones go — swept at
      // most once a minute while full — and otherwise the registration is refused.
      if (now - this.lastFullSweep >= 60_000) { this.lastFullSweep = now; this.sweep(expiredBefore); }
      if (this.map.size >= this.max) return null;
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
  /** Bounded by the TTL sweep and the per-address registration limit (RoomProofs); never full. */
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
  /** `deferred`: a good proof for a room without a verifier that registered nothing (review S15: the
   *  address's registration limit, or a full in-memory store) — admitted unproven, as a legacy join. */
  | { kind: "legacy"; error?: string; deferred?: "registration-limit" | "verifiers-full" }
  | {
    kind: "refused"; code: "room-proof" | "room-proof-required";
    reason: "mismatch" | "bad-signature" | "rate-limited" | "required" | "store-error" | "registration-limit" | "verifiers-full";
    message: string;
  };

const SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * Event times per key within a window (6.12 review S04): at most `maxKeys`
 * keys — the least recently touched goes first, in O(1) — and at most `keep`
 * times per key. Replaces an unbounded map that scanned itself on every
 * failure once it held 10 000 addresses.
 */
export class RecentEvents {
  private readonly map = new Map<string, number[]>();
  constructor(private readonly maxKeys: number, private readonly windowMs: number, private readonly keep: number) {}

  get size(): number { return this.map.size; }

  /** Events of `key` in the window ending at `now`. */
  count(key: string, now: number): number {
    const list = this.map.get(key);
    if (!list) return 0;
    const recent = list.filter((t) => now - t < this.windowMs);
    if (recent.length) this.map.set(key, recent); else this.map.delete(key);
    return recent.length;
  }

  add(key: string, now: number): void {
    const list = (this.map.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.map.delete(key);
    this.map.set(key, list.slice(-this.keep));
    while (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value as string);
  }
}

export class RoomProofs {
  /** Bad signatures per address group (an IPv6 /64): enough of them block proofs from it for every room. */
  private readonly failures = new RecentEvents(PROOF_FAILURES.maxAddresses, PROOF_FAILURES.windowMs, PROOF_FAILURES.max);
  /** Failed proofs (bad signatures and another key's valid ones) per room + address group: block that room only. */
  private readonly roomFailures = new RecentEvents(PROOF_FAILURES.maxAddresses, PROOF_FAILURES.windowMs, PROOF_FAILURES.max);
  /** New verifiers per address group (review S15). */
  private readonly registrations = new RecentEvents(PROOF_FAILURES.maxAddresses, PROOF_REGISTRATIONS.windowMs, 100_000);
  /** hasVerifier()'s answers by room key, for a short while. */
  private readonly known = new Map<string, { has: boolean; until: number }>();
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

  private registrationLimit(): number {
    const n = this.settings.registrationsPerHour;
    return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : PROOF_REGISTRATIONS.perHour;
  }

  /** What hasVerifier() answers for a while (bounded: the oldest answer goes first). */
  private remember(key: string, has: boolean, now: number): void {
    this.known.delete(key);
    this.known.set(key, { has, until: now + (has ? VERIFIER_CACHE.yesMs : VERIFIER_CACHE.noMs) });
    while (this.known.size > VERIFIER_CACHE.max) this.known.delete(this.known.keys().next().value as string);
  }

  /**
   * 6.12 review S07: does this room have a registered verifier (someone proved
   * for it within the TTL)? Then the server reaches only proven members by
   * room, name or peer id — also while every proven member is away. Cached (a
   * minute when yes, seconds when no); a store error keeps the last answer.
   */
  hasVerifier(roomId: string): boolean {
    if (!canProve(roomId)) return false;
    const key = this.roomKey(roomId);
    const now = this.now();
    const cached = this.known.get(key);
    if (cached && cached.until > now) return cached.has;
    let has = cached?.has ?? false;
    try {
      const v = this.store.get(key);
      has = Boolean(v && now - v.lastProvenAt <= this.settings.ttlMs);
    } catch { /* keep the last known answer */ }
    this.remember(key, has, now);
    return has;
  }

  /** Decides a join: proven, admitted as legacy, or refused. `ip`: the client's address (counted by its group). */
  check(roomId: string, nonce: string, proof: { pub: string; sig: string } | undefined, ip: string): ProofOutcome {
    if (!canProve(roomId)) return { kind: "legacy" };
    if (!proof) {
      return this.settings.required
        ? { kind: "refused", code: "room-proof-required", reason: "required", message: "This server admits only members who prove they hold the room key — update the app." }
        : { kind: "legacy" };
    }
    const now = this.now();
    const address = addressGroup(ip) || "unknown";
    const key = this.roomKey(roomId);
    const roomAddress = `${key}|${address}`;
    // Checked before the signature (no Ed25519 work for a blocked address). Bad signatures block the
    // address for every room; failures in one room (a squatted room's real members) block that room only.
    if (this.failures.count(address, now) >= PROOF_FAILURES.max || this.roomFailures.count(roomAddress, now) >= PROOF_FAILURES.max) {
      return { kind: "refused", code: "room-proof", reason: "rate-limited", message: "Too many failed room proofs from this address; wait a few minutes." };
    }
    if (!verifyHubProof(proof, roomId, nonce)) {
      this.failures.add(address, now);
      this.roomFailures.add(roomAddress, now);
      return { kind: "refused", code: "room-proof", reason: "bad-signature", message: "The room proof does not verify." };
    }
    try {
      let v = this.store.get(key);
      if (v && now - v.lastProvenAt > this.settings.ttlMs) {
        this.store.remove(key);
        v = null;
      }
      let registered = false;
      if (!v) {
        // 6.12 review S15: a registration costs a slot of the address's hourly budget, and a full
        // in-memory store refuses it rather than evict a room proven within the TTL.
        const limited = this.registrations.count(address, now) >= this.registrationLimit();
        const kept = limited ? null : this.store.register(key, hashRoom(roomId) ?? "", proof.pub, now, now - this.settings.ttlMs);
        if (!kept) {
          const why = limited ? "registration-limit" as const : "verifiers-full" as const;
          this.remember(key, false, now);
          return this.settings.required
            ? { kind: "refused", code: "room-proof", reason: why, message: limited ? "Too many new rooms from this address; try again later." : "The server cannot take more rooms that prove their key right now; try again later." }
            : { kind: "legacy", deferred: why };
        }
        v = kept;
        registered = v.pub === proof.pub && v.createdAt === now;
        if (registered) this.registrations.add(address, now);
      }
      this.remember(key, true, now);
      if (v.pub !== proof.pub) {
        // A valid proof by another key: counted for this room only (review S04).
        this.roomFailures.add(roomAddress, now);
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

  /**
   * The operator's way out of a squatted room (6.12): forgets the room's
   * verifier, so the next proven join — the real members, who hold the key —
   * registers it again. Returns whether there was one. Needs the blind id
   * (members see it in the room's info), never the passphrase.
   */
  reset(roomId: string): boolean {
    if (!canProve(roomId)) return false;
    const key = this.roomKey(roomId);
    const had = Boolean(this.store.get(key));
    if (had) this.store.remove(key);
    this.known.delete(key);
    return had;
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
