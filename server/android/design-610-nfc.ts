// 6.10 design area: the NFC tool's application templates — a template runs
// every step of a card type's read; its output switches between raw in / out,
// raw, JSON and readable, and is shared, forwarded or kept to myself.
// One area of the 6.10 design (design-610.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
//  - The workbench (the nfcWork slot, android/…/ui/parts/NfcWorkbench) is
//    native: its "Application template" button (always there, and the ISO-DEP
//    / EMV op of the same name) lists m5mobile.define.apduTemplates grouped by
//    card type with their notes — a template with a problem is listed, not
//    runnable, and says why; an older entry (one command, one whole read) is
//    marked. Picking one runs ALL its steps (android/…/nfc/TemplateRunner —
//    the contract in client/src/lib/nfc/apdu-templates.ts) with a progress
//    line and Cancel; an e-ID template asks the holder's key first.
//  - The output: a switch of the four views (apdu-templates.ts
//    TEMPLATE_VIEWS: in / out, raw, JSON, readable — readable after a run) and
//    three icons: Share (the system share sheet: the text, the JSON as a
//    file), Forward (a room, then everyone or one member: the text as a
//    message, the JSON as a file) and Keep for myself (a note in the current
//    room's history — kind "note", only on this device, never sent).
//  - No new element, action or tree: only the texts below (the readable
//    view's labels too, android/…/nfc/TemplateViews, English when missing).

import type { DesignArea } from "./design-67";

/** The keys this area adds (the same in every language; test/android-nfc-610.test.ts). */
export const NFC_610_STRINGS = {
  cs: {
    // The picker.
    "nfc.tpl.open": "Šablona aplikace", "nfc.tpl.title": "Šablony aplikací",
    "nfc.tpl.group.emv": "Platební karty (EMV)", "nfc.tpl.group.emrtd": "Občanské průkazy a pasy (e-ID)", "nfc.tpl.group.desfire": "MIFARE DESFire",
    "nfc.tpl.group.iso7816": "Čipové karty (ISO 7816-4)", "nfc.tpl.group.other": "Další šablony",
    "nfc.tpl.legacy": "starší záznam — jednotlivé příkazy", "nfc.tpl.legacyOp": "starší záznam — celé čtení v jednom kroku",
    "nfc.tpl.steps": "Kroků: {0}", "nfc.tpl.cantRun": "Nelze spustit: {0}",
    // The run.
    "nfc.tpl.hold": "Přiložte kartu k telefonu — šablona provede všechny své kroky.", "nfc.tpl.running": "Krok {0} / {1} · {2}",
    "nfc.tpl.cancel": "Zrušit", "nfc.tpl.cancelled": "Zrušeno — níže je to, co se stihlo přečíst.", "nfc.tpl.done": "Hotovo · příkazů: {0} · {1} s",
    "nfc.tpl.failed": "Čtení se přerušilo: {0}", "nfc.tpl.noIsoDep": "Tato karta nekomunikuje přes ISO-DEP (APDU) — šablonu na ní nelze spustit.",
    "nfc.tpl.usb": "Čtu kartu ve čtečce USB…", "nfc.tpl.noCard": "Ve čtečce USB není karta.",
    // The output.
    "nfc.out.io": "Vstup/výstup", "nfc.out.raw": "Surová data", "nfc.out.json": "JSON", "nfc.out.readable": "Čitelně",
    "nfc.out.share": "Sdílet", "nfc.out.forward": "Přeposlat uživateli", "nfc.out.toMyself": "Ponechat jen pro sebe",
    "nfc.out.noted": "Uloženo jako poznámka v místnosti {0} — vidíte ji jen vy, nic se neodeslalo.",
    "nfc.out.noRoom": "Nejdřív otevřete místnost — poznámka se uloží do její historie.", "nfc.out.me": "mě (poznámka, neodesláno)",
    "nfc.out.noteHead": "Poznámka pro mě", "nfc.out.asFile": "Odesláno jako soubor — na zprávu je to příliš dlouhé.",
    "nfc.out.truncated": "Na obrazovce zkráceno — celý výstup dá Sdílet.", "nfc.out.empty": "Ke kartě nedošel žádný příkaz.",
    // The readable view.
    "nfc.tpl.r.card": "Karta", "nfc.tpl.r.tech": "Technologie", "nfc.tpl.r.aids": "Aplikace na kartě", "nfc.tpl.r.read": "Čtení",
    "nfc.tpl.r.deep": "všechny soubory", "nfc.tpl.r.afl": "záznamy AFL", "nfc.tpl.r.app": "Aplikace", "nfc.tpl.r.label": "Název",
    "nfc.tpl.r.scheme": "Schéma", "nfc.tpl.r.pan": "Číslo karty", "nfc.tpl.r.currency": "Měna", "nfc.tpl.r.country": "Země",
    "nfc.tpl.r.result": "Výsledek", "nfc.tpl.r.logSfi": "Soubor historie (SFI)", "nfc.tpl.r.logFormat": "Formát historie",
    "nfc.tpl.r.holder": "Držitel", "nfc.tpl.r.name": "Jméno", "nfc.tpl.r.optionalData": "Volitelné údaje", "nfc.tpl.r.mrz": "MRZ",
    "nfc.tpl.r.file": "Soubor", "nfc.tpl.r.status": "Stav", "nfc.tpl.r.size": "Velikost", "nfc.tpl.r.message": "Zpráva",
    "nfc.tpl.r.command": "Příkaz", "nfc.tpl.r.response": "Odpověď", "nfc.tpl.r.text": "Text", "nfc.tpl.r.steps": "Kroky",
    "nfc.tpl.r.total": "příkazů: {0} · {1} s", "nfc.tpl.r.cancelled": "Zrušeno — toto se stihlo přečíst.", "nfc.tpl.r.stopped": "Čtení se přerušilo: {0}",
    "nfc.tpl.r.none": "žádné", "nfc.tpl.r.desfire": "MIFARE DESFire", "nfc.tpl.r.vendor": "Výrobce", "nfc.tpl.r.product": "Produkt",
    "nfc.tpl.r.hw": "Hardware", "nfc.tpl.r.sw": "Software", "nfc.tpl.r.storage": "Paměť", "nfc.tpl.r.protocol": "Protokol",
    "nfc.tpl.r.batch": "Šarže", "nfc.tpl.r.produced": "Vyrobeno", "nfc.tpl.r.week": "{0}. týden roku {1}", "nfc.tpl.r.apps": "Aplikace (AID)",
    "nfc.tpl.r.free": "Volná paměť", "nfc.tpl.r.keys": "Nastavení klíčů (PICC)", "nfc.tpl.r.keyCount": "klíčů: {0}, {1}",
    "nfc.tpl.r.ks.change": "hlavní klíč lze změnit", "nfc.tpl.r.ks.list": "aplikace se vypíší bez klíče", "nfc.tpl.r.ks.create": "aplikace lze zakládat bez klíče",
    "nfc.tpl.r.ks.config": "nastavení lze měnit", "nfc.tpl.r.ks.frozen": "nastavení je zmrazené",
    "nfc.tpl.n.dir": "aplikací v adresáři: {0}", "nfc.tpl.n.noDir": "karta nemá adresář aplikací", "nfc.tpl.n.selected": "vybráno: {0}",
    "nfc.tpl.n.notSelected": "na kartě není — její kroky se přeskočily", "nfc.tpl.n.noAid": "není vybraná žádná aplikace",
    "nfc.tpl.n.getData": "odpovědí: {0} z {1}", "nfc.tpl.n.noLog": "karta nevede historii transakcí", "nfc.tpl.n.log": "záznamů: {0}",
    "nfc.tpl.n.gpo": "AIP {0} · AFL {1}", "nfc.tpl.n.gpoRefused": "karta odmítla GET PROCESSING OPTIONS", "nfc.tpl.n.noAfl": "chybí AFL (GPO ho nevrátilo)",
    "nfc.tpl.n.records": "záznamů: {0}", "nfc.tpl.n.apps": "přečtených aplikací: {0}", "nfc.tpl.n.unknownOp": "neznámá operace {0}",
    "nfc.tpl.n.badCommand": "neplatný příkaz", "nfc.tpl.n.lost": "karta přestala odpovídat", "nfc.tpl.n.cancelled": "zrušeno",
    // Security review 6.10: read-only templates (G-18), masked card numbers (G-19).
    "nfc.tpl.n.refused": "odmítnuto, nic se neodeslalo — {0}", "nfc.tpl.r.masked": "Čísla karet a data stop jsou skrytá.",
    "nfc.out.fullPan": "Celá čísla karet", "nfc.out.masked": "Čísla karet a data stop jsou skrytá — tady i v tom, co sdílíte nebo pošlete.",
  },
  en: {
    "nfc.tpl.open": "Application template", "nfc.tpl.title": "Application templates",
    "nfc.tpl.group.emv": "Payment cards (EMV)", "nfc.tpl.group.emrtd": "ID cards and passports (e-ID)", "nfc.tpl.group.desfire": "MIFARE DESFire",
    "nfc.tpl.group.iso7816": "Smart cards (ISO 7816-4)", "nfc.tpl.group.other": "Other templates",
    "nfc.tpl.legacy": "older entry — single commands", "nfc.tpl.legacyOp": "older entry — the whole read in one step",
    "nfc.tpl.steps": "Steps: {0}", "nfc.tpl.cantRun": "Can't run: {0}",
    "nfc.tpl.hold": "Hold the card to the phone — the template runs every one of its steps.", "nfc.tpl.running": "Step {0} / {1} · {2}",
    "nfc.tpl.cancel": "Cancel", "nfc.tpl.cancelled": "Cancelled — what was read so far is below.", "nfc.tpl.done": "Done · {0} commands · {1} s",
    "nfc.tpl.failed": "The read stopped: {0}", "nfc.tpl.noIsoDep": "This card doesn't speak ISO-DEP (APDU) — the template can't run on it.",
    "nfc.tpl.usb": "Reading the card in the USB reader…", "nfc.tpl.noCard": "No card in the USB reader.",
    "nfc.out.io": "In / out", "nfc.out.raw": "Raw", "nfc.out.json": "JSON", "nfc.out.readable": "Readable",
    "nfc.out.share": "Share", "nfc.out.forward": "Forward to a user", "nfc.out.toMyself": "Keep for myself",
    "nfc.out.noted": "Kept as a note in {0} — only you see it, nothing was sent.",
    "nfc.out.noRoom": "Open a room first — the note is kept in its history.", "nfc.out.me": "me (a note, not sent)",
    "nfc.out.noteHead": "Note to myself", "nfc.out.asFile": "Sent as a file — too long for a message.",
    "nfc.out.truncated": "Shortened on screen — Share gives the whole output.", "nfc.out.empty": "No command reached the card.",
    "nfc.tpl.r.card": "Card", "nfc.tpl.r.tech": "Technology", "nfc.tpl.r.aids": "Applications on the card", "nfc.tpl.r.read": "Read",
    "nfc.tpl.r.deep": "every file", "nfc.tpl.r.afl": "AFL records", "nfc.tpl.r.app": "Application", "nfc.tpl.r.label": "Label",
    "nfc.tpl.r.scheme": "Scheme", "nfc.tpl.r.pan": "Card number", "nfc.tpl.r.currency": "Currency", "nfc.tpl.r.country": "Country",
    "nfc.tpl.r.result": "Result", "nfc.tpl.r.logSfi": "Log file (SFI)", "nfc.tpl.r.logFormat": "Log format",
    "nfc.tpl.r.holder": "Holder", "nfc.tpl.r.name": "Name", "nfc.tpl.r.optionalData": "Optional data", "nfc.tpl.r.mrz": "MRZ",
    "nfc.tpl.r.file": "File", "nfc.tpl.r.status": "Status", "nfc.tpl.r.size": "Size", "nfc.tpl.r.message": "Message",
    "nfc.tpl.r.command": "Command", "nfc.tpl.r.response": "Response", "nfc.tpl.r.text": "Text", "nfc.tpl.r.steps": "Steps",
    "nfc.tpl.r.total": "{0} commands · {1} s", "nfc.tpl.r.cancelled": "Cancelled — this is what was read before.", "nfc.tpl.r.stopped": "The read stopped: {0}",
    "nfc.tpl.r.none": "none", "nfc.tpl.r.desfire": "MIFARE DESFire", "nfc.tpl.r.vendor": "Vendor", "nfc.tpl.r.product": "Product",
    "nfc.tpl.r.hw": "Hardware", "nfc.tpl.r.sw": "Software", "nfc.tpl.r.storage": "Storage", "nfc.tpl.r.protocol": "Protocol",
    "nfc.tpl.r.batch": "Batch", "nfc.tpl.r.produced": "Produced", "nfc.tpl.r.week": "week {0} of {1}", "nfc.tpl.r.apps": "Applications (AIDs)",
    "nfc.tpl.r.free": "Free memory", "nfc.tpl.r.keys": "Key settings (PICC)", "nfc.tpl.r.keyCount": "{0} key(s), {1}",
    "nfc.tpl.r.ks.change": "master key changeable", "nfc.tpl.r.ks.list": "applications listed without a key", "nfc.tpl.r.ks.create": "applications created without a key",
    "nfc.tpl.r.ks.config": "settings changeable", "nfc.tpl.r.ks.frozen": "settings frozen",
    "nfc.tpl.n.dir": "{0} application(s) listed", "nfc.tpl.n.noDir": "no directory on the card", "nfc.tpl.n.selected": "selected: {0}",
    "nfc.tpl.n.notSelected": "not on the card — its steps were skipped", "nfc.tpl.n.noAid": "no application to select",
    "nfc.tpl.n.getData": "{0} of {1} answered", "nfc.tpl.n.noLog": "the card keeps no transaction log", "nfc.tpl.n.log": "{0} entries",
    "nfc.tpl.n.gpo": "AIP {0} · AFL {1}", "nfc.tpl.n.gpoRefused": "the card refused GET PROCESSING OPTIONS", "nfc.tpl.n.noAfl": "no AFL (GPO gave none)",
    "nfc.tpl.n.records": "{0} record(s)", "nfc.tpl.n.apps": "{0} application(s) read", "nfc.tpl.n.unknownOp": "unknown operation {0}",
    "nfc.tpl.n.badCommand": "not a valid command", "nfc.tpl.n.lost": "the card stopped answering", "nfc.tpl.n.cancelled": "cancelled",
    "nfc.tpl.n.refused": "refused, never sent — {0}", "nfc.tpl.r.masked": "Card numbers and track data are masked.",
    "nfc.out.fullPan": "Full card numbers", "nfc.out.masked": "Card numbers and track data are masked — here and in what you share or send.",
  },
  de: {
    "nfc.tpl.open": "Anwendungsvorlage", "nfc.tpl.title": "Anwendungsvorlagen",
    "nfc.tpl.group.emv": "Zahlungskarten (EMV)", "nfc.tpl.group.emrtd": "Ausweise und Pässe (e-ID)", "nfc.tpl.group.desfire": "MIFARE DESFire",
    "nfc.tpl.group.iso7816": "Chipkarten (ISO 7816-4)", "nfc.tpl.group.other": "Weitere Vorlagen",
    "nfc.tpl.legacy": "älterer Eintrag — einzelne Befehle", "nfc.tpl.legacyOp": "älterer Eintrag — das ganze Lesen in einem Schritt",
    "nfc.tpl.steps": "Schritte: {0}", "nfc.tpl.cantRun": "Nicht ausführbar: {0}",
    "nfc.tpl.hold": "Halten Sie die Karte an das Telefon — die Vorlage führt alle ihre Schritte aus.", "nfc.tpl.running": "Schritt {0} / {1} · {2}",
    "nfc.tpl.cancel": "Abbrechen", "nfc.tpl.cancelled": "Abgebrochen — unten steht, was bis dahin gelesen wurde.", "nfc.tpl.done": "Fertig · {0} Befehle · {1} s",
    "nfc.tpl.failed": "Das Lesen wurde unterbrochen: {0}", "nfc.tpl.noIsoDep": "Diese Karte spricht kein ISO-DEP (APDU) — die Vorlage kann darauf nicht laufen.",
    "nfc.tpl.usb": "Lese die Karte im USB-Leser…", "nfc.tpl.noCard": "Keine Karte im USB-Leser.",
    "nfc.out.io": "Ein / aus", "nfc.out.raw": "Rohdaten", "nfc.out.json": "JSON", "nfc.out.readable": "Lesbar",
    "nfc.out.share": "Teilen", "nfc.out.forward": "An einen Benutzer weiterleiten", "nfc.out.toMyself": "Nur für mich behalten",
    "nfc.out.noted": "Als Notiz in {0} gespeichert — nur Sie sehen sie, nichts wurde gesendet.",
    "nfc.out.noRoom": "Öffnen Sie zuerst einen Raum — die Notiz wird in seinem Verlauf gespeichert.", "nfc.out.me": "mich (Notiz, nicht gesendet)",
    "nfc.out.noteHead": "Notiz für mich", "nfc.out.asFile": "Als Datei gesendet — zu lang für eine Nachricht.",
    "nfc.out.truncated": "Auf dem Bildschirm gekürzt — Teilen liefert die ganze Ausgabe.", "nfc.out.empty": "Kein Befehl hat die Karte erreicht.",
    "nfc.tpl.r.card": "Karte", "nfc.tpl.r.tech": "Technologie", "nfc.tpl.r.aids": "Anwendungen auf der Karte", "nfc.tpl.r.read": "Gelesen",
    "nfc.tpl.r.deep": "alle Dateien", "nfc.tpl.r.afl": "AFL-Datensätze", "nfc.tpl.r.app": "Anwendung", "nfc.tpl.r.label": "Name",
    "nfc.tpl.r.scheme": "Netz", "nfc.tpl.r.pan": "Kartennummer", "nfc.tpl.r.currency": "Währung", "nfc.tpl.r.country": "Land",
    "nfc.tpl.r.result": "Ergebnis", "nfc.tpl.r.logSfi": "Protokolldatei (SFI)", "nfc.tpl.r.logFormat": "Protokollformat",
    "nfc.tpl.r.holder": "Inhaber", "nfc.tpl.r.name": "Name", "nfc.tpl.r.optionalData": "Optionale Daten", "nfc.tpl.r.mrz": "MRZ",
    "nfc.tpl.r.file": "Datei", "nfc.tpl.r.status": "Status", "nfc.tpl.r.size": "Größe", "nfc.tpl.r.message": "Meldung",
    "nfc.tpl.r.command": "Befehl", "nfc.tpl.r.response": "Antwort", "nfc.tpl.r.text": "Text", "nfc.tpl.r.steps": "Schritte",
    "nfc.tpl.r.total": "{0} Befehle · {1} s", "nfc.tpl.r.cancelled": "Abgebrochen — das wurde bis dahin gelesen.", "nfc.tpl.r.stopped": "Das Lesen wurde unterbrochen: {0}",
    "nfc.tpl.r.none": "keine", "nfc.tpl.r.desfire": "MIFARE DESFire", "nfc.tpl.r.vendor": "Hersteller", "nfc.tpl.r.product": "Produkt",
    "nfc.tpl.r.hw": "Hardware", "nfc.tpl.r.sw": "Software", "nfc.tpl.r.storage": "Speicher", "nfc.tpl.r.protocol": "Protokoll",
    "nfc.tpl.r.batch": "Charge", "nfc.tpl.r.produced": "Hergestellt", "nfc.tpl.r.week": "KW {0} / {1}", "nfc.tpl.r.apps": "Anwendungen (AIDs)",
    "nfc.tpl.r.free": "Freier Speicher", "nfc.tpl.r.keys": "Schlüsseleinstellungen (PICC)", "nfc.tpl.r.keyCount": "{0} Schlüssel, {1}",
    "nfc.tpl.r.ks.change": "Hauptschlüssel änderbar", "nfc.tpl.r.ks.list": "Anwendungen ohne Schlüssel auflistbar", "nfc.tpl.r.ks.create": "Anwendungen ohne Schlüssel anlegbar",
    "nfc.tpl.r.ks.config": "Einstellungen änderbar", "nfc.tpl.r.ks.frozen": "Einstellungen eingefroren",
    "nfc.tpl.n.dir": "{0} Anwendung(en) im Verzeichnis", "nfc.tpl.n.noDir": "kein Anwendungsverzeichnis auf der Karte", "nfc.tpl.n.selected": "ausgewählt: {0}",
    "nfc.tpl.n.notSelected": "nicht auf der Karte — ihre Schritte wurden übersprungen", "nfc.tpl.n.noAid": "keine Anwendung zum Auswählen",
    "nfc.tpl.n.getData": "{0} von {1} beantwortet", "nfc.tpl.n.noLog": "die Karte führt keinen Transaktionsverlauf", "nfc.tpl.n.log": "{0} Einträge",
    "nfc.tpl.n.gpo": "AIP {0} · AFL {1}", "nfc.tpl.n.gpoRefused": "die Karte hat GET PROCESSING OPTIONS abgelehnt", "nfc.tpl.n.noAfl": "kein AFL (GPO lieferte keins)",
    "nfc.tpl.n.records": "{0} Datensätze", "nfc.tpl.n.apps": "{0} Anwendung(en) gelesen", "nfc.tpl.n.unknownOp": "unbekannte Operation {0}",
    "nfc.tpl.n.badCommand": "kein gültiger Befehl", "nfc.tpl.n.lost": "die Karte antwortet nicht mehr", "nfc.tpl.n.cancelled": "abgebrochen",
    "nfc.tpl.n.refused": "abgelehnt, nichts gesendet — {0}", "nfc.tpl.r.masked": "Kartennummern und Spurdaten sind ausgeblendet.",
    "nfc.out.fullPan": "Vollständige Kartennummern", "nfc.out.masked": "Kartennummern und Spurdaten sind ausgeblendet — hier und in dem, was Sie teilen oder senden.",
  },
} satisfies Record<"cs" | "en" | "de", Record<string, string>>;

export const AREA: DesignArea = { strings: NFC_610_STRINGS };
