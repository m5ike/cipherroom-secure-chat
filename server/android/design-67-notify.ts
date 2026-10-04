// 6.7 design area: notifications: delivery with fallback, server templates, per-user settings (6.7)
// One area of the 6.7 design (design-67.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
// Settings › Notifications becomes a screen of the design (it used to open
// the phone's own notification settings — still one row on it): on / off,
// which kinds, how much a notification shows (the operator caps it), quiet
// hours, and signed in — whether the server covers for this phone while the
// app is closed (keeps its messages, wakes it), the order of the channels
// the server tries (Android, web push, e-mail) and a test through them. The
// switches are settings (push/NotifyPrefs.java "notify.*"), which the app
// sends to the server; $notify is what the app knows besides.

import type { ANode, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

const section = (id: string, key: string) => n(id, "text", { text: `{_'${key}'}`, props: { variant: "label" }, style: { fg: "@primary", padding: "18 20 6 20", bold: true } });
const hint = (id: string, key: string, cond?: string) => n(id, "text", { ...(cond ? { if: cond } : {}), text: `{_'${key}'}`, props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 64" } });
const toggleRow = (id: string, icon: string, key: string, setting: string, cond?: string): ANode => n(id, "row", { ...(cond ? { if: cond } : {}), style: { padding: "10 12 10 20", gap: 18, align: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-label`, "text", { text: `{_'${key}'}`, style: { size: 16, weight: 1 } }),
  n(`${id}-switch`, "switch", { props: { setting } }),
]);
const selectRow = (id: string, icon: string, key: string, setting: string, options: string, cond?: string): ANode => n(id, "row", { ...(cond ? { if: cond } : {}), style: { padding: "8 16 8 20", gap: 18, align: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-label`, "text", { text: `{_'${key}'}`, style: { size: 16, weight: 1 } }),
  n(`${id}-select`, "select", { props: { setting, options }, style: { maxWidth: 200 } }),
]);
const page = (title: string, body: ANode[]): ANode => n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
  n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
    n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
    n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
  ]),
  n("scroll", "scroll", { style: { weight: 1 } }, [n("list", "column", { style: { padding: "0 0 24 0" } }, body)]),
]);

const ON = "$settings.notify.on";
const PRIVACY = ":{_'notify.privacy.default'}|neutral:{_'notify.privacy.neutral'}|sender:{_'notify.privacy.sender'}|room:{_'notify.privacy.room'}|content:{_'notify.privacy.content'}";

/** One channel of the order: its place, name, and the buttons to move it, use it or leave it out. */
const CHANNEL: ANode = n("ch", "row", { each: "$notify.channels", as: "c", style: { padding: "6 12 6 20", gap: 12, align: "center" } }, [
  n("ch-n", "text", { text: "{=$c.used ? $c.n + '.' : '–'}", props: { variant: "mono" }, style: { width: 24, fg: "=$c.used ? '@primary' : '@muted'" } }),
  n("ch-label", "text", { text: "{$c.label}", style: { size: 15, weight: 1, fg: "=$c.used ? '@onSurface' : '@muted'" } }),
  n("ch-up", "iconButton", { if: "$c.used && !$c.first", props: { icon: "arrow-up", label: "{_'notify.up'}" }, on: click("notify.up", "{$c.id}") }),
  n("ch-down", "iconButton", { if: "$c.used && !$c.last", props: { icon: "arrow-down", label: "{_'notify.down'}" }, on: click("notify.down", "{$c.id}") }),
  n("ch-drop", "iconButton", { if: "$c.used", props: { icon: "x", label: "{_'notify.drop'}" }, on: click("notify.drop", "{$c.id}") }),
  n("ch-use", "iconButton", { if: "!$c.used", props: { icon: "plus", label: "{_'notify.use'}" }, on: click("notify.use", "{$c.id}") }),
]);

const TREE: ANode = page("{_'settings.notifications'}", [
  toggleRow("on", "bell", "notify.on", "notify.on"),
  hint("off-hint", "notify.offHint", `!${ON}`),
  n("server-off", "text", { if: "$notify.serverOff", text: "{_'notify.serverOff'}", props: { variant: "caption" }, style: { fg: "@warning", padding: "0 20 8 64" } }),

  section("s-kinds", "notify.kinds"),
  toggleRow("k-message", "message-square", "notify.kind.message", "notify.message", ON),
  toggleRow("k-mention", "at-sign", "notify.kind.mention", "notify.mention", ON),
  toggleRow("k-call", "phone", "notify.kind.call", "notify.call", ON),
  toggleRow("k-function", "terminal", "notify.kind.function", "notify.function", ON),
  toggleRow("k-summon", "bell-ring", "notify.kind.summon", "notify.summon", ON),

  section("s-privacy", "notify.privacy"),
  selectRow("privacy", "eye", "notify.privacy.level", "notify.privacy", PRIVACY),
  hint("privacy-hint", "notify.privacy.hint"),

  section("s-quiet", "notify.quiet"),
  toggleRow("quiet", "moon", "notify.quiet.on", "notify.quiet"),
  selectRow("quiet-from", "clock", "notify.quiet.from", "notify.quietFrom", "=$notify.hours", "$settings.notify.quiet"),
  selectRow("quiet-to", "clock", "notify.quiet.to", "notify.quietTo", "=$notify.hours", "$settings.notify.quiet"),
  hint("quiet-hint", "notify.quiet.hint"),

  n("server", "column", { if: "$account.signedIn" }, [
    section("s-server", "notify.server"),
    toggleRow("away", "cloud", "notify.away", "notify.away"),
    hint("away-hint", "notify.away.hint"),
    n("away-fcm", "text", { if: "!$notify.push", text: "{_'notify.noFcm'}", props: { variant: "caption" }, style: { fg: "@warning", padding: "0 20 8 64" } }),
    section("s-order", "notify.order"),
    hint("order-hint", "notify.order.hint"),
    CHANNEL,
    n("status", "text", { if: "$notify.status", text: "{$notify.status}", props: { variant: "caption" }, style: { fg: "@danger", padding: "4 20 4 20" } }),
  ]),
  n("signed-out", "text", { if: "!$account.signedIn", text: "{_'notify.signedOut'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "14 20 4 20" } }),

  n("actions", "row", { props: { wrap: true }, style: { padding: "16 20 4 20", gap: 10 } }, [
    n("test", "button", { text: "{_'notify.test'}", props: { icon: "send", variant: "tonal" }, on: click("notify.test") }),
    n("busy", "progress", { if: "$notify.busy", style: { width: 24 } }),
  ]),
  n("system", "row", { style: { padding: "14 20", gap: 18, align: "center" }, on: click("system.settings", "notifications") }, [
    n("system-icon", "icon", { props: { icon: "smartphone", size: 22, color: "@muted" } }),
    n("system-label", "text", { text: "{_'notify.system'}", style: { size: 16, weight: 1 } }),
    n("system-go", "icon", { props: { icon: "external-link", size: 18, color: "@muted" } }),
  ]),
]);

const HOURS = Array.from({ length: 48 }, (_, i) => { const v = `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`; return { value: v, label: v }; });

const SCREEN: ScreenDef = {
  id: "settings.notify", label: "Settings › Notifications", group: "app",
  vars: ["$settings", "$notify", "$account"],
  sample: {
    settings: { notify: { on: true, away: true, message: true, mention: true, call: true, function: false, summon: true, privacy: "sender", order: "android,webpush", quiet: true, quietFrom: "22:00", quietTo: "07:00" } },
    account: { signedIn: true, username: "bystry-sokol-7k3q" },
    notify: {
      signedIn: true, linked: true, busy: false, status: "", push: true, serverOff: false, hours: HOURS,
      channels: [
        { id: "android", used: true, n: 1, first: true, last: false, label: "Android app" },
        { id: "webpush", used: true, n: 2, first: false, last: true, label: "Browser (web push)" },
        { id: "email", used: false, n: 0, first: true, last: true, label: "E-mail" },
      ],
    },
  },
  help: "Notifications: on / off, kinds, how much they show, quiet hours; signed in — the server covering for the phone, the channel order, a test.",
};

const ROW: ANode = n("notifications", "row", { style: { padding: "12 20", gap: 18, align: "center" }, on: click("screen.open", "settings.notify") }, [
  n("notifications-icon", "icon", { props: { icon: "bell", size: 22, color: "@muted" } }),
  n("notifications-col", "column", { style: { weight: 1 } }, [
    n("notifications-label", "text", { text: "{_'settings.notifications'}", style: { size: 16 } }),
    n("notifications-sub", "text", { text: "{=$settings.notify.on ? _('notify.sub') : _('notify.sub.off')}", props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
  ]),
  n("notifications-go", "icon", { props: { icon: "chevron-right", size: 18, color: "@muted" } }),
]);

function replaceById(node: ANode, id: string, next: ANode): boolean {
  const kids = node.children ?? [];
  const i = kids.findIndex((k) => k.id === id);
  if (i >= 0) { kids[i] = next; return true; }
  return kids.some((k) => replaceById(k, id, next));
}

const S = (cs: string, en: string, de: string) => ({ cs, en, de });
const STR: Record<string, { cs: string; en: string; de: string }> = {
  "notify.sub": S("Co, kudy a kolik toho ukázat", "What, how, and how much to show", "Was, auf welchem Weg und wie viel"),
  "notify.sub.off": S("Vypnuto", "Off", "Aus"),
  "notify.on": S("Upozornění", "Notifications", "Benachrichtigungen"),
  "notify.offHint": S("Aplikace ani server vás neupozorní.", "Neither the app nor the server will notify you.", "Weder die App noch der Server benachrichtigt Sie."),
  "notify.serverOff": S("Server upozornění neposílá — jen aplikace sama, když běží.", "The server sends no notifications — only the app itself, while it runs.", "Der Server sendet keine Benachrichtigungen — nur die App selbst, solange sie läuft."),
  "notify.kinds": S("Na co upozorňovat", "Notify me about", "Benachrichtigen bei"),
  "notify.kind.message": S("Nové zprávy", "New messages", "Neuen Nachrichten"),
  "notify.kind.mention": S("Zmínky o mně", "Mentions of me", "Erwähnungen"),
  "notify.kind.call": S("Hovory", "Calls", "Anrufen"),
  "notify.kind.function": S("Výsledky příkazů", "Command results", "Ergebnissen von Befehlen"),
  "notify.kind.summon": S("Výzvy operátora", "The operator calling me back", "Rückrufen des Betreibers"),
  "notify.privacy": S("Soukromí", "Privacy", "Privatsphäre"),
  "notify.privacy.level": S("Upozornění ukáže", "A notification shows", "Eine Benachrichtigung zeigt"),
  "notify.privacy.default": S("jak nastavil server", "as the server sets it", "wie der Server es einstellt"),
  "notify.privacy.neutral": S("nic — jen že něco přišlo", "nothing — only that something came", "nichts — nur dass etwas kam"),
  "notify.privacy.sender": S("kdo píše", "who writes", "wer schreibt"),
  "notify.privacy.room": S("kdo a v které místnosti", "who, and in which room", "wer und in welchem Raum"),
  "notify.privacy.content": S("i náhled zprávy", "a preview too", "auch eine Vorschau"),
  "notify.privacy.hint": S("Server zprávy nepřečte: náhled ukáže jen tato aplikace, když zprávu sama dešifruje (ne při zamčení). Server může úroveň omezit.", "The server cannot read messages: only this app shows a preview, when it decrypts the message itself (not while locked). The server may limit the level.", "Der Server kann Nachrichten nicht lesen: eine Vorschau zeigt nur diese App, wenn sie die Nachricht selbst entschlüsselt (nicht im gesperrten Zustand). Der Server kann die Stufe begrenzen."),
  "notify.quiet": S("Tiché hodiny", "Quiet hours", "Ruhezeiten"),
  "notify.quiet.on": S("Tiché hodiny", "Quiet hours", "Ruhezeiten"),
  "notify.quiet.from": S("Od", "From", "Von"),
  "notify.quiet.to": S("Do", "To", "Bis"),
  "notify.quiet.hint": S("V tuto dobu nic nepřijde (kromě testu).", "Nothing comes in these hours (except a test).", "In dieser Zeit kommt nichts (außer einem Test)."),
  "notify.server": S("Když je aplikace zavřená", "While the app is closed", "Wenn die App geschlossen ist"),
  "notify.away": S("Server drží mé zprávy a probudí mě", "The server keeps my messages and wakes me", "Der Server hält meine Nachrichten und weckt mich"),
  "notify.away.hint": S("Zprávy čekají na serveru zašifrované (nepřečte je) a upozornění přijde zapečetěné pro toto zařízení.", "Messages wait on the server encrypted (it cannot read them), and the notification comes sealed for this device.", "Nachrichten warten verschlüsselt auf dem Server (er kann sie nicht lesen), und die Benachrichtigung kommt für dieses Gerät versiegelt."),
  "notify.noFcm": S("Server nemá Firebase — probuzení přijde až při příští kontrole.", "The server has no Firebase — a wake-up waits for the next check-in.", "Der Server hat kein Firebase — ein Wecken wartet bis zur nächsten Abfrage."),
  "notify.order": S("Kudy mě upozornit", "How to reach me", "Wie ich erreicht werde"),
  "notify.order.hint": S("V tomto pořadí; když jedna cesta selže, server zkusí další.", "In this order; when one way fails, the server tries the next.", "In dieser Reihenfolge; scheitert ein Weg, versucht der Server den nächsten."),
  "notify.channel.android": S("Aplikace pro Android", "Android app", "Android-App"),
  "notify.channel.webpush": S("Prohlížeč (web push)", "Browser (web push)", "Browser (Web Push)"),
  "notify.channel.email": S("E-mail", "E-mail", "E-Mail"),
  "notify.up": S("Výš", "Up", "Hoch"),
  "notify.down": S("Níž", "Down", "Runter"),
  "notify.use": S("Použít", "Use", "Verwenden"),
  "notify.drop": S("Nepoužívat", "Do not use", "Nicht verwenden"),
  "notify.signedOut": S("Bez přihlášení upozorňuje jen aplikace sama, když běží. Přihlaste se, aby vás server upozornil i jinak.", "Signed out, only the app itself notifies you while it runs. Sign in so the server can reach you too.", "Ohne Anmeldung benachrichtigt nur die App selbst, solange sie läuft. Melden Sie sich an, damit auch der Server Sie erreicht."),
  "notify.test": S("Poslat zkušební upozornění", "Send a test notification", "Testbenachrichtigung senden"),
  "notify.test.ok": S("Odešlo přes: {channel}", "Sent through: {channel}", "Gesendet über: {channel}"),
  "notify.test.skipped": S("Nic neodešlo: {reason}", "Nothing sent: {reason}", "Nichts gesendet: {reason}"),
  "notify.test.failed": S("Žádná cesta to nevzala.", "No way took it.", "Kein Weg hat es angenommen."),
  "notify.test.local": S("Upozornění funguje (zobrazila ho aplikace).", "Notifications work (the app showed it).", "Benachrichtigungen funktionieren (die App hat sie gezeigt)."),
  "notify.system": S("Nastavení oznámení v telefonu", "The phone's notification settings", "Benachrichtigungseinstellungen des Telefons"),
  "notify.quietChannel": S("Tichá upozornění", "Quiet notifications", "Stille Benachrichtigungen"),
};

export const AREA: DesignArea = {
  actions: [
    { action: "notify.up", arg: "android | webpush | email", help: "A channel a place earlier in the order the server tries (Settings › Notifications)" },
    { action: "notify.down", arg: "android | webpush | email", help: "A channel a place later" },
    { action: "notify.use", arg: "android | webpush | email", help: "Use a channel (at the end of the order)" },
    { action: "notify.drop", arg: "android | webpush | email", help: "Leave a channel out" },
    { action: "notify.test", arg: "", help: "A test notification through the account's channels (signed out: the app shows one itself)" },
    { action: "notify.sync", arg: "", help: "Send the notification settings to the server now" },
  ],
  screens: [SCREEN],
  trees: { "settings.notify": TREE },
  strings: {
    cs: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.cs])),
    en: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.en])),
    de: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.de])),
  },
  // Settings: "Notifications" opens this screen (it opened the phone's settings; that is a row on it now).
  patch(screens) {
    if (screens.settings) replaceById(screens.settings, "notifications", ROW);
  },
};
