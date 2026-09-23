// @vitest-environment node
//
// Promotion: a session user registers a passkey and their session database
// moves into the account database. The review found it could silently drop
// messages (a read clamp of 5 000), was not atomic, and let session values
// overwrite newer account values. These tests hold it to "everything, in one
// transaction, newest value wins, or nothing at all".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StorageService, type StorageOptions } from "../server/storage/service";
import { _resetMasterKeyForTests } from "../server/storage/keys";
import type { UserDatabase } from "../server/storage/user-store";

let dir = "";
let storage: StorageService;
const passkeyKey = () => randomBytes(32).toString("hex");

async function start(options: StorageOptions = {}) {
  storage = new StorageService(dir, options);
  expect((await storage.init()).ok).toBe(true);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-promote-"));
  _resetMasterKeyForTests();
  process.env.STORAGE_MASTER_KEY = randomBytes(32).toString("hex");
});

afterEach(() => {
  vi.useRealTimers();
  storage?.close();
  delete process.env.STORAGE_MASTER_KEY;
  rmSync(dir, { recursive: true, force: true });
});

function readAll(db: UserDatabase): string[] {
  const ids: string[] = [];
  let cursor = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = db.readMessagesPage({ afterSeq: cursor, limit: 5_000 });
    ids.push(...page.messages.map((m) => `${m.room}/${m.id}`));
    cursor = page.lastSeq;
    if (!page.more) break;
  }
  return ids;
}

/** The raw handle, to plant rows no API would write. */
const raw = (db: UserDatabase) => (db as unknown as { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } }).db;

describe("promoting a session", () => {
  it("moves more than 5 000 messages — all of them — and drops the session only afterwards", async () => {
    await start();
    const session = storage.startSession();
    const temp = storage.openSession(session.sessionId)!;
    const now = Date.now();
    const total = 6_500;
    for (let i = 0; i < total; i += 2_000) {
      temp.putMessages(Array.from({ length: Math.min(2_000, total - i) }, (_, j) => ({
        id: `m${i + j}`, room: (i + j) % 2 ? "alpha" : "beta", createdAt: now - 100_000 + i + j, payload: { n: i + j },
      })));
    }
    temp.addMail({ id: "mail-1", room: "alpha", kind: "message", messageId: "x1", from: { name: "Bob" }, envelope: { iv: "a", ciphertext: "b" }, storedAt: now });
    const sessionFile = storage.global.databasePath(storage.global.getDatabase(session.databaseId)!);

    const promoted = storage.promoteSession(session.sessionId, "acc-alice", passkeyKey());
    expect(promoted).toMatchObject({ ok: true, moved: { messages: total, mailbox: 1 } });

    const db = storage.account("acc-alice")!;
    expect(readAll(db)).toHaveLength(total);
    expect(db.summary().messages).toBe(total);
    expect(Object.fromEntries(db.rooms().map((r) => [r.room, r.messages]))).toEqual({ alpha: total / 2, beta: total / 2 });
    expect(db.mailbox()).toHaveLength(1);
    expect(storage.global.getDatabase(session.databaseId)).toBeNull();
    expect(existsSync(sessionFile)).toBe(false);
  });

  it("keeps the newer value on a conflict and never copies the reserved vault key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await start();
    const key = passkeyKey();
    const t0 = Date.now();

    storage.openAccount("acc-alice", key);
    const account = storage.account("acc-alice")!;
    account.putVault({ profile: { ct: "QUNDT1VOVA==", updatedAt: t0 } });

    const session = storage.startSession();
    const temp = storage.openSession(session.sessionId)!;
    vi.setSystemTime(t0 + 1_000);
    temp.put("theme", "session-old");      // older than the account's
    account.put("lang", "account-old");    // older than the session's
    vi.setSystemTime(t0 + 2_000);
    account.put("theme", "account-new");
    temp.put("lang", "session-new");
    temp.put("draft", "only-in-session");
    // A vault planted under the old kv key must not travel.
    raw(temp).prepare("INSERT INTO kv (key, value, updated_at) VALUES ('vault', ?, ?)").run(JSON.stringify({ profile: { ct: "U0VTU0lPTg==", updatedAt: t0 + 9_999 } }), t0 + 9_999);

    const promoted = storage.promoteSession(session.sessionId, "acc-alice", key);
    expect(promoted).toMatchObject({ ok: true, moved: { keys: 3 } });
    expect(account.get("theme")).toBe("account-new");
    expect(account.get("lang")).toBe("session-new");
    expect(account.get("draft")).toBe("only-in-session");
    expect(account.keys()).not.toContain("vault");
    expect(account.getVault()).toEqual({ profile: { ct: "QUNDT1VOVA==", updatedAt: t0 } });
  });

  it("does not duplicate events the account already has", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await start();
    const key = passkeyKey();
    const at = Date.now();
    storage.openAccount("acc-alice", key);
    const account = storage.account("acc-alice")!;
    account.addEvent({ at, kind: "data-loaded", meta: { n: 1 } });

    const session = storage.startSession();
    const temp = storage.openSession(session.sessionId)!;
    temp.addEvent({ at, kind: "data-loaded", meta: { n: 1 } });   // the same event
    temp.addEvent({ at: at + 1, kind: "draft-saved" });

    storage.promoteSession(session.sessionId, "acc-alice", key);
    const kinds = account.events(100).map((e) => e.kind);
    expect(kinds.filter((k) => k === "data-loaded")).toHaveLength(1);
    expect(kinds).toContain("draft-saved");
  });

  it("moves nothing — and keeps the session — when the account has no room", async () => {
    await start({ limits: { accountQuotaBytes: 300 * 1024 } });
    const session = storage.startSession();
    const temp = storage.openSession(session.sessionId)!;
    temp.putMessages(Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, room: "alpha", createdAt: Date.now(), payload: { text: "q".repeat(2_000) } })));

    const promoted = storage.promoteSession(session.sessionId, "acc-alice", passkeyKey());
    expect(promoted).toMatchObject({ ok: false });
    expect((promoted as { reason: string }).reason).toMatch(/no room/);
    // Nothing half-copied on the account side…
    expect(storage.account("acc-alice")!.summary().messages).toBe(0);
    // …and the session is still there, whole.
    expect(storage.openSession(session.sessionId)!.summary().messages).toBe(300);
  });

  it("drops a session that was registered but never written, without touching disk", async () => {
    await start();
    const session = storage.startSession();
    const promoted = storage.promoteSession(session.sessionId, "acc-alice", passkeyKey());
    expect(promoted).toMatchObject({ ok: true, moved: { messages: 0, keys: 0, mailbox: 0 } });
    expect(storage.global.getDatabase(session.databaseId)).toBeNull();
  });
});
