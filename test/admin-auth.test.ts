// @vitest-environment node
//
// Shared operator auth (admin service + operator routes of the main
// service): constant-time Bearer check, 503 without a configured token,
// 401 (+ WWW-Authenticate) on a missing / wrong one.

import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { checkAdminRequest, isAuthorizedHeader, requireAdminToken } from "../server/admin-auth";

describe("isAuthorizedHeader", () => {
  it("accepts exactly 'Bearer <token>'", () => {
    expect(isAuthorizedHeader("Bearer s3cret-token", "s3cret-token")).toBe(true);
    expect(isAuthorizedHeader("Bearer s3cret-token ", "s3cret-token")).toBe(false);
    expect(isAuthorizedHeader("bearer s3cret-token", "s3cret-token")).toBe(false);
    expect(isAuthorizedHeader("Bearer s3cret", "s3cret-token")).toBe(false);
    expect(isAuthorizedHeader(undefined, "s3cret-token")).toBe(false);
  });
  it("never authorizes when no token is configured (even 'Bearer ')", () => {
    expect(isAuthorizedHeader("Bearer ", "")).toBe(false);
    expect(isAuthorizedHeader("", "")).toBe(false);
  });
});

describe("requireAdminToken middleware", () => {
  let close: (() => void) | null = null;
  const saved = process.env.ADMIN_API_TOKEN;
  afterEach(() => {
    close?.(); close = null;
    if (saved === undefined) delete process.env.ADMIN_API_TOKEN; else process.env.ADMIN_API_TOKEN = saved;
  });

  async function serve(): Promise<string> {
    const app = express();
    app.get("/op", requireAdminToken(), (_req, res) => { res.json({ ok: true }); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/op`;
  }

  it("503 when ADMIN_API_TOKEN is unset, 401 without / with a wrong token, 200 with it", async () => {
    delete process.env.ADMIN_API_TOKEN;
    const url = await serve();
    expect((await fetch(url, { headers: { Authorization: "Bearer anything" } })).status).toBe(503);
    process.env.ADMIN_API_TOKEN = "op-token-123";
    const none = await fetch(url);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await fetch(url, { headers: { Authorization: "Bearer op-token-123" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });

  it("checkAdminRequest reads the token at call time", () => {
    const req = { header: (name: string) => (name === "authorization" ? "Bearer t1" : undefined) } as unknown as express.Request;
    expect(checkAdminRequest(req, () => "")?.status).toBe(503);
    expect(checkAdminRequest(req, () => "t2")?.status).toBe(401);
    expect(checkAdminRequest(req, () => "t1")).toBeNull();
  });
});
