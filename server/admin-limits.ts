// Limits and large bodies on the main service's /api/admin (6.7, audit S4).
//
// The operator console: a busy operator is not a flood, a wrong token is.
// Refused requests count against a small budget (token guessing), all
// requests against a generous one. 6.0: a function's calls (m5adm, a signed
// m5f1 token) come from this host too — they get a bucket per model instead,
// so a busy script cannot use up the console's.
//
// 6.7: a token only counts as a function's when its signature verifies.
// Before, any bearer that merely started with "m5f1." skipped both console
// limiters and was bucketed by the (unverified) model name in its payload —
// rotating the name meant no limit at all. And the routes that take large
// bodies (the Android design, 8 MB; the menu, 1 MB) parsed them before any
// limit or token check; now they are read only for an administrator, after
// the limits.

import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAdminToken } from "./admin-auth";
import { isAdmToken, verifyAdmToken, type AdmTokenClaims } from "./functions/adm-token";

const bearerOf = (req: Request) => (req.header("authorization") ?? "").replace(/^Bearer\s+/, "");

/** The claims of the request's function token when it verifies; null otherwise (cached per request). */
export function functionClaimsOf(req: Request): AdmTokenClaims | null {
  const r = req as Request & { m5fnClaims?: AdmTokenClaims | null };
  if (r.m5fnClaims === undefined) {
    const token = bearerOf(req);
    r.m5fnClaims = isAdmToken(token) && token.length <= 300 ? verifyAdmToken(token) : null;
  }
  return r.m5fnClaims;
}

/** The three /api/admin limiters (console refused, console all, per function model). */
export function adminLimiters(): RequestHandler[] {
  const isFunction = (req: Request) => functionClaimsOf(req) !== null;
  return [
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, skip: isFunction, message: { ok: false, message: "Too many refused admin requests." } }),
    rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, skip: isFunction, message: { ok: false, message: "Too many admin requests." } }),
    rateLimit({ windowMs: 60 * 1000, limit: 1_200, standardHeaders: true, legacyHeaders: false, skip: (req) => !isFunction(req), keyGenerator: (req) => `fn:${functionClaimsOf(req)?.model ?? "?"}`, message: { ok: false, message: "Too many administration calls from this function." } }),
  ];
}

/** Mounts the limiters, then the large-body parsers behind the admin guard. */
export function mountAdminRequestGuards(app: Express): void {
  app.use("/api/admin", ...adminLimiters());
  // The Android design carries screens, strings and small assets; the menu
  // builder saves a whole menu, HTML blocks included. Only an administrator's
  // body is read at all (the routes check the role again).
  app.use("/api/admin/android/design", requireAdminToken(), express.json({ limit: "8mb" }));
  app.use("/api/admin/menu-config", requireAdminToken(), express.json({ limit: "1mb" }));
}
