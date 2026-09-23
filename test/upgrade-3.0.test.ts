// @vitest-environment node
//
// An installation of 3.0 upgraded in place: the data it left behind —
// accounts without the 3.1 fields, an offline queue with plain metadata
// and no relay ledger, an audit journal without the hash chain — opens
// with this version, keeps working, and gains the new features. (Room
// envelopes of 3.0 clients: envelope.test.ts.)

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../server/accounts/store";
import { MailQueue, MAILQUEUE_MIGRATIONS } from "../server/accounts/mailqueue";
import { loadSqliteDriver, openPlainDatabase } from "../server/storage/db";
import { GLOBAL_MIGRATIONS } from "../server/storage/schema";
import { GlobalStore } from "../server/storage/global-store";
import { _resetMasterKeyForTests } from "../server/storage/keys";

let dir = "";
const saved = { ...process.env };
beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "m5cet-upgrade-")); });
afterEach(() => { process.env = { ...saved }; _resetMasterKeyForTests(); rmSync(dir, { recursive: true, force: true }); });

const T0 = 1_780_000_000_000;

describe("accounts written by 3.0", () => {
  it("load, keep their passkey, and take a second one and a recovery code", () => {
    const accounts = join(dir, "accounts");
    mkdirSync(accounts, { recursive: true });
    // Exactly the 3.0 record: one credential, no credentials[], wrapped, recovery or identity.
    const record = {
      id: "acc3000000000000000000", userName: "Alice", createdAt: T0, lastLoginAt: T0, loginCount: 4,
      credential: { credentialId: "cred-3-0-000000000001", publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 9 },
      vault: { profileBytes: 0, profileUpdatedAt: 0, chatBytes: 0, chatUpdatedAt: 0, messages: 0, messageBytes: 0, rooms: 0 },
      push: [], away: [{ room: "alpha", name: "Alice", since: T0 }], audit: [{ at: T0, kind: "created" }],
    };
    writeFileSync(join(accounts, "accounts.json"), JSON.stringify({ v: 1, accounts: { [record.id]: record } }), { mode: 0o600 });

    const store = new AccountStore(accounts);
    expect(store.findByCredential("cred-3-0-000000000001")?.userName).toBe("Alice");
    expect(store.allAway()).toEqual([expect.objectContaining({ accountId: record.id, room: "alpha" })]);
    // 3.0 never persisted sessions: there are none, and signing in makes one.
    expect(store.sessionCount()).toBe(0);
    const token = store.issueToken(record.id, T0 + 1000);
    expect(store.resolveToken(token, T0 + 2000)?.id).toBe(record.id);

    const wrapped = { iv: "aXZpdml2aXZpdml2", ct: "Y3RjdGN0Y3RjdGN0Y3RjdGN0Y3RjdGN0" };
    expect(store.addCredential(record.id, { credentialId: "cred-3-1-second-key01", publicKeyJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" }, alg: -7, signCount: 0 }, wrapped, "phone")).toEqual({ ok: true });
    expect(store.setRecovery(record.id, { id: "rec-id-000000000001", verifier: "ab".repeat(32), wrapped })).toEqual({ ok: true });
    const summary = store.summary(record.id) as { passkeys: unknown[]; recovery: unknown };
    expect(summary.passkeys).toHaveLength(2);
    expect(summary.recovery).toBeTruthy();
    // The first passkey still signs in.
    expect(store.credentialOf(record.id, "cred-3-0-000000000001")?.signCount).toBe(9);
    store.flush();
  });
});

describe("the offline queue of 3.0", () => {
  it("hands over items stored before metadata sealing, and gains the relay ledger", () => {
    const path = join(dir, "queue.db");
    // 3.0: only the first migration, plain JSON in from_json, raw sender key.
    const old = openPlainDatabase(path, [MAILQUEUE_MIGRATIONS[0]]);
    old.prepare(`INSERT INTO mail_queue (id, account_id, room, seq, kind, message_id, from_json, sender_key, envelope, state, attempts, stored_at, lease_until, expires_at, bytes)
      VALUES ('q1', 'acc-bob', 'alpha', 1, 'message', 'm-old', ?, 'peer-alice', ?, 'queued', 0, ?, 0, ?, 40)`)
      .run(JSON.stringify({ peerId: "peer-alice", name: "Alice" }), JSON.stringify({ iv: "aXY=", ciphertext: "Y3Q=" }), T0, T0 + 30 * 86_400_000);
    old.prepare("INSERT INTO mail_queue_seq (account_id, room, next_seq) VALUES ('acc-bob', 'alpha', 1)").run();
    old.close();

    const sealer = {
      seal: (text: string, aad: string) => Buffer.from(`${aad}|${text}`).toString("base64"),
      open: (sealed: string, aad: string) => { const raw = Buffer.from(sealed, "base64").toString(); return raw.startsWith(`${aad}|`) ? raw.slice(aad.length + 1) : null; },
    };
    const db = openPlainDatabase(path, []);
    const queue = new MailQueue(db, () => T0 + 1000, sealer);
    const [item] = queue.lease("acc-bob", "alpha");
    expect(item).toMatchObject({ messageId: "m-old", from: { peerId: "peer-alice", name: "Alice" }, envelope: { ciphertext: "Y3Q=" } });
    // New items go in sealed, numbered after the old ones.
    const next = queue.enqueue({ accountId: "acc-bob", room: "alpha", kind: "message", messageId: "m-new", from: { peerId: "peer-carol", name: "Carol" }, envelope: { iv: "aXY=", ciphertext: "Y3Q=" } });
    expect(next).toMatchObject({ ok: true, item: { seq: 2 } });
    queue.rememberRelay("m-new", "alpha", { peerId: "peer-carol", name: "Carol" }, "acc-bob");
    expect(queue.relayOf("m-new")).toMatchObject({ recipients: ["acc-bob"] });
    db.close();
  });
});

describe("the audit journal of 3.0", () => {
  it("keeps its old rows as 'before the chain' and chains everything after", () => {
    process.env.STORAGE_DIR = dir;
    process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
    _resetMasterKeyForTests();
    mkdirSync(join(dir, "db"), { recursive: true });
    const old = openPlainDatabase(join(dir, "m5cet.db"), GLOBAL_MIGRATIONS.filter((m) => m.name !== "004-audit-chain" && !/^0(0[5-9]|[1-9])/.test(m.name)));
    for (let i = 0; i < 5; i++) {
      old.prepare("INSERT INTO audit (at, category, level, event, actor) VALUES (?, 'security', 'warn', ?, 'peer-x')").run(T0 + i, `old.${i}`);
    }
    old.close();

    const store = new GlobalStore(dir);
    for (let i = 0; i < 3; i++) store.appendAudit({ id: 0, at: T0 + 100 + i, category: "security", level: "warn", event: `new.${i}`, actor: "peer-y" });
    const v = store.verifyAudit();
    expect(v).toMatchObject({ ok: true, checked: 3, unchained: 5 });
    store.close?.();
  });
});
