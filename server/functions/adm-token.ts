// m5adm (6.0): how a function reaches the administration. A run whose model
// the owner granted access (Functions › model › Administration) gets a
// short-lived token, signed with a key both services read ($DATA_DIR), and
// calls the main service's /api/admin/* with it — the same routes, guards
// and audit journal as the console, never more than the grant:
//
//   role    auditor (read) · operator (act) · owner (also administrators)
//   areas   which parts of the console: rooms, users, audit… (an empty
//           grant is none; the token lists them, the guard enforces them
//           path by path — admin-auth.ts)
//
// The token names the model and the caller, so the journal says who acted:
// "fn:<model>/<caller>". It lives until the run's deadline (at most 15 min).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { adminDir, ROLE_RANK, type AdminRole } from "../admin-users";

export const ADM_AREAS = ["overview", "rooms", "connections", "traffic", "modules", "users", "queue", "audit", "commands", "admins"] as const;
export type AdmArea = typeof ADM_AREAS[number];
export const isAdmArea = (v: unknown): v is AdmArea => ADM_AREAS.includes(v as AdmArea);

/** What the owner granted a model (or a console administrator has in a test run). */
export type AdmGrant = { role: AdminRole; areas: AdmArea[] };

const PREFIX = "m5f1.";
const MAX_TTL_MS = 15 * 60 * 1000;
const ROLES: AdminRole[] = ["auditor", "operator", "owner"];

let cachedKey: { file: string; key: Buffer } | null = null;

/** The signing key, shared by the main and the admin service through the data directory. */
function signingKey(): Buffer {
  const file = process.env.FUNCTIONS_ADM_KEY_FILE?.trim() || join(adminDir(), "functions-adm.key");
  if (cachedKey?.file === file) return cachedKey.key;
  const read = (): Buffer | null => { try { const k = Buffer.from(readFileSync(file, "utf8").trim(), "base64url"); return k.length >= 32 ? k : null; } catch { return null; } };
  let key = read();
  if (!key) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // "wx": whichever service is first writes it; the other reads that one.
      writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
    } catch { /* the other service was first */ }
    key = read();
  }
  if (!key) throw new Error(`cannot read or create the m5adm key at ${file}`);
  cachedKey = { file, key };
  return key;
}

const mac = (payload: string) => createHmac("sha256", signingKey()).update(`m5adm/1|${payload}`).digest("base64url");

/** Areas as a bit mask (the token must stay under the directory's 256-character limit). */
const maskOf = (areas: readonly AdmArea[]) => areas.reduce((m, a) => m | (1 << ADM_AREAS.indexOf(a)), 0);
const areasOf = (mask: number) => ADM_AREAS.filter((_, i) => (mask & (1 << i)) !== 0);

export type AdmTokenClaims = { role: AdminRole; areas: AdmArea[]; model: string; caller: string; exp: number };

/** A token for one run: the grant, who (model and caller), until when. */
export function mintAdmToken(grant: AdmGrant, who: { model: string; caller: string }, ttlMs: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({
    r: ROLES.indexOf(grant.role),
    a: maskOf(grant.areas),
    m: who.model.slice(0, 40),
    c: who.caller.replace(/[^\p{L}\p{N}._@ -]/gu, "").slice(0, 24),
    x: Math.floor((now + Math.max(1_000, Math.min(ttlMs, MAX_TTL_MS))) / 1000),
  })).toString("base64url");
  return `${PREFIX}${payload}.${mac(payload)}`;
}

/** The claims of a valid, unexpired token; null for anything else. */
export function verifyAdmToken(token: string, now = Date.now()): AdmTokenClaims | null {
  if (!token.startsWith(PREFIX)) return null;
  const [payload, sig] = token.slice(PREFIX.length).split(".");
  if (!payload || !sig) return null;
  let expected: Buffer;
  try { expected = Buffer.from(mac(payload)); } catch { return null; }
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { r?: number; a?: number; m?: string; c?: string; x?: number };
    const role = ROLES[c.r ?? -1];
    if (!role || typeof c.x !== "number" || c.x * 1000 < now) return null;
    return { role, areas: areasOf(Number(c.a) || 0), model: String(c.m ?? ""), caller: String(c.c ?? ""), exp: c.x * 1000 };
  } catch { return null; }
}

export const isAdmToken = (token: string) => token.startsWith(PREFIX);

/* ------------------------------------------------------------ paths */

/** Which area an /api/admin path belongs to; null: never for a function (sign-in, own passkeys, live stream, storage…). */
export function areaOfPath(path: string, method: string): AdmArea | null {
  const p = path.replace(/^\/api\/admin/, "").split("?")[0];
  const is = (prefix: string) => p === prefix || p.startsWith(`${prefix}/`);
  if (is("/overview") || is("/system") || is("/metrics") || is("/alerts") || is("/backups") || (is("/db") && method === "GET") || is("/whoami")) return "overview";
  if (is("/rooms")) return "rooms";
  if (is("/connections")) return "connections";
  if (is("/traffic") || is("/events")) return "traffic";
  if (is("/client-config") || is("/modules")) return "modules";
  if (is("/users")) return "users";
  if (is("/queue")) return "queue";
  if (is("/audit")) return "audit";
  if (is("/commands") || is("/push")) return "commands";
  if (is("/admins")) return "admins";
  return null;
}

/** May a function principal with these areas call this path? (/whoami: always.) */
export function admPathAllowed(areas: readonly AdmArea[], path: string, method: string): boolean {
  const area = areaOfPath(path, method);
  if (!area) return false;
  if (path.replace(/^\/api\/admin/, "").startsWith("/whoami")) return true;
  return areas.includes(area);
}

/** A grant as the model stores it, cleaned: known areas; a role an owner may give. */
export function sanitizeGrant(raw: unknown): { enabled: boolean; role: AdminRole; areas: AdmArea[] } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const role = ROLES.includes(o.role as AdminRole) ? o.role as AdminRole : "auditor";
  const areas = Array.isArray(o.areas) ? [...new Set(o.areas.filter(isAdmArea))] : [];
  return { enabled: o.enabled === true && areas.length > 0, role, areas };
}

/** The grant a run of a console administrator gets (a test run: what they could do in the console). */
export function consoleGrant(role: AdminRole): AdmGrant {
  return { role, areas: ROLE_RANK[role] >= ROLE_RANK.owner ? [...ADM_AREAS] : ADM_AREAS.filter((a) => a !== "admins") };
}
