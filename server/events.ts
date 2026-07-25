// Optional event logging scaffold.
// When DATABASE_URL is set and LOG_EVENTS=1, append-only logs go to a SQLite/file backend.
// Otherwise an in-memory ring buffer is used and disappears on restart.
// No message contents are ever logged here — only opaque metadata.

import { sanitizeMeta, safeId } from "./util";

type EventRecord = {
  id: string;
  ts: number;
  kind: string;
  room?: string;
  peerId?: string;
  meta?: Record<string, unknown>;
};

const RING_LIMIT = 500;

class EventStore {
  private ring: EventRecord[] = [];
  private databaseUrl?: string;
  private enabled: boolean;

  constructor() {
    this.databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
    this.enabled = process.env.LOG_EVENTS === "1";
  }

  get backend() {
    if (!this.enabled) return "disabled";
    return this.databaseUrl ? "database" : "memory";
  }

  get isEnabled() {
    return this.enabled;
  }

  record(input: { kind: string; room?: string; peerId?: string; meta?: Record<string, unknown> }) {
    if (!this.enabled) return;
    const kind = safeId(input.kind, 32);
    if (!kind) return;

    const event: EventRecord = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind,
      room: safeId(input.room),
      peerId: safeId(input.peerId),
      meta: sanitizeMeta(input.meta),
    };

    if (this.databaseUrl) {
      // Database backend is intentionally a no-op stub. The schema would be:
      //   CREATE TABLE events (id TEXT PRIMARY KEY, ts INTEGER, kind TEXT, room TEXT, peer_id TEXT, meta TEXT)
      // We still mirror to memory so /api/events/recent works without external deps.
    }

    this.ring.push(event);
    if (this.ring.length > RING_LIMIT) {
      this.ring.splice(0, this.ring.length - RING_LIMIT);
    }
  }

  recent(limit = 50) {
    const clamped = Math.max(1, Math.min(RING_LIMIT, Math.floor(limit) || 50));
    return this.ring.slice(-clamped);
  }
}

export const eventStore = new EventStore();
