// Client side of the admin Layout builder: fetch the operator's layout config
// from the server, keep a local copy for instant startup, and turn its style
// section into CSS custom properties on <html>. Templates are rendered where
// they are used (App.tsx / MessageBubble) via renderTemplate().

import { DEFAULT_LAYOUT, allLayoutVarNames, layoutCssVars, sanitizeLayout, type LayoutConfig } from "./layout-config";

const CACHE_KEY = "m5cet:layout:v1";

export function loadCachedLayout(): LayoutConfig {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? sanitizeLayout(JSON.parse(raw)) : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** GET /api/layout; falls back to the cached copy, then the defaults. Never throws. */
export async function fetchLayoutConfig(): Promise<LayoutConfig> {
  try {
    const res = await fetch("/api/layout", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return loadCachedLayout();
    const json = await res.json() as { ok?: boolean; layout?: unknown };
    const cfg = sanitizeLayout(json.layout ?? json);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cfg)); } catch { /* quota / private mode */ }
    return cfg;
  } catch {
    return loadCachedLayout();
  }
}

/** Set the component CSS variables on <html>; clears ones no longer present. */
export function applyLayoutStyles(cfg: LayoutConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  const vars = layoutCssVars(cfg);
  for (const name of allLayoutVarNames()) {
    if (name in vars) root.setProperty(name, vars[name]);
    else root.removeProperty(name);
  }
}
