// The seams between the NFC session logic and Core NFC (Android: android.nfc.Tag,
// the tech classes, NfcAdapter reader mode). Core NFC is callback based and its
// types are not Sendable, so the seams are callback based too and every call
// happens on the session's serial queue (the executor of `NfcTagSession`):
//
//  * `NfcTagHandle` — one detected tag (CoreNFCTag wraps NFCTag; tests use fakes);
//  * `NfcSessionDriver` — the system reader session (CoreNFCSessionDriver wraps
//    NFCTagReaderSession: the sheet, polling, connect);
//  * `NfcSessionEvents` — what the driver reports back (the delegate callbacks).
//
// Nothing here imports CoreNFC: the tests drive the same code with fakes.

import Foundation
import M5NFC

/// What kind of tag Core NFC found, with its public activation data (Sendable copy of NFCTag's fields).
enum NfcTagKind: Sendable, Hashable {
    /// NFCISO7816Tag: the AID Core NFC selected (one of Info.plist's), historical bytes (type A) / application data (type B).
    case iso7816(initialSelectedAid: String, historicalBytes: [UInt8]?, applicationData: [UInt8]?, supportsPace: Bool)
    /// NFCMiFareTag: "ultralight", "plus", "desfire" or "unknown", and its historical bytes.
    case miFare(family: String, historicalBytes: [UInt8]?)
    /// NFCISO15693Tag: the IC manufacturer code.
    case iso15693(icManufacturer: Int)
    /// NFCFeliCaTag: the current IDm and system code.
    case feliCa(idm: [UInt8], systemCode: [UInt8])

    /// The M5NFC view of it (`TagTech.map(ios:)`).
    var iosTag: TagTech.IOSTag {
        switch self {
        case .iso7816(let aid, let hb, let app, _): return .iso7816(initialSelectedAid: aid, historicalBytes: hb, applicationData: app)
        case .miFare(let family, let hb): return .miFare(family: family, historicalBytes: hb)
        case .iso15693: return .iso15693
        case .feliCa: return .feliCa
        }
    }

    /// The historical bytes / ATS the card showed (CardIdentity.ats).
    var historicalBytes: [UInt8]? {
        switch self {
        case .iso7816(_, let hb, let app, _): return hb ?? app
        case .miFare(_, let hb): return hb
        default: return nil
        }
    }

    /// ISO 14443-4 (ISO-DEP): APDUs go through sendCommand / sendMiFareISO7816Command.
    var isoDep: Bool {
        switch self {
        case .iso7816: return true
        case .miFare(let family, let hb): return family == "desfire" || family == "plus" || TagTech.isDesfireAts(hb)
        default: return false
        }
    }

    /// What the tag itself can do over Core NFC — the transport's capabilities are this ∩ the device's.
    var capabilities: NfcCapabilities {
        let ndef: NfcCapabilities = [.ndefRead, .ndefWrite, .ndefLock, .longSession]
        switch self {
        case .iso7816(_, let hb, _, _):
            var c: NfcCapabilities = ndef.union([.iso7816, .autoSelectsAid])
            if TagTech.isDesfireAts(hb) { c.insert(.desfire) }
            return c
        case .miFare(let family, let hb):
            switch family {
            case "desfire": return ndef.union([.iso7816, .desfire])
            case "plus": return ndef.union([.iso7816])
            case "ultralight": return ndef.union([.mifareUltralight])
            default: return TagTech.isDesfireAts(hb) ? ndef.union([.iso7816, .desfire]) : ndef.union([.mifareUltralight])
            }
        case .iso15693: return ndef.union([.iso15693])
        case .feliCa: return ndef.union([.felica])
        }
    }
}

/// NDEF state of a tag (NFCNDEFStatus + capacity in bytes).
struct NdefStatus: Sendable, Hashable {
    enum State: String, Sendable { case notSupported = "not-supported", readWrite = "read-write", readOnly = "read-only" }
    var state: State
    var capacity: Int
}

/// One ISO 7816 answer as Core NFC hands it over.
struct ApduReply: Sendable, Hashable {
    var data: [UInt8]
    var sw1: UInt8
    var sw2: UInt8
    /// data ‖ SW1 SW2 — the form M5NFC's `ApduChannel` returns.
    var bytes: [UInt8] { data + [sw1, sw2] }
}

typealias NfcCompletion<T> = @Sendable (Result<T, any Error>) -> Void

/// One tag a session detected. Implementations are confined to the session's queue: every method is
/// called there, and the completions may come on any thread (Core NFC: on the session queue).
protocol NfcTagHandle: AnyObject {
    var kind: NfcTagKind { get }
    /// The UID / IDm (NFCTag identifier).
    var identifier: [UInt8] { get }
    /// Still in the field and connected.
    var isAvailable: Bool { get }

    /// An ISO 7816 APDU (NFCISO7816Tag.sendCommand, or NFCMiFareTag.sendMiFareISO7816Command for DESFire / Plus).
    func sendAPDU(_ apdu: ApduFrame, completion: @escaping NfcCompletion<ApduReply>)
    /// A MIFARE native command; Core NFC adds the CRC (NFCMiFareTag.sendMiFareCommand).
    func sendMiFare(_ frame: [UInt8], completion: @escaping NfcCompletion<[UInt8]>)
    func queryNdefStatus(completion: @escaping NfcCompletion<NdefStatus>)
    /// The NDEF records; an empty array for an empty / zero-length message.
    func readNdef(completion: @escaping NfcCompletion<[NdefRecord]>)
    func writeNdef(_ records: [NdefRecord], completion: @escaping NfcCompletion<Void>)
    /// Permanently read-only (NFCNDEFTag.writeLock).
    func writeLock(completion: @escaping NfcCompletion<Void>)
    /// ISO 15693 Read Single Block (high data rate).
    func readBlock(_ block: Int, completion: @escaping NfcCompletion<[UInt8]>)
    /// ISO 15693 Write Single Block (high data rate).
    func writeBlock(_ block: Int, _ data: [UInt8], completion: @escaping NfcCompletion<Void>)
    /// FeliCa Request System Code.
    func felicaSystemCodes(completion: @escaping NfcCompletion<[[UInt8]]>)
    /// FeliCa Polling for a system code: the PMm (manufacture parameter).
    func felicaPmm(systemCode: [UInt8], completion: @escaping NfcCompletion<[UInt8]>)
}

/// What one reading asks of the system session (Android: the reader-mode flags).
struct NfcSessionRequest: Sendable, Hashable {
    struct Polling: OptionSet, Sendable, Hashable {
        let rawValue: Int
        static let iso14443 = Polling(rawValue: 1)
        static let iso15693 = Polling(rawValue: 2)
        static let iso18092 = Polling(rawValue: 4)
        /// PACE-only ID cards — needs "PACE" in com.apple.developer.nfc.readersession.formats (off by default).
        static let pace = Polling(rawValue: 8)
        /// Every technology the tag session finds (Android InternalReader.FLAGS).
        static let all: Polling = [.iso14443, .iso15693, .iso18092]
    }

    var polling: Polling
    /// The ISO 7816 AIDs to try at discovery, in order (iOS 26.4+; a subset of Info.plist's). Empty = Info.plist's list.
    var aids: [String]
    /// The sheet's first text.
    var alert: String
}

/// The system reader session (NFCTagReaderSession) as the session logic drives it. Called on the session queue only.
protocol NfcSessionDriver: AnyObject {
    /// The sheet's text (Core NFC: updatable while the session is valid).
    var alertMessage: String { get set }
    func begin()
    /// Looks for a new tag; tags detected before become invalid.
    func restartPolling()
    /// Ends the session: with an error text (shown with an error mark) or nil (a success, the current alert text stays).
    func invalidate(errorMessage: String?)
    func connect(_ tag: any NfcTagHandle, completion: @escaping @Sendable ((any Error)?) -> Void)
}

/// The driver's callbacks into the session (NFCTagReaderSessionDelegate). Call them on the session queue.
struct NfcSessionEvents: Sendable {
    let session: NfcTagSession

    func becameActive() { session.assumeIsolated { $0.didBecomeActive() } }
    func detected(_ tags: [any NfcTagHandle]) {
        nonisolated(unsafe) let tags = tags // on the session queue: handed straight to its actor (assumeIsolated)
        session.assumeIsolated { $0.didDetect(tags) }
    }
    func invalidated(_ error: any Error) { session.assumeIsolated { $0.didInvalidate(error) } }
}

/// Makes the system session for a request; nil when this device has none (iPad, simulator, no entitlement).
typealias NfcSessionDriverFactory = @Sendable (_ request: NfcSessionRequest, _ queue: DispatchSerialQueue, _ events: NfcSessionEvents) -> (any NfcSessionDriver)?
