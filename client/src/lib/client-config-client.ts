// The operator's client configuration (client-config.ts) in the browser:
// fetched from GET /api/client-config, kept in localStorage so the next
// start knows it before the network answers.

import { DEFAULT_CLIENT_CONFIG, sanitizeClientConfig, type ClientConfig } from "./client-config";

const CACHE_KEY = "m5cet:client-config:v1";

export function loadCachedClientConfig(): ClientConfig {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? sanitizeClientConfig(JSON.parse(raw)) : DEFAULT_CLIENT_CONFIG;
  } catch {
    return DEFAULT_CLIENT_CONFIG;
  }
}

/** Never throws: the cached copy, then the defaults, stand in. */
export async function fetchClientConfig(fetcher: typeof fetch = fetch): Promise<ClientConfig> {
  try {
    const res = await fetcher("/api/client-config", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return loadCachedClientConfig();
    const json = await res.json() as { config?: unknown };
    const config = sanitizeClientConfig(json.config ?? json);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(config)); } catch { /* quota / private mode */ }
    return config;
  } catch {
    return loadCachedClientConfig();
  }
}
