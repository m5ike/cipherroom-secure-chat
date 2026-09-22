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
//   2. A signed-in user's sealed vault (profile + chat) moves into their
//      own SQLCipher database as soon as it is open. Until they send the
//      key, and on a server without storage, it keeps using the file the
//      account store has always used — the blob is sealed by the browser in
//      both cases, so nothing about confidentiality changes, only where the
//      encrypted bytes sit.

import { setVaultBackend, type AccountRecord, type AccountStore } from "../accounts/store";
import type { StorageService } from "./service";

type VaultFile = { profile?: { ct: string; updatedAt: number }; chat?: { ct: string; updatedAt: number } };

const VAULT_KEY = "vault";

/** Points the account store's vault at the user's encrypted database. */
export function installVaultBackend(storage: StorageService): void {
  setVaultBackend({
    read(accountId) {
      const db = storage.account(accountId);
      return db ? db.get<VaultFile>(VAULT_KEY) : null;
    },
    write(accountId, vault) {
      const db = storage.account(accountId);
      if (!db) return false;
      try {
        db.put(VAULT_KEY, vault);
        return true;
      } catch {
        return false; // too large for the database: the file takes it
      }
    },
    erase(accountId) {
      storage.account(accountId)?.remove(VAULT_KEY);
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
    storage.log({ level: "info", source: "server", event: "account.deleted", accountId });
  } catch { /* the account is gone either way */ }
}

/** Wires both jobs into a running server. */
export function connectAccountsToStorage(storage: StorageService, accounts: AccountStore): void {
  installVaultBackend(storage);
  // Accounts that existed before storage was switched on still belong in
  // the tables, so bring what the account store already knows.
  if (!storage.isAvailable) return;
  try {
    for (const account of accounts.all()) recordAccount(storage, account, "register", { backfilled: true });
  } catch { /* nothing to backfill */ }
}
