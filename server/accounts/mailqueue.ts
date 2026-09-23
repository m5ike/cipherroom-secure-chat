// The offline message queue for signed-in users who are away.
//
// The first version kept each mailbox as a JSON file and rewrote it whole
// on every add and every acknowledgement. This one is a table in the
// global SQLite database, and it behaves like a queue should:
//
//   ordered      every item gets a per-(account, room) sequence number and
//                is handed over in that order
//   deduplicated the same message relayed twice (a retrying sender, a
//                reconnect) is stored once: (account, kind, message id) is
//                unique
//   leased       handing an item to a client does not delete it — it moves
//                to `delivering` with a lease. Only an acknowledgement
//                removes it; a lease that runs out puts it back in the
//                queue, so a tab that died mid-delivery loses nothing
//   bounded      per-account item and byte quotas, and a per-sender quota
//                so one member of a room cannot fill someone's mailbox
//   expiring     every item has a deadline (the message's own TTL if it
//                has one, the retention window otherwise)
//   dead-letter  an item that was delivered too many times without an
//                acknowledgement, or that expired, is kept as `dead` with
//                a reason for the operator instead of vanishing silently
//
// What is stored is exactly what the relay received: room-key ciphertext
// the server cannot open, plus the metadata needed to route it. With a
// sealer (the storage master key, see storage/service.ts) the metadata
// that is not needed for routing — who sent it, the status details — is
// sealed at rest and bound to its row, and the per-sender quota key is a
// hash: a copy of the database file does not say who wrote to whom.
//
// The relay ledger (relay_ledger) remembers, per relayed message, its room,
// sender and recipients, so a read receipt can find its way back — also
// after a restart (it used to live in memory only).

import { createHash, randomBytes } from "node:crypto";
import { migrate, type SqliteDatabase } from "../storage/db";
import type { Migration } from "../storage/schema";

export type MailKind = "message" | "status";
export type MailState = "queued" | "delivering" | "dead";

export type MailFrom = { peerId: string; accountId?: string; name: string };

/** Room-key ciphertext and its public header fields, exactly as relayed. */
export type QueueEnvelope = Record<string, string | number>;

export type QueueItem = {
  id: string;
  accountId: string;
  room: string;
  seq: number;
  kind: MailKind;
  messageId: string;
  from: MailFrom;
  envelope?: QueueEnvelope;
  status?: { state: "delivered" | "read"; at: number; recipientName: string };
  state: MailState;
  attempts: number;
  storedAt: number;
  leaseUntil: number;
  expiresAt: number;
  bytes: number;
  deadReason?: string;
};

export const QUEUE_LIMITS = {
  maxItemsPerAccount: 1_000,
  maxBytesPerAccount: 8_000_000,
  maxItemBytes: 130_000,
  /** One sender may not own more than this share of a mailbox. */
  maxItemsPerSender: 300,
  /** Deliveries without an acknowledgement before an item is dead. */
  maxAttempts: 8,
  /** How long a delivered-but-unacknowledged item waits (ms). */
  leaseMs: 60_000,
  /** Default life of an item without its own TTL (ms). */
  defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** Dead items are kept this long for the operator (ms). */
  deadRetentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** How long an item without its own TTL waits: RELAY_RETENTION_DAYS (the
 *  retention policy's relay window), else QUEUE_LIMITS.defaultTtlMs. */
export function queueTtlMs(): number {
  const days = Number(process.env.RELAY_RETENTION_DAYS?.trim() || "");
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : QUEUE_LIMITS.defaultTtlMs;
}

/** Seals / opens metadata at rest; `aad` names the row and the column. */
export type QueueSealer = {
  seal(plaintext: string, aad: string): string;
  open(sealed: string, aad: string): string | null;
};

/** Who relayed a message to whom — for routing receipts back. */
export type LedgerEntry = {
  messageId: string;
  room: string;
  sender: { peerId: string; accountId?: string; name: string };
  recipients: string[];
  at: number;
};

export const LEDGER_LIMITS = { maxEntries: 50_000, ttlMs: 30 * 24 * 60 * 60 * 1000 } as const;

export type EnqueueResult =
  | { ok: true; item: QueueItem; duplicate: boolean }
  | { ok: false; reason: "quota" | "sender-quota" | "too-large" | "invalid"; detail: string };

export const MAILQUEUE_MIGRATIONS: Migration[] = [
  {
    name: "mq-001-core",
    sql: `
      CREATE TABLE IF NOT EXISTS mail_queue (
        id          TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL,
        room        TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        message_id  TEXT NOT NULL,
        from_json   TEXT NOT NULL,
        sender_key  TEXT NOT NULL,
        envelope    TEXT,
        status_json TEXT,
        state       TEXT NOT NULL DEFAULT 'queued',
        attempts    INTEGER NOT NULL DEFAULT 0,
        stored_at   INTEGER NOT NULL,
        lease_until INTEGER NOT NULL DEFAULT 0,
        expires_at  INTEGER NOT NULL,
        bytes       INTEGER NOT NULL,
        dead_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mail_queue_dedupe ON mail_queue(account_id, kind, message_id);
      CREATE INDEX IF NOT EXISTS mail_queue_deliver ON mail_queue(account_id, room, state, seq);
      CREATE INDEX IF NOT EXISTS mail_queue_expiry ON mail_queue(state, expires_at);
      CREATE INDEX IF NOT EXISTS mail_queue_lease ON mail_queue(state, lease_until);

      CREATE TABLE IF NOT EXISTS mail_queue_seq (
        account_id TEXT NOT NULL,
        room       TEXT NOT NULL,
        next_seq   INTEGER NOT NULL,
        PRIMARY KEY (account_id, room)
      );
    `,
  },
  {
    name: "mq-002-ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS relay_ledger (
        message_id TEXT PRIMARY KEY,
        room       TEXT NOT NULL,
        sender     TEXT NOT NULL,
        recipients TEXT NOT NULL,
        at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS relay_ledger_at ON relay_ledger(at);
    `,
  },
];

type Row = Record<string, unknown>;

const SEALED = "s1:";

function toItem(row: Row, sealer?: QueueSealer): QueueItem {
  const parse = <T>(raw: unknown, column: string): T | undefined => {
    if (typeof raw !== "string" || !raw) return undefined;
    let text: string | null = raw;
    // A sealed column (s1:…); rows written before sealing are plain JSON.
    if (raw.startsWith(SEALED)) text = sealer ? sealer.open(raw.slice(SEALED.length), `mq:${String(row.id)}:${column}`) : null;
    if (text === null) return undefined;
    try { return JSON.parse(text) as T; } catch { return undefined; }
  };
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    room: String(row.room),
    seq: Number(row.seq),
    kind: String(row.kind) as MailKind,
    messageId: String(row.message_id),
    from: parse<MailFrom>(row.from_json, "from") ?? { peerId: "", name: "" },
    envelope: parse(row.envelope, "envelope"),
    status: parse(row.status_json, "status"),
    state: String(row.state) as MailState,
    attempts: Number(row.attempts),
    storedAt: Number(row.stored_at),
    leaseUntil: Number(row.lease_until),
    expiresAt: Number(row.expires_at),
    bytes: Number(row.bytes),
    ...(row.dead_reason ? { deadReason: String(row.dead_reason) } : {}),
  };
}

/** What the relay needs from a queue — SQLite (MailQueue) or memory. */
export interface OfflineQueue {
  enqueue(input: Parameters<MailQueue["enqueue"]>[0]): EnqueueResult;
  lease(accountId: string, room: string | undefined, limit?: number): QueueItem[];
  ack(accountId: string, ids: string[]): QueueItem[];
  /** The socket holding these leases went away: hand them out again now. */
  release(accountId: string, ids: string[]): number;
  pending(accountId: string, room?: string): QueueItem[];
  dead(accountId?: string, limit?: number): QueueItem[];
  revive(id: string): boolean;
  stats(accountId?: string): { queued: number; delivering: number; dead: number; bytes: number; oldestAt: number | null };
  overview(limit?: number): Array<{ accountId: string; queued: number; delivering: number; dead: number; bytes: number; oldestAt: number | null; rooms: number }>;
  sweep(): { expired: number; purged: number };
  purgeAccount(accountId: string): number;
  /** Raise a status item to a higher state ("read" beats "delivered"). */
  upgradeStatus(accountId: string, messageId: string, status: { state: "delivered" | "read"; at: number; recipientName: string }): boolean;
  /** The relay ledger: this message went from `sender` to `recipient`. */
  rememberRelay(messageId: string, room: string, sender: LedgerEntry["sender"], recipient: string): void;
  relayOf(messageId: string): LedgerEntry | null;
  readonly persistent: boolean;
}

export class MailQueue implements OfflineQueue {
  readonly persistent = true;

  constructor(private readonly db: SqliteDatabase, private readonly now: () => number = Date.now, private readonly sealer?: QueueSealer) {
    migrate(db, MAILQUEUE_MIGRATIONS);
  }

  private row(r: Row): QueueItem {
    return toItem(r, this.sealer);
  }

  /** A metadata column as stored: sealed and bound to its row when a sealer is set. */
  private store(id: string, column: string, json: string | null): string | null {
    if (json === null) return null;
    return this.sealer ? SEALED + this.sealer.seal(json, `mq:${id}:${column}`) : json;
  }

  /** Adds an item, or returns the one already there for the same message. */
  enqueue(input: {
    accountId: string;
    room: string;
    kind: MailKind;
    messageId: string;
    from: MailFrom;
    envelope?: QueueEnvelope;
    status?: { state: "delivered" | "read"; at: number; recipientName: string };
    /** The message's own deadline, when it has one (ms since epoch). */
    expiresAt?: number;
  }): EnqueueResult {
    if (!input.accountId || !input.room || !input.messageId) return { ok: false, reason: "invalid", detail: "account, room and message id are required" };
    const at = this.now();
    const envelope = input.envelope ? JSON.stringify(input.envelope) : null;
    const status = input.status ? JSON.stringify(input.status) : null;
    const fromJson = JSON.stringify(input.from ?? { peerId: "", name: "" });
    const bytes = (envelope?.length ?? 0) + (status?.length ?? 0) + fromJson.length;
    if (bytes > QUEUE_LIMITS.maxItemBytes) return { ok: false, reason: "too-large", detail: `${bytes} bytes` };
    const rawSender = input.from?.accountId || input.from?.peerId || "anonymous";
    // With a sealer the quota key is a hash: the quota works, the file does not name the sender.
    const senderKey = this.sealer ? createHash("sha256").update(`mq-sender:${rawSender}`).digest("base64url").slice(0, 22) : rawSender;

    const run = this.db.transaction((): EnqueueResult => {
      const existing = this.db.prepare("SELECT * FROM mail_queue WHERE account_id = ? AND kind = ? AND message_id = ?")
        .get(input.accountId, input.kind, input.messageId) as Row | undefined;
      if (existing) return { ok: true, item: this.row(existing), duplicate: true };

      const totals = this.db.prepare("SELECT count(*) AS n, COALESCE(sum(bytes), 0) AS b FROM mail_queue WHERE account_id = ? AND state != 'dead'")
        .get(input.accountId) as { n: number; b: number };
      if (totals.n >= QUEUE_LIMITS.maxItemsPerAccount || totals.b + bytes > QUEUE_LIMITS.maxBytesPerAccount) {
        return { ok: false, reason: "quota", detail: `${totals.n} items, ${totals.b} bytes waiting` };
      }
      // Status receipts are the recipient's own bookkeeping, not flooding.
      if (input.kind === "message") {
        const bySender = this.db.prepare("SELECT count(*) AS n FROM mail_queue WHERE account_id = ? AND sender_key = ? AND state != 'dead'")
          .get(input.accountId, senderKey) as { n: number };
        if (bySender.n >= QUEUE_LIMITS.maxItemsPerSender) return { ok: false, reason: "sender-quota", detail: `${bySender.n} items from this sender` };
      }

      this.db.prepare(`
        INSERT INTO mail_queue_seq (account_id, room, next_seq) VALUES (?, ?, 1)
        ON CONFLICT(account_id, room) DO UPDATE SET next_seq = next_seq + 1
      `).run(input.accountId, input.room);
      const seq = Number((this.db.prepare("SELECT next_seq AS s FROM mail_queue_seq WHERE account_id = ? AND room = ?")
        .get(input.accountId, input.room) as { s: number }).s);

      const id = `mq-${randomBytes(10).toString("base64url")}`;
      const ttl = queueTtlMs();
      const expiresAt = input.expiresAt && input.expiresAt > at
        ? Math.min(input.expiresAt, at + ttl)
        : at + ttl;
      this.db.prepare(`
        INSERT INTO mail_queue (id, account_id, room, seq, kind, message_id, from_json, sender_key, envelope, status_json, state, attempts, stored_at, lease_until, expires_at, bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?)
      `).run(id, input.accountId, input.room, seq, input.kind, input.messageId, this.store(id, "from", fromJson), senderKey, envelope, this.store(id, "status", status), at, expiresAt, bytes);
      return { ok: true, item: this.row(this.db.prepare("SELECT * FROM mail_queue WHERE id = ?").get(id) as Row), duplicate: false };
    });
    return run();
  }

  /**
   * Items to hand to the client now, in order: queued ones and delivering
   * ones whose lease ran out. They move to `delivering` with a fresh lease;
   * an item past its attempt budget goes to the dead-letter list instead.
   */
  lease(accountId: string, room: string | undefined, limit = 200): QueueItem[] {
    const at = this.now();
    const run = this.db.transaction((): QueueItem[] => {
      const rows = (room === undefined
        ? this.db.prepare(`
            SELECT * FROM mail_queue
            WHERE account_id = ? AND (state = 'queued' OR (state = 'delivering' AND lease_until <= ?)) AND expires_at > ?
            ORDER BY room, seq LIMIT ?`).all(accountId, at, at, limit)
        : this.db.prepare(`
            SELECT * FROM mail_queue
            WHERE account_id = ? AND room = ? AND (state = 'queued' OR (state = 'delivering' AND lease_until <= ?)) AND expires_at > ?
            ORDER BY seq LIMIT ?`).all(accountId, room, at, at, limit)) as Row[];
      const out: QueueItem[] = [];
      const deliver = this.db.prepare("UPDATE mail_queue SET state = 'delivering', attempts = attempts + 1, lease_until = ? WHERE id = ?");
      const kill = this.db.prepare("UPDATE mail_queue SET state = 'dead', dead_reason = ?, lease_until = 0 WHERE id = ?");
      for (const row of rows) {
        const item = this.row(row);
        if (item.attempts >= QUEUE_LIMITS.maxAttempts) {
          kill.run(`delivered ${item.attempts} times without an acknowledgement`, item.id);
          continue;
        }
        deliver.run(at + QUEUE_LIMITS.leaseMs, item.id);
        out.push({ ...item, state: "delivering", attempts: item.attempts + 1, leaseUntil: at + QUEUE_LIMITS.leaseMs });
      }
      return out;
    });
    return run();
  }

  /** The client processed these: they leave the queue. Returns them. */
  ack(accountId: string, ids: string[]): QueueItem[] {
    if (ids.length === 0) return [];
    const run = this.db.transaction((): QueueItem[] => {
      const taken: QueueItem[] = [];
      const get = this.db.prepare("SELECT * FROM mail_queue WHERE id = ? AND account_id = ? AND state != 'dead'");
      const drop = this.db.prepare("DELETE FROM mail_queue WHERE id = ?");
      for (const id of ids.slice(0, 1_000)) {
        const row = get.get(id, accountId) as Row | undefined;
        if (!row) continue;
        drop.run(id);
        taken.push(this.row(row));
      }
      return taken;
    });
    return run();
  }

  /** Leased items go back to the queue at once (their socket closed before
   *  acknowledging), instead of waiting for the lease to run out. */
  release(accountId: string, ids: string[]): number {
    if (ids.length === 0) return 0;
    const put = this.db.prepare("UPDATE mail_queue SET state = 'queued', lease_until = 0 WHERE id = ? AND account_id = ? AND state = 'delivering'");
    const run = this.db.transaction((): number => {
      let n = 0;
      for (const id of ids.slice(0, 1_000)) n += put.run(id, accountId).changes;
      return n;
    });
    return run();
  }

  /** Items waiting (queued or delivering), in order — for status views. */
  pending(accountId: string, room?: string): QueueItem[] {
    const rows = (room === undefined
      ? this.db.prepare("SELECT * FROM mail_queue WHERE account_id = ? AND state != 'dead' ORDER BY room, seq").all(accountId)
      : this.db.prepare("SELECT * FROM mail_queue WHERE account_id = ? AND room = ? AND state != 'dead' ORDER BY seq").all(accountId, room)) as Row[];
    return rows.map((r) => this.row(r));
  }

  dead(accountId?: string, limit = 200): QueueItem[] {
    const rows = (accountId
      ? this.db.prepare("SELECT * FROM mail_queue WHERE state = 'dead' AND account_id = ? ORDER BY stored_at DESC LIMIT ?").all(accountId, limit)
      : this.db.prepare("SELECT * FROM mail_queue WHERE state = 'dead' ORDER BY stored_at DESC LIMIT ?").all(limit)) as Row[];
    return rows.map((r) => this.row(r));
  }

  /** Puts a dead item back in the queue (operator action). */
  revive(id: string): boolean {
    return this.db.prepare("UPDATE mail_queue SET state = 'queued', attempts = 0, dead_reason = NULL, lease_until = 0 WHERE id = ? AND state = 'dead'")
      .run(id).changes > 0;
  }

  stats(accountId?: string): { queued: number; delivering: number; dead: number; bytes: number; oldestAt: number | null } {
    const where = accountId ? "WHERE account_id = ?" : "";
    const params = accountId ? [accountId] : [];
    const row = this.db.prepare(`
      SELECT
        COALESCE(sum(CASE WHEN state = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
        COALESCE(sum(CASE WHEN state = 'delivering' THEN 1 ELSE 0 END), 0) AS delivering,
        COALESCE(sum(CASE WHEN state = 'dead' THEN 1 ELSE 0 END), 0) AS dead,
        COALESCE(sum(CASE WHEN state != 'dead' THEN bytes ELSE 0 END), 0) AS bytes,
        min(CASE WHEN state != 'dead' THEN stored_at END) AS oldest
      FROM mail_queue ${where}
    `).get(...params) as { queued: number; delivering: number; dead: number; bytes: number; oldest: number | null };
    return { queued: Number(row.queued), delivering: Number(row.delivering), dead: Number(row.dead), bytes: Number(row.bytes), oldestAt: row.oldest === null ? null : Number(row.oldest) };
  }

  /** Per-account view for the operator. */
  overview(limit = 200): Array<{ accountId: string; queued: number; delivering: number; dead: number; bytes: number; oldestAt: number | null; rooms: number }> {
    return (this.db.prepare(`
      SELECT account_id,
        sum(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
        sum(CASE WHEN state = 'delivering' THEN 1 ELSE 0 END) AS delivering,
        sum(CASE WHEN state = 'dead' THEN 1 ELSE 0 END) AS dead,
        sum(CASE WHEN state != 'dead' THEN bytes ELSE 0 END) AS bytes,
        min(CASE WHEN state != 'dead' THEN stored_at END) AS oldest,
        count(DISTINCT room) AS rooms
      FROM mail_queue GROUP BY account_id ORDER BY oldest ASC LIMIT ?
    `).all(limit) as Row[]).map((r) => ({
      accountId: String(r.account_id),
      queued: Number(r.queued),
      delivering: Number(r.delivering),
      dead: Number(r.dead),
      bytes: Number(r.bytes ?? 0),
      oldestAt: r.oldest === null ? null : Number(r.oldest),
      rooms: Number(r.rooms),
    }));
  }

  /** Expired items become dead; long-dead ones are removed. */
  sweep(): { expired: number; purged: number } {
    const at = this.now();
    const expired = this.db.prepare("UPDATE mail_queue SET state = 'dead', dead_reason = 'expired before delivery', lease_until = 0 WHERE state != 'dead' AND expires_at <= ?")
      .run(at).changes;
    const purged = this.db.prepare("DELETE FROM mail_queue WHERE state = 'dead' AND stored_at < ?")
      .run(at - QUEUE_LIMITS.deadRetentionMs).changes;
    // The ledger: by age, then by count (oldest first).
    this.db.prepare("DELETE FROM relay_ledger WHERE at < ?").run(at - LEDGER_LIMITS.ttlMs);
    const count = Number((this.db.prepare("SELECT count(*) AS n FROM relay_ledger").get() as { n: number }).n);
    if (count > LEDGER_LIMITS.maxEntries) {
      this.db.prepare("DELETE FROM relay_ledger WHERE message_id IN (SELECT message_id FROM relay_ledger ORDER BY at ASC LIMIT ?)").run(count - LEDGER_LIMITS.maxEntries);
    }
    return { expired, purged };
  }

  /** A later receipt for the same message raises the stored one. */
  upgradeStatus(accountId: string, messageId: string, status: { state: "delivered" | "read"; at: number; recipientName: string }): boolean {
    const row = this.db.prepare("SELECT * FROM mail_queue WHERE account_id = ? AND kind = 'status' AND message_id = ? AND state != 'dead'")
      .get(accountId, messageId) as Row | undefined;
    if (!row) return false;
    const current = this.row(row).status;
    if (!current || current.state === "read" || current.state === status.state) return false;
    return this.db.prepare("UPDATE mail_queue SET status_json = ?, state = 'queued', lease_until = 0 WHERE id = ?")
      .run(this.store(String(row.id), "status", JSON.stringify(status)), String(row.id)).changes > 0;
  }

  /* -------------------------------------------------------------- ledger */

  rememberRelay(messageId: string, room: string, sender: LedgerEntry["sender"], recipient: string): void {
    const run = this.db.transaction(() => {
      const existing = this.relayOf(messageId);
      if (existing) {
        if (existing.recipients.includes(recipient)) return;
        const recipients = [...existing.recipients, recipient].slice(-200);
        this.db.prepare("UPDATE relay_ledger SET recipients = ? WHERE message_id = ?")
          .run(this.store(`ledger:${messageId}`, "recipients", JSON.stringify(recipients)), messageId);
        return;
      }
      this.db.prepare("INSERT INTO relay_ledger (message_id, room, sender, recipients, at) VALUES (?, ?, ?, ?, ?)").run(
        messageId, room,
        this.store(`ledger:${messageId}`, "sender", JSON.stringify(sender)),
        this.store(`ledger:${messageId}`, "recipients", JSON.stringify([recipient])),
        this.now(),
      );
    });
    run();
  }

  relayOf(messageId: string): LedgerEntry | null {
    const row = this.db.prepare("SELECT * FROM relay_ledger WHERE message_id = ?").get(messageId) as Row | undefined;
    if (!row) return null;
    const open = (raw: unknown, column: string): unknown => {
      if (typeof raw !== "string") return null;
      const text = raw.startsWith(SEALED) ? (this.sealer ? this.sealer.open(raw.slice(SEALED.length), `mq:ledger:${messageId}:${column}`) : null) : raw;
      if (text === null) return null;
      try { return JSON.parse(text); } catch { return null; }
    };
    const sender = open(row.sender, "sender") as LedgerEntry["sender"] | null;
    const recipients = open(row.recipients, "recipients") as string[] | null;
    if (!sender || !Array.isArray(recipients)) return null;
    return { messageId, room: String(row.room), sender, recipients, at: Number(row.at) };
  }

  /** Everything of one account (it was deleted). */
  purgeAccount(accountId: string): number {
    this.db.prepare("DELETE FROM mail_queue_seq WHERE account_id = ?").run(accountId);
    return this.db.prepare("DELETE FROM mail_queue WHERE account_id = ?").run(accountId).changes;
  }
}
