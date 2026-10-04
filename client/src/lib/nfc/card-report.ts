// Card reports (6.6) — what an NFC read gives, in the format the caller wants.
// One PURE module (no DOM, no Node): the Functions sandbox formats a model's
// read with it (m5.nfc.report / m5.nfc.emv.format / m5.nfc.eid.format, the
// Builder's NFC.EMV and NFC.e-ID nodes), and the NFC workbench exports with it.
//
//   html     every field, formatted for the chat: sections, tables, the
//            history, the pictures inline (data: URIs); a fragment styled by
//            the app's m5h-* classes (the chat sanitizes it again)
//   object   one normalized object (pictures and files as base64)
//   array    the same as rows: { section, field, value }
//   json     the object as JSON text
//   text     a plain-text report
//   csv      the rows as CSV (section, field, value)
//
// Pictures the browser can show (JPEG, PNG…) are `images`; everything else —
// the document's security objects, raw groups, JPEG 2000 pictures, the EMV
// records, the history as CSV — is `files`, for download. Card text is never
// trusted: every value is escaped.

import type { CardFile, EmvApp, EmvData, EmvLogEntry, MrtdData, MrtdImage, NfcResult } from "./command";

export const CARD_REPORT_FORMATS = ["html", "object", "array", "json", "text", "csv"] as const;
export type CardReportFormat = (typeof CARD_REPORT_FORMATS)[number];
export type CardReportLang = "en" | "cs" | "de";

export type CardReportOptions = {
  /** Show the whole card number (the holder's own card); masked by default. */
  fullPan?: boolean;
  /** Label language. */
  lang?: CardReportLang | string;
  /** A title instead of the card's own. */
  title?: string;
  /** Offer the raw data as files (default true). */
  attachments?: boolean;
  /** Put the pictures in (default true). */
  images?: boolean;
};

export type CardRow = { section: string; field: string; value: string };

export type CardReport = {
  kind: "emv" | "mrtd" | "card";
  format: CardReportFormat;
  /** The formatted value: text (html, json, text, csv), the object, or the rows. */
  value: unknown;
  mime: string;
  title: string;
  summary: string;
  /** Pictures to show (JPEG, PNG, GIF, WebP). */
  images: CardFile[];
  /** Everything else, to download. */
  files: CardFile[];
};

/* ================================================================ labels */

const EN = {
  card: "Card", uid: "UID", technology: "Technology", atqa: "ATQA", sak: "SAK", ats: "ATS", atr: "ATR", memory: "Memory", status: "Status", message: "Message",
  application: "Application", aid: "AID", label: "Label", scheme: "Scheme", pan: "Card number", expiry: "Expires", effective: "Valid from", cardholder: "Cardholder",
  issuerCountry: "Issuer country", panSequence: "PAN sequence", atc: "Transactions (ATC)", lastOnlineAtc: "Last online ATC", pinTryCounter: "PIN tries left",
  aip: "AIP", afl: "AFL", logSfi: "Log file (SFI)", logFormat: "Log format", aids: "Applications on the card", read: "Read", deep: "every file", aflOnly: "AFL records", apdus: "APDUs",
  history: "Transaction history", noHistory: "The card keeps no transaction log (or it is not readable).", date: "Date", time: "Time", amount: "Amount", currency: "Currency",
  country: "Country", type: "Type", merchant: "Merchant", cid: "Result", dataElements: "Data elements", getData: "GET DATA", records: "Records", tag: "Tag", name: "Name", value: "Value",
  holder: "Holder", documentType: "Document", documentNumber: "Document number", issuer: "Issuing state", nationality: "Nationality", surname: "Surname", givenNames: "Given names",
  dateOfBirth: "Date of birth", sex: "Sex", dateOfExpiry: "Expires", optionalData: "Optional data", mrz: "MRZ", access: "Opened with", pace: "PACE",
  personal: "Personal details", fullName: "Full name", otherNames: "Other names", personalNumber: "Personal number", fullDateOfBirth: "Full date of birth", placeOfBirth: "Place of birth",
  address: "Address", telephone: "Telephone", profession: "Profession", title: "Title", personalSummary: "Personal summary", otherTravelDocuments: "Other travel documents", custody: "Custody",
  document: "Document details", issuingAuthority: "Issuing authority", dateOfIssue: "Date of issue", otherPersons: "Other persons", endorsements: "Endorsements", taxExit: "Tax / exit",
  personalizationTime: "Personalized", personalizationDevice: "Personalization system", optional: "Optional details (DG13)", personsToNotify: "Persons to notify",
  security: "Security", passive: "Passive authentication", passiveOk: "every group read matches EF.SOD", passiveBad: "a group does NOT match EF.SOD", passiveNone: "not checked",
  hashAlgorithm: "Hash", signer: "Document signer", signerIssuer: "Signed by", validity: "Valid", protocols: "Protocols", activeAuthKey: "Active Authentication key", lds: "LDS version", unicode: "Unicode version",
  files: "Files", file: "File", size: "Size", hashOk: "Hash", protected: "protected (EAC)", absent: "absent", error: "error", readOk: "read",
  images: "Pictures", face: "Face", portrait: "Portrait", signature: "Signature", documentImage: "Document", otherImage: "Picture", jp2: "JPEG 2000 — attached for download",
  attachments: "Attachments", ndef: "NDEF records", m5records: "M5Cet records", data: "Data", yes: "yes", no: "no", none: "—",
  passport: "Passport", idCard: "ID card", travelDocument: "Travel document",
} as const;
type Key = keyof typeof EN;

const CS: Partial<Record<Key, string>> = {
  card: "Karta", technology: "Technologie", memory: "Paměť", status: "Stav", message: "Zpráva", application: "Aplikace", label: "Název", scheme: "Schéma",
  pan: "Číslo karty", expiry: "Platnost do", effective: "Platnost od", cardholder: "Držitel", issuerCountry: "Země vydavatele", panSequence: "Pořadí PAN",
  atc: "Počet transakcí (ATC)", lastOnlineAtc: "Poslední online ATC", pinTryCounter: "Zbývající pokusy PIN", logSfi: "Soubor logu (SFI)", logFormat: "Formát logu",
  aids: "Aplikace na kartě", read: "Čtení", deep: "všechny soubory", aflOnly: "záznamy AFL", history: "Historie transakcí", noHistory: "Karta nevede log transakcí (nebo není čitelný).",
  date: "Datum", time: "Čas", amount: "Částka", currency: "Měna", country: "Země", type: "Typ", merchant: "Obchodník", cid: "Výsledek", dataElements: "Datové prvky", records: "Záznamy",
  tag: "Tag", name: "Název", value: "Hodnota", holder: "Držitel", documentType: "Doklad", documentNumber: "Číslo dokladu", issuer: "Vydávající stát", nationality: "Státní občanství",
  surname: "Příjmení", givenNames: "Jména", dateOfBirth: "Datum narození", sex: "Pohlaví", dateOfExpiry: "Platnost do", optionalData: "Volitelné údaje", access: "Otevřeno pomocí",
  personal: "Osobní údaje", fullName: "Celé jméno", otherNames: "Další jména", personalNumber: "Osobní číslo", fullDateOfBirth: "Úplné datum narození", placeOfBirth: "Místo narození",
  address: "Adresa", telephone: "Telefon", profession: "Povolání", title: "Titul", personalSummary: "Shrnutí", otherTravelDocuments: "Další cestovní doklady", custody: "Péče",
  document: "Údaje o dokladu", issuingAuthority: "Vydal", dateOfIssue: "Datum vydání", otherPersons: "Další osoby", endorsements: "Poznámky", taxExit: "Daň / výjezd",
  personalizationTime: "Personalizováno", personalizationDevice: "Personalizační systém", optional: "Volitelné údaje (DG13)", personsToNotify: "Osoby k vyrozumění",
  security: "Zabezpečení", passive: "Pasivní autentizace", passiveOk: "všechny přečtené skupiny odpovídají EF.SOD", passiveBad: "některá skupina NEODPOVÍDÁ EF.SOD", passiveNone: "neověřeno",
  signer: "Podepsal (DS)", signerIssuer: "Vydal (CSCA)", validity: "Platnost", protocols: "Protokoly", activeAuthKey: "Klíč aktivní autentizace", files: "Soubory", file: "Soubor", size: "Velikost",
  protected: "chráněno (EAC)", absent: "chybí", error: "chyba", readOk: "přečteno", images: "Obrázky", face: "Obličej", portrait: "Portrét", signature: "Podpis", documentImage: "Doklad",
  otherImage: "Obrázek", jp2: "JPEG 2000 — v příloze ke stažení", attachments: "Přílohy", ndef: "Záznamy NDEF", m5records: "Záznamy M5Cet", data: "Data", yes: "ano", no: "ne",
  passport: "Cestovní pas", idCard: "Občanský průkaz", travelDocument: "Cestovní doklad",
};
const DE: Partial<Record<Key, string>> = {
  card: "Karte", technology: "Technologie", memory: "Speicher", status: "Status", message: "Meldung", application: "Anwendung", label: "Name", scheme: "Netz",
  pan: "Kartennummer", expiry: "Gültig bis", effective: "Gültig ab", cardholder: "Karteninhaber", issuerCountry: "Ausgabeland", atc: "Transaktionen (ATC)",
  pinTryCounter: "Verbleibende PIN-Versuche", aids: "Anwendungen auf der Karte", read: "Gelesen", deep: "alle Dateien", history: "Transaktionsverlauf",
  noHistory: "Die Karte führt kein Transaktionsprotokoll (oder es ist nicht lesbar).", date: "Datum", time: "Uhrzeit", amount: "Betrag", currency: "Währung", country: "Land",
  type: "Art", merchant: "Händler", cid: "Ergebnis", dataElements: "Datenelemente", records: "Datensätze", name: "Name", value: "Wert", holder: "Inhaber", documentType: "Dokument",
  documentNumber: "Dokumentnummer", issuer: "Ausstellerstaat", nationality: "Staatsangehörigkeit", surname: "Nachname", givenNames: "Vornamen", dateOfBirth: "Geburtsdatum",
  sex: "Geschlecht", dateOfExpiry: "Gültig bis", access: "Geöffnet mit", personal: "Persönliche Angaben", fullName: "Vollständiger Name", placeOfBirth: "Geburtsort", address: "Anschrift",
  document: "Dokumentangaben", issuingAuthority: "Ausstellende Behörde", dateOfIssue: "Ausstellungsdatum", security: "Sicherheit", passive: "Passive Authentisierung",
  passiveOk: "alle gelesenen Gruppen stimmen mit EF.SOD überein", passiveBad: "eine Gruppe stimmt NICHT mit EF.SOD überein", passiveNone: "nicht geprüft", files: "Dateien", file: "Datei",
  size: "Größe", protected: "geschützt (EAC)", absent: "fehlt", error: "Fehler", readOk: "gelesen", images: "Bilder", face: "Gesicht", signature: "Unterschrift", attachments: "Anhänge",
  yes: "ja", no: "nein", passport: "Reisepass", idCard: "Personalausweis", travelDocument: "Reisedokument",
};
const LANGS: Record<CardReportLang, Partial<Record<Key, string>>> = { en: EN, cs: CS, de: DE };

/* ================================================================ helpers */

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const SHOWABLE = /^image\/(jpeg|png|gif|webp)$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function b64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64Size = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
function sizeText(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function maskPan(pan: string): string {
  return pan.length >= 10 ? `${pan.slice(0, 6)}${"•".repeat(pan.length - 10)}${pan.slice(-4)}` : pan;
}
/** The PAN's digits hidden inside hex / text (records, Track 2). */
function maskIn(s: string, pans: string[]): string {
  let out = s;
  for (const p of pans) if (p.length >= 10) out = out.split(p).join(`${p.slice(0, 6)}${"X".repeat(p.length - 10)}${p.slice(-4)}`);
  return out;
}

/** What the input is: an NfcResult, a bare EmvData / MrtdData. */
function classify(input: unknown): { kind: CardReport["kind"]; result: NfcResult; emv?: EmvData; mrtd?: MrtdData } {
  const r = (isObj(input) ? input : {}) as Record<string, unknown>;
  if (isObj(r.emv)) return { kind: "emv", result: r as NfcResult, emv: r.emv as EmvData };
  if (isObj(r.mrtd)) return { kind: "mrtd", result: r as NfcResult, mrtd: r.mrtd as MrtdData };
  if (Array.isArray(r.apps) && Array.isArray(r.aids)) return { kind: "emv", result: { status: "ok", emv: r as EmvData }, emv: r as EmvData };
  if ("access" in r && "present" in r) return { kind: "mrtd", result: { status: "ok", mrtd: r as MrtdData }, mrtd: r as MrtdData };
  return { kind: "card", result: r as NfcResult };
}

const docKind = (code?: string): Key => (!code ? "travelDocument" : code.startsWith("P") ? "passport" : code.startsWith("I") || code.startsWith("A") || code.startsWith("C") ? "idCard" : "travelDocument");
const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length))) as T;

/* ================================================================ the object */

type Section = { id: string; title: string; rows: Array<[string, string]>; mono?: boolean; table?: { columns: string[]; rows: string[][] }; pre?: string; collapsed?: boolean; note?: string };

/** The normalized report: sections for every view, the object, the pictures and the files. */
type Built = { kind: CardReport["kind"]; title: string; subtitle: string; summary: string; sections: Section[]; object: Record<string, unknown>; images: Array<CardFile & { caption: string }>; files: CardFile[]; jp2: string[] };

function cardSection(L: (k: Key) => string, r: NfcResult): Section | null {
  const c = r.card;
  if (!c) return null;
  const rows: Array<[string, string]> = [[L("uid"), c.uid], [L("technology"), c.label || c.tech]];
  for (const k of ["atqa", "sak", "ats", "atr", "memory"] as const) if (c[k]) rows.push([L(k), String(c[k])]);
  return { id: "card", title: L("card"), rows: rows.filter(([, v]) => v) };
}

function buildEmv(L: (k: Key) => string, r: NfcResult, d: EmvData, o: CardReportOptions): Built {
  const pans = d.apps.map((a) => a.pan).filter((p): p is string => Boolean(p));
  const pan = (a: EmvApp) => (a.pan ? (o.fullPan ? a.pan : a.panMasked || maskPan(a.pan)) : undefined);
  const mask = (s: string) => (o.fullPan ? s : maskIn(s, pans));
  const first = d.apps[0];
  const title = o.title || [first?.scheme || first?.label || d.scheme || "EMV", first ? pan(first) : ""].filter(Boolean).join(" · ");
  const historyCount = d.apps.reduce((n, a) => n + (a.log?.length ?? 0), 0);
  const subtitle = [first?.label && first.label !== first.scheme ? first.label : "", first?.expiry ? `${L("expiry")} ${first.expiry}` : "", historyCount ? `${L("history")}: ${historyCount}` : ""].filter(Boolean).join(" · ");
  const sections: Section[] = [];
  const cs = cardSection(L, r);
  if (cs) sections.push(cs);
  sections.push({ id: "aids", title: L("aids"), rows: [[L("aids"), d.aids.join(", ") || L("none")], [L("read"), `${d.deep === false ? L("aflOnly") : L("deep")}${d.apdus ? ` · ${d.apdus} ${L("apdus")}` : ""}`]] });

  const files: CardFile[] = [];
  const histCsv: string[][] = [];
  const apps = d.apps.map((a, i) => {
    const name = a.label || a.scheme || a.aid;
    const n = d.apps.length > 1 ? ` ${i + 1} — ${name}` : ` — ${name}`;
    const rows: Array<[string, string]> = [];
    const add = (k: Key, v: unknown) => { if (v !== undefined && v !== null && v !== "") rows.push([L(k), String(v)]); };
    add("aid", a.aid); add("label", a.label); add("scheme", a.scheme); add("pan", pan(a)); add("expiry", a.expiry); add("effective", a.effective);
    add("cardholder", a.cardholder); add("issuerCountry", a.issuerCountry); add("panSequence", a.panSequence); add("atc", a.atc); add("lastOnlineAtc", a.lastOnlineAtc);
    add("pinTryCounter", a.pinTryCounter); add("aip", a.aip); add("afl", a.afl); add("logSfi", a.logSfi); add("logFormat", a.logFormat);
    sections.push({ id: `app${i}`, title: `${L("application")}${n}`, rows });
    // The history.
    const log = a.log ?? [];
    const cols: Array<[keyof EmvLogEntry & string, Key]> = [["date", "date"], ["time", "time"], ["amount", "amount"], ["currency", "currency"], ["merchant", "merchant"], ["type", "type"], ["country", "country"], ["atc", "atc"], ["cid", "cid"]];
    const used = cols.filter(([k]) => log.some((e) => e[k]));
    const extra = [...new Set(log.flatMap((e) => Object.keys(e).filter((k) => k !== "raw" && !cols.some(([c]) => c === k))))];
    if (a.logSfi !== undefined || log.length) {
      sections.push({
        id: `history${i}`, title: `${L("history")}${n} (${log.length})`, rows: [],
        ...(log.length ? { table: { columns: [...used.map(([, k]) => L(k)), ...extra], rows: log.map((e) => [...used.map(([k]) => e[k] ?? ""), ...extra.map((k) => e[k] ?? "")]) } } : { note: L("noHistory") }),
      });
      for (const e of log) histCsv.push([name, e.date ?? "", e.time ?? "", e.amount ?? "", e.currency ?? "", e.merchant ?? "", e.type ?? "", e.country ?? "", e.atc ?? "", e.cid ?? "", e.raw ?? ""]);
    }
    const tagRows: Array<[string, string]> = a.tags.map((t) => [`${t.tag} ${t.name}`, mask(t.value === t.hex ? t.hex : `${t.value}${t.value !== t.hex ? `  (${t.hex})` : ""}`)]);
    sections.push({ id: `tags${i}`, title: `${L("dataElements")}${n} (${a.tags.length})`, rows: tagRows, mono: true, collapsed: true });
    if (a.getData?.length) sections.push({ id: `gd${i}`, title: `${L("getData")}${n}`, rows: a.getData.map((t) => [`${t.tag} ${t.name}`, mask(t.value)]), mono: true, collapsed: true });
    if (a.records?.length) sections.push({ id: `rec${i}`, title: `${L("records")}${n} (${a.records.length})`, rows: [], pre: a.records.map((rec) => `SFI ${String(rec.sfi).padStart(2)} · ${String(rec.record).padStart(2)}${rec.log ? " (log)" : ""}  ${mask(rec.hex)}`).join("\n"), collapsed: true });
    return clean({
      aid: a.aid, label: a.label, scheme: a.scheme, pan: pan(a), expiry: a.expiry, effective: a.effective, cardholder: a.cardholder, issuerCountry: a.issuerCountry,
      panSequence: a.panSequence, atc: a.atc, lastOnlineAtc: a.lastOnlineAtc, pinTryCounter: a.pinTryCounter, aip: a.aip, afl: a.afl, logSfi: a.logSfi, logFormat: a.logFormat,
      history: log, data: a.tags.map((t) => ({ ...t, value: mask(t.value), hex: mask(t.hex) })), getData: a.getData, records: a.records?.map((rec) => ({ ...rec, hex: mask(rec.hex) })),
    });
  });
  if (o.attachments !== false) {
    if (histCsv.length) files.push({ name: "emv-history.csv", mime: "text/csv", data: b64OfText(csv([["application", "date", "time", "amount", "currency", "merchant", "type", "country", "atc", "result", "raw"], ...histCsv])) });
    const recs = d.apps.flatMap((a) => (a.records ?? []).map((rec) => `${a.aid}  SFI ${rec.sfi} record ${rec.record}${rec.log ? " (log)" : ""}\n${mask(rec.hex)}\n`));
    if (recs.length) files.push({ name: "emv-records.txt", mime: "text/plain", data: b64OfText(`${title}\n\n${recs.join("\n")}${d.tree ? `\nPPSE\n${d.tree}\n` : ""}`) });
  }
  const object = clean({ type: "emv", title, summary: "", card: r.card, scheme: d.scheme, aids: d.aids, applications: apps, ppse: d.tree, deep: d.deep, apdus: d.apdus, status: r.status, message: r.message });
  const summary = [title, first?.expiry, historyCount ? `${L("history")}: ${historyCount}` : ""].filter(Boolean).join(" · ");
  object.summary = summary;
  return { kind: "emv", title, subtitle, summary, sections, object, images: [], files, jp2: [] };
}

function buildMrtd(L: (k: Key) => string, r: NfcResult, d: MrtdData, o: CardReportOptions): Built {
  const m = d.mrzInfo ?? {};
  const name = [m.givenNames, m.surname].filter(Boolean).join(" ");
  const kind = L(docKind(m.documentCode));
  const title = o.title || [kind, name].filter(Boolean).join(" · ") || "e-ID";
  const subtitle = [m.documentNumber, m.issuer, m.dateOfExpiry ? `${L("dateOfExpiry")} ${m.dateOfExpiry}` : ""].filter(Boolean).join(" · ");
  const sections: Section[] = [];
  const cs = cardSection(L, r);
  if (cs) sections.push(cs);
  const rows = (pairs: Array<[Key, unknown]>) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)).map(([k, v]) => [L(k), Array.isArray(v) ? v.join("; ") : String(v)] as [string, string]);
  const access = d.access === "pace" ? `PACE${d.pace?.password ? ` (${d.pace.password.toUpperCase()})` : ""}${d.pace?.protocol ? ` · ${d.pace.protocol}` : ""}` : d.access === "bac" ? "BAC (MRZ)" : L("none");
  sections.push({ id: "holder", title: L("holder"), rows: rows([["documentType", m.documentCode ? `${kind} (${m.documentCode})` : undefined], ["documentNumber", m.documentNumber], ["surname", m.surname], ["givenNames", m.givenNames], ["nationality", m.nationality], ["dateOfBirth", m.dateOfBirth], ["sex", m.sex], ["dateOfExpiry", m.dateOfExpiry], ["issuer", m.issuer], ["optionalData", m.optionalData], ["access", access]]) });
  if (m.mrz) sections.push({ id: "mrz", title: L("mrz"), rows: [], pre: m.mrz.includes("\n") ? m.mrz : m.mrz.length === 88 ? `${m.mrz.slice(0, 44)}\n${m.mrz.slice(44)}` : m.mrz.length === 90 ? `${m.mrz.slice(0, 30)}\n${m.mrz.slice(30, 60)}\n${m.mrz.slice(60)}` : m.mrz.length === 72 ? `${m.mrz.slice(0, 36)}\n${m.mrz.slice(36)}` : m.mrz });
  const p = d.personal ?? {};
  const pr = rows([["fullName", p.fullName], ["otherNames", p.otherNames], ["personalNumber", p.personalNumber], ["fullDateOfBirth", p.fullDateOfBirth], ["placeOfBirth", p.placeOfBirth], ["address", p.address], ["telephone", p.telephone], ["profession", p.profession], ["title", p.title], ["personalSummary", p.personalSummary], ["otherTravelDocuments", p.otherTravelDocuments], ["custody", p.custody]]);
  if (pr.length) sections.push({ id: "personal", title: L("personal"), rows: pr });
  const doc = d.document ?? {};
  const dr = rows([["issuingAuthority", doc.issuingAuthority], ["dateOfIssue", doc.dateOfIssue], ["otherPersons", doc.otherPersons], ["endorsements", doc.endorsements], ["taxExit", doc.taxExit], ["personalizationTime", doc.personalizationTime], ["personalizationDevice", doc.personalizationDevice]]);
  if (dr.length) sections.push({ id: "document", title: L("document"), rows: dr });
  if (d.optional) sections.push({ id: "optional", title: L("optional"), rows: [], pre: d.optional });
  if (d.personsToNotify?.length) sections.push({ id: "notify", title: L("personsToNotify"), rows: d.personsToNotify.map((x, i) => [`#${i + 1}`, x]) });
  const s = d.security ?? {};
  const passive = s.passive === "ok" ? `✓ ${L("passiveOk")}` : s.passive === "mismatch" ? `✗ ${L("passiveBad")}` : L("passiveNone");
  sections.push({ id: "security", title: L("security"), rows: rows([["passive", passive], ["hashAlgorithm", s.hashAlgorithm], ["signer", s.signer?.subject], ["signerIssuer", s.signer?.issuer], ["validity", s.signer?.notBefore || s.signer?.notAfter ? `${s.signer?.notBefore ?? "?"} – ${s.signer?.notAfter ?? "?"}` : undefined], ["protocols", s.protocols], ["activeAuthKey", s.activeAuthKey], ["pace", d.pace ? (d.pace.supported ? `${L("yes")}${d.pace.protocol ? ` · ${d.pace.protocol}` : ""}` : L("no")) : undefined], ["lds", d.ldsVersion], ["unicode", d.unicodeVersion]]) });
  if (d.files?.length) {
    const st = (f: NonNullable<MrtdData["files"]>[number]) => (f.status === "read" ? L("readOk") : f.status === "protected" ? L("protected") : f.status === "absent" ? L("absent") : L("error"));
    sections.push({ id: "files", title: L("files"), rows: [], table: { columns: [L("file"), "FID", L("status"), L("size"), L("hashOk")], rows: d.files.map((f) => [f.name, f.fid, `${st(f)}${f.message ? ` — ${f.message}` : ""}`, f.size !== undefined ? sizeText(f.size) : "", f.hashOk === true ? "✓" : f.hashOk === false ? "✗" : ""]) }, collapsed: true });
  }
  if (d.message && d.access === "none") sections.push({ id: "message", title: L("message"), rows: [[L("message"), d.message]] });

  // Pictures: what a browser shows goes in; JPEG 2000 becomes a download.
  const images: Built["images"] = [];
  const files: CardFile[] = [];
  const jp2: string[] = [];
  const kindLabel = (i: MrtdImage) => L(i.kind === "face" ? "face" : i.kind === "portrait" ? "portrait" : i.kind === "signature" ? "signature" : i.kind === "document" ? "documentImage" : "otherImage");
  const all: MrtdImage[] = d.images?.length ? d.images : d.photo && d.photoMime ? [{ group: "DG2", kind: "face", mime: d.photoMime, data: d.photo, name: d.photoMime === "image/jp2" ? "face.jp2" : "face.jpg" }] : [];
  if (o.images !== false) {
    for (const img of all) {
      if (!B64.test(img.data)) continue;
      if (SHOWABLE.test(img.mime)) images.push({ name: img.name, mime: img.mime, data: img.data, caption: `${kindLabel(img)} · ${img.group}` });
      else { files.push({ name: img.name, mime: img.mime, data: img.data }); jp2.push(`${kindLabel(img)} · ${img.group} (${img.name})`); }
    }
  }
  if (o.attachments !== false) for (const f of d.raw ?? []) if (B64.test(f.data)) files.push(f);
  if (all.length) sections.push({ id: "images", title: L("images"), rows: all.map((i) => [`${kindLabel(i)} · ${i.group}`, `${i.name} · ${i.mime} · ${sizeText(b64Size(i.data))}`]) });
  const object = clean({
    type: "mrtd", title, summary: "", card: r.card, access: d.access, pace: d.pace, dataGroups: d.dataGroups, holder: clean({ ...m }), personal: d.personal, document: d.document,
    optional: d.optional, personsToNotify: d.personsToNotify, security: clean({ ...s, ldsVersion: d.ldsVersion, unicodeVersion: d.unicodeVersion }), files: d.files,
    images: all.map((i) => ({ ...i, size: b64Size(i.data) })), attachments: d.raw, status: r.status, message: d.message ?? r.message,
  });
  const summary = [title, m.documentNumber, m.nationality, all.length ? `${L("images")}: ${all.length}` : "", d.access !== "none" ? d.access.toUpperCase() : ""].filter(Boolean).join(" · ");
  object.summary = summary;
  return { kind: "mrtd", title, subtitle, summary, sections, object, images, files, jp2 };
}

function buildCard(L: (k: Key) => string, r: NfcResult, o: CardReportOptions): Built {
  const c = r.card;
  const title = o.title || [c?.label || c?.tech || L("card"), c?.uid].filter(Boolean).join(" · ");
  const sections: Section[] = [];
  const cs = cardSection(L, r);
  if (cs) sections.push(cs);
  sections.push({ id: "status", title: L("status"), rows: [[L("status"), r.status], ...(r.message ? [[L("message"), r.message] as [string, string]] : [])] });
  if (r.ndef?.length) sections.push({ id: "ndef", title: L("ndef"), rows: r.ndef.map((n, i) => [`#${i + 1} ${n.kind}${n.type ? ` (${n.type})` : ""}`, n.text ?? n.data ?? ""]) });
  if (r.records?.length) sections.push({ id: "m5", title: L("m5records"), rows: r.records.map((x) => [`#${x.id} ${x.type}`, x.summary]) });
  const files: CardFile[] = [];
  if (r.data) { sections.push({ id: "data", title: L("data"), rows: [[L("size"), sizeText(b64Size(r.data))]] }); if (o.attachments !== false && B64.test(r.data)) files.push({ name: "card-data.bin", mime: "application/octet-stream", data: r.data }); }
  const object = clean({ type: "card", title, summary: title, card: c, status: r.status, ndef: r.ndef, records: r.records, data: r.data, message: r.message });
  return { kind: "card", title, subtitle: r.message ?? "", summary: title, sections, object, images: [], files, jp2: [] };
}

/* ================================================================ the views */

function csv(rows: string[][]): string {
  const cell = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map((v) => cell(String(v ?? ""))).join(",")).join("\r\n") + "\r\n";
}

function rowsOf(b: Built): CardRow[] {
  const out: CardRow[] = [];
  for (const s of b.sections) {
    for (const [field, value] of s.rows) out.push({ section: s.title, field, value });
    if (s.table) s.table.rows.forEach((r, i) => out.push({ section: s.title, field: `#${i + 1}`, value: r.filter(Boolean).join(" · ") }));
    if (s.pre) out.push({ section: s.title, field: "", value: s.pre });
    if (s.note) out.push({ section: s.title, field: "", value: s.note });
  }
  return out;
}

function textOf(b: Built): string {
  const lines: string[] = [b.title, "=".repeat(Math.min(72, Math.max(8, b.title.length)))];
  if (b.subtitle) lines.push(b.subtitle);
  for (const s of b.sections) {
    lines.push("", s.title, "-".repeat(Math.min(72, s.title.length)));
    const w = Math.min(28, Math.max(0, ...s.rows.map(([f]) => f.length)));
    for (const [f, v] of s.rows) lines.push(`${f.padEnd(w)}  ${v.replace(/\n/g, `\n${" ".repeat(w + 2)}`)}`);
    if (s.table) {
      const widths = s.table.columns.map((c, i) => Math.min(30, Math.max(c.length, ...s.table!.rows.map((r) => (r[i] ?? "").length))));
      lines.push(s.table.columns.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
      lines.push(widths.map((w2) => "-".repeat(w2)).join("  "));
      for (const r of s.table.rows) lines.push(r.map((c, i) => (c ?? "").slice(0, 30).padEnd(widths[i])).join("  ").trimEnd());
    }
    if (s.pre) lines.push(s.pre);
    if (s.note) lines.push(s.note);
  }
  return lines.join("\n") + "\n";
}

function htmlOf(b: Built, L: (k: Key) => string, attachments: CardFile[]): string {
  const e = escapeHtml;
  const kv = (rows: Array<[string, string]>, mono?: boolean) => rows.length ? `<table class="m5h-kv${mono ? " m5h-kv--mono" : ""}"><tbody>${rows.map(([f, v]) => `<tr><th>${e(f)}</th><td>${e(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}</tbody></table>` : "";
  const grid = (t: NonNullable<Section["table"]>) => `<div class="m5h-scroll"><table class="m5h-grid"><thead><tr>${t.columns.map((c) => `<th>${e(c)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${e(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const body = (s: Section) => `${s.note ? `<p class="m5h-muted">${e(s.note)}</p>` : ""}${kv(s.rows, s.mono)}${s.table ? grid(s.table) : ""}${s.pre ? `<pre class="m5h-pre">${e(s.pre)}</pre>` : ""}`;
  const badge = (s: Section) => {
    if (s.id !== "security") return "";
    const p = s.rows[0]?.[1] ?? "";
    return p.startsWith("✓") ? ` <span class="m5h-badge m5h-badge--ok">✓</span>` : p.startsWith("✗") ? ` <span class="m5h-badge m5h-badge--err">✗</span>` : "";
  };
  const parts: string[] = [];
  parts.push(`<div class="m5h-report m5h-report--${b.kind}">`);
  parts.push(`<div class="m5h-head"><div class="m5h-title">${e(b.title)}</div>${b.subtitle ? `<div class="m5h-sub">${e(b.subtitle)}</div>` : ""}</div>`);
  const face = b.images.find((i) => /face|portrait/i.test(i.caption) || i.name.startsWith("face") || i.name.startsWith("portrait"));
  for (const s of b.sections) {
    if (s.id === "images") continue;
    if (s.id === "holder" && face) {
      parts.push(`<section class="m5h-sec"><h4>${e(s.title)}</h4><div class="m5h-id"><figure class="m5h-photo"><img src="data:${face.mime};base64,${face.data}" alt="${e(face.caption)}"><figcaption>${e(face.caption)}</figcaption></figure>${kv(s.rows)}</div></section>`);
      continue;
    }
    if (s.collapsed) parts.push(`<details class="m5h-sec"><summary>${e(s.title)}</summary>${body(s)}</details>`);
    else parts.push(`<section class="m5h-sec"><h4>${e(s.title)}${badge(s)}</h4>${body(s)}</section>`);
  }
  const rest = b.images.filter((i) => i !== face);
  if (rest.length || b.jp2.length) {
    parts.push(`<section class="m5h-sec"><h4>${e(L("images"))}</h4><div class="m5h-photos">`);
    for (const i of rest) parts.push(`<figure class="m5h-photo"><img src="data:${i.mime};base64,${i.data}" alt="${e(i.caption)}"><figcaption>${e(i.caption)}</figcaption></figure>`);
    for (const j of b.jp2) parts.push(`<figure class="m5h-photo m5h-photo--file"><div class="m5h-ph">JPEG 2000</div><figcaption>${e(j)} — ${e(L("jp2"))}</figcaption></figure>`);
    parts.push(`</div></section>`);
  }
  if (attachments.length) parts.push(`<section class="m5h-sec"><h4>${e(L("attachments"))}</h4><ul class="m5h-files">${attachments.map((f) => `<li><span class="m5h-mono">${e(f.name)}</span> <span class="m5h-muted">${e(sizeText(b64Size(f.data)))}</span></li>`).join("")}</ul></section>`);
  parts.push(`</div>`);
  return parts.join("");
}

/* ================================================================ public */

function labels(lang?: string): (k: Key) => string {
  const dict = LANGS[(lang ?? "en").slice(0, 2).toLowerCase() as CardReportLang] ?? EN;
  return (k) => dict[k] ?? EN[k];
}

function build(input: unknown, opts: CardReportOptions): Built {
  const L = labels(opts.lang);
  const c = classify(input);
  if (c.kind === "emv" && c.emv) return buildEmv(L, c.result, c.emv, opts);
  if (c.kind === "mrtd" && c.mrtd) return buildMrtd(L, c.result, c.mrtd, opts);
  return buildCard(L, c.result, opts);
}

export function isCardReportFormat(v: unknown): v is CardReportFormat {
  return typeof v === "string" && (CARD_REPORT_FORMATS as readonly string[]).includes(v);
}

/**
 * Formats an NFC read (an NfcResult, or its emv / mrtd part) as html, object,
 * array, json, text or csv — with the card's pictures and the files to download.
 */
export function cardReport(input: unknown, format: CardReportFormat | string = "html", opts: CardReportOptions = {}): CardReport {
  const fmt: CardReportFormat = isCardReportFormat(format) ? format : "html";
  const b = build(input, opts);
  const L = labels(opts.lang);
  const base = { kind: b.kind, format: fmt, title: b.title, summary: b.summary, images: b.images.map(({ name, mime, data }) => ({ name, mime, data })), files: b.files };
  switch (fmt) {
    case "object": return { ...base, value: b.object, mime: "application/json" };
    case "array": return { ...base, value: rowsOf(b), mime: "application/json" };
    case "json": return { ...base, value: JSON.stringify(b.object, null, 2), mime: "application/json" };
    case "text": return { ...base, value: textOf(b), mime: "text/plain" };
    case "csv": return { ...base, value: csv([["section", "field", "value"], ...rowsOf(b).map((r) => [r.section, r.field, r.value])]), mime: "text/csv" };
    default: return { ...base, value: htmlOf(b, L, b.files), mime: "text/html" };
  }
}

/** The transaction history of an EMV read, every application's, as rows. */
export function cardHistory(input: unknown): Array<EmvLogEntry & { application: string }> {
  const c = classify(input);
  if (!c.emv) return [];
  return c.emv.apps.flatMap((a) => (a.log ?? []).map((e) => ({ application: a.label || a.scheme || a.aid, ...e })));
}

/** The pictures of a read (shown) — every one, JPEG 2000 included. */
export function cardImages(input: unknown): CardFile[] {
  const c = classify(input);
  const d = c.mrtd;
  if (!d) return [];
  if (d.images?.length) return d.images.map((i) => ({ name: i.name, mime: i.mime, data: i.data }));
  return d.photo && d.photoMime ? [{ name: d.photoMime === "image/jp2" ? "face.jp2" : "face.jpg", mime: d.photoMime, data: d.photo }] : [];
}

/** A standalone HTML document of the report (for a download): the fragment and its styles. */
export function cardReportDocument(input: unknown, opts: CardReportOptions = {}): string {
  const r = cardReport(input, "html", opts);
  return `<!doctype html><html lang="${escapeHtml((opts.lang ?? "en").slice(0, 2))}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(r.title)}</title><style>${CARD_REPORT_CSS}</style></head><body>${r.value as string}</body></html>`;
}

/** The report's look — the chat has its own copy (fn.css), themed; this one is for a standalone file. */
export const CARD_REPORT_CSS = `body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1d1d1f;background:#fff}
.m5h-report{max-width:880px}.m5h-head{margin-bottom:12px}.m5h-title{font-size:20px;font-weight:700}.m5h-sub,.m5h-muted{color:#6e6e73}
.m5h-sec{margin:14px 0}.m5h-sec h4,.m5h-sec summary{font-size:15px;font-weight:650;margin:0 0 6px;cursor:default}
.m5h-kv,.m5h-grid{border-collapse:collapse;width:100%}.m5h-kv th{text-align:left;font-weight:500;color:#6e6e73;width:34%;vertical-align:top;padding:3px 10px 3px 0}
.m5h-kv td,.m5h-grid td,.m5h-grid th{padding:3px 8px;vertical-align:top;word-break:break-word}.m5h-grid th{text-align:left;border-bottom:1px solid #d2d2d7}
.m5h-grid tr:nth-child(even) td{background:#f5f5f7}.m5h-kv--mono td,.m5h-mono,.m5h-pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.m5h-pre{white-space:pre-wrap;word-break:break-all;background:#f5f5f7;padding:8px;border-radius:6px}.m5h-scroll{overflow-x:auto}
.m5h-id{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}.m5h-photos{display:flex;gap:12px;flex-wrap:wrap}
.m5h-photo{margin:0;max-width:180px}.m5h-photo img{max-width:180px;max-height:240px;border-radius:6px;border:1px solid #d2d2d7}
.m5h-photo figcaption{font-size:12px;color:#6e6e73}.m5h-ph{width:120px;height:150px;display:flex;align-items:center;justify-content:center;border:1px dashed #aaa;border-radius:6px;color:#6e6e73}
.m5h-badge{display:inline-block;padding:0 6px;border-radius:9px;font-size:12px}.m5h-badge--ok{background:#d1f5d8;color:#0a6b25}.m5h-badge--err{background:#ffd6d6;color:#a30000}
.m5h-files{margin:0;padding-left:18px}`;
