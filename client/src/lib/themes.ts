// Three radically different visual themes. Switching swaps a data-theme attribute
// on <html>; CSS variables in index.css drive the actual look.

export type ThemeId = "motorsport" | "glass" | "terminal";

export const THEMES: { id: ThemeId; tone: "dark" | "light"; labelKey: string }[] = [
  { id: "motorsport", tone: "dark", labelKey: "themes.motorsport" },
  { id: "glass", tone: "light", labelKey: "themes.glass" },
  { id: "terminal", tone: "dark", labelKey: "themes.terminal" },
];

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  root.setAttribute("data-theme", id);
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
