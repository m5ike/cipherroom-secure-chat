// Messages for absent members (docs/protocol-v4.md § 7): the mailbox.
//
// Protocol 3 sealed a message for an away member with the ROOM key — anyone
// who ever learns the passphrase could open the relay's backlog (F-09).
// Protocol 4 seals it for each recipient DEVICE, to that device's signed
// mailbox bundle (a P-256 key and an ML-KEM-768 key, renewed weekly):
//
//   ss1 = ECDH(eph, Rb.dh)          fresh per item: forward secrecy for the item
//   ss2 = ECDH(Sb.dh, Rb.dh)        sender's bundle: authenticates the sender —
//                                   deniably, the recipient could compute it too
//   ss3 = ML-KEM.Encaps(Rb.kem)     post-quantum
//   key, iv = HKDF(H(AAD), ss1 || ss2 || ss3, "m5cet/p4/mb", 44)
//
// A bundle's private keys outlive its expiry by MAILBOX_KEEP_MS (the relay's
// retention) and are then wiped: a device seized later cannot open what the
// relay once held (bounded forward secrecy for queued messages).
//
// Private keys go through a `BundleStore`; the integrator persists them
// encrypted (web: IndexedDB / the session cache with a non-extractable key;
// Android: the vault). `MemoryBundleStore` is the in-memory one (tests).

import { KEM, LABEL, MAILBOX_KEEP_MS, MAILBOX_LIFETIME_MS, MAILBOX_RENEW_BEFORE_MS, type HelloAccount, type MailboxBundle, type MailboxItem, type MailboxSet } from "./contract";
import { kemDecaps, kemEncaps, kemKeygen } from "./kem";
import { pad, unpad } from "./pad";
import {
  aesGcmOpen, aesGcmSeal, b64, b64url, concat, ecdh, ecdsaVerify, fromUtf8, H, hB64, hkdf, importEcdhPublic, isSafeCount, join,
  Mutex, P4Error, unb64, unb64url, utf8, wipe, type Bytes, type DeviceSigner,
} from "./primitives";
import { systemRng, type Rng } from "./rng";

/* ------------------------------------------------------------ bundles */

/** One own bundle with its private keys. */
export type BundleKeys = {
  bundle: MailboxBundle;
  /** ECDH private key (non-extractable in the app). */
  dh: CryptoKey;
  /** ML-KEM-768 decapsulation key. */
  kemDk: Bytes;
  created: number;
};

/** Where own bundles and their private keys live; the integrator encrypts them at rest. */
export interface BundleStore {
  all(): Promise<BundleKeys[]>;
  put(keys: BundleKeys): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryBundleStore implements BundleStore {
  private readonly rows = new Map<string, BundleKeys>();
  async all(): Promise<BundleKeys[]> { return [...this.rows.values()]; }
  async put(keys: BundleKeys): Promise<void> { this.rows.set(keys.bundle.id, keys); }
  async remove(id: string): Promise<void> { this.rows.delete(id); }
}

/** § 7.1: the bytes a bundle's `sig` covers. */
export async function bundleSignedData(b: Pick<MailboxBundle, "id" | "dh" | "kem" | "exp">): Promise<Bytes> {
  return join(LABEL.mailboxBundle, b.id, b.dh, await hB64(unb64(b.kem)), b.exp);
}

export function isBundleShape(value: unknown): value is MailboxBundle {
  const b = value as Partial<MailboxBundle> | null;
  if (!b || typeof b !== "object" || typeof b.id !== "string" || typeof b.dh !== "string" || typeof b.kem !== "string" || !isSafeCount(b.exp) || typeof b.sig !== "string") return false;
  try {
    unb64url(b.id, 8);
    unb64(b.dh);
    unb64(b.kem, KEM.ek);
    unb64(b.sig, 64);
    return true;
  } catch {
    return false;
  }
}

/** Checks a peer's bundle: null when it is valid at `now`, else why not. */
export async function checkBundle(bundle: unknown, devicePk: string, now = Date.now()): Promise<"malformed" | "bad-signature" | "expired" | null> {
  if (!isBundleShape(bundle)) return "malformed";
  try { await importEcdhPublic(bundle.dh); } catch { return "malformed"; }
  if (!(await ecdsaVerify(devicePk, await bundleSignedData(bundle), bundle.sig))) return "bad-signature";
  return bundle.exp > now ? null : "expired";
}

/** § 7.1: a new signed bundle. Draws: "mailbox.id", "mailbox.dh", "mailbox.kem-seed". */
export async function createBundle(signer: DeviceSigner, now = Date.now(), rng: Rng = systemRng): Promise<BundleKeys> {
  const id = b64url(rng.bytes(8, "mailbox.id"));
  const dh = await rng.p256("ecdh", "mailbox.dh");
  const kem = kemKeygen(rng, "mailbox.kem-seed");
  const unsigned = { id, dh: dh.spki, kem: b64(kem.ek), exp: now + MAILBOX_LIFETIME_MS };
  const sig = await signer.sign(await bundleSignedData(unsigned));
  return { bundle: { ...unsigned, sig }, dh: dh.privateKey, kemDk: kem.dk, created: now };
}

/* ------------------------------------------------------------ sealing */

/** § 7.2 AAD. */
export function mailboxAad(roomId: string, id: string, senderPk: string, senderBundleId: string, recipientBundleId: string, eph: string, kctHash: string): Bytes {
  return join(LABEL.mailbox, roomId, id, senderPk, senderBundleId, recipientBundleId, eph, kctHash);
}

async function itemKey(aad: Uint8Array, ss1: Uint8Array, ss2: Uint8Array, ss3: Uint8Array): Promise<{ key: Bytes; iv: Bytes }> {
  const ikm = concat(ss1, ss2, ss3);
  const okm = await hkdf(await H(aad), ikm, LABEL.mailbox, 44);
  const out = { key: okm.slice(0, 32), iv: okm.slice(32, 44) };
  wipe(ikm, okm);
  return out;
}

const hasId = (payload: unknown, id: string) => Boolean(payload) && typeof payload === "object" && (payload as { id?: unknown }).id === id;

export type SealInput = {
  roomId: string;
  id: string;
  /** The chat payload; `payload.id` must be `id`. */
  payload: unknown;
  /** The recipient device: its key and its bundle (from its hello or the key directory). */
  recipient: { pk: string; bundle: MailboxBundle };
  /** Our device key (SPKI b64), which signed our bundle. */
  senderPk: string;
  /** Our account attestation, when signed in. */
  sacc?: HelloAccount;
  now?: number;
};

/**
 * § 7.2 with explicit sender keys (the low-level form; `Mailbox.seal` uses
 * its current bundle). The recipient's bundle is checked first (signature by
 * `recipient.pk`, not expired). Draws: "mailbox.eph", "mailbox.kem-m".
 */
export async function sealMailboxItem(i: SealInput, sender: BundleKeys, rng: Rng = systemRng): Promise<MailboxItem> {
  if (!hasId(i.payload, i.id)) throw new P4Error("id-mismatch", "payload.id must be the message id");
  const problem = await checkBundle(i.recipient.bundle, i.recipient.pk, i.now ?? Date.now());
  if (problem) throw new P4Error(problem === "expired" ? "expired" : "signature", `recipient bundle: ${problem}`);
  const Rb = i.recipient.bundle;
  const eph = await rng.p256("ecdh", "mailbox.eph");
  const ss1 = await ecdh(eph.privateKey, Rb.dh);
  const ss2 = await ecdh(sender.dh, Rb.dh);
  const { ct: kct, ss: ss3 } = kemEncaps(unb64(Rb.kem, KEM.ek), rng, "mailbox.kem-m");
  const aad = mailboxAad(i.roomId, i.id, i.senderPk, sender.bundle.id, Rb.id, eph.spki, await hB64(kct));
  const { key, iv } = await itemKey(aad, ss1, ss2, ss3);
  const plain = pad(utf8(JSON.stringify(i.payload)));
  let c: Bytes;
  try { c = await aesGcmSeal(key, iv, aad, plain); } finally { wipe(ss1, ss2, ss3, key, iv, plain); }
  return {
    v: 4, kind: "mb", id: i.id, to: Rb.id, sb: sender.bundle, spk: i.senderPk,
    ...(i.sacc ? { sacc: i.sacc } : {}),
    e: eph.spki, kct: b64(kct), c: b64(c),
  };
}

export type OpenedMailboxItem<T> = {
  payload: T;
  /** The sender's device key: check it against the pins (§ 7.3). */
  spk: string;
  /** The sender's account attestation, to check like a hello's `acc` (`verifyAccount`). */
  sacc: HelloAccount | null;
  /** The sender's bundle (verified with `spk`), to remember with the pin. */
  senderBundle: MailboxBundle;
};

function isItemShape(value: unknown): value is MailboxItem {
  const m = value as Partial<MailboxItem> | null;
  return Boolean(m) && typeof m === "object" && m!.v === 4 && m!.kind === "mb" && typeof m!.id === "string" && typeof m!.to === "string"
    && typeof m!.spk === "string" && typeof m!.e === "string" && typeof m!.kct === "string" && typeof m!.c === "string" && isBundleShape(m!.sb)
    && (m!.sacc === undefined || (typeof m!.sacc === "object" && m!.sacc !== null));
}

/** § 7.3 with the recipient bundle's private keys. Throws on a broken item. */
export async function openMailboxItem<T>(item: MailboxItem, roomId: string, mine: BundleKeys): Promise<OpenedMailboxItem<T>> {
  if (!isItemShape(item)) throw new P4Error("malformed", "not a mailbox item");
  if (item.to !== mine.bundle.id) throw new P4Error("state", "item for another bundle");
  if (!(await ecdsaVerify(item.spk, await bundleSignedData(item.sb), item.sb.sig))) throw new P4Error("signature", "sender bundle not signed by the sender key");
  const kct = unb64(item.kct, KEM.ct);
  const c = unb64(item.c);
  const ss1 = await ecdh(mine.dh, item.e);
  const ss2 = await ecdh(mine.dh, item.sb.dh);
  const ss3 = kemDecaps(kct, mine.kemDk);
  const aad = mailboxAad(roomId, item.id, item.spk, item.sb.id, item.to, item.e, await hB64(kct));
  const { key, iv } = await itemKey(aad, ss1, ss2, ss3);
  let plain: Bytes;
  try { plain = await aesGcmOpen(key, iv, aad, c); } finally { wipe(ss1, ss2, ss3, key, iv); }
  let payload: unknown;
  try { payload = JSON.parse(fromUtf8(unpad(plain))); } catch { throw new P4Error("malformed", "item body is not padded JSON"); } finally { wipe(plain); }
  if (!hasId(payload, item.id)) throw new P4Error("id-mismatch", "payload.id is not the item id");
  return { payload: payload as T, spk: item.spk, sacc: item.sacc ?? null, senderBundle: item.sb };
}

/* --------------------------------------------------------------- sets */

/** § 7.4: one message for every known device of one away account. */
export function mailboxSet(id: string, items: MailboxItem[]): MailboxSet {
  if (items.length === 0 || items.some((m) => m.id !== id)) throw new P4Error("malformed", "a set holds items of one message");
  return { v: 4, kind: "mb-set", id, items };
}

export const isMailboxItem = (v: unknown): v is MailboxItem => (v as { kind?: unknown } | null)?.kind === "mb" && (v as { v?: unknown }).v === 4;
export const isMailboxSet = (v: unknown): v is MailboxSet =>
  (v as { kind?: unknown } | null)?.kind === "mb-set" && (v as { v?: unknown }).v === 4 && Array.isArray((v as { items?: unknown }).items);

/* ------------------------------------------------------------ mailbox */

/**
 * This device's mailbox: keeps a current bundle (renewed MAILBOX_RENEW_BEFORE_MS
 * before expiry), wipes private keys MAILBOX_KEEP_MS after expiry, seals with
 * the current bundle and opens items / sets addressed to any kept bundle.
 */
export class Mailbox {
  private readonly mutex = new Mutex();
  private readonly rng: Rng;

  constructor(private readonly store: BundleStore, private readonly signer: DeviceSigner, opts: { rng?: Rng } = {}) {
    this.rng = opts.rng ?? systemRng;
  }

  /** Renews and wipes as due; returns the bundle created, if any, and the ids wiped. */
  maintain(now = Date.now()): Promise<{ created: MailboxBundle | null; wiped: string[] }> {
    return this.mutex.run(() => this.maintainNow(now));
  }

  private async maintainNow(now: number): Promise<{ created: MailboxBundle | null; wiped: string[] }> {
    const wiped: string[] = [];
    let fresh = false;
    for (const keys of await this.store.all()) {
      if (now >= keys.bundle.exp + MAILBOX_KEEP_MS) {
        wipe(keys.kemDk);
        await this.store.remove(keys.bundle.id);
        wiped.push(keys.bundle.id);
      } else if (keys.bundle.exp - now > MAILBOX_RENEW_BEFORE_MS) {
        fresh = true;
      }
    }
    if (fresh) return { created: null, wiped };
    const keys = await createBundle(this.signer, now, this.rng);
    await this.store.put(keys);
    return { created: keys.bundle, wiped };
  }

  /** The current bundle with its keys (renewing first when due). */
  current(now = Date.now()): Promise<BundleKeys> {
    return this.mutex.run(async () => {
      await this.maintainNow(now);
      const all = (await this.store.all()).filter((k) => k.bundle.exp > now).sort((a, b) => b.bundle.exp - a.bundle.exp);
      return all[0];
    });
  }

  /** § 7.2 with our current bundle. */
  async seal(input: SealInput): Promise<MailboxItem> {
    const mine = await this.current(input.now ?? Date.now());
    if (mine.bundle && this.signer.publicKey !== input.senderPk) throw new P4Error("state", "sender key is not this device's");
    return sealMailboxItem(input, mine, this.rng);
  }

  /**
   * § 7.3: opens an item or a set; null when nothing in it is addressed to a
   * bundle of this device. Keys past `exp + MAILBOX_KEEP_MS` are `wiped` even
   * before `maintain` ran.
   */
  async open<T>(value: MailboxItem | MailboxSet, roomId: string, now = Date.now()): Promise<OpenedMailboxItem<T> | null> {
    const items = isMailboxSet(value) ? value.items : [value];
    if (isMailboxSet(value) && items.some((m) => !isMailboxItem(m) || m.id !== value.id)) throw new P4Error("malformed", "set items of another message");
    const kept = new Map((await this.store.all()).map((k) => [k.bundle.id, k]));
    for (const item of items) {
      const mine = item && typeof item === "object" ? kept.get(item.to) : undefined;
      if (!mine) continue;
      if (now >= mine.bundle.exp + MAILBOX_KEEP_MS) throw new P4Error("wiped", "the bundle's keys are past their retention");
      return openMailboxItem<T>(item, roomId, mine);
    }
    return null;
  }
}
