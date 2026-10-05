// The iOS design (6.14): the same design language as Android's (elements,
// actions, expressions, texts, menus, libraries — server/android/design.ts),
// its own document. The default is Android's default design with an iOS look:
// the system colours (blue tint, grouped backgrounds, iMessage-like bubbles),
// iOS corner radii and transitions, and "sans" drawn in SF Pro by the app.
// Builds are the same M5PK / M5AB bundles, gated by minAppCode for iOS builds
// (the first iOS app is 6.14.0 = 61400).
//
// What iOS cannot do of a valid design (docs/ios-architecture.md §5) is not
// refused — the app hides or replaces it — but the console says so: the
// warnings of /design/validate and /design/preview.
//
// iOS-only items live only here, never in Android's design: the Apple Watch
// switch in Settings › Notifications (setting watch.on — M5Design's
// SettingsModel / SettingSchema: off by default, a private area no design
// action may change) and the texts only the iOS app says (IOS_STRINGS: the
// watch app's, the system NFC sheet's). The iOS app ships this design
// (script/ios-assets.ts → ios/Design/m5/, copied by the Xcode build phase
// "Copy design assets"). The design's scope has no platform variable ($app is
// name / version / code / bundle on both apps): a design is one platform's
// document, so it simply contains what that app shows. A shared design that
// ever needed iOS-only visibility would add "platform" to $app (M5Design
// ScreenScope.app, Android MainActivity.appScope) and use
// if: "$app.platform == 'ios'".

import { join } from "node:path";
import {
  androidCatalog, DEFAULT_ANIMATIONS, DEFAULT_DESIGN, designRev, LANGS, sanitizeDesign,
  type AndroidDesign, type ANode, type Animations, type Theme,
} from "../android/design";
import type { Locale } from "../../client/src/lib/locales";
import { designMinAppCode } from "../mobile/bundle";
import { createDesignStore } from "../mobile/design-store";
import { mobileDir } from "../mobile/store";
import type { AndroidTheme } from "../android/themes";
import { THEMES_67_LOOK } from "../android/design-67-look";

/** The first iOS app (6.14.0): the oldest that reads bundle format 1. */
export const IOS_MIN_APP_CODE = 61400;

/**
 * iOS system colours on the design's tokens. The tint is iOS blue, darkened
 * where white text sits on it (#0064e0: 5.4:1; Apple's #007aff is 4.0:1) and
 * lightened in the dark tone with dark text on it; red / green / orange are
 * Apple's accessible variants.
 */
export const IOS_THEME: Theme = {
  light: {
    primary: "#0064e0", onPrimary: "#ffffff", background: "#f2f2f7", surface: "#ffffff", surfaceVariant: "#e5e5ea", onSurface: "#000000",
    muted: "#6c6c70", accent: "#5856d6", border: "#c6c6c8", danger: "#d70015", success: "#248a3d", warning: "#c93400",
    bubbleIn: "#e9e9eb", onBubbleIn: "#000000", bubbleOut: "#0064e0", onBubbleOut: "#ffffff", scrim: "#66000000",
  },
  dark: {
    primary: "#409cff", onPrimary: "#001a33", background: "#000000", surface: "#1c1c1e", surfaceVariant: "#2c2c2e", onSurface: "#ffffff",
    muted: "#98989f", accent: "#7d7aff", border: "#38383a", danger: "#ff6961", success: "#30db5b", warning: "#ffb340",
    bubbleIn: "#262628", onBubbleIn: "#ffffff", bubbleOut: "#0060c8", onBubbleOut: "#ffffff", scrim: "#99000000",
  },
  radius: 12,
  font: "sans",
  density: "normal",
};

/** iOS motion: a pushed screen slides in from the right, sheets rise from the bottom. */
export const IOS_ANIMATIONS: Animations = {
  ...structuredClone(DEFAULT_ANIMATIONS),
  screen: { type: "slide-left", ms: 350, easing: "decelerate" },
  dialog: { type: "slide-up", ms: 300, easing: "decelerate" },
  message: { type: "slide-up", ms: 220, easing: "decelerate" },
  users: { type: "slide-left", ms: 300, easing: "decelerate" },
  splash: { style: "reveal", ms: 900, minMs: 500 },
};

/* ===================================================== iOS-only items */

type Texts = Record<Locale, string>;
const T = (en: string, cs: string, de: string, es: string, it: string, fr: string, sk: string, sl: string, fi: string): Texts => ({ en, cs, de, es, it, fr, sk, sl, fi });
/** The same text in every language (product names, formats). */
const SAME = (s: string): Texts => T(s, s, s, s, s, s, s, s, s);

/** The Apple Watch switch's setting (M5Design SettingsModel: false; SettingSchema: private area "watch."). */
export const IOS_WATCH_SETTING = "watch.on";

/**
 * The texts only the iOS app says, in the nine languages (i18n/GLOSSARY.md).
 * watch.*: the Apple Watch switch, and what the watch app shows — the phone
 * sends them in the user's language (ios/M5cet/Platform/Watch/WatchWire.swift:
 * WatchWire.english is the fallback). nfc.ios.*: the system NFC sheet
 * (ios/M5cet/Platform/NFC/NfcSheetTexts.swift).
 */
export const IOS_STRINGS: Record<string, Texts> = {
  /* ------------------------------------------- Settings › Notifications */
  "watch.setting": SAME("Apple Watch"),
  "watch.setting.hint": T(
    "Shows recent messages on your Apple Watch while M5cet is unlocked on this iPhone.",
    "Na hodinkách Apple Watch ukazuje poslední zprávy, dokud je aplikace M5cet na tomto iPhonu odemčená.",
    "Zeigt die letzten Nachrichten auf Ihrer Apple Watch, solange M5cet auf diesem iPhone entsperrt ist.",
    "Muestra los mensajes recientes en tu Apple Watch mientras la app M5cet esté desbloqueada en este iPhone.",
    "Mostra i messaggi recenti sul tuo Apple Watch finché l’app M5cet è sbloccata su questo iPhone.",
    "Affiche les messages récents sur votre Apple Watch tant que l’app M5cet est déverrouillée sur cet iPhone.",
    "Na hodinkách Apple Watch zobrazuje posledné správy, kým je aplikácia M5cet na tomto iPhone odomknutá.",
    "Prikazuje zadnja sporočila na uri Apple Watch, dokler je aplikacija M5cet v tem iPhonu odklenjena.",
    "Näyttää viimeisimmät viestit Apple Watchissa, kun M5cet-sovelluksen lukitus on avattu tässä iPhonessa.",
  ),

  /* -------------------------------------------- the watch app's states */
  "watch.locked": T("Locked on iPhone", "Zamčeno na iPhonu", "Auf dem iPhone gesperrt", "Bloqueado en el iPhone", "Bloccato sull’iPhone", "Verrouillé sur l’iPhone", "Zamknuté na iPhone", "Zaklenjeno v iPhonu", "Lukittu iPhonessa"),
  "watch.locked.hint": T(
    "Unlock M5cet on your iPhone to see your rooms here.",
    "Odemkněte M5cet na iPhonu a uvidíte tu své místnosti.",
    "Entsperren Sie M5cet auf Ihrem iPhone, um Ihre Räume hier zu sehen.",
    "Desbloquea M5cet en tu iPhone para ver aquí tus salas.",
    "Sblocca M5cet sul tuo iPhone per vedere qui le tue stanze.",
    "Déverrouillez M5cet sur votre iPhone pour voir vos salles ici.",
    "Odomknite M5cet na iPhone a uvidíte tu svoje miestnosti.",
    "Odklenite M5cet v iPhonu, da tukaj vidite svoje sobe.",
    "Avaa M5cet iPhonessa, niin näet huoneesi täällä.",
  ),
  "watch.off": T("Off on iPhone", "Vypnuto na iPhonu", "Auf dem iPhone ausgeschaltet", "Desactivado en el iPhone", "Disattivato sull’iPhone", "Désactivé sur l’iPhone", "Vypnuté na iPhone", "Izklopljeno v iPhonu", "Pois päältä iPhonessa"),
  "watch.off.hint": T(
    "Turn on Apple Watch in M5cet on your iPhone (Settings › Notifications).",
    "Zapněte Apple Watch v aplikaci M5cet na iPhonu (Nastavení › Oznámení).",
    "Schalten Sie Apple Watch in M5cet auf Ihrem iPhone ein (Einstellungen › Benachrichtigungen).",
    "Activa Apple Watch en la app M5cet de tu iPhone (Ajustes › Notificaciones).",
    "Attiva Apple Watch nell’app M5cet del tuo iPhone (Impostazioni › Notifiche).",
    "Activez Apple Watch dans l’app M5cet de votre iPhone (Paramètres › Notifications).",
    "Zapnite Apple Watch v aplikácii M5cet na iPhone (Nastavenia › Upozornenia).",
    "Vklopite Apple Watch v aplikaciji M5cet v iPhonu (Nastavitve › Obvestila).",
    "Ota Apple Watch käyttöön iPhonen M5cet-sovelluksessa (Asetukset › Ilmoitukset).",
  ),
  "watch.waiting": T("Open M5cet on your iPhone", "Otevřete M5cet na iPhonu", "Öffnen Sie M5cet auf dem iPhone", "Abre M5cet en tu iPhone", "Apri M5cet sul tuo iPhone", "Ouvrez M5cet sur votre iPhone", "Otvorte M5cet na iPhone", "Odprite M5cet v iPhonu", "Avaa M5cet iPhonessa"),
  "watch.waiting.hint": T(
    "Your rooms show here while M5cet is unlocked on your iPhone.",
    "Vaše místnosti se tu ukazují, dokud je aplikace M5cet na iPhonu odemčená.",
    "Ihre Räume erscheinen hier, solange M5cet auf Ihrem iPhone entsperrt ist.",
    "Tus salas aparecen aquí mientras la app M5cet esté desbloqueada en tu iPhone.",
    "Le tue stanze compaiono qui finché l’app M5cet è sbloccata sul tuo iPhone.",
    "Vos salles s’affichent ici tant que l’app M5cet est déverrouillée sur votre iPhone.",
    "Vaše miestnosti sa tu zobrazujú, kým je aplikácia M5cet na iPhone odomknutá.",
    "Vaše sobe so prikazane tukaj, dokler je aplikacija M5cet v iPhonu odklenjena.",
    "Huoneesi näkyvät täällä, kun M5cet-sovelluksen lukitus on avattu iPhonessa.",
  ),
  "watch.away": T("iPhone not connected", "iPhone není připojený", "iPhone nicht verbunden", "iPhone no conectado", "iPhone non connesso", "iPhone non connecté", "iPhone nie je pripojený", "iPhone ni povezan", "iPhone ei ole yhdistetty"),
  "watch.away.hint": T(
    "Messages show again when your iPhone is near and M5cet is unlocked.",
    "Zprávy se znovu ukážou, až bude iPhone nablízku a aplikace M5cet odemčená.",
    "Nachrichten erscheinen wieder, wenn Ihr iPhone in der Nähe und M5cet entsperrt ist.",
    "Los mensajes volverán a aparecer cuando tu iPhone esté cerca y la app M5cet, desbloqueada.",
    "I messaggi ricompariranno quando l’iPhone sarà vicino e l’app M5cet sbloccata.",
    "Les messages réapparaîtront quand votre iPhone sera à proximité et l’app M5cet déverrouillée.",
    "Správy sa znova zobrazia, keď bude iPhone nablízku a aplikácia M5cet odomknutá.",
    "Sporočila se znova prikažejo, ko bo iPhone v bližini in aplikacija M5cet odklenjena.",
    "Viestit näkyvät taas, kun iPhone on lähellä ja M5cetin lukitus on avattu.",
  ),
  "watch.unreachable": T(
    "iPhone not reachable — replies wait", "iPhone není dostupný — odpovědi počkají", "iPhone nicht erreichbar — Antworten warten",
    "iPhone no disponible: las respuestas esperan", "iPhone non raggiungibile — le risposte attendono", "iPhone injoignable — les réponses attendent",
    "iPhone nie je dostupný — odpovede počkajú", "iPhone ni dosegljiv — odgovori čakajo", "iPhone ei ole tavoitettavissa – vastaukset odottavat",
  ),
  "watch.noRooms": T("No rooms on the iPhone yet.", "Na iPhonu zatím nejsou žádné místnosti.", "Noch keine Räume auf dem iPhone.", "Aún no hay salas en el iPhone.", "Ancora nessuna stanza sull’iPhone.", "Pas encore de salle sur l’iPhone.", "Na iPhone zatiaľ nie sú žiadne miestnosti.", "V iPhonu še ni sob.", "iPhonessa ei ole vielä huoneita."),
  "watch.noMessages": T("No messages yet.", "Zatím žádné zprávy.", "Noch keine Nachrichten.", "Aún no hay mensajes.", "Ancora nessun messaggio.", "Pas encore de messages.", "Zatiaľ žiadne správy.", "Še ni sporočil.", "Ei vielä viestejä."),
  "watch.notOpen": T(
    "This room's messages are on the iPhone.", "Zprávy této místnosti jsou na iPhonu.", "Die Nachrichten dieses Raums sind auf dem iPhone.",
    "Los mensajes de esta sala están en el iPhone.", "I messaggi di questa stanza sono sull’iPhone.", "Les messages de cette salle sont sur l’iPhone.",
    "Správy tejto miestnosti sú na iPhone.", "Sporočila te sobe so v iPhonu.", "Tämän huoneen viestit ovat iPhonessa.",
  ),
  "watch.open": T("Open on iPhone", "Otevřít na iPhonu", "Auf dem iPhone öffnen", "Abrir en el iPhone", "Apri sull’iPhone", "Ouvrir sur l’iPhone", "Otvoriť na iPhone", "Odpri v iPhonu", "Avaa iPhonessa"),
  "watch.opened": T(
    "The room is ready in M5cet on your iPhone.", "Místnost je připravená v aplikaci M5cet na iPhonu.", "Der Raum ist in M5cet auf Ihrem iPhone bereit.",
    "La sala está lista en la app M5cet de tu iPhone.", "La stanza è pronta nell’app M5cet del tuo iPhone.", "La salle est prête dans l’app M5cet de votre iPhone.",
    "Miestnosť je pripravená v aplikácii M5cet na iPhone.", "Soba je pripravljena v aplikaciji M5cet v iPhonu.", "Huone on valmiina iPhonen M5cet-sovelluksessa.",
  ),

  /* --------------------------------------------- the watch app's reply */
  "watch.write": T("Dictate or write…", "Nadiktujte nebo napište…", "Diktieren oder schreiben…", "Dicta o escribe…", "Detta o scrivi…", "Dictez ou écrivez…", "Nadiktujte alebo napíšte…", "Narekujte ali napišite …", "Sanele tai kirjoita…"),
  "watch.quick": T("Quick replies", "Rychlé odpovědi", "Schnellantworten", "Respuestas rápidas", "Risposte rapide", "Réponses rapides", "Rýchle odpovede", "Hitri odgovori", "Pikavastaukset"),
  "watch.reply.sending": T("Sending…", "Odesílám…", "Wird gesendet…", "Enviando…", "Invio…", "Envoi…", "Odosielam…", "Pošiljam …", "Lähetetään…"),
  "watch.reply.queued": T("Waits for the iPhone", "Čeká na iPhone", "Wartet auf das iPhone", "Esperando al iPhone", "In attesa dell’iPhone", "En attente de l’iPhone", "Čaká na iPhone", "Čaka na iPhone", "Odottaa iPhonea"),
  "watch.reply.sent": T("Sent", "Odesláno", "Gesendet", "Enviado", "Inviato", "Envoyé", "Odoslané", "Poslano", "Lähetetty"),
  "watch.reply.failed": T("Not sent", "Neodesláno", "Nicht gesendet", "No enviado", "Non inviato", "Non envoyé", "Neodoslané", "Ni poslano", "Ei lähetetty"),
  "watch.reply.locked": T(
    "Not sent — M5cet is locked on the iPhone", "Neodesláno — aplikace M5cet je na iPhonu zamčená", "Nicht gesendet — M5cet ist auf dem iPhone gesperrt",
    "No enviado: la app M5cet está bloqueada en el iPhone", "Non inviato — l’app M5cet è bloccata sull’iPhone", "Non envoyé — l’app M5cet est verrouillée sur l’iPhone",
    "Neodoslané — aplikácia M5cet je na iPhone zamknutá", "Ni poslano — aplikacija M5cet je v iPhonu zaklenjena", "Ei lähetetty – M5cet on lukittu iPhonessa",
  ),

  /* ------------------------------- what a message is, where it is not shown */
  "watch.kind.video": T("Video", "Video", "Video", "Vídeo", "Video", "Vidéo", "Video", "Videoposnetek", "Video"),
  "watch.kind.held": T(
    "Held — check the identity on the iPhone", "Zadržená zpráva — ověřte identitu na iPhonu", "Zurückgehaltene Nachricht — Identität auf dem iPhone prüfen",
    "Mensaje retenido: comprueba la identidad en el iPhone", "Messaggio trattenuto — verifica l’identità sull’iPhone", "Message retenu — vérifiez l’identité sur l’iPhone",
    "Zadržaná správa — overte identitu na iPhone", "Zadržano sporočilo — preverite identiteto v iPhonu", "Pidätetty viesti – tarkista identiteetti iPhonessa",
  ),
  "watch.kind.fn": T("Command", "Příkaz", "Befehl", "Comando", "Comando", "Commande", "Príkaz", "Ukaz", "Komento"),

  /* ------------------------------ quick replies (natural, not literal) */
  "watch.quick.1": T("OK", "OK", "OK", "OK", "OK", "OK", "OK", "V redu", "OK"),
  "watch.quick.2": T("Yes", "Ano", "Ja", "Sí", "Sì", "Oui", "Áno", "Da", "Kyllä"),
  "watch.quick.3": T("No", "Ne", "Nein", "No", "No", "Non", "Nie", "Ne", "Ei"),
  "watch.quick.4": T("On my way", "Už jdu", "Bin unterwegs", "Voy de camino", "Sto arrivando", "J’arrive", "Už idem", "Na poti sem", "Olen tulossa"),
  "watch.quick.5": T("I'll write later", "Napíšu později", "Ich schreibe später", "Te escribo luego", "Ti scrivo dopo", "Je réponds plus tard", "Napíšem neskôr", "Napišem kasneje", "Kirjoitan myöhemmin"),

  /* --------------------------------------------- the system NFC sheet */
  "nfc.ios.hold": T(
    "Hold the card near the top of your iPhone", "Přiložte kartu k horní části iPhonu", "Karte an den oberen Teil des iPhone halten",
    "Acerca la tarjeta a la parte superior del iPhone", "Avvicina la carta alla parte superiore dell’iPhone", "Approchez la carte du haut de votre iPhone",
    "Priložte kartu k hornej časti iPhonu", "Prislonite kartico na zgornji del iPhona", "Pidä korttia iPhonen yläosaa vasten",
  ),
  "nfc.ios.holdWrite": T(
    "Hold the card near the top of your iPhone to write it", "Pro zápis přiložte kartu k horní části iPhonu", "Zum Schreiben die Karte an den oberen Teil des iPhone halten",
    "Para escribir, acerca la tarjeta a la parte superior del iPhone", "Per scrivere, avvicina la carta alla parte superiore dell’iPhone", "Pour écrire, approchez la carte du haut de votre iPhone",
    "Na zápis priložte kartu k hornej časti iPhonu", "Za zapis prislonite kartico na zgornji del iPhona", "Pidä korttia iPhonen yläosaa vasten kirjoitusta varten",
  ),
  /** A template's step: "2/7 · READ RECORD (AFL)" — {0} the step, {1} of how many, {2} its label. */
  "nfc.ios.step": SAME("{0}/{1} · {2}"),
  "nfc.ios.multipleTags": T(
    "More than one card — hold just one.", "Víc než jedna karta — přiložte jen jednu.", "Mehr als eine Karte — halten Sie nur eine an.",
    "Hay más de una tarjeta: acerca solo una.", "Più di una carta — avvicinane solo una.", "Plus d’une carte — n’en approchez qu’une.",
    "Viac ako jedna karta — priložte len jednu.", "Več kot ena kartica — prislonite samo eno.", "Useampi kuin yksi kortti – pidä vain yhtä.",
  ),
};

const findNode = (node: ANode, id: string): ANode | null => {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
};

const parentOf = (node: ANode, id: string): ANode | null => {
  for (const c of node.children ?? []) {
    if (c.id === id) return node;
    const f = parentOf(c, id);
    if (f) return f;
  }
  return null;
};

/** The Apple Watch rows: a switch bound to watch.on in the shape of its neighbours (icon, label, switch), and its hint. */
export function watchRows(): ANode[] {
  return [
    {
      id: "watch", el: "row", style: { padding: "10 12 10 20", gap: 18, align: "center" }, children: [
        // Lucide has no watch in the design's icon set (client/src/lib/menu-icons-data.ts): a watch face.
        { id: "watch-icon", el: "icon", props: { icon: "clock-3", size: 22, color: "@muted" } },
        { id: "watch-label", el: "text", text: "{_'watch.setting'}", style: { size: 16, weight: 1 } },
        { id: "watch-switch", el: "switch", props: { setting: IOS_WATCH_SETTING } },
      ],
    },
    { id: "watch-hint", el: "text", text: "{_'watch.setting.hint'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 64" } },
  ];
}

/**
 * Settings › Notifications gets the Apple Watch switch after "Hide on the
 * lock screen" (where else a message's content shows), before the quiet hours.
 */
function addWatchSwitch(screens: Record<string, ANode>): void {
  const notify = screens["settings.notify"];
  if (!notify || findNode(notify, "watch")) return;
  const parent = parentOf(notify, "lockscreen-hint") ?? parentOf(notify, "s-quiet") ?? findNode(notify, "list") ?? notify;
  const kids = parent.children ?? [];
  const after = kids.findIndex((k) => k.id === "lockscreen-hint");
  const before = kids.findIndex((k) => k.id === "s-quiet");
  kids.splice(after >= 0 ? after + 1 : before >= 0 ? before : kids.length, 0, ...watchRows());
  parent.children = kids;
}

/** Android's default design (deep copy — Android's own stays as it is) with the iOS look and the iOS-only items. */
function iosDefaultDesign(): AndroidDesign {
  const d = structuredClone(DEFAULT_DESIGN);
  d.theme = IOS_THEME;
  d.animations = IOS_ANIMATIONS;
  addWatchSwitch(d.screens);
  for (const lang of LANGS) for (const [key, texts] of Object.entries(IOS_STRINGS)) d.strings[lang][key] = texts[lang];
  d.rev = "default";
  return d;
}

export const IOS_DEFAULT_DESIGN: AndroidDesign = iosDefaultDesign();

/** The look as a template of Settings › Appearance (first in the iOS app's list). */
export const IOS_LOOK_THEME: AndroidTheme = {
  id: "ios", family: "studio", tones: ["light", "dark"], radius: IOS_THEME.radius, font: "sans",
  label: { cs: "iOS", en: "iOS", de: "iOS", es: "iOS", it: "iOS", fr: "iOS", sk: "iOS", sl: "iOS", fi: "iOS" },
  light: { ...IOS_THEME.light }, dark: { ...IOS_THEME.dark },
};


/* ============================================================ limits (§ 5) */

export type IosLimit = { action: string; arg?: RegExp; note: string };

/** Actions of the design language iOS cannot carry out as Android does — what the iOS app does instead. */
export const IOS_LIMITS: IosLimit[] = [
  { action: "nfc.emulate", note: "card emulation (HCE) needs Apple's HCE entitlement (EU, iOS 18.1+); without it the iOS app hides the control" },
  { action: "nfc.reader", arg: /usb/i, note: "iPhone has no USB NFC readers; the iOS app offers the internal reader (iPhone) and Bluetooth readers" },
  { action: "calllog.system", note: "iOS does not let an app remove calls from the Phone app's Recents; the iOS app hides it" },
  { action: "conversations.settings", note: "iOS has no per-conversation system settings; the iOS app opens its notification settings" },
  { action: "update.install", note: "an iOS update is installed by the App Store or TestFlight; the action opens the release's link" },
];

/** What of a design the iOS app will hide or replace, each once with where it is used. */
export function iosDesignWarnings(design: AndroidDesign): string[] {
  const found = new Map<IosLimit, Set<string>>();
  const check = (action: unknown, arg: unknown, where: string) => {
    if (typeof action !== "string") return;
    for (const l of IOS_LIMITS) {
      if (l.action !== action) continue;
      if (l.arg && !(typeof arg === "string" && l.arg.test(arg))) continue;
      if (!found.has(l)) found.set(l, new Set());
      found.get(l)!.add(where);
    }
  };
  const visit = (v: unknown, where: string, depth: number): void => {
    if (depth > 64 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x, where, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if ("action" in o) check(o.action, o.arg, where);
    if ("do" in o) check(o.do, o.arg, where);
    for (const x of Object.values(o)) visit(x, where, depth + 1);
  };
  for (const [id, tree] of Object.entries(design.screens)) visit(tree, `screen ${id}`, 0);
  for (const [id, items] of Object.entries(design.menus)) visit(items, `menu ${id}`, 0);
  for (const [id, lib] of Object.entries(design.libraries)) visit(lib, `library ${id}`, 0);
  return [...found.entries()].map(([l, where]) => {
    const list = [...where];
    return `${l.action}${l.arg ? ` (${l.arg.source.replace(/\\/g, "")})` : ""} — ${list.slice(0, 4).join(", ")}${list.length > 4 ? ` and ${list.length - 4} more` : ""}: ${l.note}`;
  });
}

/** The oldest iOS app a design runs on: the first iOS app, or newer when a design element needs it. */
export function iosDesignMinAppCode(design: AndroidDesign): number {
  return Math.max(IOS_MIN_APP_CODE, designMinAppCode(design));
}

/* ================================================================ storage */

export const sanitizeIosDesign = (raw: unknown): AndroidDesign => sanitizeDesign(raw, IOS_DEFAULT_DESIGN);

const designStore = createDesignStore({ label: "ios", file: () => join(mobileDir("ios"), "design.json"), defaults: IOS_DEFAULT_DESIGN, sanitize: sanitizeIosDesign, rev: designRev });

export const iosDesign = (): AndroidDesign => designStore.get();
export const saveIosDesign = (raw: unknown, by: string): AndroidDesign => designStore.save(raw, by);
export const forgetIosDesign = (): void => designStore.forget();
export const savedIosDesignProblem = (): string | null => designStore.problem();

/**
 * What the console's design builder needs: Android's catalog with the iOS
 * defaults, the § 5 limits, and the app's own templates (the iOS look first;
 * the web's templates come from client CSS at build time — ios/assets.ts —
 * so the running server lists only these).
 */
export function iosCatalog() {
  return {
    ...androidCatalog(IOS_DEFAULT_DESIGN),
    platform: "ios",
    iosLimits: IOS_LIMITS.map((l) => ({ action: l.action, arg: l.arg?.source ?? "", note: l.note })),
    themes: [IOS_LOOK_THEME, ...THEMES_67_LOOK],
  };
}
