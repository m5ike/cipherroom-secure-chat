// @vitest-environment node
//
// The offline queue for signed-in users who are away
// (server/accounts/mailqueue.ts): ordered, deduplicated, leased, bounded,
// expiring, with a dead-letter list. Runs against a real SQLite database.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDriver, openPlainDatabase, type SqliteDatabase } from "../server/storage/db";
import { MailQueue, QUEUE_LIMITS } from "../server/accounts/mailqueue";

const ENVELOPE = { iv: "aXY=", ciphertext: "Y2lwaGVydGV4dA==" };
const BOB = { peerId: "peer-bob", name: "Bob" };

let dir = "";
let db: SqliteDatabase;
let clock = 1_700_000_000_000;
let queue: MailQueue;

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-mq-"));
  db = openPlainDatabase(join(dir, "q.db"), []);
  clock = 1_700_000_000_000;
  queue = new MailQueue(db, () => clock);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function add(messageId: string, over: Partial<Parameters<MailQueue["enqueue"]>[0]> = {}) {
  return queue.enqueue({ accountId: "acc-alice", room: "alpha", kind: "message", messageId, from: BOB, envelope: ENVELOPE, ...over });
}

describe("order and duplicates", () => {
  it("numbers items per account and room and hands them over in that order", () => {
    add("m1"); add("m2"); add("m3", { room: "beta" }); add("m4");
    const alpha = queue.lease("acc-alice", "alpha");
    expect(alpha.map((i) => [i.messageId, i.seq])).toEqual([["m1", 1], ["m2", 2], ["m4", 3]]);
    expect(queue.lease("acc-alice", "beta").map((i) => i.seq)).toEqual([1]);
  });

  it("stores a message relayed twice only once", () => {
    const first = add("m1");
    const again = add("m1");
    expect(first.ok && again.ok).toBe(true);
    expect(again).toMatchObject({ duplicate: true });
    expect(queue.pending("acc-alice")).toHaveLength(1);
    // A status for the same message id is a different item.
    expect(add("m1", { kind: "status", envelope: undefined, status: { state: "read", at: clock, recipientName: "Bob" } })).toMatchObject({ ok: true, duplicate: false });
  });
});

describe("leases and acknowledgements", () => {
  it("does not lose an item that was handed over but never acknowledged", () => {
    add("m1");
    const handed = queue.lease("acc-alice", "alpha");
    expect(handed[0]).toMatchObject({ state: "delivering", attempts: 1 });

    // The tab died: nothing is handed over again while the lease runs…
    expect(queue.lease("acc-alice", "alpha")).toHaveLength(0);
    // …and once it expires, the item comes back.
    clock += QUEUE_LIMITS.leaseMs + 1;
    expect(queue.lease("acc-alice", "alpha").map((i) => [i.messageId, i.attempts])).toEqual([["m1", 2]]);
  });

  it("removes an item only when it is acknowledged, and only for its owner", () => {
    const { item } = add("m1") as { item: { id: string } };
    queue.lease("acc-alice", "alpha");
    expect(queue.ack("acc-mallory", [item.id])).toEqual([]);
    expect(queue.ack("acc-alice", [item.id]).map((i) => i.messageId)).toEqual(["m1"]);
    expect(queue.pending("acc-alice")).toHaveLength(0);
  });

  it("gives up after too many unacknowledged deliveries and keeps the item as dead", () => {
    add("m1");
    for (let i = 0; i < QUEUE_LIMITS.maxAttempts; i++) {
      expect(queue.lease("acc-alice", "alpha")).toHaveLength(1);
      clock += QUEUE_LIMITS.leaseMs + 1;
    }
    expect(queue.lease("acc-alice", "alpha")).toHaveLength(0);
    const [dead] = queue.dead("acc-alice");
    expect(dead).toMatchObject({ messageId: "m1", state: "dead" });
    expect(dead.deadReason).toMatch(/without an acknowledgement/);

    expect(queue.revive(dead.id)).toBe(true);
    expect(queue.lease("acc-alice", "alpha")).toHaveLength(1);
  });
});

describe("limits", () => {
  it("refuses an item that is too large", () => {
    expect(add("big", { envelope: { iv: "aXY=", ciphertext: "A".repeat(QUEUE_LIMITS.maxItemBytes) } }))
      .toMatchObject({ ok: false, reason: "too-large" });
  });

  it("stops one sender from filling somebody's mailbox", () => {
    for (let i = 0; i < QUEUE_LIMITS.maxItemsPerSender; i++) add(`m${i}`);
    expect(add("one-more")).toMatchObject({ ok: false, reason: "sender-quota" });
    // Somebody else can still write.
    expect(add("from-carol", { from: { peerId: "peer-carol", name: "Carol" } })).toMatchObject({ ok: true });
  });

  it("caps the whole mailbox", () => {
    for (let i = 0; i < QUEUE_LIMITS.maxItemsPerAccount; i++) {
      add(`m${i}`, { from: { peerId: `peer-${i % 10}`, name: "x" } });
    }
    expect(add("overflow", { from: { peerId: "peer-new", name: "y" } })).toMatchObject({ ok: false, reason: "quota" });
  });
});

describe("expiry and statistics", () => {
  it("honours a message's own deadline and sweeps what expired into the dead list", () => {
    add("short", { expiresAt: clock + 5_000 });
    add("long");
    clock += 6_000;
    expect(queue.lease("acc-alice", "alpha").map((i) => i.messageId)).toEqual(["long"]);
    expect(queue.sweep()).toMatchObject({ expired: 1 });
    expect(queue.dead("acc-alice")[0]).toMatchObject({ messageId: "short", deadReason: "expired before delivery" });

    clock += QUEUE_LIMITS.deadRetentionMs + 1;
    expect(queue.sweep().purged).toBe(1);
  });

  it("reports per account and overall", () => {
    add("m1"); add("m2");
    queue.enqueue({ accountId: "acc-bob", room: "alpha", kind: "message", messageId: "x1", from: { peerId: "peer-alice", name: "Alice" }, envelope: ENVELOPE });
    queue.lease("acc-alice", "alpha", 1);

    expect(queue.stats("acc-alice")).toMatchObject({ queued: 1, delivering: 1, dead: 0, oldestAt: clock });
    expect(queue.stats()).toMatchObject({ queued: 2, delivering: 1 });
    expect(queue.overview().map((o) => o.accountId).sort()).toEqual(["acc-alice", "acc-bob"]);
  });

  it("forgets everything of a deleted account", () => {
    add("m1"); add("m2");
    expect(queue.purgeAccount("acc-alice")).toBe(2);
    expect(queue.stats("acc-alice").queued).toBe(0);
  });
});


describe("metadata at rest and the relay ledger", () => {
  const sealer = {
    // A stand-in for the master-key sealer: reversible, and bound to the aad.
    seal: (text: string, aad: string) => Buffer.from(`${aad}|${text}`).toString("base64"),
    open: (sealed: string, aad: string) => {
      const raw = Buffer.from(sealed, "base64").toString();
      return raw.startsWith(`${aad}|`) ? raw.slice(aad.length + 1) : null;
    },
  };

  it("seals who sent an item and keeps it readable through the queue", () => {
    const q = new MailQueue(db, () => clock, sealer);
    const r = q.enqueue({ accountId: "acc-seal", room: "r", kind: "message", messageId: "m-seal", from: { peerId: "p-1", accountId: "acc-sender", name: "Mallory Q." }, envelope: ENVELOPE });
    expect(r.ok).toBe(true);
    const raw = db.prepare("SELECT from_json, sender_key FROM mail_queue WHERE message_id = 'm-seal'").get() as { from_json: string; sender_key: string };
    expect(raw.from_json.startsWith("s1:")).toBe(true);
    expect(raw.from_json).not.toContain("Mallory");
    expect(raw.sender_key).not.toContain("acc-sender");
    expect(q.lease("acc-seal", "r")[0].from).toEqual({ peerId: "p-1", accountId: "acc-sender", name: "Mallory Q." });
  });

  it("remembers relayed messages across instances (a restart)", () => {
    const before = new MailQueue(db, () => clock, sealer);
    before.rememberRelay("m-led", "room-x", { peerId: "p-s", name: "Sender" }, "acc-a");
    before.rememberRelay("m-led", "room-x", { peerId: "p-s", name: "Sender" }, "acc-b");
    before.rememberRelay("m-led", "room-x", { peerId: "p-s", name: "Sender" }, "acc-b");
    const after = new MailQueue(db, () => clock, sealer);
    expect(after.relayOf("m-led")).toMatchObject({ room: "room-x", sender: { peerId: "p-s", name: "Sender" }, recipients: ["acc-a", "acc-b"] });
    const stored = db.prepare("SELECT sender FROM relay_ledger WHERE message_id = 'm-led'").get() as { sender: string };
    expect(stored.sender).not.toContain("Sender");
    expect(after.relayOf("nope")).toBeNull();
  });
});
