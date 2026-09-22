// Visual system: three independent axes, each a data-* attribute on <html>.
//
//   data-theme   the template — surfaces, typography, radius, mood
//   data-accent  a colour variation of that template (primary / ring / stripe)
//   data-layout  how the conversation is laid out (width, density)
//
// CSS variables in index.css do the work; this file only lists what exists
// and flips the attributes.

export type ThemeId = "motorsport" | "glass" | "terminal" | "midnight" | "paper" | "contrast";
export type AccentId = "default" | "red" | "orange" | "green" | "blue" | "violet";
export type LayoutId = "classic" | "wide" | "compact" | "focus";

export const THEMES: { id: ThemeId; tone: "dark" | "light"; labelKey: string }[] = [
  { id: "motorsport", tone: "dark", labelKey: "themes.motorsport" },
  { id: "glass", tone: "light", labelKey: "themes.glass" },
  { id: "terminal", tone: "dark", labelKey: "themes.terminal" },
  { id: "midnight", tone: "dark", labelKey: "themes.midnight" },
  { id: "paper", tone: "light", labelKey: "themes.paper" },
  { id: "contrast", tone: "dark", labelKey: "themes.contrast" },
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
  }
}

export const FONT_FAMILIES = [
  { id: "system", label: "System", stack: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { id: "mono", label: "Monospace", stack: "'SFMono-Regular', 'Cascadia Code', 'Liberation Mono', Menlo, monospace" },
  { id: "rounded", label: "Rounded", stack: "'Nunito', 'Avenir Next', system-ui, sans-serif" },
  { id: "serif", label: "Serif", stack: "ui-serif, Georgia, 'Times New Roman', serif" },
];

export function applyFont(fontId: string, size: "sm" | "md" | "lg") {
  const family = FONT_FAMILIES.find((entry) => entry.id === fontId) || FONT_FAMILIES[0];
  document.documentElement.style.setProperty("--font-sans", family.stack);
  const px = size === "sm" ? "14px" : size === "lg" ? "17px" : "15.5px";
  document.documentElement.style.setProperty("--app-font-size", px);
  document.documentElement.style.fontSize = px;
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
  pattern: "grid" | "dots" | "plain";
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
