// 6.7 design area: the public profile — photo, background, public nickname,
// info, optional fields, each with who sees it (only me / room members /
// public), as the web's Profile panel (client/src/components/ProfileEditor.tsx).
//
//   settings.profile   the editor: the two pictures (picked, cropped, re-encoded
//                      without metadata — ProfileImages.java), the nickname
//                      (it pre-fills the name when joining a room), the about
//                      text, the fields (a tap edits one in a native dialog),
//                      the audience of each (lock / people / globe), a
//                      preview per audience, and saving ($profile —
//                      Profiles.scope; inputs bound to $form.pf*)
//   settings.user      a "Public profile" button for a signed-in user
//   users.person       what the person shares with the room (their profile
//                      frame, end-to-end encrypted), and on request the
//                      public profile of their username — marked verified
//                      when its account is the one signing their messages
//
// Java: profile/ProfileCard (the model, the same checks as the web),
// ProfileRoom (the room frames), Profiles (the vault card, the public part),
// ui/parts/ProfileUi (the actions, the field dialog, the people's detail).

import type { DesignArea } from "./design-67";
import type { ANode, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

const AUD_OPTIONS = "me:{_'pf.aud.me'}|room:{_'pf.aud.room'}|public:{_'pf.aud.public'}";

/* =============================================================== screens */

const SAMPLE_FIELD = { index: 0, type: "phone", typeLabel: "Telefon", icon: "phone", label: "Mobil", value: "+420 777 123 456", audience: "me", audIcon: "lock", invalid: false };
const SAMPLE_PROFILE = {
  signedIn: true, ready: true, loading: false, error: "", busy: false, msg: "", dirty: true, canAdd: true,
  avatar: "", cover: "", hasAvatar: false, hasCover: false, initials: "A",
  fields: [SAMPLE_FIELD, { ...SAMPLE_FIELD, index: 1, type: "url", typeLabel: "Web", icon: "globe", label: "Blog", value: "https://alice.example", audience: "public", audIcon: "globe" }],
  preview: { nickname: "Alice", about: "Lezu a piju kávu.", avatar: "", cover: "", fields: [{ icon: "globe", label: "Blog", value: "https://alice.example" }], empty: false },
};

const SCREENS: ScreenDef[] = [
  {
    id: "settings.profile", label: "Settings › Public profile", group: "app", vars: ["$profile", "$form", "$account"],
    sample: { profile: SAMPLE_PROFILE, form: { pfNick: "Alice", pfAbout: "Lezu a piju kávu.", pfNickAud: "public", pfAboutAud: "room", pfAvatarAud: "room", pfCoverAud: "me", pfPreview: "room" }, account: { signedIn: true, username: "bystry-sokol-7k3q" } },
    help: "The user's profile card: photo, background, public nickname (pre-fills the name when joining a room), about and fields — each only me / room members / public — with a preview per audience; saved sealed into the vault, its public part on the server.",
  },
];

/* ================================================================= trees */

const bar = (title: string): ANode => n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
  n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
  n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
  n("save-top", "iconButton", { if: "$profile.ready && $profile.dirty && !$profile.busy", props: { icon: "check", label: "{_'pf.save'}", variant: "primary" }, on: click("profile.save") }),
]);

const label = (id: string, key: string): ANode => n(id, "text", { text: `{_'${key}'}`, props: { variant: "label" }, style: { fg: "@primary", bold: true, padding: "14 20 4 20" } });
const hint = (id: string, key: string): ANode => n(id, "text", { text: `{_'${key}'}`, props: { variant: "caption" }, style: { fg: "@muted", padding: "2 20 4 20" } });
const audience = (id: string, bind: string): ANode => n(id, "segmented", { props: { bind, options: AUD_OPTIONS }, style: { margin: "4 20 2 20" }, on: { change: { action: "profile.sync" } } });

/** One audience in the legend: its icon and what it means. */
const legend = (id: string, icon: string, key: string): ANode => n(id, "row", { style: { gap: 10, align: "start", padding: "2 20" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 16, color: "@primary" } }),
  n(`${id}-text`, "text", { text: `{_'${key}'} — {_'${key}.hint'}`, props: { variant: "caption" }, style: { weight: 1, fg: "@muted" } }),
]);

/** The preview of one audience, or another member's profile: background, photo, nickname, about, fields. */
const card = (id: string, p: string, fallback: string): ANode => n(id, "card", { style: { margin: "4 16", padding: 0, gap: 0 } }, [
  n(`${id}-cover`, "image", { if: `${p}.cover`, props: { src: `=${p}.cover`, fit: "cover", ratio: 3 }, style: { radius: 12 } }),
  n(`${id}-head`, "row", { style: { gap: 12, align: "center", padding: "10 12 4 12" } }, [
    n(`${id}-photo`, "image", { if: `${p}.avatar`, props: { src: `=${p}.avatar`, fit: "cover" }, style: { width: 52, height: 52, radius: 26 } }),
    n(`${id}-mono`, "avatar", { if: `!${p}.avatar`, props: { name: `{=${p}.nickname ? ${p}.nickname : ${fallback}}`, size: 52 } }),
    n(`${id}-nick`, "text", { text: `{=${p}.nickname ? ${p}.nickname : ${fallback}}`, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 2 } }),
  ]),
  n(`${id}-about`, "text", { if: `${p}.about`, text: `{${p}.about}`, style: { padding: "2 12 6 12" } }),
  n(`${id}-field`, "row", { each: `${p}.fields`, as: "pf", style: { gap: 10, align: "start", padding: "4 12" } }, [
    n(`${id}-field-icon`, "icon", { props: { icon: "=$pf.icon", size: 16, color: "@muted" } }),
    n(`${id}-field-label`, "text", { text: "{$pf.label}", props: { variant: "caption" }, style: { fg: "@muted", width: 96 } }),
    n(`${id}-field-value`, "text", { text: "{$pf.value}", props: { links: true }, style: { weight: 1 } }),
  ]),
  n(`${id}-end`, "spacer", { props: { size: 8 } }),
]);

const editor: ANode = n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
  bar("{_'pf.title'}"),
  n("scroll", "scroll", { style: { weight: 1 } }, [n("list", "column", { style: { padding: "0 0 32 0" } }, [
    n("signin", "column", { if: "!$profile.signedIn", style: { padding: "20", gap: 12 } }, [
      n("signin-text", "text", { text: "{_'pf.needSignIn'}", style: { fg: "@muted" } }),
      n("signin-go", "button", { text: "{_'set.user.signin'}", props: { icon: "fingerprint-pattern", variant: "primary" }, on: click("account.signin") }),
    ]),
    n("loading", "row", { if: "$profile.signedIn && !$profile.ready", style: { padding: 20, gap: 12, align: "center" } }, [
      n("loading-bar", "progress", { if: "$profile.loading", style: { width: 28 } }),
      n("loading-text", "text", { text: "{=$profile.error ? _('pf.loadFailed') + ' ' + $profile.error : _('pf.loading')}", style: { weight: 1, fg: "@muted" } }),
    ]),
    n("edit", "column", { if: "$profile.ready" }, [
      n("intro", "text", { text: "{_'pf.intro'}", style: { padding: "14 20 6 20" } }),
      legend("lg-me", "lock", "pf.aud.me"),
      legend("lg-room", "users", "pf.aud.room"),
      legend("lg-public", "globe", "pf.aud.public"),

      label("photo-label", "pf.avatar"),
      n("photo-row", "row", { style: { gap: 14, align: "center", padding: "4 20" } }, [
        n("photo", "image", { if: "$profile.hasAvatar", props: { src: "=$profile.avatar", fit: "cover" }, style: { width: 64, height: 64, radius: 32 } }),
        n("photo-mono", "avatar", { if: "!$profile.hasAvatar", props: { name: "{$profile.initials}", size: 64 } }),
        n("photo-pick", "button", { text: "{_'pf.pick'}", props: { icon: "camera", variant: "tonal" }, on: click("profile.pick", "avatar") }),
        n("photo-clear", "iconButton", { if: "$profile.hasAvatar", props: { icon: "trash", label: "{_'pf.remove'}" }, on: click("profile.clear", "avatar") }),
      ]),
      audience("photo-aud", "pfAvatarAud"),

      label("cover-label", "pf.cover"),
      n("cover", "image", { if: "$profile.hasCover", props: { src: "=$profile.cover", fit: "cover", ratio: 3 }, style: { margin: "4 20", radius: 12 } }),
      n("cover-row", "row", { style: { gap: 10, align: "center", padding: "4 20" } }, [
        n("cover-pick", "button", { text: "{_'pf.pick'}", props: { icon: "image", variant: "tonal" }, on: click("profile.pick", "cover") }),
        n("cover-clear", "button", { if: "$profile.hasCover", text: "{_'pf.remove'}", props: { icon: "trash", variant: "text" }, on: click("profile.clear", "cover") }),
      ]),
      audience("cover-aud", "pfCoverAud"),
      hint("image-note", "pf.image.note"),

      label("nick-label", "pf.nickname"),
      n("nick", "input", { props: { bind: "pfNick", hint: "{_'pf.nickname'}" }, style: { margin: "4 20" } }),
      audience("nick-aud", "pfNickAud"),
      hint("nick-hint", "pf.nickname.hint"),

      label("about-label", "pf.about"),
      n("about", "input", { props: { bind: "pfAbout", type: "multiline", hint: "{_'pf.about'}" }, style: { margin: "4 20" } }),
      audience("about-aud", "pfAboutAud"),

      label("fields-label", "pf.fields"),
      n("field", "row", { each: "$profile.fields", as: "f", style: { gap: 12, align: "center", padding: "10 20" }, on: click("profile.field", "{$f.index}") }, [
        n("field-icon", "icon", { props: { icon: "=$f.icon", size: 20, color: "@muted" } }),
        n("field-col", "column", { style: { weight: 1 } }, [
          n("field-label", "text", { text: "{=$f.label ? $f.label : $f.typeLabel}", props: { variant: "caption" }, style: { fg: "@muted" } }),
          n("field-value", "text", { text: "{$f.value}", style: { lines: 3 } }),
          n("field-invalid", "text", { if: "$f.invalid", text: "{_'pf.field.invalid'}", props: { variant: "caption" }, style: { fg: "@danger" } }),
        ]),
        n("field-aud", "icon", { props: { icon: "=$f.audIcon", size: 18, color: "=$f.audience == 'me' ? '@muted' : '@primary'" } }),
      ]),
      n("field-add", "button", { if: "$profile.canAdd", text: "{_'pf.addField'}", props: { icon: "plus", variant: "text" }, style: { margin: "0 12" }, on: click("profile.field", "new") }),

      label("preview-label", "pf.preview"),
      audience("preview-aud", "pfPreview"),
      n("preview-empty", "text", { if: "$profile.preview.empty", text: "{_'pf.preview.empty'}", style: { fg: "@muted", padding: "6 20" } }),
      n("preview", "column", { if: "!$profile.preview.empty" }, [card("pv", "$profile.preview", "$account.username")]),

      n("save", "button", { text: "{=$profile.busy ? _('pf.saving') : _('pf.save')}", props: { icon: "check", variant: "primary", disabled: "=$profile.busy || !$profile.dirty" }, style: { margin: "18 20 4 20" }, on: click("profile.save") }),
      n("dirty", "text", { if: "$profile.dirty && !$profile.busy", text: "{_'pf.dirty'}", props: { variant: "caption", align: "center" }, style: { fg: "@muted" } }),
      n("msg", "text", { if: "$profile.msg", text: "{$profile.msg}", props: { variant: "caption", align: "center" }, style: { padding: "4 20" } }),
    ]),
  ])]),
]);

/* ================================================================ patches */

const find = (node: ANode, id: string): ANode | null => {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
};

const insert = (parent: ANode, at: { after?: string; before?: string }, nodes: ANode[]): void => {
  const kids = parent.children ?? [];
  const i = kids.findIndex((k) => k.id === (at.after ?? at.before));
  kids.splice(i < 0 ? kids.length : at.after ? i + 1 : i, 0, ...nodes);
  parent.children = kids;
};

const P = "$form.person";

/** What a person shares (users.person): their room profile, and their public one on request. */
function personProfile(): ANode[] {
  return [
    n("pf-room", "column", { if: `${P}.profile.has` }, [
      n("pf-room-title", "text", { text: "{_'pf.view.room'}", props: { variant: "label" }, style: { fg: "@primary", bold: true, padding: "4 8 2 8" } }),
      card("pf-rc", `${P}.profile.room`, `${P}.name`),
    ]),
    n("pf-public-load", "button", { if: `!${P}.me && ${P}.username && !${P}.profile.publicState`, text: "{_'pf.view.loadPublic'} @{$form.person.username}", props: { icon: "globe", variant: "text" }, on: click("profile.public", `{${P}.username}`) }),
    n("pf-public-wait", "text", { if: `${P}.profile.publicState == 'loading'`, text: "{_'pf.view.loading'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "2 8" } }),
    n("pf-public-none", "text", { if: `${P}.profile.publicState == 'none'`, text: "{_'pf.view.none'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "2 8" } }),
    n("pf-public", "column", { if: `${P}.profile.publicState == 'ok'` }, [
      n("pf-public-title", "text", { text: "{_'pf.view.public'} · @{$form.person.username}", props: { variant: "label" }, style: { fg: "@primary", bold: true, padding: "8 8 2 8" } }),
      n("pf-public-trust", "row", { style: { gap: 6, align: "center", padding: "0 8 2 8" } }, [
        n("pf-public-trust-icon", "icon", { props: { icon: `=${P}.profile.publicVerified ? 'shield-check' : 'shield-question-mark'`, size: 14, color: `=${P}.profile.publicVerified ? '@success' : '@muted'` } }),
        n("pf-public-trust-text", "text", { text: `{=${P}.profile.publicVerified ? _('pf.view.verified') : _('pf.view.unverified')}`, props: { variant: "caption" }, style: { fg: "@muted", weight: 1 } }),
      ]),
      card("pf-pc", `${P}.profile.public`, `${P}.name`),
    ]),
  ];
}

function patch(screens: Record<string, ANode>): void {
  // Settings › User: "Public profile" for a signed-in user, under the account.
  const user = screens["settings.user"];
  const box = user ? find(user, "card") : null;
  if (box && !find(box, "profile")) {
    insert(box, { after: "who" }, [
      n("profile", "button", { if: "$account.signedIn", text: "{_'pf.title'}", props: { icon: "circle-user-round", variant: "tonal" }, on: click("profile.open") }),
    ]);
  }
  // A person's detail: their profile under the head.
  const person = screens["users.person"];
  const body = person ? find(person, "body") : null;
  if (body && !find(body, "pf-room")) insert(body, { after: "head" }, personProfile());
}

/* =============================================================== strings */

const STRINGS: DesignArea["strings"] = {
  cs: {
    "pf.title": "Veřejný profil",
    "pf.intro": "Fotka, pozadí, veřejná přezdívka, pár slov o vás a další údaje. U každé položky zvolíte, kdo ji uvidí.",
    "pf.aud.me": "Jen já", "pf.aud.room": "Místnosti", "pf.aud.public": "Veřejné",
    "pf.aud.me.hint": "zůstane zapečetěné ve vašem trezoru, jen pro vaše zařízení",
    "pf.aud.room.hint": "pošle se šifrovaně (end-to-end) lidem v místnostech, do kterých vstoupíte; server to nepřečte",
    "pf.aud.public.hint": "uloží se na serveru a přečte si to každý, kdo zná vaše uživatelské jméno",
    "pf.avatar": "Profilová fotka", "pf.cover": "Fotka na pozadí", "pf.pick": "Vybrat", "pf.remove": "Odebrat",
    "pf.image.note": "Obrázek se před uložením zmenší a překóduje — metadata (EXIF, poloha GPS, fotoaparát) se zahodí.",
    "pf.nickname": "Veřejná přezdívka", "pf.nickname.hint": "Předvyplní se jako jméno, když vstoupíte do místnosti — tam ho pořád můžete změnit.",
    "pf.about": "O mně", "pf.fields": "Další údaje", "pf.addField": "Přidat údaj",
    "pf.field.title": "Údaj", "pf.field.type": "Druh", "pf.field.label": "Popisek", "pf.field.value": "Hodnota", "pf.field.audience": "Kdo ho uvidí",
    "pf.field.save": "Hotovo", "pf.field.cancel": "Zrušit", "pf.field.remove": "Odebrat", "pf.field.invalid": "Tohle nevypadá jako platná hodnota — sdílet se nebude.",
    "pf.type.name": "Jméno", "pf.type.phone": "Telefon", "pf.type.email": "E-mail", "pf.type.address": "Adresa", "pf.type.url": "Web",
    "pf.type.social": "Sociální síť", "pf.type.org": "Organizace / role", "pf.type.birthday": "Narozeniny", "pf.type.other": "Jiné",
    "pf.preview": "Jak mě vidí ostatní", "pf.preview.empty": "Tomuto publiku se nezobrazí nic.",
    "pf.save": "Uložit profil", "pf.saving": "Ukládám…", "pf.saved": "Uloženo.", "pf.saved.published": "Uloženo — veřejná část je na serveru.",
    "pf.saved.withdrawn": "Uloženo — veřejný profil byl ze serveru odebrán.", "pf.saved.publicFailed": "Uloženo v trezoru, ale veřejnou část se nepodařilo uložit:",
    "pf.dirty": "Neuložené změny", "pf.loading": "Otevírám váš profil…", "pf.loadFailed": "Profil se nepodařilo otevřít:",
    "pf.err.image": "Tento obrázek nejde použít.", "pf.err.imageLarge": "Obrázek je příliš velký i po zmenšení.",
    "pf.needSignIn": "Profil se ukládá zapečetěný v trezoru vašeho účtu — přihlaste se passkeyem.",
    "pf.view.room": "Sdílí v místnosti", "pf.view.public": "Veřejný profil", "pf.view.loadPublic": "Zobrazit veřejný profil",
    "pf.view.none": "Žádný veřejný profil.", "pf.view.loading": "Načítám…",
    "pf.view.verified": "Patří účtu, který podepisuje zprávy tohoto člověka.", "pf.view.unverified": "Neověřeno — uživatelské jméno je jen tvrzení tohoto člověka.",
  },
  en: {
    "pf.title": "Public profile",
    "pf.intro": "A photo, a background, a public nickname, a few words about you and more. For each item you choose who sees it.",
    "pf.aud.me": "Only me", "pf.aud.room": "Rooms", "pf.aud.public": "Public",
    "pf.aud.me.hint": "stays sealed in your vault, for your own devices",
    "pf.aud.room.hint": "sent end-to-end encrypted to the people in the rooms you join; the server cannot read it",
    "pf.aud.public.hint": "stored on the server; anyone who knows your username can read it",
    "pf.avatar": "Profile photo", "pf.cover": "Background photo", "pf.pick": "Choose", "pf.remove": "Remove",
    "pf.image.note": "The picture is shrunk and re-encoded before it is saved — its metadata (EXIF, GPS position, camera) is dropped.",
    "pf.nickname": "Public nickname", "pf.nickname.hint": "Pre-fills your name when you join a room — you can still change it there.",
    "pf.about": "About me", "pf.fields": "More information", "pf.addField": "Add an item",
    "pf.field.title": "Item", "pf.field.type": "Kind", "pf.field.label": "Label", "pf.field.value": "Value", "pf.field.audience": "Who sees it",
    "pf.field.save": "Done", "pf.field.cancel": "Cancel", "pf.field.remove": "Remove", "pf.field.invalid": "This does not look like a valid value — it will not be shared.",
    "pf.type.name": "Name", "pf.type.phone": "Phone", "pf.type.email": "E-mail", "pf.type.address": "Address", "pf.type.url": "Website",
    "pf.type.social": "Social network", "pf.type.org": "Organisation / role", "pf.type.birthday": "Birthday", "pf.type.other": "Other",
    "pf.preview": "How others see me", "pf.preview.empty": "Nothing is shown to this audience.",
    "pf.save": "Save the profile", "pf.saving": "Saving…", "pf.saved": "Saved.", "pf.saved.published": "Saved — the public part is on the server.",
    "pf.saved.withdrawn": "Saved — the public profile was removed from the server.", "pf.saved.publicFailed": "Saved in your vault, but the public part failed:",
    "pf.dirty": "Unsaved changes", "pf.loading": "Opening your profile…", "pf.loadFailed": "The profile could not be opened:",
    "pf.err.image": "This picture cannot be used.", "pf.err.imageLarge": "The picture is too large even after shrinking.",
    "pf.needSignIn": "The profile is kept sealed in your account's vault — sign in with your passkey.",
    "pf.view.room": "Shares in the room", "pf.view.public": "Public profile", "pf.view.loadPublic": "Show the public profile",
    "pf.view.none": "No public profile.", "pf.view.loading": "Loading…",
    "pf.view.verified": "Belongs to the account that signs this person's messages.", "pf.view.unverified": "Not verified — the username is only this person's claim.",
  },
  de: {
    "pf.title": "Öffentliches Profil",
    "pf.intro": "Ein Foto, ein Hintergrund, ein öffentlicher Spitzname, ein paar Worte über Sie und mehr. Für jeden Eintrag wählen Sie, wer ihn sieht.",
    "pf.aud.me": "Nur ich", "pf.aud.room": "Räume", "pf.aud.public": "Öffentlich",
    "pf.aud.me.hint": "bleibt versiegelt in Ihrem Tresor, nur für Ihre eigenen Geräte",
    "pf.aud.room.hint": "wird Ende-zu-Ende-verschlüsselt an die Personen in den Räumen gesendet, die Sie betreten; der Server kann es nicht lesen",
    "pf.aud.public.hint": "wird auf dem Server gespeichert; jeder, der Ihren Benutzernamen kennt, kann es lesen",
    "pf.avatar": "Profilfoto", "pf.cover": "Hintergrundfoto", "pf.pick": "Auswählen", "pf.remove": "Entfernen",
    "pf.image.note": "Das Bild wird vor dem Speichern verkleinert und neu kodiert — seine Metadaten (EXIF, GPS-Position, Kamera) werden verworfen.",
    "pf.nickname": "Öffentlicher Spitzname", "pf.nickname.hint": "Wird als Name vorausgefüllt, wenn Sie einen Raum betreten — dort können Sie ihn weiterhin ändern.",
    "pf.about": "Über mich", "pf.fields": "Weitere Angaben", "pf.addField": "Angabe hinzufügen",
    "pf.field.title": "Angabe", "pf.field.type": "Art", "pf.field.label": "Bezeichnung", "pf.field.value": "Wert", "pf.field.audience": "Wer sie sieht",
    "pf.field.save": "Fertig", "pf.field.cancel": "Abbrechen", "pf.field.remove": "Entfernen", "pf.field.invalid": "Das sieht nicht nach einem gültigen Wert aus — es wird nicht geteilt.",
    "pf.type.name": "Name", "pf.type.phone": "Telefon", "pf.type.email": "E-Mail", "pf.type.address": "Adresse", "pf.type.url": "Website",
    "pf.type.social": "Soziales Netzwerk", "pf.type.org": "Organisation / Rolle", "pf.type.birthday": "Geburtstag", "pf.type.other": "Sonstiges",
    "pf.preview": "Wie andere mich sehen", "pf.preview.empty": "Diesem Publikum wird nichts gezeigt.",
    "pf.save": "Profil speichern", "pf.saving": "Speichere…", "pf.saved": "Gespeichert.", "pf.saved.published": "Gespeichert — der öffentliche Teil liegt auf dem Server.",
    "pf.saved.withdrawn": "Gespeichert — das öffentliche Profil wurde vom Server entfernt.", "pf.saved.publicFailed": "Im Tresor gespeichert, aber der öffentliche Teil ist fehlgeschlagen:",
    "pf.dirty": "Ungespeicherte Änderungen", "pf.loading": "Öffne Ihr Profil…", "pf.loadFailed": "Das Profil ließ sich nicht öffnen:",
    "pf.err.image": "Dieses Bild lässt sich nicht verwenden.", "pf.err.imageLarge": "Das Bild ist auch verkleinert zu groß.",
    "pf.needSignIn": "Das Profil wird versiegelt im Tresor Ihres Kontos aufbewahrt — melden Sie sich mit Ihrem Passkey an.",
    "pf.view.room": "Teilt im Raum", "pf.view.public": "Öffentliches Profil", "pf.view.loadPublic": "Öffentliches Profil anzeigen",
    "pf.view.none": "Kein öffentliches Profil.", "pf.view.loading": "Lade…",
    "pf.view.verified": "Gehört dem Konto, das die Nachrichten dieser Person signiert.", "pf.view.unverified": "Nicht verifiziert — der Benutzername ist nur die Angabe dieser Person.",
  },
};

export const AREA: DesignArea = {
  actions: [
    { action: "profile.open", arg: "", help: "Settings › Public profile: the editor, with the card as it is saved" },
    { action: "profile.pick", arg: "avatar | cover", help: "Pick the photo or the background (cropped, shrunk, re-encoded without metadata)" },
    { action: "profile.clear", arg: "avatar | cover", help: "Remove the photo or the background" },
    { action: "profile.field", arg: "field index | new", help: "Edit a field (kind, label, value, who sees it) or add one, in a dialog" },
    { action: "profile.sync", arg: "", help: "Take the form's values (nickname, about, audiences, preview) into the editor and draw it again" },
    { action: "profile.save", arg: "", help: "Save: the whole card sealed into the vault, the public part on the server (withdrawn when nothing is public)" },
    { action: "profile.public", arg: "username", help: "Look up the public profile of a person's username (their detail shows it)" },
  ],
  screens: SCREENS,
  trees: { "settings.profile": editor },
  strings: STRINGS,
  patch,
};
