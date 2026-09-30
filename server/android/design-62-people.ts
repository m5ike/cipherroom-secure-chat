// 6.2 — the People widget (avatars, status, signal, selection) and linking people to the phone's contacts.
// Merged into the default design by design-62.ts (this file adds to the
// catalog; a tree here replaces the one of the same id).
//
// The People widget does what the web's recipients widget does
// (client/src/components/RecipientsWidget.tsx): each person with an avatar
// (a linked contact's photo, else the monogram in the web's colours), a
// status (online, light = a guest without an account, dnd = in a call, away =
// the server holds their messages, offline), the signal (the web's four-bar
// latency meter, here from each connection's own round trip) and a checkbox
// for who gets the next message ($form.msgTo); "Vybrat vše" / "Zrušit výběr"
// below. A tap opens the person's detail (users.person, a sheet bound to
// $form.person): the connection, the keys and safety number, a private
// message, calls, verification, and the link to a phone contact — whose
// "Zpráva / Volat přes M5cet" rows then reach them from the Contacts app.

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

export const ELEMENTS_62_PEOPLE: ElementDef[] = [];

export const ACTIONS_62_PEOPLE: Array<{ action: string; arg: string; help: string }> = [
  { action: "people.open", arg: "person id", help: "A person's detail (users.person as a sheet)" },
  { action: "people.select", arg: "person id", help: "Add / remove a person from who gets the next message" },
  { action: "people.all", arg: "", help: "Everyone connected gets the next message (each selected)" },
  { action: "people.none", arg: "", help: "Clear the selection (the next message goes to everyone)" },
  { action: "people.message", arg: "person id", help: "A private message to only this person (the composer gets the focus)" },
  { action: "people.call", arg: "person id", help: "A voice call (the room's call, as on the web)" },
  { action: "people.video", arg: "person id", help: "A video call (the room's call)" },
  { action: "people.verify", arg: "person id", help: "Compare the safety number and mark the person verified" },
  { action: "people.link", arg: "person id", help: "Link a signed-in person with a contact of the phone (the contact picker)" },
  { action: "people.unlink", arg: "person id", help: "Remove the link with the phone contact" },
  { action: "people.unlinkAll", arg: "", help: "Remove every link with the phone's contacts (asks first)" },
];

export const SLOTS_62_PEOPLE: Array<{ name: string; label: string; screens: string[] }> = [];

const SAMPLE_PERSON = {
  id: "peer-9f2c41d0a7b3", name: "Alice", me: false, channel: "open", username: "bystry-sokol-7k3q", signedIn: true, status: "online",
  statusIcon: "circle-check", statusColor: "@success", statusLabel: "Online", signal: 4, signalIcon: "signal", signalColor: "@success", rtt: 38, rttText: "38 ms",
  glyph: "A", avatarBg: "#38ae2929", avatarFg: "#ffb62020", photo: "", selectable: true, selected: false, linked: true, contact: "Alice Nováková",
  canLink: true, safetyVerified: false, verified: true, changed: false, away: false, peerShort: "peer-9f2c41d0a7b3", sinceText: "12 min 5 s",
  transport: "direct", transportLabel: "Direct (P2P)", candidates: "host → srflx · UDP", remote: "203.0.113.7:51234", codec: "opus", traffic: "84.2 kB / 91.6 kB",
  security: "AES-GCM 256 (E2EE) · DTLS 1.2", dtls: "sha-256 3A:5F:…", fingerprint: "8537 3E64 524D FF04 7F54 2310 0FA3 B932",
  hasSafety: true, safety: "13286 60170 84613 24995\n23962 36648 18264 48418\n04707 59157 69365 29038", room: "team", contactsOn: true, others: 2, app: "",
};

export const SCREENS_62_PEOPLE: ScreenDef[] = [
  { id: "users.person", label: "User panel › person", group: "parts", vars: ["$form.person", "$settings"], sample: { form: { person: SAMPLE_PERSON }, settings: { people: { contacts: true } } }, help: "A person's detail (a sheet from the People widget): status, connection, keys and safety number; private message, calls, verification, the phone contact." },
  { id: "settings.people", label: "Settings › People", group: "app", vars: ["$settings"], sample: { settings: { people: { contacts: true } } }, help: "Links between M5cet people and the phone's contacts." },
];

/* ================================================================= trees */

const P = "$form.person";

/** The avatar: a linked contact's photo, else the web's monogram; the status icon on its corner. */
const face = (id: string, who: string, size: number, badge: number): ANode => n(id, "stack", { style: { width: size + 4, height: size + 4 } }, [
  n(`${id}-mono`, "column", { if: `!${who}.photo`, style: { width: size, height: size, radius: size / 2, bg: `=${who}.avatarBg`, align: "center", justify: "center", self: "start" } }, [
    n(`${id}-glyph`, "text", { text: `{${who}.glyph}`, props: { align: "center" }, style: { fg: `=${who}.avatarFg`, bold: true, size: Math.round(size * 0.42) } }),
  ]),
  n(`${id}-photo`, "image", { if: `${who}.photo`, props: { src: `=${who}.photo`, fit: "cover" }, style: { width: size, height: size, radius: size / 2, bg: "@surfaceVariant", self: "start" } }),
  n(`${id}-state`, "column", { style: { width: badge, height: badge, radius: badge / 2, bg: "@surface", align: "center", justify: "center", self: "end" } }, [
    n(`${id}-state-icon`, "icon", { props: { icon: `=${who}.statusIcon`, size: badge - 4, color: `=${who}.statusColor` } }),
  ]),
]);

/** A labelled value of the detail. */
const info = (id: string, label: string, value: string, cond?: string, mono = false): ANode => n(id, "row", { ...(cond ? { if: cond } : {}), style: { padding: "5 8", gap: 12, align: "start" } }, [
  n(`${id}-label`, "text", { text: label, props: { variant: "caption" }, style: { fg: "@muted", width: 116 } }),
  n(`${id}-value`, "text", { text: value, props: mono ? { variant: "mono" } : {}, style: { weight: 1, size: mono ? 12.5 : 13.5 } }),
]);

const section = (id: string, key: string): ANode => n(id, "text", { text: `{_'${key}'}`, props: { variant: "label" }, style: { fg: "@primary", padding: "14 8 4 8", bold: true } });

/** An action of the detail: a round icon over a label. */
const tile = (id: string, icon: string, label: string, action: string, cond: string): ANode => n(id, "column", { if: cond, style: { weight: 1, align: "center", gap: 6, padding: "8 2", radius: 16 }, on: click(action, `{${P}.id}`) }, [
  n(`${id}-icon`, "column", { style: { bg: "@surfaceVariant", radius: 20, padding: 11, align: "center" } }, [n(`${id}-i`, "icon", { props: { icon, size: 22, color: "@primary" } })]),
  n(`${id}-label`, "text", { text: label, props: { variant: "caption", align: "center" }, style: { lines: 2 } }),
]);

const users: ANode = n("panel", "column", { style: { bg: "@surface", radius: 16, elevation: 8, padding: 8, gap: 4 } }, [
  n("head", "row", { style: { align: "center", gap: 6, padding: "2 4 2 8" } }, [
    n("icon", "icon", { props: { icon: "users", size: 18, color: "@primary" } }),
    n("title", "text", { text: "{_'users.title'} ({$count})", style: { bold: true, weight: 1, lines: 1 } }),
    n("dock", "iconButton", { props: { icon: "=$dock == 'left' ? 'panel-left' : ($dock == 'bottom' ? 'rows-2' : ($dock == 'right' ? 'panel-right' : 'move'))", label: "{_'users.dock'}" }, on: click("menu.open", "dock") }),
    n("pin", "iconButton", { if: "$dock != 'none'", props: { icon: "=$autoHide ? 'pin-off' : 'pin'", label: "{=$autoHide ? _('users.pin') : _('users.autoHide')}" }, on: click("users.autoHide") }),
    n("close", "iconButton", { props: { icon: "x", label: "{_'nav.close'}" }, on: click("users.toggle") }),
  ]),
  n("list", "slot", { props: { name: "userList" }, style: { weight: 1 } }),
  // Who gets the next message, and the last row: "Vybrat vše" / "Zrušit výběr".
  n("pick", "column", { if: "$selectable > 0", style: { padding: "4 2 0 2", gap: 2 } }, [
    n("to", "row", { style: { gap: 6, align: "center", padding: "0 6" } }, [
      n("to-icon", "icon", { props: { icon: "=$selectedCount > 0 ? 'message-square-lock' : 'users'", size: 14, color: "=$selectedCount > 0 ? '@primary' : '@muted'" } }),
      n("to-text", "text", { text: "{=$selectedCount > 0 ? _('people.toSelected') + ' (' + $selectedCount + ')' : _('people.toEveryone')}", props: { variant: "caption" }, style: { fg: "@muted", weight: 1, lines: 2 } }),
    ]),
    n("buttons", "row", { style: { gap: 4 } }, [
      n("all", "button", { text: "{_'people.all'}", props: { icon: "list-checks", variant: "text", disabled: "=$allSelected" }, style: { weight: 1, padding: "6 4", size: 13 }, on: click("people.all") }),
      n("none", "button", { text: "{_'people.none'}", props: { icon: "list-x", variant: "text", disabled: "=$selectedCount == 0" }, style: { weight: 1, padding: "6 4", size: 13 }, on: click("people.none") }),
    ]),
  ]),
]);

const usersItem: ANode = n("item", "row", { style: { padding: "4 6 4 0", gap: 8, align: "center", radius: 12, bg: "=$user.selected ? '@surfaceVariant' : '#00000000'" }, on: click("people.open", "{$user.id}") }, [
  n("pick", "checkbox", { if: "$user.selectable", props: { checked: "=$user.selected" }, on: click("people.select", "{$user.id}") }),
  n("nopick", "spacer", { if: "!$user.selectable", props: { size: 32 } }),
  face("face", "$user", 34, 16),
  n("who", "column", { style: { weight: 1, gap: 1 } }, [
    n("name", "text", { text: "{$user.name}{=$user.me ? ' (' + _('users.me') + ')' : ''}", style: { lines: 1 } }),
    n("sub", "text", { text: "{$user.statusLabel}{=$user.signedIn && $user.username ? ' · @' + $user.username : ''}", props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
  ]),
  n("linked", "icon", { if: "$user.linked", props: { icon: "contact-round", size: 14, color: "@muted" } }),
  n("trust", "icon", { if: "!$user.me && $user.verified", props: { icon: "=$user.safetyVerified ? 'shield-check' : 'shield'", size: 14, color: "=$user.safetyVerified ? '@success' : '@muted'" } }),
  n("changed", "icon", { if: "$user.changed", props: { icon: "shield-alert", size: 14, color: "@danger" } }),
  n("signal", "icon", { if: "!$user.me", props: { icon: "=$user.signalIcon", size: 16, color: "=$user.signalColor" } }),
]);

const person: ANode = n("root", "column", { style: { bg: "@surface", radius: 24, padding: "10 12 12 12", gap: 4 }, anim: { enter: { type: "slide-up", ms: 220, easing: "decelerate" } } }, [
  n("handle", "row", { style: { justify: "center", padding: "0 0 6 0" } }, [n("grip", "spacer", { props: { size: 4 }, style: { width: 40, bg: "@border", radius: 2 } })]),
  n("scroll", "scroll", {}, [
    n("body", "column", { style: { gap: 2, padding: "0 0 8 0" } }, [
      n("head", "row", { style: { gap: 14, align: "center", padding: "0 8 8 8" } }, [
        face("face", P, 56, 22),
        n("who", "column", { style: { weight: 1, gap: 2 } }, [
          n("name", "text", { text: `{${P}.name}{=${P}.me ? ' (' + _('users.me') + ')' : ''}`, props: { variant: "title" }, style: { bold: true, lines: 2 } }),
          n("state", "row", { style: { gap: 6, align: "center" } }, [
            n("state-text", "text", { text: `{${P}.statusLabel}`, props: { variant: "caption" }, style: { fg: `=${P}.statusColor` } }),
            n("signal", "icon", { if: `!${P}.me`, props: { icon: `=${P}.signalIcon`, size: 14, color: `=${P}.signalColor` } }),
            n("rtt", "text", { if: `!${P}.me && ${P}.rtt >= 0`, text: `{${P}.rttText}`, props: { variant: "caption" }, style: { fg: "@muted" } }),
          ]),
          n("user", "text", { text: `{=${P}.signedIn && ${P}.username ? '@' + ${P}.username : _('people.guest')}`, props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
        ]),
      ]),
      n("warn", "row", { if: `${P}.changed`, style: { bg: "@danger", fg: "#ffffff", radius: 12, padding: "8 12", gap: 8, align: "center", margin: "0 4 6 4" } }, [
        n("warn-icon", "icon", { props: { icon: "shield-alert", size: 18, color: "#ffffff" } }),
        n("warn-text", "text", { text: "{_'people.keyChanged'}", style: { weight: 1 } }),
      ]),
      n("actions", "row", { if: `!${P}.me`, style: { gap: 2, align: "start", padding: "0 0 4 0" } }, [
        tile("msg", "message-square-lock", "{_'people.message'}", "people.message", `${P}.selectable`),
        tile("call", "phone", "{_'people.call'}", "people.call", `${P}.selectable`),
        tile("video", "video", "{_'people.video'}", "people.video", `${P}.selectable`),
        tile("verify", `=${P}.safetyVerified ? 'shield-check' : 'shield-question-mark'`, `{=${P}.safetyVerified ? _('people.verifiedShort') : _('people.verify')}`, "people.verify", `${P}.hasSafety`),
        tile("link", "contact-round", "{_'people.link'}", "people.link", `${P}.canLink && !${P}.linked`),
        tile("unlink", "unlink", "{_'people.unlink'}", "people.unlink", `${P}.linked`),
      ]),
      n("linked", "row", { if: `${P}.linked`, style: { gap: 8, align: "center", padding: "2 8" } }, [
        n("linked-icon", "icon", { props: { icon: "contact-round", size: 16, color: "@primary" } }),
        n("linked-text", "text", { text: `{_'people.linkedTo'}: {${P}.contact}`, props: { variant: "caption" }, style: { weight: 1 } }),
      ]),
      n("nolink", "text", { if: `!${P}.me && ${P}.contactsOn && !${P}.canLink && !${P}.linked`, text: "{_'people.linkOnlyAccounts'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "2 8" } }),
      n("roomcall", "text", { if: `!${P}.me && ${P}.selectable && ${P}.others > 1`, text: "{_'people.roomCallHint'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "2 8" } }),
      section("s-conn", "people.section.connection"),
      info("r-state", "{_'people.stateLabel'}", `{${P}.statusLabel}`),
      info("r-room", "{_'people.room'}", `{${P}.room}`),
      info("r-since", "{_'people.since'}", `{${P}.sinceText}`),
      info("r-transport", "{_'people.transport'}", `{${P}.transportLabel}`, `!${P}.me`),
      info("r-cand", "{_'people.candidates'}", `{${P}.candidates}`, `${P}.candidates`),
      info("r-remote", "{_'people.remote'}", `{${P}.remote}`, `${P}.remote`, true),
      info("r-rtt", "{_'people.rtt'}", `{${P}.rttText}`, `!${P}.me`),
      info("r-codec", "{_'people.codec'}", `{${P}.codec}`, `${P}.codec`),
      info("r-traffic", "{_'people.traffic'}", `{${P}.traffic}`, `!${P}.me`),
      info("r-sec", "{_'people.security'}", `{${P}.security}`),
      section("s-id", "people.section.identity"),
      info("r-user", "{_'people.username'}", `{=${P}.username ? ${P}.username : _('people.guest')}`),
      info("r-peer", "{_'people.peerId'}", `{${P}.peerShort}`, undefined, true),
      info("r-app", "{_'people.app'}", `{${P}.app}`, `${P}.app`),
      info("r-key", "{_'people.deviceKey'}", `{${P}.fingerprint}`, `${P}.fingerprint`, true),
      info("r-dtls", "{_'people.dtls'}", `{${P}.dtls}`, `${P}.dtls`, true),
      info("r-safety", "{_'people.safety'}", `{${P}.safety}`, `${P}.hasSafety`, true),
      info("r-verified", "{_'people.verification'}", `{=${P}.safetyVerified ? _('people.verified') : _('people.notVerified')}`, `${P}.hasSafety`),
    ]),
  ]),
]);

/* The Settings page, as the 6.1 settings pages are drawn (design-61.ts). */

const bar = (title: string): ANode => n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
  n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
  n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
]);

const page = (title: string, body: ANode[]): ANode => n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
  bar(title),
  n("scroll", "scroll", { style: { weight: 1 } }, [n("list", "column", { style: { padding: "0 0 24 0" } }, body)]),
]);

const hint = (id: string, key: string): ANode => n(id, "text", { text: `{_'${key}'}`, props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 64" } });

const actRow = (id: string, icon: string, label: string, action: string, arg?: string, color?: string): ANode => n(id, "row", { style: { padding: "14 20", gap: 18, align: "center" }, on: click(action, arg) }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: color ?? "@muted" } }),
  n(`${id}-label`, "text", { text: label, style: { size: 16, weight: 1, ...(color ? { fg: color } : {}) } }),
]);

const settingsPeople: ANode = page("{_'set.people'}", [
  n("contacts", "column", {}, [
    n("contacts-row", "row", { style: { padding: "10 12 10 20", gap: 18, align: "center" } }, [
      n("contacts-icon", "icon", { props: { icon: "contact-round", size: 22, color: "@muted" } }),
      n("contacts-label", "text", { text: "{_'set.people.contacts'}", style: { size: 16, weight: 1 } }),
      n("contacts-switch", "switch", { props: { setting: "people.contacts" } }),
    ]),
    hint("contacts-hint", "set.people.contactsHint"),
  ]),
  hint("how", "set.people.how"),
  actRow("unlink-all", "unlink", "{_'people.unlinkAll'}", "people.unlinkAll", undefined, "@danger"),
  actRow("perm", "shield", "{_'set.people.permission'}", "system.settings", "app"),
]);

export const SCREENS_TREES_62_PEOPLE: Record<string, ANode> = {
  users,
  "users.item": usersItem,
  "users.person": person,
  "settings.people": settingsPeople,
};

export const MENUS_62_PEOPLE: Record<string, MenuItem[]> = {};

export const STRINGS_62_PEOPLE: Record<"cs" | "en" | "de", Record<string, string>> = {
  cs: {
    "people.status.online": "Online", "people.status.light": "Připojen bez účtu", "people.status.dnd": "Nerušit — v hovoru", "people.status.away": "Pryč — zprávy drží server",
    "people.status.connecting": "Připojuje se…", "people.status.offline": "Offline",
    "people.all": "Vybrat vše", "people.none": "Zrušit výběr", "people.toEveryone": "Příští zprávu dostanou všichni", "people.toSelected": "Příští zprávu dostanou jen vybraní",
    "people.guest": "host bez účtu",
    "people.message": "Soukromá zpráva", "people.call": "Zavolat", "people.video": "Video", "people.verify": "Ověřit", "people.verifiedShort": "Ověřeno",
    "people.link": "Propojit s kontaktem", "people.unlink": "Zrušit propojení", "people.linkedTo": "Propojeno s kontaktem",
    "people.linkOnlyAccounts": "S kontaktem v telefonu lze propojit jen přihlášeného uživatele (s účtem M5cet).",
    "people.roomCallHint": "Hovor poběží v celé místnosti — uslyší ho všichni, kdo jsou v ní připojení.",
    "people.keyChanged": "Klíč tohoto člověka se od minula změnil. Než mu budete věřit, porovnejte bezpečnostní číslo.",
    "people.section.connection": "Spojení", "people.section.identity": "Identita a klíče",
    "people.stateLabel": "Stav", "people.room": "Místnost", "people.since": "Doba spojení", "people.transport": "Přenos", "people.candidates": "Kandidáti ICE",
    "people.remote": "Adresa protistrany", "people.rtt": "Odezva (RTT)", "people.codec": "Kodek", "people.traffic": "Odesláno / přijato", "people.security": "Zabezpečení",
    "people.username": "Uživatelské jméno", "people.peerId": "ID spojení", "people.app": "Aplikace", "people.deviceKey": "Klíč zařízení", "people.dtls": "Otisk DTLS",
    "people.safety": "Bezpečnostní číslo", "people.verification": "Ověření", "people.verified": "Ověřeno porovnáním čísel", "people.notVerified": "Neověřeno — porovnejte bezpečnostní číslo",
    "people.transport.direct": "Přímé spojení (P2P)", "people.transport.relay": "Přes TURN server (stále šifrované)", "people.transport.connecting": "Navazuje se…", "people.transport.self": "Toto zařízení",
    "people.h": "h", "people.m": "min", "people.s": "s",
    "people.verify.hint": "Porovnejte toto číslo s tím, které vidí {name} — osobně, nebo po telefonu. Když se shodují, nikdo se mezi vás nevloudil.",
    "people.verify.match": "Shodují se — ověřit", "people.verify.undo": "Zrušit ověření", "people.verify.done": "{name}: ověřeno",
    "people.callAsk": "Zavolat uživateli {name}? Hovor poběží v místnosti {room} — uslyší ho všichni, kdo jsou v ní připojení.",
    "people.contact.message": "Zpráva přes M5cet", "people.contact.call": "Volat přes M5cet",
    "people.linked": "{name} je propojen s kontaktem {contact}.", "people.unlinked": "Propojení s kontaktem je zrušené.", "people.linkFailed": "Propojení s kontaktem se nezdařilo.",
    "people.unlinkAll": "Zrušit všechna propojení", "people.unlinkAllAsk": "Odebrat z kontaktů v telefonu všechna propojení s M5cet? Kontakty samotné zůstanou.",
    "people.contactsOff": "Propojení s kontakty je vypnuté (Nastavení › Lidé a kontakty).",
    "people.searching": "Hledám {name} v připojených místnostech…", "people.notOnline": "{name} teď není online v žádné z připojených místností.",
    "people.noRooms": "Nejste připojeni k žádné místnosti, {name} teď nezastihnete.", "people.notLinked": "Tento kontakt není v M5cet propojený s žádným uživatelem.",
    "set.people": "Lidé a kontakty", "set.people.sub": "Propojení s kontakty v telefonu", "set.people.contacts": "Propojit s kontakty v telefonu",
    "set.people.contactsHint": "Propojený kontakt nabídne v aplikaci Kontakty „Zpráva přes M5cet“ a „Volat přes M5cet“. Do kontaktů se ukládá jen uživatelské jméno M5cet a nic z kontaktů neopouští telefon. Vypnutím se tyto řádky z kontaktů odeberou.",
    "set.people.how": "Propojení vytvoříte v panelu Lidé: klepněte na člověka a zvolte Propojit s kontaktem. Propojit lze jen přihlášené uživatele.",
    "set.people.permission": "Oprávnění aplikace",
  },
  en: {
    "people.status.online": "Online", "people.status.light": "Connected without an account", "people.status.dnd": "Do not disturb — in a call", "people.status.away": "Away — the server holds messages",
    "people.status.connecting": "Connecting…", "people.status.offline": "Offline",
    "people.all": "Select all", "people.none": "Clear selection", "people.toEveryone": "The next message goes to everyone", "people.toSelected": "The next message goes only to the selected",
    "people.guest": "guest without an account",
    "people.message": "Private message", "people.call": "Call", "people.video": "Video", "people.verify": "Verify", "people.verifiedShort": "Verified",
    "people.link": "Link to a contact", "people.unlink": "Unlink", "people.linkedTo": "Linked to the contact",
    "people.linkOnlyAccounts": "Only a signed-in person (with an M5cet account) can be linked to a phone contact.",
    "people.roomCallHint": "The call runs in the whole room — everyone connected there hears it.",
    "people.keyChanged": "This person's key has changed since last time. Compare the safety number before you trust them.",
    "people.section.connection": "Connection", "people.section.identity": "Identity and keys",
    "people.stateLabel": "Status", "people.room": "Room", "people.since": "Connected for", "people.transport": "Transport", "people.candidates": "ICE candidates",
    "people.remote": "Remote address", "people.rtt": "Round trip (RTT)", "people.codec": "Codec", "people.traffic": "Sent / received", "people.security": "Security",
    "people.username": "Username", "people.peerId": "Peer ID", "people.app": "App", "people.deviceKey": "Device key", "people.dtls": "DTLS fingerprint",
    "people.safety": "Safety number", "people.verification": "Verification", "people.verified": "Verified by comparing numbers", "people.notVerified": "Not verified — compare the safety number",
    "people.transport.direct": "Direct (P2P)", "people.transport.relay": "Through a TURN server (still encrypted)", "people.transport.connecting": "Connecting…", "people.transport.self": "This device",
    "people.h": "h", "people.m": "min", "people.s": "s",
    "people.verify.hint": "Compare this number with the one {name} sees — in person or on a call. If they match, nobody is in between.",
    "people.verify.match": "They match — verify", "people.verify.undo": "Remove the verification", "people.verify.done": "{name}: verified",
    "people.callAsk": "Call {name}? The call runs in the room {room} — everyone connected there hears it.",
    "people.contact.message": "Message via M5cet", "people.contact.call": "Call via M5cet",
    "people.linked": "{name} is linked to the contact {contact}.", "people.unlinked": "The link to the contact is removed.", "people.linkFailed": "Linking to the contact failed.",
    "people.unlinkAll": "Remove all links", "people.unlinkAllAsk": "Remove every M5cet link from the phone's contacts? The contacts themselves stay.",
    "people.contactsOff": "Linking with contacts is off (Settings › People and contacts).",
    "people.searching": "Looking for {name} in the connected rooms…", "people.notOnline": "{name} is not online in any of the connected rooms right now.",
    "people.noRooms": "You are not connected to any room, so {name} cannot be reached now.", "people.notLinked": "This contact is not linked to an M5cet user.",
    "set.people": "People and contacts", "set.people.sub": "Links with the phone's contacts", "set.people.contacts": "Link with the phone's contacts",
    "set.people.contactsHint": "A linked contact offers \"Message via M5cet\" and \"Call via M5cet\" in the Contacts app. Only the M5cet username goes into the contacts, and nothing of the contacts leaves the phone. Switching this off removes those rows from the contacts.",
    "set.people.how": "Make a link in the People panel: tap a person and choose Link to a contact. Only signed-in people can be linked.",
    "set.people.permission": "App permissions",
  },
  de: {
    "people.status.online": "Online", "people.status.light": "Verbunden ohne Konto", "people.status.dnd": "Nicht stören — im Gespräch", "people.status.away": "Abwesend — der Server hält Nachrichten",
    "people.status.connecting": "Verbindet…", "people.status.offline": "Offline",
    "people.all": "Alle auswählen", "people.none": "Auswahl aufheben", "people.toEveryone": "Die nächste Nachricht geht an alle", "people.toSelected": "Die nächste Nachricht geht nur an die Ausgewählten",
    "people.guest": "Gast ohne Konto",
    "people.message": "Private Nachricht", "people.call": "Anrufen", "people.video": "Video", "people.verify": "Verifizieren", "people.verifiedShort": "Verifiziert",
    "people.link": "Mit Kontakt verknüpfen", "people.unlink": "Verknüpfung aufheben", "people.linkedTo": "Verknüpft mit dem Kontakt",
    "people.linkOnlyAccounts": "Nur eine angemeldete Person (mit M5cet-Konto) kann mit einem Kontakt des Telefons verknüpft werden.",
    "people.roomCallHint": "Das Gespräch läuft im ganzen Raum — alle dort Verbundenen hören es.",
    "people.keyChanged": "Der Schlüssel dieser Person hat sich seit dem letzten Mal geändert. Vergleichen Sie die Sicherheitsnummer, bevor Sie ihr vertrauen.",
    "people.section.connection": "Verbindung", "people.section.identity": "Identität und Schlüssel",
    "people.stateLabel": "Status", "people.room": "Raum", "people.since": "Verbindungsdauer", "people.transport": "Übertragung", "people.candidates": "ICE-Kandidaten",
    "people.remote": "Gegenstelle", "people.rtt": "Laufzeit (RTT)", "people.codec": "Codec", "people.traffic": "Gesendet / empfangen", "people.security": "Sicherheit",
    "people.username": "Benutzername", "people.peerId": "Peer-ID", "people.app": "App", "people.deviceKey": "Geräteschlüssel", "people.dtls": "DTLS-Fingerabdruck",
    "people.safety": "Sicherheitsnummer", "people.verification": "Verifizierung", "people.verified": "Durch Vergleich der Nummern verifiziert", "people.notVerified": "Nicht verifiziert — Sicherheitsnummer vergleichen",
    "people.transport.direct": "Direkt (P2P)", "people.transport.relay": "Über einen TURN-Server (weiterhin verschlüsselt)", "people.transport.connecting": "Verbindet…", "people.transport.self": "Dieses Gerät",
    "people.h": "h", "people.m": "min", "people.s": "s",
    "people.verify.hint": "Vergleichen Sie diese Nummer mit der, die {name} sieht — persönlich oder am Telefon. Stimmen sie überein, steht niemand dazwischen.",
    "people.verify.match": "Stimmen überein — verifizieren", "people.verify.undo": "Verifizierung aufheben", "people.verify.done": "{name}: verifiziert",
    "people.callAsk": "{name} anrufen? Das Gespräch läuft im Raum {room} — alle dort Verbundenen hören es.",
    "people.contact.message": "Nachricht über M5cet", "people.contact.call": "Anruf über M5cet",
    "people.linked": "{name} ist mit dem Kontakt {contact} verknüpft.", "people.unlinked": "Die Verknüpfung mit dem Kontakt ist aufgehoben.", "people.linkFailed": "Die Verknüpfung mit dem Kontakt ist fehlgeschlagen.",
    "people.unlinkAll": "Alle Verknüpfungen aufheben", "people.unlinkAllAsk": "Alle M5cet-Verknüpfungen aus den Kontakten des Telefons entfernen? Die Kontakte selbst bleiben.",
    "people.contactsOff": "Die Verknüpfung mit Kontakten ist ausgeschaltet (Einstellungen › Personen und Kontakte).",
    "people.searching": "Suche {name} in den verbundenen Räumen…", "people.notOnline": "{name} ist gerade in keinem der verbundenen Räume online.",
    "people.noRooms": "Sie sind mit keinem Raum verbunden, {name} ist jetzt nicht erreichbar.", "people.notLinked": "Dieser Kontakt ist mit keinem M5cet-Benutzer verknüpft.",
    "set.people": "Personen und Kontakte", "set.people.sub": "Verknüpfung mit den Kontakten des Telefons", "set.people.contacts": "Mit den Kontakten des Telefons verknüpfen",
    "set.people.contactsHint": "Ein verknüpfter Kontakt bietet in der Kontakte-App „Nachricht über M5cet“ und „Anruf über M5cet“. In die Kontakte kommt nur der M5cet-Benutzername, und nichts aus den Kontakten verlässt das Telefon. Ausschalten entfernt diese Zeilen aus den Kontakten.",
    "set.people.how": "Eine Verknüpfung legen Sie im Personen-Panel an: auf eine Person tippen und Mit Kontakt verknüpfen wählen. Nur angemeldete Personen lassen sich verknüpfen.",
    "set.people.permission": "App-Berechtigungen",
  },
};

/** A row that opens a screen, as the 6.1 settings list draws them. */
const navRow = (id: string, icon: string, label: string, target: string, sub: string): ANode => n(id, "row", { style: { padding: "12 20", gap: 18, align: "center" }, on: click("screen.open", target) }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-col`, "column", { style: { weight: 1 } }, [
    n(`${id}-label`, "text", { text: label, style: { size: 16 } }),
    n(`${id}-sub`, "text", { text: sub, props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
  ]),
  n(`${id}-go`, "icon", { props: { icon: "chevron-right", size: 18, color: "@muted" } }),
]);

/** Changes to existing trees (after every 6.1 and 6.2 tree is in place): Settings gets "Lidé a kontakty" after Calls. */
export function patch62People(screens: Record<string, ANode>): void {
  const list = screens.settings?.children?.find((c) => c.id === "scroll")?.children?.find((c) => c.id === "list");
  if (!list?.children || list.children.some((c) => c.id === "people")) return;
  const at = list.children.findIndex((c) => c.id === "calls");
  list.children.splice(at < 0 ? list.children.length : at + 1, 0, navRow("people", "contact-round", "{_'set.people'}", "settings.people", "{_'set.people.sub'}"));
}
