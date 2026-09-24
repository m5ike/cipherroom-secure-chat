// What the console's Layout builder offers (4.0.5): the palette of elements,
// attributes and their values, CSS properties and their values, the classes
// the app's stylesheet really has, icons, and every layout with its default
// tree and contract. Built from the same pure modules the app renders with.

import fs from "node:fs";
import path from "node:path";
import {
  ARIA_ATTRS, ATTR_VALUES, BOOLEAN_ATTRS, CSS_PROPERTIES, ELEMENTS, GLOBAL_ATTRS, LAYOUT_EVENTS, LAYOUT_LIMITS, TAG_ATTRS,
} from "../client/src/lib/layout-tree";
import { DEFAULT_LAYOUT_REVS, DEFAULT_LAYOUTS, LAYOUT_GROUP, LAYOUT_GROUP_LABELS, LAYOUT_IDS, LAYOUT_LABELS, LAYOUT_STYLE_COMPONENT, type LayoutGroup } from "../client/src/lib/layouts";
import { LAYOUT_CONTRACTS } from "../client/src/lib/layouts/contracts";
import { PREVIEW_VARIANTS } from "../client/src/lib/layouts/samples";
import { THEME_IDS } from "../client/src/lib/theme-catalog";
import { MENU_ICON_ALIASES, MENU_ICONS } from "../client/src/lib/menu-icons-data";
import {
  ALIGNS, BORDER_STYLES, COLOR_TOKENS, FONT_STACKS, FONT_WEIGHTS, ICON_POSITIONS, SHADOWS, STATE_KEYS, WRAPS,
} from "../client/src/lib/menu-config";
import { TEMPLATE_FILTERS, TEMPLATE_MACROS } from "../client/src/lib/menu-template";
import { sanitizeClientConfig } from "../client/src/lib/client-config";
import { BUILTIN_GROUPS } from "../client/src/lib/modules";

/**
 * 4.13: the groups a layout variant may be for — guest, user and the
 * operator's own (from the client configuration; ids and labels, never the
 * members). Read from the file the main service keeps (the same path rules
 * as server/client-config.ts, which this process does not load).
 */
export function layoutGroups(): Array<{ id: string; label: string }> {
  const explicit = process.env.CLIENT_CONFIG_FILE?.trim();
  const dir = process.env.DATA_DIR?.trim();
  const file = explicit ? path.resolve(explicit) : dir ? path.resolve(dir, "client-config.json") : path.resolve(process.cwd(), ".m5cet", "client-config.json");
  let own: Array<{ id: string; label: string }> = [];
  try { own = sanitizeClientConfig(JSON.parse(fs.readFileSync(file, "utf8"))).groups.map((g) => ({ id: g.id, label: g.label })); } catch { /* none yet */ }
  return [...BUILTIN_GROUPS.map((g) => ({ id: g.id, label: g.label })), ...own];
}

/** dist/public of this install (the app's build), when there is one. */
export function distPublicDir(): string | null {
  let here = "";
  try { here = __dirname; } catch { here = process.cwd(); }
  const candidates = [path.resolve(here, "public"), path.resolve(here, "..", "dist", "public"), path.resolve(process.cwd(), "dist", "public")];
  for (const c of candidates) if (fs.existsSync(path.join(c, "index.html"))) return c;
  return null;
}

let classCache: { sig: string; classes: string[] } | null = null;

/**
 * Every class selector in the app's built stylesheets — Tailwind only emits
 * the utilities the source uses, so these are the classes that really style
 * something. Cached until the build changes.
 */
export function appCssClasses(): string[] {
  const dir = distPublicDir();
  if (!dir) return [];
  const assets = path.join(dir, "assets");
  let files: string[] = [];
  try { files = fs.readdirSync(assets).filter((f) => f.endsWith(".css")).sort(); } catch { return []; }
  const sig = files.map((f) => { try { return `${f}:${fs.statSync(path.join(assets, f)).mtimeMs}`; } catch { return f; } }).join("|");
  if (classCache?.sig === sig) return classCache.classes;
  const found = new Set<string>();
  for (const f of files) {
    let css = "";
    try { css = fs.readFileSync(path.join(assets, f), "utf8"); } catch { continue; }
    // Selectors only: skip declaration blocks.
    const selectors = css.replace(/\{[^{}]*\}/g, "{}");
    for (const m of selectors.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
      const name = m[1].replace(/\\(.)/g, "$1");
      if (name.length > 1 && name.length <= 80 && !/^\d/.test(name)) found.add(name);
      if (found.size >= 12000) break;
    }
  }
  classCache = { sig, classes: [...found].sort() };
  return classCache.classes;
}

export function layoutCatalog() {
  return {
    elements: ELEMENTS,
    events: LAYOUT_EVENTS,
    attrs: { global: GLOBAL_ATTRS, aria: ARIA_ATTRS, byTag: TAG_ATTRS, values: ATTR_VALUES, boolean: [...BOOLEAN_ATTRS] },
    css: CSS_PROPERTIES,
    classes: appCssClasses(),
    icons: MENU_ICONS,
    iconAliases: MENU_ICON_ALIASES,
    layouts: LAYOUT_IDS.map((id) => ({
      id,
      label: LAYOUT_LABELS[id],
      section: LAYOUT_GROUP[id],
      styleComponent: LAYOUT_STYLE_COMPONENT[id],
      contract: LAYOUT_CONTRACTS[id],
      tree: DEFAULT_LAYOUTS[id],
      rev: DEFAULT_LAYOUT_REVS[id],
    })),
    // 4.13: the layouts in sections (the app, the Room window, windows, dialogs, panels)
    sections: (Object.keys(LAYOUT_GROUP_LABELS) as LayoutGroup[]).map((id) => ({ id, label: LAYOUT_GROUP_LABELS[id] })),
    variants: PREVIEW_VARIANTS,
    themes: THEME_IDS,
    groups: layoutGroups(),
    template: { filters: TEMPLATE_FILTERS, macros: TEMPLATE_MACROS },
    style: {
      states: STATE_KEYS, fonts: Object.keys(FONT_STACKS), fontStacks: FONT_STACKS, fontWeights: FONT_WEIGHTS, colors: Object.keys(COLOR_TOKENS),
      colorTokens: COLOR_TOKENS, shadows: SHADOWS, borders: BORDER_STYLES, aligns: ALIGNS, wraps: WRAPS, iconPositions: ICON_POSITIONS,
    },
    limits: LAYOUT_LIMITS,
  };
}
