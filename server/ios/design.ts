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
// watch app's, the system NFC sheet's). Android's texts that describe what
// only Android does (conversation shortcuts, the system call log, Firebase,
// Google's password manager…) say what the iOS app does instead
// (IOS_WORDING), and the rows of what iOS cannot do at all are left out
// (IOS_REMOVED_NODES). The iOS app ships this design
// (script/ios-assets.ts → ios/Design/m5/, copied by the Xcode build phase
// "Copy design assets"). The design's scope has no platform variable ($app is
// name / version / code / bundle on both apps; the iOS app adds "watch" —
// whether the device pairs with an Apple Watch, false on an iPad — for the
// watch switch): a design is one platform's
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
/** French: a no-break space (U+00A0) before : ; ! ? (i18n/GLOSSARY.md, as design-613.ts). */
const NB = " ";

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

  /* ----------------------- the NFC screens (ios/M5cet/Parts/NFC) */
  /** A dialog's plain OK (Android's dialogs say it in code). */
  "nfc.ok": T("OK", "OK", "OK", "Aceptar", "OK", "OK", "OK", "V redu", "OK"),
  // The permanent lock (ndef-lock) asks first: it cannot be undone.
  "nfc.lock.title": T(
    "Make the tag read-only?", "Nastavit tag jen pro čtení?", "Den Tag schreibgeschützt machen?",
    "¿Dejar la etiqueta en solo lectura?", "Rendere il tag di sola lettura?", `Passer le tag en lecture seule${NB}?`,
    "Nastaviť tag len na čítanie?", "Želite značko nastaviti samo za branje?", "Tehdäänkö tagista vain luettava?",
  ),
  "nfc.lock.text": T(
    "The tag's content can never be changed again — not by this app, not by any other. This cannot be undone.",
    "Obsah tagu už nikdy nepůjde změnit — touto ani žádnou jinou aplikací. Nelze to vrátit zpět.",
    "Der Inhalt des Tags lässt sich danach nie mehr ändern — weder mit dieser noch mit einer anderen App. Das kann nicht rückgängig gemacht werden.",
    "El contenido de la etiqueta ya no se podrá cambiar nunca, ni con esta app ni con ninguna otra. No se puede deshacer.",
    "Il contenuto del tag non potrà più essere modificato, né con questa app né con altre. L’operazione non si può annullare.",
    "Le contenu du tag ne pourra plus jamais être modifié — ni par cette app, ni par une autre. C’est irréversible.",
    "Obsah tagu sa už nikdy nebude dať zmeniť — touto ani žiadnou inou aplikáciou. Nedá sa to vrátiť späť.",
    "Vsebine značke ne bo mogoče nikoli več spremeniti — ne s to ne s katero koli drugo aplikacijo. Tega ni mogoče razveljaviti.",
    "Tagin sisältöä ei voi enää koskaan muuttaa – ei tällä eikä millään muulla sovelluksella. Toimintoa ei voi perua.",
  ),
  "nfc.lock.confirm": T("Make read-only", "Nastavit jen pro čtení", "Schreibschutz setzen", "Dejar en solo lectura", "Rendi di sola lettura", "Passer en lecture seule", "Nastaviť len na čítanie", "Nastavi samo za branje", "Tee vain luettavaksi"),
  // A card report's export — the web's words (client/src/lib/i18n-nfc.ts, i18n/locales/<lang>/web.json).
  "nfc.report.full": T("Full report", "Celý výpis", "Vollständiger Bericht", "Informe completo", "Report completo", "Rapport complet", "Celý výpis", "Celoten izpis", "Täydellinen raportti"),
  "nfc.report.export": T("Export", "Export", "Export", "Exportar", "Esporta", "Exporter", "Export", "Izvoz", "Vie"),
  "nfc.report.files": T("Files to download", "Soubory ke stažení", "Dateien zum Herunterladen", "Archivos para descargar", "File da scaricare", "Fichiers à télécharger", "Súbory na stiahnutie", "Datoteke za prenos", "Ladattavat tiedostot"),
  "nfc.report.html": T("HTML report", "HTML výpis", "HTML-Bericht", "Informe HTML", "Report HTML", "Rapport HTML", "HTML výpis", "Izpis HTML", "HTML-raportti"),
  "nfc.report.saved": T("Saved: {name}", "Uloženo: {name}", "Gespeichert: {name}", "Guardado: {name}", "Salvato: {name}", `Enregistré${NB}: {name}`, "Uložené: {name}", "Shranjeno: {name}", "Tallennettu: {name}"),
  /** An iPad (or an iPhone without a reader): "nfc.unavailable" stays the phone's words for Android. */
  "nfc.unavailable.device": T(
    "This device has no NFC reader.", "Toto zařízení nemá čtečku NFC.", "Dieses Gerät hat kein NFC-Lesegerät.",
    "Este dispositivo no tiene lector NFC.", "Questo dispositivo non ha un lettore NFC.", "Cet appareil n’a pas de lecteur NFC.",
    "Toto zariadenie nemá čítačku NFC.", "Ta naprava nima bralnika NFC.", "Tässä laitteessa ei ole NFC-lukijaa.",
  ),

  /* ---- why Core NFC cannot do an op (M5NFC NfcPlatform.limit / noReader — the workbench's buttons, the builder) */
  "nfc.ios.limit.noReader": T(
    "This device has no NFC reader (iPad and Apple Watch have none).", "Toto zařízení nemá čtečku NFC (iPad ani Apple Watch ji nemají).",
    "Dieses Gerät hat kein NFC-Lesegerät (iPad und Apple Watch haben keines).", "Este dispositivo no tiene lector NFC (el iPad y el Apple Watch no tienen).",
    "Questo dispositivo non ha un lettore NFC (iPad e Apple Watch non ne hanno).", "Cet appareil n’a pas de lecteur NFC (l’iPad et l’Apple Watch n’en ont pas).",
    "Toto zariadenie nemá čítačku NFC (iPad ani Apple Watch ju nemajú).", "Ta naprava nima bralnika NFC (iPad in Apple Watch ga nimata).",
    "Tässä laitteessa ei ole NFC-lukijaa (iPadissa ja Apple Watchissa ei ole).",
  ),
  "nfc.ios.limit.classic": T(
    "MIFARE Classic is not available on iPhone (Core NFC has no MIFARE Classic).", "MIFARE Classic na iPhonu není k dispozici (Core NFC MIFARE Classic neumí).",
    "MIFARE Classic ist auf dem iPhone nicht verfügbar (Core NFC unterstützt kein MIFARE Classic).", "MIFARE Classic no está disponible en el iPhone (Core NFC no admite MIFARE Classic).",
    "MIFARE Classic non è disponibile su iPhone (Core NFC non supporta MIFARE Classic).", "MIFARE Classic n’est pas disponible sur iPhone (Core NFC ne prend pas en charge MIFARE Classic).",
    "MIFARE Classic na iPhone nie je k dispozícii (Core NFC MIFARE Classic nepodporuje).", "MIFARE Classic v iPhonu ni na voljo (Core NFC ne podpira MIFARE Classic).",
    "MIFARE Classic ei ole käytettävissä iPhonessa (Core NFC ei tue MIFARE Classicia).",
  ),
  "nfc.ios.limit.raw": T(
    "Raw ISO 14443-3 frames are not available on iPhone (Core NFC sends APDUs and MIFARE commands only).",
    "Surové rámce ISO 14443-3 na iPhonu nejsou k dispozici (Core NFC posílá jen APDU a příkazy MIFARE).",
    "Rohe ISO-14443-3-Frames sind auf dem iPhone nicht verfügbar (Core NFC sendet nur APDUs und MIFARE-Befehle).",
    "Las tramas ISO 14443-3 sin procesar no están disponibles en el iPhone (Core NFC solo envía APDU y comandos MIFARE).",
    "I frame ISO 14443-3 grezzi non sono disponibili su iPhone (Core NFC invia solo APDU e comandi MIFARE).",
    "Les trames ISO 14443-3 brutes ne sont pas disponibles sur iPhone (Core NFC n’envoie que des APDU et des commandes MIFARE).",
    "Surové rámce ISO 14443-3 na iPhone nie sú k dispozícii (Core NFC posiela len APDU a príkazy MIFARE).",
    "Surovi okvirji ISO 14443-3 v iPhonu niso na voljo (Core NFC pošilja samo APDU-je in ukaze MIFARE).",
    "Raakoja ISO 14443-3 -kehyksiä ei voi käyttää iPhonessa (Core NFC lähettää vain APDU- ja MIFARE-komentoja).",
  ),
  "nfc.ios.limit.hce": T(
    "Card emulation needs the HCE entitlement (Core NFC CardSession) — not available on this device.",
    "Emulace karty potřebuje oprávnění HCE (Core NFC CardSession) — na tomto zařízení není k dispozici.",
    "Kartenemulation braucht die HCE-Berechtigung (Core NFC CardSession) — auf diesem Gerät nicht verfügbar.",
    "La emulación de tarjeta necesita el permiso HCE (Core NFC CardSession): no está disponible en este dispositivo.",
    "L’emulazione della carta richiede l’autorizzazione HCE (Core NFC CardSession) — non disponibile su questo dispositivo.",
    "L’émulation de carte nécessite l’autorisation HCE (Core NFC CardSession) — non disponible sur cet appareil.",
    "Emulácia karty potrebuje oprávnenie HCE (Core NFC CardSession) — na tomto zariadení nie je k dispozícii.",
    "Emulacija kartice potrebuje pravico HCE (Core NFC CardSession) — v tej napravi ni na voljo.",
    "Kortin emulointi vaatii HCE-oikeuden (Core NFC CardSession) – ei käytettävissä tällä laitteella.",
  ),
  "nfc.ios.limit.payment": T(
    "Core NFC does not allow payment applications (EMV AIDs) — use an external reader.", "Core NFC nedovolí platební aplikace (EMV AID) — použijte externí čtečku.",
    "Core NFC erlaubt keine Zahlungsanwendungen (EMV-AIDs) — verwenden Sie ein externes Lesegerät.", "Core NFC no permite aplicaciones de pago (AID de EMV): usa un lector externo.",
    "Core NFC non consente le applicazioni di pagamento (AID EMV) — usa un lettore esterno.", "Core NFC n’autorise pas les applications de paiement (AID EMV) — utilisez un lecteur externe.",
    "Core NFC nepovolí platobné aplikácie (EMV AID) — použite externú čítačku.", "Core NFC ne dovoli plačilnih aplikacij (EMV AID) — uporabite zunanji bralnik.",
    "Core NFC ei salli maksusovelluksia (EMV AID) – käytä ulkoista lukijaa.",
  ),
  "nfc.ios.limit.other": T(
    "This reader cannot do it.", "Tahle čtečka to neumí.", "Dieses Lesegerät kann das nicht.", "Este lector no puede hacerlo.", "Questo lettore non può farlo.",
    "Ce lecteur ne sait pas le faire.", "Táto čítačka to nevie.", "Ta bralnik tega ne zmore.", "Tämä lukija ei pysty siihen.",
  ),

  /* -------- People: a safety number's QR (ios/M5cet/Parts/People) — the web's words (client/src/lib/i18n-security.ts) */
  "sec.safety.scan": T("Scan their code", "Naskenovat jeho kód", "Seinen Code scannen", "Escanear su código", "Scansiona il suo codice", "Scanner son code", "Naskenovať kód druhého", "Skeniraj kodo drugega", "Skannaa toisen koodi"),
  "sec.safety.verified": T(
    "Verified: this device belongs to the person you compared numbers with.",
    "Ověřeno: toto zařízení patří tomu, s kým jste čísla porovnali.",
    "Bestätigt: Dieses Gerät gehört der Person, mit der Sie die Nummer verglichen haben.",
    "Verificado: este dispositivo pertenece a la persona con la que has comparado los números.",
    "Verificato: questo dispositivo appartiene alla persona con cui hai confrontato i numeri.",
    `Vérifié${NB}: cet appareil appartient à la personne avec qui vous avez comparé les numéros.`,
    "Overené: toto zariadenie patrí tomu, s kým ste porovnali čísla.",
    "Preverjeno: ta naprava pripada osebi, s katero ste primerjali številko.",
    "Vahvistettu: tämä laite kuuluu henkilölle, jonka kanssa vertasit numeroita.",
  ),
  "sec.safety.mismatch": T(
    "The numbers do NOT match — this is not the same device.",
    "Čísla se NESHODUJÍ — nejde o stejné zařízení.",
    "Die Nummern stimmen NICHT überein — es ist nicht dasselbe Gerät.",
    "Los números NO coinciden: no es el mismo dispositivo.",
    "I numeri NON corrispondono — non è lo stesso dispositivo.",
    "Les numéros ne correspondent PAS — ce n’est pas le même appareil.",
    "Čísla sa NEZHODUJÚ — nejde o rovnaké zariadenie.",
    "Številki se NE ujemata — to ni ista naprava.",
    "Numerot EIVÄT täsmää – tämä ei ole sama laite.",
  ),

  /* -------- Settings › Security: what protects the PIN (Vault.pinKeyLevel "secure-enclave" — Android: strongbox / tee) */
  "set.security.pinKey.secure-enclave": T(
    "Secure Enclave (security chip)", "Secure Enclave (bezpečnostní čip)", "Secure Enclave (Sicherheitschip)",
    "Secure Enclave (chip de seguridad)", "Secure Enclave (chip di sicurezza)", "Secure Enclave (puce de sécurité)",
    "Secure Enclave (bezpečnostný čip)", "Secure Enclave (varnostni čip)", "Secure Enclave (turvasiru)",
  ),
};

/* ============================================ Android's words, iOS's ways */

/**
 * Android's texts that describe what only Android does, in the words of what
 * the iOS app does instead (each checked against the iOS code):
 *
 * - conversations.*: Android publishes conversation shortcuts (launcher,
 *   Share sheet, widgets); iOS has Communication Notifications and donated
 *   INSendMessageIntents (Platform/Notifications/Conversations.swift): the
 *   sender's name and initials, grouped by room, Siri's suggestions; off or
 *   locked → the donations are deleted, no names.
 * - notify.lockScreenHide: iOS has no per-notification lock-screen visibility
 *   (Shared/LockScreen.swift): neutral text when previews show always, else
 *   the system hides the preview.
 * - notify.channel.android: the server's app channel ("android") wakes the
 *   account's iOS devices too (server/notify/channels.ts).
 * - notify.noFcm: $notify.push is APNs (DeviceService.pushMode "apns").
 * - set.security.blocked: iOS cannot forbid screenshots (ScreenPrivacy.swift).
 * - passkey.*, set.user.boundHint: the iOS password manager is the Passwords
 *   app (iCloud Keychain, PRF since iOS 18); the server association is
 *   apple-app-site-association (AccountDialogs.swift, server/ios/app-site.ts).
 * - settings.callLog, calllog.*: CallKit's Recents in the Phone app
 *   (CallKitBridge includesCallsInRecents) — no call log permission, nothing
 *   another app reads, a tap calls back (CallSystem INStartCallIntent); the
 *   permission and erase rows are not in the iOS design (IOS_REMOVED_NODES).
 * - nfc.hold / nfc.work.tapScan / nfc.model.hold: the iPhone's NFC antenna is
 *   at its top edge (as nfc.ios.hold); nfc.tpl.none: console › iOS › Define.
 * - look.mic.blocked: the iOS Settings app's path.
 */
export const IOS_WORDING: Record<string, Texts> = {
  /* -------------------------------------- Settings › Notifications */
  "conversations.section": T("Conversations", "Konverzace", "Unterhaltungen", "Conversaciones", "Conversazioni", "Conversations", "Konverzácie", "Pogovori", "Keskustelut"),
  "conversations.on": T(
    "Rooms as conversations", "Místnosti jako konverzace", "Räume als Unterhaltungen", "Salas como conversaciones", "Stanze come conversazioni",
    "Salles comme conversations", "Miestnosti ako konverzácie", "Sobe kot pogovori", "Huoneet keskusteluina",
  ),
  "conversations.hint": T(
    "Message notifications show who wrote (their name and initials), grouped by room, and iOS learns the rooms from them for Siri's suggestions. Switching this off removes everything iOS has learnt.",
    "Oznámení zpráv ukážou, kdo psal (jméno a iniciály), seskupená podle místností, a iOS se z nich naučí místnosti pro návrhy Siri. Vypnutím se všechno, co se iOS naučil, odebere.",
    "Nachrichten-Benachrichtigungen zeigen, wer geschrieben hat (Name und Initialen), nach Räumen gruppiert, und iOS lernt daraus die Räume für die Siri-Vorschläge. Ausschalten entfernt alles, was iOS gelernt hat.",
    "Las notificaciones de mensajes muestran quién escribió (nombre e iniciales), agrupadas por sala, y iOS aprende de ellas las salas para las sugerencias de Siri. Al desactivarlo se quita todo lo que iOS ha aprendido.",
    "Le notifiche dei messaggi mostrano chi ha scritto (nome e iniziali), raggruppate per stanza, e iOS impara da esse le stanze per i suggerimenti di Siri. Disattivando questa opzione si rimuove tutto ciò che iOS ha imparato.",
    "Les notifications de messages indiquent qui a écrit (nom et initiales), regroupées par salle, et iOS en apprend les salles pour les suggestions de Siri. La désactiver supprime tout ce qu’iOS a appris.",
    "Upozornenia na správy ukážu, kto písal (meno a iniciály), zoskupené podľa miestností, a iOS sa z nich naučí miestnosti pre návrhy Siri. Vypnutím sa všetko, čo sa iOS naučil, odstráni.",
    "Obvestila o sporočilih pokažejo, kdo je pisal (ime in začetnice), združena po sobah, iOS pa se iz njih nauči sobe za predloge Siri. Z izklopom se odstrani vse, kar se je iOS naučil.",
    "Viesti-ilmoitukset näyttävät, kuka kirjoitti (nimi ja nimikirjaimet), huoneittain ryhmiteltyinä, ja iOS oppii niistä huoneet Sirin ehdotuksia varten. Tämän poistaminen käytöstä poistaa kaiken, mitä iOS on oppinut.",
  ),
  "conversations.names.hint": T(
    "iOS (notifications, Siri's suggestions) gets a room's name only while the app is unlocked and notifications may name the room (Privacy above). Otherwise a conversation has no name, and as soon as the app locks, iOS forgets the named ones. They never hold message content or the room's key.",
    "Název místnosti iOS dostane (oznámení, návrhy Siri) jen když je aplikace odemčená a oznámení smí místnost jmenovat (Soukromí výše). Jinak konverzace název nemá, a jakmile se aplikace zamkne, iOS pojmenované konverzace zapomene. Obsah zpráv ani klíč místnosti v nich nikdy není.",
    "iOS (Benachrichtigungen, Siri-Vorschläge) erhält einen Raumnamen nur, solange die App entsperrt ist und Benachrichtigungen den Raum nennen dürfen (Privatsphäre oben). Sonst hat eine Unterhaltung keinen Namen, und sobald die App sperrt, vergisst iOS die benannten. Nachrichteninhalte oder der Schlüssel des Raums sind nie darin.",
    "iOS (notificaciones, sugerencias de Siri) recibe el nombre de una sala solo mientras la app está desbloqueada y las notificaciones pueden nombrar la sala (Privacidad, arriba). En caso contrario, la conversación no tiene nombre, y en cuanto la app se bloquea, iOS olvida las que tenían nombre. Nunca contienen el contenido de los mensajes ni la clave de la sala.",
    "iOS (notifiche, suggerimenti di Siri) riceve il nome di una stanza solo mentre l’app è sbloccata e le notifiche possono indicare il nome della stanza (Privacy sopra). Altrimenti la conversazione non ha nome e, non appena l’app si blocca, iOS dimentica quelle con nome. Non contengono mai il contenuto dei messaggi né la chiave della stanza.",
    "iOS (notifications, suggestions de Siri) ne reçoit le nom d’une salle que lorsque l’app est déverrouillée et que les notifications peuvent nommer la salle (Confidentialité ci-dessus). Sinon, la conversation n’a pas de nom, et dès que l’app se verrouille, iOS oublie celles qui en avaient un. Elles ne contiennent jamais le contenu des messages ni la clé de la salle.",
    "Názov miestnosti iOS dostane (upozornenia, návrhy Siri) len vtedy, keď je aplikácia odomknutá a upozornenia smú miestnosť pomenovať (Súkromie vyššie). Inak konverzácia názov nemá, a hneď ako sa aplikácia zamkne, iOS pomenované konverzácie zabudne. Obsah správ ani kľúč miestnosti v nich nikdy nie je.",
    "iOS (obvestila, predlogi Siri) dobi ime sobe samo, dokler je aplikacija odklenjena in smejo obvestila sobo poimenovati (Zasebnost zgoraj). Sicer pogovor nima imena, in takoj ko se aplikacija zaklene, iOS pozabi poimenovane. Nikoli ne vsebujejo vsebine sporočil ali ključa sobe.",
    "iOS (ilmoitukset, Sirin ehdotukset) saa huoneen nimen vain, kun sovellus on avattu ja ilmoitukset saavat nimetä huoneen (Yksityisyys yllä). Muuten keskustelulla ei ole nimeä, ja heti kun sovellus lukittuu, iOS unohtaa nimetyt. Niissä ei koskaan ole viestin sisältöä tai huoneen avainta.",
  ),
  "notify.lockScreenHide": T(
    "Hide content on the lock screen", "Skrýt obsah na zamčené obrazovce", "Inhalt auf dem Sperrbildschirm ausblenden", "Ocultar el contenido en la pantalla de bloqueo",
    "Nascondi il contenuto nella schermata di blocco", "Masquer le contenu sur l’écran de verrouillage", "Skryť obsah na zamknutej obrazovke", "Skrij vsebino na zaklenjenem zaslonu",
    "Piilota sisältö lukitusnäytöllä",
  ),
  "notify.lockScreenHide.hint": T(
    "Message notifications show no content on the lock screen: when iOS always shows previews there (Settings › Notifications), they carry only a neutral text; otherwise iOS hides their preview there. While the app is locked, this is always so.",
    "Oznámení zpráv na zamčené obrazovce neukážou obsah: když tam iOS ukazuje náhledy vždy (Nastavení › Oznámení), nesou jen neutrální text; jinak jejich náhled na zamčené obrazovce skryje iOS. Dokud je zamčená aplikace, platí to vždy.",
    "Nachrichten-Benachrichtigungen zeigen auf dem Sperrbildschirm keinen Inhalt: Zeigt iOS dort Vorschauen immer an (Einstellungen › Mitteilungen), tragen sie nur einen neutralen Text; sonst blendet iOS ihre Vorschau dort aus. Solange die App gesperrt ist, gilt das immer.",
    "Las notificaciones de mensajes no muestran su contenido en la pantalla de bloqueo: si iOS muestra allí siempre las previsualizaciones (Ajustes › Notificaciones), solo llevan un texto neutro; si no, iOS oculta allí su previsualización. Mientras la app está bloqueada, siempre es así.",
    "Le notifiche dei messaggi non mostrano il contenuto nella schermata di blocco: se iOS lì mostra sempre le anteprime (Impostazioni › Notifiche), contengono solo un testo neutro; altrimenti iOS ne nasconde l’anteprima. Mentre l’app è bloccata, è sempre così.",
    `Les notifications de messages n’affichent aucun contenu sur l’écran de verrouillage${NB}: si iOS y affiche toujours les aperçus (Réglages › Notifications), elles ne portent qu’un texte neutre${NB}; sinon, iOS y masque leur aperçu. Tant que l’app est verrouillée, c’est toujours le cas.`,
    "Upozornenia na správy na zamknutej obrazovke neukážu obsah: keď tam iOS ukazuje náhľady vždy (Nastavenia › Hlásenia), nesú len neutrálny text; inak ich náhľad na zamknutej obrazovke skryje iOS. Kým je aplikácia zamknutá, platí to vždy.",
    "Obvestila o sporočilih na zaklenjenem zaslonu ne prikažejo vsebine: če iOS tam predogled prikazuje vedno (Nastavitve › Obvestila), vsebujejo samo nevtralno besedilo; sicer iOS njihov predogled tam skrije. Dokler je aplikacija zaklenjena, je to vedno tako.",
    "Viesti-ilmoitukset eivät näytä sisältöä lukitusnäytöllä: jos iOS näyttää esikatselut siellä aina (Asetukset › Ilmoitukset), niissä on vain neutraali teksti; muuten iOS piilottaa niiden esikatselun siellä. Kun sovellus on lukittu, näin on aina.",
  ),
  "notify.channel.android": T(
    "M5cet app (iOS, Android)", "Aplikace M5cet (iOS, Android)", "M5cet-App (iOS, Android)", "App M5cet (iOS, Android)", "App M5cet (iOS, Android)",
    "App M5cet (iOS, Android)", "Aplikácia M5cet (iOS, Android)", "Aplikacija M5cet (iOS, Android)", "M5cet-sovellus (iOS, Android)",
  ),
  "notify.noFcm": T(
    "Apple's push service (APNs) is not available — the server has no APNs key or this device has no push token: nothing wakes a closed app; a notification comes only another way (e-mail) if you have one, and nothing is kept for later.",
    "Push přes Apple (APNs) tu není — server nemá klíč APNs nebo toto zařízení nemá token pro push: zavřenou aplikaci nic neprobudí; upozornění přijde jen jinou cestou (e-mail), pokud ji máte, a nic se neodkládá na později.",
    "Der Push-Dienst von Apple (APNs) ist nicht verfügbar — der Server hat keinen APNs-Schlüssel oder dieses Gerät kein Push-Token: Nichts weckt eine geschlossene App; eine Benachrichtigung kommt nur auf einem anderen Weg (E-Mail), falls vorhanden, und nichts wird für später aufgehoben.",
    "El servicio push de Apple (APNs) no está disponible: el servidor no tiene clave de APNs o este dispositivo no tiene token push. Nada despierta a una app cerrada; una notificación solo llega por otra vía (correo electrónico) si tienes una, y nada se guarda para más tarde.",
    "Il servizio push di Apple (APNs) non è disponibile — il server non ha una chiave APNs o questo dispositivo non ha un token push: nulla sveglia un’app chiusa; una notifica arriva solo in un altro modo (e-mail) se ne hai uno, e nulla viene conservato per dopo.",
    `Le service push d’Apple (APNs) n’est pas disponible — le serveur n’a pas de clé APNs ou cet appareil n’a pas de jeton push${NB}: rien ne réveille une app fermée${NB}; une notification n’arrive que par un autre moyen (e-mail) si vous en avez un, et rien n’est conservé pour plus tard.`,
    "Push cez Apple (APNs) tu nie je — server nemá kľúč APNs alebo toto zariadenie nemá token pre push: zatvorenú aplikáciu nič nezobudí; upozornenie príde len inou cestou (e-mail), ak ju máte, a nič sa neodkladá na neskôr.",
    "Potisna storitev Apple (APNs) ni na voljo — strežnik nima ključa APNs ali ta naprava nima žetona za potisna obvestila: zaprte aplikacije nič ne prebudi; obvestilo prispe samo po drugi poti (e-pošta), če jo imate, in nič se ne shranjuje za pozneje.",
    "Applen push-palvelu (APNs) ei ole käytettävissä – palvelimella ei ole APNs-avainta tai tällä laitteella ei ole push-tunnusta: mikään ei herätä suljettua sovellusta; ilmoitus tulee vain toista kautta (sähköposti), jos sellainen on, eikä mitään säilytetä myöhempää varten.",
  ),

  /* ------------------------------------------ Settings › Security */
  "set.security.blocked": T(
    "not allowed — hidden in recordings and the app switcher; a screenshot is reported",
    "nepovolené — skryté při nahrávání a v přepínači aplikací; snímek se nahlásí",
    "nicht erlaubt — in Aufnahmen und im App-Umschalter verborgen; ein Bildschirmfoto wird gemeldet",
    "no permitidas: ocultas en grabaciones y en el selector de apps; una captura se notifica",
    "non consentiti — nascosti nelle registrazioni e nel selettore app; uno screenshot viene segnalato",
    `non autorisées — masquées dans les enregistrements et le sélecteur d’apps${NB}; une capture est signalée`,
    "nepovolené — skryté pri nahrávaní a v prepínači aplikácií; snímka sa nahlási",
    "ni dovoljeno — skrito pri snemanju in v preklopniku aplikacij; posnetek se sporoči",
    "ei sallittu – piilotettu tallenteissa ja sovellusten vaihtajassa; kuvakaappauksesta ilmoitetaan",
  ),

  /* ------------------------------------------------- passkeys (iOS) */
  "passkey.unsupported": T(
    "This device has no password manager that handles passkeys. Turn one on in Settings › General › AutoFill & Passwords (e.g. the Passwords app).",
    "V tomto zařízení není správce hesel, který by uměl passkeys. Zapněte ho v Nastavení › Obecné › Automatické vyplňování a hesla (např. aplikaci Hesla).",
    "Auf diesem Gerät gibt es keinen Passwortmanager, der Passkeys unterstützt. Schalten Sie einen unter Einstellungen › Allgemein › Automatisch ausfüllen & Passwörter ein (z. B. die App „Passwörter“).",
    "Este dispositivo no tiene un gestor de contraseñas que admita llaves de acceso. Activa uno en Ajustes › General › Autorrelleno y contraseñas (p. ej., la app Contraseñas).",
    "Questo dispositivo non ha un gestore di password che gestisca le passkey. Attivane uno in Impostazioni › Generali › Inserimento automatico e password (ad es. l’app Password).",
    "Cet appareil n’a pas de gestionnaire de mots de passe prenant en charge les clés d’accès. Activez-en un dans Réglages › Général › Remplissage automatique et mots de passe (p. ex. l’app Mots de passe).",
    "V tomto zariadení nie je správca hesiel, ktorý by vedel pracovať s prístupovými kľúčmi. Zapnite ho v Nastaveniach › Všeobecné › Automatické vypĺňanie a heslá (napr. aplikáciu Heslá).",
    "Ta naprava nima upravitelja gesel, ki podpira ključe za dostop. Vklopite ga v Nastavitve › Splošno › Samodejno izpolnjevanje in gesla (npr. aplikacijo Gesla).",
    "Tässä laitteessa ei ole salasanojen hallintaa, joka käsittelee pääsyavaimia. Ota sellainen käyttöön kohdassa Asetukset › Yleiset › Automaattitäyttö ja salasanat (esim. Salasanat-app).",
  ),
  "passkey.rpText": T(
    "Passkeys on iPhone and iPad only work when the server {host} publishes https://{host}/.well-known/apple-app-site-association naming this app (the operator sets APNS_TEAM_ID) and the app was built for that domain. Send the server's operator the line below.",
    "Passkeye na iPhonu a iPadu fungují jen tehdy, když server {host} zveřejní https://{host}/.well-known/apple-app-site-association se záznamem této aplikace (provozovatel nastaví APNS_TEAM_ID) a aplikace je sestavená pro tuto doménu. Pošlete provozovateli serveru řádek níže.",
    "Passkeys funktionieren auf iPhone und iPad nur, wenn der Server {host} https://{host}/.well-known/apple-app-site-association mit dieser App veröffentlicht (der Betreiber setzt APNS_TEAM_ID) und die App für diese Domain gebaut ist. Senden Sie dem Betreiber des Servers die Zeile unten.",
    "Las llaves de acceso en iPhone y iPad solo funcionan cuando el servidor {host} publica https://{host}/.well-known/apple-app-site-association con esta app (el operador configura APNS_TEAM_ID) y la app se ha compilado para ese dominio. Envía al operador del servidor la línea de abajo.",
    "Le passkey su iPhone e iPad funzionano solo se il server {host} pubblica https://{host}/.well-known/apple-app-site-association con questa app (l’operatore imposta APNS_TEAM_ID) e l’app è stata compilata per quel dominio. Invia all’operatore del server la riga qui sotto.",
    "Les clés d’accès sur iPhone et iPad ne fonctionnent que si le serveur {host} publie https://{host}/.well-known/apple-app-site-association avec cette app (l’opérateur définit APNS_TEAM_ID) et si l’app a été compilée pour ce domaine. Envoyez à l’opérateur du serveur la ligne ci-dessous.",
    "Prístupové kľúče na iPhone a iPade fungujú len vtedy, keď server {host} zverejní https://{host}/.well-known/apple-app-site-association so záznamom tejto aplikácie (prevádzkovateľ nastaví APNS_TEAM_ID) a aplikácia je zostavená pre túto doménu. Pošlite prevádzkovateľovi servera riadok nižšie.",
    "Ključi za dostop v iPhonu in iPadu delujejo samo, če strežnik {host} objavi https://{host}/.well-known/apple-app-site-association z zapisom te aplikacije (upravljavec nastavi APNS_TEAM_ID) in je aplikacija zgrajena za to domeno. Upravljavcu strežnika pošljite spodnjo vrstico.",
    "Pääsyavaimet toimivat iPhonessa ja iPadissa vain, jos palvelin {host} julkaisee osoitteessa https://{host}/.well-known/apple-app-site-association tämän sovelluksen (ylläpitäjä asettaa APNS_TEAM_ID:n) ja sovellus on käännetty tälle verkkotunnukselle. Lähetä palvelimen ylläpitäjälle alla oleva rivi.",
  ),

  /* ----------------------------------------------- Settings › Calls */
  "settings.callLog": T(
    "Calls in the Phone app's history", "Hovory v historii aplikace Telefon", "Anrufe im Verlauf der Telefon-App", "Llamadas en el historial de la app Teléfono",
    "Chiamate nella cronologia dell’app Telefono", "Appels dans l’historique de l’app Téléphone", "Hovory v histórii aplikácie Telefón", "Klici v zgodovini aplikacije Telefon",
    "Puhelut Puhelin-apin historiassa",
  ),
  "calllog.hint": T(
    "Calls of the rooms show in the Phone app's call history: incoming, outgoing and missed, with their time and whether they had video. iOS may sync it to your other devices with the same Apple Account. An entry has no number: tapping it calls the room again through this app.",
    "Hovory z místností se ukážou v historii hovorů aplikace Telefon: příchozí, odchozí i zmeškané, s časem a příznakem videa. iOS ji může synchronizovat do vašich dalších zařízení se stejným Apple účtem. Položka nemá číslo: klepnutím na ni místnosti zavoláte znovu přes tuto aplikaci.",
    "Anrufe der Räume erscheinen im Anrufverlauf der Telefon-App: eingehend, ausgehend und verpasst, mit Zeit und ob mit Video. iOS kann ihn mit Ihren anderen Geräten mit demselben Apple Account synchronisieren. Ein Eintrag hat keine Nummer: Ein Tippen darauf ruft den Raum über diese App erneut an.",
    "Las llamadas de las salas aparecen en el historial de llamadas de la app Teléfono: entrantes, salientes y perdidas, con su hora y si tenían vídeo. iOS puede sincronizarlo con tus otros dispositivos con la misma cuenta de Apple. Una entrada no tiene número: al tocarla vuelves a llamar a la sala a través de esta app.",
    "Le chiamate delle stanze compaiono nella cronologia chiamate dell’app Telefono: in arrivo, in uscita e perse, con ora e se avevano il video. iOS può sincronizzarla sugli altri tuoi dispositivi con lo stesso Account Apple. Una voce non ha un numero: toccandola richiami la stanza tramite questa app.",
    `Les appels des salles apparaissent dans l’historique des appels de l’app Téléphone${NB}: entrants, sortants et manqués, avec leur heure et la présence de vidéo. iOS peut le synchroniser avec vos autres appareils utilisant le même compte Apple. Une entrée n’a pas de numéro${NB}: la toucher rappelle la salle via cette app.`,
    "Hovory z miestností sa ukážu v histórii hovorov aplikácie Telefón: prichádzajúce, odchádzajúce aj zmeškané, s časom a príznakom videa. iOS ju môže synchronizovať do vašich ďalších zariadení s rovnakým Apple účtom. Položka nemá číslo: klepnutím na ňu miestnosti zavoláte znova cez túto aplikáciu.",
    "Klici iz sob se prikažejo v zgodovini klicev aplikacije Telefon: dohodni, odhodni in zgrešeni, z uro in oznako, ali so imeli video. iOS jo lahko sinhronizira z vašimi drugimi napravami z istim računom Apple. Vnos nima številke: če ga tapnete, sobo prek te aplikacije pokličete znova.",
    "Huoneiden puhelut näkyvät Puhelin-apin puheluhistoriassa: saapuvat, lähtevät ja vastaamatta jääneet, aikoineen ja tietona siitä, oliko niissä video. iOS voi synkronoida sen muihin laitteisiisi, joissa on sama Apple-tili. Merkinnässä ei ole numeroa: sen napauttaminen soittaa huoneeseen uudelleen tämän sovelluksen kautta.",
  ),
  "calllog.name.hint": T(
    "While the app is locked, only the app's name is ever written.", "Dokud je aplikace zamčená, zapíše se vždy jen jméno aplikace.",
    "Solange die App gesperrt ist, wird immer nur der Name der App geschrieben.", "Mientras la app está bloqueada, solo se anota el nombre de la app.",
    "Finché l’app è bloccata, viene scritto solo il nome dell’app.", "Tant que l’app est verrouillée, seul le nom de l’app est inscrit.",
    "Kým je aplikácia zamknutá, zapíše sa vždy len názov aplikácie.", "Dokler je aplikacija zaklenjena, se vedno zapiše samo ime aplikacije.",
    "Kun sovellus on lukittu, kirjoitetaan aina vain sovelluksen nimi.",
  ),

  /* ------------------------------------------------------------- NFC */
  "nfc.hold": T(
    "Hold a card or a phone near the top of the iPhone…", "Přiložte kartu nebo telefon k horní části iPhonu…", "Karte oder Telefon an den oberen Teil des iPhone halten…",
    "Acerca una tarjeta o un teléfono a la parte superior del iPhone…", "Avvicina una carta o un telefono alla parte superiore dell’iPhone…",
    "Approchez une carte ou un téléphone du haut de l’iPhone…", "Priložte kartu alebo telefón k hornej časti iPhonu…",
    "Prislonite kartico ali telefon na zgornji del iPhona …", "Pidä korttia tai puhelinta iPhonen yläosaa vasten…",
  ),
  "nfc.work.tapScan": T(
    "Tap Scan and hold a card near the top of the iPhone.", "Klepněte na Sken a přiložte kartu k horní části iPhonu.", "Auf Scan tippen und eine Karte an den oberen Teil des iPhone halten.",
    "Toca Escanear y acerca una tarjeta a la parte superior del iPhone.", "Tocca Scansiona e avvicina una carta alla parte superiore dell’iPhone.",
    "Touchez Scan et approchez une carte du haut de l’iPhone.", "Klepnite na Sken a priložte kartu k hornej časti iPhonu.",
    "Tapnite Skeniraj in prislonite kartico na zgornji del iPhona.", "Napauta Skannaa ja pidä korttia iPhonen yläosaa vasten.",
  ),
  // The sheet's line in the app (NfcModelSheet) — the system sheet's own words (nfc.ios.hold).
  "nfc.model.hold": IOS_STRINGS["nfc.ios.hold"],

  /* ------------------------------------------------- the microphone */
  "look.mic.blocked": T(
    "The microphone is blocked for the app — allow it in Settings › Apps › M5cet › Microphone.",
    "Mikrofon je pro aplikaci zakázaný — povolte ho v Nastavení › Aplikace › M5cet › Mikrofon.",
    "Das Mikrofon ist für die App gesperrt — erlauben Sie es unter Einstellungen › Apps › M5cet › Mikrofon.",
    "El micrófono está bloqueado para la app: permítelo en Ajustes › Apps › M5cet › Micrófono.",
    "Il microfono è bloccato per l’app — consentilo in Impostazioni › App › M5cet › Microfono.",
    "Le micro est bloqué pour l’app — autorisez-le dans Réglages › Apps › M5cet › Micro.",
    "Mikrofón je pre aplikáciu zakázaný — povoľte ho v Nastaveniach › Aplikácie › M5cet › Mikrofón.",
    "Mikrofon je za aplikacijo blokiran — dovolite ga v Nastavitve › Aplikacije › M5cet › Mikrofon.",
    "Mikrofoni on estetty sovellukselta – salli se kohdassa Asetukset › Apit › M5cet › Mikrofoni.",
  ),
};

/**
 * Android's passkey texts name Android's password managers (Google Password
 * Manager, Samsung Pass); on iOS the one with PRF is the Passwords app
 * (iCloud Keychain). The rest of each sentence stays Android's.
 */
const PASSWORDS_APP: Record<Locale, [string, string][]> = {
  en: [["Google Password Manager or Samsung Pass", "the Passwords app"], ["Google Password Manager", "the Passwords app"]],
  cs: [["ze Správce hesel Google", "z aplikace Hesla"], ["Správce hesel Google nebo Samsung Pass", "aplikace Hesla"], ["Správce hesel Google", "aplikace Hesla"]],
  de: [["dem Google Passwortmanager", "der App „Passwörter“"], ["Google Passwortmanager oder Samsung Pass", "die App „Passwörter“"], ["Google Passwortmanager", "die App „Passwörter“"]],
  es: [["el Gestor de contraseñas de Google o Samsung Pass", "la app Contraseñas"], ["el Gestor de contraseñas de Google", "la app Contraseñas"]],
  it: [["Gestore delle password di Google o Samsung Pass", "l’app Password"], ["Gestore delle password di Google", "l’app Password"]],
  fr: [["Gestionnaire de mots de passe Google ou Samsung Pass", "l’app Mots de passe"], ["Gestionnaire de mots de passe Google", "l’app Mots de passe"]],
  sk: [["zo Správcu hesiel Google", "z aplikácie Heslá"], ["Správca hesiel Google alebo Samsung Pass", "aplikácia Heslá"], ["Správca hesiel Google", "aplikácia Heslá"]],
  sl: [["iz Googlovega upravitelja gesel", "iz aplikacije Gesla"], ["Googlov upravitelj gesel ali Samsung Pass", "aplikacija Gesla"], ["Googlov upravitelj gesel", "aplikacija Gesla"]],
  fi: [["Google Password Manager tai Samsung Pass", "Salasanat-app"], ["Google Password Manager", "Salasanat-app"]],
};

/** The passkey texts that name a password manager. */
export const IOS_PASSKEY_KEYS = ["passkey.addNoPrf", "passkey.boundText", "passkey.noPrf", "passkey.orphan", "passkey.unknownHint", "set.user.boundHint"];

const swap = (text: string, pairs: [string, string][]): string => pairs.reduce((s, [from, to]) => s.split(from).join(to), text);

for (const key of IOS_PASSKEY_KEYS) {
  IOS_WORDING[key] = Object.fromEntries(LANGS.map((l) => [l, swap(DEFAULT_DESIGN.strings[l][key], PASSWORDS_APP[l])])) as Texts;
}
// The APDU templates are Define's (console › iOS › Define — the same set as Android's).
IOS_WORDING["nfc.tpl.none"] = Object.fromEntries(LANGS.map((l) => [l, DEFAULT_DESIGN.strings[l]["nfc.tpl.none"].replace("→ Android →", "→ iOS →")])) as Texts;

/** Elements of Android's screens iOS cannot do: Settings › Calls' call log permission and erasing the system call log. */
export const IOS_REMOVED_NODES: Record<string, string[]> = { "settings.calls": ["calllog-perm", "calllog-erase"] };

/**
 * The update notice: an iOS release is a version record with an App Store / TestFlight link and no download
 * size (ios/M5cet/Platform/Push/UpdateNotice.swift: size 0), and "Version 6.15.0 · 0 B" said nothing true —
 * the size shows only when there is one (a design bundle's).
 */
function updateWithoutSize(screens: Record<string, ANode>): void {
  const root = screens["update"];
  const version = root && findNode(root, "version");
  const parent = root && parentOf(root, "version");
  if (!version || !parent?.children || findNode(root, "version-only")) return;
  version.if = "$update.size > 0";
  const at = parent.children.indexOf(version);
  parent.children.splice(at + 1, 0, { ...structuredClone(version), id: "version-only", text: "{_'update.version'} {$update.version}", if: "!($update.size > 0)" });
}

/** The screens of the iOS design that are not Android's as they are (the rest are). */
export const IOS_CHANGED_SCREENS = ["settings.notify", ...Object.keys(IOS_REMOVED_NODES), "update"];

const findNode =(node: ANode, id: string): ANode | null => {
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

/**
 * Not on a device that cannot pair with an Apple Watch: the iOS app's $app.watch is false on an iPad
 * (WCSession.isSupported — ios/M5cet/Renderer/Shell/DesignHost.swift appScope); where $app has no "watch"
 * (the console's preview) the rows show.
 */
export const IOS_WATCH_IF = "$app.watch != false";

/** The Apple Watch rows: a switch bound to watch.on in the shape of its neighbours (icon, label, switch), and its hint. */
export function watchRows(): ANode[] {
  return [
    {
      id: "watch", el: "row", if: IOS_WATCH_IF, style: { padding: "10 12 10 20", gap: 18, align: "center" }, children: [
        // Lucide has no watch in the design's icon set (client/src/lib/menu-icons-data.ts): a watch face.
        { id: "watch-icon", el: "icon", props: { icon: "clock-3", size: 22, color: "@muted" } },
        { id: "watch-label", el: "text", text: "{_'watch.setting'}", style: { size: 16, weight: 1 } },
        { id: "watch-switch", el: "switch", props: { setting: IOS_WATCH_SETTING } },
      ],
    },
    { id: "watch-hint", el: "text", text: "{_'watch.setting.hint'}", if: IOS_WATCH_IF, props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 64" } },
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

/** IOS_REMOVED_NODES out of their screens. */
function removeNodes(screens: Record<string, ANode>): void {
  for (const [screen, ids] of Object.entries(IOS_REMOVED_NODES)) {
    const root = screens[screen];
    if (!root) continue;
    for (const id of ids) {
      const parent = parentOf(root, id);
      if (parent?.children) parent.children = parent.children.filter((c) => c.id !== id);
    }
  }
}

/** Android's default design (deep copy — Android's own stays as it is) with the iOS look and the iOS-only items. */
function iosDefaultDesign(): AndroidDesign {
  const d = structuredClone(DEFAULT_DESIGN);
  d.theme = IOS_THEME;
  d.animations = IOS_ANIMATIONS;
  addWatchSwitch(d.screens);
  removeNodes(d.screens);
  updateWithoutSize(d.screens);
  for (const lang of LANGS) {
    for (const [key, texts] of Object.entries(IOS_STRINGS)) d.strings[lang][key] = texts[lang];
    for (const [key, texts] of Object.entries(IOS_WORDING)) d.strings[lang][key] = texts[lang];
  }
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
