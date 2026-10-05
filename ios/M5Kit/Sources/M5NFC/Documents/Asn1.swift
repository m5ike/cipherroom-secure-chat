// Small DER helpers (6.6) for the travel-document security objects — EF.SOD (a
// CMS SignedData), DG14 / EF.CardAccess (SecurityInfos), DG15 (a public key)
// and the document signer's X.509 certificate. A/nfc/Asn1.java (asn1.ts).
// Reading only: names, dates, OIDs, hashes. Nothing here verifies a signature.

import Foundation
import M5Core

public enum Asn1 {
    public static let SEQ = 0x30, SET = 0x31, OID = 0x06, INT = 0x02, OCTETS = 0x04, BITS = 0x03

    /// DER children of a node (an OCTET STRING / BIT STRING holding DER is parsed on demand).
    public static func kids(_ n: Tlv?) -> [Tlv] {
        guard let n else { return [] }
        if let c = n.children { return c }
        return BerTlv.decode(n.tag == BITS ? Bytes.slice(n.value, 1) : n.value, recurse: true)
    }

    /// Parses DER, tolerating trailing garbage.
    public static func der(_ bytes: [UInt8]) -> [Tlv] { BerTlv.decode(bytes, recurse: true) }

    /// The i-th element, or nil.
    public static func at(_ list: [Tlv]?, _ i: Int) -> Tlv? {
        guard let list, i >= 0, i < list.count else { return nil }
        return list[i]
    }

    /// An OBJECT IDENTIFIER's value → dotted text.
    public static func oidText(_ v: [UInt8]) -> String {
        guard let first = v.first else { return "" }
        var s = "\(first / 40).\(first % 40)"
        var n: UInt64 = 0
        for b in v.dropFirst() {
            n = n &* 128 &+ UInt64(b & 0x7f)
            if b & 0x80 == 0 { s += ".\(n)"; n = 0 }
        }
        return s
    }

    /// Dotted text → an OBJECT IDENTIFIER's value bytes.
    public static func oidBytes(_ text: String) -> [UInt8] {
        let p = text.split(separator: ".").map { UInt64($0) ?? 0 }
        guard p.count >= 2 else { return [] }
        var out: [UInt8] = [UInt8(truncatingIfNeeded: p[0] * 40 + p[1])]
        for k in 2..<p.count {
            var v = p[k]
            var enc: [UInt8] = [UInt8(v & 0x7f)]
            v >>= 7
            while v > 0 { enc.insert(UInt8((v & 0x7f) | 0x80), at: 0); v >>= 7 }
            out += enc
        }
        return out
    }

    /// An INTEGER's value (its last six bytes at most).
    public static func intValue(_ v: [UInt8]) -> Int64 {
        var n: Int64 = 0
        for b in v.suffix(6) { n = n * 256 + Int64(b) }
        return n
    }

    /// Well-known OIDs the travel documents use (asn1.ts OID_NAMES).
    public static let oidNames: [String: String] = {
        var m: [String: String] = [
            "1.3.14.3.2.26": "SHA-1",
            "2.16.840.1.101.3.4.2.4": "SHA-224",
            "2.16.840.1.101.3.4.2.1": "SHA-256",
            "2.16.840.1.101.3.4.2.2": "SHA-384",
            "2.16.840.1.101.3.4.2.3": "SHA-512",
            "1.2.840.113549.1.1.1": "RSA",
            "1.2.840.10045.2.1": "EC",
            "1.2.840.113549.1.7.2": "CMS signed data",
            "2.23.136.1.1.1": "LDS security object",
            "2.23.136.1.1.5": "Active Authentication",
            "0.4.0.127.0.7.2.2.1.1": "Chip Authentication key (DH)",
            "0.4.0.127.0.7.2.2.1.2": "Chip Authentication key (ECDH)",
            "0.4.0.127.0.7.2.2.2": "Terminal Authentication",
            "0.4.0.127.0.7.2.2.3.1.1": "Chip Authentication (DH, 3DES)",
            "0.4.0.127.0.7.2.2.3.1.2": "Chip Authentication (DH, AES-128)",
            "0.4.0.127.0.7.2.2.3.1.3": "Chip Authentication (DH, AES-192)",
            "0.4.0.127.0.7.2.2.3.1.4": "Chip Authentication (DH, AES-256)",
            "0.4.0.127.0.7.2.2.3.2.1": "Chip Authentication (ECDH, 3DES)",
            "0.4.0.127.0.7.2.2.3.2.2": "Chip Authentication (ECDH, AES-128)",
            "0.4.0.127.0.7.2.2.3.2.3": "Chip Authentication (ECDH, AES-192)",
            "0.4.0.127.0.7.2.2.3.2.4": "Chip Authentication (ECDH, AES-256)",
            "0.4.0.127.0.7.2.2.4.6.2": "PACE ECDH-CAM AES-128",
            "0.4.0.127.0.7.2.2.4.6.3": "PACE ECDH-CAM AES-192",
            "0.4.0.127.0.7.2.2.4.6.4": "PACE ECDH-CAM AES-256",
            "0.4.0.127.0.7.2.2.5": "Restricted Identification",
            "0.4.0.127.0.7.2.2.6": "Card info",
            "0.4.0.127.0.7.2.2.12": "PACE domain parameters",
            "1.2.840.10045.3.1.7": "NIST P-256",
            "1.3.132.0.34": "NIST P-384",
            "1.3.132.0.35": "NIST P-521",
            "1.3.36.3.3.2.8.1.1.7": "brainpoolP256r1",
            "1.3.36.3.3.2.8.1.1.11": "brainpoolP384r1",
            "1.3.36.3.3.2.8.1.1.13": "brainpoolP512r1",
            "2.5.4.3": "CN", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.5": "serialNumber",
        ]
        let maps = [("1", "DH-GM"), ("2", "ECDH-GM"), ("3", "DH-IM"), ("4", "ECDH-IM")]
        let ciphers = [("1", "3DES"), ("2", "AES-128"), ("3", "AES-192"), ("4", "AES-256")]
        for (mk, mn) in maps { for (ck, cn) in ciphers { m["0.4.0.127.0.7.2.2.4.\(mk).\(ck)"] = "PACE \(mn) \(cn)" } }
        return m
    }()

    public static func oidName(_ oid: String) -> String { oidNames[oid] ?? oid }

    /// Strict UTF-8, else Latin-1 (card text is not always well-formed).
    public static func text(_ v: [UInt8]) -> String {
        if let s = String(validating: v, as: UTF8.self) { return s }
        return Bytes.latin1String(v)
    }

    /// An X.500 Name → "CN=…, O=…, C=…".
    public static func nameText(_ n: Tlv?) -> String {
        var parts = [String]()
        for rdn in kids(n) {
            for atv in kids(rdn) {
                let k = kids(atv)
                guard let type = at(k, 0), let value = at(k, 1) else { continue }
                parts.append(oidName(oidText(type.value)) + "=" + text(value.value))
            }
        }
        return parts.joined(separator: ", ")
    }

    /// UTCTime / GeneralizedTime → YYYY-MM-DD.
    public static func timeText(_ n: Tlv?) -> String {
        guard let n else { return "" }
        let s = text(n.value)
        let c = Array(s)
        if n.tag == 0x17, c.count >= 6, c[0..<6].allSatisfy(\.isASCIIDigit) {
            let yy = Int(String(c[0..<2]))!
            return "\(yy < 50 ? 2000 + yy : 1900 + yy)-\(String(c[2..<4]))-\(String(c[4..<6]))"
        }
        if c.count >= 8, c[0..<8].allSatisfy(\.isASCIIDigit) { return "\(String(c[0..<4]))-\(String(c[4..<6]))-\(String(c[6..<8]))" }
        return s
    }

    /// The interesting parts of an X.509 certificate: serial, issuer, subject, notBefore, notAfter.
    public static func certInfo(_ cert: Tlv?) -> NfcJSONObject {
        var out = NfcJSONObject()
        guard let tbs = at(kids(cert), 0) else { return out }
        var k = kids(tbs)
        if let f = k.first, f.tag == 0xa0 { k.removeFirst() } // [0] version
        let serial = at(k, 0), issuer = at(k, 2), validity = at(k, 3), subject = at(k, 4)
        let v = kids(validity)
        if let serial { out["serial"] = .string(Hex.upper(serial.value)) }
        func putNonEmpty(_ key: String, _ s: String) { if !s.isEmpty { out[key] = .string(s) } }
        putNonEmpty("issuer", nameText(issuer))
        putNonEmpty("subject", nameText(subject))
        putNonEmpty("notBefore", timeText(at(v, 0)))
        putNonEmpty("notAfter", timeText(at(v, 1)))
        return out
    }
}

extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber && ("0"..."9").contains(self) }
}
