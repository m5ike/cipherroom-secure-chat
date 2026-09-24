// The operator's menu (menu-config.ts, built in the console's Menu builder)
// in the browser: fetched from GET /api/menu-config, kept in localStorage so
// the next start draws it before the network answers.

import { DEFAULT_MENU_CONFIG, sanitizeMenuConfig, type MenuConfig } from "./menu-config";

const CACHE_KEY = "m5cet:menu-config:v1";

export function loadCachedMenuConfig(): MenuConfig {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? sanitizeMenuConfig(JSON.parse(raw)) : DEFAULT_MENU_CONFIG;
  } catch {
    return DEFAULT_MENU_CONFIG;
  }
}

/** Never throws: the cached copy, then the default menu, stand in. */
export async function fetchMenuConfig(fetcher: typeof fetch = fetch): Promise<MenuConfig> {
  try {
    const res = await fetcher("/api/menu-config", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return loadCachedMenuConfig();
    const json = await res.json() as { config?: unknown };
    const config = sanitizeMenuConfig(json.config ?? json);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(config)); } catch { /* quota / private mode */ }
    return config;
  } catch {
    return loadCachedMenuConfig();
  }
}
