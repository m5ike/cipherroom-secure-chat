// The public API's general rate limit (index.ts mounts it on /api): requests
// per client address (see trust-proxy.ts) in a sliding window. 6.8: the
// operator sets it — API_RATE_LIMIT (requests, default 100) and
// API_RATE_WINDOW_MIN (minutes, default 15) — and the routes that have a
// bucket of their own no longer spend this one too:
//
//   /api/account/vault, /api/storage, /api/admin, /api/android, /api/profile
//                            their own, larger buckets (index.ts)
//   /api/map/tile/…          300 a minute (map-tiles.ts) — a map preview is
//                            several tiles, and a room's history several maps
//   the passkey ceremonies   30 in 10 minutes (accounts/routes.ts) — so a busy
//                            browser can still sign in
//   /api/kt/…                600 in 15 minutes (kt/routes.ts, 6.12) — clients
//                            check the key-transparency log for every peer
//   PUT /api/keys/bundle     60 in 15 minutes (keys/routes.ts, 6.12)
//
// Before 6.8 a page that drew a few maps used up the 100 requests and the
// next passkey sign-in got "Too many requests, please try again later."

export const API_LIMIT_DEFAULT = 100;
export const API_WINDOW_MIN_DEFAULT = 15;

const LIMIT_RANGE = [10, 100_000] as const;
const WINDOW_RANGE = [1, 1440] as const;

/** A whole number from the environment within [min, max], else the default (and why). */
function envInt(raw: string | undefined, def: number, [min, max]: readonly [number, number], name: string, problems: string[]): number {
  const v = raw?.trim();
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name}=${JSON.stringify(v)} is not a whole number from ${min} to ${max}; using ${def}`);
    return def;
  }
  return n;
}

export type ApiLimitConfig = { limit: number; windowMin: number; windowMs: number; problems: string[] };

/** The general limit from API_RATE_LIMIT / API_RATE_WINDOW_MIN (an invalid value is reported, the default used). */
export function apiLimitConfig(env: Record<string, string | undefined> = process.env): ApiLimitConfig {
  const problems: string[] = [];
  const limit = envInt(env.API_RATE_LIMIT, API_LIMIT_DEFAULT, LIMIT_RANGE, "API_RATE_LIMIT", problems);
  const windowMin = envInt(env.API_RATE_WINDOW_MIN, API_WINDOW_MIN_DEFAULT, WINDOW_RANGE, "API_RATE_WINDOW_MIN", problems);
  return { limit, windowMin, windowMs: windowMin * 60_000, problems };
}

/** Prefixes whose routes have a bucket of their own (the path itself or below it). */
const OWN_BUCKET_PREFIXES = ["/api/account/vault", "/api/storage", "/api/admin", "/api/android", "/api/profile", "/api/map/tile", "/api/kt"];

/** The passkey ceremonies (accounts/routes.ts ceremonyLimiter, registrationLimiter, recoveryLimiter). */
const OWN_BUCKET_ROUTES = new Set([
  "POST /api/account/register/options", "POST /api/account/register/verify", "POST /api/account/register/check", "POST /api/account/register/start",
  "POST /api/account/signin/options", "POST /api/account/signin/verify", "POST /api/account/unlock",
  "POST /api/account/passkeys/options", "POST /api/account/passkeys/verify",
  "POST /api/account/recovery/start", "POST /api/account/recovery/finish",
  // 6.12: the key directory (keys/routes.ts, 60 in 15 minutes).
  "PUT /api/keys/bundle",
]);

/** Whether a request is counted by its own route's limiter instead of the general one. */
export function hasOwnBucket(method: string, originalUrl: string): boolean {
  const q = originalUrl.indexOf("?");
  const path = q < 0 ? originalUrl : originalUrl.slice(0, q);
  if (OWN_BUCKET_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return true;
  return OWN_BUCKET_ROUTES.has(`${method.toUpperCase()} ${path}`);
}
