// The pair ratchet of protocol 4 (docs/protocol-v4.md § 5): a Double Ratchet
// (P-256 DH steps + HMAC chains) whose DH steps also run an ML-KEM-768 step,
// carried in the headers — the post-quantum half of post-compromise security.
//
//   KDF_RK(rk, dhOut, kss) = HKDF(salt = rk, ikm = dhOut || kss, "m5cet/p4/rk", 64)
//   KDF_CK(ck)             = (mk = HMAC(ck, 0x01), ck' = HMAC(ck, 0x02))
//   keyIv(mk, label)       = HKDF(32 zero bytes, mk, label, 44) → key, iv
//
// A sending chain's first message (n = 0) announces the sender's current KEM
// key (`kek`) and, when the DH step that started the chain encapsulated to the
// peer's announced key, the KEM ciphertext (`kid`, `kct`). The receiver mixes
// the decapsulated secret into the root key at the same step.
//
// Robustness rules this file enforces:
//   * COPY-ON-WRITE. A frame is processed on a copy of the state; the copy is
//     committed only after the AEAD check passed. A forged, replayed or
//     corrupted frame changes nothing (and the secrets the attempt derived are
//     wiped). Old chain / root keys are wiped when a commit replaces them.
//   * Failures are RETURNED, not thrown: `{ ok: false, error, reset }`.
//     `reset` is true on the second failure in the session or for a KEM
//     ciphertext that cannot be decapsulated (§ 5.5) — the caller then sends
//     `p4-reset`, discards the session (`wipe()`) and sends a new hello.
//   * One operation at a time (a mutex): encrypt and decrypt may be called
//     from concurrent event handlers.
//   * Skipped keys (§ 5.6): at most MAX_SKIP per chain and MAX_SKIPPED_TOTAL
//     per session, oldest dropped first; a header that would skip more fails.
//
// Sessions live per data channel, in memory only: there is no serialisation.

import { KEM, LABEL, MAX_SKIP, MAX_SKIPPED_TOTAL, type RatchetFrame, type RatchetHeader, type RatchetInner } from "./contract";
import { kemDecaps, kemEncaps, kemKeygen, kemKid } from "./kem";
import { pad, unpad } from "./pad";
import {
  aesGcmOpen, aesGcmSeal, b64, concat, copy, ecdh, fromUtf8, hB64, hkdf, hmac, isSafeCount, join, keyIv, Mutex, P4Error,
  unb64, utf8, wipe, type Bytes, type P256Pair, type P4ErrorCode,
} from "./primitives";
import { systemRng, type Rng } from "./rng";

/* --------------------------------------------------------------- KDFs */

/** § 5.1 KDF_RK; `kss` is the KEM shared secret or null (0 bytes). */
export async function kdfRk(rk: Uint8Array, dhOut: Uint8Array, kss: Uint8Array | null): Promise<{ rk: Bytes; ck: Bytes }> {
  const ikm = kss ? concat(dhOut, kss) : copy(dhOut);
  const okm = await hkdf(rk, ikm, LABEL.ratchet, 64);
  const out = { rk: okm.slice(0, 32), ck: okm.slice(32, 64) };
  wipe(ikm, okm);
  return out;
}

const ONE = new Uint8Array([0x01]);
const TWO = new Uint8Array([0x02]);

/** § 5.1 KDF_CK. */
export async function kdfCk(ck: Uint8Array): Promise<{ mk: Bytes; ck: Bytes }> {
  const [mk, next] = await Promise.all([hmac(ck, ONE), hmac(ck, TWO)]);
  return { mk, ck: next };
}

/** § 5.2 header transcript Hs, as its parts (spliced into the AAD join). */
export async function headerParts(h: RatchetHeader): Promise<Array<string | number>> {
  return [
    h.dh, h.pn, h.n, h.kid ?? "-",
    h.kct ? await hB64(unb64(h.kct)) : "-",
    h.kek ? await hB64(unb64(h.kek)) : "-",
  ];
}

/** § 5.2 AAD = join(LABEL.pairAad, roomId, from, to, b64(TH), Hs). */
export async function pairAad(roomId: string, from: string, to: string, th: Uint8Array, h: RatchetHeader): Promise<Bytes> {
  return join(LABEL.pairAad, roomId, from, to, b64(th), ...(await headerParts(h)));
}

/* -------------------------------------------------------------- state */

type KemKeys = { ek: Bytes; dk: Bytes; ekB64: string; kid: string };
type Skipped = { chain: string; mk: Bytes };

type State = {
  rk: Bytes;
  dhs: P256Pair;
  dhr: string | null;
  cks: Bytes;
  ckr: Bytes | null;
  ns: number;
  nr: number;
  pn: number;
  /** Own KEM key pairs, oldest first; the last is the current one (announced as `kek`). At most 3. */
  myKem: KemKeys[];
  /** The peer's announced KEM key not yet encapsulated to (b64). */
  peerKem: string | null;
  /** The peer key the last sending step encapsulated to (a re-announcement of it is ignored). */
  usedPeerKem: string | null;
  /** kid / kct of the step that started the current sending chain, sent with its n = 0. */
  pendingKct: { kid: string; kct: string } | null;
  /** Skipped message keys by `${dh}|${n}`, oldest first. */
  skipped: Map<string, Skipped>;
  /** Skipped keys per receiving chain (by its dh). */
  perChain: Map<string, number>;
};

const KEEP_KEMS = 3;

function cloneState(s: State): State {
  return { ...s, myKem: [...s.myKem], skipped: new Map(s.skipped), perChain: new Map(s.perChain) };
}

/** Every secret byte array a state references (to wipe what a commit leaves behind). */
function secretsOf(s: State): Set<Uint8Array> {
  const out = new Set<Uint8Array>([s.rk, s.cks]);
  if (s.ckr) out.add(s.ckr);
  for (const k of s.myKem) out.add(k.dk);
  for (const v of s.skipped.values()) out.add(v.mk);
  return out;
}

async function newKem(rng: Rng, what: string): Promise<KemKeys> {
  const { ek, dk } = kemKeygen(rng, what);
  return { ek, dk, ekB64: b64(ek), kid: await kemKid(ek) };
}

/* ------------------------------------------------------------ results */

export type RatchetFailure = { ok: false; error: P4ErrorCode; reset: boolean; message: string };
export type RatchetOpened = { ok: true; inner: RatchetInner };
export type RatchetResult = RatchetOpened | RatchetFailure;

export type RatchetRole = "A" | "B";

export type RatchetInit = {
  role: RatchetRole;
  roomId: string;
  selfPeerId: string;
  peerPeerId: string;
  /** The session transcript hash (§ 4). */
  th: Uint8Array;
  rk0: Uint8Array;
  ckB0: Uint8Array;
  /** A: B's hello `e` (A's first DHr). */
  peerE: string;
  /** B: its own hello `e` key pair (B's first DHs). */
  ownE?: P256Pair;
  rng?: Rng;
};

/** Counters and public keys, for tests and diagnostics (no secrets). */
export type RatchetInfo = {
  role: RatchetRole; ns: number; nr: number; pn: number; dhs: string; dhr: string | null;
  skipped: number; kemKeys: number; peerKem: boolean; failures: number; wiped: boolean;
};

const KID_RE = /^[A-Za-z0-9_-]{16}$/;

type Parsed = { h: RatchetHeader; ct: Bytes; kct: Bytes | null };

/* ------------------------------------------------------------ ratchet */

export class Ratchet {
  private failures = 0;
  private wiped = false;
  private readonly mutex = new Mutex();
  private readonly rng: Rng;
  private readonly th: Bytes;

  private constructor(private state: State, readonly role: RatchetRole, private readonly init: Omit<RatchetInit, "rk0" | "ckB0" | "ownE" | "rng" | "th">, th: Uint8Array, rng: Rng) {
    this.rng = rng;
    this.th = copy(th);
  }

  /** § 4: the initial state for role A or B. Draws (A): "init.dhs", "init.kem-seed"; (B): "init.kem-seed". */
  static async create(init: RatchetInit): Promise<Ratchet> {
    const rng = init.rng ?? systemRng;
    const base = { role: init.role, roomId: init.roomId, selfPeerId: init.selfPeerId, peerPeerId: init.peerPeerId, peerE: init.peerE };
    if (init.rk0.length !== 32 || init.ckB0.length !== 32) throw new P4Error("malformed", "root and chain keys are 32 bytes");
    let state: State;
    if (init.role === "A") {
      const dhs = await rng.p256("ecdh", "init.dhs");
      const myKem = await newKem(rng, "init.kem-seed");
      const dhOut = await ecdh(dhs.privateKey, init.peerE);
      const { rk, ck } = await kdfRk(init.rk0, dhOut, null);
      wipe(dhOut);
      state = {
        rk, dhs, dhr: init.peerE, cks: ck, ckr: copy(init.ckB0), ns: 0, nr: 0, pn: 0,
        myKem: [myKem], peerKem: null, usedPeerKem: null, pendingKct: null, skipped: new Map(), perChain: new Map(),
      };
    } else {
      if (!init.ownE) throw new P4Error("state", "role B needs its hello key pair");
      const myKem = await newKem(rng, "init.kem-seed");
      state = {
        rk: copy(init.rk0), dhs: init.ownE, dhr: null, cks: copy(init.ckB0), ckr: null, ns: 0, nr: 0, pn: 0,
        myKem: [myKem], peerKem: null, usedPeerKem: null, pendingKct: null, skipped: new Map(), perChain: new Map(),
      };
    }
    return new Ratchet(state, init.role, base, init.th, rng);
  }

  info(): RatchetInfo {
    const s = this.state;
    return {
      role: this.role, ns: s.ns, nr: s.nr, pn: s.pn, dhs: s.dhs.spki, dhr: s.dhr, skipped: s.skipped.size,
      kemKeys: s.myKem.length, peerKem: s.peerKem !== null, failures: this.failures, wiped: this.wiped,
    };
  }

  /* ---------------------------------------------------------- sending */

  /** § 5.2: seals one inner message (a JSON object with a string `t`). */
  encrypt(inner: RatchetInner): Promise<RatchetFrame> {
    return this.mutex.run(async () => {
      if (this.wiped) throw new P4Error("state", "session wiped");
      if (!inner || typeof inner !== "object" || Array.isArray(inner) || typeof inner.t !== "string") throw new P4Error("malformed", "inner message needs a type t");
      const s = this.state;
      const h: RatchetHeader = { dh: s.dhs.spki, pn: s.pn, n: s.ns };
      if (s.ns === 0) {
        if (s.pendingKct) { h.kid = s.pendingKct.kid; h.kct = s.pendingKct.kct; }
        h.kek = s.myKem[s.myKem.length - 1].ekB64;
      }
      const { mk, ck } = await kdfCk(s.cks);
      const aad = await pairAad(this.init.roomId, this.init.selfPeerId, this.init.peerPeerId, this.th, h);
      const { key, iv } = await keyIv(mk, LABEL.pairKey);
      const plain = pad(utf8(JSON.stringify(inner)));
      let c: Bytes;
      try { c = await aesGcmSeal(key, iv, aad, plain); } finally { wipe(mk, key, iv, plain); }
      const old = s.cks;
      s.cks = ck;
      s.ns += 1;
      if (h.n === 0) s.pendingKct = null;
      wipe(old);
      return { kind: "p4", v: 4, h, c: b64(c) };
    });
  }

  /* -------------------------------------------------------- receiving */

  /** § 5.4: opens one frame. Never throws; a failure says whether to reset (§ 5.5). */
  decrypt(frame: unknown): Promise<RatchetResult> {
    return this.mutex.run(async () => {
      if (this.wiped) return { ok: false as const, error: "state" as const, reset: true, message: "session wiped" };
      try {
        return { ok: true as const, inner: await this.open(frame) };
      } catch (error) {
        const code: P4ErrorCode = error instanceof P4Error ? error.code : "malformed";
        this.failures += 1;
        return { ok: false as const, error: code, reset: code === "kct" || this.failures >= 2, message: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  private parse(frame: unknown): Parsed {
    const f = frame as Partial<RatchetFrame> | null;
    if (!f || typeof f !== "object" || f.kind !== "p4" || f.v !== 4 || !f.h || typeof f.h !== "object") throw new P4Error("malformed", "not a p4 frame");
    const raw = f.h as Partial<RatchetHeader>;
    if (typeof raw.dh !== "string" || !isSafeCount(raw.pn) || !isSafeCount(raw.n)) throw new P4Error("malformed", "bad header");
    const h: RatchetHeader = { dh: raw.dh, pn: raw.pn, n: raw.n };
    unb64(h.dh); // canonical base64 (the key itself is checked when it is used)
    if ((raw.kid === undefined) !== (raw.kct === undefined)) throw new P4Error("malformed", "kid and kct go together");
    let kct: Bytes | null = null;
    if (raw.kid !== undefined) {
      if (typeof raw.kid !== "string" || !KID_RE.test(raw.kid)) throw new P4Error("malformed", "bad kid");
      try { kct = unb64(raw.kct, KEM.ct); } catch { throw new P4Error("kct", "KEM ciphertext cannot be decapsulated"); }
      h.kid = raw.kid;
      h.kct = raw.kct as string;
    }
    if (raw.kek !== undefined) { unb64(raw.kek, KEM.ek); h.kek = raw.kek; }
    const ct = unb64(f.c);
    if (ct.length < 16) throw new P4Error("malformed", "ciphertext too short");
    return { h, ct, kct };
  }

  private async open(frame: unknown): Promise<RatchetInner> {
    const { h, ct, kct } = this.parse(frame);
    const aad = await pairAad(this.init.roomId, this.init.peerPeerId, this.init.selfPeerId, this.th, h);
    const old = this.state;

    // 1. A stored skipped key: use it, delete it. (A `kek` here is ignored: § 5.4, it is not newer than what was seen.)
    const slot = `${h.dh}|${h.n}`;
    const kept = old.skipped.get(slot);
    if (kept) {
      const plain = await openWith(kept.mk, aad, ct);
      const next = cloneState(old);
      dropSkipped(next, slot);
      this.commit(next, []);
      return parseInner(plain);
    }

    const w = cloneState(old);
    const fresh: Uint8Array[] = [];
    let committed = false;
    try {
      if (h.dh !== w.dhr) {
        // 2. A new chain from the peer.
        await skipTo(w, h.pn, fresh);                                              // 2.1
        let kss: Bytes | null = null;
        if (h.kct !== undefined) {                                                  // 2.2
          const mine = w.myKem.find((k) => k.kid === h.kid);
          if (!mine) throw new P4Error("kct", "KEM ciphertext for an unknown key");
          kss = kemDecaps(kct!, mine.dk);
          fresh.push(kss);
        }
        const dhOut = await ecdh(w.dhs.privateKey, h.dh);                         // 2.3
        fresh.push(dhOut);
        const r = await kdfRk(w.rk, dhOut, kss);
        fresh.push(r.rk, r.ck);
        w.rk = r.rk; w.ckr = r.ck; w.pn = w.ns; w.ns = 0; w.nr = 0; w.dhr = h.dh;
        if (h.kek !== undefined) takeKek(w, h.kek);                                 // 3 (before 2.4)
        await this.sendingStep(w, fresh);                                           // 2.4
      } else if (h.kek !== undefined) {
        takeKek(w, h.kek);                                                          // 3
      }
      if (!w.ckr) throw new P4Error("malformed", "no receiving chain");
      if (h.n < w.nr) throw new P4Error("replay", "message key already used");
      await skipTo(w, h.n, fresh);                                                  // 4
      const { mk, ck } = await kdfCk(w.ckr);
      fresh.push(mk, ck);
      w.ckr = ck;
      w.nr += 1;
      const plain = await openWith(mk, aad, ct);
      this.commit(w, fresh);
      committed = true;
      return parseInner(plain);
    } finally {
      if (!committed) {
        // Nothing of this attempt survives: wipe what it derived.
        const live = secretsOf(old);
        for (const b of fresh) if (!live.has(b)) wipe(b);
        for (const b of secretsOf(w)) if (!live.has(b)) wipe(b);
      }
    }
  }

  /** § 5.3 sending ratchet step. Draws: "ratchet.dhs", ["ratchet.kem-m" when encapsulating], "ratchet.kem-seed". */
  private async sendingStep(w: State, fresh: Uint8Array[]): Promise<void> {
    w.dhs = await this.rng.p256("ecdh", "ratchet.dhs");
    let kss: Bytes | null = null;
    w.pendingKct = null;
    if (w.peerKem) {
      const ek = unb64(w.peerKem, KEM.ek);
      const { ct, ss } = kemEncaps(ek, this.rng, "ratchet.kem-m");
      kss = ss;
      fresh.push(ss);
      w.pendingKct = { kid: await kemKid(ek), kct: b64(ct) };
      w.usedPeerKem = w.peerKem;
      w.peerKem = null;
    }
    const mine = await newKem(this.rng, "ratchet.kem-seed");
    fresh.push(mine.dk);
    w.myKem = [...w.myKem, mine].slice(-KEEP_KEMS);
    const dhOut = await ecdh(w.dhs.privateKey, w.dhr!);
    fresh.push(dhOut);
    const r = await kdfRk(w.rk, dhOut, kss);
    fresh.push(r.rk, r.ck);
    w.rk = r.rk;
    w.cks = r.ck;
  }

  /** Makes `next` the state; wipes every secret neither it nor the old state still needs. */
  private commit(next: State, fresh: Uint8Array[]): void {
    const live = secretsOf(next);
    for (const b of secretsOf(this.state)) if (!live.has(b)) wipe(b);
    for (const b of fresh) if (!live.has(b)) wipe(b);
    this.state = next;
  }

  /** Forgets every secret of the session. */
  wipe(): void {
    if (this.wiped) return;
    this.wiped = true;
    for (const b of secretsOf(this.state)) wipe(b);
    wipe(this.th);
    this.state.skipped.clear();
  }
}

/* ------------------------------------------------------------ helpers */

async function openWith(mk: Uint8Array, aad: Uint8Array, ct: Uint8Array): Promise<Bytes> {
  const { key, iv } = await keyIv(mk, LABEL.pairKey);
  try { return await aesGcmOpen(key, iv, aad, ct); } finally { wipe(key, iv); }
}

function takeKek(w: State, kek: string): void {
  if (kek !== w.usedPeerKem) w.peerKem = kek;
}

/** Stores the keys of the current receiving chain from Nr up to (not including) `until`. */
async function skipTo(w: State, until: number, fresh: Uint8Array[]): Promise<void> {
  if (!w.ckr || !w.dhr || until <= w.nr) return;
  if (until - w.nr > MAX_SKIP) throw new P4Error("skip", "too many skipped messages");
  while (w.nr < until) {
    const { mk, ck } = await kdfCk(w.ckr);
    fresh.push(mk, ck);
    storeSkipped(w, w.dhr, w.nr, mk);
    w.ckr = ck;
    w.nr += 1;
  }
}

function storeSkipped(w: State, chain: string, n: number, mk: Bytes): void {
  const count = w.perChain.get(chain) ?? 0;
  if (count >= MAX_SKIP) {
    for (const [slot, v] of w.skipped) if (v.chain === chain) { dropSkipped(w, slot); break; }
  }
  w.skipped.set(`${chain}|${n}`, { chain, mk });
  w.perChain.set(chain, (w.perChain.get(chain) ?? 0) + 1);
  while (w.skipped.size > MAX_SKIPPED_TOTAL) dropSkipped(w, w.skipped.keys().next().value!);
}

function dropSkipped(w: State, slot: string): void {
  const v = w.skipped.get(slot);
  if (!v) return;
  w.skipped.delete(slot);
  const left = (w.perChain.get(v.chain) ?? 1) - 1;
  if (left > 0) w.perChain.set(v.chain, left); else w.perChain.delete(v.chain);
}

/** unpad, strict UTF-8, JSON, an object with a string `t`. */
export function parseInner(padded: Uint8Array): RatchetInner {
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(unpad(padded)));
  } catch {
    throw new P4Error("malformed", "inner message is not padded JSON");
  } finally {
    wipe(padded);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { t?: unknown }).t !== "string") throw new P4Error("malformed", "inner message needs a type t");
  return value as RatchetInner;
}
