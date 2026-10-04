// The public part of a user's profile (6.7) — what its owner marked
// "public": stored here and readable by anyone who looks the user up by
// username. Everything else of the profile stays with the user (sealed in
// the vault, or end-to-end encrypted to room members); this server never
// sees it.
//
//   GET    /api/profile/:username     the public profile (anyone)          404 when none
//   GET    /api/profile               my own, as stored                    (Bearer)
//   PUT    /api/profile               {profile} → checked, images re-checked
//                                     and stripped of metadata, stored      (Bearer)
//   DELETE /api/profile               withdraw it                          (Bearer)
//
//   Console (moderation, behind the admin guard):
//   GET    /api/admin/users/:id/public-profile
//   DELETE /api/admin/users/:id/public-profile
//
//   $ACCOUNTS_DIR/profiles/<id>.json   one file per account (0600)
//
// A missing profile and a missing account answer the same 404, so the lookup
// tells no more than what is public. Publishing, withdrawing and the console's
// removal are audited with sizes and counts — never the content. Deleting the
// account deletes its public profile (the store's revoke event, both for the
// user's own delete and the console's).

import type { Express, NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { audit } from "../monitor/audit";
import { accountsDir, accountStore as defaultAccounts, usernameOf, type AccountRecord, type AccountStore } from "./store";
import { adminName, requireAdmin } from "../admin-auth";
import { clientInfo } from "./routes";
import { isEmptyView, normalizeShared, PROFILE_LIMITS, SHARED_PROFILE_MAX_CHARS, type SharedProfile } from "../../client/src/lib/profile/model";
import { checkImageDataUrl } from "../../client/src/lib/profile/image";

export type StoredPublicProfile = { profile: SharedProfile; updatedAt: number };

const ID = /^[A-Za-z0-9_-]{10,64}$/;

export class PublicProfileStore {
  /** Files the disk refused (read-only install): kept in memory instead. */
  private memory = new Map<string, StoredPublicProfile | null>();

  constructor(private readonly dir: string = join(accountsDir(), "profiles")) {}

  private path(id: string): string { return join(this.dir, `${id}.json`); }

  get(accountId: string): StoredPublicProfile | null {
    if (!ID.test(accountId)) return null;
    if (this.memory.has(accountId)) return this.memory.get(accountId) ?? null;
    try {
      const raw = JSON.parse(readFileSync(this.path(accountId), "utf8")) as { profile?: unknown; updatedAt?: unknown };
      const profile = normalizeShared(raw.profile);
      return profile ? { profile, updatedAt: Number(raw.updatedAt) || 0 } : null;
    } catch { return null; }
  }

  put(accountId: string, profile: SharedProfile, now = Date.now()): StoredPublicProfile | null {
    if (!ID.test(accountId)) return null;
    const stored: StoredPublicProfile = { profile, updatedAt: now };
    const path = this.path(accountId);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
      renameSync(tmp, path);
      this.memory.delete(accountId);
    } catch {
      this.memory.set(accountId, stored);
    }
    return stored;
  }

  remove(accountId: string): boolean {
    if (!ID.test(accountId)) return false;
    const had = this.get(accountId) !== null;
    this.memory.set(accountId, null);
    try { rmSync(this.path(accountId), { force: true }); this.memory.delete(accountId); } catch { /* read-only: the memory entry hides it */ }
    return had;
  }
}

export const publicProfiles = new PublicProfileStore();

/**
 * A PUT body's profile, as the server will keep and serve it: the shared
 * normalizer (values checked per type, sizes capped), then every image
 * checked against its real format and re-written without metadata.
 */
export function checkPublicProfile(input: unknown): { ok: true; profile: SharedProfile } | { ok: false; code: string; message: string } {
  if (!input || typeof input !== "object") return { ok: false, code: "invalid", message: "A profile is required." };
  if (JSON.stringify(input).length > SHARED_PROFILE_MAX_CHARS) return { ok: false, code: "too-large", message: "The profile is too large." };
  const raw = input as { avatar?: unknown; cover?: unknown };
  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  const avatar = given(raw.avatar) ? checkImageDataUrl(raw.avatar, PROFILE_LIMITS.avatarBytes) : "";
  const cover = given(raw.cover) ? checkImageDataUrl(raw.cover, PROFILE_LIMITS.coverBytes) : "";
  if (given(raw.avatar) && !avatar) return { ok: false, code: "bad-image", message: "The photo is not a JPEG, PNG or WebP within the size limit." };
  if (given(raw.cover) && !cover) return { ok: false, code: "bad-image", message: "The background is not a JPEG, PNG or WebP within the size limit." };
  const profile = normalizeShared({ ...(input as object), ...(avatar ? { avatar } : {}), ...(cover ? { cover } : {}) });
  if (!profile) return { ok: false, code: "invalid", message: "Not a profile." };
  if (isEmptyView(profile)) return { ok: false, code: "empty", message: "Nothing public in it; withdraw it instead (DELETE)." };
  return { ok: true, profile };
}

/** Sizes and counts for the journal — never what the profile says. */
function shape(p: SharedProfile): Record<string, number | boolean> {
  return {
    nickname: Boolean(p.nickname), about: Boolean(p.about), avatar: Boolean(p.avatar), cover: Boolean(p.cover),
    fields: p.fields.length, chars: JSON.stringify(p).length,
  };
}

type AuthedRequest = Request & { account?: AccountRecord };

export function registerPublicProfileRoutes(app: Express, accounts: AccountStore = defaultAccounts, store: PublicProfileStore = publicProfiles): void {
  // Deleting an account (the user's own delete, or the console's) withdraws its profile.
  accounts.onRevoke((accountId, _hash, reason) => { if (reason === "deleted") store.remove(accountId); });

  const lookupLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many profile lookups; wait a moment." } });
  const writeLimiter = rateLimit({
    windowMs: 10 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `acc:${(req as AuthedRequest).account?.id ?? "?"}`,
    message: { ok: false, message: "Too many profile changes; wait a few minutes." },
  });

  const requireAccount = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const account = token ? accounts.resolveToken(token) : null;
    if (!account) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="m5cet-account"');
      return res.status(401).json({ ok: false, code: "signed-out", message: "Sign in with your passkey first." });
    }
    req.account = account;
    next();
  };

  const journal = (req: Request, event: string, accountId: string, detail: Record<string, unknown>, level: "info" | "notice" = "info") => {
    audit.add({ category: "account", level, event, accountId, actor: accountId, ip: clientInfo(req).ip, detail: { client: clientInfo(req).client, ...detail } });
  };

  /** The account a username names (since 4.0 the id; older accounts too), case-insensitively. */
  const byUsername = (name: string): AccountRecord | null => {
    if (!ID.test(name)) return null;
    const exact = accounts.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    return accounts.all().find((a) => usernameOf(a).toLowerCase() === lower) ?? null;
  };

  app.get("/api/profile/:username", lookupLimiter, (req: Request, res: Response) => {
    const account = byUsername(String(req.params.username));
    const stored = account ? store.get(account.id) : null;
    // A withdrawn profile must vanish at once: nobody caches it.
    res.setHeader("Cache-Control", "no-store");
    if (!account || !stored) return res.status(404).json({ ok: false, code: "no-profile", message: "No public profile." });
    // The account's public signing key (if it set one): a viewer who met the
    // user in a room compares it with the key that signed their messages.
    res.json({ ok: true, username: usernameOf(account), profile: stored.profile, updatedAt: stored.updatedAt, ...(account.identity?.publicKey ? { accountKey: account.identity.publicKey } : {}) });
  });

  app.get("/api/profile", requireAccount, (req: AuthedRequest, res: Response) => {
    const stored = store.get(req.account!.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, username: usernameOf(req.account!), profile: stored?.profile ?? null, updatedAt: stored?.updatedAt ?? 0 });
  });

  app.put("/api/profile", requireAccount, writeLimiter, (req: AuthedRequest, res: Response) => {
    const account = req.account!;
    const checked = checkPublicProfile(((req.body || {}) as { profile?: unknown }).profile);
    if (!checked.ok) {
      journal(req, "account.profile.refused", account.id, { code: checked.code });
      return res.status(checked.code === "too-large" ? 413 : 400).json({ ok: false, code: checked.code, message: checked.message });
    }
    const stored = store.put(account.id, checked.profile);
    if (!stored) return res.status(400).json({ ok: false, code: "invalid", message: "Unknown account." });
    accounts.addAudit(account.id, "profile-published", { fields: checked.profile.fields.length, images: Number(Boolean(checked.profile.avatar)) + Number(Boolean(checked.profile.cover)) });
    journal(req, "account.profile.published", account.id, shape(checked.profile), "notice");
    res.json({ ok: true, username: usernameOf(account), profile: stored.profile, updatedAt: stored.updatedAt });
  });

  app.delete("/api/profile", requireAccount, writeLimiter, (req: AuthedRequest, res: Response) => {
    const account = req.account!;
    const had = store.remove(account.id);
    if (had) {
      accounts.addAudit(account.id, "profile-withdrawn");
      journal(req, "account.profile.withdrawn", account.id, {}, "notice");
    }
    res.json({ ok: true, removed: had });
  });

  /* ------------------------------------------------------------ console */

  // Behind the /api/admin guard (admin-api.ts) and, to be explicit, a role.
  app.get("/api/admin/users/:id/public-profile", requireAdmin("auditor"), (req: Request, res: Response) => {
    const id = String(req.params.id);
    const stored = accounts.get(id) ? store.get(id) : null;
    if (!stored) return res.status(404).json({ ok: false, message: "No public profile." });
    res.json({ ok: true, profile: stored.profile, updatedAt: stored.updatedAt });
  });

  app.delete("/api/admin/users/:id/public-profile", requireAdmin("operator"), (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!accounts.get(id)) return res.status(404).json({ ok: false, message: "Unknown account." });
    const had = store.remove(id);
    if (!had) return res.status(404).json({ ok: false, message: "No public profile." });
    accounts.addAudit(id, "profile-removed-by-operator");
    audit.add({ category: "admin", level: "notice", event: "admin.user.profile-removed", actor: adminName(req), target: id, accountId: id });
    res.json({ ok: true });
  });
}
