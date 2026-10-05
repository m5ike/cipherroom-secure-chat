// Room messages in protocol 4 (docs/protocol-v4.md § 6): sender keys with a
// per-chain signing key.
//
// As in protocol 3 (sender-keys.ts) each sender ratchets its own chain
//     (mk, CK) = KDF_CK(CK)
// and hands the CURRENT chain to each peer — now only inside the pair
// ratchet (an `sk` inner message). What protocol 3 lacked: every member who
// holds a chain can derive its message keys, so one of them could forge a
// message "from" its owner, or send garbage at a high index and make
// everyone burn the keys in between. Protocol 4 gives each chain its own
// ECDSA P-256 key pair: the owner signs AAD || ciphertext, the public half
// (`spk`) travels with the chain, and a receiver verifies the signature
// BEFORE it advances the chain. The signing key is per chain and ephemeral,
// not the device key: messages are authentic to the members, yet carry no
// signature a third party could tie to the device (F-30).
//
// Every member holds every chain, so one could re-announce another member's
// chain as its own and relay that member's validly signed messages under its
// own name. Each chain therefore carries `cert`: the chain's OWN signing key
// signs (roomId, keyId, owner's device key) once, when the chain is made. A
// receiver checks it with the chain's `spk` against the hello `pk` of the pair
// session that delivered the chain, and refuses the chain without a valid one.
// Only the holder of the spk's private half can name an owner, so a chain
// re-announced by anyone else fails — whatever order the chains arrive in.
// (A device signature over the spk would not do: anyone can sign any spk.)
// The device key signs nothing here, so nothing a third party could check
// ties a message to the device: anyone can make an spk that names a device.
//
// Chains are found by (sending peer, keyId) — a member cannot plant a chain
// under another member's id (6.7 audit S18). Each peer keeps its newest
// chain and ONE older (messages in flight across a rotation).

import { LABEL, MAX_SKIP, SENDER_KEY_ROTATE, type SenderKeyEnvelope } from "./contract";
import { pad, unpad } from "./pad";
import {
  aesGcmOpen, aesGcmSeal, b64, b64url, concat, ecdsaSign, ecdsaVerify, fromUtf8, isP256Spki, isSafeCount, join, keyIv,
  Mutex, P4Error, unb64, unb64url, utf8, wipe, type Bytes, type P256Pair,
} from "./primitives";
import { kdfCk } from "./ratchet";
import { systemRng, type Rng } from "./rng";
import type { Signer } from "../envelope";

/** The `sk` inner message of the pair ratchet (§ 5.7). */
export type SkInner = { t: "sk"; keyId: string; chain: string; index: number; spk: string; cert: string };

type OwnChain = { keyId: string; ck: Bytes; index: number; createdAt: number; sign: P256Pair; cert: string };
type PeerChain = { owner: string; ownerPk: string; keyId: string; ck: Bytes; index: number; spk: string; skipped: Map<number, Bytes> };

const chainSlot = (owner: string, keyId: string) => `${owner}\u0000${keyId}`;

/** § 6 AAD = join(LABEL.senderKey, roomId, id, keyId, n). */
export const senderKeyAad = (roomId: string, id: string, keyId: string, n: number): Bytes => join(LABEL.senderKey, roomId, id, keyId, n);

/** § 6: what a chain's `cert` signs (with the chain's spk) — join(LABEL.skCert, roomId, keyId, ownerPk). */
export const skCertData = (roomId: string, keyId: string, ownerPk: string): Bytes => join(LABEL.skCert, roomId, keyId, ownerPk);

const hasId = (payload: unknown, id: string) => Boolean(payload) && typeof payload === "object" && (payload as { id?: unknown }).id === id;

/** The `Signer` a protocol-4 message gets (§ 6): the hello's device key, valid; the account when attested. */
export function p4Signer(helloPk: string, account?: { publicKey: string; valid: boolean } | null): Signer {
  return account ? { publicKey: helloPk, valid: true, account: { publicKey: account.publicKey, valid: account.valid } } : { publicKey: helloPk, valid: true };
}

export class SenderKeys4 {
  private own: OwnChain | null = null;
  private readonly chains = new Map<string, PeerChain>();
  /** Peers that hold our current chain. */
  private readonly sentTo = new Set<string>();
  private readonly mutex = new Mutex();
  private readonly rng: Rng;

  /** `owner`: this device (its hello `pk`; the protocol-3 Identity fits) — every chain names it in its `cert`. */
  constructor(private readonly roomId: string, private readonly owner: { publicKey: string }, opts: { rng?: Rng } = {}) {
    this.rng = opts.rng ?? systemRng;
  }

  /* -------------------------------------------------------- own chain */

  /** Is our chain missing or due for replacement (SENDER_KEY_ROTATE)? */
  due(now = Date.now()): boolean {
    return !this.own || this.own.index >= SENDER_KEY_ROTATE.messages || now - this.own.createdAt >= SENDER_KEY_ROTATE.ms;
  }

  /**
   * Starts a new chain when there is none or it is due; true when it did (then
   * nobody holds it yet). Call before handing the chain out and before sealing.
   * Draws: "sk.keyId", "sk.chain", "sk.spk"; the new spk signs the chain's `cert`.
   */
  prepare(now = Date.now()): Promise<boolean> {
    return this.mutex.run(async () => {
      if (!this.due(now)) return false;
      const keyId = b64url(this.rng.bytes(12, "sk.keyId"));
      const ck = this.rng.bytes(32, "sk.chain");
      const sign = await this.rng.p256("ecdsa", "sk.spk");
      const cert = await ecdsaSign(sign.privateKey, skCertData(this.roomId, keyId, this.owner.publicKey));
      if (this.own) wipe(this.own.ck);
      this.own = { keyId, ck, index: 0, createdAt: now, sign, cert };
      this.sentTo.clear();
      return true;
    });
  }

  /** Drops our chain; the next `prepare()` starts a new one (a member left, was excluded, …). */
  rotate(): void {
    if (this.own) wipe(this.own.ck);
    this.own = null;
    this.sentTo.clear();
  }

  /** The current chain as an `sk` inner message for `peerId` — from its current index, nothing before. */
  chainFor(peerId: string): SkInner {
    const own = this.own;
    if (!own) throw new P4Error("state", "no chain: call prepare() first");
    this.sentTo.add(peerId);
    return { t: "sk", keyId: own.keyId, chain: b64(own.ck), index: own.index, spk: own.sign.spki, cert: own.cert };
  }

  hasOurChain(peerId: string): boolean {
    return Boolean(this.own) && this.sentTo.has(peerId);
  }

  get currentKeyId(): string | null { return this.own?.keyId ?? null; }

  /** § 6: seals a room message with our current chain (`payload.id` must be `id`). */
  seal(id: string, payload: unknown): Promise<SenderKeyEnvelope> {
    return this.mutex.run(async () => {
      const own = this.own;
      if (!own) throw new P4Error("state", "no chain: call prepare() first");
      if (!hasId(payload, id)) throw new P4Error("id-mismatch", "payload.id must be the message id");
      const n = own.index;
      const aad = senderKeyAad(this.roomId, id, own.keyId, n);
      const { mk, ck } = await kdfCk(own.ck);
      const { key, iv } = await keyIv(mk, LABEL.senderKey);
      const plain = pad(utf8(JSON.stringify(payload)));
      let c: Bytes;
      try { c = await aesGcmSeal(key, iv, aad, plain); } finally { wipe(mk, key, iv, plain); }
      const s = await ecdsaSign(own.sign.privateKey, concat(aad, c));
      wipe(own.ck);
      own.ck = ck;
      own.index = n + 1;
      return { v: 4, id, sk: own.keyId, n, c: b64(c), s };
    });
  }

  /* ------------------------------------------------------ peer chains */

  /**
   * A peer's chain from its `sk` inner message, delivered by the pair session
   * with `peerId` whose hello carried device key `peerPk`. Refused (false)
   * unless `cert` is the chain spk's signature over (roomId, keyId, peerPk).
   */
  acceptChain(peerId: string, peerPk: string, raw: unknown): Promise<boolean> {
    return this.mutex.run(async () => {
      const m = raw as Partial<SkInner> | null;
      if (!m || typeof m !== "object" || m.t !== "sk" || typeof m.keyId !== "string" || !isSafeCount(m.index) || typeof m.spk !== "string" || typeof m.cert !== "string") return false;
      let ck: Bytes;
      try { unb64url(m.keyId, 12); ck = unb64(m.chain, 32); } catch { return false; }
      if (!(await isP256Spki(m.spk))) return false;
      let certified = false;
      try { certified = typeof peerPk === "string" && await ecdsaVerify(m.spk, skCertData(this.roomId, m.keyId, peerPk), m.cert); } catch { certified = false; }
      if (!certified) { wipe(ck); return false; }
      // Defence in depth: a signing key already held for another owner device is refused too (the cert
      // makes that impossible; the same device under a new peer id is fine). Not the key id: anyone may
      // pick any key id for a chain of its own, and chains are kept per (peer, keyId) anyway.
      for (const c of this.chains.values()) if (c.spk === m.spk && c.ownerPk !== peerPk) { wipe(ck); return false; }
      const slot = chainSlot(peerId, m.keyId);
      const prev = this.chains.get(slot);
      if (prev) this.forget(prev);
      this.chains.set(slot, { owner: peerId, ownerPk: peerPk, keyId: m.keyId, ck, index: m.index, spk: m.spk, skipped: new Map() }); // last = newest
      const older = [...this.chains.values()].filter((c) => c.owner === peerId && c.keyId !== m.keyId);
      for (const old of older.slice(0, -1)) this.forget(old); // grace for ONE older chain
      return true;
    });
  }

  /**
   * § 6: opens a peer's room message. The signature is verified before the
   * chain moves; the chain moves only when the message decrypts. Throws
   * `malformed`, `no-chain`, `signature`, `replay`, `skip`, `aead`, `id-mismatch`.
   */
  open<T>(peerId: string, raw: unknown): Promise<T> {
    return this.mutex.run(async () => {
      const e = raw as Partial<SenderKeyEnvelope> | null;
      if (!e || typeof e !== "object" || e.v !== 4 || typeof e.id !== "string" || !e.id || typeof e.sk !== "string" || !isSafeCount(e.n) || typeof e.c !== "string" || typeof e.s !== "string") {
        throw new P4Error("malformed", "not a protocol-4 sender-key message");
      }
      const chain = this.chains.get(chainSlot(peerId, e.sk));
      if (!chain) throw new P4Error("no-chain", "no chain for this sender and key id");
      const n = e.n;
      const aad = senderKeyAad(this.roomId, e.id, e.sk, n);
      const c = unb64(e.c);
      if (!(await ecdsaVerify(chain.spk, concat(aad, c), e.s))) throw new P4Error("signature", "not signed by the chain's key");

      // Derive on the side; the chain changes only after the AEAD check.
      let mk: Bytes;
      let nextCk: Bytes | null = null;
      const skippedNow: Array<[number, Bytes]> = [];
      const fresh: Bytes[] = [];
      const kept = chain.skipped.get(n);
      if (kept) {
        mk = kept;
      } else {
        if (n < chain.index) throw new P4Error("replay", "message key already used");
        if (n - chain.index > MAX_SKIP) throw new P4Error("skip", "too far ahead");
        let ck = chain.ck;
        for (let i = chain.index; i < n; i++) {
          const step = await kdfCk(ck);
          skippedNow.push([i, step.mk]);
          if (ck !== chain.ck) fresh.push(ck);
          ck = step.ck;
        }
        const last = await kdfCk(ck);
        if (ck !== chain.ck) fresh.push(ck);
        mk = last.mk;
        nextCk = last.ck;
      }
      const { key, iv } = await keyIv(mk, LABEL.senderKey);
      let plain: Bytes;
      try {
        plain = await aesGcmOpen(key, iv, aad, c);
      } catch (error) {
        if (!kept) { wipe(mk, nextCk, ...fresh); for (const [, k] of skippedNow) wipe(k); }
        throw error;
      } finally {
        wipe(key, iv);
      }
      // Commit.
      if (kept) {
        chain.skipped.delete(n);
      } else {
        wipe(chain.ck, ...fresh);
        chain.ck = nextCk!;
        chain.index = n + 1;
        for (const [i, k] of skippedNow) chain.skipped.set(i, k);
        while (chain.skipped.size > MAX_SKIP) {
          const oldest = chain.skipped.keys().next().value!;
          wipe(chain.skipped.get(oldest));
          chain.skipped.delete(oldest);
        }
      }
      wipe(mk);
      let payload: unknown;
      try { payload = JSON.parse(fromUtf8(unpad(plain))); } catch { throw new P4Error("malformed", "body is not padded JSON"); } finally { wipe(plain); }
      if (!hasId(payload, e.id)) throw new P4Error("id-mismatch", "payload.id is not the envelope id");
      return payload as T;
    });
  }

  hasChain(peerId: string, keyId: string): boolean {
    return this.chains.has(chainSlot(peerId, keyId));
  }

  /* -------------------------------------------------------- lifecycle */

  /** A member left or was excluded: forget their chains and drop ours (§ 6). */
  peerLeft(peerId: string): void {
    for (const chain of [...this.chains.values()]) if (chain.owner === peerId) this.forget(chain);
    this.rotate();
  }

  /** A new pair session with `peerId` (re-hello): when it held our chain, ours is replaced (§ 6). */
  rehello(peerId: string): void {
    if (this.sentTo.has(peerId)) this.rotate();
  }

  clear(): void {
    this.rotate();
    for (const chain of [...this.chains.values()]) this.forget(chain);
  }

  private forget(chain: PeerChain): void {
    wipe(chain.ck);
    for (const k of chain.skipped.values()) wipe(k);
    chain.skipped.clear();
    this.chains.delete(chainSlot(chain.owner, chain.keyId));
  }
}
