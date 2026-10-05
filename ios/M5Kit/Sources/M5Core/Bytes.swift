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

public enum Hex {
    private static let digits = Array("0123456789abcdef".utf8)

    /// Lower-case hex.
    public static func encode(_ data: Bytes) -> String {
        var out = [UInt8]()
        out.reserveCapacity(data.count * 2)
        for b in data { out.append(digits[Int(b >> 4)]); out.append(digits[Int(b & 15)]) }
        return String(decoding: out, as: UTF8.self)
    }

    /// Hex (either case) to bytes; nil for an odd length or another character.
    public static func decode(_ s: String) -> Bytes? {
        let c = Array(s.utf8)
        if c.count % 2 != 0 { return nil }
        var out = Bytes()
        out.reserveCapacity(c.count / 2)
        func v(_ x: UInt8) -> UInt8? {
            switch x {
            case 48...57: return x - 48
            case 97...102: return x - 87
            case 65...70: return x - 55
            default: return nil
            }
        }
        var i = 0
        while i < c.count {
            guard let hi = v(c[i]), let lo = v(c[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
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
