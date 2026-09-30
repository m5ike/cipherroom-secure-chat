// What the server's operator switches on for every client: the saved
// connections of signed-in users and the GUI templates. PURE module (no DOM,
// no Node): the server validates and stores it (server/client-config.ts,
// $DATA_DIR/client-config.json, console › Klient a addony), clients read it
// from GET /api/client-config.

import { isIconStyle, isThemeId, isToneChoice, THEME_IDS, type IconStyle, type ThemeId, type ToneChoice } from "./theme-catalog";
import { sanitizeGroups, sanitizeModules, type GroupDef, type ModulesPolicy } from "./modules";

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
  /** 4.0: which modules are on, and for which groups (modules.ts). */
  modules: ModulesPolicy;
  /** 4.0: the operator's own groups. Members only on the server and the console. */
  groups: GroupDef[];
  /** 5.2: the message box — which characters open which suggestions, and tags to offer. */
  composer: ComposerPolicy;
  /** 6.2: the map drawn in a message that carries a position (web and Android alike). */
  map: MapPreviewPolicy;
};

/**
 * 6.2: the map preview in a message with a position. The tiles come through
 * this server (GET /api/map/tile/{z}/{x}/{y}), so a client never reveals its
 * address to the tile provider and the web's CSP stays 'self'; the operator
 * picks the provider (`tiles`, a raster URL template) and the look.
 */
export type MapPreviewPolicy = {
  /** Draw a map in the bubble (off: only the pin link, as before 6.2). */
  enabled: boolean;
  /** Upstream raster tiles: https://…/{z}/{x}/{y}.png, {s} for a subdomain. */
  tiles: string;
  /** Subdomains for {s} ("abc"); "" when the template has none. */
  subdomains: string;
  /** Shown in the map's corner (the provider's licence). */
  attribution: string;
  /** Zoom of the preview, 3–19. */
  zoom: number;
  /** Size of the preview in CSS px / dp. */
  width: number;
  height: number;
  /** The pin's colour (#rrggbb). */
  pinColor: string;
  /** The caption's background (#rrggbb; "" = the theme's primary colour). */
  accent: string;
  /** The caption under the pin: "Jana's current position". */
  label: boolean;
  /** Latitude, longitude and accuracy under the map. */
  showCoords: boolean;
  /** Draw the tiles in grey (a calmer bubble). */
  grayscale: boolean;
  /** How long the server keeps a tile, in hours (1–720). */
  cacheHours: number;
};

export const DEFAULT_MAP_PREVIEW: MapPreviewPolicy = {
  enabled: true,
  tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  subdomains: "",
  attribution: "© OpenStreetMap",
  zoom: 16,
  width: 280,
  height: 160,
  pinColor: "#e11d48",
  accent: "",
  label: true,
  showCoords: true,
  grayscale: false,
  cacheHours: 168,
};

/** A raster tile URL template the server may fetch: https (http only for this machine), {z} {x} {y}, no credentials. */
export function normalizeTileTemplate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 300 || !/\{z\}/.test(text) || !/\{x\}/.test(text) || !/\{y\}/.test(text)) return null;
  let url: URL;
  try { url = new URL(text.replace(/\{[a-z]\}/g, "0")); } catch { return null; }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.hash) return null;
  return text;
}

const hexColor = (v: unknown, dflt: string, allowEmpty = false) =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : allowEmpty && v === "" ? "" : dflt;

export function sanitizeMapPreview(raw: unknown): MapPreviewPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_MAP_PREVIEW;
  const n = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt);
  const b = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  // eslint-disable-next-line no-control-regex
  const text = (v: unknown, dflt: string, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max) : dflt);
  return {
    enabled: b(r.enabled, d.enabled),
    tiles: normalizeTileTemplate(r.tiles) ?? d.tiles,
    subdomains: typeof r.subdomains === "string" && /^[a-z0-9]{0,8}$/i.test(r.subdomains) ? r.subdomains : d.subdomains,
    attribution: text(r.attribution, d.attribution, 120),
    zoom: n(r.zoom, 3, 19, d.zoom),
    width: n(r.width, 160, 640, d.width),
    height: n(r.height, 100, 480, d.height),
    pinColor: hexColor(r.pinColor, d.pinColor),
    accent: hexColor(r.accent, d.accent, true),
    label: b(r.label, d.label),
    showCoords: b(r.showCoords, d.showCoords),
    grayscale: b(r.grayscale, d.grayscale),
    cacheHours: n(r.cacheHours, 1, 720, d.cacheHours),
  };
}

export type ComposerAction = "functions" | "mentions" | "tags";
export type ComposerPolicy = { triggers: Array<{ char: string; action: ComposerAction }>; tags: string[] };
export const DEFAULT_COMPOSER: ComposerPolicy = { triggers: [{ char: "/", action: "functions" }, { char: "@", action: "mentions" }, { char: "#", action: "tags" }], tags: [] };

export function sanitizeComposer(raw: unknown): ComposerPolicy {
  if (!raw || typeof raw !== "object") return { triggers: DEFAULT_COMPOSER.triggers.map((t) => ({ ...t })), tags: [] };
  const r = raw as Record<string, unknown>;
  const triggers: ComposerPolicy["triggers"] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(r.triggers) ? r.triggers : []) {
    const e = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    const char = typeof e.char === "string" ? [...e.char.trim()][0] ?? "" : "";
    const action = e.action === "functions" || e.action === "mentions" || e.action === "tags" ? e.action : null;
    if (!char || !action || /[\sA-Za-z0-9]/.test(char) || seen.has(char) || triggers.length >= 10) continue;
    seen.add(char);
    triggers.push({ char, action });
  }
  const tags = Array.isArray(r.tags) ? [...new Set(r.tags.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^#/, "").trim().toLowerCase()).filter((x) => /^[\p{L}\p{N}_-]{1,40}$/u.test(x)))].slice(0, 200) : [];
  return { triggers, tags };
}

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
  modules: {},
  groups: [],
  composer: DEFAULT_COMPOSER,
  map: DEFAULT_MAP_PREVIEW,
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

  const groups = sanitizeGroups(r.groups);
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
    modules: sanitizeModules(r.modules, groups),
    groups,
    composer: sanitizeComposer(r.composer),
    map: sanitizeMapPreview(r.map),
  };
}

/** What every client may read: the groups without their members. */
export function publicClientConfig(config: ClientConfig): ClientConfig {
  return { ...config, groups: config.groups.map((g) => ({ id: g.id, label: g.label, members: [] })) };
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
