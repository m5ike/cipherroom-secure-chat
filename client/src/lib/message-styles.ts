// Per-user message styling. The reader chooses how each participant's bubbles
// look — font colour / family / size, bubble background colour + opacity, and
// border colour + style. Choices are local (localStorage, via Preferences) and
// keyed by the participant's name, so they persist across reconnects (peer ids
// are regenerated every session and would not).
//
// Nothing here leaves the browser and nothing is derived from peer-supplied
// URLs; only plain hex colours, a small font whitelist and an enum border
// style are accepted.

import type { CSSProperties } from "react";
import { FONT_FAMILIES } from "./themes";

export type BorderStyleId = "solid" | "dashed" | "dotted" | "double" | "none";
export const BORDER_STYLES: readonly BorderStyleId[] = ["solid", "dashed", "dotted", "double", "none"] as const;
export const isBorderStyle = (v: unknown): v is BorderStyleId => BORDER_STYLES.includes(v as BorderStyleId);

export type PerUserStyle = {
  fontColor?: string; // #rgb / #rrggbb
  fontFamily?: string; // one of FONT_FAMILIES ids
  fontScale?: number; // 0.8 – 1.4 (em)
  bubbleColor?: string; // #rgb / #rrggbb
  bubbleOpacity?: number; // 0 – 1
  borderColor?: string; // #rgb / #rrggbb
  borderStyle?: BorderStyleId;
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Stable key for a participant. Name first (recognisable, survives reconnects),
 *  peer id as a fallback for empty names. */
export function styleKeyFor(senderName: string, senderId: string): string {
  const n = (senderName || "").trim().toLowerCase();
  return n || senderId;
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
}

export function sanitizePerUserStyle(raw: unknown): PerUserStyle {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: PerUserStyle = {};
  if (typeof s.fontColor === "string" && HEX.test(s.fontColor)) out.fontColor = s.fontColor;
  if (typeof s.bubbleColor === "string" && HEX.test(s.bubbleColor)) out.bubbleColor = s.bubbleColor;
  if (typeof s.borderColor === "string" && HEX.test(s.borderColor)) out.borderColor = s.borderColor;
  if (isBorderStyle(s.borderStyle)) out.borderStyle = s.borderStyle;
  if (typeof s.fontFamily === "string" && FONT_FAMILIES.some((f) => f.id === s.fontFamily)) out.fontFamily = s.fontFamily;
  if (s.fontScale !== undefined) out.fontScale = clampNum(s.fontScale, 0.8, 1.4, 1);
  if (s.bubbleOpacity !== undefined) out.bubbleOpacity = clampNum(s.bubbleOpacity, 0, 1, 1);
  return out;
}

export function sanitizeStyleMap(raw: unknown): Record<string, PerUserStyle> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, PerUserStyle> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0 || k.length > 64) continue;
    const s = sanitizePerUserStyle(v);
    if (Object.keys(s).length > 0) out[k.slice(0, 64)] = s;
  }
  return out;
}

/** True when a style has no visible effect (so callers can drop the entry). */
export function isEmptyStyle(s: PerUserStyle | undefined): boolean {
  return !s || Object.keys(s).length === 0;
}

function hexToRgba(hex: string, alpha: number): string {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Inline CSS for a bubble. `mine` only affects nothing here — the caller keeps
 *  its own left/right classes; this overlays the user's colour choices. */
export function bubbleStyleFrom(style: PerUserStyle | undefined): CSSProperties {
  const css: CSSProperties = {};
  if (!style) return css;
  if (style.fontColor && HEX.test(style.fontColor)) css.color = style.fontColor;
  if (style.bubbleColor && HEX.test(style.bubbleColor)) {
    css.background = hexToRgba(style.bubbleColor, style.bubbleOpacity ?? 1);
  }
  if (style.borderStyle && style.borderStyle !== "none") {
    css.borderStyle = style.borderStyle;
    css.borderWidth = style.borderStyle === "double" ? "3px" : "1.5px";
    css.borderColor = style.borderColor && HEX.test(style.borderColor) ? style.borderColor : undefined;
  } else if (style.borderColor && HEX.test(style.borderColor)) {
    css.borderColor = style.borderColor;
    css.borderStyle = "solid";
    css.borderWidth = "1.5px";
  }
  if (style.fontScale && style.fontScale !== 1) css.fontSize = `${style.fontScale}em`;
  if (style.fontFamily) {
    const fam = FONT_FAMILIES.find((f) => f.id === style.fontFamily);
    if (fam) css.fontFamily = fam.stack;
  }
  return css;
}
