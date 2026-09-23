// Server accounts for signed-in (passkey) users — persisted on disk.
//
//   $ACCOUNTS_DIR (default $DATA_DIR/accounts, else ./.m5cet/accounts)
//     accounts.json            account records: passkey public key, counters,
//                              stats, push endpoints, away rooms, audit log
//     vault/<id>.json          the user's encrypted vault (profile + chat)
//     mailbox/<id>.json        messages / receipts waiting while the user is away
//
// Zero-knowledge where it matters: vault blobs are sealed in the browser with
// a key derived from the passkey's PRF secret, and mailbox items are room-key
// ciphertext — the server stores and forwards, it cannot read either. What
// it does know (and logs): who signed in when, sizes, counts, room names and
// display names — the same metadata signaling already sees.
//
// Session tokens are random, shown to the client once and kept only as
// SHA-256 hashes — in sessions.json next to the accounts, so a restart does
// not sign everyone out. A session lives 12 hours from its last use and at
// most 7 days; the account window lists them and ends any one of them.
//
// One account, several passkeys (3.1): the browser derives the account's
// keys from a root secret. The first passkey's PRF output IS that root; for
// every further passkey — and for a recovery code — the browser stores the
// root sealed under a key only that passkey (or code) can produce
// (`wrapped`). The server keeps blobs it cannot open.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StoredCredential } from "./webauthn";

export const ACCOUNT_LIMITS = {
  maxAccounts: 5000,
  maxUserNameChars: 64,
  maxProfileChars: 128_000,
  maxChatChars: 6_000_000,
  maxMailboxItems: 500,
  maxMailboxBytes: 4_000_000,
  maxItemBytes: 130_000,
  maxAudit: 300,
  maxPush: 5,
  maxAwayRooms: 20,
  /** A session ends this long after its last use… */
  tokenTtlMs: 12 * 60 * 60 * 1000,
  /** …and this long after it began, used or not. */
  tokenMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxSessionsPerAccount: 20,
  maxPasskeys: 10,
} as const;

export type AuditEntry = { at: number; kind: string; meta?: Record<string, string | number | boolean> };

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string }; createdAt: number };

/** A passkey besides the first one, with what the account window shows. */
export type AccountCredential = StoredCredential & { createdAt: number; lastUsedAt: number; label: string };

/** The account root sealed for one passkey or for the recovery code. */
export type WrappedRoot = { iv: string; ct: string; createdAt: number };

export type AccountRecord = {
  id: string;
  /** The first passkey — its PRF output is the account root. */
  credential: StoredCredential;
  /** Further passkeys (3.1). */
  credentials?: AccountCredential[];
  /** credentialId | "recovery" → the root sealed for it. */
  wrapped?: Record<string, WrappedRoot>;
  /** The recovery code, as a lookup id and a verifier of its proof. */
  recovery?: { id: string; verifier: string; createdAt: number };
  /** The account's own signing key (Ed25519, public part), for reference. */
  identity?: { publicKey: string; updatedAt: number };
  userName: string;
  createdAt: number;
  lastLoginAt: number;
  loginCount: number;
  vault: { profileBytes: number; profileUpdatedAt: number; chatBytes: number; chatUpdatedAt: number; messages: number; messageBytes: number; rooms: number };
  push: PushTarget[];
  away: Array<{ room: string; name: string; since: number }>;
  audit: AuditEntry[];
};

export type MailFrom = { peerId: string; accountId?: string; name: string };

export type MailItem = {
  id: string;
  room: string;
  kind: "message" | "status";
  from: MailFrom;
  messageId: string;
  /** Room-key ciphertext of the message (kind "message"). */
  envelope?: { iv: string; ciphertext: string };
  /** Delivery / read status of a message this account sent (kind "status"). */
  status?: { state: "delivered" | "read"; at: number; recipientName: string };
  storedAt: number;
  bytes: number;
};

type VaultFile = { profile?: { ct: string; updatedAt: number }; chat?: { ct: string; updatedAt: number } };

/**
 * Where a user's sealed vault lives. By default it is a file next to the
 * account index; when the SQLCipher storage is running and the user's own
 * database is open, server/storage/bridge.ts points this at that database
 * instead. The blob is sealed by the browser either way — this only decides
 * which encrypted container holds it.
 */
export type VaultBackend = {
  read(accountId: string): VaultFile | null;
  write(accountId: string, vault: VaultFile): boolean;
  erase(accountId: string): void;
};

let vaultBackend: VaultBackend | null = null;

export function setVaultBackend(backend: VaultBackend | null): void {
  vaultBackend = backend;
}
type Session = { accountId: string; createdAt: number; expiresAt: number; lastUsedAt: number; client?: string; ip?: string };

/** What the account window shows about one session. */
export type SessionView = { id: string; createdAt: number; lastUsedAt: number; expiresAt: number; client: string; ip: string; current: boolean };

const env = (name: string) => process.env[name]?.trim() || "";

export function accountsDir(): string {
  const explicit = env("ACCOUNTS_DIR");
  if (explicit) return resolve(explicit);
  const data = env("DATA_DIR");
  return data ? resolve(data, "accounts") : resolve(process.cwd(), ".m5cet", "accounts");
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

const B64 = /^[A-Za-z0-9+/=_-]+$/;
function validWrapped(w: unknown): w is { iv: string; ct: string } {
  const v = w as { iv?: unknown; ct?: unknown } | null;
  return Boolean(v) && typeof v!.iv === "string" && typeof v!.ct === "string" && B64.test(v!.iv) && B64.test(v!.ct) && v!.iv.length <= 32 && v!.ct.length <= 256;
}
// eslint-disable-next-line no-control-regex
const cleanLabel = (label: unknown) => (typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) : "") || "passkey";

/** How a session token is known inside the server (never the token itself). */
export function tokenHash(token: string): string {
  return sha256hex(token);
}

/** Told when sessions end: one token (its hash), or every session of the account (null). */
export type RevokeListener = (accountId: string, tokenHash: string | null, reason: "sign-out" | "sign-out-everywhere" | "deleted" | "admin") => void;
const ID = /^[A-Za-z0-9_-]{10,64}$/;

/** Stable, non-reversible account id derived from the credential id. */
export function accountIdFor(credentialId: string): string {
  return createHash("sha256").update(`m5cet:account:${credentialId}`).digest("base64url").slice(0, 22);
}

export class AccountStore {
  private loaded = false;
  private accounts = new Map<string, AccountRecord>();
  private byCredential = new Map<string, string>();
  private sessions = new Map<string, Session>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Files the disk refused (read-only install): kept in memory instead. */
  private memory = new Map<string, unknown>();
  private writeError: string | null = null;
  private revokeListeners = new Set<RevokeListener>();
  private queueStats: ((accountId: string) => { pending: number; bytes: number }) | null = null;

  constructor(private readonly dir: string = accountsDir()) {}

  /** Several instances use this directory (see shareDisk). */
  private shared = false;
  /** path → mtime/size/inode as this instance last read or wrote it. */
  private stamps = new Map<string, string>();

  /**
   * Several server instances use this directory (a cluster on one host, or
   * a shared volume): before every operation read again what another
   * instance wrote, and write changes at once instead of coalescing them.
   * Two instances changing the store in the very same millisecond can
   * still lose one change — sticky sessions at the load balancer keep a
   * user's requests on one instance and make that rarer still.
   */
  shareDisk(): void {
    this.shared = true;
    if (this.persistTimer) this.persist();
    if (this.sessionsTimer) this.persistSessionsSoon(true);
  }

  private stampOf(path: string): string {
    try { const st = statSync(path); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return "none"; }
  }

  private write(path: string, value: unknown): void {
    try {
      writeJsonAtomic(path, value);
      if (this.shared) this.stamps.set(path, this.stampOf(path));
      this.memory.delete(path);
    } catch (err) {
      this.memory.set(path, value);
      if (!this.writeError) console.warn(`[accounts] ${this.dir} is not writable (${(err as Error).message}); keeping account data in memory only. Set DATA_DIR / ACCOUNTS_DIR to a writable directory.`);
      this.writeError = (err as Error).message;
    }
  }

  private read<T>(path: string, fallback: T): T {
    return this.memory.has(path) ? (this.memory.get(path) as T) : readJson(path, fallback);
  }

  private remove(path: string): void {
    this.memory.delete(path);
    try { rmSync(path, { force: true }); } catch { /* read-only: nothing on disk anyway */ }
  }

  /** Where accounts live and whether they survive a restart. */
  status(): { dir: string; persistent: boolean; error?: string } {
    this.load();
    return { dir: this.dir, persistent: this.writeError === null, ...(this.writeError ? { error: this.writeError } : {}) };
  }

  private indexPath() { return join(this.dir, "accounts.json"); }
  private sessionsPath() { return join(this.dir, "sessions.json"); }
  private vaultPath(id: string) { return join(this.dir, "vault", `${id}.json`); }
  private mailboxPath(id: string) { return join(this.dir, "mailbox", `${id}.json`); }

  private load() {
    if (this.loaded) {
      if (this.shared) this.refresh();
      return;
    }
    this.loaded = true;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      accessSync(this.dir, fsConstants.W_OK);
    } catch (err) {
      this.writeError = (err as Error).message;
    }
    this.readAccounts();
    this.readSessions();
  }

  /** Shared directory: another instance changed a file since we saw it. */
  private refresh(): void {
    const index = this.stampOf(this.indexPath());
    if (index !== this.stamps.get(this.indexPath())) this.readAccounts();
    const sessions = this.stampOf(this.sessionsPath());
    if (sessions !== this.stamps.get(this.sessionsPath())) this.readSessions();
  }

  private readAccounts(): void {
    this.stamps.set(this.indexPath(), this.stampOf(this.indexPath()));
    this.accounts.clear();
    this.byCredential.clear();
    const data = this.read<{ accounts?: Record<string, AccountRecord> }>(this.indexPath(), {});
    for (const rec of Object.values(data.accounts ?? {})) {
      if (!rec || typeof rec.id !== "string" || !rec.credential?.credentialId) continue;
      rec.push ??= [];
      rec.away ??= [];
      rec.audit ??= [];
      this.accounts.set(rec.id, rec);
      this.byCredential.set(rec.credential.credentialId, rec.id);
      for (const extra of rec.credentials ?? []) this.byCredential.set(extra.credentialId, rec.id);
    }
  }

  /** Sessions survive a restart: hashes only, and only live ones. */
  private readSessions(): void {
    this.stamps.set(this.sessionsPath(), this.stampOf(this.sessionsPath()));
    this.sessions.clear();
    const now = Date.now();
    const stored = this.read<{ sessions?: Record<string, Session> }>(this.sessionsPath(), {});
    for (const [hash, sess] of Object.entries(stored.sessions ?? {})) {
      if (/^[0-9a-f]{64}$/.test(hash) && sess && this.accounts.has(sess.accountId) && sess.expiresAt > now) this.sessions.set(hash, sess);
    }
  }

  private sessionsTimer: ReturnType<typeof setTimeout> | null = null;

  /** Session writes are frequent (every use moves "last used"): coalesce them. */
  private persistSessionsSoon(immediately = false): void {
    const write = () => {
      this.sessionsTimer = null;
      this.write(this.sessionsPath(), { v: 1, sessions: Object.fromEntries(this.sessions) });
    };
    if (immediately || this.shared) {
      if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
      write();
      return;
    }
    if (this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(write, 2_000);
    this.sessionsTimer.unref?.();
  }

  private persist() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    this.write(this.indexPath(), { v: 1, accounts: Object.fromEntries(this.accounts) });
  }

  /** Audit lines are frequent (one per relayed message): coalesce their writes. */
  private persistSoon() {
    if (this.shared) return this.persist();
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, 400);
    this.persistTimer.unref?.();
  }

  /** Writes pending changes now (tests, shutdown). */
  flush(): void {
    if (this.persistTimer) this.persist();
    if (this.sessionsTimer) this.persistSessionsSoon(true);
  }

  get size(): number { this.load(); return this.accounts.size; }

  get(accountId: string): AccountRecord | null {
    this.load();
    return ID.test(accountId) ? this.accounts.get(accountId) ?? null : null;
  }

  /** Every account, for anything that needs to walk them (storage index). */
  all(): AccountRecord[] {
    this.load();
    return Array.from(this.accounts.values());
  }

  findByCredential(credentialId: string): AccountRecord | null {
    this.load();
    const id = this.byCredential.get(credentialId);
    return id ? this.accounts.get(id) ?? null : null;
  }

  create(credential: StoredCredential, userName: string, now = Date.now()): { ok: true; account: AccountRecord } | { ok: false; reason: string } {
    this.load();
    if (this.byCredential.has(credential.credentialId)) return { ok: false, reason: "credential already registered" };
    if (this.accounts.size >= ACCOUNT_LIMITS.maxAccounts) return { ok: false, reason: "account store full" };
    const account: AccountRecord = {
      id: accountIdFor(credential.credentialId),
      credential,
      userName: userName.trim().slice(0, ACCOUNT_LIMITS.maxUserNameChars),
      createdAt: now,
      lastLoginAt: now,
      loginCount: 1,
      vault: { profileBytes: 0, profileUpdatedAt: 0, chatBytes: 0, chatUpdatedAt: 0, messages: 0, messageBytes: 0, rooms: 0 },
      push: [],
      away: [],
      audit: [],
    };
    this.accounts.set(account.id, account);
    this.byCredential.set(credential.credentialId, account.id);
    this.addAudit(account.id, "register", { alg: credential.alg }, now);
    this.persist();
    return { ok: true, account };
  }

  recordSignIn(accountId: string, signCount: number, meta: AuditEntry["meta"], now = Date.now(), credentialId?: string): void {
    const acc = this.get(accountId);
    if (!acc) return;
    const extra = credentialId ? acc.credentials?.find((c) => c.credentialId === credentialId) : undefined;
    if (extra) { extra.signCount = signCount; extra.lastUsedAt = now; }
    else acc.credential.signCount = signCount;
    acc.lastLoginAt = now;
    acc.loginCount += 1;
    this.addAudit(accountId, "sign-in", meta, now);
    this.persist(); // the signature counter must survive a crash
  }

  addAudit(accountId: string, kind: string, meta?: AuditEntry["meta"], now = Date.now()): void {
    const acc = this.get(accountId);
    if (!acc) return;
    acc.audit.push({ at: now, kind: kind.slice(0, 40), ...(meta ? { meta } : {}) });
    if (acc.audit.length > ACCOUNT_LIMITS.maxAudit) acc.audit.splice(0, acc.audit.length - ACCOUNT_LIMITS.maxAudit);
    this.persistSoon();
  }

  /* -------------------------------------------------------------- tokens */

  issueToken(accountId: string, now = Date.now(), meta: { client?: string; ip?: string } = {}): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(sha256hex(token), {
      accountId, createdAt: now, lastUsedAt: now, expiresAt: now + ACCOUNT_LIMITS.tokenTtlMs,
      ...(meta.client ? { client: meta.client.slice(0, 40) } : {}), ...(meta.ip ? { ip: meta.ip.slice(0, 48) } : {}),
    });
    // Oldest sessions of the account go first when it has too many.
    const mine = [...this.sessions].filter(([, sess]) => sess.accountId === accountId).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [hash] of mine.slice(0, Math.max(0, mine.length - ACCOUNT_LIMITS.maxSessionsPerAccount))) {
      this.sessions.delete(hash);
      this.emitRevoke(accountId, hash, "sign-out");
    }
    this.persistSessionsSoon(true);
    return token;
  }

  resolveToken(token: unknown, now = Date.now()): AccountRecord | null {
    this.load();
    if (typeof token !== "string" || token.length < 20 || token.length > 128) return null;
    const key = sha256hex(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt < now || now - s.createdAt > ACCOUNT_LIMITS.tokenMaxAgeMs) {
      this.sessions.delete(key);
      this.persistSessionsSoon();
      return null;
    }
    // Sliding: every use buys another 12 hours, up to the maximum age.
    // (A shared directory is written at once, so only once a minute.)
    const moved = now - (s.lastUsedAt ?? 0) > 60_000;
    s.lastUsedAt = now;
    s.expiresAt = Math.min(now + ACCOUNT_LIMITS.tokenTtlMs, s.createdAt + ACCOUNT_LIMITS.tokenMaxAgeMs);
    if (moved || !this.shared) this.persistSessionsSoon();
    return this.get(s.accountId);
  }

  revokeToken(token: string): void {
    const key = sha256hex(token);
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    this.persistSessionsSoon(true);
    if (s) this.emitRevoke(s.accountId, key, "sign-out");
  }

  revokeAll(accountId: string, reason: "sign-out-everywhere" | "deleted" | "admin" = "sign-out-everywhere"): void {
    for (const [k, s] of this.sessions) if (s.accountId === accountId) this.sessions.delete(k);
    this.persistSessionsSoon(true);
    this.emitRevoke(accountId, null, reason);
  }

  /** The account's sessions for its window; `currentHash` marks this one. */
  listSessions(accountId: string, currentHash?: string, now = Date.now()): SessionView[] {
    this.load();
    return [...this.sessions]
      .filter(([, sess]) => sess.accountId === accountId && sess.expiresAt >= now)
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      .map(([hash, sess]) => ({
        id: hash.slice(0, 16),
        createdAt: sess.createdAt,
        lastUsedAt: sess.lastUsedAt,
        expiresAt: sess.expiresAt,
        client: sess.client ?? "",
        ip: sess.ip ?? "",
        current: hash === currentHash,
      }));
  }

  /** Ends one session of the account (another device), by its listed id. */
  revokeSession(accountId: string, id: string): boolean {
    this.load();
    if (!/^[0-9a-f]{16}$/.test(id)) return false;
    for (const [hash, sess] of this.sessions) {
      if (sess.accountId !== accountId || !hash.startsWith(id)) continue;
      this.sessions.delete(hash);
      this.persistSessionsSoon(true);
      this.emitRevoke(accountId, hash, "sign-out");
      this.addAudit(accountId, "session-ended", { client: sess.client ?? "" });
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ passkeys */

  /** The stored public key of any of the account's passkeys. */
  credentialOf(accountId: string, credentialId: string): StoredCredential | null {
    const acc = this.get(accountId);
    if (!acc) return null;
    if (acc.credential.credentialId === credentialId) return acc.credential;
    return acc.credentials?.find((c) => c.credentialId === credentialId) ?? null;
  }

  wrappedFor(accountId: string, slot: string): WrappedRoot | null {
    return this.get(accountId)?.wrapped?.[slot] ?? null;
  }

  addCredential(accountId: string, credential: StoredCredential, wrapped: { iv: string; ct: string }, label: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    const acc = this.get(accountId);
    if (!acc) return { ok: false, reason: "unknown account" };
    if (this.byCredential.has(credential.credentialId)) return { ok: false, reason: "this passkey is already registered" };
    if (1 + (acc.credentials?.length ?? 0) >= ACCOUNT_LIMITS.maxPasskeys) return { ok: false, reason: "too many passkeys" };
    if (!validWrapped(wrapped)) return { ok: false, reason: "sealed account key missing or malformed" };
    acc.credentials = [...(acc.credentials ?? []), { ...credential, createdAt: now, lastUsedAt: now, label: cleanLabel(label) }];
    acc.wrapped = { ...(acc.wrapped ?? {}), [credential.credentialId]: { iv: wrapped.iv, ct: wrapped.ct, createdAt: now } };
    this.byCredential.set(credential.credentialId, accountId);
    this.addAudit(accountId, "passkey-added", { passkeys: 1 + acc.credentials.length });
    this.persist();
    return { ok: true };
  }

  /** Removes a passkey. The last one cannot go; removing the first one makes
   *  the next the "first" (its sealed root still opens the account). */
  removeCredential(accountId: string, credentialId: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    const acc = this.get(accountId);
    if (!acc) return { ok: false, reason: "unknown account" };
    const extras = acc.credentials ?? [];
    if (extras.length === 0) return { ok: false, reason: "the last passkey cannot be removed" };
    if (acc.credential.credentialId === credentialId) {
      const [next, ...rest] = extras;
      const { createdAt: _c, lastUsedAt: _l, label: _n, ...stored } = next;
      acc.credential = stored;
      acc.credentials = rest;
      // The new first passkey keeps its sealed root: its PRF output is not the root.
    } else if (extras.some((c) => c.credentialId === credentialId)) {
      acc.credentials = extras.filter((c) => c.credentialId !== credentialId);
      if (acc.wrapped) delete acc.wrapped[credentialId];
    } else {
      return { ok: false, reason: "unknown passkey" };
    }
    this.byCredential.delete(credentialId);
    this.addAudit(accountId, "passkey-removed", {}, now);
    this.persist();
    return { ok: true };
  }

  /* ------------------------------------------------------------ recovery */

  setRecovery(accountId: string, input: { id: string; verifier: string; wrapped: { iv: string; ct: string } }, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    const acc = this.get(accountId);
    if (!acc) return { ok: false, reason: "unknown account" };
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.id) || !/^[0-9a-f]{64}$/.test(input.verifier) || !validWrapped(input.wrapped)) {
      return { ok: false, reason: "malformed recovery data" };
    }
    for (const other of this.accounts.values()) {
      if (other.id !== accountId && other.recovery?.id === input.id) return { ok: false, reason: "recovery id collision; generate a new code" };
    }
    acc.recovery = { id: input.id, verifier: input.verifier, createdAt: now };
    acc.wrapped = { ...(acc.wrapped ?? {}), recovery: { iv: input.wrapped.iv, ct: input.wrapped.ct, createdAt: now } };
    this.addAudit(accountId, "recovery-set", {}, now);
    this.persist();
    return { ok: true };
  }

  clearRecovery(accountId: string): boolean {
    const acc = this.get(accountId);
    if (!acc?.recovery) return false;
    delete acc.recovery;
    if (acc.wrapped) delete acc.wrapped.recovery;
    this.addAudit(accountId, "recovery-removed");
    this.persist();
    return true;
  }

  /** The account a recovery proof opens (constant-time check), or null. */
  checkRecovery(id: string, proof: string): AccountRecord | null {
    this.load();
    if (typeof id !== "string" || typeof proof !== "string" || proof.length > 128) return null;
    for (const acc of this.accounts.values()) {
      if (acc.recovery?.id !== id) continue;
      const expected = Buffer.from(acc.recovery.verifier, "hex");
      const given = createHash("sha256").update(proof).digest();
      return expected.length === given.length && timingSafeEqual(expected, given) ? acc : null;
    }
    return null;
  }

  setIdentity(accountId: string, publicKey: string, now = Date.now()): boolean {
    const acc = this.get(accountId);
    if (!acc || typeof publicKey !== "string" || !/^[A-Za-z0-9+/=_-]{40,64}$/.test(publicKey)) return false;
    if (acc.identity?.publicKey === publicKey) return true;
    acc.identity = { publicKey, updatedAt: now };
    this.addAudit(accountId, "identity-set", {}, now);
    this.persist();
    return true;
  }

  /** Open sessions (valid tokens), for one account or all of them. */
  sessionCount(accountId?: string, now = Date.now()): number {
    this.load();
    let n = 0;
    for (const s of this.sessions.values()) if (s.expiresAt >= now && (!accountId || s.accountId === accountId)) n += 1;
    return n;
  }

  /** Whether the session behind `hash` is still valid. */
  sessionAlive(hash: string, now = Date.now()): boolean {
    this.load();
    const s = this.sessions.get(hash);
    return Boolean(s && s.expiresAt >= now && this.accounts.has(s.accountId));
  }

  /** Sockets that authenticated with a token listen here to end with it. */
  onRevoke(listener: RevokeListener): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  private emitRevoke(accountId: string, hash: string | null, reason: Parameters<RevokeListener>[2]): void {
    for (const listener of this.revokeListeners) {
      try { listener(accountId, hash, reason); } catch (err) { console.warn(`[accounts] revoke listener failed: ${(err as Error).message}`); }
    }
  }

  /** Where summary() reads the mailbox size once the offline queue runs. */
  setQueueStats(fn: ((accountId: string) => { pending: number; bytes: number }) | null): void {
    this.queueStats = fn;
  }

  /* --------------------------------------------------------------- vault */

  getVault(accountId: string): VaultFile {
    if (!this.get(accountId)) return {};
    return vaultBackend?.read(accountId) ?? this.read<VaultFile>(this.vaultPath(accountId), {});
  }

  putVault(
    accountId: string,
    patch: { profile?: string; chat?: { ct: string; messages: number; messageBytes: number; rooms: number } },
    now = Date.now(),
  ): { ok: true } | { ok: false; reason: string } {
    const acc = this.get(accountId);
    if (!acc) return { ok: false, reason: "unknown account" };
    const b64 = /^[A-Za-z0-9+/=]+$/;
    if (patch.profile !== undefined && (typeof patch.profile !== "string" || !b64.test(patch.profile) || patch.profile.length > ACCOUNT_LIMITS.maxProfileChars)) {
      return { ok: false, reason: "profile ciphertext invalid or too large" };
    }
    if (patch.chat !== undefined && (typeof patch.chat.ct !== "string" || !b64.test(patch.chat.ct) || patch.chat.ct.length > ACCOUNT_LIMITS.maxChatChars)) {
      return { ok: false, reason: "chat ciphertext invalid or too large" };
    }
    const vault = this.getVault(accountId);
    if (patch.profile !== undefined) {
      vault.profile = { ct: patch.profile, updatedAt: now };
      acc.vault.profileBytes = patch.profile.length;
      acc.vault.profileUpdatedAt = now;
    }
    if (patch.chat !== undefined) {
      vault.chat = { ct: patch.chat.ct, updatedAt: now };
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
      acc.vault.chatBytes = patch.chat.ct.length;
      acc.vault.chatUpdatedAt = now;
      acc.vault.messages = n(patch.chat.messages);
      acc.vault.messageBytes = n(patch.chat.messageBytes);
      acc.vault.rooms = n(patch.chat.rooms);
    }
    // The user's own encrypted database when it is open, the file otherwise.
    if (!vaultBackend?.write(accountId, vault)) this.write(this.vaultPath(accountId), vault);
    this.persist();
    return { ok: true };
  }

  /* ------------------------------------------------------------- mailbox */

  mailbox(accountId: string, room?: string): MailItem[] {
    if (!this.get(accountId)) return [];
    const items = this.read<{ items?: MailItem[] }>(this.mailboxPath(accountId), {}).items ?? [];
    return room === undefined ? items : items.filter((i) => i.room === room);
  }

  addMail(accountId: string, item: Omit<MailItem, "id" | "storedAt" | "bytes">, now = Date.now()): { ok: true; item: MailItem } | { ok: false; reason: string } {
    if (!this.get(accountId)) return { ok: false, reason: "unknown account" };
    const bytes = JSON.stringify(item).length;
    if (bytes > ACCOUNT_LIMITS.maxItemBytes) return { ok: false, reason: "message too large for the mailbox" };
    const items = this.mailbox(accountId);
    const total = items.reduce((a, i) => a + i.bytes, 0);
    if (items.length >= ACCOUNT_LIMITS.maxMailboxItems || total + bytes > ACCOUNT_LIMITS.maxMailboxBytes) {
      return { ok: false, reason: "mailbox full" };
    }
    const full: MailItem = { ...item, id: randomBytes(12).toString("base64url"), storedAt: now, bytes };
    items.push(full);
    this.write(this.mailboxPath(accountId), { items });
    return { ok: true, item: full };
  }

  /** Removes the given items (the client acknowledged them) and returns them. */
  takeMail(accountId: string, ids: string[]): MailItem[] {
    const want = new Set(ids);
    const items = this.mailbox(accountId);
    const taken = items.filter((i) => want.has(i.id));
    if (taken.length) this.write(this.mailboxPath(accountId), { items: items.filter((i) => !want.has(i.id)) });
    return taken;
  }

  mailboxStats(accountId: string): { pending: number; bytes: number } {
    const items = this.mailbox(accountId);
    return { pending: items.length, bytes: items.reduce((a, i) => a + i.bytes, 0) };
  }

  /* ---------------------------------------------------------------- away */

  setAway(accountId: string, room: string, name: string, now = Date.now()): void {
    const acc = this.get(accountId);
    if (!acc) return;
    acc.away = acc.away.filter((a) => a.room !== room);
    acc.away.push({ room, name: name.slice(0, 48), since: now });
    if (acc.away.length > ACCOUNT_LIMITS.maxAwayRooms) acc.away.splice(0, acc.away.length - ACCOUNT_LIMITS.maxAwayRooms);
    this.addAudit(accountId, "away", { room }, now);
    this.persist();
  }

  clearAway(accountId: string, room: string, now = Date.now()): boolean {
    const acc = this.get(accountId);
    if (!acc || !acc.away.some((a) => a.room === room)) return false;
    acc.away = acc.away.filter((a) => a.room !== room);
    this.addAudit(accountId, "back", { room }, now);
    this.persist();
    return true;
  }

  /** Signed out for good: no longer away anywhere. Returns the rooms. */
  clearAllAway(accountId: string, now = Date.now()): string[] {
    const acc = this.get(accountId);
    if (!acc || acc.away.length === 0) return [];
    const rooms = acc.away.map((a) => a.room);
    acc.away = [];
    this.addAudit(accountId, "away-cleared", { rooms: rooms.length }, now);
    this.persist();
    return rooms;
  }

  /** The relay's record of an away room: cheap, written to disk shortly. */
  noteAway(accountId: string, room: string, name: string, since = Date.now()): void {
    const acc = this.get(accountId);
    if (!acc) return;
    acc.away = acc.away.filter((a) => a.room !== room);
    acc.away.push({ room, name: name.slice(0, 48), since });
    if (acc.away.length > ACCOUNT_LIMITS.maxAwayRooms) acc.away.splice(0, acc.away.length - ACCOUNT_LIMITS.maxAwayRooms);
    this.persistSoon();
  }

  noteBack(accountId: string, room: string): void {
    const acc = this.get(accountId);
    if (!acc || !acc.away.some((a) => a.room === room)) return;
    acc.away = acc.away.filter((a) => a.room !== room);
    this.persistSoon();
  }

  /** Every away record, to restore the relay after a restart. */
  allAway(): Array<{ accountId: string; room: string; name: string; since: number }> {
    this.load();
    const out: Array<{ accountId: string; room: string; name: string; since: number }> = [];
    for (const acc of this.accounts.values()) for (const a of acc.away) out.push({ accountId: acc.id, room: a.room, name: a.name, since: a.since });
    return out;
  }

  isAway(accountId: string, room: string): boolean {
    return Boolean(this.get(accountId)?.away.some((a) => a.room === room));
  }

  awayInRoom(room: string): Array<{ accountId: string; name: string; since: number }> {
    this.load();
    const out: Array<{ accountId: string; name: string; since: number }> = [];
    for (const acc of this.accounts.values()) {
      const a = acc.away.find((x) => x.room === room);
      if (a) out.push({ accountId: acc.id, name: a.name, since: a.since });
    }
    return out;
  }

  /* ---------------------------------------------------------------- push */

  addPush(accountId: string, target: Omit<PushTarget, "createdAt">, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    const acc = this.get(accountId);
    if (!acc) return { ok: false, reason: "unknown account" };
    if (typeof target.endpoint !== "string" || !target.endpoint.startsWith("https://") || target.endpoint.length > 512) return { ok: false, reason: "invalid endpoint" };
    if (typeof target.keys?.p256dh !== "string" || typeof target.keys?.auth !== "string") return { ok: false, reason: "invalid keys" };
    acc.push = acc.push.filter((p) => p.endpoint !== target.endpoint);
    acc.push.push({ endpoint: target.endpoint, keys: { p256dh: target.keys.p256dh.slice(0, 256), auth: target.keys.auth.slice(0, 128) }, createdAt: now });
    if (acc.push.length > ACCOUNT_LIMITS.maxPush) acc.push.splice(0, acc.push.length - ACCOUNT_LIMITS.maxPush);
    this.addAudit(accountId, "push-linked", { devices: acc.push.length }, now);
    this.persist();
    return { ok: true };
  }

  removePushEndpoint(accountId: string, endpoint: string): void {
    const acc = this.get(accountId);
    if (!acc) return;
    const before = acc.push.length;
    acc.push = acc.push.filter((p) => p.endpoint !== endpoint);
    if (acc.push.length !== before) this.persist();
  }

  /* -------------------------------------------------------------- delete */

  deleteAccount(accountId: string): boolean {
    const acc = this.get(accountId);
    if (!acc) return false;
    this.accounts.delete(accountId);
    this.byCredential.delete(acc.credential.credentialId);
    for (const extra of acc.credentials ?? []) this.byCredential.delete(extra.credentialId);
    this.revokeAll(accountId, "deleted");
    vaultBackend?.erase(accountId);
    this.remove(this.vaultPath(accountId));
    this.remove(this.mailboxPath(accountId));
    this.persist();
    return true;
  }

  /* ----------------------------------------------------------- retention */

  /** Drops mailbox items and audit entries older than their cutoffs, and
   *  expired session tokens. Returns what went. */
  prune(cutoffs: { mailbox: number; audit: number }, now = Date.now()): { mailboxItems: number; auditEntries: number; tokens: number } {
    this.load();
    let mailboxItems = 0;
    let auditEntries = 0;
    let tokens = 0;
    for (const [k, s] of this.sessions) if (s.expiresAt < now || now - s.createdAt > ACCOUNT_LIMITS.tokenMaxAgeMs) { this.sessions.delete(k); tokens++; }
    if (tokens) this.persistSessionsSoon(true);
    let dirty = false;
    for (const acc of this.accounts.values()) {
      const before = acc.audit.length;
      acc.audit = acc.audit.filter((e) => e.at >= cutoffs.audit);
      if (acc.audit.length !== before) { auditEntries += before - acc.audit.length; dirty = true; }
      const items = this.mailbox(acc.id);
      const kept = items.filter((i) => i.storedAt >= cutoffs.mailbox);
      if (kept.length !== items.length) {
        mailboxItems += items.length - kept.length;
        this.write(this.mailboxPath(acc.id), { items: kept });
      }
    }
    if (dirty) this.persist();
    return { mailboxItems, auditEntries, tokens };
  }

  /** What /api/account/me shows (never the key material or tokens).
   *  `currentHash` marks the caller's own session in the list. */
  summary(accountId: string, currentHash?: string) {
    const acc = this.get(accountId);
    if (!acc) return null;
    return {
      passkeys: [
        { credentialId: acc.credential.credentialId, alg: acc.credential.alg, createdAt: acc.createdAt, lastUsedAt: acc.lastLoginAt, label: "", primary: true },
        ...(acc.credentials ?? []).map((c) => ({ credentialId: c.credentialId, alg: c.alg, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, label: c.label, primary: false })),
      ],
      recovery: acc.recovery ? { set: true, createdAt: acc.recovery.createdAt } : { set: false },
      identity: acc.identity ?? null,
      sessions: this.listSessions(acc.id, currentHash),
      id: acc.id,
      credentialId: acc.credential.credentialId,
      alg: acc.credential.alg,
      userName: acc.userName,
      createdAt: acc.createdAt,
      lastLoginAt: acc.lastLoginAt,
      loginCount: acc.loginCount,
      vault: { ...acc.vault },
      mailbox: this.queueStats ? this.queueStats(acc.id) : this.mailboxStats(acc.id),
      away: acc.away.map((a) => ({ ...a })),
      pushDevices: acc.push.length,
      audit: acc.audit.slice(-60).reverse(),
    };
  }
}

export const accountStore = new AccountStore();
