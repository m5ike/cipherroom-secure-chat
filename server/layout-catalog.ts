// What the console's Layout builder offers (4.0.5): the palette of elements,
// attributes and their values, CSS properties and their values, the classes
// the app's stylesheet really has, icons, and every layout with its default
// tree and contract. Built from the same pure modules the app renders with.

import fs from "node:fs";
import path from "node:path";
import {
  ARIA_ATTRS, ATTR_VALUES, BOOLEAN_ATTRS, CSS_PROPERTIES, ELEMENTS, GLOBAL_ATTRS, LAYOUT_EVENTS, LAYOUT_LIMITS, TAG_ATTRS,
} from "../client/src/lib/layout-tree";
import { DEFAULT_LAYOUT_REVS, DEFAULT_LAYOUTS, LAYOUT_IDS, LAYOUT_LABELS, LAYOUT_STYLE_COMPONENT } from "../client/src/lib/layouts";
import { LAYOUT_CONTRACTS } from "../client/src/lib/layouts/contracts";
import { PREVIEW_VARIANTS } from "../client/src/lib/layouts/samples";
import { THEME_IDS } from "../client/src/lib/theme-catalog";
import { MENU_ICON_ALIASES, MENU_ICONS } from "../client/src/lib/menu-icons-data";
import {
  ALIGNS, BORDER_STYLES, COLOR_TOKENS, FONT_STACKS, FONT_WEIGHTS, ICON_POSITIONS, SHADOWS, STATE_KEYS, WRAPS,
} from "../client/src/lib/menu-config";
import { TEMPLATE_FILTERS, TEMPLATE_MACROS } from "../client/src/lib/menu-template";

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
      styleComponent: LAYOUT_STYLE_COMPONENT[id],
      contract: LAYOUT_CONTRACTS[id],
      tree: DEFAULT_LAYOUTS[id],
      rev: DEFAULT_LAYOUT_REVS[id],
    })),
    variants: PREVIEW_VARIANTS,
    themes: THEME_IDS,
    template: { filters: TEMPLATE_FILTERS, macros: TEMPLATE_MACROS },
    style: {
      states: STATE_KEYS, fonts: Object.keys(FONT_STACKS), fontStacks: FONT_STACKS, fontWeights: FONT_WEIGHTS, colors: Object.keys(COLOR_TOKENS),
      colorTokens: COLOR_TOKENS, shadows: SHADOWS, borders: BORDER_STYLES, aligns: ALIGNS, wraps: WRAPS, iconPositions: ICON_POSITIONS,
    },
    limits: LAYOUT_LIMITS,
  };
}
