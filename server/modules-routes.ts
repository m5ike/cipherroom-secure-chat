// The console's Modules & groups endpoints (5.2), in the main service
// behind the admin guard (GET auditor, PUT operator):
//
//   GET /api/admin/modules/state      the server switches (AI, speech,
//                                     functions: on/off, who decided) and the
//                                     main groups (created when missing)
//   PUT /api/admin/modules/switches   { ai?, speech?, functions? } — the
//                                     services themselves (plugins.json; an
//                                     ENABLE_* variable wins)

import type { Express, Request, Response } from "express";
import { setPluginSwitches, switchState, type PluginSwitch } from "./plugins/settings";
import { ensureMainGroups, switchRefused } from "./access";
import { audit } from "./monitor/audit";
import { adminName } from "./admin-auth";
import { TOOL_MODULES, mainGroupOf } from "../client/src/lib/modules";

const SWITCHES: PluginSwitch[] = ["ai", "speech", "functions"];

export function registerModulesAdminRoutes(app: Express): void {
  app.get("/api/admin/modules/state", (req: Request, res: Response) => {
    const created = ensureMainGroups(adminName(req));
    res.json({ ok: true, switches: Object.fromEntries(SWITCHES.map((s) => [s, switchState(s)])), mainGroups: Object.fromEntries(TOOL_MODULES.map((m) => [m, mainGroupOf(m)])), created });
  });

  app.put("/api/admin/modules/switches", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const change: Partial<Record<PluginSwitch, boolean>> = {};
    for (const s of SWITCHES) if (typeof body[s] === "boolean") change[s] = body[s] as boolean;
    if (!Object.keys(change).length) return res.status(400).json({ ok: false, message: "Send { ai?, speech?, functions?: true|false }." });
    const refused = switchRefused(req, res, Object.keys(change));
    if (refused) return res.status(403).json({ ok: false, code: "module-denied", message: refused });
    const r = setPluginSwitches(change, adminName(req));
    if (!r.ok) return res.status(409).json(r);
    audit.add({ category: "admin", level: "notice", event: "admin.modules.switches", actor: adminName(req), detail: Object.fromEntries(Object.entries(change).map(([k, v]) => [k, v ? "on" : "off"])) });
    res.json({ ok: true, switches: Object.fromEntries(SWITCHES.map((s) => [s, switchState(s)])) });
  });
}
