// The key directory (protocol 4, § 7.5): the newest mailbox bundle of every
// device of a signed-in account, with the device certificate (v2) that ties
// the device to the account key. Public keys only — nothing here is secret —
// in the global SQLite database (table key_directory), or in memory when the
// server runs without storage (then it is lost on a restart, and the devices
// upload again at their next sign-in or bundle renewal).
//
// One row per (account, device key). `token_hash` is the session the device
// last uploaded with: ending that session (sign-out on that device, "end this
// session" from another one) removes the device, and signing out everywhere or
// deleting the account removes them all (server/keys/service.ts logs a `rev`
// entry for each).

import { migrate, type SqliteDatabase, type SqliteStatement } from "../storage/db";
import type { Migration } from "../storage/schema";
import type { DirectoryDevice, MailboxBundle } from "../../client/src/lib/p4/contract";

export const KEYS_MIGRATIONS: Migration[] = [
  {
    name: "keys-001-directory",
    sql: `
      CREATE TABLE IF NOT EXISTS key_directory (
        account_id TEXT NOT NULL,
        pk         TEXT NOT NULL,
        u          TEXT NOT NULL,
        apk        TEXT NOT NULL,
        cert_exp   INTEGER NOT NULL,
        cert_sig   TEXT NOT NULL,
        bundle     TEXT NOT NULL,
        bundle_exp INTEGER NOT NULL,
        token_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, pk)
      );
      CREATE INDEX IF NOT EXISTS key_directory_token ON key_directory(account_id, token_hash);
    `,
  },
];

export const DIRECTORY_LIMITS = {
  /** Devices one account may have in the directory (with a certificate that has not expired). */
  devicesPerAccount: 10,
  /** Devices in the whole directory. */
  totalDevices: 200_000,
};

/** KEYS_MAX_DEVICES (1 – 50) overrides devicesPerAccount. */
export function devicesPerAccount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KEYS_MAX_DEVICES?.trim());
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DIRECTORY_LIMITS.devicesPerAccount;
}

export type DirectoryRow = {
  accountId: string;
  /** The device's signing key (SPKI b64). */
  pk: string;
  /** The account's KT user id (b64url(SHA-256("m5cet/kt/user|" + username))) — kept so a removal can be logged after the account is gone. */
  u: string;
  apk: string;
  certExp: number;
  certSig: string;
  bundle: MailboxBundle;
  tokenHash: string | null;
  createdAt: number;
  updatedAt: number;
};

export function toDirectoryDevice(r: DirectoryRow): DirectoryDevice {
  return { pk: r.pk, apk: r.apk, cert: { v: 2, exp: r.certExp, sig: r.certSig }, bundle: r.bundle };
}

export interface DirectoryBackend {
  readonly persistent: boolean;
  get(accountId: string, pk: string): DirectoryRow | null;
  list(accountId: string): DirectoryRow[];
  put(row: DirectoryRow): void;
  remove(accountId: string, pk: string): boolean;
  count(): number;
  accounts(): number;
}

export class MemoryDirectory implements DirectoryBackend {
  readonly persistent = false;
  private readonly rows = new Map<string, Map<string, DirectoryRow>>();

  get(accountId: string, pk: string): DirectoryRow | null {
    return this.rows.get(accountId)?.get(pk) ?? null;
  }
  list(accountId: string): DirectoryRow[] {
    return [...(this.rows.get(accountId)?.values() ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  }
  put(row: DirectoryRow): void {
    let map = this.rows.get(row.accountId);
    if (!map) { map = new Map(); this.rows.set(row.accountId, map); }
    map.set(row.pk, { ...row });
  }
  remove(accountId: string, pk: string): boolean {
    const map = this.rows.get(accountId);
    const gone = map?.delete(pk) ?? false;
    if (map && map.size === 0) this.rows.delete(accountId);
    return gone;
  }
  count(): number {
    let n = 0;
    for (const m of this.rows.values()) n += m.size;
    return n;
  }
  accounts(): number {
    return this.rows.size;
  }
}

type Row = Record<string, unknown>;

function fromRow(r: Row): DirectoryRow | null {
  let bundle: MailboxBundle;
  try { bundle = JSON.parse(String(r.bundle)) as MailboxBundle; } catch { return null; }
  return {
    accountId: String(r.account_id), pk: String(r.pk), u: String(r.u), apk: String(r.apk),
    certExp: Number(r.cert_exp), certSig: String(r.cert_sig), bundle,
    tokenHash: r.token_hash === null || r.token_hash === undefined ? null : String(r.token_hash),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

export class SqliteDirectory implements DirectoryBackend {
  readonly persistent = true;
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(private readonly db: SqliteDatabase) {
    migrate(db, KEYS_MIGRATIONS);
  }

  private sql(source: string): SqliteStatement {
    let s = this.statements.get(source);
    if (!s) { s = this.db.prepare(source); this.statements.set(source, s); }
    return s;
  }

  get(accountId: string, pk: string): DirectoryRow | null {
    const r = this.sql("SELECT * FROM key_directory WHERE account_id = ? AND pk = ?").get(accountId, pk) as Row | undefined;
    return r ? fromRow(r) : null;
  }
  list(accountId: string): DirectoryRow[] {
    return (this.sql("SELECT * FROM key_directory WHERE account_id = ? ORDER BY created_at ASC").all(accountId) as Row[]).map(fromRow).filter((r): r is DirectoryRow => r !== null);
  }
  put(row: DirectoryRow): void {
    this.sql(`
      INSERT INTO key_directory (account_id, pk, u, apk, cert_exp, cert_sig, bundle, bundle_exp, token_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, pk) DO UPDATE SET
        u = excluded.u, apk = excluded.apk, cert_exp = excluded.cert_exp, cert_sig = excluded.cert_sig,
        bundle = excluded.bundle, bundle_exp = excluded.bundle_exp, token_hash = excluded.token_hash, updated_at = excluded.updated_at
    `).run(row.accountId, row.pk, row.u, row.apk, row.certExp, row.certSig, JSON.stringify(row.bundle), row.bundle.exp, row.tokenHash, row.createdAt, row.updatedAt);
  }
  remove(accountId: string, pk: string): boolean {
    return this.sql("DELETE FROM key_directory WHERE account_id = ? AND pk = ?").run(accountId, pk).changes > 0;
  }
  count(): number {
    return Number((this.sql("SELECT count(*) AS n FROM key_directory").get() as { n: number }).n);
  }
  accounts(): number {
    return Number((this.sql("SELECT count(DISTINCT account_id) AS n FROM key_directory").get() as { n: number }).n);
  }
}
