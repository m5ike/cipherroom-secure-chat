// 6.11: the design's additions, one file per area (design-611-<area>.ts), each
// exporting an AREA (the 6.7 shape, design-67.ts); this file gathers them in
// the shape design.ts takes. They apply after 6.10's.

import type { ElementDef, ANode, MenuItem, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";
import { AREA as FN } from "./design-611-fn";

const AREAS: DesignArea[] = [FN];

export const ELEMENTS_611: ElementDef[] = AREAS.flatMap((a) => a.elements ?? []);
export const ACTIONS_611: Array<{ action: string; arg: string; help: string }> = AREAS.flatMap((a) => a.actions ?? []);
export const SLOTS_611: Array<{ name: string; label: string; screens: string[] }> = AREAS.flatMap((a) => a.slots ?? []);
export const SCREENS_611: ScreenDef[] = AREAS.flatMap((a) => a.screens ?? []);
export const SCREENS_TREES_611: Record<string, ANode> = Object.assign({}, ...AREAS.map((a) => a.trees ?? {}));
export const MENUS_611: Record<string, MenuItem[]> = Object.assign({}, ...AREAS.map((a) => a.menus ?? {}));
export const STRINGS_611: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };
for (const a of AREAS) for (const lang of ["cs", "en", "de"] as const) Object.assign(STRINGS_611[lang], a.strings?.[lang] ?? {});

export function patch611(screens: Record<string, ANode>): void {
  for (const a of AREAS) a.patch?.(screens);
}

export function patchMenus611(menus: Record<string, MenuItem[]>): void {
  for (const a of AREAS) a.patchMenus?.(menus);
}
