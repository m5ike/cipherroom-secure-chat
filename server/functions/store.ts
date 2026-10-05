// The Functions store (4.15): packages and their versions, models, runs and
// their logs, sessions with a key–value store, and a shared cache — in
// $DATA_DIR/functions/functions.db (SQLite, WAL; the app and the runner both
// use it). FUNCTIONS_DB_FILE moves it. 6.12 (F-18): the file is SQLCipher,
// keyed from the storage master key (storage/service-db.ts).
//
// Without the SQLite driver (an install that could not build it) the store
// lives in memory: everything works within one run of the process but does
// not survive a restart, and the console says so.

import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { SqliteDatabase } from "../storage/db";
import { openServiceDatabase, serviceDbStates } from "../storage/service-db";
import type {
  Caller, Chain, DurableWebhook, FileMap, Model, Package, PackageVersion, Run, RunLog, RunStatus, Schedule, WebhookCall,
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
type ModelRow = { id: string; name: string; keyword: string; summary: string; entry: string; on_event: string; runtime: string; inputs: string; outputs: string; limits: string; executors: string; groups: string; enabled: number; revision: number; created_at: number; updated_at: number; updated_by: string; endpoints?: string; grants?: string; icon?: string; usage?: string };
type RunRow = { id: string; model_id: string; entry: string; lang: string; executor: string; caller: string; session_id: string; parent: string | null; status: string; inputs: string; outputs: string; error: string | null; test: number; queued_at: number; started_at: number | null; finished_at: number | null; ms: number; mem_mb: number; chain_id?: string; call_id?: number | null; endpoint?: string; sensitive?: number };

function toPackage(r: PackageRow): Package {
  return { id: r.id, name: r.name, language: r.language as Package["language"], description: r.description, draft: r.draft, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by };
}
function toVersion(r: VersionRow): PackageVersion {
  return { packageId: r.package_id, version: r.version, manifest: jsonParse(r.manifest, {} as PackageVersion["manifest"]), files: jsonParse(r.files, {}), fingerprint: r.fingerprint, status: r.status as PackageVersion["status"], test: jsonParse(r.test, null), createdAt: r.created_at, createdBy: r.created_by, publishedAt: r.published_at };
}
function toModel(r: ModelRow): Model {
  return { id: r.id, name: r.name, keyword: r.keyword, summary: r.summary, entry: r.entry, onEvent: r.on_event, runtime: r.runtime as Model["runtime"], inputs: jsonParse(r.inputs, []), outputs: jsonParse(r.outputs, []), limits: jsonParse(r.limits, {}), executors: jsonParse(r.executors, { chat: { enabled: false, visibility: "room" }, console: { enabled: true } }), groups: jsonParse(r.groups, []), enabled: Boolean(r.enabled), revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by, endpoints: jsonParse(r.endpoints, []), ...(r.grants && r.grants !== "{}" ? { grants: jsonParse(r.grants, {}) } : {}), icon: r.icon ?? "", usage: r.usage ?? "" };
}
function toRun(r: RunRow): Run {
  return { id: r.id, modelId: r.model_id, entry: r.entry, lang: r.lang as Run["lang"], executor: r.executor, caller: jsonParse(r.caller, {} as Caller), sessionId: r.session_id, parent: r.parent, status: r.status as RunStatus, inputs: jsonParse(r.inputs, {}), outputs: jsonParse(r.outputs, []), error: jsonParse(r.error, null), test: Boolean(r.test), queuedAt: r.queued_at, startedAt: r.started_at, finishedAt: r.finished_at, ms: r.ms, memMb: r.mem_mb,
    ...(r.chain_id ? { chainId: r.chain_id } : {}), ...(typeof r.call_id === "number" ? { callId: r.call_id } : {}), ...(r.endpoint ? { endpoint: r.endpoint as Run["endpoint"] } : {}), ...(r.sensitive ? { sensitive: true } : {}) };
}
function toChain(r: Record<string, unknown>): Chain {
  const opener = typeof r.opener === "string" && r.opener ? jsonParse<Chain["opener"] | null>(r.opener, null) : null;
  return { id: String(r.id), modelId: String(r.model_id), sessionId: String(r.session_id), source: jsonParse(r.source, { kind: "model" } as Chain["source"]), calls: jsonParse(r.calls, []), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), ...(opener ? { opener } : {}) };
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
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '',
  endpoints TEXT NOT NULL DEFAULT '[]', icon TEXT NOT NULL DEFAULT '', usage TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS models_keyword ON models(keyword);
CREATE TABLE IF NOT EXISTS model_revisions (
  model_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (model_id, revision));
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL DEFAULT '', entry TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'js',
  executor TEXT NOT NULL, caller TEXT NOT NULL DEFAULT '{}', session_id TEXT NOT NULL DEFAULT '', parent TEXT,
  status TEXT NOT NULL, inputs TEXT NOT NULL DEFAULT '{}', outputs TEXT NOT NULL DEFAULT '[]', error TEXT,
  test INTEGER NOT NULL DEFAULT 0, queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  ms INTEGER NOT NULL DEFAULT 0, mem_mb INTEGER NOT NULL DEFAULT 0,
  chain_id TEXT NOT NULL DEFAULT '', call_id INTEGER, endpoint TEXT NOT NULL DEFAULT '');
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
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, cron TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'UTC', inputs TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, last_run INTEGER, created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS webhook_calls (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', hook TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'POST', path TEXT NOT NULL DEFAULT '', query TEXT NOT NULL DEFAULT '{}', headers TEXT NOT NULL DEFAULT '{}',
  content_type TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', body_size INTEGER NOT NULL DEFAULT 0, parsed TEXT,
  ip TEXT NOT NULL DEFAULT '', status INTEGER NOT NULL DEFAULT 0, response_headers TEXT NOT NULL DEFAULT '{}', response_body TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '', ms INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', replay_of TEXT NOT NULL DEFAULT '', result TEXT);
CREATE INDEX IF NOT EXISTS webhook_calls_model ON webhook_calls(model_id, at);
CREATE INDEX IF NOT EXISTS webhook_calls_at ON webhook_calls(at);
CREATE TABLE IF NOT EXISTS webhooks (
  token TEXT PRIMARY KEY, model_id TEXT NOT NULL, session_id TEXT NOT NULL, caller TEXT NOT NULL DEFAULT '{}', entry TEXT NOT NULL,
  once INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS model_chains (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, session_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT '{"kind":"model"}',
  calls TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, opener TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS model_chains_updated ON model_chains(updated_at);
`;

/** Columns later versions added to tables an older database already has. */
const MIGRATIONS: Array<[table: string, column: string, definition: string]> = [
  ["models", "endpoints", "TEXT NOT NULL DEFAULT '[]'"],
  // 6.0: m5adm and m5.telephony beyond the caller (ModelGrants).
  ["models", "grants", "TEXT NOT NULL DEFAULT '{}'"],
  ["runs", "chain_id", "TEXT NOT NULL DEFAULT ''"],
  ["runs", "call_id", "INTEGER"],
  ["runs", "endpoint", "TEXT NOT NULL DEFAULT ''"],
  // 6.7: who opened a processing session and the room it was shared to (chain-access.ts).
  ["model_chains", "opener", "TEXT NOT NULL DEFAULT ''"],
  // 6.7 (F-18): a run that read a card is pruned after FUNCTIONS_NFC_RUN_HOURS.
  ["runs", "sensitive", "INTEGER NOT NULL DEFAULT 0"],
  // 6.11: a model's icon (its avatar as the sender of its answers) and its usage guide.
  ["models", "icon", "TEXT NOT NULL DEFAULT ''"],
  ["models", "usage", "TEXT NOT NULL DEFAULT ''"],
];

/** How long a run that read a card (m5.nfc) is kept: FUNCTIONS_NFC_RUN_HOURS, default 24. */
export const nfcRunKeepMs = () => Math.max(1, Number(process.env.FUNCTIONS_NFC_RUN_HOURS) || 24) * 3_600_000;

/* ------------------------------------------------ key–value limits (6.7) */

/** 6.7 (audit N16): m5.session / m5.cache had no limit on a value's size or
 *  the number of keys — one model could fill the disk. Per scope (a session,
 *  a cache scope): */
export const KV_LIMITS = { valueBytes: 1024 * 1024, keyChars: 512, keysPerScope: 10_000, bytesPerScope: 64 * 1024 * 1024 } as const;

export class KvLimitError extends Error {
  readonly code = "kv-limit";
  constructor(message: string) { super(message); this.name = "KvLimitError"; }
}

/** Refuses a write that would break KV_LIMITS; `scope` is what the caller sees. */
function checkKv(key: string, json: string, scope: { exists: boolean; oldBytes: number; keys: number; bytes: number }): void {
  if (key.length > KV_LIMITS.keyChars) throw new KvLimitError(`a key is at most ${KV_LIMITS.keyChars} characters`);
  const size = Buffer.byteLength(json);
  if (size > KV_LIMITS.valueBytes) throw new KvLimitError(`a stored value is at most ${KV_LIMITS.valueBytes} bytes as JSON (this one is ${size})`);
  if (!scope.exists && scope.keys >= KV_LIMITS.keysPerScope) throw new KvLimitError(`a session or cache scope holds at most ${KV_LIMITS.keysPerScope} keys`);
  if (scope.bytes - scope.oldBytes + size > KV_LIMITS.bytesPerScope) throw new KvLimitError(`a session or cache scope holds at most ${KV_LIMITS.bytesPerScope} bytes`);
}

/* ---------------------------------------------------------- the store */

class FunctionsStore {
  private db: SqliteDatabase | null = null;
  private opening: Promise<void> | null = null;
  private reason = "";
  private mem = new MemoryStore();

  ready(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.opening ??= (async () => {
      const file = functionsDbPath();
      try {
        // 6.12 (F-18): SQLCipher under a subkey of the storage master key; a
        // plain functions.db from before is converted on the first start.
        const db = await openServiceDatabase(file, "functions");
        if (!db) { this.reason = "the SQLite driver is not installed — functions are kept in memory only"; return; }
        db.pragma("foreign_keys = ON");
        db.exec(SCHEMA);
        for (const [table, column, definition] of MIGRATIONS) {
          const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
          if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
        this.db = db;
        this.reason = "";
      } catch (err) {
        this.reason = `cannot open ${file}: ${(err as Error).message} — functions are kept in memory only`;
      }
    })();
    return this.opening;
  }

  status(): { persistent: boolean; file: string; reason: string; encrypted: boolean; warning: string } {
    const at = serviceDbStates().find((x) => x.label === "functions");
    return { persistent: Boolean(this.db), file: functionsDbPath(), reason: this.reason, encrypted: Boolean(this.db && at?.encrypted), warning: at?.warning ?? "" };
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
    this.d.prepare(`INSERT INTO models (id, name, keyword, summary, entry, on_event, runtime, inputs, outputs, limits, executors, groups, enabled, revision, created_at, updated_at, updated_by, endpoints, grants, icon, usage)
      VALUES (@id, @name, @keyword, @summary, @entry, @on_event, @runtime, @inputs, @outputs, @limits, @executors, @groups, @enabled, @revision, @created_at, @updated_at, @updated_by, @endpoints, @grants, @icon, @usage)
      ON CONFLICT(id) DO UPDATE SET name=@name, keyword=@keyword, summary=@summary, entry=@entry, on_event=@on_event, runtime=@runtime, inputs=@inputs, outputs=@outputs, limits=@limits, executors=@executors, groups=@groups, enabled=@enabled, revision=@revision, updated_at=@updated_at, updated_by=@updated_by, endpoints=@endpoints, grants=@grants, icon=@icon, usage=@usage`)
      .run({ id: m.id, name: m.name, keyword: m.keyword, summary: m.summary, entry: m.entry, on_event: m.onEvent, runtime: m.runtime, inputs: JSON.stringify(m.inputs), outputs: JSON.stringify(m.outputs), limits: JSON.stringify(m.limits), executors: JSON.stringify(m.executors), groups: JSON.stringify(m.groups), enabled: m.enabled ? 1 : 0, revision: m.revision, created_at: m.createdAt, updated_at: m.updatedAt, updated_by: m.updatedBy, endpoints: JSON.stringify(m.endpoints ?? []), grants: JSON.stringify(m.grants ?? {}), icon: m.icon ?? "", usage: m.usage ?? "" });
    this.d.prepare("INSERT OR REPLACE INTO model_revisions (model_id, revision, snapshot, created_at, created_by) VALUES (?, ?, ?, ?, ?)").run(m.id, m.revision, JSON.stringify(m), m.updatedAt, m.updatedBy);
  }
  deleteModel(id: string): void {
    if (!this.d) return this.mem.deleteModel(id);
    this.d.prepare("DELETE FROM models WHERE id = ?").run(id);
  }

  /* -------- runs -------- */

  saveRun(r: Run): void {
    if (!this.d) return this.mem.saveRun(r);
    this.d.prepare(`INSERT INTO runs (id, model_id, entry, lang, executor, caller, session_id, parent, status, inputs, outputs, error, test, queued_at, started_at, finished_at, ms, mem_mb, chain_id, call_id, endpoint, sensitive)
      VALUES (@id, @model_id, @entry, @lang, @executor, @caller, @session_id, @parent, @status, @inputs, @outputs, @error, @test, @queued_at, @started_at, @finished_at, @ms, @mem_mb, @chain_id, @call_id, @endpoint, @sensitive)
      ON CONFLICT(id) DO UPDATE SET status=@status, outputs=@outputs, error=@error, started_at=@started_at, finished_at=@finished_at, ms=@ms, mem_mb=@mem_mb, sensitive=MAX(sensitive, @sensitive)`)
      .run({ id: r.id, model_id: r.modelId, entry: r.entry, lang: r.lang, executor: r.executor, caller: JSON.stringify(r.caller), session_id: r.sessionId, parent: r.parent, status: r.status, inputs: JSON.stringify(r.inputs), outputs: JSON.stringify(r.outputs), error: r.error ? JSON.stringify(r.error) : null, test: r.test ? 1 : 0, queued_at: r.queuedAt, started_at: r.startedAt, finished_at: r.finishedAt, ms: r.ms, mem_mb: r.memMb, chain_id: r.chainId ?? "", call_id: r.callId ?? null, endpoint: r.endpoint ?? "", sensitive: r.sensitive ? 1 : 0 });
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
    const now = Date.now();
    const expires = ttlMs ? now + ttlMs : null;
    const json = JSON.stringify(value ?? null);
    const old = this.d.prepare("SELECT length(CAST(value AS BLOB)) AS n FROM session_kv WHERE session_id = ? AND key = ?").get(sessionId, key) as { n: number } | undefined;
    const all = this.d.prepare("SELECT count(*) AS c, COALESCE(sum(length(CAST(value AS BLOB))), 0) AS b FROM session_kv WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)").get(sessionId, now) as { c: number; b: number };
    checkKv(key, json, { exists: Boolean(old), oldBytes: old?.n ?? 0, keys: all.c, bytes: all.b });
    this.d.prepare("INSERT OR REPLACE INTO session_kv (session_id, key, value, expires_at) VALUES (?, ?, ?, ?)").run(sessionId, key, json, expires);
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
    const now = Date.now();
    const expires = ttlMs ? now + ttlMs : null;
    const json = JSON.stringify(value ?? null);
    const old = this.d.prepare("SELECT length(CAST(value AS BLOB)) AS n FROM cache_kv WHERE scope = ? AND key = ?").get(scope, key) as { n: number } | undefined;
    const all = this.d.prepare("SELECT count(*) AS c, COALESCE(sum(length(CAST(value AS BLOB))), 0) AS b FROM cache_kv WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?)").get(scope, now) as { c: number; b: number };
    checkKv(key, json, { exists: Boolean(old), oldBytes: old?.n ?? 0, keys: all.c, bytes: all.b });
    this.d.prepare("INSERT OR REPLACE INTO cache_kv (scope, key, value, expires_at, lock_token) VALUES (?, ?, ?, ?, NULL)").run(scope, key, json, expires);
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

  /* -------- schedules -------- */

  schedules(): Schedule[] {
    if (!this.d) return this.mem.schedules();
    return (this.d.prepare("SELECT * FROM schedules ORDER BY created_at").all() as Array<Record<string, unknown>>).map(toSchedule);
  }
  schedule(id: string): Schedule | null {
    if (!this.d) return this.mem.schedule(id);
    const r = this.d.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toSchedule(r) : null;
  }
  saveSchedule(s: Schedule): void {
    if (!this.d) return this.mem.saveSchedule(s);
    this.d.prepare(`INSERT INTO schedules (id, model_id, cron, tz, inputs, enabled, last_run, created_at, created_by)
      VALUES (@id, @model_id, @cron, @tz, @inputs, @enabled, @last_run, @created_at, @created_by)
      ON CONFLICT(id) DO UPDATE SET model_id=@model_id, cron=@cron, tz=@tz, inputs=@inputs, enabled=@enabled, last_run=@last_run`)
      .run({ id: s.id, model_id: s.modelId, cron: s.cron, tz: s.tz, inputs: JSON.stringify(s.inputs), enabled: s.enabled ? 1 : 0, last_run: s.lastRun, created_at: s.createdAt, created_by: s.createdBy });
  }
  deleteSchedule(id: string): void {
    if (!this.d) return this.mem.deleteSchedule(id);
    this.d.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  /* -------- durable webhooks -------- */

  saveWebhook(w: DurableWebhook): void {
    if (!this.d) return this.mem.saveWebhook(w);
    this.d.prepare(`INSERT OR REPLACE INTO webhooks (token, model_id, session_id, caller, entry, once, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(w.token, w.modelId, w.sessionId, JSON.stringify(w.caller), w.entry, w.once ? 1 : 0, w.expiresAt, w.createdAt);
  }
  webhook(token: string): DurableWebhook | null {
    const now = Date.now();
    if (!this.d) return this.mem.webhook(token, now);
    const r = this.d.prepare("SELECT * FROM webhooks WHERE token = ?").get(token) as Record<string, unknown> | undefined;
    if (!r) return null;
    if (r.expires_at !== null && (r.expires_at as number) <= now) { this.deleteWebhook(token); return null; }
    return toWebhook(r);
  }
  deleteWebhook(token: string): void {
    if (!this.d) return this.mem.deleteWebhook(token);
    this.d.prepare("DELETE FROM webhooks WHERE token = ?").run(token);
  }

  /** Durable webhooks (for the console's list; tokens masked there). */
  durableWebhooks(): DurableWebhook[] {
    const now = Date.now();
    if (!this.d) return this.mem.durableWebhooks(now);
    return (this.d.prepare("SELECT * FROM webhooks WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC LIMIT 500").all(now) as Array<Record<string, unknown>>).map(toWebhook);
  }

  /* -------- the webhook log (5.2) -------- */

  addWebhookCall(c: WebhookCall): void {
    if (!this.d) return this.mem.addWebhookCall(c);
    this.d.prepare(`INSERT OR REPLACE INTO webhook_calls (id, at, kind, model_id, hook, method, path, query, headers, content_type, body, body_size, parsed, ip, status, response_headers, response_body, run_id, ms, error, replay_of, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.at, c.kind, c.modelId, c.hook, c.method, c.path, JSON.stringify(c.query), JSON.stringify(c.headers), c.contentType, c.body, c.bodySize, c.parsed ? JSON.stringify(c.parsed) : null, c.ip, c.status, JSON.stringify(c.responseHeaders), c.responseBody, c.runId, c.ms, c.error, c.replayOf, c.result ? JSON.stringify(c.result) : null);
  }
  webhookCall(id: string): WebhookCall | null {
    if (!this.d) return this.mem.webhookCall(id);
    const r = this.d.prepare("SELECT * FROM webhook_calls WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toWebhookCall(r) : null;
  }
  webhookCalls(q: { modelId?: string; kind?: string; status?: "ok" | "error"; limit?: number; before?: number } = {}): WebhookCall[] {
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    if (!this.d) return this.mem.webhookCalls(q, limit);
    const where: string[] = []; const args: unknown[] = [];
    if (q.modelId) { where.push("model_id = ?"); args.push(q.modelId); }
    if (q.kind) { where.push("kind = ?"); args.push(q.kind); }
    if (q.status === "ok") where.push("status BETWEEN 200 AND 299");
    if (q.status === "error") where.push("(status < 200 OR status >= 300)");
    if (q.before) { where.push("at < ?"); args.push(q.before); }
    const sql = `SELECT * FROM webhook_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ${limit}`;
    return (this.d.prepare(sql).all(...args) as Array<Record<string, unknown>>).map(toWebhookCall);
  }
  webhookStats(): Array<{ modelId: string; calls: number; errors: number; last: number }> {
    if (!this.d) return this.mem.webhookStats();
    return (this.d.prepare("SELECT model_id, COUNT(*) AS calls, SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS errors, MAX(at) AS last FROM webhook_calls GROUP BY model_id").all() as Array<Record<string, unknown>>)
      .map((r) => ({ modelId: String(r.model_id), calls: Number(r.calls), errors: Number(r.errors ?? 0), last: Number(r.last) }));
  }
  /** 5.3: calls per webhook (model × masked token) — a model may have several. */
  webhookHookStats(): Array<{ modelId: string; hook: string; calls: number; errors: number; last: number }> {
    if (!this.d) return this.mem.webhookHookStats();
    return (this.d.prepare("SELECT model_id, hook, COUNT(*) AS calls, SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS errors, MAX(at) AS last FROM webhook_calls GROUP BY model_id, hook").all() as Array<Record<string, unknown>>)
      .map((r) => ({ modelId: String(r.model_id), hook: String(r.hook), calls: Number(r.calls), errors: Number(r.errors ?? 0), last: Number(r.last) }));
  }
  deleteWebhookCalls(modelId?: string): number {
    if (!this.d) return this.mem.deleteWebhookCalls(modelId);
    const r = modelId ? this.d.prepare("DELETE FROM webhook_calls WHERE model_id = ?").run(modelId) : this.d.prepare("DELETE FROM webhook_calls").run();
    return Number((r as { changes?: number }).changes ?? 0);
  }

  /* -------- processing sessions (5.3: m5.model) -------- */

  chain(id: string): Chain | null {
    if (!this.d) return this.mem.chain(id);
    const r = this.d.prepare("SELECT * FROM model_chains WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toChain(r) : null;
  }
  saveChain(c: Chain): void {
    if (!this.d) return this.mem.saveChain(c);
    // The opener is written once, with the session: a later call never changes who it belongs to.
    this.d.prepare(`INSERT INTO model_chains (id, model_id, session_id, source, calls, created_at, updated_at, opener) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET calls=excluded.calls, updated_at=excluded.updated_at`).run(c.id, c.modelId, c.sessionId, JSON.stringify(c.source), JSON.stringify(c.calls), c.createdAt, c.updatedAt, c.opener ? JSON.stringify(c.opener) : "");
  }
  /** A model's recent processing sessions (the console). */
  chains(modelId: string, limit = 50): Chain[] {
    if (!this.d) return this.mem.chains(modelId, limit);
    return (this.d.prepare("SELECT * FROM model_chains WHERE model_id = ? ORDER BY updated_at DESC LIMIT ?").all(modelId, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>).map(toChain);
  }

  /** Removes expired session and cache values, and runs older than the cutoff. */
  prune(runCutoff: number, now = Date.now()): void {
    if (!this.d) return this.mem.prune(runCutoff, now);
    // Processing sessions idle since the cutoff go with their key–value store and cache.
    const old = this.d.prepare("SELECT id, session_id FROM model_chains WHERE updated_at < ?").all(runCutoff) as Array<{ id: string; session_id: string }>;
    for (const c of old) {
      this.d.prepare("DELETE FROM session_kv WHERE session_id = ?").run(c.session_id);
      this.d.prepare("DELETE FROM sessions WHERE id = ?").run(c.session_id);
      this.d.prepare("DELETE FROM cache_kv WHERE scope = ?").run(`chain:${c.id}`);
    }
    this.d.prepare("DELETE FROM model_chains WHERE updated_at < ?").run(runCutoff);
    this.d.prepare("DELETE FROM webhook_calls WHERE at < ?").run(runCutoff);
    this.d.prepare("DELETE FROM session_kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    this.d.prepare("DELETE FROM cache_kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    this.d.prepare("DELETE FROM webhooks WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    this.d.prepare("DELETE FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?)").run(runCutoff);
    this.d.prepare("DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?").run(runCutoff);
    // 6.7 (F-18): a run that read a card goes much sooner (its inputs, outputs and logs hold personal data).
    const nfcCutoff = Math.max(runCutoff, now - nfcRunKeepMs());
    this.d.prepare("DELETE FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE sensitive = 1 AND finished_at IS NOT NULL AND finished_at < ?)").run(nfcCutoff);
    this.d.prepare("DELETE FROM runs WHERE sensitive = 1 AND finished_at IS NOT NULL AND finished_at < ?").run(nfcCutoff);
  }
}

function toSchedule(r: Record<string, unknown>): Schedule {
  return { id: String(r.id), modelId: String(r.model_id), cron: String(r.cron), tz: String(r.tz || "UTC"), inputs: jsonParse(r.inputs, {}), enabled: Boolean(r.enabled), lastRun: (r.last_run as number) ?? null, createdAt: Number(r.created_at), createdBy: String(r.created_by || "") };
}
function toWebhookCall(r: Record<string, unknown>): WebhookCall {
  return {
    id: String(r.id), at: Number(r.at), kind: String(r.kind) as WebhookCall["kind"], modelId: String(r.model_id || ""), hook: String(r.hook || ""),
    method: String(r.method || "POST"), path: String(r.path || ""), query: jsonParse(r.query, {}), headers: jsonParse(r.headers, {}),
    contentType: String(r.content_type || ""), body: String(r.body || ""), bodySize: Number(r.body_size || 0), parsed: jsonParse(r.parsed, null),
    ip: String(r.ip || ""), status: Number(r.status || 0), responseHeaders: jsonParse(r.response_headers, {}), responseBody: String(r.response_body || ""),
    runId: String(r.run_id || ""), ms: Number(r.ms || 0), error: String(r.error || ""), replayOf: String(r.replay_of || ""), result: jsonParse(r.result, null),
  };
}
function toWebhook(r: Record<string, unknown>): DurableWebhook {
  return { token: String(r.token), modelId: String(r.model_id), sessionId: String(r.session_id), caller: jsonParse(r.caller, {} as Caller), entry: String(r.entry), once: Boolean(r.once), expiresAt: (r.expires_at as number) ?? null, createdAt: Number(r.created_at) };
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
  sessionSet(sessionId: string, key: string, value: unknown, ttlMs: number | null): void { this.memCheck(this.skv, sessionId, key, value); this.skv.set(`${sessionId}\0${key}`, { value: value ?? null, expires: ttlMs ? Date.now() + ttlMs : null }); }
  /** KV_LIMITS for the in-memory store too. */
  private memCheck(map: Map<string, { value: unknown; expires: number | null }>, scope: string, key: string, value: unknown): void {
    const now = Date.now();
    let keys = 0; let bytes = 0; let oldBytes = 0; let exists = false;
    for (const [k, v] of map) {
      if (!k.startsWith(`${scope}\0`) || (v.expires !== null && v.expires <= now)) continue;
      const n = Buffer.byteLength(JSON.stringify(v.value ?? null));
      keys++; bytes += n;
      if (k === `${scope}\0${key}`) { exists = true; oldBytes = n; }
    }
    checkKv(key, JSON.stringify(value ?? null), { exists, oldBytes, keys, bytes });
  }
  sessionDelete(sessionId: string, key: string): void { this.skv.delete(`${sessionId}\0${key}`); }
  sessionKeys(sessionId: string, now: number): string[] { const out: string[] = []; for (const [k, v] of this.skv) { const [sid, key] = k.split("\0"); if (sid === sessionId && (v.expires === null || v.expires > now)) out.push(key); } return out; }

  cacheGet(scope: string, key: string, now: number): unknown { const r = this.ckv.get(`${scope}\0${key}`); return r && (r.expires === null || r.expires > now) ? r.value : null; }
  cacheSet(scope: string, key: string, value: unknown, ttlMs: number | null): void { this.memCheck(this.ckv, scope, key, value); this.ckv.set(`${scope}\0${key}`, { value: value ?? null, expires: ttlMs ? Date.now() + ttlMs : null }); }
  cacheDelete(scope: string, key: string): void { this.ckv.delete(`${scope}\0${key}`); }

  private sch = new Map<string, Schedule>();
  private hooks = new Map<string, DurableWebhook>();
  schedules(): Schedule[] { return [...this.sch.values()].sort((a, b) => a.createdAt - b.createdAt); }
  schedule(id: string): Schedule | null { return this.sch.get(id) ?? null; }
  saveSchedule(s: Schedule): void { this.sch.set(s.id, structuredClone(s)); }
  deleteSchedule(id: string): void { this.sch.delete(id); }
  saveWebhook(w: DurableWebhook): void { this.hooks.set(w.token, structuredClone(w)); }
  private calls = new Map<string, WebhookCall>();
  durableWebhooks(now: number): DurableWebhook[] { return [...this.hooks.values()].filter((w) => w.expiresAt === null || w.expiresAt > now); }
  addWebhookCall(c: WebhookCall): void { this.calls.set(c.id, c); if (this.calls.size > 2000) this.calls.delete(this.calls.keys().next().value as string); }
  webhookCall(id: string): WebhookCall | null { return this.calls.get(id) ?? null; }
  webhookCalls(q: { modelId?: string; kind?: string; status?: "ok" | "error"; before?: number }, limit: number): WebhookCall[] {
    return [...this.calls.values()].filter((c) => (!q.modelId || c.modelId === q.modelId) && (!q.kind || c.kind === q.kind) && (!q.before || c.at < q.before)
      && (!q.status || (q.status === "ok" ? c.status >= 200 && c.status < 300 : c.status < 200 || c.status >= 300))).sort((a, b) => b.at - a.at).slice(0, limit);
  }
  webhookStats(): Array<{ modelId: string; calls: number; errors: number; last: number }> {
    const by = new Map<string, { modelId: string; calls: number; errors: number; last: number }>();
    for (const c of this.calls.values()) { const s = by.get(c.modelId) ?? { modelId: c.modelId, calls: 0, errors: 0, last: 0 }; s.calls++; if (c.status < 200 || c.status >= 300) s.errors++; s.last = Math.max(s.last, c.at); by.set(c.modelId, s); }
    return [...by.values()];
  }
  webhookHookStats(): Array<{ modelId: string; hook: string; calls: number; errors: number; last: number }> {
    const by = new Map<string, { modelId: string; hook: string; calls: number; errors: number; last: number }>();
    for (const c of this.calls.values()) { const k = `${c.modelId}\0${c.hook}`; const s = by.get(k) ?? { modelId: c.modelId, hook: c.hook, calls: 0, errors: 0, last: 0 }; s.calls++; if (c.status < 200 || c.status >= 300) s.errors++; s.last = Math.max(s.last, c.at); by.set(k, s); }
    return [...by.values()];
  }
  deleteWebhookCalls(modelId?: string): number { let n = 0; for (const [id, c] of this.calls) if (!modelId || c.modelId === modelId) { this.calls.delete(id); n++; } return n; }
  webhook(token: string, now: number): DurableWebhook | null { const w = this.hooks.get(token); if (!w) return null; if (w.expiresAt !== null && w.expiresAt <= now) { this.hooks.delete(token); return null; } return w; }
  deleteWebhook(token: string): void { this.hooks.delete(token); }

  private chs = new Map<string, Chain>();
  chain(id: string): Chain | null { const c = this.chs.get(id); return c ? structuredClone(c) : null; }
  saveChain(c: Chain): void { this.chs.set(c.id, structuredClone(c)); }
  chains(modelId: string, limit: number): Chain[] { return [...this.chs.values()].filter((c) => c.modelId === modelId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((c) => structuredClone(c)); }

  prune(runCutoff: number, now: number): void {
    const nfcCutoff = Math.max(runCutoff, now - nfcRunKeepMs());
    for (const [id, r] of this.rns) if (r.sensitive && r.finishedAt !== null && r.finishedAt < nfcCutoff) this.rns.delete(id);
    for (const [id, c] of this.chs) if (c.updatedAt < runCutoff) { this.chs.delete(id); for (const k of [...this.skv.keys()]) if (k.startsWith(`${c.sessionId}\0`)) this.skv.delete(k); for (const k of [...this.ckv.keys()]) if (k.startsWith(`chain:${id}\0`)) this.ckv.delete(k); }
    for (const [k, v] of this.skv) if (v.expires !== null && v.expires <= now) this.skv.delete(k);
    for (const [k, v] of this.ckv) if (v.expires !== null && v.expires <= now) this.ckv.delete(k);
    for (const [t, w] of this.hooks) if (w.expiresAt !== null && w.expiresAt <= now) this.hooks.delete(t);
    for (const [id, r] of this.rns) if (r.finishedAt !== null && r.finishedAt < runCutoff) { this.rns.delete(id); this.lgs.delete(id); }
  }
}

export const functionsStore = new FunctionsStore();
