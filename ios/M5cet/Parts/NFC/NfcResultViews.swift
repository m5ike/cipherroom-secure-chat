// What the workbench shows of a card — Android NfcWorkbench's drawCardInfo,
// showCard's op result, emvApp (6.6: fields, counters, the transaction history
// as a table, GET DATA, the elements and the records), drawMrtd (the holder
// beside the face, DG11 / DG12 / DG13 / DG16, every picture, the security
// objects, the files), the M5Cet card's records and a template run's output.
// Pictures in JPEG 2000 are shown too (ImageIO decodes them; Android could not).

import M5Core
import M5NFC
import SwiftUI

/// The detected card (Android drawCardInfo): label, UID, SAK · ATQA · ATS, memory, the selected application.
struct NfcCardInfoView: View {
    let card: CardIdentity
    let palette: NfcPalette

    var body: some View {
        NfcCardBox(palette: palette) {
            NfcText(text: card.label, size: 16, color: palette.fg, bold: true, family: palette.family)
            if !card.uid.isEmpty { NfcText(text: "UID " + card.uid, size: 13, color: palette.muted, family: palette.family) }
            let meta = [card.sak.map { "SAK " + $0 }, card.atqa.map { "ATQA " + $0 }, card.ats.map { "ATS " + $0 }].compactMap { $0 }.filter { $0.count > 5 }
            if !meta.isEmpty { NfcText(text: meta.joined(separator: " · "), size: 12, color: palette.muted, family: palette.family) }
            if let m = card.memory, !m.isEmpty { NfcText(text: m, size: 12, color: palette.muted, family: palette.family) }
            if let aid = card.selectedAid, !aid.isEmpty { NfcText(text: "AID " + aid, size: 12, color: palette.muted, family: palette.family) }
        }
        .accessibilityIdentifier("nfc.card")
    }
}

/// An op's output (Android showCard's result box): ✓ done, a note, ← the APDU answer, the rest as JSON.
struct NfcOpResultView: View {
    let output: NfcJSONObject
    let palette: NfcPalette

    var body: some View {
        NfcCardBox(palette: palette) {
            if output.has("done") { NfcText(text: "✓ " + output.optString("done"), size: 14, color: palette.success, bold: true, family: palette.family) }
            if output.has("note") { NfcText(text: output.optString("note"), size: 13, color: palette.muted, family: palette.family) }
            if output.has("apdu") { NfcText(text: "← " + output.optString("apdu"), size: 13, color: palette.fg, family: palette.family) }
            if !output.has("done") || output.count > 1 {
                let s = output.compact
                NfcText(text: s.count > 1600 ? String(s.prefix(1600)) + "…" : s, size: 12, color: palette.muted, mono: true, selectable: true)
                    .padding(.top, 6)
            }
        }
        .accessibilityIdentifier("nfc.result")
    }
}

/// One EMV application (Android emvApp).
struct NfcEmvAppView: View {
    let app: NfcJSONObject
    let words: NfcWords
    let palette: NfcPalette

    var body: some View {
        let p = palette
        let head = app.optString("scheme", app.optString("label", app.optString("aid")))
        NfcCardBox(palette: p) {
            NfcText(text: head, size: 16, color: p.fg, bold: true, family: p.family)
            if !app.optString("label").isEmpty && app.optString("label") != head { NfcText(text: app.optString("label"), size: 13, color: p.muted, family: p.family) }
            field("PAN", app.optString("panMasked", app.optString("pan")), p.fg)
            field(words("nfc.emv.expiry"), app.optString("expiry"), p.fg)
            field(words("nfc.emv.cardholder"), app.optString("cardholder"), p.fg)
            field(words("nfc.emv.effective"), app.optString("effective"), p.fg)
            field(words("nfc.emv.issuer"), app.optString("issuerCountry"), p.fg)
            field(words("nfc.emv.panSeq"), app.optString("panSequence"), p.fg)
            if app.has("atc") { field(words("nfc.emv.atc"), String(app.optInt64("atc")), p.fg) }
            if app.has("lastOnlineAtc") { field(words("nfc.emv.lastOnlineAtc"), String(app.optInt64("lastOnlineAtc")), p.fg) }
            if app.has("pinTryCounter") { field(words("nfc.emv.ptc"), String(app.optInt64("pinTryCounter")), p.fg) }
            field("AID", app.optString("aid"), p.muted)
            field("AIP", app.optString("aip"), p.muted)
            field("AFL", app.optString("afl"), p.muted)

            // The transaction history (newest first, as the card keeps it).
            let log = app.objects("log")
            NfcSectionTitle(text: words("nfc.emv.history") + (log.isEmpty ? "" : " (\(log.count))"), palette: p)
            if log.isEmpty {
                NfcText(text: words("nfc.emv.noHistory"), size: 12, color: p.muted, family: p.family)
            } else {
                NfcTable(head: [words("nfc.emv.date"), words("nfc.emv.time"), words("nfc.emv.amount"), words("nfc.emv.merchant"), words("nfc.emv.type")],
                         weights: [1.25, 0.95, 1.2, 1.4, 1],
                         rows: log.map { e in [e.optString("date"), e.optString("time"), (e.optString("amount") + " " + e.optString("currency")).trimmingCharacters(in: .whitespaces),
                                               e.optString("merchant"), e.optString("type")] },
                         endColumn: 2, palette: p)
                    .accessibilityIdentifier("nfc.emv.history")
                if app.has("logSfi") {
                    NfcText(text: "SFI \(app.optInt("logSfi"))" + (app.optString("logFormat").isEmpty ? "" : " · " + app.optString("logFormat")), size: 11, color: p.muted, family: p.family)
                }
            }

            // What GET DATA answered (counters, the log entry and format, balances).
            let gd = app.objects("getData")
            if !gd.isEmpty {
                NfcSectionTitle(text: words("nfc.emv.getData"), palette: p)
                ForEach(Array(gd.enumerated()), id: \.offset) { _, g in
                    NfcText(text: g.optString("tag") + "  " + g.optString("name") + ": " + g.optString("value"), size: 12, color: p.fg, mono: true)
                }
            }
            let tags = app.objects("tags")
            if !tags.isEmpty {
                NfcCollapsible(title: words("nfc.emv.tags") + " (\(tags.count))", palette: p) {
                    ForEach(Array(tags.enumerated()), id: \.offset) { _, t in
                        NfcText(text: t.optString("tag") + "  " + t.optString("name") + ": " + t.optString("value"), size: 12, color: p.muted, mono: true)
                    }
                }
            }
            let recs = app.objects("records")
            if !recs.isEmpty {
                NfcCollapsible(title: words("nfc.emv.records") + " (\(recs.count))", palette: p) {
                    ForEach(Array(recs.enumerated()), id: \.offset) { _, r in
                        NfcText(text: "SFI \(r.optInt("sfi")) · #\(r.optInt("record"))" + (r.optBool("log") ? " · " + words("nfc.emv.log") : ""),
                                size: 12, color: p.fg, bold: true, family: p.family)
                            .padding(.top, 6)
                        NfcText(text: NfcResultFormat.spaced(r.optString("hex")), size: 11, color: p.muted, mono: true)
                    }
                }
            }
        }
    }

    @ViewBuilder private func field(_ label: String, _ value: String, _ color: Color) -> some View {
        NfcField2(label: label, value: value, color: color, palette: palette)
    }
}

/// The EMV read (Android showEmv): every application, how it was read, the read-only note.
struct NfcEmvView: View {
    let emv: NfcJSONObject
    let words: NfcWords
    let palette: NfcPalette

    var body: some View {
        let apps = emv.objects("apps")
        if apps.isEmpty {
            NfcCardBox(palette: palette) {
                NfcText(text: EmvReader.summary(emv), size: 14, color: palette.fg, bold: true, family: palette.family)
                NfcText(text: words("nfc.readonly.help"), size: 12, color: palette.muted, family: palette.family)
            }
        } else {
            ForEach(Array(apps.enumerated()), id: \.offset) { _, a in NfcEmvAppView(app: a, words: words, palette: palette) }
            NfcCardBox(palette: palette) {
                if emv.has("apdus") {
                    NfcText(text: words.f(emv.optBool("deep") ? "nfc.emv.readDeep" : "nfc.emv.readAfl", String(emv.optInt("apdus"))), size: 12, color: palette.muted, family: palette.family)
                }
                NfcText(text: words("nfc.readonly.help"), size: 12, color: palette.muted, family: palette.family)
            }
        }
    }
}

/// The e-ID / MRTD read (Android drawMrtd): the holder beside the face, DG11 / DG12, DG13 / DG16, every picture,
/// the security objects, every file tried.
struct NfcMrtdView: View {
    let mrtd: NfcJSONObject
    let words: NfcWords
    let palette: NfcPalette

    var body: some View {
        let p = palette
        let m = mrtd.optObject("mrzInfo")
        let photo = mrtd.optString("photo")
        NfcCardBox(palette: p) {
            if let m {
                HStack(alignment: .top, spacing: 12) {
                    if !photo.isEmpty { NfcPictureView(base64: photo, mime: mrtd.optString("photoMime"), caption: nil, width: 104, words: words, palette: p) }
                    VStack(alignment: .leading, spacing: 2) {
                        let name = (m.optString("givenNames") + " " + m.optString("surname")).trimmingCharacters(in: .whitespaces)
                        NfcText(text: name.isEmpty ? words("nfc.eid.title") : name, size: 16, color: p.fg, bold: true, family: p.family)
                            .accessibilityIdentifier("nfc.eid.holder")
                        f("nfc.eid.docCode", m.optString("documentCode"))
                        f("nfc.eid.docNumber", m.optString("documentNumber"))
                        f("nfc.eid.nationality", m.optString("nationality"))
                        f("nfc.eid.issuer", m.optString("issuer"))
                        f("nfc.eid.dobLabel", m.optString("dateOfBirth"))
                        f("nfc.eid.sex", m.optString("sex"))
                        f("nfc.eid.expiryLabel", m.optString("dateOfExpiry"))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                NfcText(text: words("nfc.eid.title"), size: 16, color: p.fg, bold: true, family: p.family)
                NfcText(text: mrtd.optString("message", MrtdReader.summary(mrtd)), size: 13, color: p.muted, family: p.family)
            }
            // How the chip was opened: BAC, or PACE (and what the chip offers).
            let pace = mrtd.optObject("pace")
            if let how = Self.access(mrtd) {
                NfcField2(label: words("nfc.eid.access"), value: how, color: p.fg, palette: p)
            }
            if let pace, pace.optBool("supported"), !pace.optBool("used") {
                let offered = pace.optString("protocol", "PACE") + (pace.has("parameterId") ? " (\(Pace.parameterName(pace.optInt("parameterId"))))" : "")
                NfcField2(label: words("nfc.eid.paceOffered"), value: offered + " — " + words("nfc.eid.notUsed"), color: p.muted, palette: p)
            }
            let dg = mrtd.strings("dataGroups")
            if !dg.isEmpty { NfcField2(label: words("nfc.eid.dataGroups"), value: dg.joined(separator: ", "), color: p.muted, palette: p) }
            if m != nil, !mrtd.optString("message").isEmpty { NfcText(text: mrtd.optString("message"), size: 12, color: p.muted, family: p.family) }
        }
        .accessibilityIdentifier("nfc.eid")

        // DG11 — personal details.
        if let d = mrtd.optObject("personal"), !d.isEmpty {
            details("nfc.eid.personal", d, [("fullName", "nfc.eid.fullName"), ("otherNames", "nfc.eid.otherNames"), ("personalNumber", "nfc.eid.personalNumber"),
                                             ("fullDateOfBirth", "nfc.eid.fullDob"), ("placeOfBirth", "nfc.eid.placeOfBirth"), ("address", "nfc.eid.address"),
                                             ("telephone", "nfc.eid.telephone"), ("profession", "nfc.eid.profession"), ("title", "nfc.eid.titleField"),
                                             ("personalSummary", "nfc.eid.summary"), ("otherTravelDocuments", "nfc.eid.otherDocs"), ("custody", "nfc.eid.custody")])
        }
        // DG12 — document details.
        if let d = mrtd.optObject("document"), !d.isEmpty {
            details("nfc.eid.document", d, [("issuingAuthority", "nfc.eid.issuingAuthority"), ("dateOfIssue", "nfc.eid.dateOfIssue"),
                                             ("otherPersons", "nfc.eid.otherPersons"), ("endorsements", "nfc.eid.endorsements"), ("taxExit", "nfc.eid.taxExit"),
                                             ("personalizationTime", "nfc.eid.personalized"), ("personalizationDevice", "nfc.eid.personalizationDevice")])
        }
        // DG13 / DG16.
        let optional = mrtd.optString("optional")
        let notify = mrtd.strings("personsToNotify")
        if !optional.isEmpty || !notify.isEmpty {
            NfcCardBox(palette: p) {
                if !optional.isEmpty {
                    NfcSectionTitle(text: words("nfc.eid.optional"), palette: p)
                    NfcText(text: optional, size: 13, color: p.fg, family: p.family)
                }
                if !notify.isEmpty {
                    NfcSectionTitle(text: words("nfc.eid.notify"), palette: p)
                    ForEach(Array(notify.enumerated()), id: \.offset) { _, n in NfcText(text: n, size: 13, color: p.fg, family: p.family) }
                }
            }
        }
        // Every picture the document holds (the face beside the holder is not repeated).
        let pictures = Self.pictures(mrtd)
        if !pictures.isEmpty {
            NfcCardBox(palette: p) {
                NfcText(text: words("nfc.eid.images") + " (\(pictures.count))", size: 15, color: p.fg, bold: true, family: p.family)
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 10) {
                        ForEach(Array(pictures.enumerated()), id: \.offset) { _, img in
                            NfcPictureView(base64: img.optString("data"), mime: img.optString("mime"),
                                           caption: imageLabel(img.optString("kind")) + " · " + img.optString("group"),
                                           width: img.optString("kind") == "document" ? 200 : 120, words: words, palette: p)
                        }
                    }
                    .padding(.top, 6)
                }
            }
            .accessibilityIdentifier("nfc.eid.images")
        }
        // The security objects: passive authentication, the signer, the protocols, the AA key.
        if let sec = mrtd.optObject("security"), !sec.isEmpty {
            NfcCardBox(palette: p) {
                NfcText(text: words("nfc.eid.security"), size: 15, color: p.fg, bold: true, family: p.family)
                let passive = sec.optString("passive")
                if !passive.isEmpty {
                    let text = passive == "ok" ? "✓ " + words("nfc.eid.passiveOk") : passive == "mismatch" ? "✗ " + words("nfc.eid.passiveBad") : "— " + words("nfc.eid.passiveNone")
                    NfcField2(label: words("nfc.eid.passive"), value: text, color: passive == "ok" ? p.success : passive == "mismatch" ? p.danger : p.muted, palette: p)
                }
                NfcField2(label: words("nfc.eid.hash"), value: sec.optString("hashAlgorithm"), color: p.fg, palette: p)
                if let signer = sec.optObject("signer") {
                    NfcField2(label: words("nfc.eid.signer"), value: signer.optString("subject"), color: p.fg, palette: p)
                    NfcField2(label: words("nfc.eid.signedBy"), value: signer.optString("issuer"), color: p.fg, palette: p)
                    let validity = (signer.optString("notBefore") + " – " + signer.optString("notAfter")).trimmingCharacters(in: .whitespaces)
                    if validity != "–" { NfcField2(label: words("nfc.eid.validity"), value: validity, color: p.fg, palette: p) }
                    NfcField2(label: words("nfc.eid.serial"), value: signer.optString("serial"), color: p.muted, palette: p)
                }
                let protocols = sec.strings("protocols")
                if !protocols.isEmpty { NfcField2(label: words("nfc.eid.protocols"), value: protocols.joined(separator: ", "), color: p.fg, palette: p) }
                NfcField2(label: words("nfc.eid.aaKey"), value: sec.optString("activeAuthKey"), color: p.fg, palette: p)
                NfcField2(label: words("nfc.eid.lds"), value: mrtd.optString("ldsVersion"), color: p.muted, palette: p)
                NfcField2(label: words("nfc.eid.unicode"), value: mrtd.optString("unicodeVersion"), color: p.muted, palette: p)
            }
        }
        // Every file tried, and how it went.
        let files = mrtd.objects("files")
        if !files.isEmpty {
            NfcCardBox(palette: p) {
                NfcText(text: words("nfc.eid.files"), size: 15, color: p.fg, bold: true, family: p.family)
                ForEach(Array(files.enumerated()), id: \.offset) { _, f in fileRow(f) }
            }
        }
        NfcCardBox(palette: p) { NfcText(text: words("nfc.readonly.help"), size: 12, color: p.muted, family: p.family) }
    }

    /// How the chip was opened: "BAC", or "PACE · protocol · CAN"; nil when it was not.
    static func access(_ mrtd: NfcJSONObject) -> String? {
        let access = mrtd.optString("access", "none")
        if access == "none" { return nil }
        var how = access.uppercased()
        if access == "pace", let pace = mrtd.optObject("pace") {
            how += " · " + pace.optString("protocol") + (pace.has("password") ? " · " + pace.optString("password").uppercased() : "")
        }
        return how
    }

    /// The pictures to list: every one, except the face already beside the holder.
    static func pictures(_ mrtd: NfcJSONObject) -> [NfcJSONObject] {
        var faceShown = mrtd.optObject("mrzInfo") != nil && !mrtd.optString("photo").isEmpty
        var out = [NfcJSONObject]()
        for img in mrtd.objects("images") {
            if faceShown && img.optString("kind") == "face" && img.optString("data") == mrtd.optString("photo") { faceShown = false; continue }
            out.append(img)
        }
        return out
    }

    private func f(_ key: String, _ value: String) -> some View { NfcField2(label: words(key), value: value, color: palette.fg, palette: palette) }

    private func details(_ title: String, _ d: NfcJSONObject, _ keys: [(String, String)]) -> some View {
        NfcCardBox(palette: palette) {
            NfcText(text: words(title), size: 15, color: palette.fg, bold: true, family: palette.family)
            ForEach(keys, id: \.0) { k in
                let v = d.optArray(k.0) != nil ? d.strings(k.0).joined(separator: ", ") : d.optString(k.0)
                NfcField2(label: words(k.1), value: v, color: palette.fg, palette: palette)
            }
        }
    }

    private func imageLabel(_ kind: String) -> String {
        switch kind {
        case "face": return words("nfc.eid.img.face")
        case "portrait": return words("nfc.eid.img.portrait")
        case "signature": return words("nfc.eid.img.signature")
        case "document": return words("nfc.eid.img.document")
        default: return words("nfc.eid.img.other")
        }
    }

    /// One file of the document: its name and id, its status (read / protected (EAC) / absent / error), size and hash check.
    private func fileRow(_ f: NfcJSONObject) -> some View {
        let p = palette
        let status = f.optString("status", "error")
        var st: String
        switch status {
        case "read": st = words("nfc.eid.st.read")
        case "protected": st = words("nfc.eid.st.protected")
        case "absent": st = words("nfc.eid.st.absent")
        default: st = words("nfc.eid.st.error")
        }
        if f.has("size") { st += " · " + NfcResultFormat.size(f.optInt("size")) }
        if !f.optString("message").isEmpty { st += " · " + f.optString("message") }
        return HStack(alignment: .center, spacing: 6) {
            NfcText(text: f.optString("name") + "  " + f.optString("fid"), size: 13, color: p.fg, bold: true, mono: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1.1)
            NfcText(text: st, size: 12, color: status == "read" ? p.fg : status == "error" ? p.danger : p.muted, family: p.family)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(2)
            if f.has("hashOk") {
                NfcText(text: f.optBool("hashOk") ? "✓" : "✗", size: 15, color: f.optBool("hashOk") ? p.success : p.danger, bold: true)
            }
        }
        .padding(.vertical, 3)
    }
}

/// A picture of the document, `width` pt wide, with an optional caption — JPEG, JPEG 2000 and PNG (ImageIO); a
/// format this device cannot draw shows a labelled placeholder (Android: every JPEG 2000).
struct NfcPictureView: View {
    let base64: String
    let mime: String
    let caption: String?
    let width: CGFloat
    let words: NfcWords
    let palette: NfcPalette
    @State private var image: UIImage?
    @State private var tried = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let image {
                Image(uiImage: image).resizable().scaledToFit().frame(width: width)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .accessibilityLabel(Text(verbatim: caption ?? ""))
            } else if tried {
                let format = mime == "image/jp2" ? "JPEG 2000" : mime.isEmpty ? "?" : mime
                NfcText(text: words.f("nfc.eid.cantShow", format), size: 12, color: palette.muted, family: palette.family)
                    .multilineTextAlignment(.center)
                    .padding(8)
                    .frame(width: width, height: max(72, width * 4 / 3))
                    .background(RoundedRectangle(cornerRadius: 10).fill(palette.surfaceVariant))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(palette.border, lineWidth: 1))
            } else {
                Color.clear.frame(width: width, height: width * 4 / 3)
            }
            if let caption { NfcText(text: caption, size: 11, color: palette.muted, family: palette.family).frame(width: width, alignment: .leading) }
        }
        .task(id: base64.count) {
            image = NfcImages.decode(base64: base64)
            tried = true
        }
    }
}

/// The M5Cet card's records (Android openM5Records / recordRow), and "Be an M5Cet card".
struct NfcRecordsView: View {
    let records: [M5Card.Sealed]
    let words: NfcWords
    let palette: NfcPalette
    let emulateReason: String?
    let open: @MainActor (M5Card.Sealed) -> Void
    let emulate: @MainActor () -> Void

    var body: some View {
        let p = palette
        VStack(alignment: .leading, spacing: 0) {
            NfcText(text: words("nfc.m5.records") + " (\(records.count))", size: 12, color: p.muted, family: p.family)
            ForEach(records, id: \.id) { s in
                let meta = M5Records.meta(s.type)
                NfcCardBox(palette: p) {
                    HStack(spacing: 10) {
                        DesignIcon(name: meta?.icon ?? "file", size: 20, color: p.primary)
                        VStack(alignment: .leading, spacing: 2) {
                            NfcText(text: meta.map { words($0.label) } ?? s.type, size: 15, color: p.fg, bold: true, family: p.family)
                            NfcText(text: (s.oneTime ? "🔥 " : "") + (s.mode == M5Card.modeInternal ? words("nfc.rec.account") : words("nfc.rec.pin")),
                                    size: 12, color: p.muted, family: p.family)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    NfcPillButton(label: meta.map { words($0.actionLabel) } ?? words("nfc.rec.show"), icon: meta?.icon ?? "eye", palette: p,
                                  id: "nfc.record.\(s.id)") { open(s) }
                        .padding(.top, 8)
                }
                .padding(.top, 10)
            }
            NfcPillButton(label: words("nfc.m5.emulate"), icon: "smartphone", enabled: emulateReason == nil, palette: p, id: "nfc.m5.emulate", action: emulate)
                .padding(.top, 10)
            if let emulateReason { NfcText(text: emulateReason, size: 12, color: p.muted, family: p.family).padding(.top, 4) }
        }
    }
}

/// Monospaced, selectable text — at most `NfcWorkbenchModel.screenMax` characters on the screen.
struct NfcTextBox: View {
    let text: String
    let words: NfcWords
    let palette: NfcPalette

    var body: some View {
        let cut = text.count > NfcWorkbenchModel.screenMax
        NfcCardBox(palette: palette) {
            NfcText(text: cut ? String(text.prefix(NfcWorkbenchModel.screenMax)) + "\n…" : text, size: 11.5, color: palette.fg, mono: true, selectable: true)
                .accessibilityIdentifier("nfc.out.text")
            if cut { NfcText(text: words("nfc.out.truncated"), size: 12, color: palette.muted, family: palette.family) }
        }
    }
}

/// The report's export (the web's CardReportView): each format and the card's own files, through the share sheet.
struct NfcReportExportView: View {
    let files: [NfcExportFile]
    let words: NfcWords
    let palette: NfcPalette

    var body: some View {
        if !files.isEmpty {
            NfcCardBox(palette: palette) {
                NfcText(text: words.or("nfc.report.export", "nfc.out.share"), size: 13, color: palette.muted, bold: true, family: palette.family)
                NfcFlow(spacing: 8) {
                    ForEach(files) { f in
                        ShareLink(item: f, preview: SharePreview(Text(verbatim: f.name))) {
                            HStack(spacing: 6) {
                                DesignIcon(name: "download", size: 14, color: palette.primary)
                                NfcText(text: f.format.isEmpty ? f.name : NfcReportExport.label(f.format, words: words), size: 13, color: palette.primary, bold: true, family: palette.family)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(palette.primary.opacity(0.12)))
                        }
                        .accessibilityIdentifier("nfc.report." + f.name)
                    }
                }
                .padding(.top, 4)
            }
        }
    }
}

/// Buttons that wrap to the next line (the report's formats).
struct NfcFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { y += line + spacing; x = 0; line = 0 }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { y += line + spacing; x = bounds.minX; line = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

enum NfcResultFormat {
    /// Hex in byte pairs ("70 0F 5A…").
    static func spaced(_ hex: String) -> String {
        var out = ""
        var i = hex.startIndex
        while i < hex.endIndex, let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) {
            if !out.isEmpty { out += " " }
            out += hex[i..<j]
            i = j
        }
        return out
    }

    static func size(_ n: Int) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return n < 10_240 ? String(format: "%.1f kB", locale: Locale(identifier: "en_US_POSIX"), Double(n) / 1024) : "\(n / 1024) kB" }
        return String(format: "%.1f MB", locale: Locale(identifier: "en_US_POSIX"), Double(n) / 1024 / 1024)
    }
}
