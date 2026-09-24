// The Functions store (4.15): packages and their versions, models, runs and
// their logs, sessions with a key–value store, and a shared cache — in
// $DATA_DIR/functions/functions.db (SQLite, WAL; the app and the runner both
// use it). FUNCTIONS_DB_FILE moves it.
//
// Without the SQLite driver (an install that could not build it) the store
// lives in memory: everything works within one run of the process but does
// not survive a restart, and the console says so.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { loadSqliteDriver, type SqliteDatabase } from "../storage/db";
import type {
  Caller, FileMap, Model, Package, PackageVersion, Run, RunLog, RunStatus,
} from "./types";

export function functionsDir(): string {
  const explicit = process.env.FUNCTIONS_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);
  const data = process.env.DATA_DIR?.trim();
  return data ? resolve(data, "functions") : resolve(process.cwd(), ".m5cet", "functions");
}
export function functionsDbPath(): string {
  const explicit = process.env.FUNCTIONS_DB_FILE?.trim();
  return explicit ? resolve(explicit) : resolve(functionsDir(), "functions.db");
}

export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
export const fingerprint = (files: FileMap): string => {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) h.update(path).update("\0").update(files[path]).update("\0");
  return h.digest("hex");
};

const jsonParse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

/* --------------------------------------------------------------- rows */

type PackageRow = { id: string; name: string; language: string; description: string; draft: string | null; created_at: number; updated_at: number; updated_by: string };
type VersionRow = { package_id: string; version: string; manifest: string; files: string; fingerprint: string; status: string; test: string | null; created_at: number; created_by: string; published_at: number | null };
type ModelRow = { id: string; name: string; keyword: string; summary: string; entry: string; on_event: string; runtime: string; inputs: string; outputs: string; limits: string; executors: string; groups: string; enabled: number; revision: number; created_at: number; updated_at: number; updated_by: string };
type RunRow = { id: string; model_id: string; entry: string; lang: string; executor: string; caller: string; session_id: string; parent: string | null; status: string; inputs: string; outputs: string; error: string | null; test: number; queued_at: number; started_at: number | null; finished_at: number | null; ms: number; mem_mb: number };

function toPackage(r: PackageRow): Package {
  return { id: r.id, name: r.name, language: r.language as Package["language"], description: r.description, draft: r.draft, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by };
}
function toVersion(r: VersionRow): PackageVersion {
  return { packageId: r.package_id, version: r.version, manifest: jsonParse(r.manifest, {} as PackageVersion["manifest"]), files: jsonParse(r.files, {}), fingerprint: r.fingerprint, status: r.status as PackageVersion["status"], test: jsonParse(r.test, null), createdAt: r.created_at, createdBy: r.created_by, publishedAt: r.published_at };
}
function toModel(r: ModelRow): Model {
  return { id: r.id, name: r.name, keyword: r.keyword, summary: r.summary, entry: r.entry, onEvent: r.on_event, runtime: r.runtime as Model["runtime"], inputs: jsonParse(r.inputs, []), outputs: jsonParse(r.outputs, []), limits: jsonParse(r.limits, {}), executors: jsonParse(r.executors, { chat: { enabled: false, visibility: "room" }, console: { enabled: true } }), groups: jsonParse(r.groups, []), enabled: Boolean(r.enabled), revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by };
}
function toRun(r: RunRow): Run {
  return { id: r.id, modelId: r.model_id, entry: r.entry, lang: r.lang as Run["lang"], executor: r.executor, caller: jsonParse(r.caller, {} as Caller), sessionId: r.session_id, parent: r.parent, status: r.status as RunStatus, inputs: jsonParse(r.inputs, {}), outputs: jsonParse(r.outputs, []), error: jsonParse(r.error, null), test: Boolean(r.test), queuedAt: r.queued_at, startedAt: r.started_at, finishedAt: r.finished_at, ms: r.ms, memMb: r.mem_mb };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, language TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  draft TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS package_versions (
  package_id TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT NOT NULL, files TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL, test TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT '', published_at INTEGER,
  PRIMARY KEY (package_id, version));
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, keyword TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  entry TEXT NOT NULL, on_event TEXT NOT NULL DEFAULT '', runtime TEXT NOT NULL DEFAULT 'auto',
  inputs TEXT NOT NULL DEFAULT '[]', outputs TEXT NOT NULL DEFAULT '[]', limits TEXT NOT NULL DEFAULT '{}',
  executors TEXT NOT NULL DEFAULT '{}', groups TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS models_keyword ON models(keyword);
CREATE TABLE IF NOT EXISTS model_revisions (
  model_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (model_id, revision));
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL DEFAULT '', entry TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'js',
  executor TEXT NOT NULL, caller TEXT NOT NULL DEFAULT '{}', session_id TEXT NOT NULL DEFAULT '', parent TEXT,
  status TEXT NOT NULL, inputs TEXT NOT NULL DEFAULT '{}', outputs TEXT NOT NULL DEFAULT '[]', error TEXT,
  test INTEGER NOT NULL DEFAULT 0, queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  ms INTEGER NOT NULL DEFAULT 0, mem_mb INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS runs_model_ts ON runs(model_id, queued_at);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status, queued_at);
CREATE TABLE IF NOT EXISTS run_logs (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL, fields TEXT,
  PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, scope_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER);
CREATE INDEX IF NOT EXISTS sessions_scope ON sessions(scope_key);
CREATE TABLE IF NOT EXISTS session_kv (
  session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (session_id, key));
CREATE TABLE IF NOT EXISTS cache_kv (
  scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, lock_token TEXT, PRIMARY KEY (scope, key));
`;

/* ---------------------------------------------------------- the store */

class FunctionsStore {
  private db: SqliteDatabase | null = null;
  private opening: Promise<void> | null = null;
  private reason = "";
  private mem = new MemoryStore();

  ready(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.opening ??= (async () => {
      const Driver = await loadSqliteDriver();
      if (!Driver) { this.reason = "the SQLite driver is not installed — functions are kept in memory only"; return; }
      const file = functionsDbPath();
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
        try { chmodSync(file, 0o600); } catch { /* not ours */ }
        const db = new Driver(file, { timeout: 5000 });
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.pragma("foreign_keys = ON");
        db.exec(SCHEMA);
        this.db = db;
        this.reason = "";
      } catch (err) {
        this.reason = `cannot open ${file}: ${(err as Error).message} — functions are kept in memory only`;
      }
    })();
    return this.opening;
  }

  status(): { persistent: boolean; file: string; reason: string } {
    return { persistent: Boolean(this.db), file: functionsDbPath(), reason: this.reason };
  }

  private get d(): SqliteDatabase | null { return this.db; }

  /* -------- packages -------- */

  packages(): Package[] {
    if (!this.d) return this.mem.packages();
    return (this.d.prepare("SELECT * FROM packages ORDER BY name").all() as PackageRow[]).map(toPackage);
  }
  package(id: string): Package | null {
    if (!this.d) return this.mem.package(id);
    const r = this.d.prepare("SELECT * FROM packages WHERE id = ?").get(id) as PackageRow | undefined;
    return r ? toPackage(r) : null;
  }
  packageByName(name: string): Package | null {
    if (!this.d) return this.mem.packageByName(name);
    const r = this.d.prepare("SELECT * FROM packages WHERE name = ?").get(name) as PackageRow | undefined;
    return r ? toPackage(r) : null;
  }
  savePackage(p: Package): void {
    if (!this.d) return this.mem.savePackage(p);
    this.d.prepare(`INSERT INTO packages (id, name, language, description, draft, created_at, updated_at, updated_by)
      VALUES (@id, @name, @language, @description, @draft, @createdAt, @updatedAt, @updatedBy)
      ON CONFLICT(id) DO UPDATE SET name=@name, language=@language, description=@description, draft=@draft, updated_at=@updatedAt, updated_by=@updatedBy`)
      .run({ ...p });
  }
  deletePackage(id: string): void {
    if (!this.d) return this.mem.deletePackage(id);
    this.d.prepare("DELETE FROM package_versions WHERE package_id = ?").run(id);
    this.d.prepare("DELETE FROM packages WHERE id = ?").run(id);
  }

  /* -------- versions -------- */

  versions(packageId: string): PackageVersion[] {
    if (!this.d) return this.mem.versions(packageId);
    return (this.d.prepare("SELECT * FROM package_versions WHERE package_id = ? ORDER BY created_at DESC").all(packageId) as VersionRow[]).map(toVersion);
  }
  version(packageId: string, version: string): PackageVersion | null {
    if (!this.d) return this.mem.version(packageId, version);
    const r = this.d.prepare("SELECT * FROM package_versions WHERE package_id = ? AND version = ?").get(packageId, version) as VersionRow | undefined;
    return r ? toVersion(r) : null;
  }
  /** Looks a package version up by name (what an entry / import refers to). */
  versionByName(name: string, version: string): PackageVersion | null {
    const pkg = this.packageByName(name);
    return pkg ? this.version(pkg.id, version) : null;
  }
  saveVersion(v: PackageVersion): void {
    if (!this.d) return this.mem.saveVersion(v);
    this.d.prepare(`INSERT INTO package_versions (package_id, version, manifest, files, fingerprint, status, test, created_at, created_by, published_at)
      VALUES (@package_id, @version, @manifest, @files, @fingerprint, @status, @test, @created_at, @created_by, @published_at)
      ON CONFLICT(package_id, version) DO UPDATE SET manifest=@manifest, files=@files, fingerprint=@fingerprint, status=@status, test=@test, published_at=@published_at`)
      .run({ package_id: v.packageId, version: v.version, manifest: JSON.stringify(v.manifest), files: JSON.stringify(v.files), fingerprint: v.fingerprint, status: v.status, test: v.test ? JSON.stringify(v.test) : null, created_at: v.createdAt, created_by: v.createdBy, published_at: v.publishedAt });
  }
  deleteVersion(packageId: string, version: string): void {
    if (!this.d) return this.mem.deleteVersion(packageId, version);
    this.d.prepare("DELETE FROM package_versions WHERE package_id = ? AND version = ?").run(packageId, version);
  }

  /* -------- models -------- */

  models(): Model[] {
    if (!this.d) return this.mem.models();
    return (this.d.prepare("SELECT * FROM models ORDER BY name").all() as ModelRow[]).map(toModel);
  }
  model(id: string): Model | null {
    if (!this.d) return this.mem.model(id);
    const r = this.d.prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | undefined;
    return r ? toModel(r) : null;
  }
  modelByKeyword(keyword: string): Model | null {
    if (!this.d) return this.mem.modelByKeyword(keyword);
    const r = this.d.prepare("SELECT * FROM models WHERE keyword = ? AND enabled = 1").get(keyword) as ModelRow | undefined;
    return r ? toModel(r) : null;
  }
  saveModel(m: Model): void {
    if (!this.d) return this.mem.saveModel(m);
    this.d.prepare(`INSERT INTO models (id, name, keyword, summary, entry, on_event, runtime, inputs, outputs, limits, executors, groups, enabled, revision, created_at, updated_at, updated_by)
      VALUES (@id, @name, @keyword, @summary, @entry, @on_event, @runtime, @inputs, @outputs, @limits, @executors, @groups, @enabled, @revision, @created_at, @updated_at, @updated_by)
      ON CONFLICT(id) DO UPDATE SET name=@name, keyword=@keyword, summary=@summary, entry=@entry, on_event=@on_event, runtime=@runtime, inputs=@inputs, outputs=@outputs, limits=@limits, executors=@executors, groups=@groups, enabled=@enabled, revision=@revision, updated_at=@updated_at, updated_by=@updated_by`)
      .run({ id: m.id, name: m.name, keyword: m.keyword, summary: m.summary, entry: m.entry, on_event: m.onEvent, runtime: m.runtime, inputs: JSON.stringify(m.inputs), outputs: JSON.stringify(m.outputs), limits: JSON.stringify(m.limits), executors: JSON.stringify(m.executors), groups: JSON.stringify(m.groups), enabled: m.enabled ? 1 : 0, revision: m.revision, created_at: m.createdAt, updated_at: m.updatedAt, updated_by: m.updatedBy });
    this.d.prepare("INSERT OR REPLACE INTO model_revisions (model_id, revision, snapshot, created_at, created_by) VALUES (?, ?, ?, ?, ?)").run(m.id, m.revision, JSON.stringify(m), m.updatedAt, m.updatedBy);
  }
  deleteModel(id: string): void {
    if (!this.d) return this.mem.deleteModel(id);
    this.d.prepare("DELETE FROM models WHERE id = ?").run(id);
  }

  /* -------- runs -------- */

  saveRun(r: Run): void {
    if (!this.d) return this.mem.saveRun(r);
    this.d.prepare(`INSERT INTO runs (id, model_id, entry, lang, executor, caller, session_id, parent, status, inputs, outputs, error, test, queued_at, started_at, finished_at, ms, mem_mb)
      VALUES (@id, @model_id, @entry, @lang, @executor, @caller, @session_id, @parent, @status, @inputs, @outputs, @error, @test, @queued_at, @started_at, @finished_at, @ms, @mem_mb)
      ON CONFLICT(id) DO UPDATE SET status=@status, outputs=@outputs, error=@error, started_at=@started_at, finished_at=@finished_at, ms=@ms, mem_mb=@mem_mb`)
      .run({ id: r.id, model_id: r.modelId, entry: r.entry, lang: r.lang, executor: r.executor, caller: JSON.stringify(r.caller), session_id: r.sessionId, parent: r.parent, status: r.status, inputs: JSON.stringify(r.inputs), outputs: JSON.stringify(r.outputs), error: r.error ? JSON.stringify(r.error) : null, test: r.test ? 1 : 0, queued_at: r.queuedAt, started_at: r.startedAt, finished_at: r.finishedAt, ms: r.ms, mem_mb: r.memMb });
  }
  run(id: string): Run | null {
    if (!this.d) return this.mem.run(id);
    const r = this.d.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return r ? toRun(r) : null;
  }
  runs(query: { modelId?: string; status?: RunStatus; limit?: number; before?: number } = {}): Run[] {
    if (!this.d) return this.mem.runs(query);
    const where: string[] = []; const args: unknown[] = [];
    if (query.modelId) { where.push("model_id = ?"); args.push(query.modelId); }
    if (query.status) { where.push("status = ?"); args.push(query.status); }
    if (query.before) { where.push("queued_at < ?"); args.push(query.before); }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY queued_at DESC LIMIT ?`;
    return (this.d.prepare(sql).all(...args, Math.max(1, Math.min(500, query.limit ?? 100))) as RunRow[]).map(toRun);
  }

  addLogs(logs: RunLog[]): void {
    if (!logs.length) return;
    if (!this.d) return this.mem.addLogs(logs);
    const stmt = this.d.prepare("INSERT OR IGNORE INTO run_logs (run_id, seq, ts, level, msg, fields) VALUES (?, ?, ?, ?, ?, ?)");
    const tx = this.d.transaction((rows: RunLog[]) => { for (const l of rows) stmt.run(l.runId, l.seq, l.ts, l.level, l.msg, l.fields ? JSON.stringify(l.fields) : null); });
    tx(logs);
  }
  logs(runId: string, afterSeq = -1): RunLog[] {
    if (!this.d) return this.mem.logs(runId, afterSeq);
    return (this.d.prepare("SELECT * FROM run_logs WHERE run_id = ? AND seq > ? ORDER BY seq").all(runId, afterSeq) as Array<{ run_id: string; seq: number; ts: number; level: string; msg: string; fields: string | null }>)
      .map((r) => ({ runId: r.run_id, seq: r.seq, ts: r.ts, level: r.level as RunLog["level"], msg: r.msg, fields: jsonParse(r.fields, null) }));
  }

  /* -------- sessions & cache -------- */

  session(modelId: string, scopeKey: string): string {
    const now = Date.now();
    if (!this.d) return this.mem.session(modelId, scopeKey, now);
    const found = this.d.prepare("SELECT id FROM sessions WHERE scope_key = ? AND (expires_at IS NULL OR expires_at > ?)").get(scopeKey, now) as { id: string } | undefined;
    if (found) return found.id;
    const id = newId("ses");
    this.d.prepare("INSERT INTO sessions (id, model_id, scope_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, modelId, scopeKey, now, null);
    return id;
  }
  sessionGet(sessionId: string, key: string): unknown {
    const now = Date.now();
    if (!this.d) return this.mem.sessionGet(sessionId, key, now);
    const r = this.d.prepare("SELECT value, expires_at FROM session_kv WHERE session_id = ? AND key = ?").get(sessionId, key) as { value: string; expires_at: number | null } | undefined;
    if (!r || (r.expires_at !== null && r.expires_at <= now)) return null;
    return jsonParse(r.value, null);
  }
  sessionSet(sessionId: string, key: string, value: unknown, ttlMs: number | null): void {
    if (!this.d) return this.mem.sessionSet(sessionId, key, value, ttlMs);
    const expires = ttlMs ? Date.now() + ttlMs : null;
    this.d.prepare("INSERT OR REPLACE INTO session_kv (session_id, key, value, expires_at) VALUES (?, ?, ?, ?)").run(sessionId, key, JSON.stringify(value ?? null), expires);
  }
  sessionDelete(sessionId: string, key: string): void {
    if (!this.d) return this.mem.sessionDelete(sessionId, key);
    this.d.prepare("DELETE FROM session_kv WHERE session_id = ? AND key = ?").run(sessionId, key);
  }
  sessionKeys(sessionId: string): string[] {
    const now = Date.now();
    if (!this.d) return this.mem.sessionKeys(sessionId, now);
    return (this.d.prepare("SELECT key FROM session_kv WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)").all(sessionId, now) as Array<{ key: string }>).map((r) => r.key);
  }

  cacheGet(scope: string, key: string): unknown {
    const now = Date.now();
    if (!this.d) return this.mem.cacheGet(scope, key, now);
    const r = this.d.prepare("SELECT value, expires_at FROM cache_kv WHERE scope = ? AND key = ?").get(scope, key) as { value: string; expires_at: number | null } | undefined;
    if (!r || (r.expires_at !== null && r.expires_at <= now)) return null;
    return jsonParse(r.value, null);
  }
  cacheSet(scope: string, key: string, value: unknown, ttlMs: number | null): void {
    if (!this.d) return this.mem.cacheSet(scope, key, value, ttlMs);
    const expires = ttlMs ? Date.now() + ttlMs : null;
    this.d.prepare("INSERT OR REPLACE INTO cache_kv (scope, key, value, expires_at, lock_token) VALUES (?, ?, ?, ?, NULL)").run(scope, key, JSON.stringify(value ?? null), expires);
  }
  cacheIncr(scope: string, key: string, by: number, ttlMs: number | null): number {
    const cur = this.cacheGet(scope, key);
    const next = (typeof cur === "number" ? cur : 0) + by;
    this.cacheSet(scope, key, next, ttlMs);
    return next;
  }
  cacheDelete(scope: string, key: string): void {
    if (!this.d) return this.mem.cacheDelete(scope, key);
    this.d.prepare("DELETE FROM cache_kv WHERE scope = ?  AND key = ?").run(scope, key);
  }

  /** Removes expired session and cache values, and runs older than the cutoff. */
  prune(runCutoff: number, now = Date.now()): void {
    if (!this.d) return this.mem.prune(runCutoff, now);
    this.d.prepare("DELETE FROM session_kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    this.d.prepare("DELETE FROM cache_kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    this.d.prepare("DELETE FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?)").run(runCutoff);
    this.d.prepare("DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?").run(runCutoff);
  }
}

/* --------------------------------------------------- memory fallback */

class MemoryStore {
  private pkgs = new Map<string, Package>();
  private vers = new Map<string, PackageVersion>();
  private mods = new Map<string, Model>();
  private rns = new Map<string, Run>();
  private lgs = new Map<string, RunLog[]>();
  private sess = new Map<string, { id: string; modelId: string; scopeKey: string; expires: number | null }>();
  private skv = new Map<string, { value: unknown; expires: number | null }>();
  private ckv = new Map<string, { value: unknown; expires: number | null }>();
  private vkey = (p: string, v: string) => `${p}\0${v}`;

  packages(): Package[] { return [...this.pkgs.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  package(id: string): Package | null { return this.pkgs.get(id) ?? null; }
  packageByName(name: string): Package | null { return [...this.pkgs.values()].find((p) => p.name === name) ?? null; }
  savePackage(p: Package): void { this.pkgs.set(p.id, { ...p }); }
  deletePackage(id: string): void { this.pkgs.delete(id); for (const k of [...this.vers.keys()]) if (k.startsWith(`${id}\0`)) this.vers.delete(k); }

  versions(packageId: string): PackageVersion[] { return [...this.vers.values()].filter((v) => v.packageId === packageId).sort((a, b) => b.createdAt - a.createdAt); }
  version(packageId: string, version: string): PackageVersion | null { return this.vers.get(this.vkey(packageId, version)) ?? null; }
  saveVersion(v: PackageVersion): void { this.vers.set(this.vkey(v.packageId, v.version), structuredClone(v)); }
  deleteVersion(packageId: string, version: string): void { this.vers.delete(this.vkey(packageId, version)); }

  models(): Model[] { return [...this.mods.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  model(id: string): Model | null { return this.mods.get(id) ?? null; }
  modelByKeyword(keyword: string): Model | null { return [...this.mods.values()].find((m) => m.keyword === keyword && m.enabled) ?? null; }
  saveModel(m: Model): void { this.mods.set(m.id, structuredClone(m)); }
  deleteModel(id: string): void { this.mods.delete(id); }

  saveRun(r: Run): void { this.rns.set(r.id, structuredClone(r)); }
  run(id: string): Run | null { return this.rns.get(id) ?? null; }
  runs(query: { modelId?: string; status?: RunStatus; limit?: number; before?: number }): Run[] {
    let list = [...this.rns.values()];
    if (query.modelId) list = list.filter((r) => r.modelId === query.modelId);
    if (query.status) list = list.filter((r) => r.status === query.status);
    if (query.before) list = list.filter((r) => r.queuedAt < query.before!);
    return list.sort((a, b) => b.queuedAt - a.queuedAt).slice(0, Math.max(1, Math.min(500, query.limit ?? 100)));
  }
  addLogs(logs: RunLog[]): void { for (const l of logs) { const arr = this.lgs.get(l.runId) ?? []; arr.push(l); this.lgs.set(l.runId, arr); } }
  logs(runId: string, afterSeq: number): RunLog[] { return (this.lgs.get(runId) ?? []).filter((l) => l.seq > afterSeq).sort((a, b) => a.seq - b.seq); }

  session(modelId: string, scopeKey: string, now: number): string {
    for (const s of this.sess.values()) if (s.scopeKey === scopeKey && (s.expires === null || s.expires > now)) return s.id;
    const id = newId("ses"); this.sess.set(id, { id, modelId, scopeKey, expires: null }); return id;
  }
  sessionGet(sessionId: string, key: string, now: number): unknown { const r = this.skv.get(`${sessionId}\0${key}`); return r && (r.expires === null || r.expires > now) ? r.value : null; }
  sessionSet(sessionId: string, key: string, value: unknown, ttlMs: number | null): void { this.skv.set(`${sessionId}\0${key}`, { value: value ?? null, expires: ttlMs ? Date.now() + ttlMs : null }); }
  sessionDelete(sessionId: string, key: string): void { this.skv.delete(`${sessionId}\0${key}`); }
  sessionKeys(sessionId: string, now: number): string[] { const out: string[] = []; for (const [k, v] of this.skv) { const [sid, key] = k.split("\0"); if (sid === sessionId && (v.expires === null || v.expires > now)) out.push(key); } return out; }

  cacheGet(scope: string, key: string, now: number): unknown { const r = this.ckv.get(`${scope}\0${key}`); return r && (r.expires === null || r.expires > now) ? r.value : null; }
  cacheSet(scope: string, key: string, value: unknown, ttlMs: number | null): void { this.ckv.set(`${scope}\0${key}`, { value: value ?? null, expires: ttlMs ? Date.now() + ttlMs : null }); }
  cacheDelete(scope: string, key: string): void { this.ckv.delete(`${scope}\0${key}`); }

  prune(runCutoff: number, now: number): void {
    for (const [k, v] of this.skv) if (v.expires !== null && v.expires <= now) this.skv.delete(k);
    for (const [k, v] of this.ckv) if (v.expires !== null && v.expires <= now) this.ckv.delete(k);
    for (const [id, r] of this.rns) if (r.finishedAt !== null && r.finishedAt < runCutoff) { this.rns.delete(id); this.lgs.delete(id); }
  }
}

export const functionsStore = new FunctionsStore();
