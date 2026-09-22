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

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

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

export type AdminAuthFailure = { status: 401 | 503; body: { ok: false; message: string } };

/** null when the request carries the operator token; otherwise the response to send. */
export function checkAdminRequest(req: Request, getToken: () => string = adminTokenFromEnv): AdminAuthFailure | null {
  const token = getToken();
  if (!token) return { status: 503, body: { ok: false, message: "ADMIN_API_TOKEN env var is not set." } };
  if (!isAuthorizedHeader(req.header("authorization"), token)) {
    return { status: 401, body: { ok: false, message: "Unauthorized." } };
  }
  return null;
}

export function sendAdminAuthFailure(res: Response, failure: AdminAuthFailure): void {
  if (failure.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="m5cet-admin"');
  res.status(failure.status).json(failure.body);
}

/** Express middleware: 503 when no token is configured, 401 on a wrong / missing one. */
export function requireAdminToken(getToken: () => string = adminTokenFromEnv): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const failure = checkAdminRequest(req, getToken);
    if (failure) return sendAdminAuthFailure(res, failure);
    next();
  };
}
