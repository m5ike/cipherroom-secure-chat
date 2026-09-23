// Visual system: independent axes, each a data-* attribute on <html>.
//
//   data-theme   the template — surfaces, typography, radius, mood
//                (theme-catalog.ts lists them; index.css + themes.css style them)
//   data-tone    light / dark — fixed for most templates; the system
//                look-alikes follow the OS when the user picks "automatic"
//   data-accent  a colour variation of that template (primary / ring / stripe)
//   data-layout  how the conversation is laid out (width, density)
//   data-icons   how icons are drawn (outline, thin, bold, duotone, badge)
//
// CSS variables in index.css do the work; this file only lists what exists
// and flips the attributes. User-level overrides from the Appearance screen
// (typography, custom accent, bubble colours, radii) are inline custom
// properties on <html>, which beat the per-theme :root[data-theme] rules.

import { FONTS, fontStack } from "./fonts";
import { hexToHslVar, isHexColor, readableOn, shade } from "./color";
import {
  THEME_CATALOG, isThemeId, resolveIconStyle, resolveTone, themeDef,
  type IconStyle, type ThemeId, type ThemePreview, type ThemeTone, type ToneChoice,
} from "./theme-catalog";

export { isThemeId, type ThemeId };
export type AccentId = "default" | "red" | "orange" | "green" | "blue" | "violet";
export type LayoutId = "classic" | "wide" | "compact" | "focus";

/** Picker data for every template (the catalog in theme-catalog.ts). `tone`
 *  and `preview` are the template's default tone; `previews` has all. */
export const THEMES: { id: ThemeId; tone: ThemeTone; tones: readonly ThemeTone[]; family: string; labelKey: string; descKey: string; preview: ThemePreview; previews: Partial<Record<ThemeTone, ThemePreview>> }[] =
  THEME_CATALOG.map((t) => ({ id: t.id, tone: t.tones[0], tones: t.tones, family: t.family, labelKey: t.labelKey, descKey: t.descKey, preview: t.preview[t.tones[0]]!, previews: t.preview }));

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

export const isAccentId = (v: unknown): v is AccentId => ACCENTS.some((a) => a.id === v);
export const isLayoutId = (v: unknown): v is LayoutId => LAYOUTS.some((l) => l.id === v);

export type ThemeOptions = { tone?: ToneChoice; icons?: IconStyle | "theme" };

let applied: { id: ThemeId; tone: ToneChoice } | null = null;
let systemQuery: MediaQueryList | null = null;

function systemDark(): boolean {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; }
}

/** "Automatic" follows the operating system while the page is open. */
function followSystem(): void {
  if (systemQuery || typeof window === "undefined" || !window.matchMedia) return;
  systemQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => { if (applied?.tone === "auto" && themeDef(applied.id).tones.length > 1) setTone(resolveTone(applied.id, "auto", systemDark())); };
  try { systemQuery.addEventListener("change", onChange); } catch { systemQuery.addListener?.(onChange); }
}

function setTone(tone: ThemeTone): void {
  const root = document.documentElement;
  root.setAttribute("data-tone", tone);
  root.classList.toggle("dark", tone === "dark");
  // Native controls and scrollbars follow the template; "only" stops
  // Samsung Internet / Chrome forced dark mode from re-inverting it.
  root.style.colorScheme = `only ${tone}`;
  syncThemeColor();
}

export function applyTheme(id: ThemeId, accent: AccentId = "default", layout: LayoutId = "classic", options: ThemeOptions = {}) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = isThemeId(id) ? id : "motorsport";
  const tone = options.tone ?? "auto";
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-accent", accent);
  root.setAttribute("data-layout", layout);
  root.setAttribute("data-icons", resolveIconStyle(theme, options.icons ?? "theme"));
  root.setAttribute("data-family", themeDef(theme).family);
  applied = { id: theme, tone };
  if (tone === "auto") followSystem();
  setTone(resolveTone(theme, tone, systemDark()));
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
