// 6.8 design area: the app's calls in the phone's own call log, and the
// app's own log of calls and messages across all rooms.
// One area of the 6.8 design (design-68.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
//   log              the app's own log ("Záznam" / "History" / "Verlauf"):
//                    calls and messages of every saved room in one list,
//                    newest first, with a filter (all / calls / messages /
//                    missed) and a search; a tap opens the room (and scrolls
//                    to the message), the phone button calls the room again
//                    after a confirmation. $log is built by the app
//                    (ui/parts/CallLogUi.java): calls from its encrypted call
//                    history (chat/CallHistory.java, at most 500 / 90 days),
//                    messages from the rooms' own histories — a sealed,
//                    hold-to-read, vanishing or hidden message shows only its
//                    kind, never its text
//   rooms            an icon in the bar opens it; the main menu too
//   settings.calls   the phone's call log: what an entry is named (only the
//                    app's name by default — any app allowed to read the call
//                    log reads it; while the app is locked always only that),
//                    the permission, removing the app's entries; the app's
//                    own call history: keep it, open the log, clear it
//
// Java: chat/CallTrack (incoming / outgoing / missed / declined, one record per
// call), chat/CallHistory, chat/ActivityLog (the merge, filter and search),
// telecom/CallLogBridge (the phone's call log, never a dialable number),
// telecom/CallRing (a call starting in a room: Join / Decline, then missed),
// telecom/M5ConnectionService (the self-managed account the entries name),
// ui/parts/CallLogUi (the actions and $log).

import type { ANode, MenuItem, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

/* =============================================================== screens */

const SAMPLE_ITEMS = [
  { id: "c:k3f9", type: "call", dir: "missed", icon: "phone-off", color: "@danger", room: "Tým", people: "Alice", time: 1760900000000, day: "Dnes", newDay: true, detail: "Zmeškaný · Alice", callable: true, video: false },
  { id: "m:1a2b:m-77", type: "msg", dir: "in", icon: "message-circle", color: "@muted", room: "Tým", people: "Alice", time: 1760899000000, day: "Dnes", newDay: false, detail: "Alice: Zavoláme se po obědě?", callable: false, video: false },
  { id: "c:k3f2", type: "call", dir: "out", icon: "video", color: "@primary", room: "Rodina", people: "Bob, Eva", time: 1760810000000, day: "Včera", newDay: true, detail: "Odchozí · video · 12:04 · Bob, Eva", callable: true, video: true },
  { id: "m:9c8d:m-12", type: "msg", dir: "in", icon: "message-square-lock", color: "@muted", room: "Rodina", people: "Eva", time: 1760800000000, day: "Včera", newDay: false, detail: "Eva: Zapečetěná zpráva", callable: false, video: false },
];

const SCREENS: ScreenDef[] = [
  {
    id: "log", label: "History (calls and messages)", group: "app", vars: ["$log", "$form", "$settings"],
    sample: {
      log: { loading: false, empty: false, count: 4, shown: 4, more: false, history: true, items: SAMPLE_ITEMS },
      form: { logFilter: "all", logQuery: "" },
      settings: { callLog: false, calls: { history: true, logName: "app" } },
    },
    help: "Calls and messages of every saved room, newest first: a filter (all / calls / messages / missed), a search, a tap opens the room, the phone button calls again after a confirmation. Sealed, hold-to-read, vanishing and hidden messages show only their kind.",
  },
];

/* ================================================================= trees */

const FILTERS = "all:{_'log.filter.all'}|calls:{_'log.filter.calls'}|messages:{_'log.filter.messages'}|missed:{_'log.filter.missed'}";

/** One entry: its icon (kind and direction), the room, the time, a line of detail, calling again. */
const ITEM: ANode = n("item", "column", { each: "$log.items", as: "it" }, [
  n("item-day", "text", { if: "$it.newDay", text: "{$it.day}", props: { variant: "label" }, style: { fg: "@primary", bold: true, padding: "14 20 4 20" } }),
  n("item-row", "row", { style: { padding: "10 8 10 20", gap: 14, align: "center" }, on: click("calllog.item", "{$it.id}") }, [
    n("item-icon", "icon", { props: { icon: "=$it.icon", size: 22, color: "=$it.color" } }),
    n("item-col", "column", { style: { weight: 1, gap: 2 } }, [
      n("item-head", "row", { style: { gap: 8, align: "center" } }, [
        n("item-room", "text", { text: "{$it.room}", style: { size: 16, bold: true, weight: 1, lines: 1 } }),
        n("item-time", "text", { text: "{$it.time|time}", props: { variant: "caption" }, style: { fg: "@muted" } }),
      ]),
      n("item-detail", "text", { text: "{$it.detail}", props: { variant: "caption" }, style: { fg: "=$it.dir == 'missed' ? '@danger' : '@muted'", lines: 2 } }),
    ]),
    n("item-call", "iconButton", { if: "$it.callable", props: { icon: "=$it.video ? 'video' : 'phone'", label: "{_'log.callBack'}" }, on: click("calllog.call", "{$it.id}") }),
  ]),
]);

const TREE: ANode = n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
  n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
    n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
    n("title", "text", { text: "{_'log.title'}", props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
    n("settings", "iconButton", { props: { icon: "settings", label: "{_'set.calls'}" }, on: click("screen.open", "settings.calls") }),
  ]),
  n("filters", "column", { style: { bg: "@surface", padding: "6 12 10 12", gap: 8 } }, [
    n("filter", "segmented", { props: { bind: "logFilter", options: FILTERS }, on: { change: { action: "calllog.refresh" } } }),
    n("search-row", "row", { style: { gap: 6, align: "center" } }, [
      n("search", "input", { props: { bind: "logQuery", hint: "{_'log.search'}" }, style: { weight: 1 }, on: { submit: { action: "calllog.refresh" } } }),
      n("search-go", "iconButton", { props: { icon: "search", label: "{_'log.searchGo'}" }, on: click("calllog.refresh") }),
    ]),
  ]),
  n("scroll", "scroll", { style: { weight: 1 } }, [n("list", "column", { style: { padding: "0 0 24 0" } }, [
    n("loading", "row", { if: "$log.loading", style: { padding: 20, gap: 12, align: "center" } }, [
      n("loading-bar", "progress", { style: { width: 24 } }),
      n("loading-text", "text", { text: "{_'log.loading'}", style: { fg: "@muted", weight: 1 } }),
    ]),
    n("empty", "text", { if: "$log.empty && !$log.loading", text: "{=$form.logQuery || $form.logFilter && $form.logFilter != 'all' ? _('log.noMatch') : _('log.empty')}", props: { align: "center" }, style: { fg: "@muted", padding: "32 24" } }),
    n("off", "text", { if: "!$log.history", text: "{_'log.historyOff'}", props: { variant: "caption" }, style: { fg: "@warning", padding: "10 20 0 20" } }),
    ITEM,
    n("more", "text", { if: "$log.more", text: "{_'log.limit'} ({$log.shown} / {$log.count})", props: { variant: "caption", align: "center" }, style: { fg: "@muted", padding: "12 24" } }),
  ])]),
]);

/* ================================================================ patches */

const find = (node: ANode, id: string): ANode | null => {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
};

/** The node whose children hold the one with this id (or null). */
const parentOf = (node: ANode, id: string): ANode | null => {
  for (const c of node.children ?? []) {
    if (c.id === id) return node;
    const f = parentOf(c, id);
    if (f) return f;
  }
  return null;
};

const insert = (parent: ANode, at: { after?: string; before?: string }, nodes: ANode[]): void => {
  const kids = parent.children ?? [];
  const i = kids.findIndex((k) => k.id === (at.after ?? at.before));
  kids.splice(i < 0 ? kids.length : at.after ? i + 1 : i, 0, ...nodes);
  parent.children = kids;
};

const section = (id: string, key: string): ANode => n(id, "text", { text: `{_'${key}'}`, props: { variant: "label" }, style: { fg: "@primary", padding: "18 20 6 20", bold: true } });
const hint = (id: string, key: string, cond?: string): ANode => n(id, "text", { ...(cond ? { if: cond } : {}), text: `{_'${key}'}`, props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 64" } });
const actRow = (id: string, icon: string, key: string, action: string, arg?: string, color?: string, cond?: string): ANode => n(id, "row", { ...(cond ? { if: cond } : {}), style: { padding: "14 20", gap: 18, align: "center" }, on: click(action, arg) }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: color ?? "@muted" } }),
  n(`${id}-label`, "text", { text: `{_'${key}'}`, style: { size: 16, weight: 1, ...(color ? { fg: color } : {}) } }),
]);
const toggleRow = (id: string, icon: string, key: string, setting: string): ANode => n(id, "row", { style: { padding: "10 12 10 20", gap: 18, align: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-label`, "text", { text: `{_'${key}'}`, style: { size: 16, weight: 1 } }),
  n(`${id}-switch`, "switch", { props: { setting } }),
]);
const NAMES = "app:{_'calllog.name.app'}|room:{_'calllog.name.room'}|people:{_'calllog.name.people'}";

/** Settings › Calls: the phone's call log (naming, permission, removal) and the app's own call history. */
function callSettings(): ANode[] {
  return [
    hint("calllog-hint", "calllog.hint"),
    n("calllog-name", "row", { if: "$settings.callLog", style: { padding: "8 16 8 20", gap: 18, align: "center" } }, [
      n("calllog-name-icon", "icon", { props: { icon: "eye", size: 22, color: "@muted" } }),
      n("calllog-name-label", "text", { text: "{_'calllog.name'}", style: { size: 16, weight: 1 } }),
      n("calllog-name-select", "select", { props: { setting: "calls.logName", options: NAMES }, style: { maxWidth: 200 } }),
    ]),
    hint("calllog-name-hint", "calllog.name.hint", "$settings.callLog"),
    actRow("calllog-perm", "shield", "calllog.perm", "system.settings", "app"),
    actRow("calllog-erase", "eraser", "calllog.erase", "calllog.system"),
    section("history-section", "log.title"),
    toggleRow("history-keep", "rotate-ccw-clock", "log.keep", "calls.history"),
    hint("history-hint", "log.keep.hint"),
    actRow("history-open", "list", "log.open", "calllog.open"),
    actRow("history-clear", "trash", "log.clear", "calllog.clear", undefined, "@danger"),
  ];
}

function patch(screens: Record<string, ANode>): void {
  // Rooms: the log's icon in the bar, before "join a room".
  const rooms = screens.rooms;
  const bar = rooms ? find(rooms, "bar") : null;
  if (bar && !find(rooms, "log")) {
    insert(bar, { before: "add" }, [n("log", "iconButton", { props: { icon: "rotate-ccw-clock", label: "{_'log.title'}" }, on: click("calllog.open") })]);
  }
  // Settings › Calls: under the call log's switch.
  const calls = screens["settings.calls"];
  if (calls && !find(calls, "calllog-hint")) {
    const parent = parentOf(calls, "log") ?? find(calls, "list");
    if (parent) insert(parent, { after: "log" }, callSettings());
  }
}

const MENU_ITEM: MenuItem = { id: "log", icon: "rotate-ccw-clock", label: "{_'log.title'}", action: "calllog.open" };

function patchMenus(menus: Record<string, MenuItem[]>): void {
  const items = menus.main;
  if (!items || items.some((it) => it.id === MENU_ITEM.id)) return;
  const i = items.findIndex((it) => it.id === "settings");
  items.splice(i < 0 ? 0 : i + 1, 0, { ...MENU_ITEM });
}

/* =============================================================== strings */

const S = (cs: string, en: string, de: string) => ({ cs, en, de });
const STR: Record<string, { cs: string; en: string; de: string }> = {
  // The app's own log (screen "log")
  "log.title": S("Záznam", "History", "Verlauf"),
  "log.open": S("Záznam hovorů a zpráv", "History of calls and messages", "Verlauf von Anrufen und Nachrichten"),
  "log.filter.all": S("Vše", "All", "Alle"),
  "log.filter.calls": S("Hovory", "Calls", "Anrufe"),
  "log.filter.messages": S("Zprávy", "Messages", "Nachrichten"),
  "log.filter.missed": S("Zmeškané", "Missed", "Verpasst"),
  "log.search": S("Hledat místnost, člověka nebo text", "Search a room, a person or text", "Raum, Person oder Text suchen"),
  "log.searchGo": S("Hledat", "Search", "Suchen"),
  "log.loading": S("Načítám záznam…", "Loading the history…", "Lade den Verlauf…"),
  "log.empty": S("Zatím tu nic není.", "Nothing here yet.", "Noch nichts hier."),
  "log.noMatch": S("Nic tomu neodpovídá.", "Nothing matches.", "Nichts passt dazu."),
  "log.limit": S("Ukazuji nejnovější — zužte výběr filtrem nebo hledáním", "Showing the newest — narrow it with the filter or the search", "Die neuesten — grenzen Sie mit dem Filter oder der Suche ein"),
  "log.historyOff": S("Historie hovorů se neukládá (Nastavení › Hovory) — vidíte jen zprávy a dřív uložené hovory.", "The call history is not kept (Settings › Calls) — you see messages and the calls kept before.", "Der Anrufverlauf wird nicht gespeichert (Einstellungen › Anrufe) — Sie sehen Nachrichten und früher gespeicherte Anrufe."),
  "log.today": S("Dnes", "Today", "Heute"),
  "log.yesterday": S("Včera", "Yesterday", "Gestern"),
  "log.dir.in": S("Příchozí", "Incoming", "Eingehend"),
  "log.dir.out": S("Odchozí", "Outgoing", "Ausgehend"),
  "log.dir.missed": S("Zmeškaný", "Missed", "Verpasst"),
  "log.dir.declined": S("Odmítnutý", "Declined", "Abgelehnt"),
  "log.video": S("video", "video", "Video"),
  "log.nobody": S("nikdo nepřišel", "nobody came", "niemand kam"),
  "log.me": S("Já", "Me", "Ich"),
  "log.kind.sealed": S("Zapečetěná zpráva", "Sealed message", "Versiegelte Nachricht"),
  "log.kind.tap": S("Zpráva „podržet a číst“", "\"Hold to read\" message", "Nachricht „zum Lesen halten“"),
  "log.kind.vanish": S("Mizející zpráva", "Vanishing message", "Verschwindende Nachricht"),
  "log.kind.hidden": S("Skrytá zpráva", "Hidden message", "Ausgeblendete Nachricht"),
  "log.kind.file": S("Soubor", "File", "Datei"),
  "log.callBack": S("Zavolat znovu", "Call again", "Erneut anrufen"),
  "log.callAsk": S("Zavolat do místnosti {room}? Hovor uslyší všichni, kdo jsou v ní připojení.", "Call the room {room}? Everyone connected there hears the call.", "Im Raum {room} anrufen? Alle, die dort verbunden sind, hören den Anruf."),
  "log.call.audio": S("Zavolat", "Call", "Anrufen"),
  "log.call.video": S("S videem", "With video", "Mit Video"),
  "log.gone": S("Tuto místnost už aplikace nemá uloženou.", "This room is no longer saved in the app.", "Dieser Raum ist in der App nicht mehr gespeichert."),
  "log.keep": S("Ukládat historii hovorů", "Keep a call history", "Anrufverlauf speichern"),
  "log.keep.hint": S("Zašifrovaně jen v tomto telefonu — nejvýš 500 hovorů z posledních 90 dní. Vypnutím se další hovory přestanou ukládat; uložené smažete níže. Zprávy bere Záznam z historie místností.", "Encrypted, on this phone only — at most 500 calls of the last 90 days. Off: no more calls are kept; delete those kept below. Messages come from the rooms' own histories.", "Verschlüsselt, nur auf diesem Telefon — höchstens 500 Anrufe der letzten 90 Tage. Aus: keine weiteren Anrufe werden gespeichert; die gespeicherten löschen Sie unten. Nachrichten kommen aus dem Verlauf der Räume."),
  "log.clear": S("Smazat historii hovorů", "Clear the call history", "Anrufverlauf löschen"),
  "log.clearAsk": S("Smazat historii hovorů aplikace v tomto telefonu? Zprávy v místnostech zůstanou.", "Delete the app's call history on this phone? The rooms' messages stay.", "Den Anrufverlauf der App auf diesem Telefon löschen? Die Nachrichten der Räume bleiben."),
  "log.cleared": S("Historie hovorů je smazaná.", "The call history is deleted.", "Der Anrufverlauf ist gelöscht."),
  // The phone's call log (Settings › Calls)
  "calllog.hint": S("Hovory z místností se zapíšou do záznamu hovorů telefonu: příchozí, odchozí, zmeškané i odmítnuté, s časem, délkou a příznakem videa. Ten záznam čte každá aplikace s oprávněním k seznamu hovorů. Položka nemá číslo — z aplikace Telefon ji nejde vytočit; zavolat znovu jde ze Záznamu v této aplikaci.", "Calls of the rooms go into the phone's call log: incoming, outgoing, missed and declined, with their time, length and whether they had video. Any app allowed to read the call log reads it. An entry has no number — the Phone app cannot dial it; call again from the History in this app.", "Anrufe der Räume kommen in die Anrufliste des Telefons: eingehend, ausgehend, verpasst und abgelehnt, mit Zeit, Dauer und ob mit Video. Jede App mit Zugriff auf die Anrufliste liest sie. Ein Eintrag hat keine Nummer — die Telefon-App kann ihn nicht wählen; erneut anrufen geht aus dem Verlauf in dieser App."),
  "calllog.name": S("Položka v záznamu ukáže", "An entry shows", "Ein Eintrag zeigt"),
  "calllog.name.app": S("jen jméno aplikace", "only the app's name", "nur den Namen der App"),
  "calllog.name.room": S("i místnost", "the room too", "auch den Raum"),
  "calllog.name.people": S("místnost a lidi", "the room and the people", "Raum und Personen"),
  "calllog.name.hint": S("Dokud je aplikace zamčená, zapíše se vždy jen jméno aplikace. Některé aplikace Telefon jméno neukážou a napíšou „Neznámé“ (s ikonou této aplikace).", "While the app is locked, only the app's name is ever written. Some Phone apps do not show the name and say \"Unknown\" (with this app's icon).", "Solange die App gesperrt ist, wird immer nur der Name der App geschrieben. Manche Telefon-Apps zeigen den Namen nicht und schreiben „Unbekannt“ (mit dem Symbol dieser App)."),
  "calllog.perm": S("Oprávnění aplikace v telefonu", "The app's permissions on the phone", "Berechtigungen der App im Telefon"),
  "calllog.denied": S("Bez oprávnění k seznamu hovorů to nejde. Povolte ho v nastavení telefonu: Aplikace › M5cet › Oprávnění › Seznam hovorů.", "Not without the call log permission. Allow it in the phone's settings: Apps › M5cet › Permissions › Call logs.", "Nicht ohne die Berechtigung für die Anrufliste. Erlauben Sie sie in den Telefoneinstellungen: Apps › M5cet › Berechtigungen › Anruflisten."),
  "calllog.erase": S("Odebrat hovory této aplikace ze záznamu telefonu", "Remove this app's calls from the phone's call log", "Anrufe dieser App aus der Anrufliste entfernen"),
  "calllog.eraseAsk": S("Odebrat ze záznamu hovorů telefonu všechny hovory, které tam zapsala tato aplikace?", "Remove from the phone's call log every call this app wrote there?", "Alle Anrufe, die diese App in die Anrufliste des Telefons geschrieben hat, entfernen?"),
  "calllog.erased": S("Odebráno ze záznamu telefonu: {n}", "Removed from the phone's call log: {n}", "Aus der Anrufliste entfernt: {n}"),
  "calllog.eraseNeedsPerm": S("Odebrat je jde jen s oprávněním k seznamu hovorů.", "Removing them needs the call log permission.", "Zum Entfernen braucht es die Berechtigung für die Anrufliste."),
  // A call starting in a room (telecom/CallRing)
  "ring.call": S("Hovor", "Call", "Anruf"),
  "ring.video": S("Videohovor", "Video call", "Videoanruf"),
  "ring.who": S("{name} volá", "{name} is calling", "{name} ruft an"),
  "ring.join": S("Připojit se", "Join", "Beitreten"),
  "ring.decline": S("Odmítnout", "Decline", "Ablehnen"),
  "ring.missed": S("Zmeškaný hovor", "Missed call", "Verpasster Anruf"),
  "ring.missedWho": S("Zmeškaný hovor · {name}", "Missed call · {name}", "Verpasster Anruf · {name}"),
};

export const AREA: DesignArea = {
  actions: [
    { action: "calllog.open", arg: "", help: "The History screen (calls and messages of every room), loaded afresh" },
    { action: "calllog.refresh", arg: "", help: "Apply $form.logFilter (all | calls | messages | missed) and $form.logQuery to the History" },
    { action: "calllog.item", arg: "entry id", help: "Open an entry's room (a message: scrolled to it)" },
    { action: "calllog.call", arg: "entry id", help: "Call an entry's room again — after a confirmation, never at once" },
    { action: "calllog.clear", arg: "", help: "Delete the app's call history on this phone (asks first; messages stay)" },
    { action: "calllog.system", arg: "", help: "Remove every call this app wrote into the phone's call log (asks first)" },
  ],
  screens: SCREENS,
  trees: { log: TREE },
  strings: {
    cs: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.cs])),
    en: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.en])),
    de: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.de])),
  },
  patch,
  patchMenus,
};
