// The access log (5.2): every module decision — allowed and refused — for the
// app's users and the console's administrators. Both services append to one
// file a day under $DATA_DIR/access (JSON lines, 0600); the console reads it
// back with filters. Writes are buffered (flushed every second or at 200
// lines) so a check costs a push onto an array; files older than
// ACCESS_LOG_DAYS (default 30) are removed.
//
//   { at, module, subject, kind, decision, reason, right?, path?, ip?, via }

import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";

export type AccessEntry = {
  at: number;
  module: string;
  /** username, admin:<name>, "guest", "webhook", "api" … */
  subject: string;
  kind: "user" | "guest" | "admin" | "webhook" | "api" | "function" | "system";
  decision: "allow" | "deny";
  reason: string;
  right?: string;
  path?: string;
  ip?: string;
  /** Which service decided: app | console. */
  via: string;
};

export function accessLogDir(): string {
  const data = process.env.DATA_DIR?.trim();
  return data ? resolve(data, "access") : resolve(process.cwd(), ".m5cet", "access");
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const RECENT_MAX = 2000;

class AccessLog {
  private buffer: AccessEntry[] = [];
  private recent: AccessEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private lastCleanup = 0;

  record(e: AccessEntry): void {
    this.recent.push(e);
    if (this.recent.length > RECENT_MAX) this.recent.splice(0, this.recent.length - RECENT_MAX);
    if (process.env.ACCESS_LOG === "0") return;
    this.buffer.push(e);
    if (this.buffer.length >= 200) void this.flush();
    else if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 1000); this.timer.unref?.(); }
  }

  /** Writes what is buffered (one append per day file). */
  async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0);
    const byDay = new Map<string, string[]>();
    for (const e of batch) { const d = day(e.at); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(JSON.stringify(e)); }
    this.flushing = (async () => {
      try {
        const dir = accessLogDir();
        await mkdir(dir, { recursive: true, mode: 0o700 });
        for (const [d, lines] of byDay) await appendFile(join(dir, `access-${d}.jsonl`), `${lines.join("\n")}\n`, { mode: 0o600 });
        if (Date.now() - this.lastCleanup > 6 * 3600_000) { this.lastCleanup = Date.now(); await this.cleanup(); }
      } catch { /* a full disk must not break a request */ }
    })();
    await this.flushing;
    this.flushing = null;
  }

  private async cleanup(): Promise<void> {
    const keep = Math.max(1, Number(process.env.ACCESS_LOG_DAYS) || 30);
    const cutoff = day(Date.now() - keep * 86400_000);
    const dir = accessLogDir();
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const m = /^access-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[1] < cutoff) await unlink(join(dir, f)).catch(() => undefined);
    }
  }

  /** This process's latest decisions (newest last). */
  latest(): AccessEntry[] { return [...this.recent]; }

  /** Reads the log back, newest first: filters, and at most `limit` lines (the last `days` days). */
  async query(q: { module?: string; decision?: string; subject?: string; kind?: string; text?: string; since?: number; limit?: number; days?: number } = {}): Promise<{ entries: AccessEntry[]; stats: Record<string, { allow: number; deny: number }> }> {
    await this.flush();
    const limit = Math.max(1, Math.min(5000, q.limit ?? 500));
    const days = Math.max(1, Math.min(31, q.days ?? 2));
    const dir = accessLogDir();
    const out: AccessEntry[] = [];
    const stats: Record<string, { allow: number; deny: number }> = {};
    const needle = (q.text || "").toLowerCase();
    for (let i = 0; i < days && out.length < limit; i++) {
      const file = join(dir, `access-${day(Date.now() - i * 86400_000)}.jsonl`);
      let raw = "";
      try {
        const st = await stat(file);
        // Big days: the last 16 MB is plenty for the console.
        raw = await readFile(file, "utf8");
        if (st.size > 16 * 1024 * 1024) raw = raw.slice(-16 * 1024 * 1024);
      } catch { continue; }
      const lines = raw.split("\n");
      for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
        if (!lines[j]) continue;
        let e: AccessEntry;
        try { e = JSON.parse(lines[j]) as AccessEntry; } catch { continue; }
        if (q.since && e.at < q.since) continue;
        const s = (stats[e.module] ??= { allow: 0, deny: 0 });
        s[e.decision] += 1;
        if (q.module && e.module !== q.module) continue;
        if (q.decision && e.decision !== q.decision) continue;
        if (q.kind && e.kind !== q.kind) continue;
        if (q.subject && !e.subject.toLowerCase().includes(q.subject.toLowerCase())) continue;
        if (needle && !`${e.subject} ${e.right ?? ""} ${e.path ?? ""} ${e.reason}`.toLowerCase().includes(needle)) continue;
        out.push(e);
      }
    }
    return { entries: out, stats };
  }
}

export const accessLog = new AccessLog();
process.once("beforeExit", () => { void accessLog.flush(); });
