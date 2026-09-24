// The journal of AI & speech calls (4.14): who called which model, from
// where, how long it took, how many tokens, what it cost, whether it worked —
// in $DATA_DIR/ai/journal.db (SQLite, WAL: the app and the admin service both
// write). What was said is kept only while the owner has content logging on
// (to debug), and every row goes after the retention period. Usage for the
// limits is counted from here.
//
// Without the SQLite driver (an install that could not build it) the journal
// lives in memory: limits still count, but not across restarts — the console
// says so.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadSqliteDriver, type SqliteDatabase } from "../storage/db";
import { aiDataDir } from "./config";
import type { ModelKind } from "./types";

export type CallSource = "app" | "playground" | "test" | "function";
export type CallStatus = "ok" | "error" | "refused" | "cancelled";

export type CallRecord = {
  id: string;
  ts: number;
  source: CallSource;
  /** Username, "guest", or the administrator's name. */
  actor: string;
  /** The account id (for the per-user limits); "" for guests and the console. */
  account: string;
  provider: string;
  providerType: string;
  model: string;
  kind: ModelKind;
  status: CallStatus;
  error: string;
  http: number;
  ms: number;
  /** Time to the first piece of a stream. */
  ttft: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCached: number;
  estimated: boolean;
  /** USD, where the model has prices; null = unknown. */
  cost: number | null;
  charsIn: number;
  charsOut: number;
  stream: boolean;
  /** What was said — only with content logging on. */
  content: string | null;
};

export type CallQuery = { limit?: number; before?: number; after?: number; source?: string; status?: string; provider?: string; account?: string; model?: string; q?: string };
export type Usage = { requests: number; tokens: number; usd: number };

const MEMORY_MAX = 5000;
const COLUMNS = "id, ts, source, actor, account, provider, provider_type, model, kind, status, error, http, ms, ttft, tin, tout, treason, tcached, estimated, cost, chars_in, chars_out, stream, content";

export function journalPath(): string {
  const explicit = process.env.AI_JOURNAL_FILE?.trim();
  return explicit ? resolve(explicit) : resolve(aiDataDir(), "journal.db");
}

export function newCallId(): string {
  return `call_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

class Journal {
  private db: SqliteDatabase | null = null;
  private file = "";
  private memory: CallRecord[] = [];
  private opening: Promise<void> | null = null;
  private reason = "";
  private writes = 0;
  /** Called with every new record (the admin service streams them). */
  onRecord: ((r: CallRecord) => void) | null = null;

  /** Opens the database once (the driver loads asynchronously). */
  ready(): Promise<void> {
    const file = journalPath();
    if (this.db && this.file === file) return Promise.resolve();
    if (this.db && this.file !== file) { try { this.db.close(); } catch { /* closed */ } this.db = null; this.opening = null; this.memory = []; }
    this.opening ??= (async () => {
      const Driver = await loadSqliteDriver();
      if (!Driver) { this.reason = "the SQLite driver is not installed — the journal is kept in memory only"; return; }
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        if (!existsSync(file)) { closeSync(openSync(file, "a", 0o600)); }
        try { chmodSync(file, 0o600); } catch { /* not ours to change */ }
        const db = new Driver(file, { timeout: 5000 });
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.exec(`CREATE TABLE IF NOT EXISTS calls (
          id TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL, actor TEXT NOT NULL, account TEXT NOT NULL,
          provider TEXT NOT NULL, provider_type TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
          error TEXT NOT NULL, http INTEGER NOT NULL, ms INTEGER NOT NULL, ttft INTEGER NOT NULL,
          tin INTEGER NOT NULL, tout INTEGER NOT NULL, treason INTEGER NOT NULL, tcached INTEGER NOT NULL, estimated INTEGER NOT NULL,
          cost REAL, chars_in INTEGER NOT NULL, chars_out INTEGER NOT NULL, stream INTEGER NOT NULL, content TEXT);
          CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
          CREATE INDEX IF NOT EXISTS calls_account_ts ON calls(account, ts);`);
        this.db = db;
        this.file = file;
        this.reason = "";
      } catch (err) {
        this.reason = `cannot open ${file}: ${(err as Error).message} — the journal is kept in memory only`;
      }
    })();
    return this.opening;
  }

  status(): { persistent: boolean; file: string; reason: string } {
    return { persistent: Boolean(this.db), file: journalPath(), reason: this.reason };
  }

  record(r: CallRecord): void {
    if (this.db) {
      this.db.prepare(`INSERT INTO calls (${COLUMNS}) VALUES (${COLUMNS.split(",").map(() => "?").join(",")})`).run(
        r.id, r.ts, r.source, r.actor, r.account, r.provider, r.providerType, r.model, r.kind, r.status, r.error, r.http, r.ms, r.ttft,
        r.tokensIn, r.tokensOut, r.tokensReasoning, r.tokensCached, r.estimated ? 1 : 0, r.cost, r.charsIn, r.charsOut, r.stream ? 1 : 0, r.content,
      );
    } else {
      this.memory.push(r);
      if (this.memory.length > MEMORY_MAX) this.memory.splice(0, this.memory.length - MEMORY_MAX);
    }
    this.onRecord?.(r);
  }

  /** Removes what is older than the retention period (now and then, after writes). */
  prune(retentionDays: number, now = Date.now()): number {
    const cutoff = now - retentionDays * 86_400_000;
    if (this.db) return this.db.prepare("DELETE FROM calls WHERE ts < ?").run(cutoff).changes;
    const before = this.memory.length;
    this.memory = this.memory.filter((r) => r.ts >= cutoff);
    return before - this.memory.length;
  }

  /** Forgets what was said in older calls (content logging ended or its time ran out). */
  dropContentBefore(ts: number): void {
    if (this.db) this.db.prepare("UPDATE calls SET content = NULL WHERE content IS NOT NULL AND ts < ?").run(ts);
    else for (const r of this.memory) if (r.ts < ts) r.content = null;
  }

  /** Now and then after writes: old calls go, and what was said goes once content logging has ended. */
  maybePrune(retentionDays: number, contentLogging: boolean): void {
    if (++this.writes % 200 !== 1) return;
    this.prune(retentionDays);
    if (!contentLogging) this.dropContentBefore(Date.now() + 1);
  }

  /** Requests, tokens and USD since a time (for everyone, or one account), chat and speech. */
  usage(since: number, account?: string): Usage {
    if (this.db) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(tin + tout), 0) AS t, COALESCE(SUM(cost), 0) AS c FROM calls WHERE ts >= ? AND status = 'ok'${account !== undefined ? " AND account = ?" : ""}`)
        .get(...(account !== undefined ? [since, account] : [since])) as { n: number; t: number; c: number };
      return { requests: row.n, tokens: row.t, usd: row.c };
    }
    let requests = 0; let tokens = 0; let usd = 0;
    for (const r of this.memory) {
      if (r.ts < since || r.status !== "ok" || (account !== undefined && r.account !== account)) continue;
      requests += 1; tokens += r.tokensIn + r.tokensOut; usd += r.cost ?? 0;
    }
    return { requests, tokens, usd };
  }

  list(q: CallQuery = {}): CallRecord[] {
    const limit = Math.max(1, Math.min(1000, q.limit ?? 100));
    if (this.db) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (q.before) { where.push("ts < ?"); args.push(q.before); }
      if (q.after) { where.push("ts > ?"); args.push(q.after); }
      for (const [col, v] of [["source", q.source], ["status", q.status], ["provider", q.provider], ["account", q.account], ["model", q.model]] as const) {
        if (v) { where.push(`${col} = ?`); args.push(v); }
      }
      if (q.q) { where.push("(actor LIKE ? OR model LIKE ? OR error LIKE ?)"); const like = `%${q.q.replace(/[%_]/g, "")}%`; args.push(like, like, like); }
      const rows = this.db.prepare(`SELECT ${COLUMNS} FROM calls${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`).all(...args, limit) as Row[];
      return rows.map(fromRow);
    }
    const needle = (q.q ?? "").toLowerCase();
    return this.memory.filter((r) =>
      (!q.before || r.ts < q.before) && (!q.after || r.ts > q.after) && (!q.source || r.source === q.source) && (!q.status || r.status === q.status)
      && (!q.provider || r.provider === q.provider) && (!q.account || r.account === q.account) && (!q.model || r.model === q.model)
      && (!needle || `${r.actor} ${r.model} ${r.error}`.toLowerCase().includes(needle)),
    ).slice(-limit).reverse();
  }

  get(id: string): CallRecord | null {
    if (this.db) {
      const row = this.db.prepare(`SELECT ${COLUMNS} FROM calls WHERE id = ?`).get(id) as Row | undefined;
      return row ? fromRow(row) : null;
    }
    return this.memory.find((r) => r.id === id) ?? null;
  }

  /** Sums per day, per model and per user over the last days. */
  summary(days: number, now = Date.now()): { byDay: SummaryRow[]; byModel: SummaryRow[]; byActor: SummaryRow[]; bySource: SummaryRow[] } {
    const since = now - days * 86_400_000;
    const rows = this.db ? null : this.memory.filter((r) => r.ts >= since);
    const group = (key: (r: CallRecord) => string, sql: string): SummaryRow[] => {
      if (this.db) {
        return (this.db.prepare(`SELECT ${sql} AS k, COUNT(*) AS n, SUM(status = 'ok') AS ok, COALESCE(SUM(tin), 0) AS tin, COALESCE(SUM(tout), 0) AS tout, COALESCE(SUM(cost), 0) AS cost, SUM(cost IS NOT NULL) AS priced, COALESCE(AVG(ms), 0) AS ms FROM calls WHERE ts >= ? GROUP BY k ORDER BY n DESC LIMIT 60`).all(since) as Array<{ k: string; n: number; ok: number; tin: number; tout: number; cost: number; priced: number; ms: number }>)
          .map((r) => ({ key: String(r.k), requests: r.n, ok: r.ok, tokensIn: r.tin, tokensOut: r.tout, cost: r.cost, priced: r.priced, avgMs: Math.round(r.ms) }));
      }
      const map = new Map<string, SummaryRow>();
      for (const r of rows ?? []) {
        const k = key(r);
        const s = map.get(k) ?? { key: k, requests: 0, ok: 0, tokensIn: 0, tokensOut: 0, cost: 0, priced: 0, avgMs: 0 };
        s.avgMs = Math.round((s.avgMs * s.requests + r.ms) / (s.requests + 1));
        s.requests += 1; s.ok += r.status === "ok" ? 1 : 0; s.tokensIn += r.tokensIn; s.tokensOut += r.tokensOut; s.cost += r.cost ?? 0; s.priced += r.cost === null ? 0 : 1;
        map.set(k, s);
      }
      return [...map.values()].sort((a, b) => b.requests - a.requests).slice(0, 60);
    };
    return {
      byDay: group((r) => new Date(r.ts).toISOString().slice(0, 10), "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')").sort((a, b) => a.key.localeCompare(b.key)),
      byModel: group((r) => `${r.provider}/${r.model}`, "provider || '/' || model"),
      byActor: group((r) => r.actor, "actor"),
      bySource: group((r) => r.source, "source"),
    };
  }

  clear(): void {
    if (this.db) this.db.exec("DELETE FROM calls");
    this.memory = [];
  }

  /** For tests: forget the open database (another file next time). */
  reset(): void {
    try { this.db?.close(); } catch { /* closed */ }
    this.db = null;
    this.file = "";
    this.opening = null;
    this.memory = [];
    this.reason = "";
    this.writes = 0;
  }
}

/** Sums of a group of calls; `priced` = how many had a price (cost is unknown when none had). */
export type SummaryRow = { key: string; requests: number; ok: number; tokensIn: number; tokensOut: number; cost: number; priced: number; avgMs: number };

type Row = {
  id: string; ts: number; source: string; actor: string; account: string; provider: string; provider_type: string; model: string; kind: string; status: string;
  error: string; http: number; ms: number; ttft: number; tin: number; tout: number; treason: number; tcached: number; estimated: number; cost: number | null;
  chars_in: number; chars_out: number; stream: number; content: string | null;
};

function fromRow(r: Row): CallRecord {
  return {
    id: r.id, ts: r.ts, source: r.source as CallSource, actor: r.actor, account: r.account, provider: r.provider, providerType: r.provider_type, model: r.model,
    kind: r.kind as ModelKind, status: r.status as CallStatus, error: r.error, http: r.http, ms: r.ms, ttft: r.ttft, tokensIn: r.tin, tokensOut: r.tout,
    tokensReasoning: r.treason, tokensCached: r.tcached, estimated: r.estimated === 1, cost: r.cost, charsIn: r.chars_in, charsOut: r.chars_out, stream: r.stream === 1, content: r.content,
  };
}

export const journal = new Journal();
