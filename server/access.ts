// Module access on the server (5.2): who may use a module and which parts of
// it, for the app's users and the console's administrators — decided by the
// pure rules in client/src/lib/modules.ts, cached per configuration and set
// of groups (a check is a Map lookup and a few regular expressions), and
// written to the access log (server/access-log.ts), allowed and refused.
//
//   requireModule(id)              app routes: 403 when the module is not the caller's
//   consoleGuard(id, rights)       console routes: the administrator's module access,
//                                  plus the right a change needs ("edit", "settings"…)
//   checkAccess(id, subject, …)    everything else (functions, AI models, telephony)

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { clientConfigStore, clientConfigPath } from "./client-config";
import { accessLog, type AccessEntry } from "./access-log";
import { accountStore, usernameOf } from "./accounts/store";
import { adminGroupsFor, compileRights, decide, groupsFor, missingMainGroups, MODULE_BY_ID, permits, type Decision, type Rights } from "../client/src/lib/modules";
import type { ClientConfig } from "../client/src/lib/client-config";

export type Subject = { kind: AccessEntry["kind"]; name: string; groups: string[]; role?: string };

/* ------------------------------------------------------------- groups */

let groupIndex: { config: ClientConfig; users: Map<string, string[]>; decisions: Map<string, Decision> } | null = null;
function index() {
  const config = clientConfigStore.get();
  if (!groupIndex || groupIndex.config !== config) groupIndex = { config, users: new Map(), decisions: new Map() };
  return groupIndex;
}

/** An app user (or a guest): their groups, memoised per configuration. */
export function userSubject(username: string | null | undefined): Subject {
  if (!username) return { kind: "guest", name: "guest", groups: ["guest"] };
  const ix = index();
  let groups = ix.users.get(username);
  if (!groups) { groups = groupsFor(ix.config.groups, username); ix.users.set(username, groups); }
  return { kind: "user", name: username, groups };
}

/** A console administrator: admin, admin-<role>, and the groups listing admin:<name>. */
export function adminSubject(name: string, role: string): Subject {
  const ix = index();
  const key = `admin:${name}|${role}`;
  let groups = ix.users.get(key);
  if (!groups) { groups = adminGroupsFor(ix.config.groups, name, role); ix.users.set(key, groups); }
  return { kind: "admin", name: `admin:${name}`, groups, role };
}

/** The subject of an app request (its bearer token → account). */
export function requestSubject(req: Request): Subject {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const account = token ? accountStore.resolveToken(token) : null;
  return userSubject(account ? usernameOf(account) : null);
}

/** A decision for a module and a set of groups, cached until the configuration changes. */
export function decision(moduleId: string, groups: readonly string[]): Decision {
  const ix = index();
  const key = `${moduleId}|${groups.join(",")}`;
  let d = ix.decisions.get(key);
  if (!d) {
    d = decide(ix.config.modules, moduleId, groups);
    if (ix.decisions.size > 5000) ix.decisions.clear();
    ix.decisions.set(key, d);
  }
  return d;
}

/* ------------------------------------------------------------- checks */

export type Check = { allowed: boolean; reason: string; rights: Rights };
/** What a request needs: aspects, each a list of names (see permits in modules.ts). */
export type Needs = Array<string | readonly string[]>;
const ALL_RIGHTS = compileRights(["*"]);
/** "run & model:dns|package:dns" — for the log and messages. */
export const needsText = (needs: Needs) => needs.map((d) => (typeof d === "string" ? d : d.join("|"))).join(" & ");

/**
 * May `subject` use `moduleId` (and, with `right`, one of those parts)?
 * Console owners always may (they could lock everyone out otherwise) — it
 * is logged as "owner". `log: false` for per-item filtering behind one
 * logged check (a list of commands, of models).
 */
export function checkAccess(moduleId: string, subject: Subject, opts: { right?: Needs; path?: string; ip?: string; via?: string; log?: boolean } = {}): Check {
  const d = decision(moduleId, subject.groups);
  let allowed = d.allowed;
  let reason = d.reason;
  if (allowed && opts.right && opts.right.length && !permits(d.rights, ...opts.right)) { allowed = false; reason = "right"; }
  if (!allowed && subject.kind === "admin" && subject.role === "owner") { allowed = true; reason = "owner"; }
  if (opts.log !== false) {
    const rule = clientConfigStore.get().modules[moduleId];
    const mode = rule?.log ?? "all";
    if (mode === "all" || (mode === "deny" && !allowed)) {
      accessLog.record({ at: Date.now(), module: moduleId, subject: subject.name, kind: subject.kind, decision: allowed ? "allow" : "deny", reason, ...(opts.right?.length ? { right: needsText(opts.right).slice(0, 300) } : {}), ...(opts.path ? { path: opts.path.slice(0, 200) } : {}), ...(opts.ip ? { ip: opts.ip } : {}), via: opts.via ?? "app" });
    }
  }
  return { allowed, reason, rights: reason === "owner" ? ALL_RIGHTS : d.rights };
}

/** Per-item filtering (no log line): the rights of a decision already made. */
export const allows = (c: Check, ...needs: Needs) => c.allowed && (c.reason === "owner" || permits(c.rights, ...needs));

const ipOf = (req: Request) => (req.ip || "").replace(/^::ffff:/, "");

/** App routes: 403 when the module is off or not the caller's. */
export function requireModule(id: string, right?: Needs): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const c = checkAccess(id, requestSubject(req), { right, path: `${req.method} ${req.baseUrl || req.path}`, ip: ipOf(req), via: "app" });
    if (c.allowed) return next();
    res.status(403).json({ ok: false, code: "module-disabled", module: id, message: `The ${MODULE_BY_ID[id]?.label ?? id} module is not available to you on this server.` });
  };
}

/**
 * Console routes. `rightOf` names the parts a request needs (null = just
 * the module): e.g. changes need "edit"; a package's own right also counts.
 * The administrator comes from res.locals (admin service) or req.admin
 * (main service).
 */
export function consoleGuard(id: string, rightOf: (req: Request) => Needs | null = defaultConsoleRight): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const principal = consolePrincipal(req, res);
    if (!principal) return next(); // the auth middleware answers
    const right = rightOf(req);
    const c = checkAccess(id, adminSubject(principal.name, principal.role), { right: right ?? undefined, path: `${req.method} ${req.originalUrl.split("?")[0]}`, ip: ipOf(req), via: "console" });
    res.locals.moduleRights = c;
    if (c.allowed) return next();
    res.status(403).json({ ok: false, code: "module-denied", module: id, message: c.reason === "right" ? `Your access to ${MODULE_BY_ID[id]?.label ?? id} does not include this (${needsText(right ?? [])}).` : `You have no access to ${MODULE_BY_ID[id]?.label ?? id} (Modules & groups).` });
  };
}

/** Reading needs the module; a change needs "edit". */
export function defaultConsoleRight(req: Request): Needs | null {
  return req.method === "GET" || req.method === "HEAD" ? null : ["edit"];
}

export function consolePrincipal(req: Request, res: Response): { name: string; role: string } | null {
  const fromLocals = res.locals.adminName ? { name: String(res.locals.adminName), role: String(res.locals.adminRole ?? "operator") } : null;
  const admin = (req as Request & { admin?: { name: string; role: string } }).admin;
  return fromLocals ?? (admin ? { name: admin.name, role: admin.role } : null);
}

/** For a finer check inside a console route (a package's or a provider's own right). */
export function consoleCan(req: Request, res: Response, id: string, needs: Needs, log = true): boolean {
  const principal = consolePrincipal(req, res);
  if (!principal) return false;
  return checkAccess(id, adminSubject(principal.name, principal.role), { right: needs, path: `${req.method} ${req.originalUrl.split("?")[0]}`, ip: ipOf(req), via: "console", log }).allowed;
}

/** A service switch (AI, speech, functions) is a change to that tool: "settings" / "edit" there. */
const SWITCH_NEEDS: Record<string, [string, Needs]> = { ai: ["ai", [["settings"]]], speech: ["ai", [["settings"]]], functions: ["functions", [["edit"]]] };
export function switchRefused(req: Request, res: Response, keys: readonly string[]): string | null {
  for (const k of keys) {
    const need = SWITCH_NEEDS[k];
    if (need && !consoleCan(req, res, need[0], need[1])) return `Your access to ${MODULE_BY_ID[need[0]]?.label ?? need[0]} does not include switching ${k} (${needsText(need[1])}).`;
  }
  return null;
}

/* ------------------------------------------------------------- main groups */

/** Creates the tool modules' main groups (mod-<id>, all rights) when they are missing. */
export function ensureMainGroups(actor = "system"): boolean {
  const config = clientConfigStore.get();
  const missing = missingMainGroups(config.groups);
  if (!missing.length) return false;
  const r = clientConfigStore.set({ ...config, groups: [...config.groups, ...missing] });
  if (r.ok) accessLog.record({ at: Date.now(), module: "modules", subject: actor, kind: "system", decision: "allow", reason: `created ${missing.map((g) => g.id).join(", ")} in ${clientConfigPath()}`, via: "server" });
  return r.ok;
}
