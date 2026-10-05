// The seam between M5NFC and a radio (docs/ios-architecture.md § 3, A/nfc/Reader.java,
// A/nfc/Apdu.java Transceiver). Everything in M5NFC talks to a card through
// `ApduChannel` (one APDU in, the answer data ‖ SW1 SW2 out); the app's CoreNFC
// transport (M5cet/Platform/NFC, wave 2) implements `CardTransport`, which adds
// what the card is, what the transport can do and the optional non-APDU paths
// (MIFARE commands, raw frames, NDEF). Tests use simulated cards.

import Foundation

/// One ISO 7816 APDU exchange with the card in the field — Android's `Apdu.Transceiver`.
/// `transmit` returns the response data followed by SW1 SW2 (at least 2 bytes
/// for a card that answered). Throw `NfcError.cardGone` when the card left.
public protocol ApduChannel: AnyObject {
    func transmit(_ apdu: [UInt8]) async throws -> [UInt8]
}

/// What a transport (the radio and the session it opened) can do. The UI hides
/// what a transport does not have — iOS limits are made explicit here
/// (`NfcCapabilities.coreNFCiPhone`), never faked.
public struct NfcCapabilities: OptionSet, Sendable, Hashable {
    public let rawValue: UInt32
    public init(rawValue: UInt32) { self.rawValue = rawValue }

    /// ISO 7816-4 APDUs to an ISO-DEP card (CoreNFC: an NFCISO7816Tag with one of the
    /// Info.plist AIDs, or NFCMiFareTag.sendMiFareISO7816Command for DESFire).
    public static let iso7816 = NfcCapabilities(rawValue: 1 << 0)
    /// Read the NDEF message of a tag.
    public static let ndefRead = NfcCapabilities(rawValue: 1 << 1)
    /// Write an NDEF message (CoreNFC: NFCNDEFTag.writeNDEF).
    public static let ndefWrite = NfcCapabilities(rawValue: 1 << 2)
    /// Make a tag read-only (CoreNFC: writeLock).
    public static let ndefLock = NfcCapabilities(rawValue: 1 << 3)
    /// MIFARE Ultralight / NTAG native commands (READ 30, WRITE A2, GET_VERSION 60) — NFCMiFareTag.sendMiFareCommand.
    public static let mifareUltralight = NfcCapabilities(rawValue: 1 << 4)
    /// MIFARE DESFire native commands wrapped in ISO 7816 (90 cmd 00 00 Lc data 00).
    public static let desfire = NfcCapabilities(rawValue: 1 << 5)
    /// ISO 15693 (vicinity) blocks — NFCISO15693Tag.
    public static let iso15693 = NfcCapabilities(rawValue: 1 << 6)
    /// FeliCa — NFCFeliCaTag (system codes from Info.plist).
    public static let felica = NfcCapabilities(rawValue: 1 << 7)
    /// MIFARE Classic sectors (Crypto1). **Not on iOS**: CoreNFC has no MIFARE Classic.
    public static let mifareClassic = NfcCapabilities(rawValue: 1 << 8)
    /// Raw ISO 14443-3 frames (Android NfcA.transceive: the Gen1a backdoor of "magic" cards).
    /// **Not on iOS**: an ISO 7816 session sends APDUs only, sendMiFareCommand adds its own CRC.
    public static let rawFrames = NfcCapabilities(rawValue: 1 << 9)
    /// The phone answers as a Type 4 tag (Android HCE, CardService). **iOS only with the HCE
    /// entitlement** (CardSession, EEA, iOS 18.1+) — the app sets it after its availability check.
    public static let emulation = NfcCapabilities(rawValue: 1 << 10)
    /// EMV payment applications (PPSE / payment AIDs). **CoreNFC refuses payment-related AIDs**
    /// (Apple: "Core NFC doesn't support payment-related Application IDs") — an external reader may.
    public static let paymentAids = NfcCapabilities(rawValue: 1 << 11)
    /// The session selects one of its listed AIDs itself before the card is handed over (CoreNFC
    /// ISO 7816 sessions do): the e-ID reader then selects the master file before EF.CardAccess.
    public static let autoSelectsAid = NfcCapabilities(rawValue: 1 << 12)
    /// The card stays in the session long enough for hundreds of APDUs (a deep EMV / e-ID read).
    /// CoreNFC sessions last ≤ 60 s: on.
    public static let longSession = NfcCapabilities(rawValue: 1 << 13)

    /// The iPhone's own NFC through CoreNFC (NFCTagReaderSession, polling .iso14443 / .iso15693 / .iso18092,
    /// and .pace for PACE-only ID cards). No MIFARE Classic, no raw frames, no payment AIDs, no emulation
    /// unless the HCE entitlement is granted (then add `.emulation`).
    public static let coreNFCiPhone: NfcCapabilities = [.iso7816, .ndefRead, .ndefWrite, .ndefLock, .mifareUltralight, .desfire, .iso15693, .felica, .autoSelectsAid, .longSession]

    /// iPad and Apple Watch: no NFC controller at all.
    public static let none: NfcCapabilities = []

    /// What Android's internal antenna does (the reference the catalogue was written for).
    public static let android: NfcCapabilities = [.iso7816, .ndefRead, .ndefWrite, .ndefLock, .mifareUltralight, .desfire, .iso15693, .felica, .mifareClassic, .rawFrames, .emulation, .paymentAids, .longSession]
}

/// The card in the field as the transport sees it (public activation data only —
/// the NfcResult `card`: uid, tech, label, atqa / sak / ats / atr, memory).
public struct CardIdentity: Sendable, Hashable {
    /// The UID (NFCTag identifier), upper hex.
    public var uid: String
    /// A catalogue technology (`NfcCatalog.Tech` raw value).
    public var tech: String
    public var label: String
    public var atqa: String?
    public var sak: String?
    /// ISO 14443-4 historical bytes / ATS (CoreNFC: historicalBytes), upper hex.
    public var ats: String?
    public var atr: String?
    public var memory: String?
    /// The AID the session selected before handing the card over (CoreNFC initialSelectedAID).
    public var selectedAid: String?

    public init(uid: String, tech: String, label: String? = nil, atqa: String? = nil, sak: String? = nil, ats: String? = nil,
                atr: String? = nil, memory: String? = nil, selectedAid: String? = nil) {
        self.uid = uid; self.tech = tech; self.label = label ?? NfcCatalog.techInfo(tech).label
        self.atqa = atqa; self.sak = sak; self.ats = ats; self.atr = atr; self.memory = memory; self.selectedAid = selectedAid
    }

    /// The identity as the contract's `card` object.
    public var json: NfcJSONObject {
        var o = NfcJSONObject()
        o["uid"] = .string(uid); o["tech"] = .string(tech); o["label"] = .string(label)
        if let v = atqa, !v.isEmpty { o["atqa"] = .string(v) }
        if let v = sak, !v.isEmpty { o["sak"] = .string(v) }
        if let v = ats, !v.isEmpty { o["ats"] = .string(v) }
        if let v = atr, !v.isEmpty { o["atr"] = .string(v) }
        if let v = memory, !v.isEmpty { o["memory"] = .string(v) }
        return o
    }
}

/// A card behind a radio — what the app's CoreNFC transport implements (one per
/// detected tag). Only `transmit`, `capabilities` and `identity` are required;
/// the other paths default to "unsupported".
public protocol CardTransport: ApduChannel, Sendable {
    /// What this transport (and the card it found) can do.
    var capabilities: NfcCapabilities { get }
    /// The card's public identity.
    func identify() async throws -> CardIdentity
    /// A MIFARE native command (Ultralight / NTAG: READ 30 p, WRITE A2 p d, GET_VERSION 60) — the
    /// transport adds the CRC (CoreNFC sendMiFareCommand). Needs `.mifareUltralight`.
    func mifareCommand(_ frame: [UInt8]) async throws -> [UInt8]
    /// A raw ISO 14443-3 frame. Needs `.rawFrames` — never on iOS.
    func rawFrame(_ frame: [UInt8]) async throws -> [UInt8]
    /// The tag's NDEF message records; nil when it is not an NDEF tag.
    func readNdef() async throws -> [NdefRecord]?
    /// Writes an NDEF message (the encoded bytes, `Ndef.encodeMessage`). Needs `.ndefWrite`.
    func writeNdef(_ records: [NdefRecord]) async throws
}

extension CardTransport {
    public func mifareCommand(_ frame: [UInt8]) async throws -> [UInt8] {
        throw NfcError.unsupported("this reader does not send MIFARE commands")
    }
    public func rawFrame(_ frame: [UInt8]) async throws -> [UInt8] {
        throw NfcError.unsupported("raw ISO 14443-3 frames are not available on this device (iOS sends APDUs only)")
    }
    public func readNdef() async throws -> [NdefRecord]? { nil }
    public func writeNdef(_ records: [NdefRecord]) async throws {
        throw NfcError.unsupported("this reader does not write NDEF")
    }
}
