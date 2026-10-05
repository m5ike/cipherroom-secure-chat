// The NFC screens' view of the iPhone's NFC — NfcService's shape (Platform/NFC),
// so the view models run on NfcService in the app, on a fake in the tests
// (M5cetTests/NFCUI) and on a demo radio in DEBUG screenshots. Nothing here
// talks to Core NFC; everything that does is NfcService's.
//
// Also the few things the NFC screens need from other parts of the app that do
// not exist yet on iOS (Android: Account.cardRoot(), Parts.forward(ChatMessage)):
// `NfcUiHooks` — the owners install them; until then the screens say so honestly
// (an internal record needs the account; Forward is not offered).

import Foundation
import M5Core
import M5Design
import M5NFC
import M5Proto
import UIKit

/// What the NFC UI calls (NfcService's API, Platform/NFC/README.md).
@MainActor
protocol NfcUiService: AnyObject {
    /// The device has an NFC reader (false on iPad, Apple Watch and the simulator).
    var readingAvailable: Bool { get }
    /// What this device's reader does (.none on iPad; + .emulation with HCE).
    var capabilities: NfcCapabilities { get }
    /// A reading is in progress (the system sheet is up).
    var busy: Bool { get }
    /// Why an op is not offered here (nil when it is) — M5NFC's words.
    func limit(op: String, tech: String) -> String?
    func refreshEmulation() async -> HceAvailability
    /// Closes the reading in progress.
    func cancel()

    func readTag(texts: NfcSheetTexts, timeout: Duration?) async throws -> NfcTagRead
    func perform(_ op: String, tech: String, input: NfcOpInput, texts: NfcSheetTexts) async throws -> NfcOpResult
    func runTemplate(_ template: ApduTemplates.Template, mrtd: MrtdReader.Options?, texts: NfcSheetTexts,
                     onStep: TemplateRunner.StepListener?, onExchange: TemplateRunner.ExchangeListener?) async throws -> TemplateRunResult

    /// Opens a connection tag's body with what was typed (NfcService.openConnBody).
    func openConn(_ body: String?, secret: String, trustedOrigin: String?, redeem: Bool) async -> NfcConnReading
    /// A format-2 body for a room's card: "inv" or "off" (NfcService.prepareConnTag).
    func prepareConn(_ card: NfcJSONObject, kind: String, origin: String, appVersion: String) async throws -> NfcPreparedTag
    func writeConnTag(_ body: String, texts: NfcSheetTexts) async throws -> Int
    func writeM5Card(_ container: [UInt8], texts: NfcSheetTexts) async throws -> Int
    func lockTag(confirmPermanentLock: Bool, texts: NfcSheetTexts) async throws

    func emulateConnection(_ body: String, texts: NfcSheetTexts) async throws -> HceEnd
    func emulateM5Card(_ container: [UInt8], texts: NfcSheetTexts) async throws -> HceEnd
    func stopEmulation()

    func modelPlan(_ spec: NfcJSONObject?, preferredReader: String) -> ModelNfcPlan
    func modelRead(_ command: ModelNfc.Command, texts: NfcSheetTexts) async -> NfcJSONObject
}

/// A prepared connection tag: the body to write, and an offline tag's code to show once (nil for an invitation).
struct NfcPreparedTag: Sendable, Equatable {
    let body: String
    let code: String?
}

extension NfcService: NfcUiService {
    func openConn(_ body: String?, secret: String, trustedOrigin: String?, redeem: Bool) async -> NfcConnReading {
        NfcConnReading(await openConnBody(body, secret: secret, trustedOrigin: trustedOrigin, redeem: redeem))
    }

    func prepareConn(_ card: NfcJSONObject, kind: String, origin: String, appVersion: String) async throws -> NfcPreparedTag {
        let p = try await prepareConnTag(card, kind: kind, origin: origin, appVersion: appVersion)
        return NfcPreparedTag(body: p.body, code: p.code)
    }
}

extension NfcUiService {
    /// Why nothing can be read here (iPad, simulator), nil on an iPhone with NFC.
    var unavailableReason: String? { readingAvailable ? nil : NfcService.noReader }

    /// The reason an op is not offered: no reader at all first, then M5NFC's platform limit.
    func reason(op: String, tech: String) -> String? {
        if let none = unavailableReason { return none }
        return limit(op: op == "mrtd-read" ? "eid-read" : op, tech: tech)
    }
}

/// What the NFC screens need from other owners (installed by them; nil = not on iOS yet).
@MainActor
enum NfcUiHooks {
    /// The account's root for internal (passkey) records of an M5Cet card — Android `Account.cardRoot()`
    /// (requested from the account owner). Without it an internal record answers "needs your account".
    static var accountRoot: (@MainActor () -> [UInt8]?)?
    /// The chat's forward sheet for a message that is in no room yet (Android `Parts.forward(ChatMessage)`:
    /// a room, then everyone there or one member) — requested from the chat owner. Without it Forward is not offered.
    static var forward: (@MainActor (ChatMessage, DesignHost) -> Void)?
    /// The NFC service the screens use (tests and DEBUG previews put their own).
    static var service: (@MainActor () -> any NfcUiService) = { NfcService.shared }
}

/// The app's side of joining a room from a card (Android MainActivity.finishJoin): saved, connected, shown.
@MainActor
enum NfcJoin {
    static func finish(room: String, passphrase: String, name: String, host: DesignHost?) {
        guard let host else { return }
        let core = CoreModels.shared
        if room.trimmingCharacters(in: .whitespaces).isEmpty || passphrase.isEmpty {
            host.form["joinError"] = .string(host.translator.t("join.passphrase"))
            host.refresh()
            return
        }
        host.form["joinError"] = .string("")
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let nick = !trimmed.isEmpty ? trimmed : !core.userName.isEmpty ? core.userName : UIDevice.current.model
        core.rooms.join(room: room, passphrase: passphrase, userName: nick)
        host.closeOverlay()
        host.showScreen("room")
    }
}

/// The three JSON value types side by side: M5NFC's NfcJSON, M5Core's JSON and the design's DesignValue.
enum NfcValues {
    static func nfc(_ v: DesignValue) -> NfcJSON {
        switch v {
        case .null: return .null
        case .bool(let b): return .bool(b)
        case .number(let d): return .number(d)
        case .string(let s): return .string(s)
        case .array(let a): return .array(a.map(nfc))
        case .object(let o):
            var out = NfcJSONObject()
            for k in o.keys.sorted() { out[k] = nfc(o[k]!) }
            return .object(out)
        }
    }

    static func design(_ v: NfcJSON) -> DesignValue {
        switch v {
        case .null: return .null
        case .bool(let b): return .bool(b)
        case .number(let d): return .number(d)
        case .string(let s): return .string(s)
        case .array(let a): return .array(a.map(design))
        case .object(let o):
            var out = [String: DesignValue]()
            for e in o { out[e.key] = design(e.value) }
            return .object(out)
        }
    }

    static func design(_ o: NfcJSONObject) -> DesignValue { design(.object(o)) }

    /// M5Core's object (a room's card) as M5NFC's.
    static func nfc(_ o: JSONObject) -> NfcJSONObject { nfc(DesignValue(o)).objectValue ?? NfcJSONObject() }
}
