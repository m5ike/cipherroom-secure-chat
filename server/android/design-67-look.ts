// 6.7 design area: six more colour templates, icons on menu buttons, swipe gestures on the room rows (6.7)
// One area of the 6.7 design (design-67.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
//   THEMES_67_LOOK   six templates of the app's own (forest, sunset, lavender,
//                    mocha, arctic, ink), each light AND dark; assets.ts puts
//                    them after the web's into themes.json, Palette.java
//                    gives each its colour variants
//   swipe            a list row that slides sideways to reveal the actions of
//                    a menu (ui/look/SwipeRow.java); the rooms' rows use it:
//                    dragged right → Delete, dragged left → Clone, Edit
//   room.edit        the join form, filled with a saved room (its Edit)
//   patch            rooms.item in a swipe; the main settings' icons on tiles;
//                    the last buttons without an icon get one
//
// The menus themselves (MainActivity.showMenu, a message's long press, a
// select's choices) are drawn by ui/look/Menus.java in the design's colours:
// icon + label, so an icon never disappears on a popup of the other tone.

import type { DesignArea } from "./design-67";
import type { ANode, ElementDef, MenuItem, PropDef, ScreenDef } from "./design";
import type { AndroidTheme } from "./themes";
import { n } from "./design-62-look";

const P = (name: string, kind: PropDef["kind"], label: string, extra: Partial<PropDef> = {}): PropDef => ({ name, kind, label, ...extra });

/* ============================================================= templates */

/**
 * Templates of the Android app only (Settings › Appearance › Template, next
 * to the web's): each with a light AND a dark palette on the design's colour
 * tokens. Every text colour reads on what it sits on (WCAG AA, 4.5:1; body
 * text 7:1 — test/android-look-67.test.ts checks it). assets.ts appends
 * them to the web's (themes.json); ui/look/Palette.java lists their colour
 * variants.
 */
export const THEMES_67_LOOK: AndroidTheme[] = [
  {
    id: "forest", family: "studio", tones: ["light", "dark"], radius: 18,
    label: { cs: "Les", en: "Forest", de: "Wald" },
    light: {
      background: "#f2f5f0", surface: "#ffffff", surfaceVariant: "#e5ece2", onSurface: "#15231a", muted: "#4f6154", border: "#d3ddcf",
      primary: "#2d6a43", onPrimary: "#ffffff", accent: "#2d6a43", danger: "#b42318", success: "#1f6b34", warning: "#8f5000",
      bubbleIn: "#ffffff", onBubbleIn: "#15231a", bubbleOut: "#2d6a43", onBubbleOut: "#ffffff",
    },
    dark: {
      background: "#0d1410", surface: "#141e18", surfaceVariant: "#1d2a22", onSurface: "#e3ede5", muted: "#98ab9d", border: "#2a3a30",
      primary: "#7cc694", onPrimary: "#0a1a10", accent: "#7cc694", danger: "#f2948b", success: "#86d39b", warning: "#f0bd5a",
      bubbleIn: "#1c2a21", onBubbleIn: "#e3ede5", bubbleOut: "#2d6a43", onBubbleOut: "#ffffff",
    },
  },
  {
    id: "sunset", family: "studio", tones: ["light", "dark"], radius: 20,
    label: { cs: "Západ slunce", en: "Sunset", de: "Sonnenuntergang" },
    light: {
      background: "#fff6ef", surface: "#ffffff", surfaceVariant: "#fbe9dd", onSurface: "#2a1a2e", muted: "#6a5464", border: "#f0dccd",
      primary: "#b83d0a", onPrimary: "#ffffff", accent: "#6d28d9", danger: "#be123c", success: "#15703a", warning: "#9a4a00",
      bubbleIn: "#ffffff", onBubbleIn: "#2a1a2e", bubbleOut: "#6d28d9", onBubbleOut: "#ffffff",
    },
    dark: {
      background: "#1a1020", surface: "#221629", surfaceVariant: "#2e1f37", onSurface: "#f7eaf1", muted: "#b9a3b4", border: "#3d2a46",
      primary: "#fb923c", onPrimary: "#1a1020", accent: "#c4b5fd", danger: "#fb7f95", success: "#5fdc8c", warning: "#fbbf24",
      bubbleIn: "#2b1c33", onBubbleIn: "#f7eaf1", bubbleOut: "#6d28d9", onBubbleOut: "#ffffff",
    },
  },
  {
    id: "lavender", family: "studio", tones: ["light", "dark"], radius: 22,
    label: { cs: "Levandule", en: "Lavender", de: "Lavendel" },
    light: {
      background: "#f7f5fc", surface: "#ffffff", surfaceVariant: "#ece8f7", onSurface: "#211b34", muted: "#5d5673", border: "#dfd9ef",
      primary: "#6346bd", onPrimary: "#ffffff", accent: "#6346bd", danger: "#b9204a", success: "#1b6f46", warning: "#8f4f00",
      bubbleIn: "#ffffff", onBubbleIn: "#211b34", bubbleOut: "#6346bd", onBubbleOut: "#ffffff",
    },
    dark: {
      background: "#13101c", surface: "#1b1727", surfaceVariant: "#262135", onSurface: "#ece8f7", muted: "#a8a1c0", border: "#332d45",
      primary: "#b9a5f5", onPrimary: "#191230", accent: "#b9a5f5", danger: "#f590a6", success: "#82d6ab", warning: "#f2c26b",
      bubbleIn: "#241f33", onBubbleIn: "#ece8f7", bubbleOut: "#5b3fb0", onBubbleOut: "#ffffff",
    },
  },
  {
    id: "mocha", family: "studio", tones: ["light", "dark"], radius: 14, font: "serif",
    label: { cs: "Moka", en: "Mocha", de: "Mokka" },
    light: {
      background: "#f6f1eb", surface: "#fffdfa", surfaceVariant: "#eee4d9", onSurface: "#2a1e16", muted: "#685a50", border: "#e2d5c7",
      primary: "#77472a", onPrimary: "#ffffff", accent: "#77472a", danger: "#ad2a1f", success: "#2f6d2c", warning: "#8a5000",
      bubbleIn: "#fffdfa", onBubbleIn: "#2a1e16", bubbleOut: "#77472a", onBubbleOut: "#ffffff",
    },
    dark: {
      background: "#16110e", surface: "#1f1813", surfaceVariant: "#2a211a", onSurface: "#f1e7dd", muted: "#b6a698", border: "#3a2f26",
      primary: "#dcab7f", onPrimary: "#1f140c", accent: "#dcab7f", danger: "#f2a39b", success: "#9fcf92", warning: "#e9b961",
      bubbleIn: "#29201a", onBubbleIn: "#f1e7dd", bubbleOut: "#7f4d2d", onBubbleOut: "#ffffff",
    },
  },
  {
    id: "arctic", family: "studio", tones: ["light", "dark"], radius: 16,
    label: { cs: "Arktida", en: "Arctic", de: "Arktis" },
    light: {
      background: "#f1f6fa", surface: "#ffffff", surfaceVariant: "#e2edf5", onSurface: "#0e2132", muted: "#4f6475", border: "#d2e1ec",
      primary: "#0a609f", onPrimary: "#ffffff", accent: "#0a609f", danger: "#bd2129", success: "#0f6e43", warning: "#8a5000",
      bubbleIn: "#ffffff", onBubbleIn: "#0e2132", bubbleOut: "#0a609f", onBubbleOut: "#ffffff",
    },
    dark: {
      background: "#09121b", surface: "#0f1b26", surfaceVariant: "#172735", onSurface: "#e3f0fa", muted: "#93aabb", border: "#213446",
      primary: "#7cc4f2", onPrimary: "#06192a", accent: "#7cc4f2", danger: "#ff8f94", success: "#72d8a5", warning: "#f5c060",
      bubbleIn: "#152432", onBubbleIn: "#e3f0fa", bubbleOut: "#0d5a94", onBubbleOut: "#ffffff",
    },
  },
  {
    id: "ink", family: "studio", tones: ["light", "dark"], radius: 8,
    label: { cs: "Inkoust", en: "Ink", de: "Tinte" },
    light: {
      background: "#f4f4f4", surface: "#ffffff", surfaceVariant: "#eaeaea", onSurface: "#111111", muted: "#575757", border: "#d9d9d9",
      primary: "#1a1a1a", onPrimary: "#ffffff", accent: "#1a1a1a", danger: "#b42318", success: "#1a6636", warning: "#7f4c00",
      bubbleIn: "#ffffff", onBubbleIn: "#111111", bubbleOut: "#1a1a1a", onBubbleOut: "#ffffff",
    },
    dark: {
      background: "#0b0b0b", surface: "#141414", surfaceVariant: "#1f1f1f", onSurface: "#f0f0f0", muted: "#a6a6a6", border: "#2c2c2c",
      primary: "#efefef", onPrimary: "#111111", accent: "#efefef", danger: "#ff8a80", success: "#7bd88f", warning: "#ffcc66",
      bubbleIn: "#1d1d1d", onBubbleIn: "#f0f0f0", bubbleOut: "#e6e6e6", onBubbleOut: "#111111",
    },
  },
];

/** The colour variants' names the six templates add (Palette.java NAMED; "color.<id>" below). */
export const NEW_HUES_67 = ["moss", "lilac", "ice", "cocoa", "gold"] as const;

/* ================================================================ swipe */

const ELEMENTS: ElementDef[] = [
  { el: "swipe", label: "Swipe actions", group: "layout", container: true, text: false, props: [
    P("right", "text", "Dragged right: menu", { help: "the id of a menu (Menus) whose items show at the row's left edge when it is dragged to the right — e.g. room-swipe-right (Delete); empty = that way off" }),
    P("left", "text", "Dragged left: menu", { help: "the id of a menu whose items show at the row's right edge when it is dragged to the left — e.g. room-swipe-left (Clone, Edit); empty = that way off" }),
    P("rightColor", "color", "Dragged right: colour", { help: "the actions' colour (default @danger)" }),
    P("leftColor", "color", "Dragged left: colour", { help: "the actions' colour (default @primary)" }),
  ], help: "Wraps a list row: dragged sideways it slides away from the actions of a menu (icon and label; a tap runs one, the row springs back otherwise). A menu item's argument sees the row's variables ($room…); its condition hides it. TalkBack offers the same actions on the row." },
];

const ACTIONS: Array<{ action: string; arg: string; help: string }> = [
  { action: "room.delete", arg: "room key", help: "Asks first, then deletes a saved room from the list (and its history on this phone)" },
  { action: "room.clone", arg: "room key", help: "Saves a copy of a saved room under a new name (same passphrase and nickname; not connected)" },
  { action: "room.edit", arg: "room key", help: "The join form filled with a saved room (the room.edit sheet): its name, passphrase, nickname" },
];

const SCREENS: ScreenDef[] = [
  { id: "room.edit", label: "Rooms › edit", group: "app", vars: ["$form"], sample: { form: {} }, help: "A saved room changed (its row's swipe › Edit): the join form, filled — name, room, passphrase." },
];

const MENUS: Record<string, MenuItem[]> = {
  // swipe on a room's row (rooms.item): dragged to the right…
  "room-swipe-right": [
    { id: "delete", icon: "trash", label: "{_'swipe.delete'}", action: "room.delete", arg: "=$room.key" },
  ],
  // …and to the left
  "room-swipe-left": [
    { id: "clone", icon: "copy", label: "{_'swipe.clone'}", action: "room.clone", arg: "=$room.key" },
    { id: "edit", icon: "pencil", label: "{_'swipe.edit'}", action: "room.edit", arg: "=$room.key" },
  ],
};

/** A tinted tile around an icon (like the Tools dock's). */
const tile = (id: string, icon: string, size = 36): ANode => n(id, "column", { style: { width: size, height: size, radius: Math.round(size * 0.31), bg: "@surfaceVariant", align: "center", justify: "center" } }, [
  n(`${id}-i`, "icon", { props: { icon, size: Math.round(size * 0.55), color: "@primary" } }),
]);

const ROOM_EDIT: ANode = n("root", "column", { style: { padding: 24, gap: 12, bg: "@surface" } }, [
  n("head", "row", { style: { gap: 12, align: "center" } }, [
    tile("head-tile", "pencil"),
    n("title", "text", { text: "{_'room.edit.title'}", props: { variant: "title" }, style: { bold: true, weight: 1 } }),
  ]),
  n("hint", "text", { text: "{_'room.edit.hint'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
  n("form", "slot", { props: { name: "joinForm" } }),
]);

/* ============================================================== patches */

/** rooms.item in a swipe: right → Delete, left → Clone, Edit (twice is once). */
export function swipeRooms(screens: Record<string, ANode>): void {
  const item = screens["rooms.item"];
  if (!item || item.el === "swipe") return;
  screens["rooms.item"] = n("swipe", "swipe", { props: { right: "room-swipe-right", left: "room-swipe-left", rightColor: "@danger", leftColor: "@primary" } }, [item]);
}

/** The main settings' rows: their leading icon on a tinted tile (the menu reads at a glance). */
export function settingsTiles(screens: Record<string, ANode>): void {
  const walk = (node: ANode): void => {
    const kids = node.children ?? [];
    if (node.el === "row" && node.on?.click && kids[0]?.el === "icon" && kids[0].props?.color === "@muted") {
      const icon = kids[0];
      kids[0] = n(`${icon.id}-tile`, "column", { style: { width: 36, height: 36, radius: 11, bg: "@surfaceVariant", align: "center", justify: "center" } }, [
        { ...icon, props: { ...icon.props, size: 20, color: "@primary" } },
      ]);
      node.style = { ...node.style, gap: 16 };
      return;
    }
    kids.forEach(walk);
  };
  if (screens.settings) walk(screens.settings);
}

/** The buttons that had no icon. */
const BUTTON_ICONS: Record<string, Record<string, string>> = {
  update: { later: "clock" },
  "settings.appearance": { "pv-tonal": "clock" },
};

export function buttonIcons(screens: Record<string, ANode>): void {
  for (const [screen, byId] of Object.entries(BUTTON_ICONS)) {
    const walk = (node: ANode): void => {
      if (node.el === "button" && byId[node.id] && !node.props?.icon) node.props = { ...node.props, icon: byId[node.id] };
      (node.children ?? []).forEach(walk);
    };
    if (screens[screen]) walk(screens[screen]);
  }
}

/* =============================================================== strings */

const STRINGS: Record<"cs" | "en" | "de", Record<string, string>> = {
  cs: {
    "swipe.delete": "Smazat", "swipe.clone": "Klonovat", "swipe.edit": "Upravit",
    "room.delete.title": "Smazat místnost?", "room.delete.text": "Místnost „{name}“ zmizí ze seznamu a s ní i historie zpráv v tomto telefonu. Ostatních v místnosti se to netýká.",
    "room.delete.yes": "Smazat", "room.delete.no": "Zrušit", "room.deleted": "Místnost „{name}“ je smazaná.",
    "room.cloned": "Kopie je uložená jako „{name}“.",
    "room.edit.title": "Upravit místnost", "room.edit.hint": "Jiný název je jiná místnost; heslo musí mít všichni v místnosti stejné.", "room.edit.save": "Uložit změny", "room.edit.saved": "Změny jsou uložené.",
    "room.edit.missing": "Vyplňte název místnosti i heslo.",
    "color.moss": "Mechová", "color.lilac": "Šeříková", "color.ice": "Ledová", "color.cocoa": "Kakaová", "color.gold": "Zlatá",
  },
  en: {
    "swipe.delete": "Delete", "swipe.clone": "Clone", "swipe.edit": "Edit",
    "room.delete.title": "Delete the room?", "room.delete.text": "The room “{name}” leaves the list, and its message history on this phone goes with it. The others in the room are not affected.",
    "room.delete.yes": "Delete", "room.delete.no": "Cancel", "room.deleted": "The room “{name}” was deleted.",
    "room.cloned": "The copy is saved as “{name}”.",
    "room.edit.title": "Edit the room", "room.edit.hint": "A different name is a different room; everyone in it needs the same passphrase.", "room.edit.save": "Save changes", "room.edit.saved": "The changes are saved.",
    "room.edit.missing": "Fill in the room's name and its passphrase.",
    "color.moss": "Moss", "color.lilac": "Lilac", "color.ice": "Ice", "color.cocoa": "Cocoa", "color.gold": "Gold",
  },
  de: {
    "swipe.delete": "Löschen", "swipe.clone": "Klonen", "swipe.edit": "Bearbeiten",
    "room.delete.title": "Raum löschen?", "room.delete.text": "Der Raum „{name}“ verschwindet aus der Liste und mit ihm der Nachrichtenverlauf auf diesem Telefon. Die anderen im Raum betrifft das nicht.",
    "room.delete.yes": "Löschen", "room.delete.no": "Abbrechen", "room.deleted": "Der Raum „{name}“ wurde gelöscht.",
    "room.cloned": "Die Kopie ist als „{name}“ gespeichert.",
    "room.edit.title": "Raum bearbeiten", "room.edit.hint": "Ein anderer Name ist ein anderer Raum; alle darin brauchen dieselbe Passphrase.", "room.edit.save": "Änderungen speichern", "room.edit.saved": "Die Änderungen sind gespeichert.",
    "room.edit.missing": "Geben Sie den Namen des Raums und seine Passphrase ein.",
    "color.moss": "Moos", "color.lilac": "Flieder", "color.ice": "Eis", "color.cocoa": "Kakao", "color.gold": "Gold",
  },
};

export const AREA: DesignArea = {
  elements: ELEMENTS,
  actions: ACTIONS,
  screens: SCREENS,
  trees: { "room.edit": ROOM_EDIT },
  menus: MENUS,
  strings: STRINGS,
  patch(screens) {
    swipeRooms(screens);
    settingsTiles(screens);
    buttonIcons(screens);
  },
};

