// 6.8 design area: rooms as Android conversations — conversation shortcuts
// for the rooms (the system's Conversations section, the widget, direct
// share), bubbles, and what the person decides about them in the settings.
// One area of the 6.8 design (design-68.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
// The app (telecom/Conversations.java, ConversationPlan.java) makes every
// joined room a long-lived conversation shortcut: the notifications'
// Conversations section (priority, the Conversation widget), the share
// sheet's top row (shared text lands in the room's message field, not sent)
// and the app icon's long press. Settings › Notifications gets a section:
// on / off ("conversations.on"; off removes them) and whether they carry the
// room's name ("conversations.names") — only ever while the app is unlocked
// and notifications may name the room, else "Conversation 1, 2…". The room's
// menu opens the phone's settings of that room as a conversation (priority…)
// — the action "conversations.settings", which makes a design need app 6.8.
// No bubbles: they need an embeddable activity of their own, the app has one
// activity carrying the lock and every screen.

import type { ANode, MenuItem } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });

const ON = "$settings.conversations.on";

const section = (id: string, key: string) => n(id, "text", { text: `{_'${key}'}`, props: { variant: "label" }, style: { fg: "@primary", padding: "18 20 6 20", bold: true } });
const hint = (id: string, key: string, cond?: string) => n(id, "text", { ...(cond ? { if: cond } : {}), text: `{_'${key}'}`, props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 64" } });
const toggleRow = (id: string, icon: string, key: string, setting: string, cond?: string): ANode => n(id, "row", { ...(cond ? { if: cond } : {}), style: { padding: "10 12 10 20", gap: 18, align: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-label`, "text", { text: `{_'${key}'}`, style: { size: 16, weight: 1 } }),
  n(`${id}-switch`, "switch", { props: { setting } }),
]);

/** Settings › Notifications, after Privacy: the switch, the names, what it means. */
export const CONVERSATION_ROWS: ANode[] = [
  section("s-conversations", "conversations.section"),
  toggleRow("conversations", "messages-square", "conversations.on", "conversations.on"),
  hint("conversations-hint", "conversations.hint"),
  toggleRow("conversations-names", "eye", "conversations.names", "conversations.names", ON),
  hint("conversations-names-hint", "conversations.names.hint", ON),
];

/** The room's menu: the phone's settings of this room as a conversation (before Leave). */
export const ROOM_MENU_ITEM: MenuItem = { id: "conversation", icon: "messages-square", label: "{_'conversations.room'}", action: "conversations.settings", arg: "room", if: ON };

/** Puts `add` after the node `id` (anywhere in the tree); false when there is none. */
function insertAfter(node: ANode, id: string, add: ANode[]): boolean {
  const kids = node.children ?? [];
  const i = kids.findIndex((k) => k.id === id);
  if (i >= 0) { kids.splice(i + 1, 0, ...add.map((a) => structuredClone(a))); return true; }
  return kids.some((k) => insertAfter(k, id, add));
}

function findById(node: ANode, id: string): ANode | undefined {
  if (node.id === id) return node;
  for (const k of node.children ?? []) { const f = findById(k, id); if (f) return f; }
  return undefined;
}

const S = (cs: string, en: string, de: string) => ({ cs, en, de });
const STR: Record<string, { cs: string; en: string; de: string }> = {
  "conversations.section": S("Konverzace v Androidu", "Android conversations", "Android-Unterhaltungen"),
  "conversations.on": S("Místnosti jako konverzace Androidu", "Rooms as Android conversations", "Räume als Android-Unterhaltungen"),
  "conversations.hint": S(
    "Připojené místnosti se ukážou v sekci Konverzace v oznámeních, v horní řadě nabídky Sdílet (sdílený text se vloží do pole zprávy, sám se neodešle) a po podržení ikony aplikace. Konverzaci pak můžete označit jako prioritní nebo ji dát na plochu jako widget. Vypnutím se všechny odeberou.",
    "Joined rooms show in the Conversations section of notifications, in the top row of the Share sheet (shared text goes into the message field and is not sent by itself) and when you hold the app's icon. You can then mark a conversation as priority or put it on the home screen as a widget. Switching this off removes them all.",
    "Verbundene Räume erscheinen im Bereich „Unterhaltungen“ der Benachrichtigungen, in der oberen Reihe des Teilen-Menüs (geteilter Text kommt ins Nachrichtenfeld und wird nicht von selbst gesendet) und beim Halten des App-Symbols. Eine Unterhaltung lässt sich dann als priorisiert markieren oder als Widget auf den Startbildschirm legen. Ausschalten entfernt alle."),
  "conversations.names": S("Ukazovat názvy místností", "Show room names", "Raumnamen anzeigen"),
  "conversations.names.hint": S(
    "Název místnosti systém dostane (plocha, Sdílet, oznámení) jen když je aplikace odemčená a oznámení smí místnost jmenovat (Soukromí výše). Jinak — a jakmile se aplikace zamkne — se konverzace jmenují neutrálně: „Konverzace 1“, „Konverzace 2“… Obsah zpráv ani klíč místnosti v nich nikdy není.",
    "The system (home screen, Share, notifications) gets a room's name only while the app is unlocked and notifications may name the room (Privacy above). Otherwise — and as soon as the app locks — conversations have neutral names: “Conversation 1”, “Conversation 2”… They never hold message content or the room's key.",
    "Das System (Startbildschirm, Teilen, Benachrichtigungen) erhält einen Raumnamen nur, solange die App entsperrt ist und Benachrichtigungen den Raum nennen dürfen (Privatsphäre oben). Sonst — und sobald die App sperrt — heißen Unterhaltungen neutral: „Unterhaltung 1“, „Unterhaltung 2“… Nachrichteninhalte oder der Schlüssel des Raums sind nie darin."),
  "conversations.neutral": S("Konverzace {n}", "Conversation {n}", "Unterhaltung {n}"),
  "conversations.gone": S("Tato místnost už v aplikaci není.", "This room is no longer in the app.", "Dieser Raum ist nicht mehr in der App."),
  "conversations.room": S("Konverzace v telefonu", "Conversation on the phone", "Unterhaltung im Telefon"),
};

export const AREA: DesignArea = {
  actions: [
    { action: "conversations.settings", arg: "room | (empty)", help: "The phone's settings of the room on screen as a conversation — priority, sound (Android 11+; else the messages channel); empty: the app's notification settings" },
  ],
  strings: {
    cs: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.cs])),
    en: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.en])),
    de: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.de])),
  },
  // Settings › Notifications: the section after Privacy (at the end of the list when that is gone).
  patch(screens) {
    const notify = screens["settings.notify"];
    if (!notify || JSON.stringify(notify).includes('"conversations.on"')) return;
    if (insertAfter(notify, "privacy-hint", CONVERSATION_ROWS)) return;
    const list = findById(notify, "list") ?? notify;
    (list.children ??= []).push(...CONVERSATION_ROWS.map((r) => structuredClone(r)));
  },
  // The room's menu: "Conversation on the phone" before Leave.
  patchMenus(menus) {
    const room = menus.room;
    if (!room || room.some((it) => it.id === ROOM_MENU_ITEM.id)) return;
    const i = room.findIndex((it) => it.id === "leave");
    room.splice(i < 0 ? room.length : i, 0, { ...ROOM_MENU_ITEM });
  },
};
