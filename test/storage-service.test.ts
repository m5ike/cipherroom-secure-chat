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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StorageService, SESSION_TTL_MS, roomHash } from "../server/storage/service";
import { _resetMasterKeyForTests } from "../server/storage/keys";

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
    expect(rows.find((r) => r.ownerKind === "session")).toMatchObject({ keyMode: "wrapped", ownerId: session.sessionId });
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
    const broken = new StorageService("/proc/definitely-not-writable/m5cet");
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
