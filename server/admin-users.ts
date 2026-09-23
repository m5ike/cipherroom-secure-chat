// Who may use the operator console, and as what.
//
//   owner     everything, including managing administrators
//   operator  everything except managing administrators
//   auditor   read-only: every GET, the audit export — no action
//
// Principals come from three places:
//   ADMIN_API_TOKEN   the original single token → "admin", owner (kept, so
//                     an existing installation keeps working)
//   ADMIN_TOKENS      "name:role:token,…" in the environment
//   admin-users.json  administrators the owner created in the console, with
//                     named tokens (hashes only) and passkeys; next to the
//                     other data ($DATA_DIR, 0600)
//
// A token is only ever stored as SHA-256; the one issued in the console is
// shown once. An administrator with a passkey signs in to the console with
// it and gets an 8-hour session token instead of pasting a secret.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StoredCredential } from "./accounts/webauthn";

export type AdminRole = "owner" | "operator" | "auditor";
export type AdminPrincipal = { name: string; role: AdminRole; via: "env-token" | "token" | "passkey" };

export const ROLE_RANK: Record<AdminRole, number> = { auditor: 1, operator: 2, owner: 3 };
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

type StoredToken = { id: string; hash: string; label: string; createdAt: number; lastUsedAt: number };
type AdminPasskey = StoredCredential & { createdAt: number; lastUsedAt: number; label: string };
type AdminUser = { name: string; role: AdminRole; createdAt: number; disabled?: boolean; tokens: StoredToken[]; passkeys: AdminPasskey[] };

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const NAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function isRole(value: unknown): value is AdminRole {
  return value === "owner" || value === "operator" || value === "auditor";
}

export function adminDir(): string {
  const data = process.env.DATA_DIR?.trim();
  return data ? resolve(data) : resolve(process.cwd(), ".m5cet");
}

/** ADMIN_TOKENS="alice:operator:tok1,bob:auditor:tok2" → principals by token hash. */
function envTokens(): Map<string, AdminPrincipal> {
  const out = new Map<string, AdminPrincipal>();
  for (const part of (process.env.ADMIN_TOKENS ?? "").split(",")) {
    const [name, role, ...rest] = part.trim().split(":");
    const token = rest.join(":");
    if (!name || !isRole(role) || token.length < 16) continue;
    out.set(sha256hex(token), { name: name.slice(0, 32), role, via: "env-token" });
  }
  return out;
}

export class AdminDirectory {
  private users = new Map<string, AdminUser>();
  private sessions = new Map<string, { name: string; expiresAt: number }>();
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string = join(adminDir(), "admin-users.json")) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { users?: AdminUser[] };
      for (const u of data.users ?? []) if (u && NAME.test(u.name) && isRole(u.role)) this.users.set(u.name, { ...u, tokens: u.tokens ?? [], passkeys: u.passkeys ?? [] });
    } catch { /* none yet */ }
  }

  private persist(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, users: [...this.users.values()] }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[admin] cannot write ${this.file}: ${(err as Error).message}`);
    }
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persist(), 5_000);
    this.persistTimer.unref?.();
  }

  /** Is any way of signing in configured at all? */
  configured(): boolean {
    this.load();
    return Boolean(process.env.ADMIN_API_TOKEN?.trim()) || envTokens().size > 0 || [...this.users.values()].some((u) => !u.disabled && (u.tokens.length || u.passkeys.length));
  }

  /** Who "Authorization: Bearer <token>" is, or null. */
  authenticate(authorization: string | undefined, now = Date.now()): AdminPrincipal | null {
    this.load();
    const header = authorization ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice(7).trim();
    if (!token || token.length > 256) return null;
    // The original token: whatever length the operator chose.
    const legacy = process.env.ADMIN_API_TOKEN?.trim() || "";
    if (legacy && timingSafeEqual(createHash("sha256").update(token).digest(), createHash("sha256").update(legacy).digest())) {
      return { name: "admin", role: "owner", via: "env-token" };
    }
    if (token.length < 16) return null;
    const hash = sha256hex(token);
    const fromEnv = envTokens().get(hash);
    if (fromEnv) return fromEnv;
    const session = this.sessions.get(hash);
    if (session) {
      const user = this.users.get(session.name);
      if (session.expiresAt > now && user && !user.disabled) return { name: user.name, role: user.role, via: "passkey" };
      this.sessions.delete(hash);
    }
    for (const user of this.users.values()) {
      if (user.disabled) continue;
      const stored = user.tokens.find((t) => t.hash === hash);
      if (stored) {
        stored.lastUsedAt = now;
        this.persistSoon();
        return { name: user.name, role: user.role, via: "token" };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ managing */

  list() {
    this.load();
    return [...this.users.values()].map((u) => ({
      name: u.name, role: u.role, createdAt: u.createdAt, disabled: Boolean(u.disabled),
      tokens: u.tokens.map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
      passkeys: u.passkeys.map((p) => ({ credentialId: p.credentialId, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })),
    }));
  }

  get(name: string): AdminUser | null {
    this.load();
    return this.users.get(name) ?? null;
  }

  create(name: string, role: AdminRole, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    this.load();
    if (!NAME.test(name)) return { ok: false, reason: "name: 2–32 characters a–z, 0–9, . _ -" };
    if (name === "admin" || this.users.has(name)) return { ok: false, reason: "that name is taken" };
    if (this.users.size >= 100) return { ok: false, reason: "too many administrators" };
    this.users.set(name, { name, role, createdAt: now, tokens: [], passkeys: [] });
    this.persist();
    return { ok: true };
  }

  update(name: string, patch: { role?: AdminRole; disabled?: boolean }): boolean {
    const user = this.get(name);
    if (!user) return false;
    if (patch.role) user.role = patch.role;
    if (typeof patch.disabled === "boolean") user.disabled = patch.disabled;
    if (user.disabled) for (const [hash, s] of this.sessions) if (s.name === name) this.sessions.delete(hash);
    this.persist();
    return true;
  }

  remove(name: string): boolean {
    this.load();
    const removed = this.users.delete(name);
    for (const [hash, s] of this.sessions) if (s.name === name) this.sessions.delete(hash);
    if (removed) this.persist();
    return removed;
  }

  /** A new token for `name`, returned once. */
  issueToken(name: string, label: string, now = Date.now()): string | null {
    const user = this.get(name);
    if (!user) return null;
    const token = `m5a_${randomBytes(24).toString("base64url")}`;
    user.tokens = [...user.tokens, { id: randomBytes(6).toString("hex"), hash: sha256hex(token), label: label.slice(0, 40) || "token", createdAt: now, lastUsedAt: 0 }].slice(-10);
    this.persist();
    return token;
  }

  revokeToken(name: string, id: string): boolean {
    const user = this.get(name);
    if (!user) return false;
    const before = user.tokens.length;
    user.tokens = user.tokens.filter((t) => t.id !== id);
    if (user.tokens.length !== before) this.persist();
    return user.tokens.length !== before;
  }

  /* ------------------------------------------------------------ passkeys */

  addPasskey(name: string, credential: StoredCredential, label: string, now = Date.now()): boolean {
    const user = this.get(name);
    if (!user || this.byCredential(credential.credentialId)) return false;
    user.passkeys = [...user.passkeys, { ...credential, createdAt: now, lastUsedAt: 0, label: label.slice(0, 40) || "passkey" }].slice(-10);
    this.persist();
    return true;
  }

  removePasskey(name: string, credentialId: string): boolean {
    const user = this.get(name);
    if (!user) return false;
    const before = user.passkeys.length;
    user.passkeys = user.passkeys.filter((p) => p.credentialId !== credentialId);
    if (user.passkeys.length !== before) this.persist();
    return user.passkeys.length !== before;
  }

  byCredential(credentialId: string): { user: AdminUser; passkey: AdminPasskey } | null {
    this.load();
    for (const user of this.users.values()) {
      const passkey = user.passkeys.find((p) => p.credentialId === credentialId);
      if (passkey) return { user, passkey };
    }
    return null;
  }

  /** After a verified passkey assertion: an 8-hour console session. */
  passkeySignIn(credentialId: string, signCount: number, now = Date.now()): { token: string; principal: AdminPrincipal } | null {
    const found = this.byCredential(credentialId);
    if (!found || found.user.disabled) return null;
    found.passkey.signCount = signCount;
    found.passkey.lastUsedAt = now;
    this.persist();
    const token = `m5s_${randomBytes(32).toString("base64url")}`;
    this.sessions.set(sha256hex(token), { name: found.user.name, expiresAt: now + ADMIN_SESSION_TTL_MS });
    if (this.sessions.size > 1_000) this.sessions.delete(this.sessions.keys().next().value!);
    return { token, principal: { name: found.user.name, role: found.user.role, via: "passkey" } };
  }

  endSession(authorization: string | undefined): void {
    const token = (authorization ?? "").replace(/^Bearer\s+/, "");
    this.sessions.delete(sha256hex(token));
  }
}

export const adminDirectory = new AdminDirectory();
