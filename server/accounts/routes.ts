// Passkey accounts — REST API of the main service.
//
//   GET    /api/account/status             is this server offering accounts?
//   POST   /api/account/register/options   challenge + creation options
//   POST   /api/account/register/verify    attestation → account + session token
//   POST   /api/account/signin/options     challenge (discoverable credentials)
//   POST   /api/account/signin/verify      signed assertion → session token
//   GET    /api/account/me                 summary: sizes, dates, counts, audit   (Bearer)
//   GET    /api/account/vault              encrypted profile + chat blobs         (Bearer)
//   PUT    /api/account/vault              store encrypted blobs                  (Bearer)
//   POST   /api/account/event              client-reported: decrypt-ok / -failed,
//                                          data-loaded / data-cleared             (Bearer)
//   POST   /api/account/push               link this device's Web Push endpoint   (Bearer)
//   POST   /api/account/signout            revoke this token                      (Bearer)
//   DELETE /api/account                    delete account, vault and mailbox      (Bearer)
//
// Challenges are random, single-use and expire after 2 minutes; the one a
// response answers is read from its clientDataJSON and must have been issued
// for that ceremony. rpId: WEBAUTHN_RP_ID, else the PUBLIC_BASE_URL host,
// else the request host. Origins: WEBAUTHN_ORIGINS (exact list) or any https
// origin on the rpId (+ http://localhost for development).

import { randomBytes } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { eventStore } from "../events";
import { ACCOUNT_LIMITS, accountStore as defaultStore, type AccountRecord, type AccountStore } from "./store";
import {
  SUPPORTED_ALGS, b64urlToBuffer, verifyAssertion, verifyRegistration,
  type AssertionResponseJSON, type RegistrationResponseJSON, type RpPolicy,
} from "./webauthn";

const env = (name: string) => process.env[name]?.trim() || "";
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

type Purpose = "register" | "signin";
class Challenges {
  private map = new Map<string, { purpose: Purpose; at: number; userName?: string }>();
  issue(purpose: Purpose, userName?: string): string {
    const now = Date.now();
    for (const [k, v] of this.map) if (now - v.at > CHALLENGE_TTL_MS) this.map.delete(k);
    if (this.map.size > 10_000) this.map.clear();
    const c = randomBytes(32).toString("base64url");
    this.map.set(c, { purpose, at: now, userName });
    return c;
  }
  /** Consumes the challenge if it was issued for `purpose` and is still fresh. */
  take(challenge: string, purpose: Purpose): { userName?: string } | null {
    const v = this.map.get(challenge);
    this.map.delete(challenge);
    if (!v || v.purpose !== purpose || Date.now() - v.at > CHALLENGE_TTL_MS) return null;
    return { userName: v.userName };
  }
}

export function rpPolicyFor(req: Request): RpPolicy {
  const origins = env("WEBAUTHN_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
  let rpId = env("WEBAUTHN_RP_ID");
  if (!rpId && env("PUBLIC_BASE_URL")) {
    try { rpId = new URL(env("PUBLIC_BASE_URL")).hostname; } catch { rpId = ""; }
  }
  if (!rpId) rpId = req.hostname;
  return { rpId, origins };
}

function challengeOf(clientDataJSON: unknown): string {
  try {
    const data = JSON.parse(b64urlToBuffer(String(clientDataJSON)).toString("utf8")) as { challenge?: unknown };
    return typeof data.challenge === "string" ? data.challenge.replace(/=+$/, "") : "";
  } catch {
    return "";
  }
}

/** Coarse client info for the sign-in log: truncated IP, browser + OS family. */
export function clientInfo(req: Request): Record<string, string> {
  const ip = String(req.ip || "");
  const truncated = ip.includes(":") ? `${ip.split(":").slice(0, 3).join(":")}::/48` : ip.replace(/\.\d+$/, ".0/24");
  const ua = String(req.header("user-agent") || "");
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "other";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "other";
  return { ip: truncated, client: `${browser}/${os}` };
}

type AuthedRequest = Request & { account?: AccountRecord; token?: string };

const CLIENT_EVENTS = new Set(["decrypt-ok", "decrypt-failed", "data-loaded", "data-cleared", "chat-restored"]);

export type AccountHooks = {
  /** Signed out or deleted: stop answering for the account (away relay). */
  onSignOut?: (accountId: string) => void;
};

export function registerAccountRoutes(app: Express, store: AccountStore = defaultStore, hooks: AccountHooks = {}): void {
  const challenges = new Challenges();
  const lastSaveAudit = new Map<string, number>();
  const ceremonyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, message: "Too many sign-in attempts; wait a few minutes." },
  });

  const requireAccount = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const account = store.resolveToken(token);
    if (!account) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="m5cet-account"');
      return res.status(401).json({ ok: false, message: "Sign in with your passkey first." });
    }
    req.account = account;
    req.token = token;
    next();
  };

  app.get("/api/account/status", (req: Request, res: Response) => {
    const s = store.status();
    res.json({
      ok: true,
      available: true,
      // False on a read-only install: accounts work but do not survive a restart.
      persistent: s.persistent,
      rpId: rpPolicyFor(req).rpId,
      accounts: store.size,
      limits: { profileChars: ACCOUNT_LIMITS.maxProfileChars, chatChars: ACCOUNT_LIMITS.maxChatChars, mailboxItems: ACCOUNT_LIMITS.maxMailboxItems },
    });
  });

  /* ----------------------------------------------------------- register */

  app.post("/api/account/register/options", ceremonyLimiter, (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const userName = typeof body.userName === "string" && body.userName.trim() ? body.userName.trim().slice(0, 64) : "M5cet";
    const policy = rpPolicyFor(req);
    const challenge = challenges.issue("register", userName);
    res.json({
      ok: true,
      publicKey: {
        challenge,
        rp: { id: policy.rpId, name: "M5cet" },
        user: { id: randomBytes(16).toString("base64url"), name: userName, displayName: userName },
        pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key", alg })),
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
        timeout: 60_000,
      },
    });
  });

  app.post("/api/account/register/verify", ceremonyLimiter, (req: Request, res: Response) => {
    const body = (req.body || {}) as { credential?: RegistrationResponseJSON };
    const credential = body.credential;
    const challenge = challengeOf(credential?.response?.clientDataJSON);
    const issued = challenge ? challenges.take(challenge, "register") : null;
    if (!credential || !issued) return res.status(400).json({ ok: false, message: "Unknown or expired challenge." });
    const r = verifyRegistration({ response: credential, expectedChallenge: challenge, policy: rpPolicyFor(req) });
    if (!r.ok) {
      eventStore.record({ kind: "account-register-failed", meta: { error: r.error.slice(0, 80) } });
      return res.status(400).json({ ok: false, message: `Passkey registration rejected: ${r.error}` });
    }
    const created = store.create(r.credential, issued.userName ?? "M5cet");
    if (!created.ok) return res.status(409).json({ ok: false, message: created.reason });
    store.addAudit(created.account.id, "sign-in", { ...clientInfo(req), via: "register" });
    const token = store.issueToken(created.account.id);
    eventStore.record({ kind: "account-register", meta: { accountId: created.account.id } });
    res.json({ ok: true, token, account: store.summary(created.account.id) });
  });

  /* ------------------------------------------------------------ sign-in */

  app.post("/api/account/signin/options", ceremonyLimiter, (req: Request, res: Response) => {
    const policy = rpPolicyFor(req);
    res.json({ ok: true, publicKey: { challenge: challenges.issue("signin"), rpId: policy.rpId, userVerification: "required", timeout: 60_000 } });
  });

  app.post("/api/account/signin/verify", ceremonyLimiter, (req: Request, res: Response) => {
    const body = (req.body || {}) as { credential?: AssertionResponseJSON };
    const credential = body.credential;
    const challenge = challengeOf(credential?.response?.clientDataJSON);
    const issued = challenge ? challenges.take(challenge, "signin") : null;
    if (!credential || !issued) return res.status(400).json({ ok: false, message: "Unknown or expired challenge." });
    let credentialId = "";
    try { credentialId = b64urlToBuffer(credential.rawId || credential.id).toString("base64url"); } catch { credentialId = ""; }
    const account = credentialId ? store.findByCredential(credentialId) : null;
    if (!account) {
      eventStore.record({ kind: "account-signin-unknown" });
      return res.status(404).json({ ok: false, message: "This passkey has no account on this server." });
    }
    const r = verifyAssertion({ response: credential, expectedChallenge: challenge, policy: rpPolicyFor(req), stored: account.credential });
    if (!r.ok) {
      store.addAudit(account.id, "sign-in-failed", { reason: r.error.slice(0, 60), ...clientInfo(req) });
      return res.status(401).json({ ok: false, message: `Passkey verification failed: ${r.error}` });
    }
    store.recordSignIn(account.id, r.signCount, clientInfo(req));
    const token = store.issueToken(account.id);
    eventStore.record({ kind: "account-signin", meta: { accountId: account.id } });
    res.json({ ok: true, token, account: store.summary(account.id) });
  });

  /* ------------------------------------------------------- authenticated */

  app.get("/api/account/me", requireAccount, (req: AuthedRequest, res: Response) => {
    res.json({ ok: true, account: store.summary(req.account!.id) });
  });

  app.get("/api/account/vault", requireAccount, (req: AuthedRequest, res: Response) => {
    const vault = store.getVault(req.account!.id);
    store.addAudit(req.account!.id, "vault-load", {
      profileBytes: vault.profile?.ct.length ?? 0,
      chatBytes: vault.chat?.ct.length ?? 0,
    });
    res.json({ ok: true, profile: vault.profile ?? null, chat: vault.chat ?? null });
  });

  app.put("/api/account/vault", requireAccount, (req: AuthedRequest, res: Response) => {
    const body = (req.body || {}) as { profile?: unknown; chat?: { ct?: unknown; messages?: unknown; messageBytes?: unknown; rooms?: unknown } };
    const patch: Parameters<AccountStore["putVault"]>[1] = {};
    if (body.profile !== undefined) patch.profile = String(body.profile);
    if (body.chat !== undefined) {
      patch.chat = {
        ct: String(body.chat?.ct ?? ""),
        messages: Number(body.chat?.messages) || 0,
        messageBytes: Number(body.chat?.messageBytes) || 0,
        rooms: Number(body.chat?.rooms) || 0,
      };
    }
    if (!patch.profile && !patch.chat) return res.status(400).json({ ok: false, message: "Nothing to store." });
    const r = store.putVault(req.account!.id, patch);
    if (!r.ok) return res.status(413).json({ ok: false, message: r.reason });
    // One audit line per minute per account, not one per autosave.
    const now = Date.now();
    if (now - (lastSaveAudit.get(req.account!.id) ?? 0) > 60_000) {
      lastSaveAudit.set(req.account!.id, now);
      const a = store.get(req.account!.id)!;
      store.addAudit(a.id, "vault-save", { profileBytes: a.vault.profileBytes, chatBytes: a.vault.chatBytes, messages: a.vault.messages });
    }
    res.json({ ok: true, account: store.summary(req.account!.id) });
  });

  app.post("/api/account/event", requireAccount, (req: AuthedRequest, res: Response) => {
    const body = (req.body || {}) as { kind?: unknown; meta?: unknown };
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!CLIENT_EVENTS.has(kind)) return res.status(400).json({ ok: false, message: "Unknown event kind." });
    const meta: Record<string, string | number | boolean> = {};
    if (body.meta && typeof body.meta === "object") {
      for (const [k, v] of Object.entries(body.meta as Record<string, unknown>).slice(0, 6)) {
        if (!/^[a-zA-Z]{1,24}$/.test(k)) continue;
        if (typeof v === "number" && Number.isFinite(v)) meta[k] = v;
        else if (typeof v === "boolean") meta[k] = v;
        else if (typeof v === "string") meta[k] = v.slice(0, 60);
      }
    }
    store.addAudit(req.account!.id, kind, meta);
    res.json({ ok: true });
  });

  app.post("/api/account/push", requireAccount, (req: AuthedRequest, res: Response) => {
    const sub = ((req.body || {}) as { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }).subscription;
    const r = store.addPush(req.account!.id, {
      endpoint: String(sub?.endpoint ?? ""),
      keys: { p256dh: String(sub?.keys?.p256dh ?? ""), auth: String(sub?.keys?.auth ?? "") },
    });
    if (!r.ok) return res.status(400).json({ ok: false, message: r.reason });
    res.json({ ok: true });
  });

  app.post("/api/account/signout", requireAccount, (req: AuthedRequest, res: Response) => {
    const everywhere = ((req.body || {}) as { everywhere?: unknown }).everywhere === true;
    if (everywhere) store.revokeAll(req.account!.id);
    else store.revokeToken(req.token!);
    store.addAudit(req.account!.id, "sign-out", { ...clientInfo(req), everywhere });
    hooks.onSignOut?.(req.account!.id);
    res.json({ ok: true });
  });

  app.delete("/api/account", requireAccount, (req: AuthedRequest, res: Response) => {
    const id = req.account!.id;
    hooks.onSignOut?.(id);
    store.deleteAccount(id);
    eventStore.record({ kind: "account-deleted", meta: { accountId: id } });
    res.json({ ok: true });
  });
}
