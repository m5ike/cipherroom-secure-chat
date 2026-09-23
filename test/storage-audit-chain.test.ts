// @vitest-environment node
//
// Tamper evidence for the persisted audit journal (server/storage/
// global-store.ts): a hash chain over the rows, signed checkpoints, and a
// verifier that names the first row where something was changed, removed
// or re-signed.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
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
  dir = mkdtempSync(join(tmpdir(), "m5cet-chain-"));
  process.env.STORAGE_DIR = dir;
  process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  _resetMasterKeyForTests();
  store = new GlobalStore(dir);
});
afterEach(() => { store.close?.(); process.env = { ...saved }; _resetMasterKeyForTests(); rmSync(dir, { recursive: true, force: true }); });

const add = (i: number) => store.appendAudit({ id: 0, at: 1_700_000_000_000 + i, category: "security", level: "warn", event: `ev.${i}`, actor: `peer-${i}`, detail: { i } });
const db = () => (store as unknown as { handle(): { prepare(sql: string): { run(...a: unknown[]): unknown } } }).handle();

describe("audit chain", () => {
  it("verifies an untouched journal, with a signed checkpoint", () => {
    for (let i = 0; i < 20; i++) add(i);
    expect(store.auditCheckpoint("test")).toMatchObject({ lastId: 20 });
    const v = store.verifyAudit();
    expect(v).toMatchObject({ ok: true, checked: 20, checkpoints: 1, signedCheckpoints: 1 });
    expect(v.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("names a row whose contents were changed", () => {
    for (let i = 0; i < 10; i++) add(i);
    db().prepare("UPDATE audit SET actor = 'someone-else' WHERE id = 4").run();
    const v = store.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toEqual({ id: 4, kind: "row-altered" });
  });

  it("notices a row removed from the middle", () => {
    for (let i = 0; i < 10; i++) add(i);
    db().prepare("DELETE FROM audit WHERE id = 6").run();
    expect(store.verifyAudit().problems.map((p) => p.kind)).toEqual(expect.arrayContaining(["rows-missing", "link-broken"]));
  });

  it("notices a forged checkpoint", () => {
    for (let i = 0; i < 5; i++) add(i);
    store.auditCheckpoint("test");
    db().prepare("UPDATE audit_checkpoints SET head_hash = 'ff' WHERE id = 1").run();
    expect(store.verifyAudit().problems.map((p) => p.kind)).toEqual(expect.arrayContaining(["checkpoint-signature"]));
  });

  it("stays verifiable after old rows are pruned", () => {
    for (let i = 0; i < 30; i++) add(i);
    expect(store.pruneAudit(1_700_000_000_000 + 10, 1_000)).toBe(10);
    const v = store.verifyAudit();
    expect(v).toMatchObject({ ok: true, checked: 20 });
  });
});
