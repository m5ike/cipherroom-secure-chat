// @vitest-environment node
// 6.8 — the public API's general limit (server/api-limit.ts). A web page that
// drew a few maps (each preview several /api/map/tile requests) used up the
// 100 requests of 15 minutes, and the next passkey sign-in got "Too many
// requests, please try again later." Now the routes with a bucket of their
// own are not counted twice, and the operator sets the limit.

import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { rateLimit } from "express-rate-limit";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { API_LIMIT_DEFAULT, API_WINDOW_MIN_DEFAULT, apiLimitConfig, hasOwnBucket } from "../server/api-limit";

describe("apiLimitConfig", () => {
  it("defaults to 100 requests in 15 minutes", () => {
    expect(apiLimitConfig({})).toEqual({ limit: API_LIMIT_DEFAULT, windowMin: API_WINDOW_MIN_DEFAULT, windowMs: 15 * 60_000, problems: [] });
    expect(API_LIMIT_DEFAULT).toBe(100);
  });

  it("takes API_RATE_LIMIT and API_RATE_WINDOW_MIN", () => {
    const c = apiLimitConfig({ API_RATE_LIMIT: " 600 ", API_RATE_WINDOW_MIN: "5" });
    expect(c).toMatchObject({ limit: 600, windowMin: 5, windowMs: 300_000, problems: [] });
  });

  it("an invalid value is reported and the default used", () => {
    for (const [k, v] of [["API_RATE_LIMIT", "lots"], ["API_RATE_LIMIT", "5"], ["API_RATE_LIMIT", "2.5"], ["API_RATE_WINDOW_MIN", "0"], ["API_RATE_WINDOW_MIN", "1441"]]) {
      const c = apiLimitConfig({ [k]: v });
      expect(c.limit).toBe(100);
      expect(c.windowMin).toBe(15);
      expect(c.problems).toHaveLength(1);
      expect(c.problems[0]).toContain(k);
    }
  });
});

describe("hasOwnBucket", () => {
  it.each([
    ["GET", "/api/map/tile/12/2213/1386"],
    ["GET", "/api/map/tile/3/4/2?v=1"],
    ["POST", "/api/account/signin/options"],
    ["POST", "/api/account/signin/verify"],
    ["POST", "/api/account/register/verify"],
    ["POST", "/api/account/unlock"],
    ["POST", "/api/account/passkeys/verify"],
    ["POST", "/api/account/recovery/finish"],
    ["PUT", "/api/account/vault"],
    ["GET", "/api/storage/x"],
    ["GET", "/api/admin/status"],
    ["POST", "/api/android/checkin"],
    ["GET", "/api/profile/alice"],
  ])("%s %s has its own bucket", (method, url) => {
    expect(hasOwnBucket(method, url)).toBe(true);
  });

  it.each([
    ["GET", "/api/health"],
    ["GET", "/api/settings"],
    ["GET", "/api/map/search"],
    ["GET", "/api/account/me"],
    ["GET", "/api/account/passkeys/abc/wrapped"],
    ["DELETE", "/api/account/passkeys/abc"],
    ["GET", "/api/account/signin/options"],
    ["GET", "/api/profiles-of-someone"],
    ["GET", "/api/storagex"],
  ])("%s %s counts toward the general limit", (method, url) => {
    expect(hasOwnBucket(method, url)).toBe(false);
  });
});

describe("the general limiter with the skip (real express-rate-limit)", () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((done) => { if (server) server.close(() => done()); else done(); }));

  it("map tiles and sign-in requests do not use up the budget of the rest", async () => {
    const app = express();
    app.use("/api", rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: true, legacyHeaders: false, skip: (req) => hasOwnBucket(req.method, req.originalUrl), message: { ok: false, message: "Too many requests, please try again later." } }));
    app.all(/^\/api\/.*/, (_req, res) => { res.json({ ok: true }); });
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server!.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (let i = 0; i < 20; i++) expect((await fetch(`${base}/api/map/tile/12/${i}/1`)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await fetch(`${base}/api/settings`)).status).toBe(200);
    expect((await fetch(`${base}/api/settings`)).status).toBe(429);
    // The budget is gone, and a passkey sign-in still goes (it has its own limiter).
    expect((await fetch(`${base}/api/account/signin/options`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/api/account/signin/verify`, { method: "POST" })).status).toBe(200);
  });
});
