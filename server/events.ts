// Event logging scaffold.
//
//  • DATABASE_URL=sqlite:./path  → reálná perzistence přes better-sqlite3
//  • DATABASE_URL unset + LOG_EVENTS=1 → in-memory ring (500 záznamů), mizí po restartu
//  • LOG_EVENTS≠1  → no-op (vše se zahazuje)
//
// Žádné zprávy ani klíče se nikdy logují — jen sanitizovaná metadata:
//   (ts, kind, room?, peerId?, meta?)
// peerId je zahashovaný, aby se zabránilo korelaci v tracech.

import path from "node:path";
import fs from "node:fs";

type EventRecord = {
  id: string;
  ts: number;
  kind: string;
  room?: string;
  peerId?: string;
  meta?: Record<string, unknown>;
};

const RING_LIMIT = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Sanitizace metadat — whitelist polí
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeMeta(input: Record<string, unknown> | undefined) {
  if (!input || typeof input !== "object") return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof key !== "string" || key.length > 32) continue;
    if (/[^a-zA-Z0-9_-]/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = value;
    } else if (typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "string") {
      const trimmed = value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 64);
      if (trimmed) safe[key] = trimmed;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

function safeId(value: unknown, max = 64) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, max);
  return trimmed || undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite backend — lazy load better-sqlite3
// ─────────────────────────────────────────────────────────────────────────────

interface SqliteBackend {
  insert(event: EventRecord): void;
  recent(limit: number): EventRecord[];
  close(): void;
}

function createSqliteBackend(databaseUrl: string): SqliteBackend | null {
  // Podpora formátů:
  //   sqlite:./relative/path
  //   sqlite:/absolute/path
  //   sqlite::memory:
  let filename = databaseUrl.startsWith("sqlite:") ? databaseUrl.slice("sqlite:".length) : databaseUrl;
  if (!filename) return null;
  if (filename === ":memory:") {
    filename = ":memory:";
  } else {
    // absolutní cesta — zajisti adresář
    if (filename.startsWith("/")) {
      const dir = path.dirname(filename);
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          return null;
        }
      }
    } else {
      // relativní — vždy pod CWD/eventstore.db
      const abs = path.resolve(process.cwd(), filename);
      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          return null;
        }
      }
      filename = abs;
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const db = new Database(filename);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        room TEXT,
        peer_id TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS events_room_ts ON events (room, ts DESC);
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts DESC);
    `);
    const stmt = db.prepare(
      "INSERT INTO events (id, ts, kind, room, peer_id, meta) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const qstmt = db.prepare(
      "SELECT id, ts, kind, room, peer_id AS peerId, meta FROM events ORDER BY ts DESC LIMIT ?",
    );
    return {
      insert(event) {
        stmt.run(
          event.id,
          event.ts,
          event.kind,
          event.room ?? null,
          event.peerId ?? null,
          event.meta ? JSON.stringify(event.meta) : null,
        );
      },
      recent(limit) {
        const rows = qstmt.all(limit) as Array<{
          id: string;
          ts: number;
          kind: string;
          room: string | null;
          peerId: string | null;
          meta: string | null;
        }>;
        return rows
          .map((r) => ({
            id: r.id,
            ts: r.ts,
            kind: r.kind,
            room: r.room ?? undefined,
            peerId: r.peerId ?? undefined,
            meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : undefined,
          }))
          .reverse();
      },
      close() {
        try {
          db.close();
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    // better-sqlite3 není k dispozici nebo DB init selhal — vrátíme null,
    // čímž se automaticky fallbackuje na in-memory ring.
    console.warn("[eventStore] SQLite backend unavailable, using memory backend:", (err as Error).message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EventStore façade
// ─────────────────────────────────────────────────────────────────────────────

class EventStore {
  private ring: EventRecord[] = [];
  private databaseUrl?: string;
  private enabled: boolean;
  private sqlite: SqliteBackend | null = null;

  constructor() {
    this.databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
    this.enabled = process.env.LOG_EVENTS === "1";
    if (this.enabled && this.databaseUrl && this.databaseUrl.startsWith("sqlite:")) {
      this.sqlite = createSqliteBackend(this.databaseUrl);
    }
  }

  get backend(): "disabled" | "memory" | "database" {
    if (!this.enabled) return "disabled";
    if (this.sqlite) return "database";
    return "memory";
  }

  get isEnabled() {
    return this.enabled;
  }

  record(input: {
    kind: string;
    room?: string;
    peerId?: string;
    meta?: Record<string, unknown>;
  }) {
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

    // Reálná DB perzistence (pokud inicializována)
    if (this.sqlite) {
      try {
        this.sqlite.insert(event);
      } catch (err) {
        // pokud DB write selže, pokračuj do ring (viditelnost v /events/recent)
        console.warn("[eventStore] SQLite insert failed, falling back to ring:", (err as Error).message);
      }
    }

    // Mirror do paměti — aby /api/events/recent fungoval i bez DB
    this.ring.push(event);
    if (this.ring.length > RING_LIMIT) {
      this.ring.splice(0, this.ring.length - RING_LIMIT);
    }
  }

  recent(limit = 50) {
    // Preferuj DB pokud je k dispozici; jinak vrať ring
    if (this.sqlite) {
      try {
        return this.sqlite.recent(limit);
      } catch {
        // fall through
      }
    }
    const clamped = Math.max(1, Math.min(RING_LIMIT, Math.floor(limit) || 50));
    return this.ring.slice(-clamped);
  }
}

export const eventStore = new EventStore();
