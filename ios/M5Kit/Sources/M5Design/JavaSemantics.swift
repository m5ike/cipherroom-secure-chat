// The few Java behaviours the design's semantics rest on, reproduced exactly so a
// design means the same on iOS as on Android: String.trim, Double.parseDouble,
// Math.round, Double.compare, (int) casts, Integer.parseInt, Character's classes
// for UTF-16 code units, BigDecimal's plain text of a double. Strings are
// measured and cut in UTF-16 code units, as Java does.

import Foundation

enum JavaSemantics {
    // MARK: UTF-16

    @inline(__always) static func units(_ s: String) -> [UInt16] { Array(s.utf16) }

    @inline(__always) static func string(_ u: ArraySlice<UInt16>) -> String { String(decoding: u, as: UTF16.self) }

    @inline(__always) static func string(_ u: [UInt16]) -> String { String(decoding: u, as: UTF16.self) }

    /// Java's String.length().
    @inline(__always) static func length(_ s: String) -> Int { s.utf16.count }

    /// Java's substring(from, to) on UTF-16 units.
    static func substring(_ s: String, _ from: Int, _ to: Int? = nil) -> String {
        let u = units(s)
        let end = min(to ?? u.count, u.count)
        guard from < end else { return "" }
        return string(u[max(0, from)..<end])
    }

    /// Java's String.trim(): leading and trailing code units up to U+0020.
    static func trim(_ s: String) -> String {
        let u = units(s)
        var a = 0, b = u.count
        while a < b && u[a] <= 0x20 { a += 1 }
        while b > a && u[b - 1] <= 0x20 { b -= 1 }
        if a == 0 && b == u.count { return s }
        return string(u[a..<b])
    }

    static func indexOf(_ u: [UInt16], _ c: UInt16, from: Int = 0) -> Int {
        var i = max(0, from)
        while i < u.count { if u[i] == c { return i }; i += 1 }
        return -1
    }

    private static func scalar(_ u: UInt16) -> Unicode.Scalar? { Unicode.Scalar(UInt32(u)) }

    /// Character.isDigit(char): general category Nd.
    static func isDigit(_ u: UInt16) -> Bool {
        if u >= 0x30 && u <= 0x39 { return true }
        if u < 0x80 { return false }
        guard let s = scalar(u) else { return false }
        return s.properties.generalCategory == .decimalNumber
    }

    /// Character.isLetter(char): general categories Lu, Ll, Lt, Lm, Lo.
    static func isLetter(_ u: UInt16) -> Bool {
        if (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) { return true }
        if u < 0x80 { return false }
        guard let s = scalar(u) else { return false }
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: return true
        default: return false
        }
    }

    static func isLetterOrDigit(_ u: UInt16) -> Bool { isLetter(u) || isDigit(u) }

    /// Character.isWhitespace(char).
    static func isWhitespace(_ u: UInt16) -> Bool {
        switch u {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1C, 0x1D, 0x1E, 0x1F: return true
        case 0x00A0, 0x2007, 0x202F: return false
        default:
            guard u >= 0x20, let s = scalar(u) else { return false }
            switch s.properties.generalCategory {
            case .spaceSeparator, .lineSeparator, .paragraphSeparator: return true
            default: return false
            }
        }
    }

    /// The decimal value of a digit (Character.digit(c, 10)), or nil.
    static func digitValue(_ u: UInt16) -> Int? {
        if u >= 0x30 && u <= 0x39 { return Int(u - 0x30) }
        guard isDigit(u), let s = scalar(u), let v = s.properties.numericValue else { return nil }
        return Int(v)
    }

    // MARK: numbers

    /// Double.parseDouble — nil where Java throws NumberFormatException.
    static func parseDouble(_ raw: String) -> Double? {
        let s = trim(raw)
        var u = units(s)
        if u.isEmpty { return nil }
        var negative = false
        var i = 0
        if u[0] == 0x2B || u[0] == 0x2D { negative = u[0] == 0x2D; i = 1 }
        let rest = string(u[i...])
        if rest == "NaN" { return .nan }
        if rest == "Infinity" { return negative ? -.infinity : .infinity }
        // A type suffix (1.5f, 2d) is allowed at the very end.
        if let last = u.last, last == 0x66 || last == 0x46 || last == 0x64 || last == 0x44, u.count - 1 > i {
            u.removeLast()
        }
        if u.count - i >= 2 && u[i] == 0x30 && (u[i + 1] == 0x78 || u[i + 1] == 0x58) {
            // Hex floating point: Java requires the binary exponent.
            let body = string(u[i...])
            guard body.lowercased().contains("p"), let d = Double(body) else { return nil }
            return negative ? -d : d
        }
        var intDigits: [UInt16] = [], fracDigits: [UInt16] = [], expDigits: [UInt16] = []
        var expNegative = false
        while i < u.count, u[i] >= 0x30 && u[i] <= 0x39 { intDigits.append(u[i]); i += 1 }
        if i < u.count, u[i] == 0x2E {
            i += 1
            while i < u.count, u[i] >= 0x30 && u[i] <= 0x39 { fracDigits.append(u[i]); i += 1 }
        }
        if intDigits.isEmpty && fracDigits.isEmpty { return nil }
        if i < u.count, u[i] == 0x65 || u[i] == 0x45 {
            i += 1
            if i < u.count, u[i] == 0x2B || u[i] == 0x2D { expNegative = u[i] == 0x2D; i += 1 }
            while i < u.count, u[i] >= 0x30 && u[i] <= 0x39 { expDigits.append(u[i]); i += 1 }
            if expDigits.isEmpty { return nil }
        }
        if i != u.count { return nil }
        var text = (negative ? "-" : "") + (intDigits.isEmpty ? "0" : string(intDigits)) + "." + (fracDigits.isEmpty ? "0" : string(fracDigits))
        if !expDigits.isEmpty {
            // Very long exponents saturate (Java gives 0 or Infinity, as strtod does).
            let e = String(string(expDigits).drop(while: { $0 == "0" }).prefix(6))
            text += "e" + (expNegative ? "-" : "") + (e.isEmpty ? "0" : e)
        }
        return Double(text)
    }

    /// Math.round(double): half up, saturating at the long range, NaN → 0.
    static func round(_ d: Double) -> Int64 {
        if d.isNaN { return 0 }
        if d >= 9.223372036854775807e18 { return Int64.max }
        if d <= -9.223372036854775808e18 { return Int64.min }
        let f = d.rounded(.down)
        let r = d - f >= 0.5 ? f + 1 : f
        if r >= 9.223372036854775807e18 { return Int64.max }
        return Int64(r)
    }

    /// Math.round(float) for the few float computations of the Android code.
    static func roundInt(_ d: Double) -> Int {
        let r = round(d)
        return r > Int64(Int32.max) ? Int(Int32.max) : r < Int64(Int32.min) ? Int(Int32.min) : Int(r)
    }

    /// The (int) cast of a double: toward zero, saturating, NaN → 0.
    static func intValue(_ d: Double) -> Int32 {
        if d.isNaN { return 0 }
        if d >= 2147483647 { return Int32.max }
        if d <= -2147483648 { return Int32.min }
        return Int32(d.rounded(.towardZero))
    }

    /// The (long) cast of a double.
    static func longValue(_ d: Double) -> Int64 {
        if d.isNaN { return 0 }
        if d >= 9.223372036854775807e18 { return Int64.max }
        if d <= -9.223372036854775808e18 { return Int64.min }
        return Int64(d.rounded(.towardZero))
    }

    /// Integer.parseInt(s): optional sign, decimal digits (any script), nil on overflow or anything else.
    static func parseInt(_ s: String) -> Int32? {
        let u = units(s)
        if u.isEmpty { return nil }
        var i = 0
        var negative = false
        if u[0] == 0x2B || u[0] == 0x2D { negative = u[0] == 0x2D; i = 1; if u.count == 1 { return nil } }
        var v: Int64 = 0
        while i < u.count {
            guard let d = digitValue(u[i]) else { return nil }
            v = v * 10 + Int64(d)
            if v > Int64(Int32.max) + 1 { return nil }
            i += 1
        }
        if negative { v = -v }
        guard v >= Int64(Int32.min) && v <= Int64(Int32.max) else { return nil }
        return Int32(v)
    }

    /// Double.compare(a, b): -0.0 below 0.0, NaN above everything.
    static func compare(_ a: Double, _ b: Double) -> Int {
        if a < b { return -1 }
        if a > b { return 1 }
        let x = a.isNaN ? Int64(0x7ff8000000000000) : Int64(bitPattern: a.bitPattern)
        let y = b.isNaN ? Int64(0x7ff8000000000000) : Int64(bitPattern: b.bitPattern)
        return x == y ? 0 : (x < y ? -1 : 1)
    }

    /// BigDecimal.valueOf(d).stripTrailingZeros().toPlainString() for a finite double.
    static func plainDecimal(_ d: Double) -> String {
        if d == 0 { return "0" }
        var text = "\(d)"
        var negative = false
        if text.hasPrefix("-") { negative = true; text.removeFirst() }
        var mantissa = text
        var exponent = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(text[..<e])
            exponent = Int(text[text.index(after: e)...].replacingOccurrences(of: "+", with: "")) ?? 0
        }
        var intPart = mantissa
        var fracPart = ""
        if let dot = mantissa.firstIndex(of: ".") {
            intPart = String(mantissa[..<dot])
            fracPart = String(mantissa[mantissa.index(after: dot)...])
        }
        var digits = Array(intPart + fracPart)
        var point = intPart.count + exponent
        while digits.count > 1 && digits.first == "0" && point > 1 { digits.removeFirst(); point -= 1 }
        if point <= 0 {
            digits = Array(repeating: "0", count: -point + 1) + digits
            point = 1
        }
        while digits.count < point { digits.append("0") }
        var whole = String(digits[0..<point])
        var frac = String(digits[point...])
        while frac.hasSuffix("0") { frac.removeLast() }
        while whole.count > 1 && whole.hasPrefix("0") { whole.removeFirst() }
        if whole.isEmpty { whole = "0" }
        let out = frac.isEmpty ? whole : whole + "." + frac
        return negative && out != "0" ? "-" + out : out
    }
}
