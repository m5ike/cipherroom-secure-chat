// BAC — Basic Access Control (6.5), ICAO 9303 Part 11 — A/nfc/Bac.java (bac.ts).
// The holder opens their own travel document with the key the MRZ carries
// (document number, date of birth, date of expiry): a mutual authentication
// yields session keys and every later APDU is wrapped in secure messaging. The
// document's own access mechanism, not a bypass — and it only reads. Pinned
// byte for byte to the ICAO worked example (BacDesTests).

import Foundation
import M5Core

/// The three MRZ fields the document key is made of.
public struct MrzKey: Sendable, Hashable {
    public let documentNumber: String, dateOfBirth: String, dateOfExpiry: String
    public init(_ documentNumber: String, _ dateOfBirth: String, _ dateOfExpiry: String) {
        self.documentNumber = documentNumber; self.dateOfBirth = dateOfBirth; self.dateOfExpiry = dateOfExpiry
    }
}

/// One plain answer through secure messaging: the data and the real status word (Bac.Sm / SmChannel.Reply).
public struct SmReply: Sendable, Hashable {
    public let data: [UInt8]
    public let sw: Int
    public init(data: [UInt8], sw: Int) { self.data = data; self.sw = sw }
}

public enum Bac {
    static func checkValue(_ c: Character) -> Int {
        guard let a = c.asciiValue else { return 0 }
        if a >= 0x30 && a <= 0x39 { return Int(a - 0x30) }
        if a >= 0x41 && a <= 0x5a { return 10 + Int(a - 0x41) }
        return 0 // '<' and everything else
    }

    /// ICAO check digit (weights 7, 3, 1) over A–Z, 0–9 and '<'.
    public static func checkDigit(_ field: String) -> String {
        let w = [7, 3, 1]
        var sum = 0
        for (i, c) in JSText.upperASCII(field).enumerated() { sum += checkValue(c) * w[i % 3] }
        return String(sum % 10)
    }

    static func padEnd(_ s: String, _ len: Int, _ c: Character) -> String { s.count >= len ? s : s + String(repeating: c, count: len - s.count) }
    static func left(_ s: String, _ n: Int) -> String { String(s.prefix(n)) }

    /// The MRZ information string the BAC seed is hashed from.
    public static func mrzInformation(_ key: MrzKey) -> String {
        let doc = left(padEnd(JSText.upperASCII(key.documentNumber).replacingRegex("[^A-Z0-9<]", with: ""), 9, "<"), 9)
        let dob = left(key.dateOfBirth.replacingRegex("\\D", with: ""), 6)
        let exp = left(key.dateOfExpiry.replacingRegex("\\D", with: ""), 6)
        return doc + checkDigit(doc) + dob + checkDigit(dob) + exp + checkDigit(exp)
    }

    static func sub(_ s: String, _ from: Int, _ to: Int) -> String {
        let c = Array(s)
        return from < c.count ? String(c[from..<min(to, c.count)]) : ""
    }

    /// Reads the BAC key fields out of a 2- or 3-line MRZ (TD1 / TD2 / TD3).
    public static func mrzKey(fromMrz mrz: String) -> MrzKey? {
        let lines = JSText.upperASCII(mrz).components(separatedBy: "\n").map { $0.replacingRegex("\\s", with: "") }.filter { !$0.isEmpty }
        if lines.count == 2 && lines[0].count >= 36 && lines[1].count >= 36 {
            let l2 = lines[1]
            return MrzKey(sub(l2, 0, 9).replacingOccurrences(of: "<", with: ""), sub(l2, 13, 19), sub(l2, 21, 27))
        }
        if lines.count == 2 && lines[0].count >= 30 {
            let l1 = lines[0], l2 = lines[1]
            guard l2.count >= 14 else { return nil }
            return MrzKey(sub(l1, 5, 14).replacingOccurrences(of: "<", with: ""), sub(l2, 0, 6), sub(l2, 8, 14))
        }
        if lines.count == 3 && lines[0].count >= 30 {
            let l1 = lines[0], l2 = lines[1]
            guard l2.count >= 14 else { return nil }
            return MrzKey(sub(l1, 5, 14).replacingOccurrences(of: "<", with: ""), sub(l2, 0, 6), sub(l2, 8, 14))
        }
        if lines.count >= 2 && lines[1].count >= 28 {
            let l2 = lines[1]
            return MrzKey(sub(l2, 0, 9).replacingOccurrences(of: "<", with: ""), sub(l2, 13, 19), sub(l2, 21, 27))
        }
        return nil
    }

    /* ------------------------------------------------------------ keys */

    static func fixParity(_ k: [UInt8]) -> [UInt8] {
        k.map { x in
            let b = x & 0xfe
            return b | (b.nonzeroBitCount % 2 == 0 ? 1 : 0)
        }
    }

    /// One 16-byte 2-key 3DES key from a seed and a counter (1 = enc, 2 = mac).
    public static func deriveKey(_ seed: [UInt8], _ counter: Int) -> [UInt8] {
        let h = NfcHash.sha1(seed + Bytes.u8(0, 0, 0, counter))
        return fixParity(Array(h[0..<16]))
    }

    public struct Keys: Sendable { public let kenc: [UInt8], kmac: [UInt8], seed: [UInt8] }

    /// Kenc and Kmac from the MRZ information (the BAC seed = SHA1(MRZ info)[0:16]).
    public static func keys(_ key: MrzKey) -> Keys {
        let seed = Array(NfcHash.sha1(Bytes.latin1(mrzInformation(key)))[0..<16])
        return Keys(kenc: deriveKey(seed, 1), kmac: deriveKey(seed, 2), seed: seed)
    }

    /* ------------------------------------------------------------ mutual authentication */

    /// The EXTERNAL AUTHENTICATE command data (Eifd ‖ Mifd).
    public static func mutualAuthCommand(kenc: [UInt8], kmac: [UInt8], rndIfd: [UInt8], rndIcc: [UInt8], kifd: [UInt8]) throws -> [UInt8] {
        let eifd = try Des.tdesCbcEncrypt(kenc, rndIfd + rndIcc + kifd)
        return eifd + (try Des.retailMac(kmac, Des.pad(eifd)))
    }

    /// The secure-messaging state: the session keys and the send sequence counter, advanced in place.
    public final class Session {
        public let ksenc: [UInt8], ksmac: [UInt8]
        public var ssc: [UInt8]
        public init(ksenc: [UInt8], ksmac: [UInt8], ssc: [UInt8]) { self.ksenc = ksenc; self.ksmac = ksmac; self.ssc = ssc }
    }

    /// Verifies the chip's answer and derives the session keys + the SSC.
    public static func session(kenc: [UInt8], kmac: [UInt8], rndIfd: [UInt8], rndIcc: [UInt8], kifd: [UInt8], response: [UInt8]) throws -> Session {
        guard response.count >= 40 else { throw NfcError(.authFailed, "mutual authenticate answer too short") }
        let eicc = Array(response[0..<32]), micc = Array(response[32..<40])
        guard try Des.retailMac(kmac, Des.pad(eicc)) == micc else { throw NfcError(.authFailed, "the document's MAC did not verify (wrong MRZ?)") }
        let r = try Des.tdesCbcDecrypt(kenc, eicc)
        let rndIfdBack = Array(r[8..<16]), kicc = Array(r[16..<32])
        guard rndIfdBack == rndIfd else { throw NfcError(.authFailed, "the document did not echo our nonce (wrong MRZ?)") }
        let seed = (0..<16).map { kifd[$0] ^ kicc[$0] }
        let ssc = Array(rndIcc[4..<8]) + Array(rndIfd[4..<8])
        return Session(ksenc: deriveKey(seed, 1), ksmac: deriveKey(seed, 2), ssc: ssc)
    }

    /* ------------------------------------------------------------ secure messaging */

    static func incSsc(_ ssc: inout [UInt8]) {
        var i = ssc.count - 1
        while i >= 0 { ssc[i] &+= 1; if ssc[i] != 0 { break }; i -= 1 }
    }

    static func len1(_ n: Int) -> [UInt8] {
        if n < 0x80 { return Bytes.u8(n) }
        if n < 0x100 { return Bytes.u8(0x81, n) }
        return Bytes.u8(0x82, n >> 8, n)
    }

    /// Wraps a plain [CLA INS P1 P2 (Lc data)(Le)] APDU in 3DES secure messaging (advances the SSC).
    public static func protect(_ s: Session, _ apdu: [UInt8]) throws -> [UInt8] {
        guard apdu.count >= 4 else { throw NfcError(.invalidArgument, "APDU shorter than 4 bytes") }
        let cla = Int(apdu[0]) | 0x0c, ins = Int(apdu[1]), p1 = Int(apdu[2]), p2 = Int(apdu[3])
        var data = [UInt8]()
        var le = -1
        if apdu.count == 5 { le = Int(apdu[4]) } else if apdu.count > 5 {
            let lc = Int(apdu[4])
            data = Bytes.slice(apdu, 5, 5 + lc)
            if apdu.count > 5 + lc { le = Int(apdu[5 + lc]) }
        }
        incSsc(&s.ssc)
        let header = Des.pad(Bytes.u8(cla, ins, p1, p2))
        var do87 = [UInt8](), do97 = [UInt8]()
        if !data.isEmpty {
            let body = [0x01] + (try Des.tdesCbcEncrypt(s.ksenc, Des.pad(data)))
            do87 = [0x87] + len1(body.count) + body
        }
        if le >= 0 { do97 = Bytes.u8(0x97, 0x01, le) }
        let cc = try Des.retailMac(s.ksmac, Des.pad(s.ssc + header + do87 + do97))
        let body = do87 + do97 + [0x8e, 0x08] + cc
        return Bytes.u8(cla, ins, p1, p2) + len1(body.count) + body + [0x00]
    }

    static func readLen(_ body: [UInt8], _ i: inout Int) -> Int {
        var L = Int(body[i]); i += 1
        if L == 0x81 { if i >= body.count { return -1 }; L = Int(body[i]); i += 1 }
        else if L == 0x82 { if i + 1 >= body.count { return -1 }; L = Int(body[i]) << 8 | Int(body[i + 1]); i += 2 }
        return L
    }

    /// Unwraps a secure-messaging answer → the plain data and the real status word (advances the SSC).
    public static func unprotect(_ s: Session, _ resp: [UInt8]) throws -> SmReply {
        guard resp.count >= 2 else { throw NfcError.protocolError("Response shorter than SW1SW2 (\(resp.count) bytes)") }
        var sw = Int(resp[resp.count - 2]) << 8 | Int(resp[resp.count - 1])
        let body = Array(resp[0..<(resp.count - 2)])
        incSsc(&s.ssc)
        var i = 0
        var do87 = [UInt8](), do99 = [UInt8](), do8e = [UInt8](), encData = [UInt8]()
        while i < body.count {
            let tag = body[i]; i += 1
            if i >= body.count { break } // no length byte — tolerate a trailing byte (as the web does)
            let L = readLen(body, &i)
            if L < 0 || i + L > body.count { break }
            let v = Array(body[i..<(i + L)]); i += L
            if tag == 0x87 { do87 = [0x87] + len1(L) + v; encData = Bytes.slice(v, 1) }
            else if tag == 0x99 { do99 = [0x99] + len1(L) + v }
            else if tag == 0x8e { do8e = v }
        }
        // 6.7 (audit N18): data or a protected status without DO'8E was taken unchecked — a relay could strip the MAC.
        if do8e.isEmpty && (!do87.isEmpty || !do99.isEmpty) { throw NfcError.protocolError("secure messaging: the response carries no MAC") }
        if !do8e.isEmpty {
            let mac = try Des.retailMac(s.ksmac, Des.pad(s.ssc + do87 + do99))
            guard Bytes.constantTimeEqual(mac, do8e) else { throw NfcError.protocolError("secure-messaging MAC did not verify") }
        }
        // 6.6: the processing status the chip protected (DO'99') is the command's real status.
        if do99.count == 4 { sw = Int(do99[2]) << 8 | Int(do99[3]) }
        if encData.isEmpty { return SmReply(data: [], sw: sw) }
        return SmReply(data: Des.unpad(try Des.tdesCbcDecrypt(s.ksenc, encData)), sw: sw)
    }
}

/// A secure-messaging channel — what BAC and PACE both give the e-ID reader once the
/// holder's document is open: send a plain APDU, get the plain answer (A/nfc/SmChannel.java,
/// PaceProtocol.Channel). BAC wraps with 3DES + retail MAC, PACE with AES + CMAC or 3DES.
public protocol SecureMessagingChannel: AnyObject {
    /// How the document was opened: "bac" or "pace".
    var kind: String { get }
    /// One exchange: protect → transmit → unprotect.
    func send(_ plainApdu: [UInt8]) async throws -> SmReply
}

/// The channel a BAC session gives (3DES secure messaging, ICAO 9303-11 § 9.8).
public final class BacChannel: SecureMessagingChannel {
    public let kind: String
    let transport: any ApduChannel
    public let session: Bac.Session

    public init(_ transport: any ApduChannel, _ session: Bac.Session, kind: String = "bac") {
        self.transport = transport; self.session = session; self.kind = kind
    }

    public func send(_ plainApdu: [UInt8]) async throws -> SmReply {
        let resp = try await transport.transmit(try Bac.protect(session, plainApdu))
        return try Bac.unprotect(session, resp)
    }
}
