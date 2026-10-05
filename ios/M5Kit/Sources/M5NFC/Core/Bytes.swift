// Byte helpers shared by every M5NFC part — the Swift side of Apdu.java's
// hex / unhex / concat / slice / u8 (A/nfc/Apdu.java) and apdu.ts. Pure.

import Foundation

/// Hex text ↔ bytes, as Android's `Apdu.hex` / `Apdu.unhex` write and read it.
public enum Hex {
    private static let digits: [UInt8] = Array("0123456789ABCDEF".utf8)

    /// Upper-case hex, two digits per byte ("00A4…").
    public static func encode<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        var out = [UInt8]()
        out.reserveCapacity(bytes.underestimatedCount * 2)
        for b in bytes {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Lenient decode (Apdu.unhex): "0x" prefixes and anything that is not a hex
    /// digit are dropped, then the digits are read in pairs (an odd last digit is ignored).
    public static func decode(_ text: String) -> [UInt8] {
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
        var out = [UInt8]()
        out.reserveCapacity(nibbles.count / 2)
        var j = 0
        while j + 1 < nibbles.count { out.append(nibbles[j] << 4 | nibbles[j + 1]); j += 2 }
        return out
    }

    /// Strict decode: only hex digits (either case), an even number of them; nil otherwise.
    public static func decodeStrict(_ text: String) -> [UInt8]? {
        let u = Array(text.utf8)
        guard u.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(u.count / 2)
        var i = 0
        while i < u.count {
            guard let hi = nibble(u[i]), let lo = nibble(u[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    /// Whether `text` is whole bytes of upper-case hex (`([0-9A-F]{2})+`).
    public static func isUpperHexBytes(_ text: String) -> Bool {
        let u = text.utf8
        guard !u.isEmpty, u.count % 2 == 0 else { return false }
        return u.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) }
    }

    static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x41...0x46: return c - 0x41 + 10
        case 0x61...0x66: return c - 0x61 + 10
        default: return nil
        }
    }
}

/// Byte-array helpers (the Java `Apdu.concat / slice / u8`).
public enum Bytes {
    /// Bytes from small integers, each masked to 8 bits (`Apdu.u8`).
    public static func u8(_ values: Int...) -> [UInt8] { values.map { UInt8(truncatingIfNeeded: $0) } }

    public static func concat(_ parts: [UInt8]...) -> [UInt8] { concat(parts) }

    public static func concat(_ parts: [[UInt8]]) -> [UInt8] {
        var out = [UInt8]()
        out.reserveCapacity(parts.reduce(0) { $0 + $1.count })
        for p in parts { out.append(contentsOf: p) }
        return out
    }

    /// `a[from..<to]`, clamped to the array (never traps), as `Apdu.slice`.
    public static func slice(_ a: [UInt8], _ from: Int, _ to: Int? = nil) -> [UInt8] {
        let lo = max(0, from)
        var hi = min(a.count, to ?? a.count)
        if hi < lo { hi = lo }
        if lo >= a.count { return [] }
        return Array(a[lo..<hi])
    }

    /// ASCII / Latin-1 bytes of a string (each scalar's low byte, as Java's US_ASCII / ISO_8859_1 for 0–255).
    public static func latin1(_ s: String) -> [UInt8] { s.unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) } }

    /// The bytes as ISO 8859-1 text (every byte one character).
    public static func latin1String(_ b: [UInt8]) -> String {
        var s = String.UnicodeScalarView()
        for x in b { s.append(Unicode.Scalar(x)) }
        return String(s)
    }

    /// ASCII text of the bytes (Java `new String(b, US_ASCII)`: a byte above 0x7F becomes U+FFFD).
    public static func asciiString(_ b: [UInt8]) -> String {
        var s = String.UnicodeScalarView()
        for x in b { s.append(x < 0x80 ? Unicode.Scalar(x) : "\u{FFFD}") }
        return String(s)
    }

    public static func utf8(_ s: String) -> [UInt8] { Array(s.utf8) }

    /// Constant-time comparison of two byte strings (MessageDigest.isEqual).
    public static func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    /// `n` bytes of `value`.
    public static func filled(_ n: Int, _ value: UInt8) -> [UInt8] { [UInt8](repeating: value, count: max(0, n)) }
}

/// JavaScript string-length helpers: Java and the web count UTF-16 units, so the
/// text views align columns by that count to read the same on every platform.
enum JSText {
    static func length(_ s: String) -> Int { s.utf16.count }

    /// The longest prefix of `s` that is at most `n` UTF-16 units (never splitting a character).
    static func prefix(_ s: String, _ n: Int) -> String {
        if s.utf16.count <= n { return s }
        var out = ""
        var used = 0
        for ch in s {
            let w = String(ch).utf16.count
            if used + w > n { break }
            out.append(ch)
            used += w
        }
        return out
    }

    /// `s` padded with spaces to `width` UTF-16 units (String.padEnd).
    static func padEnd(_ s: String, _ width: Int) -> String {
        let l = length(s)
        return l >= width ? s : s + String(repeating: " ", count: width - l)
    }

    /// `s` padded on the left (String.padStart).
    static func padStart(_ s: String, _ width: Int, _ pad: Character = " ") -> String {
        let l = length(s)
        return l >= width ? s : String(repeating: pad, count: width - l) + s
    }

    static func trimEnd(_ s: String) -> String {
        var t = Substring(s)
        while t.last == " " { t.removeLast() }
        return String(t)
    }

    /// Java `String.trim()`: drops leading and trailing characters ≤ U+0020.
    static func trim(_ s: String) -> String {
        let scalars = Array(s.unicodeScalars)
        var lo = 0, hi = scalars.count
        while lo < hi, scalars[lo].value <= 0x20 { lo += 1 }
        while hi > lo, scalars[hi - 1].value <= 0x20 { hi -= 1 }
        var v = String.UnicodeScalarView()
        v.append(contentsOf: scalars[lo..<hi])
        return String(v)
    }

    /// Java `String.toUpperCase(Locale.ROOT)` for the ASCII range (card data, hex, MRZ).
    static func upperASCII(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.map { ($0.value >= 0x61 && $0.value <= 0x7a) ? Unicode.Scalar($0.value - 32)! : $0 }))
    }
}

extension String {
    /// Whether the whole string matches the regular expression (Java `String.matches`).
    func fullMatch(_ pattern: String) -> Bool {
        guard let re = try? NSRegularExpression(pattern: "^(?:" + pattern + ")$", options: [.dotMatchesLineSeparators]) else { return false }
        return re.firstMatch(in: self, range: NSRange(startIndex..., in: self)) != nil
    }

    /// Every match of `pattern` replaced (Java `replaceAll`; `$1` in the template is a group).
    func replacingRegex(_ pattern: String, with template: String, caseInsensitive: Bool = false) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : []) else { return self }
        return re.stringByReplacingMatches(in: self, range: NSRange(startIndex..., in: self), withTemplate: template)
    }

    /// The first match's groups (index 0 = the whole match), or nil.
    func firstMatch(_ pattern: String) -> [String?]? {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: self, range: NSRange(startIndex..., in: self)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            guard r.location != NSNotFound, let rr = Range(r, in: self) else { return nil }
            return String(self[rr])
        }
    }
}
