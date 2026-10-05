// An ISO 7816-4 command APDU taken apart for Core NFC (NFCISO7816APDU wants CLA,
// INS, P1, P2, the data and Le as fields — Android's IsoDep.transceive took the
// raw bytes). M5NFC builds raw APDUs; this parses them, short and extended form,
// and enforces what Core NFC accepts (Lc 1…65535, Le 1…65536 or none). The
// answer goes back raw (data ‖ SW1 SW2): 61xx / 6Cxx are M5NFC's to handle
// (Apdu.transmitSmart, TemplateRunner), exactly as on Android.
//
// Core NFC also refuses SELECT by name (P1 = 04) of an application that is not in
// Info.plist (NFCReaderErrorSecurityViolation): `selectRefusal` says so before
// the command reaches the card, with the AID in words — never a made-up answer.

import Foundation
import M5NFC

struct ApduFrame: Sendable, Hashable {
    let cla: UInt8, ins: UInt8, p1: UInt8, p2: UInt8
    /// The command data (empty = no Lc).
    let data: [UInt8]
    /// Le as Core NFC takes it: -1 = no Le field, 1…65536 (256 = short "00", 65536 = extended "0000").
    let expectedResponseLength: Int
    /// The command was in extended form (3-byte Lc / 2- or 3-byte Le).
    let extended: Bool

    /// Core NFC's limits (NFCISO7816APDU): Lc 1…65535, Le 1…65536.
    static let maxData = 65_535, maxLe = 65_536

    struct Malformed: Error, Sendable, Hashable { let reason: String }

    /// Parses case 1, 2, 3, 4 in short and extended form (ISO 7816-4 § 5.1).
    static func parse(_ apdu: [UInt8]) throws(Malformed) -> ApduFrame {
        guard apdu.count >= 4 else { throw Malformed(reason: "an APDU has at least 4 bytes (CLA INS P1 P2)") }
        let h = (apdu[0], apdu[1], apdu[2], apdu[3])
        func make(_ data: [UInt8], _ le: Int, _ ext: Bool) -> ApduFrame {
            ApduFrame(cla: h.0, ins: h.1, p1: h.2, p2: h.3, data: data, expectedResponseLength: le, extended: ext)
        }
        let body = Array(apdu[4...])
        if body.isEmpty { return make([], -1, false) }                                        // case 1
        if body.count == 1 { return make([], body[0] == 0 ? 256 : Int(body[0]), false) }      // case 2S
        if body[0] != 0 {                                                                     // short Lc
            let lc = Int(body[0])
            if body.count == 1 + lc { return make(Array(body[1...]), -1, false) }             // case 3S
            if body.count == 2 + lc { let le = Int(body[1 + lc]); return make(Array(body[1...lc]), le == 0 ? 256 : le, false) } // case 4S
            throw Malformed(reason: "Lc \(lc) does not match the \(body.count - 1) bytes that follow")
        }
        // Extended: a 00 byte, then 2 bytes (Le of case 2E, or Lc of case 3E / 4E).
        guard body.count >= 3 else { throw Malformed(reason: "a truncated extended length") }
        let n = Int(body[1]) << 8 | Int(body[2])
        if body.count == 3 { return make([], n == 0 ? maxLe : n, true) }                       // case 2E
        guard n > 0 else { throw Malformed(reason: "an extended Lc of 0") }
        if body.count == 3 + n { return make(Array(body[3..<(3 + n)]), -1, true) }            // case 3E
        if body.count == 5 + n {                                                              // case 4E
            let le = Int(body[3 + n]) << 8 | Int(body[4 + n])
            return make(Array(body[3..<(3 + n)]), le == 0 ? maxLe : le, true)
        }
        throw Malformed(reason: "extended Lc \(n) does not match the \(body.count - 3) bytes that follow")
    }

    /// The raw bytes again (short form when it fits — what Core NFC sends for these fields).
    var bytes: [UInt8] {
        var w = [cla, ins, p1, p2]
        let ext = extended || data.count > 255 || expectedResponseLength > 256
        if !data.isEmpty {
            if ext { w += [0x00, UInt8(data.count >> 8), UInt8(data.count & 0xff)] } else { w.append(UInt8(data.count)) }
            w += data
        }
        if expectedResponseLength > 0 {
            let le = expectedResponseLength
            if ext {
                if data.isEmpty { w.append(0x00) }
                w += le == ApduFrame.maxLe ? [0x00, 0x00] : [UInt8(le >> 8), UInt8(le & 0xff)]
            } else {
                w.append(le == 256 ? 0x00 : UInt8(le))
            }
        }
        return w
    }

    /// SELECT by DF name (an application).
    var selectsByName: Bool { ins == 0xa4 && p1 == 0x04 && !data.isEmpty }
}

enum CoreNFCRules {
    /// Why Core NFC would refuse this command, or nil. Only SELECT by name is checked: its AID must be one of
    /// the session's allowed AIDs (Info.plist), or a prefix / extension of one (partial selection).
    static func selectRefusal(_ frame: ApduFrame, allowed: [String]) -> String? {
        guard frame.selectsByName, !allowed.isEmpty else { return nil }
        let aid = M5NFC.Hex.encode(frame.data)
        let listed = allowed.map { $0.uppercased() }
        if listed.contains(where: { $0 == aid || $0.hasPrefix(aid) || aid.hasPrefix($0) }) { return nil }
        return "Core NFC lets the app select only the applications listed in its Info.plist — \(aid) is not one of them."
    }

    /// The AIDs of Info.plist (com.apple.developer.nfc.readersession.iso7816.select-identifiers).
    static func infoPlistAids(_ bundle: Bundle = .main) -> [String] {
        (bundle.object(forInfoDictionaryKey: "com.apple.developer.nfc.readersession.iso7816.select-identifiers") as? [String] ?? []).map { $0.uppercased() }
    }

    /// The FeliCa system codes of Info.plist (com.apple.developer.nfc.readersession.felica.systemcodes).
    static func infoPlistFelicaCodes(_ bundle: Bundle = .main) -> [String] {
        bundle.object(forInfoDictionaryKey: "com.apple.developer.nfc.readersession.felica.systemcodes") as? [String] ?? []
    }

    /// The AIDs a reading tries at discovery (iOS 26.4+ configuration): the e-ID and the NDEF application for
    /// documents and tags, what the template selects for a template — always a subset of `allowed`, in its order.
    static func discoveryAids(_ wanted: [String], allowed: [String]) -> [String] {
        let w = Set(wanted.map { $0.uppercased() })
        return allowed.filter { w.contains($0.uppercased()) }
    }
}
