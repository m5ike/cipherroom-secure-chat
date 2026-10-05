// Text helpers shared by every M5NFC part: JavaScript / Java string lengths and
// trimming, Java's `String.matches` / `replaceAll`. Pure. The byte and hex
// helpers (Apdu.java's hex / unhex / concat / slice / u8) are M5Core's:
// `Hex.upper`, `Hex.decodeLenient`, `Hex.decode`, `Bytes.u8`, `Bytes.slice`, …

import Foundation

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
