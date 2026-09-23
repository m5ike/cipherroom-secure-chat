// @vitest-environment node
//
// Upgrading a server that ran the first version of the storage: its global
// database holds session ids in the clear and keys wrapped with the master
// key itself; its user databases key messages by id alone and keep the vault
// under a kv key. Opening them with this version must migrate all of that
// without losing a session's data.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { loadSqliteDriver, openPlainDatabase, openUserDatabase } from "../server/storage/db";
import { GLOBAL_MIGRATIONS, USER_MIGRATIONS } from "../server/storage/schema";
import { StorageService } from "../server/storage/service";
import { _resetMasterKeyForTests, sealValue, sessionRef } from "../server/storage/keys";

let dir = "";
let master: Buffer;

/** How the first version wrapped a database key: AES-GCM under the master key. */
function legacyWrap(key: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-migrate-"));
  _resetMasterKeyForTests();
  master = randomBytes(32);
  process.env.STORAGE_MASTER_KEY = master.toString("hex");
});

afterEach(() => {
  delete process.env.STORAGE_MASTER_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("a storage directory from the first version", () => {
  it("rewrites session ids as references, re-wraps keys and migrates the user database", async () => {
    const sessionId = `sess-${randomBytes(18).toString("base64url")}`;
    const dbId = `db-${randomBytes(12).toString("hex")}`;
    const key = randomBytes(32);

    // The old global database: first migration only, ids in the clear.
    const global = openPlainDatabase(join(dir, "m5cet.db"), [GLOBAL_MIGRATIONS[0]]);
    const now = Date.now();
    global.prepare(`INSERT INTO databases (id, owner_kind, owner_id, key_mode, wrapped_key, file_name, created_at, expires_at)
      VALUES (?, 'session', ?, 'wrapped', ?, ?, ?, ?)`).run(dbId, sessionId, legacyWrap(key, `m5cet:db:${dbId}`), `${dbId}.db`, now, now + 60 * 60 * 1000);
    global.prepare("INSERT INTO logs (at, level, source, event, session_id, detail) VALUES (?, 'info', 'client', 'old-line', ?, ?)")
      .run(now, sessionId, sealValue("{\"old\":true}", "m5cet:log"));
    global.prepare("INSERT INTO transfers (id, at, direction, transport, status, session_id) VALUES ('xfer-old', ?, 'out', 'p2p', 'completed', ?)").run(now, sessionId);
    global.close();

    // The old user database: messages keyed by id alone, vault in kv.
    mkdirSync(join(dir, "db"), { recursive: true });
    const user = openUserDatabase(join(dir, "db", `${dbId}.db`), key, [USER_MIGRATIONS[0]]);
    const insert = user.prepare("INSERT INTO messages (id, room, created_at, stored_at, payload, bytes) VALUES (?, ?, ?, ?, ?, 2)");
    insert.run("m1", "alpha", now - 3_000, now, "{}");
    insert.run("m2", "alpha", now - 2_000, now, "{}");
    insert.run("m3", "beta", now - 1_000, now, "{}");
    user.prepare("INSERT INTO rooms (room, first_seen_at, last_seen_at, message_count) VALUES ('alpha', ?, ?, 99), ('empty', ?, ?, 0)").run(now, now, now, now);
    user.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('vault', ?, ?), ('theme', '\"dark\"', ?)")
      .run(JSON.stringify({ profile: { ct: "UFJPRklMRQ==", updatedAt: now - 5 }, chat: { ct: "Q0hBVA==", updatedAt: now - 4 } }), now, now);
    user.close();

    const storage = new StorageService(dir);
    expect((await storage.init()).ok).toBe(true);
    try {
      // The index holds the reference now, and nothing holds the id.
      const row = storage.global.findDatabase("session", sessionId)!;
      expect(row.ownerId).toBe(sessionRef(sessionId));
      expect(readFileSync(join(dir, "m5cet.db")).includes(Buffer.from(sessionId))).toBe(false);
      expect(storage.global.readLogs({ sessionId })[0]).toMatchObject({ event: "old-line", sessionId: sessionRef(sessionId), detail: null });
      expect(storage.global.readTransfers({ sessionId })[0]).toMatchObject({ id: "xfer-old", sessionId: sessionRef(sessionId) });

      // The session still opens (its key was re-wrapped), and its database
      // is on the new schema.
      const db = storage.openSession(sessionId)!;
      expect(db).not.toBeNull();
      const messages = db.readMessages();
      expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
      expect(Object.fromEntries(db.rooms().map((r) => [r.room, r.messages]))).toEqual({ alpha: 2, beta: 1 });
      expect(db.keys()).toEqual(["theme"]);
      expect(db.getVault()).toEqual({ profile: { ct: "UFJPRklMRQ==", updatedAt: now - 5 }, chat: { ct: "Q0hBVA==", updatedAt: now - 4 } });

      // New messages continue the sequence; the same id in another room is fine.
      db.putMessages([{ id: "m1", room: "beta", createdAt: now, payload: {} }]);
      expect(db.readMessagesPage({ afterSeq: 3 }).messages.map((m) => [m.room, m.id, m.seq])).toEqual([["beta", "m1", 4]]);
    } finally {
      storage.close();
    }

    // Opening again changes nothing (the rewrite is idempotent).
    _resetMasterKeyForTests();
    const again = new StorageService(dir);
    expect((await again.init()).ok).toBe(true);
    expect(again.openSession(sessionId)!.summary().messages).toBe(4);
    again.close();
  });
});
