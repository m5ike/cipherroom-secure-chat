// @vitest-environment node
//
// REVIEW 6.12 (server) — F-23, the audit journal's tamper evidence
// (storage/global-store.ts ensurePin / verifyAudit). The 6.12 claim: "whoever
// can rewrite m5cet.db (or the storage directory, when the master key comes
// from STORAGE_MASTER_KEY) cannot re-sign a forged journal". These tests take
// that attacker (writes the storage directory, does not know the master key)
// and assert the secure behaviour; failing ones are `it.skip` with a note.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "m5cet-review-audit-"));
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

/** Re-hashes every row from `fromId` on, as a forger who knows the (unkeyed) scheme would. */
function rechain(fromId: number, s = store): void {
  const rows = db(s).prepare("SELECT * FROM audit WHERE id >= ? ORDER BY id").all(fromId) as Array<Record<string, unknown>>;
  let prev = String((db(s).prepare("SELECT hash FROM audit WHERE id = ?").get(fromId - 1) as { hash?: string } | undefined)?.hash ?? "");
  for (const r of rows) {
    const detail = r.detail ? Buffer.from(r.detail as Buffer).toString("base64") : null;
    const canonical = JSON.stringify([prev, r.at, r.category, r.level, r.event, r.actor, r.target, r.account_id, r.session_ref, r.peer_id, r.room_hash, r.ip, r.bytes, r.status, detail]);
    const hash = createHash("sha256").update(canonical).digest("hex");
    db(s).prepare("UPDATE audit SET prev_hash = ?, hash = ? WHERE id = ?").run(prev, hash, r.id);
    prev = hash;
  }
}

describe("F-23 against a forger who writes the storage directory", () => {
  // REVIEW-612 S01a: a missing audit-signing.pin is re-created by trust on first use at the next open — pinning EVERY key
  // that self-signs a checkpoint row. The forger rewrites rows, re-signs the head with their own key, deletes the pin file
  // (same directory, same permissions as m5cet.db) and restarts: verifyAudit() says ok.
  it.skip("a rewritten journal re-signed with the forger's key does not verify after the forger deletes the pin file", () => {
    store.open();
    for (let i = 0; i < 10; i++) add(i);
    store.auditCheckpoint("test");
    expect(store.verifyAudit().ok).toBe(true);

    // The forger: change a row, rechain, replace the checkpoint with one of their own key, drop the pin.
    db().prepare("UPDATE audit SET actor = 'innocent' WHERE id = 4").run();
    rechain(4);
    const forger = generateKeyPairSync("ed25519");
    const head = db().prepare("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string };
    const at = Date.now();
    db().prepare("DELETE FROM audit_checkpoints").run();
    db().prepare("INSERT INTO audit_checkpoints (at, last_id, head_hash, reason, signature, public_key) VALUES (?, ?, ?, 'interval', ?, ?)")
      .run(at, head.id, head.hash, sign(null, Buffer.from(message(head.id, head.hash, at)), forger.privateKey).toString("base64"), forger.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    store.close?.();
    rmSync(join(dir, "audit-signing.pin"));

    // The next start.
    const after = new GlobalStore(dir);
    after.open();
    const v = after.verifyAudit();
    after.close?.();
    expect(v.ok).toBe(false);
  });

  // REVIEW-612 S01b: no pin deletion needed at all — verifyAudit() never requires a checkpoint to exist. Rewrite, rechain,
  // DELETE every checkpoint: ok: true (signedCheckpoints 0), although the store signs one every 500 rows and before pruning.
  it.skip("a rewritten journal whose checkpoints were deleted does not verify", () => {
    store.open();
    for (let i = 0; i < 520; i++) add(i); // the store signs a checkpoint by itself at 500 rows
    expect(store.verifyAudit()).toMatchObject({ ok: true, signedCheckpoints: 1 });
    db().prepare("UPDATE audit SET actor = 'innocent' WHERE id = 4").run();
    rechain(4);
    db().prepare("DELETE FROM audit_checkpoints").run();
    const v = store.verifyAudit();
    expect(v.ok).toBe(false);
  });
});
