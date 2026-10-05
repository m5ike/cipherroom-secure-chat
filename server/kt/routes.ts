// Key transparency over HTTP (protocol 4, § 14.3). The log names users only
// by u = b64url(SHA-256("m5cet/kt/user|" + username)) — a PUBLIC, unkeyed hash
// (§ 14.1): it keeps the name out of the log's text, it does not hide it from
// someone who can guess it (generated usernames of 4.0–6.4.0 have ~2^29.6
// values and invert offline in minutes). So the lookup is not public (6.12
// review S03):
//
//   GET /api/kt/key                       → { key: b64 }            the KT public key (raw Ed25519)
//   GET /api/kt/sth                       → SignedTreeHead
//   GET /api/kt/lookup[?u=<u>]            → KtLookup                Bearer: an account session — every entry of
//                                                                    the CALLER's own u (the newest 500), proofs in
//                                                                    sth; another u → 403 not-yours. A member is
//                                                                    looked up over the hub (`kt-lookup` by its
//                                                                    room-scoped reference), as a member of the room
//   GET /api/kt/consistency?from=&to=     → { from, to, proof }     0 ≤ from ≤ to ≤ the log's size
//
// 400 { ok:false, code:"bad-request" } for a malformed u or size; 401
// signed-out / locked for a lookup without a session; 503 with code "kt-off"
// (no server-side storage), "kt-failed" (the log is corrupt and closed — see
// server/kt/log.ts) or "kt-busy". Its own rate-limit bucket: 600 requests per
// 15 minutes per client address.

import type { Express, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { accountAuth, type AuthedRequest } from "../accounts/routes";
import { usernameOf, type AccountStore } from "../accounts/store";
import { KtUnavailableError } from "./log";
import { ktUser, type KtService } from "./service";

const U = /^[A-Za-z0-9_-]{43}$/;
const SIZE = /^(0|[1-9][0-9]{0,14})$/;

function unavailable(res: Response, err: unknown): void {
  if (err instanceof KtUnavailableError) {
    const message = err.code === "off" ? "Key transparency is not running on this server (no server-side storage)."
      : err.code === "busy" ? "Key transparency is busy; try again." : "Key transparency is closed on this server.";
    res.status(503).json({ ok: false, code: `kt-${err.code}`, message });
    return;
  }
  if (err instanceof RangeError) {
    res.status(400).json({ ok: false, code: "bad-request", message: err.message });
    return;
  }
  res.status(500).json({ ok: false, code: "server-error", message: "The server could not answer." });
}

export function registerKtRoutes(app: Express, kt: () => KtService, accounts: AccountStore): void {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, code: "rate-limited", message: "Too many key transparency requests." },
  });
  const fresh = (res: Response) => res.setHeader("Cache-Control", "no-store");

  app.get("/api/kt/key", limiter, (_req, res) => {
    fresh(res);
    try { res.json({ key: kt().key() }); } catch (err) { unavailable(res, err); }
  });

  app.get("/api/kt/sth", limiter, async (_req, res) => {
    fresh(res);
    try { res.json(await kt().sth()); } catch (err) { unavailable(res, err); }
  });

  // 6.12 review S03: a session, and only the caller's own entries (a member's: the hub's `kt-lookup`).
  app.get("/api/kt/lookup", limiter, accountAuth(accounts, false), async (req: AuthedRequest, res) => {
    fresh(res);
    const own = ktUser(usernameOf(req.account!));
    const asked = req.query.u;
    if (asked !== undefined && (typeof asked !== "string" || !U.test(asked))) {
      return res.status(400).json({ ok: false, code: "bad-request", message: "u must be b64url(SHA-256(…)) — 43 characters." });
    }
    if (asked !== undefined && asked !== own) {
      return res.status(403).json({ ok: false, code: "not-yours", message: "Only your own entries are looked up here; a member's come over the room (kt-lookup)." });
    }
    try { res.json(await kt().lookup(own)); } catch (err) { unavailable(res, err); }
  });

  app.get("/api/kt/consistency", limiter, (req, res) => {
    fresh(res);
    const from = typeof req.query.from === "string" && SIZE.test(req.query.from) ? Number(req.query.from) : NaN;
    const to = typeof req.query.to === "string" && SIZE.test(req.query.to) ? Number(req.query.to) : NaN;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
      return res.status(400).json({ ok: false, code: "bad-request", message: "from and to are tree sizes, 0 ≤ from ≤ to." });
    }
    try { res.json(kt().consistency(from, to)); } catch (err) { unavailable(res, err); }
  });
}
