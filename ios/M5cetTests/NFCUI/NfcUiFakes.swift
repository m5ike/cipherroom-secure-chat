// An NfcService-shaped fake for the NFC UI's view models (the screens' seam
// NfcUiService): an iPhone (Core NFC, no HCE), an iPhone with HCE, or an iPad
// (no reader) — the limits are M5NFC's NfcPlatform, as NfcService's are. Every
// call is recorded; what a reading returns is set by the test.

import Foundation
import M5Core
import M5Design
import M5NFC
@testable import M5cet

@MainActor
final class FakeNfcUi: NfcUiService {
    var readingAvailable: Bool
    var capabilities: NfcCapabilities
    var busy = false

    /// What each call got (op names, "readTag", "writeM5Card"…).
    private(set) var calls: [String] = []
    private(set) var inputs: [String: NfcOpInput] = [:]
    private(set) var written: [[UInt8]] = []
    private(set) var connWritten: [String] = []
    private(set) var emulated: [String] = []
    private(set) var cancels = 0

    var tag: NfcTagRead?
    var opResult: (String, NfcOpInput) throws -> NfcOpResult = { _, _ in NfcOpResult(card: CardIdentity(uid: "04A1", tech: NfcCatalog.ntag21x), output: [:]) }
    var conn: (String?, String, Bool) -> NfcConnReading = { _, _, _ in NfcConnReading() }
    var prepared: (String) -> NfcPreparedTag = { kind in NfcPreparedTag(body: NfcTagV2.prefix + "{\"k\":\"\(kind)\"}", code: kind == "off" ? "ABCD-EFGH-JKMN-PQRS-TVWX" : nil) }
    var chip: (any ApduChannel & Sendable)?
    var modelResult: NfcJSONObject = ["status": "ok"]
    var modelReadDelay: Duration = .zero
    var readError: (any Error)?

    /// iPhone: Core NFC without HCE (the default); `hce` adds emulation; iPad: no reader at all.
    init(iPhone: Bool = true, hce: Bool = false) {
        readingAvailable = iPhone
        capabilities = iPhone ? (hce ? NfcCapabilities.coreNFCiPhone.union(.emulation) : .coreNFCiPhone) : .none
    }

    func limit(op: String, tech: String) -> String? { NfcPlatform.limit(op: op, tech: tech, capabilities: capabilities) }
    func refreshEmulation() async -> HceAvailability { capabilities.contains(.emulation) ? .available : .unavailable("no HCE") }
    func cancel() { cancels += 1; busy = false }

    func readTag(texts: NfcSheetTexts, timeout: Duration?) async throws -> NfcTagRead {
        calls.append("readTag")
        if let readError { throw readError }
        guard let tag else { throw NfcError(.cancelled, "no tag") }
        return tag
    }

    func perform(_ op: String, tech: String, input: NfcOpInput, texts: NfcSheetTexts) async throws -> NfcOpResult {
        calls.append(op)
        inputs[op] = input
        if let readError { throw readError }
        return try opResult(op, input)
    }

    func runTemplate(_ template: ApduTemplates.Template, mrtd: MrtdReader.Options?, texts: NfcSheetTexts,
                     onStep: TemplateRunner.StepListener?, onExchange: TemplateRunner.ExchangeListener?) async throws -> TemplateRunResult {
        calls.append("template:" + template.label)
        guard let chip else { throw NfcError(.cancelled, "no card") }
        return await TemplateRunner(template, mrtd: mrtd, onStep: onStep, onExchange: onExchange).run(chip)
    }

    func openConn(_ body: String?, secret: String, trustedOrigin: String?, redeem: Bool) async -> NfcConnReading {
        calls.append("openConn:" + (redeem ? "redeem" : "peek"))
        return conn(body, secret, redeem)
    }

    func prepareConn(_ card: NfcJSONObject, kind: String, origin: String, appVersion: String) async throws -> NfcPreparedTag {
        calls.append("prepare:" + kind)
        return prepared(kind)
    }

    func writeConnTag(_ body: String, texts: NfcSheetTexts) async throws -> Int {
        calls.append("writeConnTag")
        if let readError { throw readError }
        connWritten.append(body)
        return body.utf8.count + 30
    }

    func writeM5Card(_ container: [UInt8], texts: NfcSheetTexts) async throws -> Int {
        calls.append("writeM5Card")
        if let readError { throw readError }
        written.append(container)
        return container.count + 16
    }

    func lockTag(confirmPermanentLock: Bool, texts: NfcSheetTexts) async throws {
        calls.append("lockTag")
        guard confirmPermanentLock else { throw NfcError(.invalidArgument, NfcService.lockNeedsYes) }
    }

    func emulateConnection(_ body: String, texts: NfcSheetTexts) async throws -> HceEnd {
        calls.append("emulateConnection")
        if let why = limit(op: "conn-emulate", tech: NfcCatalog.connectionTag) { throw NfcError.unsupported(why) }
        emulated.append(body)
        return .served
    }

    func emulateM5Card(_ container: [UInt8], texts: NfcSheetTexts) async throws -> HceEnd {
        calls.append("emulateM5Card")
        if let why = limit(op: "m5-emulate", tech: NfcCatalog.m5cetCard) { throw NfcError.unsupported(why) }
        return .served
    }

    func stopEmulation() { calls.append("stopEmulation") }

    func modelPlan(_ spec: NfcJSONObject?, preferredReader: String) -> ModelNfcPlan {
        NfcModelPlanner.plan(spec, capabilities: capabilities, preferredReader: preferredReader)
    }

    func modelRead(_ command: ModelNfc.Command, texts: NfcSheetTexts) async -> NfcJSONObject {
        calls.append("modelRead:" + command.op)
        if modelReadDelay > .zero { try? await Task.sleep(for: modelReadDelay) }
        if Task.isCancelled { return ModelNfc.cancelled() }
        return modelResult
    }
}

/// A simulated ISO 7816 card: SELECT and READ BINARY answer; READ RECORD answers a record with a card number (EMV
/// test PAN 5413330089020011) and track 2 — what the views must mask; anything else "not found".
final class FakeUiChip: ApduChannel, @unchecked Sendable {
    static let pan = "5413330089020011"
    func transmit(_ apdu: [UInt8]) async throws -> [UInt8] {
        guard apdu.count >= 4 else { return [0x67, 0x00] }
        switch apdu[1] {
        case 0xA4: return [0x90, 0x00]
        case 0xB0: return [0x5F, 0x01, 0x04, 0x30, 0x31, 0x30, 0x90, 0x00]
        case 0xB2:
            let pan = Hex.decodeLenient(Self.pan)
            let track2 = Hex.decodeLenient(Self.pan + "D29122010000000000")
            let rec: [UInt8] = [0x5A, UInt8(pan.count)] + pan + [0x57, UInt8(track2.count)] + track2
            return [0x70, UInt8(rec.count)] + rec + [0x90, 0x00]
        default: return [0x6A, 0x88]
        }
    }
}

/// Flashes and screens a view model asked for.
@MainActor
final class NfcUiRecorder {
    var flashes: [(String, FlashLevel)] = []
    var screens: [String] = []
    var outcomes: [NfcRecordOutcome] = []

    var lastFlash: String? { flashes.last?.0 }
}

@MainActor
enum NfcUiTest {
    static var words: NfcWords { NfcWords.builtIn }
    static func w(_ key: String) -> String { words(key) }

    /// A workbench on a fake, its flashes and screens recorded.
    static func workbench(_ fake: FakeNfcUi, recorder: NfcUiRecorder = NfcUiRecorder()) -> NfcWorkbenchModel {
        let m = NfcWorkbenchModel(service: { fake }, words: words)
        m.flashed = { t, l in recorder.flashes.append((t, l)) }
        m.openScreen = { recorder.screens.append($0) }
        m.onRecord = { recorder.outcomes.append($0) }
        m.conn.flash = { t, l in recorder.flashes.append((t, l)) }
        m.trustedOrigin = { "https://chat.example.com" }
        m.activeCard = { ["room": "team", "passphrase": "pass phrase words", "name": "Mike"] }
        return m
    }

    /// Waits until `done` (the view models' work runs in tasks on the main actor).
    static func until(_ timeout: Duration = .seconds(10), _ done: () -> Bool) async {
        let end = ContinuousClock.now + timeout
        while !done() && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(10)) }
    }

    static func template(_ json: NfcJSON) -> ApduTemplates.Template { ApduTemplates.parse([json])[0] }
}
