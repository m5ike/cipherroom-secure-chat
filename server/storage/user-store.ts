// One encrypted database per user (or per anonymous session).
//
// The handle is opened with the key the caller provides and cached for a
// while, because opening a SQLCipher database costs a key derivation. The
// pool is bounded (least recently used handles close first) and idle
// handles are closed by `sweepIdle`, so a busy server does not sit on
// hundreds of open files — and so a signed-out user's database goes back to
// being an opaque file as soon as possible. A cached handle is only handed
// out for the key it was opened with (compared as a fingerprint, in
// constant time).
//
// Everything here is the user's own data: settings, rooms, messages, the
// away mailbox, their audit trail and the sealed account vault. Nothing in
// this module writes a key anywhere; the index in the global database says
// how each one is keyed.
//
// Limits: every write runs in a transaction that ends with a quota check
// (bytes the database actually uses), single values and messages have a
// size cap, and reads stop at a byte budget as well as a row limit.

import { digestKey, keyToSqlcipher, sameDigest } from "./keys";
import {
  DatabaseOpenError, openUserDatabase, PayloadTooLargeError, QuotaExceededError, ReservedKeyError,
  type SqliteDatabase, type SqliteStatement,
} from "./db";
import { USER_MIGRATIONS } from "./schema";

export type StoredMessage = {
  id: string;
  room: string;
  createdAt: number;
  senderId?: string;
  senderName?: string;
  mine?: boolean;
  expiresAt?: number;
  payload: unknown;
  /** Server-assigned, monotonic: the cursor for incremental reads. */
  seq?: number;
};

export type MailboxItem = {
  id: string;
  room: string;
  kind: "message" | "status";
  messageId: string;
  from: unknown;
  envelope?: unknown;
  status?: unknown;
  storedAt: number;
  bytes: number;
};

export type UserEvent = { at: number; kind: string; meta?: unknown };

export type VaultPart = { ct: string; updatedAt: number };
export type VaultParts = { profile?: VaultPart; chat?: VaultPart; connections?: VaultPart };
/** The sealed parts of an account vault (3.2 added the saved connections). */
export const VAULT_PARTS = ["profile", "chat", "connections"] as const;

/** The kv key the account vault used to live under; nobody may write it. */
export const VAULT_KEY = "vault";
export const RESERVED_KEYS: ReadonlySet<string> = new Set([VAULT_KEY]);

export type UserLimits = {
  maxMessages: number;
  maxMessageBytes: number;
  maxKvBytes: number;
  maxVaultPartBytes: number;
  maxMailbox: number;
  maxMailItemBytes: number;
  maxReadRows: number;
  maxReadBytes: number;
  maxEvents: number;
  futureSkewMs: number;
  pastWindowMs: number;
};

export const USER_LIMITS: Readonly<UserLimits> = {
  maxMessages: 20_000,
  maxMessageBytes: 256 * 1024,
  maxKvBytes: 4_000_000,
  maxVaultPartBytes: 8_000_000,
  maxMailbox: 500,
  maxMailItemBytes: 256 * 1024,
  maxReadRows: 5_000,
  maxReadBytes: 4 * 1024 * 1024,
  maxEvents: 500,
  futureSkewMs: 5 * 60 * 1000,
  pastWindowMs: 365 * 24 * 60 * 60 * 1000,
};

export type UserDatabaseOptions = {
  /** Bytes this database may use; 0 = unlimited. */
  quotaBytes?: number;
  limits?: Partial<UserLimits>;
};

export type MessagePage = { messages: StoredMessage[]; more: boolean; lastSeq: number };

export type PutResult = { stored: number; skipped: string[]; trimmed: number };

export type MovedCounts = { messages: number; keys: number; mailbox: number; events: number; rooms: number };

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** A live handle on one encrypted database. */
export class UserDatabase {
  lastUsedAt = Date.now();
  readonly quotaBytes: number;
  private readonly limits: UserLimits;
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(readonly id: string, private readonly db: SqliteDatabase, options: UserDatabaseOptions = {}) {
    this.quotaBytes = Math.max(0, options.quotaBytes ?? 0);
    this.limits = { ...USER_LIMITS, ...(options.limits ?? {}) };
  }

  private touch() { this.lastUsedAt = Date.now(); }

  /** Prepared once per handle: preparing is not free, and this runs on
   *  every request. */
  private sql(source: string): SqliteStatement {
    let statement = this.statements.get(source);
    if (!statement) {
      statement = this.db.prepare(source);
      this.statements.set(source, statement);
    }
    return statement;
  }

  get open(): boolean { return this.db.open; }

  close(): void {
    this.statements.clear();
    try { this.db.close(); } catch { /* already closed */ }
  }

  /* -------------------------------------------------------------- quota */

  /** Bytes the database uses: its pages minus the free ones. Inside a
   *  write transaction this already counts what the transaction added. */
  /** Writes the WAL back into the file, so a copy of the file is complete. */
  checkpoint(): void {
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* a busy database checkpoints later */ }
  }

  /** SQLite's quick integrity check: "ok", or what is wrong. */
  quickCheck(): string {
    try { return String(this.db.pragma("quick_check", { simple: true })); } catch (err) { return (err as Error).message; }
  }

  usedBytes(): number {
    const pages = Number(this.db.pragma("page_count", { simple: true }) ?? 0);
    const free = Number(this.db.pragma("freelist_count", { simple: true }) ?? 0);
    const size = Number(this.db.pragma("page_size", { simple: true }) ?? 4096);
    return Math.max(0, pages - free) * size;
  }

  /** Throws (and so rolls back the surrounding transaction) past the quota. */
  private checkQuota(): void {
    if (this.quotaBytes <= 0) return;
    const used = this.usedBytes();
    if (used > this.quotaBytes) throw new QuotaExceededError(used, this.quotaBytes);
  }

  /* ----------------------------------------------------------- settings */

  put(key: string, value: unknown): void {
    this.touch();
    const name = String(key).slice(0, 120);
    if (RESERVED_KEYS.has(name)) throw new ReservedKeyError(name);
    const json = JSON.stringify(value ?? null);
    if (json.length > this.limits.maxKvBytes) throw new PayloadTooLargeError("value too large");
    const write = this.db.transaction(() => {
      this.sql(`
        INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(name, json, Date.now());
      this.checkQuota();
    });
    write();
  }

  get<T = unknown>(key: string): T | null {
    this.touch();
    const row = this.sql("SELECT value FROM kv WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try { return JSON.parse(row.value) as T; } catch { return null; }
  }

  keys(): string[] {
    this.touch();
    return (this.sql("SELECT key FROM kv ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
  }

  remove(key: string): boolean {
    this.touch();
    return this.sql("DELETE FROM kv WHERE key = ?").run(key).changes > 0;
  }

  /* -------------------------------------------------------------- vault */

  /** The sealed account vault (profile + chat), or null when there is none. */
  getVault(): VaultParts | null {
    this.touch();
    const rows = this.sql("SELECT part, ct, updated_at FROM vault").all() as Array<{ part: string; ct: string; updated_at: number }>;
    if (rows.length === 0) return null;
    const vault: VaultParts = {};
    for (const row of rows) {
      if ((VAULT_PARTS as readonly string[]).includes(row.part)) vault[row.part as (typeof VAULT_PARTS)[number]] = { ct: String(row.ct), updatedAt: Number(row.updated_at) };
    }
    return vault.profile || vault.chat || vault.connections ? vault : null;
  }

  /** Stores the parts given. With `onlyNewer`, a part only replaces one
   *  with an older timestamp. */
  putVault(vault: VaultParts, options: { onlyNewer?: boolean } = {}): void {
    this.touch();
    const parts = VAULT_PARTS.filter((p) => vault[p] && typeof vault[p]!.ct === "string");
    for (const part of parts) {
      if (vault[part]!.ct.length > this.limits.maxVaultPartBytes) throw new PayloadTooLargeError(`vault ${part} too large`);
    }
    const upsert = this.sql(`
      INSERT INTO vault (part, ct, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(part) DO UPDATE SET ct = excluded.ct, updated_at = excluded.updated_at
      WHERE ? = 0 OR excluded.updated_at > vault.updated_at
    `);
    const write = this.db.transaction(() => {
      for (const part of parts) {
        const value = vault[part]!;
        upsert.run(part, value.ct, Number(value.updatedAt) || Date.now(), options.onlyNewer ? 1 : 0);
      }
      this.checkQuota();
    });
    write();
  }

  eraseVault(): void {
    this.touch();
    this.sql("DELETE FROM vault").run();
  }

  /* ----------------------------------------------------------- messages */

  /** Adds (or replaces) messages and keeps the room index in step. Returns
   *  how many were stored (a message over the size cap is skipped). */
  putMessages(messages: StoredMessage[]): number {
    return this.putMessagesDetailed(messages).stored;
  }

  /** putMessages, telling which messages were skipped as too large and how
   *  many old ones the per-database cap pushed out. */
  putMessagesDetailed(messages: StoredMessage[]): PutResult {
    this.touch();
    const now = Date.now();
    const earliest = now - this.limits.pastWindowMs;
    const latest = now + this.limits.futureSkewMs;
    const skipped: string[] = [];
    const rows: Array<{ id: string; room: string; createdAt: number; senderId: string; senderName: string; mine: number; expiresAt: number; payload: string }> = [];
    for (const m of messages) {
      const id = String(m.id ?? "").slice(0, 120);
      const room = String(m.room ?? "").slice(0, 64);
      if (!id || !room) continue;
      const payload = JSON.stringify(m.payload ?? null);
      if (payload.length > this.limits.maxMessageBytes) { skipped.push(id); continue; }
      // The client's clock decides the order, within reason: nothing from
      // the far past, nothing from the future.
      const created = Number(m.createdAt);
      rows.push({
        id, room,
        createdAt: Math.round(clamp(Number.isFinite(created) && created > 0 ? created : now, earliest, latest)),
        senderId: String(m.senderId ?? "").slice(0, 64),
        senderName: String(m.senderName ?? "").slice(0, 64),
        mine: m.mine ? 1 : 0,
        expiresAt: Math.max(0, Math.round(Number(m.expiresAt) || 0)),
        payload,
      });
    }
    if (rows.length === 0) return { stored: 0, skipped, trimmed: 0 };

    const insert = this.sql(`
      INSERT INTO messages (seq, id, room, created_at, stored_at, sender_id, sender_name, mine, expires_at, bytes, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room, id) DO UPDATE SET
        payload = excluded.payload, expires_at = excluded.expires_at, bytes = excluded.bytes,
        stored_at = excluded.stored_at, seq = excluded.seq
    `);
    const upsertRoom = this.sql(`
      INSERT INTO rooms (room, first_seen_at, last_seen_at, message_count) VALUES (?, ?, ?, 0)
      ON CONFLICT(room) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `);
    const write = this.db.transaction((): number => {
      let seq = this.currentSeq();
      const touched = new Map<string, number>();
      for (const m of rows) {
        seq += 1;
        insert.run(seq, m.id, m.room, m.createdAt, now, m.senderId, m.senderName, m.mine, m.expiresAt, m.payload.length, m.payload);
        touched.set(m.room, Math.min(touched.get(m.room) ?? m.createdAt, m.createdAt));
      }
      this.setSeq(seq);
      for (const [room, first] of touched) upsertRoom.run(room, first, now);
      // Counted once per room, after the loop — not once per message.
      this.recount(touched.keys());
      const trimmed = this.trimInside(now);
      this.checkQuota();
      return trimmed;
    });
    const trimmed = write();
    return { stored: rows.length, skipped, trimmed };
  }

  private currentSeq(): number {
    const row = this.sql("SELECT value FROM counters WHERE name = 'message_seq'").get() as { value?: number } | undefined;
    return Number(row?.value ?? 0);
  }

  private setSeq(value: number): void {
    this.sql("INSERT INTO counters (name, value) VALUES ('message_seq', ?) ON CONFLICT(name) DO UPDATE SET value = max(value, excluded.value)").run(value);
  }

  /** Exact counts for these rooms; rooms left with nothing go. */
  private recount(rooms: Iterable<string>): void {
    const count = this.sql("UPDATE rooms SET message_count = (SELECT count(*) FROM messages WHERE messages.room = ?) WHERE room = ?");
    const drop = this.sql("DELETE FROM rooms WHERE room = ? AND message_count <= 0");
    for (const room of rooms) {
      count.run(room, room);
      drop.run(room);
    }
  }

  /** Newest first by default, the last `limit` in ascending order. With a
   *  cursor — `afterSeq` (preferred) or `since` (a createdAt, inclusive) —
   *  the OLDEST rows after it, ascending, so paging never skips any. */
  readMessages(filter: { room?: string; since?: number; afterSeq?: number; limit?: number; maxBytes?: number } = {}): StoredMessage[] {
    return this.readMessagesPage(filter).messages;
  }

  /** readMessages, plus whether more rows are waiting (row limit or byte
   *  budget reached) and the highest `seq` handed out. */
  readMessagesPage(filter: { room?: string; since?: number; afterSeq?: number; limit?: number; maxBytes?: number } = {}): MessagePage {
    this.touch();
    const limit = clamp(Math.floor(Number(filter.limit) || 500), 1, this.limits.maxReadRows);
    const budget = clamp(Math.floor(Number(filter.maxBytes) || this.limits.maxReadBytes), 1, this.limits.maxReadBytes);
    const clauses = ["(expires_at = 0 OR expires_at > ?)"];
    const params: unknown[] = [Date.now()];
    if (filter.room) { clauses.push("room = ?"); params.push(filter.room); }
    let order: string;
    let newestFirst = false;
    const afterSeq = typeof filter.afterSeq === "number" && Number.isFinite(filter.afterSeq) && filter.afterSeq >= 0 ? Math.floor(filter.afterSeq) : null;
    if (afterSeq !== null) {
      clauses.push("seq > ?");
      params.push(afterSeq);
      order = "seq ASC";
    } else if (filter.since) {
      clauses.push("created_at >= ?");
      params.push(filter.since);
      order = "created_at ASC, seq ASC";
    } else {
      order = "created_at DESC, seq DESC";
      newestFirst = true;
    }
    params.push(limit + 1);
    const statement = this.sql(`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ?`);
    const out: StoredMessage[] = [];
    let bytes = 0;
    let more = false;
    for (const raw of statement.iterate(...params)) {
      const row = raw as Record<string, unknown>;
      const size = Number(row.bytes) || String(row.payload ?? "").length;
      if (out.length >= limit || (out.length > 0 && bytes + size > budget)) { more = true; break; }
      bytes += size;
      out.push(toMessage(row));
    }
    if (newestFirst) out.reverse();
    const lastSeq = out.reduce((max, m) => Math.max(max, m.seq ?? 0), afterSeq ?? 0);
    return { messages: out, more, lastSeq };
  }

  deleteMessages(filter: { room?: string; before?: number } = {}): number {
    this.touch();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.room) { clauses.push("room = ?"); params.push(filter.room); }
    if (filter.before) { clauses.push("created_at < ?"); params.push(filter.before); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const run = this.db.transaction((): number => {
      const affected = this.db.prepare(`SELECT room, count(*) AS n FROM messages ${where} GROUP BY room`).all(...params) as Array<{ room: string; n: number }>;
      const gone = this.db.prepare(`DELETE FROM messages ${where}`).run(...params).changes;
      this.decrement(affected);
      return gone;
    });
    return run();
  }

  /** Drops expired messages and anything past the per-database cap. */
  trimMessages(now = Date.now()): number {
    const run = this.db.transaction((): number => this.trimInside(now));
    return run();
  }

  private decrement(affected: Array<{ room: string; n: number }>): void {
    const down = this.sql("UPDATE rooms SET message_count = max(0, message_count - ?) WHERE room = ?");
    const drop = this.sql("DELETE FROM rooms WHERE room = ? AND message_count <= 0");
    for (const { room, n } of affected) {
      down.run(Number(n), room);
      drop.run(room);
    }
  }

  /** Both trims find their rows through an index and adjust the room counts
   *  by what they removed. Runs inside the caller's transaction. */
  private trimInside(now: number): number {
    let removed = 0;
    const expired = this.sql("SELECT room, count(*) AS n FROM messages WHERE expires_at > 0 AND expires_at < ? GROUP BY room").all(now) as Array<{ room: string; n: number }>;
    if (expired.length) {
      removed += this.sql("DELETE FROM messages WHERE expires_at > 0 AND expires_at < ?").run(now).changes;
      this.decrement(expired);
    }
    const total = Number((this.sql("SELECT COALESCE(sum(message_count), 0) AS n FROM rooms").get() as { n?: number } | undefined)?.n ?? 0);
    const excess = total - this.limits.maxMessages;
    if (excess > 0) {
      // The newest `excess`-th oldest row is the cutoff; everything up to it
      // goes. (created_at, seq) is a strict order backed by an index.
      const edge = this.sql("SELECT created_at, seq FROM messages ORDER BY created_at ASC, seq ASC LIMIT 1 OFFSET ?").get(excess - 1) as { created_at: number; seq: number } | undefined;
      if (edge) {
        const affected = this.sql("SELECT room, count(*) AS n FROM messages WHERE (created_at, seq) <= (?, ?) GROUP BY room").all(edge.created_at, edge.seq) as Array<{ room: string; n: number }>;
        removed += this.sql("DELETE FROM messages WHERE (created_at, seq) <= (?, ?)").run(edge.created_at, edge.seq).changes;
        this.decrement(affected);
      }
    }
    return removed;
  }

  rooms(): Array<{ room: string; firstSeenAt: number; lastSeenAt: number; messages: number }> {
    this.touch();
    return (this.sql("SELECT * FROM rooms ORDER BY last_seen_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({
      room: String(row.room),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      messages: Number(row.message_count),
    }));
  }

  /* ------------------------------------------------------------ mailbox */

  addMail(item: Omit<MailboxItem, "bytes"> & { bytes?: number }): MailboxItem | null {
    this.touch();
    const envelope = item.envelope === undefined ? null : JSON.stringify(item.envelope);
    const status = item.status === undefined ? null : JSON.stringify(item.status);
    const from = JSON.stringify(item.from ?? null);
    const bytes = item.bytes ?? (envelope?.length ?? 0) + (status?.length ?? 0);
    if ((envelope?.length ?? 0) + (status?.length ?? 0) + from.length > this.limits.maxMailItemBytes) return null;
    const run = this.db.transaction((): boolean => {
      const pending = Number((this.sql("SELECT count(*) AS n FROM mailbox").get() as { n?: number } | undefined)?.n ?? 0);
      if (pending >= this.limits.maxMailbox) return false;
      this.sql(`
        INSERT INTO mailbox (id, room, kind, message_id, from_json, envelope, status_json, stored_at, bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(String(item.id).slice(0, 120), String(item.room).slice(0, 64), item.kind, String(item.messageId).slice(0, 120), from, envelope, status, item.storedAt, bytes);
      this.checkQuota();
      return true;
    });
    return run() ? { ...item, bytes } as MailboxItem : null;
  }

  mailbox(room?: string): MailboxItem[] {
    this.touch();
    const rows = (room
      ? this.sql("SELECT * FROM mailbox WHERE room = ? ORDER BY stored_at").all(room)
      : this.sql("SELECT * FROM mailbox ORDER BY stored_at").all()) as Array<Record<string, unknown>>;
    return rows.map(toMail);
  }

  takeMail(ids: string[]): MailboxItem[] {
    this.touch();
    if (ids.length === 0) return [];
    const get = this.sql("SELECT * FROM mailbox WHERE id = ?");
    const drop = this.sql("DELETE FROM mailbox WHERE id = ?");
    const run = this.db.transaction((list: string[]): MailboxItem[] => {
      const taken: MailboxItem[] = [];
      for (const id of new Set(list)) {
        const row = get.get(id) as Record<string, unknown> | undefined;
        if (!row) continue;
        drop.run(id);
        taken.push(toMail(row));
      }
      return taken.sort((a, b) => a.storedAt - b.storedAt);
    });
    return run(ids);
  }

  mailboxStats(): { pending: number; bytes: number } {
    const row = this.sql("SELECT count(*) AS n, COALESCE(sum(bytes), 0) AS b FROM mailbox").get() as { n?: number; b?: number } | undefined;
    return { pending: Number(row?.n ?? 0), bytes: Number(row?.b ?? 0) };
  }

  /* ------------------------------------------------------------- events */

  addEvent(event: UserEvent): void {
    this.touch();
    const run = this.db.transaction(() => {
      this.sql("INSERT INTO events (at, kind, meta) VALUES (?, ?, ?)")
        .run(event.at || Date.now(), String(event.kind).slice(0, 60), event.meta === undefined ? null : JSON.stringify(event.meta).slice(0, 2_000));
      // Keep the newest few hundred; the cut is found through the rowid.
      this.sql("DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)").run(this.limits.maxEvents);
    });
    run();
  }

  events(limit = 100): UserEvent[] {
    this.touch();
    return (this.sql("SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?").all(clamp(Math.floor(Number(limit) || 100), 1, this.limits.maxEvents)) as Array<Record<string, unknown>>)
      .map((row) => ({ at: Number(row.at), kind: String(row.kind), meta: row.meta ? safeParse(String(row.meta)) : undefined }));
  }

  /* --------------------------------------------------------------- misc */

  summary(): { messages: number; messageBytes: number; rooms: number; keys: number; mailbox: number; events: number; usedBytes: number; quotaBytes: number } {
    const one = (sql: string) => Number((this.sql(sql).get() as { n?: number } | undefined)?.n ?? 0);
    return {
      messages: one("SELECT COALESCE(sum(message_count), 0) AS n FROM rooms"),
      messageBytes: one("SELECT COALESCE(sum(bytes), 0) AS n FROM messages"),
      rooms: one("SELECT count(*) AS n FROM rooms"),
      keys: one("SELECT count(*) AS n FROM kv"),
      mailbox: one("SELECT count(*) AS n FROM mailbox"),
      events: one("SELECT count(*) AS n FROM events"),
      usedBytes: this.usedBytes(),
      quotaBytes: this.quotaBytes,
    };
  }

  /** The cheap part of summary(), for answering every write: no table
   *  scans, just the room counts and the pages in use. */
  usage(): { messages: number; rooms: number; usedBytes: number; quotaBytes: number } {
    const row = this.sql("SELECT COALESCE(sum(message_count), 0) AS n, count(*) AS r FROM rooms").get() as { n?: number; r?: number } | undefined;
    return { messages: Number(row?.n ?? 0), rooms: Number(row?.r ?? 0), usedBytes: this.usedBytes(), quotaBytes: this.quotaBytes };
  }

  /** Empties every table but keeps the database (the user asked to clear).
   *  The message counter is kept: `seq` never goes backwards. */
  wipe(): void {
    this.touch();
    this.db.exec("DELETE FROM messages; DELETE FROM rooms; DELETE FROM kv; DELETE FROM mailbox; DELETE FROM events; DELETE FROM vault;");
    this.db.exec("VACUUM");
  }

  /** Everything in this database, for moving it somewhere else. (Promotion
   *  uses `absorb`, which copies in one transaction without this detour.) */
  exportAll(): { kv: Array<{ key: string; value: unknown }>; messages: StoredMessage[]; mailbox: MailboxItem[]; events: UserEvent[] } {
    this.touch();
    const messages = (this.sql("SELECT * FROM messages WHERE expires_at = 0 OR expires_at > ? ORDER BY created_at ASC, seq ASC").all(Date.now()) as Array<Record<string, unknown>>).map(toMessage);
    return {
      kv: this.keys().filter((key) => !RESERVED_KEYS.has(key)).map((key) => ({ key, value: this.get(key) })),
      messages,
      mailbox: this.mailbox(),
      events: this.events(this.limits.maxEvents),
    };
  }

  /** The other half of exportAll. */
  importAll(data: ReturnType<UserDatabase["exportAll"]>): void {
    this.touch();
    for (const entry of data.kv) if (!RESERVED_KEYS.has(entry.key)) this.put(entry.key, entry.value);
    for (let i = 0; i < data.messages.length; i += 2_000) this.putMessages(data.messages.slice(i, i + 2_000));
    for (const item of data.mailbox) this.addMail(item);
    for (const event of data.events) this.addEvent(event);
  }

  /**
   * Moves everything from another encrypted database (a session's) into
   * this one: every live message, every setting (the newer value wins a
   * conflict; the reserved vault key is never copied), the mailbox and the
   * events (without duplicates). One transaction: the counts are verified
   * before it commits, and anything short of all of it rolls back.
   */
  absorb(sourcePath: string, sourceKey: Buffer): MovedCounts {
    this.touch();
    this.db.prepare("ATTACH DATABASE ? AS src KEY ?").run(sourcePath, keyToSqlcipher(sourceKey));
    try {
      const now = Date.now();
      const count = (sql: string, ...params: unknown[]) => Number((this.db.prepare(sql).get(...params) as { n?: number } | undefined)?.n ?? 0);
      const run = this.db.transaction((): MovedCounts => {
        // Settings: the newer value wins, and the vault is not the session's to give.
        const keys = count("SELECT count(*) AS n FROM src.kv WHERE key <> ?", VAULT_KEY);
        this.db.prepare(`
          INSERT INTO main.kv (key, value, updated_at)
          SELECT key, value, updated_at FROM src.kv WHERE key <> ?
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          WHERE excluded.updated_at > kv.updated_at
        `).run(VAULT_KEY);

        // Messages: all live ones, with fresh seq numbers from this database.
        const live = "(expires_at = 0 OR expires_at > ?)";
        const messages = count(`SELECT count(*) AS n FROM src.messages WHERE ${live}`, now);
        const base = this.currentSeq();
        this.db.prepare(`
          INSERT INTO main.messages (seq, id, room, created_at, stored_at, sender_id, sender_name, mine, expires_at, bytes, payload)
          SELECT ? + row_number() OVER (ORDER BY created_at, seq), id, room, created_at, stored_at, sender_id, sender_name, mine, expires_at, bytes, payload
          FROM src.messages WHERE ${live}
          ON CONFLICT(room, id) DO UPDATE SET
            payload = excluded.payload, expires_at = excluded.expires_at, bytes = excluded.bytes,
            stored_at = excluded.stored_at, seq = excluded.seq
          WHERE excluded.stored_at > messages.stored_at
        `).run(base, now);
        this.setSeq(base + messages);

        // Rooms, then exact counts for every room that was touched.
        this.db.prepare(`
          INSERT INTO main.rooms (room, name, first_seen_at, last_seen_at, message_count)
          SELECT room, name, first_seen_at, last_seen_at, 0 FROM src.rooms WHERE true
          ON CONFLICT(room) DO UPDATE SET
            first_seen_at = min(rooms.first_seen_at, excluded.first_seen_at),
            last_seen_at = max(rooms.last_seen_at, excluded.last_seen_at),
            name = CASE WHEN rooms.name = '' THEN excluded.name ELSE rooms.name END
        `).run();
        this.db.prepare(`
          INSERT INTO main.rooms (room, first_seen_at, last_seen_at, message_count)
          SELECT room, min(created_at), max(stored_at), 0 FROM src.messages WHERE true GROUP BY room
          ON CONFLICT(room) DO NOTHING
        `).run();
        const rooms = (this.db.prepare("SELECT room FROM src.rooms UNION SELECT DISTINCT room FROM src.messages").all() as Array<{ room: string }>).map((r) => r.room);
        this.recount(rooms);

        // Mailbox and events.
        const mailbox = count("SELECT count(*) AS n FROM src.mailbox");
        this.db.prepare(`
          INSERT INTO main.mailbox (id, room, kind, message_id, from_json, envelope, status_json, stored_at, bytes)
          SELECT id, room, kind, message_id, from_json, envelope, status_json, stored_at, bytes FROM src.mailbox WHERE true
          ON CONFLICT(id) DO NOTHING
        `).run();
        const events = this.db.prepare(`
          INSERT INTO main.events (at, kind, meta)
          SELECT s.at, s.kind, s.meta FROM src.events s
          WHERE NOT EXISTS (SELECT 1 FROM main.events e WHERE e.at = s.at AND e.kind = s.kind AND e.meta IS s.meta)
          ORDER BY s.at, s.id
        `).run().changes;

        // Nothing is left behind: every source row must be here now.
        const presentMessages = count(`
          SELECT count(*) AS n FROM src.messages s
          WHERE (s.expires_at = 0 OR s.expires_at > ?) AND EXISTS (SELECT 1 FROM main.messages m WHERE m.room = s.room AND m.id = s.id)
        `, now);
        const presentKeys = count("SELECT count(*) AS n FROM src.kv s WHERE s.key <> ? AND EXISTS (SELECT 1 FROM main.kv m WHERE m.key = s.key)", VAULT_KEY);
        const presentMail = count("SELECT count(*) AS n FROM src.mailbox s WHERE EXISTS (SELECT 1 FROM main.mailbox m WHERE m.id = s.id)");
        if (presentMessages !== messages || presentKeys !== keys || presentMail !== mailbox) {
          throw new Error(`promotion verification failed (messages ${presentMessages}/${messages}, keys ${presentKeys}/${keys}, mailbox ${presentMail}/${mailbox})`);
        }
        this.checkQuota();
        return { messages, keys, mailbox, events, rooms: rooms.length };
      });
      return run();
    } finally {
      try { this.db.exec("DETACH DATABASE src"); } catch { /* not attached */ }
    }
  }
}

type PoolEntry = { handle: UserDatabase; digest: Buffer };

/** Opens encrypted databases and keeps recently used ones around — at most
 *  `maxOpen` of them; the least recently used closes first. */
export class UserDatabasePool {
  private entries = new Map<string, PoolEntry>();

  constructor(private readonly idleMs = 5 * 60 * 1000, private readonly maxOpen = 200) {}

  /**
   * The open handle for `id`, if it was opened with this very key; else
   * opens it. A cached handle is never handed to a different key: that is
   * a DatabaseOpenError("wrong-key"), just as the file itself would say.
   */
  open(id: string, path: string, key: Buffer, options: UserDatabaseOptions & { mustExist?: boolean } = {}): UserDatabase {
    const digest = digestKey(key);
    const existing = this.entries.get(id);
    if (existing?.handle.open) {
      if (!sameDigest(existing.digest, digest)) throw new DatabaseOpenError("wrong-key", "this key does not open the stored database");
      this.promote(id, existing);
      existing.handle.lastUsedAt = Date.now();
      return existing.handle;
    }
    if (existing) this.entries.delete(id);
    this.evictDownTo(Math.max(0, this.maxOpen - 1));
    const handle = new UserDatabase(id, openUserDatabase(path, key, USER_MIGRATIONS, { mustExist: options.mustExist }), options);
    this.entries.set(id, { handle, digest });
    return handle;
  }

  get(id: string): UserDatabase | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (!entry.handle.open) { this.entries.delete(id); return null; }
    this.promote(id, entry);
    return entry.handle;
  }

  private promote(id: string, entry: PoolEntry): void {
    // A Map iterates in insertion order: re-inserting makes this the most
    // recently used, and the first entry the least.
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  private evictDownTo(size: number): number {
    let closed = 0;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= size) break;
      entry.handle.close();
      this.entries.delete(id);
      closed += 1;
    }
    return closed;
  }

  /** Closes one database — after a sign-out it should be a file again. */
  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.handle.close();
    this.entries.delete(id);
  }

  sweepIdle(now = Date.now()): number {
    let closed = 0;
    for (const [id, entry] of this.entries) {
      if (!entry.handle.open || now - entry.handle.lastUsedAt > this.idleMs) {
        entry.handle.close();
        this.entries.delete(id);
        closed += 1;
      }
    }
    return closed;
  }

  closeAll(): void {
    for (const [, entry] of this.entries) entry.handle.close();
    this.entries.clear();
  }

  get size(): number { return this.entries.size; }

  /** Every open database (backup, integrity check). */
  forEachOpen(fn: (id: string, db: UserDatabase) => void): void {
    for (const [id, entry] of this.entries) if (entry.handle.open) fn(id, entry.handle);
  }
}

function toMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: String(row.id),
    room: String(row.room),
    createdAt: Number(row.created_at),
    senderId: String(row.sender_id ?? ""),
    senderName: String(row.sender_name ?? ""),
    mine: Number(row.mine) === 1,
    expiresAt: Number(row.expires_at),
    payload: safeParse(String(row.payload)),
    seq: Number(row.seq),
  };
}

function toMail(row: Record<string, unknown>): MailboxItem {
  return {
    id: String(row.id),
    room: String(row.room),
    kind: String(row.kind) as MailboxItem["kind"],
    messageId: String(row.message_id),
    from: safeParse(String(row.from_json)),
    envelope: row.envelope ? safeParse(String(row.envelope)) : undefined,
    status: row.status_json ? safeParse(String(row.status_json)) : undefined,
    storedAt: Number(row.stored_at),
    bytes: Number(row.bytes),
  };
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}
