// Identity states, pins and what protocol 4 remembers about peers
// (docs/protocol-v4.md §§ 1, 7.1, 12; F-13).
//
// States (§ 12.1), as a message carries them (chat-types.ts › MessageIdentity):
//   new       the key is not verified — seen for the first time (`firstSeen`)
//             or seen before, never compared. Never shown as "verified".
//   verified  the user compared the safety number or scanned the QR code — for
//             this name in this room, or (attested devices) for the ACCOUNT, which
//             then stays verified in every room.
//   changed   a different key for a pinned name (or a device the key
//             transparency log revoked): the messages are held behind a warning
//             until the user accepts the new key.
//   invalid   the signature (protocol 3) or the account certificate does not hold.
//   unsigned  an old client, no signature.
// With `account: true` the device is certified by an account key, and the state
// is the account's. `protocol: 3` marks an older peer ("older protocol").
//
// Name pins are the protocol-3 ones (identity.ts › createPinStore, room +
// name → key id, the account key's id when attested). This book adds, in
// localStorage (all of it public data):
//   * verified accounts (account key → when), valid across rooms;
//   * the downgrade markers: device keys seen with a valid hello v4 (§ 1);
//   * the newest mailbox bundle per device key (§ 7.1), with its account key;
//   * per room, the devices seen behind a room-scoped account reference — so a
//     message for an away member can be sealed to their mailboxes (§ 7.4);
//   * device keys key transparency reported revoked (§ 12.3).

import type { HelloAccount, MailboxBundle } from "./p4";
import type { MessageIdentity } from "./chat-types";
import type { Signer } from "./envelope";
import { keyFingerprint, keyId, type createPinStore } from "./identity";

type PinStore = ReturnType<typeof createPinStore>;

type DeviceRow = { mb?: MailboxBundle; apk?: string; at: number };
type BookState = {
  v: 1;
  /** Verified accounts: account key → when the user verified it. */
  accounts: Record<string, number>;
  /** Device keys seen with a valid hello v4 → when first seen. */
  p4: Record<string, number>;
  /** Device key → its newest bundle and account. */
  devices: Record<string, DeviceRow>;
  /** `${roomId}|${ref}` → device keys seen behind that reference. */
  refs: Record<string, { pks: string[]; at: number }>;
  /** Device keys key transparency says were revoked. */
  revoked: Record<string, number>;
};

const BOOK_KEY = "m5cet:p4trust:v1";
const MAX_DEVICES = 300;
const MAX_REFS = 500;
const empty = (): BookState => ({ v: 1, accounts: {}, p4: {}, devices: {}, refs: {}, revoked: {} });

const trim = <T extends { at: number }>(rows: Record<string, T>, max: number): Record<string, T> => {
  const entries = Object.entries(rows);
  if (entries.length <= max) return rows;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, max));
};

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
    state.devices = trim(state.devices, MAX_DEVICES);
    state.refs = trim(state.refs, MAX_REFS);
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

  accountVerified(apk: string): boolean { return Boolean(this.read().accounts[apk]); }

  verifyAccount(apk: string, now = Date.now()): void {
    const s = this.read();
    s.accounts[apk] = now;
    this.write(s);
  }

  /* ------------------------------------------------- bundles (§ 7.1, 7.4) */

  /** A peer's bundle (verified by the caller), remembered with its device key. */
  rememberDevice(pk: string, info: { mb?: MailboxBundle | null; apk?: string | null }, now = Date.now()): void {
    const s = this.read();
    const cur = s.devices[pk];
    const mb = info.mb && (!cur?.mb || info.mb.exp >= cur.mb.exp) ? info.mb : cur?.mb;
    s.devices[pk] = { ...(mb ? { mb } : {}), ...(info.apk ?? cur?.apk ? { apk: (info.apk ?? cur?.apk)! } : {}), at: now };
    this.write(s);
  }

  device(pk: string): DeviceRow | null { return this.read().devices[pk] ?? null; }

  /** The device seen behind a member's room-scoped reference (they may come back away). */
  rememberRef(roomId: string, ref: string, pk: string, now = Date.now()): void {
    if (!ref) return;
    const s = this.read();
    const slot = `${roomId}|${ref}`;
    const pks = [pk, ...(s.refs[slot]?.pks ?? []).filter((x) => x !== pk)].slice(0, 16);
    s.refs[slot] = { pks, at: now };
    this.write(s);
  }

  /** Devices (with a bundle valid at `now`) seen behind this reference. */
  devicesOfRef(roomId: string, ref: string, now = Date.now()): Array<{ pk: string; mb: MailboxBundle; apk?: string }> {
    const s = this.read();
    const out: Array<{ pk: string; mb: MailboxBundle; apk?: string }> = [];
    for (const pk of s.refs[`${roomId}|${ref}`]?.pks ?? []) {
      const d = s.devices[pk];
      if (d?.mb && d.mb.exp > now && !s.revoked[pk]) out.push({ pk, mb: d.mb, ...(d.apk ? { apk: d.apk } : {}) });
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

  clear(): void {
    this.memory = empty();
    try { this.storage?.removeItem(BOOK_KEY); } catch { /* ignore */ }
  }
}

/* -------------------------------------------------------------- states */

export type IdentityInput = {
  signer: Signer | null;
  /** The account certificate's version (`acc.cv`): 1 = without expiry. */
  certVersion?: 1 | 2;
  protocol: 3 | 4;
  /** The pins' room (the readable room name, as protocol 3 pinned it) and the sender's name. */
  room: string;
  name: string;
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
  const verified = pins.isVerified(input.room, input.name, kid) || (byAccount && book.accountVerified(pinned));
  return verified ? { state: "verified", checked: true, ...base } : { state: "new", ...base, ...(verdict === "new" ? { firstSeen: true } : {}) };
}

/** The user compared safety numbers (or scanned the QR code): pin as verified — the account everywhere, else the name here. */
export async function markVerified(pins: PinStore, book: TrustBook, room: string, name: string, device: { pk: string; apk?: string | null }): Promise<void> {
  if (device.apk) {
    book.verifyAccount(device.apk);
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
