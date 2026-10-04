// The control plane's console endpoints (6.9), on the admin service behind
// its authentication and consoleGuard("telephony", telephonyConsoleRight) —
// the right each one needs is in api-contract.ts (TELEPHONY_API):
//
//   GET    /admin/telephony/permissions        TelPermissions + the module's access per group (read-only)
//   PUT    /admin/telephony/permissions        save (validated, clamped)               settings
//   GET    /admin/telephony/rules              { inbound, outbound } in priority order
//   PUT    /admin/telephony/rules/inbound      replace the list (order = priority)    routing
//   PUT    /admin/telephony/rules/outbound                                             routing
//   POST   /admin/telephony/rules/test         dry run: RouteQuestion → RouteDecision (optionally over a draft)
//   GET    /admin/telephony/inroute            the live inroute table (codes and rooms in full with
//                                              "settings"; else masked — 6.10 G-03)
//   POST   /admin/telephony/inroute            add a code (tests)                      settings
//   DELETE /admin/telephony/inroute/:code      remove one                              settings
//
// Answers are { ok: true, … } or { ok: false, message, problems? }.

import type { Express, Request, Response } from "express";
import { clientConfigStore } from "../../client-config";
import { mainGroupOf } from "../../../client/src/lib/modules";
import { sipStore } from "../sip";
import type { InrouteEntry, RouteQuestion, TelPermissions } from "./types";
import type { InrouteAddBody, PermissionsAnswer, RulesAnswer } from "./api-contract";
import { checkInbound, checkOutbound, checkPermissions, controlMeta, getPermissions, getRules, PERMISSION_BOUNDS, ROUTE_SOURCES, savePermissions, saveRules, type Problem } from "./store";
import { decideWith } from "./rules";
import { InrouteError, inrouteAdd, inrouteDel, inrouteList, maskCode } from "./inroute";
import { consoleCan } from "../../access";
import { hashRoom } from "../../monitor/traffic";
import { CALL_PROVIDERS } from "./store";

const adminOf = (res: Response): string => String(res.locals.adminName ?? "admin").slice(0, 80);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");

/** The module's access as Modules & groups decides it: per group, what it allows and takes away. */
export function telephonyAccess(): PermissionsAnswer["access"] {
  const rule = clientConfigStore.get().modules.telephony;
  // No rule: the module is on for everyone with every right ("unlisted").
  if (!rule) return [{ group: "*", allow: ["*"], deny: [] }];
  if (rule.enabled === false) return [];
  const rows = new Map<string, { group: string; allow: string[]; deny: string[] }>();
  const row = (group: string) => { let r = rows.get(group); if (!r) { r = { group, allow: [], deny: [] }; rows.set(group, r); } return r; };
  row(mainGroupOf("telephony")).allow.push("*");
  for (const g of rule.groups ?? []) if ((rule.groupAccess ?? "allow") === "allow") row(g).allow.push("*"); else row(g);
  for (const g of rule.grants ?? []) for (const r of g.rights) (r.startsWith("-") ? row(g.group).deny : row(g.group).allow).push(r.replace(/^-/, ""));
  if ((rule.defaultAccess ?? ((rule.groups ?? []).length ? "deny" : "allow")) === "allow") row("*").allow.push("*");
  return [...rows.values()].map((r) => ({ ...r, allow: [...new Set(r.allow)], deny: [...new Set(r.deny)] }));
}

const refuse = (res: Response, status: number, message: string, problems?: Problem[]) => res.status(status).json({ ok: false, message, ...(problems ? { problems } : {}) });

/** A dry-run question from the console. */
function questionOf(raw: unknown): { q: RouteQuestion } | { problem: string } {
  const b = obj(raw);
  const direction = str(b.direction);
  if (direction !== "inbound" && direction !== "outbound") return { problem: "direction: inbound or outbound" };
  const provider = str(b.provider);
  if (provider && !(CALL_PROVIDERS as readonly string[]).includes(provider)) return { problem: `provider: empty or ${CALL_PROVIDERS.join(", ")}` };
  const service = str(b.service);
  if (service && service !== "app" && service !== "sip") return { problem: "service: empty, app or sip" };
  const source = str(b.source);
  if (source && !(ROUTE_SOURCES as readonly string[]).includes(source)) return { problem: `source: ${ROUTE_SOURCES.join(", ")}` };
  const at = typeof b.at === "number" ? b.at : typeof b.at === "string" && b.at ? Date.parse(b.at) : Date.now();
  if (!Number.isFinite(at)) return { problem: "at: a time (milliseconds or ISO 8601)" };
  const groups = Array.isArray(b.groups) ? b.groups.map((g) => str(g, 32)).filter(Boolean).slice(0, 50) : [];
  return {
    q: {
      direction, from: str(b.from), to: str(b.to), at, groups,
      ...(provider ? { provider: provider as RouteQuestion["provider"] } : {}),
      ...(service ? { service: service as RouteQuestion["service"] } : {}),
      ...(source ? { source: source as RouteQuestion["source"] } : {}),
    },
  };
}

/** An inroute entry for a reader without "settings": the code's last digit, the room's hash. */
export function maskedEntry(e: InrouteEntry): InrouteEntry {
  return { ...e, code: maskCode(e.code), room: hashRoom(e.room) ?? "" };
}

function inrouteFailed(res: Response, err: unknown) {
  if (err instanceof InrouteError) return refuse(res, err.code === "code-taken" ? 409 : err.code === "inroute-limit" ? 429 : err.code === "busy" ? 503 : 400, err.message);
  return refuse(res, 500, (err as Error).message.slice(0, 300));
}

export function registerControlRoutes(app: Express): void {
  /* ------------------------------------------------------- permissions */

  app.get("/admin/telephony/permissions", (_req: Request, res: Response) => {
    const answer: PermissionsAnswer = { permissions: getPermissions(), access: telephonyAccess() };
    res.json({ ok: true, ...answer, bounds: PERMISSION_BOUNDS, meta: controlMeta().permissions });
  });

  app.put("/admin/telephony/permissions", (req: Request, res: Response) => {
    const body = obj(req.body);
    const r = savePermissions(body.permissions !== undefined ? body.permissions : body, adminOf(res));
    if (!r.ok) return refuse(res, r.problems.length ? 400 : 500, r.message, r.problems);
    const answer: PermissionsAnswer = { permissions: r.value, access: telephonyAccess() };
    res.json({ ok: true, ...answer, notes: r.notes, meta: controlMeta().permissions });
  });

  /* ------------------------------------------------------------ rules */

  app.get("/admin/telephony/rules", (_req: Request, res: Response) => {
    const answer: RulesAnswer = getRules();
    // The trunks a "sip" service can name (no secrets: sip.ts never returns a password).
    res.json({ ok: true, ...answer, trunks: sipStore.list().map((t) => ({ id: t.id, label: t.label, host: t.host, callerIdNumber: t.callerIdNumber, callerIdName: t.callerIdName, source: t.source })), meta: controlMeta().rules });
  });

  for (const direction of ["inbound", "outbound"] as const) {
    app.put(`/admin/telephony/rules/${direction}`, (req: Request, res: Response) => {
      const body = obj(req.body);
      const r = saveRules(direction, body.rules !== undefined ? body.rules : req.body, adminOf(res));
      if (!r.ok) return refuse(res, r.problems.length ? 400 : 500, r.message, r.problems);
      res.json({ ok: true, rules: r.value, notes: r.notes, meta: controlMeta().rules });
    });
  }

  // A dry run — over the saved rules, or over a draft the editor has not saved yet.
  app.post("/admin/telephony/rules/test", (req: Request, res: Response) => {
    const body = obj(req.body);
    const parsed = questionOf(body.question !== undefined ? body.question : body);
    if ("problem" in parsed) return refuse(res, 400, parsed.problem);
    const saved = getRules();
    const draft = obj(body.draft);
    const problems: Problem[] = [];
    const inbound = draft.inbound !== undefined ? (() => { const c = checkInbound(draft.inbound); problems.push(...c.problems); return c.rules; })() : saved.inbound;
    const outbound = draft.outbound !== undefined ? (() => { const c = checkOutbound(draft.outbound); problems.push(...c.problems); return c.rules; })() : saved.outbound;
    let permissions: TelPermissions = getPermissions();
    if (draft.permissions !== undefined) { const c = checkPermissions(draft.permissions, permissions); problems.push(...c.problems); permissions = c.permissions; }
    if (problems.length) return refuse(res, 400, `the draft has ${problems.length} problem(s): ${problems[0].path} — ${problems[0].message}`, problems);
    res.json({ ok: true, ...decideWith(parsed.q, { inbound, outbound, permissions }), draft: draft.inbound !== undefined || draft.outbound !== undefined || draft.permissions !== undefined });
  });

  /* ---------------------------------------------------------- inroute */

  // 6.10 (G-03): a live code is a key to a room's audio (dial the number, type it) and the room
  // is its blind id (an offline test of the room key, and the hub's address of the room). Only
  // who may change the table ("settings") reads them in full; everyone else sees the last digit
  // and the room's hash, as in the log.
  app.get("/admin/telephony/inroute", async (req: Request, res: Response) => {
    try {
      const entries: InrouteEntry[] = await inrouteList({ limit: 5000 });
      const full = consoleCan(req, res, "telephony", [["settings"]], false);
      res.json({ ok: true, entries: full ? entries : entries.map(maskedEntry), masked: !full, limits: getPermissions().inroute });
    } catch (err) { inrouteFailed(res, err); }
  });

  app.post("/admin/telephony/inroute", async (req: Request, res: Response) => {
    const b = obj(req.body) as Partial<InrouteAddBody> & Record<string, unknown>;
    try {
      const entry = await inrouteAdd({
        code: str(b.code, 12), ...(b.digits !== undefined ? { digits: Number(b.digits) } : {}),
        type: (str(b.type) || "room") as InrouteEntry["type"], room: str(b.room), user: str(b.user, 80),
        ...(b.ttl !== undefined && b.ttl !== null ? { ttl: Number(b.ttl) } : {}),
        label: str(b.label, 80), maxUses: Number(b.maxUses) || 0,
        createdBy: { kind: "console", id: adminOf(res) },
      });
      res.json({ ok: true, entry });
    } catch (err) { inrouteFailed(res, err); }
  });

  app.delete("/admin/telephony/inroute/:code", async (req: Request, res: Response) => {
    try {
      const removed = await inrouteDel(String(req.params.code), { by: `admin:${adminOf(res)}` });
      if (!removed) return refuse(res, 404, "no such live route code");
      res.json({ ok: true });
    } catch (err) { inrouteFailed(res, err); }
  });
}
