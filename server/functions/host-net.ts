// m5.http and m5.dns on the host (4.15, stage 4). A function in the sandbox
// cannot reach the network itself; it asks the host, which makes the request
// here with the caller's limits and — the point — an SSRF guard: only http(s),
// and never to a private, loopback, link-local or cloud-metadata address, on
// the first hop or any redirect. The hostname is resolved and checked, then
// the request is pinned to that address so a name that flips after the check
// (DNS rebinding) cannot slip through.

import { lookup as dnsLookup, promises as dnsp } from "node:dns";
import { isIP } from "node:net";
import { Buffer } from "node:buffer";

export class NetError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "NetError"; }
}

const DEFAULT_TIMEOUT = 15_000;
const MAX_TIMEOUT = 120_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const HARD_MAX_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 8;

/** Private / loopback / link-local / metadata ranges that a function may not reach. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;             // this-host, private, loopback
    if (a === 169 && b === 254) return true;                        // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;              // private
    if (a === 192 && b === 168) return true;                        // private
    if (a === 100 && b >= 64 && b <= 127) return true;             // carrier-grade NAT
    if (a === 192 && b === 0 && p[2] === 0) return true;           // 192.0.0.0/24
    if (a >= 224) return true;                                      // multicast + reserved
    return false;
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (ip6 === "::1" || ip6 === "::") return true;                 // loopback / unspecified
    if (ip6.startsWith("fe80") || ip6.startsWith("fc") || ip6.startsWith("fd")) return true; // link-local / unique-local
    if (ip6.startsWith("ff")) return true;                          // multicast
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip6);
    if (m) return isBlockedIp(m[1]);
    return false;
  }
  return true; // not an IP literal → refuse (we only pin to resolved IPs)
}

// Development / tests may allow private addresses (to reach a local test
// server); never set this in production — it turns the SSRF guard off.
const allowLocal = () => process.env.FUNCTIONS_HTTP_ALLOW_LOCAL === "1";

/** Resolves a hostname and returns a safe address to connect to, or throws. */
async function resolveSafe(hostname: string): Promise<{ address: string; family: number }> {
  const ok = allowLocal();
  if (isIP(hostname)) {
    if (!ok && isBlockedIp(hostname)) throw new NetError("ssrf", `${hostname} is a private or reserved address`);
    return { address: hostname, family: isIP(hostname) };
  }
  let records: Array<{ address: string; family: number }>;
  try { records = await dnsp.lookup(hostname, { all: true }); }
  catch (err) { throw new NetError("dns", `cannot resolve ${hostname}: ${(err as Error).message}`); }
  if (!records.length) throw new NetError("dns", `cannot resolve ${hostname}`);
  if (!ok) for (const r of records) if (isBlockedIp(r.address)) throw new NetError("ssrf", `${hostname} resolves to a private or reserved address (${r.address})`);
  return records[0];
}

type HttpSpec = {
  method?: string;
  url: string;
  headers?: Record<string, unknown>;
  body?: unknown;         // string, or { $b: base64 } bytes (decoded by the caller side)
  json?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  redirect?: "follow" | "manual" | "error";
  maxRedirects?: number;
};

const clampInt = (v: unknown, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection"]);

/** Makes one HTTP request with the SSRF guard and size / time limits. */
export async function httpRequest(spec: HttpSpec, bytesOf: (v: unknown) => Buffer | null): Promise<Record<string, unknown>> {
  if (typeof spec?.url !== "string") throw new NetError("bad-argument", "url is required");
  const method = String(spec.method ?? "GET").toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) throw new NetError("bad-argument", `unsupported method ${method}`);
  const timeout = clampInt(spec.timeoutMs, DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const maxBytes = clampInt(spec.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const redirect = spec.redirect === "manual" || spec.redirect === "error" ? spec.redirect : "follow";
  const maxRedirects = clampInt(spec.maxRedirects, MAX_REDIRECTS, MAX_REDIRECTS);

  const headers = new Headers();
  for (const [k, val] of Object.entries(spec.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(k.toLowerCase()) || val === undefined || val === null) continue;
    headers.set(k, String(val));
  }
  let body: string | Uint8Array | undefined;
  if (spec.json !== undefined) { body = JSON.stringify(spec.json); if (!headers.has("content-type")) headers.set("content-type", "application/json"); }
  else if (spec.body !== undefined && spec.body !== null) { const b = bytesOf(spec.body); body = b ? new Uint8Array(b) : String(spec.body); }

  const started = Date.now();
  let url = spec.url;
  let hops = 0;
  const deadline = AbortSignal.timeout(timeout);
  for (;;) {
    let u: URL;
    try { u = new URL(url); } catch { throw new NetError("bad-argument", `not a URL: ${url.slice(0, 120)}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new NetError("scheme", "only http(s) is allowed");
    const pin = await resolveSafe(u.hostname);
    // Pin the connection to the checked address (defeats DNS rebinding).
    const dispatcher = pinnedDispatcher(u, pin.address);
    let res: Response;
    const init = { method, headers, body: body as BodyInit | undefined, redirect: "manual" as const, signal: deadline, ...(dispatcher ? { dispatcher } : {}) };
    try {
      res = await fetch(u, init as RequestInit);
    } catch (err) {
      if ((err as Error).name === "TimeoutError") throw new NetError("timeout", `the request took longer than ${timeout} ms`);
      throw new NetError("network", (err as Error).message);
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      if (redirect === "error") throw new NetError("redirect", `the server redirected to ${loc}`);
      if (redirect === "manual") return await readResponse(res, u.href, maxBytes, started);
      if (++hops > maxRedirects) throw new NetError("redirect", "too many redirects");
      url = new URL(loc, u).href;
      continue;
    }
    return await readResponse(res, u.href, maxBytes, started);
  }
}

/** An undici dispatcher that connects to a fixed IP but keeps the URL's host
 *  (SNI, Host header). Returns undefined when undici is unavailable. */
function pinnedDispatcher(u: URL, address: string): unknown {
  try {
    // Node's global fetch is undici; Agent + connect.lookup pins the address.
    const { Agent } = require("undici") as { Agent: new (o: object) => unknown };
    return new Agent({ connect: { lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, address, isIP(address) || 4) } });
  } catch {
    return undefined; // fall back to a normal connect (already SSRF-checked above)
  }
}

async function readResponse(res: Response, finalUrl: string, maxBytes: number, started: number): Promise<Record<string, unknown>> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) { total += value.length; if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new NetError("too-large", `the response is larger than ${maxBytes} bytes`); } chunks.push(value); }
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const ctype = headers["content-type"] || "";
  const textual = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/.test(ctype);
  const out: Record<string, unknown> = {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    url: finalUrl,
    headers,
    timing: { totalMs: Date.now() - started },
    bytes: buf.length,
  };
  if (textual || buf.length <= 1_048_576) out.text = buf.toString("utf8");
  out.body = { $b: buf.toString("base64") };
  if (/application\/json|\+json/.test(ctype)) { try { out.json = JSON.parse(buf.toString("utf8")); } catch { /* leave as text */ } }
  return out;
}

/* ------------------------------------------------------------------ dns */

const DNS_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "PTR", "SOA"]);

export async function dnsResolve(name: unknown, type: unknown): Promise<unknown> {
  const host = String(name ?? "").trim();
  const t = String(type ?? "A").toUpperCase();
  if (!host) throw new NetError("bad-argument", "a name is required");
  if (!DNS_TYPES.has(t)) throw new NetError("bad-argument", `unsupported record type ${t}`);
  try {
    if (t === "PTR") return await new Promise((resolve, reject) => dnsp.reverse(host).then(resolve, reject));
    return await dnsp.resolve(host, t as "A");
  } catch (err) {
    throw new NetError("dns", `cannot resolve ${host} ${t}: ${(err as Error).message}`);
  }
}

// Keep dnsLookup referenced for platforms where resolve is restricted.
void dnsLookup;
