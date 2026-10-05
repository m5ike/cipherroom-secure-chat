// Card reports (6.6) — client/src/lib/nfc/card-report.ts: what an NFC read gives,
// in the format the caller wants. One pure module: the app's workbench exports
// with it, and a model's read is formatted the way the web formats it.
//
//   html     every field, for the chat: sections, tables, the history, the pictures
//            inline (data: URIs); a fragment styled by the m5h-* classes
//   object   one normalized object (pictures and files as base64)
//   array    the same as rows: { section, field, value }
//   json     the object as JSON text
//   text     a plain-text report
//   csv      the rows as CSV (section, field, value)
//
// Pictures a browser shows (JPEG, PNG…) are `images`; everything else — the
// document's security objects, raw groups, JPEG 2000 pictures, the EMV records,
// the history as CSV — is `files`. Card text is never trusted: every value is
// escaped. The PAN is masked unless `fullPan` (G-19).

import Foundation

public enum CardReport {
    public static let formats = ["html", "object", "array", "json", "text", "csv"]

    public struct Options: Sendable {
        /// Show the whole card number (the holder's own card); masked by default.
        public var fullPan = false
        /// Label language (en, cs, de, … — sk falls back to cs, the rest to en).
        public var lang = "en"
        /// A title instead of the card's own.
        public var title: String? = nil
        /// Offer the raw data as files (default true).
        public var attachments = true
        /// Put the pictures in (default true).
        public var images = true
        public init(fullPan: Bool = false, lang: String = "en", title: String? = nil, attachments: Bool = true, images: Bool = true) {
            self.fullPan = fullPan; self.lang = lang; self.title = title; self.attachments = attachments; self.images = images
        }
    }

    /// A file of a report (base64 data).
    public struct File: Sendable, Hashable {
        public let name: String, mime: String, data: String
        public var json: NfcJSON { ["name": .string(name), "mime": .string(mime), "data": .string(data)] }
    }

    public struct Row: Sendable, Hashable { public let section: String, field: String, value: String }

    public struct Report: Sendable {
        /// "emv" | "mrtd" | "card".
        public let kind: String
        public let format: String
        /// The formatted value: text (html, json, text, csv), the object, or the rows.
        public let value: NfcJSON
        public let mime: String
        public let title: String
        public let summary: String
        /// Pictures to show (JPEG, PNG, GIF, WebP).
        public let images: [File]
        /// Everything else, to download.
        public let files: [File]
        /// The value as text (html, json, text, csv).
        public var text: String { value.stringValue ?? value.pretty() }
    }

    /* ================================================================ labels */

    static let en: [String: String] = [
        "card": "Card", "uid": "UID", "technology": "Technology", "atqa": "ATQA", "sak": "SAK", "ats": "ATS", "atr": "ATR", "memory": "Memory", "status": "Status", "message": "Message",
        "application": "Application", "aid": "AID", "label": "Label", "scheme": "Scheme", "pan": "Card number", "expiry": "Expires", "effective": "Valid from", "cardholder": "Cardholder",
        "issuerCountry": "Issuer country", "panSequence": "PAN sequence", "atc": "Transactions (ATC)", "lastOnlineAtc": "Last online ATC", "pinTryCounter": "PIN tries left",
        "aip": "AIP", "afl": "AFL", "logSfi": "Log file (SFI)", "logFormat": "Log format", "aids": "Applications on the card", "read": "Read", "deep": "every file", "aflOnly": "AFL records", "apdus": "APDUs",
        "history": "Transaction history", "noHistory": "The card keeps no transaction log (or it is not readable).", "date": "Date", "time": "Time", "amount": "Amount", "currency": "Currency",
        "country": "Country", "type": "Type", "merchant": "Merchant", "cid": "Result", "dataElements": "Data elements", "getData": "GET DATA", "records": "Records", "tag": "Tag", "name": "Name", "value": "Value",
        "holder": "Holder", "documentType": "Document", "documentNumber": "Document number", "issuer": "Issuing state", "nationality": "Nationality", "surname": "Surname", "givenNames": "Given names",
        "dateOfBirth": "Date of birth", "sex": "Sex", "dateOfExpiry": "Expires", "optionalData": "Optional data", "mrz": "MRZ", "access": "Opened with", "pace": "PACE",
        "personal": "Personal details", "fullName": "Full name", "otherNames": "Other names", "personalNumber": "Personal number", "fullDateOfBirth": "Full date of birth", "placeOfBirth": "Place of birth",
        "address": "Address", "telephone": "Telephone", "profession": "Profession", "title": "Title", "personalSummary": "Personal summary", "otherTravelDocuments": "Other travel documents", "custody": "Custody",
        "document": "Document details", "issuingAuthority": "Issuing authority", "dateOfIssue": "Date of issue", "otherPersons": "Other persons", "endorsements": "Endorsements", "taxExit": "Tax / exit",
        "personalizationTime": "Personalized", "personalizationDevice": "Personalization system", "optional": "Optional details (DG13)", "personsToNotify": "Persons to notify",
        "security": "Security", "passive": "Passive authentication", "passiveOk": "every group read matches EF.SOD", "passiveBad": "a group does NOT match EF.SOD", "passiveNone": "not checked",
        "hashAlgorithm": "Hash", "signer": "Document signer", "signerIssuer": "Signed by", "validity": "Valid", "protocols": "Protocols", "activeAuthKey": "Active Authentication key", "lds": "LDS version", "unicode": "Unicode version",
        "files": "Files", "file": "File", "size": "Size", "hashOk": "Hash", "protected": "protected (EAC)", "absent": "absent", "error": "error", "readOk": "read",
        "images": "Pictures", "face": "Face", "portrait": "Portrait", "signature": "Signature", "documentImage": "Document", "otherImage": "Picture", "jp2": "JPEG 2000 — attached for download",
        "attachments": "Attachments", "ndef": "NDEF records", "m5records": "M5Cet records", "data": "Data", "yes": "yes", "no": "no", "none": "—",
        "passport": "Passport", "idCard": "ID card", "travelDocument": "Travel document",
    ]
    static let cs: [String: String] = [
        "card": "Karta", "technology": "Technologie", "memory": "Paměť", "status": "Stav", "message": "Zpráva", "application": "Aplikace", "label": "Název", "scheme": "Schéma",
        "pan": "Číslo karty", "expiry": "Platnost do", "effective": "Platnost od", "cardholder": "Držitel", "issuerCountry": "Země vydavatele", "panSequence": "Pořadí PAN",
        "atc": "Počet transakcí (ATC)", "lastOnlineAtc": "Poslední online ATC", "pinTryCounter": "Zbývající pokusy PIN", "logSfi": "Soubor logu (SFI)", "logFormat": "Formát logu",
        "aids": "Aplikace na kartě", "read": "Čtení", "deep": "všechny soubory", "aflOnly": "záznamy AFL", "history": "Historie transakcí", "noHistory": "Karta nevede log transakcí (nebo není čitelný).",
        "date": "Datum", "time": "Čas", "amount": "Částka", "currency": "Měna", "country": "Země", "type": "Typ", "merchant": "Obchodník", "cid": "Výsledek", "dataElements": "Datové prvky", "records": "Záznamy",
        "tag": "Tag", "name": "Název", "value": "Hodnota", "holder": "Držitel", "documentType": "Doklad", "documentNumber": "Číslo dokladu", "issuer": "Vydávající stát", "nationality": "Státní občanství",
        "surname": "Příjmení", "givenNames": "Jména", "dateOfBirth": "Datum narození", "sex": "Pohlaví", "dateOfExpiry": "Platnost do", "optionalData": "Volitelné údaje", "access": "Otevřeno pomocí",
        "personal": "Osobní údaje", "fullName": "Celé jméno", "otherNames": "Další jména", "personalNumber": "Osobní číslo", "fullDateOfBirth": "Úplné datum narození", "placeOfBirth": "Místo narození",
        "address": "Adresa", "telephone": "Telefon", "profession": "Povolání", "title": "Titul", "personalSummary": "Shrnutí", "otherTravelDocuments": "Další cestovní doklady", "custody": "Péče",
        "document": "Údaje o dokladu", "issuingAuthority": "Vydal", "dateOfIssue": "Datum vydání", "otherPersons": "Další osoby", "endorsements": "Poznámky", "taxExit": "Daň / výjezd",
        "personalizationTime": "Personalizováno", "personalizationDevice": "Personalizační systém", "optional": "Volitelné údaje (DG13)", "personsToNotify": "Osoby k vyrozumění",
        "security": "Zabezpečení", "passive": "Pasivní autentizace", "passiveOk": "všechny přečtené skupiny odpovídají EF.SOD", "passiveBad": "některá skupina NEODPOVÍDÁ EF.SOD", "passiveNone": "neověřeno",
        "signer": "Podepsal (DS)", "signerIssuer": "Vydal (CSCA)", "validity": "Platnost", "protocols": "Protokoly", "activeAuthKey": "Klíč aktivní autentizace", "files": "Soubory", "file": "Soubor", "size": "Velikost",
        "protected": "chráněno (EAC)", "absent": "chybí", "error": "chyba", "readOk": "přečteno", "images": "Obrázky", "face": "Obličej", "portrait": "Portrét", "signature": "Podpis", "documentImage": "Doklad",
        "otherImage": "Obrázek", "jp2": "JPEG 2000 — v příloze ke stažení", "attachments": "Přílohy", "ndef": "Záznamy NDEF", "m5records": "Záznamy M5Cet", "data": "Data", "yes": "ano", "no": "ne",
        "passport": "Cestovní pas", "idCard": "Občanský průkaz", "travelDocument": "Cestovní doklad",
        "lds": "Verze LDS", "unicode": "Verze Unicode", "hashAlgorithm": "Hash", "none": "—", "aid": "AID",
    ]
    static let de: [String: String] = [
        "card": "Karte", "technology": "Technologie", "memory": "Speicher", "status": "Status", "message": "Meldung", "application": "Anwendung", "label": "Name", "scheme": "Netz",
        "pan": "Kartennummer", "expiry": "Gültig bis", "effective": "Gültig ab", "cardholder": "Karteninhaber", "issuerCountry": "Ausgabeland", "atc": "Transaktionen (ATC)",
        "pinTryCounter": "Verbleibende PIN-Versuche", "aids": "Anwendungen auf der Karte", "read": "Gelesen", "deep": "alle Dateien", "history": "Transaktionsverlauf",
        "noHistory": "Die Karte führt kein Transaktionsprotokoll (oder es ist nicht lesbar).", "date": "Datum", "time": "Uhrzeit", "amount": "Betrag", "currency": "Währung", "country": "Land",
        "type": "Art", "merchant": "Händler", "cid": "Ergebnis", "dataElements": "Datenelemente", "records": "Datensätze", "name": "Name", "value": "Wert", "holder": "Inhaber", "documentType": "Dokument",
        "documentNumber": "Dokumentnummer", "issuer": "Ausstellerstaat", "nationality": "Staatsangehörigkeit", "surname": "Nachname", "givenNames": "Vornamen", "dateOfBirth": "Geburtsdatum",
        "sex": "Geschlecht", "dateOfExpiry": "Gültig bis", "access": "Geöffnet mit", "personal": "Persönliche Angaben", "fullName": "Vollständiger Name", "placeOfBirth": "Geburtsort", "address": "Anschrift",
        "document": "Dokumentangaben", "issuingAuthority": "Ausstellende Behörde", "dateOfIssue": "Ausstellungsdatum", "security": "Sicherheit", "passive": "Passive Authentisierung",
        "passiveOk": "alle gelesenen Gruppen stimmen mit EF.SOD überein", "passiveBad": "eine Gruppe stimmt NICHT mit EF.SOD überein", "passiveNone": "nicht geprüft", "files": "Dateien", "file": "Datei",
        "size": "Größe", "protected": "geschützt (EAC)", "absent": "fehlt", "error": "Fehler", "readOk": "gelesen", "images": "Bilder", "face": "Gesicht", "signature": "Unterschrift", "attachments": "Anhänge",
        "yes": "ja", "no": "nein", "passport": "Reisepass", "idCard": "Personalausweis", "travelDocument": "Reisedokument",
        "lds": "LDS-Version", "unicode": "Unicode-Version", "personsToNotify": "Zu benachrichtigende Personen", "optional": "Optionale Angaben (DG13)",
        "signer": "Dokumentensigner", "signerIssuer": "Ausgestellt von (CSCA)", "validity": "Gültigkeit", "protocols": "Protokolle", "activeAuthKey": "Schlüssel der aktiven Authentisierung",
        "portrait": "Porträt", "documentImage": "Dokument", "otherImage": "Bild", "jp2": "JPEG 2000 — als Anhang zum Herunterladen", "ndef": "NDEF-Datensätze", "m5records": "M5Cet-Datensätze", "data": "Daten",
    ]
    static let locales = ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"]

    /// The label lookup for a language: the language, its fallbacks (sk → cs), then English.
    static func labels(_ lang: String?) -> (String) -> String {
        let l = String((lang ?? "en").prefix(2)).lowercased()
        let code = locales.contains(l) ? l : "en"
        var chain = [code]
        if code == "sk" { chain.append("cs") }
        if !chain.contains("en") { chain.append("en") }
        let tables = chain.map { ["en": en, "cs": cs, "de": de][$0] ?? [:] }
        return { k in for t in tables { if let v = t[k] { return v } }; return en[k] ?? k }
    }

    /* ================================================================ helpers */

    static let showable = "image/(jpeg|png|gif|webp)"
    static func isB64(_ s: String) -> Bool { s.fullMatch("[A-Za-z0-9+/]*={0,2}") }

    public static func escapeHtml(_ s: String) -> String {
        var out = ""
        for c in s {
            switch c { case "&": out += "&amp;"; case "<": out += "&lt;"; case ">": out += "&gt;"; case "\"": out += "&quot;"; case "'": out += "&#39;"; default: out.append(c) }
        }
        return out
    }

    static func b64OfText(_ text: String) -> String { Data(text.utf8).base64EncodedString() }
    static func b64Size(_ b64: String) -> Int { b64.utf8.count * 3 / 4 - (b64.hasSuffix("==") ? 2 : b64.hasSuffix("=") ? 1 : 0) }
    static func sizeText(_ n: Int) -> String {
        n < 1024 ? "\(n) B" : n < 1024 * 1024 ? String(format: n < 10_240 ? "%.1f kB" : "%.0f kB", Double(n) / 1024) : String(format: "%.1f MB", Double(n) / 1024 / 1024)
    }

    /// The JavaScript truthiness of an optional field.
    static func present(_ v: NfcJSON?) -> Bool { v.map { !$0.isNull && !($0.stringValue?.isEmpty ?? false) && !($0.arrayValue?.isEmpty ?? false) } ?? false }

    /// Without undefined / null / "" / [] values (card-report.ts clean).
    static func clean(_ pairs: [(String, NfcJSON?)]) -> NfcJSONObject {
        var o = NfcJSONObject()
        for (k, v) in pairs { if let v, present(v) { o[k] = v } }
        return o
    }

    static func docKind(_ code: String?) -> String {
        guard let c = code, !c.isEmpty else { return "travelDocument" }
        if c.hasPrefix("P") { return "passport" }
        if c.hasPrefix("I") || c.hasPrefix("A") || c.hasPrefix("C") { return "idCard" }
        return "travelDocument"
    }

    struct Section {
        let id: String
        let title: String
        var rows: [(String, String)]
        var mono = false
        var columns: [String]? = nil
        var table: [[String]]? = nil
        var pre: String? = nil
        var collapsed = false
        var note: String? = nil
    }

    struct Built {
        let kind: String, title: String, subtitle: String, summary: String
        let sections: [Section]
        let object: NfcJSONObject
        let images: [(file: File, caption: String)]
        let files: [File]
        let jp2: [String]
    }

    static func cardSection(_ L: (String) -> String, _ r: NfcJSONObject) -> Section? {
        guard let c = r.optObject("card") else { return nil }
        var rows: [(String, String)] = [(L("uid"), c.optString("uid")), (L("technology"), c.optString("label").isEmpty ? c.optString("tech") : c.optString("label"))]
        for k in ["atqa", "sak", "ats", "atr", "memory"] where !c.optString(k).isEmpty { rows.append((L(k), c.optString(k))) }
        return Section(id: "card", title: L("card"), rows: rows.filter { !$0.1.isEmpty })
    }

    static func join(_ parts: [String?], _ sep: String = " · ") -> String { parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: sep) }

    /* ================================================================ EMV */

    static func buildEmv(_ L: @escaping (String) -> String, _ r: NfcJSONObject, _ d: NfcJSONObject, _ o: Options) -> Built {
        let pans = PanMask.pansOfEmv(d)
        func pan(_ a: NfcJSONObject) -> String? {
            let p = a.optString("pan")
            if p.isEmpty { return nil }
            return o.fullPan ? p : (a.optString("panMasked").isEmpty ? PanMask.maskPanDigits(p, "•") : a.optString("panMasked"))
        }
        func mask(_ s: String) -> String { o.fullPan ? s : PanMask.maskPans(s, pans) }
        func maskHex(_ s: String) -> String { o.fullPan ? s : PanMask.maskAnswer(s, pans) }
        func tagView(_ t: NfcJSONObject) -> NfcJSONObject {
            if o.fullPan { return t }
            var v = t
            let tag = t.optString("tag")
            if PanMask.sensitive.contains(tag) { let m = PanMask.maskValue(tag, t.optString("hex")); v["value"] = .string(m); v["hex"] = .string(m) }
            else { v["value"] = .string(mask(t.optString("value"))); v["hex"] = .string(mask(t.optString("hex"))) }
            return v
        }
        let apps = d.objects("apps")
        let first = apps.first
        let firstHead = first.map { a in a.optString("scheme").isEmpty ? a.optString("label") : a.optString("scheme") } ?? ""
        let title = o.title ?? join([!firstHead.isEmpty ? firstHead : (d.optString("scheme").isEmpty ? "EMV" : d.optString("scheme")), first.flatMap(pan)])
        let historyCount = apps.reduce(0) { $0 + $1.arrayCount("log") }
        let fl = first?.optString("label") ?? ""
        let subtitle = join([!fl.isEmpty && fl != first?.optString("scheme") ? fl : nil, (first?.optString("expiry")).flatMap { $0.isEmpty ? nil : "\(L("expiry")) \($0)" },
                             historyCount > 0 ? "\(L("history")): \(historyCount)" : nil])
        var sections = [Section]()
        if let cs = cardSection(L, r) { sections.append(cs) }
        let apdus = d.optInt("apdus")
        sections.append(Section(id: "aids", title: L("aids"), rows: [(L("aid"), d.strings("aids").isEmpty ? L("none") : d.strings("aids").joined(separator: ", ")),
                                                                      (L("read"), (d["deep"]?.boolValue == false ? L("aflOnly") : L("deep")) + (apdus != 0 ? " · \(apdus) \(L("apdus"))" : ""))]))
        var files = [File]()
        var histCsv = [[String]]()
        var appObjects = [NfcJSON]()
        for (i, a) in apps.enumerated() {
            let name = !a.optString("label").isEmpty ? a.optString("label") : !a.optString("scheme").isEmpty ? a.optString("scheme") : a.optString("aid")
            let n = apps.count > 1 ? " \(i + 1) — \(name)" : " — \(name)"
            var rows = [(String, String)]()
            func add(_ k: String, _ v: NfcJSON?) { if let v, !v.isNull, !(v.stringValue?.isEmpty ?? false) { rows.append((L(k), v.jsString)) } }
            add("aid", a["aid"]); add("label", a["label"]); add("scheme", a["scheme"]); add("pan", pan(a).map { .string($0) }); add("expiry", a["expiry"]); add("effective", a["effective"])
            add("cardholder", a["cardholder"]); add("issuerCountry", a["issuerCountry"]); add("panSequence", a["panSequence"]); add("atc", a["atc"]); add("lastOnlineAtc", a["lastOnlineAtc"])
            add("pinTryCounter", a["pinTryCounter"]); add("aip", a["aip"]); add("afl", a["afl"]); add("logSfi", a["logSfi"]); add("logFormat", a["logFormat"])
            sections.append(Section(id: "app\(i)", title: L("application") + n, rows: rows))
            // The history.
            let log = a.objects("log")
            let cols: [(String, String)] = [("date", "date"), ("time", "time"), ("amount", "amount"), ("currency", "currency"), ("merchant", "merchant"), ("type", "type"), ("country", "country"), ("atc", "atc"), ("cid", "cid")]
            let used = cols.filter { c in log.contains { !$0.optString(c.0).isEmpty } }
            var extra = [String]()
            for e in log { for k in e.keys where k != "raw" && !cols.contains(where: { $0.0 == k }) && !extra.contains(k) { extra.append(k) } }
            if a.has("logSfi") || !log.isEmpty {
                var s = Section(id: "history\(i)", title: "\(L("history"))\(n) (\(log.count))", rows: [])
                if log.isEmpty { s.note = L("noHistory") } else {
                    s.columns = used.map { $0.1 == "atc" ? "ATC" : L($0.1) } + extra
                    s.table = log.map { e in used.map { e.optString($0.0) } + extra.map { e.optString($0) } }
                }
                sections.append(s)
                for e in log {
                    histCsv.append([name, e.optString("date"), e.optString("time"), e.optString("amount"), e.optString("currency"), e.optString("merchant"), e.optString("type"),
                                    e.optString("country"), e.optString("atc"), e.optString("cid"), e.optString("raw").isEmpty ? "" : maskHex(e.optString("raw"))])
                }
            }
            let tags = a.objects("tags").map(tagView)
            sections.append(Section(id: "tags\(i)", title: "\(L("dataElements"))\(n) (\(tags.count))",
                                    rows: tags.map { t in ("\(t.optString("tag")) \(t.optString("name"))", t.optString("value") == t.optString("hex") ? t.optString("hex") : "\(t.optString("value"))  (\(t.optString("hex")))") },
                                    mono: true, collapsed: true))
            let gd = a.objects("getData").map(tagView)
            if !gd.isEmpty { sections.append(Section(id: "gd\(i)", title: "\(L("getData"))\(n)", rows: gd.map { ("\($0.optString("tag")) \($0.optString("name"))", $0.optString("value")) }, mono: true, collapsed: true)) }
            let recs = a.objects("records")
            if !recs.isEmpty {
                let pre = recs.map { rec in "SFI \(JSText.padStart(String(rec.optInt("sfi")), 2)) · \(JSText.padStart(String(rec.optInt("record")), 2))\(rec.optBool("log") ? " (log)" : "")  \(maskHex(rec.optString("hex")))" }.joined(separator: "\n")
                sections.append(Section(id: "rec\(i)", title: "\(L("records"))\(n) (\(recs.count))", rows: [], pre: pre, collapsed: true))
            }
            let history: [NfcJSON] = log.map { e in var x = e; if !e.optString("raw").isEmpty { x["raw"] = .string(maskHex(e.optString("raw"))) }; return .object(x) }
            appObjects.append(.object(clean([
                ("aid", a["aid"]), ("label", a["label"]), ("scheme", a["scheme"]), ("pan", pan(a).map { .string($0) }), ("expiry", a["expiry"]), ("effective", a["effective"]),
                ("cardholder", a["cardholder"]), ("issuerCountry", a["issuerCountry"]), ("panSequence", a["panSequence"]), ("atc", a["atc"]), ("lastOnlineAtc", a["lastOnlineAtc"]),
                ("pinTryCounter", a["pinTryCounter"]), ("aip", a["aip"]), ("afl", a["afl"]), ("logSfi", a["logSfi"]), ("logFormat", a["logFormat"]),
                ("history", .array(history)), ("data", .array(tags.map { .object($0) })), ("getData", a.has("getData") ? .array(gd.map { .object($0) }) : nil),
                ("records", a.has("records") ? .array(recs.map { rec in var x = rec; x["hex"] = .string(maskHex(rec.optString("hex"))); return .object(x) }) : nil),
            ])))
        }
        if o.attachments {
            if !histCsv.isEmpty {
                files.append(File(name: "emv-history.csv", mime: "text/csv", data: b64OfText(csv([["application", "date", "time", "amount", "currency", "merchant", "type", "country", "atc", "result", "raw"]] + histCsv))))
            }
            let recs = apps.flatMap { a in a.objects("records").map { rec in "\(a.optString("aid"))  SFI \(rec.optInt("sfi")) record \(rec.optInt("record"))\(rec.optBool("log") ? " (log)" : "")\n\(maskHex(rec.optString("hex")))\n" } }
            if !recs.isEmpty {
                let tree = d.optString("tree")
                files.append(File(name: "emv-records.txt", mime: "text/plain", data: b64OfText("\(title)\n\n\(recs.joined(separator: "\n"))\(tree.isEmpty ? "" : "\nPPSE\n\(tree)\n")")))
            }
        }
        let summary = join([title, first?.optString("expiry"), historyCount > 0 ? "\(L("history")): \(historyCount)" : nil])
        var object = clean([("type", "emv"), ("title", .string(title)), ("summary", ""), ("card", r["card"]), ("scheme", d["scheme"]), ("aids", d["aids"]), ("applications", .array(appObjects)),
                            ("ppse", d["tree"]), ("deep", d["deep"]), ("apdus", d["apdus"]), ("status", r["status"]), ("message", r["message"])])
        object["summary"] = .string(summary)
        return Built(kind: "emv", title: title, subtitle: subtitle, summary: summary, sections: sections, object: object, images: [], files: files, jp2: [])
    }

    /* ================================================================ e-ID */

    static func buildMrtd(_ L: @escaping (String) -> String, _ r: NfcJSONObject, _ d: NfcJSONObject, _ o: Options) -> Built {
        let m = d.optObject("mrzInfo") ?? NfcJSONObject()
        let name = join([m.optString("givenNames"), m.optString("surname")], " ")
        let kind = L(docKind(m.optString("documentCode")))
        let title = o.title ?? { let t = join([kind, name]); return t.isEmpty ? "e-ID" : t }()
        let subtitle = join([m.optString("documentNumber"), m.optString("issuer"), m.optString("dateOfExpiry").isEmpty ? nil : "\(L("dateOfExpiry")) \(m.optString("dateOfExpiry"))"])
        var sections = [Section]()
        if let cs = cardSection(L, r) { sections.append(cs) }
        func rows(_ pairs: [(String, NfcJSON?)]) -> [(String, String)] {
            pairs.compactMap { k, v in
                guard let v, present(v) else { return nil }
                if let a = v.arrayValue { return (L(k), a.map(\.jsString).joined(separator: "; ")) }
                return (L(k), v.jsString)
            }
        }
        let access = d.optString("access", "none")
        let pace = d.optObject("pace")
        let accessText: String
        if access == "pace" {
            let pw = pace?.optString("password") ?? "", proto = pace?.optString("protocol") ?? ""
            accessText = "PACE" + (pw.isEmpty ? "" : " (\(JSText.upperASCII(pw)))") + (proto.isEmpty ? "" : " · \(proto)")
        } else { accessText = access == "bac" ? "BAC (MRZ)" : L("none") }
        let code = m.optString("documentCode")
        sections.append(Section(id: "holder", title: L("holder"), rows: rows([("documentType", code.isEmpty ? nil : .string("\(kind) (\(code))")), ("documentNumber", m["documentNumber"]),
                                                                                ("surname", m["surname"]), ("givenNames", m["givenNames"]), ("nationality", m["nationality"]), ("dateOfBirth", m["dateOfBirth"]),
                                                                                ("sex", m["sex"]), ("dateOfExpiry", m["dateOfExpiry"]), ("issuer", m["issuer"]), ("optionalData", m["optionalData"]), ("access", .string(accessText))])))
        let mrz = m.optString("mrz")
        if !mrz.isEmpty {
            let s = Bac.sub
            let pre = mrz.contains("\n") ? mrz : mrz.count == 88 ? s(mrz, 0, 44) + "\n" + s(mrz, 44, 88) : mrz.count == 90 ? s(mrz, 0, 30) + "\n" + s(mrz, 30, 60) + "\n" + s(mrz, 60, 90)
                : mrz.count == 72 ? s(mrz, 0, 36) + "\n" + s(mrz, 36, 72) : mrz
            sections.append(Section(id: "mrz", title: L("mrz"), rows: [], pre: pre))
        }
        let p = d.optObject("personal") ?? NfcJSONObject()
        let pr = rows(["fullName", "otherNames", "personalNumber", "fullDateOfBirth", "placeOfBirth", "address", "telephone", "profession", "title", "personalSummary", "otherTravelDocuments", "custody"].map { ($0, p[$0]) })
        if !pr.isEmpty { sections.append(Section(id: "personal", title: L("personal"), rows: pr)) }
        let doc = d.optObject("document") ?? NfcJSONObject()
        let dr = rows(["issuingAuthority", "dateOfIssue", "otherPersons", "endorsements", "taxExit", "personalizationTime", "personalizationDevice"].map { ($0, doc[$0]) })
        if !dr.isEmpty { sections.append(Section(id: "document", title: L("document"), rows: dr)) }
        if !d.optString("optional").isEmpty { sections.append(Section(id: "optional", title: L("optional"), rows: [], pre: d.optString("optional"))) }
        let notify = d.strings("personsToNotify")
        if !notify.isEmpty { sections.append(Section(id: "notify", title: L("personsToNotify"), rows: notify.enumerated().map { ("#\($0.offset + 1)", $0.element) })) }
        let s = d.optObject("security") ?? NfcJSONObject()
        let passive = s.optString("passive") == "ok" ? "✓ \(L("passiveOk"))" : s.optString("passive") == "mismatch" ? "✗ \(L("passiveBad"))" : L("passiveNone")
        let signer = s.optObject("signer")
        let validity: NfcJSON? = signer.flatMap { sg in sg.optString("notBefore").isEmpty && sg.optString("notAfter").isEmpty ? nil : .string("\(sg.optString("notBefore", "?")) – \(sg.optString("notAfter", "?"))") }
        let paceRow: NfcJSON? = pace.map { pc in .string(pc.optBool("supported") ? L("yes") + (pc.optString("protocol").isEmpty ? "" : " · \(pc.optString("protocol"))") : L("no")) }
        sections.append(Section(id: "security", title: L("security"), rows: rows([("passive", .string(passive)), ("hashAlgorithm", s["hashAlgorithm"]), ("signer", signer?["subject"]),
                                                                                    ("signerIssuer", signer?["issuer"]), ("validity", validity), ("protocols", s["protocols"]), ("activeAuthKey", s["activeAuthKey"]),
                                                                                    ("pace", paceRow), ("lds", d["ldsVersion"]), ("unicode", d["unicodeVersion"])])))
        let fileList = d.objects("files")
        if !fileList.isEmpty {
            func st(_ f: NfcJSONObject) -> String {
                switch f.optString("status") { case "read": return L("readOk"); case "protected": return L("protected"); case "absent": return L("absent"); default: return L("error") }
            }
            sections.append(Section(id: "files", title: L("files"), rows: [], columns: [L("file"), "FID", L("status"), L("size"), L("hashOk")],
                                    table: fileList.map { f in [f.optString("name"), f.optString("fid"), st(f) + (f.optString("message").isEmpty ? "" : " — \(f.optString("message"))"),
                                                                f.has("size") ? sizeText(f.optInt("size")) : "", f["hashOk"]?.boolValue == true ? "✓" : f["hashOk"]?.boolValue == false ? "✗" : ""] },
                                    collapsed: true))
        }
        if !d.optString("message").isEmpty && access == "none" { sections.append(Section(id: "message", title: L("message"), rows: [(L("message"), d.optString("message"))])) }

        // Pictures: what a browser shows goes in; JPEG 2000 becomes a download.
        var images = [(file: File, caption: String)]()
        var files = [File]()
        var jp2 = [String]()
        func kindLabel(_ i: NfcJSONObject) -> String {
            switch i.optString("kind") { case "face": return L("face"); case "portrait": return L("portrait"); case "signature": return L("signature"); case "document": return L("documentImage"); default: return L("otherImage") }
        }
        var all = d.objects("images")
        if all.isEmpty, !d.optString("photo").isEmpty, !d.optString("photoMime").isEmpty {
            let mime = d.optString("photoMime")
            all = [["group": "DG2", "kind": "face", "mime": .string(mime), "data": .string(d.optString("photo")), "name": .string(mime == "image/jp2" ? "face.jp2" : "face.jpg")]]
        }
        if o.images {
            for img in all where isB64(img.optString("data")) {
                let f = File(name: img.optString("name"), mime: img.optString("mime"), data: img.optString("data"))
                if img.optString("mime").fullMatch(showable) { images.append((f, "\(kindLabel(img)) · \(img.optString("group"))")) }
                else { files.append(f); jp2.append("\(kindLabel(img)) · \(img.optString("group")) (\(img.optString("name")))") }
            }
        }
        if o.attachments { for f in d.objects("raw") where isB64(f.optString("data")) { files.append(File(name: f.optString("name"), mime: f.optString("mime"), data: f.optString("data"))) } }
        if !all.isEmpty {
            sections.append(Section(id: "images", title: L("images"), rows: all.map { ("\(kindLabel($0)) · \($0.optString("group"))", "\($0.optString("name")) · \($0.optString("mime")) · \(sizeText(b64Size($0.optString("data"))))") }))
        }
        var sec = clean(s.entries.map { ($0.key, $0.value) })
        if present(d["ldsVersion"]) { sec["ldsVersion"] = d["ldsVersion"] }
        if present(d["unicodeVersion"]) { sec["unicodeVersion"] = d["unicodeVersion"] }
        let message: NfcJSON? = d["message"] ?? r["message"]
        var object = clean([("type", "mrtd"), ("title", .string(title)), ("summary", ""), ("card", r["card"]), ("access", d["access"]), ("pace", d["pace"]), ("dataGroups", d["dataGroups"]),
                            ("holder", .object(clean(m.entries.map { ($0.key, $0.value) }))), ("personal", d["personal"]), ("document", d["document"]), ("optional", d["optional"]),
                            ("personsToNotify", d["personsToNotify"]), ("security", .object(sec)), ("files", d["files"]),
                            ("images", .array(all.map { var x = $0; x["size"] = NfcJSON(b64Size($0.optString("data"))); return .object(x) })), ("attachments", d["raw"]),
                            ("status", r["status"]), ("message", message)])
        let summary = join([title, m.optString("documentNumber"), m.optString("nationality"), all.isEmpty ? nil : "\(L("images")): \(all.count)", access != "none" ? JSText.upperASCII(access) : nil])
        object["summary"] = .string(summary)
        return Built(kind: "mrtd", title: title, subtitle: subtitle, summary: summary, sections: sections, object: object, images: images, files: files, jp2: jp2)
    }

    /* ================================================================ any other card */

    static func buildCard(_ L: @escaping (String) -> String, _ r: NfcJSONObject, _ o: Options) -> Built {
        let c = r.optObject("card")
        let head = c.map { !$0.optString("label").isEmpty ? $0.optString("label") : !$0.optString("tech").isEmpty ? $0.optString("tech") : L("card") } ?? L("card")
        let title = o.title ?? join([head, c?.optString("uid")])
        var sections = [Section]()
        if let cs = cardSection(L, r) { sections.append(cs) }
        var statusRows = [(L("status"), r.optString("status"))]
        if !r.optString("message").isEmpty { statusRows.append((L("message"), r.optString("message"))) }
        sections.append(Section(id: "status", title: L("status"), rows: statusRows))
        let ndef = r.objects("ndef")
        if !ndef.isEmpty {
            sections.append(Section(id: "ndef", title: L("ndef"), rows: ndef.enumerated().map { i, n in
                ("#\(i + 1) \(n.optString("kind"))" + (n.optString("type").isEmpty ? "" : " (\(n.optString("type")))"), n.has("text") ? n.optString("text") : n.optString("data"))
            }))
        }
        let records = r.objects("records")
        if !records.isEmpty { sections.append(Section(id: "m5", title: L("m5records"), rows: records.map { ("#\($0.optString("id")) \($0.optString("type"))", $0.optString("summary")) })) }
        var files = [File]()
        let data = r.optString("data")
        if !data.isEmpty {
            sections.append(Section(id: "data", title: L("data"), rows: [(L("size"), sizeText(b64Size(data)))]))
            if o.attachments && isB64(data) { files.append(File(name: "card-data.bin", mime: "application/octet-stream", data: data)) }
        }
        let object = clean([("type", "card"), ("title", .string(title)), ("summary", .string(title)), ("card", r["card"]), ("status", r["status"]), ("ndef", r["ndef"]),
                            ("records", r["records"]), ("data", r["data"]), ("message", r["message"])])
        return Built(kind: "card", title: title, subtitle: r.optString("message"), summary: title, sections: sections, object: object, images: [], files: files, jp2: [])
    }

    /* ================================================================ the views */

    static func csv(_ rows: [[String]]) -> String {
        func cell(_ v: String) -> String { v.rangeOfCharacter(from: CharacterSet(charactersIn: "\",\n\r;")) != nil ? "\"" + v.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : v }
        return rows.map { $0.map(cell).joined(separator: ",") }.joined(separator: "\r\n") + "\r\n"
    }

    static func rowsOf(_ b: Built) -> [Row] {
        var out = [Row]()
        for s in b.sections {
            for (f, v) in s.rows { out.append(Row(section: s.title, field: f, value: v)) }
            if let t = s.table { for (i, r) in t.enumerated() { out.append(Row(section: s.title, field: "#\(i + 1)", value: r.filter { !$0.isEmpty }.joined(separator: " · "))) } }
            if let p = s.pre { out.append(Row(section: s.title, field: "", value: p)) }
            if let n = s.note { out.append(Row(section: s.title, field: "", value: n)) }
        }
        return out
    }

    static func textOf(_ b: Built) -> String {
        var lines = [b.title, String(repeating: "=", count: min(72, max(8, JSText.length(b.title))))]
        if !b.subtitle.isEmpty { lines.append(b.subtitle) }
        for s in b.sections {
            lines += ["", s.title, String(repeating: "-", count: min(72, JSText.length(s.title)))]
            let w = min(28, max(0, s.rows.map { JSText.length($0.0) }.max() ?? 0))
            for (f, v) in s.rows { lines.append(JSText.padEnd(f, w) + "  " + v.replacingOccurrences(of: "\n", with: "\n" + String(repeating: " ", count: w + 2))) }
            if let t = s.table, let cols = s.columns {
                let widths = cols.indices.map { i in min(30, max(JSText.length(cols[i]), t.map { i < $0.count ? JSText.length($0[i]) : 0 }.max() ?? 0)) }
                lines.append(JSText.trimEnd(cols.indices.map { JSText.padEnd(cols[$0], widths[$0]) }.joined(separator: "  ")))
                lines.append(widths.map { String(repeating: "-", count: $0) }.joined(separator: "  "))
                for r in t { lines.append(JSText.trimEnd(r.indices.map { JSText.padEnd(JSText.prefix(r[$0], 30), $0 < widths.count ? widths[$0] : 0) }.joined(separator: "  "))) }
            }
            if let p = s.pre { lines.append(p) }
            if let n = s.note { lines.append(n) }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    static func htmlOf(_ b: Built, _ L: (String) -> String, _ attachments: [File]) -> String {
        let e = escapeHtml
        func kv(_ rows: [(String, String)], _ mono: Bool = false) -> String {
            rows.isEmpty ? "" : "<table class=\"m5h-kv\(mono ? " m5h-kv--mono" : "")\"><tbody>" + rows.map { "<tr><th>\(e($0.0))</th><td>\(e($0.1).replacingOccurrences(of: "\n", with: "<br>"))</td></tr>" }.joined() + "</tbody></table>"
        }
        func grid(_ cols: [String], _ rows: [[String]]) -> String {
            "<div class=\"m5h-scroll\"><table class=\"m5h-grid\"><thead><tr>" + cols.map { "<th>\(e($0))</th>" }.joined() + "</tr></thead><tbody>"
                + rows.map { "<tr>" + $0.map { "<td>\(e($0))</td>" }.joined() + "</tr>" }.joined() + "</tbody></table></div>"
        }
        func body(_ s: Section) -> String {
            (s.note.map { "<p class=\"m5h-muted\">\(e($0))</p>" } ?? "") + kv(s.rows, s.mono) + (s.table.map { grid(s.columns ?? [], $0) } ?? "") + (s.pre.map { "<pre class=\"m5h-pre\">\(e($0))</pre>" } ?? "")
        }
        func badge(_ s: Section) -> String {
            guard s.id == "security" else { return "" }
            let p = s.rows.first?.1 ?? ""
            return p.hasPrefix("✓") ? " <span class=\"m5h-badge m5h-badge--ok\">✓</span>" : p.hasPrefix("✗") ? " <span class=\"m5h-badge m5h-badge--err\">✗</span>" : ""
        }
        var parts = ["<div class=\"m5h-report m5h-report--\(b.kind)\">"]
        parts.append("<div class=\"m5h-head\"><div class=\"m5h-title\">\(e(b.title))</div>" + (b.subtitle.isEmpty ? "" : "<div class=\"m5h-sub\">\(e(b.subtitle))</div>") + "</div>")
        let faceIndex = b.images.firstIndex { $0.caption.range(of: "face|portrait", options: [.regularExpression, .caseInsensitive]) != nil || $0.file.name.hasPrefix("face") || $0.file.name.hasPrefix("portrait") }
        for s in b.sections {
            if s.id == "images" { continue }
            if s.id == "holder", let fi = faceIndex {
                let face = b.images[fi]
                parts.append("<section class=\"m5h-sec\"><h4>\(e(s.title))</h4><div class=\"m5h-id\"><figure class=\"m5h-photo\"><img src=\"data:\(face.file.mime);base64,\(face.file.data)\" alt=\"\(e(face.caption))\"><figcaption>\(e(face.caption))</figcaption></figure>\(kv(s.rows))</div></section>")
                continue
            }
            if s.collapsed { parts.append("<details class=\"m5h-sec\"><summary>\(e(s.title))</summary>\(body(s))</details>") }
            else { parts.append("<section class=\"m5h-sec\"><h4>\(e(s.title))\(badge(s))</h4>\(body(s))</section>") }
        }
        let rest = b.images.indices.filter { $0 != faceIndex }.map { b.images[$0] }
        if !rest.isEmpty || !b.jp2.isEmpty {
            parts.append("<section class=\"m5h-sec\"><h4>\(e(L("images")))</h4><div class=\"m5h-photos\">")
            for i in rest { parts.append("<figure class=\"m5h-photo\"><img src=\"data:\(i.file.mime);base64,\(i.file.data)\" alt=\"\(e(i.caption))\"><figcaption>\(e(i.caption))</figcaption></figure>") }
            for j in b.jp2 { parts.append("<figure class=\"m5h-photo m5h-photo--file\"><div class=\"m5h-ph\">JPEG 2000</div><figcaption>\(e(j)) — \(e(L("jp2")))</figcaption></figure>") }
            parts.append("</div></section>")
        }
        if !attachments.isEmpty {
            parts.append("<section class=\"m5h-sec\"><h4>\(e(L("attachments")))</h4><ul class=\"m5h-files\">"
                         + attachments.map { "<li><span class=\"m5h-mono\">\(e($0.name))</span> <span class=\"m5h-muted\">\(e(sizeText(b64Size($0.data))))</span></li>" }.joined() + "</ul></section>")
        }
        parts.append("</div>")
        return parts.joined()
    }

    /* ================================================================ public */

    /// What the input is: an NfcResult, a bare EmvData / MrtdData.
    static func classify(_ input: NfcJSON?) -> (kind: String, result: NfcJSONObject, emv: NfcJSONObject?, mrtd: NfcJSONObject?) {
        let r = input?.objectValue ?? NfcJSONObject()
        if let e = r.optObject("emv") { return ("emv", r, e, nil) }
        if let m = r.optObject("mrtd") { return ("mrtd", r, nil, m) }
        if r.optArray("apps") != nil && r.optArray("aids") != nil { return ("emv", ["status": "ok", "emv": .object(r)], r, nil) }
        if r.has("access") && r.has("present") { return ("mrtd", ["status": "ok", "mrtd": .object(r)], nil, r) }
        return ("card", r, nil, nil)
    }

    static func build(_ input: NfcJSON?, _ o: Options) -> Built {
        let L = labels(o.lang)
        let c = classify(input)
        if c.kind == "emv", let e = c.emv { return buildEmv(L, c.result, e, o) }
        if c.kind == "mrtd", let m = c.mrtd { return buildMrtd(L, c.result, m, o) }
        return buildCard(L, c.result, o)
    }

    /// Formats an NFC read (an NfcResult, or its emv / mrtd part) as html, object, array, json, text or csv —
    /// with the card's pictures and the files to download.
    public static func report(_ input: NfcJSON?, format: String = "html", options: Options = Options()) -> Report {
        let fmt = formats.contains(format) ? format : "html"
        let b = build(input, options)
        let L = labels(options.lang)
        let images = b.images.map(\.file)
        func make(_ value: NfcJSON, _ mime: String) -> Report { Report(kind: b.kind, format: fmt, value: value, mime: mime, title: b.title, summary: b.summary, images: images, files: b.files) }
        switch fmt {
        case "object": return make(.object(b.object), "application/json")
        case "array": return make(.array(rowsOf(b).map { ["section": .string($0.section), "field": .string($0.field), "value": .string($0.value)] }), "application/json")
        case "json": return make(.string(NfcJSON.object(b.object).pretty(indent: 2)), "application/json")
        case "text": return make(.string(textOf(b)), "text/plain")
        case "csv": return make(.string(csv([["section", "field", "value"]] + rowsOf(b).map { [$0.section, $0.field, $0.value] })), "text/csv")
        default: return make(.string(htmlOf(b, L, b.files)), "text/html")
        }
    }

    /// The rows of a report (the "array" format as values).
    public static func rows(_ input: NfcJSON?, options: Options = Options()) -> [Row] { rowsOf(build(input, options)) }

    /// The transaction history of an EMV read, every application's, as rows (with "application").
    public static func history(_ input: NfcJSON?) -> [NfcJSONObject] {
        guard let emv = classify(input).emv else { return [] }
        return emv.objects("apps").flatMap { a in
            a.objects("log").map { e in
                let app = !a.optString("label").isEmpty ? a.optString("label") : !a.optString("scheme").isEmpty ? a.optString("scheme") : a.optString("aid")
                var o: NfcJSONObject = ["application": .string(app)]
                for x in e { o[x.key] = x.value }
                return o
            }
        }
    }

    /// The pictures of a read — every one, JPEG 2000 included.
    public static func images(_ input: NfcJSON?) -> [File] {
        guard let d = classify(input).mrtd else { return [] }
        let all = d.objects("images")
        if !all.isEmpty { return all.map { File(name: $0.optString("name"), mime: $0.optString("mime"), data: $0.optString("data")) } }
        let mime = d.optString("photoMime")
        return !d.optString("photo").isEmpty && !mime.isEmpty ? [File(name: mime == "image/jp2" ? "face.jp2" : "face.jpg", mime: mime, data: d.optString("photo"))] : []
    }

    /// A standalone HTML document of the report (for a download): the fragment and its styles.
    public static func document(_ input: NfcJSON?, options: Options = Options()) -> String {
        let r = report(input, format: "html", options: options)
        return "<!doctype html><html lang=\"\(escapeHtml(String(options.lang.prefix(2))))\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>\(escapeHtml(r.title))</title><style>\(css)</style></head><body>\(r.text)</body></html>"
    }

    /// The report's look for a standalone file (the chat has its own, themed).
    public static let css = """
    body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1d1d1f;background:#fff}
    .m5h-report{max-width:880px}.m5h-head{margin-bottom:12px}.m5h-title{font-size:20px;font-weight:700}.m5h-sub,.m5h-muted{color:#6e6e73}
    .m5h-sec{margin:14px 0}.m5h-sec h4,.m5h-sec summary{font-size:15px;font-weight:650;margin:0 0 6px;cursor:default}
    .m5h-kv,.m5h-grid{border-collapse:collapse;width:100%}.m5h-kv th{text-align:left;font-weight:500;color:#6e6e73;width:34%;vertical-align:top;padding:3px 10px 3px 0}
    .m5h-kv td,.m5h-grid td,.m5h-grid th{padding:3px 8px;vertical-align:top;word-break:break-word}.m5h-grid th{text-align:left;border-bottom:1px solid #d2d2d7}
    .m5h-grid tr:nth-child(even) td{background:#f5f5f7}.m5h-grid td,.m5h-grid th{white-space:nowrap;word-break:normal}.m5h-kv--mono td,.m5h-mono,.m5h-pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
    .m5h-pre{white-space:pre-wrap;word-break:break-all;background:#f5f5f7;padding:8px;border-radius:6px}.m5h-scroll{overflow-x:auto}
    .m5h-id{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}.m5h-photos{display:flex;gap:12px;flex-wrap:wrap}
    .m5h-photo{margin:0;max-width:180px}.m5h-photo img{max-width:180px;max-height:240px;border-radius:6px;border:1px solid #d2d2d7}
    .m5h-photo figcaption{font-size:12px;color:#6e6e73}.m5h-ph{width:120px;height:150px;display:flex;align-items:center;justify-content:center;border:1px dashed #aaa;border-radius:6px;color:#6e6e73}
    .m5h-badge{display:inline-block;padding:0 6px;border-radius:9px;font-size:12px}.m5h-badge--ok{background:#d1f5d8;color:#0a6b25}.m5h-badge--err{background:#ffd6d6;color:#a30000}
    .m5h-files{margin:0;padding-left:18px}
    """
}
