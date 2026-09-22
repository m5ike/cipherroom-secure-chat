// Which reverse proxies may tell us the real client address (X-Forwarded-For).
//
// Behind nginx the TCP peer is nginx itself, so with Express's default
// (`trust proxy` = false) every visitor had the same req.ip — 127.0.0.1 —
// and shared ONE rate-limit bucket: 100 /api requests per 15 min for the
// whole site, 10 telephony requests per 10 min for everyone together.
// express-rate-limit reports exactly that at the first proxied request
// (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
//
// TRUST_PROXY (env) accepts everything Express does:
//   unset          loopback — nginx/Caddy on the same host (native install);
//                  inside a container also the private ranges, because the
//                  host proxy then arrives via the Docker/Podman gateway
//   false | 0      trust nobody (the app is exposed directly, no proxy)
//   1, 2, …        trust that many hops (e.g. 2 = Cloudflare → nginx → app)
//   list           comma-separated IPs / CIDRs / presets: loopback,
//                  linklocal, uniquelocal, 10.0.0.0/8, …
//   true           trust every hop — spoofable; express-rate-limit warns
//
// Only addresses inside the trusted set are skipped, so a client can never
// pick its own req.ip by sending a forged X-Forwarded-For through nginx
// ($proxy_add_x_forwarded_for appends the address nginx really saw).

import { existsSync } from "node:fs";
import type { Express } from "express";

export type TrustProxyValue = boolean | number | string;

const CONTAINER_DEFAULT = "loopback, linklocal, uniquelocal";
const HOST_DEFAULT = "loopback";

export function runningInContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export function resolveTrustProxy(raw: string | undefined, inContainer = runningInContainer()): { value: TrustProxyValue; source: "env" | "default" } {
  const v = raw?.trim();
  if (!v) return { value: inContainer ? CONTAINER_DEFAULT : HOST_DEFAULT, source: "default" };
  const lower = v.toLowerCase();
  if (["false", "0", "off", "no", "none"].includes(lower)) return { value: false, source: "env" };
  if (["true", "on", "yes", "all"].includes(lower)) return { value: true, source: "env" };
  if (/^\d+$/.test(v)) return { value: Number(v), source: "env" };
  return { value: v, source: "env" };
}

/** Apply TRUST_PROXY to an Express app. An invalid value is reported and the
 *  safe default used instead of refusing to boot. Returns what was applied. */
export function applyTrustProxy(app: Express, raw = process.env.TRUST_PROXY, inContainer = runningInContainer()): TrustProxyValue {
  const resolved = resolveTrustProxy(raw, inContainer);
  try {
    app.set("trust proxy", resolved.value);
    return resolved.value;
  } catch (err) {
    const fallback = resolveTrustProxy(undefined, inContainer).value;
    console.error(`[trust-proxy] ignoring invalid TRUST_PROXY=${JSON.stringify(raw)} (${(err as Error).message}); using "${fallback}"`);
    app.set("trust proxy", fallback);
    return fallback;
  }
}
