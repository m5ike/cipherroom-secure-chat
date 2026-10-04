// What running TSAs keep (6.9), in telephony.db next to the calls (tel-store's
// file, its own connection — SQLite in WAL mode is the channel between the
// main service, where the providers' webhooks resume a call, and the admin
// service, where the console's simulator and test calls start one):
//
//   tsa_sessions   one row per TSA run on a call (or in the simulator): where
//                  it is, what it waits for, its variables, values and trace
//   tsa_graphs     the graphs sessions run, once each (by content hash) — a
//                  session keeps running the graph it started with
//   tsa_audio      synthesized speech (AI & speech TTS) the provider fetches
//                  from /wh/tsa/audio/<token>, until it expires
//   tsa_marks      small counters: wrong route codes per caller and hour,
//                  one-use codes already used
//
// Without the SQLite driver everything lives in memory (one process).

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { loadSqliteDriver, type SqliteDatabase } from "../../storage/db";
import { DocTable } from "../../storage/doc-table";
import { telDbPath } from "../tel-store";
import type { CallAction } from "../providers/types";
import type { InrouteEntry } from "../control/types";
import type { TsaCallRef } from "../control/hooks";
import type { TsaGraph, TsaSession } from "./types";

/** Where a session continues when a "played" redirect comes back. */
export type Cursor = { run: string } | { follow: { node: string; port: string } };

/** The simulator's own state: route codes added in the simulation, what it reported. */
export type SimState = { inroute: Record<string, InrouteEntry> };

/** A session as stored: the contract's TsaSession plus what only the runtime needs. */
export type StoredSession = TsaSession & {
  /** The call's webhook capability and identity (never shown by the API). */
  ref: TsaCallRef;
  graphKey: string;
  tsaName: string;
  draft: boolean;
  /** The Start's language (TTS / STT / spoken errors). */
  lang: string;
  /** The call has been answered (a state on Hang up refuses an unanswered call instead). */
  answered: boolean;
  /** The caller hung up while a recording was still on its way: only the rest of the flow that needs no caller runs. */
  offline: boolean;
  /** Read DTMF retries per node; wrong route codes in this call. */
  attempts: Record<string, number>;
  routeAttempts: number;
  /** Rounds per running loop (by node). */
  rounds: Record<string, number>;
  /** After a "played" redirect: where to go on. */
  cont: Cursor | null;
  /** The last turn's actions — a repeated or stale webhook gets them again. */
  lastActions: CallAction[];
  deadline: number;
  /** Trace entries appended so far (the simulator shows the new ones). */
  traceCount: number;
  sim: SimState | null;
  /** What waits is doing: record for an STT (ai) or a plain recording. */
  waitMode: string;
};

export type StoredGraph = { id: string; graph: TsaGraph; at: number };
export type StoredAudio = { id: string; mime: string; data: string; text: string; session: string; createdAt: number; expiresAt: number };
export type StoredMark = { id: string; n: number; at: number; expiresAt: number };

class TsaDb {
  private db: SqliteDatabase | null = null;
  private opening: Promise<void> | null = null;
  private reason = "";

  readonly sessions = new DocTable<StoredSession>("tsa_sessions", () => this.db, (s) => s.updatedAt, (s) => s.callId);
  readonly graphs = new DocTable<StoredGraph>("tsa_graphs", () => this.db, (g) => g.at);
  readonly audio = new DocTable<StoredAudio>("tsa_audio", () => this.db, (a) => a.expiresAt, (a) => a.session);
  readonly marks = new DocTable<StoredMark>("tsa_marks", () => this.db, (m) => m.expiresAt);

  ready(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.opening ??= (async () => {
      const Driver = await loadSqliteDriver();
      if (!Driver) { this.reason = "the SQLite driver is not installed — TSA sessions are kept in memory only"; return; }
      const file = telDbPath();
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
        try { chmodSync(file, 0o600); } catch { /* not ours */ }
        const db = new Driver(file, { timeout: 5000 });
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        for (const t of [this.sessions, this.graphs, this.audio, this.marks]) db.exec(t.schema());
        this.db = db;
        this.reason = "";
      } catch (err) {
        this.reason = `cannot open ${file}: ${(err as Error).message} — TSA sessions are kept in memory only`;
      }
    })();
    return this.opening;
  }

  status(): { persistent: boolean; file: string; reason: string } { return { persistent: Boolean(this.db), file: telDbPath(), reason: this.reason }; }

  /** Stores a graph once; its key. */
  putGraph(graph: TsaGraph): string {
    const json = JSON.stringify(graph);
    const id = createHash("sha256").update(json).digest("hex").slice(0, 32);
    const had = this.graphs.get(id);
    // Touched when used again, so a graph a new call runs is not pruned under it.
    if (!had || had.at < Date.now() - 24 * 3600_000) this.graphs.put({ id, graph, at: Date.now() });
    return id;
  }

  /** A counter that expires (wrong codes per caller and hour, used one-time codes). */
  bump(id: string, ttlMs: number, now = Date.now()): number {
    const m = this.marks.get(id);
    const live = m && m.expiresAt > now ? m : null;
    const next: StoredMark = { id, n: (live?.n ?? 0) + 1, at: now, expiresAt: live?.expiresAt ?? now + ttlMs };
    this.marks.put(next);
    return next.n;
  }
  count(id: string, now = Date.now()): number { const m = this.marks.get(id); return m && m.expiresAt > now ? m.n : 0; }

  /** Old rows go: simulator sessions after an hour, every other session a day after its last change, expired audio and marks. */
  prune(now = Date.now()): void {
    try {
      this.audio.pruneBefore(now);
      this.marks.pruneBefore(now);
      this.sessions.pruneBefore(now - 3600_000, (s) => !s.callId.startsWith("sim:") && s.updatedAt >= now - 24 * 3600_000);
      // Graphs nobody runs any more (kept a week: a long call, a replay in the console).
      this.graphs.pruneBefore(now - 7 * 24 * 3600_000);
    } catch { /* pruning never breaks a call */ }
  }

  /** Tests: close and forget. */
  reset(): void {
    try { this.db?.close(); } catch { /* closed */ }
    this.db = null;
    this.opening = null;
    for (const t of [this.sessions, this.graphs, this.audio, this.marks]) t.clearMemory();
  }
}

export const tsaDb = new TsaDb();
