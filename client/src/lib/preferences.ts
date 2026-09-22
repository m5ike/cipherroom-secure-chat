// Local-only preferences. Never sent to the server unless the user explicitly
// triggers a sync via the consented Server-enhanced mode.

import type { Lang } from "./i18n";
import { isAccentId, isLayoutId, isThemeId, type AccentId, type LayoutId, type ThemeId } from "./themes";
import { sanitizeStyleMap, type PerUserStyle } from "./message-styles";

export type FontSize = "sm" | "md" | "lg";

export type ChatPattern = "grid" | "dots" | "plain";
export type ChatWidth = "sm" | "md" | "lg" | "full";

/** Floating recipients widget: position + collapsed state + room-broadcast toggle. */
export type WidgetState = {
  x: number;
  y: number;
  minimized: boolean;
  autoRoom: boolean;
};

export type RoomSecurity = {
  sort: "asc" | "desc";
  deliveryReceipts: boolean;
  readReceipts: boolean;
  typingIndicator: boolean;
  messageStatus: boolean;
};

export type RoomTtlOverride = {
  defaultMinutes: number; // 0 = off
  absoluteMinutes: number; // 0 = off
};

export type Preferences = {
  // Behaviour
  mode: "light" | "server";
  // Identity
  name: string;
  bio: string;
  avatar: string;
  // Last room
  lastRoom: string;
  // Theme/visual
  theme: ThemeId;
  /** Colour variation of the template and conversation layout. */
  accent: AccentId;
  layout: LayoutId;
  font: string;
  fontSize: FontSize;
  effects: boolean;
  /** Conversation surface: colour tint, optional image, saturation, pattern
   *  intensity ("plnost") and the active reading width. */
  chatBgColor: string; // "" = template default, else #rgb / #rrggbb
  chatBgImage: string; // "" = none, else data: URL
  chatBgSaturation: number; // 0.5 – 1.5
  chatBgOpacity: number; // 0 – 1 (pattern / tint intensity)
  chatPattern: ChatPattern;
  chatWidth: ChatWidth;
  /** Per-participant bubble styling, keyed by styleKeyFor(name, id). */
  messageStyles: Record<string, PerUserStyle>;
  /** Floating recipients widget layout + behaviour. */
  widget: WidgetState;
  // Locale
  lang: Lang;
  timezone: string;
  // Notifications
  notificationsEnabled: boolean;
  // Privacy
  analyticsConsent: boolean;
  // TTL — user defaults
  ttlDefaultMinutes: number; // 0 = off
  // TTL room-level overrides keyed by room id
  roomTtl: Record<string, RoomTtlOverride>;
  // Room security keyed by room id
  roomSecurity: Record<string, RoomSecurity>;
  // Device id for sync (random, no PII)
  deviceId: string;
  // Keepalive strategy for the signaling connection
  keepaliveStrategy: "conservative" | "balanced" | "aggressive";
  // Max attachment size in bytes for chunked DataChannel transfer.
  // Unlimited by setting to Number.MAX_SAFE_INTEGER (default).
  maxAttachmentBytes: number;
  // Toolbar display mode for the top-bar menu buttons:
  //   "inline"    — icon + label side by side (sm:inline label)
  //   "tooltip"   — icon only, label visible as native title / curl tip
  //   "speeddial" — three horizontal bars button → opens a floating
  //                 panel with the same entries vertically.
  // Toolbar display mode for the top-bar menu. The four values are:
  //   "icons"         — icon only, no labels (compact, default)
  //   "text"          — label only, no icons (very compact, accessible)
  //   "icons-text"    — icon + label side-by-side (rich header)
  //   "icons-tooltip" — icon only on the toolbar, full label appears as
  //                     a native browser tooltip on hover
  // Legacy aliases `inline`/`tooltip`/`speeddial` are still accepted
  // when reading stored prefs and are mapped below.
  // "speeddial" (default) keeps the header clean: the whole menu opens from
  // the three-bars button.
  menuDisplay: "icons" | "text" | "icons-text" | "icons-tooltip" | "speeddial";
  /** Bumped when a default changes and stored values must follow once. */
  menuRev: number;
};

const STORAGE_KEY = "m5cet:prefs:v2";

function randomId() {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

const DEFAULTS: Preferences = {
  mode: "light",
  name: "",
  bio: "",
  avatar: "",
  lastRoom: "brno-secure",
  theme: "motorsport",
  accent: "default",
  layout: "classic",
  font: "system",
  fontSize: "md",
  effects: true,
  chatBgColor: "",
  chatBgImage: "",
  chatBgSaturation: 1,
  chatBgOpacity: 1,
  chatPattern: "grid",
  chatWidth: "md",
  messageStyles: {},
  widget: { x: 0, y: 0, minimized: false, autoRoom: true },
  lang: "cs",
  timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC",
  notificationsEnabled: false,
  analyticsConsent: false,
  ttlDefaultMinutes: 0,
  roomTtl: {},
  roomSecurity: {},
  deviceId: "",
  keepaliveStrategy: "balanced",
  // Unlimited by default — operator sets MAX_BYTES server-side.
  maxAttachmentBytes: Number.MAX_SAFE_INTEGER,
  menuDisplay: "speeddial",
  menuRev: 2,
};

function sanitizeWidget(raw: unknown, base: WidgetState): WidgetState {
  const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
  return {
    x: Math.max(-4000, Math.min(4000, num(w.x, base.x))),
    y: Math.max(-4000, Math.min(4000, num(w.y, base.y))),
    minimized: w.minimized === true,
    autoRoom: w.autoRoom === false ? false : true,
  };
}

export const DEFAULT_ROOM_SECURITY: RoomSecurity = {
  sort: "asc",
  deliveryReceipts: true,
  readReceipts: false,
  typingIndicator: true,
  messageStatus: true,
};

function safeGet(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadPreferences(): Preferences {
  const storage = safeGet();
  const base: Preferences = {
    ...DEFAULTS,
    deviceId: randomId(),
  };
  if (!storage) return base;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migrate from older v1 if present.
      const legacy = storage.getItem("cipherroom:prefs:v1");
      if (legacy) {
        try {
          const parsed = JSON.parse(legacy) as Partial<Preferences>;
          return { ...base, ...sanitize(parsed, base) };
        } catch {
          /* ignore */
        }
      }
      // Persist with new device id.
      try { storage.setItem(STORAGE_KEY, JSON.stringify(base)); } catch { /* ignore */ }
      return base;
    }
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    const merged: Preferences = { ...base, ...sanitize(parsed, base) };
    if (!merged.deviceId) merged.deviceId = randomId();
    return merged;
  } catch {
    return base;
  }
}

function sanitize(parsed: Partial<Preferences>, base: Preferences): Partial<Preferences> {
  const lang: Lang = parsed.lang === "en" || parsed.lang === "de" || parsed.lang === "cs" ? parsed.lang : base.lang;
  const theme: ThemeId = isThemeId(parsed.theme) ? parsed.theme : base.theme;
  const fontSize: FontSize =
    parsed.fontSize === "sm" || parsed.fontSize === "md" || parsed.fontSize === "lg" ? parsed.fontSize : base.fontSize;
  return {
    mode: parsed.mode === "server" ? "server" : "light",
    name: typeof parsed.name === "string" ? parsed.name.slice(0, 42) : base.name,
    bio: typeof parsed.bio === "string" ? parsed.bio.slice(0, 280) : base.bio,
    avatar: typeof parsed.avatar === "string" ? parsed.avatar.slice(0, 256) : base.avatar,
    lastRoom: typeof parsed.lastRoom === "string" ? parsed.lastRoom.slice(0, 48) : base.lastRoom,
    theme,
    accent: isAccentId(parsed.accent) ? parsed.accent : base.accent,
    layout: isLayoutId(parsed.layout) ? parsed.layout : base.layout,
    font: typeof parsed.font === "string" ? parsed.font : base.font,
    fontSize,
    effects: parsed.effects === false ? false : true,
    chatBgColor: typeof parsed.chatBgColor === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(parsed.chatBgColor) ? parsed.chatBgColor : base.chatBgColor,
    // Accept only same-origin data: images so a synced/pasted value can never
    // trigger an outbound request.
    chatBgImage: typeof parsed.chatBgImage === "string" && parsed.chatBgImage.startsWith("data:image/") && parsed.chatBgImage.length < 4_000_000 ? parsed.chatBgImage : base.chatBgImage,
    chatBgSaturation: typeof parsed.chatBgSaturation === "number" && Number.isFinite(parsed.chatBgSaturation) ? Math.max(0.5, Math.min(1.5, parsed.chatBgSaturation)) : base.chatBgSaturation,
    chatBgOpacity: typeof parsed.chatBgOpacity === "number" && Number.isFinite(parsed.chatBgOpacity) ? Math.max(0, Math.min(1, parsed.chatBgOpacity)) : base.chatBgOpacity,
    chatPattern: parsed.chatPattern === "dots" || parsed.chatPattern === "plain" ? parsed.chatPattern : base.chatPattern,
    chatWidth: parsed.chatWidth === "sm" || parsed.chatWidth === "lg" || parsed.chatWidth === "full" ? parsed.chatWidth : base.chatWidth,
    messageStyles: sanitizeStyleMap(parsed.messageStyles),
    widget: sanitizeWidget(parsed.widget, base.widget),
    lang,
    timezone: typeof parsed.timezone === "string" ? parsed.timezone.slice(0, 64) : base.timezone,
    notificationsEnabled: parsed.notificationsEnabled === true,
    analyticsConsent: parsed.analyticsConsent === true,
    ttlDefaultMinutes: typeof parsed.ttlDefaultMinutes === "number" ? Math.max(0, Math.min(parsed.ttlDefaultMinutes, 60 * 24 * 30)) : base.ttlDefaultMinutes,
    roomTtl: typeof parsed.roomTtl === "object" && parsed.roomTtl ? parsed.roomTtl as Preferences["roomTtl"] : base.roomTtl,
    roomSecurity: typeof parsed.roomSecurity === "object" && parsed.roomSecurity ? parsed.roomSecurity as Preferences["roomSecurity"] : base.roomSecurity,
    deviceId: typeof parsed.deviceId === "string" && parsed.deviceId.length > 4 ? parsed.deviceId.slice(0, 64) : base.deviceId,
    keepaliveStrategy: parsed.keepaliveStrategy === "conservative" || parsed.keepaliveStrategy === "aggressive" ? parsed.keepaliveStrategy : base.keepaliveStrategy,
    // Accept any positive integer up to MAX_SAFE_INTEGER so that
    // prefs.maxAttachmentBytes === Number.MAX_SAFE_INTEGER represents
    // an "unlimited" config (essentially capped only by RAM + server
    // proxy memory).
    maxAttachmentBytes: typeof parsed.maxAttachmentBytes === "number" && parsed.maxAttachmentBytes > 0 && parsed.maxAttachmentBytes <= Number.MAX_SAFE_INTEGER ? Math.floor(parsed.maxAttachmentBytes) : base.maxAttachmentBytes,
    // Rev 2 made the three-bars menu the default. Values stored before that
    // follow once; a choice made afterwards is respected.
    menuDisplay:
      parsed.menuRev === 2 && (
        parsed.menuDisplay === "icons" ||
        parsed.menuDisplay === "text" ||
        parsed.menuDisplay === "icons-text" ||
        parsed.menuDisplay === "icons-tooltip" ||
        parsed.menuDisplay === "speeddial")
        ? parsed.menuDisplay
        : base.menuDisplay,
    menuRev: 2,
  };
}

export function savePreferences(prefs: Preferences) {
  const storage = safeGet();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota or privacy mode — fail silently.
  }
}

export function clearPreferences() {
  const storage = safeGet();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
    storage.removeItem("cipherroom:prefs:v1");
  } catch {
    // ignore
  }
}
