// 6.3 — the NFC workbench: reader choice, card technologies, scan, read, write,
// change UID, emulate, and the M5Cet card (records and the visual builder).
// Merged into the default design by design-63.ts.

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

export const ELEMENTS_63_NFC: ElementDef[] = [];
export const ACTIONS_63_NFC: Array<{ action: string; arg: string; help: string }> = [];
export const SLOTS_63_NFC: Array<{ name: string; label: string; screens: string[] }> = [];
export const SCREENS_63_NFC: ScreenDef[] = [];
export const SCREENS_TREES_63_NFC: Record<string, ANode> = {};
export const MENUS_63_NFC: Record<string, MenuItem[]> = {};
export const STRINGS_63_NFC: Record<"cs" | "en" | "de", Record<string, string>> = { cs: {}, en: {}, de: {} };

/** Changes to existing trees (after every 6.1/6.2/6.3 tree is in place). */
export function patch63Nfc(_screens: Record<string, ANode>): void { /* none yet */ }
