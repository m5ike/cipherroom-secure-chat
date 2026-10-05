// The output views of a template run (6.10) — A/nfc/TemplateViews.java,
// apdu-templates.ts TEMPLATE_VIEWS: the same names and the same text on the
// web, Android and iOS:
//
//   io        every command and its response: "→ <hex>" / "← <hex> <SW> (<meaning>)"
//   raw       the responses only (hex + status word), one per line
//   json      the TemplateExchange array as JSON.stringify(exchanges, null, 2) writes it
//   readable  for people: the card, the EMV applications (PAN masked, expiry,
//             counters, the history — the card report), the e-ID holder and
//             document, and for any other card each step's answer decoded
//             (BER-TLV with the EMV names, DESFire's GetVersion, the status words)
//
// G-19: every view hides the card number — in the readable report AND in the io /
// raw / json transcript — unless the user asks for the full data (`full: true`).

import Foundation

public enum TemplateViews {
    public static let io = "io", raw = "raw", json = "json", readable = "readable"
    /// The views, in the order the switch shows them.
    public static let views = [io, raw, json, readable]

    /// The app's strings (design keys); a missing key (nil, empty or the key itself) falls back to English.
    public typealias Labels = (_ key: String) -> String?

    /// The view's text; `full`: the card number and track data as read (the user asked for them), else masked.
    public static func view(_ view: String?, _ r: TemplateRunResult, labels: Labels? = nil, full: Bool = false) -> String {
        switch view ?? "" {
        case io: return ioText(exchanges(r, full: full))
        case raw: return rawText(exchanges(r, full: full))
        case json: return jsonText(exchanges(r, full: full))
        default: return readableText(r, labels: labels, cards: true, full: full)
        }
    }

    /// The run's exchanges as a view shows them: masked (G-19) unless `full`.
    public static func exchanges(_ r: TemplateRunResult, full: Bool) -> [TemplateExchange] {
        if full { return r.exchanges }
        let m = Mask(pans: pans(r))
        return r.exchanges.map { e in TemplateExchange(step: e.step, label: e.label, op: e.op, command: e.command, response: m.hex(e.response), sw: e.sw, status: e.status, ms: e.ms) }
    }

    /* ------------------------------------------------------------ masking (G-19) */

    /// The card numbers a run read: the EMV applications', and every PAN or track in any answer.
    public static func pans(_ r: TemplateRunResult) -> [String] {
        var out = [String]()
        func add(_ p: String) { if !out.contains(p) { out.append(p) } }
        for a in (r.emv?.optArray("apps") ?? []).compactMap(\.objectValue) {
            let p = a.optString("pan")
            if p.fullMatch("\\d{12,19}") { add(p) }
        }
        for h in r.exchanges.map(\.response) + r.steps.map(\.data) { PanMask.pansInHex(h).forEach(add) }
        return out
    }

    /// Whether masking hides anything in this run (the app then offers the full data and says it is masked).
    public static func masks(_ r: TemplateRunResult) -> Bool {
        if !pans(r).isEmpty { return true }
        return r.exchanges.contains { PanMask.answerMasks($0.response) }
    }

    /// How a view hides the card number: in an answer (hex), in a decoded value, in text. Off: everything as read.
    struct Mask {
        let pans: [String]
        let on: Bool
        init(pans: [String]) { self.pans = pans; on = true }
        private init() { pans = []; on = false }
        static let off = Mask()

        /// An answer: its sensitive elements masked (when it is BER-TLV), then every PAN in BCD or ASCII hex.
        func hex(_ h: String) -> String { on && !h.isEmpty ? PanMask.maskAnswer(h, pans) : h }

        /// A value as text (a decoded element, a label): every PAN masked.
        func text(_ t: String) -> String {
            guard on else { return t }
            var s = t
            for p in pans { s = s.replacingOccurrences(of: p, with: PanMask.maskDigits(p)) }
            return s
        }

        /// An element's decoded value: a sensitive one shows only its masked hex.
        func value(_ tag: String, _ shown: String, _ hex: String) -> String { on && PanMask.sensitive.contains(tag) ? PanMask.maskValue(tag, hex) : text(shown) }
    }

    static func displayPan(_ pan: String) -> String { PanMask.maskPanDigits(pan, "•") }

    /// The `emv` object as a masked view shows it (the workbench draws it): no whole PAN, the sensitive
    /// elements masked, the records and the log's raw records masked.
    public static func maskedEmv(_ emv: NfcJSONObject?, pans: [String]) -> NfcJSONObject? {
        guard var out = emv else { return nil }
        let m = Mask(pans: pans)
        guard var apps = out.optArray("apps") else { return out }
        for i in apps.indices {
            guard var a = apps[i].objectValue else { continue }
            let pan = a.optString("pan")
            a.remove("pan")
            if !pan.isEmpty && a.optString("panMasked").isEmpty { a["panMasked"] = .string(displayPan(pan)) }
            for list in ["tags", "getData"] {
                guard var tags = a.optArray(list) else { continue }
                for j in tags.indices {
                    guard var t = tags[j].objectValue else { continue }
                    let tag = t.optString("tag"), hex = t.optString("hex")
                    t["value"] = .string(m.value(tag, t.optString("value"), hex))
                    t["hex"] = .string(PanMask.sensitive.contains(tag) ? PanMask.maskValue(tag, hex) : m.hex(hex))
                    tags[j] = .object(t)
                }
                a[list] = .array(tags)
            }
            if var recs = a.optArray("records") {
                for j in recs.indices { if var rec = recs[j].objectValue { rec["hex"] = .string(m.hex(rec.optString("hex"))); recs[j] = .object(rec) } }
                a["records"] = .array(recs)
            }
            if var log = a.optArray("log") {
                for j in log.indices { if var e = log[j].objectValue, e.has("raw") { e["raw"] = .string(m.hex(e.optString("raw"))); log[j] = .object(e) } }
                a["log"] = .array(log)
            }
            apps[i] = .object(a)
        }
        out["apps"] = .array(apps)
        return out
    }

    /* ------------------------------------------------------------ io / raw / json */

    static func answer(_ e: TemplateExchange) -> String {
        var sb = e.response
        if !e.sw.isEmpty { if !sb.isEmpty { sb += " " }; sb += e.sw }
        return sb
    }

    /// Every command and its response: "→ 00A4…" then "← 6F2E… 9000 (OK)".
    public static func ioText(_ xs: [TemplateExchange]) -> String {
        var lines = [String]()
        for e in xs {
            lines.append("→ " + e.command)
            let a = answer(e)
            lines.append("← " + (a.isEmpty ? "" : a + " ") + "(" + StatusWords.describe(e.sw) + ")")
        }
        return lines.joined(separator: "\n")
    }

    /// The responses only, one per line ("6F2E… 9000").
    public static func rawText(_ xs: [TemplateExchange]) -> String {
        xs.map { e in let a = answer(e); return a.isEmpty ? "(" + StatusWords.describe(e.sw) + ")" : a }.joined(separator: "\n")
    }

    /// The exchanges as JSON.stringify(exchanges, null, 2) writes them.
    public static func jsonText(_ xs: [TemplateExchange]) -> String { NfcJSON.array(xs.map(\.json)).pretty(indent: 2) }

    /* ------------------------------------------------------------ labels */

    /// English for every key the readable view uses (the design's en strings say the same).
    static let en: [String: String] = [
        // 6.6 keys the workbench already has.
        "nfc.emv.expiry": "Expiry", "nfc.emv.cardholder": "Cardholder", "nfc.emv.effective": "Effective", "nfc.emv.issuer": "Issuer country",
        "nfc.emv.panSeq": "PAN sequence", "nfc.emv.atc": "Transactions (ATC)", "nfc.emv.lastOnlineAtc": "Last online ATC", "nfc.emv.ptc": "PIN tries left",
        "nfc.emv.history": "Transaction history", "nfc.emv.noHistory": "The card keeps no transaction log (or it is not readable).", "nfc.emv.date": "Date",
        "nfc.emv.time": "Time", "nfc.emv.amount": "Amount", "nfc.emv.merchant": "Merchant", "nfc.emv.type": "Type", "nfc.emv.getData": "Counters (GET DATA)",
        "nfc.emv.tags": "Data elements", "nfc.emv.records": "Records", "nfc.emv.log": "log",
        "nfc.eid.docCode": "Document", "nfc.eid.docNumber": "Document number", "nfc.eid.nationality": "Nationality",
        "nfc.eid.issuer": "Issuing state", "nfc.eid.dobLabel": "Born", "nfc.eid.sex": "Sex", "nfc.eid.expiryLabel": "Expires", "nfc.eid.access": "Opened with",
        "nfc.eid.dataGroups": "Data groups", "nfc.eid.personal": "Personal details (DG11)", "nfc.eid.fullName": "Full name", "nfc.eid.otherNames": "Other names",
        "nfc.eid.personalNumber": "Personal number", "nfc.eid.fullDob": "Full date of birth", "nfc.eid.placeOfBirth": "Place of birth", "nfc.eid.address": "Address",
        "nfc.eid.telephone": "Telephone", "nfc.eid.profession": "Profession", "nfc.eid.titleField": "Title", "nfc.eid.summary": "Personal summary",
        "nfc.eid.otherDocs": "Other travel documents", "nfc.eid.custody": "Custody", "nfc.eid.document": "Document details (DG12)",
        "nfc.eid.issuingAuthority": "Issuing authority", "nfc.eid.dateOfIssue": "Date of issue", "nfc.eid.otherPersons": "Other persons",
        "nfc.eid.endorsements": "Endorsements", "nfc.eid.taxExit": "Tax / exit", "nfc.eid.personalized": "Personalized",
        "nfc.eid.personalizationDevice": "Personalization system", "nfc.eid.optional": "Optional details (DG13)", "nfc.eid.notify": "Persons to notify (DG16)",
        "nfc.eid.security": "Security", "nfc.eid.passive": "Passive authentication", "nfc.eid.passiveOk": "every group read matches EF.SOD",
        "nfc.eid.passiveBad": "a group does NOT match EF.SOD", "nfc.eid.passiveNone": "not checked", "nfc.eid.hash": "Hash", "nfc.eid.signer": "Document signer",
        "nfc.eid.signedBy": "Signed by", "nfc.eid.validity": "Valid", "nfc.eid.serial": "Serial number", "nfc.eid.protocols": "Protocols",
        "nfc.eid.aaKey": "Active Authentication key", "nfc.eid.lds": "LDS version", "nfc.eid.unicode": "Unicode version", "nfc.eid.files": "Files",
        "nfc.eid.st.read": "read", "nfc.eid.st.protected": "protected (EAC)", "nfc.eid.st.absent": "absent", "nfc.eid.st.error": "error",
        "nfc.eid.images": "Pictures", "nfc.eid.img.face": "Face", "nfc.eid.img.portrait": "Portrait", "nfc.eid.img.signature": "Signature",
        "nfc.eid.img.document": "Document", "nfc.eid.img.other": "Picture",
        // 6.10 (design-610-nfc.ts).
        "nfc.tpl.r.card": "Card", "nfc.tpl.r.tech": "Technology", "nfc.tpl.r.aids": "Applications on the card", "nfc.tpl.r.read": "Read",
        "nfc.tpl.r.deep": "every file", "nfc.tpl.r.afl": "AFL records", "nfc.tpl.r.app": "Application",
        "nfc.tpl.r.label": "Label", "nfc.tpl.r.scheme": "Scheme", "nfc.tpl.r.pan": "Card number", "nfc.tpl.r.currency": "Currency",
        "nfc.tpl.r.country": "Country", "nfc.tpl.r.result": "Result", "nfc.tpl.r.logSfi": "Log file (SFI)", "nfc.tpl.r.logFormat": "Log format",
        "nfc.tpl.r.holder": "Holder", "nfc.tpl.r.name": "Name", "nfc.tpl.r.optionalData": "Optional data", "nfc.tpl.r.mrz": "MRZ",
        "nfc.tpl.r.file": "File", "nfc.tpl.r.status": "Status", "nfc.tpl.r.size": "Size", "nfc.tpl.r.message": "Message",
        "nfc.tpl.r.command": "Command", "nfc.tpl.r.response": "Response", "nfc.tpl.r.text": "Text",
        "nfc.tpl.r.steps": "Steps", "nfc.tpl.r.total": "{0} commands · {1} s", "nfc.tpl.r.cancelled": "Cancelled — this is what was read before.",
        "nfc.tpl.r.stopped": "The read stopped: {0}", "nfc.tpl.r.none": "none",
        "nfc.tpl.r.desfire": "MIFARE DESFire", "nfc.tpl.r.vendor": "Vendor", "nfc.tpl.r.product": "Product", "nfc.tpl.r.hw": "Hardware",
        "nfc.tpl.r.sw": "Software", "nfc.tpl.r.storage": "Storage", "nfc.tpl.r.protocol": "Protocol", "nfc.tpl.r.batch": "Batch",
        "nfc.tpl.r.produced": "Produced", "nfc.tpl.r.week": "week {0} of {1}", "nfc.tpl.r.apps": "Applications (AIDs)",
        "nfc.tpl.r.free": "Free memory", "nfc.tpl.r.keys": "Key settings (PICC)", "nfc.tpl.r.keyCount": "{0} key(s), {1}",
        "nfc.tpl.r.ks.change": "master key changeable", "nfc.tpl.r.ks.list": "applications listed without a key",
        "nfc.tpl.r.ks.create": "applications created without a key", "nfc.tpl.r.ks.config": "settings changeable", "nfc.tpl.r.ks.frozen": "settings frozen",
        "nfc.tpl.n.dir": "{0} application(s) listed", "nfc.tpl.n.noDir": "no directory on the card", "nfc.tpl.n.selected": "selected: {0}",
        "nfc.tpl.n.notSelected": "not on the card — its steps were skipped", "nfc.tpl.n.noAid": "no application to select",
        "nfc.tpl.n.getData": "{0} of {1} answered", "nfc.tpl.n.noLog": "the card keeps no transaction log", "nfc.tpl.n.log": "{0} entries",
        "nfc.tpl.n.gpo": "AIP {0} · AFL {1}", "nfc.tpl.n.gpoRefused": "the card refused GET PROCESSING OPTIONS", "nfc.tpl.n.noAfl": "no AFL (GPO gave none)",
        "nfc.tpl.n.records": "{0} record(s)", "nfc.tpl.n.apps": "{0} application(s) read", "nfc.tpl.n.unknownOp": "unknown operation {0}",
        "nfc.tpl.n.badCommand": "not a valid command", "nfc.tpl.n.lost": "the card stopped answering", "nfc.tpl.n.cancelled": "cancelled",
        "nfc.tpl.n.refused": "refused, never sent — {0}", "nfc.tpl.r.masked": "Card numbers and track data are masked.",
    ]

    struct L {
        let src: Labels?
        func t(_ key: String) -> String {
            let v = src?(key)
            if v == nil || v!.isEmpty || v == key { return TemplateViews.en[key] ?? key }
            return v!
        }
        func f(_ key: String, _ args: [String]) -> String {
            var s = t(key)
            for (i, a) in args.enumerated() { s = s.replacingOccurrences(of: "{\(i)}", with: a) }
            return s
        }
    }

    /* ------------------------------------------------------------ readable */

    /// A part of the readable text (card-report.ts textOf's sections).
    struct Section {
        let title: String
        var rows = [(String, String)]()
        var columns: [String]? = nil
        var table: [[String]]? = nil
        var pre: String? = nil, note: String? = nil
        init(_ title: String) { self.title = title }
        mutating func row(_ field: String, _ value: String?) { if let v = value, !v.isEmpty { rows.append((field, v)) } }
        var empty: Bool { rows.isEmpty && table == nil && pre == nil && note == nil }
    }

    /// The sections as plain text: a title over "=", each section over "-", fields aligned, tables in columns.
    static func text(_ title: String, _ subtitle: [String], _ sections: [Section]) -> String {
        var lines = [title, String(repeating: "=", count: min(72, max(8, JSText.length(title))))]
        for s in subtitle where !s.isEmpty { lines.append(s) }
        for s in sections where !s.empty {
            lines.append("")
            lines.append(s.title)
            lines.append(String(repeating: "-", count: min(72, JSText.length(s.title))))
            let w = min(28, s.rows.map { JSText.length($0.0) }.max() ?? 0)
            for r in s.rows { lines.append(JSText.padEnd(r.0, w) + "  " + r.1.replacingOccurrences(of: "\n", with: "\n" + String(repeating: " ", count: w + 2))) }
            if let table = s.table, let columns = s.columns {
                let widths = columns.indices.map { i in min(30, max(JSText.length(columns[i]), table.map { i < $0.count ? JSText.length($0[i]) : 0 }.max() ?? 0)) }
                lines.append(JSText.trimEnd(columns.indices.map { JSText.padEnd(columns[$0], widths[$0]) }.joined(separator: "  ")))
                lines.append(widths.map { String(repeating: "-", count: $0) }.joined(separator: "  "))
                for r in table {
                    let cells = widths.indices.map { i -> String in
                        let c = i < r.count ? r[i] : ""
                        return JSText.padEnd(JSText.prefix(c, 30), widths[i])
                    }
                    lines.append(JSText.trimEnd(cells.joined(separator: "  ")))
                }
            }
            if let p = s.pre { lines.append(p) }
            if let n = s.note { lines.append(n) }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// The run for people; `cards` false leaves out the EMV and e-ID sections (the workbench draws those itself);
    /// `full`: the card number and track data as read, else masked (G-19) and said so.
    public static func readableText(_ r: TemplateRunResult, labels: Labels? = nil, cards: Bool = true, full: Bool = false) -> String {
        let l = L(src: labels)
        let m = full ? Mask.off : Mask(pans: pans(r))
        var sections = [Section]()
        var subtitle = [String]()
        if !r.note.isEmpty { subtitle.append(r.note) }
        if !full && masks(r) { subtitle.append(l.t("nfc.tpl.r.masked")) }
        if let card = cardSection(l, r.cardInfo) { sections.append(card) }
        if cards, let e = r.emv { emv(l, e, &sections, m) }
        if cards, let d = r.mrtd { mrtd(l, d, &sections) }
        generic(l, r, &sections, m)
        sections.append(steps(l, r, m))
        return text(r.label, subtitle, sections)
    }

    static func cardSection(_ l: L, _ c: NfcJSONObject?) -> Section? {
        guard let c else { return nil }
        var s = Section(l.t("nfc.tpl.r.card"))
        s.row("UID", c.optString("uid"))
        s.row(l.t("nfc.tpl.r.tech"), c.optString("label", c.optString("tech")))
        s.row("ATQA", c.optString("atqa")); s.row("SAK", c.optString("sak")); s.row("ATS", c.optString("ats")); s.row("ATR", c.optString("atr"))
        return s.empty ? nil : s
    }

    static func sym(_ status: String) -> String { status == "error" ? "✗" : status == "warn" ? "⚠" : "✓" }

    static func steps(_ l: L, _ r: TemplateRunResult, _ m: Mask) -> Section {
        var s = Section(l.t("nfc.tpl.r.steps") + " (\(r.steps.count))")
        for x in r.steps {
            var note = x.noteKey.map { l.f($0, x.noteArgs) } ?? x.note
            if x.op.isEmpty && !x.sw.isEmpty && x.noteKey == nil { note = x.sw + " " + StatusWords.describe(x.sw) }
            s.rows.append(("\(x.step) \(sym(x.status))", m.text(x.label + ((note ?? "").isEmpty ? "" : " — " + note!))))
        }
        s.rows.append(("Σ", l.f("nfc.tpl.r.total", [String(r.exchanges.count), String(format: "%.1f", Double(r.ms) / 1000.0)])))
        if r.cancelled { s.note = l.t("nfc.tpl.r.cancelled") } else if let e = r.error { s.note = l.f("nfc.tpl.r.stopped", [e]) }
        return s
    }

    /* ------------------------------------------------------------ EMV (card-report.ts buildEmv) */

    static func emv(_ l: L, _ d: NfcJSONObject, _ out: inout [Section], _ m: Mask) {
        let apps = (d.optArray("apps") ?? []).compactMap(\.objectValue)
        var head = Section(l.t("nfc.tpl.r.aids"))
        let list = (d.optArray("aids") ?? []).map(\.jsString).joined(separator: ", ")
        head.row("AID", list.isEmpty ? "—" : list)
        let apdus = d.optInt("apdus")
        head.row(l.t("nfc.tpl.r.read"), l.t(d.optBool("deep") ? "nfc.tpl.r.deep" : "nfc.tpl.r.afl") + (apdus > 0 ? " · \(apdus) APDU" : ""))
        out.append(head)
        for (i, a) in apps.enumerated() {
            let name = a.optString("label").isEmpty ? a.optString("scheme", a.optString("aid")) : a.optString("label")
            let n = apps.count > 1 ? " \(i + 1) — \(name)" : " — \(name)"
            var s = Section(l.t("nfc.tpl.r.app") + n)
            s.row("AID", a.optString("aid")); s.row(l.t("nfc.tpl.r.label"), a.optString("label")); s.row(l.t("nfc.tpl.r.scheme"), a.optString("scheme"))
            var pan = m.on ? a.optString("panMasked") : a.optString("pan", a.optString("panMasked"))
            if pan.isEmpty && !a.optString("pan").isEmpty { pan = displayPan(a.optString("pan")) }
            s.row(l.t("nfc.tpl.r.pan"), pan); s.row(l.t("nfc.emv.expiry"), a.optString("expiry")); s.row(l.t("nfc.emv.effective"), a.optString("effective"))
            s.row(l.t("nfc.emv.cardholder"), a.optString("cardholder")); s.row(l.t("nfc.emv.issuer"), a.optString("issuerCountry"))
            s.row(l.t("nfc.emv.panSeq"), a.optString("panSequence"))
            if a.has("atc") { s.row(l.t("nfc.emv.atc"), String(a.optInt("atc"))) }
            if a.has("lastOnlineAtc") { s.row(l.t("nfc.emv.lastOnlineAtc"), String(a.optInt("lastOnlineAtc"))) }
            if a.has("pinTryCounter") { s.row(l.t("nfc.emv.ptc"), String(a.optInt("pinTryCounter"))) }
            s.row("AIP", a.optString("aip")); s.row("AFL", a.optString("afl"))
            if a.has("logSfi") { s.row(l.t("nfc.tpl.r.logSfi"), String(a.optInt("logSfi"))) }
            s.row(l.t("nfc.tpl.r.logFormat"), a.optString("logFormat"))
            out.append(s)
            // The history.
            let log = (a.optArray("log") ?? []).compactMap(\.objectValue)
            if a.has("logSfi") || !log.isEmpty {
                var h = Section(l.t("nfc.emv.history") + n + " (\(log.count))")
                if log.isEmpty { h.note = l.t("nfc.emv.noHistory") } else {
                    let cols: [(String, String)] = [("date", "nfc.emv.date"), ("time", "nfc.emv.time"), ("amount", "nfc.emv.amount"), ("currency", "nfc.tpl.r.currency"),
                                                    ("merchant", "nfc.emv.merchant"), ("type", "nfc.emv.type"), ("country", "nfc.tpl.r.country"), ("atc", "ATC"), ("cid", "nfc.tpl.r.result")]
                    let used = cols.filter { c in log.contains { !$0.optString(c.0).isEmpty } }
                    var extra = [String]()
                    for e in log { for k in e.keys where k != "raw" && !cols.contains(where: { $0.0 == k }) && !extra.contains(k) { extra.append(k) } }
                    h.columns = used.map { $0.1.hasPrefix("nfc.") ? l.t($0.1) : $0.1 } + extra
                    h.table = log.map { e in used.map { e.optString($0.0) } + extra.map { e.optString($0) } }
                }
                out.append(h)
            }
            let gd = (a.optArray("getData") ?? []).compactMap(\.objectValue)
            if !gd.isEmpty {
                var g = Section(l.t("nfc.emv.getData") + n)
                for t in gd { g.rows.append((t.optString("tag") + " " + t.optString("name"), m.value(t.optString("tag"), t.optString("value"), t.optString("hex")))) }
                out.append(g)
            }
            let tags = (a.optArray("tags") ?? []).compactMap(\.objectValue)
            if !tags.isEmpty {
                var t = Section(l.t("nfc.emv.tags") + n + " (\(tags.count))")
                for tg in tags {
                    let v = tg.optString("value"), hx = tg.optString("hex"), tag = tg.optString("tag")
                    let shown = m.on && PanMask.sensitive.contains(tag) ? PanMask.maskValue(tag, hx) : v == hx ? m.hex(hx) : m.text(v) + "  (" + m.hex(hx) + ")"
                    t.rows.append((tag + " " + tg.optString("name"), shown))
                }
                out.append(t)
            }
            let recs = (a.optArray("records") ?? []).compactMap(\.objectValue)
            if !recs.isEmpty {
                var rs = Section(l.t("nfc.emv.records") + n + " (\(recs.count))")
                rs.pre = recs.map { rec in
                    String(format: "SFI %2d · %2d", rec.optInt("sfi"), rec.optInt("record")) + (rec.optBool("log") ? " (" + l.t("nfc.emv.log") + ")" : "") + "  " + m.hex(rec.optString("hex"))
                }.joined(separator: "\n")
                out.append(rs)
            }
        }
    }

    /* ------------------------------------------------------------ e-ID (card-report.ts buildMrtd) */

    static func joined(_ o: NfcJSONObject, _ key: String) -> String {
        if let arr = o.optArray(key) { return arr.map(\.jsString).joined(separator: "; ") }
        return o.optString(key)
    }

    static func sizeText(_ n: Int) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return n < 10_240 ? String(format: "%.1f kB", Double(n) / 1024.0) : "\(n / 1024) kB" }
        return String(format: "%.1f MB", Double(n) / 1024.0 / 1024.0)
    }

    static func b64Size(_ b64: String) -> Int { b64.utf8.count * 3 / 4 - (b64.hasSuffix("==") ? 2 : b64.hasSuffix("=") ? 1 : 0) }

    static func mrzLines(_ mrz: String) -> String {
        let flat = mrz.replacingOccurrences(of: "\n", with: "")
        let s = Bac.sub
        if mrz.contains("\n") { return mrz }
        switch flat.count {
        case 88: return s(flat, 0, 44) + "\n" + s(flat, 44, 88)
        case 90: return s(flat, 0, 30) + "\n" + s(flat, 30, 60) + "\n" + s(flat, 60, 90)
        case 72: return s(flat, 0, 36) + "\n" + s(flat, 36, 72)
        default: return flat
        }
    }

    static func mrtd(_ l: L, _ d: NfcJSONObject, _ out: inout [Section]) {
        let m = d.optObject("mrzInfo") ?? NfcJSONObject()
        var h = Section(l.t("nfc.tpl.r.holder"))
        h.row(l.t("nfc.eid.docCode"), m.optString("documentCode"))
        h.row(l.t("nfc.eid.docNumber"), m.optString("documentNumber"))
        h.row(l.t("nfc.tpl.r.name"), JSText.trim(m.optString("givenNames") + " " + m.optString("surname")))
        h.row(l.t("nfc.eid.nationality"), m.optString("nationality"))
        h.row(l.t("nfc.eid.dobLabel"), m.optString("dateOfBirth"))
        h.row(l.t("nfc.eid.sex"), m.optString("sex"))
        h.row(l.t("nfc.eid.expiryLabel"), m.optString("dateOfExpiry"))
        h.row(l.t("nfc.eid.issuer"), m.optString("issuer"))
        h.row(l.t("nfc.tpl.r.optionalData"), m.optString("optionalData"))
        let access = d.optString("access", "none")
        let pace = d.optObject("pace")
        let how: String
        if access == "pace" {
            let pw = pace?.optString("password") ?? "", proto = pace?.optString("protocol") ?? ""
            how = "PACE" + (pw.isEmpty ? "" : " (\(JSText.upperASCII(pw)))") + (proto.isEmpty ? "" : " · \(proto)")
        } else { how = access == "bac" ? "BAC (MRZ)" : "—" }
        h.row(l.t("nfc.eid.access"), how)
        h.row(l.t("nfc.eid.dataGroups"), joined(d, "dataGroups").replacingOccurrences(of: "; ", with: ", "))
        if !d.has("mrzInfo") { h.row(l.t("nfc.tpl.r.message"), d.optString("message")) }
        out.append(h)
        let mrz = m.optString("mrz")
        if !mrz.isEmpty { var z = Section(l.t("nfc.tpl.r.mrz")); z.pre = mrzLines(mrz); out.append(z) }
        if let p = d.optObject("personal"), !p.isEmpty {
            var s = Section(l.t("nfc.eid.personal"))
            let keys = [("fullName", "nfc.eid.fullName"), ("otherNames", "nfc.eid.otherNames"), ("personalNumber", "nfc.eid.personalNumber"),
                        ("fullDateOfBirth", "nfc.eid.fullDob"), ("placeOfBirth", "nfc.eid.placeOfBirth"), ("address", "nfc.eid.address"), ("telephone", "nfc.eid.telephone"),
                        ("profession", "nfc.eid.profession"), ("title", "nfc.eid.titleField"), ("personalSummary", "nfc.eid.summary"),
                        ("otherTravelDocuments", "nfc.eid.otherDocs"), ("custody", "nfc.eid.custody")]
            for k in keys { s.row(l.t(k.1), joined(p, k.0)) }
            out.append(s)
        }
        if let doc = d.optObject("document"), !doc.isEmpty {
            var s = Section(l.t("nfc.eid.document"))
            let keys = [("issuingAuthority", "nfc.eid.issuingAuthority"), ("dateOfIssue", "nfc.eid.dateOfIssue"), ("otherPersons", "nfc.eid.otherPersons"),
                        ("endorsements", "nfc.eid.endorsements"), ("taxExit", "nfc.eid.taxExit"), ("personalizationTime", "nfc.eid.personalized"),
                        ("personalizationDevice", "nfc.eid.personalizationDevice")]
            for k in keys { s.row(l.t(k.1), joined(doc, k.0)) }
            out.append(s)
        }
        if !d.optString("optional").isEmpty { var s = Section(l.t("nfc.eid.optional")); s.pre = d.optString("optional"); out.append(s) }
        if let notify = d.optArray("personsToNotify"), !notify.isEmpty {
            var s = Section(l.t("nfc.eid.notify"))
            for (i, n) in notify.enumerated() { s.row("#\(i + 1)", n.jsString) }
            out.append(s)
        }
        if let sec = d.optObject("security"), !sec.isEmpty {
            var s = Section(l.t("nfc.eid.security"))
            let passive = sec.optString("passive")
            s.row(l.t("nfc.eid.passive"), passive == "ok" ? "✓ " + l.t("nfc.eid.passiveOk") : passive == "mismatch" ? "✗ " + l.t("nfc.eid.passiveBad") : l.t("nfc.eid.passiveNone"))
            s.row(l.t("nfc.eid.hash"), sec.optString("hashAlgorithm"))
            if let signer = sec.optObject("signer") {
                s.row(l.t("nfc.eid.signer"), signer.optString("subject"))
                s.row(l.t("nfc.eid.signedBy"), signer.optString("issuer"))
                if !signer.optString("notBefore").isEmpty || !signer.optString("notAfter").isEmpty {
                    s.row(l.t("nfc.eid.validity"), signer.optString("notBefore", "?") + " – " + signer.optString("notAfter", "?"))
                }
                s.row(l.t("nfc.eid.serial"), signer.optString("serial"))
            }
            s.row(l.t("nfc.eid.protocols"), joined(sec, "protocols").replacingOccurrences(of: "; ", with: ", "))
            s.row(l.t("nfc.eid.aaKey"), sec.optString("activeAuthKey"))
            s.row(l.t("nfc.eid.lds"), d.optString("ldsVersion"))
            s.row(l.t("nfc.eid.unicode"), d.optString("unicodeVersion"))
            out.append(s)
        }
        if let files = d.optArray("files"), !files.isEmpty {
            var s = Section(l.t("nfc.eid.files"))
            s.columns = [l.t("nfc.tpl.r.file"), "FID", l.t("nfc.tpl.r.status"), l.t("nfc.tpl.r.size"), l.t("nfc.eid.hash")]
            s.table = files.compactMap(\.objectValue).map { f in
                let st = f.optString("status", "error")
                let key = st == "read" ? "nfc.eid.st.read" : st == "protected" ? "nfc.eid.st.protected" : st == "absent" ? "nfc.eid.st.absent" : "nfc.eid.st.error"
                let stText = l.t(key) + (f.optString("message").isEmpty ? "" : " — " + f.optString("message"))
                return [f.optString("name"), f.optString("fid"), stText, f.has("size") ? sizeText(f.optInt("size")) : "",
                        f.has("hashOk") ? (f.optBool("hashOk") ? "✓" : "✗") : ""]
            }
            out.append(s)
        }
        if let images = d.optArray("images"), !images.isEmpty {
            var s = Section(l.t("nfc.eid.images"))
            for img in images.compactMap(\.objectValue) {
                let kind = img.optString("kind")
                let k = kind == "face" ? "nfc.eid.img.face" : kind == "portrait" ? "nfc.eid.img.portrait" : kind == "signature" ? "nfc.eid.img.signature"
                    : kind == "document" ? "nfc.eid.img.document" : "nfc.eid.img.other"
                s.row(l.t(k) + " · " + img.optString("group"), img.optString("name") + " · " + img.optString("mime") + " · " + sizeText(b64Size(img.optString("data"))))
            }
            out.append(s)
        }
    }

    /* ------------------------------------------------------------ any other card */

    /// ISO 7816-4 names the EMV dictionary lacks (EF.DIR, EF.ATR, FCP).
    static let isoTags: [String: String] = [
        "43": "Card service data", "46": "Pre-issuing data", "47": "Card capabilities", "51": "Path", "52": "Command to perform",
        "53": "Discretionary data", "62": "File control parameters (FCP)", "64": "File management data (FMD)", "73": "Discretionary data objects",
        "83": "File identifier", "8A": "Life cycle status", "7F66": "Extended length information", "78": "Compatible tag allocation authority",
        "4D": "Extended header list", "5F52": "Historical bytes",
    ]

    static func tagName(_ tag: String) -> String {
        let info = EmvTags.info(tag)
        if !info.name.hasPrefix("Tag ") { return info.name }
        return isoTags[tag] ?? ""
    }

    /// Whether `b` is BER-TLV through and through (padding aside), so a decode is not a guess.
    public static func isTlv(_ b: [UInt8]) -> Bool { PanMask.isTlv(b) }

    static func printable(_ v: [UInt8]) -> Bool { !v.isEmpty && v.allSatisfy { $0 >= 0x20 && $0 < 0x7f } }

    /// A BER-TLV tree, one element per line, with the EMV (and ISO 7816) names and the values formatted.
    static func tlvText(_ data: [UInt8], _ m: Mask = .off) -> String {
        var lines = [String]()
        tlvLines(BerTlv.decode(data, recurse: true), 0, &lines, m)
        return lines.joined(separator: "\n")
    }

    static func tlvLines(_ nodes: [Tlv], _ depth: Int, _ out: inout [String], _ m: Mask) {
        for n in nodes {
            let tag = Hex.encode(n.tagBytes)
            let name = tagName(tag)
            let head = String(repeating: " ", count: depth * 2) + tag + (name.isEmpty ? "" : " " + name)
            if n.constructed, let c = n.children, !c.isEmpty { out.append(head); tlvLines(c, depth + 1, &out, m); continue }
            let hx = Hex.encode(n.value)
            let shown: String
            if m.on && PanMask.sensitive.contains(tag) { shown = PanMask.maskValue(tag, hx) } else {
                let info = EmvTags.info(tag)
                let v = info.name.hasPrefix("Tag ") ? hx : EmvReader.formatValue(tag, n.value, info.format)
                shown = v == hx ? m.hex(hx) + (printable(n.value) ? "  \"" + m.text(Bytes.asciiString(n.value)) + "\"" : "") : m.text(v) + "  (" + m.hex(hx) + ")"
            }
            out.append(head + ": " + shown)
        }
    }

    /// Each fixed command's answer, decoded; a DESFire's GetVersion as the chip it describes.
    static func generic(_ l: L, _ r: TemplateRunResult, _ out: inout [Section], _ m: Mask) {
        if let d = desfire(l, r) { out.append(d) }
        for x in r.steps where x.op.isEmpty && !x.command.isEmpty {
            var s = Section("\(x.step). \(x.label)")
            s.row(l.t("nfc.tpl.r.command"), x.command)
            s.row(l.t("nfc.tpl.r.response"), m.hex(x.data))
            if let k = x.noteKey { s.row(l.t("nfc.tpl.r.status"), sym(x.status) + " " + l.f(k, x.noteArgs)) }
            else { s.row(l.t("nfc.tpl.r.status"), x.sw.isEmpty ? StatusWords.describe("") : sym(x.status) + " " + x.sw + " — " + StatusWords.describe(x.sw)) }
            let data = Hex.decode(x.data)
            if !data.isEmpty {
                if isTlv(data) { s.pre = tlvText(data, m) } else if printable(data) { s.row(l.t("nfc.tpl.r.text"), m.text(Bytes.asciiString(data))) }
            }
            out.append(s)
        }
    }

    /* ------------------------------------------------------------ DESFire */

    static func byCommand(_ steps: [TemplateStepResult], _ from: Int, _ command: String) -> Int? {
        guard from < steps.count else { return nil }
        return (from..<steps.count).first { steps[$0].op.isEmpty && steps[$0].command == command }
    }

    /// The storage byte of GetVersion: 2^n bytes, or between 2^n and 2^(n+1) when its lowest bit is set.
    public static func storage(_ b: Int) -> String { Desfire.storageText(b) }

    /// MIFARE DESFire generations by the hardware type and major version (NXP AN12343 / AN12752).
    public static func product(_ type: Int, _ major: Int) -> String { Desfire.product(type: type, major: major) }

    static func desfire(_ l: L, _ r: TemplateRunResult) -> Section? {
        let st = r.steps
        guard let v = byCommand(st, 0, "9060000000") else { return nil }
        let hw = Hex.decode(st[v].data)
        guard hw.count >= 7 else { return nil }
        var s = Section(l.t("nfc.tpl.r.desfire"))
        s.row(l.t("nfc.tpl.r.vendor"), hw[0] == 0x04 ? "NXP" : String(format: "%02X", hw[0]))
        s.row(l.t("nfc.tpl.r.product"), product(Int(hw[1]), Int(hw[3])))
        s.row(l.t("nfc.tpl.r.hw"), String(format: "%d.%d (type %02X, subtype %02X)", hw[3], hw[4], hw[1], hw[2]))
        s.row(l.t("nfc.tpl.r.storage"), storage(Int(hw[5])))
        s.row(l.t("nfc.tpl.r.protocol"), String(format: "%02X", hw[6]) + (hw[6] == 0x05 ? " (ISO/IEC 14443-2 / -3)" : ""))
        if let swStep = byCommand(st, v + 1, "90AF000000") {
            let sw = Hex.decode(st[swStep].data)
            if sw.count >= 7 { s.row(l.t("nfc.tpl.r.sw"), "\(sw[3]).\(sw[4])") }
            let id = byCommand(st, swStep + 1, "90AF000000").map { Hex.decode(st[$0].data) } ?? []
            if id.count >= 14 {
                s.row("UID", Hex.encode(id[0..<7]))
                s.row(l.t("nfc.tpl.r.batch"), Hex.encode(id[7..<12]))
                let week = Desfire.bcd(Int(id[12])), year = Desfire.bcd(Int(id[13]))
                if week > 0 || year > 0 { s.row(l.t("nfc.tpl.r.produced"), l.f("nfc.tpl.r.week", [String(week), String(2000 + year)])) }
            }
        }
        if let apps = byCommand(st, 0, "906A000000"), st[apps].sw.hasPrefix("91") {
            let aids = Desfire.applicationIds(Hex.decode(st[apps].data))
            s.row(l.t("nfc.tpl.r.apps"), aids.isEmpty ? l.t("nfc.tpl.r.none") : aids.joined(separator: ", ") + (st[apps].sw == "91AF" ? ", …" : ""))
        }
        if let free = byCommand(st, 0, "906E000000"), st[free].sw == "9100", let bytes = Desfire.freeMemory(Hex.decode(st[free].data)) {
            s.row(l.t("nfc.tpl.r.free"), "\(bytes) B")
        }
        if let keys = byCommand(st, 0, "9045000000"), st[keys].sw == "9100", let ks = Desfire.KeySettings(Hex.decode(st[keys].data)) {
            var flags = [String]()
            if ks.masterKeyChangeable { flags.append(l.t("nfc.tpl.r.ks.change")) }
            if ks.freeDirectoryList { flags.append(l.t("nfc.tpl.r.ks.list")) }
            if ks.freeCreateDelete { flags.append(l.t("nfc.tpl.r.ks.create")) }
            flags.append(l.t(ks.configurationChangeable ? "nfc.tpl.r.ks.config" : "nfc.tpl.r.ks.frozen"))
            s.row(l.t("nfc.tpl.r.keys"), String(format: "%02X · ", ks.settings) + l.f("nfc.tpl.r.keyCount", [String(ks.keyCount), ks.crypto]) + "\n" + flags.joined(separator: ", "))
        }
        return s
    }
}
