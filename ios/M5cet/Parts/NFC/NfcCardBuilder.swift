// The M5Cet card builder (slot "nfcBuilder", the design's "nfc.builder" screen)
// — Android ui/parts/NfcCardBuilder (6.3): add / edit / reorder / remove records,
// an encryption PIN (external) or the account's key (internal), one-time, the
// size against real tags, then the card is written as the NDEF external record
// m5cet.cz:card — the same bytes the web builder writes (M5NFC M5Card).
//
// iOS: the size names only tags this device can write (no MIFARE Classic on an
// iPhone); "Write to a card" on iPad says why it cannot. Sealing (PBKDF2, 600 000
// rounds per record) runs off the main thread.

import Foundation
import M5Design
import M5NFC
import Observation
import SwiftUI

@MainActor
@Observable
final class NfcCardBuilderModel {
    /// One record as it is being built.
    struct Draft: Identifiable, Equatable {
        let id: UUID
        var type: String
        var isInternal: Bool
        var oneTime: Bool
        var data: NfcJSONObject

        init(type: String, isInternal: Bool, oneTime: Bool, data: NfcJSONObject = NfcJSONObject()) {
            id = UUID()
            self.type = type
            self.isInternal = isInternal
            self.oneTime = oneTime
            self.data = data
        }
    }

    /// The per-type fields the builder offers (the records.ts shapes).
    static let fields: [String: [String]] = [
        "message": ["text", "url"], "one-time-message": ["text", "url"], "server-room": ["server", "room", "passphrase", "name"],
        "wifi": ["ssid", "password", "auth"], "url-login": ["url", "user", "password", "note"], "contact": ["name", "tel", "email", "org", "url", "note"],
        "external-key": ["label", "key", "algo"], "passkey-backup": ["user", "root"], "identity-backup": ["user"],
    ]

    private(set) var drafts: [Draft] = []
    var pin = ""
    /// The record in the editor (new or existing).
    var editing: Draft?
    private(set) var editingIsNew = false
    /// The type chooser is up.
    var picking = false
    /// Sealing and writing.
    private(set) var writing = false

    @ObservationIgnored let service: @MainActor () -> any NfcUiService
    @ObservationIgnored var words: NfcWords
    @ObservationIgnored var flashed: @MainActor (String, FlashLevel) -> Void = { _, _ in }
    @ObservationIgnored var accountRoot: @MainActor () -> [UInt8]? = { NfcUiHooks.accountRoot?() }
    @ObservationIgnored private var task: Task<Void, Never>?

    init(service: @escaping @MainActor () -> any NfcUiService, words: NfcWords) {
        self.service = service
        self.words = words
    }

    private func flash(_ text: String, _ level: FlashLevel) { flashed(text, level) }

    /* ------------------------------------------------------------ records */

    /// The types a person builds (M5Records.buildable) with their names.
    var types: [(type: String, label: String)] { M5Records.buildable.map { ($0, label($0)) } }

    func label(_ type: String) -> String { M5Records.meta(type).map { words($0.label) } ?? type }

    /// A new record of a type: one-time and internal as the type suggests, then the editor.
    func add(_ type: String) {
        picking = false
        let m = M5Records.meta(type)
        editing = Draft(type: type, isInternal: m?.accountOnly ?? false, oneTime: m?.oneTimeDefault ?? false)
        editingIsNew = true
    }

    func edit(_ id: UUID) {
        guard let d = drafts.first(where: { $0.id == id }) else { return }
        editing = d
        editingIsNew = false
    }

    /// The editor's OK: the non-empty fields, the toggles.
    func save(values: [String: String], oneTime: Bool, isInternal: Bool) {
        guard var d = editing else { return }
        var data = NfcJSONObject()
        for f in Self.fields[d.type] ?? [] { if let v = values[f], !v.isEmpty { data[f] = .string(v) } }
        d.data = data
        d.oneTime = oneTime
        d.isInternal = isInternal
        if editingIsNew { drafts.append(d) } else if let i = drafts.firstIndex(where: { $0.id == d.id }) { drafts[i] = d }
        editing = nil
    }

    func move(_ id: UUID, by delta: Int) {
        guard let i = drafts.firstIndex(where: { $0.id == id }) else { return }
        let j = i + delta
        guard drafts.indices.contains(j) else { return }
        drafts.swapAt(i, j)
    }

    func remove(_ id: UUID) { drafts.removeAll { $0.id == id } }

    /// "Message  🔥  🔑" and its one-line summary (no secrets).
    func title(_ d: Draft) -> String { label(d.type) + (d.oneTime ? "  🔥" : "") + (d.isInternal ? "  🔑" : "") }
    func summary(_ d: Draft) -> String { M5Records.summary(d.type, d.data) }

    /* ------------------------------------------------------------ size */

    /// The NDEF size without the crypto: the container is 7 header + Σ(37 overhead + json + 16 GCM tag), and the
    /// external record (m5cet.cz:card) adds 16 B (19 B once the payload reaches 256).
    var ndefSize: Int {
        var size = 7
        for d in drafts { size += 37 + Array(d.data.compact.utf8).count + 16 }
        return size + (size < 256 ? 16 : 19)
    }

    /// The smallest tag that holds it — among the tags this device writes (an iPhone writes no MIFARE Classic).
    var fit: String {
        let classic = service().capabilities.contains(.mifareClassic)
        let tags: [(Int, String, Bool)] = [(144, "NTAG213", false), (504, "NTAG215", false), (716, "MIFARE Classic 1K", true), (888, "NTAG216", false),
                                          (3352, "MIFARE Classic 4K", true)]
        for t in tags where (!t.2 || classic) && ndefSize <= t.0 { return t.1 }
        return words("nfc.builder.big")
    }

    var sizeText: String { words("nfc.builder.size") + ": \(ndefSize) B · " + fit }

    /// Why "Write to a card" cannot run here (iPad, simulator).
    var writeReason: String? { service().reason(op: "m5-write", tech: NfcCatalog.m5cetCard) }

    /* ------------------------------------------------------------ write */

    enum WriteCheck: Equatable { case ok, empty, badPin, needAccount, noReader }

    /// What stands in the way of writing (Android write()'s checks), in order.
    func check() -> WriteCheck {
        if drafts.isEmpty { return .empty }
        let anyExternal = drafts.contains { !$0.isInternal }, anyInternal = drafts.contains { $0.isInternal }
        if anyExternal && !M5Card.isValidPin(pinText) { return .badPin }
        if anyInternal && accountRoot() == nil { return .needAccount }
        if writeReason != nil { return .noReader }
        return .ok
    }

    private var pinText: String { pin.trimmingCharacters(in: .whitespaces) }

    /// Seals the records (off the main thread) and writes the card on the next tag.
    func write() {
        switch check() {
        case .empty: flash(words("nfc.builder.empty"), .info); return
        case .badPin: flash(words("nfc.builder.pin"), .warn); return
        case .needAccount: flash(words("nfc.builder.needAccount"), .warn); return
        case .noReader: flash(writeReason ?? words.or("nfc.unavailable.device", "nfc.unavailable"), .warn); return
        case .ok: break
        }
        let p = pinText
        let root = accountRoot()
        let records = drafts.map { M5Card.Record(type: $0.type, mode: $0.isInternal ? M5Card.modeInternal : M5Card.modeExternal, oneTime: $0.oneTime, data: $0.data) }
        let s = service()
        writing = true
        task = Task { [weak self] in
            do {
                let container = try await Task.detached(priority: .userInitiated) {
                    try M5Card.buildCard(records, M5Card.keys(pin: M5Card.isValidPin(p) ? p : nil, root: root))
                }.value
                let n = try await s.writeM5Card(container, texts: NfcSheetTexts())
                if let self { self.flash(self.words.f("nfc.done.writtenBytes", String(n)), .success) }
            } catch let e as NfcError where e.code == .cancelled {
            } catch let w as NfcWriteFailure {
                self?.flash(w.text(NfcSheetTexts()), .warn)
            } catch {
                self?.flash(NfcConnTagFlow.message(error), .warn)
            }
            self?.writing = false
        }
    }

    func stop() { task?.cancel() }
}

struct NfcCardBuilderView: View {
    let ctx: SlotContext
    @Bindable var model: NfcCardBuilderModel
    @FocusState private var pinFocused: Bool

    var body: some View {
        let p = NfcPalette(ctx.context, reducedMotion: ctx.host.reducedMotion)
        let w = model.words
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                NfcText(text: w("nfc.builder.pin"), size: 12, color: p.muted, family: p.family)
                NfcField(hint: w("nfc.pin"), text: $model.pin, keyboard: .numberPad, secret: true, palette: p, id: "nfc.builder.pin")
                    .focused($pinFocused)
                    .padding(.top, 4)
                VStack(spacing: 8) {
                    ForEach(model.drafts) { d in row(d, p) }
                }
                .padding(.top, 10)
                NfcPillButton(label: w("nfc.builder.add"), icon: "plus", palette: p, id: "nfc.builder.add") { model.picking = true }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10)
                NfcText(text: model.sizeText, size: 12, color: p.muted, family: p.family)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
                    .padding(.top, 12)
                    .padding(.bottom, 6)
                    .accessibilityIdentifier("nfc.builder.size")
                let why = model.writeReason
                NfcPillButton(label: w("nfc.builder.write"), icon: "nfc", primary: true, enabled: why == nil && !model.writing, fill: true, palette: p, id: "nfc.builder.write") {
                    if model.check() == .badPin { pinFocused = true }
                    model.write()
                }
                if model.writing { NfcSpinner(palette: p).padding(.top, 8) }
                if let why {
                    NfcText(text: w.or("nfc.unavailable.device", "nfc.unavailable") + " " + why, size: 12, color: p.muted, family: p.family)
                        .padding(.top, 6)
                        .accessibilityIdentifier("nfc.builder.why")
                }
            }
            .padding(EdgeInsets(top: 14, leading: 16, bottom: 28, trailing: 16))
        }
        .accessibilityIdentifier(ctx.id)
        .onAppear {
            model.flashed = { [weak host = ctx.host] t, l in host?.flash(title: "", text: t, level: l) }
        }
        .onDisappear { model.stop() }
        .confirmationDialog(Text(verbatim: w("nfc.builder.add")), isPresented: $model.picking, titleVisibility: .visible) {
            ForEach(model.types, id: \.type) { t in Button { model.add(t.type) } label: { Text(verbatim: t.label) } }
            Button(role: .cancel) {} label: { Text(verbatim: w("nav.close")) }
        }
        .sheet(item: $model.editing) { d in
            NfcRecordEditor(draft: d, model: model, palette: p).presentationDetents([.medium, .large])
        }
    }

    private func row(_ d: NfcCardBuilderModel.Draft, _ p: NfcPalette) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                NfcText(text: model.title(d), size: 15, color: p.fg, bold: true, family: p.family)
                NfcText(text: model.summary(d), size: 12, color: p.muted, family: p.family)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            icon("chevron-up", p) { model.move(d.id, by: -1) }
            icon("chevron-down", p) { model.move(d.id, by: 1) }
            icon("pencil", p) { model.edit(d.id) }
            icon("trash", p) { model.remove(d.id) }
        }
        .padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 8))
        .background(RoundedRectangle(cornerRadius: 14).fill(p.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(p.border, lineWidth: 1))
        .accessibilityIdentifier("nfc.builder.record")
    }

    private func icon(_ name: String, _ p: NfcPalette, _ action: @escaping @MainActor () -> Void) -> some View {
        Button(action: action) { DesignIcon(name: name, size: 20, color: p.muted).padding(8).contentShape(Rectangle()) }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: name))
    }
}

/// One record's fields, one-time and internal (Android NfcCardBuilder.edit).
struct NfcRecordEditor: View {
    let draft: NfcCardBuilderModel.Draft
    @Bindable var model: NfcCardBuilderModel
    let palette: NfcPalette
    @State private var values: [String: String] = [:]
    @State private var oneTime = false
    @State private var isInternal = false

    var body: some View {
        let p = palette
        let w = model.words
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                NfcText(text: model.label(draft.type), size: 18, color: p.fg, bold: true, family: p.family)
                ForEach(NfcCardBuilderModel.fields[draft.type] ?? [], id: \.self) { f in
                    NfcField(hint: w("nfc.field." + f), text: Binding(get: { values[f] ?? "" }, set: { values[f] = $0 }),
                             multiline: f == "text" || f == "note", palette: p, id: "nfc.field." + f)
                }
                Toggle(isOn: $oneTime) { NfcText(text: w("nfc.builder.oneTime"), size: 14, color: p.fg, family: p.family) }.tint(p.primary)
                Toggle(isOn: $isInternal) { NfcText(text: w("nfc.builder.internal"), size: 14, color: p.fg, family: p.family) }.tint(p.primary)
                HStack(spacing: 10) {
                    Spacer()
                    NfcPillButton(label: w("nav.close"), icon: "x", palette: p, id: "nfc.editor.close") { model.editing = nil }
                    NfcPillButton(label: w.or("nfc.ok", "nfc.model.done"), icon: "check", primary: true, palette: p, id: "nfc.editor.ok") {
                        model.save(values: values, oneTime: oneTime, isInternal: isInternal)
                    }
                }
                .padding(.top, 8)
            }
            .padding(20)
        }
        .background(p.surface.ignoresSafeArea())
        .onAppear {
            for f in NfcCardBuilderModel.fields[draft.type] ?? [] { values[f] = draft.data.optString(f) }
            oneTime = draft.oneTime
            isInternal = draft.isInternal
        }
    }
}
