// @vitest-environment node
// 6.12 (F-04, server part): the room hash in logs, the audit journal, the
// monitor and the console is an HMAC keyed with a subkey of the storage
// master key — stable across restarts and the same in both services, but no
// longer an offline oracle for the blind room id (the old value was a plain
// SHA-256 anyone could recompute from a guessed passphrase). Registry records
// kept under the old hash move to the new one the first time the room is
// hashed; old hashes stored elsewhere translate while the room is known.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetMasterKeyForTests } from "../server/storage/keys";
import { _resetRoomHashForTests, currentRoomHash, hashRoom, legacyRoomHash, roomHashKeyed } from "../server/monitor/traffic";
import { roomRegistry } from "../server/room-registry";

const saved = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), "m5roomhash-"));
const MASTER = Buffer.alloc(32, 5);

beforeEach(() => {
  process.env.STORAGE_DIR = join(dir, "storage");
  process.env.STORAGE_MASTER_KEY = MASTER.toString("hex");
  process.env.ROOM_REGISTRY_FILE = join(dir, "room-registry.json");
  _resetMasterKeyForTests();
  _resetRoomHashForTests();
});
afterAll(() => { process.env = { ...saved }; _resetMasterKeyForTests(); _resetRoomHashForTests(); rmSync(dir, { recursive: true, force: true }); });

const sha = (room: string) => createHash("sha256").update(`m5cet:room:${room}`).digest("hex").slice(0, 16);

describe("keyed room hashes", () => {
  it("is an HMAC under the master key's room-hash subkey — not the guessable SHA-256", () => {
    const h = hashRoom("r3.blind-id")!;
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toBe(sha("r3.blind-id"));
    expect(legacyRoomHash("r3.blind-id")).toBe(sha("r3.blind-id"));
    // What another process (the admin service) or the next start computes from the same master key.
    const sub = Buffer.from(hkdfSync("sha256", MASTER, Buffer.from("m5cet-storage-v2"), Buffer.from("m5cet:room-hash"), 32));
    expect(h).toBe(createHmac("sha256", sub).update("m5cet:room:r3.blind-id").digest("hex").slice(0, 16));
    expect(roomHashKeyed()).toBe(true);
    expect(hashRoom("")).toBeUndefined();
    expect(hashRoom(null)).toBeUndefined();
  });

  it("another server (another master key) gets other hashes", () => {
    const a = hashRoom("r3.same");
    process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 6).toString("hex");
    _resetMasterKeyForTests();
    expect(hashRoom("r3.same")).not.toBe(a);
  });

  it("translates a pre-6.12 hash of a room this process has seen", () => {
    const keyed = hashRoom("r3.seen")!;
    expect(currentRoomHash(sha("r3.seen"))).toBe(keyed);
    expect(currentRoomHash(sha("r3.never-seen"))).toBe(sha("r3.never-seen"));
    expect(currentRoomHash(keyed)).toBe(keyed);
  });

  it("moves a registry record (a block) from the old hash to the new one before the hub reads it", () => {
    const old = sha("r3.blocked");
    writeFileSync(process.env.ROOM_REGISTRY_FILE!, JSON.stringify({ v: 1, rooms: [{ id: old, label: "Closed", note: "", tags: [], maxMembers: 3, blocked: { reason: "spam", until: null, by: "op", at: 1 }, wall: null, createdAt: 1, updatedAt: 1, updatedBy: "op" }] }));
    const keyed = hashRoom("r3.blocked")!;
    expect(roomRegistry.blockOf(keyed)).toMatchObject({ reason: "spam" });
    expect(roomRegistry.get(keyed)).toMatchObject({ id: keyed, label: "Closed", maxMembers: 3 });
    expect(roomRegistry.get(old)).toBeNull();
    // The file no longer carries the guessable value.
    expect(readFileSync(process.env.ROOM_REGISTRY_FILE!, "utf8")).not.toContain(old);
  });

  it("does not overwrite a record the room already has under the new hash", () => {
    const old = sha("r3.both");
    _resetRoomHashForTests();
    const keyed = (() => { const k = hashRoom("r3.both")!; _resetRoomHashForTests(); return k; })();
    const rec = (id: string, label: string) => ({ id, label, note: "", tags: [], maxMembers: 0, blocked: null, wall: null, createdAt: 1, updatedAt: 1, updatedBy: "op" });
    writeFileSync(process.env.ROOM_REGISTRY_FILE!, JSON.stringify({ v: 1, rooms: [rec(old, "old"), rec(keyed, "new")] }));
    hashRoom("r3.both");
    expect(roomRegistry.get(keyed)?.label).toBe("new");
    expect(roomRegistry.get(old)?.label).toBe("old");
  });

  it("without the master key falls back to the old value, and says so", () => {
    process.env.STORAGE_MASTER_KEY = "broken";
    _resetMasterKeyForTests();
    expect(hashRoom("r3.nokey")).toBe(sha("r3.nokey"));
    expect(roomHashKeyed()).toBe(false);
  });
});
