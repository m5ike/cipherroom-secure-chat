// 6.2 People: what two people compare to rule out an impostor, computed as the
// web does it (client/src/lib/identity.ts) so a phone and a browser show the same
// digits — the safety number of both keys, a key's fingerprint and its id (port of
// android/…/contacts/Safety.java) — and the QR code of the number the web's user
// info shows and scans (UserInfoModal.tsx: "M5CET-SN:1:" + the 60 digits).

import CryptoKit
import Foundation

enum PeopleSafety {
    /// safetyNumber(): SHA-512 over both public keys (sorted first, so it is the same on both sides),
    /// 1024 more rounds, then twelve groups of five digits. "" when a key is missing or not base64.
    static func number(_ a: String?, _ b: String?) -> String {
        guard let a, let b, !a.isEmpty, !b.isEmpty else { return "" }
        // String.compareTo: UTF-16 code units (keys are base64, ASCII).
        let aFirst = Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16)) || a == b
        let first = aFirst ? a : b, second = aFirst ? b : a
        guard let x = decode(first), let y = decode(second) else { return "" }
        var d = Data(SHA512.hash(data: x + y))
        for _ in 0..<1024 { d = Data(SHA512.hash(data: d)) }
        let bytes = [UInt8](d)
        var groups = [String]()
        for i in 0..<12 {
            let n = UInt64(bytes[i * 5]) << 24 | UInt64(bytes[i * 5 + 1]) << 16 | UInt64(bytes[i * 5 + 2]) << 8 | UInt64(bytes[i * 5 + 3])
            let s = String(n % 100_000)
            groups.append(String(repeating: "0", count: 5 - s.count) + s)
        }
        return groups.joined(separator: " ")
    }

    /// The twelve groups in three lines of four (for reading aloud).
    static func lines(_ number: String?) -> String {
        let g = (number ?? "").split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" }).map(String.init)
        var out = ""
        for (i, x) in g.enumerated() { out += (i == 0 ? "" : i % 4 == 0 ? "\n" : " ") + x }
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
        let s = Data(d).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return String(s.prefix(16))
    }

    private static func sha256(_ publicKey: String?) -> [UInt8]? {
        guard let publicKey, !publicKey.isEmpty, let raw = decode(publicKey) else { return nil }
        return Array(SHA256.hash(data: raw))
    }

    /// Standard base64 (padding optional); base64url as a fallback — java.util.Base64's decoders.
    static func decode(_ s: String) -> Data? {
        let t = s.trimmingCharacters(in: CharacterSet(charactersIn: " \t\n\r\u{0B}\u{0C}\0"))
        func strict(_ v: String, _ alphabet: Set<Character>) -> Data? {
            var body = Substring(v)
            // '=' ends the data (at most two of them, only at the end).
            var pad = 0
            while body.last == "=" && pad < 2 { body.removeLast(); pad += 1 }
            guard !body.isEmpty || v.isEmpty, body.allSatisfy({ alphabet.contains($0) }) else { return nil }
            if body.count % 4 == 1 { return nil }
            if pad > 0 && (body.count + pad) % 4 != 0 { return nil }
            var std = String(body)
            if alphabet == urlAlphabet { std = std.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") }
            while std.count % 4 != 0 { std += "=" }
            return Data(base64Encoded: std)
        }
        return strict(t, stdAlphabet) ?? strict(t, urlAlphabet)
    }

    private static let letters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
    private static let stdAlphabet = letters.union(["+", "/"])
    private static let urlAlphabet = letters.union(["-", "_"])

    // MARK: the QR code (the web's UserInfoModal)

    /// What the QR code of a safety number says: "M5CET-SN:1:" and its 60 digits.
    static let qrPrefix = "M5CET-SN:1:"

    /// The QR payload of a number ("" without one).
    static func qrPayload(_ number: String?) -> String {
        let digits = (number ?? "").filter { $0.isASCII && $0.isNumber }
        return digits.count == 60 ? qrPrefix + digits : ""
    }

    /// The digits a scanned code carries (nil: not a safety number's code).
    static func qrDigits(_ scanned: String) -> String? {
        let t = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix(qrPrefix) else { return nil }
        let digits = String(t.dropFirst(qrPrefix.count))
        return digits.count == 60 && digits.allSatisfy({ $0.isASCII && $0.isNumber }) ? digits : nil
    }

    /// A scanned code against the number shown here — the web compares the whole text.
    static func qrMatches(_ scanned: String, number: String?) -> Bool {
        let mine = qrPayload(number)
        return !mine.isEmpty && scanned.trimmingCharacters(in: .whitespacesAndNewlines) == mine
    }
}
