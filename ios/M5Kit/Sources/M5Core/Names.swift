// Display names as the app shows them, and names made to look like another
// (6.12, security analysis F-22) — a port of android core/Names.java, checked
// against android/app/src/test/resources/cz/m5cet/app/names-vectors.json.
//
//   normalize(name)   strip every control and format character (Cc, Cf; line
//                     breaks and tabs become spaces first), NFKC, strip them
//                     again, every run of white space → one space, trimmed, at
//                     most 48 code points, trimmed again
//   skeleton(name)    normalize, NFD, drop the non-spacing marks, map the
//                     Cyrillic / Greek look-alikes (and 0 → o, 1 → l, ı → i),
//                     lower case (locale-independent), map again
//   mixedScript(name) a word with letters of two or three of Latin, Cyrillic, Greek
//   flags(people)     a mixed-script name, or another identity with the same skeleton

import Foundation

public enum Names {
    /// The longest name shown, in code points (the web's nameChars).
    public static let max = 48
    /// Before a flagged name.
    public static let flag = "⚠ "
    /// An operator notice's message id starts so.
    public static let noticeId = "notice-"

    private static let lookalikes: [UInt32: UInt32] = {
        var m = [UInt32: UInt32]()
        func map(_ from: String, _ to: String) {
            for (f, t) in zip(from.unicodeScalars, to.unicodeScalars) { m[f.value] = t.value }
        }
        // Cyrillic capitals: А В Е К М Н О Р С Т Х У Ѕ І Ј Ԛ Ԝ Ү
        map("АВЕКМНОРСТХУЅІЈԚԜҮ", "ABEKMHOPCTXYSIJQWY")
        // Cyrillic small: а е о р с у х ѕ і ј ԛ ԝ һ ү ӏ к
        map("аеорсухѕіјԛԝһүӏк", "aeopcyxsijqwhylk")
        // Greek capitals: Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ
        map("ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ", "ABEZHIKMNOPTYX")
        // Greek small: ο ν α ι κ ρ υ χ γ
        map("οναικρυχγ", "ovaikpuxy")
        // Latin look-alikes within Latin: dotless ı, and two digits
        map("ı01", "iol")
        return m
    }()

    private static func hidden(_ u: Unicode.Scalar) -> Bool {
        let c = u.properties.generalCategory
        return c == .control || c == .format
    }

    private static func strip(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            if u == "\n" || u == "\r" || u == "\t" { out.append(" ") }
            else if !hidden(u) { out.append(u) }
        }
        return String(out)
    }

    /// Java's Character.isWhitespace || isSpaceChar.
    private static func isSpace(_ u: Unicode.Scalar) -> Bool {
        switch u.properties.generalCategory {
        case .spaceSeparator, .lineSeparator, .paragraphSeparator: return true
        default: return (0x09...0x0d).contains(u.value) || (0x1c...0x1f).contains(u.value)
        }
    }

    /// The name as shown: no control or format character, NFKC, one space between words, at most `max` code points.
    public static func normalize(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        let s = strip(strip(raw).precomposedStringWithCompatibilityMapping)
        var out = String.UnicodeScalarView()
        var space = false
        for u in s.unicodeScalars {
            if isSpace(u) { space = !out.isEmpty; continue }
            if space { out.append(" "); space = false }
            out.append(u)
        }
        if out.count > max {
            var cut = String.UnicodeScalarView()
            cut.append(contentsOf: out.prefix(max))
            return String(cut).javaTrimmed
        }
        return String(out)
    }

    private static func lookalike(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for u in s.unicodeScalars { out.append(lookalikes[u.value].flatMap(Unicode.Scalar.init) ?? u) }
        return String(out)
    }

    /// Java's String.toLowerCase(Locale.ROOT): the default case mapping, with Greek final sigma.
    static func lowerRoot(_ s: String) -> String {
        let scalars = Array(s.unicodeScalars)
        var out = ""
        for (i, u) in scalars.enumerated() {
            if u.value == 0x03a3 {
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

    /// What two names that look alike share.
    public static func skeleton(_ name: String?) -> String {
        let s = normalize(name).decomposedStringWithCanonicalMapping
        var out = String.UnicodeScalarView()
        for u in s.unicodeScalars where u.properties.generalCategory != .nonspacingMark { out.append(u) }
        return lookalike(lowerRoot(lookalike(String(out))))
    }

    private static func isLetter(_ u: Unicode.Scalar) -> Bool {
        switch u.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: return true
        default: return false
        }
    }

    private static let latin: [ClosedRange<UInt32>] = [
        0x41...0x5a, 0x61...0x7a, 0xaa...0xaa, 0xba...0xba, 0xc0...0xd6, 0xd8...0xf6, 0xf8...0x2b8, 0x2e0...0x2e4,
        0x1d00...0x1d25, 0x1d2c...0x1d5c, 0x1d62...0x1d65, 0x1d6b...0x1d77, 0x1d79...0x1dbe, 0x1e00...0x1eff,
        0x2071...0x2071, 0x207f...0x207f, 0x2090...0x209c, 0x212a...0x212b, 0x2132...0x2132, 0x214e...0x214e,
        0x2160...0x2188, 0x2c60...0x2c7f, 0xa722...0xa787, 0xa78b...0xa7ff, 0xab30...0xab5a, 0xab5c...0xab64,
        0xab66...0xab69, 0xfb00...0xfb06, 0xff21...0xff3a, 0xff41...0xff5a, 0x10780...0x107ba, 0x1df00...0x1df2a,
    ]
    private static let cyrillic: [ClosedRange<UInt32>] = [
        0x400...0x484, 0x487...0x52f, 0x1c80...0x1c8a, 0x1d2b...0x1d2b, 0x1d78...0x1d78, 0x2de0...0x2dff,
        0xa640...0xa69f, 0xfe2e...0xfe2f, 0x1e030...0x1e08f,
    ]
    private static let greek: [ClosedRange<UInt32>] = [
        0x370...0x373, 0x375...0x377, 0x37a...0x37d, 0x37f...0x37f, 0x384...0x384, 0x386...0x386, 0x388...0x38a,
        0x38c...0x38c, 0x38e...0x3a1, 0x3a3...0x3e1, 0x3f0...0x3ff, 0x1d26...0x1d2a, 0x1d5d...0x1d61, 0x1d66...0x1d6a,
        0x1dbf...0x1dbf, 0x1f00...0x1ffe, 0x2126...0x2126, 0xab65...0xab65, 0x10140...0x1018e, 0x101a0...0x101a0,
        0x1d200...0x1d245,
    ]

    private static func script(_ u: Unicode.Scalar) -> Int {
        guard isLetter(u) else { return 0 }
        let v = u.value
        if latin.contains(where: { $0.contains(v) }) { return 1 }
        if cyrillic.contains(where: { $0.contains(v) }) { return 2 }
        if greek.contains(where: { $0.contains(v) }) { return 4 }
        return 0
    }

    /// A word with letters of two (or three) of Latin, Cyrillic and Greek.
    public static func mixedScript(_ name: String?) -> Bool {
        var word = 0
        for u in normalize(name).unicodeScalars {
            if u == " " { word = 0; continue }
            word |= script(u)
            if word.nonzeroBitCount > 1 { return true }
        }
        return false
    }

    /// One person shown: what tells two people apart (a device key, an account, a connection id) and the name.
    public struct Person: Sendable {
        public let identity: String?
        public let name: String?
        public init(_ identity: String?, _ name: String?) { self.identity = identity; self.name = name }
    }

    /// Who is flagged among people shown together: a mixed-script name, or a skeleton another identity has too.
    public static func flags(_ people: [Person]) -> [Bool] {
        var bySkeleton = [String: Set<String>]()
        let skel = people.map { skeleton($0.name) }
        for (i, p) in people.enumerated() where !skel[i].isEmpty {
            bySkeleton[skel[i], default: []].insert(p.identity ?? "")
        }
        return people.enumerated().map { i, p in
            let ids = skel[i].isEmpty ? nil : bySkeleton[skel[i]]
            return mixedScript(p.name) || (ids.map { $0.count > 1 } ?? false)
        }
    }

    /// A roster entry: connection id, identity, name.
    public struct Member: Sendable {
        public let connectionId: String?
        public let identity: String?
        public let name: String?
        public init(_ connectionId: String?, _ identity: String?, _ name: String?) { self.connectionId = connectionId; self.identity = identity; self.name = name }
    }

    /// A message's sender (not mine): mixed scripts, my name's look-alike, or — when in the room now — another member's.
    public static func senderFlag(_ roster: [Member], myName: String?, senderId: String?, senderName: String?) -> Bool {
        if mixedScript(senderName) { return true }
        let sk = skeleton(senderName)
        if sk.isEmpty { return false }
        var at = -1
        for (i, m) in roster.enumerated() where m.connectionId != nil && m.connectionId == senderId { at = i }
        if at < 0 { return myName != nil && sk == skeleton(myName) }
        let people = roster.enumerated().map { i, m in Person(m.identity, i == at ? senderName : m.name) }
        return flags(people)[at]
    }

    /// An operator notice's sender: its kind's sign and always the operator's label.
    public static func `operator`(_ storedSender: String?, _ operatorLabel: String) -> String {
        var sign = "📣"
        if let s = storedSender { for x in ["✉", "📌", "📣"] where s.hasPrefix(x) { sign = x } }
        return sign + " " + operatorLabel
    }

    /// The name with the flag before it when flagged.
    public static func shown(_ name: String?, flagged: Bool) -> String {
        let n = normalize(name)
        return flagged ? flag + n : n
    }

    /// Whether two names look alike (the same skeleton) while not being the same name.
    public static func confusable(_ a: String?, _ b: String?) -> Bool {
        let na = normalize(a), nb = normalize(b)
        return !na.isEmpty && na != nb && skeleton(na) == skeleton(nb)
    }
}
