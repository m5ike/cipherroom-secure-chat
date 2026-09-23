// @vitest-environment node
//
// The server-side storage: a plain global database for what the server must
// know, and one SQLCipher database per user or per anonymous session.
//
// The things worth proving are the security ones: a user database is
// unreadable on disk and with the wrong key, a session database expires and
// can be wiped on demand, and registering a passkey moves the data into a
// database keyed by that passkey and leaves nothing behind.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StorageService, SESSION_TTL_MS, SESSION_MAX_AGE_MS, roomHash, shutdownStorage, type StorageOptions } from "../server/storage/service";
import { DatabaseOpenError, PayloadTooLargeError, QuotaExceededError, ReservedKeyError, SessionLimitError } from "../server/storage/db";
import { UserDatabasePool } from "../server/storage/user-store";
import { _resetMasterKeyForTests, sessionRef } from "../server/storage/keys";

const DAY = 24 * 60 * 60 * 1000;
const passkeyKey = () => randomBytes(32).toString("hex");

let dir = "";
let storage: StorageService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-storage-"));
  _resetMasterKeyForTests();
  process.env.STORAGE_MASTER_KEY = randomBytes(32).toString("base64");
  storage = new StorageService(dir);
  const started = await storage.init();
  expect(started.ok).toBe(true);
});

afterEach(() => {
  storage.close();
  delete process.env.STORAGE_MASTER_KEY;
  rmSync(dir, { recursive: true, force: true });
});

function userDbFiles(): string[] {
  try { return readdirSync(join(dir, "db")).filter((f) => f.endsWith(".db")); } catch { return []; }
}

describe("a signed-in user's database", () => {
  it("opens with the passkey's key and keeps their data", () => {
    const key = passkeyKey();
    const opened = storage.openAccount("acc-alice", key);
    expect(opened).toMatchObject({ ok: true, keyMode: "prf" });

    const db = storage.account("acc-alice")!;
    db.put("profile", { name: "Alice", theme: "midnight" });
    db.putMessages([{ id: "m1", room: "alpha", createdAt: Date.now(), senderName: "Bob", payload: { text: "a secret sentence" } }]);

    expect(db.get<{ name: string }>("profile")!.name).toBe("Alice");
    expect(db.readMessages({ room: "alpha" })).toHaveLength(1);
    expect(db.summary()).toMatchObject({ messages: 1, rooms: 1, keys: 1 });
  });

  it("is ciphertext on disk — the words are not in the file", () => {
    const key = passkeyKey();
    storage.openAccount("acc-alice", key);
    const db = storage.account("acc-alice")!;
    db.putMessages([{ id: "m1", room: "alpha", createdAt: Date.now(), payload: { text: "a secret sentence" } }]);
    storage.releaseAccount("acc-alice"); // flush + close

    const files = userDbFiles();
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(dir, "db", files[0]));
    expect(raw.includes(Buffer.from("a secret sentence"))).toBe(false);
    expect(raw.subarray(0, 15).toString("utf8")).not.toContain("SQLite format");
    // …and only its owner can read the file at all.
    expect(statSync(join(dir, "db", files[0])).mode & 0o077).toBe(0);
  });

  it("refuses a different key instead of showing empty data", () => {
    storage.openAccount("acc-alice", passkeyKey());
    storage.account("acc-alice")!.put("profile", { name: "Alice" });
    storage.releaseAccount("acc-alice");

    const wrong = storage.openAccount("acc-alice", passkeyKey());
    expect(wrong).toMatchObject({ ok: false });
    expect((wrong as { reason: string }).reason).toMatch(/does not open/i);
  });

  it("forgets the key on sign-out, so the file is opaque again", () => {
    const key = passkeyKey();
    storage.openAccount("acc-alice", key);
    storage.account("acc-alice")!.put("profile", { name: "Alice" });
    storage.releaseAccount("acc-alice");

    expect(storage.account("acc-alice")).toBeNull();          // no key in memory
    expect(storage.openAccount("acc-alice", key).ok).toBe(true); // the user brings it back
    expect(storage.account("acc-alice")!.get<{ name: string }>("profile")!.name).toBe("Alice");
  });

  it("needs a key at all", () => {
    expect(storage.openAccount("acc-alice", "not-a-key")).toMatchObject({ ok: false });
    expect(storage.openAccount("acc-alice", undefined)).toMatchObject({ ok: false });
  });
});

describe("a session without a passkey", () => {
  it("gets a temporary database that lives for a day", () => {
    const session = storage.startSession();
    expect(session.sessionId).toMatch(/^sess-/);
    expect(session.expiresAt - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 5_000);

    const db = storage.openSession(session.sessionId)!;
    db.putMessages([{ id: "m1", room: "alpha", createdAt: Date.now(), payload: { text: "hello" } }]);
    expect(storage.openSession(session.sessionId)!.readMessages()).toHaveLength(1);

    const row = storage.global.findDatabase("session", session.sessionId)!;
    expect(row.keyMode).toBe("wrapped");
  });

  it("is swept once it expires, file and index row together", () => {
    const session = storage.startSession();
    storage.openSession(session.sessionId)!.put("x", 1);
    expect(userDbFiles()).toHaveLength(1);

    const swept = storage.sweep(Date.now() + SESSION_TTL_MS + 1_000);
    expect(swept.databases).toBe(1);
    expect(userDbFiles()).toHaveLength(0);
    expect(storage.openSession(session.sessionId)).toBeNull();
  });

  it("goes away at once when the user clears everything", () => {
    const session = storage.startSession();
    storage.openSession(session.sessionId)!.put("x", 1);

    expect(storage.forget({ sessionId: session.sessionId })).toEqual({ removed: true });
    expect(userDbFiles()).toHaveLength(0);
    expect(storage.forget({ sessionId: session.sessionId })).toEqual({ removed: false });
  });

  it("resumes the same database for a returning browser", () => {
    const first = storage.startSession();
    storage.openSession(first.sessionId)!.put("draft", "unsent");
    const again = storage.startSession(first.sessionId);
    expect(again.databaseId).toBe(first.databaseId);
    expect(storage.openSession(first.sessionId)!.get("draft")).toBe("unsent");
  });

  it("does not resume a made-up session id", () => {
    const fresh = storage.startSession("sess-not-a-real-session-id-here");
    expect(fresh.sessionId).not.toBe("sess-not-a-real-session-id-here");
    expect(storage.openSession("nonsense")).toBeNull();
  });
});

describe("registering a passkey mid-session", () => {
  it("moves the data into a database keyed by the passkey and drops the old one", () => {
    const session = storage.startSession();
    const temp = storage.openSession(session.sessionId)!;
    temp.put("profile", { name: "Anon" });
    temp.putMessages([
      { id: "m1", room: "alpha", createdAt: Date.now(), payload: { text: "before the passkey" } },
      { id: "m2", room: "alpha", createdAt: Date.now(), payload: { text: "and another" } },
    ]);
    const oldDatabaseId = session.databaseId;

    const key = passkeyKey();
    const promoted = storage.promoteSession(session.sessionId, "acc-alice", key);
    expect(promoted).toMatchObject({ ok: true, moved: { messages: 2, keys: 1 } });

    // Everything is in the account database now…
    const db = storage.account("acc-alice")!;
    expect(db.get<{ name: string }>("profile")!.name).toBe("Anon");
    expect(db.readMessages().map((m) => (m.payload as { text: string }).text)).toEqual(["before the passkey", "and another"]);
    expect(db.events().some((e) => e.kind === "storage.promoted")).toBe(true);

    // …and the temporary one is gone, index row and file.
    expect(storage.global.getDatabase(oldDatabaseId)).toBeNull();
    expect(storage.openSession(session.sessionId)).toBeNull();
    expect(userDbFiles()).toHaveLength(1);
  });

  it("works for someone who had no session data yet", () => {
    const promoted = storage.promoteSession("sess-nothing-here-at-all-x", "acc-bob", passkeyKey());
    expect(promoted).toMatchObject({ ok: true, moved: { messages: 0 } });
    expect(storage.account("acc-bob")).not.toBeNull();
  });

  it("refuses without a usable key and leaves the session alone", () => {
    const session = storage.startSession();
    storage.openSession(session.sessionId)!.put("x", 1);
    expect(storage.promoteSession(session.sessionId, "acc-alice", "short")).toMatchObject({ ok: false });
    expect(storage.openSession(session.sessionId)!.get("x")).toBe(1);
  });
});

describe("the global database", () => {
  it("indexes every database with how it is keyed", () => {
    storage.openAccount("acc-alice", passkeyKey());
    const session = storage.startSession();

    const rows = storage.global.listDatabases();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ownerKind === "account")).toMatchObject({ keyMode: "prf", expiresAt: 0 });
    // The session id is a bearer secret: the index keeps an HMAC of it.
    const sessionRow = rows.find((r) => r.ownerKind === "session")!;
    expect(sessionRow).toMatchObject({ keyMode: "wrapped", ownerId: sessionRef(session.sessionId) });
    expect(sessionRow.ownerId).not.toContain(session.sessionId);
    expect(readFileSync(join(dir, "m5cet.db")).includes(Buffer.from(session.sessionId))).toBe(false);
  });

  it("keeps users and their passkeys, public material only", () => {
    storage.global.upsertUser({ id: "acc-alice", userName: "Alice" });
    storage.global.addPasskey({ credentialId: "cred-1", accountId: "acc-alice", publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 3, label: "MacBook" });
    storage.global.recordLogin("acc-alice");

    expect(storage.global.getUser("acc-alice")).toMatchObject({ userName: "Alice", loginCount: 1 });
    expect(storage.global.listPasskeys("acc-alice")).toHaveLength(1);
    storage.global.updateSignCount("cred-1", 9);
    expect(storage.global.getPasskey("cred-1")).toMatchObject({ signCount: 9, alg: -7 });

    storage.global.deleteUser("acc-alice");
    expect(storage.global.getPasskey("cred-1")).toBeNull();
  });

  it("stores logs with the detail sealed, and reads them back", () => {
    storage.log({ level: "warn", source: "client", event: "decrypt-failed", accountId: "acc-alice", detail: { room: "alpha", note: "a telling detail" } });
    const entries = storage.global.readLogs({ accountId: "acc-alice" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "warn", event: "decrypt-failed" });
    expect(entries[0].detail).toEqual({ room: "alpha", note: "a telling detail" });

    const raw = readFileSync(join(dir, "m5cet.db"));
    expect(raw.includes(Buffer.from("a telling detail"))).toBe(false);
  });

  it("records transfers in detail and prunes old ones", () => {
    storage.recordTransfer({ id: "xfer-1", at: Date.now() - 100 * DAY, direction: "out", transport: "p2p", status: "completed", bytes: 10_000, chunks: 320, accountId: "acc-alice", roomHash: roomHash("alpha"), detail: { name: "burst.bin" } });
    storage.recordTransfer({ id: "xfer-2", at: Date.now(), direction: "in", transport: "proxy", status: "failed", bytes: 5, chunks: 1, detail: { error: "missing chunks" } });

    const rows = storage.global.readTransfers();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "xfer-2", transport: "proxy", status: "failed" });
    expect(rows[0].detail).toEqual({ error: "missing chunks" });
    expect(rows[1].roomHash).not.toContain("alpha"); // the room name never lands here

    expect(storage.global.pruneTransfers(Date.now() - 30 * DAY)).toBe(1);
    expect(storage.global.readTransfers()).toHaveLength(1);
  });

  it("reports what it holds", () => {
    storage.openAccount("acc-alice", passkeyKey());
    storage.startSession();
    storage.log({ level: "info", source: "server", event: "hello" });

    const status = storage.status();
    expect(status).toMatchObject({ available: true, engine: "sqlite+sqlcipher" });
    // Two log lines: the session's creation and the one written above.
    expect(status.stats).toMatchObject({ databases: 2, sessions: 1, logs: 2 });
  });
});

describe("when the driver or the directory is missing", () => {
  it("says storage is off instead of throwing at the caller", async () => {
    // A file where the directory should be: portable, and nothing to clean up.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    const broken = new StorageService(join(blocked, "storage"));
    const started = await broken.init();
    expect(started.ok).toBe(false);
    expect(broken.isAvailable).toBe(false);
    expect(broken.status()).toMatchObject({ available: false, stats: null });
    // The forgiving paths stay quiet…
    expect(broken.forget({ sessionId: "sess-x" })).toEqual({ removed: false });
    expect(broken.account("acc-x")).toBeNull();
    broken.log({ level: "info", source: "server", event: "ignored" });
    // …and the ones that cannot work say so.
    expect(() => broken.startSession()).toThrow();
    broken.close();
  });
});

describe("idle handles", () => {
  it("closes databases nobody touched", () => {
    vi.useFakeTimers();
    try {
      storage.openAccount("acc-alice", passkeyKey());
      expect(storage.status().openDatabases).toBe(1);
      const closed = storage.sweep(Date.now() + 10 * 60 * 1000);
      expect(closed.closed).toBe(1);
      expect(storage.status().openDatabases).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ---------------------------------------------------------------------- */
/* The hardening: every numbered finding of the storage review has a test */
/* ---------------------------------------------------------------------- */

const HOUR = 60 * 60 * 1000;

/** A second service in its own directory, with its own limits. */
async function serviceWith(options: StorageOptions): Promise<StorageService> {
  const other = new StorageService(join(dir, `svc-${randomBytes(4).toString("hex")}`), options);
  expect((await other.init()).ok).toBe(true);
  return other;
}

function filesIn(root: string): string[] {
  try { return readdirSync(join(root, "db")).filter((f) => f.endsWith(".db")); } catch { return []; }
}

describe("anonymous sessions are cheap until used, and capped", () => {
  it("creates no file and opens no handle until the first read or write", () => {
    const session = storage.startSession();
    expect(userDbFiles()).toHaveLength(0);
    expect(storage.status().openDatabases).toBe(0);
    // Resuming does not open it either.
    storage.startSession(session.sessionId);
    expect(userDbFiles()).toHaveLength(0);

    storage.openSession(session.sessionId)!.put("x", 1);
    expect(userDbFiles()).toHaveLength(1);
    expect(storage.status().openDatabases).toBe(1);
  });

  it("caps new sessions per client per hour, and says which cap it hit", async () => {
    const capped = await serviceWith({ limits: { sessionsPerClientPerHour: 2, maxLiveSessions: 3 } });
    try {
      const first = capped.startSession(undefined, { clientKey: "ip:198.51.100.7" });
      capped.startSession(undefined, { clientKey: "ip:198.51.100.7" });
      expect(() => capped.startSession(undefined, { clientKey: "ip:198.51.100.7" })).toThrow(SessionLimitError);
      try { capped.startSession(undefined, { clientKey: "ip:198.51.100.7" }); } catch (err) { expect((err as SessionLimitError).scope).toBe("client"); }
      // Resuming is not a new session and is never refused.
      expect(capped.startSession(first.sessionId, { clientKey: "ip:198.51.100.7" }).sessionId).toBe(first.sessionId);
      // Another client still gets one…
      capped.startSession(undefined, { clientKey: "ip:203.0.113.9" });
      // …until the server-wide cap of live session databases.
      let scope = "";
      try { capped.startSession(undefined, { clientKey: "ip:192.0.2.1" }); } catch (err) { scope = (err as SessionLimitError).scope; }
      expect(scope).toBe("global");
    } finally {
      capped.close();
    }
  });

  it("keeps at most maxOpenHandles databases open, closing the least recently used", async () => {
    const small = await serviceWith({ limits: { maxOpenHandles: 2 } });
    try {
      const ids = [small.startSession(), small.startSession(), small.startSession()].map((s) => s.sessionId);
      ids.forEach((id, i) => small.openSession(id)!.put("n", i));
      expect(small.status().openDatabases).toBe(2);
      // The evicted one simply opens again, data intact.
      expect(small.openSession(ids[0])!.get("n")).toBe(0);
      expect(small.status().openDatabases).toBe(2);
    } finally {
      small.close();
    }
  });

  it("slides a day past the last activity, but never past a week after creation", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      const session = storage.startSession();
      storage.openSession(session.sessionId)!.put("x", 1);
      // A visit every 23 hours keeps it alive…
      for (let visit = 1; visit * 23 * HOUR < SESSION_MAX_AGE_MS; visit += 1) {
        vi.setSystemTime(start + visit * 23 * HOUR);
        const resumed = storage.startSession(session.sessionId);
        expect(resumed.sessionId).toBe(session.sessionId);
        expect(resumed.expiresAt).toBeLessThanOrEqual(start + SESSION_MAX_AGE_MS);
      }
      // …but a week after it was made it is gone, visits or not.
      vi.setSystemTime(start + SESSION_MAX_AGE_MS + 1_000);
      expect(storage.openSession(session.sessionId)).toBeNull();
      expect(storage.startSession(session.sessionId).sessionId).not.toBe(session.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume a session whose wrapped key no longer unwraps", () => {
    const session = storage.startSession();
    const db = storage.global.handleForQueue();
    db.prepare("UPDATE databases SET wrapped_key = ? WHERE id = ?").run(randomBytes(60), session.databaseId);
    const again = storage.startSession(session.sessionId);
    expect(again.sessionId).not.toBe(session.sessionId);
    expect(storage.global.getDatabase(session.databaseId)).toBeNull();
  });

  it("keeps new database files private, journals included", () => {
    const session = storage.startSession();
    storage.openSession(session.sessionId)!.put("x", 1);
    const file = join(dir, "db", userDbFiles()[0]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    if (existsSync(`${file}-wal`)) expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "db")).mode & 0o777).toBe(0o700);
  });
});

describe("account keys", () => {
  it("never hands a cached handle to a different key", () => {
    const key = passkeyKey();
    storage.openAccount("acc-alice", key);
    storage.account("acc-alice")!.put("profile", { name: "Alice" });
    expect(storage.status().openDatabases).toBe(1); // cached

    const wrong = storage.openAccount("acc-alice", passkeyKey());
    expect(wrong).toMatchObject({ ok: false, code: "wrong-key" });
    // The right key still works, and the data is untouched.
    expect(storage.openAccount("acc-alice", key).ok).toBe(true);
    expect(storage.account("acc-alice")!.get("profile")).toEqual({ name: "Alice" });

    // The pool itself checks, too.
    const pool = new UserDatabasePool();
    const path = join(dir, "pool-check.db");
    const right = randomBytes(32);
    pool.open("db-x", path, right);
    expect(() => pool.open("db-x", path, randomBytes(32))).toThrow(DatabaseOpenError);
    expect(pool.open("db-x", path, Buffer.from(right)).open).toBe(true);
    pool.closeAll();
  });

  it("tells a missing or damaged file apart from a wrong key", () => {
    const key = passkeyKey();
    const opened = storage.openAccount("acc-alice", key);
    if (!opened.ok) throw new Error(opened.reason);
    storage.account("acc-alice")!.put("profile", { name: "Alice" });
    storage.releaseAccount("acc-alice");
    const file = join(dir, "db", `${opened.databaseId}.db`);

    writeFileSync(file, randomBytes(8192)); // damaged, but the key is the right one
    expect(storage.openAccount("acc-alice", key)).toMatchObject({ ok: false, code: "corrupt" });
    expect(storage.openAccount("acc-alice", passkeyKey())).toMatchObject({ ok: false, code: "wrong-key" });

    rmSync(file, { force: true }); // the index says it was created: no silent empty database
    expect(storage.openAccount("acc-alice", key)).toMatchObject({ ok: false, code: "missing" });
    expect(existsSync(file)).toBe(false);
  });

  it("stays open while another device still holds it, and zeroes it when the last one lets go", () => {
    const key = passkeyKey();
    storage.openAccount("acc-alice", key, "laptop");
    storage.openAccount("acc-alice", key, "phone");
    const held = (storage as unknown as { accountKeys: Map<string, { key: Buffer }> }).accountKeys.get("acc-alice")!.key;

    storage.releaseAccount("acc-alice", "laptop");
    expect(storage.account("acc-alice")).not.toBeNull();
    storage.releaseAccount("acc-alice", "phone");
    expect(storage.account("acc-alice")).toBeNull();
    expect(held.equals(Buffer.alloc(32))).toBe(true);
  });

  it("drops every holder at once when released without one", () => {
    const key = passkeyKey();
    storage.openAccount("acc-alice", key, "laptop");
    storage.openAccount("acc-alice", key, "phone");
    storage.releaseAccount("acc-alice");
    expect(storage.account("acc-alice")).toBeNull();
  });

  it("forgets a key nobody used for 12 hours", () => {
    storage.openAccount("acc-alice", passkeyKey(), "laptop");
    expect(storage.sweepIdle(Date.now() + 11 * HOUR).keys).toBe(0);
    expect(storage.isAccountOpen("acc-alice")).toBe(true);
    expect(storage.sweepIdle(Date.now() + 13 * HOUR).keys).toBe(1);
    expect(storage.account("acc-alice")).toBeNull();
  });

  it("closes everything and zeroes every key on shutdown", async () => {
    const other = await serviceWith({});
    other.openAccount("acc-alice", passkeyKey());
    const held = (other as unknown as { accountKeys: Map<string, { key: Buffer }> }).accountKeys.get("acc-alice")!.key;
    shutdownStorage(other);
    expect(other.isAvailable).toBe(false);
    expect(other.status().openDatabases).toBe(0);
    expect(held.equals(Buffer.alloc(32))).toBe(true);
  });
});

describe("quotas and size caps", () => {
  it("refuses a write past the database quota and rolls it back", async () => {
    const tight = await serviceWith({ limits: { sessionQuotaBytes: 400 * 1024 } });
    try {
      const session = tight.startSession();
      const db = tight.openSession(session.sessionId)!;
      const chunk = "x".repeat(60_000);
      let refused: unknown = null;
      let stored = 0;
      for (let i = 0; i < 20 && !refused; i += 1) {
        try { db.put(`k${i}`, chunk); stored += 1; } catch (err) { refused = err; }
      }
      expect(refused).toBeInstanceOf(QuotaExceededError);
      expect(db.keys()).toHaveLength(stored);           // the refused write left nothing behind
      expect(db.usedBytes()).toBeLessThanOrEqual(400 * 1024);
      // Deleting makes room again.
      db.remove("k0");
      db.remove("k1");
      expect(() => db.put("again", chunk)).not.toThrow();
    } finally {
      tight.close();
    }
  });

  it("skips a message over the size cap, refuses an oversized value, reserves the vault key", async () => {
    const small = await serviceWith({ userLimits: { maxMessageBytes: 1_000, maxKvBytes: 2_000 } });
    try {
      const db = small.openSession(small.startSession().sessionId)!;
      const result = db.putMessagesDetailed([
        { id: "ok", room: "alpha", createdAt: Date.now(), payload: { text: "fine" } },
        { id: "big", room: "alpha", createdAt: Date.now(), payload: { text: "y".repeat(5_000) } },
      ]);
      expect(result).toMatchObject({ stored: 1, skipped: ["big"] });
      expect(() => db.put("huge", "z".repeat(5_000))).toThrow(PayloadTooLargeError);
      expect(() => db.put("vault", { profile: "mine now" })).toThrow(ReservedKeyError);
    } finally {
      small.close();
    }
  });

  it("stops a read at the byte budget and says there is more", async () => {
    const budget = await serviceWith({ userLimits: { maxReadBytes: 10_000 } });
    try {
      const db = budget.openSession(budget.startSession().sessionId)!;
      const now = Date.now();
      db.putMessages(Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, room: "alpha", createdAt: now + i, payload: { text: "p".repeat(3_000) } })));
      const page = db.readMessagesPage({ afterSeq: 0, limit: 100 });
      expect(page.messages.length).toBeGreaterThan(0);
      expect(page.messages.length).toBeLessThan(10);
      expect(page.more).toBe(true);
      // Paging on from lastSeq gets the rest, each message once.
      const seen = page.messages.map((m) => m.id);
      let cursor = page.lastSeq;
      for (let guard = 0; guard < 20; guard += 1) {
        const next = db.readMessagesPage({ afterSeq: cursor, limit: 100 });
        seen.push(...next.messages.map((m) => m.id));
        cursor = next.lastSeq;
        if (!next.more) break;
      }
      expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    } finally {
      budget.close();
    }
  });
});

describe("messages", () => {
  function sessionDb() {
    return storage.openSession(storage.startSession().sessionId)!;
  }

  it("reads incrementally from the oldest row after the cursor, never skipping", () => {
    const db = sessionDb();
    const t0 = Date.now() - 60_000;
    db.putMessages(Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, room: "alpha", createdAt: t0 + i * 1_000, payload: { i } })));

    // `since`: the OLDEST rows at or after the cursor, ascending.
    expect(db.readMessages({ since: t0 + 2_000, limit: 3 }).map((m) => m.id)).toEqual(["m2", "m3", "m4"]);
    // Without a cursor: the newest, still in ascending order.
    expect(db.readMessages({ limit: 3 }).map((m) => m.id)).toEqual(["m7", "m8", "m9"]);

    // `afterSeq`: server-assigned and monotonic.
    const first = db.readMessagesPage({ afterSeq: 0, limit: 4 });
    expect(first.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(first.more).toBe(true);
    const second = db.readMessagesPage({ afterSeq: first.lastSeq, limit: 4 });
    expect(second.messages.map((m) => m.id)).toEqual(["m4", "m5", "m6", "m7"]);

    // A message that arrives later (even with an older createdAt) is still
    // seen by a reader that pages by seq.
    db.putMessages([{ id: "late", room: "alpha", createdAt: t0 - 5_000, payload: {} }]);
    const third = db.readMessagesPage({ afterSeq: second.lastSeq, limit: 10 });
    expect(third.messages.map((m) => m.id)).toEqual(["m8", "m9", "late"]);
    expect(third.more).toBe(false);
  });

  it("keeps createdAt within a year back and five minutes ahead", () => {
    const db = sessionDb();
    const now = Date.now();
    db.putMessages([
      { id: "future", room: "alpha", createdAt: now + 10 * DAY, payload: {} },
      { id: "ancient", room: "alpha", createdAt: 1, payload: {} },
    ]);
    const byId = new Map(db.readMessages().map((m) => [m.id, m.createdAt]));
    expect(byId.get("future")!).toBeLessThanOrEqual(now + 5 * 60 * 1000 + 1_000);
    expect(byId.get("ancient")!).toBeGreaterThanOrEqual(now - 366 * DAY);
  });

  it("treats the same id in two rooms as two messages", () => {
    const db = sessionDb();
    db.putMessages([
      { id: "m1", room: "alpha", createdAt: Date.now(), payload: { text: "in alpha" } },
      { id: "m1", room: "beta", createdAt: Date.now(), payload: { text: "in beta" } },
    ]);
    expect(db.readMessages({ room: "alpha" })[0].payload).toEqual({ text: "in alpha" });
    expect(db.readMessages({ room: "beta" })[0].payload).toEqual({ text: "in beta" });
    const before = db.readMessages({ room: "alpha" })[0].seq!;

    // Replacing one keeps the count and moves it past the cursor.
    db.putMessages([{ id: "m1", room: "alpha", createdAt: Date.now(), payload: { text: "edited" } }]);
    const after = db.readMessages({ room: "alpha" });
    expect(after).toHaveLength(1);
    expect(after[0].payload).toEqual({ text: "edited" });
    expect(after[0].seq!).toBeGreaterThan(before);
    expect(db.rooms().map((r) => [r.room, r.messages]).sort()).toEqual([["alpha", 1], ["beta", 1]]);
  });

  it("keeps room counts right through deletes, expiry and the cap, and drops empty rooms", async () => {
    const capped = await serviceWith({ userLimits: { maxMessages: 5 } });
    try {
      const db = capped.openSession(capped.startSession().sessionId)!;
      const now = Date.now();
      db.putMessages(Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, room: "alpha", createdAt: now - 10_000 + i, payload: {} })));
      db.putMessages(Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, room: "beta", createdAt: now + i, payload: {} })));
      // Cap of 5: the three oldest (all alpha) went.
      expect(db.summary().messages).toBe(5);
      expect(Object.fromEntries(db.rooms().map((r) => [r.room, r.messages]))).toEqual({ alpha: 1, beta: 4 });

      db.deleteMessages({ room: "alpha" });
      expect(db.rooms().map((r) => r.room)).toEqual(["beta"]);

      db.putMessages([{ id: "short", room: "gamma", createdAt: now, expiresAt: now + 50, payload: {} }]);
      expect(db.trimMessages(now + 1_000)).toBe(1);
      expect(db.rooms().map((r) => r.room)).toEqual(["beta"]);
      expect(db.summary().messages).toBe(4);
    } finally {
      capped.close();
    }
  });
});
