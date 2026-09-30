// 6.2 — the look: templates with colour variants, fonts, animations, buttons; the Tools dock; the send button and the microphone.
// Merged into the default design by design-62.ts (this file adds to the
// catalog; a tree here replaces the one of the same id).
//
//   tools                the hammer's Tools: a compact floating dock above the
//                        composer (a "sheet" root: present / dismissOnAction)
//   settings.appearance  template, its colour variants, tone, font and size,
//                        animations, buttons, layout — with a live preview
//   flash                a calmer notice: the surface with the level's icon
//   patch62Look          flat top bars with a hairline, the room bar's avatar
//
// The look's settings (Android core/Settings.java): look.* apply in place —
// the screen is drawn again — like appearance.* set by these screens'
// controls or the look.set action (the setting.set action restarts the app).
// THEME_62_LOOK: calmer default tokens for design.ts's DEFAULT_THEME.

import type { ANode, ElementDef, MenuItem, PropDef, ScreenDef } from "./design";
import { SCREENS_61 } from "./design-61";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });
const P = (name: string, kind: PropDef["kind"], label: string, extra: Partial<PropDef> = {}): PropDef => ({ name, kind, label, ...extra });

export const ELEMENTS_62_LOOK: ElementDef[] = [
  { el: "sheet", label: "Sheet / dock", group: "layout", container: true, text: false, props: [
    P("present", "select", "Shown as", { options: ["sheet", "dock"], help: "sheet: from the bottom over the screen; dock: a small card floating above the composer, a tap outside closes it (an expression may choose)" }),
    P("dismissOnAction", "expr", "Close after an action", { help: "true: it fades away as soon as one of its elements runs an action" }),
  ], help: "The root of a sheet (sheet.open): shown from the bottom or as a floating dock; its children one under another." },
];
export const ACTIONS_62_LOOK: Array<{ action: string; arg: string; help: string }> = [
  { action: "look.set", arg: "key=value", help: "Change the look (appearance.* or look.*) in place — the screen is drawn again, the app does not restart" },
  { action: "look.reset", arg: "", help: "The design's own look again (template, colours, font, motion, buttons), in place" },
];
export const SLOTS_62_LOOK: Array<{ name: string; label: string; screens: string[] }> = [];
export const SCREENS_62_LOOK: ScreenDef[] = [];
export const MENUS_62_LOOK: Record<string, MenuItem[]> = {};

/* ============================================================== helpers */

const bar = (title: string): ANode => n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface" } }, [
  n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
  n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
]);

const section = (id: string, key: string): ANode => n(id, "text", { text: `{_'${key}'}`, props: { variant: "label" }, style: { fg: "@primary", padding: "20 20 6 20" } });

/** A label with an icon over a control. */
const labelled = (id: string, icon: string, label: string, control: ANode, cond?: string): ANode => n(id, "column", { ...(cond ? { if: cond } : {}), style: { padding: "6 20 8 20", gap: 8 } }, [
  n(`${id}-head`, "row", { style: { gap: 14, align: "center" } }, [
    n(`${id}-icon`, "icon", { props: { icon, size: 20, color: "@muted" } }),
    n(`${id}-label`, "text", { text: label, style: { size: 15.5, weight: 1 } }),
  ]),
  control,
]);

const seg = (id: string, setting: string, options: string): ANode => n(id, "segmented", { props: { setting, options } });

const toggleRow = (id: string, icon: string, label: string, setting: string, hint?: string): ANode => n(id, "column", {}, [
  n(`${id}-row`, "row", { style: { padding: "10 12 10 20", gap: 14, align: "center" } }, [
    n(`${id}-icon`, "icon", { props: { icon, size: 20, color: "@muted" } }),
    n(`${id}-label`, "text", { text: label, style: { size: 15.5, weight: 1 } }),
    n(`${id}-switch`, "switch", { props: { setting } }),
  ]),
  ...(hint ? [n(`${id}-hint`, "text", { text: `{_'${hint}'}`, props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 54" } })] : []),
]);

/** A choice as chips (wrapping); each chip may style itself (a font chip in its font). */
const chips = (id: string, setting: string, options: Array<{ v: string | number; key: string; style?: Record<string, string | number | boolean>; selected?: string }>): ANode =>
  n(id, "row", { props: { wrap: true }, style: { gap: 8 } }, options.map((o) => n(`${id}-${String(o.v || "own").replace(/[^a-z0-9]+/gi, "-")}`, "chip", {
    text: `{_'${o.key}'}`,
    props: { selected: o.selected ?? (typeof o.v === "number" ? `=$settings.${setting} == ${o.v}` : `=$settings.${setting} == '${o.v}'`) },
    ...(o.style ? { style: o.style } : {}),
    on: click("look.set", `${setting}=${o.v}`),
  })));

/* ================================================================ tools */

/** A tool of the dock: a small tinted icon tile over a one-word label. */
const tool = (id: string, icon: string, label: string, action: string, arg?: string, cond?: string): ANode => n(id, "column", {
  ...(cond ? { if: cond } : {}), style: { width: 76, align: "center", gap: 5, padding: "8 2 6 2", radius: 14 }, on: click(action, arg),
}, [
  n(`${id}-tile`, "column", { style: { bg: "@surfaceVariant", radius: 14, padding: 10, align: "center" } }, [n(`${id}-i`, "icon", { props: { icon, size: 22, color: "@primary" } })]),
  n(`${id}-label`, "text", { text: label, props: { variant: "caption", align: "center" }, style: { lines: 1, size: 11.5 } }),
]);

const TOOLS: ANode = n("root", "sheet", {
  props: { present: "=$settings.look.toolsDock ? 'dock' : 'sheet'", dismissOnAction: true },
  style: { bg: "@surface", radius: 22, padding: "8 6 8 6" },
}, [
  n("tiles", "row", { props: { wrap: true }, style: { gap: 4, justify: "center" } }, [
    tool("ai", "bot", "{_'tools.s.ai'}", "screen.open", "ai"),
    tool("voice", "audio-lines", "{_'tools.s.voice'}", "screen.open", "voice"),
    tool("nfc", "nfc", "{_'tools.nfc'}", "screen.open", "nfc", "$tools.nfc"),
    tool("look", "palette", "{_'tools.s.look'}", "screen.open", "settings.appearance"),
    tool("pos", "map-pin", "{_'tools.s.position'}", "compose", "location"),
    tool("dict", "speech", "{_'tools.s.dictate'}", "compose", "dictate"),
    tool("user", "user-round", "{_'tools.s.account'}", "screen.open", "settings.user"),
    tool("settings", "settings", "{_'tools.s.settings'}", "screen.open", "settings"),
  ]),
]);

/* ================================================== settings.appearance */

/** The live preview: a mini chat and the buttons, in the look as it is now. */
const PREVIEW: ANode = n("preview", "card", { style: { margin: "12 16 4 16", padding: 0, gap: 0 } }, [
  n("pv-chat", "column", { style: { bg: "@background", padding: "12 12 10 12", gap: 6 } }, [
    n("pv-in", "row", { style: { gap: 8, align: "end" } }, [
      n("pv-avatar", "avatar", { props: { name: "Jana Nováková", size: 26 } }),
      n("pv-in-bubble", "column", { style: { bg: "@bubbleIn", fg: "@onBubbleIn", radius: 16, padding: "7 11", gap: 1, maxWidth: 250, elevation: 1 } }, [
        n("pv-in-name", "text", { text: "Jana", props: { variant: "label" }, style: { fg: "@primary", size: 12.5 } }),
        n("pv-in-text", "text", { text: "{_'look.preview.in'}" }),
      ]),
    ]),
    n("pv-out", "row", { style: { justify: "end" } }, [
      n("pv-out-bubble", "column", { style: { bg: "@bubbleOut", fg: "@onBubbleOut", radius: 16, padding: "7 11", gap: 1, maxWidth: 250, elevation: 1 } }, [
        n("pv-out-text", "text", { text: "{_'look.preview.out'}" }),
        n("pv-out-meta", "row", { style: { gap: 3, align: "center", self: "end", opacity: 0.85 } }, [
          n("pv-out-time", "text", { text: "12:34", props: { variant: "caption" } }),
          n("pv-out-state", "icon", { props: { icon: "check-check", size: 13, color: "@onBubbleOut" } }),
        ]),
      ]),
    ]),
  ]),
  n("pv-line", "divider", { style: { bg: "@border", opacity: 0.6 } }),
  n("pv-buttons", "row", { props: { wrap: true }, style: { gap: 8, padding: 12, align: "center" } }, [
    n("pv-primary", "button", { text: "{_'look.preview.send'}", props: { icon: "send-horizontal", variant: "primary" }, on: click("flash", "{_'look.preview.pressed'}") }),
    n("pv-tonal", "button", { text: "{_'look.preview.later'}", props: { variant: "tonal" }, on: click("flash", "{_'look.preview.pressed'}") }),
    n("pv-chip", "chip", { text: "{_'look.preview.chip'}", props: { icon: "sparkles", selected: true }, on: click("flash", "{_'look.preview.pressed'}") }),
    n("pv-icon", "iconButton", { props: { icon: "heart", variant: "primary", label: "{_'look.preview.chip'}" }, on: click("flash", "{_'look.preview.pressed'}") }),
  ]),
]);

/** A template's card: its background with a surface bubble, a primary bubble and dot; its name under it. */
const TEMPLATES: ANode = n("templates", "scroll", { props: { horizontal: true } }, [
  n("tpl-row", "row", { style: { gap: 10, padding: "4 16 4 16", align: "start" } }, [
    n("tpl", "column", { each: "$presets", as: "p", style: { width: 88, gap: 6, align: "center" }, on: click("look.set", "appearance.preset={$p.value}") }, [
      n("tpl-card", "column", { style: { width: 88, height: 62, bg: "=$p.bg", radius: 14, padding: "8 8 8 8", gap: 5, border: "=$p.selected ? '2.5 @primary' : '1 @border'" } }, [
        n("tpl-head", "row", { style: { gap: 5, align: "center" } }, [
          n("tpl-dot", "divider", { style: { width: 9, height: 9, radius: 5, bg: "=$p.primary" } }),
          n("tpl-title", "divider", { style: { width: 30, height: 5, radius: 3, bg: "=$p.fg", opacity: 0.35 } }),
        ]),
        n("tpl-in", "divider", { style: { width: 38, height: 11, radius: 6, bg: "=$p.surface" } }),
        n("tpl-out", "divider", { style: { width: 44, height: 11, radius: 6, bg: "=$p.primary", self: "end" } }),
      ]),
      n("tpl-label", "text", { text: "{$p.label}", props: { variant: "caption", align: "center" }, style: { lines: 1, fg: "=$p.selected ? '@primary' : '@onSurface'" } }),
    ]),
  ]),
]);

/** The chosen template's colours: its own first, then the variants that suit it. */
const VARIANTS: ANode = n("variants", "column", { each: "$presets", as: "p", if: "$p.selected", style: { padding: "4 20 4 20", gap: 6 } }, [
  n("swatches", "row", { props: { wrap: true }, style: { gap: 10 } }, [
    n("sw", "column", {
      each: "$p.variants", as: "v",
      style: { width: 40, height: 40, radius: 20, bg: "=$v.color", border: "=$v.selected ? '3 @onSurface' : '1 @border'", align: "center", justify: "center" },
      on: click("look.set", "look.variant={$v.value}"),
    }, [n("sw-on", "icon", { if: "$v.selected", props: { icon: "check", size: 18, color: "=$v.on" } })]),
  ]),
  n("variants-of", "text", { text: "{_'look.variantsOf'} {$p.label}", props: { variant: "caption" }, style: { fg: "@muted" } }),
]);

const TONE: ANode = n("tone", "column", { each: "$presets", as: "p", if: "$p.selected", style: { padding: "4 20 8 20" } }, [
  seg("tone-seg", "appearance.tone", "system:{_'set.appearance.system'}|light:{_'set.appearance.light'}|dark:{_'set.appearance.dark'}"),
  n("tone-fixed", "text", { if: "$p.tone != 'both'", text: "{=$p.tone == 'dark' ? _('look.tone.onlyDark') : _('look.tone.onlyLight')}", props: { variant: "caption" }, style: { fg: "@muted", padding: "6 0 0 0" } }),
]);

const FONTS = [
  { v: "", key: "look.font.own" }, { v: "sans", key: "look.font.sans", style: { font: "sans" } }, { v: "serif", key: "look.font.serif", style: { font: "serif" } },
  { v: "mono", key: "look.font.mono", style: { font: "mono" } }, { v: "condensed", key: "look.font.condensed", style: { font: "condensed" } },
  { v: "medium", key: "look.font.medium", style: { font: "medium" } }, { v: "light", key: "look.font.light", style: { font: "light" } },
  { v: "casual", key: "look.font.casual", style: { font: "casual" } }, { v: "cursive", key: "look.font.cursive", style: { font: "cursive" } },
];

const SIZES = [
  { v: 0.85, key: "look.size.s", style: { size: 12.5 }, selected: "=$settings.appearance.fontScale < 0.93" },
  { v: 1, key: "look.size.m", style: { size: 14 }, selected: "=$settings.appearance.fontScale >= 0.93 && $settings.appearance.fontScale < 1.07" },
  { v: 1.15, key: "look.size.l", style: { size: 15.5 }, selected: "=$settings.appearance.fontScale >= 1.07 && $settings.appearance.fontScale < 1.22" },
  { v: 1.3, key: "look.size.xl", style: { size: 17 }, selected: "=$settings.appearance.fontScale >= 1.22 && $settings.appearance.fontScale < 1.4" },
  { v: 1.5, key: "look.size.xxl", style: { size: 18.5 }, selected: "=$settings.appearance.fontScale >= 1.4" },
];

const APPEARANCE: ANode = n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
  bar("{_'set.appearance'}"),
  n("bar-line", "divider", { style: { bg: "@border", opacity: 0.7 } }),
  n("scroll", "scroll", { style: { weight: 1 } }, [n("list", "column", { style: { padding: "0 0 28 0" } }, [
    PREVIEW,
    section("s-template", "set.appearance.preset"),
    TEMPLATES,
    section("s-colour", "set.appearance.accent"),
    VARIANTS,
    n("custom", "row", { if: "$settings.appearance.accent", style: { padding: "2 20 4 20", gap: 10, align: "center" } }, [
      n("custom-dot", "divider", { style: { width: 14, height: 14, radius: 7, bg: "@primary" } }),
      n("custom-text", "text", { text: "{_'look.accent.custom'}", props: { variant: "caption" }, style: { fg: "@muted", weight: 1 } }),
      n("custom-clear", "chip", { text: "{_'look.accent.clear'}", props: { icon: "x" }, on: click("look.set", "appearance.accent=") }),
    ]),
    section("s-tone", "set.appearance.tone"),
    TONE,
    section("s-type", "look.type"),
    labelled("font", "type", "{_'look.font'}", chips("font-chips", "look.font", FONTS)),
    labelled("size", "a-large-small", "{_'set.appearance.fontScale'}", chips("size-chips", "appearance.fontScale", SIZES)),
    section("s-motion", "look.motion"),
    labelled("motion", "wand-sparkles", "{_'look.motion.level'}", seg("motion-seg", "look.motion", "off:{_'look.motion.off'}|subtle:{_'look.motion.subtle'}|normal:{_'look.motion.normal'}|lively:{_'look.motion.lively'}")),
    labelled("speed", "gauge", "{_'look.speed'} · {$settings.look.speed}×", n("speed-slider", "slider", { props: { setting: "look.speed", min: 0.5, max: 2, step: 0.25 } }), "$settings.look.motion != 'off'"),
    section("s-buttons", "look.buttons"),
    labelled("bstyle", "mouse-pointer-click", "{_'look.buttons.style'}", seg("bstyle-seg", "look.buttons", "filled:{_'look.buttons.filled'}|tonal:{_'look.buttons.tonal'}|outlined:{_'look.buttons.outlined'}|text:{_'look.buttons.text'}")),
    labelled("shape", "square-round-corner", "{_'look.shape'}", seg("shape-seg", "look.shape", "pill:{_'look.shape.pill'}|rounded:{_'look.shape.rounded'}|square:{_'look.shape.square'}")),
    labelled("press", "hand", "{_'look.press'}", seg("press-seg", "look.press", "ripple:{_'look.press.ripple'}|scale:{_'look.press.scale'}|none:{_'look.press.none'}")),
    toggleRow("haptics", "vibrate", "{_'look.haptics'}", "look.haptics", "look.hapticsHint"),
    section("s-layout", "look.layout"),
    labelled("density", "rows-2", "{_'set.appearance.density'}", seg("density-seg", "appearance.density", "compact:{_'set.appearance.compact'}|normal:{_'set.appearance.normal'}|comfortable:{_'set.appearance.comfortable'}")),
    labelled("bubbles", "message-circle", "{_'set.appearance.bubbles'}", seg("bubbles-seg", "appearance.bubbles", "rounded:{_'set.appearance.rounded'}|square:{_'set.appearance.square'}|minimal:{_'set.appearance.minimal'}")),
    toggleRow("dock", "panel-bottom", "{_'look.toolsDock'}", "look.toolsDock", "look.toolsDockHint"),
    n("reset", "row", { style: { padding: "18 20 8 20", gap: 14, align: "center" }, on: click("look.reset") }, [
      n("reset-icon", "icon", { props: { icon: "rotate-ccw", size: 20, color: "@muted" } }),
      n("reset-label", "text", { text: "{_'set.appearance.reset'}", style: { size: 15.5, weight: 1 } }),
    ]),
  ])]),
]);

/* ================================================================ flash */

/** A calmer notice: the surface, the level's coloured icon, a coloured edge for errors and warnings. */
const FLASH: ANode = n("box", "row", {
  style: {
    bg: "@surface", fg: "@onSurface", radius: 16, padding: "12 16 12 14", gap: 12, align: "center", elevation: 8, margin: "8 12",
    border: "=$flash.level == 'error' ? '1.5 @danger' : ($flash.level == 'warn' ? '1.5 @warning' : '1 @border')",
  },
  anim: { enter: { type: "slide-down", ms: 220, easing: "decelerate" } },
}, [
  n("icon", "icon", { props: {
    icon: "=$flash.level == 'error' ? 'circle-alert' : ($flash.level == 'success' ? 'circle-check' : ($flash.level == 'warn' ? 'triangle-alert' : 'info'))",
    color: "=$flash.level == 'error' ? '@danger' : ($flash.level == 'success' ? '@success' : ($flash.level == 'warn' ? '@warning' : '@primary'))",
    size: 22,
  } }),
  n("col", "column", { style: { weight: 1 } }, [
    n("title", "text", { if: "$flash.title", text: "{$flash.title}", style: { bold: true } }),
    n("text", "text", { text: "{$flash.text}" }),
  ]),
]);

export const SCREENS_TREES_62_LOOK: Record<string, ANode> = {
  tools: TOOLS,
  "settings.appearance": APPEARANCE,
  flash: FLASH,
};

/* ================================================================ theme */

/**
 * Calmer default tokens (softer neutrals, quieter borders, a slightly
 * larger radius). design.ts's DEFAULT_THEME is not this module's to change:
 * the integrator merges these into it (Object.assign per tone).
 */
export const THEME_62_LOOK = {
  light: { background: "#f6f7f9", surfaceVariant: "#eef0f4", border: "#e2e5eb", muted: "#667085", onSurface: "#1b2230" },
  dark: { background: "#0f1217", surface: "#161a21", surfaceVariant: "#1f252e", border: "#29303b", muted: "#8d96a3" },
  radius: 16,
};

/* ============================================================== patches */

const hairline = (id: string): ANode => n(id, "divider", { style: { bg: "@border", opacity: 0.7 } });

/** A top bar rests flat on the screen with a hairline under it (no shadow). */
function calmBar(tree: ANode): void {
  const kids = tree.children;
  if (tree.el !== "column" || !kids) return;
  const i = kids.findIndex((c) => c.id === "bar" && c.el === "row");
  if (i < 0) return;
  const bar = kids[i];
  if (bar.style?.elevation === undefined) return;
  bar.style = { ...bar.style, elevation: 0 };
  if (!kids.some((c) => c.id === "bar-line")) kids.splice(i + 1, 0, hairline("bar-line"));
}

/** The room's bar: the room's avatar by its name; the video call moves to the call's long press and the room menu. */
function roomBar(room: ANode): void {
  const bar = room.children?.find((c) => c.id === "bar");
  if (!bar?.children) return;
  bar.style = { ...bar.style, padding: "6 4 6 4", gap: 0 };
  bar.children = bar.children.filter((c) => c.id !== "video");
  const back = bar.children.findIndex((c) => c.id === "back");
  if (!bar.children.some((c) => c.id === "avatar")) bar.children.splice(back + 1, 0, n("avatar", "avatar", { props: { name: "{$room.name}", size: 34 }, style: { margin: "0 4 0 0" } }));
  const head = bar.children.find((c) => c.id === "head");
  if (head) head.style = { ...head.style, padding: "0 6 0 6" };
  const name = head?.children?.find((c) => c.id === "name");
  if (name) name.style = { ...name.style, size: 17 };
}

/** Changes to existing trees (after every 6.1 and 6.2 tree is in place). */
export function patch62Look(screens: Record<string, ANode>): void {
  if (screens.room) roomBar(screens.room);
  for (const tree of Object.values(screens)) calmBar(tree);
  // The console's sample data for the new Appearance screen (its variables are richer now).
  const def = SCREENS_61.find((s) => s.id === "settings.appearance");
  if (def) {
    const sample = def.sample as { settings?: Record<string, unknown>; presets?: unknown };
    if (sample.settings) sample.settings.look = LOOK_SAMPLE;
    sample.presets = PRESETS_SAMPLE;
    def.help = "Template and its colours, tone, font and size, animations, buttons, layout — with a live preview.";
  }
}

const LOOK_SAMPLE = { variant: "", font: "", motion: "normal", speed: 1, buttons: "filled", shape: "pill", press: "ripple", haptics: true, toolsDock: true, hintSendOptions: false, v: 1 };
const swatch = (value: string, label: string, color: string, selected = false) => ({ value, label, color, on: "#ffffff", selected });
const PRESETS_SAMPLE = [
  { value: "design", label: "M5cet", family: "design", selected: true, tone: "both", bg: "#f5f6f8", surface: "#ffffff", fg: "#1c2330", primary: "#e11d48", onPrimary: "#ffffff",
    variants: [swatch("", "Barva šablony", "#e11d48", true), swatch("red", "Červená", "#c41c2c"), swatch("orange", "Oranžová", "#b24a09"), swatch("green", "Zelená", "#1b7a48"), swatch("blue", "Modrá", "#1560c9"), swatch("violet", "Fialová", "#7045e0"), swatch("teal", "Tyrkysová", "#127a70"), swatch("pink", "Růžová", "#c0195b")] },
  { value: "ios", label: "iOS 27", family: "system", selected: false, tone: "both", bg: "#f2f2f7", surface: "#ffffff", fg: "#000000", primary: "#007bff", onPrimary: "#ffffff", variants: [] },
  { value: "midnight", label: "Midnight", family: "classic", selected: false, tone: "dark", bg: "#0b0d19", surface: "#111322", fg: "#e4e8f7", primary: "#8266f5", onPrimary: "#ffffff", variants: [] },
  { value: "paper", label: "Paper", family: "classic", selected: false, tone: "light", bg: "#f8f6f1", surface: "#fdfdfb", fg: "#2c231b", primary: "#b84c1e", onPrimary: "#ffffff", variants: [] },
];

/* =============================================================== strings */

export const STRINGS_62_LOOK: Record<"cs" | "en" | "de", Record<string, string>> = {
  cs: {
    "tools.s.ai": "AI", "tools.s.voice": "Hlas", "tools.s.look": "Vzhled", "tools.s.position": "Poloha", "tools.s.dictate": "Diktát", "tools.s.account": "Účet", "tools.s.settings": "Nastavení",
    "set.appearance.sub": "Šablona, barvy, písmo, animace, tlačítka",
    "look.variant.own": "Barva šablony", "look.variantsOf": "Barvy, které se hodí k šabloně", "look.accent.custom": "Platí vlastní barva z dřívějška.", "look.accent.clear": "Zrušit",
    "look.tone.onlyDark": "Tato šablona je jen tmavá.", "look.tone.onlyLight": "Tato šablona je jen světlá.",
    "look.type": "Písmo a text", "look.font": "Písmo", "look.font.own": "Podle šablony", "look.font.sans": "Bezpatkové", "look.font.serif": "Patkové", "look.font.mono": "Strojové", "look.font.condensed": "Úzké", "look.font.medium": "Výrazné", "look.font.light": "Tenké", "look.font.casual": "Hravé", "look.font.cursive": "Psací",
    "look.size.s": "Malé", "look.size.m": "Běžné", "look.size.l": "Větší", "look.size.xl": "Velké", "look.size.xxl": "Největší",
    "look.motion": "Animace", "look.motion.level": "Pohyb", "look.motion.off": "Vypnuté", "look.motion.subtle": "Jemné", "look.motion.normal": "Běžné", "look.motion.lively": "Živé", "look.speed": "Rychlost",
    "look.buttons": "Tlačítka", "look.buttons.style": "Styl", "look.buttons.filled": "Plná", "look.buttons.tonal": "Tónovaná", "look.buttons.outlined": "Obrysová", "look.buttons.text": "Textová",
    "look.shape": "Tvar", "look.shape.pill": "Oblá", "look.shape.rounded": "Zaoblená", "look.shape.square": "Hranatá",
    "look.press": "Odezva na stisk", "look.press.ripple": "Vlnka", "look.press.scale": "Zmáčknutí", "look.press.none": "Žádná",
    "look.haptics": "Jemné cvaknutí při stisku", "look.hapticsHint": "Krátká vibrace; řídí se i nastavením dotykové odezvy v telefonu.",
    "look.layout": "Rozvržení", "look.toolsDock": "Nástroje jako plovoucí panel", "look.toolsDockHint": "Kladívko otevře malý panel nad polem pro psaní a po výběru nástroje zmizí. Vypnuto: nabídka zespodu přes celou šířku.",
    "look.preview.in": "Ahoj, jak se ti líbí nový vzhled?", "look.preview.out": "Moc! Je klidnější a přehlednější.", "look.preview.send": "Odeslat", "look.preview.later": "Později", "look.preview.chip": "Oblíbené", "look.preview.pressed": "Takhle tlačítko odpovídá na stisk.",
    "look.send.everyone": "Odeslat všem v místnosti", "look.send.only": "Odeslat jen:", "look.send.hold": "podržením další volby", "look.send.hint": "Podržením zobrazíte další volby",
    "look.mic.record": "Nahrát hlasovou zprávu", "look.mic.stop": "Zastavit a odeslat", "look.mic.cancel": "Zahodit nahrávku", "look.mic.none": "Telefon nemá mikrofon.", "look.mic.denied": "Bez přístupu k mikrofonu nelze nahrávat.",
    "look.mic.blocked": "Mikrofon je pro aplikaci zakázaný — povolte ho v nastavení telefonu (Aplikace › M5cet › Oprávnění).", "look.mic.busy": "Mikrofon se nepodařilo zapnout — nepoužívá ho právě hovor nebo jiná aplikace?", "look.mic.short": "Nahrávka byla příliš krátká.",
    "look.dictate.none": "Převod řeči na text není v telefonu k dispozici.",
    "color.coral": "Korálová", "color.amber": "Jantarová", "color.yellow": "Žlutá", "color.lime": "Limetková", "color.emerald": "Smaragdová", "color.mint": "Mátová", "color.teal": "Tyrkysová", "color.cyan": "Azurová", "color.sky": "Nebeská",
    "color.indigo": "Indigová", "color.purple": "Purpurová", "color.magenta": "Fuchsiová", "color.pink": "Růžová", "color.rose": "Malinová", "color.brown": "Hnědá", "color.slate": "Břidlicová",
    "color.frost": "Mrazivá", "color.steel": "Ocelová", "color.sage": "Šalvějová", "color.sand": "Písková", "color.clay": "Terakotová", "color.plum": "Švestková",
  },
  en: {
    "tools.s.ai": "AI", "tools.s.voice": "Voice", "tools.s.look": "Look", "tools.s.position": "Position", "tools.s.dictate": "Dictate", "tools.s.account": "Account", "tools.s.settings": "Settings",
    "set.appearance.sub": "Template, colours, font, animations, buttons",
    "look.variant.own": "The template's colour", "look.variantsOf": "Colours that suit the template", "look.accent.custom": "An own colour from before applies.", "look.accent.clear": "Remove",
    "look.tone.onlyDark": "This template is dark only.", "look.tone.onlyLight": "This template is light only.",
    "look.type": "Font and text", "look.font": "Font", "look.font.own": "The template's", "look.font.sans": "Sans serif", "look.font.serif": "Serif", "look.font.mono": "Monospace", "look.font.condensed": "Condensed", "look.font.medium": "Strong", "look.font.light": "Thin", "look.font.casual": "Casual", "look.font.cursive": "Handwritten",
    "look.size.s": "Small", "look.size.m": "Normal", "look.size.l": "Larger", "look.size.xl": "Large", "look.size.xxl": "Largest",
    "look.motion": "Animations", "look.motion.level": "Motion", "look.motion.off": "Off", "look.motion.subtle": "Subtle", "look.motion.normal": "Normal", "look.motion.lively": "Lively", "look.speed": "Speed",
    "look.buttons": "Buttons", "look.buttons.style": "Style", "look.buttons.filled": "Filled", "look.buttons.tonal": "Tonal", "look.buttons.outlined": "Outlined", "look.buttons.text": "Text",
    "look.shape": "Shape", "look.shape.pill": "Pill", "look.shape.rounded": "Rounded", "look.shape.square": "Square",
    "look.press": "Press response", "look.press.ripple": "Ripple", "look.press.scale": "Press in", "look.press.none": "None",
    "look.haptics": "A soft tick on press", "look.hapticsHint": "A short vibration; the phone's touch feedback setting applies too.",
    "look.layout": "Layout", "look.toolsDock": "Tools as a floating dock", "look.toolsDockHint": "The hammer opens a small panel above the message field that disappears once you pick a tool. Off: a full-width sheet from the bottom.",
    "look.preview.in": "Hi, how do you like the new look?", "look.preview.out": "A lot! Calmer and clearer.", "look.preview.send": "Send", "look.preview.later": "Later", "look.preview.chip": "Favourite", "look.preview.pressed": "This is how a button answers a press.",
    "look.send.everyone": "Send to everyone in the room", "look.send.only": "Send only to:", "look.send.hold": "hold for more options", "look.send.hint": "Hold for more options",
    "look.mic.record": "Record a voice message", "look.mic.stop": "Stop and send", "look.mic.cancel": "Discard the recording", "look.mic.none": "This phone has no microphone.", "look.mic.denied": "Recording needs access to the microphone.",
    "look.mic.blocked": "The microphone is blocked for the app — allow it in the phone's settings (Apps › M5cet › Permissions).", "look.mic.busy": "The microphone could not start — is a call or another app using it?", "look.mic.short": "The recording was too short.",
    "look.dictate.none": "Speech to text is not available on this phone.",
    "color.coral": "Coral", "color.amber": "Amber", "color.yellow": "Yellow", "color.lime": "Lime", "color.emerald": "Emerald", "color.mint": "Mint", "color.teal": "Teal", "color.cyan": "Cyan", "color.sky": "Sky",
    "color.indigo": "Indigo", "color.purple": "Purple", "color.magenta": "Magenta", "color.pink": "Pink", "color.rose": "Rose", "color.brown": "Brown", "color.slate": "Slate",
    "color.frost": "Frost", "color.steel": "Steel", "color.sage": "Sage", "color.sand": "Sand", "color.clay": "Terracotta", "color.plum": "Plum",
  },
  de: {
    "tools.s.ai": "KI", "tools.s.voice": "Sprache", "tools.s.look": "Aussehen", "tools.s.position": "Standort", "tools.s.dictate": "Diktat", "tools.s.account": "Konto", "tools.s.settings": "Einstellungen",
    "set.appearance.sub": "Vorlage, Farben, Schrift, Animationen, Tasten",
    "look.variant.own": "Farbe der Vorlage", "look.variantsOf": "Farben, die zur Vorlage passen", "look.accent.custom": "Eine eigene Farbe von früher gilt.", "look.accent.clear": "Entfernen",
    "look.tone.onlyDark": "Diese Vorlage ist nur dunkel.", "look.tone.onlyLight": "Diese Vorlage ist nur hell.",
    "look.type": "Schrift und Text", "look.font": "Schrift", "look.font.own": "Wie die Vorlage", "look.font.sans": "Serifenlos", "look.font.serif": "Mit Serifen", "look.font.mono": "Festbreite", "look.font.condensed": "Schmal", "look.font.medium": "Kräftig", "look.font.light": "Dünn", "look.font.casual": "Verspielt", "look.font.cursive": "Handschrift",
    "look.size.s": "Klein", "look.size.m": "Normal", "look.size.l": "Größer", "look.size.xl": "Groß", "look.size.xxl": "Am größten",
    "look.motion": "Animationen", "look.motion.level": "Bewegung", "look.motion.off": "Aus", "look.motion.subtle": "Dezent", "look.motion.normal": "Normal", "look.motion.lively": "Lebhaft", "look.speed": "Tempo",
    "look.buttons": "Tasten", "look.buttons.style": "Stil", "look.buttons.filled": "Gefüllt", "look.buttons.tonal": "Getönt", "look.buttons.outlined": "Umrandet", "look.buttons.text": "Text",
    "look.shape": "Form", "look.shape.pill": "Pille", "look.shape.rounded": "Abgerundet", "look.shape.square": "Eckig",
    "look.press": "Reaktion auf Druck", "look.press.ripple": "Welle", "look.press.scale": "Eindrücken", "look.press.none": "Keine",
    "look.haptics": "Leichtes Klicken beim Drücken", "look.hapticsHint": "Eine kurze Vibration; die Einstellung für haptisches Feedback des Telefons gilt auch.",
    "look.layout": "Anordnung", "look.toolsDock": "Werkzeuge als schwebende Leiste", "look.toolsDockHint": "Der Hammer öffnet eine kleine Leiste über dem Eingabefeld, die nach der Wahl eines Werkzeugs verschwindet. Aus: ein Blatt von unten über die ganze Breite.",
    "look.preview.in": "Hallo, wie gefällt dir das neue Aussehen?", "look.preview.out": "Sehr! Ruhiger und übersichtlicher.", "look.preview.send": "Senden", "look.preview.later": "Später", "look.preview.chip": "Favorit", "look.preview.pressed": "So reagiert eine Taste auf Druck.",
    "look.send.everyone": "An alle im Raum senden", "look.send.only": "Nur senden an:", "look.send.hold": "gedrückt halten für mehr", "look.send.hint": "Gedrückt halten für weitere Optionen",
    "look.mic.record": "Sprachnachricht aufnehmen", "look.mic.stop": "Stoppen und senden", "look.mic.cancel": "Aufnahme verwerfen", "look.mic.none": "Dieses Telefon hat kein Mikrofon.", "look.mic.denied": "Zum Aufnehmen braucht die App das Mikrofon.",
    "look.mic.blocked": "Das Mikrofon ist für die App gesperrt — erlauben Sie es in den Einstellungen des Telefons (Apps › M5cet › Berechtigungen).", "look.mic.busy": "Das Mikrofon ließ sich nicht einschalten — nutzt es gerade ein Anruf oder eine andere App?", "look.mic.short": "Die Aufnahme war zu kurz.",
    "look.dictate.none": "Spracheingabe ist auf diesem Telefon nicht verfügbar.",
    "color.coral": "Koralle", "color.amber": "Bernstein", "color.yellow": "Gelb", "color.lime": "Limette", "color.emerald": "Smaragd", "color.mint": "Minze", "color.teal": "Blaugrün", "color.cyan": "Cyan", "color.sky": "Himmelblau",
    "color.indigo": "Indigo", "color.purple": "Purpur", "color.magenta": "Magenta", "color.pink": "Rosa", "color.rose": "Himbeere", "color.brown": "Braun", "color.slate": "Schiefer",
    "color.frost": "Frost", "color.steel": "Stahl", "color.sage": "Salbei", "color.sand": "Sand", "color.clay": "Terrakotta", "color.plum": "Pflaume",
  },
};
