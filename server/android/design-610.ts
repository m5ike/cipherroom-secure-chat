// 6.10: the design's additions, one file per area (design-610-<area>.ts), each
// exporting an AREA (the 6.7 shape, design-67.ts); this file gathers them in
// the shape design.ts takes. They apply after 6.8's.

import type { ElementDef, ANode, MenuItem, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";
import { AREA as CHAT } from "./design-610-chat";
import { AREA as NFC } from "./design-610-nfc";

const AREAS: DesignArea[] = [CHAT, NFC];

export const ELEMENTS_610: ElementDef[] = AREAS.flatMap((a) => a.elements ?? []);
export const ACTIONS_610: Array<{ action: string; arg: string; help: string }> = AREAS.flatMap((a) => a.actions ?? []);
export const SLOTS_610: Array<{ name: string; label: string; screens: string[] }> = AREAS.flatMap((a) => a.slots ?? []);
export const SCREENS_610: ScreenDef[] = AREAS.flatMap((a) => a.screens ?? []);
export const SCREENS_TREES_610: Record<string, ANode> = Object.assign({}, ...AREAS.map((a) => a.trees ?? {}));
export const MENUS_610: Record<string, MenuItem[]> = Object.assign({}, ...AREAS.map((a) => a.menus ?? {}));
export const STRINGS_610: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };
for (const a of AREAS) for (const lang of ["cs", "en", "de"] as const) Object.assign(STRINGS_610[lang], a.strings?.[lang] ?? {});

export function patch610(screens: Record<string, ANode>): void {
  for (const a of AREAS) a.patch?.(screens);
}

export function patchMenus610(menus: Record<string, MenuItem[]>): void {
  for (const a of AREAS) a.patchMenus?.(menus);
}
