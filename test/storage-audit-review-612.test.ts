// @vitest-environment node
//
// 6.12 review S01 — the audit journal's pin and checkpoint coverage:
//   - a store that signed with the derived key does not re-pin when
//     audit-signing.pin disappears ("pin-missing"), not even from a planted
//     pre-6.12 key file;
//   - keys are never pinned from what a checkpoint row names;
//   - the newest valid checkpoint may lag the head by at most
//     AUDIT_UNSIGNED_TAIL_MAX rows ("checkpoint-missing"), and the cadence
//     continues across restarts;
//   - the operator's explicit re-pin (and the console route behind it).

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_UNSIGNED_TAIL_MAX, GlobalStore } from "../server/storage/global-store";
import { loadSqliteDriver } from "../server/storage/db";
import { _resetMasterKeyForTests, derivedKey } from "../server/storage/keys";

let dir = "";
let store: GlobalStore;
const saved = { ...process.env };

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-audit-review-"));
  process.env.STORAGE_DIR = dir;
  process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 13).toString("base64");
  _resetMasterKeyForTests();
  store = new GlobalStore(dir);
});
afterEach(() => { store.close?.(); process.env = { ...saved }; _resetMasterKeyForTests(); rmSync(dir, { recursive: true, force: true }); });

type Db = { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };
const db = (s = store) => (s as unknown as { handle(): Db }).handle();
const add = (i: number, s = store) => s.appendAudit({ id: 0, at: 1_700_000_000_000 + i, category: "security", level: "warn", event: `ev.${i}`, actor: `peer-${i}`, detail: { i } });
const message = (lastId: number, head: string, at: number) => `m5cet/audit-checkpoint/1|${lastId}|${head}|${at}`;
const kinds = (s = store) => s.verifyAudit().problems.map((p) => p.kind);
const pinFile = () => join(dir, "audit-signing.pin");
const reopen = () => { store.close?.(); store = new GlobalStore(dir); store.open(); return store; };

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

describe("a missing pin after the store was pinned", () => {
  it("is a failure, not a re-pin — also with a planted pre-6.12 key file and forged checkpoints", () => {
    store.open();
    for (let i = 0; i < 10; i++) add(i);
    store.auditCheckpoint("test");
    expect(store.verifyAudit().ok).toBe(true);
    rmSync(pinFile());
    reopen();
    expect(existsSync(pinFile())).toBe(false);
    expect(kinds()).toContain("pin-missing");

    // The forger also plants a "pre-6.12" key and re-signs a rewritten journal with it — and the derived-key checkpoint stays.
    db().prepare("UPDATE audit SET actor = 'innocent' WHERE id = 4").run();
    rechain(4);
    const legacy = generateKeyPairSync("ed25519");
    writeFileSync(join(dir, "audit-signing.key"), legacy.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const head = db().prepare("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string };
    db().prepare("INSERT INTO audit_checkpoints (at, last_id, head_hash, reason, signature, public_key) VALUES (?, ?, ?, 'interval', ?, ?)")
      .run(1, head.id, head.hash, sign(null, Buffer.from(message(head.id, head.hash, 1)), legacy.privateKey).toString("base64"), legacy.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    reopen();
    expect(existsSync(pinFile())).toBe(false);
    expect(store.verifyAudit().ok).toBe(false);
    expect(kinds()).toEqual(expect.arrayContaining(["pin-missing", "checkpoint-signature"]));
  });

  it("keys a checkpoint row names are never pinned (no key file: only the derived key counts)", () => {
    for (let i = 0; i < 5; i++) add(i);
    const other = generateKeyPairSync("ed25519");
    const head = db().prepare("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string };
    db().prepare("INSERT INTO audit_checkpoints (at, last_id, head_hash, reason, signature, public_key) VALUES (?, ?, ?, 'interval', ?, ?)")
      .run(1, head.id, head.hash, sign(null, Buffer.from(message(head.id, head.hash, 1)), other.privateKey).toString("base64"), other.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    rmSync(pinFile());
    reopen();
    const pin = JSON.parse(readFileSync(pinFile(), "utf8")) as { v: number; keys: unknown[]; coverFrom: number };
    expect(pin).toMatchObject({ v: 2, keys: [], coverFrom: 1 });
    expect(kinds()).toContain("checkpoint-signature");
  });

  it("a 6.12 pin written before the review (v1) still verifies", () => {
    store.open();
    for (let i = 0; i < 4; i++) add(i);
    const body = { v: 1, keys: [] as Array<{ publicKey: string; upTo: number | null }>, chainFrom: 1, pinnedAt: 1_700_000_000_000 };
    const mac = createHmac("sha256", derivedKey("audit-pin")).update(JSON.stringify([body.v, body.keys.map((k) => [k.publicKey, k.upTo]), body.chainFrom, body.pinnedAt])).digest("hex");
    writeFileSync(pinFile(), JSON.stringify({ ...body, mac }));
    reopen();
    expect(store.verifyAudit()).toMatchObject({ ok: true, pinned: { chainFrom: 1, coverFrom: 1 } });
  });
});

describe("checkpoint coverage", () => {
  it(`at most ${AUDIT_UNSIGNED_TAIL_MAX} chained rows after the newest valid checkpoint`, () => {
    for (let i = 0; i < 499; i++) add(i);
    expect(store.verifyAudit()).toMatchObject({ ok: true, signedCheckpoints: 0 }); // shorter than the cadence: fine
    add(499); // row 500: signed by itself
    expect(store.verifyAudit()).toMatchObject({ ok: true, signedCheckpoints: 1 });
    db().prepare("DELETE FROM audit_checkpoints").run();
    for (let i = 500; i < 510; i++) add(i);
    expect(store.verifyAudit()).toMatchObject({ ok: true }); // 510 unsigned rows: still within the slack
    add(510);
    expect(store.verifyAudit().problems).toEqual([{ id: 1, kind: "checkpoint-missing" }]);
  });

  it("the cadence continues across restarts (a restart used to start the count again)", () => {
    for (let i = 0; i < 300; i++) add(i);
    reopen();
    for (let i = 300; i < 520; i++) add(i);
    expect(store.verifyAudit()).toMatchObject({ ok: true, lastCheckpoint: { lastId: 500 } });
  });

  it("a journal of before 6.12 is covered by what its key signed; new rows by the derived key", () => {
    for (let i = 0; i < 700; i++) db().prepare("INSERT INTO audit (at, category, level, event) VALUES (1, 'x', 'info', 'old')").run(); // before the chain (3.0)
    rmSync(pinFile());
    const legacy = generateKeyPairSync("ed25519");
    writeFileSync(join(dir, "audit-signing.key"), legacy.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    reopen();
    for (let i = 0; i < 520; i++) add(i, store);
    expect(store.verifyAudit()).toMatchObject({ ok: true, unchained: 700, checked: 520 });
  });
});

describe("the operator's explicit re-pin", () => {
  it("vouches for the journal as it is now and signs its head", () => {
    store.open();
    for (let i = 0; i < 10; i++) add(i);
    store.auditCheckpoint("test");
    rmSync(pinFile());
    reopen();
    expect(kinds()).toContain("pin-missing");
    const r = store.repinAudit();
    expect(r).toMatchObject({ keys: 0, chainFrom: 1, coverFrom: 11, checkpoint: 10 });
    expect(store.verifyAudit()).toMatchObject({ ok: true });
    reopen();
    expect(store.verifyAudit()).toMatchObject({ ok: true, pinned: { coverFrom: 11 } });
  });

  it("trusts keys rows name only when asked (pre-6.12 checkpoints of a lost key file)", () => {
    for (let i = 0; i < 5; i++) add(i);
    const lost = generateKeyPairSync("ed25519");
    const head = db().prepare("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string };
    db().prepare("INSERT INTO audit_checkpoints (at, last_id, head_hash, reason, signature, public_key) VALUES (?, ?, ?, 'interval', ?, ?)")
      .run(1, head.id, head.hash, sign(null, Buffer.from(message(head.id, head.hash, 1)), lost.privateKey).toString("base64"), lost.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    expect(kinds()).toContain("checkpoint-signature");
    store.repinAudit();
    expect(kinds()).toContain("checkpoint-signature");
    expect(store.repinAudit({ trustRowKeys: true })).toMatchObject({ keys: 1 });
    expect(store.verifyAudit()).toMatchObject({ ok: true, pinned: { earlierKeys: 1 } });
  });
});
