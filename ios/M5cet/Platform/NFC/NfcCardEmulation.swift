// The phone as an NFC Forum Type 4 tag (Android CardService, HostApduService,
// AID D2760000850101): another phone reads the connection tag or the M5Cet card
// off this one. iOS: Core NFC CardSession (iOS 17.4+, card emulation for apps in
// the EEA from iOS 18.1) — only with Apple's HCE entitlement
// (com.apple.developer.nfc.hce) and the AID in Info.plist
// (com.apple.developer.nfc.hce.iso7816.select-identifier-prefixes), on an eligible
// iPhone. Without them nothing here touches CardSession: the feature is reported
// unavailable with M5NFC's limit reason, never faked.
//
// The APDU logic is M5NFC's `Type4TagEmulator` (Android CardService.processCommandApdu);
// `HceResponder` adds what the session needs to know (the whole NDEF file was read).

import CoreNFC
import Foundation
import M5NFC
import Synchronization

/// Whether card emulation can run here, and why not.
enum HceAvailability: Sendable, Equatable {
    case available
    case unavailable(String)

    var isAvailable: Bool { self == .available }

    /// The reason M5NFC gives when `.emulation` is missing (NfcPlatform.limit), or "no NFC" on iPad.
    static func reason(readingAvailable: Bool) -> String {
        NfcPlatform.limit(op: "conn-emulate", tech: NfcCatalog.connectionTag, capabilities: readingAvailable ? .coreNFCiPhone : .none)
            ?? "Card emulation is not available on this iPhone."
    }
}

/// What decides HCE availability (Core NFC in the app; fakes in tests).
protocol HceProbe: Sendable {
    /// The app is built with HCE: Info.plist lists the emulated AID (the coordinator adds it together with the entitlement).
    var configured: Bool { get }
    /// CardSession.isSupported (the device and the OS).
    var supported: Bool { get }
    /// CardSession.isEligible (region, the person's settings).
    func eligible() async -> Bool
}

/// The real probe: Info.plist, then CardSession.
struct CoreNFCHceProbe: HceProbe {
    static let infoPlistKey = "com.apple.developer.nfc.hce.iso7816.select-identifier-prefixes"
    /// The NDEF application this app answers as (Android CardService's AID).
    static let aid = "D2760000850101"

    var bundle: Bundle = .main

    var configured: Bool {
        (bundle.object(forInfoDictionaryKey: Self.infoPlistKey) as? [String] ?? []).contains { Self.aid.hasPrefix($0.uppercased()) }
    }
    var supported: Bool { configured && NFCReaderSession.readingAvailable && CardSession.isSupported }
    func eligible() async -> Bool { supported ? await CardSession.isEligible : false }
}

enum HceCheck {
    /// The gate, in order: built with HCE → supported here → eligible now.
    static func availability(_ probe: any HceProbe, readingAvailable: Bool) async -> HceAvailability {
        let no = HceAvailability.unavailable(HceAvailability.reason(readingAvailable: readingAvailable))
        guard readingAvailable, probe.configured, probe.supported else { return no }
        return await probe.eligible() ? .available : no
    }
}

/// One emulation's APDU answers (Type4TagEmulator) and whether a reader took the whole NDEF file.
struct HceResponder: Sendable {
    private(set) var emulator: Type4TagEmulator
    /// Bytes of the NDEF file read so far (the highest offset + length a READ BINARY returned on E104).
    private(set) var ndefBytesRead = 0
    private var ndefSelected = false

    init(_ emulator: Type4TagEmulator) { self.emulator = emulator }

    /// A reader read the NDEF file to its end.
    var served: Bool { (emulator.ndefFile?.count ?? Int.max) <= ndefBytesRead }

    mutating func process(_ apdu: [UInt8]) -> [UInt8] {
        let answer = emulator.process(apdu)
        let ok = answer.count >= 2 && answer[answer.count - 2] == 0x90 && answer[answer.count - 1] == 0x00
        if apdu.count >= 4 && apdu[1] == 0xa4 {
            let lc = apdu.count > 4 ? Int(apdu[4]) : 0
            let data = apdu.count >= 5 + lc ? Array(apdu[5..<(5 + lc)]) : []
            ndefSelected = ok && apdu[2] == 0x00 && data == [0xe1, 0x04]
        } else if apdu.count >= 4 && apdu[1] == 0xb0 && ok && ndefSelected {
            let offset = Int(apdu[2]) << 8 | Int(apdu[3])
            ndefBytesRead = max(ndefBytesRead, offset + answer.count - 2)
        }
        return answer
    }

    mutating func deactivated() { emulator.deactivated(); ndefSelected = false }
}

/// How an emulation ended.
enum HceEnd: Sendable, Equatable {
    /// A reader read the whole card.
    case served
    /// Stopped (the person, the screen, `stop`).
    case stopped
    /// iOS ended it (time limit, the person closed the system UI, not eligible…).
    case ended(String)
}

/// Runs card emulation sessions (Android CardService.serve… / stopServing).
@MainActor
final class NfcCardEmulation {
    private(set) var availability: HceAvailability
    private let probe: any HceProbe
    private let readingAvailable: Bool
    private var task: Task<HceEnd, any Error>?

    init(probe: any HceProbe = CoreNFCHceProbe(), readingAvailable: Bool) {
        self.probe = probe
        self.readingAvailable = readingAvailable
        availability = .unavailable(HceAvailability.reason(readingAvailable: readingAvailable))
    }

    /// Checks the gate again (CardSession.isEligible is async and may change).
    @discardableResult
    func refresh() async -> HceAvailability {
        availability = await HceCheck.availability(probe, readingAvailable: readingAvailable)
        return availability
    }

    /// Whether the phone answers as a card now.
    var serving: Bool { task != nil }

    /// Answers as a Type 4 tag holding `emulator`'s card until a reader read it, `stop()`, or iOS ends it.
    func serve(_ emulator: Type4TagEmulator, texts: NfcSheetTexts) async throws -> HceEnd {
        guard await refresh() == .available else {
            if case .unavailable(let why) = availability { throw NfcError.unsupported(why) }
            throw NfcError.unsupported(HceAvailability.reason(readingAvailable: readingAvailable))
        }
        guard emulator.serving else { throw NfcError(.invalidArgument, "no card to answer as") }
        stop()
        let alert = texts.emulating
        let t = Task.detached { try await HceRunner.run(emulator, alert: alert) }
        task = t
        defer { if task == t { task = nil } }
        return try await withTaskCancellationHandler { try await t.value } onCancel: { t.cancel() }
    }

    /// Stops answering (Android CardService.stopServing).
    func stop() {
        task?.cancel()
        task = nil
    }
}

/// The CardSession event loop — all CardSession use stays in this one task (CardSession is not Sendable).
enum HceRunner {
    /// Lets the cancellation handler end the session from outside the task. CardSession.invalidate() is meant to be
    /// called to end a session at any time; nothing else of the session is touched through this box.
    private final class Invalidator: @unchecked Sendable {
        let session: CardSession
        init(_ s: CardSession) { session = s }
        func invalidate() { session.invalidate() }
    }

    static func run(_ emulator: Type4TagEmulator, alert: String) async throws -> HceEnd {
        // Keeps the wallet's default contactless app from presenting while this app emulates.
        let presentment = try await NFCPresentmentIntentAssertion.acquire()
        defer { withExtendedLifetime(presentment) {} }
        let session = try await CardSession()
        session.alertMessage = alert
        let box = Invalidator(session)
        var responder = HceResponder(emulator)
        return try await withTaskCancellationHandler {
            for try await event in session.eventStream {
                if Task.isCancelled { session.invalidate(); return .stopped }
                switch event {
                case .sessionStarted:
                    try await session.startEmulation()
                case .readerDetected:
                    break
                case .received(let apdu):
                    let answer = responder.process([UInt8](apdu.payload))
                    do { try await apdu.respond(response: Data(answer)) }
                    catch let e as CardSession.Error where e == .transmissionError {
                        try? await apdu.respond(response: Data(answer)) // Apple: retry once on a transmission error
                    }
                case .readerDeselected:
                    responder.deactivated()
                    if responder.served {
                        await session.stopEmulation(status: .success)
                        session.invalidate()
                        return .served
                    }
                case .sessionInvalidated(let reason):
                    return Task.isCancelled ? .stopped : .ended(String(describing: reason))
                @unknown default:
                    break
                }
            }
            return Task.isCancelled ? .stopped : .ended("the session ended")
        } onCancel: {
            box.invalidate()
        }
    }
}
