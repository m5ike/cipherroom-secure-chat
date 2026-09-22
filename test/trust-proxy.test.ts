// @vitest-environment node
//
// Behind nginx every request arrives from 127.0.0.1 with X-Forwarded-For.
// Regression for the production log line ERR_ERL_UNEXPECTED_X_FORWARDED_FOR:
// with Express's default (trust proxy = false) all visitors shared nginx's
// rate-limit bucket. Real sockets, real express-rate-limit.

import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { rateLimit } from "express-rate-limit";
import type { AddressInfo } from "node:net";
import { applyTrustProxy, resolveTrustProxy } from "../server/trust-proxy";

describe("resolveTrustProxy", () => {
  it("defaults to loopback on a host, private ranges too inside a container", () => {
    expect(resolveTrustProxy(undefined, false)).toEqual({ value: "loopback", source: "default" });
    expect(resolveTrustProxy("  ", true)).toEqual({ value: "loopback, linklocal, uniquelocal", source: "default" });
  });
  it("parses booleans, hop counts and lists", () => {
    expect(resolveTrustProxy("false", false).value).toBe(false);
    expect(resolveTrustProxy("0", false).value).toBe(false);
    expect(resolveTrustProxy("TRUE", false).value).toBe(true);
    expect(resolveTrustProxy("2", false).value).toBe(2);
    expect(resolveTrustProxy("loopback, 10.0.0.0/8", false).value).toBe("loopback, 10.0.0.0/8");
  });
  it("an invalid list falls back to the default instead of crashing the boot", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    expect(applyTrustProxy(app, "not-an-ip", false)).toBe("loopback");
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/ignoring invalid TRUST_PROXY/));
    err.mockRestore();
  });
});

describe("behind a same-host proxy (requests from 127.0.0.1 with X-Forwarded-For)", () => {
  let close: (() => void) | null = null;
  afterEach(() => { close?.(); close = null; vi.restoreAllMocks(); });

  async function serve(trust: string | undefined): Promise<string> {
    const app = express();
    applyTrustProxy(app, trust, false);
    app.use(rateLimit({ windowMs: 60_000, limit: 1, standardHeaders: true, legacyHeaders: false }));
    app.get("/ip", (req, res) => { res.json({ ip: req.ip }); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const hit = (base: string, xff: string) => fetch(`${base}/ip`, { headers: { "X-Forwarded-For": xff } });

  it("default: req.ip is the client nginx saw, each client gets its own bucket, no ERL warning", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = await serve(undefined);
    const a = await hit(base, "203.0.113.7");
    expect(await a.json()).toEqual({ ip: "203.0.113.7" });
    expect((await hit(base, "198.51.100.9")).status).toBe(200); // a different visitor is NOT throttled
    expect((await hit(base, "203.0.113.7")).status).toBe(429); // the same one is
    // A forged left-most entry does not help: nginx appends the real address.
    expect((await hit(base, "1.2.3.4, 203.0.113.7")).status).toBe(429);
    expect(err.mock.calls.flat().map(String).join(" ")).not.toMatch(/X-Forwarded-For/);
  });

  it("TRUST_PROXY=false reproduces the old behaviour: one shared bucket + the ERL warning", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = await serve("false");
    const a = await hit(base, "203.0.113.7");
    expect(await a.json()).toEqual({ ip: "127.0.0.1" });
    expect((await hit(base, "198.51.100.9")).status).toBe(429); // a stranger is throttled by someone else's use
    expect(err.mock.calls.flat().map(String).join(" ")).toMatch(/X-Forwarded-For/);
  });
});
