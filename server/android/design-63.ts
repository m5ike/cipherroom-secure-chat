// 6.3: the design's additions. One area for now (NFC), same shape as 6.2 so it
// can grow.

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";
import * as N from "./design-63-nfc";

export const ELEMENTS_63: ElementDef[] = [...N.ELEMENTS_63_NFC];
export const ACTIONS_63: Array<{ action: string; arg: string; help: string }> = [...N.ACTIONS_63_NFC];
export const SLOTS_63: Array<{ name: string; label: string; screens: string[] }> = [...N.SLOTS_63_NFC];
export const SCREENS_63: ScreenDef[] = [...N.SCREENS_63_NFC];
export const SCREENS_TREES_63: Record<string, ANode> = { ...N.SCREENS_TREES_63_NFC };
export const MENUS_63: Record<string, MenuItem[]> = { ...N.MENUS_63_NFC };
export const STRINGS_63: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };
for (const lang of ["cs", "en", "de"] as const) Object.assign(STRINGS_63[lang], N.STRINGS_63_NFC[lang]);

export function patch63(screens: Record<string, ANode>): void {
  N.patch63Nfc(screens);
}
