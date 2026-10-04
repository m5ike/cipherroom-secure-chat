// @vitest-environment node
// The SSRF guard pins the connection to the address it checked (6.7, F-14).
// It resolved and checked the name, then asked for an undici Agent that was
// never installed and fell back to a plain fetch — which resolved the name a
// second time. A name that answered a public address to the check and
// 127.0.0.1 to the connection (DNS rebinding) reached the service's own
// network. Now the request is made with node:http(s) and a lookup that
// returns only the checked address.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import dns from "node:dns";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { httpRequest, isBlockedIp, NetError } from "../server/functions/host-net";

const seen: Array<{ port: number; url: string; headers: IncomingHttpHeaders }> = [];
let a: Server;
let b: Server;
let portA = 0;
let portB = 0;

function serve(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, port: () => number) => void): Promise<[Server, number]> {
  return new Promise((resolve) => {
    let port = 0;
    const srv = createServer((req, res) => { seen.push({ port, url: req.url ?? "", headers: req.headers }); handler(req, res, () => port); });
    srv.listen(0, "127.0.0.1", () => { port = (srv.address() as AddressInfo).port; resolve([srv, port]); });
  });
}

beforeAll(async () => {
  [a, portA] = await serve((req, res) => {
    if (req.url === "/gz") { res.setHeader("content-encoding", "gzip"); res.setHeader("content-type", "text/plain"); res.end(gzipSync("unzipped text")); return; }
    if (req.url === "/away") { res.statusCode = 302; res.setHeader("location", `http://127.0.0.1:${portB}/landed`); res.end(); return; }
    if (req.url === "/here") { res.statusCode = 302; res.setHeader("location", "/landed"); res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ host: req.headers.host, auth: req.headers.authorization ?? null }));
  });
  [b, portB] = await serve((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ auth: req.headers.authorization ?? null })); });
});

afterAll(() => { a.close(); b.close(); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.FUNCTIONS_HTTP_ALLOW_LOCAL; seen.length = 0; });

describe("F-14 — the checked address is the one connected to", () => {
  it("a name that is public at the check and loopback at connect time does not reach the loopback", async () => {
    // The check sees a public address (TEST-NET-3); the system resolver would say 127.0.0.1 for localhost.
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "203.0.113.10", family: 4 }] as never);
    let err: unknown = null;
    try { await httpRequest({ url: `http://localhost:${portA}/`, timeoutMs: 1500 }, () => null); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NetError);
    expect(["timeout", "network"]).toContain((err as NetError).code);
    expect(seen.filter((s) => s.port === portA)).toHaveLength(0);
  });

  it("connects to the checked address and keeps the URL's host in the Host header", async () => {
    process.env.FUNCTIONS_HTTP_ALLOW_LOCAL = "1";
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    const r = await httpRequest({ url: `http://pinned.invalid:${portA}/` }, () => null);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ host: `pinned.invalid:${portA}`, auth: null });
  });

  it("still decodes a gzip response, as fetch did", async () => {
    process.env.FUNCTIONS_HTTP_ALLOW_LOCAL = "1";
    const r = await httpRequest({ url: `http://127.0.0.1:${portA}/gz` }, () => null);
    expect(r.text).toBe("unzipped text");
  });

  it("drops Authorization on a redirect to another origin, keeps it on the same origin", async () => {
    process.env.FUNCTIONS_HTTP_ALLOW_LOCAL = "1";
    const away = await httpRequest({ url: `http://127.0.0.1:${portA}/away`, headers: { authorization: "Bearer secret" } }, () => null);
    expect(away.json).toEqual({ auth: null });
    const here = await httpRequest({ url: `http://127.0.0.1:${portA}/here`, headers: { authorization: "Bearer secret" } }, () => null);
    expect(here.json).toMatchObject({ auth: "Bearer secret" });
  });

  it("an IPv6 literal URL is checked as an address (and refused when private)", async () => {
    await expect(httpRequest({ url: "http://[::1]:9/" }, () => null)).rejects.toMatchObject({ code: "ssrf" });
    await expect(httpRequest({ url: "http://[::ffff:7f00:1]:9/" }, () => null)).rejects.toMatchObject({ code: "ssrf" });
  });
});

describe("F-14 / N13 — every spelling of a private address is blocked", () => {
  it("blocks hex IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo, site-local", () => {
    for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::1", "2002:7f00:1::1", "2002:c0a8:101::", "2001::1", "fec0::1", "febf::1", "[::1]", "0:0:0:0:0:0:0:1", "fe80::1%lo0"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it("allows public addresses in those forms", () => {
    for (const ip of ["64:ff9b::808:808", "2002:808:808::1", "::ffff:808:808", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});
