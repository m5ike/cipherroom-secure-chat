// The web client's templates for the Android app (6.1): Settings ›
// Appearance › Template offers the same looks as the browser. The colours
// come straight from the web's CSS (client/src/index.css, themes.css —
// :root[data-theme="…"] and its [data-tone="…"] variant, HSL custom
// properties) and are mapped onto the design's colour tokens; the build puts
// them into the app's assets (themes.json), so the two never drift apart.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { THEME_CATALOG } from "../../client/src/lib/theme-catalog";
import { t } from "../../client/src/lib/i18n";

type Tokens = Record<string, string>;
/**
 * 6.2: besides the colours a template carries its family (the picker's
 * groups), its corner radius (--radius, dp) and its font (--font-sans →
 * sans / serif / mono), so a template changes the shapes and the type too.
 */
export type AndroidTheme = {
  id: string; label: Record<"cs" | "en" | "de", string>; tones: string[]; light?: Tokens; dark?: Tokens;
  family: string; radius?: number; font?: "sans" | "serif" | "mono";
};

/** "1.125rem" / "18px" → dp (a rem is 16 px), within what a phone's cards take. */
export function radiusDp(v: string | undefined): number | undefined {
  const m = v?.trim().match(/^([\d.]+)(rem|px)$/);
  if (!m) return undefined;
  const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
  return Number.isFinite(px) ? Math.max(0, Math.min(28, Math.round(px))) : undefined;
}

/** The first family of a CSS font stack that says what it is. */
export function fontKind(stack: string | undefined): "sans" | "serif" | "mono" | undefined {
  if (!stack) return undefined;
  const s = stack.toLowerCase();
  if (/mono|consolas|menlo|courier/.test(s.split(",")[0]) || /^\s*monospace\s*$/.test(s)) return "mono";
  if (/(^|,)\s*(ui-)?serif\s*(,|$)/.test(s) && !/sans-serif/.test(s.split(",")[0])) return "serif";
  return "sans";
}

/** The design token ← the web's custom property. */
const MAP: Array<[string, string]> = [
  ["background", "background"], ["surface", "card"], ["onSurface", "foreground"], ["primary", "primary"], ["onPrimary", "primary-foreground"],
  ["surfaceVariant", "muted"], ["muted", "muted-foreground"], ["border", "border"], ["danger", "destructive"], ["accent", "primary"],
  ["bubbleIn", "card"], ["onBubbleIn", "card-foreground"], ["bubbleOut", "primary"], ["onBubbleOut", "primary-foreground"],
];

/** "H S% L%" → #rrggbb. */
export function hslToHex(v: string): string | null {
  const m = v.trim().match(/^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%/);
  if (!m) return null;
  const h = ((Number(m[1]) % 360) + 360) % 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m0 = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (n: number) => Math.round((n + m0) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** The custom properties of every :root[data-theme="id"](+[data-tone]) block. */
function readBlocks(css: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const block = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(css))) {
    const selectors = m[1].split(",").map((s) => s.trim());
    const vars: Record<string, string> = {};
    for (const d of m[2].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
    if (!Object.keys(vars).length) continue;
    for (const sel of selectors) {
      const th = sel.match(/^:root\[data-theme="([a-z]+)"\](?:\[data-tone="(light|dark)"\])?$/);
      if (!th) continue;
      const key = `${th[1]}|${th[2] ?? ""}`;
      out.set(key, { ...(out.get(key) ?? {}), ...vars });
    }
  }
  return out;
}

export function androidThemes(): AndroidTheme[] {
  const root = resolve(import.meta.dirname, "..", "..", "client", "src");
  const css = (readFileSync(resolve(root, "index.css"), "utf8") + "\n" + readFileSync(resolve(root, "themes.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = readBlocks(css);
  const themes: AndroidTheme[] = [];
  for (const def of THEME_CATALOG) {
    const base = blocks.get(`${def.id}|`) ?? {};
    const theme: AndroidTheme = { id: def.id, label: { cs: t("cs", def.labelKey), en: t("en", def.labelKey), de: t("de", def.labelKey) }, tones: [...def.tones], family: def.family };
    const radius = radiusDp(base.radius), font = fontKind(base["font-sans"]);
    if (radius !== undefined) theme.radius = radius;
    if (font) theme.font = font;
    def.tones.forEach((tone, i) => {
      // The first tone is the template's own block; the other has a [data-tone] block on top of it.
      const vars: Record<string, string> = { ...base, ...(i === 0 ? {} : blocks.get(`${def.id}|${tone}`) ?? {}) };
      // The template's own colour (the web's "default" accent): --theme-primary, its foreground --theme-primary-fg.
      if (!vars.primary || vars.primary.startsWith("var(")) vars.primary = vars["theme-primary"] ?? "";
      if (!vars["primary-foreground"] || vars["primary-foreground"].startsWith("var(")) vars["primary-foreground"] = vars["theme-primary-fg"] ?? (tone === "dark" ? "0 0% 4%" : "0 0% 100%");
      const tokens: Tokens = {};
      for (const [token, prop] of MAP) {
        const hex = vars[prop] ? hslToHex(vars[prop]) : null;
        if (hex) tokens[token] = hex;
      }
      if (Object.keys(tokens).length >= 6) theme[tone as "light" | "dark"] = tokens;
    });
    if (theme.light || theme.dark) themes.push(theme);
  }
  return themes;
}
