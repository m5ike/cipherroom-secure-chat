// A menu node's style (menu-config.ts › ElementStyle) as what React puts on
// the element: inline CSS for the resting look, and for each state (hover,
// click, focus, current) a class plus a custom property — the rules in
// menu.css read them. Only what is set is emitted, so an unstyled node looks
// exactly like the menu always did.

import type { CSSProperties } from "react";
import { cssColor, FONT_STACKS, STATE_KEYS, type ElementStyle, type StateKey, type StateStyle } from "./menu-config";

export const SHADOW_CSS: Record<string, string> = {
  none: "none",
  sm: "0 1px 2px rgb(0 0 0 / 0.12)",
  md: "0 4px 12px rgb(0 0 0 / 0.16)",
  lg: "0 12px 32px rgb(0 0 0 / 0.22)",
  glow: "0 0 0 3px hsl(var(--primary) / 0.28)",
};

const STATE_PROPS: Array<[keyof StateStyle, string, (v: never) => string]> = [
  ["color", "color", (v: string) => cssColor(v)],
  ["background", "bg", (v: string) => cssColor(v)],
  ["iconColor", "icon", (v: string) => cssColor(v)],
  ["borderColor", "border", (v: string) => cssColor(v)],
  ["fontWeight", "weight", (v: string) => v],
  ["underline", "underline", (v: boolean) => (v ? "underline" : "none")],
  ["opacity", "opacity", (v: number) => String(v)],
  ["scale", "scale", (v: number) => String(v)],
  ["shadow", "shadow", (v: string) => SHADOW_CSS[v] ?? "none"],
];

/** Later styles win; states merge per state. */
export function mergeStyles(...styles: Array<ElementStyle | undefined>): ElementStyle {
  const out: ElementStyle = {};
  for (const s of styles) {
    if (!s) continue;
    const { states, ...rest } = s;
    Object.assign(out, rest);
    if (states) {
      out.states = { ...(out.states ?? {}) };
      for (const k of Object.keys(states) as StateKey[]) out.states[k] = { ...(out.states[k] ?? {}), ...states[k] };
    }
  }
  return out;
}

export function styleProps(style: ElementStyle | undefined): { className: string; style: CSSProperties } {
  if (!style) return { className: "", style: {} };
  const css: Record<string, string | number> = {};
  const classes: string[] = [];
  if (style.color) css.color = cssColor(style.color);
  if (style.background) css.background = cssColor(style.background);
  if (style.iconColor) { css["--mb-icon"] = cssColor(style.iconColor); classes.push("mb-ic"); }
  if (style.borderColor) css.borderColor = cssColor(style.borderColor);
  if (style.borderWidth !== undefined) { css.borderWidth = `${style.borderWidth}px`; css.borderStyle = style.borderStyle ?? "solid"; }
  else if (style.borderStyle) css.borderStyle = style.borderStyle;
  if (style.fontWeight) css.fontWeight = style.fontWeight;
  if (style.underline !== undefined) css.textDecoration = style.underline ? "underline" : "none";
  if (style.opacity !== undefined) css.opacity = style.opacity;
  if (style.scale !== undefined) css.transform = `scale(${style.scale})`;
  if (style.shadow) css.boxShadow = SHADOW_CSS[style.shadow];
  if (style.align) {
    css.justifyContent = style.align === "start" ? "flex-start" : style.align === "end" ? "flex-end" : style.align === "between" ? "space-between" : "center";
    css.textAlign = style.align === "between" ? "start" : style.align;
  }
  if (style.wrap === "nowrap") css.whiteSpace = "nowrap";
  if (style.wrap === "wrap") css.whiteSpace = "normal";
  if (style.wrap === "ellipsis") classes.push("mb-ellipsis");
  if (style.fontSize) css.fontSize = `${style.fontSize}px`;
  if (style.fontFamily && style.fontFamily !== "inherit") css.fontFamily = FONT_STACKS[style.fontFamily];
  if (style.italic !== undefined) css.fontStyle = style.italic ? "italic" : "normal";
  if (style.uppercase !== undefined) css.textTransform = style.uppercase ? "uppercase" : "none";
  if (style.letterSpacing !== undefined) css.letterSpacing = `${style.letterSpacing}px`;
  if (style.iconSize) { css["--mb-icon-size"] = `${style.iconSize}px`; classes.push("mb-is"); }
  if (style.iconPosition && style.iconPosition !== "start") classes.push(`mb-icon-${style.iconPosition}`);
  if (style.paddingX !== undefined) css.paddingInline = `${style.paddingX}px`;
  if (style.paddingY !== undefined) css.paddingBlock = `${style.paddingY}px`;
  if (style.gap !== undefined) css.gap = `${style.gap}px`;
  if (style.minHeight !== undefined) css.minHeight = `${style.minHeight}px`;
  if (style.radius !== undefined) css.borderRadius = `${style.radius}px`;
  for (const state of STATE_KEYS) {
    const st = style.states?.[state];
    if (!st) continue;
    for (const [key, slug, toCss] of STATE_PROPS) {
      const value = st[key];
      if (value === undefined) continue;
      css[`--mb-${state}-${slug}`] = (toCss as (v: unknown) => string)(value);
      classes.push(`mb-${state}-${slug}`);
    }
  }
  return { className: classes.join(" "), style: css as CSSProperties };
}
