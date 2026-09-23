// Forward secrecy for live messages, and messages only their recipients open.
//
// The room key is shared and static: whoever learns the passphrase — today
// or in a year — could open everything captured so far. So live messages
// between peers are no longer sealed with it:
//
// PAIRWISE CHANNEL. When a data channel opens, both sides send a signed
// hello: their device key (ECDSA), a Diffie-Hellman key (ECDH P-256) and the
// room's key check value. The signature binds the DH key to the device key,
// the device key is what peers pin (identity.ts). Both sides then compute
//     pair key = HKDF(ECDH(my DH, their DH), salt = room,
//                     info = "m5cet/pair/1|" + both device keys, sorted)
// — known to exactly these two devices.
//
// SENDER KEYS. Each sender keeps a chain key CK and ratchets it:
//     message key  MK_n   = HMAC(CK_n, 0x01)
//     next chain   CK_n+1 = HMAC(CK_n, 0x02)
// and hands its CURRENT chain key to each peer over their pair channel.
// A message sealed with MK_n carries (sender key id, n). Once CK_n has been
// replaced by CK_n+1 on both sides, MK_n cannot be recomputed from anything
// left in memory: messages already read stay read-only history (forward
// secrecy). When someone leaves — or is excluded — every sender starts a
// fresh chain and gives it only to those still there, so the leaver cannot
// read what is said next.
//
// PRIVATE MESSAGES (to chosen recipients) are sealed separately for each of
// them with the pair key, so another room member cannot open them even with
// the room passphrase.
//
// What still uses the room key (envelope.ts): messages relayed to members
// who are away and messages waiting in the light-mode outbox — their
// recipients may not have a pair channel yet — plus signaling and files.

import { fromBase64, toBase64, type Bytes } from "./crypto";
import { context, readBody, signBody, type Envelope, type RoomKeys, type Signer } from "./envelope";
import type { Identity } from "./identity";
import { verifySignature } from "./identity";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (s: string): Bytes => new Uint8Array(encoder.encode(s));

/** How far ahead a receiver derives keys for messages it did not get (sent to others). */
export const MAX_SKIP = 1_000;
/** A fresh chain after this many messages, or after this long. */
export const ROTATE_AFTER = { messages: 500, ms: 60 * 60 * 1000 };

async function hmac(keyBytes: Bytes, byte: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([byte])));
}

async function messageKey(chain: Bytes): Promise<CryptoKey> {
  const bits = await hmac(chain, 0x01);
  const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  bits.fill(0);
  return key;
}

const b64url = (b: Bytes) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* ------------------------------------------------------------ own chain */

export class OwnSenderKey {
  readonly keyId: string;
  private chain: Bytes;
  index = 0;
  readonly createdAt: number;

  constructor(now = Date.now()) {
    this.keyId = b64url(crypto.getRandomValues(new Uint8Array(12)));
    this.chain = crypto.getRandomValues(new Uint8Array(32));
    this.createdAt = now;
  }

  /** The key for the next message; the chain moves on and the old link is wiped. */
  async next(): Promise<{ keyId: string; index: number; key: CryptoKey }> {
    const key = await messageKey(this.chain);
    const nextChain = await hmac(this.chain, 0x02);
    this.chain.fill(0);
    this.chain = nextChain;
    const index = this.index;
    this.index += 1;
    return { keyId: this.keyId, index, key };
  }

  /** What a peer needs to follow from here on (never anything before). */
  wire(): SenderKeyWire {
    return { keyId: this.keyId, chain: toBase64(this.chain), index: this.index };
  }

  due(now = Date.now()): boolean {
    return this.index >= ROTATE_AFTER.messages || now - this.createdAt >= ROTATE_AFTER.ms;
  }

  wipe(): void {
    this.chain.fill(0);
  }
}

export type SenderKeyWire = { keyId: string; chain: string; index: number };

/* ------------------------------------------------------- a peer's chain */

class PeerChain {
  private chain: Bytes;
  private index: number;
  private skipped = new Map<number, CryptoKey>();

  constructor(readonly keyId: string, readonly owner: string, wire: SenderKeyWire) {
    this.chain = fromBase64(wire.chain);
    this.index = wire.index;
  }

  /** The message key for `index` — ratcheting forward, keeping the few
   *  skipped ones (messages sent to others) for a while. */
  async keyFor(index: number): Promise<CryptoKey | null> {
    const kept = this.skipped.get(index);
    if (kept) { this.skipped.delete(index); return kept; }
    if (index < this.index || index - this.index > MAX_SKIP) return null;
    while (this.index < index) {
      this.skipped.set(this.index, await messageKey(this.chain));
      await this.advance();
      if (this.skipped.size > MAX_SKIP) this.skipped.delete(this.skipped.keys().next().value!);
    }
    const key = await messageKey(this.chain);
    await this.advance();
    return key;
  }

  private async advance(): Promise<void> {
    const next = await hmac(this.chain, 0x02);
    this.chain.fill(0);
    this.chain = next;
    this.index += 1;
  }

  wipe(): void {
    this.chain.fill(0);
    this.skipped.clear();
  }
}

/* ----------------------------------------------------------- the store */

export type Hello = { kind: "hello"; v: 3; check: string; pk: string; dh: string; sig: string };
export type Pair = { key: CryptoKey; peerPublicKey: string };

const helloContext = (room: string, from: string, to: string, check: string, dh: string) => utf8(["m5cet/hello/1", room, from, to, check, dh].join("|"));
const pairInfo = (a: string, b: string) => utf8(`m5cet/pair/1|${[a, b].sort().join("|")}`);

export class SenderKeyStore {
  private own: OwnSenderKey | null = null;
  private chains = new Map<string, PeerChain>();
  private pairs = new Map<string, Pair>();
  /** Peers that already have our current chain. */
  private sentTo = new Set<string>();

  /* -------------------------------------------------------------- hello */

  async hello(keys: RoomKeys, identity: Identity, from: string, to: string): Promise<Hello> {
    const sig = await identity.sign(helloContext(keys.room, from, to, keys.check, identity.dhPublicKey));
    return { kind: "hello", v: 3, check: keys.check, pk: identity.publicKey, dh: identity.dhPublicKey, sig };
  }

  /**
   * A peer's hello: checks the key check value and the signature, then
   * derives the pair key. Returns why it was refused, or null.
   */
  async acceptHello(keys: RoomKeys, identity: Identity, hello: Hello, from: string, to: string): Promise<"key-mismatch" | "bad-signature" | null> {
    if (hello.check !== keys.check) return "key-mismatch";
    const valid = await verifySignature(hello.pk, helloContext(keys.room, from, to, hello.check, hello.dh), hello.sig).catch(() => false);
    if (!valid) return "bad-signature";
    const secret = await identity.sharedSecret(hello.dh);
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    secret.fill(0);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: utf8(keys.room), info: pairInfo(identity.publicKey, hello.pk) },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
    this.pairs.set(from, { key, peerPublicKey: hello.pk });
    this.sentTo.delete(from);
    return null;
  }

  hasPair(peerId: string): boolean { return this.pairs.has(peerId); }
  pairOf(peerId: string): Pair | null { return this.pairs.get(peerId) ?? null; }

  /* -------------------------------------------------------- distribution */

  private ensureOwn(now = Date.now()): OwnSenderKey {
    if (!this.own || this.own.due(now)) this.rotate();
    return this.own!;
  }

  /** A fresh chain nobody has yet (someone left, or it is time). */
  rotate(): void {
    this.own?.wipe();
    this.own = new OwnSenderKey();
    this.sentTo.clear();
  }

  /** Our current chain, sealed for one peer — or null without a pair key. */
  async senderKeyFor(keys: RoomKeys, from: string, to: string): Promise<{ kind: "sender-key"; v: 3; iv: string; ct: string } | null> {
    const pair = this.pairs.get(to);
    if (!pair) return null;
    const own = this.ensureOwn();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context("sender-key", keys.room, from, to) },
      pair.key, utf8(JSON.stringify(own.wire())),
    ));
    this.sentTo.add(to);
    return { kind: "sender-key", v: 3, iv: toBase64(iv), ct: toBase64(ct) };
  }

  /** A peer's chain, from its sealed message. */
  async acceptSenderKey(keys: RoomKeys, message: { iv: string; ct: string }, from: string, to: string): Promise<boolean> {
    const pair = this.pairs.get(from);
    if (!pair) return false;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(message.iv), additionalData: context("sender-key", keys.room, from, to) }, pair.key, fromBase64(message.ct));
      const wire = JSON.parse(decoder.decode(plain)) as SenderKeyWire;
      if (typeof wire.keyId !== "string" || typeof wire.chain !== "string" || !Number.isInteger(wire.index)) return false;
      this.chains.get(wire.keyId)?.wipe();
      this.chains.set(wire.keyId, new PeerChain(wire.keyId, from, wire));
      // Old chains of the same peer go after a grace period (in-flight messages).
      const olderOfPeer = [...this.chains.values()].filter((c) => c.owner === from && c.keyId !== wire.keyId);
      for (const old of olderOfPeer.slice(0, -1)) { old.wipe(); this.chains.delete(old.keyId); }
      return true;
    } catch {
      return false;
    }
  }

  /** Does this peer already hold our current chain? */
  hasOurKey(peerId: string): boolean {
    return Boolean(this.own) && this.sentTo.has(peerId);
  }

  /** Someone left: forget their pair and chains, and start a new chain of
   *  our own so they cannot read what comes next. */
  forgetPeer(peerId: string): void {
    this.pairs.delete(peerId);
    this.sentTo.delete(peerId);
    for (const [id, chain] of this.chains) if (chain.owner === peerId) { chain.wipe(); this.chains.delete(id); }
    if (this.own && this.own.index > 0) this.rotate();
  }

  clear(): void {
    this.own?.wipe();
    this.own = null;
    for (const chain of this.chains.values()) chain.wipe();
    this.chains.clear();
    this.pairs.clear();
    this.sentTo.clear();
  }

  /* ----------------------------------------------------------- messages */

  /** A live message for everyone holding our chain. */
  async sealLive(keys: RoomKeys, id: string, payload: unknown, identity?: Identity | null): Promise<Envelope> {
    const own = this.ensureOwn();
    const { keyId, index, key } = await own.next();
    const ctx = context("msg-sk", keys.room, id, keyId, index);
    const plain = await signBody(JSON.stringify(payload), ctx, identity);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ctx }, key, utf8(plain)));
    return { v: 3, id, sk: keyId, n: index, iv: toBase64(iv), ciphertext: toBase64(ct) };
  }

  async openLive<T>(keys: RoomKeys, envelope: Envelope, from: string): Promise<{ payload: T; signer: Signer | null }> {
    const chain = envelope.sk ? this.chains.get(envelope.sk) : undefined;
    if (!chain || chain.owner !== from || typeof envelope.n !== "number" || typeof envelope.id !== "string") throw new Error("no sender key for this message");
    const key = await chain.keyFor(envelope.n);
    if (!key) throw new Error("message key already used or too far ahead");
    const ctx = context("msg-sk", keys.room, envelope.id, envelope.sk!, envelope.n);
    const plain = decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.iv), additionalData: ctx }, key, fromBase64(envelope.ciphertext)));
    const { body, signer } = await readBody(plain, ctx);
    const payload = JSON.parse(body) as T;
    if ((payload as { id?: unknown })?.id !== envelope.id) throw new Error("envelope id mismatch");
    return { payload, signer };
  }

  /** A message for one peer only, sealed with the pair key. */
  async sealPrivate(keys: RoomKeys, id: string, payload: unknown, from: string, to: string, identity?: Identity | null): Promise<Envelope | null> {
    const pair = this.pairs.get(to);
    if (!pair) return null;
    const ctx = context("msg-pair", keys.room, id, from, to);
    const plain = await signBody(JSON.stringify(payload), ctx, identity);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ctx }, pair.key, utf8(plain)));
    return { v: 3, id, sk: "pair", iv: toBase64(iv), ciphertext: toBase64(ct) };
  }

  async openPrivate<T>(keys: RoomKeys, envelope: Envelope, from: string, to: string): Promise<{ payload: T; signer: Signer | null }> {
    const pair = this.pairs.get(from);
    if (!pair || typeof envelope.id !== "string") throw new Error("no pair key with this peer");
    const ctx = context("msg-pair", keys.room, envelope.id, from, to);
    const plain = decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.iv), additionalData: ctx }, pair.key, fromBase64(envelope.ciphertext)));
    const { body, signer } = await readBody(plain, ctx);
    const payload = JSON.parse(body) as T;
    if ((payload as { id?: unknown })?.id !== envelope.id) throw new Error("envelope id mismatch");
    // The pair key already names the peer; the signature must be the same device.
    if (signer && signer.publicKey !== pair.peerPublicKey) throw new Error("signed by another device than the pair");
    return { payload, signer };
  }
}

/** Is this envelope sealed with a sender key or a pair key? */
export function envelopeKind(envelope: Envelope): "sender-key" | "pair" | "room" {
  if (envelope.v === 3 && envelope.sk === "pair") return "pair";
  if (envelope.v === 3 && typeof envelope.sk === "string" && typeof envelope.n === "number") return "sender-key";
  return "room";
}
