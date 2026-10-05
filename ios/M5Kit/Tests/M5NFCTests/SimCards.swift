// Simulated cards (SimCards.java + MrtdDeepTest.Chip): an EMV card with any applications (PPSE and / or
// the contact PSE, counters, the log, GPO with its PDOL checked, the AFL's records and a file only a deep
// read finds), a MIFARE DESFire EV1, a plain ISO 7816-4 card answering 61xx and 6Cxx, and a BAC e-passport
// chip written from ICAO 9303-11. Each logs every command and fails the read on anything that is not one
// (VERIFY, GENERATE AC, a write).

import Foundation
@testable import M5NFC

class SimCard: ApduChannel {
    var seen = [String]()
    var forbidden = [String]()
    /// After this many commands the card leaves the field (−1: never).
    var leaveAfter = -1

    final func transmit(_ cmd: [UInt8]) async throws -> [UInt8] {
        if leaveAfter >= 0 && seen.count >= leaveAfter { throw CardFailure(message: "Tag was lost.") }
        let h = H(cmd)
        seen.append(h)
        let cla = Int(cmd[0]), ins = Int(cmd[1])
        if ins == 0x20 || (cla == 0x80 && ins == 0xae) || ins == 0xd6 || ins == 0xdc || ins == 0xe2 {
            forbidden.append(h)
            throw CardFailure(message: "the reader must only read")
        }
        return answer(cmd)
    }

    func answer(_ cmd: [UInt8]) -> [UInt8] { sw(0x6d00) }

    static func dataOf(_ cmd: [UInt8]) -> [UInt8] { cmd.count > 5 ? Bytes.slice(cmd, 5, 5 + Int(cmd[4])) : [] }
}

enum Sim {
    static let logFormat = b("9A039F21039F02065F2A029F1A029C019F4E089F3602")
    static let pdol = b("9F66049F02069F37045F2A02")

    static func logRecord(_ date: String, _ time: String, _ amount: String, _ merchant: String, _ atc: Int) -> [UInt8] {
        var m = merchant
        while m.count < 8 { m += " " }
        return b(date) + b(time) + b(amount) + b("0203") + b("0203") + b("00") + ascii(String(m.prefix(8))) + u8(atc >> 8, atc & 0xff)
    }

    static let pans = ["A0000000031010": "4111111111111111", "A0000000041010": "5413330089020011"]
    static let labels = ["A0000000031010": "VISA CREDIT", "A0000000041010": "MASTERCARD"]

    static let dir1 = T(0x61, T(0x4f, b("A0000002471001")), T(0x50, ascii("ICAO eMRTD")))
    static let dir2 = T(0x61, T(0x4f, b("A0000000041010")), T(0x50, ascii("MASTERCARD")), T(0x51, b("3F00")))
    static let atr = T(0x43, u8(0xf0)) + T(0x47, u8(0x94, 0x81, 0xc1))
}

/// An EMV card: the applications it has, whether it answers the contactless (PPSE) and the contact (PSE) directory.
final class EmvSim: SimCard {
    let aids: [String]
    let ppse: Bool, pse: Bool
    var selected: String?

    init(ppse: Bool, pse: Bool, _ aids: String...) { self.ppse = ppse; self.pse = pse; self.aids = aids }

    func pan(_ aid: String) -> String { Sim.pans[aid] ?? "6011000990139424" }
    func label(_ aid: String) -> String { Sim.labels[aid] ?? "CARD " + String(aid.suffix(4)) }

    func fci(_ aid: String) -> [UInt8] { T(0x6f, T(0x84, b(aid)), T(0xa5, T(0x50, ascii(label(aid))), T(0x87, u8(1)), T(0x9f38, Sim.pdol))) }

    func files(_ aid: String) -> [(String, [UInt8])] {
        [
            // The holder record: the PAN, Track 2 (57), Track 1 in ASCII (56) and its discretionary data (9F1F).
            ("1:1", T(0x70, T(0x5a, b(pan(aid))), T(0x5f24, b("281231")), T(0x5f20, ascii("NOVAK/JAN")), T(0x5f28, b("0203")),
                      T(0x57, b(pan(aid) + "D28122011234567890")), T(0x56, ascii("B" + pan(aid) + "^NOVAK/JAN^2812201123456789")), T(0x9f1f, ascii("1234567890")))),
            ("2:1", T(0x70, T(0x8c, b("9F02069F03069F1A02")), T(0x8e, b("000000000000000042031E031F03")))),
            // Not in the AFL — only a deep read finds it.
            ("3:1", T(0x70, T(0x9f08, b("0002")), T(0x5f30, b("0201")))),
        ]
    }

    static let log = [Sim.logRecord("250914", "183005", "000000012345", "BILLA", 41), Sim.logRecord("250912", "091500", "000000000990", "DPP", 40)]

    override func answer(_ cmd: [UInt8]) -> [UInt8] {
        let cla = Int(cmd[0]), ins = Int(cmd[1]), p1 = Int(cmd[2]), p2 = Int(cmd[3])
        if ins == 0xa4 && p1 == 0x04 {
            let name = H(SimCard.dataOf(cmd))
            if name == H(ascii("2PAY.SYS.DDF01")) {
                if !ppse { return sw(0x6a82) }
                selected = "PPSE"
                let entries = aids.enumerated().map { T(0x61, T(0x4f, b($0.element)), T(0x50, ascii(label($0.element))), T(0x87, u8($0.offset + 1))) }
                return ok(T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, entries.flatMap { $0 }))))
            }
            if name == H(ascii("1PAY.SYS.DDF01")) {
                if !pse { return sw(0x6a82) }
                selected = "PSE"
                return ok(T(0x6f, T(0x84, ascii("1PAY.SYS.DDF01")), T(0xa5, T(0x88, u8(1)), T(0x5f2d, ascii("encs")))))
            }
            if aids.contains(name) { selected = name; return ok(fci(name)) }
            return sw(0x6a82)
        }
        if cla == 0x80 && ins == 0xca {
            guard let sel = selected, !sel.hasSuffix("PSE") else { return sw(0x6985) }
            switch String(format: "%04X", p1 << 8 | p2) {
            case "9F36": return ok(T(0x9f36, u8(0x00, 0x2a)))
            case "9F13": return ok(T(0x9f13, u8(0x00, 0x28)))
            case "9F17": return ok(T(0x9f17, u8(0x03)))
            case "9F4D": return ok(T(0x9f4d, u8(0x0b, 0x02)))
            case "9F4F": return ok(T(0x9f4f, Sim.logFormat))
            default: return sw(0x6a88)
            }
        }
        if cla == 0x80 && ins == 0xa8 {
            guard let sel = selected, !sel.hasSuffix("PSE") else { return sw(0x6985) }
            let d = SimCard.dataOf(cmd)
            // The PDOL filled: tag 83, then 4 + 6 + 4 + 2 bytes.
            if d.count != 18 || d[0] != 0x83 || d[1] != 16 { return sw(0x6700) }
            return ok(T(0x77, T(0x82, b("1980")), T(0x94, b("0801010010010100"))))
        }
        if ins == 0xb2 {
            let sfi = p2 >> 3
            if selected == "PSE" {
                if sfi != 1 || p1 > aids.count { return sw(0x6a83) }
                let aid = aids[p1 - 1]
                return ok(T(0x70, T(0x61, T(0x4f, b(aid)), T(0x50, ascii(label(aid))), T(0x87, u8(p1)))))
            }
            guard let sel = selected, sel != "PPSE" else { return sw(0x6a82) }
            if sfi == 0x0b { return p1 <= EmvSim.log.count ? ok(EmvSim.log[p1 - 1]) : sw(0x6a83) }
            let fs = files(sel)
            if let f = fs.first(where: { $0.0 == "\(sfi):\(p1)" }) { return ok(f.1) }
            if fs.contains(where: { $0.0.hasPrefix("\(sfi):") }) { return sw(0x6a83) }
            return sw(0x6a82)
        }
        return sw(0x6d00)
    }
}

/// A MIFARE DESFire EV1 8K: GetVersion in three frames, two applications, 4 KB free, the PICC's key settings.
final class DesfireSim: SimCard {
    var frame = 0
    override func answer(_ cmd: [UInt8]) -> [UInt8] {
        switch H(cmd) {
        case "9060000000": frame = 1; return b("04010101001A05") + sw(0x91af)
        case "90AF000000":
            if frame == 1 { frame = 2; return b("04010101041A05") + sw(0x91af) }
            if frame == 2 { frame = 0; return b("04112233445566BA7C1234561219") + sw(0x9100) }
            return sw(0x911c)
        case "906A000000": return b("5634120D0C0B") + sw(0x9100)
        case "906E000000": return b("001000") + sw(0x9100)
        case "9045000000": return b("0F81") + sw(0x9100)
        default: return sw(0x911c)
        }
    }
}

/// A plain ISO 7816-4 card: MF, EF.DIR with two records (the first through GET RESPONSE), EF.ATR answering 6Cxx first.
final class IsoSim: SimCard {
    var current = -1
    var pending: [UInt8]?
    override func answer(_ cmd: [UInt8]) -> [UInt8] {
        let ins = Int(cmd[1]), p1 = Int(cmd[2])
        if ins == 0xa4 {
            let d = SimCard.dataOf(cmd)
            let fid = d.count == 2 ? Int(d[0]) << 8 | Int(d[1]) : -1
            if [0x3f00, 0x2f00, 0x2f01].contains(fid) { current = fid; return sw(0x9000) }
            return sw(0x6a82)
        }
        if ins == 0xb2 {
            if current != 0x2f00 { return sw(0x6986) }
            if p1 == 1 { pending = Sim.dir1; return sw(0x6100 | Sim.dir1.count) }
            if p1 == 2 { return ok(Sim.dir2) }
            return sw(0x6a83)
        }
        if ins == 0xc0 {
            guard let out = pending else { return sw(0x6985) }
            pending = nil
            return ok(out)
        }
        if ins == 0xb0 {
            if current != 0x2f01 { return sw(0x6986) }
            let le = cmd.count == 5 ? Int(cmd[4]) : -1
            if le != Sim.atr.count { return sw(0x6c00 | Sim.atr.count) }
            return ok(Sim.atr)
        }
        return sw(0x6d00)
    }
}

/* ================================================================ the e-passport (MrtdDeepTest) */

enum Doc {
    static let mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10"
    static let key = MrzKey("L898902C", "690806", "940623")
    static let jpeg = u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10) + ascii("JFIF") + fill(600, 7) + u8(0xff, 0xd9)
    static let sig = u8(0xff, 0xd8, 0xff, 0xdb) + fill(80, 3) + u8(0xff, 0xd9)

    static let dg1 = T(0x61, T(0x5f1f, ascii(mrz.replacingOccurrences(of: "\n", with: ""))))
    static let dg2 = T(0x75, T(0x7f61, T(0x02, u8(1)), T(0x7f60, T(0xa1, T(0x80, u8(1, 1))), T(0x5f2e, ascii("FAC\0") + [UInt8](repeating: 0, count: 40) + jpeg))))
    static let dg7 = T(0x67, T(0x02, u8(1)), T(0x5f43, sig))
    static let dg11 = T(0x6b, T(0x5c, u8(0x5f, 0x0e, 0x5f, 0x2b, 0x5f, 0x11, 0x5f, 0x42)), T(0x5f0e, ascii("ERIKSSON<<ANNA<MARIA")),
                        T(0x5f2b, u8(0x19, 0x69, 0x08, 0x06)), T(0x5f11, ascii("ZENITH<UTO")), T(0x5f42, ascii("123<MAPLE<STREET<<ZENITH")), T(0x5f10, ascii("ZE184226B")))
    static let dg12 = T(0x6c, T(0x5c, u8(0x5f, 0x19, 0x5f, 0x26)), T(0x5f19, ascii("UTOPIA<PASSPORT<OFFICE")), T(0x5f26, u8(0x20, 0x24, 0x01, 0x15)), T(0x5f55, ascii("20240110093000")))
    static let modulus = u8(0x00) + fill(128, 0xa5)
    static let dg15 = T(0x6f, T(0x30, T(0x30, oid("1.2.840.113549.1.1.1"), u8(0x05, 0x00)), T(0x03, u8(0x00), T(0x30, T(0x02, modulus), T(0x02, u8(1, 0, 1))))))
    static let dg14 = T(0x6e, T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.3.2.2"), integer(1)), T(0x30, oid("0.4.0.127.0.7.2.2.2"), integer(1))))
    static let com = T(0x60, T(0x5f01, ascii("0107")), T(0x5f36, ascii("040000")), T(0x5c, u8(0x61, 0x75, 0x63, 0x67, 0x6b, 0x6c, 0x6e, 0x6f)))

    static func name(_ cn: String) -> [UInt8] { T(0x30, T(0x31, T(0x30, oid("2.5.4.6"), T(0x13, ascii("UT")))), T(0x31, T(0x30, oid("2.5.4.3"), T(0x0c, ascii(cn))))) }

    static func certificate() -> [UInt8] {
        let tbs = T(0x30, T(0xa0, integer(2)), T(0x02, u8(0x12, 0x34)), T(0x30, oid("1.2.840.113549.1.1.11")), name("CSCA Utopia"),
                    T(0x30, T(0x17, ascii("240101000000Z")), T(0x17, ascii("340101000000Z"))), name("DS Utopia 1"),
                    T(0x30, T(0x30, oid("1.2.840.113549.1.1.1")), T(0x03, u8(0))))
        return T(0x30, tbs, T(0x30, oid("1.2.840.113549.1.1.11")), T(0x03, u8(0, 1, 2)))
    }

    static func sod(_ groups: [(Int, [UInt8])], tamper: Int) -> [UInt8] {
        var hashes = [UInt8]()
        for (n, g) in groups.sorted(by: { $0.0 < $1.0 }) {
            var h = NfcHash.sha256(g)
            if n == tamper { h[0] ^= 1 }
            hashes += T(0x30, integer(n), T(0x04, h))
        }
        let lds = T(0x30, integer(0), T(0x30, oid("2.16.840.1.101.3.4.2.1")), T(0x30, hashes))
        let signedData = T(0x30, integer(3), T(0x31, T(0x30, oid("2.16.840.1.101.3.4.2.1"))), T(0x30, oid("2.23.136.1.1.1"), T(0xa0, T(0x04, lds))),
                           T(0xa0, certificate()), T(0x31))
        return T(0x77, T(0x30, oid("1.2.840.113549.1.7.2"), T(0xa0, signedData)))
    }

    static func files(tamper: Int = -1) -> [Int: [UInt8]] {
        let groups: [(Int, [UInt8])] = [(1, dg1), (2, dg2), (7, dg7), (11, dg11), (12, dg12), (14, dg14), (15, dg15)]
        return [0x011e: com, 0x011d: sod(groups, tamper: tamper), 0x0101: dg1, 0x0102: dg2, 0x0107: dg7, 0x010b: dg11, 0x010c: dg12, 0x010e: dg14, 0x010f: dg15]
    }
}

/// A BAC chip from the spec: plain until mutual authentication, then every APDU in secure messaging.
final class BacChip: ApduChannel {
    var log = [String]()
    /// Every file id the chip was asked to SELECT (plain or in SM, decrypted).
    var selected = [Int]()
    var files: [Int: [UInt8]]
    let cardAccess: [UInt8]?
    let kenc: [UInt8], kmac: [UInt8]
    var rndIcc = [UInt8]()
    var ksenc: [UInt8]?, ksmac = [UInt8](), ssc = [UInt8]()
    var current: Int?

    init(_ key: MrzKey, _ files: [Int: [UInt8]], cardAccess: [UInt8]? = nil) {
        self.files = files; self.cardAccess = cardAccess
        let k = Bac.keys(key)
        kenc = k.kenc; kmac = k.kmac
    }

    static func inc(_ s: inout [UInt8]) { var i = s.count - 1; while i >= 0 { s[i] &+= 1; if s[i] != 0 { break }; i -= 1 } }
    static func unpad(_ d: [UInt8]) -> [UInt8] { var i = d.count - 1; while i >= 0 && d[i] == 0 { i -= 1 }; return Bytes.slice(d, 0, i) }

    /// Plain command logic: SELECT / READ BINARY over the files.
    func run(_ ins: Int, _ p1: Int, _ p2: Int, _ data: [UInt8], _ le: Int?) -> ([UInt8], Int) {
        if ins == 0xa4 && p1 == 0x04 { return ([], H(data) == "A0000002471001" ? 0x9000 : 0x6a82) }
        if ins == 0xa4 {
            guard data.count >= 2 else { return ([], 0x6a80) }
            let fid = Int(data[0]) << 8 | Int(data[1])
            selected.append(fid)
            if fid == 0x011c && cardAccess != nil { current = fid; return ([], 0x9000) }
            if fid == 0x0103 || fid == 0x0104 { return ([], 0x6982) }
            if files[fid] == nil { return ([], 0x6a82) }
            current = fid
            return ([], 0x9000)
        }
        if ins == 0xb0 {
            guard let c = current, let f = c == 0x011c ? cardAccess : files[c] else { return ([], 0x6986) }
            let off = p1 << 8 | p2
            let n = le == nil || le == 0 ? 256 : le!
            return (Bytes.slice(f, off, off + n), off + n > f.count ? 0x6282 : 0x9000)
        }
        return ([], 0x6d00)
    }

    func transmit(_ a: [UInt8]) async throws -> [UInt8] {
        log.append(H(a))
        guard let ksenc else {
            let ins = Int(a[1]), p1 = Int(a[2]), p2 = Int(a[3])
            if ins == 0x84 { rndIcc = NfcCrypto.random(8); return rndIcc + sw(0x9000) }
            if ins == 0x82 {
                let body = Bytes.slice(a, 5, 5 + Int(a[4]))
                let eifd = Bytes.slice(body, 0, 32), mifd = Bytes.slice(body, 32, 40)
                guard try Des.retailMac(kmac, Des.pad(eifd)) == mifd else { return sw(0x6300) }
                let s = try Des.tdesCbcDecrypt(kenc, eifd)
                let rndIfd = Bytes.slice(s, 0, 8), kifd = Bytes.slice(s, 16, 32)
                guard Bytes.slice(s, 8, 16) == rndIcc else { return sw(0x6300) }
                let kicc = NfcCrypto.random(16)
                let eicc = try Des.tdesCbcEncrypt(kenc, rndIcc + rndIfd + kicc)
                let micc = try Des.retailMac(kmac, Des.pad(eicc))
                let seed = (0..<16).map { kifd[$0] ^ kicc[$0] }
                self.ksenc = Bac.deriveKey(seed, 1); ksmac = Bac.deriveKey(seed, 2)
                ssc = Bytes.slice(rndIcc, 4, 8) + Bytes.slice(rndIfd, 4, 8)
                return eicc + micc + sw(0x9000)
            }
            let lc = a.count > 5 ? Int(a[4]) : 0
            let le: Int? = a.count == 5 ? Int(a[4]) : a.count > 5 + lc ? Int(a[5 + lc]) : nil
            let r = run(ins, p1, p2, Bytes.slice(a, 5, 5 + lc), le)
            return r.0 + sw(r.1)
        }
        // Secure messaging: check the MAC, decrypt, run, wrap the answer.
        guard a[0] & 0x0c == 0x0c else { return sw(0x6987) }
        var do87: [UInt8]?, do97: [UInt8]?, do8e: [UInt8]?
        for n in BerTlv.decode(Bytes.slice(a, 5, 5 + Int(a[4])), recurse: false) {
            if n.tag == 0x87 { do87 = n.value } else if n.tag == 0x97 { do97 = n.value } else if n.tag == 0x8e { do8e = n.value }
        }
        BacChip.inc(&ssc)
        let macIn = Des.pad(ssc + Des.pad(Bytes.slice(a, 0, 4)) + (do87.map { T(0x87, $0) } ?? []) + (do97.map { T(0x97, $0) } ?? []))
        guard let mac = do8e, try Des.retailMac(ksmac, macIn) == mac else { return sw(0x6988) }
        let data = try do87.map { BacChip.unpad(try Des.tdesCbcDecrypt(ksenc, Bytes.slice($0, 1))) } ?? []
        let r = run(Int(a[1]), Int(a[2]), Int(a[3]), data, do97.map { Int($0[0]) })
        BacChip.inc(&ssc)
        let r87 = r.0.isEmpty ? [] : T(0x87, u8(0x01), try Des.tdesCbcEncrypt(ksenc, Des.pad(r.0)))
        let r99 = T(0x99, sw(r.1))
        let rmac = try Des.retailMac(ksmac, Des.pad(ssc + r87 + r99))
        return r87 + r99 + T(0x8e, rmac) + sw(0x9000)
    }
}
