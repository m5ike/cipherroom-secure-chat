// Bytes, base64 / base64url, hex and UTF-8 — the encodings every port shares
// (android security/Crypto.java, client/src/lib/p4/primitives.ts).

import Foundation

/// A byte string. M5Kit uses arrays (not `Data`) so indexes always start at 0.
public typealias Bytes = [UInt8]

public enum B64 {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".utf8)
    private static let urlAlphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

    private static func table(_ a: [UInt8]) -> [Int16] {
        var t = [Int16](repeating: -1, count: 256)
        for (i, c) in a.enumerated() { t[Int(c)] = Int16(i) }
        return t
    }
    private static let decodeStd = table(alphabet)
    private static let decodeUrl = table(urlAlphabet)

    private static func encode(_ data: Bytes, _ a: [UInt8], pad: Bool) -> String {
        var out = [UInt8]()
        out.reserveCapacity((data.count + 2) / 3 * 4)
        var i = 0
        while i + 3 <= data.count {
            let n = UInt32(data[i]) << 16 | UInt32(data[i + 1]) << 8 | UInt32(data[i + 2])
            out.append(a[Int(n >> 18 & 63)]); out.append(a[Int(n >> 12 & 63)])
            out.append(a[Int(n >> 6 & 63)]); out.append(a[Int(n & 63)])
            i += 3
        }
        let rest = data.count - i
        if rest == 1 {
            let n = UInt32(data[i]) << 16
            out.append(a[Int(n >> 18 & 63)]); out.append(a[Int(n >> 12 & 63)])
            if pad { out.append(61); out.append(61) }
        } else if rest == 2 {
            let n = UInt32(data[i]) << 16 | UInt32(data[i + 1]) << 8
            out.append(a[Int(n >> 18 & 63)]); out.append(a[Int(n >> 12 & 63)]); out.append(a[Int(n >> 6 & 63)])
            if pad { out.append(61) }
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Standard base64 with padding.
    public static func encode(_ data: Bytes) -> String { encode(data, alphabet, pad: true) }
    /// base64url without padding.
    public static func url(_ data: Bytes) -> String { encode(data, urlAlphabet, pad: false) }

    /// Java's `Base64.getDecoder()` / `getUrlDecoder()`: the alphabet only,
    /// padding optional (but only at the end, never too much), no white space.
    private static func decode(_ s: String, _ t: [Int16]) -> Bytes? {
        var chars = Array(s.utf8)
        var padding = 0
        while let last = chars.last, last == 61 { chars.removeLast(); padding += 1 }
        if padding > 2 { return nil }
        if chars.count % 4 == 1 { return nil }
        if padding > 0 && (chars.count + padding) % 4 != 0 { return nil }
        var out = Bytes()
        out.reserveCapacity(chars.count * 3 / 4)
        var acc: UInt32 = 0
        var bits = 0
        for c in chars {
            let v = t[Int(c)]
            if v < 0 { return nil }
            acc = acc << 6 | UInt32(v)
            bits += 6
            if bits >= 8 {
                bits -= 8
                out.append(UInt8(truncatingIfNeeded: acc >> UInt32(bits)))
            }
        }
        return out
    }

    /// Standard base64 (padding optional, as Java decodes it).
    public static func decode(_ s: String) -> Bytes? { decode(s, decodeStd) }
    /// base64url (padding optional).
    public static func decodeURL(_ s: String) -> Bytes? { decode(s, decodeUrl) }

    /// `Data(base64Encoded:)` with surrounding white space trimmed (as `Sealed.unb64`).
    public static func decodeTrimmed(_ s: String) -> Bytes? { decode(s.trimmingCharacters(in: .whitespacesAndNewlines)) }
}

/// Hex text ↔ bytes. `encode` writes lower case (the protocol's, Crypto.hex); `upper`
/// writes upper case as Android's `Apdu.hex` (APDUs, card dumps — M5NFC).
public enum Hex {
    private static let digits = Array("0123456789abcdef".utf8)
    private static let upperDigits = Array("0123456789ABCDEF".utf8)

    /// Lower-case hex.
    public static func encode(_ data: Bytes) -> String {
        var out = [UInt8]()
        out.reserveCapacity(data.count * 2)
        for b in data { out.append(digits[Int(b >> 4)]); out.append(digits[Int(b & 15)]) }
        return String(decoding: out, as: UTF8.self)
    }

    /// Upper-case hex, two digits per byte ("00A4…") — `Apdu.hex`.
    public static func upper<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        var out = [UInt8]()
        out.reserveCapacity(bytes.underestimatedCount * 2)
        for b in bytes { out.append(upperDigits[Int(b >> 4)]); out.append(upperDigits[Int(b & 15)]) }
        return String(decoding: out, as: UTF8.self)
    }

    /// Hex (either case) to bytes; nil for an odd length or another character.
    public static func decode(_ s: String) -> Bytes? {
        let c = Array(s.utf8)
        if c.count % 2 != 0 { return nil }
        var out = Bytes()
        out.reserveCapacity(c.count / 2)
        var i = 0
        while i < c.count {
            guard let hi = nibble(c[i]), let lo = nibble(c[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    /// Lenient decode (`Apdu.unhex`): "0x" prefixes and anything that is not a hex
    /// digit are dropped, then the digits are read in pairs (an odd last digit is ignored).
    public static func decodeLenient(_ text: String) -> Bytes {
        var nibbles = [UInt8]()
        nibbles.reserveCapacity(text.utf8.count)
        let u = Array(text.utf8)
        var i = 0
        while i < u.count {
            let c = u[i]
            // "0x" / "0X" — dropped wherever it appears, as replaceAll("(?i)0x", "").
            if c == 0x30, i + 1 < u.count, u[i + 1] == 0x78 || u[i + 1] == 0x58 { i += 2; continue }
            if let v = nibble(c) { nibbles.append(v) }
            i += 1
        }
        var out = Bytes()
        out.reserveCapacity(nibbles.count / 2)
        var j = 0
        while j + 1 < nibbles.count { out.append(nibbles[j] << 4 | nibbles[j + 1]); j += 2 }
        return out
    }

    /// Whether `text` is whole bytes of upper-case hex (`([0-9A-F]{2})+`).
    public static func isUpperHexBytes(_ text: String) -> Bool {
        let u = text.utf8
        guard !u.isEmpty, u.count % 2 == 0 else { return false }
        return u.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) }
    }

    /// One hex digit's value (either case); nil for anything else.
    public static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x41...0x46: return c - 0x41 + 10
        case 0x61...0x66: return c - 0x61 + 10
        default: return nil
        }
    }
}

public enum UTF8Text {
    /// The UTF-8 bytes of a string.
    @inlinable public static func bytes(_ s: String) -> Bytes { Array(s.utf8) }

    /// Strict UTF-8 decoding: nil for an invalid sequence (never replaced).
    public static func decode(_ b: Bytes) -> String? { String(validating: b, as: UTF8.self) }

    /// Lenient decoding (U+FFFD for invalid sequences), as `new String(bytes, UTF_8)`.
    public static func lossy(_ b: Bytes) -> String { String(decoding: b, as: UTF8.self) }
}

public enum ByteOps {
    /// a ‖ b ‖ …
    public static func concat(_ parts: Bytes...) -> Bytes { concat(parts) }
    public static func concat(_ parts: [Bytes]) -> Bytes {
        var out = Bytes()
        out.reserveCapacity(parts.reduce(0) { $0 + $1.count })
        for p in parts { out.append(contentsOf: p) }
        return out
    }

    /// Constant-time equality for equal lengths; different lengths are simply unequal.
    public static func ctEqual(_ a: Bytes, _ b: Bytes) -> Bool {
        if a.count != b.count { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    /// Overwrites the bytes with zeros (best effort: Swift arrays are values, copies may exist).
    public static func wipe(_ b: inout Bytes) {
        for i in b.indices { b[i] = 0 }
    }

    /// Big-endian bytes of an unsigned integer.
    public static func be64(_ v: UInt64) -> Bytes { (0..<8).map { UInt8(truncatingIfNeeded: v >> (56 - 8 * UInt64($0))) } }
    public static func be32(_ v: UInt32) -> Bytes { (0..<4).map { UInt8(truncatingIfNeeded: v >> (24 - 8 * UInt32($0))) } }
}

/* ------------------------------------------------------- Bytes.… helpers */

// `Bytes.u8(…)`, `Bytes.slice(…)`, `Bytes.b64(data)` … — the byte helpers M5NFC
// (Android's Apdu.concat / slice / u8, Latin-1 and ASCII text) and M5Net (the
// wire's `Data`: base64 as the server's Buffer reads it, hex, constant-time
// equality) call through the `Bytes` alias. One home for every module, so a
// file that imports several of them sees one meaning. SHA-256 and random
// bytes for `Data` are M5Crypto's (`Bytes.sha256`, `Bytes.random`).
public extension Array where Element == UInt8 {
    /// Bytes from small integers, each masked to 8 bits (`Apdu.u8`).
    static func u8(_ values: Int...) -> Bytes { values.map { UInt8(truncatingIfNeeded: $0) } }

    /// a ‖ b ‖ … (`Apdu.concat`; the same as `ByteOps.concat`).
    static func concat(_ parts: Bytes...) -> Bytes { ByteOps.concat(parts) }
    static func concat(_ parts: [Bytes]) -> Bytes { ByteOps.concat(parts) }

    /// `a[from..<to]`, clamped to the array (never traps), as `Apdu.slice`.
    static func slice(_ a: Bytes, _ from: Int, _ to: Int? = nil) -> Bytes {
        let lo = Swift.max(0, from)
        var hi = Swift.min(a.count, to ?? a.count)
        if hi < lo { hi = lo }
        if lo >= a.count { return [] }
        return Array(a[lo..<hi])
    }

    /// ASCII / Latin-1 bytes of a string (each scalar's low byte, as Java's US_ASCII / ISO_8859_1 for 0–255).
    static func latin1(_ s: String) -> Bytes { s.unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) } }

    /// The bytes as ISO 8859-1 text (every byte one character).
    static func latin1String(_ b: Bytes) -> String {
        var s = String.UnicodeScalarView()
        for x in b { s.append(Unicode.Scalar(x)) }
        return String(s)
    }

    /// ASCII text of the bytes (Java `new String(b, US_ASCII)`: a byte above 0x7F becomes U+FFFD).
    static func asciiString(_ b: Bytes) -> String {
        var s = String.UnicodeScalarView()
        for x in b { s.append(x < 0x80 ? Unicode.Scalar(x) : "\u{FFFD}") }
        return String(s)
    }

    /// The UTF-8 bytes of a string.
    static func utf8(_ s: String) -> Bytes { UTF8Text.bytes(s) }

    /// Constant-time comparison of two byte strings (MessageDigest.isEqual; `ByteOps.ctEqual`).
    static func constantTimeEqual(_ a: Bytes, _ b: Bytes) -> Bool { ByteOps.ctEqual(a, b) }

    /// `n` bytes of `value`.
    static func filled(_ n: Int, _ value: UInt8) -> Bytes { Bytes(repeating: value, count: Swift.max(0, n)) }

    /* ------------------------------------------------- Data (the wire) */

    /// Standard base64 with padding (Buffer.toString("base64")).
    static func b64(_ data: Data) -> String { data.base64EncodedString() }

    /// base64url without padding (Buffer.toString("base64url")).
    static func b64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Standard base64 (padding optional, spaces around it ignored); nil when it is not base64.
    static func unb64(_ s: String) -> Data? {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.range(of: "^[A-Za-z0-9+/]*={0,2}$", options: .regularExpression) != nil else { return nil }
        var padded = t
        while padded.count % 4 != 0 { padded += "=" }
        return Data(base64Encoded: padded)
    }

    /// base64url (padding tolerated); nil when it is not base64url.
    static func unb64url(_ s: String) -> Data? {
        let t = s.replacingOccurrences(of: "=", with: "")
        guard t.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil, t.count % 4 != 1 else { return nil }
        var std = t.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while std.count % 4 != 0 { std += "=" }
        return Data(base64Encoded: std)
    }

    /// Either alphabet (what Buffer.from(x, "base64") accepts in practice).
    static func unb64any(_ s: String) -> Data? { unb64(s) ?? unb64url(s) }

    /// Lower-case hex (`Hex.encode`).
    static func hex(_ data: Data) -> String { Hex.encode(Array(data)) }

    /// Hex (either case) to bytes; nil for an odd length or another character (`Hex.decode`).
    static func unhex(_ s: String) -> Data? { Hex.decode(s).map { Data($0) } }

    /// Constant-time equality (`ByteOps.ctEqual`).
    static func same(_ a: Data, _ b: Data) -> Bool { ByteOps.ctEqual(Array(a), Array(b)) }
    static func same(_ a: String, _ b: String) -> Bool { ByteOps.ctEqual(Array(a.utf8), Array(b.utf8)) }

    /// Big-endian u32 at `at` (nil when out of range).
    static func be32(_ d: Data, _ at: Int) -> UInt32? {
        guard at >= 0, at + 4 <= d.count else { return nil }
        let s = d.startIndex + at
        return UInt32(d[s]) << 24 | UInt32(d[s + 1]) << 16 | UInt32(d[s + 2]) << 8 | UInt32(d[s + 3])
    }
}

public enum Ordinal {
    /// Java `String.compareTo` / JavaScript `<` on strings: UTF-16 code units, lexicographic.
    public static func compare(_ a: String, _ b: String) -> Int {
        var ia = a.utf16.makeIterator(), ib = b.utf16.makeIterator()
        while true {
            let x = ia.next(), y = ib.next()
            switch (x, y) {
            case (nil, nil): return 0
            case (nil, _): return -1
            case (_, nil): return 1
            case let (x?, y?): if x != y { return Int(x) - Int(y) }
            }
        }
    }

    public static func less(_ a: String, _ b: String) -> Bool { compare(a, b) < 0 }
}

public extension String {
    /// Java `String.trim()`: removes every character <= U+0020 at both ends.
    var javaTrimmed: String {
        let scalars = Array(unicodeScalars)
        var start = 0, end = scalars.count
        while start < end && scalars[start].value <= 0x20 { start += 1 }
        while end > start && scalars[end - 1].value <= 0x20 { end -= 1 }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars[start..<end])
        return String(out)
    }
}
