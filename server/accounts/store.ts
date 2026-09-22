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
// Session tokens are random, shown to the client once, kept only as SHA-256
// hashes and only in memory (a restart signs everyone out; sign in again).

import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  tokenTtlMs: 12 * 60 * 60 * 1000,
} as const;

export type AuditEntry = { at: number; kind: string; meta?: Record<string, string | number | boolean> };

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string }; createdAt: number };

export type AccountRecord = {
  id: string;
  credential: StoredCredential;
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
type Session = { accountId: string; createdAt: number; expiresAt: number };

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

  constructor(private readonly dir: string = accountsDir()) {}

  private write(path: string, value: unknown): void {
    try {
      writeJsonAtomic(path, value);
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
  private vaultPath(id: string) { return join(this.dir, "vault", `${id}.json`); }
  private mailboxPath(id: string) { return join(this.dir, "mailbox", `${id}.json`); }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      accessSync(this.dir, fsConstants.W_OK);
    } catch (err) {
      this.writeError = (err as Error).message;
    }
    const data = readJson<{ accounts?: Record<string, AccountRecord> }>(this.indexPath(), {});
    for (const rec of Object.values(data.accounts ?? {})) {
      if (!rec || typeof rec.id !== "string" || !rec.credential?.credentialId) continue;
      rec.push ??= [];
      rec.away ??= [];
      rec.audit ??= [];
      this.accounts.set(rec.id, rec);
      this.byCredential.set(rec.credential.credentialId, rec.id);
    }
  }

  private persist() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    this.write(this.indexPath(), { v: 1, accounts: Object.fromEntries(this.accounts) });
  }

  /** Audit lines are frequent (one per relayed message): coalesce their writes. */
  private persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, 400);
    this.persistTimer.unref?.();
  }

  /** Writes pending changes now (tests, shutdown). */
  flush(): void {
    if (this.persistTimer) this.persist();
  }

  get size(): number { this.load(); return this.accounts.size; }

  get(accountId: string): AccountRecord | null {
    this.load();
    return ID.test(accountId) ? this.accounts.get(accountId) ?? null : null;
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

  recordSignIn(accountId: string, signCount: number, meta: AuditEntry["meta"], now = Date.now()): void {
    const acc = this.get(accountId);
    if (!acc) return;
    acc.credential.signCount = signCount;
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

  issueToken(accountId: string, now = Date.now()): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(sha256hex(token), { accountId, createdAt: now, expiresAt: now + ACCOUNT_LIMITS.tokenTtlMs });
    return token;
  }

  resolveToken(token: unknown, now = Date.now()): AccountRecord | null {
    if (typeof token !== "string" || token.length < 20 || token.length > 128) return null;
    const key = sha256hex(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt < now) { this.sessions.delete(key); return null; }
    return this.get(s.accountId);
  }

  revokeToken(token: string): void {
    this.sessions.delete(sha256hex(token));
  }

  revokeAll(accountId: string): void {
    for (const [k, s] of this.sessions) if (s.accountId === accountId) this.sessions.delete(k);
  }

  /* --------------------------------------------------------------- vault */

  getVault(accountId: string): VaultFile {
    return this.get(accountId) ? this.read<VaultFile>(this.vaultPath(accountId), {}) : {};
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
    this.write(this.vaultPath(accountId), vault);
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
    this.revokeAll(accountId);
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
    for (const [k, s] of this.sessions) if (s.expiresAt < now) { this.sessions.delete(k); tokens++; }
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

  /** What /api/account/me shows (never the key material or tokens). */
  summary(accountId: string) {
    const acc = this.get(accountId);
    if (!acc) return null;
    return {
      id: acc.id,
      credentialId: acc.credential.credentialId,
      alg: acc.credential.alg,
      userName: acc.userName,
      createdAt: acc.createdAt,
      lastLoginAt: acc.lastLoginAt,
      loginCount: acc.loginCount,
      vault: { ...acc.vault },
      mailbox: this.mailboxStats(acc.id),
      away: acc.away.map((a) => ({ ...a })),
      pushDevices: acc.push.length,
      audit: acc.audit.slice(-60).reverse(),
    };
  }
}

export const accountStore = new AccountStore();
