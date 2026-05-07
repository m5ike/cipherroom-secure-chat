// Local-only preferences. Never sent to the server unless the user explicitly
// triggers a sync via the consented Server-enhanced mode.

import type { Lang } from "./i18n";
import type { ThemeId } from "./themes";

export type FontSize = "sm" | "md" | "lg";

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
  font: string;
  fontSize: FontSize;
  effects: boolean;
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
  font: "system",
  fontSize: "md",
  effects: true,
  lang: "cs",
  timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC",
  notificationsEnabled: false,
  analyticsConsent: false,
  ttlDefaultMinutes: 0,
  roomTtl: {},
  roomSecurity: {},
  deviceId: "",
};

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
  const theme: ThemeId =
    parsed.theme === "motorsport" || parsed.theme === "glass" || parsed.theme === "terminal"
      ? parsed.theme
      : base.theme;
  const fontSize: FontSize =
    parsed.fontSize === "sm" || parsed.fontSize === "md" || parsed.fontSize === "lg" ? parsed.fontSize : base.fontSize;
  return {
    mode: parsed.mode === "server" ? "server" : "light",
    name: typeof parsed.name === "string" ? parsed.name.slice(0, 42) : base.name,
    bio: typeof parsed.bio === "string" ? parsed.bio.slice(0, 280) : base.bio,
    avatar: typeof parsed.avatar === "string" ? parsed.avatar.slice(0, 256) : base.avatar,
    lastRoom: typeof parsed.lastRoom === "string" ? parsed.lastRoom.slice(0, 48) : base.lastRoom,
    theme,
    font: typeof parsed.font === "string" ? parsed.font : base.font,
    fontSize,
    effects: parsed.effects === false ? false : true,
    lang,
    timezone: typeof parsed.timezone === "string" ? parsed.timezone.slice(0, 64) : base.timezone,
    notificationsEnabled: parsed.notificationsEnabled === true,
    analyticsConsent: parsed.analyticsConsent === true,
    ttlDefaultMinutes: typeof parsed.ttlDefaultMinutes === "number" ? Math.max(0, Math.min(parsed.ttlDefaultMinutes, 60 * 24 * 30)) : base.ttlDefaultMinutes,
    roomTtl: typeof parsed.roomTtl === "object" && parsed.roomTtl ? parsed.roomTtl as Preferences["roomTtl"] : base.roomTtl,
    roomSecurity: typeof parsed.roomSecurity === "object" && parsed.roomSecurity ? parsed.roomSecurity as Preferences["roomSecurity"] : base.roomSecurity,
    deviceId: typeof parsed.deviceId === "string" && parsed.deviceId.length > 4 ? parsed.deviceId.slice(0, 64) : base.deviceId,
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
