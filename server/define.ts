// m5mobile.define (6.3) — the operator's typed definitions, stored once and
// served to every runtime.
//
//   GET  /api/define?scope=web|android|ios   the materialized values a client reads (ios = android: the mobile apps)
//   GET  /api/admin/define               the full definition set (the console)
//   PUT  /api/admin/define               operator saves it
//
// The console (Android › Define) edits the set with a GUI builder; the web app
// fetches its materialized values, the Android bundle carries them, and the
// Functions sandbox exposes them as `m5mobile.define.<name>`. One source of
// truth, validated by the same shared module (client/src/lib/define/schema.ts)
// everywhere, so a value never differs between a Package, a Model and an app.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Express, Request, Response } from "express";
import {
  DEFAULT_DEFINE_SET, defineValues, oversized, sanitizeDefineSet, type DefineSet,
} from "../client/src/lib/define/schema";
import { audit } from "./monitor/audit";
import { adminName, type AdminRequest } from "./admin-auth";

const env = (name: string): string => (process.env[name]?.trim() || "");

export function definePath(): string {
  const explicit = env("DEFINE_FILE");
  if (explicit) return resolve(explicit);
  const dir = env("DATA_DIR");
  return dir ? resolve(dir, "define.json") : resolve(process.cwd(), ".m5cet", "define.json");
}

function stamp(file: string): string {
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
}

export class DefineStore {
  private cache: { set: DefineSet; stamp: string; file: string } | null = null;

  get(): DefineSet {
    const file = definePath();
    const now = stamp(file);
    if (this.cache && this.cache.stamp === now && this.cache.file === file) return this.cache.set;
    let set = DEFAULT_DEFINE_SET;
    try { set = sanitizeDefineSet(JSON.parse(readFileSync(file, "utf8"))); } catch { /* missing or corrupt → empty */ }
    this.cache = { set, stamp: now, file };
    return set;
  }

  set(raw: unknown, now = Date.now()): { ok: true; set: DefineSet } | { ok: false; message: string } {
    const set = sanitizeDefineSet(raw);
    set.updatedAt = now;
    const over = oversized(set);
    if (over.length) return { ok: false, message: `These definitions exceed their max size: ${over.join(", ")}` };
    const file = definePath();
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "write failed" };
    }
    this.cache = null;
    return { ok: true, set };
  }

  /** name → value, for a client of the given scope. */
  values(scope: "android" | "web" | "both"): Record<string, unknown> {
    return defineValues(this.get(), scope);
  }
}

export const defineStore = new DefineStore();

export function registerDefineRoutes(app: Express): void {
  app.get("/api/define", (req: Request, res: Response) => {
    // 6.14: the iOS app reads the mobile apps' values — a definition scoped "android" is for both apps
    // (the console's iOS › Define edits the same set, shared with Android).
    const asked = req.query.scope === "ios" ? "android" : req.query.scope;
    const scope = asked === "android" || asked === "web" ? (asked as "android" | "web") : "both";
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, values: defineStore.values(scope), updatedAt: defineStore.get().updatedAt });
  });
}

/** Mounted behind the admin guard (GET auditor, PUT operator). */
export function registerAdminDefineRoutes(app: Express): void {
  app.get("/api/admin/define", (_req, res) => {
    res.json({ ok: true, define: defineStore.get() });
  });
  app.put("/api/admin/define", (req: AdminRequest, res: Response) => {
    const body = (req.body ?? {}) as { define?: unknown };
    const saved = defineStore.set(body.define ?? body);
    if (!saved.ok) return res.status(400).json({ ok: false, message: saved.message });
    audit.add({ category: "admin", level: "notice", event: "define.save", actor: adminName(req), detail: { count: saved.set.defs.length } });
    res.json({ ok: true, define: saved.set });
  });
}
