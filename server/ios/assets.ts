// The files the iOS app may ship (6.14), as server/android/assets.ts writes
// Android's: the iOS default design, the icon set (the same as Android's) and
// the appearance templates with the iOS look first. Pure functions for a
// build script or a test — never imported by the running server: the web's
// templates are read from client/src/*.css (server/android/themes.ts), which
// a production bundle does not carry.

import { designRev } from "../android/design";
import { androidAssets } from "../android/assets";
import { androidThemes, type AndroidTheme } from "../android/themes";
import { THEMES_67_LOOK } from "../android/design-67-look";
import { IOS_DEFAULT_DESIGN, IOS_LOOK_THEME, sanitizeIosDesign } from "./design";

/** The templates the iOS app offers: its own look, then the web's and the app's (as on Android). */
export function iosThemes(): AndroidTheme[] {
  return [IOS_LOOK_THEME, ...androidThemes(), ...THEMES_67_LOOK];
}

export function iosAssets(): Record<string, string> {
  const design = sanitizeIosDesign(IOS_DEFAULT_DESIGN);
  design.rev = designRev(design);
  return {
    "default-design.json": `${JSON.stringify(design)}\n`,
    "icons.json": androidAssets()["icons.json"],
    "themes.json": `${JSON.stringify(iosThemes())}\n`,
  };
}
