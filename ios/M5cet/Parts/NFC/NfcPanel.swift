// The NFC panel (slot "nfcPanel") — Android ui/parts/ToolPanels.NfcPanel over
// nfc/Nfc (the connection card's modes): the code / PIN, Read, Write the room,
// Be a card, what the last tag held — and joining a room from its card. The
// design's actions nfc.read / nfc.write / nfc.emulate / nfc.stop run here
// (Android Parts.nfc → NfcPanel.action) and its state is the screens' $nfc
// (Parts.nfcScope → Nfc.state: available, enabled, state, message, last, emulating).
//
// iOS: one call = one system sheet (NfcService); "enabled" is "available" (iOS has
// no NFC switch); emulation only with HCE (NfcService says why not).

import M5Core
import M5Crypto
import M5Design
import M5NFC
import Observation
import SwiftUI

@MainActor
@Observable
final class NfcPanelModel {
    /// idle | read | write | emulate | opening (Android Nfc.mode).
    private(set) var mode = "idle"
    /// "", "written", "too-small", or an error's words (Android Nfc.message).
    private(set) var message = ""
    /// What the last tag held (Android Nfc.last): tech, id, ndef, capacity, writable, records, card, conn.
    private(set) var last: NfcJSONObject?
    /// The code (format 2) or PIN (format 1) typed in the panel.
    var pin = ""
    let conn: NfcConnTagFlow

    @ObservationIgnored private let service: @MainActor () -> any NfcUiService
    /// The connection-tag body last read (to open it again with a code); never shown.
    @ObservationIgnored private var lastBody: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored weak var host: DesignHost?
    @ObservationIgnored var words: NfcWords
    /// The app's server — an invitation is redeemed only there.
    @ObservationIgnored var trustedOrigin: @MainActor () -> String = { CoreModels.shared.server }
    /// The active room's connection card ({room, passphrase, name}), nil without one.
    @ObservationIgnored var activeCard: @MainActor () -> NfcJSONObject? = {
        let rooms = CoreModels.shared.rooms
        return rooms.activeKey.isEmpty ? nil : rooms.card(rooms.activeKey).map(NfcValues.nfc)
    }

    init(service: @escaping @MainActor () -> any NfcUiService, words: NfcWords, conn: NfcConnTagFlow? = nil) {
        self.service = service
        self.words = words
        self.conn = conn ?? NfcConnTagFlow(service: service)
    }

    var available: Bool { service().readingAvailable }

    /// $nfc (Android Nfc.state).
    var scope: DesignValue {
        .object(["available": .bool(available), "enabled": .bool(available), "state": .string(mode), "message": .string(message),
                 "last": last.map(NfcValues.design) ?? .null, "emulating": .bool(mode == "emulate")])
    }

    private func flash(_ text: String, _ level: FlashLevel) { host?.flash(title: "", text: text, level: level) }

    /* ------------------------------------------------------------ actions */

    /// read | write | emulate | stop — write / emulate take the active room (Android NfcPanel.action).
    /// 6.12 (§ 16): only format 2 is written — an invitation or an offline tag, prepared first; reading opens format 2,
    /// and format 1 with its PIN. `secret`: what was typed (the panel's field, else $form.nfcPin).
    func action(_ what: String, secret: String? = nil) {
        if what == "stop" { stop(); return }
        guard available else { flash(words("nfc.unavailable"), .warn); return }
        let typed = (secret ?? pin).trimmingCharacters(in: .whitespaces)
        if what == "read" { read(typed); return }
        guard let card = activeCard() else { flash(words("rooms.empty"), .warn); return }
        conn.flash = { [weak self] t, l in self?.flash(t, l) }
        conn.prepare(card) { [weak self] body in
            if what == "emulate" { self?.emulate(body) } else { self?.write(body) }
        }
    }

    /// Waits for a tag to read; `secret` (an offline tag's code or a format-1 PIN) may be empty — then it is asked for.
    func read(_ secret: String) {
        start("read") { [weak self] s in
            let tag = try await s.readTag(texts: NfcSheetTexts(), timeout: nil)
            guard let self else { return }
            var out = NfcPanelModel.describe(tag)
            self.lastBody = tag.connectionBody
            if let body = tag.connectionBody {
                out["card"] = true
                // After the tag left the field: an invitation goes to the server, an offline tag runs Argon2id.
                let r = await s.openConn(body, secret: secret, trustedOrigin: self.trustedOrigin(), redeem: true)
                out["conn"] = .object(r.json)
                if !r.error.isEmpty { self.message = r.error }
            }
            self.last = out
        }
    }

    /// Waits for a tag to write a prepared format-2 body to.
    func write(_ body: String) {
        start("write") { [weak self] s in
            _ = try await s.writeConnTag(body, texts: NfcSheetTexts())
            self?.message = "written"
        }
    }

    /// Answers as a tag with a prepared format-2 body until stop() (HCE; without it NfcService says why not).
    func emulate(_ body: String) {
        task?.cancel()
        mode = "emulate"
        message = ""
        task = Task { [weak self] in
            do {
                _ = try await self?.service().emulateConnection(body, texts: NfcSheetTexts())
            } catch {
                self?.failed(error)
            }
            if self?.mode == "emulate" { self?.mode = "idle" }
        }
    }

    /// The last read tag again, with the code (or PIN) typed now.
    func openLast(_ typed: String) {
        guard let b = lastBody else { return }
        mode = "opening"
        message = ""
        task = Task { [weak self] in
            guard let self else { return }
            let r = await self.service().openConn(b, secret: typed, trustedOrigin: self.trustedOrigin(), redeem: true)
            if var l = self.last { l["conn"] = .object(r.json); self.last = l }
            self.message = r.error
            self.mode = "idle"
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        let s = service()
        if s.busy { s.cancel() }
        s.stopEmulation()
        mode = "idle"
    }

    private func start(_ m: String, _ body: @escaping @MainActor (any NfcUiService) async throws -> Void) {
        task?.cancel()
        let s = service()
        s.stopEmulation()
        mode = m
        message = ""
        task = Task { [weak self] in
            do { try await body(s) } catch { self?.failed(error) }
            self?.mode = "idle"
        }
    }

    private func failed(_ error: any Error) {
        if let e = error as? NfcError, e.code == .cancelled { return }
        if let w = error as? NfcWriteFailure {
            message = w.kind == .tooSmall ? "too-small" : w.text(NfcSheetTexts())
            return
        }
        message = NfcConnTagFlow.message(error)
    }

    /// Android Nfc.readFrom's object: tech, id, ndef, capacity, writable, records ({kind, text | uri | mime, size}).
    static func describe(_ tag: NfcTagRead) -> NfcJSONObject {
        var out: NfcJSONObject = ["tech": .array([.string(tag.identity.label)]), "id": .string(tag.identity.uid)]
        guard let ndef = tag.ndef, ndef.state != .notSupported else { out["ndef"] = false; return out }
        out["ndef"] = true
        out["capacity"] = NfcJSON(ndef.capacity)
        out["writable"] = .bool(ndef.state == .readWrite)
        out["records"] = .array((tag.records ?? []).map { r in
            var o: NfcJSONObject = ["tnf": NfcJSON(Int(r.tnf))]
            switch Ndef.decodeRecord(r) {
            case .text(let text, _, _): o["kind"] = "text"; o["text"] = .string(text)
            case .uri(let u), .absoluteUri(let u): o["kind"] = "uri"; o["uri"] = .string(u)
            case .mime(let type, _): o["mime"] = .string(type)
            default: break
            }
            o["size"] = NfcJSON(r.payload.count)
            return .object(o)
        })
        return out
    }

    /* ------------------------------------------------------------ what the panel shows */

    /// The status line (Android NfcPanel.refresh).
    var status: String {
        let connErr = lastConn.map { NfcConnTagFlow.error($0, words: words) } ?? ""
        if !available { return words("nfc.unavailable") }
        switch mode {
        case "emulate": return words("nfc.emulating")
        case "read", "write": return words("nfc.hold")
        case "opening": return words("nfc.v2.opening")
        default: break
        }
        if message == "written" { return "✓ " + words("nfc.written") }
        if message == "too-small" { return words("nfc.tooSmall") }
        if !connErr.isEmpty { return "⚠ " + connErr }
        return message.isEmpty ? words("tools.nfc") : "⚠ " + message
    }

    var waiting: Bool { ["read", "write", "emulate", "opening"].contains(mode) }

    /// The connection tag last read (format, need, error, room).
    var lastConn: NfcConnReading? {
        guard let c = last?.optObject("conn"), !c.optString("format").isEmpty || !c.optString("error").isEmpty else { return nil }
        return NfcConnReading(json: c)
    }

    /// The lines under the status (Android NfcPanel.refresh): techs, ID, NDEF, the records.
    var lines: [String] {
        guard let last else { return [] }
        var out = [last.strings("tech").joined(separator: " · ")]
        if !last.optString("id").isEmpty { out.append("ID " + last.optString("id")) }
        if last.optBool("ndef") { out.append("NDEF · \(last.optInt("capacity")) B") }
        for r in last.objects("records") {
            let line = r.has("text") ? "T  " + r.optString("text") : r.has("uri") ? "U  " + r.optString("uri")
                : r.has("mime") ? "M  " + r.optString("mime") + " (\(r.optInt("size")) B)" : "·  \(r.optInt("size")) B"
            out.append(line.count > 200 ? String(line.prefix(200)) + "…" : line)
        }
        return out
    }
}

/// The panel (Android NfcPanel): status, a spinner while waiting, the code field, Read / Write the room,
/// Be a card, and what the last tag held with its connection card.
struct NfcPanelView: View {
    let ctx: SlotContext
    @Bindable var model: NfcPanelModel

    var body: some View {
        let p = NfcPalette(ctx.context, reducedMotion: ctx.host.reducedMotion)
        let w = model.words
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                NfcText(text: model.status, size: 15, color: p.fg, bold: true, family: p.family)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("nfc.panel.status")
                if model.waiting { NfcSpinner(palette: p).padding(.top, 8) }
                if model.available {
                    // 6.12: an offline tag's code (format 2) or an old tag's PIN (format 1) — writing needs neither.
                    NfcField(hint: w("nfc.v2.codeHint"), text: $model.pin, capitalize: true, palette: p, id: "nfc.panel.pin")
                        .padding(.top, 14)
                    HStack(spacing: 10) {
                        NfcPillButton(label: w("nfc.read"), icon: "scan-line", primary: true, palette: p, id: "nfc.panel.read") { run("read") }
                        NfcPillButton(label: w("nfc.write"), icon: "pencil", palette: p, id: "nfc.panel.write") { run("write") }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
                    .padding(.bottom, 4)
                    let emu = NfcUiHooks.service().reason(op: "conn-emulate", tech: NfcCatalog.connectionTag)
                    NfcPillButton(label: w("nfc.emulate"), icon: "smartphone", enabled: emu == nil, palette: p, id: "nfc.panel.emulate") { run("emulate") }
                        .frame(maxWidth: .infinity)
                    if let emu { NfcText(text: emu, size: 12, color: p.muted, family: p.family).frame(maxWidth: .infinity).multilineTextAlignment(.center).padding(.top, 4) }
                } else if let why = NfcUiHooks.service().unavailableReason {
                    NfcText(text: why, size: 13, color: p.muted, family: p.family).padding(.top, 10)
                        .accessibilityIdentifier("nfc.panel.reason")
                }
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(model.lines.enumerated()), id: \.offset) { i, line in
                        NfcText(text: line, size: i < 3 && !line.hasPrefix("T  ") && !line.hasPrefix("U  ") && !line.hasPrefix("M  ") ? 13 : 14,
                                color: i < 3 && !line.hasPrefix("T  ") && !line.hasPrefix("U  ") && !line.hasPrefix("M  ") ? p.muted : p.fg, family: p.family)
                    }
                    // 6.12: the connection tag — the room to join, or what is missing (the code / an old PIN), or why not.
                    if let r = model.lastConn, !r.format.isEmpty {
                        NfcConnTagCard(read: r, words: w, palette: p,
                                       open: { model.openLast(model.pin.trimmingCharacters(in: .whitespaces)) },
                                       rewrite: { card in
                                           model.conn.flash = { [weak host = ctx.host] t, l in host?.flash(title: "", text: t, level: l) }
                                           model.conn.prepare(card) { body in model.write(body) }
                                       },
                                       join: { room, pass, name in NfcJoin.finish(room: room, passphrase: pass, name: name, host: ctx.host) })
                            .padding(.top, 12)
                    }
                }
                .padding(.top, 16)
            }
            .padding(EdgeInsets(top: 16, leading: 16, bottom: 24, trailing: 16))
        }
        .accessibilityIdentifier(ctx.id)
        .onAppear { model.host = ctx.host }
        .onDisappear { model.stop() }
    }

    private func run(_ what: String) {
        model.host = ctx.host
        model.action(what)
    }
}
