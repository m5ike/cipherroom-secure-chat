// Java's String.format("%.Nf", v) (Locale.ROOT) — the digits Android writes into
// links, texts and labels (GeoLinks.deg, Where.mapUrl, Presence.bytes). Java
// rounds the shortest decimal form of the double half-up (0.15 → "0.2", where C's
// printf gives "0.1"), and keeps the sign of a negative number that rounds to
// zero ("-0.0"). Used by Location, Contacts and Voice; belongs in M5Core.

import Foundation

enum JavaFormat {
    private static let posix = Locale(identifier: "en_US_POSIX")

    /// `%.{digits}f` as Java writes it.
    static func fixed(_ v: Double, _ digits: Int) -> String {
        if v.isNaN { return "NaN" }
        if v.isInfinite { return v < 0 ? "-Infinity" : "Infinity" }
        var exact = Decimal(string: "\(v)", locale: posix) ?? Decimal(v)
        var rounded = Decimal()
        NSDecimalRound(&rounded, &exact, max(0, digits), .plain)
        var s = NSDecimalNumber(decimal: rounded).description(withLocale: posix)
        if v.sign == .minus && !s.hasPrefix("-") { s = "-" + s }
        guard digits > 0 else { return s }
        if let dot = s.firstIndex(of: ".") {
            let have = s.distance(from: s.index(after: dot), to: s.endIndex)
            if have < digits { s += String(repeating: "0", count: digits - have) }
        } else {
            s += "." + String(repeating: "0", count: digits)
        }
        return s
    }

    /// Java's Math.round(double): ⌊x + 0.5⌋ as a long.
    static func round(_ v: Double) -> Int64 {
        guard v.isFinite else { return v.isNaN ? 0 : (v > 0 ? Int64.max : Int64.min) }
        let r = (v + 0.5).rounded(.down)
        if r >= 9.223372036854775807e18 { return Int64.max }
        if r <= -9.223372036854775808e18 { return Int64.min }
        return Int64(r)
    }

    /// Java's Math.round(float): ⌊x + 0.5⌋ as an int.
    static func round(_ v: Float) -> Int32 {
        guard v.isFinite else { return v.isNaN ? 0 : (v > 0 ? Int32.max : Int32.min) }
        let r = (v + 0.5).rounded(.down)
        if r >= 2.147483647e9 { return Int32.max }
        if r <= -2.147483648e9 { return Int32.min }
        return Int32(r)
    }
}
