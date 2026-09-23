// What the server's operator switches on for every client: the saved
// connections of signed-in users and the GUI templates. PURE module (no DOM,
// no Node): the server validates and stores it (server/client-config.ts,
// $DATA_DIR/client-config.json, console › Klient a addony), clients read it
// from GET /api/client-config.

import { isIconStyle, isThemeId, isToneChoice, THEME_IDS, type IconStyle, type ThemeId, type ToneChoice } from "./theme-catalog";

export type ServerEntry = { id: string; label: string; url: string };

export type ConnectionsPolicy = {
  /** Signed-in users in server-enhanced mode may save connections. */
  enabled: boolean;
  /** Saved connections per account. */
  maxProfiles: number;
  /** Log lines kept per connection (oldest go first). */
  logLimit: number;
  /** Clients keep statistics and logs of their connections at all. */
  stats: boolean;
  /** Users may type a signaling server of their own (else only the list). */
  allowCustomServers: boolean;
  /** Other signaling servers a connection may use, besides this one. */
  servers: ServerEntry[];
  /** New users: connect the default connection right after signing in. */
  autoConnectDefault: boolean;
};

export type AppearancePolicy = {
  /** Templates users may pick; empty = all. */
  themes: ThemeId[];
  /** For devices that have not chosen yet. */
  defaultTheme: ThemeId;
  defaultTone: ToneChoice;
  defaultIcons: IconStyle | "theme";
  /** Everyone gets defaultTheme; the picker is locked. */
  lockTheme: boolean;
};

export type ClientConfig = {
  version: 1;
  updatedAt: number;
  connections: ConnectionsPolicy;
  appearance: AppearancePolicy;
};

export const CLIENT_CONFIG_LIMITS = { maxProfiles: 200, logLimit: 2000, servers: 20 } as const;

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  version: 1,
  updatedAt: 0,
  connections: {
    enabled: true,
    maxProfiles: 30,
    logLimit: 200,
    stats: true,
    allowCustomServers: false,
    servers: [],
    autoConnectDefault: true,
  },
  appearance: {
    themes: [],
    defaultTheme: "motorsport",
    defaultTone: "auto",
    defaultIcons: "theme",
    lockTheme: false,
  },
};

/**
 * A signaling server address as the client will dial it: wss:// (https://
 * becomes wss://), host and optional path, no credentials, query or
 * fragment; ws:// only for the machine itself. Null for anything else.
 */
export function normalizeServerUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 300) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `wss://${text}`); } catch { return null; }
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local)) return null;
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** The WebSocket URL for a server entry: its path, or /ws when it has none. */
export function signalingUrl(server: string): string {
  const base = normalizeServerUrl(server);
  if (!base) return "";
  return new URL(base).pathname && new URL(base).pathname !== "/" ? base : `${base}/ws`;
}

const int = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
// eslint-disable-next-line no-control-regex
const label = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) : "");

export function sanitizeClientConfig(raw: unknown): ClientConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c = (r.connections && typeof r.connections === "object" ? r.connections : {}) as Record<string, unknown>;
  const a = (r.appearance && typeof r.appearance === "object" ? r.appearance : {}) as Record<string, unknown>;
  const d = DEFAULT_CLIENT_CONFIG;

  const servers: ServerEntry[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(c.servers) ? c.servers : []) {
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const url = normalizeServerUrl(e.url);
    if (!url || seen.has(url) || servers.length >= CLIENT_CONFIG_LIMITS.servers) continue;
    seen.add(url);
    const id = typeof e.id === "string" && /^[a-z0-9-]{1,32}$/.test(e.id) ? e.id : `srv-${servers.length + 1}`;
    servers.push({ id, label: label(e.label) || new URL(url).host, url });
  }

  const themes = Array.isArray(a.themes) ? [...new Set(a.themes.filter(isThemeId))] : [];
  let defaultTheme: ThemeId = isThemeId(a.defaultTheme) ? a.defaultTheme : d.appearance.defaultTheme;
  if (themes.length > 0 && !themes.includes(defaultTheme)) defaultTheme = themes[0];

  return {
    version: 1,
    updatedAt: int(r.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    connections: {
      enabled: bool(c.enabled, d.connections.enabled),
      maxProfiles: int(c.maxProfiles, 1, CLIENT_CONFIG_LIMITS.maxProfiles, d.connections.maxProfiles),
      logLimit: int(c.logLimit, 0, CLIENT_CONFIG_LIMITS.logLimit, d.connections.logLimit),
      stats: bool(c.stats, d.connections.stats),
      allowCustomServers: bool(c.allowCustomServers, d.connections.allowCustomServers),
      servers,
      autoConnectDefault: bool(c.autoConnectDefault, d.connections.autoConnectDefault),
    },
    appearance: {
      themes,
      defaultTheme,
      defaultTone: isToneChoice(a.defaultTone) ? a.defaultTone : d.appearance.defaultTone,
      defaultIcons: a.defaultIcons === "theme" || isIconStyle(a.defaultIcons) ? a.defaultIcons : d.appearance.defaultIcons,
      lockTheme: bool(a.lockTheme, d.appearance.lockTheme),
    },
  };
}

/** Whether a connection may use `server` ("" = this server) under the policy. */
export function serverAllowed(policy: ConnectionsPolicy, server: string): boolean {
  if (!server) return true;
  const url = normalizeServerUrl(server);
  if (!url) return false;
  return policy.allowCustomServers || policy.servers.some((s) => s.url === url);
}

/** The templates a user may pick. */
export function allowedThemes(policy: AppearancePolicy): readonly ThemeId[] {
  return policy.lockTheme ? [policy.defaultTheme] : policy.themes.length ? policy.themes : THEME_IDS;
}

/** What a device shows: the user's template, unless the operator locked one,
 *  left it out of the allowed list, or the user never picked any. */
export function effectiveAppearance(
  prefs: { theme: ThemeId; themeTone: ToneChoice; iconStyle: IconStyle | "theme"; themeSet: boolean },
  policy: AppearancePolicy,
): { theme: ThemeId; tone: ToneChoice; icons: IconStyle | "theme" } {
  const own = prefs.themeSet && !policy.lockTheme;
  const theme = own && allowedThemes(policy).includes(prefs.theme) ? prefs.theme : policy.defaultTheme;
  return { theme, tone: own ? prefs.themeTone : policy.defaultTone, icons: own ? prefs.iconStyle : policy.defaultIcons };
}
