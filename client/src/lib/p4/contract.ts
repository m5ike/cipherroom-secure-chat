// Protocol 4 (M5cet 6.12) — the CONTRACT every implementation shares: the
// web client (client/src/lib/p4/*), the Android app (a Java port, cz.m5cet.app.p4)
// and the server (hub join proof, relay per recipient, key directory, key
// transparency, release manifests). The normative text is docs/protocol-v4.md;
// this file holds its constants and the shapes that cross a wire. Pure.

/* ------------------------------------------------------------ versions */

export const P4 = 4 as const;
/** The capability a protocol-4 client lists in its hello `caps`. */
export const P4_CAP = "p4";

/* ------------------------------------------------------------- labels */
// Every label is ASCII; transcripts join their parts with "|" (spec § 0).

export const LABEL = {
  hello: "m5cet/hello/4",
  transcript: "m5cet/p4/th",
  root: "m5cet/p4/root",
  ratchet: "m5cet/p4/rk",
  pairKey: "m5cet/p4/mk",
  pairAad: "m5cet/p4/pair",
  senderKey: "m5cet/p4/sk",
  mailboxBundle: "m5cet/mb/4",
  mailbox: "m5cet/p4/mb",
  file: "m5cet/p4/file",
  fileMeta: "m5cet/p4/file-meta",
  fileChunk: "m5cet/p4/chunk",
  fileEnd: "m5cet/p4/file-end",
  media: "m5cet/p4/media",
  hubSeed: "m5cet/hub-auth/4",
  hubJoin: "m5cet/hub-join/4",
  deviceCert: "m5cet/device-cert/2",
  ktUser: "m5cet/kt/user|",
  ktSth: "m5cet/kt/sth/4",
  replay: "m5cet/p4/seen",
  skCert: "m5cet/sk-cert/4",
} as const;

/* -------------------------------------------------------------- limits */

/** Skipped message keys kept per chain (pair ratchet and sender keys). */
export const MAX_SKIP = 1_000;
/** Skipped message keys kept per pair session in total. */
export const MAX_SKIPPED_TOTAL = 2_000;
/** A sender-key chain is replaced after this many messages or this long. */
export const SENDER_KEY_ROTATE = { messages: 100, ms: 15 * 60 * 1000 } as const;
/** A mailbox bundle lives this long; its private keys are kept MAILBOX_KEEP_MS past expiry, then wiped. */
export const MAILBOX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const MAILBOX_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
export const MAILBOX_KEEP_MS = 31 * 24 * 60 * 60 * 1000;
/** Device certificates (v2) are valid this long; a device renews at sign-in when less than a third is left. */
export const DEVICE_CERT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** Replay window: message ids remembered per room, how old a message may be, and how far ahead it may be dated before its time is clamped to the receive time (§ 11). */
export const REPLAY = { windowMs: 31 * 24 * 60 * 60 * 1000, futureMs: 5 * 60 * 1000, maxIdsPerRoom: 50_000 } as const;
/** Padding buckets (bytes, padded length INCLUDING the 0x80 marker); above the last, multiples of it. */
export const PAD_BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536] as const;

/** ML-KEM-768 sizes (FIPS 203). */
export const KEM = { ek: 1184, dk: 2400, ct: 1088, ss: 32, seed: 64 } as const;

/* --------------------------------------------------------------- wire */

/** Signed mailbox bundle (spec § 7): published in hello and to the key directory. */
export type MailboxBundle = {
  /** base64url, 8 random bytes. */
  id: string;
  /** P-256 ECDH public key, SPKI base64. */
  dh: string;
  /** ML-KEM-768 encapsulation key, base64. */
  kem: string;
  /** Expiry, ms since the epoch. */
  exp: number;
  /** ECDSA P-256 (device key), raw r||s base64, over join(LABEL.mailboxBundle, id, dh, b64(SHA-256(kem bytes)), exp). */
  sig: string;
};

/** The account attestation a hello carries (spec § 12): the account key and its certificate for this device. */
export type HelloAccount = { apk: string; ac: string; cv?: 2; exp?: number };

/** Hello v4 (spec § 2): the v3 fields unchanged, plus these. */
export type HelloV4Fields = {
  v: 4;
  /** Ephemeral P-256 ECDH public key (SPKI base64), fresh for every hello. */
  e: string;
  /** Ephemeral ML-KEM-768 encapsulation key (base64), fresh for every hello. */
  k: string;
  /** 16 random bytes, base64. */
  n: string;
  mb: MailboxBundle | null;
  acc: HelloAccount | null;
  /** The newest key-transparency tree head this device knows for the server it is on (spec § 14.4). */
  sth: SignedTreeHead | null;
  /** ECDSA (device key) over the hello-4 transcript (spec § 2). */
  sig4: string;
};

/** The KEM message answering a peer's hello (spec § 3). */
export type KemMessage = { kind: "p4-kem"; v: 4; ct: string; r: string };

/** A pair-ratchet frame (spec § 5). */
export type RatchetHeader = { dh: string; pn: number; n: number; kid?: string; kct?: string; kek?: string };
export type RatchetFrame = { kind: "p4"; v: 4; h: RatchetHeader; c: string };
/** Ends a broken session; both sides send a new hello (spec § 5.5). */
export type ResetMessage = { kind: "p4-reset"; v: 4; why: string };

/** Inner messages carried by the pair ratchet (spec § 5.4). */
export type RatchetInner =
  /** `cert`: ECDSA by the chain's own `spk` (raw r||s, b64) over join(LABEL.skCert, roomId, keyId, owner's device pk) — § 6. */
  | { t: "sk"; keyId: string; chain: string; index: number; spk: string; cert: string }
  | { t: "msg"; id: string; p: unknown }
  | { t: "media"; call: string; epoch: number; key: string }
  | { t: "file"; transferId: string; key: string }
  | { t: string; [field: string]: unknown };

/** A sender-key message (spec § 6). No `iv`: it is derived. */
export type SenderKeyEnvelope = { v: 4; id: string; sk: string; n: number; c: string; s: string };

/** A message sealed for one recipient device's mailbox (spec § 7). */
export type MailboxItem = {
  v: 4;
  kind: "mb";
  id: string;
  /** The recipient's bundle id. */
  to: string;
  /** The sender's signed bundle. */
  sb: MailboxBundle;
  /** The sender's device key (SPKI base64) that signed `sb`. */
  spk: string;
  sacc?: HelloAccount;
  /** Ephemeral P-256 public key (SPKI base64). */
  e: string;
  kct: string;
  c: string;
};

/** One message for every known device of one away account (spec § 7.4). */
export type MailboxSet = { v: 4; kind: "mb-set"; id: string; items: MailboxItem[] };

/* -------------------------------------------------------------- server */

/** Hub (spec § 13): the server's first frame gains a nonce, the join frame a proof. */
export type HubHelloNonce = { nonce: string };
export type HubJoinProof = { pub: string; sig: string };
/** In peer views (`joined.peers`, `peer-joined`): did this member prove it knows the room key? */
export type HubPeerProven = { proven: boolean };

/** Relay frame (spec § 7.4): one envelope per recipient reference, else `envelope` for all. */
export type RelayPerRecipient = { per?: Record<string, unknown> };

/** Key directory (spec § 7.5): hub frames `{ type: "key-bundles", ref }` → `{ type: "key-bundles", ref, devices }`
 *  and `{ type: "kt-lookup", ref }` → `{ type: "kt-lookup", ref, lookup }`. */
export type DirectoryDevice = {
  /** Device signing key, SPKI base64. */
  pk: string;
  /** Account key (Ed25519 raw, base64) and its v2 certificate for the device. */
  apk: string;
  cert: { v: 2; exp: number; sig: string };
  bundle: MailboxBundle;
};

/** Key transparency (spec § 14). */
export type KtEntry =
  | { t: "acct"; u: string; apk: string; ts: number }
  | { t: "dev"; u: string; apk: string; dpk: string; exp: number; ts: number }
  | { t: "rev"; u: string; apk: string; dpk: string; ts: number };
export type SignedTreeHead = { size: number; root: string; ts: number; sig: string };
export type KtLookup = { sth: SignedTreeHead; entries: Array<{ entry: KtEntry; index: number; proof: string[] }> };
export type KtConsistency = { from: number; to: number; proof: string[] };

/** Release manifest (spec § 15). */
export type ReleaseManifest = {
  format: "m5cet-release/1";
  name: string;
  version: string;
  commit: string;
  created: string;
  files: Array<{ path: string; size: number; sha256: string }>;
};
