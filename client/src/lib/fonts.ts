// Font catalogue for the Appearance screen.
//
//   system  font stacks already on the device — no network request at all
//   google  71 Google Fonts. `weights` lists exactly what the css2 API serves
//           for each family (verified against fonts.googleapis.com: asking
//           for a weight a family lacks fails the whole request with 400),
//           `czech` whether the family covers latin-ext (č ř ž ů ě).
//
// Google fonts are fetched only after consent (prefs.googleFonts): loading
// them tells Google the visitor's IP address. One <link> per family, added
// on demand (preview in the picker or actual use) and cached by the browser;
// the browser then downloads only the unicode-range subsets it renders.

export type FontCategory = "theme" | "system" | "sans" | "serif" | "display" | "hand" | "mono";

export type FontDef = {
  id: string;
  label: string;
  category: FontCategory;
  /** CSS font-family value. Empty for "theme" (the template decides). */
  stack: string;
  google?: { family: string; weights: string };
  /** Covers Czech diacritics (latin-ext). System stacks: true. */
  czech: boolean;
};

const SANS_FALLBACK = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const SERIF_FALLBACK = "ui-serif, Georgia, 'Times New Roman', serif";
const MONO_FALLBACK = "ui-monospace, 'SFMono-Regular', 'Cascadia Code', 'Liberation Mono', Menlo, monospace";
const HAND_FALLBACK = "'Segoe Print', 'Bradley Hand', cursive";

const SYSTEM_FONTS: FontDef[] = [
  { id: "theme", label: "Podle šablony", category: "theme", stack: "", czech: true },
  { id: "system", label: "System UI", category: "system", stack: SANS_FALLBACK, czech: true },
  { id: "humanist", label: "Humanist (system)", category: "system", stack: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif", czech: true },
  { id: "geometric", label: "Geometric (system)", category: "system", stack: "Avenir, 'Avenir Next LT Pro', Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif", czech: true },
  { id: "rounded", label: "Rounded (system)", category: "system", stack: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT', 'Arial Rounded MT Bold', Calibri, source-sans-pro, sans-serif", czech: true },
  { id: "serif", label: "Serif (system)", category: "system", stack: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, " + SERIF_FALLBACK, czech: true },
  { id: "mono", label: "Monospace (system)", category: "system", stack: MONO_FALLBACK, czech: true },
];

const W5 = "300;400;500;600;700";

// [family, category, weights, czech]
const GOOGLE: Array<[string, Exclude<FontCategory, "theme" | "system">, string, boolean]> = [
  ["Inter", "sans", W5, true], ["Roboto", "sans", "300;400;500;700", true], ["Open Sans", "sans", W5, true],
  ["Lato", "sans", "300;400;700", true], ["Montserrat", "sans", W5, true], ["Poppins", "sans", W5, true],
  ["Nunito", "sans", W5, true], ["Raleway", "sans", W5, true], ["Work Sans", "sans", W5, true],
  ["Source Sans 3", "sans", W5, true], ["Noto Sans", "sans", W5, true], ["IBM Plex Sans", "sans", W5, true],
  ["Manrope", "sans", W5, true], ["DM Sans", "sans", W5, true], ["Rubik", "sans", W5, true],
  ["Fira Sans", "sans", W5, true], ["PT Sans", "sans", "400;700", true], ["Ubuntu", "sans", "300;400;500;700", true],
  ["Mulish", "sans", W5, true], ["Barlow", "sans", W5, true], ["Karla", "sans", W5, true],
  ["Quicksand", "sans", W5, true], ["Plus Jakarta Sans", "sans", W5, true], ["Lexend", "sans", W5, true],
  ["Figtree", "sans", W5, true], ["Space Grotesk", "sans", W5, true], ["Josefin Sans", "sans", W5, true],
  ["Titillium Web", "sans", "300;400;600;700", true], ["Exo 2", "sans", W5, true], ["Oswald", "sans", W5, true],
  ["Archivo", "sans", W5, true], ["Outfit", "sans", W5, true], ["Sora", "sans", W5, true],
  ["Merriweather", "serif", "300;400;700", true], ["Playfair Display", "serif", "400;500;600;700", true],
  ["Lora", "serif", "400;500;600;700", true], ["PT Serif", "serif", "400;700", true], ["Noto Serif", "serif", "400;700", true],
  ["Source Serif 4", "serif", W5, true], ["Libre Baskerville", "serif", "400;700", true],
  ["EB Garamond", "serif", "400;500;600;700", true], ["Crimson Pro", "serif", W5, true], ["Roboto Slab", "serif", W5, true],
  ["Bitter", "serif", W5, true], ["Cormorant Garamond", "serif", W5, true], ["Spectral", "serif", W5, true],
  ["Zilla Slab", "serif", W5, true], ["Alegreya", "serif", "400;500;600;700", true],
  ["Bebas Neue", "display", "400", true], ["Comfortaa", "display", W5, true], ["Righteous", "display", "400", true],
  ["Audiowide", "display", "400", true], ["Teko", "display", W5, true], ["Rajdhani", "display", W5, true],
  ["Chakra Petch", "display", W5, true], ["Orbitron", "display", "400;500;600;700", false],
  ["Caveat", "hand", "400;500;600;700", true], ["Dancing Script", "hand", "400;500;600;700", true],
  ["Pacifico", "hand", "400", true], ["Kalam", "hand", "300;400;700", true], ["Patrick Hand", "hand", "400", true],
  ["Great Vibes", "hand", "400", true], ["Indie Flower", "hand", "400", true],
  ["JetBrains Mono", "mono", W5, true], ["Fira Code", "mono", W5, true], ["Source Code Pro", "mono", W5, true],
  ["IBM Plex Mono", "mono", W5, true], ["Roboto Mono", "mono", W5, true], ["Space Mono", "mono", "400;700", true],
  ["Inconsolata", "mono", W5, true], ["Ubuntu Mono", "mono", "400;700", true],
];

const FALLBACK_FOR: Record<string, string> = {
  sans: SANS_FALLBACK,
  serif: SERIF_FALLBACK,
  display: SANS_FALLBACK,
  hand: `${HAND_FALLBACK}, ${SANS_FALLBACK}`,
  mono: MONO_FALLBACK,
};

export const googleFontId = (family: string) => `g-${family.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

export const GOOGLE_FONTS: FontDef[] = GOOGLE.map(([family, category, weights, czech]) => ({
  id: googleFontId(family),
  label: family,
  category,
  stack: `'${family}', ${FALLBACK_FOR[category]}`,
  google: { family, weights },
  czech,
}));

export const FONTS: FontDef[] = [...SYSTEM_FONTS, ...GOOGLE_FONTS];

export const FONT_CATEGORIES: FontCategory[] = ["theme", "system", "sans", "serif", "display", "hand", "mono"];

export function findFont(id: string): FontDef | undefined {
  return FONTS.find((f) => f.id === id);
}

export const isFontId = (v: unknown): v is string => typeof v === "string" && FONTS.some((f) => f.id === v);

/** CSS font-family for a font id; "" means "leave the template's font". */
export function fontStack(id: string): string {
  return findFont(id)?.stack ?? SANS_FALLBACK;
}

/** The css2 URL for one Google family (all of its verified weights). */
export function googleCssUrl(def: FontDef): string {
  if (!def.google) return "";
  const family = encodeURIComponent(def.google.family).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${family}:wght@${def.google.weights}&display=swap`;
}

/** Sample text used in previews: shows Czech diacritics at a glance. */
export const FONT_SAMPLE = "Příliš žluťoučký kůň úpěl ďábelské ódy";

const LINK_ATTR = "data-m5-font";

/** Make sure the given fonts are available. Google fonts are only requested
 *  with consent; without it nothing leaves the device and the fallback in the
 *  stack renders. Returns the ids that were (or already are) requested. */
export function ensureFonts(ids: string[], allowGoogle: boolean): string[] {
  if (typeof document === "undefined") return [];
  const requested: string[] = [];
  for (const id of new Set(ids)) {
    const def = findFont(id);
    if (!def?.google || !allowGoogle) continue;
    requested.push(id);
    if (document.head.querySelector(`link[${LINK_ATTR}="${def.id}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = googleCssUrl(def);
    link.setAttribute(LINK_ATTR, def.id);
    link.referrerPolicy = "no-referrer";
    document.head.appendChild(link);
  }
  return requested;
}

/** Consent withdrawn: drop every Google stylesheet we added. */
export function removeGoogleFonts(): void {
  if (typeof document === "undefined") return;
  document.head.querySelectorAll(`link[${LINK_ATTR}]`).forEach((el) => el.remove());
}
