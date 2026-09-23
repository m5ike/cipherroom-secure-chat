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
//   3.1 — several passkeys, a recovery code, sessions, the account key:
//   POST   /api/account/passkeys/options   creation options for one more passkey (Bearer)
//   POST   /api/account/passkeys/verify    attestation + the root sealed for it  (Bearer)
//   DELETE /api/account/passkeys/:id       remove one (never the last)           (Bearer)
//   GET    /api/account/passkeys/:id/wrapped   the root sealed for that passkey  (Bearer)
//   PUT    /api/account/recovery           set the recovery code's id/verifier + sealed root (Bearer)
//   DELETE /api/account/recovery                                                  (Bearer)
//   POST   /api/account/recovery/start     {id, proof} → sealed root + options for a new passkey
//   POST   /api/account/recovery/finish    {ticket, credential, wrapped} → session token
//   GET    /api/account/sessions           this account's sessions (devices)      (Bearer)
//   DELETE /api/account/sessions/:id       end one of them                        (Bearer)
//   PUT    /api/account/identity           the account's public signing key      (Bearer)
//
// Challenges are random, single-use and expire after 2 minutes; the one a
// response answers is read from its clientDataJSON and must have been issued
// for that ceremony. rpId: WEBAUTHN_RP_ID, else the PUBLIC_BASE_URL host,
// else the request host. Origins: WEBAUTHN_ORIGINS (exact list) or any https
// origin on the rpId (+ http://localhost for development).

import { isAllowedPushEndpoint } from "../push";
import { tokenHash } from "./store";
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

type Purpose = "register" | "signin" | "add-passkey" | "recover";
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

export function challengeOf(clientDataJSON: unknown): string {
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
  /** A ceremony succeeded — the storage mirrors it into its tables. */
  onAuthenticated?: (accountId: string, event: "register" | "sign-in", meta: Record<string, string | number | boolean>) => void;
  /** The account was deleted for good. */
  onDeleted?: (accountId: string) => void;
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
    hooks.onAuthenticated?.(created.account.id, "register", clientInfo(req));
    const token = store.issueToken(created.account.id, Date.now(), clientInfo(req));
    eventStore.record({ kind: "account-register", meta: { accountId: created.account.id } });
    res.json({ ok: true, token, account: store.summary(created.account.id, tokenHash(token)) });
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
    const stored = store.credentialOf(account.id, credentialId);
    if (!stored) return res.status(404).json({ ok: false, message: "This passkey has no account on this server." });
    const r = verifyAssertion({ response: credential, expectedChallenge: challenge, policy: rpPolicyFor(req), stored });
    if (!r.ok) {
      store.addAudit(account.id, "sign-in-failed", { reason: r.error.slice(0, 60), ...clientInfo(req) });
      return res.status(401).json({ ok: false, message: `Passkey verification failed: ${r.error}` });
    }
    store.recordSignIn(account.id, r.signCount, clientInfo(req), Date.now(), credentialId);
    hooks.onAuthenticated?.(account.id, "sign-in", clientInfo(req));
    const token = store.issueToken(account.id, Date.now(), clientInfo(req));
    eventStore.record({ kind: "account-signin", meta: { accountId: account.id } });
    // A passkey added later carries the account root sealed for it; the first
    // one does not need it (its PRF output is the root).
    res.json({ ok: true, token, account: store.summary(account.id, tokenHash(token)), wrapped: store.wrappedFor(account.id, credentialId) });
  });

  /* ------------------------------------------------------- authenticated */

  app.get("/api/account/me", requireAccount, (req: AuthedRequest, res: Response) => {
    res.json({ ok: true, account: store.summary(req.account!.id, tokenHash(req.token!)) });
  });

  app.get("/api/account/vault", requireAccount, (req: AuthedRequest, res: Response) => {
    const vault = store.getVault(req.account!.id);
    store.addAudit(req.account!.id, "vault-load", {
      profileBytes: vault.profile?.ct.length ?? 0,
      chatBytes: vault.chat?.ct.length ?? 0,
    });
    res.json({ ok: true, profile: vault.profile ?? null, chat: vault.chat ?? null, connections: vault.connections ?? null });
  });

  app.put("/api/account/vault", requireAccount, (req: AuthedRequest, res: Response) => {
    const body = (req.body || {}) as { profile?: unknown; chat?: { ct?: unknown; messages?: unknown; messageBytes?: unknown; rooms?: unknown }; connections?: { ct?: unknown; count?: unknown } };
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
    if (body.connections !== undefined) {
      patch.connections = { ct: String(body.connections?.ct ?? ""), count: Number(body.connections?.count) || 0 };
    }
    if (!patch.profile && !patch.chat && !patch.connections) return res.status(400).json({ ok: false, message: "Nothing to store." });
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
    // Only real push services: the server will POST to this address.
    if (!isAllowedPushEndpoint(sub?.endpoint)) return res.status(400).json({ ok: false, message: "not a known push service endpoint" });
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
    hooks.onDeleted?.(id);
    eventStore.record({ kind: "account-deleted", meta: { accountId: id } });
    res.json({ ok: true });
  });

  /* ------------------------------------------------------ more passkeys */

  const creationOptions = (req: Request, account: AccountRecord, challenge: string) => {
    const policy = rpPolicyFor(req);
    const all = [account.credential.credentialId, ...(account.credentials ?? []).map((c) => c.credentialId)];
    return {
      challenge,
      rp: { id: policy.rpId, name: "M5cet" },
      user: { id: Buffer.from(account.id).toString("base64url"), name: account.userName, displayName: account.userName },
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key", alg })),
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      excludeCredentials: all.map((id) => ({ type: "public-key", id })),
      attestation: "none",
      timeout: 60_000,
    };
  };

  app.post("/api/account/passkeys/options", ceremonyLimiter, requireAccount, (req: AuthedRequest, res: Response) => {
    const account = req.account!;
    res.json({ ok: true, publicKey: creationOptions(req, account, challenges.issue("add-passkey", account.id)) });
  });

  app.post("/api/account/passkeys/verify", ceremonyLimiter, requireAccount, (req: AuthedRequest, res: Response) => {
    const body = (req.body || {}) as { credential?: RegistrationResponseJSON; wrapped?: { iv: string; ct: string }; label?: string };
    const challenge = challengeOf(body.credential?.response?.clientDataJSON);
    const issued = challenge ? challenges.take(challenge, "add-passkey") : null;
    if (!body.credential || !issued || issued.userName !== req.account!.id) return res.status(400).json({ ok: false, message: "Unknown or expired challenge." });
    const r = verifyRegistration({ response: body.credential, expectedChallenge: challenge, policy: rpPolicyFor(req) });
    if (!r.ok) return res.status(400).json({ ok: false, message: `Passkey registration rejected: ${r.error}` });
    const added = store.addCredential(req.account!.id, r.credential, body.wrapped ?? { iv: "", ct: "" }, String(body.label ?? ""));
    if (!added.ok) return res.status(409).json({ ok: false, message: added.reason });
    hooks.onAuthenticated?.(req.account!.id, "register", { ...clientInfo(req), via: "add-passkey" });
    res.json({ ok: true, account: store.summary(req.account!.id, tokenHash(req.token!)) });
  });

  // The root sealed for one of the account's own passkeys (to confirm with
  // it before adding another passkey or a recovery code). Opaque to us.
  app.get("/api/account/passkeys/:id/wrapped", requireAccount, (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    if (!store.credentialOf(req.account!.id, id)) return res.status(404).json({ ok: false, message: "unknown passkey" });
    res.json({ ok: true, wrapped: store.wrappedFor(req.account!.id, id) });
  });

  app.delete("/api/account/passkeys/:id", requireAccount, (req: AuthedRequest, res: Response) => {
    const removed = store.removeCredential(req.account!.id, String(req.params.id));
    if (!removed.ok) return res.status(400).json({ ok: false, message: removed.reason });
    hooks.onAuthenticated?.(req.account!.id, "register", { via: "remove-passkey" });
    res.json({ ok: true, account: store.summary(req.account!.id, tokenHash(req.token!)) });
  });

  /* ------------------------------------------------------------ recovery */

  // A recovery code is 130 random bits, so guessing is hopeless — this limit
  // is about noise, and about making a stolen id useless without the code.
  const recoveryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many recovery attempts; try again in an hour." } });
  const tickets = new Map<string, { accountId: string; at: number }>();
  const TICKET_TTL_MS = 10 * 60 * 1000;

  app.put("/api/account/recovery", requireAccount, (req: AuthedRequest, res: Response) => {
    const body = (req.body || {}) as { id?: unknown; verifier?: unknown; wrapped?: { iv: string; ct: string } };
    const r = store.setRecovery(req.account!.id, { id: String(body.id ?? ""), verifier: String(body.verifier ?? ""), wrapped: body.wrapped ?? { iv: "", ct: "" } });
    if (!r.ok) return res.status(400).json({ ok: false, message: r.reason });
    res.json({ ok: true, account: store.summary(req.account!.id, tokenHash(req.token!)) });
  });

  app.delete("/api/account/recovery", requireAccount, (req: AuthedRequest, res: Response) => {
    store.clearRecovery(req.account!.id);
    res.json({ ok: true, account: store.summary(req.account!.id, tokenHash(req.token!)) });
  });

  app.post("/api/account/recovery/start", recoveryLimiter, (req: Request, res: Response) => {
    const body = (req.body || {}) as { id?: unknown; proof?: unknown };
    const account = store.checkRecovery(String(body.id ?? ""), String(body.proof ?? ""));
    if (!account) {
      eventStore.record({ kind: "account-recovery-failed" });
      return res.status(404).json({ ok: false, message: "This recovery code does not match an account on this server." });
    }
    const now = Date.now();
    for (const [k, v] of tickets) if (now - v.at > TICKET_TTL_MS) tickets.delete(k);
    const ticket = randomBytes(24).toString("base64url");
    tickets.set(ticket, { accountId: account.id, at: now });
    store.addAudit(account.id, "recovery-started", clientInfo(req));
    res.json({
      ok: true,
      ticket,
      wrapped: store.wrappedFor(account.id, "recovery"),
      userName: account.userName,
      publicKey: creationOptions(req, account, challenges.issue("recover", account.id)),
    });
  });

  app.post("/api/account/recovery/finish", ceremonyLimiter, (req: Request, res: Response) => {
    const body = (req.body || {}) as { ticket?: unknown; credential?: RegistrationResponseJSON; wrapped?: { iv: string; ct: string }; label?: string };
    const ticket = tickets.get(String(body.ticket ?? ""));
    tickets.delete(String(body.ticket ?? ""));
    if (!ticket || Date.now() - ticket.at > TICKET_TTL_MS) return res.status(400).json({ ok: false, message: "The recovery has expired; start again." });
    const challenge = challengeOf(body.credential?.response?.clientDataJSON);
    const issued = challenge ? challenges.take(challenge, "recover") : null;
    if (!body.credential || !issued || issued.userName !== ticket.accountId) return res.status(400).json({ ok: false, message: "Unknown or expired challenge." });
    const r = verifyRegistration({ response: body.credential, expectedChallenge: challenge, policy: rpPolicyFor(req) });
    if (!r.ok) return res.status(400).json({ ok: false, message: `Passkey registration rejected: ${r.error}` });
    const added = store.addCredential(ticket.accountId, r.credential, body.wrapped ?? { iv: "", ct: "" }, String(body.label ?? "recovered"));
    if (!added.ok) return res.status(409).json({ ok: false, message: added.reason });
    store.recordSignIn(ticket.accountId, r.credential.signCount, { ...clientInfo(req), via: "recovery" }, Date.now(), r.credential.credentialId);
    store.addAudit(ticket.accountId, "recovered", clientInfo(req));
    hooks.onAuthenticated?.(ticket.accountId, "sign-in", { ...clientInfo(req), via: "recovery" });
    const token = store.issueToken(ticket.accountId, Date.now(), clientInfo(req));
    res.json({ ok: true, token, account: store.summary(ticket.accountId, tokenHash(token)) });
  });

  /* -------------------------------------------------- sessions, identity */

  app.get("/api/account/sessions", requireAccount, (req: AuthedRequest, res: Response) => {
    res.json({ ok: true, sessions: store.listSessions(req.account!.id, tokenHash(req.token!)) });
  });

  app.delete("/api/account/sessions/:id", requireAccount, (req: AuthedRequest, res: Response) => {
    const ended = store.revokeSession(req.account!.id, String(req.params.id));
    if (!ended) return res.status(404).json({ ok: false, message: "No such session." });
    res.json({ ok: true, sessions: store.listSessions(req.account!.id, tokenHash(req.token!)) });
  });

  app.put("/api/account/identity", requireAccount, (req: AuthedRequest, res: Response) => {
    const ok = store.setIdentity(req.account!.id, String(((req.body || {}) as { publicKey?: unknown }).publicKey ?? ""));
    res.status(ok ? 200 : 400).json({ ok });
  });
}
