// m5.http and m5.dns on the host (4.15, stage 4). A function in the sandbox
// cannot reach the network itself; it asks the host, which makes the request
// here with the caller's limits and — the point — an SSRF guard: only http(s),
// and never to a private, loopback, link-local or cloud-metadata address, on
// the first hop or any redirect. The hostname is resolved and checked, then
// the request is pinned to that address so a name that flips after the check
// (DNS rebinding) cannot slip through (6.7, F-14: node:http(s) with a fixed
// lookup — the undici Agent it used to ask for was never installed).

import { lookup as dnsLookup, promises as dnsp } from "node:dns";
import { request as httpReq, type IncomingMessage } from "node:http";
import { request as httpsReq } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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
  if (v === 6 || isIP(ip.replace(/^\[|\]$/g, "")) === 6) {
    // 6.7 (F-14 / audit N13): every spelling of an address is expanded
    // first (::ffff:7f00:1 is ::ffff:127.0.0.1), and the IPv4 an address
    // carries (mapped, compatible, NAT64, 6to4) is checked as IPv4.
    const h = ipv6Hextets(ip.replace(/^\[|\]$/g, ""));
    if (!h) return true;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
    if (zero(0, 8)) return true;                                    // :: unspecified
    if (zero(0, 7) && h[7] === 1) return true;                      // ::1 loopback
    if (zero(0, 5) && h[5] === 0xffff) return isBlockedIp(v4(h[6], h[7]));  // ::ffff:0:0/96 IPv4-mapped
    if (zero(0, 6)) return isBlockedIp(v4(h[6], h[7]));             // ::/96 IPv4-compatible (deprecated)
    if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return isBlockedIp(v4(h[6], h[7])); // 64:ff9b::/96 NAT64
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
    if (h[0] === 0x2002) return isBlockedIp(v4(h[1], h[2]));        // 2002::/16 6to4
    if (h[0] === 0x2001 && h[1] === 0) return true;                 // 2001::/32 Teredo (an obfuscated IPv4)
    if (h[0] === 0x0100 && zero(1, 4)) return true;                 // 100::/64 discard
    if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return true; // fe80::/10 link-local, fec0::/10 site-local
    if ((h[0] & 0xfe00) === 0xfc00) return true;                    // fc00::/7 unique-local
    if ((h[0] & 0xff00) === 0xff00) return true;                    // ff00::/8 multicast
    return false;
  }
  return true; // not an IP literal → refuse (we only pin to resolved IPs)
}

/** The eight 16-bit groups of an IPv6 literal (a dotted IPv4 tail allowed); null if it is not one. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const b = tail.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    s = `${s.slice(0, tail.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(":") : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

// Development / tests may allow private addresses (to reach a local test
// server); never set this in production — it turns the SSRF guard off.
const allowLocal = () => process.env.FUNCTIONS_HTTP_ALLOW_LOCAL === "1";

/** Resolves a hostname and returns a safe address to connect to, or throws. */
async function resolveSafe(rawHostname: string): Promise<{ address: string; family: number }> {
  const ok = allowLocal();
  // URL.hostname keeps an IPv6 literal's brackets ("[::1]").
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
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
    let res: PinnedResponse;
    try {
      res = await pinnedRequest(u, pin, { method, headers, body, signal: deadline });
    } catch (err) {
      if (deadline.aborted || (err as Error).name === "TimeoutError") throw new NetError("timeout", `the request took longer than ${timeout} ms`);
      throw new NetError("network", (err as Error).message);
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      if (redirect === "error") { res.discard(); throw new NetError("redirect", `the server redirected to ${loc}`); }
      if (redirect === "manual") return await readResponse(res, u.href, maxBytes, started);
      res.discard();
      if (++hops > maxRedirects) throw new NetError("redirect", "too many redirects");
      const next = new URL(loc, u);
      // Credentials are for the origin they were given to (as fetch does).
      if (next.origin !== u.origin) for (const h of ["authorization", "cookie", "proxy-authorization"]) headers.delete(h);
      url = next.href;
      continue;
    }
    return await readResponse(res, u.href, maxBytes, started);
  }
}

/** What readResponse needs of a response. */
type PinnedResponse = { status: number; statusText: string; ok: boolean; headers: Headers; body: ReadableStream<Uint8Array> | null; discard(): void };

/**
 * One HTTP(S) request whose connection goes to `pin` — the address
 * resolveSafe resolved and checked — while the URL's host stays the Host
 * header, the TLS server name and the name the certificate is checked
 * against (6.7, F-14). The guard used to hand this to an undici Agent that
 * was never installed, so fetch silently resolved the name a second time
 * and a name that flipped to 127.0.0.1 after the check (DNS rebinding) got
 * through. Like fetch, it asks for and decodes gzip / deflate / br.
 */
function pinnedRequest(u: URL, pin: { address: string; family: number }, init: { method: string; headers: Headers; body: string | Uint8Array | undefined; signal: AbortSignal }): Promise<PinnedResponse> {
  const lookup = ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
    const family = pin.family || isIP(pin.address) || 4;
    if (options?.all) cb(null, [{ address: pin.address, family }]);
    else cb(null, pin.address, family);
  }) as unknown as LookupFunction;
  const headers: Record<string, string> = {};
  init.headers.forEach((v, k) => { headers[k] = v; });
  headers["accept"] ??= "*/*";
  headers["user-agent"] ??= "node";
  headers["accept-encoding"] ??= "gzip, deflate, br";
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  const options = {
    method: init.method,
    host: hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    headers,
    lookup,
    signal: init.signal,
    ...(u.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
    agent: false as const,
  };
  return new Promise<PinnedResponse>((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsReq : httpReq)(options, (res: IncomingMessage) => {
      const h = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) { try { h.append(res.rawHeaders[i], res.rawHeaders[i + 1]); } catch { /* a header fetch would refuse too */ } }
      const status = res.statusCode ?? 0;
      const empty = init.method === "HEAD" || status === 204 || status === 304;
      const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
      const decoder = empty ? null : encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
      const stream: Readable = decoder ? res.pipe(decoder) : res;
      if (decoder) res.on("error", (err) => decoder.destroy(err));
      if (empty) res.resume();
      resolve({
        status,
        statusText: res.statusMessage ?? "",
        ok: status >= 200 && status < 300,
        headers: h,
        body: empty ? null : Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
        discard: () => { res.destroy(); },
      });
    });
    req.on("error", reject);
    if (init.body !== undefined) req.end(typeof init.body === "string" ? init.body : Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength));
    else req.end();
  });
}

async function readResponse(res: PinnedResponse, finalUrl: string, maxBytes: number, started: number): Promise<Record<string, unknown>> {
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
