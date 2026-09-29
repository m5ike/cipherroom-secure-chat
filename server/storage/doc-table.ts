// A table of JSON documents (6.0): an id, the document, a number to sort by
// and a key to filter by (a device, a call…). SQLite when the driver is there
// (the caller opens the database and hands it over), memory otherwise — the
// same calls either way. Shared by the Android store and the telephony engine.

import type { SqliteDatabase } from "./db";

type Row = { id: string; data: string; sort: number; device: string };

export class DocTable<T extends { id: string }> {
  private mem = new Map<string, T>();
  constructor(
    private readonly name: string,
    private readonly db: () => SqliteDatabase | null,
    private readonly sortOf: (v: T) => number,
    private readonly deviceOf: (v: T) => string = () => "",
  ) {}

  schema(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.name} (id TEXT PRIMARY KEY, data TEXT NOT NULL, sort INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '');
            CREATE INDEX IF NOT EXISTS ${this.name}_sort ON ${this.name}(sort);
            CREATE INDEX IF NOT EXISTS ${this.name}_device ON ${this.name}(device, sort);`;
  }

  get(id: string): T | null {
    const d = this.db();
    if (!d) return this.mem.get(id) ?? null;
    const row = d.prepare(`SELECT data FROM ${this.name} WHERE id = ?`).get(id) as Pick<Row, "data"> | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  put(value: T): T {
    const d = this.db();
    if (!d) { this.mem.set(value.id, structuredClone(value)); return value; }
    d.prepare(`INSERT INTO ${this.name} (id, data, sort, device) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, sort = excluded.sort, device = excluded.device`)
      .run(value.id, JSON.stringify(value), this.sortOf(value), this.deviceOf(value));
    return value;
  }

  delete(id: string): boolean {
    const d = this.db();
    if (!d) return this.mem.delete(id);
    return (d.prepare(`DELETE FROM ${this.name} WHERE id = ?`).run(id) as { changes: number }).changes > 0;
  }

  /** Newest first. */
  list(opts: { device?: string; limit?: number; before?: number; filter?: (v: T) => boolean } = {}): T[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const d = this.db();
    if (!d) {
      return [...this.mem.values()]
        .filter((v) => (!opts.device || this.deviceOf(v) === opts.device) && (opts.before === undefined || this.sortOf(v) < opts.before) && (!opts.filter || opts.filter(v)))
        .sort((a, b) => this.sortOf(b) - this.sortOf(a))
        .slice(0, limit)
        .map((v) => structuredClone(v));
    }
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.device) { where.push("device = ?"); args.push(opts.device); }
    if (opts.before !== undefined) { where.push("sort < ?"); args.push(opts.before); }
    const sql = `SELECT data FROM ${this.name}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sort DESC`;
    if (!opts.filter) return (d.prepare(`${sql} LIMIT ?`).all(...args, limit) as Array<Pick<Row, "data">>).map((r) => JSON.parse(r.data) as T);
    // A filter runs in JS: walk the rows until the limit is filled.
    const out: T[] = [];
    for (const r of d.prepare(sql).iterate(...args) as IterableIterator<Pick<Row, "data">>) {
      const v = JSON.parse(r.data) as T;
      if (opts.filter(v)) out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }

  count(filter?: (v: T) => boolean): number {
    const d = this.db();
    if (!d) return filter ? [...this.mem.values()].filter(filter).length : this.mem.size;
    if (!filter) return Number((d.prepare(`SELECT COUNT(*) AS n FROM ${this.name}`).get() as { n: number }).n);
    return this.list({ limit: 5000, filter }).length;
  }

  /** Removes rows sorted before `t` (events, commands); returns how many. */
  pruneBefore(t: number, keep?: (v: T) => boolean): number {
    const d = this.db();
    if (!d) {
      let n = 0;
      for (const [id, v] of this.mem) if (this.sortOf(v) < t && !(keep?.(v))) { this.mem.delete(id); n++; }
      return n;
    }
    if (!keep) return (d.prepare(`DELETE FROM ${this.name} WHERE sort < ?`).run(t) as { changes: number }).changes;
    let n = 0;
    for (const v of this.list({ before: t, limit: 5000 })) if (!keep(v)) { this.delete(v.id); n++; }
    return n;
  }

  clearMemory(): void { this.mem.clear(); }
}
