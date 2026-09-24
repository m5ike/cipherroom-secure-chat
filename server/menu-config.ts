// The app's menu, as the operator builds it in the console (4.0).
// Validated by the same pure module the client renders with
// (client/src/lib/menu-config.ts); the default is the menu as it always was.
//
//   MENU_CONFIG_FILE              explicit path, or
//   $DATA_DIR/menu-config.json    (shared by every instance), or
//   ./.m5cet/menu-config.json
//
//   GET  /api/menu-config                 every client
//   GET  /api/admin/menu-config           the console: config, defaults, and the
//                                         catalog (icons, panels, functions,
//                                         specials, fonts, colours, modules,
//                                         the template language's help)
//   PUT  /api/admin/menu-config           operator and above
//   POST /api/admin/menu-config/render    the builder's preview: labels and
//                                         HTML blocks rendered with sample
//                                         values, as safe element trees

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Express, Request, Response } from "express";
import {
  ALIGNS, BORDER_STYLES, COLOR_TOKENS, DEFAULT_MENU_CONFIG, FONT_STACKS, FONT_WEIGHTS, ICON_POSITIONS, isI18nLabel, MENU_FNS, MENU_LIMITS, MENU_PANELS,
  sanitizeMenuConfig, SHADOWS, SPECIALS, STATE_KEYS, walkNodes, WHEN, WRAPS, type MenuConfig,
} from "../client/src/lib/menu-config";
import {
  renderMenuHtml, renderText, sampleTemplateVars, TEMPLATE_EXAMPLES, TEMPLATE_FILTERS, TEMPLATE_MACROS, TEMPLATE_VARIABLES,
} from "../client/src/lib/menu-template";
import { MENU_ICONS } from "../client/src/lib/menu-icons-data";
import { MODULE_CATALOG } from "../client/src/lib/modules";
import { t, type Lang } from "../client/src/lib/i18n";
import { audit } from "./monitor/audit";
import { adminName } from "./admin-auth";

const env = (name: string): string => (process.env[name]?.trim() || "");

export function menuConfigPath(): string {
  const explicit = env("MENU_CONFIG_FILE");
  if (explicit) return resolve(explicit);
  const dir = env("DATA_DIR");
  return dir ? resolve(dir, "menu-config.json") : resolve(process.cwd(), ".m5cet", "menu-config.json");
}

function stamp(file: string): string {
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
}

export class MenuConfigStore {
  private cache: { config: MenuConfig; stamp: string; file: string } | null = null;

  get(): MenuConfig {
    const file = menuConfigPath();
    const now = stamp(file);
    if (this.cache && this.cache.stamp === now && this.cache.file === file) return this.cache.config;
    let config = DEFAULT_MENU_CONFIG;
    try { config = sanitizeMenuConfig(JSON.parse(readFileSync(file, "utf8"))); } catch { /* missing or corrupt → the default menu */ }
    this.cache = { config, stamp: now, file };
    return config;
  }

  set(raw: unknown, now = Date.now()): { ok: true; config: MenuConfig } | { ok: false; message: string } {
    const config = { ...sanitizeMenuConfig(raw), updatedAt: now };
    const file = menuConfigPath();
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

export const menuConfigStore = new MenuConfigStore();

const allow = { panels: MENU_PANELS, fns: MENU_FNS.map((f) => f.id) };

/** Everything the builder offers, from the same lists the app uses. */
export function menuCatalog() {
  return {
    icons: MENU_ICONS,
    panels: MENU_PANELS,
    fns: MENU_FNS,
    specials: SPECIALS,
    when: WHEN,
    states: STATE_KEYS,
    fonts: Object.keys(FONT_STACKS),
    fontStacks: FONT_STACKS,
    colorTokens: COLOR_TOKENS,
    limits: { width: MENU_LIMITS.width, label: MENU_LIMITS.label, html: MENU_LIMITS.html, nodes: MENU_LIMITS.nodes },
    fontWeights: FONT_WEIGHTS,
    colors: Object.keys(COLOR_TOKENS),
    shadows: SHADOWS,
    borders: BORDER_STYLES,
    aligns: ALIGNS,
    wraps: WRAPS,
    iconPositions: ICON_POSITIONS,
    modules: MODULE_CATALOG.map((m) => ({ id: m.id, label: m.label })),
    template: { variables: TEMPLATE_VARIABLES, filters: TEMPLATE_FILTERS, macros: TEMPLATE_MACROS, examples: TEMPLATE_EXAMPLES },
  };
}

const PREVIEW_STRINGS = [
  "menu.appearance", "menu.clearQuit", "menu.title", "menu.open", "common.close", "mb.tone", "mb.notifications", "id.signIn", "id.signedInAs",
] as const;

/** Labels and HTML blocks as the app would show them (sample values). */
export function renderPreview(config: MenuConfig, lang: Lang = "cs") {
  const vars = sampleTemplateVars();
  const translate = (key: string) => t(lang, key);
  const label = (text: string) => (isI18nLabel(text) ? translate(text.trim().slice(1)) : renderText(text, vars, { translate, lang }));
  const labels: Record<string, string> = {};
  const html: Record<string, { nodes: unknown[]; error: string }> = {};
  const visit = (node: MenuConfig["items"][number]) => {
    if (node.kind === "section" || node.kind === "item") labels[node.id] = label(node.label);
    if (node.kind === "special" && node.label) labels[node.id] = label(node.label);
    if (node.kind === "html") html[node.id] = renderMenuHtml(node.html, vars, allow, { translate, lang });
  };
  walkNodes(config.items, (n) => visit(n));
  walkNodes(config.footer, (n) => visit(n));
  // What the special buttons say when they have no label of their own.
  const strings = Object.fromEntries(PREVIEW_STRINGS.map((key) => [key, translate(key)]));
  return {
    labels,
    html,
    strings,
    title: label(config.panel.title),
    trigger: { text: label(config.trigger.text), title: label(config.trigger.title) },
    vars,
  };
}

export function registerMenuConfigRoutes(app: Express): void {
  app.get("/api/menu-config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, config: menuConfigStore.get() });
  });
}

/** Mounted behind the admin guard (GET auditor; PUT and the preview's POST operator). */
export function registerAdminMenuConfigRoutes(app: Express): void {
  app.get("/api/admin/menu-config", (_req, res) => {
    res.json({ ok: true, config: menuConfigStore.get(), defaults: DEFAULT_MENU_CONFIG, file: menuConfigPath(), catalog: menuCatalog() });
  });
  app.put("/api/admin/menu-config", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = menuConfigStore.set(body.config ?? body);
    if (!saved.ok) return res.status(500).json({ ok: false, message: saved.message });
    let nodes = 0;
    walkNodes(saved.config.items, () => { nodes++; });
    walkNodes(saved.config.footer, () => { nodes++; });
    audit.add({ category: "admin", level: "notice", event: "admin.menu-config", actor: adminName(req), detail: { nodes, width: saved.config.panel.width } });
    res.json({ ok: true, config: saved.config });
  });
  // The preview only renders; it changes nothing.
  app.post("/api/admin/menu-config/render", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { config?: unknown; lang?: unknown };
    const lang: Lang = body.lang === "en" || body.lang === "de" ? body.lang : "cs";
    const config = sanitizeMenuConfig(body.config ?? menuConfigStore.get());
    res.json({ ok: true, config, ...renderPreview(config, lang) });
  });
}
