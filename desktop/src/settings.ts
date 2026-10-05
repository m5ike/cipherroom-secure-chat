// The app's own settings (pure): the servers, the window, the options.
//
// Stored encrypted with the OS key store (safeStorage, store.ts); this module
// only defines the shape, the defaults, and how a stored copy is read back
// safely — anything malformed falls back to the default rather than throwing
// (a damaged file must never stop the app from starting).

import { parseServerUrl } from "./server-url";
import { isLocale, type Locale } from "../../client/src/lib/locales";

export const MAX_SERVERS = 20;

export type CodeSource = "app" | "server";
export type PasskeyMode = "auto" | "app" | "browser";

export type ServerEntry = {
  origin: string;
  host: string;
  display: string;
  addedAt: number;
  lastUsedAt: number;
  /** "server": the user chose this server's web code (explicitly, after a version mismatch). */
  codeSource: CodeSource;
};

export type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean; fullscreen: boolean };

export type Settings = {
  v: 1;
  servers: ServerEntry[];
  current: string | null;
  window: WindowState | null;
  startAtLogin: boolean;
  closeToTray: boolean;
  passkeys: PasskeyMode;
  /** The page's UI language, as last reported (menus follow it). */
  locale: Locale | null;
  autoUpdate: boolean;
  /** 6.13.1: servers (origins) the user allowed to use the computer's smart-card readers (PC/SC). */
  pcsc: string[];
};

export function defaultSettings(): Settings {
  return { v: 1, servers: [], current: null, window: null, startAtLogin: false, closeToTray: true, passkeys: "auto", locale: null, autoUpdate: true, pcsc: [] };
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : undefined;

/** A stored copy → Settings; unknown or malformed parts take their defaults. */
export function sanitizeSettings(raw: unknown, opts: { allowLoopbackHttp?: boolean } = {}): Settings {
  const out = defaultSettings();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.servers)) {
    for (const s of r.servers.slice(0, MAX_SERVERS)) {
      if (!s || typeof s !== "object") continue;
      const e = s as Record<string, unknown>;
      const parsed = parseServerUrl(String(e.origin ?? ""), opts);
      if (!parsed.ok || parsed.value.rest || out.servers.some((x) => x.origin === parsed.value.origin)) continue;
      out.servers.push({
        origin: parsed.value.origin,
        host: parsed.value.host,
        display: parsed.value.display,
        addedAt: num(e.addedAt, 0, 8.64e15) ?? 0,
        lastUsedAt: num(e.lastUsedAt, 0, 8.64e15) ?? 0,
        codeSource: e.codeSource === "server" ? "server" : "app",
      });
    }
  }
  if (typeof r.current === "string" && out.servers.some((s) => s.origin === r.current)) out.current = r.current;
  if (r.window && typeof r.window === "object") {
    const w = r.window as Record<string, unknown>;
    const width = num(w.width, 320, 20000);
    const height = num(w.height, 240, 20000);
    if (width && height) {
      out.window = { width, height, maximized: w.maximized === true, fullscreen: w.fullscreen === true };
      const x = num(w.x, -50000, 50000);
      const y = num(w.y, -50000, 50000);
      if (x !== undefined && y !== undefined) { out.window.x = x; out.window.y = y; }
    }
  }
  out.startAtLogin = r.startAtLogin === true;
  out.closeToTray = r.closeToTray !== false;
  out.passkeys = r.passkeys === "app" || r.passkeys === "browser" ? r.passkeys : "auto";
  out.locale = isLocale(r.locale) ? r.locale : null;
  out.autoUpdate = r.autoUpdate !== false;
  // A grant only for a server still in the list, written as its origin.
  if (Array.isArray(r.pcsc)) {
    for (const o of r.pcsc.slice(0, MAX_SERVERS)) {
      if (typeof o === "string" && out.servers.some((s) => s.origin === o) && !out.pcsc.includes(o)) out.pcsc.push(o);
    }
  }
  return out;
}

/** 6.13.1: whether a server may use the smart-card readers. */
export function pcscAllowed(s: Settings, origin: string | null): boolean {
  return Boolean(origin) && s.pcsc.includes(origin!);
}

/** 6.13.1: allow or withdraw the smart-card readers for a server (only one in the list). */
export function setPcscAllowed(s: Settings, origin: string, allowed: boolean): Settings {
  const rest = s.pcsc.filter((o) => o !== origin);
  if (!allowed || !s.servers.some((x) => x.origin === origin)) return { ...s, pcsc: rest };
  return { ...s, pcsc: [...rest, origin] };
}

/** Adds (or refreshes) a server and makes it current. */
export function addServer(s: Settings, origin: string, now: number, opts: { allowLoopbackHttp?: boolean } = {}): { ok: true; settings: Settings; entry: ServerEntry } | { ok: false; error: string } {
  const parsed = parseServerUrl(origin, opts);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const existing = s.servers.find((x) => x.origin === parsed.value.origin);
  const entry: ServerEntry = existing
    ? { ...existing, lastUsedAt: now }
    : { origin: parsed.value.origin, host: parsed.value.host, display: parsed.value.display, addedAt: now, lastUsedAt: now, codeSource: "app" };
  let servers = [entry, ...s.servers.filter((x) => x.origin !== entry.origin)];
  if (servers.length > MAX_SERVERS) servers = servers.slice(0, MAX_SERVERS);
  return { ok: true, settings: { ...s, servers, current: entry.origin }, entry };
}

export function removeServer(s: Settings, origin: string): Settings {
  const servers = s.servers.filter((x) => x.origin !== origin);
  return { ...s, servers, current: s.current === origin ? null : s.current, pcsc: s.pcsc.filter((o) => o !== origin) };
}

export function setCodeSource(s: Settings, origin: string, source: CodeSource): Settings {
  return { ...s, servers: s.servers.map((x) => (x.origin === origin ? { ...x, codeSource: source } : x)) };
}

export function serverEntry(s: Settings, origin: string | null): ServerEntry | null {
  return origin ? s.servers.find((x) => x.origin === origin) ?? null : null;
}

/** The passkey path for this OS: macOS signs in through the browser (Electron's Touch ID has no PRF), Windows in the app (Windows Hello). */
export function effectivePasskeyMode(mode: PasskeyMode, platform: string): "app" | "browser" {
  if (mode === "app" || mode === "browser") return mode;
  return platform === "darwin" ? "browser" : "app";
}
