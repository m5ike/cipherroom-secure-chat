// @vitest-environment node
//
// M5cet Desktop (6.13): the bundled page runs under exactly the security
// headers the server sends with it (CSP, frame-ancestors, COOP, CORP, HSTS,
// Referrer-Policy, Permissions-Policy, no-store) — desktop/src/web-headers.ts
// runs the server's own helmet configuration (server/security-headers.ts).
// Compared here against a real Express app configured as server/index.ts.

import { describe, expect, it } from "vitest";
import express from "express";
import helmet from "helmet";
import type { AddressInfo } from "node:net";
import { BASE_HEADERS, helmetOptions } from "../server/security-headers";
import { webSecurityHeaders } from "../desktop/src/web-headers";

async function serverHeaders(): Promise<Record<string, string>> {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet(helmetOptions(false)));
  app.use((_req, res, next) => { for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v); next(); });
  app.get("/", (_req, res) => { res.type("html").send("<!doctype html>"); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => { out[k] = v; });
    return out;
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe("desktop: the page's security headers are the server's", () => {
  it("every security header the server sends, with the same value", async () => {
    const server = await serverHeaders();
    const desktop = Object.fromEntries(Object.entries(webSecurityHeaders()).map(([k, v]) => [k.toLowerCase(), v]));
    const transport = new Set(["content-type", "content-length", "date", "connection", "keep-alive", "etag", "x-powered-by"]);
    const security = Object.keys(server).filter((k) => !transport.has(k));
    expect(security.length).toBeGreaterThan(10);
    for (const name of security) expect(desktop[name], name).toBe(server[name]);
    for (const name of Object.keys(desktop)) expect(server[name], name).toBeDefined();
  });

  it("the production CSP: no inline script, no eval, no framing", () => {
    const csp = webSecurityHeaders()["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    const script = csp.split(";").find((d) => d.startsWith("script-src "))!;
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("a loopback development server: no upgrade to https, no HSTS — the rest unchanged", () => {
    const h = webSecurityHeaders({ insecureLoopback: true });
    expect(h["Content-Security-Policy"]).not.toContain("upgrade-insecure-requests");
    expect(h["Content-Security-Policy"]).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(h["X-Frame-Options"]).toBe(webSecurityHeaders()["X-Frame-Options"]);
  });
});
