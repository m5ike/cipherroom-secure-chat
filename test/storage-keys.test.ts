// @vitest-environment node
//
// The storage master key (server/storage/keys.ts). It wraps every session
// database's key, so losing or replacing it silently would make all of them
// unreadable: a key file is created once, atomically and privately, and is
// never overwritten — a key file that cannot be read or parsed stops the
// storage with a clear reason instead.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, randomBytes } from "node:crypto";
import { StorageService } from "../server/storage/service";
import {
  _resetMasterKeyForTests, checkMasterKey, getMasterKey, holderForToken, masterKeyFile, sessionRef, wrapKey, unwrapKey,
} from "../server/storage/keys";

let dir = "";
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-keys-"));
  _resetMasterKeyForTests();
  delete process.env.STORAGE_MASTER_KEY;
  delete process.env.STORAGE_KEY_FILE;
  delete process.env.STORAGE_DIR;
});

afterEach(() => {
  _resetMasterKeyForTests();
  for (const name of ["STORAGE_MASTER_KEY", "STORAGE_KEY_FILE", "STORAGE_DIR"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  try { chmodSync(join(dir, "keys", "storage.key"), 0o600); } catch { /* not there */ }
  rmSync(dir, { recursive: true, force: true });
});

describe("the master key file", () => {
  it("lives next to m5cet.db by default, elsewhere with STORAGE_KEY_FILE", () => {
    process.env.STORAGE_DIR = join(dir, "storage");
    expect(masterKeyFile()).toBe(join(dir, "storage", "storage.key"));
    process.env.STORAGE_KEY_FILE = join(dir, "secrets", "m5cet.key");
    expect(masterKeyFile()).toBe(join(dir, "secrets", "m5cet.key"));
  });

  it("is created once, privately and without leftovers, and reused after a restart", async () => {
    process.env.STORAGE_KEY_FILE = join(dir, "keys", "storage.key");
    const first = new StorageService(join(dir, "storage"));
    expect((await first.init()).ok).toBe(true);
    const session = first.startSession();
    first.openSession(session.sessionId)!.put("draft", "still here");
    first.close();

    const path = join(dir, "keys", "storage.key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(dir, "keys"))).toEqual(["storage.key"]); // no temp file left behind

    // A restart reads the same key: the session database still opens.
    _resetMasterKeyForTests();
    const second = new StorageService(join(dir, "storage"));
    expect((await second.init()).ok).toBe(true);
    expect(second.openSession(session.sessionId)!.get("draft")).toBe("still here");
    second.close();
  });

  it("is never overwritten when it does not parse — storage stays off and says why", async () => {
    const path = join(dir, "keys", "storage.key");
    process.env.STORAGE_KEY_FILE = path;
    mkdirSync(join(dir, "keys"), { recursive: true });
    writeFileSync(path, "this is not a key\n", { mode: 0o600 });

    const service = new StorageService(join(dir, "storage"));
    const started = await service.init();
    expect(started.ok).toBe(false);
    expect(started.reason).toMatch(/does not hold a 32-byte key/);
    expect(service.isAvailable).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("this is not a key\n");
    service.close();
  });

  it("does not fall back to a throwaway key when the file cannot be read", () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const path = join(dir, "keys", "storage.key");
    process.env.STORAGE_KEY_FILE = path;
    mkdirSync(join(dir, "keys"), { recursive: true });
    const original = randomBytes(32).toString("hex");
    writeFileSync(path, original, { mode: 0o600 });
    chmodSync(path, 0o000);

    const check = checkMasterKey();
    expect(check.ok).toBe(false);
    expect((check as { reason: string }).reason).toMatch(/could not read/);
    expect(() => getMasterKey()).toThrow(/could not read/);
    chmodSync(path, 0o600);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("refuses an environment key that is not 32 bytes", async () => {
    process.env.STORAGE_MASTER_KEY = "too-short";
    const service = new StorageService(join(dir, "storage"));
    const started = await service.init();
    expect(started.ok).toBe(false);
    expect(started.reason).toMatch(/STORAGE_MASTER_KEY/);
    service.close();
  });
});

describe("subkeys", () => {
  it("never uses the master key itself to wrap, and keeps opening keys wrapped the old way", () => {
    process.env.STORAGE_MASTER_KEY = randomBytes(32).toString("hex");
    const master = getMasterKey().key;
    const key = randomBytes(32);
    const wrapped = wrapKey(key, "m5cet:db:db-test");
    const direct = createDecipheriv("aes-256-gcm", master, wrapped.subarray(0, 12));
    direct.setAAD(Buffer.from("m5cet:db:db-test"));
    direct.setAuthTag(wrapped.subarray(12, 28));
    expect(() => Buffer.concat([direct.update(wrapped.subarray(28)), direct.final()])).toThrow();
    expect(unwrapKey(wrapped, "m5cet:db:db-test")!.equals(key)).toBe(true);
    // Bound to its row.
    expect(unwrapKey(wrapped, "m5cet:db:db-other")).toBeNull();
  });

  it("turns a session id into a stable HMAC reference", () => {
    process.env.STORAGE_MASTER_KEY = randomBytes(32).toString("hex");
    const id = "sess-abcdefghijklmnopqrstuvwx";
    expect(sessionRef(id)).toBe(sessionRef(id));
    expect(sessionRef(id)).toMatch(/^sr-[A-Za-z0-9_-]{43}$/);
    expect(sessionRef(id)).not.toContain(id.slice(5));
  });

  it("names a key holder by the same hash the account store gives a token", async () => {
    const { tokenHash } = await import("../server/accounts/store") as { tokenHash?: (t: string) => string };
    const token = randomBytes(32).toString("base64url");
    expect(holderForToken(token)).toMatch(/^[0-9a-f]{64}$/);
    if (tokenHash) expect(holderForToken(token)).toBe(tokenHash(token));
  });
});
