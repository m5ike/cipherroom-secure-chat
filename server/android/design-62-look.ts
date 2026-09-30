// 6.2 — the look: templates with colour variants, fonts, animations, buttons; the Tools dock; the send button and the microphone.
// Merged into the default design by design-62.ts (this file adds to the
// catalog; a tree here replaces the one of the same id).

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

export const ELEMENTS_62_LOOK: ElementDef[] = [];
export const ACTIONS_62_LOOK: Array<{ action: string; arg: string; help: string }> = [];
export const SLOTS_62_LOOK: Array<{ name: string; label: string; screens: string[] }> = [];
export const SCREENS_62_LOOK: ScreenDef[] = [];
export const SCREENS_TREES_62_LOOK: Record<string, ANode> = {};
export const MENUS_62_LOOK: Record<string, MenuItem[]> = {};
export const STRINGS_62_LOOK: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };

/** Changes to existing trees (after every 6.1 and 6.2 tree is in place). */
export function patch62Look(_screens: Record<string, ANode>): void { /* none yet */ }
