// The phone as an NFC Forum Type 4 tag (6.1, extended 6.3) — the APDU logic of
// A/nfc/CardService.java (Android HCE), without the platform service. It serves
// one of the app's own cards: the room connection tag (a MIME record) or an
// M5Cet card (the container in an external record m5cet.cz:card). Only the NDEF
// application (AID D2760000850101): SELECT the application, the capability
// container (E103) or the NDEF file (E104), READ BINARY. Nothing is writable;
// with no card set it answers "not found".
//
// iOS: only with the HCE entitlement (EEA, iOS 18.1+ CardSession) — the app checks
// availability, sets `NfcCapabilities.emulation` and feeds CardSession's APDUs here.
// Without it the catalogue's emulate ops are hidden (`NfcPlatform`).

import Foundation

public struct Type4TagEmulator: Sendable {
    static let ok: [UInt8] = [0x90, 0x00], notFound: [UInt8] = [0x6a, 0x82], wrongIns: [UInt8] = [0x6d, 0x00], badP: [UInt8] = [0x6b, 0x00]

    /// The NDEF file: NLEN (2 bytes) + the message; nil = no card set.
    public private(set) var ndefFile: [UInt8]?
    private var selected: [UInt8]?

    public init() {}

    /// Serves an NDEF message (nil = none).
    public init(message: [UInt8]?) { serve(message) }

    /// The card to serve (nil = none).
    public mutating func serve(_ message: [UInt8]?) {
        ndefFile = message.map { Ndef.t4tNdefFile($0) }
        selected = nil
    }

    /// A Type 4 tag holding an M5Cet card.
    public static func m5Card(_ container: [UInt8]) throws -> Type4TagEmulator { Type4TagEmulator(message: try Ndef.encodeMessage([M5Card.ndefRecord(container)])) }

    /// A Type 4 tag holding a connection-tag body.
    public static func connection(_ body: String) throws -> Type4TagEmulator { Type4TagEmulator(message: try Ndef.encodeMessage([ConnectionCard.record(body)])) }

    /// Whether a card is served.
    public var serving: Bool { ndefFile != nil }

    /// Mapping 2.0 capability container: MLe / MLc, the NDEF file E104 of its size, read only.
    static func cc(_ size: Int) -> [UInt8] { Bytes.u8(0x00, 0x0f, 0x20, 0x00, 0x3b, 0x00, 0x34, 0x04, 0x06, 0xe1, 0x04, size >> 8, size, 0x00, 0xff) }

    /// One command APDU → the answer (CardService.processCommandApdu).
    public mutating func process(_ apdu: [UInt8]) -> [UInt8] {
        guard let file = ndefFile, apdu.count >= 4 else { return Type4TagEmulator.notFound }
        let ins = Int(apdu[1]), p1 = Int(apdu[2]), p2 = Int(apdu[3])
        if ins == 0xa4 { // SELECT
            let lc = apdu.count > 4 ? Int(apdu[4]) : 0
            let data = apdu.count >= 5 + lc ? Array(apdu[min(5, apdu.count)..<(5 + lc)]) : []
            if p1 == 0x04 && data == Ndef.t4tAid { selected = nil; return Type4TagEmulator.ok }
            if p1 == 0x00 && data == [0xe1, 0x03] { selected = Type4TagEmulator.cc(file.count); return Type4TagEmulator.ok }
            if p1 == 0x00 && data == [0xe1, 0x04] { selected = file; return Type4TagEmulator.ok }
            return Type4TagEmulator.notFound
        }
        if ins == 0xb0 { // READ BINARY
            guard let f = selected else { return Type4TagEmulator.notFound }
            let offset = p1 << 8 | p2
            var le = apdu.count > 4 ? Int(apdu[apdu.count - 1]) : 0
            if le == 0 { le = 256 }
            if offset > f.count { return Type4TagEmulator.badP }
            let n = min(le, f.count - offset)
            return Array(f[offset..<(offset + n)]) + Type4TagEmulator.ok
        }
        return Type4TagEmulator.wrongIns
    }

    /// The reader left (CardService.onDeactivated).
    public mutating func deactivated() { selected = nil }
}
