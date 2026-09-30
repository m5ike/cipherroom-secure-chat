// 6.2 — the People widget (avatars, status, signal, selection) and linking people to the phone's contacts.
// Merged into the default design by design-62.ts (this file adds to the
// catalog; a tree here replaces the one of the same id).

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

export const ELEMENTS_62_PEOPLE: ElementDef[] = [];
export const ACTIONS_62_PEOPLE: Array<{ action: string; arg: string; help: string }> = [];
export const SLOTS_62_PEOPLE: Array<{ name: string; label: string; screens: string[] }> = [];
export const SCREENS_62_PEOPLE: ScreenDef[] = [];
export const SCREENS_TREES_62_PEOPLE: Record<string, ANode> = {};
export const MENUS_62_PEOPLE: Record<string, MenuItem[]> = {};
export const STRINGS_62_PEOPLE: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };

/** Changes to existing trees (after every 6.1 and 6.2 tree is in place). */
export function patch62People(_screens: Record<string, ANode>): void { /* none yet */ }
