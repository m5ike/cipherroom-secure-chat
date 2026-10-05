// Protocol 4 handshake (docs/protocol-v4.md §§ 2–4): the hello v4, the KEM
// message that answers it, and the session key schedule that seeds the pair
// ratchet.
//
// Each side sends ONE hello per data-channel open: the protocol-3 fields and
// signature unchanged (a 6.11 peer reads it as protocol 3), plus a fresh
// ephemeral P-256 key `e`, a fresh ML-KEM-768 key `k`, a nonce `n`, its
// mailbox bundle, its account attestation, its newest key-transparency tree
// head, and `sig4` — the device key's signature over all of it, bound to the
// blind room id and both peer ids. Then each side encapsulates to the other's
// `k` (the KEM message). The session secret mixes ECDH(e, e') with BOTH KEM
// secrets under a transcript hash of everything both hellos and both KEM
// ciphertexts said, so it is safe if either P-256 or ML-KEM holds, and a
// changed byte anywhere gives the two sides different keys.
//
// The protocol-3 `sig` (over the readable room name) is made and checked by
// sender-keys.ts (`SenderKeyStore.hello` / `acceptHello`); this file builds
// and checks everything protocol 4 adds. `PairHandshake` runs the whole
// exchange for one data channel.

import { DEVICE_CERT_LIFETIME_MS, KEM, LABEL, P4_CAP, type HelloAccount, type HelloV4Fields, type KemMessage, type MailboxBundle, type SignedTreeHead } from "./contract";
import { kemDecaps, kemEncaps, kemKeygen, type KemKeyPair } from "./kem";
import { checkBundle, isBundleShape } from "./mailbox";
import {
  b64, concat, ecdh, ecdsaVerify, ed25519Verify, hB64, H, hkdf, importEcdhPublic, isSafeCount, join, P4Error, unb64, wipe,
  type Bytes, type DeviceSigner, type P256Pair,
} from "./primitives";
import { Ratchet, type RatchetRole } from "./ratchet";
import { systemRng, type Rng } from "./rng";
import { verifyDeviceCert } from "../identity";

/** A hello v4 as it travels (§ 2). */
export type HelloV4 = {
  kind: "hello";
  check: string;
  pk: string;
  dh: string;
  sig: string;
  caps: string[];
  user?: unknown;
} & HelloV4Fields;

/** The protocol-3 part of a hello, as `SenderKeyStore.hello()` made it (plus the app's `caps` / `user`). */
export type HelloV3Part = { check: string; pk: string; dh: string; sig: string; caps?: string[]; user?: unknown };

/** The private halves of one hello; memory only, wiped once the session exists or the channel closes. */
export type HelloSecrets = { e: P256Pair; k: KemKeyPair };

/* ------------------------------------------------------------ digests */

/** § 2 mbDigest: b64(H(join(mb.id, mb.dh, b64(H(kem bytes)), mb.exp, mb.sig))), or "-". */
export async function mbDigest(mb: MailboxBundle | null): Promise<string> {
  if (!mb) return "-";
  return hB64(join(mb.id, mb.dh, await hB64(unb64(mb.kem)), mb.exp, mb.sig));
}

/** § 2 accDigest: b64(H(join(acc.apk, acc.ac, acc.cv ?? 1, acc.exp ?? 0))), or "-". */
export async function accDigest(acc: HelloAccount | null): Promise<string> {
  if (!acc) return "-";
  return hB64(join(acc.apk, acc.ac, acc.cv ?? 1, acc.exp ?? 0));
}

/** § 2: the bytes `sig4` signs. `from` is the hello's sender, `to` its recipient. */
export async function helloSig4Data(roomId: string, from: string, to: string, h: Pick<HelloV4, "check" | "pk" | "dh" | "e" | "k" | "n" | "mb" | "acc">): Promise<Bytes> {
  return join(LABEL.hello, roomId, from, to, h.check, h.pk, h.dh, h.e, await hB64(unb64(h.k)), h.n, await mbDigest(h.mb), await accDigest(h.acc));
}

/** § 3: r = b64(H(join(e, b64(H(k)), n))) — names the hello a KEM message answers. */
export async function helloRef(h: { e: string; k: string; n: string }): Promise<string> {
  return hB64(join(h.e, await hB64(unb64(h.k)), h.n));
}

/* -------------------------------------------------------------- hello */

export type BuildHelloOptions = {
  roomId: string;
  /** Our peer id and the recipient's. */
  from: string;
  to: string;
  v3: HelloV3Part;
  /** The device key; `signer.publicKey` must be `v3.pk`. */
  signer: DeviceSigner;
  mb: MailboxBundle | null;
  acc: HelloAccount | null;
  sth: SignedTreeHead | null;
  rng?: Rng;
};

/** § 2: a hello v4. Draws: "hello.e", "hello.k", "hello.n". */
export async function buildHello(o: BuildHelloOptions): Promise<{ hello: HelloV4; secrets: HelloSecrets }> {
  if (o.signer.publicKey !== o.v3.pk) throw new P4Error("state", "the signer is not the hello's device key");
  const rng = o.rng ?? systemRng;
  const e = await rng.p256("ecdh", "hello.e");
  const k = kemKeygen(rng, "hello.k");
  const n = b64(rng.bytes(16, "hello.n"));
  const caps = [...(o.v3.caps ?? [])];
  if (!caps.includes(P4_CAP)) caps.push(P4_CAP);
  const base = { check: o.v3.check, pk: o.v3.pk, dh: o.v3.dh, e: e.spki, k: b64(k.ek), n, mb: o.mb, acc: o.acc };
  const sig4 = await o.signer.sign(await helloSig4Data(o.roomId, o.from, o.to, base));
  const hello: HelloV4 = {
    kind: "hello", v: 4, check: o.v3.check, pk: o.v3.pk, dh: o.v3.dh, sig: o.v3.sig, caps,
    ...(o.v3.user !== undefined ? { user: o.v3.user } : {}),
    e: e.spki, k: base.k, n, mb: o.mb, acc: o.acc, sth: o.sth, sig4,
  };
  return { hello, secrets: { e, k } };
}

export type HelloVerdict =
  | {
    ok: true;
    hello: HelloV4;
    /** The peer's mailbox bundle when it is valid now; else null (and `mailboxProblem` says why). */
    mailbox: MailboxBundle | null;
    mailboxProblem?: "expired" | "bad-signature" | "malformed";
  }
  /** `not-v4`, `malformed`, `bad-sig4`: treat as a protocol-3 hello (and apply the downgrade rule, § 1). */
  | { ok: false; why: "key-mismatch" | "not-v4" | "malformed" | "bad-sig4" };

const isStr = (v: unknown): v is string => typeof v === "string";

function isAccShape(a: unknown): a is HelloAccount {
  const acc = a as Partial<HelloAccount> | null;
  if (!acc || typeof acc !== "object" || !isStr(acc.apk) || !isStr(acc.ac)) return false;
  if (acc.cv === undefined) return acc.exp === undefined;
  return acc.cv === 2 && isSafeCount(acc.exp);
}

function isSthShape(s: unknown): s is SignedTreeHead {
  const sth = s as Partial<SignedTreeHead> | null;
  return Boolean(sth) && typeof sth === "object" && isSafeCount(sth!.size) && isStr(sth!.root) && isSafeCount(sth!.ts) && isStr(sth!.sig);
}

/**
 * § 2: checks a peer's hello. `from` is the PEER's id, `to` ours. The
 * protocol-3 `sig` is checked by `SenderKeyStore.acceptHello` (it needs the
 * readable room name); a hello is protocol 4 only when both hold.
 */
export async function verifyHello(raw: unknown, ctx: { roomId: string; from: string; to: string; check: string; now?: number }): Promise<HelloVerdict> {
  const h = raw as Partial<HelloV4> | null;
  if (!h || typeof h !== "object" || h.kind !== "hello") return { ok: false, why: "malformed" };
  if (h.check !== ctx.check) return { ok: false, why: "key-mismatch" };
  if (h.v !== 4) return { ok: false, why: "not-v4" };
  try {
    if (!isStr(h.pk) || !isStr(h.dh) || !isStr(h.sig) || !isStr(h.sig4) || !Array.isArray(h.caps)) throw new P4Error("malformed");
    await importEcdhPublic(h.e);
    unb64(h.k, KEM.ek);
    unb64(h.n, 16);
    if (h.mb !== null && !isBundleShape(h.mb)) throw new P4Error("malformed");
    if (h.acc !== null && !isAccShape(h.acc)) throw new P4Error("malformed");
    if (h.sth !== null && !isSthShape(h.sth)) throw new P4Error("malformed");
    const data = await helloSig4Data(ctx.roomId, ctx.from, ctx.to, h as HelloV4);
    if (!(await ecdsaVerify(h.pk, data, h.sig4))) return { ok: false, why: "bad-sig4" };
  } catch {
    return { ok: false, why: "malformed" };
  }
  const hello = h as HelloV4;
  if (!hello.mb) return { ok: true, hello, mailbox: null };
  const problem = await checkBundle(hello.mb, hello.pk, ctx.now ?? Date.now());
  return problem ? { ok: true, hello, mailbox: null, mailboxProblem: problem } : { ok: true, hello, mailbox: hello.mb };
}

/**
 * § 12.3: does the account `acc.apk` vouch for device key `pk`? v2 certificates
 * (`cv: 2`): Ed25519 over join(LABEL.deviceCert, pk, exp), and `exp > now`.
 * v1 (no `cv`): the protocol-3 certificate, valid without expiry.
 */
export async function verifyAccount(acc: HelloAccount | null | undefined, pk: string, now = Date.now()): Promise<{ publicKey: string; valid: boolean; v: 1 | 2; exp?: number } | null> {
  if (!acc) return null;
  if (!isAccShape(acc)) return { publicKey: String((acc as { apk?: unknown }).apk ?? ""), valid: false, v: 1 };
  if (acc.cv === 2) {
    const exp = acc.exp!;
    let valid = exp > now;
    if (valid) {
      try { valid = await ed25519Verify(acc.apk, join(LABEL.deviceCert, pk, exp), acc.ac); } catch { valid = false; }
    }
    return { publicKey: acc.apk, valid, v: 2, exp };
  }
  return { publicKey: acc.apk, valid: await verifyDeviceCert({ accountKey: acc.apk, cert: acc.ac }, pk), v: 1 };
}

/** § 12.3: a v2 device certificate (for the signed-in device; the account key signs). */
export async function certifyDeviceV2(accountPrivateKey: CryptoKey, devicePk: string, exp: number, now = Date.now()): Promise<{ v: 2; exp: number; sig: string }> {
  if (!isSafeCount(exp) || exp > now + DEVICE_CERT_LIFETIME_MS) throw new P4Error("malformed", "certificate lifetime too long");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, accountPrivateKey, join(LABEL.deviceCert, devicePk, exp)));
  return { v: 2, exp, sig: b64(sig) };
}

/* -------------------------------------------------------- KEM message */

/** § 3: the KEM message answering a peer's (accepted) hello. Draw: "hello.kem-m". */
export async function buildKemMessage(peerHello: Pick<HelloV4, "e" | "k" | "n">, rng: Rng = systemRng): Promise<{ message: KemMessage; ct: Bytes; ss: Bytes }> {
  const { ct, ss } = kemEncaps(unb64(peerHello.k, KEM.ek), rng, "hello.kem-m");
  return { message: { kind: "p4-kem", v: 4, ct: b64(ct), r: await helloRef(peerHello) }, ct, ss };
}

/**
 * § 3: a KEM message for our hello → its ciphertext and the decapsulated
 * secret; null when it answers another hello (ignore it). A malformed one
 * throws (`malformed` / `kct`).
 */
export async function openKemMessage(raw: unknown, own: { hello: Pick<HelloV4, "e" | "k" | "n">; secrets: HelloSecrets }): Promise<{ ct: Bytes; ss: Bytes } | null> {
  const m = raw as Partial<KemMessage> | null;
  if (!m || typeof m !== "object" || m.kind !== "p4-kem" || m.v !== 4 || !isStr(m.r) || !isStr(m.ct)) throw new P4Error("malformed", "not a KEM message");
  if (m.r !== await helloRef(own.hello)) return null;
  let ct: Bytes;
  try { ct = unb64(m.ct, KEM.ct); } catch { throw new P4Error("kct", "KEM ciphertext cannot be decapsulated"); }
  return { ct, ss: kemDecaps(ct, own.secrets.k.dk) };
}

/* ------------------------------------------------------- key schedule */

/** One side's contribution to the transcript. */
export type Party = { pk: string; peerId: string; e: string; k: string; n: string };

/** § 4: the side whose `pk + "|" + peerId` is smaller (ordinal) is A. */
export function roleOf(self: { pk: string; peerId: string }, peer: { pk: string; peerId: string }): RatchetRole {
  const a = `${self.pk}|${self.peerId}`;
  const b = `${peer.pk}|${peer.peerId}`;
  if (a === b) throw new P4Error("state", "both sides are the same device");
  return a < b ? "A" : "B";
}

/** § 4 TH. */
export async function transcriptHash(roomId: string, check: string, A: Party, B: Party, ctA: Uint8Array, ctB: Uint8Array): Promise<Bytes> {
  return H(join(
    LABEL.transcript, roomId, check,
    A.pk, A.e, await hB64(unb64(A.k)), A.n,
    B.pk, B.e, await hB64(unb64(B.k)), B.n,
    await hB64(ctA), await hB64(ctB),
  ));
}

/** § 4: okm = HKDF(TH, dh0 || ssA || ssB, LABEL.root, 96) → RK0, CK_B0, SID. */
export async function rootSchedule(th: Uint8Array, dh0: Uint8Array, ssA: Uint8Array, ssB: Uint8Array): Promise<{ rk0: Bytes; ckB0: Bytes; sid: Bytes }> {
  const ikm = concat(dh0, ssA, ssB);
  const okm = await hkdf(th, ikm, LABEL.root, 96);
  const out = { rk0: okm.slice(0, 32), ckB0: okm.slice(32, 64), sid: okm.slice(64, 96) };
  wipe(ikm, okm);
  return out;
}

export type PairSession = {
  role: RatchetRole;
  /** Transcript hash (bound into every pair frame). */
  th: Bytes;
  /** The session's export secret (§ 4). */
  sid: Bytes;
  ratchet: Ratchet;
};

export type EstablishInput = {
  roomId: string;
  check: string;
  self: { peerId: string; hello: HelloV4; secrets: HelloSecrets };
  peer: { peerId: string; hello: HelloV4 };
  /** Our KEM message to the peer: its ciphertext and secret. */
  sent: { ct: Uint8Array; ss: Uint8Array };
  /** The peer's KEM message to us: its ciphertext and the decapsulated secret. */
  received: { ct: Uint8Array; ss: Uint8Array };
  rng?: Rng;
};

/** § 4: the session — TH, SID and the initial ratchet for our role. Wipes the hello's KEM key and both KEM secrets. */
export async function establishSession(i: EstablishInput): Promise<PairSession> {
  const self: Party = { pk: i.self.hello.pk, peerId: i.self.peerId, e: i.self.hello.e, k: i.self.hello.k, n: i.self.hello.n };
  const peer: Party = { pk: i.peer.hello.pk, peerId: i.peer.peerId, e: i.peer.hello.e, k: i.peer.hello.k, n: i.peer.hello.n };
  const role = roleOf(self, peer);
  const [A, B] = role === "A" ? [self, peer] : [peer, self];
  // ctA: what A sent (to B's k); ctB: what B sent (to A's k).
  const [a, b] = role === "A" ? [i.sent, i.received] : [i.received, i.sent];
  const th = await transcriptHash(i.roomId, i.check, A, B, a.ct, b.ct);
  const dh0 = await ecdh(i.self.secrets.e.privateKey, i.peer.hello.e);
  const { rk0, ckB0, sid } = await rootSchedule(th, dh0, a.ss, b.ss);
  wipe(dh0);
  try {
    const ratchet = await Ratchet.create({
      role, roomId: i.roomId, selfPeerId: i.self.peerId, peerPeerId: i.peer.peerId,
      th, rk0, ckB0, peerE: i.peer.hello.e, ownE: i.self.secrets.e, rng: i.rng,
    });
    return { role, th, sid, ratchet };
  } finally {
    wipe(rk0, ckB0, i.sent.ss, i.received.ss, i.self.secrets.k.dk);
  }
}

/* ------------------------------------------------- the whole exchange */

export type PairHandshakeOptions = {
  roomId: string;
  check: string;
  selfPeerId: string;
  peerPeerId: string;
  v3: HelloV3Part;
  signer: DeviceSigner;
  mb: MailboxBundle | null;
  acc: HelloAccount | null;
  sth: SignedTreeHead | null;
  rng?: Rng;
};

/**
 * One data channel's handshake: `hello` to send; `acceptHello(peer's)` → the
 * verdict and the KEM message to send; `acceptKem(peer's)`; then, once
 * `ready`, `establish()` → the session. `wipe()` when the channel closes first.
 */
export class PairHandshake {
  private peer: HelloV4 | null = null;
  private sent: { ct: Bytes; ss: Bytes } | null = null;
  private received: { ct: Bytes; ss: Bytes } | null = null;
  private done = false;

  private constructor(private readonly o: PairHandshakeOptions, readonly hello: HelloV4, private readonly secrets: HelloSecrets) {}

  static async start(o: PairHandshakeOptions): Promise<PairHandshake> {
    const { hello, secrets } = await buildHello({ roomId: o.roomId, from: o.selfPeerId, to: o.peerPeerId, v3: o.v3, signer: o.signer, mb: o.mb, acc: o.acc, sth: o.sth, rng: o.rng });
    return new PairHandshake(o, hello, secrets);
  }

  /** Checks the peer's hello; when it is a valid v4 hello, returns the KEM message to send. */
  async acceptHello(raw: unknown, now = Date.now()): Promise<{ verdict: HelloVerdict; kem: KemMessage | null }> {
    if (this.done) throw new P4Error("state", "handshake finished");
    const verdict = await verifyHello(raw, { roomId: this.o.roomId, from: this.o.peerPeerId, to: this.o.selfPeerId, check: this.o.check, now });
    if (!verdict.ok) return { verdict, kem: null };
    if (this.sent) wipe(this.sent.ss);
    this.peer = verdict.hello;
    const built = await buildKemMessage(verdict.hello, this.o.rng);
    this.sent = { ct: built.ct, ss: built.ss };
    return { verdict, kem: built.message };
  }

  /** The peer's KEM message: "ignored" when it answers another hello of ours. */
  async acceptKem(raw: unknown): Promise<"ok" | "ignored"> {
    if (this.done) throw new P4Error("state", "handshake finished");
    const opened = await openKemMessage(raw, { hello: this.hello, secrets: this.secrets });
    if (!opened) return "ignored";
    if (this.received) wipe(this.received.ss);
    this.received = opened;
    return "ok";
  }

  get ready(): boolean { return !this.done && Boolean(this.peer && this.sent && this.received); }

  async establish(): Promise<PairSession> {
    if (!this.ready) throw new P4Error("state", "handshake not complete");
    this.done = true;
    return establishSession({
      roomId: this.o.roomId, check: this.o.check,
      self: { peerId: this.o.selfPeerId, hello: this.hello, secrets: this.secrets },
      peer: { peerId: this.o.peerPeerId, hello: this.peer! },
      sent: this.sent!, received: this.received!, rng: this.o.rng,
    });
  }

  wipe(): void {
    this.done = true;
    wipe(this.secrets.k.dk, this.sent?.ss, this.received?.ss);
  }
}
