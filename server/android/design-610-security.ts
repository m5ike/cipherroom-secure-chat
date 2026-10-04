// 6.10 design area: the texts of the app's security fixes (security analysis,
// chapter 12, G-17 and G-20 … G-24). No trees, menus or actions — only what
// the app says when it refuses something a design asked for, and when it asks
// the holder before a model gets a card's data:
//
//   security.refused     an action of the design was refused: its argument
//                        was computed from data where it could leave the
//                        phone (url.open, lib.run, fn.run, profile.public,
//                        a setting's key), it would change a privacy setting,
//                        or its value is outside the setting's rule
//                        (android/…/ui/ActionGuard.java, core/SettingSchema.java)
//   security.urlRefused  url.open with an address the person could not read
//                        in full: over 300 characters, spaces, hidden
//                        characters (bidi, zero-width) — ui/DesignUrls.java
//   nfc.consent.*        G-17: before a Functions model gets what a card read
//                        found on this phone (ui/parts/NfcModelSheet,
//                        nfc/ModelNfc.consent): which model, what goes masked,
//                        what "Send everything" adds — the web's texts
//                        (client/src/lib/i18n-nfc.ts), the Czech formal as the
//                        app's other NFC texts
//
// One area of the 6.10 design (design-610.ts gathers them).

import type { DesignArea } from "./design-67";

const T = (cs: string, en: string, de: string) => ({ cs, en, de });

const STR: Record<string, { cs: string; en: string; de: string }> = {
  "security.refused": T(
    "Tuto akci vzhledu aplikace neprovedla: mohla by z telefonu odnést data nebo změnit nastavení soukromí.",
    "The app did not run this action of the design: it could carry data off the phone or change a privacy setting.",
    "Die App hat diese Aktion des Designs nicht ausgeführt: Sie könnte Daten vom Telefon tragen oder eine Datenschutzeinstellung ändern.",
  ),
  "security.urlRefused": T(
    "Tuto adresu aplikace neotevře: je příliš dlouhá nebo obsahuje mezery či skryté znaky.",
    "The app will not open this address: it is too long or contains spaces or hidden characters.",
    "Die App öffnet diese Adresse nicht: Sie ist zu lang oder enthält Leerzeichen oder versteckte Zeichen.",
  ),
  // G-17: a model's card read — what goes, and the choice (ModelNfc.consentText; {…} filled by the app)
  "nfc.consent.title": T("Poslat data z karty funkci?", "Send the card's data to the function?", "Die Daten der Karte an die Funktion senden?"),
  "nfc.consent.text": T(
    "{model} přečetl(a) kartu na tomto telefonu. Když souhlasíte, dostane:",
    "{model} read a card on this phone. With your yes, it gets:",
    "{model} hat auf diesem Telefon eine Karte gelesen. Mit deinem Ja erhält sie:",
  ),
  "nfc.consent.aModel": T("Funkce", "A function", "Eine Funktion"),
  "nfc.consent.emvApp": T("{app}: číslo karty {pan}, platnost {expiry}", "{app}: card number {pan}, expires {expiry}", "{app}: Kartennummer {pan}, gültig bis {expiry}"),
  "nfc.consent.cardholder": T("jméno držitele: {name}", "the cardholder's name: {name}", "den Namen des Karteninhabers: {name}"),
  "nfc.consent.history": T("historii transakcí (záznamů: {n})", "the transaction history (entries: {n})", "den Transaktionsverlauf (Einträge: {n})"),
  "nfc.consent.records": T("záznamy karty ({n}, číslo karty zamaskované)", "the card's records ({n}, the card number masked)", "die Datensätze der Karte ({n}, die Kartennummer maskiert)"),
  "nfc.consent.aids": T("aplikace na kartě: {aids}", "the applications on the card: {aids}", "die Anwendungen auf der Karte: {aids}"),
  "nfc.consent.fullPan": T("celé číslo karty a data stop (čísel: {n})", "the full card number and the track data (numbers: {n})", "die ganze Kartennummer und die Spurdaten (Nummern: {n})"),
  "nfc.consent.holder": T(
    "držitele dokladu {name}: státní občanství, data narození a platnosti, číslo dokladu {doc}",
    "the document holder {name}: nationality, dates of birth and expiry, document number {doc}",
    "den Dokumentinhaber {name}: Staatsangehörigkeit, Geburts- und Ablaufdatum, Dokumentnummer {doc}",
  ),
  "nfc.consent.mrz": T("řádky MRZ, celé číslo dokladu a volitelné údaje", "the MRZ lines, the full document number and the optional data", "die MRZ-Zeilen, die ganze Dokumentnummer und die optionalen Daten"),
  "nfc.consent.images": T("fotografii a obrázky z dokladu ({n})", "the photo and the document's pictures ({n})", "das Foto und die Bilder des Dokuments ({n})"),
  "nfc.consent.details": T(
    "další osobní údaje a údaje o dokladu (DG11, DG12, DG13, DG16)",
    "further personal and document details (DG11, DG12, DG13, DG16)",
    "weitere persönliche und Dokumentangaben (DG11, DG12, DG13, DG16)",
  ),
  "nfc.consent.files": T("soubory dokladu (EF.SOD, datové skupiny — {n})", "the document's files (EF.SOD, the data groups — {n})", "die Dateien des Dokuments (EF.SOD, die Datengruppen — {n})"),
  "nfc.consent.transcript": T("přepis APDU (příkazů: {n})", "the APDU transcript (commands: {n})", "das APDU-Protokoll (Befehle: {n})"),
  "nfc.consent.transcriptMasked": T(
    "přepis APDU (příkazů: {n}, čísla karet zamaskovaná)",
    "the APDU transcript (commands: {n}, card numbers masked)",
    "das APDU-Protokoll (Befehle: {n}, Kartennummern maskiert)",
  ),
  "nfc.consent.data": T("surová data z karty ({n} B)", "raw card data ({n} B)", "Rohdaten der Karte ({n} B)"),
  "nfc.consent.dataPan": T("surová data z karty s číslem karty ({n} B)", "raw card data with a card number in it ({n} B)", "Rohdaten der Karte mit einer Kartennummer ({n} B)"),
  "nfc.consent.fullAdds": T("„Poslat vše“ pošle navíc:", "\"Send everything\" also sends:", "„Alles senden“ sendet außerdem:"),
  "nfc.consent.sendMasked": T("Poslat (zamaskované)", "Send (masked)", "Senden (maskiert)"),
  "nfc.consent.sendFull": T("Poslat vše", "Send everything", "Alles senden"),
  "nfc.consent.dontSend": T("Neposílat", "Don't send", "Nicht senden"),
  "nfc.consent.notSent": T("Data z karty se neposlala.", "The card's data was not sent.", "Die Daten der Karte wurden nicht gesendet."),
};

export const AREA: DesignArea = {
  strings: {
    cs: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.cs])),
    en: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.en])),
    de: Object.fromEntries(Object.entries(STR).map(([k, v]) => [k, v.de])),
  },
};
