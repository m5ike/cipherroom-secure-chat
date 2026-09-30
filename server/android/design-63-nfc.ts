// 6.3 — the NFC workbench: reader choice, card technologies, scan, read, write,
// change UID, emulate, and the M5Cet card (records and the visual builder).
// Merged into the default design by design-63.ts.
//
// The screens are thin: a bar plus a native slot (the workbench does the reader
// choice, the continuous scan, the per-technology functions and the M5Cet card;
// the builder adds/edits/reorders records and writes the card). The "nfc" tree
// is REPLACED here (design-63 is merged after 6.1/6.2), so Tools › NFC and the
// menu open the new workbench, while the old connection-card read/write/emulate
// keeps working inside it (byte-compatible with the web's connection tag).

import type { ANode, ElementDef, MenuItem, ScreenDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
export const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
export const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

const bar = (title: string): ANode => n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
  n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
  n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
]);

const screen = (title: string, slot: string): ANode => n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
  bar(title),
  n("panel", "slot", { props: { name: slot }, style: { weight: 1 } }),
]);

export const ELEMENTS_63_NFC: ElementDef[] = [];

export const ACTIONS_63_NFC: Array<{ action: string; arg: string; help: string }> = [
  { action: "nfc.workbench", arg: "", help: "Open the NFC workbench (reader choice, scan, per-type functions, the M5Cet card)" },
  { action: "nfc.builder", arg: "", help: "Open the M5Cet card builder (records, PIN/PassKey, one-time, write)" },
  { action: "nfc.reader", arg: "internal|usb|bluetooth", help: "Choose the NFC reader (the same names as the web)" },
];

export const SLOTS_63_NFC: Array<{ name: string; label: string; screens: string[] }> = [
  { name: "nfcWork", label: "NFC workbench", screens: ["nfc"] },
  { name: "nfcBuilder", label: "M5Cet card builder", screens: ["nfc.builder"] },
];

export const SCREENS_63_NFC: ScreenDef[] = [
  { id: "nfc.builder", label: "NFC · M5Cet builder", group: "app" as const, vars: [], sample: {}, help: "Build an M5Cet card's records (message, Wi-Fi, contact, server room, keys…), choose a PIN or the account PassKey, one-time, and write the card to a tag." },
];

export const SCREENS_TREES_63_NFC: Record<string, ANode> = {
  // Replaces the 6.1 "nfc" screen (the connection-card panel) with the workbench.
  nfc: screen("{_'tools.nfc'}", "nfcWork"),
  "nfc.builder": screen("{_'nfc.builder.title'}", "nfcBuilder"),
};

export const MENUS_63_NFC: Record<string, MenuItem[]> = {};

export const STRINGS_63_NFC: Record<"cs" | "en" | "de", Record<string, string>> = {
  cs: {
    // record types + their actions
    "nfc.rec.passkey": "Záloha přístupového klíče", "nfc.rec.identity": "Záloha identity", "nfc.rec.onetime": "Zpráva na jedno přečtení",
    "nfc.rec.message": "Zpráva", "nfc.rec.serverRoom": "Místnost na serveru", "nfc.rec.externalKey": "Externí klíč",
    "nfc.rec.contact": "Kontakt", "nfc.rec.wifi": "Wi-Fi", "nfc.rec.urlLogin": "Přihlášení k webu",
    "nfc.rec.restore": "Obnovit", "nfc.rec.show": "Zobrazit", "nfc.rec.join": "Připojit", "nfc.rec.import": "Importovat",
    "nfc.rec.saveContact": "Uložit kontakt", "nfc.rec.connect": "Připojit", "nfc.rec.open": "Otevřít",
    "nfc.rec.account": "účet", "nfc.rec.pin": "PIN", "nfc.rec.handoff": "Předejte do trezoru aplikace (přihlaste se na tomto zařízení).",
    // reader chooser
    "nfc.reader.title": "Čtečka", "nfc.reader.internal": "Tento telefon", "nfc.reader.usb": "USB", "nfc.reader.bluetooth": "Bluetooth",
    "nfc.reader.noUsb": "Žádná USB čtečka není připojená.", "nfc.reader.denied": "Přístup k USB čtečce byl odmítnut.",
    // workbench
    "nfc.work.tapScan": "Klepněte na Sken a přiložte kartu.", "nfc.work.scan": "Sken", "nfc.work.holdCard": "Přiložte kartu…",
    "nfc.keys.hint": "Klíče (po jednom na řádek, 12 hex znaků)",
    "nfc.m5.open": "Otevřít M5Cet", "nfc.m5.build": "Vytvořit kartu", "nfc.m5.none": "Na tagu není karta M5Cet.",
    "nfc.m5.records": "Záznamy", "nfc.m5.emulate": "Být kartou M5Cet", "nfc.m5.buildFirst": "Nejdřív kartu vytvořte.",
    "nfc.done.locked": "Zamčeno jen pro čtení", "nfc.done.written": "Zapsáno", "nfc.done.uid": "UID změněno",
    "nfc.restore.none": "Nejdřív pořiďte výpis (Dump).", "nfc.op.unsupported": "Tuto operaci tato čtečka nezvládne.",
    "nfc.uid.need": "Zadejte blok 0 (16 bajtů, hex).", "nfc.uid.prompt": "Blok 0 (16 bajtů, hex) — jen pro magic kartu",
    "nfc.conn.none": "Na tagu není připojka.", "nfc.wifi.pw": "Heslo", "nfc.wifi.settings": "Nastavení Wi-Fi", "nfc.login.copyPw": "Kopírovat heslo",
    "nfc.apdu.prompt": "APDU (hex)", "nfc.ndef.prompt": "Text pro NDEF", "nfc.hex.bad": "Neplatný hex.",
    "nfc.block.no": "Číslo bloku", "nfc.block.data": "Data", "nfc.write.title": "Zapsat blok",
    "nfc.onetime.rewrite": "Znovu přiložte kartu — smažu záznam na jedno přečtení.", "nfc.onetime.erased": "Záznam smazán",
    // builder
    "nfc.builder.title": "Tvorba karty M5Cet", "nfc.builder.pin": "Šifrovací PIN (6–18 číslic)", "nfc.builder.add": "Přidat záznam",
    "nfc.builder.oneTime": "Na jedno přečtení (po zobrazení se smaže)", "nfc.builder.internal": "Šifrovat účtem (PassKey) místo PINu",
    "nfc.builder.write": "Zapsat na kartu", "nfc.builder.size": "Velikost", "nfc.builder.big": "velké — použijte kartu s větší pamětí",
    "nfc.builder.empty": "Přidejte alespoň jeden záznam.", "nfc.builder.needAccount": "Interní záznam potřebuje účet (zatím není propojen).",
    // builder fields
    "nfc.field.text": "Text", "nfc.field.url": "URL", "nfc.field.server": "Server", "nfc.field.room": "Místnost",
    "nfc.field.passphrase": "Heslo místnosti", "nfc.field.name": "Jméno", "nfc.field.ssid": "SSID", "nfc.field.password": "Heslo",
    "nfc.field.auth": "Zabezpečení (WPA/WEP/nopass)", "nfc.field.user": "Uživatel", "nfc.field.note": "Poznámka", "nfc.field.email": "E-mail",
    "nfc.field.org": "Firma", "nfc.field.tel": "Telefon", "nfc.field.label": "Název", "nfc.field.key": "Klíč", "nfc.field.algo": "Algoritmus", "nfc.field.root": "Kořen (base64)",
  },
  en: {
    "nfc.rec.passkey": "Passkey backup", "nfc.rec.identity": "Identity backup", "nfc.rec.onetime": "One-time message",
    "nfc.rec.message": "Message", "nfc.rec.serverRoom": "Server room", "nfc.rec.externalKey": "External key",
    "nfc.rec.contact": "Contact", "nfc.rec.wifi": "Wi-Fi", "nfc.rec.urlLogin": "Website login",
    "nfc.rec.restore": "Restore", "nfc.rec.show": "Show", "nfc.rec.join": "Join", "nfc.rec.import": "Import",
    "nfc.rec.saveContact": "Save contact", "nfc.rec.connect": "Connect", "nfc.rec.open": "Open",
    "nfc.rec.account": "account", "nfc.rec.pin": "PIN", "nfc.rec.handoff": "Hand it to the app's vault (sign in on this device).",
    "nfc.reader.title": "Reader", "nfc.reader.internal": "This device", "nfc.reader.usb": "USB", "nfc.reader.bluetooth": "Bluetooth",
    "nfc.reader.noUsb": "No USB reader is attached.", "nfc.reader.denied": "USB reader access was denied.",
    "nfc.work.tapScan": "Tap Scan and hold a card to the back.", "nfc.work.scan": "Scan", "nfc.work.holdCard": "Hold the card…",
    "nfc.keys.hint": "Keys (one per line, 12 hex chars)",
    "nfc.m5.open": "Open M5Cet", "nfc.m5.build": "Build a card", "nfc.m5.none": "No M5Cet card on the tag.",
    "nfc.m5.records": "Records", "nfc.m5.emulate": "Be an M5Cet card", "nfc.m5.buildFirst": "Build a card first.",
    "nfc.done.locked": "Locked read-only", "nfc.done.written": "Written", "nfc.done.uid": "UID changed",
    "nfc.restore.none": "Take a dump first.", "nfc.op.unsupported": "This reader can't do that operation.",
    "nfc.uid.need": "Enter block 0 (16 bytes, hex).", "nfc.uid.prompt": "Block 0 (16 bytes, hex) — magic card only",
    "nfc.conn.none": "No connection card on the tag.", "nfc.wifi.pw": "Password", "nfc.wifi.settings": "Wi-Fi settings", "nfc.login.copyPw": "Copy password",
    "nfc.apdu.prompt": "APDU (hex)", "nfc.ndef.prompt": "Text for NDEF", "nfc.hex.bad": "Invalid hex.",
    "nfc.block.no": "Block number", "nfc.block.data": "Data", "nfc.write.title": "Write block",
    "nfc.onetime.rewrite": "Hold the card again — erasing the one-time record.", "nfc.onetime.erased": "Record erased",
    "nfc.builder.title": "M5Cet card builder", "nfc.builder.pin": "Encryption PIN (6–18 digits)", "nfc.builder.add": "Add a record",
    "nfc.builder.oneTime": "One-time (erased after it is shown)", "nfc.builder.internal": "Encrypt with your account (PassKey) instead of a PIN",
    "nfc.builder.write": "Write to a card", "nfc.builder.size": "Size", "nfc.builder.big": "large — use a bigger-memory tag",
    "nfc.builder.empty": "Add at least one record.", "nfc.builder.needAccount": "An internal record needs your account (not wired yet).",
    "nfc.field.text": "Text", "nfc.field.url": "URL", "nfc.field.server": "Server", "nfc.field.room": "Room",
    "nfc.field.passphrase": "Room passphrase", "nfc.field.name": "Name", "nfc.field.ssid": "SSID", "nfc.field.password": "Password",
    "nfc.field.auth": "Security (WPA/WEP/nopass)", "nfc.field.user": "User", "nfc.field.note": "Note", "nfc.field.email": "Email",
    "nfc.field.org": "Company", "nfc.field.tel": "Phone", "nfc.field.label": "Label", "nfc.field.key": "Key", "nfc.field.algo": "Algorithm", "nfc.field.root": "Root (base64)",
  },
  de: {
    "nfc.rec.passkey": "Passkey-Sicherung", "nfc.rec.identity": "Identitäts-Sicherung", "nfc.rec.onetime": "Einmal-Nachricht",
    "nfc.rec.message": "Nachricht", "nfc.rec.serverRoom": "Server-Raum", "nfc.rec.externalKey": "Externer Schlüssel",
    "nfc.rec.contact": "Kontakt", "nfc.rec.wifi": "WLAN", "nfc.rec.urlLogin": "Website-Login",
    "nfc.rec.restore": "Wiederherstellen", "nfc.rec.show": "Anzeigen", "nfc.rec.join": "Beitreten", "nfc.rec.import": "Importieren",
    "nfc.rec.saveContact": "Kontakt speichern", "nfc.rec.connect": "Verbinden", "nfc.rec.open": "Öffnen",
    "nfc.rec.account": "Konto", "nfc.rec.pin": "PIN", "nfc.rec.handoff": "An den Tresor der App übergeben (auf diesem Gerät anmelden).",
    "nfc.reader.title": "Lesegerät", "nfc.reader.internal": "Dieses Gerät", "nfc.reader.usb": "USB", "nfc.reader.bluetooth": "Bluetooth",
    "nfc.reader.noUsb": "Kein USB-Lesegerät angeschlossen.", "nfc.reader.denied": "Zugriff auf das USB-Lesegerät verweigert.",
    "nfc.work.tapScan": "Auf Scan tippen und eine Karte an die Rückseite halten.", "nfc.work.scan": "Scan", "nfc.work.holdCard": "Karte anhalten…",
    "nfc.keys.hint": "Schlüssel (einer pro Zeile, 12 Hex-Zeichen)",
    "nfc.m5.open": "M5Cet öffnen", "nfc.m5.build": "Karte erstellen", "nfc.m5.none": "Keine M5Cet-Karte auf dem Tag.",
    "nfc.m5.records": "Einträge", "nfc.m5.emulate": "Als M5Cet-Karte antworten", "nfc.m5.buildFirst": "Erst eine Karte erstellen.",
    "nfc.done.locked": "Schreibgeschützt gesperrt", "nfc.done.written": "Geschrieben", "nfc.done.uid": "UID geändert",
    "nfc.restore.none": "Zuerst einen Dump erstellen.", "nfc.op.unsupported": "Dieses Lesegerät kann das nicht.",
    "nfc.uid.need": "Block 0 eingeben (16 Bytes, Hex).", "nfc.uid.prompt": "Block 0 (16 Bytes, Hex) — nur Magic-Karte",
    "nfc.conn.none": "Keine Verbindungskarte auf dem Tag.", "nfc.wifi.pw": "Passwort", "nfc.wifi.settings": "WLAN-Einstellungen", "nfc.login.copyPw": "Passwort kopieren",
    "nfc.apdu.prompt": "APDU (Hex)", "nfc.ndef.prompt": "Text für NDEF", "nfc.hex.bad": "Ungültiges Hex.",
    "nfc.block.no": "Blocknummer", "nfc.block.data": "Daten", "nfc.write.title": "Block schreiben",
    "nfc.onetime.rewrite": "Karte erneut anhalten — der Einmal-Eintrag wird gelöscht.", "nfc.onetime.erased": "Eintrag gelöscht",
    "nfc.builder.title": "M5Cet-Kartenersteller", "nfc.builder.pin": "Verschlüsselungs-PIN (6–18 Ziffern)", "nfc.builder.add": "Eintrag hinzufügen",
    "nfc.builder.oneTime": "Einmalig (nach Anzeige gelöscht)", "nfc.builder.internal": "Mit Konto (PassKey) statt PIN verschlüsseln",
    "nfc.builder.write": "Auf eine Karte schreiben", "nfc.builder.size": "Größe", "nfc.builder.big": "groß — größeren Tag verwenden",
    "nfc.builder.empty": "Mindestens einen Eintrag hinzufügen.", "nfc.builder.needAccount": "Ein interner Eintrag braucht dein Konto (noch nicht verbunden).",
    "nfc.field.text": "Text", "nfc.field.url": "URL", "nfc.field.server": "Server", "nfc.field.room": "Raum",
    "nfc.field.passphrase": "Raum-Passwort", "nfc.field.name": "Name", "nfc.field.ssid": "SSID", "nfc.field.password": "Passwort",
    "nfc.field.auth": "Sicherheit (WPA/WEP/nopass)", "nfc.field.user": "Benutzer", "nfc.field.note": "Notiz", "nfc.field.email": "E-Mail",
    "nfc.field.org": "Firma", "nfc.field.tel": "Telefon", "nfc.field.label": "Bezeichnung", "nfc.field.key": "Schlüssel", "nfc.field.algo": "Algorithmus", "nfc.field.root": "Wurzel (base64)",
  },
};

/** Changes to existing trees (after every 6.1/6.2/6.3 tree is in place). */
export function patch63Nfc(_screens: Record<string, ANode>): void { /* the "nfc" tree is replaced via SCREENS_TREES_63_NFC */ }
