// 6.11: the suggester's matching — a port of android fn/Fuzzy.java: what
// typed letters find in a keyword, a name or a summary, and where (the parts
// to highlight). Case and diacritics do not count ("pocasi" finds "Počasí").
// Best first: the whole text, its start, the start of a word in it, anywhere
// in it, and — for keywords — the letters in order from a word's start ("pl"
// finds "phone-lookup": p…l; closer together is better). Offsets are UTF-16
// units of the text (NSRange-compatible).

import Foundation

/// Loose matching for the suggester (android `fn/Fuzzy.java`).
public enum Fuzzy {
    public static let exact = 1100, prefix = 1000, word = 800, inside = 600, spread = 300

    /// A match: how good (higher is better) and the parts of the text it found, as [start, end) UTF-16 ranges.
    public struct Match: Sendable, Equatable {
        public let score: Int
        public let hits: [Range<Int>]
    }

    private static let all = Match(score: 0, hits: [])

    /// One UTF-16 unit as it is compared: lower case, without its diacritic (Java's char-level fold).
    static func fold(_ c: UInt16) -> UInt16 {
        guard let u = Unicode.Scalar(c) else { return c } // a surrogate stays as it is
        var lower = c
        if let l = u.properties.lowercaseMapping.unicodeScalars.first, l.value <= 0xFFFF { lower = UInt16(l.value) }
        if lower < 0x80 { return lower }
        guard let lu = Unicode.Scalar(lower) else { return lower }
        return String(Character(lu)).decomposedStringWithCanonicalMapping.utf16.first ?? lower
    }

    /// A text folded unit by unit (the indexes stay those of the text).
    static func fold(_ s: String) -> [UInt16] { s.utf16.map(fold) }

    private static func wordStart(_ s: [UInt16], _ i: Int) -> Bool { i == 0 || !Js.isLetterOrDigit(s[i - 1]) }

    private static func startsWith(_ t: [UInt16], _ q: [UInt16], at i: Int) -> Bool {
        i >= 0 && i + q.count <= t.count && t[i..<(i + q.count)].elementsEqual(q)
    }

    /// Where query is in text; nil when it is not. An empty query matches
    /// everything (score 0, nothing to highlight). spread: the letters may
    /// also lie apart, in order, starting at a word (keywords).
    public static func match(_ query: String?, _ text: String?, _ spread: Bool) -> Match? {
        guard let query, !query.isEmpty else { return all }
        guard let text, !text.isEmpty else { return nil }
        let q = fold(Js.lowerRoot(query)), t = fold(text)
        let n = q.count
        if t == q { return Match(score: exact, hits: [0..<n]) }
        if startsWith(t, q, at: 0) { return Match(score: prefix, hits: [0..<n]) }
        var i = 1
        while i + n <= t.count {
            if wordStart(t, i) && startsWith(t, q, at: i) { return Match(score: word - Swift.min(i, 100), hits: [i..<(i + n)]) }
            i += 1
        }
        let at = Js.index(of: q, in: t, from: 0)
        if at >= 0 { return Match(score: inside - Swift.min(at, 100), hits: [at..<(at + n)]) }
        if !spread || n < 2 { return nil }
        // The letters in order, the first at a word's start; closer together is better.
        for s in 0..<t.count {
            if t[s] != q[0] || !wordStart(t, s) { continue }
            var hits = [Range<Int>]()
            var j = 0, last = -2
            var k = s
            while k < t.count && j < n {
                if t[k] == q[j] {
                    if k == last + 1, let h = hits.last { hits[hits.count - 1] = h.lowerBound..<(k + 1) } else { hits.append(k..<(k + 1)) }
                    last = k
                    j += 1
                }
                k += 1
            }
            if j == n { return Match(score: Swift.max(1, Self.spread - (last + 1 - s - n) * 10 - Swift.min(s, 50)), hits: hits) }
        }
        return nil
    }
}
