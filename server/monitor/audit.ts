// The audit journal: every event that matters, in one structured stream.
//
// Categories
//   security       failed sign-ins, refused frames, rate limits, bad tokens
//   account        register, sign-in, sign-out, delete, database open/fail
//   communication  who reached whom: relay stored / delivered / read,
//                  signaling between peers, file transfers — metadata only
//   storage        session databases created, promoted, forgotten, swept
//   admin          what the operator did (commands, retention, toggles)
//   network        connections opened and closed, protocol handshakes
//   system         start-up, driver availability, sweeps, internal errors
//
// Each entry carries a timestamp, a level, the actor and target (peer or
// account ids), a hash of the room, sizes and a state, plus a free-form
// detail that is sealed with the storage master key before it is written
// to the database. The server never has message content to record — it
// relays ciphertext — so "auditing communication" means auditing *who,
// when, how much and with what outcome*.
//
// Communication auditing is OFF unless the operator turns it on
// (AUDIT_COMMUNICATION=1, or the console toggle): who-talked-to-whom is
// exactly the metadata an end-to-end encrypted chat should not keep by
// default. Everything else is always recorded.

export type AuditCategory = "security" | "account" | "communication" | "storage" | "admin" | "network" | "system";
export type AuditLevel = "debug" | "info" | "notice" | "warn" | "error";

export type AuditEntry = {
  id: number;
  at: number;
  category: AuditCategory;
  level: AuditLevel;
  event: string;
  /** Who did it: a peer id, an account id, "admin", "server". */
  actor?: string;
  /** Who it was done to / sent to. */
  target?: string;
  accountId?: string;
  sessionId?: string;
  peerId?: string;
  roomHash?: string;
  ip?: string;
  bytes?: number;
  /** Outcome: "ok", "stored", "delivered", "rejected", an HTTP status… */
  status?: string;
  detail?: unknown;
};

export type AuditInput = Omit<AuditEntry, "id" | "at" | "level"> & { at?: number; level?: AuditLevel };

/** Where entries are persisted (the global database, once storage is up). */
export type AuditSink = (entry: AuditEntry) => void;

const RING = 3_000;

export class AuditJournal {
  private ring: AuditEntry[] = [];
  private nextId = 1;
  private sink: AuditSink | null = null;
  private subscribers = new Set<(entry: AuditEntry) => boolean>();
  private counts = new Map<string, number>();
  private communication: boolean;

  constructor(private readonly now: () => number = Date.now) {
    this.communication = process.env.AUDIT_COMMUNICATION?.trim() === "1";
  }

  /** Persist from now on (and keep the in-memory ring either way). */
  setSink(sink: AuditSink | null): void {
    this.sink = sink;
  }

  /** Whether per-message communication records are kept. */
  get communicationEnabled(): boolean {
    return this.communication;
  }

  setCommunication(enabled: boolean, by = "admin"): void {
    if (this.communication === enabled) return;
    this.communication = enabled;
    this.add({ category: "admin", level: "notice", event: enabled ? "audit.communication.on" : "audit.communication.off", actor: by });
  }

  add(input: AuditInput): AuditEntry | null {
    // The one category that is opt-in.
    if (input.category === "communication" && !this.communication) {
      this.bump("communication.skipped");
      return null;
    }
    const entry: AuditEntry = {
      ...input,
      id: this.nextId++,
      at: input.at ?? this.now(),
      level: input.level ?? "info",
      event: String(input.event).slice(0, 120),
    };
    this.ring.push(entry);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    this.bump(entry.category);
    this.bump(`${entry.category}.${entry.level}`);

    try { this.sink?.(entry); } catch { /* the journal must never break a request */ }
    for (const subscriber of this.subscribers) subscriber(entry);
    return entry;
  }

  private bump(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Newest first, from the in-memory ring. */
  recent(filter: {
    category?: AuditCategory;
    level?: AuditLevel;
    minLevel?: AuditLevel;
    actor?: string;
    accountId?: string;
    peerId?: string;
    roomHash?: string;
    event?: string;
    search?: string;
    since?: number;
    limit?: number;
  } = {}): AuditEntry[] {
    const order: AuditLevel[] = ["debug", "info", "notice", "warn", "error"];
    const minRank = filter.minLevel ? order.indexOf(filter.minLevel) : -1;
    const needle = filter.search?.toLowerCase();
    const limit = Math.max(1, Math.min(2_000, filter.limit ?? 200));
    const out: AuditEntry[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const e = this.ring[i];
      if (filter.since && e.at < filter.since) break;
      if (filter.category && e.category !== filter.category) continue;
      if (filter.level && e.level !== filter.level) continue;
      if (minRank >= 0 && order.indexOf(e.level) < minRank) continue;
      if (filter.actor && e.actor !== filter.actor) continue;
      if (filter.accountId && e.accountId !== filter.accountId && e.actor !== filter.accountId && e.target !== filter.accountId) continue;
      if (filter.peerId && e.peerId !== filter.peerId && e.actor !== filter.peerId && e.target !== filter.peerId) continue;
      if (filter.roomHash && e.roomHash !== filter.roomHash) continue;
      if (filter.event && !e.event.startsWith(filter.event)) continue;
      if (needle) {
        const hay = `${e.event} ${e.actor ?? ""} ${e.target ?? ""} ${e.status ?? ""} ${e.ip ?? ""} ${JSON.stringify(e.detail ?? "")}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      out.push(e);
    }
    return out;
  }

  stats(): { total: number; byCategory: Record<string, number>; communicationEnabled: boolean; buffered: number } {
    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const [key, value] of this.counts) {
      byCategory[key] = value;
      if (!key.includes(".")) total += value;
    }
    return { total, byCategory, communicationEnabled: this.communication, buffered: this.ring.length };
  }

  subscribe(listener: (entry: AuditEntry) => boolean): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  /** Test seam. */
  reset(): void {
    this.ring = [];
    this.nextId = 1;
    this.counts.clear();
    this.subscribers.clear();
    this.sink = null;
    this.communication = process.env.AUDIT_COMMUNICATION?.trim() === "1";
  }
}

export const audit = new AuditJournal();
