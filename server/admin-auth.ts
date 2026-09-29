// Operator authentication shared by the admin service (admin.ts) and the
// operator routes of the main service (retention, push broadcast).
//
// Why the main service checks the token itself instead of moving those
// routes to the admin process: every table they act on (push
// subscriptions, device settings, audit, consent, the event ring) lives in
// memory in the MAIN process. The admin service is a separate process with
// its own, empty copies — a route moved there would operate on nothing.
//
// Constant-time comparison: both sides are hashed first, which gives them
// equal length (timingSafeEqual requires it) without leaking the token's
// length either.
//
// 3.1: administrators have names and roles (admin-users.ts). The guards
// below resolve "Bearer <token>" to a principal and check its role; a
// request without a role argument needs "auditor" to read (GET/HEAD) and
// "operator" to change anything.

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { adminDirectory, ROLE_RANK, type AdminPrincipal, type AdminRole } from "./admin-users";
import { admPathAllowed, isAdmToken, verifyAdmToken, type AdmArea } from "./functions/adm-token";

/** The administrator a request was authenticated as (set by the guards). */
export type AdminRequest = Request & { admin?: AdminPrincipal };

/** What a request needs by default: reading → auditor, anything else → operator. */
export function defaultRole(method: string): AdminRole {
  return method === "GET" || method === "HEAD" ? "auditor" : "operator";
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** ADMIN_API_TOKEN, read at call time (so a restart-free env change and tests see it). */
export function adminTokenFromEnv(): string {
  return process.env.ADMIN_API_TOKEN?.trim() || "";
}

/** True when `authorization` is exactly "Bearer <token>". Never true for an empty token. */
export function isAuthorizedHeader(authorization: string | undefined, token: string): boolean {
  if (!token) return false;
  return timingSafeEqual(sha256(authorization ?? ""), sha256(`Bearer ${token}`));
}

export type AdminAuthFailure = { status: 401 | 403 | 503; body: { ok: false; message: string } };

/** null when the request carries a token of an administrator with at least
 *  `role`; otherwise the response to send. With `getToken`, only that one
 *  token counts (the standalone admin service's own ADMIN_API_TOKEN). */
export function checkAdminRequest(req: Request, getToken?: () => string, role: AdminRole = defaultRole(req.method)): AdminAuthFailure | null {
  if (getToken) {
    const token = getToken();
    if (!token) return { status: 503, body: { ok: false, message: "ADMIN_API_TOKEN env var is not set." } };
    if (!isAuthorizedHeader(req.header("authorization"), token)) return { status: 401, body: { ok: false, message: "Unauthorized." } };
    (req as AdminRequest).admin = { name: "admin", role: "owner", via: "env-token" };
    return null;
  }
  // 6.0: a Functions run with an owner's grant (m5adm) — its role, and only its areas.
  const fn = functionPrincipal(req.header("authorization"));
  if (fn) {
    (req as AdminRequest).admin = fn;
    if (!admPathAllowed(fn.areas as AdmArea[], req.originalUrl || req.path, req.method)) return { status: 403, body: { ok: false, message: "This function's access to the administration does not include this part (Functions › model › Administration)." } };
    if (ROLE_RANK[fn.role] < ROLE_RANK[role]) return { status: 403, body: { ok: false, message: `This needs the ${role} role; the function has ${fn.role}.` } };
    return null;
  }
  if (!adminDirectory.configured()) return { status: 503, body: { ok: false, message: "No administrator is configured (ADMIN_API_TOKEN or ADMIN_TOKENS)." } };
  const principal = adminDirectory.authenticate(req.header("authorization"));
  if (!principal) return { status: 401, body: { ok: false, message: "Unauthorized." } };
  (req as AdminRequest).admin = principal;
  if (ROLE_RANK[principal.role] < ROLE_RANK[role]) return { status: 403, body: { ok: false, message: `This needs the ${role} role; you are ${principal.role}.` } };
  return null;
}

/** "Bearer m5f1.…": a valid function token → its principal ("fn:<model>/<caller>"). */
export function functionPrincipal(authorization: string | undefined): AdminPrincipal | null {
  const header = authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!isAdmToken(token) || token.length > 300) return null;
  const claims = verifyAdmToken(token);
  if (!claims) return null;
  return { name: `fn:${claims.model}${claims.caller ? `/${claims.caller}` : ""}`, role: claims.role, via: "function", areas: claims.areas };
}

export function sendAdminAuthFailure(res: Response, failure: AdminAuthFailure): void {
  if (failure.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="m5cet-admin"');
  res.status(failure.status).json(failure.body);
}

/** Express middleware: 503 when nobody is configured, 401 on an unknown
 *  token, 403 when the role is not enough (default: read = auditor,
 *  change = operator). `getToken` pins it to one token (admin service). */
export function requireAdminToken(getToken?: () => string, role?: AdminRole): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const failure = checkAdminRequest(req, getToken, role ?? defaultRole(req.method));
    if (failure) return sendAdminAuthFailure(res, failure);
    next();
  };
}

/** The same guard with an explicit minimum role. */
export function requireAdmin(role: AdminRole): RequestHandler {
  return requireAdminToken(undefined, role);
}

/** How the audit journal names whoever did something. */
export function adminName(req: Request): string {
  const principal = (req as AdminRequest).admin;
  const ip = String(req.ip ?? "").replace(/^::ffff:/, "") || "unknown";
  return principal ? `${principal.name}@${ip}` : `admin@${ip}`;
}
