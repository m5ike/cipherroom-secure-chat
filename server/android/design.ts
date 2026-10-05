// The Android design (6.0): what a build carries to the devices — the
// screens (element trees the app renders natively), the theme, the
// animations, the texts in every language, the menus, the action libraries
// and small assets. The operator edits it in the console (Android › Design),
// a build freezes it into a signed, encrypted bundle.
//
// DEFAULT_DESIGN is also what the app shows before its first bundle: the
// build copies it to android/app/src/main/assets/m5/default-design.json
// (script/android-assets.ts), so the two never drift apart.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { MENU_ICONS } from "../../client/src/lib/menu-icons-data";
import { checkExpr, checkTemplate } from "./expr";
import { ACTIONS_61, ELEMENTS_61, MENUS_61, SCREENS_61, SCREENS_TREES_61, SLOTS_61, STRINGS_61, TOGGLE_PROPS_61, messageIn61, messageOut61, roomBar61 } from "./design-61";
import { ACTIONS_62, ELEMENTS_62, MENUS_62, SCREENS_62, SCREENS_TREES_62, SLOTS_62, STRINGS_62, THEME_62, patch62 } from "./design-62";
import { ACTIONS_63, ELEMENTS_63, MENUS_63, SCREENS_63, SCREENS_TREES_63, SLOTS_63, STRINGS_63, patch63 } from "./design-63";
import { ACTIONS_64, ELEMENTS_64, MENUS_64, SCREENS_64, SCREENS_TREES_64, SLOTS_64, STRINGS_64, patch64, patchMenus64 } from "./design-64";
import { ACTIONS_67, ELEMENTS_67, MENUS_67, SCREENS_67, SCREENS_TREES_67, SLOTS_67, STRINGS_67, patch67, patchMenus67 } from "./design-67";
import { ACTIONS_68, ELEMENTS_68, MENUS_68, SCREENS_68, SCREENS_TREES_68, SLOTS_68, STRINGS_68, patch68, patchMenus68 } from "./design-68";
import { ACTIONS_610, ELEMENTS_610, MENUS_610, SCREENS_610, SCREENS_TREES_610, SLOTS_610, STRINGS_610, patch610, patchMenus610 } from "./design-610";
import { ACTIONS_611, ELEMENTS_611, MENUS_611, SCREENS_611, SCREENS_TREES_611, SLOTS_611, STRINGS_611, patch611, patchMenus611 } from "./design-611";
import { androidDir } from "./store";

/* ================================================================ catalog */

export type PropKind = "text" | "expr" | "number" | "bool" | "icon" | "select" | "color" | "slot" | "image";
export type PropDef = { name: string; kind: PropKind; label: string; options?: string[]; help?: string };
export type ElementDef = { el: string; label: string; group: "layout" | "content" | "controls" | "logic"; container: boolean; text: boolean; props: PropDef[]; help: string };

const P = (name: string, kind: PropKind, label: string, extra: Partial<PropDef> = {}): PropDef => ({ name, kind, label, ...extra });
const VARIANTS = ["primary", "tonal", "secondary", "text", "danger"];

export const ELEMENTS: ElementDef[] = [
  { el: "column", label: "Column", group: "layout", container: true, text: false, props: [], help: "Children one under another." },
  { el: "row", label: "Row", group: "layout", container: true, text: false, props: [P("wrap", "bool", "Wrap to the next line")], help: "Children side by side." },
  { el: "stack", label: "Stack", group: "layout", container: true, text: false, props: [], help: "Children on top of each other (the last one on top)." },
  { el: "scroll", label: "Scroll", group: "layout", container: true, text: false, props: [P("horizontal", "bool", "Horizontal")], help: "Scrolls its one child." },
  { el: "card", label: "Card", group: "layout", container: true, text: false, props: [], help: "A raised surface with rounded corners." },
  { el: "text", label: "Text", group: "content", container: false, text: true, props: [P("variant", "select", "Style", { options: ["body", "title", "headline", "display", "caption", "label", "mono"] }), P("align", "select", "Alignment", { options: ["start", "center", "end"] }), P("links", "bool", "Clickable links")], help: "A text template: {$var}, {_'key'}, {=expression}." },
  { el: "icon", label: "Icon", group: "content", container: false, text: false, props: [P("icon", "icon", "Icon"), P("size", "number", "Size (dp)"), P("color", "color", "Colour")], help: "A lucide icon, drawn natively." },
  { el: "image", label: "Image", group: "content", container: false, text: false, props: [P("src", "image", "Image", { help: "asset:<name> from the design's assets, or a fixed https URL on a host in ANDROID_DESIGN_IMAGE_HOSTS (never computed: 6.7, F-01)" }), P("fit", "select", "Fit", { options: ["cover", "contain", "center"] }), P("ratio", "number", "Width / height")], help: "A picture." },
  { el: "avatar", label: "Avatar", group: "content", container: false, text: false, props: [P("name", "text", "Name (initials, colour)"), P("size", "number", "Size (dp)")], help: "A round badge with initials." },
  { el: "badge", label: "Badge", group: "content", container: false, text: true, props: [P("icon", "icon", "Icon"), P("color", "color", "Colour")], help: "A small pill with a number or a word." },
  { el: "chip", label: "Chip", group: "content", container: false, text: true, props: [P("icon", "icon", "Icon"), P("selected", "expr", "Selected")], help: "A compact choice." },
  { el: "divider", label: "Divider", group: "content", container: false, text: false, props: [], help: "A thin line." },
  { el: "spacer", label: "Spacer", group: "content", container: false, text: false, props: [P("size", "number", "Size (dp); empty = fill")], help: "Empty space." },
  { el: "progress", label: "Progress", group: "content", container: false, text: false, props: [P("value", "expr", "Value 0–1 (empty = spinning)")], help: "A progress bar." },
  { el: "button", label: "Button", group: "controls", container: false, text: true, props: [P("icon", "icon", "Icon"), P("variant", "select", "Variant", { options: VARIANTS }), P("disabled", "expr", "Disabled when")], help: "A button; its action is in Events." },
  { el: "iconButton", label: "Icon button", group: "controls", container: false, text: false, props: [P("icon", "icon", "Icon"), P("label", "text", "Accessible label"), P("variant", "select", "Variant", { options: VARIANTS }), P("badge", "expr", "Badge number")], help: "A round button with an icon." },
  { el: "input", label: "Input", group: "controls", container: false, text: false, props: [P("bind", "text", "Value name", { help: "Stored under $form.<name>" }), P("hint", "text", "Hint"), P("type", "select", "Type", { options: ["text", "password", "number", "email", "phone", "multiline", "url"] })], help: "A text field; Enter runs its submit action." },
  { el: "switch", label: "Switch", group: "controls", container: false, text: true, props: [P("checked", "expr", "On when"), ...TOGGLE_PROPS_61], help: "An on/off switch: bound to a setting it changes it itself, else its click action does." },
  { el: "checkbox", label: "Checkbox", group: "controls", container: false, text: true, props: [P("checked", "expr", "Checked when"), ...TOGGLE_PROPS_61], help: "A checkbox (e.g. selecting rooms)." },
  ...ELEMENTS_61,
  ...ELEMENTS_62,
  ...ELEMENTS_63,
  ...ELEMENTS_64,
  ...ELEMENTS_67,
  ...ELEMENTS_68,
  ...ELEMENTS_610,
  ...ELEMENTS_611,
  { el: "slot", label: "App part", group: "logic", container: false, text: false, props: [P("name", "slot", "Part")], help: "A native component of the app (message list, composer…)." },
];

export const STYLE_PROPS: Array<{ name: string; label: string; help: string }> = [
  { name: "padding", label: "Padding", help: "dp: 12 or \"8 16\" or \"8 16 8 16\"" },
  { name: "margin", label: "Margin", help: "dp, same forms as padding" },
  { name: "gap", label: "Gap", help: "dp between children" },
  { name: "width", label: "Width", help: "match, wrap or dp" },
  { name: "height", label: "Height", help: "match, wrap or dp" },
  { name: "maxWidth", label: "Max width", help: "dp" },
  { name: "weight", label: "Weight", help: "share of the free space in a row/column" },
  { name: "align", label: "Align children", help: "start, center, end, stretch" },
  { name: "justify", label: "Justify children", help: "start, center, end, between, around" },
  { name: "self", label: "Align self", help: "start, center, end, stretch" },
  { name: "bg", label: "Background", help: "@token or #rrggbb (#aarrggbb)" },
  { name: "fg", label: "Text colour", help: "@token or #rrggbb" },
  { name: "radius", label: "Corner radius", help: "dp" },
  { name: "border", label: "Border", help: "\"1 @border\" (width colour)" },
  { name: "elevation", label: "Elevation", help: "dp of shadow" },
  { name: "size", label: "Text size", help: "sp" },
  { name: "bold", label: "Bold", help: "true / false" },
  { name: "italic", label: "Italic", help: "true / false" },
  { name: "font", label: "Font", help: "sans, serif, mono" },
  { name: "lines", label: "Max lines", help: "number" },
  { name: "opacity", label: "Opacity", help: "0–1" },
];

export const COLOR_TOKENS = ["primary", "onPrimary", "background", "surface", "surfaceVariant", "onSurface", "muted", "accent", "border", "danger", "success", "warning", "bubbleIn", "onBubbleIn", "bubbleOut", "onBubbleOut", "scrim"] as const;
export const ANIM_TYPES = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "scale", "pop"] as const;
export const EASINGS = ["standard", "decelerate", "accelerate", "linear", "overshoot", "bounce"] as const;
export const EVENTS = ["click", "longClick", "submit", "change"] as const;

/** The actions the app implements in Java (docs/android-architecture.md §4). */
export const ACTIONS: Array<{ action: string; arg: string; help: string }> = [
  { action: "screen.open", arg: "screen id", help: "Open a screen (settings, about, rooms…)" },
  { action: "back", arg: "", help: "Back / close" },
  { action: "menu.open", arg: "menu id", help: "Show a menu of the design (main, room)" },
  { action: "room.join", arg: "", help: "The form to join a new room" },
  { action: "room.switch", arg: "room key", help: "Make a connected room the active one (or connect it)" },
  { action: "room.toggle", arg: "room key", help: "Select / unselect a room in the list" },
  { action: "rooms.connect", arg: "", help: "Connect every selected room" },
  { action: "room.leave", arg: "room key (empty = active)", help: "Disconnect a room" },
  { action: "room.forget", arg: "room key", help: "Remove a saved room" },
  { action: "message.send", arg: "", help: "Send the composer's text" },
  { action: "message.reply", arg: "message id", help: "Reply to a message" },
  { action: "message.copy", arg: "message id", help: "Copy a message" },
  { action: "users.toggle", arg: "", help: "Show / hide the user panel" },
  { action: "users.dock", arg: "none | left | right | bottom", help: "Dock the user panel to an edge" },
  { action: "users.autoHide", arg: "true | false (empty = toggle)", help: "Pin or auto-hide the docked panel" },
  { action: "call.audio", arg: "", help: "Start / join a voice call in the room" },
  { action: "call.video", arg: "", help: "Start / join a video call" },
  { action: "call.end", arg: "", help: "Hang up" },
  { action: "call.mute", arg: "", help: "Mute / unmute" },
  { action: "lock.now", arg: "", help: "Lock the app" },
  { action: "lock.biometric", arg: "", help: "Unlock with biometrics" },
  { action: "theme.toggle", arg: "", help: "Light / dark" },
  { action: "lang.set", arg: "cs | en | de", help: "Language" },
  { action: "update.check", arg: "", help: "Look for a new bundle or release" },
  { action: "update.install", arg: "", help: "Install what was downloaded" },
  { action: "update.later", arg: "", help: "Remind later" },
  { action: "flash", arg: "text", help: "Show a flash message" },
  { action: "url.open", arg: "https URL", help: "Open a web page" },
  { action: "copy", arg: "text", help: "Copy to the clipboard" },
  { action: "share", arg: "text", help: "The system share sheet" },
  { action: "fn.run", arg: "/command args", help: "Run a Functions command in the active room" },
  { action: "lib.run", arg: "library name", help: "Run an action library of the design" },
  { action: "set", arg: "name=value", help: "Set a value in $form" },
  ...ACTIONS_61,
  ...ACTIONS_62,
  ...ACTIONS_63,
  ...ACTIONS_64,
  ...ACTIONS_67,
  ...ACTIONS_68,
  ...ACTIONS_610,
  ...ACTIONS_611,
];

export const SLOTS: Array<{ name: string; label: string; screens: string[] }> = [
  { name: "splashLogo", label: "Animated logo", screens: ["splash"] },
  { name: "logo", label: "Logo", screens: ["lock", "enroll", "about", "rooms"] },
  { name: "lockPad", label: "PIN pad", screens: ["lock"] },
  { name: "enrollForm", label: "Server and code form", screens: ["enroll"] },
  { name: "roomList", label: "Rooms (items: rooms.item)", screens: ["rooms"] },
  { name: "roomTabs", label: "Connected rooms bar", screens: ["room"] },
  { name: "messages", label: "Messages (message.in / .out / .sys)", screens: ["room"] },
  { name: "composer", label: "Composer", screens: ["room"] },
  { name: "userPanel", label: "User panel (users, users.handle)", screens: ["room"] },
  { name: "userList", label: "Users (items: users.item)", screens: ["users"] },
  { name: "callControls", label: "Call controls", screens: ["call"] },
  { name: "callVideo", label: "Video tiles", screens: ["call"] },
  { name: "settingsList", label: "Settings", screens: ["settings"] },
  { name: "joinForm", label: "Join a room form", screens: ["join"] },
  { name: "updateProgress", label: "Download progress", screens: ["update"] },
  ...SLOTS_61,
  ...SLOTS_62,
  ...SLOTS_63,
  ...SLOTS_64,
  ...SLOTS_67,
  ...SLOTS_68,
  ...SLOTS_610,
  ...SLOTS_611,
];

export type ScreenDef = { id: string; label: string; group: "app" | "room" | "parts" | "system"; vars: string[]; sample: Record<string, unknown>; help: string };

const SAMPLE_ROOMS = [
  { key: "team", name: "team", users: 4, unread: 0, active: true, connected: true, selected: true, status: "joined" },
  { key: "family", name: "family", users: 3, unread: 7, active: false, connected: true, selected: true, status: "joined" },
  { key: "project-x", name: "project-x", users: 0, unread: 0, active: false, connected: false, selected: false, status: "saved" },
];
const APP = { name: "M5cet", version: "6.0.0", code: 600, bundle: "6.0.0-b1" };

export const SCREENS: ScreenDef[] = [
  { id: "splash", label: "Splash", group: "system", vars: ["$app", "$status", "$busy"], sample: { app: APP, status: "Decrypting…", busy: true }, help: "While the app starts: unlock, decrypt, load the bundle." },
  { id: "lock", label: "Lock", group: "system", vars: ["$app", "$lock"], sample: { app: APP, lock: { mode: "pin", attempts: 1, left: 7, wait: 0, biometricAvailable: true, error: "" } }, help: "Biometrics / PIN; attempts left, the wait after failures." },
  { id: "enroll", label: "Enrolment", group: "system", vars: ["$app", "$enroll"], sample: { app: APP, enroll: { server: "https://chat.example.com", error: "" } }, help: "First start: the server and (when required) the code." },
  { id: "rooms", label: "Rooms", group: "app", vars: ["$app", "$rooms", "$selectedCount", "$connectedCount", "$unreadTotal"], sample: { app: APP, rooms: SAMPLE_ROOMS, selectedCount: 2, connectedCount: 2, unreadTotal: 7 }, help: "Saved rooms, select several and connect them at once." },
  { id: "rooms.item", label: "Rooms › item", group: "parts", vars: ["$room"], sample: { room: SAMPLE_ROOMS[1] }, help: "One room in the list: checkbox, users badge, unread badge." },
  { id: "join", label: "Join a room", group: "app", vars: ["$form", "$error"], sample: { form: { name: "", room: "", passphrase: "" }, error: "" }, help: "Name, room, passphrase." },
  { id: "room", label: "Room", group: "room", vars: ["$room", "$rooms", "$me", "$users", "$call"], sample: { room: SAMPLE_ROOMS[0], rooms: SAMPLE_ROOMS.slice(0, 2), me: { name: "Mike" }, users: { open: true, dock: "right", autoHide: false, count: 4 }, call: { active: false } }, help: "The chat of the active room." },
  { id: "message.in", label: "Message › received", group: "parts", vars: ["$msg"], sample: { msg: { id: "m1", text: "Ahoj, jak to jde?", sender: "Alice", time: 1760000000000, mine: false, verified: true, changed: false, replyTo: null, attachment: null } }, help: "A message from someone else." },
  { id: "message.out", label: "Message › sent", group: "parts", vars: ["$msg"], sample: { msg: { id: "m2", text: "Dobře, díky!", sender: "Mike", time: 1760000060000, mine: true, status: "sent", replyTo: { sender: "Alice", text: "Ahoj, jak to jde?" }, attachment: null } }, help: "A message of mine." },
  { id: "message.sys", label: "Message › system", group: "parts", vars: ["$msg"], sample: { msg: { id: "s1", text: "Alice joined", time: 1760000000000 } }, help: "A notice (joins, leaves, key changes)." },
  { id: "users", label: "User panel", group: "room", vars: ["$users", "$count", "$dock", "$autoHide"], sample: { users: [{ name: "Alice", verified: true, away: false, me: false }, { name: "Mike", verified: true, away: false, me: true }], count: 2, dock: "right", autoHide: false }, help: "The floating / docked list of people in the room." },
  { id: "users.item", label: "User panel › item", group: "parts", vars: ["$user"], sample: { user: { name: "Alice", verified: true, away: false, me: false } }, help: "One person." },
  { id: "users.handle", label: "User panel › handle", group: "parts", vars: ["$count", "$edge", "$open"], sample: { count: 4, edge: "right", open: false }, help: "The small tab left on the edge while the panel hides." },
  { id: "settings", label: "Settings", group: "app", vars: ["$app", "$settings"], sample: { app: APP, settings: {} }, help: "Lock, notifications, theme, language, updates." },
  { id: "call", label: "Call", group: "room", vars: ["$call", "$room"], sample: { call: { active: true, mode: "audio", muted: false, peers: 2, duration: 83 }, room: SAMPLE_ROOMS[0] }, help: "An audio / video call in the room." },
  { id: "update", label: "Update", group: "system", vars: ["$update"], sample: { update: { kind: "bundle", version: "6.0.0-b2", size: 182000, notes: "New look of the rooms.", progress: 0.4, state: "downloading" } }, help: "A new bundle or release." },
  { id: "about", label: "About", group: "app", vars: ["$app", "$device", "$server"], sample: { app: APP, device: { id: "and_…", model: "Pixel 9" }, server: { url: "https://chat.example.com", kid: "AbCdEf0123456789", fingerprint: "1A2B 3C4D …" } }, help: "Versions, the device, the server's key." },
  { id: "flash", label: "Flash message", group: "parts", vars: ["$flash"], sample: { flash: { text: "Saved.", level: "success", title: "" } }, help: "A short notice at the top." },
  ...SCREENS_61,
  ...SCREENS_62,
  ...SCREENS_63,
  ...SCREENS_64,
  ...SCREENS_67,
  ...SCREENS_68,
  ...SCREENS_610,
  ...SCREENS_611,
];
export const SCREEN_IDS = SCREENS.map((s) => s.id);

/* ================================================================== trees */

export type ANode = {
  id: string; el: string; name?: string; text?: string;
  props?: Record<string, string | number | boolean>;
  style?: Record<string, string | number | boolean>;
  anim?: { enter?: { type: string; ms?: number; delay?: number; easing?: string } };
  if?: string; each?: string; as?: string;
  on?: Record<string, { action: string; arg?: string }>;
  children?: ANode[];
};

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

export const DEFAULT_SCREENS: Record<string, ANode> = {
  splash: n("root", "column", { style: { width: "match", height: "match", bg: "@background", align: "center", justify: "center", gap: 20 } }, [
    n("logo", "slot", { props: { name: "splashLogo" }, anim: { enter: { type: "scale", ms: 520, easing: "overshoot" } } }),
    n("name", "text", { text: "{$app.name}", props: { variant: "display", align: "center" }, style: { bold: true }, anim: { enter: { type: "fade", ms: 420, delay: 180 } } }),
    n("status", "text", { text: "{$status}", props: { variant: "caption", align: "center" }, style: { fg: "@muted" }, anim: { enter: { type: "fade", ms: 300, delay: 360 } } }),
    n("bar", "progress", { if: "$busy", style: { width: 140 } }),
  ]),
  lock: n("root", "column", { style: { width: "match", height: "match", bg: "@background", align: "center", justify: "center", gap: 14, padding: 24 } }, [
    n("logo", "slot", { props: { name: "logo" } }),
    n("title", "text", { text: "{_'lock.title'}", props: { variant: "headline", align: "center" }, style: { bold: true } }),
    n("hint", "text", { text: "{=$lock.mode == 'biometric' ? _('lock.useBiometric') : _('lock.enterPin')}", props: { variant: "body", align: "center" }, style: { fg: "@muted" } }),
    n("wait", "text", { if: "$lock.wait > 0", text: "{_'lock.waitFor'} {$lock.wait} s", props: { align: "center" }, style: { fg: "@danger", bold: true } }),
    n("left", "text", { if: "$lock.attempts > 0 && $lock.left > 0", text: "{_'lock.attemptsLeft'}: {$lock.left}", props: { variant: "caption", align: "center" }, style: { fg: "@danger" } }),
    n("error", "text", { if: "$lock.error", text: "{$lock.error}", props: { variant: "caption", align: "center" }, style: { fg: "@danger" } }),
    n("pad", "slot", { props: { name: "lockPad" }, if: "$lock.wait == 0" }),
    n("bio", "button", { if: "$lock.biometricAvailable && $lock.wait == 0", text: "{_'lock.useBiometric'}", props: { icon: "fingerprint-pattern", variant: "tonal" }, on: click("lock.biometric") }),
  ]),
  enroll: n("root", "scroll", { style: { width: "match", height: "match", bg: "@background" } }, [
    n("col", "column", { style: { padding: 24, gap: 16 } }, [
      n("logo", "slot", { props: { name: "logo" }, style: { self: "center" } }),
      n("title", "text", { text: "{_'enroll.title'}", props: { variant: "headline", align: "center" }, style: { bold: true } }),
      n("hint", "text", { text: "{_'enroll.hint'}", props: { align: "center" }, style: { fg: "@muted" } }),
      n("form", "slot", { props: { name: "enrollForm" } }),
      n("error", "text", { if: "$enroll.error", text: "{$enroll.error}", style: { fg: "@danger" } }),
    ]),
  ]),
  rooms: n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
    n("bar", "row", { style: { padding: "12 8 12 16", align: "center", gap: 8, bg: "@surface", elevation: 2 } }, [
      n("logo", "slot", { props: { name: "logo" }, style: { width: 32, height: 32 } }),
      n("title", "text", { text: "{_'rooms.title'}", props: { variant: "title" }, style: { weight: 1, bold: true } }),
      n("unread", "badge", { if: "$unreadTotal > 0", text: "{$unreadTotal}", props: { icon: "message-circle", color: "@primary" } }),
      n("add", "iconButton", { props: { icon: "plus", label: "{_'rooms.add'}" }, on: click("room.join") }),
      n("menu", "iconButton", { props: { icon: "ellipsis-vertical", label: "{_'menu.more'}" }, on: click("menu.open", "main") }),
    ]),
    n("list", "slot", { props: { name: "roomList" }, style: { weight: 1 } }),
    n("actions", "row", { if: "$selectedCount > 0", style: { padding: 16, gap: 12, bg: "@surface", elevation: 4 } }, [
      n("connect", "button", { text: "{_'rooms.connectSelected'} ({$selectedCount})", props: { icon: "plug", variant: "primary" }, style: { weight: 1 }, on: click("rooms.connect") }),
    ]),
  ]),
  "rooms.item": n("item", "row", { style: { padding: "12 16", gap: 12, align: "center", bg: "=$room.active ? '@surfaceVariant' : '@surface'" }, on: click("room.switch", "=$room.key") }, [
    n("sel", "checkbox", { props: { checked: "=$room.selected" }, on: click("room.toggle", "=$room.key") }),
    n("avatar", "avatar", { props: { name: "{$room.name}", size: 40 } }),
    n("info", "column", { style: { weight: 1, gap: 2 } }, [
      n("name", "text", { text: "{$room.name}", style: { bold: true, lines: 1 } }),
      n("state", "text", { text: "{=$room.connected ? _('rooms.connected') : _('rooms.saved')}", props: { variant: "caption" }, style: { fg: "=$room.connected ? '@success' : '@muted'" } }),
    ]),
    n("users", "badge", { if: "$room.connected", text: "{$room.users}", props: { icon: "users", color: "@muted" } }),
    n("unread", "badge", { if: "$room.unread > 0", text: "{$room.unread}", props: { icon: "message-circle", color: "@primary" }, anim: { enter: { type: "pop", ms: 240 } } }),
  ]),
  join: n("root", "column", { style: { padding: 24, gap: 12, bg: "@surface" } }, [
    n("title", "text", { text: "{_'join.title'}", props: { variant: "title" }, style: { bold: true } }),
    n("form", "slot", { props: { name: "joinForm" } }),
    n("error", "text", { if: "$error", text: "{$error}", style: { fg: "@danger" } }),
  ]),
  room: n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
    n("bar", "row", { style: { padding: "8 4 8 12", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
      n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("screen.open", "rooms") }),
      n("head", "column", { style: { weight: 1, padding: "0 4" } }, [
        n("name", "text", { text: "{$room.name}", props: { variant: "title" }, style: { bold: true, lines: 1 } }),
        n("sub", "text", { text: "{$room.users} {_'room.people'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
      ]),
      n("call", "iconButton", { props: { icon: "phone", label: "{_'call.audio'}" }, on: click("call.audio") }),
      n("users", "iconButton", { props: { icon: "users", label: "{_'users.title'}", badge: "=$users.count" }, on: click("users.toggle") }),
      n("menu", "iconButton", { props: { icon: "ellipsis-vertical", label: "{_'menu.more'}" }, on: click("menu.open", "room") }),
    ]),
    n("tabs", "slot", { if: "$rooms.length > 1", props: { name: "roomTabs" } }),
    n("body", "stack", { style: { weight: 1 } }, [
      n("messages", "slot", { props: { name: "messages" } }),
      n("panel", "slot", { props: { name: "userPanel" } }),
    ]),
    n("composer", "slot", { props: { name: "composer" } }),
  ]),
  "message.in": n("row", "row", { style: { padding: "3 12", gap: 8, align: "end" }, anim: { enter: { type: "slide-up", ms: 180 } } }, [
    n("avatar", "avatar", { props: { name: "{$msg.sender}", size: 30 } }),
    n("bubble", "column", { style: { bg: "@bubbleIn", fg: "@onBubbleIn", radius: 16, padding: "8 12", gap: 2, maxWidth: 300, elevation: 1 } }, [
      n("sender", "text", { text: "{$msg.sender}", props: { variant: "label" }, style: { fg: "@primary", bold: true } }),
      n("reply", "text", { if: "$msg.replyTo", text: "↪ {$msg.replyTo.sender}: {$msg.replyTo.text|truncate:60}", props: { variant: "caption" }, style: { fg: "@muted", italic: true } }),
      n("file", "row", { if: "$msg.attachment", style: { gap: 6, align: "center" } }, [
        n("fileIcon", "icon", { props: { icon: "paperclip", size: 16 } }),
        n("fileName", "text", { text: "{$msg.attachment.name} · {$msg.attachment.size|size}", props: { variant: "caption" } }),
      ]),
      n("text", "text", { if: "$msg.text", text: "{$msg.text}", props: { links: true } }),
      n("meta", "row", { style: { gap: 4, align: "center", self: "end" } }, [
        n("changed", "icon", { if: "$msg.changed", props: { icon: "shield-alert", size: 12, color: "@warning" } }),
        n("verified", "icon", { if: "$msg.verified && !$msg.changed", props: { icon: "shield-check", size: 12, color: "@success" } }),
        n("time", "text", { text: "{$msg.time|time}", props: { variant: "caption" }, style: { fg: "@muted" } }),
      ]),
    ]),
  ]),
  "message.out": n("row", "row", { style: { padding: "3 12", justify: "end" }, anim: { enter: { type: "slide-up", ms: 160 } } }, [
    n("bubble", "column", { style: { bg: "@bubbleOut", fg: "@onBubbleOut", radius: 16, padding: "8 12", gap: 2, maxWidth: 300, elevation: 1 } }, [
      n("reply", "text", { if: "$msg.replyTo", text: "↪ {$msg.replyTo.sender}: {$msg.replyTo.text|truncate:60}", props: { variant: "caption" }, style: { opacity: 0.8, italic: true } }),
      n("file", "row", { if: "$msg.attachment", style: { gap: 6, align: "center" } }, [
        n("fileIcon", "icon", { props: { icon: "paperclip", size: 16, color: "@onBubbleOut" } }),
        n("fileName", "text", { text: "{$msg.attachment.name} · {$msg.attachment.size|size}", props: { variant: "caption" } }),
      ]),
      n("text", "text", { if: "$msg.text", text: "{$msg.text}", props: { links: true } }),
      n("meta", "row", { style: { gap: 4, align: "center", self: "end", opacity: 0.8 } }, [
        n("time", "text", { text: "{$msg.time|time}", props: { variant: "caption" } }),
        n("state", "icon", { props: { icon: "=$msg.status == 'read' ? 'check-check' : ($msg.status == 'queued' ? 'clock' : 'check')", size: 12, color: "@onBubbleOut" } }),
      ]),
    ]),
  ]),
  "message.sys": n("row", "row", { style: { padding: "6 12", justify: "center" } }, [
    n("pill", "text", { text: "{$msg.text}", props: { variant: "caption", align: "center" }, style: { bg: "@surfaceVariant", fg: "@muted", radius: 10, padding: "4 10" } }),
  ]),
  users: n("panel", "column", { style: { bg: "@surface", radius: 16, elevation: 8, padding: 8, gap: 4 } }, [
    n("head", "row", { style: { align: "center", gap: 6, padding: "2 4 2 8" } }, [
      n("icon", "icon", { props: { icon: "users", size: 18, color: "@primary" } }),
      n("title", "text", { text: "{_'users.title'} ({$count})", style: { bold: true, weight: 1, lines: 1 } }),
      n("dock", "iconButton", { props: { icon: "=$dock == 'left' ? 'panel-left' : ($dock == 'bottom' ? 'rows-2' : ($dock == 'right' ? 'panel-right' : 'move'))", label: "{_'users.dock'}" }, on: click("menu.open", "dock") }),
      n("pin", "iconButton", { if: "$dock != 'none'", props: { icon: "=$autoHide ? 'pin-off' : 'pin'", label: "{=$autoHide ? _('users.pin') : _('users.autoHide')}" }, on: click("users.autoHide") }),
      n("close", "iconButton", { props: { icon: "x", label: "{_'nav.close'}" }, on: click("users.toggle") }),
    ]),
    n("list", "slot", { props: { name: "userList" }, style: { weight: 1 } }),
  ]),
  "users.item": n("item", "row", { style: { padding: "6 8", gap: 10, align: "center" } }, [
    n("avatar", "avatar", { props: { name: "{$user.name}", size: 28 } }),
    n("name", "text", { text: "{$user.name}{=$user.me ? ' (' + _('users.me') + ')' : ''}", style: { weight: 1, lines: 1 } }),
    n("away", "text", { if: "$user.away", text: "{_'users.away'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
    n("verified", "icon", { if: "$user.verified", props: { icon: "shield-check", size: 14, color: "@success" } }),
  ]),
  "users.handle": n("handle", "column", { style: { bg: "@primary", radius: 12, padding: "8 6", gap: 2, align: "center", elevation: 6 } }, [
    n("icon", "icon", { props: { icon: "users", size: 18, color: "@onPrimary" } }),
    n("count", "text", { text: "{$count}", props: { variant: "caption", align: "center" }, style: { fg: "@onPrimary", bold: true } }),
  ]),
  settings: n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
    n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
      n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
      n("title", "text", { text: "{_'settings.title'}", props: { variant: "title" }, style: { bold: true, weight: 1 } }),
    ]),
    n("list", "slot", { props: { name: "settingsList" }, style: { weight: 1 } }),
  ]),
  call: n("root", "column", { style: { width: "match", height: "match", bg: "#101418", fg: "#ffffff", align: "center", gap: 16, padding: 24 } }, [
    n("room", "text", { text: "{$room.name}", props: { variant: "headline", align: "center" }, style: { bold: true, fg: "#ffffff" } }),
    n("state", "text", { text: "{=$call.mode == 'video' ? _('call.video') : _('call.audio')} · {$call.peers} {_'room.people'}", props: { align: "center" }, style: { fg: "#c9d1d9" } }),
    n("video", "slot", { props: { name: "callVideo" }, style: { weight: 1, width: "match" } }),
    n("controls", "slot", { props: { name: "callControls" } }),
  ]),
  update: n("root", "card", { style: { padding: 20, gap: 12, margin: 16, radius: 20 } }, [
    n("title", "text", { text: "{=$update.kind == 'release' ? _('update.release') : _('update.bundle')}", props: { variant: "title" }, style: { bold: true } }),
    n("version", "text", { text: "{_'update.version'} {$update.version} · {$update.size|size}", style: { fg: "@muted" } }),
    n("notes", "text", { if: "$update.notes", text: "{$update.notes}" }),
    n("progress", "slot", { props: { name: "updateProgress" }, if: "$update.state == 'downloading'" }),
    n("actions", "row", { style: { gap: 12, justify: "end" } }, [
      n("later", "button", { text: "{_'update.later'}", props: { variant: "text" }, on: click("update.later") }),
      n("install", "button", { if: "$update.state == 'ready'", text: "{_'update.install'}", props: { variant: "primary", icon: "download" }, on: click("update.install") }),
    ]),
  ]),
  about: n("root", "scroll", { style: { width: "match", height: "match", bg: "@background" } }, [
    n("col", "column", { style: { padding: 24, gap: 10, align: "center" } }, [
      n("logo", "slot", { props: { name: "logo" } }),
      n("name", "text", { text: "{$app.name}", props: { variant: "headline" }, style: { bold: true } }),
      n("version", "text", { text: "{_'about.version'} {$app.version} ({$app.code}) · {_'about.bundle'} {$app.bundle}", props: { align: "center" }, style: { fg: "@muted" } }),
      n("device", "text", { text: "{_'about.device'}: {$device.model} · {$device.id}", props: { variant: "caption", align: "center" } }),
      n("server", "text", { text: "{$server.url}", props: { variant: "caption", align: "center" } }),
      n("key", "text", { text: "{_'about.serverKey'}: {$server.fingerprint}", props: { variant: "mono", align: "center" }, style: { size: 11 } }),
    ]),
  ]),
  flash: n("box", "row", { style: { bg: "=$flash.level == 'error' ? '@danger' : ($flash.level == 'success' ? '@success' : ($flash.level == 'warn' ? '@warning' : '@surface'))", fg: "=$flash.level == 'info' ? '@onSurface' : '#ffffff'", radius: 14, padding: "12 16", gap: 10, align: "center", elevation: 8, margin: "8 12" }, anim: { enter: { type: "slide-down", ms: 220, easing: "decelerate" } } }, [
    n("icon", "icon", { props: { icon: "=$flash.level == 'error' ? 'circle-alert' : ($flash.level == 'success' ? 'circle-check' : ($flash.level == 'warn' ? 'triangle-alert' : 'info'))", size: 20 } }),
    n("col", "column", { style: { weight: 1 } }, [
      n("title", "text", { if: "$flash.title", text: "{$flash.title}", style: { bold: true } }),
      n("text", "text", { text: "{$flash.text}" }),
    ]),
  ]),
};

// 6.1 (design-61.ts): the new screens; the room bar gets video, the tools and
// the call's options; the bubbles get the body slot, the kinds, the position
// pin, the recording's icon and the delivery states; settings become screens.
Object.assign(DEFAULT_SCREENS, SCREENS_TREES_61);
DEFAULT_SCREENS.room.children = (DEFAULT_SCREENS.room.children ?? []).map((c) => (c.id === "bar" ? roomBar61() : c));
DEFAULT_SCREENS["message.in"] = messageIn61();
DEFAULT_SCREENS["message.out"] = messageOut61();
// 6.2 (design-62*.ts): new and replaced trees, then each area's changes to existing ones.
Object.assign(DEFAULT_SCREENS, SCREENS_TREES_62);
patch62(DEFAULT_SCREENS);
Object.assign(DEFAULT_SCREENS, SCREENS_TREES_63);
patch63(DEFAULT_SCREENS);
Object.assign(DEFAULT_SCREENS, SCREENS_TREES_64);
patch64(DEFAULT_SCREENS);
// 6.7 (design-67-*.ts): one file per area.
Object.assign(DEFAULT_SCREENS, SCREENS_TREES_67);
patch67(DEFAULT_SCREENS);
// 6.8 (design-68-*.ts), after 6.7.
Object.assign(DEFAULT_SCREENS, SCREENS_TREES_68);
patch68(DEFAULT_SCREENS);
// 6.10 (design-610-*.ts), after 6.8.
Object.assign(DEFAULT_SCREENS, SCREENS_TREES_610);
patch610(DEFAULT_SCREENS);
// 6.11 (design-611-*.ts), after 6.10.
Object.assign(DEFAULT_SCREENS, SCREENS_TREES_611);
patch611(DEFAULT_SCREENS);

/* ================================================================== theme */

export type Theme = { light: Record<string, string>; dark: Record<string, string>; radius: number; font: "sans" | "serif" | "mono"; density: "compact" | "normal" | "comfortable" };

export const DEFAULT_THEME: Theme = {
  light: {
    primary: "#e11d48", onPrimary: "#ffffff", background: "#f5f6f8", surface: "#ffffff", surfaceVariant: "#eceef2", onSurface: "#1c2330",
    muted: "#6b7280", accent: "#f43f5e", border: "#dfe3ea", danger: "#dc2626", success: "#16a34a", warning: "#d97706",
    bubbleIn: "#ffffff", onBubbleIn: "#1c2330", bubbleOut: "#e11d48", onBubbleOut: "#ffffff", scrim: "#99000000",
  },
  dark: {
    primary: "#fb7185", onPrimary: "#1c0b10", background: "#0e1116", surface: "#161b22", surfaceVariant: "#212833", onSurface: "#e8ecf2",
    muted: "#8b949e", accent: "#fb7185", border: "#2d3542", danger: "#f87171", success: "#4ade80", warning: "#fbbf24",
    bubbleIn: "#1f2630", onBubbleIn: "#e8ecf2", bubbleOut: "#be123c", onBubbleOut: "#ffffff", scrim: "#cc000000",
  },
  radius: 14,
  font: "sans",
  density: "normal",
};
// 6.2 look: calmer default tokens (design-62-look.ts).
Object.assign(DEFAULT_THEME.light, THEME_62.light);
Object.assign(DEFAULT_THEME.dark, THEME_62.dark);
DEFAULT_THEME.radius = THEME_62.radius;

export type AnimSpec = { type: string; ms: number; easing: string; delay?: number };
export type Animations = {
  screen: AnimSpec; dialog: AnimSpec; message: AnimSpec; list: AnimSpec; flash: AnimSpec & { stay: number };
  users: AnimSpec; splash: { style: "orbit" | "pulse" | "reveal" | "none"; ms: number; minMs: number };
};

export const DEFAULT_ANIMATIONS: Animations = {
  screen: { type: "slide-left", ms: 260, easing: "standard" },
  dialog: { type: "scale", ms: 200, easing: "decelerate" },
  message: { type: "slide-up", ms: 180, easing: "decelerate" },
  list: { type: "fade", ms: 160, easing: "standard", delay: 24 },
  flash: { type: "slide-down", ms: 220, easing: "decelerate", stay: 3500 },
  users: { type: "slide-right", ms: 240, easing: "decelerate" },
  splash: { style: "orbit", ms: 1400, minMs: 700 },
};

/* ================================================================ strings */

export const LANGS = ["cs", "en", "de"] as const;
export type Lang = typeof LANGS[number];

export const DEFAULT_STRINGS: Record<Lang, Record<string, string>> = {
  cs: {
    "app.starting": "Spouštím…", "app.decrypting": "Dešifruji data…", "app.loadingBundle": "Načítám vzhled…", "app.connecting": "Připojuji…",
    "lock.title": "Aplikace je zamčená", "lock.enterPin": "Zadejte PIN", "lock.useBiometric": "Odemknout biometrií", "lock.waitFor": "Další pokus za", "lock.attemptsLeft": "Zbývá pokusů",
    "lock.wrongPin": "Nesprávný PIN", "lock.setPin": "Nastavte PIN", "lock.confirmPin": "Zopakujte PIN", "lock.pinMismatch": "PINy se neshodují", "lock.wiped": "Všechna data byla po opakovaných chybách smazána.", "lock.bioPrompt": "Odemknout M5cet", "lock.bioCancel": "Použít PIN",
    "enroll.title": "Připojení k serveru", "enroll.hint": "Zadejte adresu serveru M5cet a případně registrační kód od správce.", "enroll.server": "Adresa serveru", "enroll.code": "Registrační kód", "enroll.name": "Název zařízení", "enroll.submit": "Zaregistrovat", "enroll.failed": "Registrace se nezdařila",
    "rooms.title": "Místnosti", "rooms.add": "Nová místnost", "rooms.connectSelected": "Připojit vybrané", "rooms.connected": "Připojeno", "rooms.saved": "Uložená", "rooms.empty": "Zatím žádné místnosti. Přidejte první tlačítkem +.", "rooms.leave": "Odpojit", "rooms.forget": "Zapomenout",
    "join.title": "Připojit místnost", "join.name": "Vaše jméno", "join.room": "Místnost", "join.passphrase": "Heslo místnosti", "join.submit": "Připojit", "join.save": "Uložit do seznamu",
    "room.people": "lidí", "room.empty": "Zatím žádné zprávy. Zprávy jsou šifrované end-to-end a server je nevidí.", "room.typeMessage": "Napište zprávu…", "room.send": "Odeslat", "room.connecting": "Připojuji…", "room.offline": "Odpojeno — zkouším znovu", "room.keyMismatch": "Jiné heslo místnosti než u ostatních",
    "users.title": "Lidé", "users.me": "já", "users.away": "pryč", "users.dock": "Umístění panelu", "users.autoHide": "Automaticky schovat", "users.pin": "Připnout", "users.dockNone": "Volně", "users.dockLeft": "Vlevo", "users.dockRight": "Vpravo", "users.dockBottom": "Dole",
    "call.audio": "Hlasový hovor", "call.video": "Videohovor", "call.end": "Zavěsit", "call.mute": "Ztlumit", "call.incoming": "Hovor v místnosti",
    "settings.title": "Nastavení", "settings.lock": "Zámek aplikace", "settings.biometric": "Biometrie", "settings.changePin": "Změnit PIN", "settings.notifications": "Oznámení", "settings.theme": "Tmavý vzhled", "settings.language": "Jazyk", "settings.updates": "Aktualizace", "settings.about": "O aplikaci", "settings.callLog": "Hovory do systémového záznamu", "settings.wipe": "Smazat všechna data",
    "update.bundle": "Nový vzhled aplikace", "update.release": "Nová verze aplikace", "update.version": "Verze", "update.install": "Nainstalovat", "update.later": "Později", "update.installed": "Aktualizace nainstalována", "update.failed": "Aktualizace se nezdařila — běží předchozí verze", "update.none": "Máte nejnovější verzi",
    "about.version": "Verze", "about.bundle": "vzhled", "about.device": "Zařízení", "about.serverKey": "Klíč serveru",
    "menu.more": "Další", "menu.settings": "Nastavení", "menu.about": "O aplikaci", "menu.lock": "Zamknout", "menu.update": "Zkontrolovat aktualizace", "menu.theme": "Světlý / tmavý", "menu.leave": "Odpojit místnost", "menu.video": "Videohovor", "menu.share": "Sdílet pozvánku",
    "nav.back": "Zpět", "nav.close": "Zavřít",
    "notify.message": "Nová zpráva", "notify.messages": "nových zpráv", "notify.reply": "Odpovědět", "notify.markRead": "Přečteno",
    "push.channel": "Zprávy a upozornění", "push.flash": "Upozornění",
  },
  en: {
    "app.starting": "Starting…", "app.decrypting": "Decrypting data…", "app.loadingBundle": "Loading the look…", "app.connecting": "Connecting…",
    "lock.title": "The app is locked", "lock.enterPin": "Enter your PIN", "lock.useBiometric": "Unlock with biometrics", "lock.waitFor": "Next attempt in", "lock.attemptsLeft": "Attempts left",
    "lock.wrongPin": "Wrong PIN", "lock.setPin": "Choose a PIN", "lock.confirmPin": "Repeat the PIN", "lock.pinMismatch": "The PINs do not match", "lock.wiped": "All data was erased after repeated failures.", "lock.bioPrompt": "Unlock M5cet", "lock.bioCancel": "Use PIN",
    "enroll.title": "Connect to a server", "enroll.hint": "Enter the address of your M5cet server and, if required, the enrolment code from the administrator.", "enroll.server": "Server address", "enroll.code": "Enrolment code", "enroll.name": "Device name", "enroll.submit": "Enrol", "enroll.failed": "Enrolment failed",
    "rooms.title": "Rooms", "rooms.add": "New room", "rooms.connectSelected": "Connect selected", "rooms.connected": "Connected", "rooms.saved": "Saved", "rooms.empty": "No rooms yet. Add the first one with +.", "rooms.leave": "Disconnect", "rooms.forget": "Forget",
    "join.title": "Join a room", "join.name": "Your name", "join.room": "Room", "join.passphrase": "Room passphrase", "join.submit": "Join", "join.save": "Save to the list",
    "room.people": "people", "room.empty": "No messages yet. Messages are end-to-end encrypted; the server cannot read them.", "room.typeMessage": "Write a message…", "room.send": "Send", "room.connecting": "Connecting…", "room.offline": "Offline — retrying", "room.keyMismatch": "A different room passphrase than the others",
    "users.title": "People", "users.me": "me", "users.away": "away", "users.dock": "Panel position", "users.autoHide": "Auto-hide", "users.pin": "Pin", "users.dockNone": "Free", "users.dockLeft": "Left", "users.dockRight": "Right", "users.dockBottom": "Bottom",
    "call.audio": "Voice call", "call.video": "Video call", "call.end": "Hang up", "call.mute": "Mute", "call.incoming": "A call in the room",
    "settings.title": "Settings", "settings.lock": "App lock", "settings.biometric": "Biometrics", "settings.changePin": "Change PIN", "settings.notifications": "Notifications", "settings.theme": "Dark look", "settings.language": "Language", "settings.updates": "Updates", "settings.about": "About", "settings.callLog": "Calls in the system call log", "settings.wipe": "Erase all data",
    "update.bundle": "A new look of the app", "update.release": "A new version of the app", "update.version": "Version", "update.install": "Install", "update.later": "Later", "update.installed": "Update installed", "update.failed": "The update failed — the previous version runs", "update.none": "You have the latest version",
    "about.version": "Version", "about.bundle": "look", "about.device": "Device", "about.serverKey": "Server key",
    "menu.more": "More", "menu.settings": "Settings", "menu.about": "About", "menu.lock": "Lock", "menu.update": "Check for updates", "menu.theme": "Light / dark", "menu.leave": "Disconnect the room", "menu.video": "Video call", "menu.share": "Share an invitation",
    "nav.back": "Back", "nav.close": "Close",
    "notify.message": "New message", "notify.messages": "new messages", "notify.reply": "Reply", "notify.markRead": "Mark read",
    "push.channel": "Messages and notices", "push.flash": "Notices",
  },
  de: {
    "app.starting": "Starte…", "app.decrypting": "Entschlüssele Daten…", "app.loadingBundle": "Lade das Aussehen…", "app.connecting": "Verbinde…",
    "lock.title": "Die App ist gesperrt", "lock.enterPin": "PIN eingeben", "lock.useBiometric": "Mit Biometrie entsperren", "lock.waitFor": "Nächster Versuch in", "lock.attemptsLeft": "Verbleibende Versuche",
    "lock.wrongPin": "Falsche PIN", "lock.setPin": "PIN festlegen", "lock.confirmPin": "PIN wiederholen", "lock.pinMismatch": "Die PINs stimmen nicht überein", "lock.wiped": "Nach wiederholten Fehlern wurden alle Daten gelöscht.", "lock.bioPrompt": "M5cet entsperren", "lock.bioCancel": "PIN verwenden",
    "enroll.title": "Mit einem Server verbinden", "enroll.hint": "Geben Sie die Adresse Ihres M5cet-Servers und ggf. den Registrierungscode des Administrators ein.", "enroll.server": "Serveradresse", "enroll.code": "Registrierungscode", "enroll.name": "Gerätename", "enroll.submit": "Registrieren", "enroll.failed": "Registrierung fehlgeschlagen",
    "rooms.title": "Räume", "rooms.add": "Neuer Raum", "rooms.connectSelected": "Ausgewählte verbinden", "rooms.connected": "Verbunden", "rooms.saved": "Gespeichert", "rooms.empty": "Noch keine Räume. Fügen Sie den ersten mit + hinzu.", "rooms.leave": "Trennen", "rooms.forget": "Vergessen",
    "join.title": "Raum beitreten", "join.name": "Ihr Name", "join.room": "Raum", "join.passphrase": "Raum-Passphrase", "join.submit": "Beitreten", "join.save": "In der Liste speichern",
    "room.people": "Personen", "room.empty": "Noch keine Nachrichten. Nachrichten sind Ende-zu-Ende-verschlüsselt; der Server kann sie nicht lesen.", "room.typeMessage": "Nachricht schreiben…", "room.send": "Senden", "room.connecting": "Verbinde…", "room.offline": "Offline — neuer Versuch", "room.keyMismatch": "Eine andere Raum-Passphrase als die anderen",
    "users.title": "Personen", "users.me": "ich", "users.away": "abwesend", "users.dock": "Position des Panels", "users.autoHide": "Automatisch ausblenden", "users.pin": "Anheften", "users.dockNone": "Frei", "users.dockLeft": "Links", "users.dockRight": "Rechts", "users.dockBottom": "Unten",
    "call.audio": "Sprachanruf", "call.video": "Videoanruf", "call.end": "Auflegen", "call.mute": "Stummschalten", "call.incoming": "Ein Anruf im Raum",
    "settings.title": "Einstellungen", "settings.lock": "App-Sperre", "settings.biometric": "Biometrie", "settings.changePin": "PIN ändern", "settings.notifications": "Benachrichtigungen", "settings.theme": "Dunkles Aussehen", "settings.language": "Sprache", "settings.updates": "Updates", "settings.about": "Über", "settings.callLog": "Anrufe im Systemanrufprotokoll", "settings.wipe": "Alle Daten löschen",
    "update.bundle": "Ein neues Aussehen der App", "update.release": "Eine neue Version der App", "update.version": "Version", "update.install": "Installieren", "update.later": "Später", "update.installed": "Update installiert", "update.failed": "Das Update ist fehlgeschlagen — die vorherige Version läuft", "update.none": "Sie haben die neueste Version",
    "about.version": "Version", "about.bundle": "Aussehen", "about.device": "Gerät", "about.serverKey": "Serverschlüssel",
    "menu.more": "Mehr", "menu.settings": "Einstellungen", "menu.about": "Über", "menu.lock": "Sperren", "menu.update": "Nach Updates suchen", "menu.theme": "Hell / dunkel", "menu.leave": "Raum trennen", "menu.video": "Videoanruf", "menu.share": "Einladung teilen",
    "nav.back": "Zurück", "nav.close": "Schließen",
    "notify.message": "Neue Nachricht", "notify.messages": "neue Nachrichten", "notify.reply": "Antworten", "notify.markRead": "Gelesen",
    "push.channel": "Nachrichten und Hinweise", "push.flash": "Hinweise",
  },
};
for (const lang of LANGS) Object.assign(DEFAULT_STRINGS[lang], STRINGS_61[lang]);
for (const lang of LANGS) Object.assign(DEFAULT_STRINGS[lang], STRINGS_62[lang]);
for (const lang of LANGS) Object.assign(DEFAULT_STRINGS[lang], STRINGS_63[lang]);
for (const lang of LANGS) Object.assign(DEFAULT_STRINGS[lang], STRINGS_64[lang]);
for (const lang of LANGS) Object.assign(DEFAULT_STRINGS[lang], STRINGS_67[lang]);
for (const lang of LANGS) Object.assign(DEFAULT_STRINGS[lang], STRINGS_68[lang]);
for (const lang of LANGS) Object.assign(DEFAULT_STRINGS[lang], STRINGS_610[lang]);
for (const lang of LANGS) Object.assign(DEFAULT_STRINGS[lang], STRINGS_611[lang]);

/* ================================================================== menus */

export type MenuItem = { id: string; icon: string; label: string; action: string; arg?: string; if?: string };

export const DEFAULT_MENUS: Record<string, MenuItem[]> = {
  main: [
    { id: "settings", icon: "settings", label: "{_'menu.settings'}", action: "screen.open", arg: "settings" },
    { id: "update", icon: "refresh-cw", label: "{_'menu.update'}", action: "update.check" },
    { id: "theme", icon: "moon", label: "{_'menu.theme'}", action: "theme.toggle" },
    { id: "lock", icon: "lock", label: "{_'menu.lock'}", action: "lock.now" },
    { id: "about", icon: "info", label: "{_'menu.about'}", action: "screen.open", arg: "about" },
  ],
  room: [
    { id: "video", icon: "video", label: "{_'menu.video'}", action: "call.video" },
    { id: "users", icon: "users", label: "{_'users.title'}", action: "users.toggle" },
    { id: "share", icon: "share-2", label: "{_'menu.share'}", action: "share", arg: "{$room.name}" },
    { id: "leave", icon: "log-out", label: "{_'menu.leave'}", action: "room.leave" },
  ],
  dock: [
    { id: "none", icon: "move", label: "{_'users.dockNone'}", action: "users.dock", arg: "none" },
    { id: "left", icon: "panel-left", label: "{_'users.dockLeft'}", action: "users.dock", arg: "left" },
    { id: "right", icon: "panel-right", label: "{_'users.dockRight'}", action: "users.dock", arg: "right" },
    { id: "bottom", icon: "rows-2", label: "{_'users.dockBottom'}", action: "users.dock", arg: "bottom" },
  ],
};
Object.assign(DEFAULT_MENUS, MENUS_61);
Object.assign(DEFAULT_MENUS, MENUS_62);
Object.assign(DEFAULT_MENUS, MENUS_63);
Object.assign(DEFAULT_MENUS, MENUS_64);
Object.assign(DEFAULT_MENUS, MENUS_67);
Object.assign(DEFAULT_MENUS, MENUS_68);
Object.assign(DEFAULT_MENUS, MENUS_610);
Object.assign(DEFAULT_MENUS, MENUS_611);
// 6.4: Registration in the room's and the room list's menus (items added, not whole menus).
patchMenus64(DEFAULT_MENUS);
patchMenus67(DEFAULT_MENUS);
patchMenus68(DEFAULT_MENUS);
patchMenus610(DEFAULT_MENUS);
patchMenus611(DEFAULT_MENUS);

/* ============================================================== libraries */

export type LibStep = { do: string; arg?: string; if?: string };
export type Library = { description: string; steps: LibStep[] };

export const DEFAULT_LIBRARIES: Record<string, Library> = {
  "lock-and-rooms": { description: "Lock the app and go back to the room list.", steps: [{ do: "screen.open", arg: "rooms" }, { do: "lock.now" }] },
};

/* ================================================================= design */

export type Asset = { mime: string; data: string };

export type AndroidDesign = {
  format: 1;
  app: { name: string };
  theme: Theme;
  animations: Animations;
  screens: Record<string, ANode>;
  menus: Record<string, MenuItem[]>;
  strings: Record<string, Record<string, string>>;
  libraries: Record<string, Library>;
  assets: Record<string, Asset>;
  rev: string;
  updatedAt: number;
  updatedBy: string;
};

export const DEFAULT_DESIGN: AndroidDesign = {
  format: 1,
  app: { name: "M5cet" },
  theme: DEFAULT_THEME,
  animations: DEFAULT_ANIMATIONS,
  screens: DEFAULT_SCREENS,
  menus: DEFAULT_MENUS,
  strings: DEFAULT_STRINGS,
  libraries: DEFAULT_LIBRARIES,
  assets: {},
  rev: "default",
  updatedAt: 0,
  updatedBy: "",
};

/* ============================================================== sanitizer */

export const LIMITS = { nodes: 1500, depth: 30, text: 4000, assets: 2 * 1024 * 1024, asset: 512 * 1024, strings: 3000, libraries: 60, steps: 60, menuItems: 40 } as const;

export class DesignError extends Error {
  constructor(readonly problems: string[]) { super(problems.slice(0, 5).join("; ")); }
}

const ELEMENT_BY: Record<string, ElementDef> = Object.fromEntries(ELEMENTS.map((e) => [e.el, e]));
const ICONS = new Set(Object.keys(MENU_ICONS));
const ACTION_SET = new Set(ACTIONS.map((a) => a.action));
const SLOT_SET = new Set(SLOTS.map((s) => s.name));
const STYLE_SET = new Set(STYLE_PROPS.map((s) => s.name));
const COLOR_RE = /^(@[A-Za-z]+|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/i;

/** Is a value an expression ("=…"); if so, is it valid? */
/**
 * 6.7 (security analysis F-01, critical): what of a design may reach the network.
 * The app renders the design with decrypted messages in scope ($msg, $form, $user…);
 * an image fetched from "https://x/{$msg.text}" carried the plaintext to that server.
 *
 *   image src   asset:<name> (a template only for the asset's name), an expression only
 *               for a local source (asset:/data:, no web address in it), or a FIXED https URL
 *               on a host listed in ANDROID_DESIGN_IMAGE_HOSTS (comma-separated; none by default)
 *   url.open    a fixed https address (no {…} / =expression)
 *
 * The app enforces the same at run time (android/…/ui/DesignUrls.java).
 */
export function designImageHosts(): Set<string> {
  return new Set((process.env.ANDROID_DESIGN_IMAGE_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

export function checkImageSrc(s: string, hosts: Set<string> = designImageHosts()): string | null {
  if (s.startsWith("=")) {
    return /https?:|\/\//i.test(s) ? "a computed image may only name an asset: or data: source, never a web address" : null;
  }
  if (s.includes("{")) {
    return /^asset:/.test(s) ? null : "an image address must not contain {…} — it would carry what the app shows (messages, form fields) to that server";
  }
  if (/^asset:[A-Za-z0-9._-]{1,60}$/.test(s)) return null;
  if (!/^https:\/\/[^\s"'<>]{4,500}$/.test(s)) return "must be asset:<name> or an https URL";
  let host = "";
  try { host = new URL(s).hostname.toLowerCase(); } catch { return "not a valid https URL"; }
  if (!hosts.has(host)) return `remote images only from the hosts in ANDROID_DESIGN_IMAGE_HOSTS — ${host} is not one of them`;
  return null;
}

export function checkActionArg(action: string, arg: string): string | null {
  if (action !== "url.open") return null;
  if (arg.startsWith("=") || arg.includes("{")) return "url.open takes a fixed https address — no {…} or =expression (it would carry data off the phone)";
  return /^https:\/\/[^\s"'<>]{4,500}$/.test(arg) ? null : "url.open takes an https address";
}

function checkValue(v: string, where: string, problems: string[], kind: "text" | "value"): void {
  if (v.startsWith("=")) { const e = checkExpr(v.slice(1)); if (e) problems.push(`${where}: ${e}`); return; }
  if (kind === "text") { const e = checkTemplate(v); if (e) problems.push(`${where}: ${e}`); }
}

function sanitizeNode(raw: unknown, path: string, problems: string[], ctx: { count: number; ids: Set<string> }, depth: number): ANode | null {
  if (!raw || typeof raw !== "object") { problems.push(`${path}: not an element`); return null; }
  const r = raw as Record<string, unknown>;
  if (++ctx.count > LIMITS.nodes) { if (ctx.count === LIMITS.nodes + 1) problems.push(`more than ${LIMITS.nodes} elements`); return null; }
  if (depth > LIMITS.depth) { problems.push(`${path}: nested deeper than ${LIMITS.depth}`); return null; }
  const el = typeof r.el === "string" ? r.el : "";
  const def = ELEMENT_BY[el];
  if (!def) { problems.push(`${path}: unknown element "${el}"`); return null; }
  let id = typeof r.id === "string" && ID_RE.test(r.id) ? r.id : "";
  if (!id || ctx.ids.has(id)) { let i = ctx.count; do { id = `${el.toLowerCase()}-${i++}`; } while (ctx.ids.has(id)); }
  ctx.ids.add(id);
  const where = `${path}/${id}`;
  const node: ANode = { id, el };
  if (typeof r.name === "string" && r.name.trim()) node.name = r.name.trim().slice(0, 60);
  if (def.text && typeof r.text === "string") {
    node.text = r.text.slice(0, LIMITS.text);
    checkValue(node.text, `${where} text`, problems, "text");
  }
  if (r.props && typeof r.props === "object") {
    const props: Record<string, string | number | boolean> = {};
    for (const p of def.props) {
      const v = (r.props as Record<string, unknown>)[p.name];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "string") {
        const s = v.slice(0, 600);
        if (p.kind === "icon" && !s.startsWith("=") && !s.includes("{") && !ICONS.has(s)) { problems.push(`${where}: unknown icon "${s}"`); continue; }
        if (p.kind === "slot" && !SLOT_SET.has(s)) { problems.push(`${where}: unknown app part "${s}"`); continue; }
        if (p.kind === "select" && !s.startsWith("=") && p.options && !p.options.includes(s)) { problems.push(`${where}: ${p.name} must be one of ${p.options.join(", ")}`); continue; }
        if (p.kind === "color" && !s.startsWith("=") && !COLOR_RE.test(s)) { problems.push(`${where}: ${p.name} is not a colour`); continue; }
        if (p.kind === "image") { const e = checkImageSrc(s); if (e) { problems.push(`${where}: ${p.name}: ${e}`); continue; } }
        checkValue(s, `${where} ${p.name}`, problems, p.kind === "text" ? "text" : "value");
        if (p.kind === "expr" && !s.startsWith("=")) { const e = checkExpr(s); if (e) { problems.push(`${where} ${p.name}: ${e}`); continue; } }
        props[p.name] = s;
      } else if (typeof v === "number" && Number.isFinite(v) && (p.kind === "number" || p.kind === "expr")) {
        props[p.name] = Math.max(-10000, Math.min(10000, v));
      } else if (typeof v === "boolean" && (p.kind === "bool" || p.kind === "expr")) {
        props[p.name] = v;
      }
    }
    if (Object.keys(props).length) node.props = props;
  }
  if (r.style && typeof r.style === "object") {
    const style: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(r.style as Record<string, unknown>)) {
      if (!STYLE_SET.has(k)) continue;
      if (typeof v === "number" && Number.isFinite(v)) style[k] = Math.max(-10000, Math.min(10000, v));
      else if (typeof v === "boolean") style[k] = v;
      else if (typeof v === "string" && v.length <= 300) {
        if (v.startsWith("=")) { const e = checkExpr(v.slice(1)); if (e) { problems.push(`${where} style.${k}: ${e}`); continue; } }
        else if ((k === "bg" || k === "fg") && !COLOR_RE.test(v)) { problems.push(`${where} style.${k}: not a colour`); continue; }
        style[k] = v;
      }
    }
    if (Object.keys(style).length) node.style = style;
  }
  const enter = (r.anim as { enter?: Record<string, unknown> } | undefined)?.enter;
  if (enter && typeof enter === "object") {
    const type = typeof enter.type === "string" && (ANIM_TYPES as readonly string[]).includes(enter.type) ? enter.type : "fade";
    const e: NonNullable<NonNullable<ANode["anim"]>["enter"]> = { type };
    if (typeof enter.ms === "number") e.ms = Math.max(0, Math.min(5000, Math.round(enter.ms)));
    if (typeof enter.delay === "number") e.delay = Math.max(0, Math.min(5000, Math.round(enter.delay)));
    if (typeof enter.easing === "string" && (EASINGS as readonly string[]).includes(enter.easing)) e.easing = enter.easing;
    node.anim = { enter: e };
  }
  for (const key of ["if", "each"] as const) {
    if (typeof r[key] === "string" && (r[key] as string).trim()) {
      const src = (r[key] as string).trim().slice(0, 600);
      const e = checkExpr(src);
      if (e) problems.push(`${where} ${key}: ${e}`);
      else node[key] = src;
    }
  }
  if (node.each) node.as = typeof r.as === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(r.as) ? r.as : "item";
  if (r.on && typeof r.on === "object") {
    const on: NonNullable<ANode["on"]> = {};
    for (const [ev, h] of Object.entries(r.on as Record<string, unknown>)) {
      if (!(EVENTS as readonly string[]).includes(ev) || !h || typeof h !== "object") continue;
      const action = (h as { action?: unknown }).action;
      if (typeof action !== "string" || !ACTION_SET.has(action)) { problems.push(`${where} on.${ev}: unknown action "${String(action)}"`); continue; }
      const arg = (h as { arg?: unknown }).arg;
      const handler: { action: string; arg?: string } = { action };
      if (typeof arg === "string" && arg) { handler.arg = arg.slice(0, 600); checkValue(handler.arg, `${where} on.${ev}`, problems, "text"); }
      { const e = checkActionArg(action, handler.arg ?? ""); if (e) { problems.push(`${where} on.${ev}: ${e}`); continue; } }
      on[ev] = handler;
    }
    if (Object.keys(on).length) node.on = on;
  }
  if (def.container && Array.isArray(r.children)) {
    const kids = r.children.map((c, i) => sanitizeNode(c, `${where}[${i}]`, problems, ctx, depth + 1)).filter((c): c is ANode => c !== null);
    if (kids.length) node.children = kids;
  }
  return node;
}

export function sanitizeScreen(raw: unknown, id: string, problems: string[]): ANode | null {
  return sanitizeNode(raw, id, problems, { count: 0, ids: new Set() }, 0);
}

function sanitizeAnim(raw: unknown, dflt: AnimSpec): AnimSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AnimSpec>;
  return {
    type: typeof r.type === "string" && (ANIM_TYPES as readonly string[]).includes(r.type) ? r.type : dflt.type,
    ms: typeof r.ms === "number" && Number.isFinite(r.ms) ? Math.max(0, Math.min(3000, Math.round(r.ms))) : dflt.ms,
    easing: typeof r.easing === "string" && (EASINGS as readonly string[]).includes(r.easing) ? r.easing : dflt.easing,
    ...(typeof (r.delay ?? dflt.delay) === "number" ? { delay: Math.max(0, Math.min(1000, Math.round((r.delay ?? dflt.delay) as number))) } : {}),
  };
}

export function sanitizeDesign(raw: unknown): AndroidDesign {
  const problems: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AndroidDesign>;
  const d = DEFAULT_DESIGN;

  const appName = typeof r.app?.name === "string" && r.app.name.trim() ? r.app.name.trim().slice(0, 40) : d.app.name;

  const theme: Theme = structuredClone(d.theme);
  const t = (r.theme ?? {}) as Partial<Theme>;
  for (const tone of ["light", "dark"] as const) {
    const src = (t[tone] ?? {}) as Record<string, unknown>;
    for (const token of COLOR_TOKENS) {
      const v = src[token];
      if (typeof v === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) theme[tone][token] = v.toLowerCase();
      else if (v !== undefined) problems.push(`theme.${tone}.${token}: not a colour`);
    }
  }
  if (typeof t.radius === "number") theme.radius = Math.max(0, Math.min(40, Math.round(t.radius)));
  if (t.font === "sans" || t.font === "serif" || t.font === "mono") theme.font = t.font;
  if (t.density === "compact" || t.density === "normal" || t.density === "comfortable") theme.density = t.density;

  const a = (r.animations ?? {}) as Partial<Animations>;
  const animations: Animations = {
    screen: sanitizeAnim(a.screen, d.animations.screen),
    dialog: sanitizeAnim(a.dialog, d.animations.dialog),
    message: sanitizeAnim(a.message, d.animations.message),
    list: sanitizeAnim(a.list, d.animations.list),
    flash: { ...sanitizeAnim(a.flash, d.animations.flash), stay: typeof a.flash?.stay === "number" ? Math.max(1000, Math.min(20000, Math.round(a.flash.stay))) : d.animations.flash.stay },
    users: sanitizeAnim(a.users, d.animations.users),
    splash: {
      style: a.splash?.style === "pulse" || a.splash?.style === "reveal" || a.splash?.style === "none" || a.splash?.style === "orbit" ? a.splash.style : d.animations.splash.style,
      ms: typeof a.splash?.ms === "number" ? Math.max(300, Math.min(4000, Math.round(a.splash.ms))) : d.animations.splash.ms,
      minMs: typeof a.splash?.minMs === "number" ? Math.max(0, Math.min(3000, Math.round(a.splash.minMs))) : d.animations.splash.minMs,
    },
  };

  const screens: Record<string, ANode> = {};
  for (const id of SCREEN_IDS) {
    const src = (r.screens as Record<string, unknown> | undefined)?.[id];
    const node = src === undefined ? structuredClone(d.screens[id]) : sanitizeScreen(src, id, problems);
    screens[id] = node ?? structuredClone(d.screens[id]);
  }

  const menus: Record<string, MenuItem[]> = {};
  const rawMenus = (r.menus ?? d.menus) as Record<string, unknown>;
  for (const [menuId, items] of Object.entries(rawMenus)) {
    if (!ID_RE.test(menuId) || !Array.isArray(items)) continue;
    menus[menuId] = items.slice(0, LIMITS.menuItems).flatMap((it, i): MenuItem[] => {
      const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
      const action = typeof o.action === "string" ? o.action : "";
      if (!ACTION_SET.has(action)) { problems.push(`menus.${menuId}[${i}]: unknown action "${action}"`); return []; }
      const icon = typeof o.icon === "string" && ICONS.has(o.icon) ? o.icon : "circle";
      const label = typeof o.label === "string" ? o.label.slice(0, 200) : "";
      checkValue(label, `menus.${menuId}[${i}] label`, problems, "text");
      const item: MenuItem = { id: typeof o.id === "string" && ID_RE.test(o.id) ? o.id : `item-${i}`, icon, label, action };
      if (typeof o.arg === "string" && o.arg) item.arg = o.arg.slice(0, 300);
      { const e = checkActionArg(action, item.arg ?? ""); if (e) { problems.push(`menus.${menuId}[${i}]: ${e}`); return []; } }
      if (typeof o.if === "string" && o.if.trim()) { const e = checkExpr(o.if); if (e) problems.push(`menus.${menuId}[${i}] if: ${e}`); else item.if = o.if.trim(); }
      return [item];
    });
  }
  for (const [id, items] of Object.entries(d.menus)) if (!menus[id]) menus[id] = structuredClone(items);

  const strings: Record<string, Record<string, string>> = {};
  const rawStrings = (r.strings ?? {}) as Record<string, unknown>;
  for (const lang of LANGS) {
    strings[lang] = { ...d.strings[lang] };
    const src = rawStrings[lang];
    if (src && typeof src === "object") {
      let n = 0;
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (++n > LIMITS.strings) break;
        if (/^[a-zA-Z0-9_.-]{1,80}$/.test(k) && typeof v === "string") strings[lang][k] = v.slice(0, 1000);
      }
    }
  }

  const libraries: Record<string, Library> = {};
  const rawLibs = (r.libraries ?? d.libraries) as Record<string, unknown>;
  for (const [name, lib] of Object.entries(rawLibs).slice(0, LIMITS.libraries)) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || !lib || typeof lib !== "object") { problems.push(`libraries.${name}: bad name`); continue; }
    const l = lib as Partial<Library>;
    const steps = (Array.isArray(l.steps) ? l.steps : []).slice(0, LIMITS.steps).flatMap((s, i): LibStep[] => {
      const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      if (typeof o.do !== "string" || !ACTION_SET.has(o.do) || o.do === "lib.run") { problems.push(`libraries.${name}[${i}]: unknown or nested action "${String(o.do)}"`); return []; }
      const step: LibStep = { do: o.do };
      if (typeof o.arg === "string" && o.arg) { step.arg = o.arg.slice(0, 600); checkValue(step.arg, `libraries.${name}[${i}] arg`, problems, "text"); }
      { const e = checkActionArg(o.do, step.arg ?? ""); if (e) { problems.push(`libraries.${name}[${i}]: ${e}`); return []; } }
      if (typeof o.if === "string" && o.if.trim()) { const e = checkExpr(o.if); if (e) problems.push(`libraries.${name}[${i}] if: ${e}`); else step.if = o.if.trim(); }
      return [step];
    });
    libraries[name] = { description: typeof l.description === "string" ? l.description.slice(0, 300) : "", steps };
  }

  const assets: Record<string, Asset> = {};
  let total = 0;
  for (const [name, asset] of Object.entries((r.assets ?? {}) as Record<string, unknown>)) {
    const o = (asset && typeof asset === "object" ? asset : {}) as Partial<Asset>;
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(name) || typeof o.data !== "string" || typeof o.mime !== "string" || !/^image\/(png|webp|jpeg|gif)$|^font\/(ttf|otf)$/.test(o.mime)) { problems.push(`assets.${name}: not an image or font`); continue; }
    const size = Math.floor((o.data.length * 3) / 4);
    if (size > LIMITS.asset) { problems.push(`assets.${name}: larger than ${LIMITS.asset / 1024} kB`); continue; }
    if ((total += size) > LIMITS.assets) { problems.push(`assets: more than ${LIMITS.assets / 1024 / 1024} MB together`); break; }
    assets[name] = { mime: o.mime, data: o.data };
  }

  if (problems.length) throw new DesignError(problems);
  return {
    format: 1, app: { name: appName }, theme, animations, screens, menus, strings, libraries, assets,
    rev: typeof r.rev === "string" ? r.rev.slice(0, 40) : "",
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    updatedBy: typeof r.updatedBy === "string" ? r.updatedBy.slice(0, 120) : "",
  };
}

/** A fingerprint of the content (what a build records as its design). */
export function designRev(d: AndroidDesign): string {
  const { rev: _rev, updatedAt: _at, updatedBy: _by, ...content } = d;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
}

/* ================================================================ storage */

const designFile = () => join(androidDir(), "design.json");
let cachedDesign: AndroidDesign | null = null;

/** 6.7: why the saved design was not used (it no longer passes the checks — e.g. the F-01 URL rules), or null. */
let designProblem: string | null = null;
export const savedDesignProblem = (): string | null => (androidDesign(), designProblem);

export function androidDesign(): AndroidDesign {
  if (cachedDesign) return cachedDesign;
  let text: string | null = null;
  try { text = readFileSync(designFile(), "utf8"); } catch { /* none saved: the default */ }
  try {
    cachedDesign = text === null ? { ...structuredClone(DEFAULT_DESIGN), rev: designRev(DEFAULT_DESIGN) } : sanitizeDesign(JSON.parse(text));
    designProblem = null;
  } catch (err) {
    // A saved design the checks now refuse is not used — said loudly, not silently: the
    // operator re-saves it in the console after fixing what the message names.
    designProblem = (err as Error).message || "the saved design does not pass the checks";
    console.warn(`[android] the saved design is not used, the default is: ${designProblem}`);
    cachedDesign = { ...structuredClone(DEFAULT_DESIGN), rev: designRev(DEFAULT_DESIGN) };
  }
  return cachedDesign;
}

export function saveAndroidDesign(raw: unknown, by: string): AndroidDesign {
  const clean = sanitizeDesign(raw);
  clean.rev = designRev(clean);
  clean.updatedAt = Date.now();
  clean.updatedBy = by;
  const file = designFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cachedDesign = clean;
  return clean;
}

export function forgetAndroidDesign(): void { cachedDesign = null; }

/** What the console's Android builder needs to know. */
export function androidCatalog() {
  return {
    elements: ELEMENTS, style: STYLE_PROPS, colors: COLOR_TOKENS, anims: ANIM_TYPES, easings: EASINGS, events: EVENTS,
    actions: ACTIONS, slots: SLOTS, screens: SCREENS, langs: LANGS, icons: MENU_ICONS, limits: LIMITS,
    defaults: DEFAULT_DESIGN,
  };
}
