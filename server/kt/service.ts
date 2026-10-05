// Key transparency as the rest of the server sees it: on (the log in the
// global database), off (no server-side storage: nothing is logged and the
// /api/kt routes answer 503 "off") or failed (the database is there but the
// log is corrupt or could not be opened: 503 "failed", and whatever would add
// an entry — a device certificate in the key directory — is refused too, so
// the directory never serves a key the log does not show).

import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../storage/db";
import { LABEL, type KtConsistency, type KtEntry, type KtLookup, type SignedTreeHead } from "../../client/src/lib/p4/contract";
import { KtLog, KtUnavailableError, type KtSigner, type KtStatus } from "./log";

/** u = b64url(SHA-256(LABEL.ktUser + username)) — the log names no user in clear text. */
export function ktUser(username: string): string {
  return createHash("sha256").update(`${LABEL.ktUser}${username}`, "utf8").digest("base64url");
}

export type KtMode = "on" | "off" | "failed";

export class KtService {
  private constructor(private readonly log: KtLog | null, private readonly mode0: KtMode, private readonly reason: string | null) {}

  /** No server-side storage: key transparency is off. */
  static off(reason: string): KtService {
    return new KtService(null, "off", reason);
  }

  /** The log in `db`; a log that cannot be opened is failed (closed), never recreated. */
  static open(db: SqliteDatabase, signer: () => KtSigner, now: () => number = Date.now): KtService {
    try {
      return new KtService(new KtLog(db, signer(), now), "on", null);
    } catch (err) {
      const reason = `the key transparency log could not be opened (${(err as Error).message})`;
      console.error(`[kt] ${reason}`);
      return new KtService(null, "failed", reason);
    }
  }

  get mode(): KtMode {
    if (this.mode0 === "on" && this.log?.failed) return "failed";
    return this.mode0;
  }

  private need(): KtLog {
    if (this.log && !this.log.failed) return this.log;
    if (this.mode0 === "off") throw new KtUnavailableError("off", this.reason ?? "key transparency is off");
    throw new KtUnavailableError("failed", this.log?.failed ?? this.reason ?? "key transparency is closed");
  }

  key(): string { return this.need().key(); }
  sth(): Promise<SignedTreeHead> { return this.need().sth(); }
  lookup(u: string): Promise<KtLookup> { return this.need().lookup(u); }
  consistency(from: number, to: number): KtConsistency { return this.need().consistency(from, to); }
  entriesOf(u: string): KtEntry[] { return this.need().entriesOf(u); }

  /** Appends when on; null when off (nothing to log to); throws when failed or busy. */
  append(entry: KtEntry): number | null {
    if (this.mode0 === "off") return null;
    return this.need().append(entry);
  }

  /** Logs `acct` unless the newest account key of `u` in the log already is `apk`. Returns the index, or null. */
  ensureAccount(u: string, apk: string, ts: number): number | null {
    if (this.mode0 === "off") return null;
    const log = this.need();
    const last = log.entriesOf(u).filter((e) => e.t === "acct").at(-1);
    if (last && last.apk === apk) return null;
    return log.append({ t: "acct", u, apk, ts });
  }

  status(): (KtStatus & { mode: KtMode }) | { mode: KtMode; reason: string | null } {
    if (!this.log) return { mode: this.mode0, reason: this.reason };
    return { mode: this.mode, ...this.log.status() };
  }
}
