// Sign-in handoff for M5cet Desktop (6.13) — client/src/lib/desktop-auth.ts
// explains the flow. The server is only a short-lived mailbox:
//
//   POST /api/desktop-auth/start            { appKey, pollHash } → 201 { id, expiresAt }
//   GET  /api/desktop-auth/:id              → { appKey, expiresAt, state, sameNetwork }  (the browser page)
//   POST /api/desktop-auth/:id/complete     { sealed: { epk, iv, ct } } → 200 (once)
//   POST /api/desktop-auth/:id/result       { poll } → 200 { state: "pending" } | 200 { state: "done", sealed } (once, then gone)
//   POST /api/desktop-auth/:id/cancel       { poll } → 200
//
// It never sees anything in the clear: the result is AES-GCM ciphertext to the
// app's ephemeral P-256 key. It keeps a request for five minutes at most,
// hands a result out exactly once and only to whoever knows the poll secret
// (it stores SHA-256 of it; five wrong secrets end the request), refuses a
// second completion, limits pending requests per address and in total, and
// logs nothing of the bodies. `sameNetwork` tells the browser page whether
// the request came from the same address — a hint for the user, shown as a
// warning (a sign-in link someone else started), not a gate (Wi-Fi vs VPN).

import type { Express, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { truncateIp } from "./monitor/traffic";

export const DESKTOP_AUTH_TTL_MS = 5 * 60_000;
export const MAX_PENDING = 2_000;
export const MAX_PENDING_PER_ADDRESS = 20;
export const MAX_POLL_FAILURES = 5;

const B64URL = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9_-]{22,64}$/;

export type Sealed = { epk: string; iv: string; ct: string };

type Entry = {
  id: string;
  appKey: string;
  pollHash: Buffer;
  address: string;
  createdAt: number;
  expiresAt: number;
  sealed: Sealed | null;
  completedAt: number | null;
  failures: number;
};

export type StartResult = { ok: true; id: string; expiresAt: number } | { ok: false; status: 400 | 429; error: string };

function b64urlBytes(v: unknown, len: number): Buffer | null {
  if (typeof v !== "string" || !B64URL.test(v)) return null;
  const b = Buffer.from(v, "base64url");
  return b.length === len && b.toString("base64url") === v.replace(/=+$/, "") ? b : null;
}

export function isSealed(v: unknown): v is Sealed {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  const epk = b64urlBytes(s.epk, 65);
  return Boolean(epk && epk[0] === 0x04 && b64urlBytes(s.iv, 12) && typeof s.ct === "string" && B64URL.test(s.ct) && s.ct.length >= 24 && s.ct.length <= 16_384);
}

/** The in-memory mailbox (one per server process; a restart forgets every request — they are minutes long). */
export class DesktopAuthStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = DESKTOP_AUTH_TTL_MS) {}

  get size(): number { this.sweep(); return this.entries.size; }

  sweep(): void {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(id);
  }

  start(appKey: unknown, pollHash: unknown, address: string): StartResult {
    const key = b64urlBytes(appKey, 65);
    if (!key || key[0] !== 0x04) return { ok: false, status: 400, error: "appKey must be a raw P-256 public key (65 bytes, base64url)" };
    const hash = b64urlBytes(pollHash, 32);
    if (!hash) return { ok: false, status: 400, error: "pollHash must be 32 bytes, base64url" };
    this.sweep();
    if (this.entries.size >= MAX_PENDING) return { ok: false, status: 429, error: "too many sign-ins in progress" };
    let mine = 0;
    for (const e of this.entries.values()) if (e.address === address) mine += 1;
    if (mine >= MAX_PENDING_PER_ADDRESS) return { ok: false, status: 429, error: "too many sign-ins in progress from this address" };
    const id = randomBytes(18).toString("base64url");
    const t = this.now();
    this.entries.set(id, { id, appKey: String(appKey), pollHash: hash, address, createdAt: t, expiresAt: t + this.ttlMs, sealed: null, completedAt: null, failures: 0 });
    return { ok: true, id, expiresAt: t + this.ttlMs };
  }

  private live(id: string): Entry | null {
    if (!ID.test(id)) return null;
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.expiresAt <= this.now()) { this.entries.delete(id); return null; }
    return e;
  }

  info(id: string, address: string): { appKey: string; expiresAt: number; state: "waiting" | "done"; sameNetwork: boolean } | null {
    const e = this.live(id);
    if (!e) return null;
    return { appKey: e.appKey, expiresAt: e.expiresAt, state: e.sealed ? "done" : "waiting", sameNetwork: e.address === address };
  }

  complete(id: string, sealed: unknown): { ok: true } | { ok: false; status: 400 | 404 | 409; error: string } {
    const e = this.live(id);
    if (!e) return { ok: false, status: 404, error: "unknown or expired sign-in" };
    if (!isSealed(sealed)) return { ok: false, status: 400, error: "sealed result expected" };
    if (e.sealed || e.completedAt !== null) return { ok: false, status: 409, error: "this sign-in is already complete" };
    e.sealed = { epk: sealed.epk, iv: sealed.iv, ct: sealed.ct };
    e.completedAt = this.now();
    return { ok: true };
  }

  private pollOk(e: Entry, poll: unknown): boolean {
    if (typeof poll !== "string" || poll.length > 128) return false;
    const h = createHash("sha256").update(poll).digest();
    return timingSafeEqual(h, e.pollHash);
  }

  /** The app collects the result: pending, done (once — then the request is gone), or refused. */
  take(id: string, poll: unknown): { ok: true; state: "pending" } | { ok: true; state: "done"; sealed: Sealed } | { ok: false; status: 403 | 404; error: string } {
    const e = this.live(id);
    if (!e) return { ok: false, status: 404, error: "unknown or expired sign-in" };
    if (!this.pollOk(e, poll)) {
      e.failures += 1;
      if (e.failures >= MAX_POLL_FAILURES) this.entries.delete(id);
      return { ok: false, status: 403, error: "wrong poll secret" };
    }
    if (!e.sealed) return { ok: true, state: "pending" };
    const sealed = e.sealed;
    this.entries.delete(id);
    return { ok: true, state: "done", sealed };
  }

  cancel(id: string, poll: unknown): boolean {
    const e = this.live(id);
    if (!e || !this.pollOk(e, poll)) return false;
    this.entries.delete(id);
    return true;
  }
}

const limiter = (limit: number, message: string) => rateLimit({ windowMs: 10 * 60_000, limit, standardHeaders: true, legacyHeaders: false, message: { ok: false, message } });

export function registerDesktopAuthRoutes(app: Express, store = new DesktopAuthStore()): DesktopAuthStore {
  const startLimit = limiter(30, "Too many desktop sign-ins, please try again later.");
  const browserLimit = limiter(120, "Too many requests.");
  // The app polls every two seconds for up to five minutes.
  const pollLimit = limiter(600, "Too many requests.");
  const address = (req: Request) => truncateIp(req.ip) || "?";
  const noStore = (res: Response) => res.setHeader("Cache-Control", "no-store");

  app.post("/api/desktop-auth/start", startLimit, (req: Request, res: Response) => {
    noStore(res);
    const body = (req.body ?? {}) as { appKey?: unknown; pollHash?: unknown };
    const r = store.start(body.appKey, body.pollHash, address(req));
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.error });
    return res.status(201).json({ ok: true, id: r.id, expiresAt: r.expiresAt });
  });

  app.get("/api/desktop-auth/:id", browserLimit, (req: Request, res: Response) => {
    noStore(res);
    const info = store.info(String(req.params.id), address(req));
    if (!info) return res.status(404).json({ ok: false, message: "unknown or expired sign-in" });
    return res.json({ ok: true, ...info });
  });

  app.post("/api/desktop-auth/:id/complete", browserLimit, (req: Request, res: Response) => {
    noStore(res);
    const r = store.complete(String(req.params.id), (req.body as { sealed?: unknown } | undefined)?.sealed);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.error });
    return res.json({ ok: true });
  });

  app.post("/api/desktop-auth/:id/result", pollLimit, (req: Request, res: Response) => {
    noStore(res);
    const r = store.take(String(req.params.id), (req.body as { poll?: unknown } | undefined)?.poll);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.error });
    return res.json(r.state === "done" ? { ok: true, state: "done", sealed: r.sealed } : { ok: true, state: "pending" });
  });

  app.post("/api/desktop-auth/:id/cancel", pollLimit, (req: Request, res: Response) => {
    noStore(res);
    store.cancel(String(req.params.id), (req.body as { poll?: unknown } | undefined)?.poll);
    return res.json({ ok: true });
  });

  return store;
}
