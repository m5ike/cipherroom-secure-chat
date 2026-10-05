// What two people compare to rule out an impostor (6.2) — port of
// android/app/src/main/java/cz/m5cet/app/contacts/Safety.java, computed as the
// web does it (client/src/lib/identity.ts) so a phone and a browser show the
// same digits: the safety number of both device keys, a key's fingerprint and
// its id. M5Crypto's ChatIdentity.safetyNumber / Ec.kid / Ec.fingerprint give
// the same for valid keys; this adds Android's answers for missing or broken
// keys ("" instead of a hash of nothing) and base64url keys. Pure (SafetyTests).
// Candidate for M5Kit (M5Crypto, next to ChatIdentity).

import CryptoKit
import Foundation
import M5Core

enum Safety {
    /// safetyNumber(): SHA-512 over both public keys (sorted first, so it is the same on both sides),
    /// 1024 more rounds, then twelve groups of five digits. "" when a key is missing or not base64.
    static func number(_ a: String?, _ b: String?) -> String {
        guard let a, let b, !a.isEmpty, !b.isEmpty else { return "" }
        let first = Ordinal.compare(a, b) <= 0 ? a : b
        let second = first == a ? b : a
        guard let x = decode(first), let y = decode(second) else { return "" }
        var d = Array(SHA512.hash(data: x + y))
        for _ in 0..<1024 { d = Array(SHA512.hash(data: d)) }
        var groups = [String]()
        for i in 0..<12 {
            let n = UInt64(d[i * 5]) << 24 | UInt64(d[i * 5 + 1]) << 16 | UInt64(d[i * 5 + 2]) << 8 | UInt64(d[i * 5 + 3])
            let s = String(n % 100_000)
            groups.append(String(repeating: "0", count: 5 - s.count) + s)
        }
        return groups.joined(separator: " ")
    }

    /// The twelve groups in three lines of four (for reading aloud).
    static func lines(_ number: String?) -> String {
        let g = (number ?? "").trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" })
        var out = ""
        for (i, group) in g.enumerated() { out += (i == 0 ? "" : i % 4 == 0 ? "\n" : " ") + group }
        return out
    }

    /// keyFingerprint(): the first 16 bytes of SHA-256, hex in groups of four ("8537 3E64 …").
    static func fingerprint(_ publicKey: String?) -> String {
        guard let d = sha256(publicKey) else { return "" }
        var hex = ""
        for i in 0..<16 {
            if i > 0 && i % 2 == 0 { hex += " " }
            hex += String(format: "%02X", d[i])
        }
        return hex
    }

    /// keyId(): base64url of SHA-256, 16 characters (what the pins and the verified list keep).
    static func keyId(_ publicKey: String?) -> String {
        guard let d = sha256(publicKey) else { return "" }
        return String(B64.url(d).prefix(16))
    }

    private static func sha256(_ publicKey: String?) -> Bytes? {
        guard let publicKey, !publicKey.isEmpty, let raw = decode(publicKey) else { return nil }
        return Array(SHA256.hash(data: raw))
    }

    /// Standard base64 (padding optional); base64url as a fallback — Java's decoders (B64).
    static func decode(_ s: String) -> Bytes? {
        let t = s.javaTrimmed
        return B64.decode(t) ?? B64.decodeURL(t)
    }
}
