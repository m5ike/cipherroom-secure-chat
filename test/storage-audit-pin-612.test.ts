// @vitest-environment node
// 6.12 (F-23): the audit journal's checkpoints are verified against keys the
// database does not choose — the signing key is derived from the storage
// master key, earlier keys are pinned (MACed) in audit-signing.pin at the
// upgrade — and a row without a hash inside the chain, or rows cut off its
// end, are failures. Before, a forger rewrote the rows, re-signed the head
// with a key of their own and put that key in the checkpoint row.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalStore } from "../server/storage/global-store";
import { loadSqliteDriver } from "../server/storage/db";
import { _resetMasterKeyForTests } from "../server/storage/keys";

let dir = "";
let store: GlobalStore;
const saved = { ...process.env };

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-pin-"));
  process.env.STORAGE_DIR = dir;
  process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
  _resetMasterKeyForTests();
  store = new GlobalStore(dir);
});
afterEach(() => { store.close?.(); process.env = { ...saved }; _resetMasterKeyForTests(); rmSync(dir, { recursive: true, force: true }); });

type Db = { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };
const db = (s = store) => (s as unknown as { handle(): Db }).handle();
const add = (i: number, s = store) => s.appendAudit({ id: 0, at: 1_700_000_000_000 + i, category: "security", level: "warn", event: `ev.${i}`, actor: `peer-${i}`, detail: { i } });
const message = (lastId: number, head: string, at: number) => `m5cet/audit-checkpoint/1|${lastId}|${head}|${at}`;
const kinds = (s = store) => s.verifyAudit().problems.map((p) => p.kind);

/** Re-hashes every row from `fromId` on, as a forger who knows the scheme would. */
function rechain(fromId: number): void {
  const rows = db().prepare("SELECT * FROM audit WHERE id >= ? ORDER BY id").all(fromId) as Array<Record<string, unknown>>;
  let prev = String((db().prepare("SELECT hash FROM audit WHERE id = ?").get(fromId - 1) as { hash?: string } | undefined)?.hash ?? "");
  for (const r of rows) {
    const detail = r.detail ? Buffer.from(r.detail as Buffer).toString("base64") : null;
    const canonical = JSON.stringify([prev, r.at, r.category, r.level, r.event, r.actor, r.target, r.account_id, r.session_ref, r.peer_id, r.room_hash, r.ip, r.bytes, r.status, detail]);
    const hash = createHash("sha256").update(canonical).digest("hex");
    db().prepare("UPDATE audit SET prev_hash = ?, hash = ? WHERE id = ?").run(prev, hash, r.id);
    prev = hash;
  }
}

describe("pinned checkpoint keys", () => {
  it("pins on the first open and verifies a clean journal", () => {
    store.open();
    expect(existsSync(join(dir, "audit-signing.pin"))).toBe(true);
    for (let i = 0; i < 12; i++) add(i);
    store.auditCheckpoint("test");
    const v = store.verifyAudit();
    expect(v).toMatchObject({ ok: true, checked: 12, signedCheckpoints: 1, pinned: { earlierKeys: 0, chainFrom: 1 } });
    // No private key file next to the database any more.
    expect(existsSync(join(dir, "audit-signing.key"))).toBe(false);
  });

  it("refuses a rewritten journal re-signed with the forger's own key (the key in the row is not trusted)", () => {
    for (let i = 0; i < 10; i++) add(i);
    store.auditCheckpoint("test");
    db().prepare("UPDATE audit SET actor = 'innocent' WHERE id = 4").run();
    rechain(4);
    const forger = generateKeyPairSync("ed25519");
    const head = db().prepare("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string };
    const at = Date.now();
    db().prepare("DELETE FROM audit_checkpoints").run();
    db().prepare("INSERT INTO audit_checkpoints (at, last_id, head_hash, reason, signature, public_key) VALUES (?, ?, ?, 'interval', ?, ?)")
      .run(at, head.id, head.hash, sign(null, Buffer.from(message(head.id, head.hash, at)), forger.privateKey).toString("base64"), forger.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    expect(kinds()).toContain("checkpoint-signature");
    expect(store.verifyAudit().ok).toBe(false);
  });

  it("a row stripped of its hash inside the chain is a failure, not 'before the chain'", () => {
    for (let i = 0; i < 6; i++) add(i);
    db().prepare("UPDATE audit SET hash = NULL, prev_hash = NULL WHERE id = 6").run();
    const v = store.verifyAudit();
    expect(v.unchained).toBe(0);
    expect(v.problems).toContainEqual({ id: 6, kind: "row-unchained" });
    // Every row: still a failure (the pin says the chain starts at row 1).
    db().prepare("UPDATE audit SET hash = NULL, prev_hash = NULL").run();
    expect(kinds()).toContain("row-unchained");
  });

  it("notices rows cut off the end behind a checkpoint", () => {
    for (let i = 0; i < 8; i++) add(i);
    store.auditCheckpoint("test");
    db().prepare("DELETE FROM audit WHERE id > 5").run();
    expect(store.verifyAudit().problems).toContainEqual({ id: 8, kind: "rows-missing" });
  });

  it("a pin file edited without the master key is refused", () => {
    store.open();
    const file = join(dir, "audit-signing.pin");
    const pin = JSON.parse(readFileSync(file, "utf8")) as { chainFrom: number };
    pin.chainFrom = 1_000_000;
    writeFileSync(file, JSON.stringify(pin));
    const again = new GlobalStore(dir);
    for (let i = 0; i < 3; i++) add(i, again);
    expect(kinds(again)).toContain("pin-invalid");
    again.close?.();
  });
});

describe("the upgrade from 6.11", () => {
  it("pins the old audit-signing.key for the checkpoints it signed, removes it, and keeps the journal verifiable", () => {
    // A 6.11 journal: chained rows and a checkpoint signed with audit-signing.key
    // (written straight into the table, as 6.11 did); no pin file yet.
    for (let i = 0; i < 9; i++) add(i);
    const legacy = generateKeyPairSync("ed25519");
    const legacyPub = legacy.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const head = db().prepare("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string };
    const at = 1_700_000_100_000;
    db().prepare("INSERT INTO audit_checkpoints (at, last_id, head_hash, reason, signature, public_key) VALUES (?, ?, ?, 'interval', ?, ?)")
      .run(at, head.id, head.hash, sign(null, Buffer.from(message(head.id, head.hash, at)), legacy.privateKey).toString("base64"), legacyPub);
    store.close?.();
    rmSync(join(dir, "audit-signing.pin"));
    writeFileSync(join(dir, "audit-signing.key"), legacy.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

    // The first start of 6.12.
    const after = new GlobalStore(dir);
    after.open();
    const pin = JSON.parse(readFileSync(join(dir, "audit-signing.pin"), "utf8")) as { keys: Array<{ publicKey: string; upTo: number }>; chainFrom: number };
    expect(pin.keys).toEqual([{ publicKey: legacyPub, upTo: head.id }]);
    expect(pin.chainFrom).toBe(1);
    expect(existsSync(join(dir, "audit-signing.key"))).toBe(false);
    let v = after.verifyAudit();
    expect(v).toMatchObject({ ok: true, checked: 9, checkpoints: 1, signedCheckpoints: 1, pinned: { earlierKeys: 1 } });
    // New rows are signed with the derived key.
    for (let i = 9; i < 12; i++) add(i, after);
    after.auditCheckpoint("test");
    v = after.verifyAudit();
    expect(v).toMatchObject({ ok: true, checkpoints: 2, signedCheckpoints: 2 });
    // A copy of the old key cannot vouch for anything newer than what it signed.
    const head2 = db(after).prepare("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string };
    db(after).prepare("INSERT INTO audit_checkpoints (at, last_id, head_hash, reason, signature, public_key) VALUES (?, ?, ?, 'forged', ?, ?)")
      .run(at + 1, head2.id, head2.hash, sign(null, Buffer.from(message(head2.id, head2.hash, at + 1)), legacy.privateKey).toString("base64"), legacyPub);
    expect(after.verifyAudit().problems).toContainEqual({ id: head2.id, kind: "checkpoint-signature" });
    after.close?.();
  });
});
