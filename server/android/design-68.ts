// 6.8: the design's additions, one file per area (design-68-<area>.ts), each
// exporting an AREA (the 6.7 shape, design-67.ts); this file gathers them in
// the shape design.ts takes. They apply after 6.7's.

import type { ElementDef, ANode, MenuItem, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";
import { AREA as SEND } from "./design-68-send";
import { AREA as CALLLOG } from "./design-68-calllog";

const AREAS: DesignArea[] = [SEND, CALLLOG];

export const ELEMENTS_68: ElementDef[] = AREAS.flatMap((a) => a.elements ?? []);
export const ACTIONS_68: Array<{ action: string; arg: string; help: string }> = AREAS.flatMap((a) => a.actions ?? []);
export const SLOTS_68: Array<{ name: string; label: string; screens: string[] }> = AREAS.flatMap((a) => a.slots ?? []);
export const SCREENS_68: ScreenDef[] = AREAS.flatMap((a) => a.screens ?? []);
export const SCREENS_TREES_68: Record<string, ANode> = Object.assign({}, ...AREAS.map((a) => a.trees ?? {}));
export const MENUS_68: Record<string, MenuItem[]> = Object.assign({}, ...AREAS.map((a) => a.menus ?? {}));
export const STRINGS_68: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };
for (const a of AREAS) for (const lang of ["cs", "en", "de"] as const) Object.assign(STRINGS_68[lang], a.strings?.[lang] ?? {});

export function patch68(screens: Record<string, ANode>): void {
  for (const a of AREAS) a.patch?.(screens);
}

export function patchMenus68(menus: Record<string, MenuItem[]>): void {
  for (const a of AREAS) a.patchMenus?.(menus);
}
