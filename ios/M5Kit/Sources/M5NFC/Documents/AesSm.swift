// AES secure messaging (6.6), ICAO 9303-11 § 9.8.7 — A/nfc/AesSm.java (the AES
// half of sm.ts): what PACE with an AES suite gives the e-ID reader. Pinned to
// the BSI TR-03110 worked example's 21 logged APDUs (PaceTests).
//
// Commands: CLA | 0C, the data encrypted (AES-CBC, IV = E(KSenc, SSC)) in DO87
// (DO85 for an odd INS), Le in DO97, DO8E = CMAC(KSmac, SSC ‖ header ‖ DOs) cut
// to 8 bytes; short or extended length. Answers: DO8E checked over the SSC and
// every other data object, DO87 / DO85 decrypted, the status word from DO99; a
// bare status word (the chip's answer to a secure-messaging error) comes back
// as it is. The 16-byte SSC (zero after PACE) is incremented before each wrap
// and each unwrap.

import Foundation

public final class AesSm {
    public let ksenc: [UInt8], ksmac: [UInt8]
    /// The send sequence counter, advanced as secure messaging goes on.
    public private(set) var ssc: [UInt8]

    public init(ksenc: [UInt8], ksmac: [UInt8], ssc: [UInt8]) throws {
        guard ssc.count == 16 else { throw NfcError(.invalidArgument, "the AES SSC is 16 bytes") }
        self.ksenc = ksenc; self.ksmac = ksmac; self.ssc = ssc
    }

    static func pad16(_ d: [UInt8]) -> [UInt8] { Des.pad(d, block: 16) }

    static func unpad16(_ d: [UInt8]) throws -> [UInt8] {
        var i = d.count - 1
        while i >= 0 && d[i] == 0 { i -= 1 }
        guard i >= 0, d[i] == 0x80 else { throw PaceError(.protocolError, "secure messaging: the response padding is wrong") }
        return Array(d[0..<i])
    }

    /* ------------------------------------------------------------ commands */

    struct Command { let header: [UInt8], data: [UInt8], le: [UInt8]?, extended: Bool }

    static func parseCommand(_ a: [UInt8]) throws -> Command {
        guard a.count >= 4 else { throw NfcError(.invalidArgument, "APDU shorter than 4 bytes") }
        let header = Array(a[0..<4])
        if a.count == 4 { return Command(header: header, data: [], le: nil, extended: false) }
        if a.count == 5 { return Command(header: header, data: [], le: [a[4]], extended: false) }
        if a[4] == 0x00 { // extended: 00 Lc1 Lc2 (data) (Le1 Le2), or 00 Le1 Le2
            if a.count == 7 { return Command(header: header, data: [], le: Array(a[5..<7]), extended: true) }
            let lc = Int(a[5]) << 8 | Int(a[6])
            let rest = a.count - 7 - lc
            guard lc != 0, rest == 0 || rest == 2 else { throw NfcError(.invalidArgument, "inconsistent extended APDU length") }
            return Command(header: header, data: Array(a[7..<(7 + lc)]), le: rest != 0 ? Array(a[(7 + lc)...]) : nil, extended: true)
        }
        let lc = Int(a[4])
        let rest = a.count - 5 - lc
        guard rest == 0 || rest == 1 else { throw NfcError(.invalidArgument, "inconsistent APDU length (Lc=\(lc), total=\(a.count))") }
        return Command(header: header, data: Array(a[5..<(5 + lc)]), le: rest != 0 ? Array(a[(5 + lc)...]) : nil, extended: false)
    }

    /// Wraps a plain APDU (short or extended); increments the SSC first.
    public func protect(_ cmd: [UInt8]) throws -> [UInt8] {
        let c = try AesSm.parseCommand(cmd)
        let head: [UInt8] = [c.header[0] | 0x0c, c.header[1], c.header[2], c.header[3]]
        Bac.incSsc(&ssc)
        var doData = [UInt8]()
        if !c.data.isEmpty {
            let enc = try Aes.cbcEncrypt(ksenc, AesSm.pad16(c.data), iv: try Aes.encryptBlock(ksenc, ssc))
            doData = head[1] & 1 != 0 ? BerTlv.encode(0x85, enc) : BerTlv.encode(0x87, [0x01] + enc)
        }
        let do97 = c.le.map { BerTlv.encode(0x97, $0) } ?? []
        let mac = Array(try Aes.cmac(ksmac, AesSm.pad16(ssc + AesSm.pad16(head) + doData + do97))[0..<8])
        let body = doData + do97 + BerTlv.encode(0x8e, mac)
        if c.extended || body.count > 0xff { return head + Bytes.u8(0x00, body.count >> 8, body.count) + body + [0x00, 0x00] }
        return head + [UInt8(body.count)] + body + [0x00]
    }

    /* ------------------------------------------------------------ answers */

    /// Unwraps an answer (data ‖ SW): checks DO8E, decrypts DO87 / DO85, returns the plain data with
    /// DO99's status word (the outer one when there is none). Increments the SSC first.
    public func unprotect(_ resp: [UInt8]) throws -> SmReply {
        guard resp.count >= 2 else { throw PaceError(.protocolError, "Response shorter than SW1SW2 (\(resp.count) bytes)") }
        let outer = Int(resp[resp.count - 2]) << 8 | Int(resp[resp.count - 1])
        let body = Array(resp[0..<(resp.count - 2)])
        Bac.incSsc(&ssc)
        if body.isEmpty { return SmReply(data: [], sw: outer) }
        var covered = [UInt8]()
        var mac: [UInt8]? = nil, cryptogram: [UInt8]? = nil
        var sw = -1
        var i = 0
        while i < body.count {
            let (tag, tagSize) = try AesSm.readTag(body, i)
            let (len, lenSize) = try AesSm.readLength(body, i + tagSize)
            let start = i + tagSize + lenSize
            guard start <= body.count, len <= body.count - start else { throw PaceError(.protocolError, "secure messaging: truncated response") }
            let end = start + len
            let value = Array(body[start..<end])
            if tag == 0x8e { mac = value } else {
                covered += body[i..<end]
                if tag == 0x87 {
                    guard let first = value.first, first == 0x01 else { throw PaceError(.protocolError, "secure messaging: unknown padding indicator") }
                    cryptogram = Array(value.dropFirst())
                } else if tag == 0x85 { cryptogram = value }
                else if tag == 0x99 && value.count == 2 { sw = Int(value[0]) << 8 | Int(value[1]) }
            }
            i = end
        }
        guard let mac else { throw PaceError(.protocolError, "secure messaging: the response carries no MAC") }
        let want = Array(try Aes.cmac(ksmac, AesSm.pad16(ssc + covered))[0..<8])
        guard Bytes.constantTimeEqual(want, mac) else { throw PaceError(.protocolError, "secure-messaging MAC did not verify") }
        var data = [UInt8]()
        if let cg = cryptogram, !cg.isEmpty {
            guard cg.count % 16 == 0 else { throw PaceError(.protocolError, "AES-CBC data must be a whole number of 16-byte blocks") }
            data = try AesSm.unpad16(try Aes.cbcDecrypt(ksenc, cg, iv: try Aes.encryptBlock(ksenc, ssc)))
        }
        return SmReply(data: data, sw: sw >= 0 ? sw : outer)
    }

    static func readTag(_ buf: [UInt8], _ off: Int) throws -> (Int, Int) {
        guard off < buf.count else { throw PaceError(.protocolError, "TLV: tag beyond buffer") }
        var tag = Int(buf[off]), size = 1
        if tag & 0x1f == 0x1f {
            repeat {
                guard off + size < buf.count else { throw PaceError(.protocolError, "TLV: truncated multi-byte tag") }
                tag = BerTlv.appendTagByte(tag, buf[off + size])
                size += 1
            } while buf[off + size - 1] & 0x80 != 0
        }
        return (tag, size)
    }

    static func readLength(_ buf: [UInt8], _ off: Int) throws -> (Int, Int) {
        guard off < buf.count else { throw PaceError(.protocolError, "TLV: length beyond buffer") }
        let first = Int(buf[off])
        if first < 0x80 { return (first, 1) }
        let n = first & 0x7f
        guard n != 0, n <= 4 else { throw PaceError(.protocolError, "TLV: unsupported length form 0x" + String(first, radix: 16)) }
        guard off + n < buf.count else { throw PaceError(.protocolError, "TLV: truncated length") }
        var length: UInt64 = 0
        for i in 1...n { length = (length << 8) | UInt64(buf[off + i]) }
        guard length <= UInt64(Int32.max) else { throw PaceError(.protocolError, "secure messaging: truncated response") }
        return (Int(length), 1 + n)
    }
}
