// The files the Android app ships with (script/android-assets.ts writes
// them): the default design and the icon set. Pure functions, so a test can
// compare them with what is committed.

import { MENU_ICONS } from "../../client/src/lib/menu-icons-data";
import { DEFAULT_DESIGN, designRev, sanitizeDesign } from "./design";
import { androidThemes } from "./themes";
import { THEMES_67_LOOK } from "./design-67-look";

export function androidAssets(): Record<string, string> {
  const design = sanitizeDesign(DEFAULT_DESIGN);
  design.rev = designRev(design);
  // The icons without lucide's React keys: name → [[tag, attributes]].
  const icons = Object.fromEntries(Object.entries(MENU_ICONS).map(([name, children]) => [
    name,
    children.map(([tag, attrs]) => [tag, Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== "key"))]),
  ]));
  return {
    "default-design.json": `${JSON.stringify(design)}\n`,
    "icons.json": `${JSON.stringify(icons)}\n`,
    // 6.1: the web's templates, mapped onto the design's colour tokens (Settings › Appearance);
    // 6.7: then the app's own (design-67-look.ts), each with a light and a dark palette.
    "themes.json": `${JSON.stringify([...androidThemes(), ...THEMES_67_LOOK])}\n`,
  };
}
