// The GUI templates: which exist, which tones (light / dark) each has, the
// icon style it prefers and the colours its picker card shows. PURE data —
// no DOM — so the server can validate the operator's configuration
// (client-config.ts) against the same list the client renders.
//
// The real look lives in CSS: index.css (the classic templates) and
// themes.css (the system look-alikes and the studio templates), keyed by
// :root[data-theme] and, for templates with two tones, [data-tone].

export const THEME_IDS = [
  // classic
  "motorsport", "glass", "terminal", "midnight", "paper", "contrast",
  // system look-alikes
  "ios", "windows",
  // studio
  "aurora", "nord", "sakura", "ocean", "graphite",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export type ThemeTone = "light" | "dark";
/** What the user picked for a template that has both tones. */
export type ToneChoice = "auto" | ThemeTone;
export const TONE_CHOICES: readonly ToneChoice[] = ["auto", "light", "dark"] as const;

/**
 *   outline  the icon set as drawn (2 px strokes)
 *   thin     1.5 px — Windows 11 / Fluent
 *   bold     2.5 px
 *   duotone  strokes plus a soft fill of the same colour
 *   badge    menu icons on coloured rounded squares (iOS Settings), rounded
 *            strokes elsewhere
 */
export const ICON_STYLES = ["outline", "thin", "bold", "duotone", "badge"] as const;
export type IconStyle = (typeof ICON_STYLES)[number];

export type ThemeFamily = "classic" | "system" | "studio";
export const THEME_FAMILIES: ReadonlyArray<{ id: ThemeFamily; labelKey: string }> = [
  { id: "system", labelKey: "themes.family.system" },
  { id: "classic", labelKey: "themes.family.classic" },
  { id: "studio", labelKey: "themes.family.studio" },
];

type Hsl = [number, number, number];
export type ThemePreview = { bg: Hsl; card: Hsl; fg: Hsl; primary: Hsl };

export type ThemeDef = {
  id: ThemeId;
  family: ThemeFamily;
  /** The first one is the template's default tone. */
  tones: readonly ThemeTone[];
  labelKey: string;
  descKey: string;
  icons: IconStyle;
  preview: Partial<Record<ThemeTone, ThemePreview>>;
};

export const THEME_CATALOG: readonly ThemeDef[] = [
  { id: "motorsport", family: "classic", tones: ["dark"], labelKey: "themes.motorsport", descKey: "themes.motorsport.desc", icons: "outline",
    preview: { dark: { bg: [220, 28, 6], card: [220, 26, 9], fg: [210, 16, 95], primary: [0, 86, 52] } } },
  { id: "glass", family: "classic", tones: ["light"], labelKey: "themes.glass", descKey: "themes.glass.desc", icons: "outline",
    preview: { light: { bg: [210, 40, 98], card: [0, 0, 100], fg: [222, 28, 14], primary: [220, 90, 56] } } },
  { id: "terminal", family: "classic", tones: ["dark"], labelKey: "themes.terminal", descKey: "themes.terminal.desc", icons: "outline",
    preview: { dark: { bg: [145, 30, 4], card: [145, 32, 6], fg: [142, 86, 78], primary: [142, 86, 50] } } },
  { id: "midnight", family: "classic", tones: ["dark"], labelKey: "themes.midnight", descKey: "themes.midnight.desc", icons: "outline",
    preview: { dark: { bg: [232, 38, 7], card: [232, 34, 10], fg: [226, 40, 92], primary: [252, 88, 68] } } },
  { id: "paper", family: "classic", tones: ["light"], labelKey: "themes.paper", descKey: "themes.paper.desc", icons: "outline",
    preview: { light: { bg: [40, 33, 96], card: [42, 40, 99], fg: [28, 24, 14], primary: [18, 72, 42] } } },
  { id: "contrast", family: "classic", tones: ["dark"], labelKey: "themes.contrast", descKey: "themes.contrast.desc", icons: "bold",
    preview: { dark: { bg: [0, 0, 0], card: [0, 0, 5], fg: [0, 0, 100], primary: [52, 100, 50] } } },

  { id: "ios", family: "system", tones: ["light", "dark"], labelKey: "themes.ios", descKey: "themes.ios.desc", icons: "badge",
    preview: {
      light: { bg: [240, 24, 96], card: [0, 0, 100], fg: [0, 0, 0], primary: [211, 100, 50] },
      dark: { bg: [0, 0, 0], card: [240, 3, 11], fg: [0, 0, 100], primary: [210, 100, 52] },
    } },
  { id: "windows", family: "system", tones: ["light", "dark"], labelKey: "themes.windows", descKey: "themes.windows.desc", icons: "thin",
    preview: {
      light: { bg: [0, 0, 95], card: [0, 0, 98], fg: [0, 0, 11], primary: [209, 100, 36] },
      dark: { bg: [0, 0, 13], card: [0, 0, 17], fg: [0, 0, 100], primary: [199, 100, 69] },
    } },

  { id: "aurora", family: "studio", tones: ["dark"], labelKey: "themes.aurora", descKey: "themes.aurora.desc", icons: "duotone",
    preview: { dark: { bg: [232, 40, 8], card: [234, 34, 12], fg: [220, 40, 95], primary: [168, 82, 48] } } },
  { id: "nord", family: "studio", tones: ["dark", "light"], labelKey: "themes.nord", descKey: "themes.nord.desc", icons: "thin",
    preview: {
      dark: { bg: [220, 16, 22], card: [222, 16, 28], fg: [218, 27, 94], primary: [193, 43, 67] },
      light: { bg: [218, 27, 94], card: [0, 0, 100], fg: [220, 16, 22], primary: [213, 32, 52] },
    } },
  { id: "sakura", family: "studio", tones: ["light"], labelKey: "themes.sakura", descKey: "themes.sakura.desc", icons: "duotone",
    preview: { light: { bg: [340, 60, 97], card: [0, 0, 100], fg: [330, 22, 18], primary: [336, 72, 50] } } },
  { id: "ocean", family: "studio", tones: ["light", "dark"], labelKey: "themes.ocean", descKey: "themes.ocean.desc", icons: "outline",
    preview: {
      light: { bg: [195, 45, 96], card: [0, 0, 100], fg: [205, 42, 15], primary: [190, 86, 34] },
      dark: { bg: [205, 50, 9], card: [204, 44, 13], fg: [190, 30, 92], primary: [184, 80, 48] },
    } },
  { id: "graphite", family: "studio", tones: ["dark", "light"], labelKey: "themes.graphite", descKey: "themes.graphite.desc", icons: "bold",
    preview: {
      dark: { bg: [0, 0, 9], card: [0, 0, 12], fg: [0, 0, 92], primary: [24, 95, 55] },
      light: { bg: [0, 0, 97], card: [0, 0, 100], fg: [0, 0, 10], primary: [22, 90, 44] },
    } },
];

export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
export const isToneChoice = (v: unknown): v is ToneChoice => typeof v === "string" && (TONE_CHOICES as readonly string[]).includes(v);
export const isIconStyle = (v: unknown): v is IconStyle => typeof v === "string" && (ICON_STYLES as readonly string[]).includes(v);

export function themeDef(id: ThemeId): ThemeDef {
  return THEME_CATALOG.find((t) => t.id === id) ?? THEME_CATALOG[0];
}

/** The tone a template shows for a choice; `systemDark` is the OS setting. */
export function resolveTone(id: ThemeId, choice: ToneChoice, systemDark: boolean): ThemeTone {
  const tones = themeDef(id).tones;
  if (tones.length === 1) return tones[0];
  const wanted: ThemeTone = choice === "auto" ? (systemDark ? "dark" : "light") : choice;
  return tones.includes(wanted) ? wanted : tones[0];
}

/** The icon style shown: the user's pick, or the template's own. */
export function resolveIconStyle(id: ThemeId, choice: IconStyle | "theme"): IconStyle {
  return choice === "theme" ? themeDef(id).icons : choice;
}
