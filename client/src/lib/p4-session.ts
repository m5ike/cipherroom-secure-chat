// Protocol 4 (6.12) for one room's data channels — the session layer the app
// (App.tsx) and the background rooms (room-hub.ts) share.
//
// Per peer and data channel:
//
//   open        our hello v4: the protocol-3 fields and signature (a 6.11 peer
//               reads it as protocol 3), plus fresh ephemeral P-256 and ML-KEM
//               keys, our mailbox bundle, account attestation and newest
//               key-transparency tree head (handshake.ts).
//   hello       the peer's: its protocol-3 part is checked by SenderKeyStore
//               (key check value, signature — and the protocol-3 pair key for
//               an older peer); a valid v4 part answers with our KEM message,
//               anything else is protocol 3 — unless that device key was once
//               seen with protocol 4: then it is a DOWNGRADE and refused (§ 1).
//   p4-kem      completes the handshake: the session (pair ratchet) exists,
//               we hand the peer our sender-key chain as an `sk` inner message.
//   p4          a ratchet frame: `sk` installs the peer's chain; `msg` (private
//               messages), `media` and `file` keys go to the app.
//   p4-reset    a broken session: wipe it, send a new hello — at most one reset
//               per 10 s per peer, else the app closes the channel (§ 5.5).
//   sender-key  protocol 3: an older peer's chain (SenderKeyStore).
//
// Room messages to protocol-4 peers are sealed once with our SenderKeys4 chain
// (each peer gets the chain first, over its ratchet); private messages go in
// the peer's ratchet. Protocol-3 peers keep the SenderKeyStore path, which the
// app drives as before (sealLive / sealPrivate / openLive / openPrivate).
//
// Everything here is memory only: sessions live as long as their channel.

import {
  P4Error, PairHandshake, SenderKeys4, newMediaKey, verifyAccount,
  type HelloAccount, type HelloV4, type MailboxBundle, type PairSession, type RatchetFrame, type RatchetInner,
  type Rng, type SenderKeyEnvelope, type SignedTreeHead,
} from "./p4";
import { Mutex } from "./p4/primitives";
import { SenderKeyStore, type Hello } from "./sender-keys";
import type { RoomKeys, Signer } from "./envelope";
import type { Identity } from "./identity";
import { signerOf, type AccountClaim } from "./p4-trust";

/**
 * "pending": nothing known yet (no hello). "p4-pending" (6.12 review P03): the
 * peer speaks protocol 4 — its valid hello v4 was accepted, or its device key
 * did before — but the session is not up yet: hold what is for it (never the
 * room key). 3 / 4: the session's protocol. "refused": nothing goes.
 */
export type PeerProtocol = "pending" | "p4-pending" | 3 | 4 | "refused";

/** What we know about a peer once its hello was accepted. */
export type PeerInfo = {
  peerId: string;
  protocol: 3 | 4;
  /** The device key of its hello. */
  pk: string;
  /** Its account attestation (protocol 4 hello `acc`), checked. */
  account: AccountClaim;
  acc: HelloAccount | null;
  caps: string[];
  user?: string;
  /** Its mailbox bundle when valid now (protocol 4). */
  mb: MailboxBundle | null;
  mailboxProblem?: string;
  sth: SignedTreeHead | null;
};

export type P4Events = {
  /** The peer's hello was accepted: protocol 3 at once, protocol 4 once the session exists. */
  ready?(peerId: string, info: PeerInfo): void;
  /** A hello without valid v4 fields from a device key once seen with protocol 4 (§ 1). */
  downgrade?(peerId: string, pk: string): void;
  /** The hello was refused: another room key, a bad signature, an excluded device. */
  refused?(peerId: string, why: "key-mismatch" | "bad-signature" | "excluded"): void;
  /** A ratchet inner message the app handles (`msg`, `media`, `file`, unknown types). `cipher`: the frame's ciphertext. */
  inner?(peerId: string, inner: RatchetInner, cipher: string): void | Promise<void>;
  /** A session was reset (`sent`: by us). */
  reset?(peerId: string, why: string, sent: boolean): void;
  /** Resets came too fast: the app closes this peer's channel. */
  close?(peerId: string): void;
  /** A peer chain we refused (its `cert` does not name the session's device). */
  chainRefused?(peerId: string): void;
};

export type HelloLocal = { mb: MailboxBundle | null; acc: HelloAccount | null; sth: SignedTreeHead | null };

export type P4RoomOptions = {
  keys: RoomKeys;
  identity: Identity;
  selfId: () => string;
  /** Sends a text frame on the peer's data channel; false when it could not. */
  send: (peerId: string, text: string) => boolean;
  /** `caps` and `user` of our hello to this peer. */
  helloExtra: (peerId: string) => { caps: string[]; user?: string };
  /** Our mailbox bundle, account attestation and newest tree head for a hello. */
  local: () => HelloLocal | Promise<HelloLocal>;
  /** The downgrade markers (p4-trust.ts › TrustBook). */
  book: { p4Seen(pk: string): boolean; markP4(pk: string): void };
  excluded?: (pk: string) => boolean;
  events?: P4Events;
  /** The protocol-3 store (pair keys and sender keys for older peers). */
  v3?: SenderKeyStore;
  rng?: Rng;
  now?: () => number;
  /** Speak protocol 3 only (a test of the fallback). */
  disableP4?: boolean;
};

type PeerState = {
  peerId: string;
  hs: Promise<PairHandshake | null> | null;
  /** The peer hello the current handshake accepted (e|n), to tell a repeat from a restart. */
  accepted: string | null;
  session: PairSession | null;
  protocol: PeerProtocol;
  info: PeerInfo | null;
  /** Received resets within RESET_WINDOW_MS (§ 5.5). */
  resets: number[];
  /** Resets came too fast and the app closes the channel: ignore its frames until a new channel opens. */
  closed?: boolean;
  /** The device key of this peer's last hello — kept across channels of this page (review P03). */
  knownPk?: string;
  /** Wake-ups for `settled`: each returns true when it is done (and is dropped). */
  waiters: Array<() => boolean>;
  mediaEpoch: number;
};

/** At most one reset per this long per peer (§ 5.5). */
export const RESET_WINDOW_MS = 10_000;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export class P4Room {
  readonly v3: SenderKeyStore;
  readonly sk: SenderKeys4;
  private readonly peers = new Map<string, PeerState>();
  private readonly roomMutex = new Mutex();
  private readonly now: () => number;

  constructor(private readonly o: P4RoomOptions) {
    this.v3 = o.v3 ?? new SenderKeyStore();
    this.sk = new SenderKeys4(o.keys.roomId, { publicKey: o.identity.publicKey }, { rng: o.rng });
    this.now = o.now ?? Date.now;
  }

  get roomId(): string { return this.o.keys.roomId; }
  get keys(): RoomKeys { return this.o.keys; }

  private state(peerId: string): PeerState {
    let st = this.peers.get(peerId);
    if (!st) {
      st = { peerId, hs: null, accepted: null, session: null, protocol: "pending", info: null, resets: [], waiters: [], mediaEpoch: -1 };
      this.peers.set(peerId, st);
    }
    return st;
  }

  /* ------------------------------------------------------------- views */

  protocolOf(peerId: string): PeerProtocol { return this.peers.get(peerId)?.protocol ?? "pending"; }
  isP4(peerId: string): boolean { const st = this.peers.get(peerId); return st?.protocol === 4 && Boolean(st.session); }
  info(peerId: string): PeerInfo | null { return this.peers.get(peerId)?.info ?? null; }
  /** The Signer a protocol-4 message from this peer gets (§ 6). */
  signer(peerId: string): Signer | null {
    const info = this.peers.get(peerId)?.info;
    return info ? signerOf(info.pk, info.account) : null;
  }

  /**
   * Resolves once the peer's protocol is known or after `ms`: 3, 4, refused —
   * or "p4-pending" (its valid hello v4 is in hand, or its device key spoke
   * protocol 4 before: protocol 4, the session not up yet). With `session`,
   * "p4-pending" is waited out as well (until 4, or the time is up).
   */
  settled(peerId: string, ms: number, opts: { session?: boolean } = {}): Promise<PeerProtocol> {
    const st = this.state(peerId);
    const done = () => st.protocol !== "pending" && !(opts.session && st.protocol === "p4-pending");
    if (done()) return Promise.resolve(st.protocol);
    return new Promise((resolve) => {
      const check = () => { if (!done()) return false; clearTimeout(timer); resolve(st.protocol); return true; };
      const timer = setTimeout(() => { st.waiters = st.waiters.filter((w) => w !== check); resolve(st.protocol); }, ms);
      st.waiters.push(check);
    });
  }

  private settle(st: PeerState, protocol: PeerProtocol): void {
    st.protocol = protocol;
    st.waiters = st.waiters.filter((w) => !w());
  }

  /**
   * 6.12 review P03: may a message for this peer fall back to the ROOM key?
   * Never for a device that speaks protocol 4 — a session (4), its valid hello
   * v4 in hand ("p4-pending"), its device key marked as having spoken protocol
   * 4 before (§ 1), even on an earlier channel of this page — nor for a refused
   * one. Only a genuinely unknown peer (no hello yet) or a protocol-3 one.
   */
  mayUseRoomKey(peerId: string): boolean {
    const st = this.peers.get(peerId);
    if (!st) return true;
    if (st.protocol === 4 || st.protocol === "p4-pending" || st.protocol === "refused") return false;
    if (st.knownPk && this.o.book.p4Seen(st.knownPk)) return false;
    return true;
  }

  /** Is the peer's protocol still being found out (no hello yet, or a protocol-4 handshake under way)? */
  negotiating(peerId: string): boolean {
    const p = this.protocolOf(peerId);
    return p === "pending" || p === "p4-pending";
  }

  /* ------------------------------------------------------------- hello */

  /**
   * The channel to `peerId` opened: our hello (a fresh handshake; an old
   * session is wiped). When the peer's hello came first and we already
   * answered it with our own, that handshake stands.
   */
  open(peerId: string): Promise<void> {
    const st = this.state(peerId);
    st.closed = false;
    if (st.hs && !st.session && (st.protocol === "pending" || st.protocol === "p4-pending")) return st.hs.then(() => undefined);
    this.wipe(st);
    st.protocol = this.restartProtocol(st);
    st.info = null;
    st.hs = this.startHello(peerId);
    return st.hs.then(() => undefined);
  }

  private async startHello(peerId: string): Promise<PairHandshake | null> {
    const keys = this.o.keys;
    const self = this.o.selfId();
    const v3 = await this.v3.hello(keys, this.o.identity, self, peerId);
    const extra = this.o.helloExtra(peerId);
    if (this.o.disableP4) {
      this.o.send(peerId, JSON.stringify({ ...v3, caps: extra.caps, ...(extra.user ? { user: extra.user } : {}) }));
      return null;
    }
    const local = await this.o.local();
    const hs = await PairHandshake.start({
      roomId: keys.roomId, check: keys.check, selfPeerId: self, peerPeerId: peerId,
      v3: { check: v3.check, pk: v3.pk, dh: v3.dh, sig: v3.sig, caps: extra.caps, ...(extra.user ? { user: extra.user } : {}) },
      signer: this.o.identity, mb: local.mb, acc: local.acc, sth: local.sth, rng: this.o.rng,
    });
    this.o.send(peerId, JSON.stringify(hs.hello));
    return hs;
  }

  /**
   * A text frame from the peer's channel. True when this layer handled it
   * (hello, p4-kem, p4, p4-reset, a protocol-3 sender key); false for
   * everything else (envelopes, file frames…), which the app handles.
   */
  async handle(peerId: string, raw: Record<string, unknown>): Promise<boolean> {
    // A channel this layer gave up on (resets too fast): nothing more on it until a new channel opens.
    if (this.peers.get(peerId)?.closed && (raw.kind === "hello" || raw.kind === "p4-kem" || raw.kind === "p4" || raw.kind === "p4-reset" || raw.kind === "sender-key")) return true;
    switch (raw.kind) {
      case "hello": await this.onHello(peerId, raw); return true;
      case "p4-kem": await this.onKem(peerId, raw); return true;
      case "p4": await this.onFrame(peerId, raw); return true;
      case "p4-reset": {
        // Only a session (or a handshake) of protocol 4 can be reset: an older peer's "reset" changes nothing.
        const proto = this.protocolOf(peerId);
        if (proto !== 3 && proto !== "refused") await this.reset(peerId, typeof raw.why === "string" ? raw.why.slice(0, 80) : "reset", false);
        return true;
      }
      case "sender-key": {
        // Protocol 3 only: a protocol-4 peer never hands out a protocol-3 chain.
        if (this.protocolOf(peerId) === 3) await this.v3.acceptSenderKey(this.o.keys, raw as { iv: string; ct: string }, peerId, this.o.selfId());
        return true;
      }
      default: return false;
    }
  }

  private async onHello(peerId: string, raw: Record<string, unknown>): Promise<void> {
    const st = this.state(peerId);
    const pk = typeof raw.pk === "string" ? raw.pk : "";
    if (pk && this.o.excluded?.(pk)) { this.o.events?.refused?.(peerId, "excluded"); return; }
    const refused = await this.v3.acceptHello(this.o.keys, this.o.identity, raw as unknown as Hello, peerId, this.o.selfId());
    if (refused) { this.o.events?.refused?.(peerId, refused); return; }
    const caps = Array.isArray(raw.caps) ? raw.caps.filter((c): c is string => typeof c === "string").slice(0, 32) : [];
    const user = typeof raw.user === "string" ? raw.user : undefined;

    // Our side of the handshake: the one for this channel — or a fresh one when
    // the peer started over (a reset, a new hello) or ours is already used.
    const tag = `${String(raw.e ?? "")}|${String(raw.n ?? "")}`;
    if (!st.hs) st.hs = this.startHello(peerId);
    else if (st.session || (st.accepted !== null && st.accepted !== tag)) {
      if (st.accepted === tag) return; // the same hello again
      this.wipe(st);
      st.protocol = this.restartProtocol(st);
      st.hs = this.startHello(peerId);
    } else if (st.accepted === tag) {
      return; // a repeat of the hello we answered
    }
    const hs = await st.hs;

    if (hs) {
      const { verdict, kem } = await hs.acceptHello(raw, this.now());
      if (verdict.ok && kem) {
        st.accepted = tag;
        const hello = verdict.hello as HelloV4;
        // P02: the caps and the username claim of a v4 hello are the SIGNED ones (sig4 covers them).
        const signedUser = typeof hello.user === "string" && hello.user ? hello.user : undefined;
        st.info = {
          peerId, protocol: 4, pk: hello.pk, acc: hello.acc, account: await verifyAccount(hello.acc, hello.pk, this.now()),
          caps: hello.caps.slice(0, 32), ...(signedUser ? { user: signedUser } : {}), mb: verdict.mailbox, ...(verdict.mailboxProblem ? { mailboxProblem: verdict.mailboxProblem } : {}),
          sth: hello.sth,
        };
        st.knownPk = hello.pk;
        // § 1 / review P03: the downgrade marker as soon as a valid hello v4 is accepted (not only once the
        // session is up), and the peer is protocol 4 from now on — nothing for it ever under the room key.
        this.o.book.markP4(hello.pk);
        if (!st.session && st.protocol !== 4) this.settle(st, "p4-pending");
        this.o.send(peerId, JSON.stringify(kem));
        await this.tryEstablish(st, hs);
        return;
      }
      if (!verdict.ok && verdict.why === "key-mismatch") { this.o.events?.refused?.(peerId, "key-mismatch"); return; }
      hs.wipe();
    }
    // Protocol 3 (an older peer, or a hello whose v4 part does not hold).
    if (pk) st.knownPk = pk;
    if (pk && this.o.book.p4Seen(pk)) {
      this.v3.forgetPeer(peerId);
      st.info = null;
      this.settle(st, "refused");
      this.o.events?.downgrade?.(peerId, pk);
      return;
    }
    st.accepted = tag;
    st.info = { peerId, protocol: 3, pk, acc: null, account: null, caps, ...(user ? { user } : {}), mb: null, sth: null };
    this.settle(st, 3);
    this.o.events?.ready?.(peerId, st.info);
    const skMsg = await this.v3.senderKeyFor(this.o.keys, this.o.selfId(), peerId);
    if (skMsg) this.o.send(peerId, JSON.stringify(skMsg));
  }

  private async onKem(peerId: string, raw: Record<string, unknown>): Promise<void> {
    const st = this.state(peerId);
    // A peer that speaks protocol 3 (or was refused) has no handshake of ours to answer.
    if (st.protocol === 3 || st.protocol === "refused") return;
    const hs = await st.hs;
    if (!hs || st.session) return;
    let result: "ok" | "ignored";
    try {
      result = await hs.acceptKem(raw);
    } catch (error) {
      await this.reset(peerId, error instanceof P4Error ? error.code : "kem", true);
      return;
    }
    if (result === "ok") await this.tryEstablish(st, hs);
  }

  private async tryEstablish(st: PeerState, hs: PairHandshake): Promise<void> {
    if (!hs.ready || !st.info) return;
    st.session = await hs.establish();
    st.info = { ...st.info, protocol: 4 };
    this.o.book.markP4(st.info.pk);
    // A new session with a peer that held our chain: ours is replaced (§ 6).
    this.sk.rehello(st.peerId);
    this.settle(st, 4);
    this.o.events?.ready?.(st.peerId, st.info);
    await this.handOut(st.peerId);
  }

  /* ------------------------------------------------------------ frames */

  private async onFrame(peerId: string, raw: Record<string, unknown>): Promise<void> {
    const st = this.peers.get(peerId);
    const session = st?.session;
    if (!st || !session) return;
    const opened = await session.ratchet.decrypt(raw);
    if (!opened.ok) {
      if (opened.reset) await this.reset(peerId, opened.error, true);
      return;
    }
    const inner = opened.inner;
    if (inner.t === "sk") {
      const ok = await this.sk.acceptChain(peerId, st.info!.pk, inner);
      if (!ok) this.o.events?.chainRefused?.(peerId);
      return;
    }
    await this.o.events?.inner?.(peerId, inner, typeof raw.c === "string" ? raw.c : "");
  }

  /**
   * § 5.5: discard the session and send a new hello; `sent`: we tell the peer.
   * Only RECEIVED resets count toward the limit (one per RESET_WINDOW_MS, a
   * second one closes the channel): two resets that cross on the wire — ours
   * and the peer's for the same incident — must not close it.
   */
  async reset(peerId: string, why: string, sent: boolean): Promise<void> {
    const st = this.state(peerId);
    const now = this.now();
    if (!sent) {
      st.resets = st.resets.filter((t) => now - t < RESET_WINDOW_MS);
      if (st.resets.length >= 1) {
        this.wipe(st);
        st.closed = true;
        this.settle(st, "refused");
        this.o.events?.close?.(peerId);
        return;
      }
      st.resets.push(now);
    }
    if (sent) this.o.send(peerId, JSON.stringify({ kind: "p4-reset", v: 4, why }));
    this.o.events?.reset?.(peerId, why, sent);
    // A received reset while we are already starting over (no session — e.g. our own reset crossed
    // the peer's): the fresh hello we sent answers it; another one would only chase the peer's.
    if (!sent && !st.session && st.hs) return;
    this.wipe(st);
    st.protocol = this.restartProtocol(st);
    st.hs = this.startHello(peerId);
    await st.hs;
  }

  /** A handshake starts over: a peer known to speak protocol 4 stays "p4-pending" (review P03), else "pending". */
  private restartProtocol(st: PeerState): PeerProtocol {
    return st.knownPk && this.o.book.p4Seen(st.knownPk) ? "p4-pending" : "pending";
  }

  /* ------------------------------------------------------------ sending */

  /** Our current chain to a protocol-4 peer that does not hold it yet. */
  private handOut(peerId: string): Promise<void> {
    return this.roomMutex.run(async () => {
      const st = this.peers.get(peerId);
      if (!st?.session) return;
      await this.sk.prepare(this.now());
      if (this.sk.hasOurChain(peerId)) return;
      const inner = this.sk.chainFor(peerId);
      const frame = await st.session.ratchet.encrypt(inner);
      // Marked as held only once it went (review P13); else the next room message hands it out again.
      if (this.o.send(peerId, JSON.stringify(frame))) this.sk.handedOut(peerId, inner.keyId);
    });
  }

  /**
   * § 6: a room message for the protocol-4 peers among `peerIds` — each gets
   * our chain first when it lacks it (the channel is ordered). Returns the
   * envelope (send it to `to`) — null when none of them speaks protocol 4.
   */
  sealRoom(id: string, payload: unknown, peerIds: Iterable<string>): Promise<{ envelope: SenderKeyEnvelope; to: string[] } | null> {
    return this.roomMutex.run(async () => {
      const targets = [...peerIds].filter((p) => this.isP4(p));
      if (targets.length === 0) return null;
      await this.sk.prepare(this.now());
      const to: string[] = [];
      for (const peerId of targets) {
        const session = this.peers.get(peerId)!.session!;
        if (!this.sk.hasOurChain(peerId)) {
          const inner = this.sk.chainFor(peerId);
          const frame = await session.ratchet.encrypt(inner);
          if (!this.o.send(peerId, JSON.stringify(frame))) continue;
          this.sk.handedOut(peerId, inner.keyId);
        }
        to.push(peerId);
      }
      if (to.length === 0) return null;
      return { envelope: await this.sk.seal(id, payload), to };
    });
  }

  /** § 5.7 `msg`: a message for this peer only, in its ratchet. Null without a session. */
  async sealPrivate(peerId: string, id: string, payload: unknown): Promise<RatchetFrame | null> {
    const session = this.peers.get(peerId)?.session;
    if (!session) return null;
    return session.ratchet.encrypt({ t: "msg", id, p: payload });
  }

  /** Any inner message to the peer (`media`, `file`, …); false without a session or when it could not go. */
  async sendInner(peerId: string, inner: RatchetInner): Promise<boolean> {
    const session = this.peers.get(peerId)?.session;
    if (!session) return false;
    const frame = await session.ratchet.encrypt(inner);
    return this.o.send(peerId, JSON.stringify(frame));
  }

  /** § 9: a fresh media key for our direction of this call (epoch + 1), sent to the peer. */
  async sendMediaKey(peerId: string, call: string): Promise<{ raw: Uint8Array; epoch: number } | null> {
    const st = this.peers.get(peerId);
    if (!st?.session) return null;
    const epoch = st.mediaEpoch + 1;
    const { inner, raw } = newMediaKey(call, epoch, this.o.rng);
    if (!(await this.sendInner(peerId, inner))) return null;
    st.mediaEpoch = epoch;
    return { raw, epoch };
  }

  /* ------------------------------------------------------------ opening */

  /** § 6: a protocol-4 room message from this peer → its payload and signer. Throws a P4Error. */
  async openRoom<T>(peerId: string, envelope: unknown): Promise<{ payload: T; signer: Signer }> {
    const st = this.peers.get(peerId);
    if (st?.protocol !== 4 || !st.info) throw new P4Error("no-chain", "no protocol-4 session with this peer");
    const payload = await this.sk.open<T>(peerId, envelope);
    return { payload, signer: signerOf(st.info.pk, st.info.account) };
  }

  /* ---------------------------------------------------------- lifecycle */

  private wipe(st: PeerState): void {
    st.session?.ratchet.wipe();
    st.session = null;
    st.accepted = null;
    const hs = st.hs;
    st.hs = null;
    void hs?.then((h) => h?.wipe()).catch(() => undefined);
  }

  /** The channel closed: its session goes (a new channel brings a new hello). */
  channelClosed(peerId: string): void {
    const st = this.peers.get(peerId);
    if (!st) return;
    this.wipe(st);
    this.settle(st, "pending");
  }

  /** The member left or was excluded: their chains go, ours is replaced (§ 6). */
  peerLeft(peerId: string): void {
    const st = this.peers.get(peerId);
    if (st) { this.wipe(st); this.settle(st, "refused"); }
    this.peers.delete(peerId);
    this.sk.peerLeft(peerId);
    this.v3.forgetPeer(peerId);
  }

  /** Our chains start over (the app's "exclude": nobody holds the next one yet). */
  rotate(): void {
    this.sk.rotate();
    this.v3.rotate();
  }

  clear(): void {
    for (const st of this.peers.values()) { this.wipe(st); this.settle(st, "refused"); }
    this.peers.clear();
    this.sk.clear();
    this.v3.clear();
  }
}

/** Is this a protocol-4 room message (sender-key envelope, § 6)? */
export function isP4RoomEnvelope(v: unknown): v is SenderKeyEnvelope {
  return isObj(v) && v.v === 4 && typeof v.sk === "string" && typeof v.n === "number" && typeof v.c === "string" && typeof v.s === "string" && v.kind === undefined;
}
