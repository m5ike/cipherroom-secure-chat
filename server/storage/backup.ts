// Backups and integrity checks.
//
// A backup is a directory $BACKUP_DIR/m5cet-<timestamp>/ with:
//   m5cet.db            the global database, copied with SQLite's online
//                       backup (consistent while the server keeps running)
//   db/*.db             every user / session database file as it is on disk
//                       — still encrypted with its owner's key (open ones are
//                       checkpointed first so the file is complete)
//   accounts/…          the account index and sealed vault files
//   admin-users.json    console administrators (token hashes only)
//   manifest.json       what is in it: sizes and SHA-256 of every file
//
// The storage MASTER KEY is deliberately NOT in the backup: a copy of the
// backup alone then opens nothing (logs, transfers, sessions are sealed with
// it). Back it up separately (STORAGE_MASTER_KEY or storage.key).
//
// BACKUP_DIR turns on the schedule (BACKUP_INTERVAL_HOURS, default 24;
// BACKUP_KEEP, default 7). Without it, backups run only when the operator
// asks, into <storage dir>/../backups. The same schedule runs a quick
// integrity check of the global database and every open user database.

import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { StorageService } from "./service";
import { accountsDir } from "../accounts/store";
import { adminDir } from "../admin-users";
import { audit } from "../monitor/audit";

export type BackupInfo = { name: string; at: number; bytes: number; files: number };
export type IntegrityResult = { at: number; ok: boolean; global: string; databases: Array<{ id: string; result: string }>; locked: number };
export type BackupResult = { ok: true; name: string; path: string; files: number; bytes: number; ms: number } | { ok: false; error: string };

const env = (name: string) => process.env[name]?.trim() || "";

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => resolveHash(hash.digest("hex"))).on("error", reject);
  });
}

export class BackupManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<BackupResult> | null = null;
  last: BackupResult | null = null;
  lastIntegrity: IntegrityResult | null = null;

  constructor(private readonly storage: StorageService, private readonly storageDirPath: string) {}

  get dir(): string {
    return env("BACKUP_DIR") ? resolve(env("BACKUP_DIR")) : resolve(dirname(this.storageDirPath), "backups");
  }

  get scheduled(): boolean { return Boolean(env("BACKUP_DIR")); }

  get intervalHours(): number {
    const n = Number(env("BACKUP_INTERVAL_HOURS"));
    return Number.isFinite(n) && n >= 1 ? n : 24;
  }

  get keep(): number {
    const n = Number(env("BACKUP_KEEP"));
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 7;
  }

  start(): void {
    if (this.timer || !this.scheduled) return;
    this.timer = setInterval(() => {
      void this.run("schedule");
      this.integrity();
    }, this.intervalHours * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): BackupInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => /^m5cet-\d{8}T\d{6}Z(-\d+)?$/.test(name))
      .map((name) => {
        const manifest = join(this.dir, name, "manifest.json");
        try {
          const m = JSON.parse(readFileSync(manifest, "utf8")) as { at: number; files: Array<{ bytes: number }> };
          return { name, at: m.at, bytes: m.files.reduce((n, f) => n + f.bytes, 0), files: m.files.length };
        } catch {
          return { name, at: statSync(join(this.dir, name)).mtimeMs, bytes: 0, files: 0 };
        }
      })
      .sort((a, b) => b.at - a.at);
  }

  /** One backup at a time; a second request joins the running one. */
  run(reason: string): Promise<BackupResult> {
    this.running ??= this.backup(reason).finally(() => { this.running = null; });
    return this.running;
  }

  private async backup(reason: string): Promise<BackupResult> {
    const started = Date.now();
    const stamp = new Date(started).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    let name = `m5cet-${stamp}`;
    for (let i = 1; existsSync(join(this.dir, name)); i++) name = `m5cet-${stamp}-${i}`;
    const target = join(this.dir, name);
    try {
      mkdirSync(join(target, "db"), { recursive: true, mode: 0o700 });
      const files: Array<{ path: string; bytes: number; sha256: string }> = [];
      const add = async (source: string, dest: string) => {
        if (!existsSync(source)) return;
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        copyFileSync(source, dest);
        files.push({ path: relative(target, dest), bytes: statSync(dest).size, sha256: await sha256File(dest) });
      };
      await this.storage.global.backupTo(join(target, "m5cet.db"));
      files.push({ path: "m5cet.db", bytes: statSync(join(target, "m5cet.db")).size, sha256: await sha256File(join(target, "m5cet.db")) });
      for (const file of this.storage.userDatabaseFiles()) await add(file, join(target, "db", basename(file)));
      const accounts = accountsDir();
      for (const file of ["accounts.json"]) await add(join(accounts, file), join(target, "accounts", file));
      for (const sub of ["vault", "mailbox"]) {
        const dir = join(accounts, sub);
        if (existsSync(dir)) for (const f of readdirSync(dir)) await add(join(dir, f), join(target, "accounts", sub, f));
      }
      await add(join(adminDir(), "admin-users.json"), join(target, "admin-users.json"));
      writeFileSync(join(target, "manifest.json"), JSON.stringify({
        app: "m5cet", at: started, reason,
        note: "The storage master key is not included; back it up separately (STORAGE_MASTER_KEY or storage.key).",
        files,
      }, null, 2), { mode: 0o600 });
      this.rotate();
      const result: BackupResult = { ok: true, name, path: target, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), ms: Date.now() - started };
      this.last = result;
      audit.add({ category: "storage", level: "notice", event: "backup.done", status: reason, bytes: result.bytes, detail: { name, files: result.files, ms: result.ms } });
      return result;
    } catch (err) {
      rmSync(target, { recursive: true, force: true });
      const result: BackupResult = { ok: false, error: (err as Error).message };
      this.last = result;
      audit.add({ category: "storage", level: "error", event: "backup.failed", status: reason, detail: { error: result.error.slice(0, 200) } });
      return result;
    }
  }

  private rotate(): void {
    for (const old of this.list().slice(this.keep)) rmSync(join(this.dir, old.name), { recursive: true, force: true });
  }

  integrity(): IntegrityResult {
    const checked = this.storage.integrityCheck();
    const ok = checked.global === "ok" && checked.databases.every((d) => d.result === "ok");
    this.lastIntegrity = { at: Date.now(), ok, ...checked };
    audit.add({ category: "storage", level: ok ? "info" : "error", event: "integrity.check", status: ok ? "ok" : "problems", detail: { global: checked.global, bad: checked.databases.filter((d) => d.result !== "ok").map((d) => d.id), locked: checked.locked } });
    return this.lastIntegrity;
  }
}
