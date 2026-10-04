// 6.7: the design's additions, one file per area (design-67-<area>.ts), each
// exporting an AREA; this file gathers them in the shape design.ts takes.

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";
import { AREA as PRESENCE } from "./design-67-presence";
import { AREA as LOCATION } from "./design-67-location";
import { AREA as NOTIFY } from "./design-67-notify";
import { AREA as VOICE } from "./design-67-voice";
import { AREA as LOOK } from "./design-67-look";
import { AREA as PROFILE } from "./design-67-profile";

/** What one area adds (new elements, actions, slots, screens, trees, menus, strings) and changes (patch, patchMenus). */
export type DesignArea = {
  elements?: ElementDef[];
  actions?: Array<{ action: string; arg: string; help: string }>;
  slots?: Array<{ name: string; label: string; screens: string[] }>;
  screens?: ScreenDef[];
  trees?: Record<string, ANode>;
  menus?: Record<string, MenuItem[]>;
  strings?: Partial<Record<"cs" | "en" | "de", Record<string, string>>>;
  /** Changes to trees that already exist (after every older version's). */
  patch?: (screens: Record<string, ANode>) => void;
  /** Items added to menus that already exist (menus would replace a whole one). */
  patchMenus?: (menus: Record<string, MenuItem[]>) => void;
};

const AREAS: DesignArea[] = [PRESENCE, LOCATION, NOTIFY, VOICE, LOOK, PROFILE];

export const ELEMENTS_67: ElementDef[] = AREAS.flatMap((a) => a.elements ?? []);
export const ACTIONS_67: Array<{ action: string; arg: string; help: string }> = AREAS.flatMap((a) => a.actions ?? []);
export const SLOTS_67: Array<{ name: string; label: string; screens: string[] }> = AREAS.flatMap((a) => a.slots ?? []);
export const SCREENS_67: ScreenDef[] = AREAS.flatMap((a) => a.screens ?? []);
export const SCREENS_TREES_67: Record<string, ANode> = Object.assign({}, ...AREAS.map((a) => a.trees ?? {}));
export const MENUS_67: Record<string, MenuItem[]> = Object.assign({}, ...AREAS.map((a) => a.menus ?? {}));
export const STRINGS_67: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };
for (const a of AREAS) for (const lang of ["cs", "en", "de"] as const) Object.assign(STRINGS_67[lang], a.strings?.[lang] ?? {});

export function patch67(screens: Record<string, ANode>): void {
  for (const a of AREAS) a.patch?.(screens);
}

export function patchMenus67(menus: Record<string, MenuItem[]>): void {
  for (const a of AREAS) a.patchMenus?.(menus);
}
