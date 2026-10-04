// 6.10 design area: the chat screen — a bubble swiped right replies, swiped
// left forwards (a room, then everyone or one member); the message replied to
// sits on top of the reply and a tap scrolls to it; the sender's avatar at the
// top of the row, a little larger, opening what they share of their profile;
// the profile and its privacy easy to find in the settings.
// One area of the 6.10 design (design-610.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
// The gestures are the app's own (ui/parts/MessageList + BubbleRow, the rule
// in ui/bubble/BubbleSwipe): a drag that STARTS ON A BUBBLE and is clearly
// sideways moves the bubble — toward the reading direction's end (right;
// left in a right-to-left layout) it replies, toward its start it forwards;
// the icon grows in under the uncovered edge, the phone ticks where letting
// go starts to count, the bubble springs back. A vertical drag stays the
// list's scrolling; a quick sideways fling that starts OFF the bubbles (the
// free space beside them, the avatars, the background) still moves to the
// previous / next connected room (6.1). Reply and forward stay in the long
// press menu and are the row's accessibility actions (TalkBack), with the
// sender's profile and "go to the original".
//
// What the trees get:
//   message.in    the avatar in a "face" at the TOP of the row, 36 dp (a shared
//                 profile photo when the sender shares one with the room),
//                 tappable → msg.sender; in a run of one person's messages
//                 ($msg.cont) only the first shows the avatar and the name, a
//                 gap keeps the bubbles in line; the one-line "↪ sender: text"
//                 becomes a quote card (the sender's colour bar, name, two
//                 lines, the media's icon) → msg.quote scrolls to the original
//                 and flashes it (or says it is not here / hidden)
//   message.out   the same quote card in the bubble's colours
//   message.sender (new sheet)  what the sender shares with the room (6.7
//                 room profile: only the items they marked for room members
//                 or the public), else the name and "shares nothing"
//   message.forward (new sheet) forward: the message, the connected rooms,
//                 then everyone there or one person (privately)
//   settings      a profile card on top: photo, name, what each audience
//                 sees (counts) → the editor
//   settings.profile  "Who sees what" under the legend (public / room
//                 members / only me, by name), each field's audience as a
//                 chip that changes it (profile.audience); the preview stays
//   users.person  my own detail: "Edit my profile"
//   menu main     "My profile" (on top, before Settings)

import type { ANode, MenuItem, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

/** The avatar's size in a received message's row (dp; 6.1 had 30). */
export const AVATAR = 36;

/* ================================================================ helpers */

function find(node: ANode, id: string): ANode | null {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
}

function parentOf(node: ANode, id: string): ANode | null {
  for (const c of node.children ?? []) {
    if (c.id === id) return node;
    const hit = parentOf(c, id);
    if (hit) return hit;
  }
  return null;
}

/** Replaces the child `id` (anywhere) with `nodes`; false when there is none. */
function replace(tree: ANode, id: string, nodes: ANode[]): boolean {
  const p = parentOf(tree, id);
  if (!p?.children) return false;
  const i = p.children.findIndex((c) => c.id === id);
  p.children.splice(i, 1, ...nodes);
  return true;
}

/** Puts `nodes` into `parent` before / after a child (at the end without one). */
function insert(parent: ANode, at: { after?: string; before?: string }, nodes: ANode[]): void {
  const kids = parent.children ?? [];
  const i = kids.findIndex((k) => k.id === (at.after ?? at.before));
  kids.splice(i < 0 ? (at.before ? 0 : kids.length) : at.after ? i + 1 : i, 0, ...nodes);
  parent.children = kids;
}

/* ============================================================ the bubbles */

/** The sender's face at the top of a received message's row: a shared photo or the monogram; a tap shows their profile. */
export const faceNodes = (): ANode[] => [
  n("face", "column", { if: "!$msg.cont", style: { self: "start", margin: "2 0 0 0" }, on: click("msg.sender", "{$msg.id}") }, [
    n("avatar", "avatar", { if: "!$msg.photo", props: { name: "{$msg.sender}", size: AVATAR } }),
    n("photo", "image", { if: "$msg.photo", props: { src: "=$msg.photo", fit: "cover" }, style: { width: AVATAR, height: AVATAR, radius: AVATAR / 2, bg: "@surfaceVariant" } }),
  ]),
  // The rest of a run: no face, the bubble stays in line with the first.
  n("face-gap", "spacer", { if: "$msg.cont", props: { size: AVATAR }, style: { height: 1 } }),
];

/**
 * The message replied to, as a card at the top of the reply bubble: the
 * sender's colour bar, their name, two lines, the media's icon; a tap goes
 * to the original (msg.quote). `out`: in my bubble's colours.
 */
export const quoteNode = (out: boolean): ANode => {
  const R = "$msg.replyTo";
  const color = out ? "@onBubbleOut" : `=${R}.color ? ${R}.color : '@primary'`;
  return n("quote", "row", {
    if: R,
    style: { bg: out ? "#26000000" : `=${R}.tint ? ${R}.tint : '#14000000'`, radius: 10, padding: "6 10 6 0", gap: 8, margin: "2 0 4 0", align: "center" },
    on: click("msg.quote", `{${R}.id}`),
  }, [
    n("quote-bar", "column", { style: { width: 3, self: "stretch", radius: 2, bg: color } }),
    n("quote-col", "column", { style: { weight: 1, gap: 1 } }, [
      n("quote-sender", "text", { text: `{${R}.sender}`, props: { variant: "label" }, style: { ...(out ? {} : { fg: color }), bold: true, lines: 1, maxWidth: 230 } }),
      n("quote-text", "text", { text: `{${R}.text}`, props: { variant: "caption" }, style: { lines: 2, maxWidth: 230, opacity: 0.85 } }),
    ]),
    n("quote-icon", "icon", { if: `${R}.icon`, props: { icon: `=${R}.icon`, size: 18, color: out ? "@onBubbleOut" : "@muted" } }),
  ]);
};

/**
 * message.in: the face at the top (the row's children start at the top),
 * the name only at a run's start, the quote card for the 6.1 reply line.
 * message.out: the quote card. A tree without these parts (an operator's
 * own) is left as it is; patching twice changes nothing.
 */
export function patchBubbles(screens: Record<string, ANode>): void {
  const inTree = screens["message.in"];
  if (inTree && !find(inTree, "face")) {
    if (inTree.el === "row") inTree.style = { ...(inTree.style ?? {}), align: "start" };
    replace(inTree, "avatar", faceNodes());
    const sender = find(inTree, "sender");
    if (sender && !sender.if) sender.if = "!$msg.cont";
  }
  for (const [id, out] of [["message.in", false], ["message.out", true]] as const) {
    const tree = screens[id];
    if (!tree || find(tree, "quote")) continue;
    replace(tree, "reply", [quoteNode(out)]);
  }
}

/* ======================================================= the sender sheet */

const S = "$form.sender";

const handle = (): ANode => n("handle", "row", { style: { justify: "center", padding: "0 0 6 0" } }, [n("grip", "spacer", { props: { size: 4 }, style: { width: 40, bg: "@border", radius: 2 } })]);

const senderSheet: ANode = n("root", "column", { style: { bg: "@surface", radius: 24, padding: "10 12 12 12", gap: 4 }, anim: { enter: { type: "slide-up", ms: 220, easing: "decelerate" } } }, [
  handle(),
  n("scroll", "scroll", {}, [
    n("body", "column", { style: { gap: 2, padding: "0 0 8 0" } }, [
      n("cover", "image", { if: `${S}.profile.cover`, props: { src: `=${S}.profile.cover`, fit: "cover", ratio: 3 }, style: { radius: 16, margin: "0 4 6 4" } }),
      n("head", "row", { style: { gap: 14, align: "center", padding: "2 8 8 8" } }, [
        n("photo", "image", { if: `${S}.photo`, props: { src: `=${S}.photo`, fit: "cover" }, style: { width: 64, height: 64, radius: 32, bg: "@surfaceVariant" } }),
        n("mono", "avatar", { if: `!${S}.photo`, props: { name: `{${S}.name}`, size: 64 } }),
        n("who", "column", { style: { weight: 1, gap: 2 } }, [
          n("title", "text", { text: `{${S}.title}{=${S}.me ? ' (' + _('users.me') + ')' : ''}`, props: { variant: "title" }, style: { bold: true, lines: 2 } }),
          n("as", "text", { if: `${S}.nickDiffers`, text: `{_'sender.inRoomAs'} {${S}.name}`, props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
          n("user", "text", { if: `!${S}.function`, text: `{=${S}.username ? '@' + ${S}.username : _('people.guest')}`, props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
          n("fn", "text", { if: `${S}.function`, text: "{_'sender.function'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
          n("gone", "text", { if: `!${S}.present && !${S}.function && !${S}.me`, text: "{_'sender.left'}", props: { variant: "caption" }, style: { fg: "@warning" } }),
        ]),
      ]),
      n("about", "text", { if: `${S}.profile.about`, text: `{${S}.profile.about}`, props: { links: true }, style: { padding: "2 8 6 8" } }),
      n("field", "row", { each: `${S}.profile.fields`, as: "pf", style: { gap: 10, align: "start", padding: "5 8" } }, [
        n("field-icon", "icon", { props: { icon: "=$pf.icon", size: 16, color: "@muted" } }),
        n("field-label", "text", { text: "{$pf.label}", props: { variant: "caption" }, style: { fg: "@muted", width: 96 } }),
        n("field-value", "text", { text: "{$pf.value}", props: { links: true }, style: { weight: 1 } }),
      ]),
      n("none", "row", { if: `!${S}.has`, style: { gap: 10, align: "center", padding: "6 8" } }, [
        n("none-icon", "icon", { props: { icon: "eye-off", size: 18, color: "@muted" } }),
        n("none-text", "text", { text: "{_'sender.none'}", style: { weight: 1, fg: "@muted" } }),
      ]),
      n("note", "row", { style: { gap: 8, align: "start", padding: "8 8 2 8" } }, [
        n("note-icon", "icon", { props: { icon: "=" + `${S}.me ? 'users' : 'shield-check'`, size: 14, color: "@muted" } }),
        n("note-text", "text", { text: `{=${S}.me ? _('sender.noteMine') : _('sender.note')}`, props: { variant: "caption" }, style: { weight: 1, fg: "@muted" } }),
      ]),
      n("actions", "row", { if: `!${S}.me && ${S}.present`, style: { gap: 8, padding: "10 4 0 4" } }, [
        n("message", "button", { if: `${S}.canMessage`, text: "{_'people.message'}", props: { icon: "message-square-lock", variant: "tonal" }, style: { weight: 1 }, on: click("people.message", `{${S}.id}`) }),
        n("more", "button", { text: "{_'sender.more'}", props: { icon: "info", variant: "text" }, style: { weight: 1 }, on: click("people.open", `{${S}.id}`) }),
      ]),
      n("mine", "button", { if: `${S}.me`, text: "{_'me.editShort'}", props: { icon: "square-pen", variant: "tonal" }, style: { margin: "10 4 0 4" }, on: click("profile.open") }),
    ]),
  ]),
]);

/* ====================================================== the forward sheet */

const F = "$form.forward";

/** A row of the forward sheet: a tile with the icon (or a face), two lines, what it leads to. */
const pickRow = (id: string, lead: ANode, title: string, sub: string, tail: string, o: Opts): ANode =>
  n(id, "row", { ...o, style: { padding: "10 8", gap: 12, align: "center", radius: 14 } }, [
    lead,
    n(`${id}-col`, "column", { style: { weight: 1, gap: 1 } }, [
      n(`${id}-title`, "text", { text: title, style: { size: 16, lines: 1 } }),
      n(`${id}-sub`, "text", { text: sub, props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
    ]),
    n(`${id}-tail`, "icon", { props: { icon: tail, size: 18, color: "@muted" } }),
  ]);

const tile = (id: string, icon: string): ANode => n(id, "column", { style: { width: 40, height: 40, radius: 12, bg: "@surfaceVariant", align: "center", justify: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 20, color: "@primary" } }),
]);

const forwardSheet: ANode = n("root", "column", { style: { bg: "@surface", radius: 24, padding: "10 12 12 12", gap: 4 }, anim: { enter: { type: "slide-up", ms: 220, easing: "decelerate" } } }, [
  handle(),
  n("head", "row", { style: { gap: 6, align: "center", padding: "0 0 4 4" } }, [
    n("back", "iconButton", { if: `${F}.canBack`, props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("msg.forwardRoom") }),
    n("head-icon", "icon", { if: `!${F}.canBack`, props: { icon: "forward", size: 20, color: "@primary" }, style: { margin: "0 6 0 6" } }),
    n("title", "text", { text: `{=${F}.step == 'who' ? _('msg.forwardTo') : _('fwd.title')}`, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
    n("close", "iconButton", { props: { icon: "x", label: "{_'nav.close'}" }, on: click("sheet.close") }),
  ]),
  // What goes: who wrote it, two lines, its kind.
  n("what", "row", { style: { gap: 10, padding: "8 12 8 0", margin: "0 4 6 4", radius: 14, bg: "@surfaceVariant", align: "center" } }, [
    n("what-bar", "column", { style: { width: 3, self: "stretch", radius: 2, bg: "@primary" } }),
    n("what-col", "column", { style: { weight: 1, gap: 1 } }, [
      n("what-from", "text", { text: `{${F}.sender}`, props: { variant: "label" }, style: { fg: "@primary", bold: true, lines: 1 } }),
      n("what-text", "text", { text: `{${F}.text}`, props: { variant: "caption" }, style: { lines: 2 } }),
    ]),
    n("what-icon", "icon", { if: `${F}.icon`, props: { icon: `=${F}.icon`, size: 18, color: "@muted" } }),
  ]),
  n("scroll", "scroll", {}, [
    n("list", "column", { style: { padding: "0 0 4 0" } }, [
      n("rooms", "column", { if: `${F}.step == 'room'` }, [
        pickRow("room", tile("room-tile", "messages-square"), "{$fr.name}", "{$fr.users} {_'room.people'}{=$fr.here ? ' · ' + _('fwd.here') : ''}", "chevron-right",
          { each: `${F}.rooms`, as: "fr", on: click("msg.forwardRoom", "{$fr.key}") }),
      ]),
      n("who", "column", { if: `${F}.step == 'who'` }, [
        pickRow("all", tile("all-tile", "users"), "{_'msg.everyone'}", `{_'fwd.wholeRoom'} {${F}.room}`, "send", { on: click("msg.forwardTo") }),
        pickRow("person", n("person-face", "avatar", { props: { name: "{$fp.name}", size: 40 } }), "{$fp.name}", "{_'fwd.privately'}", "message-square-lock",
          { each: `${F}.people`, as: "fp", on: click("msg.forwardTo", "{$fp.id}") }),
        n("whole", "text", { if: `${F}.wholeRoom`, text: "{_'fwd.fileWholeRoom'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "4 8" } }),
        n("nobody", "text", { if: `!${F}.wholeRoom && !${F}.hasPeople`, text: "{_'msg.nobody'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "4 8" } }),
      ]),
    ]),
  ]),
]);

/* ==================================================== settings and profile */

const P = "$myProfile";

/** Settings: my profile on top — photo, name, what each audience sees — a tap opens the editor. */
const profileCard = (): ANode => n("me", "card", { style: { margin: "12 16 8 16", padding: "14 12 12 16", gap: 10 }, on: click("profile.open") }, [
  n("me-head", "row", { style: { gap: 14, align: "center" } }, [
    n("me-photo", "image", { if: `${P}.photo`, props: { src: `=${P}.photo`, fit: "cover" }, style: { width: 52, height: 52, radius: 26, bg: "@surfaceVariant" } }),
    n("me-mono", "avatar", { if: `!${P}.photo`, props: { name: `{=$account.signedIn ? ${P}.name : '?'}`, size: 52 } }),
    n("me-col", "column", { style: { weight: 1, gap: 2 } }, [
      n("me-name", "text", { text: `{${P}.name}`, props: { variant: "title" }, style: { bold: true, lines: 1 } }),
      n("me-user", "text", { if: `$account.signedIn && ${P}.nickname`, text: "@{$account.username}", props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
      n("me-edit", "text", { text: "{=$account.signedIn ? _('me.edit') : _('me.signin')}", props: { variant: "caption" }, style: { fg: "@primary", bold: true, lines: 2 } }),
    ]),
    n("me-go", "icon", { props: { icon: "chevron-right", size: 20, color: "@muted" } }),
  ]),
  n("me-who", "row", { if: `${P}.ready`, props: { wrap: true }, style: { gap: 6 } }, [
    n("me-public", "chip", { text: `{_'pf.aud.public'} · {${P}.counts.public}`, props: { icon: "globe" } }),
    n("me-room", "chip", { text: `{_'pf.aud.room.short'} · {${P}.counts.room}`, props: { icon: "users" } }),
    n("me-only", "chip", { text: `{_'pf.aud.me'} · {${P}.counts.me}`, props: { icon: "lock" } }),
  ]),
]);

/** One audience in the editor's "Who sees what": its icon, its name and count, the items by name. */
const whoRow = (id: string, icon: string, label: string, v: string): ANode => n(id, "row", { style: { gap: 12, align: "start" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 18, color: "@primary" }, style: { margin: "2 0 0 0" } }),
  n(`${id}-col`, "column", { style: { weight: 1, gap: 1 } }, [
    n(`${id}-label`, "text", { text: `${label} · {${v}.count}`, style: { bold: true, size: 14 } }),
    n(`${id}-items`, "text", { text: `{${v}.text}`, props: { variant: "caption" }, style: { fg: "@muted" } }),
  ]),
]);

const whoSees = (): ANode[] => [
  n("who-label", "text", { text: "{_'pf.who'}", props: { variant: "label" }, style: { fg: "@primary", bold: true, padding: "14 20 4 20" } }),
  n("who", "column", { style: { margin: "2 16 4 16", padding: "12 14", radius: 14, bg: "@surfaceVariant", gap: 10 } }, [
    whoRow("who-public", "globe", "{_'pf.aud.public'}", "$profile.whoSees.public"),
    whoRow("who-room", "users", "{_'pf.aud.room'}", "$profile.whoSees.room"),
    whoRow("who-me", "lock", "{_'pf.who.onlyMe'}", "$profile.whoSees.me"),
    n("who-hint", "text", { text: "{_'pf.who.hint'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
  ]),
];

/** A field's audience as a chip: a tap offers only me / room members / public (profile.audience). */
const fieldAudience = (): ANode => n("field-aud", "row", {
  style: { gap: 4, align: "center", padding: "5 10", radius: 999, bg: "@surfaceVariant" },
  on: click("profile.audience", "{$f.index}"),
}, [
  n("field-aud-icon", "icon", { props: { icon: "=$f.audIcon", size: 14, color: "=$f.audience == 'me' ? '@muted' : '@primary'" } }),
  n("field-aud-text", "text", { text: "{$f.audLabel}", props: { variant: "caption" }, style: { bold: true, fg: "=$f.audience == 'me' ? '@muted' : '@primary'" } }),
]);

function patchProfile(screens: Record<string, ANode>): void {
  // Settings: my profile first.
  const settings = screens.settings;
  const list = settings ? find(settings, "list") : null;
  if (list && !find(list, "me")) list.children = [profileCard(), ...(list.children ?? [])];
  // The editor: who sees what, under the legend; each field's audience as a chip.
  const editor = screens["settings.profile"];
  const edit = editor ? find(editor, "edit") : null;
  if (edit && !find(edit, "who")) insert(edit, { after: find(edit, "lg-public") ? "lg-public" : "intro" }, whoSees());
  const aud = editor ? find(editor, "field-aud") : null;
  if (editor && aud && aud.el === "icon") replace(editor, "field-aud", [fieldAudience()]);
  // My own detail in the People panel: what members see of me (6.7), then straight to the editor.
  const person = screens["users.person"];
  const body = person ? find(person, "body") : null;
  if (body && !find(body, "pf-mine")) {
    insert(body, { after: body.children?.some((c) => c.id === "pf-room") ? "pf-room" : "head" }, [
      n("pf-mine", "button", { if: "$form.person.me", text: "{_'me.editShort'}", props: { icon: "square-pen", variant: "tonal" }, style: { margin: "0 8 6 8" }, on: click("profile.open") }),
    ]);
  }
}

/** The main menu: My profile on top — just before Settings (signed in: the profile lives in the account's vault). */
export const PROFILE_MENU_ITEM: MenuItem = { id: "profile", icon: "circle-user-round", label: "{_'me.menu'}", action: "profile.open", if: "$account.signedIn" };

function patchMenus(menus: Record<string, MenuItem[]>): void {
  const main = menus.main;
  if (!main || main.some((m) => m.id === PROFILE_MENU_ITEM.id)) return;
  const at = main.findIndex((m) => m.id === "settings");
  main.splice(at < 0 ? 0 : at, 0, { ...PROFILE_MENU_ITEM });
}

/* ================================================================ screens */

const SAMPLE_SENDER = {
  id: "peer-9f2c41d0a7b3", name: "Alice", title: "Alice Nováková", nickDiffers: true, me: false, function: false, present: true, canMessage: true,
  username: "bystry-sokol-7k3q", photo: "", has: true,
  profile: { nickname: "Alice Nováková", about: "Lezu a piju kávu.", avatar: "", cover: "", fields: [{ icon: "globe", label: "Blog", value: "https://alice.example", type: "url" }] },
};
const SAMPLE_FORWARD = {
  step: "who", canBack: true, sender: "Alice", text: "Ahoj, jak to jde?", icon: "", room: "team", wholeRoom: false, hasPeople: true,
  rooms: [{ key: "team", name: "team", users: 4, here: true }, { key: "family", name: "family", users: 3, here: false }],
  people: [{ id: "peer-1", name: "Bob" }, { id: "peer-2", name: "Eva" }],
};

const SCREENS: ScreenDef[] = [
  { id: "message.sender", label: "Message › sender's profile", group: "parts", vars: ["$form.sender"], sample: { form: { sender: SAMPLE_SENDER } }, help: "A tap on a sender's avatar: what they share with the room's members (their room profile), else the name and that they share nothing; a private message, their details." },
  { id: "message.forward", label: "Message › forward", group: "parts", vars: ["$form.forward"], sample: { form: { forward: SAMPLE_FORWARD } }, help: "Forward a message (a left swipe on its bubble, the long press, a file's footer): the message, the connected rooms, then everyone there or one person privately." },
];

/* ================================================================ strings */

const T = (cs: string, en: string, de: string) => ({ cs, en, de });
const STR: Record<string, { cs: string; en: string; de: string }> = {
  // the quote card
  "quote.you": T("Vy", "You", "Sie"),
  "quote.photo": T("Fotka", "Photo", "Foto"),
  "quote.audio": T("Zvuková nahrávka", "Audio", "Audioaufnahme"),
  "quote.video": T("Video", "Video", "Video"),
  "quote.file": T("Soubor", "File", "Datei"),
  "quote.position": T("Poloha", "Location", "Standort"),
  "quote.sealed": T("Zapečetěná zpráva", "Sealed message", "Versiegelte Nachricht"),
  "quote.vanished": T("Zpráva už zmizela", "The message has vanished", "Die Nachricht ist verschwunden"),
  "quote.empty": T("Zpráva", "Message", "Nachricht"),
  "quote.replyTo": T("Odpověď na zprávu od", "A reply to a message from", "Antwort auf eine Nachricht von"),
  "quote.go": T("Přejít na původní zprávu", "Go to the original message", "Zur ursprünglichen Nachricht"),
  "quote.notLoaded": T(
    "Původní zpráva tu není — je starší, než kolik toto zařízení uchovává, nebo byla smazána či vypršela.",
    "The original message is not here — it is older than this device keeps, or it was deleted or expired.",
    "Die ursprüngliche Nachricht ist nicht hier — sie ist älter als das, was dieses Gerät aufbewahrt, oder wurde gelöscht bzw. ist abgelaufen.",
  ),
  "quote.hidden": T(
    "Původní zpráva je na tomto zařízení skrytá — ukážete ji tlačítkem „Skryté“.",
    "The original message is hidden on this device — the “Hidden” button shows it.",
    "Die ursprüngliche Nachricht ist auf diesem Gerät ausgeblendet — die Schaltfläche „Ausgeblendet“ zeigt sie.",
  ),
  // the sender
  "sender.profile": T("Profil", "Profile", "Profil"),
  "sender.inRoomAs": T("v místnosti jako", "in this room as", "in diesem Raum als"),
  "sender.none": T("S lidmi v místnosti nesdílí žádné údaje profilu.", "Shares no profile details with the people in this room.", "Teilt keine Profilangaben mit den Personen in diesem Raum."),
  "sender.note": T(
    "Vidíte jen to, co tento člověk sdílí se členy místnosti (šifrovaně end-to-end) — nic ze serveru.",
    "You see only what this person shares with the room's members (end-to-end encrypted) — nothing from the server.",
    "Sie sehen nur, was diese Person mit den Raummitgliedern teilt (Ende-zu-Ende-verschlüsselt) — nichts vom Server.",
  ),
  "sender.noteMine": T("Takhle vás vidí členové místností.", "This is how room members see you.", "So sehen Sie die Raummitglieder."),
  "sender.left": T("Už v místnosti není", "No longer in the room", "Nicht mehr im Raum"),
  "sender.function": T("Funkce místnosti", "A room function", "Eine Raumfunktion"),
  "sender.more": T("Podrobnosti", "Details", "Details"),
  // my profile
  "me.menu": T("Můj profil", "My profile", "Mein Profil"),
  "me.edit": T("Upravit profil a kdo co uvidí", "Edit your profile and who sees what", "Profil bearbeiten und festlegen, wer was sieht"),
  "me.editShort": T("Upravit můj profil", "Edit my profile", "Mein Profil bearbeiten"),
  "me.signin": T("Přihlaste se a nastavte si profil", "Sign in to set up your profile", "Melden Sie sich an, um Ihr Profil einzurichten"),
  "pf.who": T("Kdo co uvidí", "Who sees what", "Wer was sieht"),
  "pf.who.onlyMe": T("Jen já (nesdílí se)", "Only me (not shared)", "Nur ich (nicht geteilt)"),
  "pf.who.nothing": T("nic", "nothing", "nichts"),
  "pf.who.hint": T(
    "Členové místností vidí i vše veřejné. Kdo co uvidí, změníte u každé položky — štítkem u údaje nebo přepínačem pod fotkou, přezdívkou a textem.",
    "Room members also see everything public. Change who sees an item right at it — the chip beside a detail, or the switch under the photo, nickname and text.",
    "Raummitglieder sehen auch alles Öffentliche. Wer einen Eintrag sieht, ändern Sie direkt daran — mit dem Chip neben einer Angabe oder dem Schalter unter Foto, Spitzname und Text.",
  ),
  // forward
  "fwd.title": T("Přeposlat do místnosti", "Forward to a room", "In einen Raum weiterleiten"),
  "fwd.here": T("tato místnost", "this room", "dieser Raum"),
  "fwd.wholeRoom": T("všem v místnosti", "everyone in", "alle im Raum"),
  "fwd.privately": T("soukromě, jen tomuto člověku", "privately, only to them", "privat, nur an diese Person"),
  "fwd.fileWholeRoom": T(
    "Soubor jde vždy celé místnosti — přenos souboru nemá soukromou podobu.",
    "A file always goes to the whole room — a file transfer has no private form.",
    "Eine Datei geht immer an den ganzen Raum — eine Dateiübertragung hat keine private Form.",
  ),
};

export const AREA: DesignArea = {
  actions: [
    { action: "msg.quote", arg: "the original's message id", help: "A reply's quote card: scroll to the message it answers and flash it (or say it is not on this device / hidden)" },
    { action: "msg.sender", arg: "message id", help: "A sender's avatar: their profile as they share it with the room (message.sender), else their name and that they share nothing" },
    { action: "msg.forwardRoom", arg: "room key (empty = back to the rooms)", help: "The forward sheet: forward into this connected room — everyone there or one person next" },
    { action: "msg.forwardTo", arg: "person id (empty = everyone in the room)", help: "The forward sheet: send the forwarded message (privately to one person, or to the whole room)" },
    { action: "profile.audience", arg: "field index | nickname | about | avatar | cover", help: "Who sees an item of the profile: a menu with only me / room members / public" },
  ],
  screens: SCREENS,
  trees: { "message.sender": senderSheet, "message.forward": forwardSheet },
  strings: {
    cs: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.cs])),
    en: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.en])),
    de: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.de])),
  },
  patch(screens) {
    patchBubbles(screens);
    patchProfile(screens);
  },
  patchMenus,
};
