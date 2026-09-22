// Colour helpers + the extended palette of the Appearance screen.
// Pure functions (no DOM) except cssColorToHex, which asks the browser to
// normalise any CSS colour (hsl(), named colours, var() already resolved).

export type Rgb = { r: number; g: number; b: number };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

export function hexToRgb(hex: string): Rgb | null {
  if (!isHexColor(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
}

/** "#rrggbb" → [h, s%, l%] (rounded), the shape the theme variables use. */
export function hexToHsl(hex: string): [number, number, number] | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/** Theme variables are bare HSL components: "220 90% 56%". */
export function hexToHslVar(hex: string): string | null {
  const hsl = hexToHsl(hex);
  return hsl ? `${hsl[0]} ${hsl[1]}% ${hsl[2]}%` : null;
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Readable text colour on a background: near-white or near-black, whichever contrasts more. */
export function readableOn(bg: string): string {
  return contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#0b0d10") ? "#ffffff" : "#0b0d10";
}

/** Mix a colour with white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const t = amount > 0 ? 255 : 0;
  const p = Math.min(1, Math.abs(amount));
  return rgbToHex({ r: rgb.r + (t - rgb.r) * p, g: rgb.g + (t - rgb.g) * p, b: rgb.b + (t - rgb.b) * p });
}

/* ------------------------------------------------------------- palette */

export const PALETTE_HUES: Array<{ name: string; h: number; s: number }> = [
  { name: "red", h: 356, s: 82 }, { name: "rose", h: 343, s: 80 }, { name: "pink", h: 322, s: 74 },
  { name: "fuchsia", h: 292, s: 72 }, { name: "purple", h: 272, s: 70 }, { name: "violet", h: 258, s: 78 },
  { name: "indigo", h: 236, s: 72 }, { name: "blue", h: 216, s: 86 }, { name: "sky", h: 199, s: 88 },
  { name: "cyan", h: 188, s: 84 }, { name: "teal", h: 172, s: 70 }, { name: "emerald", h: 155, s: 68 },
  { name: "green", h: 138, s: 60 }, { name: "lime", h: 84, s: 70 }, { name: "yellow", h: 50, s: 94 },
  { name: "amber", h: 38, s: 94 }, { name: "orange", h: 24, s: 92 }, { name: "brown", h: 22, s: 40 },
];

/** Lightness steps from pale to deep. */
export const PALETTE_STEPS = [92, 82, 68, 56, 44, 32] as const;

/** 18 hues × 6 steps + a neutral ramp = 116 swatches. */
export const PALETTE: string[][] = [
  ...PALETTE_HUES.map(({ h, s }) => PALETTE_STEPS.map((l) => hslToHex(h, s, l))),
  ["#ffffff", "#e6e8eb", "#c4c9d0", "#9aa1ab", "#6b7280", "#454b54", "#2a2f36", "#0b0d10"],
];

/** Normalise any CSS colour string to #rrggbb using the browser; null if it
 *  is not a colour (or has no DOM, e.g. in the server build). */
export function cssColorToHex(value: string): string | null {
  const v = value.trim();
  if (isHexColor(v)) return v.length === 4 ? rgbToHex(hexToRgb(v)!) : v.toLowerCase();
  if (typeof document === "undefined" || !v) return null;
  if (typeof CSS !== "undefined" && CSS.supports && !CSS.supports("color", v)) return null;
  const probe = document.createElement("span");
  probe.style.color = v;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const m = /rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(computed);
  return m ? rgbToHex({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }) : null;
}
