// What ties the passkey accounts to the storage.
//
// Two jobs:
//
//   1. The global database keeps the tables the operator needs — who is
//      registered, which passkeys belong to them, when they signed in. The
//      account store stays the authority for authentication; this mirrors
//      the public facts into SQL so the index, the logs and the transfers
//      all live in one queryable place.
//
//   2. A signed-in user's sealed vault (profile + chat) lives in their own
//      SQLCipher database (its own table, not a settings key) whenever that
//      database is open. While it is locked — before the user sends the key,
//      and on a server without storage — writes go to the file the account
//      store has always used. So both copies can exist, and neither is
//      trusted blindly: a read returns, for the profile and the chat
//      separately, whichever copy is newer, and when the database opens a
//      newer file copy is moved into it (the file stays as a fallback). The
//      blob is sealed by the browser either way — this only decides which
//      encrypted container holds it.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { accountsDir, setVaultBackend, type AccountRecord, type AccountStore } from "../accounts/store";
import type { StorageService } from "./service";
import type { VaultPart, VaultParts } from "./user-store";

const ACCOUNT_ID = /^[A-Za-z0-9_-]{10,64}$/;

function isPart(value: unknown): value is VaultPart {
  return Boolean(value) && typeof (value as VaultPart).ct === "string" && Number.isFinite(Number((value as VaultPart).updatedAt));
}

/** For the profile and the chat separately: the copy with the newer
 *  updatedAt (the first one on a tie). */
export function newestVault(a: VaultParts | null, b: VaultParts | null): VaultParts | null {
  if (!a && !b) return null;
  const out: VaultParts = {};
  for (const part of ["profile", "chat"] as const) {
    const left = a?.[part];
    const right = b?.[part];
    const pick = isPart(left) && isPart(right) ? (Number(right.updatedAt) > Number(left.updatedAt) ? right : left) : isPart(left) ? left : isPart(right) ? right : undefined;
    if (pick) out[part] = { ct: pick.ct, updatedAt: Number(pick.updatedAt) };
  }
  return out;
}

function vaultFilePath(dir: string, accountId: string): string | null {
  return ACCOUNT_ID.test(accountId) ? join(dir, "vault", `${accountId}.json`) : null;
}

function readVaultFile(dir: string, accountId: string): VaultParts | null {
  const path = vaultFilePath(dir, accountId);
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VaultParts;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether `candidate` has a part newer than `current`'s. */
function hasNewer(candidate: VaultParts, current: VaultParts | null): boolean {
  return (["profile", "chat"] as const).some((part) => {
    const next = candidate[part];
    if (!isPart(next)) return false;
    const now = current?.[part];
    return !isPart(now) || Number(next.updatedAt) > Number(now.updatedAt);
  });
}

/**
 * Points the account store's vault at the user's encrypted database, and
 * tells the storage what to do with the file copy. `accounts` (or its
 * directory) says where that file copy lives; default: accountsDir().
 */
export function installVaultBackend(storage: StorageService, accounts?: AccountStore | string): void {
  const dir = typeof accounts === "string" ? accounts : accounts ? accounts.status().dir : accountsDir();

  setVaultBackend({
    read(accountId) {
      const file = readVaultFile(dir, accountId);
      const db = storage.account(accountId);
      let stored: VaultParts | null = null;
      if (db) {
        try { stored = db.getVault(); } catch { stored = null; }
      }
      // Nothing in either place: let the account store use its own fallback.
      return newestVault(stored, file);
    },
    write(accountId, vault) {
      const db = storage.account(accountId);
      if (!db) return false;
      try {
        db.putVault(vault);
        return true;
      } catch {
        return false; // too large, or the database is full: the file takes it
      }
    },
    erase(accountId) {
      try { storage.account(accountId)?.eraseVault(); } catch { /* the database goes with the account anyway */ }
    },
  });

  storage.setVaultFileHooks({
    migrate(accountId, db) {
      const file = readVaultFile(dir, accountId);
      if (!file) return;
      const current = db.getVault();
      if (!hasNewer(file, current)) return;
      db.putVault(newestVault(current, file) ?? {}, { onlyNewer: true });
      storage.log({ level: "info", source: "server", event: "storage.vault.migrated", accountId });
    },
    remove(accountId) {
      const path = vaultFilePath(dir, accountId);
      if (path) rmSync(path, { force: true });
    },
  });
}

/** Mirrors an account and its passkey into the global tables. */
export function recordAccount(storage: StorageService, account: AccountRecord, event: "register" | "sign-in", meta: Record<string, string | number | boolean> = {}): void {
  if (!storage.isAvailable) return;
  try {
    storage.global.upsertUser({ id: account.id, userName: account.userName, createdAt: account.createdAt });
    storage.global.addPasskey({
      credentialId: account.credential.credentialId,
      accountId: account.id,
      publicKey: account.credential.publicKeyJwk,
      alg: account.credential.alg,
      signCount: account.credential.signCount,
    });
    if (event === "sign-in") {
      storage.global.recordLogin(account.id);
      storage.global.updateSignCount(account.credential.credentialId, account.credential.signCount);
    }
    storage.log({ level: "info", source: "server", event: `account.${event}`, accountId: account.id, detail: meta });
  } catch (err) {
    storage.log({ level: "warn", source: "server", event: "account.mirror-failed", accountId: account.id, detail: { error: (err as Error).message } });
  }
}

/** The account (and its data) is gone: drop it from the global tables too. */
export function forgetAccount(storage: StorageService, accountId: string): void {
  if (!storage.isAvailable) return;
  try {
    storage.forget({ accountId });
    storage.global.deleteUser(accountId);
    storage.log({ level: "info", source: "server", event: "account.deleted" });
  } catch { /* the account is gone either way */ }
}

/** Wires both jobs into a running server. */
export function connectAccountsToStorage(storage: StorageService, accounts: AccountStore): void {
  installVaultBackend(storage, accounts);
  // Accounts that existed before storage was switched on still belong in
  // the tables, so bring what the account store already knows.
  if (!storage.isAvailable) return;
  try {
    for (const account of accounts.all()) recordAccount(storage, account, "register", { backfilled: true });
  } catch { /* nothing to backfill */ }
}
