// @vitest-environment node
//
// The account vault between its two homes (server/storage/bridge.ts): the
// user's encrypted database when it is open, the account store's file while
// it is locked. Neither copy wins blindly — the newer one does, for the
// profile and the chat separately — and forgetting an account removes every
// copy, the offline queue and what was logged about it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AccountStore, setVaultBackend } from "../server/accounts/store";
import { StorageService } from "../server/storage/service";
import { connectAccountsToStorage, forgetAccount, newestVault } from "../server/storage/bridge";
import { _resetMasterKeyForTests } from "../server/storage/keys";
import type { StoredCredential } from "../server/accounts/webauthn";

let dir = "";
let storage: StorageService;
let accounts: AccountStore;
let accountId = "";
const key = randomBytes(32).toString("hex");
const b64 = (text: string) => Buffer.from(text).toString("base64");
const credential = (id: string): StoredCredential => ({ credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });
const vaultFile = () => join(dir, "accounts", "vault", `${accountId}.json`);
const readFile = () => JSON.parse(readFileSync(vaultFile(), "utf8")) as { profile?: { ct: string; updatedAt: number }; chat?: { ct: string; updatedAt: number } };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-vault-"));
  _resetMasterKeyForTests();
  process.env.STORAGE_MASTER_KEY = randomBytes(32).toString("base64");
  storage = new StorageService(join(dir, "storage"));
  expect((await storage.init()).ok).toBe(true);
  accounts = new AccountStore(join(dir, "accounts"));
  const created = accounts.create(credential("cred-alice-00000001"), "Alice");
  if (!created.ok) throw new Error(created.reason);
  accountId = created.account.id;
  connectAccountsToStorage(storage, accounts);
});

afterEach(() => {
  setVaultBackend(null);
  storage.close();
  delete process.env.STORAGE_MASTER_KEY;
  rmSync(dir, { recursive: true, force: true });
});

const chat = (text: string) => ({ ct: b64(text), messages: 1, messageBytes: text.length, rooms: 1 });

describe("the vault in two places", () => {
  it("picks the newer copy for each part", () => {
    expect(newestVault(
      { profile: { ct: "A", updatedAt: 5 }, chat: { ct: "B", updatedAt: 1 } },
      { profile: { ct: "C", updatedAt: 2 }, chat: { ct: "D", updatedAt: 9 } },
    )).toEqual({ profile: { ct: "A", updatedAt: 5 }, chat: { ct: "D", updatedAt: 9 } });
    expect(newestVault(null, { chat: { ct: "D", updatedAt: 9 } })).toEqual({ chat: { ct: "D", updatedAt: 9 } });
    expect(newestVault(null, null)).toBeNull();
  });

  it("writes to the file while locked, and moves a newer file copy into the database when it opens", () => {
    const t = Date.now();
    expect(accounts.putVault(accountId, { profile: b64("profile while locked") }, t)).toEqual({ ok: true });
    expect(readFile().profile!.ct).toBe(b64("profile while locked"));

    expect(storage.openAccount(accountId, key).ok).toBe(true);
    const db = storage.account(accountId)!;
    expect(db.getVault()!.profile).toEqual({ ct: b64("profile while locked"), updatedAt: t });
    expect(existsSync(vaultFile())).toBe(true); // the file copy stays as a fallback

    // Open: writes go to the database, the file is left alone.
    accounts.putVault(accountId, { chat: chat("chat while open") }, t + 10);
    expect(db.getVault()!.chat).toEqual({ ct: b64("chat while open"), updatedAt: t + 10 });
    expect(readFile().chat).toBeUndefined();

    // Locked again: the new profile goes to the file…
    storage.releaseAccount(accountId);
    accounts.putVault(accountId, { profile: b64("profile from another device") }, t + 20);
    // …and when the database opens, the newer profile moves in and the
    // database's newer chat is kept.
    storage.openAccount(accountId, key);
    expect(accounts.getVault(accountId)).toEqual({
      profile: { ct: b64("profile from another device"), updatedAt: t + 20 },
      chat: { ct: b64("chat while open"), updatedAt: t + 10 },
    });
    expect(storage.account(accountId)!.getVault()!.profile!.updatedAt).toBe(t + 20);
  });

  it("reads the file copy when it is newer, even while the database is open", () => {
    const t = Date.now();
    storage.openAccount(accountId, key);
    accounts.putVault(accountId, { profile: b64("in the database"), chat: chat("chat in the database") }, t);
    // Another process (or an older server) wrote a newer chat to the file.
    mkdirSync(join(dir, "accounts", "vault"), { recursive: true });
    writeFileSync(vaultFile(), JSON.stringify({ chat: { ct: b64("newer chat in the file"), updatedAt: t + 50 } }));
    expect(accounts.getVault(accountId)).toEqual({
      profile: { ct: b64("in the database"), updatedAt: t },
      chat: { ct: b64("newer chat in the file"), updatedAt: t + 50 },
    });
  });

  it("keeps a vault larger than a settings value in the database", () => {
    storage.openAccount(accountId, key);
    const big = "Q".repeat(5_000_000); // over the 4 MB kv cap, under the chat limit
    expect(accounts.putVault(accountId, { chat: { ct: big, messages: 1, messageBytes: 1, rooms: 1 } })).toEqual({ ok: true });
    expect(storage.account(accountId)!.getVault()!.chat!.ct).toHaveLength(5_000_000);
    expect(existsSync(vaultFile())).toBe(false);
    // …and the settings API cannot touch it.
    expect(storage.account(accountId)!.keys()).not.toContain("vault");
  });
});

describe("forgetting an account", () => {
  it("removes the database, the vault file, queued mail and what was logged", () => {
    accounts.putVault(accountId, { profile: b64("locked profile") });
    expect(existsSync(vaultFile())).toBe(true);
    storage.openAccount(accountId, key);
    const queue = storage.queue()!;
    queue.enqueue({ accountId, room: "alpha", kind: "message", messageId: "m1", from: { peerId: "peer-bob", name: "Bob" }, envelope: { iv: "aQ==", ciphertext: "Yw==" } });
    queue.enqueue({ accountId: "someone-else-0001", room: "alpha", kind: "message", messageId: "m1", from: { peerId: "peer-bob", name: "Bob" }, envelope: { iv: "aQ==", ciphertext: "Yw==" } });
    storage.log({ level: "info", source: "client", event: "hello", accountId });
    storage.recordTransfer({ id: "x1", at: Date.now(), direction: "out", transport: "p2p", status: "completed", accountId });

    forgetAccount(storage, accountId);

    expect(storage.global.findDatabase("account", accountId)).toBeNull();
    expect(storage.isAccountOpen(accountId)).toBe(false);
    expect(existsSync(vaultFile())).toBe(false);
    expect(queue.pending(accountId)).toHaveLength(0);
    expect(queue.pending("someone-else-0001")).toHaveLength(1);
    expect(storage.global.readLogs({ accountId })).toHaveLength(0);
    expect(storage.global.readTransfers({ accountId })).toHaveLength(0);
  });
});
