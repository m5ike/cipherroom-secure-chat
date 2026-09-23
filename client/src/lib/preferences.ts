// Local-only preferences. Never sent to the server unless the user explicitly
// triggers a sync via the consented Server-enhanced mode.

import type { Lang } from "./i18n";
import { isAccentId, isLayoutId, type AccentId, type LayoutId } from "./themes";
import { isIconStyle, isThemeId, isToneChoice, type IconStyle, type ThemeId, type ToneChoice } from "./theme-catalog";
import { sanitizeStyleMap, type PerUserStyle } from "./message-styles";
import { isFontId } from "./fonts";
import { isHexColor } from "./color";
import type { DeviceLayoutPref } from "./device";
import { isChatRetention, type ChatRetention } from "./chat-history";

export type FontSize = "sm" | "md" | "lg";

export type ChatPattern = "grid" | "dots" | "diagonal" | "plain";
export type ChatWidth = "sm" | "md" | "lg" | "full";

/** Floating recipients widget: position, collapsed/locked state, room-broadcast
 *  toggle, and its user-tunable appearance (size, opacity, colour, zoom). */
export type WidgetState = {
  x: number;
  y: number;
  minimized: boolean;
  autoRoom: boolean;
  /** Docked (fixed top-left) when true; floating + draggable when false. */
  locked: boolean;
  width: number; // px
  opacity: number; // 0.3–1
  fontScale: number; // 0.8–1.4
  zoom: number; // 0.7–1.4 overall scale
  accent: string; // "" = theme card, else #hex
};

/** How the notices at the top of the screen look and behave. */
export type FlashSettings = {
  /** Show system notices as flash messages at all. */
  enabled: boolean;
  /** Seconds on screen before the fade-out (3–60). */
  seconds: number;
  position: "top" | "top-left" | "top-right";
  /** "" = follow the theme, else #hex. */
  background: string;
  color: string;
  /** Font id from fonts.ts, "" = the UI font. */
  font: string;
  /** Text size in px (11–20). */
  size: number;
  /** Corner radius in px (0–28). */
  radius: number;
  /** Show the little icon that says what kind of notice it is. */
  icon: boolean;
  animation: "fade" | "slide" | "none";
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
  /** Light / dark for templates that have both ("auto" follows the OS). */
  themeTone: ToneChoice;
  /** Icon drawing style ("theme" = the template's own). */
  iconStyle: IconStyle | "theme";
  /** The user picked a template here; until then the operator's default shows. */
  themeSet: boolean;
  /** Colour variation of the template and conversation layout. */
  accent: AccentId;
  layout: LayoutId;
  /** UI font (id from fonts.ts; "theme" = the template's own font). */
  font: string;
  /** Legacy S/M/L; textSize is authoritative since the Appearance screen. */
  fontSize: FontSize;
  /** Messages font ("" = same as the UI font) and the code/monospace font. */
  chatFont: string;
  monoFont: string;
  /** Base text size in px (12–22). */
  textSize: number;
  /** Base weight (300–700), line height (1.1–2.2), letter spacing (em). */
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  /** Message text scale relative to the UI (0.8–1.5). */
  chatScale: number;
  /** Custom accent (#hex) — overrides the preset `accent` when set. */
  accentColor: string;
  /** My / others' bubble colours (#hex or "" = template). */
  bubbleMine: string;
  bubbleTheirs: string;
  /** UI corner radius in rem (-1 = template), bubble radius in px (-1 = template). */
  uiRadius: number;
  bubbleRadius: number;
  /** Consent to fetch Google Fonts (reveals the IP address to Google). */
  googleFonts: boolean;
  /** Force a phone / tablet / desktop layout instead of the detected one. */
  deviceLayout: DeviceLayoutPref;
  /** Element style editor (Edit Mode) switched on. */
  editMode: boolean;
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
  /** Keep system notices in the conversation as well. Off by default: the
   *  chat shows what people said, notices flash at the top instead. */
  showSystemInChat: boolean;
  /** The flash notices themselves. */
  flash: FlashSettings;
  /** What happens to the conversation and its logs (see chat-history.ts):
   *  "ephemeral" a new connection clears it · "session" it lives until the
   *  session ends · "server" it lives in the passkey account's vault. */
  chatRetention: ChatRetention;
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
  themeTone: "auto",
  iconStyle: "theme",
  themeSet: false,
  accent: "default",
  layout: "classic",
  font: "theme",
  fontSize: "md",
  chatFont: "",
  monoFont: "mono",
  textSize: 15.5,
  fontWeight: 400,
  lineHeight: 1.5,
  letterSpacing: 0,
  chatScale: 1,
  accentColor: "",
  bubbleMine: "",
  bubbleTheirs: "",
  uiRadius: -1,
  bubbleRadius: -1,
  googleFonts: false,
  deviceLayout: "auto",
  editMode: false,
  effects: true,
  chatBgColor: "",
  chatBgImage: "",
  chatBgSaturation: 1,
  chatBgOpacity: 1,
  chatPattern: "grid",
  chatWidth: "md",
  messageStyles: {},
  widget: { x: 0, y: 0, minimized: false, autoRoom: true, locked: true, width: 240, opacity: 1, fontScale: 1, zoom: 1, accent: "" },
  showSystemInChat: false,
  flash: { enabled: true, seconds: 10, position: "top", background: "", color: "", font: "", size: 14, radius: 14, icon: true, animation: "fade" },
  chatRetention: "ephemeral",
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
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => Math.max(lo, Math.min(hi, num(v, dflt)));
  return {
    x: Math.max(-4000, Math.min(4000, num(w.x, base.x))),
    y: Math.max(-4000, Math.min(4000, num(w.y, base.y))),
    minimized: w.minimized === true,
    autoRoom: w.autoRoom === false ? false : true,
    // Docked (next to the menu button) unless the user moved it away.
    locked: w.locked === false ? false : true,
    width: clamp(w.width, 180, 420, base.width),
    opacity: clamp(w.opacity, 0.3, 1, base.opacity),
    fontScale: clamp(w.fontScale, 0.8, 1.4, base.fontScale),
    zoom: clamp(w.zoom, 0.7, 1.4, base.zoom),
    accent: typeof w.accent === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(w.accent) ? w.accent : base.accent,
  };
}

function sanitizeFlash(raw: unknown, base: FlashSettings): FlashSettings {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt);
  const hex = (v: unknown) => (typeof v === "string" && isHexColor(v) ? v : "");
  return {
    enabled: f.enabled === false ? false : true,
    seconds: num(f.seconds, 3, 60, base.seconds),
    position: f.position === "top-left" || f.position === "top-right" ? f.position : "top",
    background: hex(f.background),
    color: hex(f.color),
    font: typeof f.font === "string" && isFontId(f.font) ? f.font : "",
    size: num(f.size, 11, 20, base.size),
    radius: num(f.radius, 0, 28, base.radius),
    icon: f.icon === false ? false : true,
    animation: f.animation === "slide" || f.animation === "none" ? f.animation : "fade",
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

const LEGACY_SIZE_PX: Record<FontSize, number> = { sm: 14, md: 15.5, lg: 17 };

/** A finite number clamped to [lo, hi]; anything else → dflt. */
function num(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
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
    themeTone: isToneChoice(parsed.themeTone) ? parsed.themeTone : base.themeTone,
    iconStyle: parsed.iconStyle === "theme" || isIconStyle(parsed.iconStyle) ? parsed.iconStyle : base.iconStyle,
    // Stored before 3.2 with a non-default template: that was a choice too.
    themeSet: typeof parsed.themeSet === "boolean" ? parsed.themeSet : (isThemeId(parsed.theme) && parsed.theme !== base.theme),
    accent: isAccentId(parsed.accent) ? parsed.accent : base.accent,
    layout: isLayoutId(parsed.layout) ? parsed.layout : base.layout,
    font: isFontId(parsed.font) ? parsed.font : base.font,
    fontSize,
    chatFont: parsed.chatFont === "" || isFontId(parsed.chatFont) ? (parsed.chatFont as string) : base.chatFont,
    monoFont: isFontId(parsed.monoFont) ? parsed.monoFont : base.monoFont,
    // Older stores only had S/M/L: carry that choice over once.
    textSize: num(parsed.textSize, 12, 22, LEGACY_SIZE_PX[fontSize] ?? base.textSize),
    fontWeight: Math.round(num(parsed.fontWeight, 300, 700, base.fontWeight) / 50) * 50,
    lineHeight: num(parsed.lineHeight, 1.1, 2.2, base.lineHeight),
    letterSpacing: num(parsed.letterSpacing, -0.05, 0.2, base.letterSpacing),
    chatScale: num(parsed.chatScale, 0.8, 1.5, base.chatScale),
    accentColor: isHexColor(parsed.accentColor) ? parsed.accentColor : "",
    bubbleMine: isHexColor(parsed.bubbleMine) ? parsed.bubbleMine : "",
    bubbleTheirs: isHexColor(parsed.bubbleTheirs) ? parsed.bubbleTheirs : "",
    uiRadius: parsed.uiRadius === -1 ? -1 : num(parsed.uiRadius, 0, 2, base.uiRadius),
    bubbleRadius: parsed.bubbleRadius === -1 ? -1 : num(parsed.bubbleRadius, 0, 32, base.bubbleRadius),
    googleFonts: parsed.googleFonts === true,
    deviceLayout: parsed.deviceLayout === "phone" || parsed.deviceLayout === "tablet" || parsed.deviceLayout === "desktop" ? parsed.deviceLayout : "auto",
    editMode: parsed.editMode === true,
    effects: parsed.effects === false ? false : true,
    chatBgColor: typeof parsed.chatBgColor === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(parsed.chatBgColor) ? parsed.chatBgColor : base.chatBgColor,
    // Accept only same-origin data: images so a synced/pasted value can never
    // trigger an outbound request.
    chatBgImage: typeof parsed.chatBgImage === "string" && parsed.chatBgImage.startsWith("data:image/") && parsed.chatBgImage.length < 4_000_000 ? parsed.chatBgImage : base.chatBgImage,
    chatBgSaturation: typeof parsed.chatBgSaturation === "number" && Number.isFinite(parsed.chatBgSaturation) ? Math.max(0.5, Math.min(1.5, parsed.chatBgSaturation)) : base.chatBgSaturation,
    chatBgOpacity: typeof parsed.chatBgOpacity === "number" && Number.isFinite(parsed.chatBgOpacity) ? Math.max(0, Math.min(1, parsed.chatBgOpacity)) : base.chatBgOpacity,
    chatPattern: parsed.chatPattern === "dots" || parsed.chatPattern === "diagonal" || parsed.chatPattern === "plain" ? parsed.chatPattern : base.chatPattern,
    chatWidth: parsed.chatWidth === "sm" || parsed.chatWidth === "lg" || parsed.chatWidth === "full" ? parsed.chatWidth : base.chatWidth,
    messageStyles: sanitizeStyleMap(parsed.messageStyles),
    widget: sanitizeWidget(parsed.widget, base.widget),
    showSystemInChat: parsed.showSystemInChat === true,
    flash: sanitizeFlash(parsed.flash, base.flash),
    chatRetention: isChatRetention(parsed.chatRetention) ? parsed.chatRetention : base.chatRetention,
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

/** The appearance defaults, for "reset appearance". */
export const APPEARANCE_DEFAULTS: Partial<Preferences> = {
  theme: DEFAULTS.theme, themeTone: DEFAULTS.themeTone, iconStyle: DEFAULTS.iconStyle, themeSet: false, accent: DEFAULTS.accent, layout: DEFAULTS.layout,
  font: DEFAULTS.font, fontSize: DEFAULTS.fontSize, chatFont: DEFAULTS.chatFont, monoFont: DEFAULTS.monoFont,
  textSize: DEFAULTS.textSize, fontWeight: DEFAULTS.fontWeight, lineHeight: DEFAULTS.lineHeight,
  letterSpacing: DEFAULTS.letterSpacing, chatScale: DEFAULTS.chatScale, accentColor: "", bubbleMine: "",
  bubbleTheirs: "", uiRadius: -1, bubbleRadius: -1, effects: DEFAULTS.effects, chatBgColor: "",
  chatBgImage: "", chatBgSaturation: DEFAULTS.chatBgSaturation, chatBgOpacity: DEFAULTS.chatBgOpacity,
  chatPattern: DEFAULTS.chatPattern, chatWidth: DEFAULTS.chatWidth, deviceLayout: "auto",
};

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
