// The key directory and key transparency together (protocol 4, § 7.5, § 14):
// what happens when a device uploads its keys, when an account key is set or
// changed, and when sessions end.
//
//   PUT /api/keys/bundle    the v2 device certificate is checked against the
//                           account key, the bundle's signature against the
//                           device key; `acct` is logged when the log does not
//                           show this account key yet (also for accounts whose
//                           key the server learned before 6.12), `dev` when the
//                           device or its certificate is new — BEFORE the
//                           directory keeps the row, so it never serves a key
//                           the log does not show
//   account key set/changed PUT /api/account/identity (AccountStore.setIdentity)
//                           → `acct`; devices certified by the old key leave
//                           the directory with a `rev` entry each
//   a session ends          sign-out on a device / "end this session" → the
//                           devices that uploaded with that session are removed
//                           and logged as `rev`; sign-out everywhere, deletion
//                           of the account or the operator ending all sessions
//                           → every device of the account
//
// A certificate that simply expired is not revoked: its `dev` entry carries
// `exp`. The directory serves only devices whose certificate and bundle are
// still valid and certified by the account key the server knows now.

import { usernameOf, type AccountRecord, type AccountStore } from "../accounts/store";
import { audit } from "../monitor/audit";
import type { DirectoryDevice, KtLookup } from "../../client/src/lib/p4/contract";
import { KtUnavailableError } from "../kt/log";
import { ktUser, type KtService } from "../kt/service";
import { DIRECTORY_LIMITS, devicesPerAccount, toDirectoryDevice, type DirectoryBackend, type DirectoryRow } from "./directory";
import { normalizeAccountKey, parseBundleRequest, verifyDeviceCert, type CheckFailure } from "./verify";

export type PutBundleResult =
  | { ok: true; device: DirectoryDevice; kt: { acct: number | null; dev: number | null } }
  | CheckFailure;

const refuse = (status: number, code: string, message: string): CheckFailure => ({ ok: false, status, code, message });

export class KeyServices {
  private readonly now: () => number;

  constructor(
    readonly accounts: AccountStore,
    readonly directory: DirectoryBackend,
    readonly kt: () => KtService,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  /** Listens to the account store: key changes and ended sessions. Returns the unsubscribe. */
  attach(): () => void {
    const offIdentity = this.accounts.onIdentity((accountId, publicKey) => this.identityChanged(accountId, publicKey));
    const offRevoke = this.accounts.onRevoke((accountId, hash, reason) => this.sessionsEnded(accountId, hash, reason));
    return () => { offIdentity(); offRevoke(); };
  }

  private userOf(account: Pick<AccountRecord, "id" | "username">): string {
    return ktUser(usernameOf(account));
  }

  /* ------------------------------------------------------------ upload */

  putBundle(account: AccountRecord, tokenHash: string | null, body: unknown): PutBundleResult {
    const now = this.now();
    const parsed = parseBundleRequest(body, now);
    if (!parsed.ok) return parsed;
    const req = parsed.value;
    const u = this.userOf(account);

    const known = normalizeAccountKey(account.identity?.publicKey);
    if (req.apk && known && req.apk !== known) {
      return refuse(409, "apk-mismatch", "This is not the account key the server knows; change it with PUT /api/account/identity first.");
    }
    const apk = known ?? req.apk ?? null;
    if (!apk) return refuse(409, "no-account-key", "The server does not know this account's key yet: send apk (or PUT /api/account/identity) first.");
    if (!verifyDeviceCert(apk, req.pk, req.cert.exp, req.cert.sig)) {
      return refuse(400, "bad-cert-signature", "The device certificate is not signed by the account key.");
    }

    const existing = this.directory.get(account.id, req.pk);
    if (existing && existing.bundle.exp > req.bundle.exp) {
      return refuse(409, "stale-bundle", "The directory already has a newer bundle of this device.");
    }
    const others = this.directory.list(account.id).filter((r) => r.pk !== req.pk);
    // Expired certificates leave quietly (their `dev` entry carries exp).
    for (const r of others) if (r.certExp <= now) this.directory.remove(r.accountId, r.pk);
    const live = others.filter((r) => r.certExp > now);
    if (!existing && live.length >= devicesPerAccount()) {
      return refuse(409, "too-many-devices", `An account has at most ${devicesPerAccount()} devices in the key directory; sign out on one you no longer use.`);
    }
    if (!existing && this.directory.count() >= DIRECTORY_LIMITS.totalDevices) {
      return refuse(503, "directory-full", "The key directory of this server is full.");
    }

    const kt = this.kt();
    if (kt.mode === "failed") return refuse(503, "kt-failed", "Key transparency is closed on this server; the key directory takes no new keys.");
    let acct: number | null = null;
    let dev: number | null = null;
    try {
      acct = kt.ensureAccount(u, apk, now);
      const certChanged = !existing || existing.apk !== apk || existing.certExp !== req.cert.exp || existing.certSig !== req.cert.sig;
      if (certChanged) dev = kt.append({ t: "dev", u, apk, dpk: req.pk, exp: req.cert.exp, ts: now });
    } catch (err) {
      if (err instanceof KtUnavailableError) {
        audit.add({ category: "security", level: "error", event: "kt.append-failed", accountId: account.id, status: err.code });
        return refuse(503, `kt-${err.code}`, "Key transparency could not log this key; try again later.");
      }
      throw err;
    }
    // The server learns the account key with the first certificate it checks (clients before 6.12 never sent it).
    if (!known) this.accounts.setIdentity(account.id, apk, now);

    const row: DirectoryRow = {
      accountId: account.id, pk: req.pk, u, apk, certExp: req.cert.exp, certSig: req.cert.sig, bundle: req.bundle,
      tokenHash, createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.directory.put(row);
    if (!existing || dev !== null) {
      audit.add({ category: "account", event: existing ? "keys.device-renewed" : "keys.device-added", accountId: account.id, detail: { devices: live.length + 1, kt: dev !== null } });
    }
    return { ok: true, device: toDirectoryDevice(row), kt: { acct, dev } };
  }

  /* ------------------------------------------------------------ reading */

  /** The account's devices with a valid certificate and bundle, certified by the account key known now. */
  devices(accountId: string): DirectoryDevice[] {
    const account = this.accounts.get(accountId);
    if (!account) return [];
    const now = this.now();
    const apk = normalizeAccountKey(account.identity?.publicKey);
    return this.directory.list(accountId)
      .filter((r) => r.certExp > now && r.bundle.exp > now && (!apk || r.apk === apk))
      .map(toDirectoryDevice);
  }

  /** Every KT entry of the account (null when key transparency is not on). An unknown account: the head, no entries. */
  async lookup(accountId: string | null): Promise<KtLookup | null> {
    const kt = this.kt();
    if (kt.mode !== "on") return null;
    try {
      const account = accountId ? this.accounts.get(accountId) : null;
      if (!account) return { sth: await kt.sth(), entries: [] };
      return await kt.lookup(this.userOf(account));
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------- events */

  /** A device leaves the directory; `rev` is logged while its certificate is still valid. */
  private remove(r: DirectoryRow, why: string): void {
    const now = this.now();
    if (r.certExp > now) {
      try {
        this.kt().append({ t: "rev", u: r.u, apk: r.apk, dpk: r.pk, ts: now });
      } catch (err) {
        audit.add({ category: "security", level: "error", event: "kt.append-failed", accountId: r.accountId, status: err instanceof KtUnavailableError ? err.code : "error", detail: { entry: "rev" } });
      }
    }
    this.directory.remove(r.accountId, r.pk);
    audit.add({ category: "account", event: "keys.device-removed", accountId: r.accountId, status: why });
  }

  /** PUT /api/account/identity set or changed the account key. */
  identityChanged(accountId: string, publicKey: string): void {
    const account = this.accounts.get(accountId);
    const apk = normalizeAccountKey(publicKey);
    if (!account || !apk) return;
    try {
      this.kt().ensureAccount(this.userOf(account), apk, this.now());
    } catch (err) {
      audit.add({ category: "security", level: "error", event: "kt.append-failed", accountId, status: err instanceof KtUnavailableError ? err.code : "error", detail: { entry: "acct" } });
    }
    for (const r of this.directory.list(accountId)) if (r.apk !== apk) this.remove(r, "account-key-changed");
  }

  /** Sessions ended: `hash` one of them, null all of the account's. */
  sessionsEnded(accountId: string, hash: string | null, reason: string): number {
    const rows = this.directory.list(accountId).filter((r) => hash === null || r.tokenHash === hash);
    for (const r of rows) this.remove(r, reason);
    return rows.length;
  }

  status() {
    let devices = 0;
    let accounts = 0;
    try { devices = this.directory.count(); accounts = this.directory.accounts(); } catch { /* the last known numbers */ }
    return { persistent: this.directory.persistent, devices, accounts, devicesPerAccount: devicesPerAccount() };
  }
}
