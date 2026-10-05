// 6.12: the design's additions, one file per area (design-612-<area>.ts), each
// exporting an AREA (the 6.7 shape, design-67.ts); this file gathers them in
// the shape design.ts takes. They apply after 6.11's.

import type { ElementDef, ANode, MenuItem, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";
import { AREA as P4 } from "./design-612-p4";
import { AREA as NFC } from "./design-612-nfc";

const AREAS: DesignArea[] = [P4, NFC];

export const ELEMENTS_612: ElementDef[] = AREAS.flatMap((a) => a.elements ?? []);
export const ACTIONS_612: Array<{ action: string; arg: string; help: string }> = AREAS.flatMap((a) => a.actions ?? []);
export const SLOTS_612: Array<{ name: string; label: string; screens: string[] }> = AREAS.flatMap((a) => a.slots ?? []);
export const SCREENS_612: ScreenDef[] = AREAS.flatMap((a) => a.screens ?? []);
export const SCREENS_TREES_612: Record<string, ANode> = Object.assign({}, ...AREAS.map((a) => a.trees ?? {}));
export const MENUS_612: Record<string, MenuItem[]> = Object.assign({}, ...AREAS.map((a) => a.menus ?? {}));
export const STRINGS_612: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };
for (const a of AREAS) for (const lang of ["cs", "en", "de"] as const) Object.assign(STRINGS_612[lang], a.strings?.[lang] ?? {});

export function patch612(screens: Record<string, ANode>): void {
  for (const a of AREAS) a.patch?.(screens);
}

export function patchMenus612(menus: Record<string, MenuItem[]>): void {
  for (const a of AREAS) a.patchMenus?.(menus);
}
