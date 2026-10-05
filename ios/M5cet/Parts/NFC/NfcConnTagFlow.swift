// 6.12 (protocol 4 § 16, F-12): connection tags in format 2, the app's side —
// Android ui/parts/ConnTagUi. The writer chooses an invitation (recommended) or
// an offline tag, the body is prepared in the background (the invitation on the
// server, the offline tag's Argon2id), an offline tag's code is shown ONCE; the
// reader sees the room to join, what is missing (the code, or a format-1 PIN),
// why not, and a format-1 tag marked weak with the offer to rewrite it as
// format 2. Used by the NFC panel and the workbench.

import M5Core
import M5Crypto
import M5Design
import M5NFC
import Observation
import SwiftUI

/// What a tag's body opened to (M5Crypto's ConnTag.Read, as the screens keep it — Android ConnTagUi.parse).
struct NfcConnReading: Sendable, Equatable {
    struct Room: Sendable, Equatable {
        var room: String, passphrase: String, name: String
    }

    /// "v2-inv", "v2-off", "v2" (bad), "v1" or "".
    var format = ""
    /// Format 1: whoever read the tag can guess its PIN offline.
    var weak = false
    /// What is missing to open it: "code", "pin", "redeem" or "".
    var need = ""
    /// wrong-code, wrong-pin, bad-code, other-server, burned, not-found, network, corrupt, bad-tag.
    var error = ""
    /// An invitation's server, when it is not this app's.
    var origin = ""
    var room: Room?

    init() {}

    init(_ r: NfcConnTag.Read) {
        format = r.format; weak = r.weak; need = r.need; error = r.error; origin = r.origin
        room = r.room.map { Room(room: $0.room, passphrase: $0.passphrase, name: $0.name) }
    }

    /// Back from its JSON ({format, weak, need, error, origin, room: {room, passphrase, name}}).
    init(json o: NfcJSONObject) {
        format = o.optString("format"); weak = o.optBool("weak"); need = o.optString("need"); error = o.optString("error")
        origin = o.optString("origin")
        if let r = o.optObject("room") { room = Room(room: r.optString("room"), passphrase: r.optString("passphrase"), name: r.optString("name")) }
    }

    /// As $nfc.last.conn keeps it (Android ConnTag.Read.json).
    var json: NfcJSONObject {
        var o: NfcJSONObject = ["format": .string(format), "weak": .bool(weak), "need": .string(need), "error": .string(error), "origin": .string(origin)]
        if let r = room { o["room"] = ["room": .string(r.room), "passphrase": .string(r.passphrase), "name": .string(r.name)] }
        return o
    }
}

/// The writer's side: kind → prepared body (→ the code once) → `then(body)`.
@MainActor
@Observable
final class NfcConnTagFlow {
    /// The kind chooser is up (invitation / offline).
    var choosing = false
    /// An offline tag's code, shown once (it is on no tag and stored nowhere).
    private(set) var code: String?
    /// The body is being prepared (the server's invitation, the offline tag's Argon2id).
    private(set) var preparing = false

    @ObservationIgnored private var card: NfcJSONObject?
    @ObservationIgnored private var then: (@MainActor (String) -> Void)?
    @ObservationIgnored private var pending: String?
    @ObservationIgnored private let service: @MainActor () -> any NfcUiService
    /// Flash a message (the window's host).
    @ObservationIgnored var flash: @MainActor (String, FlashLevel) -> Void = { _, _ in }
    /// The server an invitation is made on (CoreModels.server) and this app's version.
    @ObservationIgnored var origin: @MainActor () -> String = { CoreModels.shared.server }
    @ObservationIgnored var appVersion = AppInfo.version
    /// Puts the chooser and the code on screen (UIKit, over whatever shows — the panel, the workbench, an action of
    /// the design); nil in the tests, which answer through `choose` / `codeDone`.
    @ObservationIgnored var presenter: (@MainActor (NfcConnTagFlow) -> Void)?

    init(service: @escaping @MainActor () -> any NfcUiService, presenter: (@MainActor (NfcConnTagFlow) -> Void)? = nil) {
        self.service = service
        self.presenter = presenter
    }

    /// Invitation or offline, then the prepared body to `then`. `card`: {room, passphrase, name}.
    func prepare(_ card: NfcJSONObject, then: @escaping @MainActor (String) -> Void) {
        self.card = card
        self.then = then
        pending = nil
        code = nil
        choosing = true
        presenter?(self)
    }

    /// The writer chose: "inv" or "off".
    func choose(_ kind: String, words: NfcWords) async {
        choosing = false
        guard let card, then != nil else { return }
        flash(words("nfc.v2.preparing"), .info)
        preparing = true
        defer { preparing = false }
        do {
            let p = try await service().prepareConn(card, kind: kind, origin: origin(), appVersion: appVersion)
            if let c = p.code {
                pending = p.body
                code = c
                presenter?(self)
            } else {
                finish(p.body)
            }
        } catch {
            flash("⚠ " + NfcConnTagFlow.message(error), .warn)
            reset()
        }
    }

    /// "I have it — write the tag": the code was seen; the body goes on.
    func codeDone() {
        let body = pending
        code = nil
        pending = nil
        if let body { finish(body) } else { reset() }
    }

    /// The chooser was closed: nothing is prepared.
    func cancel() {
        choosing = false
        if code == nil { reset() }
    }

    private func finish(_ body: String) {
        let next = then
        reset()
        next?(body)
    }

    private func reset() {
        card = nil
        then = nil
        pending = nil
    }

    /* ------------------------------------------------------------ the reader's words */

    /// Words for a reading's error code ("" for none) — Android ConnTagUi.error.
    static func error(_ r: NfcConnReading, words: NfcWords) -> String {
        if r.error.isEmpty { return "" }
        if r.error == "wrong-pin" { return words("nfc.wrongPin") }
        return words("nfc.v2.err." + r.error).replacingOccurrences(of: "{origin}", with: r.origin)
    }

    /// What kind of tag it is (invitation, offline, old PIN tag, a room's card).
    static func kind(_ r: NfcConnReading, words: NfcWords) -> String {
        switch r.format {
        case "v2-inv": return words("nfc.v2.invite")
        case "v2-off": return words("nfc.v2.offline")
        case "v1": return words("nfc.v2.old")
        default: return words("nfc.card")
        }
    }

    /// What is missing to open it.
    static func need(_ r: NfcConnReading, words: NfcWords) -> String {
        switch r.need {
        case "code": return words("nfc.v2.needCode")
        case "pin": return words("nfc.v2.needPin")
        case "": return ""
        default: return words("nfc.v2.needRedeem")
        }
    }

    /// A rewrite's card: the room and its passphrase, no name (§ 16.3 / 16.4).
    static func rewriteCard(_ room: NfcConnReading.Room) -> NfcJSONObject {
        ["room": .string(room.room), "passphrase": .string(room.passphrase), "name": ""]
    }

    static func message(_ error: any Error) -> String {
        if let e = error as? NfcError { return e.message }
        if let e = error as? LocalizedError, let d = e.errorDescription { return d }
        return "error"
    }
}

/// What a read tag says, as a card (Android ConnTagUi.result): the room with Join (and, for a format-1 tag, the
/// weak warning and "rewrite as a new tag"); else what is missing with Open (`open` runs with what is typed now)
/// or why not.
struct NfcConnTagCard: View {
    let read: NfcConnReading
    let words: NfcWords
    let palette: NfcPalette
    var open: (@MainActor () -> Void)?
    var rewrite: (@MainActor (NfcJSONObject) -> Void)?
    let join: @MainActor (_ room: String, _ passphrase: String, _ name: String) -> Void

    var body: some View {
        NfcCardBox(palette: palette) {
            NfcText(text: NfcConnTagFlow.kind(read, words: words), size: 12, color: palette.muted, family: palette.family)
            if read.weak {
                NfcText(text: "⚠ " + words("nfc.v2.weak"), size: 13, color: palette.danger, family: palette.family)
                    .padding(.vertical, 4)
            }
            if let room = read.room {
                NfcText(text: room.room, size: 18, color: palette.fg, bold: true, family: palette.family)
                HStack(spacing: 10) {
                    // A format-2 tag suggests no name (the reader keeps its own); a format-1 card may carry one.
                    NfcPillButton(label: words("nfc.join"), icon: "log-in", primary: true, palette: palette, id: "nfc.conn.join") {
                        join(room.room, room.passphrase, read.format == "v1" ? room.name : "")
                    }
                    if read.weak, let rewrite {
                        NfcPillButton(label: words("nfc.v2.rewrite"), icon: "pencil", palette: palette, id: "nfc.conn.rewrite") {
                            rewrite(NfcConnTagFlow.rewriteCard(room))
                        }
                    }
                }
                .padding(.top, 8)
            } else {
                let why = NfcConnTagFlow.error(read, words: words)
                if !why.isEmpty { NfcText(text: "⚠ " + why, size: 14, color: palette.danger, family: palette.family) }
                if !read.need.isEmpty, let open {
                    NfcText(text: NfcConnTagFlow.need(read, words: words), size: 14, color: palette.fg, family: palette.family)
                    NfcPillButton(label: words("nfc.v2.open"), icon: "lock-open", primary: true, palette: palette, id: "nfc.conn.open") { open() }
                        .padding(.top, 8)
                }
            }
        }
        .accessibilityIdentifier("nfc.conn")
    }
}
