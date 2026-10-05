// Messages for members who are away, protocol 4 (docs/protocol-v4.md § 7, F-09).
//
// Protocol 3 handed the relay one envelope under the ROOM key for every away
// member. Now each away member's devices get the message sealed to their own
// mailbox bundles as `per[ref]` of the relay frame: one `mb` item, or an
// `mb-set` for an account with several devices — but only devices this client
// AUTHENTICATED (6.12 review P01, § 7.4): seen in a valid hello (the device
// pin), and for a member whose account is pinned only that account's devices
// — then also those the server's key directory lists with a v2 certificate by
// that account. A member never authenticated gets the protocol-3 room
// envelope (the server cannot open it; a key the server picked it could), and
// the sender's info view names who got which form.
//
// This device's own bundles: created and renewed by Mailbox.maintain, their
// private keys kept encrypted (p4-store.ts), published in every hello and —
// signed in — uploaded with the account's device certificate v2
// (PUT /api/keys/bundle), so members who never met this device can still
// seal to it.

import {
  checkBundle, Mailbox, mailboxSet, verifyAccount,
  type DeviceSigner, type DirectoryDevice, type HelloAccount, type MailboxBundle, type MailboxItem, type MailboxSet,
} from "./p4";
import type { Attestation } from "./identity";
import { deviceVault, VaultBundleStore } from "./p4-store";

/** Items in one `mb-set` (the server takes 1–16). */
export const MAX_SET_ITEMS = 16;

export type AwayDevice = { pk: string; mb: MailboxBundle; apk?: string };

/** A directory device whose certificate (v2, by `apk`) and bundle (by `pk`) hold now; else null. */
export async function checkDirectoryDevice(d: DirectoryDevice, now = Date.now()): Promise<AwayDevice | null> {
  if (!d || typeof d !== "object" || typeof d.pk !== "string" || typeof d.apk !== "string" || !d.cert || d.cert.v !== 2) return null;
  const cert = await verifyAccount({ apk: d.apk, ac: d.cert.sig, cv: 2, exp: d.cert.exp }, d.pk, now);
  if (!cert?.valid) return null;
  if (await checkBundle(d.bundle, d.pk, now)) return null;
  return { pk: d.pk, mb: d.bundle, apk: d.apk };
}

export type SealForAway = {
  roomId: string;
  id: string;
  payload: unknown;
  /** Room-scoped references of the away members. */
  refs: string[];
  mailbox: Mailbox;
  /** This device's key (it signed our bundle). */
  senderPk: string;
  sacc?: HelloAccount | null;
  /**
   * Devices this client authenticated behind a reference — seen in a valid
   * hello (TrustBook.sealableDevicesOfRef). Rule 1 of § 7.4.
   */
  known: (ref: string) => AwayDevice[];
  /** The key directory over the hub (`key-bundles`); absent when not available. Used only for a pinned account. */
  directory?: (ref: string) => Promise<DirectoryDevice[]>;
  /**
   * The account key this client pinned for that reference's member (from an
   * attested hello, kept past bundle expiry), if any. Every device sealed to
   * must be certified by it; without one the directory is not used at all.
   */
  pinnedAccount?: (ref: string) => string | null;
  /** Device keys key transparency revoked (never sealed to). */
  isRevoked?: (pk: string) => boolean;
  now?: number;
};

/** Per away member: how its copy went (the sender's info view, § 7.4). */
export type AwaySealing = { ref: string; form: "mailbox"; devices: number; account: string | null } | { ref: string; form: "room-key" };

/**
 * § 7.4 (6.12 review P01): `per[ref]` for every away member with at least one
 * device this client may seal to, and the references left without one (they
 * get the protocol-3 room envelope — which the server, not knowing the room
 * key, cannot open). A bundle is NEVER trusted because the server delivered it:
 *
 *   1. a device from `known` (seen in a valid hello) — when the member's
 *      account is pinned, only one of THAT account;
 *   2. a directory device only for a member whose account is pinned, with a
 *      valid v2 certificate by that account key, not revoked.
 *
 * A member we never authenticated (no pinned account, no device seen) gets
 * the room envelope, as in 6.11.
 */
export async function sealForAway(o: SealForAway): Promise<{ per: Record<string, MailboxItem | MailboxSet>; withoutBundle: string[]; devices: number; sealing: AwaySealing[] }> {
  const now = o.now ?? Date.now();
  const per: Record<string, MailboxItem | MailboxSet> = {};
  const withoutBundle: string[] = [];
  const sealing: AwaySealing[] = [];
  let devices = 0;
  for (const ref of o.refs) {
    const pinned = o.pinnedAccount?.(ref) ?? null;
    const byPk = new Map<string, AwayDevice>();
    for (const d of o.known(ref)) {
      if (d.mb.exp <= now || o.isRevoked?.(d.pk)) continue;
      if (pinned && d.apk !== pinned) continue; // a device of another (or no) account behind a pinned member's reference
      byPk.set(d.pk, d);
    }
    if (o.directory && pinned) {
      const listed = await o.directory(ref).catch(() => [] as DirectoryDevice[]);
      for (const raw of listed.slice(0, 32)) {
        const d = await checkDirectoryDevice(raw, now);
        if (!d || d.apk !== pinned || o.isRevoked?.(d.pk)) continue;
        const cur = byPk.get(d.pk);
        if (!cur || d.mb.exp > cur.mb.exp) byPk.set(d.pk, d);
      }
    }
    const items: MailboxItem[] = [];
    for (const d of [...byPk.values()].slice(0, MAX_SET_ITEMS)) {
      try {
        items.push(await o.mailbox.seal({ roomId: o.roomId, id: o.id, payload: o.payload, recipient: { pk: d.pk, bundle: d.mb }, senderPk: o.senderPk, ...(o.sacc ? { sacc: o.sacc } : {}), now }));
      } catch { /* a bundle that does not hold: not sealed to */ }
    }
    if (items.length === 0) { withoutBundle.push(ref); sealing.push({ ref, form: "room-key" }); continue; }
    devices += items.length;
    per[ref] = items.length === 1 ? items[0] : mailboxSet(o.id, items);
    sealing.push({ ref, form: "mailbox", devices: items.length, account: pinned });
  }
  return { per, withoutBundle, devices, sealing };
}

/* ------------------------------------------------- own account, own keys */

let sharedMailbox: { pk: string; mailbox: Mailbox } | null = null;

/** This device's ONE mailbox (the room on screen and the background rooms share its bundles and their keys). */
export function deviceMailbox(signer: DeviceSigner): Mailbox {
  if (!sharedMailbox || sharedMailbox.pk !== signer.publicKey) {
    sharedMailbox = { pk: signer.publicKey, mailbox: new Mailbox(new VaultBundleStore(deviceVault()), signer) };
  }
  return sharedMailbox.mailbox;
}

/** Tests: forget the shared mailbox. */
export function _resetDeviceMailboxForTests(): void { sharedMailbox = null; }

/** The account attestation our hello carries (§ 2 `acc`): v2 while its certificate is valid, else v1. */
export function helloAccountOf(att: Attestation | null | undefined, now = Date.now()): HelloAccount | null {
  if (!att) return null;
  if (att.v2 && att.v2.exp > now) return { apk: att.accountKey, ac: att.v2.sig, cv: 2, exp: att.v2.exp };
  return { apk: att.accountKey, ac: att.cert };
}

export type UploadResult = { ok: true } | { ok: false; code: string };

/** § 7.5: this device's current bundle and its v2 certificate to the key directory. */
export async function uploadBundle(token: string, pk: string, att: Attestation, bundle: MailboxBundle, base = ""): Promise<UploadResult> {
  if (!att.v2) return { ok: false, code: "no-cert-v2" };
  try {
    const res = await fetch(`${base}/api/keys/bundle`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pk, apk: att.accountKey, cert: { v: 2, exp: att.v2.exp, sig: att.v2.sig }, bundle }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { code?: string };
    return { ok: false, code: String(body.code ?? res.status) };
  } catch (err) {
    return { ok: false, code: (err as Error).message || "network" };
  }
}
