// Key transparency, client side (docs/protocol-v4.md § 14, F-13).
//
// The server keeps an append-only Merkle log (merkle.ts, RFC 9162) of every
// account key, device certification and revocation, and signs its tree
// heads with an Ed25519 key the client pins per server origin. A server
// that wants to show one user a fake key must either put it in the log —
// where the real owner's devices see it — or show different users different
// logs. This file catches both on the client:
//
//   * every new tree head must be a consistent extension of the newest one
//     kept (or a prefix of it): a rewritten history raises a persistent alert;
//   * a lookup's entries must be included in its (signed, consistent) head;
//   * gossip: peers carry their newest head in the hello; a head of the same
//     size with another root, or one not consistent with ours, is a split
//     view — the same alert.
//
// Entries are hashed as the UTF-8 of their canonical JSON (keys in the order
// of `KtEntry`, no spaces); the values are restricted to base64 / base64url
// text and safe integers, so every JSON encoder writes the same bytes.

import { LABEL, type KtConsistency, type KtEntry, type KtLookup, type SignedTreeHead } from "./contract";
import { leafHash, verifyConsistency, verifyInclusion } from "./merkle";
import { b64, b64url, ed25519Sign, ed25519Verify, H, isSafeCount, join, Mutex, P4Error, unb64, utf8, type Bytes } from "./primitives";

/* ------------------------------------------------------------ entries */

const B64_TEXT = /^[A-Za-z0-9+/=_-]+$/;
const text = (v: unknown): string => {
  if (typeof v !== "string" || !B64_TEXT.test(v)) throw new P4Error("malformed", "KT entry field is not base64 text");
  return v;
};
const int = (v: unknown): number => {
  if (!isSafeCount(v)) throw new P4Error("malformed", "KT entry field is not a safe integer");
  return v;
};

/** § 14.1: the canonical JSON of an entry (the leaf bytes are its UTF-8). */
export function canonicalEntry(e: KtEntry): string {
  const x = e as Partial<Record<string, unknown>>;
  switch (x.t) {
    case "acct": return JSON.stringify({ t: "acct", u: text(x.u), apk: text(x.apk), ts: int(x.ts) });
    case "dev": return JSON.stringify({ t: "dev", u: text(x.u), apk: text(x.apk), dpk: text(x.dpk), exp: int(x.exp), ts: int(x.ts) });
    case "rev": return JSON.stringify({ t: "rev", u: text(x.u), apk: text(x.apk), dpk: text(x.dpk), ts: int(x.ts) });
    default: throw new P4Error("malformed", "unknown KT entry type");
  }
}

/** § 14.1: u = b64url(H(LABEL.ktUser + username)). */
export async function ktUser(username: string): Promise<string> {
  return b64url(await H(utf8(LABEL.ktUser + username)));
}

export const entryLeafHash = (e: KtEntry): Promise<Bytes> => leafHash(canonicalEntry(e));

/* ---------------------------------------------------- signed tree heads */

/** § 14.2: the bytes an STH's signature covers. */
export const sthData = (size: number, root: string, ts: number): Bytes => join(LABEL.ktSth, size, root, ts);

export function isSth(v: unknown): v is SignedTreeHead {
  const s = v as Partial<SignedTreeHead> | null;
  if (!s || typeof s !== "object" || !isSafeCount(s.size) || !isSafeCount(s.ts) || typeof s.root !== "string" || typeof s.sig !== "string") return false;
  try { unb64(s.root, 32); unb64(s.sig, 64); return true; } catch { return false; }
}

/** Server (and tests): signs a tree head. */
export async function signSth(ktPrivateKey: CryptoKey, size: number, root: Uint8Array, ts: number): Promise<SignedTreeHead> {
  const r = b64(root);
  return { size, root: r, ts, sig: b64(await ed25519Sign(ktPrivateKey, sthData(size, r, ts))) };
}

/** Is this tree head signed by `ktKey` (raw Ed25519 public key, b64)? Never throws. */
export async function verifySth(sth: unknown, ktKey: string): Promise<boolean> {
  if (!isSth(sth)) return false;
  return ed25519Verify(ktKey, sthData(sth.size, sth.root, sth.ts), sth.sig);
}

function decodeProof(proof: unknown): Bytes[] {
  if (!Array.isArray(proof) || proof.length > 64) throw new P4Error("malformed", "bad proof");
  return proof.map((p) => unb64(p, 32));
}

/* -------------------------------------------------------------- lookup */

export type VerifiedEntry = { entry: KtEntry; index: number };

/**
 * § 14.3/14.4: checks a lookup against its own tree head: the head's
 * signature, every entry's user `u` (when given) and its inclusion proof.
 * (Its consistency with the heads seen before is `KtState.update`'s job.)
 */
export async function verifyLookup(lookup: unknown, ktKey: string, u?: string): Promise<{ ok: true; sth: SignedTreeHead; entries: VerifiedEntry[] } | { ok: false; why: "bad-signature" | "malformed" | "not-included" | "wrong-user" }> {
  const l = lookup as Partial<KtLookup> | null;
  if (!l || typeof l !== "object" || !Array.isArray(l.entries)) return { ok: false, why: "malformed" };
  if (!(await verifySth(l.sth, ktKey))) return { ok: false, why: "bad-signature" };
  const sth = l.sth as SignedTreeHead;
  const root = unb64(sth.root, 32);
  const entries: VerifiedEntry[] = [];
  for (const item of l.entries) {
    let leaf: Bytes;
    let path: Bytes[];
    try {
      if (!item || typeof item !== "object" || !isSafeCount(item.index)) throw new P4Error("malformed");
      leaf = await entryLeafHash(item.entry);
      path = decodeProof(item.proof);
    } catch {
      return { ok: false, why: "malformed" };
    }
    if (u !== undefined && item.entry.u !== u) return { ok: false, why: "wrong-user" };
    if (!(await verifyInclusion(leaf, item.index, sth.size, path, root))) return { ok: false, why: "not-included" };
    entries.push({ entry: item.entry, index: item.index });
  }
  return { ok: true, sth, entries };
}

/**
 * § 14.4: what the verified entries of one user say about account key `apk`
 * and device key `dpk`: the account key is the user's CURRENT one (the latest
 * `acct` entry), the device is certified (a `dev` entry not expired at `now`),
 * and no `rev` entry for it comes after its latest `dev` entry.
 */
export function deviceStatus(entries: readonly VerifiedEntry[], apk: string, dpk: string, now = Date.now()): { account: boolean; device: boolean; revoked: boolean; ok: boolean } {
  const sorted = [...entries].sort((a, b) => a.index - b.index);
  const accts = sorted.filter((e) => e.entry.t === "acct");
  const account = accts.length > 0 && accts[accts.length - 1].entry.apk === apk;
  const devs = sorted.filter((e) => e.entry.t === "dev" && e.entry.apk === apk && e.entry.dpk === dpk);
  const lastDev = devs[devs.length - 1];
  const device = Boolean(lastDev) && (lastDev.entry as Extract<KtEntry, { t: "dev" }>).exp > now;
  const revoked = sorted.some((e) => e.entry.t === "rev" && e.entry.apk === apk && e.entry.dpk === dpk && (!lastDev || e.index > lastDev.index));
  return { account, device, revoked, ok: account && device && !revoked };
}

/* --------------------------------------------------------------- state */

export type KtAlert = { kind: "inconsistent" | "split-view" | "key-changed"; at: number; detail: string };
export type KtOriginState = { key: string | null; sth: SignedTreeHead | null; alert: KtAlert | null };

/** Persistent per-origin state (the integrator stores it with the device's data). */
export interface KtStore {
  get(origin: string): Promise<KtOriginState | null>;
  set(origin: string, state: KtOriginState): Promise<void>;
}

export class MemoryKtStore implements KtStore {
  private readonly rows = new Map<string, KtOriginState>();
  async get(origin: string): Promise<KtOriginState | null> { const s = this.rows.get(origin); return s ? { ...s } : null; }
  async set(origin: string, state: KtOriginState): Promise<void> { this.rows.set(origin, { ...state }); }
}

export type KtUpdate =
  | { status: "ok"; sth: SignedTreeHead }
  | { status: "no-key" | "bad-signature" }
  | { status: "inconsistent"; alert: KtAlert };

export type KtGossip =
  | { status: "ok" }
  | { status: "unknown" }   // no pinned key or no head kept yet for this server
  | { status: "ignored" }   // not signed by this server's key
  | { status: "need-consistency"; from: number; to: number }
  | { status: "split-view"; alert: KtAlert };

/** Fetches `GET /api/kt/consistency?from=&to=`. */
export type ConsistencyFetcher = (from: number, to: number) => Promise<KtConsistency>;

const empty = (): KtOriginState => ({ key: null, sth: null, alert: null });

export class KtState {
  private readonly mutex = new Mutex();

  constructor(private readonly store: KtStore = new MemoryKtStore(), private readonly clock: () => number = () => Date.now()) {}

  private async load(origin: string): Promise<KtOriginState> {
    return (await this.store.get(origin)) ?? empty();
  }

  private async raise(origin: string, st: KtOriginState, kind: KtAlert["kind"], detail: string): Promise<KtAlert> {
    const alert: KtAlert = { kind, at: this.clock(), detail };
    // The first alert stays (persistent) until the user deals with it.
    await this.store.set(origin, { ...st, alert: st.alert ?? alert });
    return st.alert ?? alert;
  }

  /** § 14.2: pins the server's KT key on first use. A different key later is an alert; the pin stays. */
  pinKey(origin: string, key: string): Promise<"new" | "match" | "changed"> {
    return this.mutex.run(async () => {
      unb64(key, 32);
      const st = await this.load(origin);
      if (!st.key) { await this.store.set(origin, { ...st, key }); return "new"; }
      if (st.key === key) return "match";
      await this.raise(origin, st, "key-changed", "the server's key-transparency key changed");
      return "changed";
    });
  }

  async newest(origin: string): Promise<SignedTreeHead | null> { return (await this.load(origin)).sth; }
  async alert(origin: string): Promise<KtAlert | null> { return (await this.load(origin)).alert; }

  /** Clears the alert after the user saw it (the evidence stays in their hands, not here). */
  async dismissAlert(origin: string): Promise<void> {
    await this.mutex.run(async () => { const st = await this.load(origin); await this.store.set(origin, { ...st, alert: null }); });
  }

  /** § 14.4: a tree head from the server. Kept when newer and consistent; a rewritten history raises the alert. */
  update(origin: string, sth: unknown, fetchConsistency: ConsistencyFetcher): Promise<KtUpdate> {
    return this.mutex.run(async () => {
      const st = await this.load(origin);
      if (!st.key) return { status: "no-key" as const };
      if (!(await verifySth(sth, st.key))) return { status: "bad-signature" as const };
      const head = sth as SignedTreeHead;
      const kept = st.sth;
      if (!kept) {
        await this.store.set(origin, { ...st, sth: head });
        return { status: "ok" as const, sth: head };
      }
      if (head.size === kept.size) {
        if (head.root !== kept.root) return { status: "inconsistent" as const, alert: await this.raise(origin, st, "inconsistent", `two roots for tree size ${head.size}`) };
        if (head.ts > kept.ts) await this.store.set(origin, { ...st, sth: head });
        return { status: "ok" as const, sth: head };
      }
      const [small, big] = head.size < kept.size ? [head, kept] : [kept, head];
      if (!(await consistent(small, big, fetchConsistency))) {
        return { status: "inconsistent" as const, alert: await this.raise(origin, st, "inconsistent", `tree ${small.size} is not a prefix of tree ${big.size}`) };
      }
      if (head.size > kept.size) await this.store.set(origin, { ...st, sth: head });
      return { status: "ok" as const, sth: head };
    });
  }

  /** § 14.4 gossip: a peer's tree head (from its hello) compared with ours. */
  gossip(origin: string, peerSth: unknown): Promise<KtGossip> {
    return this.mutex.run(async () => {
      const st = await this.load(origin);
      if (!st.key || !st.sth) return { status: "unknown" as const };
      if (!(await verifySth(peerSth, st.key))) return { status: "ignored" as const };
      const peer = peerSth as SignedTreeHead;
      if (peer.size === st.sth.size) {
        if (peer.root === st.sth.root) return { status: "ok" as const };
        return { status: "split-view" as const, alert: await this.raise(origin, st, "split-view", `a peer saw another root for tree size ${peer.size}`) };
      }
      return { status: "need-consistency" as const, from: Math.min(peer.size, st.sth.size), to: Math.max(peer.size, st.sth.size) };
    });
  }

  /** Finishes a `need-consistency` gossip with the server's proof; a newer consistent peer head becomes ours. */
  resolveGossip(origin: string, peerSth: unknown, fetchConsistency: ConsistencyFetcher): Promise<KtGossip> {
    return this.mutex.run(async () => {
      const st = await this.load(origin);
      if (!st.key || !st.sth) return { status: "unknown" as const };
      if (!(await verifySth(peerSth, st.key))) return { status: "ignored" as const };
      const peer = peerSth as SignedTreeHead;
      const kept = st.sth;
      if (peer.size === kept.size) {
        if (peer.root === kept.root) return { status: "ok" as const };
        return { status: "split-view" as const, alert: await this.raise(origin, st, "split-view", `a peer saw another root for tree size ${peer.size}`) };
      }
      const [small, big] = peer.size < kept.size ? [peer, kept] : [kept, peer];
      if (!(await consistent(small, big, fetchConsistency))) {
        return { status: "split-view" as const, alert: await this.raise(origin, st, "split-view", `a peer's tree ${peer.size} is not consistent with ours (${kept.size})`) };
      }
      if (peer.size > kept.size) await this.store.set(origin, { ...st, sth: peer });
      return { status: "ok" as const };
    });
  }

  /** A lookup: its head goes through `update` first, then inclusion of every entry. */
  async lookup(origin: string, lookup: KtLookup, u: string, fetchConsistency: ConsistencyFetcher): Promise<{ ok: true; entries: VerifiedEntry[] } | { ok: false; why: string }> {
    const upd = await this.update(origin, lookup?.sth, fetchConsistency);
    if (upd.status !== "ok") return { ok: false, why: upd.status };
    const key = (await this.load(origin)).key!;
    const checked = await verifyLookup(lookup, key, u);
    return checked.ok ? { ok: true, entries: checked.entries } : { ok: false, why: checked.why };
  }
}

/** Is `small` a prefix of `big`? (Both already signature-checked; sizes differ.) */
async function consistent(small: SignedTreeHead, big: SignedTreeHead, fetchConsistency: ConsistencyFetcher): Promise<boolean> {
  if (small.size === 0) return true; // the empty tree is a prefix of every tree
  const answer = await fetchConsistency(small.size, big.size);
  try {
    if (!answer || answer.from !== small.size || answer.to !== big.size) return false;
    return await verifyConsistency(small.size, big.size, unb64(small.root, 32), unb64(big.root, 32), decodeProof(answer.proof));
  } catch {
    return false;
  }
}
