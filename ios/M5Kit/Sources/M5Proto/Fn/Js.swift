// The bits of JavaScript the ported web code relies on — a port of android
// fn/Js.java: what \s and trim() take for white space, String(v), Number(v)
// and JSON.stringify (sizes of outputs are measured with it, the Markdown of a
// JSON output is its pretty form). Lengths and offsets are UTF-16 code units,
// as Java's String.length() and JavaScript's .length count them.

import Foundation
import M5Core

/// JavaScript semantics for the Functions ports (android `fn/Js.java`).
public enum Js {
    /// The characters of JavaScript's `\s` (WhiteSpace and LineTerminator), for a regular expression class.
    public static let wsChars = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    /// JavaScript's `\s` as a class.
    public static let s = "[" + wsChars + "]"
    /// JavaScript's `\S` as a class.
    public static let ns = "[^" + wsChars + "]"

    /// One UTF-16 unit of JavaScript's `\s`.
    @inlinable public static func isWs(_ c: UInt16) -> Bool {
        c == 0x20 || (c >= 0x09 && c <= 0x0D) || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A)
            || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF
    }

    /// A scalar of JavaScript's `\s` (all of them are single BMP units).
    @inlinable public static func isWs(_ u: Unicode.Scalar) -> Bool { u.value <= 0xFFFF && isWs(UInt16(u.value)) }

    /// String.prototype.trim().
    public static func trim(_ s: String) -> String {
        let u = Array(s.utf16)
        var a = 0, b = u.count
        while a < b && isWs(u[a]) { a += 1 }
        while b > a && isWs(u[b - 1]) { b -= 1 }
        if a == 0 && b == u.count { return s }
        return string(u[a..<b])
    }

    /// The first code point of a string as a string ("" for an empty one) — `[...s][0]`.
    public static func firstCodePoint(_ s: String) -> String {
        guard let u = s.unicodeScalars.first else { return "" }
        return String(Character(u))
    }

    /// The UTF-16 length (Java's `length()`).
    @inlinable public static func length(_ s: String) -> Int { s.utf16.count }

    /// `s.substring(0, max)` in UTF-16 units (a pair cut in half becomes U+FFFD, the same length).
    public static func cut(_ s: String, _ max: Int) -> String {
        if s.utf16.count <= max { return s }
        return string(Array(s.utf16.prefix(Swift.max(0, max)))[...])
    }

    /// The text of UTF-16 units (a lone surrogate becomes U+FFFD).
    @inlinable static func string(_ u: ArraySlice<UInt16>) -> String { String(decoding: u, as: UTF16.self) }
    @inlinable static func string(_ u: [UInt16]) -> String { String(decoding: u, as: UTF16.self) }

    /// A JSON value from its text (JSON.parse); throws on anything else.
    public static func parse(_ json: String) throws -> JSON { try JSON.parse(json) }

    /// Number.prototype.toString(): "1", "1.5", "1e+21", "1e-7".
    public static func numberToString(_ d: Double) -> String { JSONNumber.jsString(d) }

    /// String(v); nil stands for undefined.
    public static func str(_ v: JSON?) -> String {
        guard let v else { return "undefined" }
        switch v {
        case .null: return "null"
        case .string(let s): return s
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return numberToString(n.double)
        case .array(let a):
            var out = ""
            for (i, x) in a.enumerated() {
                if i > 0 { out += "," }
                if !x.isNull { out += str(x) }
            }
            return out
        case .object: return "[object Object]"
        }
    }

    /// Number(v); nil stands for undefined.
    public static func toNumber(_ v: JSON?) -> Double {
        guard let v else { return .nan }
        let text: String
        switch v {
        case .null: return 0
        case .bool(let b): return b ? 1 : 0
        case .number(let n): return n.double
        case .object: return .nan
        case .string(let s): text = s
        case .array: text = str(v)
        }
        let t = trim(text)
        if t.isEmpty { return 0 }
        if t == "Infinity" || t == "+Infinity" { return .infinity }
        if t == "-Infinity" { return -.infinity }
        let u = Array(t.utf8)
        if u.count > 2 && u[0] == 0x30 {
            let r = u[1] | 0x20
            let bits = r == 0x78 ? 4 : r == 0x6f ? 3 : r == 0x62 ? 1 : 0
            if bits > 0 {
                var digits = [UInt8]()
                for c in u[2...] {
                    guard let d = digitValue(c), d < (1 << bits) else { return .nan }
                    digits.append(d)
                }
                return radixValue(digits, bits: bits)
            }
        }
        return isDecimal(u) ? (Double(t) ?? .nan) : .nan
    }

    private static func digitValue(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x57
        case 0x41...0x46: return c - 0x37
        default: return nil
        }
    }

    /// BigInteger(digits, 2^bits).doubleValue(): correctly rounded, infinity when too large.
    static func radixValue(_ digits: [UInt8], bits: Int) -> Double {
        var i = 0
        while i < digits.count - 1 && digits[i] == 0 { i += 1 }
        var top: UInt64 = 0
        while i < digits.count && top < (UInt64(1) << (64 - bits)) {
            top = top << UInt64(bits) | UInt64(digits[i])
            i += 1
        }
        let restBits = (digits.count - i) * bits
        if restBits == 0 { return Double(top) }
        let sticky = digits[i...].contains { $0 != 0 }
        if sticky { top |= 1 }
        if restBits > 2000 { return .infinity }
        return Double(top) * pow(2.0, Double(restBits))
    }

    /// `[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?` (ASCII digits) over the whole text.
    static func isDecimal(_ u: [UInt8]) -> Bool {
        var i = 0
        let n = u.count
        func digit(_ k: Int) -> Bool { k < n && u[k] >= 0x30 && u[k] <= 0x39 }
        if i < n && (u[i] == 0x2b || u[i] == 0x2d) { i += 1 }
        let intStart = i
        while digit(i) { i += 1 }
        let intDigits = i > intStart
        if i < n && u[i] == 0x2e {
            i += 1
            let fracStart = i
            while digit(i) { i += 1 }
            if !intDigits && i == fracStart { return false }
        } else if !intDigits { return false }
        if i < n && (u[i] == 0x65 || u[i] == 0x45) {
            i += 1
            if i < n && (u[i] == 0x2b || u[i] == 0x2d) { i += 1 }
            let expStart = i
            while digit(i) { i += 1 }
            if i == expStart { return false }
        }
        return i == n
    }

    /// JSON.stringify(v): compact.
    public static func stringify(_ v: JSON?) -> String { stringify(v, indent: 0) }

    /// JSON.stringify(v, null, indent).
    public static func stringify(_ v: JSON?, indent: Int) -> String {
        var out = ""
        write(&out, v, indent, "")
        return out
    }

    private static func write(_ sb: inout String, _ v: JSON?, _ indent: Int, _ pad: String) {
        guard let v else { sb += "null"; return }
        switch v {
        case .null: sb += "null"
        case .string(let s): sb += JSON.quote(s)
        case .bool(let b): sb += b ? "true" : "false"
        case .number(let n): sb += n.double.isFinite ? numberToString(n.double) : "null"
        case .array(let a):
            if a.isEmpty { sb += "[]"; return }
            let inner = pad + String(repeating: " ", count: max(0, indent))
            let sep = indent > 0 ? ",\n" + inner : ","
            sb += "["
            if indent > 0 { sb += "\n" + inner }
            for (i, x) in a.enumerated() {
                if i > 0 { sb += sep }
                write(&sb, x, indent, inner)
            }
            if indent > 0 { sb += "\n" + pad }
            sb += "]"
        case .object(let o):
            if o.isEmpty { sb += "{}"; return }
            let inner = pad + String(repeating: " ", count: max(0, indent))
            let sep = indent > 0 ? ",\n" + inner : ","
            sb += "{"
            if indent > 0 { sb += "\n" + inner }
            var first = true
            for (k, x) in o {
                if !first { sb += sep }
                first = false
                sb += JSON.quote(k)
                sb += indent > 0 ? ": " : ":"
                write(&sb, x, indent, inner)
            }
            if indent > 0 { sb += "\n" + pad }
            sb += "}"
        }
    }

    /// plainJson(): a value that survives JSON, as a fresh copy — or nil
    /// (undefined) when there is none or its JSON is longer than `maxChars`.
    public static func plain(_ v: JSON?, _ maxChars: Int) -> JSON? {
        guard let v else { return nil }
        let s = stringify(v)
        if s.utf16.count > maxChars { return nil }
        return try? JSON.parse(s)
    }

    /* ----------------------------------------------- characters (Java's) */

    /// Java's `String.toLowerCase(Locale.ROOT)` / JavaScript's `toLowerCase()`: the full mapping, with the Greek final sigma.
    public static func lowerRoot(_ s: String) -> String {
        if s.utf8.allSatisfy({ $0 < 0x80 }) { return s.lowercased() }
        let scalars = Array(s.unicodeScalars)
        var out = ""
        for (i, u) in scalars.enumerated() {
            if u.value == 0x03A3 {
                var j = i - 1
                while j >= 0 && scalars[j].properties.isCaseIgnorable { j -= 1 }
                let before = j >= 0 && scalars[j].properties.isCased
                var k = i + 1
                while k < scalars.count && scalars[k].properties.isCaseIgnorable { k += 1 }
                let after = k < scalars.count && scalars[k].properties.isCased
                out += before && !after ? "ς" : "σ"
            } else {
                out += u.properties.lowercaseMapping
            }
        }
        return out
    }

    /// A–Z as a–z only (Java's CASE_INSENSITIVE without UNICODE_CASE, JavaScript's /i without u).
    static func asciiLower(_ s: String) -> String {
        guard s.utf8.contains(where: { $0 >= 0x41 && $0 <= 0x5A }) else { return s }
        var b = Array(s.utf8)
        for i in b.indices where b[i] >= 0x41 && b[i] <= 0x5A { b[i] += 32 }
        return String(decoding: b, as: UTF8.self)
    }

    /// `\p{L}` (Java's Character.isLetter).
    static func isLetter(_ u: Unicode.Scalar) -> Bool {
        switch u.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: return true
        default: return false
        }
    }

    /// `\p{N}`: a decimal digit, a letter number or another number.
    static func isNumber(_ u: Unicode.Scalar) -> Bool {
        switch u.properties.generalCategory {
        case .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    /// Java's Character.isLetterOrDigit (a letter or a decimal digit).
    static func isLetterOrDigit(_ u: Unicode.Scalar) -> Bool { isLetter(u) || u.properties.generalCategory == .decimalNumber }

    /// The same for one UTF-16 unit (a surrogate is neither).
    static func isLetterOrDigit(_ c: UInt16) -> Bool {
        guard let u = Unicode.Scalar(c) else { return false }
        return isLetterOrDigit(u)
    }

    /// Java's Character.isWhitespace.
    static func isJavaWhitespace(_ u: Unicode.Scalar) -> Bool {
        let v = u.value
        if (0x09...0x0D).contains(v) || (0x1C...0x1F).contains(v) { return true }
        if v == 0xA0 || v == 0x2007 || v == 0x202F { return false }
        switch u.properties.generalCategory {
        case .spaceSeparator, .lineSeparator, .paragraphSeparator: return true
        default: return false
        }
    }

    /// Java's Character.isISOControl.
    static func isISOControl(_ u: Unicode.Scalar) -> Bool { u.value <= 0x1F || (0x7F...0x9F).contains(u.value) }

    /// Java's Math.round(double) for what fits an Int: floor(x + 0.5).
    static func round(_ d: Double) -> Int {
        let r = (d + 0.5).rounded(.down)
        if r >= Double(Int.max) { return Int.max }
        if r <= Double(Int.min) { return Int.min }
        return Int(r)
    }

    /// JavaScript's white space removed (`.replace(/\s+/g, "")`).
    static func noSpace(_ s: String) -> String {
        guard s.utf16.contains(where: isWs) else { return s }
        return string(s.utf16.filter { !isWs($0) })
    }
}

/// An ICU regular expression (NSRegularExpression) — what Android's
/// java.util.regex runs on as well. Full matches are anchored `\A(?:…)\z`.
struct FnPattern: Sendable {
    private let find: NSRegularExpression
    private let whole: NSRegularExpression?

    /// A fixed pattern of this port (it compiles).
    init(_ pattern: String) {
        guard let f = try? NSRegularExpression(pattern: pattern), let w = try? NSRegularExpression(pattern: "\\A(?:" + pattern + ")\\z") else {
            preconditionFailure("FnPattern: \(pattern) does not compile")
        }
        find = f
        whole = w
    }

    private init(find: NSRegularExpression) { self.find = find; whole = nil }

    /// Pattern.compile(p) for find(): nil when it does not compile.
    static func compile(_ p: String) -> FnPattern? {
        guard let f = try? NSRegularExpression(pattern: p) else { return nil }
        return FnPattern(find: f)
    }

    /// matcher(s).find(): a match anywhere.
    func found(in s: String) -> Bool {
        find.firstMatch(in: s, options: [], range: NSRange(location: 0, length: s.utf16.count)) != nil
    }

    /// matcher(s).matches(): the whole text (a fixed pattern).
    func matches(_ s: String) -> Bool {
        (whole ?? find).firstMatch(in: s, options: [], range: NSRange(location: 0, length: s.utf16.count)) != nil
    }
}
