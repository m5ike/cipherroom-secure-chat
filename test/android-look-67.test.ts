// @vitest-environment node
// 6.7 — the Android app's look (server/android/design-67-look.ts): six
// templates of its own, each light and dark, readable (WCAG AA); every menu
// item and button with an icon; the rooms' rows slide to Delete / Clone /
// Edit (the "swipe" element, its menus and actions).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_IDS } from "../client/src/lib/theme-catalog";
import { MENU_ICONS } from "../client/src/lib/menu-icons-data";
import { ACTIONS, COLOR_TOKENS, DEFAULT_DESIGN, DEFAULT_MENUS, DEFAULT_SCREENS, DEFAULT_STRINGS, ELEMENTS, SCREEN_IDS, sanitizeDesign, sanitizeScreen, type ANode } from "../server/android/design";
import { androidAssets } from "../server/android/assets";
import * as L from "../server/android/design-67-look";

const walk = (n: ANode, f: (n: ANode) => void): void => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };

/** WCAG 2 contrast of two #rrggbb colours. */
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1, 7), 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const TOKENS = ["background", "surface", "surfaceVariant", "onSurface", "muted", "border", "primary", "onPrimary", "accent", "danger", "success", "warning", "bubbleIn", "onBubbleIn", "bubbleOut", "onBubbleOut"];

/** Text (and what it sits on) that must read: body text 7:1, the rest AA (4.5:1). */
const READS: Array<[string, string, number]> = [
  ["onSurface", "surface", 7], ["onSurface", "background", 7], ["onSurface", "surfaceVariant", 4.5],
  ["muted", "surface", 4.5], ["muted", "background", 4.5], ["muted", "surfaceVariant", 4.5],
  ["onPrimary", "primary", 4.5], ["primary", "surface", 4.5], ["primary", "background", 4.5],
  ["onBubbleIn", "bubbleIn", 4.5], ["onBubbleOut", "bubbleOut", 4.5],
  ["danger", "surface", 4.5], ["danger", "surfaceVariant", 4.5], ["success", "surface", 4.5], ["success", "surfaceVariant", 4.5], ["warning", "surface", 4.5],
];

describe("6.7 templates of the app's own", () => {
  const themes = L.THEMES_67_LOOK;

  it("at least four new ones, none a web template, each light AND dark with every token", () => {
    expect(themes.length).toBeGreaterThanOrEqual(4);
    const ids = themes.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of themes) {
      expect((THEME_IDS as readonly string[]).includes(t.id), t.id).toBe(false);
      expect(t.id).toMatch(/^[a-z]+$/);
      expect(t.tones).toEqual(["light", "dark"]);
      expect(["classic", "system", "studio"]).toContain(t.family);
      for (const lang of ["cs", "en", "de"] as const) expect(t.label[lang], `${t.id} ${lang}`).toBeTruthy();
      for (const tone of ["light", "dark"] as const) {
        const p = t[tone]!;
        for (const k of TOKENS) expect(p[k], `${t.id}.${tone}.${k}`).toMatch(/^#[0-9a-f]{6}$/);
        for (const k of Object.keys(p)) expect(COLOR_TOKENS as readonly string[], `${t.id}.${tone}.${k}`).toContain(k);
      }
    }
  });

  it("every text reads on what it sits on, in both tones (WCAG AA)", () => {
    for (const t of themes) for (const tone of ["light", "dark"] as const) {
      const p = t[tone]!;
      for (const [fg, bg, min] of READS) expect(contrast(p[fg], p[bg]), `${t.id}.${tone}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
      // the light palette is light, the dark one dark
      if (tone === "light") expect(lum(p.background)).toBeGreaterThan(0.6);
      else expect(lum(p.background)).toBeLessThan(0.05);
    }
  });

  it("the app carries them after the web's (themes.json), and the app knows their colour variants", () => {
    const shipped = JSON.parse(androidAssets()["themes.json"]) as Array<{ id: string }>;
    const ids = shipped.map((t) => t.id);
    expect(ids.slice(0, THEME_IDS.length).sort()).toEqual([...THEME_IDS].sort());
    for (const t of themes) expect(ids).toContain(t.id);
    const palette = readFileSync(join(__dirname, "..", "android", "app", "src", "main", "java", "cz", "m5cet", "app", "ui", "look", "Palette.java"), "utf8");
    for (const t of themes) expect(palette, t.id).toMatch(new RegExp(`template\\("${t.id}"(, "[a-z]+"){6,}\\)`));
    // the new colour names have their labels
    for (const hue of L.NEW_HUES_67) {
      expect(palette).toContain(`named("${hue}"`);
      for (const lang of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[lang][`color.${hue}`], `${lang} color.${hue}`).toBeTruthy();
    }
    // every variant a template names has a label
    for (const m of palette.matchAll(/template\("[a-z]+", ([^)]*)\)/g)) for (const v of m[1].match(/[a-z]+/g) ?? []) {
      for (const lang of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[lang][`color.${v}`], `${lang} color.${v}`).toBeTruthy();
    }
  });
});

describe("6.7 icons on the menus and buttons", () => {
  it("every item of every menu has an icon of the set", () => {
    for (const [id, items] of Object.entries(DEFAULT_MENUS)) for (const it of items) {
      expect(it.icon, `${id}/${it.id}`).toBeTruthy();
      expect(it.icon in MENU_ICONS, `${id}/${it.id}: ${it.icon}`).toBe(true);
    }
  });

  it("every button of the default screens shows an icon", () => {
    for (const [id, tree] of Object.entries(DEFAULT_SCREENS)) walk(tree, (n) => {
      if (n.el === "button") expect(n.props?.icon, `${id}/${n.id}`).toBeTruthy();
    });
  });

  it("the main settings' rows carry their icon on a tile in the primary colour", () => {
    const rows: ANode[] = [];
    walk(DEFAULT_SCREENS.settings, (n) => { if (n.el === "row" && n.on?.click && n.id !== "bar") rows.push(n); });
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const r of rows) {
      const tile = r.children![0];
      expect(tile.el, r.id).toBe("column");
      expect(tile.style?.bg).toBe("@surfaceVariant");
      expect(tile.children![0].el).toBe("icon");
      expect(tile.children![0].props?.color).toBe("@primary");
    }
  });

  it("the patches are idempotent", () => {
    const screens = structuredClone(DEFAULT_SCREENS);
    L.settingsTiles(screens);
    L.buttonIcons(screens);
    L.swipeRooms(screens);
    expect(screens).toEqual(DEFAULT_SCREENS);
  });
});

describe("6.7 swipe on the rooms' rows", () => {
  it("the swipe element is in the catalog: a container with two menus and their colours", () => {
    const def = ELEMENTS.find((e) => e.el === "swipe")!;
    expect(def.container).toBe(true);
    expect(def.props.map((p) => p.name).sort()).toEqual(["left", "leftColor", "right", "rightColor"]);
    for (const a of ["room.delete", "room.clone", "room.edit"]) expect(ACTIONS.some((x) => x.action === a), a).toBe(true);
    expect(SCREEN_IDS).toContain("room.edit");
  });

  it("a room's row: dragged right → Delete, dragged left → Clone and Edit (of that room)", () => {
    const item = DEFAULT_SCREENS["rooms.item"];
    expect(item.el).toBe("swipe");
    expect(item.children).toHaveLength(1);
    expect(item.children![0].el).toBe("row");
    const right = DEFAULT_MENUS[String(item.props?.right)];
    const left = DEFAULT_MENUS[String(item.props?.left)];
    expect(right.map((i) => [i.action, i.icon])).toEqual([["room.delete", "trash"]]);
    expect(left.map((i) => [i.action, i.icon])).toEqual([["room.clone", "copy"], ["room.edit", "pencil"]]);
    for (const it of [...right, ...left]) expect(it.arg).toBe("=$room.key");
    expect(item.props?.rightColor).toBe("@danger");
  });

  it("the edit sheet holds the join form; its trees pass the sanitizer and the whole design is valid", () => {
    const problems: string[] = [];
    sanitizeScreen(structuredClone(DEFAULT_SCREENS["room.edit"]), "room.edit", problems);
    sanitizeScreen(structuredClone(DEFAULT_SCREENS["rooms.item"]), "rooms.item", problems);
    expect(problems).toEqual([]);
    const slots: string[] = [];
    walk(DEFAULT_SCREENS["room.edit"], (n) => { if (n.el === "slot") slots.push(String(n.props?.name)); });
    expect(slots).toEqual(["joinForm"]);
    const clean = sanitizeDesign(DEFAULT_DESIGN);
    expect(clean.menus["room-swipe-left"]).toHaveLength(2);
    expect(clean.screens["rooms.item"].el).toBe("swipe");
  });

  it("a design saved before 6.7 still gets the rooms' swipe menus (the app swipes its rows with them)", () => {
    const old = structuredClone(DEFAULT_DESIGN);
    delete (old.menus as Record<string, unknown>)["room-swipe-right"];
    delete (old.menus as Record<string, unknown>)["room-swipe-left"];
    old.screens["rooms.item"] = old.screens["rooms.item"].children![0];
    const clean = sanitizeDesign(old);
    expect(clean.menus["room-swipe-right"]).toEqual(DEFAULT_MENUS["room-swipe-right"]);
    expect(clean.screens["rooms.item"].el).toBe("row");
  });

  it("every text the area uses exists in Czech, English and German", () => {
    const used = new Set<string>();
    const scan = (v: unknown): void => {
      if (typeof v === "string") for (const m of v.matchAll(/_\(?'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
      else if (v && typeof v === "object") Object.values(v).forEach(scan);
    };
    scan(L.AREA.trees);
    scan(L.AREA.menus);
    for (const k of ["room.delete.title", "room.delete.text", "room.delete.yes", "room.delete.no", "room.deleted", "room.cloned", "room.edit.save", "room.edit.saved", "room.edit.missing"]) used.add(k);
    for (const k of used) for (const lang of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[lang][k], `${lang} ${k}`).toBeTruthy();
    const keys = new Set((["cs", "en", "de"] as const).flatMap((l) => Object.keys(L.AREA.strings?.[l] ?? {})));
    for (const l of ["cs", "en", "de"] as const) for (const k of keys) expect(L.AREA.strings?.[l]?.[k], `${l} ${k}`).toBeTruthy();
  });
});
