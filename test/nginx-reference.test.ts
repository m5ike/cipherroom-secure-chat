// @vitest-environment node
// The reference nginx config (deploy/nginx/m5cet.conf) routes everything the
// app serves outside /api (6.7, audit S16): /hooks/ (Functions webhooks) and
// /fn-sandbox.html fell into the SPA fallback (index.html), and the SPA's CSP
// (child-src 'none', no frame-src) forbade the sandbox iframe anyway.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const conf = readFileSync("deploy/nginx/m5cet.conf", "utf8");

/** The body of a multi-line `location <match> { … }` in the HTTPS server (no nested blocks). */
function location(match: string): string | null {
  const at = conf.indexOf(`location ${match} {\n`);
  if (at < 0) return null;
  return conf.slice(at, conf.indexOf("\n    }", at));
}

describe("S16 — the reference nginx config", () => {
  it("proxies the Functions webhooks and the sandbox page to the app", () => {
    const hooks = location("/hooks/");
    expect(hooks).toContain("proxy_pass http://m5cet_app;");
    expect(hooks).toMatch(/client_max_body_size\s+\d+m;/);
    expect(location("= /fn-sandbox.html")).toContain("proxy_pass http://m5cet_app;");
  });

  it("lets the SPA frame its own pages (the sandbox) and nothing else", () => {
    const spa = location("/") ?? "";
    const csp = /Content-Security-Policy "([^"]+)"/.exec(spa)?.[1] ?? "";
    expect(csp).toContain("frame-src 'self'");
    expect(csp).not.toMatch(/frame-src[^;]*(\*|https:)/);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("every app path outside /api has a location (none falls to index.html)", () => {
    for (const m of ["/api/", "= /ws", "/wh/", "/hooks/", "= /fn-sandbox.html", "/media/tel/", "= /goodbye", "= /.well-known/assetlinks.json"]) {
      expect(location(m), m).not.toBeNull();
    }
  });
});
