// 6.4: the design's additions. One area for now (registration and passkey
// diagnostics), same shape as 6.2 / 6.3 so it can grow.

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";
import * as R from "./design-64-registration";

export const ELEMENTS_64: ElementDef[] = [...R.ELEMENTS_64_REG];
export const ACTIONS_64: Array<{ action: string; arg: string; help: string }> = [...R.ACTIONS_64_REG];
export const SLOTS_64: Array<{ name: string; label: string; screens: string[] }> = [...R.SLOTS_64_REG];
export const SCREENS_64: ScreenDef[] = [...R.SCREENS_64_REG];
export const SCREENS_TREES_64: Record<string, ANode> = { ...R.SCREENS_TREES_64_REG };
export const MENUS_64: Record<string, MenuItem[]> = { ...R.MENUS_64_REG };
export const STRINGS_64: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };
for (const lang of ["cs", "en", "de"] as const) Object.assign(STRINGS_64[lang], R.STRINGS_64_REG[lang]);

export function patch64(screens: Record<string, ANode>): void {
  R.patch64Reg(screens);
}

/** 6.4 adds items to menus that already exist (MENUS_64 would replace a whole menu). */
export function patchMenus64(menus: Record<string, MenuItem[]>): void {
  R.patchMenus64Reg(menus);
}
