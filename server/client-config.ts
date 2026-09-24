// The operator's client configuration: saved connections (who may keep
// them, how many, which other signaling servers they may use) and the GUI
// templates (which exist for users, the default, a lock). Validated by the
// same pure module the client reads (client/src/lib/client-config.ts).
//
//   CLIENT_CONFIG_FILE              explicit path, or
//   $DATA_DIR/client-config.json    (shared by every instance), or
//   ./.m5cet/client-config.json
//
//   GET /api/client-config          every client, no secrets in it
//   GET /api/admin/client-config    the console (+ how the addons are used)
//   PUT /api/admin/client-config    operator and above

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Express, Request, Response } from "express";
import { DEFAULT_CLIENT_CONFIG, publicClientConfig, sanitizeClientConfig, type ClientConfig } from "../client/src/lib/client-config";
import { BUILTIN_GROUPS, groupsFor, MODULE_CATALOG, moduleAllowed } from "../client/src/lib/modules";
import type { NextFunction } from "express";
import { accountStore, usernameOf } from "./accounts/store";
import { ICON_STYLES, THEME_CATALOG } from "../client/src/lib/theme-catalog";
import { audit } from "./monitor/audit";
import { adminName } from "./admin-auth";

/** The console lists the templates with these names. */
const THEME_LABELS: Record<string, string> = {
  motorsport: "Motorsport Dark", glass: "Glass Light", terminal: "Terminal Secure", midnight: "Midnight", paper: "Paper",
  contrast: "High contrast", ios: "iOS 27", windows: "Windows 11", aurora: "Aurora", nord: "Nord", sakura: "Sakura",
  ocean: "Ocean", graphite: "Graphite",
};
const catalog = () => ({
  themes: THEME_CATALOG.map((t) => ({ id: t.id, family: t.family, tones: t.tones, icons: t.icons, label: THEME_LABELS[t.id] ?? t.id })),
  icons: ICON_STYLES,
  modules: MODULE_CATALOG,
  builtinGroups: BUILTIN_GROUPS,
});
const env = (name: string): string => (process.env[name]?.trim() || "");

export function clientConfigPath(): string {
  const explicit = env("CLIENT_CONFIG_FILE");
  if (explicit) return resolve(explicit);
  const dir = env("DATA_DIR");
  return dir ? resolve(dir, "client-config.json") : resolve(process.cwd(), ".m5cet", "client-config.json");
}

/** mtime, size and inode: a save is an atomic rename, so any change shows. */
function stamp(file: string): string {
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
}

export class ClientConfigStore {
  private cache: { config: ClientConfig; stamp: string; file: string } | null = null;

  get(): ClientConfig {
    const file = clientConfigPath();
    const now = stamp(file);
    if (this.cache && this.cache.stamp === now && this.cache.file === file) return this.cache.config;
    let config = DEFAULT_CLIENT_CONFIG;
    try { config = sanitizeClientConfig(JSON.parse(readFileSync(file, "utf8"))); } catch { /* missing or corrupt → defaults */ }
    this.cache = { config, stamp: now, file };
    return config;
  }

  set(raw: unknown, now = Date.now()): { ok: true; config: ClientConfig } | { ok: false; message: string } {
    const config = { ...sanitizeClientConfig(raw), updatedAt: now };
    const file = clientConfigPath();
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, file);
      this.cache = null;
      return { ok: true, config };
    } catch (err) {
      return { ok: false, message: `cannot write ${file}: ${(err as Error).message}` };
    }
  }
}

export const clientConfigStore = new ClientConfigStore();

/** How the addons are used, from what the server can see without keys. */
export type AddonUsage = { accounts: number; withConnections: number; savedConnections: number };

export function registerClientConfigRoutes(app: Express): void {
  app.get("/api/client-config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, config: publicClientConfig(clientConfigStore.get()) });
  });
}

/** The groups of whoever sends this request: "guest", or the account's. */
export function requestGroups(req: Request): string[] {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const account = token ? accountStore.resolveToken(token) : null;
  return groupsFor(clientConfigStore.get().groups, account ? usernameOf(account) : null);
}

/** The groups of an account (for /api/account/me). */
export function accountGroups(username: string): string[] {
  return groupsFor(clientConfigStore.get().groups, username);
}

/**
 * 4.0: a module the operator switched off (or kept from this user's groups)
 * is refused on the server too, not only hidden in the app.
 */
export function requireModule(id: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (moduleAllowed(clientConfigStore.get().modules, id, requestGroups(req))) return next();
    res.status(403).json({ ok: false, code: "module-disabled", module: id, message: `The ${id} module is not available to you on this server.` });
  };
}

/** Mounted behind the admin guard (GET auditor, PUT operator). */
export function registerAdminClientConfigRoutes(app: Express, usage: () => AddonUsage, features: () => unknown = () => ({})): void {
  app.get("/api/admin/client-config", (_req, res) => {
    // features: which server connectors are configured (the /api/modules
    // manifest) — the console's Modules page shows it next to each module.
    res.json({ ok: true, config: clientConfigStore.get(), defaults: DEFAULT_CLIENT_CONFIG, file: clientConfigPath(), usage: usage(), catalog: catalog(), features: features() });
  });
  app.put("/api/admin/client-config", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = clientConfigStore.set(body.config ?? body);
    if (!saved.ok) return res.status(500).json({ ok: false, message: saved.message });
    const c = saved.config;
    audit.add({
      category: "admin", level: "notice", event: "admin.client-config", actor: adminName(req),
      detail: {
        connections: c.connections.enabled, servers: c.connections.servers.length, customServers: c.connections.allowCustomServers,
        themes: c.appearance.themes.length || "all", defaultTheme: c.appearance.defaultTheme, lockTheme: c.appearance.lockTheme,
        modulesOff: Object.entries(c.modules).filter(([, r]) => !r.enabled).map(([id]) => id).join(",") || "none",
        groups: c.groups.length,
      },
    });
    res.json({ ok: true, config: c, usage: usage() });
  });
}
