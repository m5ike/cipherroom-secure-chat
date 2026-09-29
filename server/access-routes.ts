// The console's access endpoints (5.2), in the admin service:
//
//   GET  /admin/access/me        the modules this administrator may use, and which parts
//   GET  /admin/access/log       the access log: module, decision, subject, kind, text, days, limit
//   POST /admin/access/explain   { module, subject: "alice" | "admin:bob" | "guest", right? }
//                                → the decision, why, the groups and the rights that count

import type { Express, Request, Response } from "express";
import { accessLog } from "./access-log";
import { adminSubject, checkAccess, consolePrincipal, decision, userSubject, type Needs } from "./access";
import { MODULE_CATALOG, MODULE_BY_ID, permits } from "../client/src/lib/modules";
import { clientConfigStore } from "./client-config";

/** AI & speech in the console: reading needs the module; tries need "playground"; the rest "settings". */
export function aiConsoleRight(req: Request): Needs | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const provider = /^\/providers\/([^/]+)/.exec(req.path)?.[1];
  const item: Needs = provider ? [[`provider:${decodeURIComponent(provider)}`]] : [];
  if (/^\/(playground|speech\/)/.test(req.path) || /\/test$/.test(req.path)) return [["playground", "settings"], ...item];
  return [["settings"], ...item];
}

/** "chat provider:openai" or "run, model:dns|package:net" → aspects (space or comma between, | inside). */
export const parseNeeds = (text: string): Needs => text.split(/[\s,&]+/).map((x) => x.split("|").map((y) => y.trim()).filter(Boolean)).filter((x) => x.length);

export function registerAccessRoutes(app: Express): void {
  app.get("/admin/access/me", (req: Request, res: Response) => {
    const p = consolePrincipal(req, res);
    if (!p) return res.status(401).json({ ok: false });
    const subject = adminSubject(p.name, p.role);
    const modules = MODULE_CATALOG.filter((m) => m.console).map((m) => {
      const d = decision(m.id, subject.groups);
      const owner = p.role === "owner";
      return { id: m.id, label: m.label, console: m.console, allowed: d.allowed || owner, reason: d.allowed ? d.reason : owner ? "owner" : d.reason, rights: owner && !d.allowed ? ["*"] : d.rights.list };
    });
    res.json({ ok: true, name: p.name, role: p.role, groups: subject.groups, modules });
  });

  app.get("/admin/access/log", async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const out = await accessLog.query({ module: q.module || undefined, decision: q.decision || undefined, subject: q.subject || undefined, kind: q.kind || undefined, text: q.q || undefined, days: Number(q.days) || 2, limit: Number(q.limit) || 300 });
    res.json({ ok: true, ...out });
  });

  app.post("/admin/access/explain", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { module?: string; subject?: string; right?: string };
    const id = String(body.module ?? "");
    if (!MODULE_BY_ID[id]) return res.status(400).json({ ok: false, message: "Unknown module." });
    const who = String(body.subject ?? "").trim();
    const admin = /^admin:([a-z0-9][a-z0-9._-]{1,31})(?:@(owner|operator|auditor))?$/.exec(who);
    const subject = admin ? adminSubject(admin[1], admin[2] ?? "operator") : userSubject(who && who !== "guest" ? who : null);
    const d = decision(id, subject.groups);
    const rule = clientConfigStore.get().modules[id] ?? null;
    const right = String(body.right ?? "").trim();
    const withRight = right ? d.allowed && permits(d.rights, ...parseNeeds(right)) : d.allowed;
    // An explanation is not an access: not logged, but the result is the real rule's.
    res.json({ ok: true, subject: subject.name, kind: subject.kind, groups: subject.groups, allowed: d.allowed, reason: d.reason, rights: d.rights.list, right: right || null, rightAllowed: withRight, rule });
    void checkAccess; // (the same decision checkAccess makes, without the log line)
  });
}
