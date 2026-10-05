// Key transparency over HTTP (protocol 4, § 14.3). Public (no account): the
// log names users only by u = b64url(SHA-256("m5cet/kt/user|" + username)).
//
//   GET /api/kt/key                       → { key: b64 }            the KT public key (raw Ed25519)
//   GET /api/kt/sth                       → SignedTreeHead
//   GET /api/kt/lookup?u=<u>              → KtLookup                every entry of u (the newest 500), proofs in sth
//   GET /api/kt/consistency?from=&to=     → { from, to, proof }     0 ≤ from ≤ to ≤ the log's size
//
// 400 { ok:false, code:"bad-request" } for a malformed u or size; 503 with
// code "kt-off" (no server-side storage), "kt-failed" (the log is corrupt and
// closed — see server/kt/log.ts) or "kt-busy". Its own rate-limit bucket
// (api-limit.ts): 600 requests per 15 minutes per client address.

import type { Express, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { KtUnavailableError } from "./log";
import type { KtService } from "./service";

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

export function registerKtRoutes(app: Express, kt: () => KtService): void {
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

  app.get("/api/kt/lookup", limiter, async (req, res) => {
    fresh(res);
    const u = typeof req.query.u === "string" ? req.query.u : "";
    if (!U.test(u)) return res.status(400).json({ ok: false, code: "bad-request", message: "u must be b64url(SHA-256(…)) — 43 characters." });
    try { res.json(await kt().lookup(u)); } catch (err) { unavailable(res, err); }
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
