// 6.2: the design's additions, one module per area so they can grow apart.
//   fixes    the lock screen, enrolment from a QR code, passkeys
//   people   the People widget, links to the phone's contacts
//   bubbles  map preview, message details, attachments, hide/delete
//   look     templates and colour variants, the Tools dock, the send button

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";
import * as F from "./design-62-fixes";
import * as P from "./design-62-people";
import * as B from "./design-62-bubbles";
import * as L from "./design-62-look";

export const ELEMENTS_62: ElementDef[] = [...F.ELEMENTS_62_FIXES, ...P.ELEMENTS_62_PEOPLE, ...B.ELEMENTS_62_BUBBLES, ...L.ELEMENTS_62_LOOK];
export const ACTIONS_62: Array<{ action: string; arg: string; help: string }> = [...F.ACTIONS_62_FIXES, ...P.ACTIONS_62_PEOPLE, ...B.ACTIONS_62_BUBBLES, ...L.ACTIONS_62_LOOK];
export const SLOTS_62: Array<{ name: string; label: string; screens: string[] }> = [...F.SLOTS_62_FIXES, ...P.SLOTS_62_PEOPLE, ...B.SLOTS_62_BUBBLES, ...L.SLOTS_62_LOOK];
export const SCREENS_62: ScreenDef[] = [...F.SCREENS_62_FIXES, ...P.SCREENS_62_PEOPLE, ...B.SCREENS_62_BUBBLES, ...L.SCREENS_62_LOOK];
export const SCREENS_TREES_62: Record<string, ANode> = { ...F.SCREENS_TREES_62_FIXES, ...P.SCREENS_TREES_62_PEOPLE, ...B.SCREENS_TREES_62_BUBBLES, ...L.SCREENS_TREES_62_LOOK };
export const MENUS_62: Record<string, MenuItem[]> = { ...F.MENUS_62_FIXES, ...P.MENUS_62_PEOPLE, ...B.MENUS_62_BUBBLES, ...L.MENUS_62_LOOK };
export const STRINGS_62: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };
for (const lang of ["cs", "en", "de"] as const) Object.assign(STRINGS_62[lang], F.STRINGS_62_FIXES[lang], P.STRINGS_62_PEOPLE[lang], B.STRINGS_62_BUBBLES[lang], L.STRINGS_62_LOOK[lang]);

/** Every area's changes to existing trees, in a fixed order. */
export function patch62(screens: Record<string, ANode>): void {
  F.patch62Fixes(screens);
  P.patch62People(screens);
  B.patch62Bubbles(screens);
  L.patch62Look(screens);
}
