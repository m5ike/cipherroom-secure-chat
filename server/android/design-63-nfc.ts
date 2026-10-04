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
    "nfc.work.pin": "PIN karty", "nfc.work.tapScan": "Klepněte na Sken a přiložte kartu.", "nfc.work.scan": "Sken", "nfc.work.holdCard": "Přiložte kartu…",
    "nfc.keys.hint": "Klíče (po jednom na řádek, 12 hex znaků)",
    "nfc.tpl.none": "Nejsou definované šablony APDU (konzole → Android → Define, apduTemplates).", "nfc.tpl.bad": "Šablona nemá platné APDU.", "nfc.m5.open": "Otevřít M5Cet", "nfc.m5.build": "Vytvořit kartu", "nfc.m5.none": "Na tagu není karta M5Cet.",
    "nfc.m5.records": "Záznamy", "nfc.m5.emulate": "Být kartou M5Cet", "nfc.m5.buildFirst": "Nejdřív kartu vytvořte.",
    "nfc.done.locked": "Zamčeno jen pro čtení", "nfc.done.written": "Zapsáno", "nfc.done.writtenBytes": "Zapsáno {0} B", "nfc.done.uid": "UID změněno",
    "nfc.err.readOnly": "Karta je jen pro čtení.", "nfc.err.tooSmall": "Málo místa: potřebuje {0} B, karta má {1} B.",
    "nfc.err.noKey": "Chybí klíč k sektoru {0} — přidejte jeho klíč.", "nfc.err.notWritable": "Na tento tag neumím zapsat.",
    "nfc.restore.none": "Nejdřív pořiďte výpis (Dump).", "nfc.op.unsupported": "Tuto operaci tato čtečka nezvládne.",
    "nfc.uid.need": "Zadejte blok 0 (16 bajtů, hex).", "nfc.uid.prompt": "Blok 0 (16 bajtů, hex) — jen pro magic kartu",
    "nfc.conn.none": "Na tagu není připojka.", "nfc.wifi.pw": "Heslo", "nfc.wifi.settings": "Nastavení Wi-Fi", "nfc.login.copyPw": "Kopírovat heslo",
    "nfc.apdu.prompt": "APDU (hex)", "nfc.ndef.prompt": "Text pro NDEF", "nfc.hex.bad": "Neplatný hex.",
    "nfc.block.no": "Číslo bloku", "nfc.block.data": "Data", "nfc.write.title": "Zapsat blok",
    "nfc.onetime.rewrite": "Znovu přiložte kartu — smažu záznam na jedno přečtení.", "nfc.onetime.erased": "Záznam smazán",
    // 6.5 — EMV card data + e-ID / e-passport (BAC, read-only)
    "nfc.readonly.help": "Jen pro čtení, na zařízení. Žádný PIN, žádné podpisy, žádná transakce.",
    "nfc.emv.expiry": "Platnost", "nfc.emv.cardholder": "Držitel", "nfc.emv.effective": "Platí od", "nfc.emv.issuer": "Země vydání", "nfc.emv.ptc": "Zbývá pokusů o PIN", "nfc.emv.tags": "Datové prvky",
    "nfc.eid.title": "Načíst doklad", "nfc.eid.docNumber": "Číslo dokladu", "nfc.eid.dob": "Datum narození (RRMMDD)", "nfc.eid.expiry": "Platnost (RRMMDD)",
    "nfc.eid.can": "CAN (6 číslic na dokladu, pro PACE)", "nfc.eid.mrz": "nebo vložte MRZ (2–3 řádky)", "nfc.eid.photo": "Načíst fotografii", "nfc.eid.read": "Načíst",
    "nfc.eid.needKey": "Zadejte číslo dokladu, datum narození a platnost, vložte MRZ, nebo zadejte CAN.",
    "nfc.eid.nationality": "Národnost", "nfc.eid.issuer": "Vydávající stát", "nfc.eid.dobLabel": "Narození", "nfc.eid.sex": "Pohlaví", "nfc.eid.expiryLabel": "Platí do",
    "nfc.eid.dataGroups": "Datové skupiny", "nfc.eid.photoFormat": "Fotografie: {0} (nelze zobrazit)",
    // 6.6 — the deep read: EMV history, counters, every file; e-ID every data group, pictures, security
    "nfc.emv.panSeq": "Pořadí PAN", "nfc.emv.atc": "Počet transakcí (ATC)", "nfc.emv.lastOnlineAtc": "Poslední online ATC",
    "nfc.emv.history": "Historie transakcí", "nfc.emv.noHistory": "Karta nevede log transakcí (nebo není čitelný).",
    "nfc.emv.date": "Datum", "nfc.emv.time": "Čas", "nfc.emv.amount": "Částka", "nfc.emv.merchant": "Obchodník", "nfc.emv.type": "Typ",
    "nfc.emv.getData": "Čítače (GET DATA)", "nfc.emv.records": "Záznamy", "nfc.emv.log": "log",
    "nfc.emv.readDeep": "Čteno: všechny soubory · {0} APDU", "nfc.emv.readAfl": "Čteno: záznamy AFL · {0} APDU",
    "nfc.eid.all": "Načíst všechny datové skupiny", "nfc.eid.docCode": "Doklad", "nfc.eid.access": "Otevřeno pomocí",
    "nfc.eid.paceOffered": "Čip nabízí PACE", "nfc.eid.notUsed": "nepoužito",
    "nfc.eid.personal": "Osobní údaje (DG11)", "nfc.eid.fullName": "Celé jméno", "nfc.eid.otherNames": "Další jména", "nfc.eid.personalNumber": "Osobní číslo",
    "nfc.eid.fullDob": "Úplné datum narození", "nfc.eid.placeOfBirth": "Místo narození", "nfc.eid.address": "Adresa", "nfc.eid.telephone": "Telefon",
    "nfc.eid.profession": "Povolání", "nfc.eid.titleField": "Titul", "nfc.eid.summary": "Shrnutí", "nfc.eid.otherDocs": "Další cestovní doklady", "nfc.eid.custody": "Péče",
    "nfc.eid.document": "Údaje o dokladu (DG12)", "nfc.eid.issuingAuthority": "Vydal", "nfc.eid.dateOfIssue": "Datum vydání", "nfc.eid.otherPersons": "Další osoby",
    "nfc.eid.endorsements": "Poznámky", "nfc.eid.taxExit": "Daň / výjezd", "nfc.eid.personalized": "Personalizováno", "nfc.eid.personalizationDevice": "Personalizační systém",
    "nfc.eid.optional": "Volitelné údaje (DG13)", "nfc.eid.notify": "Osoby k vyrozumění (DG16)",
    "nfc.eid.images": "Obrázky", "nfc.eid.img.face": "Obličej", "nfc.eid.img.portrait": "Portrét", "nfc.eid.img.signature": "Podpis", "nfc.eid.img.document": "Doklad", "nfc.eid.img.other": "Obrázek",
    "nfc.eid.cantShow": "{0} — toto zařízení neumí zobrazit",
    "nfc.eid.security": "Zabezpečení", "nfc.eid.passive": "Pasivní autentizace", "nfc.eid.passiveOk": "všechny přečtené skupiny odpovídají EF.SOD",
    "nfc.eid.passiveBad": "některá skupina NEODPOVÍDÁ EF.SOD", "nfc.eid.passiveNone": "neověřeno", "nfc.eid.hash": "Hash",
    "nfc.eid.signer": "Podepsal (DS)", "nfc.eid.signedBy": "Vydal (CSCA)", "nfc.eid.validity": "Platnost", "nfc.eid.serial": "Sériové číslo",
    "nfc.eid.protocols": "Protokoly", "nfc.eid.aaKey": "Klíč aktivní autentizace", "nfc.eid.lds": "Verze LDS", "nfc.eid.unicode": "Verze Unicode",
    "nfc.eid.files": "Soubory", "nfc.eid.st.read": "přečteno", "nfc.eid.st.protected": "chráněno (EAC)", "nfc.eid.st.absent": "chybí", "nfc.eid.st.error": "chyba",
    // 6.6 — a Functions model asks this phone for a card (m5.nfc, /emv, /eid)
    "nfc.model.what.scan": "Načíst kartu", "nfc.model.what.uid": "Přečíst ID karty (UID)", "nfc.model.what.ndef": "Přečíst záznamy na tagu (NDEF)",
    "nfc.model.what.m5": "Zobrazit záznamy karty M5Cet", "nfc.model.what.emv": "Přečíst platební kartu", "nfc.model.what.emvPublic": "Přečíst veřejné údaje platební karty",
    "nfc.model.what.eid": "Přečíst občanský průkaz / pas", "nfc.model.what.eidPublic": "Ověřit občanský průkaz / pas", "nfc.model.by": "Žádá {0}",
    "nfc.model.hold": "Přiložte kartu k zadní straně telefonu", "nfc.model.holdUsb": "Položte kartu na čtečku — {0}", "nfc.model.waiting": "Čekám na kartu · {0} s",
    "nfc.model.reading": "Čtu — držte kartu v klidu…", "nfc.model.done": "Hotovo", "nfc.model.timeout": "Během {0} s nebyla přiložena žádná karta.",
    "nfc.model.lost": "Karta se vzdálila — držte ji přiloženou, dokud čtení neskončí.", "nfc.model.authFailed": "Doklad se neotevřel — zkontrolujte CAN nebo MRZ.",
    "nfc.model.notThisCard": "Tato karta to neumí.", "nfc.model.error": "Kartu se nepodařilo přečíst.", "nfc.model.cancel": "Zrušit",
    "nfc.model.settings": "Nastavení NFC", "nfc.model.offHelp": "Zapněte NFC v nastavení a spusťte příkaz znovu.",
    "nfc.model.denied": "Model chtěl zapsat na kartu — odmítnuto. Zápis jde jen v nástroji NFC.",
    "nfc.model.unsupported": "Model žádal o operaci NFC, kterou tento telefon pro model neprovede.",
    "nfc.model.key.title": "Otevřít doklad", "nfc.model.key.or": "nebo", "nfc.model.key.can": "CAN (6 číslic)",
    "nfc.model.key.help": "Čip se otevře číslem CAN vytištěným na průkazu (občanské průkazy EU) nebo pomocí MRZ. Co zadáte, zůstane v telefonu a použije se jen pro toto čtení.",
    "nfc.model.key.mrz": "MRZ (2–3 řádky ve spodní části dokladu)", "nfc.model.key.badCan": "CAN má 6 číslic.",
    "nfc.model.key.badMrz": "MRZ není úplná — vložte všechny její řádky.", "nfc.model.key.badDate": "Data jsou ve tvaru RRMMDD (6 číslic).",
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
    "nfc.work.pin": "Card PIN", "nfc.work.tapScan": "Tap Scan and hold a card to the back.", "nfc.work.scan": "Scan", "nfc.work.holdCard": "Hold the card…",
    "nfc.keys.hint": "Keys (one per line, 12 hex chars)",
    "nfc.tpl.none": "No APDU templates defined (console → Android → Define, apduTemplates).", "nfc.tpl.bad": "The template has no valid APDU.", "nfc.m5.open": "Open M5Cet", "nfc.m5.build": "Build a card", "nfc.m5.none": "No M5Cet card on the tag.",
    "nfc.m5.records": "Records", "nfc.m5.emulate": "Be an M5Cet card", "nfc.m5.buildFirst": "Build a card first.",
    "nfc.done.locked": "Locked read-only", "nfc.done.written": "Written", "nfc.done.writtenBytes": "Written {0} B", "nfc.done.uid": "UID changed",
    "nfc.err.readOnly": "The tag is read-only.", "nfc.err.tooSmall": "Too small: needs {0} B, the card holds {1} B.",
    "nfc.err.noKey": "No key for sector {0} — add its key.", "nfc.err.notWritable": "This tag can't be written.",
    "nfc.restore.none": "Take a dump first.", "nfc.op.unsupported": "This reader can't do that operation.",
    "nfc.uid.need": "Enter block 0 (16 bytes, hex).", "nfc.uid.prompt": "Block 0 (16 bytes, hex) — magic card only",
    "nfc.conn.none": "No connection card on the tag.", "nfc.wifi.pw": "Password", "nfc.wifi.settings": "Wi-Fi settings", "nfc.login.copyPw": "Copy password",
    "nfc.apdu.prompt": "APDU (hex)", "nfc.ndef.prompt": "Text for NDEF", "nfc.hex.bad": "Invalid hex.",
    "nfc.block.no": "Block number", "nfc.block.data": "Data", "nfc.write.title": "Write block",
    "nfc.onetime.rewrite": "Hold the card again — erasing the one-time record.", "nfc.onetime.erased": "Record erased",
    // 6.5 — EMV card data + e-ID / e-passport (BAC, read-only)
    "nfc.readonly.help": "Read-only, on device. No PIN, no signing, no transaction.",
    "nfc.emv.expiry": "Expiry", "nfc.emv.cardholder": "Cardholder", "nfc.emv.effective": "Effective", "nfc.emv.issuer": "Issuer country", "nfc.emv.ptc": "PIN tries left", "nfc.emv.tags": "Data elements",
    "nfc.eid.title": "Read document", "nfc.eid.docNumber": "Document number", "nfc.eid.dob": "Date of birth (YYMMDD)", "nfc.eid.expiry": "Expiry (YYMMDD)",
    "nfc.eid.can": "CAN (6 digits on the document, for PACE)", "nfc.eid.mrz": "or paste the MRZ (2–3 lines)", "nfc.eid.photo": "Read the photo", "nfc.eid.read": "Read",
    "nfc.eid.needKey": "Enter the document number, date of birth and expiry, paste the MRZ, or enter the CAN.",
    "nfc.eid.nationality": "Nationality", "nfc.eid.issuer": "Issuing state", "nfc.eid.dobLabel": "Born", "nfc.eid.sex": "Sex", "nfc.eid.expiryLabel": "Expires",
    "nfc.eid.dataGroups": "Data groups", "nfc.eid.photoFormat": "Photo: {0} (can't display)",
    // 6.6 — the deep read: EMV history, counters, every file; e-ID every data group, pictures, security
    "nfc.emv.panSeq": "PAN sequence", "nfc.emv.atc": "Transactions (ATC)", "nfc.emv.lastOnlineAtc": "Last online ATC",
    "nfc.emv.history": "Transaction history", "nfc.emv.noHistory": "The card keeps no transaction log (or it is not readable).",
    "nfc.emv.date": "Date", "nfc.emv.time": "Time", "nfc.emv.amount": "Amount", "nfc.emv.merchant": "Merchant", "nfc.emv.type": "Type",
    "nfc.emv.getData": "Counters (GET DATA)", "nfc.emv.records": "Records", "nfc.emv.log": "log",
    "nfc.emv.readDeep": "Read: every file · {0} APDUs", "nfc.emv.readAfl": "Read: AFL records · {0} APDUs",
    "nfc.eid.all": "Read every data group", "nfc.eid.docCode": "Document", "nfc.eid.access": "Opened with",
    "nfc.eid.paceOffered": "PACE offered", "nfc.eid.notUsed": "not used",
    "nfc.eid.personal": "Personal details (DG11)", "nfc.eid.fullName": "Full name", "nfc.eid.otherNames": "Other names", "nfc.eid.personalNumber": "Personal number",
    "nfc.eid.fullDob": "Full date of birth", "nfc.eid.placeOfBirth": "Place of birth", "nfc.eid.address": "Address", "nfc.eid.telephone": "Telephone",
    "nfc.eid.profession": "Profession", "nfc.eid.titleField": "Title", "nfc.eid.summary": "Personal summary", "nfc.eid.otherDocs": "Other travel documents", "nfc.eid.custody": "Custody",
    "nfc.eid.document": "Document details (DG12)", "nfc.eid.issuingAuthority": "Issuing authority", "nfc.eid.dateOfIssue": "Date of issue", "nfc.eid.otherPersons": "Other persons",
    "nfc.eid.endorsements": "Endorsements", "nfc.eid.taxExit": "Tax / exit", "nfc.eid.personalized": "Personalized", "nfc.eid.personalizationDevice": "Personalization system",
    "nfc.eid.optional": "Optional details (DG13)", "nfc.eid.notify": "Persons to notify (DG16)",
    "nfc.eid.images": "Pictures", "nfc.eid.img.face": "Face", "nfc.eid.img.portrait": "Portrait", "nfc.eid.img.signature": "Signature", "nfc.eid.img.document": "Document", "nfc.eid.img.other": "Picture",
    "nfc.eid.cantShow": "{0} — this device can't display it",
    "nfc.eid.security": "Security", "nfc.eid.passive": "Passive authentication", "nfc.eid.passiveOk": "every group read matches EF.SOD",
    "nfc.eid.passiveBad": "a group does NOT match EF.SOD", "nfc.eid.passiveNone": "not checked", "nfc.eid.hash": "Hash",
    "nfc.eid.signer": "Document signer", "nfc.eid.signedBy": "Signed by", "nfc.eid.validity": "Valid", "nfc.eid.serial": "Serial number",
    "nfc.eid.protocols": "Protocols", "nfc.eid.aaKey": "Active Authentication key", "nfc.eid.lds": "LDS version", "nfc.eid.unicode": "Unicode version",
    "nfc.eid.files": "Files", "nfc.eid.st.read": "read", "nfc.eid.st.protected": "protected (EAC)", "nfc.eid.st.absent": "absent", "nfc.eid.st.error": "error",
    // 6.6 — a Functions model asks this phone for a card (m5.nfc, /emv, /eid)
    "nfc.model.what.scan": "Scan a card", "nfc.model.what.uid": "Read a card's ID (UID)", "nfc.model.what.ndef": "Read the records on a tag (NDEF)",
    "nfc.model.what.m5": "List an M5Cet card's records", "nfc.model.what.emv": "Read a payment card", "nfc.model.what.emvPublic": "Read a payment card's public data",
    "nfc.model.what.eid": "Read your ID card / passport", "nfc.model.what.eidPublic": "Check an ID card / passport", "nfc.model.by": "Asked by {0}",
    "nfc.model.hold": "Hold the card to the back of your phone", "nfc.model.holdUsb": "Put the card on the reader — {0}", "nfc.model.waiting": "Waiting for a card · {0} s",
    "nfc.model.reading": "Reading — keep the card still…", "nfc.model.done": "Done", "nfc.model.timeout": "No card within {0} s.",
    "nfc.model.lost": "The card moved away — keep it there until the read is done.", "nfc.model.authFailed": "The document did not open — check the CAN or the MRZ.",
    "nfc.model.notThisCard": "This card can't do that.", "nfc.model.error": "The card could not be read.", "nfc.model.cancel": "Cancel",
    "nfc.model.settings": "NFC settings", "nfc.model.offHelp": "Turn NFC on in the settings, then run the command again.",
    "nfc.model.denied": "A model asked to write to a card — refused. Writing runs only in the NFC workbench.",
    "nfc.model.unsupported": "A model asked for an NFC operation this phone doesn't run for a model.",
    "nfc.model.key.title": "Open the document", "nfc.model.key.or": "or", "nfc.model.key.can": "CAN (6 digits)",
    "nfc.model.key.help": "The chip opens with the CAN printed on the card (EU ID cards) or with the MRZ. What you type stays on this phone and is used for this read only.",
    "nfc.model.key.mrz": "MRZ (the 2–3 lines at the bottom of the document)", "nfc.model.key.badCan": "The CAN has 6 digits.",
    "nfc.model.key.badMrz": "That MRZ is not complete — paste all of its lines.", "nfc.model.key.badDate": "Dates are YYMMDD (6 digits).",
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
    "nfc.work.pin": "Karten-PIN", "nfc.work.tapScan": "Auf Scan tippen und eine Karte an die Rückseite halten.", "nfc.work.scan": "Scan", "nfc.work.holdCard": "Karte anhalten…",
    "nfc.keys.hint": "Schlüssel (einer pro Zeile, 12 Hex-Zeichen)",
    "nfc.tpl.none": "Keine APDU-Vorlagen definiert (Konsole → Android → Define, apduTemplates).", "nfc.tpl.bad": "Die Vorlage hat kein gültiges APDU.", "nfc.m5.open": "M5Cet öffnen", "nfc.m5.build": "Karte erstellen", "nfc.m5.none": "Keine M5Cet-Karte auf dem Tag.",
    "nfc.m5.records": "Einträge", "nfc.m5.emulate": "Als M5Cet-Karte antworten", "nfc.m5.buildFirst": "Erst eine Karte erstellen.",
    "nfc.done.locked": "Schreibgeschützt gesperrt", "nfc.done.written": "Geschrieben", "nfc.done.writtenBytes": "Geschrieben {0} B", "nfc.done.uid": "UID geändert",
    "nfc.err.readOnly": "Der Tag ist schreibgeschützt.", "nfc.err.tooSmall": "Zu klein: benötigt {0} B, die Karte hat {1} B.",
    "nfc.err.noKey": "Kein Schlüssel für Sektor {0} — füge seinen Schlüssel hinzu.", "nfc.err.notWritable": "Dieser Tag kann nicht beschrieben werden.",
    "nfc.restore.none": "Zuerst einen Dump erstellen.", "nfc.op.unsupported": "Dieses Lesegerät kann das nicht.",
    "nfc.uid.need": "Block 0 eingeben (16 Bytes, Hex).", "nfc.uid.prompt": "Block 0 (16 Bytes, Hex) — nur Magic-Karte",
    "nfc.conn.none": "Keine Verbindungskarte auf dem Tag.", "nfc.wifi.pw": "Passwort", "nfc.wifi.settings": "WLAN-Einstellungen", "nfc.login.copyPw": "Passwort kopieren",
    "nfc.apdu.prompt": "APDU (Hex)", "nfc.ndef.prompt": "Text für NDEF", "nfc.hex.bad": "Ungültiges Hex.",
    "nfc.block.no": "Blocknummer", "nfc.block.data": "Daten", "nfc.write.title": "Block schreiben",
    "nfc.onetime.rewrite": "Karte erneut anhalten — der Einmal-Eintrag wird gelöscht.", "nfc.onetime.erased": "Eintrag gelöscht",
    // 6.5 — EMV-Kartendaten + e-ID / e-Pass (BAC, nur Lesen)
    "nfc.readonly.help": "Nur Lesen, auf dem Gerät. Keine PIN, keine Signatur, keine Transaktion.",
    "nfc.emv.expiry": "Gültig bis", "nfc.emv.cardholder": "Karteninhaber", "nfc.emv.effective": "Gültig ab", "nfc.emv.issuer": "Ausstellerland", "nfc.emv.ptc": "Verbleibende PIN-Versuche", "nfc.emv.tags": "Datenelemente",
    "nfc.eid.title": "Dokument lesen", "nfc.eid.docNumber": "Dokumentennummer", "nfc.eid.dob": "Geburtsdatum (JJMMTT)", "nfc.eid.expiry": "Gültig bis (JJMMTT)",
    "nfc.eid.can": "CAN (6 Ziffern auf dem Dokument, für PACE)", "nfc.eid.mrz": "oder MRZ einfügen (2–3 Zeilen)", "nfc.eid.photo": "Foto lesen", "nfc.eid.read": "Lesen",
    "nfc.eid.needKey": "Dokumentennummer, Geburtsdatum und Ablauf eingeben, die MRZ einfügen oder die CAN eingeben.",
    "nfc.eid.nationality": "Staatsangehörigkeit", "nfc.eid.issuer": "Ausstellerstaat", "nfc.eid.dobLabel": "Geboren", "nfc.eid.sex": "Geschlecht", "nfc.eid.expiryLabel": "Gültig bis",
    "nfc.eid.dataGroups": "Datengruppen", "nfc.eid.photoFormat": "Foto: {0} (nicht anzeigbar)",
    // 6.6 — das tiefe Lesen: EMV-Verlauf, Zähler, alle Dateien; e-ID alle Datengruppen, Bilder, Sicherheit
    "nfc.emv.panSeq": "PAN-Folgenummer", "nfc.emv.atc": "Transaktionen (ATC)", "nfc.emv.lastOnlineAtc": "Letzter Online-ATC",
    "nfc.emv.history": "Transaktionsverlauf", "nfc.emv.noHistory": "Die Karte führt kein Transaktionsprotokoll (oder es ist nicht lesbar).",
    "nfc.emv.date": "Datum", "nfc.emv.time": "Uhrzeit", "nfc.emv.amount": "Betrag", "nfc.emv.merchant": "Händler", "nfc.emv.type": "Art",
    "nfc.emv.getData": "Zähler (GET DATA)", "nfc.emv.records": "Datensätze", "nfc.emv.log": "Protokoll",
    "nfc.emv.readDeep": "Gelesen: alle Dateien · {0} APDUs", "nfc.emv.readAfl": "Gelesen: AFL-Datensätze · {0} APDUs",
    "nfc.eid.all": "Alle Datengruppen lesen", "nfc.eid.docCode": "Dokument", "nfc.eid.access": "Geöffnet mit",
    "nfc.eid.paceOffered": "PACE angeboten", "nfc.eid.notUsed": "nicht verwendet",
    "nfc.eid.personal": "Persönliche Angaben (DG11)", "nfc.eid.fullName": "Vollständiger Name", "nfc.eid.otherNames": "Weitere Namen", "nfc.eid.personalNumber": "Persönliche Nummer",
    "nfc.eid.fullDob": "Vollständiges Geburtsdatum", "nfc.eid.placeOfBirth": "Geburtsort", "nfc.eid.address": "Anschrift", "nfc.eid.telephone": "Telefon",
    "nfc.eid.profession": "Beruf", "nfc.eid.titleField": "Titel", "nfc.eid.summary": "Zusammenfassung", "nfc.eid.otherDocs": "Weitere Reisedokumente", "nfc.eid.custody": "Sorgerecht",
    "nfc.eid.document": "Dokumentangaben (DG12)", "nfc.eid.issuingAuthority": "Ausstellende Behörde", "nfc.eid.dateOfIssue": "Ausstellungsdatum", "nfc.eid.otherPersons": "Weitere Personen",
    "nfc.eid.endorsements": "Vermerke", "nfc.eid.taxExit": "Steuer / Ausreise", "nfc.eid.personalized": "Personalisiert", "nfc.eid.personalizationDevice": "Personalisierungssystem",
    "nfc.eid.optional": "Optionale Angaben (DG13)", "nfc.eid.notify": "Zu benachrichtigende Personen (DG16)",
    "nfc.eid.images": "Bilder", "nfc.eid.img.face": "Gesicht", "nfc.eid.img.portrait": "Porträt", "nfc.eid.img.signature": "Unterschrift", "nfc.eid.img.document": "Dokument", "nfc.eid.img.other": "Bild",
    "nfc.eid.cantShow": "{0} — auf diesem Gerät nicht anzeigbar",
    "nfc.eid.security": "Sicherheit", "nfc.eid.passive": "Passive Authentisierung", "nfc.eid.passiveOk": "alle gelesenen Gruppen stimmen mit EF.SOD überein",
    "nfc.eid.passiveBad": "eine Gruppe stimmt NICHT mit EF.SOD überein", "nfc.eid.passiveNone": "nicht geprüft", "nfc.eid.hash": "Hash",
    "nfc.eid.signer": "Dokumentsignierer (DS)", "nfc.eid.signedBy": "Signiert von (CSCA)", "nfc.eid.validity": "Gültig", "nfc.eid.serial": "Seriennummer",
    "nfc.eid.protocols": "Protokolle", "nfc.eid.aaKey": "Schlüssel der aktiven Authentisierung", "nfc.eid.lds": "LDS-Version", "nfc.eid.unicode": "Unicode-Version",
    "nfc.eid.files": "Dateien", "nfc.eid.st.read": "gelesen", "nfc.eid.st.protected": "geschützt (EAC)", "nfc.eid.st.absent": "fehlt", "nfc.eid.st.error": "Fehler",
    // 6.6 — ein Functions-Modell bittet dieses Telefon um eine Karte (m5.nfc, /emv, /eid)
    "nfc.model.what.scan": "Karte lesen", "nfc.model.what.uid": "Karten-ID (UID) lesen", "nfc.model.what.ndef": "Einträge auf dem Tag lesen (NDEF)",
    "nfc.model.what.m5": "Einträge der M5Cet-Karte anzeigen", "nfc.model.what.emv": "Zahlungskarte lesen", "nfc.model.what.emvPublic": "Öffentliche Daten der Zahlungskarte lesen",
    "nfc.model.what.eid": "Ausweis / Reisepass lesen", "nfc.model.what.eidPublic": "Ausweis / Reisepass prüfen", "nfc.model.by": "Angefragt von {0}",
    "nfc.model.hold": "Karte an die Rückseite des Telefons halten", "nfc.model.holdUsb": "Karte auf das Lesegerät legen — {0}", "nfc.model.waiting": "Warte auf eine Karte · {0} s",
    "nfc.model.reading": "Lese — Karte ruhig halten…", "nfc.model.done": "Fertig", "nfc.model.timeout": "Innerhalb von {0} s wurde keine Karte angehalten.",
    "nfc.model.lost": "Die Karte hat sich entfernt — halte sie an, bis das Lesen fertig ist.", "nfc.model.authFailed": "Das Dokument ließ sich nicht öffnen — CAN oder MRZ prüfen.",
    "nfc.model.notThisCard": "Diese Karte kann das nicht.", "nfc.model.error": "Die Karte konnte nicht gelesen werden.", "nfc.model.cancel": "Abbrechen",
    "nfc.model.settings": "NFC-Einstellungen", "nfc.model.offHelp": "NFC in den Einstellungen einschalten und den Befehl erneut ausführen.",
    "nfc.model.denied": "Ein Modell wollte eine Karte beschreiben — abgelehnt. Schreiben geht nur im NFC-Werkzeug.",
    "nfc.model.unsupported": "Ein Modell bat um eine NFC-Operation, die dieses Telefon für ein Modell nicht ausführt.",
    "nfc.model.key.title": "Dokument öffnen", "nfc.model.key.or": "oder", "nfc.model.key.can": "CAN (6 Ziffern)",
    "nfc.model.key.help": "Der Chip öffnet sich mit der auf dem Ausweis aufgedruckten CAN (EU-Personalausweise) oder mit der MRZ. Was du eingibst, bleibt auf diesem Telefon und dient nur diesem Lesevorgang.",
    "nfc.model.key.mrz": "MRZ (die 2–3 Zeilen unten auf dem Dokument)", "nfc.model.key.badCan": "Die CAN hat 6 Ziffern.",
    "nfc.model.key.badMrz": "Die MRZ ist unvollständig — alle Zeilen einfügen.", "nfc.model.key.badDate": "Daten im Format JJMMTT (6 Ziffern).",
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
