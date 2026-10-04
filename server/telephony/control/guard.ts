// Which right a console request under /admin/telephony needs (6.9). The
// endpoints and their rights are the contract (api-contract.ts,
// TELEPHONY_API): a known endpoint needs its `right` (null = the module
// alone — reading); the older endpoints that are not in the list keep their
// rule — a change needs "settings", the old /test… needs "test" (or
// "settings"), reading needs the module. admin.ts hands this to
// consoleGuard("telephony", …).

import type { Request } from "express";
import { TELEPHONY_API, type Endpoint } from "./api-contract";
import type { Needs } from "../../access";

type Compiled = { ep: Endpoint; re: RegExp; params: number };

const COMPILED: Compiled[] = TELEPHONY_API.map((ep) => ({
  ep,
  // 6.10 (G-02): case-insensitive like a default Express router — the apps route exactly
  // (exact-routing.ts), and a guard must never be the looser of the two.
  re: new RegExp(`^${ep.path.split("/").map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`, "i"),
  params: ep.path.split("/").filter((s) => s.startsWith(":")).length,
}));

/** The contract's endpoint for a method and a full path (/admin/telephony/…), or null. A literal segment beats a :param. */
export function telephonyEndpoint(method: string, path: string): Endpoint | null {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  let best: Compiled | null = null;
  for (const c of COMPILED) if (c.ep.method === m && c.re.test(p) && (!best || c.params < best.params)) best = c;
  return best?.ep ?? null;
}

/** consoleGuard's rule for /admin/telephony: the right(s) a request needs, null = the module only. */
export function telephonyConsoleRight(req: Pick<Request, "method" | "path"> & { baseUrl?: string }): Needs | null {
  const full = `${req.baseUrl ?? ""}${req.path}`;
  const ep = telephonyEndpoint(req.method, full.startsWith("/admin/telephony") ? full : `/admin/telephony${req.path}`);
  if (ep) return ep.right ? [[ep.right]] : null;
  const read = req.method === "GET" || req.method === "HEAD";
  if (read) return null;
  return req.path.startsWith("/test") ? [["test", "settings"]] : [["settings"]];
}
