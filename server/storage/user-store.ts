// One encrypted database per user (or per anonymous session).
//
// The handle is opened with the key the caller provides and cached for a
// while, because opening a SQLCipher database costs a key derivation. Idle
// handles are closed by `sweepIdle` so a busy server does not sit on
// hundreds of open files — and so a signed-out user's database goes back to
// being an opaque file as soon as possible.
//
// Everything here is the user's own data: settings, rooms, messages, the
// away mailbox and their audit trail. Nothing in this module writes a key
// anywhere; the index in the global database says how each one is keyed.

import { openUserDatabase, type SqliteDatabase } from "./db";
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

export const USER_LIMITS = {
  maxMessages: 20_000,
  maxMessageBytes: 2_000_000,
  maxKvBytes: 4_000_000,
  maxMailbox: 500,
} as const;

/** A live handle on one encrypted database. */
export class UserDatabase {
  lastUsedAt = Date.now();

  constructor(readonly id: string, private readonly db: SqliteDatabase) {}

  private touch() { this.lastUsedAt = Date.now(); }

  get open(): boolean { return this.db.open; }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /* ----------------------------------------------------------- settings */

  put(key: string, value: unknown): void {
    this.touch();
    const json = JSON.stringify(value ?? null);
    if (json.length > USER_LIMITS.maxKvBytes) throw new Error("value too large");
    this.db.prepare(`
      INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key.slice(0, 120), json, Date.now());
  }

  get<T = unknown>(key: string): T | null {
    this.touch();
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try { return JSON.parse(row.value) as T; } catch { return null; }
  }

  keys(): string[] {
    this.touch();
    return (this.db.prepare("SELECT key FROM kv ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
  }

  remove(key: string): boolean {
    this.touch();
    return this.db.prepare("DELETE FROM kv WHERE key = ?").run(key).changes > 0;
  }

  /* ----------------------------------------------------------- messages */

  /** Adds (or replaces) messages and keeps the room index in step. */
  putMessages(messages: StoredMessage[]): number {
    this.touch();
    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO messages (id, room, created_at, stored_at, sender_id, sender_name, mine, expires_at, bytes, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload, expires_at = excluded.expires_at, bytes = excluded.bytes, stored_at = excluded.stored_at
    `);
    const room = this.db.prepare(`
      INSERT INTO rooms (room, first_seen_at, last_seen_at, message_count) VALUES (?, ?, ?, 0)
      ON CONFLICT(room) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `);
    const count = this.db.prepare("UPDATE rooms SET message_count = (SELECT count(*) FROM messages WHERE messages.room = rooms.room) WHERE room = ?");
    const write = this.db.transaction((items: StoredMessage[]) => {
      for (const m of items) {
        const payload = JSON.stringify(m.payload ?? null);
        if (payload.length > USER_LIMITS.maxMessageBytes) continue; // too big to be worth keeping
        insert.run(
          String(m.id).slice(0, 120), String(m.room).slice(0, 64), Number(m.createdAt) || now, now,
          String(m.senderId ?? "").slice(0, 64), String(m.senderName ?? "").slice(0, 64),
          m.mine ? 1 : 0, Number(m.expiresAt) || 0, payload.length, payload,
        );
        room.run(String(m.room).slice(0, 64), Number(m.createdAt) || now, now);
        count.run(String(m.room).slice(0, 64));
      }
    });
    write(messages);
    this.trimMessages();
    return messages.length;
  }

  readMessages(filter: { room?: string; since?: number; limit?: number } = {}): StoredMessage[] {
    this.touch();
    const clauses = ["(expires_at = 0 OR expires_at > ?)"];
    const params: unknown[] = [Date.now()];
    if (filter.room) { clauses.push("room = ?"); params.push(filter.room); }
    if (filter.since) { clauses.push("created_at >= ?"); params.push(filter.since); }
    params.push(Math.max(1, Math.min(5_000, filter.limit ?? 500)));
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at ASC
    `).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      room: String(row.room),
      createdAt: Number(row.created_at),
      senderId: String(row.sender_id ?? ""),
      senderName: String(row.sender_name ?? ""),
      mine: Number(row.mine) === 1,
      expiresAt: Number(row.expires_at),
      payload: safeParse(String(row.payload)),
    }));
  }

  deleteMessages(filter: { room?: string; before?: number } = {}): number {
    this.touch();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.room) { clauses.push("room = ?"); params.push(filter.room); }
    if (filter.before) { clauses.push("created_at < ?"); params.push(filter.before); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const gone = this.db.prepare(`DELETE FROM messages ${where}`).run(...params).changes;
    this.db.exec("UPDATE rooms SET message_count = (SELECT count(*) FROM messages WHERE messages.room = rooms.room)");
    return gone;
  }

  /** Drops expired messages and anything past the per-database cap. */
  trimMessages(now = Date.now()): number {
    const expired = this.db.prepare("DELETE FROM messages WHERE expires_at > 0 AND expires_at < ?").run(now).changes;
    const over = this.db.prepare(`
      DELETE FROM messages WHERE id NOT IN (
        SELECT id FROM messages ORDER BY created_at DESC LIMIT ?
      )
    `).run(USER_LIMITS.maxMessages).changes;
    return expired + over;
  }

  rooms(): Array<{ room: string; firstSeenAt: number; lastSeenAt: number; messages: number }> {
    this.touch();
    return (this.db.prepare("SELECT * FROM rooms ORDER BY last_seen_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({
      room: String(row.room),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      messages: Number(row.message_count),
    }));
  }

  /* ------------------------------------------------------------ mailbox */

  addMail(item: Omit<MailboxItem, "bytes"> & { bytes?: number }): MailboxItem | null {
    this.touch();
    const pending = Number((this.db.prepare("SELECT count(*) AS n FROM mailbox").get() as { n?: number } | undefined)?.n ?? 0);
    if (pending >= USER_LIMITS.maxMailbox) return null;
    const envelope = item.envelope === undefined ? null : JSON.stringify(item.envelope);
    const status = item.status === undefined ? null : JSON.stringify(item.status);
    const bytes = item.bytes ?? (envelope?.length ?? 0) + (status?.length ?? 0);
    this.db.prepare(`
      INSERT INTO mailbox (id, room, kind, message_id, from_json, envelope, status_json, stored_at, bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(item.id, item.room, item.kind, item.messageId, JSON.stringify(item.from ?? null), envelope, status, item.storedAt, bytes);
    return { ...item, bytes } as MailboxItem;
  }

  mailbox(room?: string): MailboxItem[] {
    this.touch();
    const rows = (room
      ? this.db.prepare("SELECT * FROM mailbox WHERE room = ? ORDER BY stored_at").all(room)
      : this.db.prepare("SELECT * FROM mailbox ORDER BY stored_at").all()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      room: String(row.room),
      kind: String(row.kind) as MailboxItem["kind"],
      messageId: String(row.message_id),
      from: safeParse(String(row.from_json)),
      envelope: row.envelope ? safeParse(String(row.envelope)) : undefined,
      status: row.status_json ? safeParse(String(row.status_json)) : undefined,
      storedAt: Number(row.stored_at),
      bytes: Number(row.bytes),
    }));
  }

  takeMail(ids: string[]): MailboxItem[] {
    this.touch();
    if (ids.length === 0) return [];
    const taken = this.mailbox().filter((item) => ids.includes(item.id));
    const drop = this.db.prepare("DELETE FROM mailbox WHERE id = ?");
    const run = this.db.transaction((list: string[]) => { for (const id of list) drop.run(id); });
    run(taken.map((i) => i.id));
    return taken;
  }

  mailboxStats(): { pending: number; bytes: number } {
    const row = this.db.prepare("SELECT count(*) AS n, COALESCE(sum(bytes), 0) AS b FROM mailbox").get() as { n?: number; b?: number } | undefined;
    return { pending: Number(row?.n ?? 0), bytes: Number(row?.b ?? 0) };
  }

  /* ------------------------------------------------------------- events */

  addEvent(event: UserEvent): void {
    this.touch();
    this.db.prepare("INSERT INTO events (at, kind, meta) VALUES (?, ?, ?)")
      .run(event.at || Date.now(), event.kind.slice(0, 60), event.meta === undefined ? null : JSON.stringify(event.meta).slice(0, 2_000));
    this.db.prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY at DESC LIMIT 500)").run();
  }

  events(limit = 100): UserEvent[] {
    this.touch();
    return (this.db.prepare("SELECT * FROM events ORDER BY at DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>)
      .map((row) => ({ at: Number(row.at), kind: String(row.kind), meta: row.meta ? safeParse(String(row.meta)) : undefined }));
  }

  /* --------------------------------------------------------------- misc */

  summary(): { messages: number; messageBytes: number; rooms: number; keys: number; mailbox: number; events: number } {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
    return {
      messages: one("SELECT count(*) AS n FROM messages"),
      messageBytes: one("SELECT COALESCE(sum(bytes), 0) AS n FROM messages"),
      rooms: one("SELECT count(*) AS n FROM rooms"),
      keys: one("SELECT count(*) AS n FROM kv"),
      mailbox: one("SELECT count(*) AS n FROM mailbox"),
      events: one("SELECT count(*) AS n FROM events"),
    };
  }

  /** Empties every table but keeps the database (the user asked to clear). */
  wipe(): void {
    this.touch();
    this.db.exec("DELETE FROM messages; DELETE FROM rooms; DELETE FROM kv; DELETE FROM mailbox; DELETE FROM events;");
    this.db.exec("VACUUM");
  }

  /** Everything in this database, for moving it somewhere else. */
  exportAll(): { kv: Array<{ key: string; value: unknown }>; messages: StoredMessage[]; mailbox: MailboxItem[]; events: UserEvent[] } {
    this.touch();
    return {
      kv: this.keys().map((key) => ({ key, value: this.get(key) })),
      messages: this.readMessages({ limit: USER_LIMITS.maxMessages }),
      mailbox: this.mailbox(),
      events: this.events(500),
    };
  }

  /** The other half of exportAll. */
  importAll(data: ReturnType<UserDatabase["exportAll"]>): void {
    this.touch();
    for (const entry of data.kv) this.put(entry.key, entry.value);
    if (data.messages.length) this.putMessages(data.messages);
    for (const item of data.mailbox) this.addMail(item);
    for (const event of data.events) this.addEvent(event);
  }
}

/** Opens encrypted databases and keeps recently used ones around. */
export class UserDatabasePool {
  private handles = new Map<string, UserDatabase>();

  constructor(private readonly idleMs = 5 * 60 * 1000) {}

  open(id: string, path: string, key: Buffer): UserDatabase {
    const existing = this.handles.get(id);
    if (existing?.open) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const handle = new UserDatabase(id, openUserDatabase(path, key, USER_MIGRATIONS));
    this.handles.set(id, handle);
    return handle;
  }

  get(id: string): UserDatabase | null {
    const handle = this.handles.get(id);
    return handle?.open ? handle : null;
  }

  /** Closes one database — after a sign-out it should be a file again. */
  release(id: string): void {
    const handle = this.handles.get(id);
    if (!handle) return;
    handle.close();
    this.handles.delete(id);
  }

  sweepIdle(now = Date.now()): number {
    let closed = 0;
    for (const [id, handle] of this.handles) {
      if (!handle.open || now - handle.lastUsedAt > this.idleMs) {
        handle.close();
        this.handles.delete(id);
        closed += 1;
      }
    }
    return closed;
  }

  closeAll(): void {
    for (const [, handle] of this.handles) handle.close();
    this.handles.clear();
  }

  get size(): number { return this.handles.size; }
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}
