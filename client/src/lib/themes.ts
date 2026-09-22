// Visual system: three independent axes, each a data-* attribute on <html>.
//
//   data-theme   the template — surfaces, typography, radius, mood
//   data-accent  a colour variation of that template (primary / ring / stripe)
//   data-layout  how the conversation is laid out (width, density)
//
// CSS variables in index.css do the work; this file only lists what exists
// and flips the attributes. User-level overrides from the Appearance screen
// (typography, custom accent, bubble colours, radii) are inline custom
// properties on <html>, which beat the per-theme :root[data-theme] rules.

import { FONTS, fontStack } from "./fonts";
import { hexToHslVar, isHexColor, readableOn, shade } from "./color";

export type ThemeId = "motorsport" | "glass" | "terminal" | "midnight" | "paper" | "contrast";
export type AccentId = "default" | "red" | "orange" | "green" | "blue" | "violet";
export type LayoutId = "classic" | "wide" | "compact" | "focus";

type Hsl = [number, number, number];
/** `preview` mirrors the template's CSS variables (background, card,
 *  foreground, primary) for the picker cards — the real values stay in index.css. */
export const THEMES: { id: ThemeId; tone: "dark" | "light"; labelKey: string; preview: { bg: Hsl; card: Hsl; fg: Hsl; primary: Hsl } }[] = [
  { id: "motorsport", tone: "dark", labelKey: "themes.motorsport", preview: { bg: [220, 28, 6], card: [220, 26, 9], fg: [210, 16, 95], primary: [0, 86, 52] } },
  { id: "glass", tone: "light", labelKey: "themes.glass", preview: { bg: [210, 40, 98], card: [0, 0, 100], fg: [222, 28, 14], primary: [220, 90, 56] } },
  { id: "terminal", tone: "dark", labelKey: "themes.terminal", preview: { bg: [145, 30, 4], card: [145, 32, 6], fg: [142, 86, 78], primary: [142, 86, 50] } },
  { id: "midnight", tone: "dark", labelKey: "themes.midnight", preview: { bg: [232, 38, 7], card: [232, 34, 10], fg: [226, 40, 92], primary: [252, 88, 68] } },
  { id: "paper", tone: "light", labelKey: "themes.paper", preview: { bg: [40, 33, 96], card: [42, 40, 99], fg: [28, 24, 14], primary: [18, 72, 42] } },
  { id: "contrast", tone: "dark", labelKey: "themes.contrast", preview: { bg: [0, 0, 0], card: [0, 0, 5], fg: [0, 0, 100], primary: [52, 100, 50] } },
];

/** `swatch` is only for the picker; the real colours live in index.css. */
export const ACCENTS: { id: AccentId; swatch: string }[] = [
  { id: "default", swatch: "hsl(var(--theme-primary))" },
  { id: "red", swatch: "hsl(356 82% 52%)" },
  { id: "orange", swatch: "hsl(27 92% 52%)" },
  { id: "green", swatch: "hsl(146 62% 40%)" },
  { id: "blue", swatch: "hsl(214 88% 54%)" },
  { id: "violet", swatch: "hsl(265 78% 60%)" },
];

export const LAYOUTS: { id: LayoutId; labelKey: string }[] = [
  { id: "classic", labelKey: "layout.classic" },
  { id: "wide", labelKey: "layout.wide" },
  { id: "compact", labelKey: "layout.compact" },
  { id: "focus", labelKey: "layout.focus" },
];

export const isThemeId = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);
export const isAccentId = (v: unknown): v is AccentId => ACCENTS.some((a) => a.id === v);
export const isLayoutId = (v: unknown): v is LayoutId => LAYOUTS.some((l) => l.id === v);

export function applyTheme(id: ThemeId, accent: AccentId = "default", layout: LayoutId = "classic") {
  const root = document.documentElement;
  root.setAttribute("data-theme", id);
  root.setAttribute("data-accent", accent);
  root.setAttribute("data-layout", layout);
  const theme = THEMES.find((entry) => entry.id === id);
  if (theme) {
    root.classList.toggle("dark", theme.tone === "dark");
    // Native controls and scrollbars follow the template; "only" stops
    // Samsung Internet / Chrome forced dark mode from re-inverting it.
    root.style.colorScheme = `only ${theme.tone}`;
  }
  syncThemeColor();
}

/** Mobile browser chrome (Android address bar, iOS 15+ tab bar, installed
 *  PWA title bar) takes the app's actual background colour. */
export function syncThemeColor(): void {
  if (typeof document === "undefined") return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  if (!bg) return;
  let meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (!meta) {
    document.head.querySelectorAll('meta[name="theme-color"][media]').forEach((m) => m.remove());
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = `hsl(${bg})`;
}

/** On-device font stacks (no network) — used by per-participant bubble styles. */
export const FONT_FAMILIES = FONTS.filter((f) => f.category === "system").map(({ id, label, stack }) => ({ id, label, stack }));

export type Typography = {
  font: string;       // UI font id ("theme" = template's own)
  chatFont: string;   // "" = same as UI
  monoFont: string;
  sizePx: number;
  weight: number;
  lineHeight: number;
  letterSpacing: number; // em
  chatScale: number;
};

function setVar(name: string, value: string | null) {
  const style = document.documentElement.style;
  if (value === null || value === "") style.removeProperty(name);
  else style.setProperty(name, value);
}

export function applyTypography(t: Typography) {
  if (typeof document === "undefined") return;
  // "theme": let :root[data-theme] decide (terminal → mono, paper → serif).
  setVar("--font-sans", t.font === "theme" ? null : fontStack(t.font));
  setVar("--font-chat", t.chatFont ? fontStack(t.chatFont) : null);
  setVar("--font-mono", t.monoFont && t.monoFont !== "theme" ? fontStack(t.monoFont) : null);
  const px = `${t.sizePx}px`;
  setVar("--app-font-size", px);
  document.documentElement.style.fontSize = px;
  setVar("--font-weight-base", String(t.weight));
  setVar("--line-height-base", String(t.lineHeight));
  setVar("--letter-spacing-base", t.letterSpacing ? `${t.letterSpacing}em` : null);
  setVar("--chat-font-scale", t.chatScale === 1 ? null : String(t.chatScale));
}

export type ColorOverrides = {
  accentColor: string;  // "" = preset accent
  bubbleMine: string;
  bubbleTheirs: string;
  uiRadius: number;     // rem, -1 = template
  bubbleRadius: number; // px, -1 = template
};

export function applyColorOverrides(c: ColorOverrides) {
  if (typeof document === "undefined") return;
  const accent = isHexColor(c.accentColor) ? hexToHslVar(c.accentColor) : null;
  setVar("--primary", accent);
  setVar("--ring", accent);
  setVar("--primary-foreground", accent ? hexToHslVar(readableOn(c.accentColor)) : null);

  const mine = isHexColor(c.bubbleMine) ? c.bubbleMine : "";
  setVar("--u-out-bg", mine || null);
  setVar("--u-out-fg", mine ? readableOn(mine) : null);

  const theirs = isHexColor(c.bubbleTheirs) ? c.bubbleTheirs : "";
  setVar("--u-in-bg", theirs || null);
  setVar("--u-in-fg", theirs ? readableOn(theirs) : null);
  setVar("--u-in-border", theirs ? shade(theirs, readableOn(theirs) === "#ffffff" ? 0.25 : -0.18) : null);

  setVar("--radius", c.uiRadius >= 0 ? `${c.uiRadius}rem` : null);
  setVar("--u-bubble-radius", c.bubbleRadius >= 0 ? `${c.bubbleRadius}px` : null);
  syncThemeColor();
}

export function applyEffects(enabled: boolean) {
  document.documentElement.classList.toggle("effects-on", enabled);
  document.documentElement.classList.toggle("effects-off", !enabled);
}

export type ChatSurface = {
  bgColor: string; // "" or #hex
  bgImage: string; // "" or data: URL
  saturation: number; // 0.5 – 1.5
  opacity: number; // 0 – 1
  pattern: "grid" | "dots" | "diagonal" | "plain";
  width: "sm" | "md" | "lg" | "full";
};

const CHAT_WIDTHS: Record<ChatSurface["width"], string> = {
  sm: "36rem",
  md: "56rem", // matches the previous max-w-4xl column
  lg: "72rem",
  full: "100%",
};

/** Drive the conversation surface from user choices. All values become CSS
 *  custom properties on <html>; index.css reads them. The image is only ever a
 *  same-origin data: URL (validated in preferences.ts). */
export function applyChatSurface(s: ChatSurface) {
  const root = document.documentElement.style;
  root.setProperty("--chat-bg-color", s.bgColor ? s.bgColor : "transparent");
  root.setProperty("--chat-bg-image", s.bgImage ? `url("${s.bgImage}")` : "none");
  root.setProperty("--chat-saturate", String(s.saturation));
  root.setProperty("--chat-pattern-opacity", String(s.opacity));
  root.setProperty("--chat-max-width", CHAT_WIDTHS[s.width] ?? CHAT_WIDTHS.md);
  document.documentElement.setAttribute("data-chat-pattern", s.pattern);
}
