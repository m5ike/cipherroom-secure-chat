// Identity states, pins and what protocol 4 remembers about peers
// (docs/protocol-v4.md §§ 1, 7.1, 7.4, 12, 14.4; F-13).
//
// States (§ 12.1), as a message carries them (chat-types.ts › MessageIdentity):
//   new       the key is not verified — seen for the first time (`firstSeen`)
//             or seen before, never compared. Never shown as "verified".
//   verified  the user compared the safety number or scanned the QR code — for
//             this name in this room, or (attested devices) for the ACCOUNT
//             together with the name it was verified under (6.12 review P08: a
//             verified account under another name is "new" with `verifiedAs`).
//   changed   a different key for a pinned name (or a device the key
//             transparency log revoked): the messages are held behind a warning
//             until the user accepts the new key.
//   invalid   the signature (protocol 3) or the account certificate does not hold.
//   unsigned  an old client, no signature.
// With `account: true` the device is certified by an account key, and the state
// is the account's — once the server's key log confirmed it (review P04: until
// then `kt` says why not, and it is neither `account` nor `verified`).
// `protocol: 3` marks an older peer ("older protocol").
//
// Name pins are the protocol-3 ones (identity.ts › createPinStore, room +
// name → key id, the account key's id when attested). This book adds, in
// localStorage (all of it public data):
//   * verified accounts (account key → when, and the name verified), across rooms;
//   * the downgrade markers: device keys seen with a valid hello v4 (§ 1);
//   * per device key: its newest mailbox bundle (§ 7.1), its account
//     attestation, and whether it was seen in a valid hello (the device pin);
//   * per room and member reference: the ACCOUNT pinned for that member — kept
//     independently of bundle expiry (review P01) — and the devices seen behind
//     it in live sessions, so a message for an away member is sealed only to
//     devices this client authenticated (§ 7.4);
//   * device keys key transparency reported revoked (§ 12.3);
//   * own devices the user acknowledged (key-transparency self-monitoring, § 14.4).

import type { HelloAccount, MailboxBundle } from "./p4";
import type { MessageIdentity } from "./chat-types";
import type { Signer } from "./envelope";
import { keyFingerprint, keyId, type createPinStore } from "./identity";
import { normalizeDisplayName } from "./names";

type PinStore = ReturnType<typeof createPinStore>;

type DeviceRow = {
  mb?: MailboxBundle;
  /** The account that certified this device (checked by whoever remembered it). */
  apk?: string;
  /** That account's attestation as the device presented it (re-checked for expiry when sealing). */
  acc?: HelloAccount;
  /** When this device key was seen in a valid hello (a live session) — the device pin of § 7.4. */
  hello?: number;
  at: number;
};
type RefRow = {
  pks: string[];
  at: number;
  /** The account pinned for this member (§ 7.4, review P01): from a verified hello, kept past bundle expiry. */
  apk?: string;
};
type AccountRow = { at: number; name?: string };
type BookState = {
  v: 1;
  /** Verified accounts: account key → when the user verified it (and under which name; older rows: a number). */
  accounts: Record<string, number | AccountRow>;
  /** Device keys seen with a valid hello v4 → when first seen. */
  p4: Record<string, number>;
  /** Device key → its newest bundle, account and hello. */
  devices: Record<string, DeviceRow>;
  /** `${roomId}|${ref}` → the member's pinned account and the device keys seen behind that reference. */
  refs: Record<string, RefRow>;
  /** Device keys key transparency says were revoked. */
  revoked: Record<string, number>;
  /** Own account key → device keys the user acknowledged as theirs (self-monitoring). */
  own?: Record<string, Record<string, number>>;
};

const BOOK_KEY = "m5cet:p4trust:v1";
const MAX_DEVICES = 300;
const MAX_REFS = 500;
const empty = (): BookState => ({ v: 1, accounts: {}, p4: {}, devices: {}, refs: {}, revoked: {}, own: {} });

const trim = <T extends { at: number }>(rows: Record<string, T>, max: number, keep?: (row: T) => boolean): Record<string, T> => {
  const entries = Object.entries(rows);
  if (entries.length <= max) return rows;
  // Account pins (`keep`) go last: they must outlive the 7-day bundles and the devices that come and go.
  return Object.fromEntries(entries.sort((a, b) => Number(Boolean(keep?.(b[1]))) - Number(Boolean(keep?.(a[1]))) || b[1].at - a[1].at).slice(0, max));
};

const sameName = (a: string, b: string) => normalizeDisplayName(a).toLowerCase() === normalizeDisplayName(b).toLowerCase();

/** A device a message for an away member may be sealed to (p4-away.ts › AwayDevice). */
export type SealableDevice = { pk: string; mb: MailboxBundle; apk?: string };

export class TrustBook {
  private memory: BookState = empty();

  constructor(private readonly storage: Storage | null = (() => { try { return localStorage; } catch { return null; } })()) {}

  private read(): BookState {
    if (!this.storage) return this.memory;
    try {
      const raw = JSON.parse(this.storage.getItem(BOOK_KEY) || "null") as Partial<BookState> | null;
      return raw && raw.v === 1 ? { ...empty(), ...raw } as BookState : empty();
    } catch { return empty(); }
  }

  private write(state: BookState): void {
    state.devices = trim(state.devices, MAX_DEVICES, (d) => Boolean(d.hello));
    state.refs = trim(state.refs, MAX_REFS, (r) => Boolean(r.apk));
    if (!this.storage) { this.memory = state; return; }
    try { this.storage.setItem(BOOK_KEY, JSON.stringify(state)); } catch { this.memory = state; }
  }

  /* -------------------------------------------- downgrade markers (§ 1) */

  /** Was this device key ever seen with a valid hello v4? */
  p4Seen(pk: string): boolean { return Boolean(this.read().p4[pk]); }

  markP4(pk: string, now = Date.now()): void {
    const s = this.read();
    if (s.p4[pk]) return;
    s.p4[pk] = now;
    this.write(s);
  }

  /* ---------------------------------------------- verified accounts (§ 12.2) */

  /** Was this account verified by the user (under any name)? */
  accountVerified(apk: string): boolean { return Boolean(this.read().accounts[apk]); }

  /**
   * Review P08: is this account verified FOR this display name? "yes";
   * `{ other }` when it was verified under another name (the claim differs —
   * a warning, not "verified"); "no". A row from before 6.12's fix has no
   * name: it counts only where the name pin itself is verified.
   */
  accountVerifiedFor(apk: string, name: string): "yes" | "no" | { other: string } {
    const row = this.read().accounts[apk];
    if (!row || typeof row === "number" || !row.name) return "no";
    return sameName(row.name, name) ? "yes" : { other: row.name };
  }

  /** The user verified this account (safety number / QR) while it wrote as `name`. */
  verifyAccount(apk: string, name?: string, now = Date.now()): void {
    const s = this.read();
    s.accounts[apk] = { at: now, ...(name ? { name: normalizeDisplayName(name) } : {}) };
    this.write(s);
  }

  /* ------------------------------------------------- devices (§ 7.1, 7.4) */

  /**
   * A peer's device as the caller verified it: its bundle (signature checked),
   * its account (`apk`, `acc`: only a VALID attestation), and `hello` when it
   * was seen in a valid hello of a live session (the device pin of § 7.4). A
   * device learned from a relayed item has no `hello`: it is never sealed to
   * on that ground.
   */
  rememberDevice(pk: string, info: { mb?: MailboxBundle | null; apk?: string | null; acc?: HelloAccount | null; hello?: boolean }, now = Date.now()): void {
    const s = this.read();
    const cur = s.devices[pk];
    const mb = info.mb && (!cur?.mb || info.mb.exp >= cur.mb.exp) ? info.mb : cur?.mb;
    const apk = info.apk ?? cur?.apk;
    const acc = info.acc && info.acc.apk === apk ? info.acc : cur?.acc && cur.acc.apk === apk ? cur.acc : undefined;
    const hello = info.hello ? now : cur?.hello;
    s.devices[pk] = { ...(mb ? { mb } : {}), ...(apk ? { apk } : {}), ...(acc ? { acc } : {}), ...(hello ? { hello } : {}), at: now };
    this.write(s);
  }

  device(pk: string): DeviceRow | null { return this.read().devices[pk] ?? null; }

  /**
   * § 7.4 (review P01): the account pinned for the member behind this room
   * reference — set from a verified hello `acc`, kept independently of bundle
   * expiry. "conflict": another account is pinned (a changed key: not
   * replaced here — the user accepts it with `repinAccount`).
   */
  pinAccount(roomId: string, ref: string, apk: string, now = Date.now()): "new" | "match" | "conflict" {
    if (!ref || !apk) return "conflict";
    const s = this.read();
    const slot = `${roomId}|${ref}`;
    const row = s.refs[slot] ?? { pks: [], at: now };
    if (row.apk && row.apk !== apk) return "conflict";
    const fresh = !row.apk;
    s.refs[slot] = { ...row, apk, at: now };
    this.write(s);
    return fresh ? "new" : "match";
  }

  /** The user accepted a changed key: this member's account is now `apk` (its old devices no longer count). */
  repinAccount(roomId: string, ref: string, apk: string, now = Date.now()): void {
    if (!ref || !apk) return;
    const s = this.read();
    const slot = `${roomId}|${ref}`;
    const row = s.refs[slot] ?? { pks: [], at: now };
    s.refs[slot] = { pks: row.pks.filter((pk) => s.devices[pk]?.apk === apk), at: now, apk };
    this.write(s);
  }

  /** The account pinned for this member (independent of any bundle's expiry), or null. */
  accountOf(roomId: string, ref: string): string | null { return this.read().refs[`${roomId}|${ref}`]?.apk ?? null; }

  /**
   * A device seen behind a member's room-scoped reference (they may come back
   * away). The reference comes from the server, so it never moves a device
   * between accounts (review P01): refused (false) when the member's pinned
   * account is not the device's, or when a device without an account was
   * already seen behind ANOTHER reference of this room.
   */
  rememberRef(roomId: string, ref: string, pk: string, now = Date.now()): boolean {
    if (!ref) return false;
    const s = this.read();
    const slot = `${roomId}|${ref}`;
    const row = s.refs[slot];
    const dev = s.devices[pk];
    if (row?.apk && dev?.apk !== row.apk) return false;
    if (!dev?.apk) {
      for (const [other, r] of Object.entries(s.refs)) {
        if (other !== slot && other.startsWith(`${roomId}|`) && r.pks.includes(pk)) return false;
      }
    }
    const pks = [pk, ...(row?.pks ?? []).filter((x) => x !== pk)].slice(0, 16);
    s.refs[slot] = { ...(row ?? {}), pks, at: now };
    this.write(s);
    return true;
  }

  /** Devices (with a bundle valid at `now`) seen behind this reference — what was remembered, nothing checked. */
  devicesOfRef(roomId: string, ref: string, now = Date.now()): SealableDevice[] {
    const s = this.read();
    const out: SealableDevice[] = [];
    for (const pk of s.refs[`${roomId}|${ref}`]?.pks ?? []) {
      const d = s.devices[pk];
      if (d?.mb && d.mb.exp > now && !s.revoked[pk]) out.push({ pk, mb: d.mb, ...(d.apk ? { apk: d.apk } : {}) });
    }
    return out;
  }

  /**
   * § 7.4 rule 1 (review P01): the remembered devices of this member a message
   * may be sealed to — seen in a valid hello (the device pin), a bundle valid
   * now, not revoked; and when the member's account is pinned, certified by
   * THAT account with an attestation still valid now (v2 not expired; v1 has
   * no expiry — its signature was checked when the hello was).
   */
  sealableDevicesOfRef(roomId: string, ref: string, now = Date.now()): SealableDevice[] {
    const s = this.read();
    const row = s.refs[`${roomId}|${ref}`];
    const pinned = row?.apk ?? null;
    const out: SealableDevice[] = [];
    for (const pk of row?.pks ?? []) {
      const d = s.devices[pk];
      if (!d?.hello || !d.mb || d.mb.exp <= now || s.revoked[pk]) continue;
      if (pinned) {
        if (d.apk !== pinned || !d.acc || d.acc.apk !== pinned) continue;
        if (d.acc.cv === 2 && !(typeof d.acc.exp === "number" && d.acc.exp > now)) continue;
      }
      out.push({ pk, mb: d.mb, ...(d.apk ? { apk: d.apk } : {}) });
    }
    return out;
  }

  /* ---------------------------------------------- revocation (§ 12.3) */

  markRevoked(pk: string, now = Date.now()): void {
    const s = this.read();
    s.revoked[pk] = now;
    this.write(s);
  }

  isRevoked(pk: string): boolean { return Boolean(this.read().revoked[pk]); }

  /* ------------------------------------ own devices (§ 14.4, review P04) */

  /** Is this device key one of ours the user acknowledged (for account `apk`)? */
  ownKnown(apk: string, dpk: string): boolean { return Boolean(this.read().own?.[apk]?.[dpk]); }

  /** "This is my device": the self-monitoring stops reporting it. */
  acknowledgeOwn(apk: string, dpk: string, now = Date.now()): void {
    const s = this.read();
    const own = s.own ?? {};
    own[apk] = { ...(own[apk] ?? {}), [dpk]: now };
    s.own = own;
    this.write(s);
  }

  clear(): void {
    this.memory = empty();
    try { this.storage?.removeItem(BOOK_KEY); } catch { /* ignore */ }
  }
}

/* -------------------------------------------------------------- states */

/** What the key log says about an attested device (p4-kt.ts › KtVerdict): only "ok" / "off" let it count as the account's. */
export type KtStanding = "ok" | "off" | "pending" | "absent" | "unverified";

export type IdentityInput = {
  signer: Signer | null;
  /** The account certificate's version (`acc.cv`): 1 = without expiry. */
  certVersion?: 1 | 2;
  protocol: 3 | 4;
  /** The pins' room (the readable room name, as protocol 3 pinned it) and the sender's name. */
  room: string;
  name: string;
  /**
   * Review P04 (§ 14.4): the key log's word on this attested device. Absent or
   * "off" (no log to ask): as before. "pending" / "absent" / "unverified": the
   * device is NOT shown as the account's, nor verified — `kt` says why.
   */
  kt?: KtStanding;
};

/**
 * The state a message's sender is shown with (§ 12.1). Pins the key on first
 * sight (trust on first use) — "new", never "verified" by itself.
 */
export async function evaluateIdentity(input: IdentityInput, pins: PinStore, book: TrustBook): Promise<MessageIdentity> {
  const signer = input.signer;
  if (!signer) return { state: "unsigned", protocol: input.protocol };
  const byAccount = Boolean(signer.valid && signer.account?.valid);
  const pinned = byAccount ? signer.account!.publicKey : signer.publicKey;
  const kid = await keyId(pinned);
  const fingerprint = await keyFingerprint(pinned);
  const base = { kid, fingerprint, account: byAccount, protocol: input.protocol, ...(byAccount && input.certVersion === 1 ? { certV1: true } : {}) };
  if (!signer.valid || (signer.account && !signer.account.valid)) return { state: "invalid", ...base };
  let verdict = pins.check(input.room, input.name, kid);
  // The same device signing in to its account is an upgrade, not a stranger.
  if (verdict === "changed" && byAccount && pins.pinned(input.room, input.name) === await keyId(signer.publicKey)) {
    pins.accept(input.room, input.name, kid);
    verdict = "match";
  }
  if (book.isRevoked(signer.publicKey)) return { state: "changed", ...base, revoked: true };
  if (verdict === "changed") return { state: "changed", ...base };
  // Review P08: an account counts as verified only together with the name it was verified under.
  const forName = byAccount ? book.accountVerifiedFor(pinned, input.name) : "no";
  const verified = pins.isVerified(input.room, input.name, kid) || forName === "yes";
  const verifiedAs = typeof forName === "object" ? { verifiedAs: forName.other } : {};
  const state: "verified" | "new" = verified ? "verified" : "new";
  // Review P04: the key log has not confirmed this account (yet): neither "account" nor "verified".
  const kt = byAccount ? input.kt : undefined;
  if (kt === "pending" || kt === "absent" || kt === "unverified") {
    return { state: "new", ...base, account: false, kt, ktState: state, ktSlot: `${kid}:${await keyId(signer.publicKey)}`, ...verifiedAs, ...(verdict === "new" ? { firstSeen: true } : {}) };
  }
  return verified
    ? { state: "verified", checked: true, ...base }
    : { state: "new", ...base, ...verifiedAs, ...(verdict === "new" ? { firstSeen: true } : {}) };
}

/** The slot a pending key-log check is known by in messages (`MessageIdentity.ktSlot`). */
export async function ktSlotOf(apk: string, pk: string): Promise<string> {
  return `${await keyId(apk)}:${await keyId(pk)}`;
}

/** The user compared safety numbers (or scanned the QR code): pin as verified — the account (with this name) everywhere, else the name here. */
export async function markVerified(pins: PinStore, book: TrustBook, room: string, name: string, device: { pk: string; apk?: string | null }): Promise<void> {
  if (device.apk) {
    book.verifyAccount(device.apk, name);
    pins.markVerified(room, name, await keyId(device.apk));
    return;
  }
  pins.markVerified(room, name, await keyId(device.pk));
}

/** The user accepted a changed key (its key id, as the message's identity carries it): it becomes the pin (not verified). */
export async function acceptChanged(pins: PinStore, room: string, name: string, kid: string): Promise<void> {
  pins.accept(room, name, kid);
}

/** The account a protocol-4 hello (or a mailbox item's `sacc`) carries, for the pins. */
export type AccountClaim = { publicKey: string; valid: boolean; v: 1 | 2; exp?: number } | null;

/** § 6 / § 7.3: the Signer a protocol-4 message gets — the device key valid, the account as checked. */
export function signerOf(pk: string, account: AccountClaim): Signer {
  return account ? { publicKey: pk, valid: true, account: { publicKey: account.publicKey, valid: account.valid } } : { publicKey: pk, valid: true };
}

export const isHelloAccount = (v: unknown): v is HelloAccount =>
  Boolean(v) && typeof v === "object" && typeof (v as HelloAccount).apk === "string" && typeof (v as HelloAccount).ac === "string";
