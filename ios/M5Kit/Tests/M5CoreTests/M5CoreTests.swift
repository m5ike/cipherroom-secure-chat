import Foundation
import Testing
@testable import M5Core

@Test func moduleExists() { #expect(M5CoreModule.name == "M5Core") }

enum Repo {
    /// The repository root (ios/M5Kit/Tests/M5CoreTests/<file> → four levels up).
    static let root: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func json(_ relative: String) throws -> JSON {
        try JSON.parse(Array(try Data(contentsOf: root.appendingPathComponent(relative))))
    }
}

/// android/app/src/test/resources/cz/m5cet/app/core/locales-vectors.json (written by the TypeScript side).
@Suite struct LocalesTests {
    static let vectors: JSON = try! Repo.json("android/app/src/test/resources/cz/m5cet/app/core/locales-vectors.json")

    @Test func theLanguagesAreTheContractsInItsOrder() {
        let locales = LocalesTests.vectors["locales"]!.arrayValue!
        #expect(locales.count == 9)
        var codes = [String]()
        for v in locales {
            let code = v["code"]!.stringValue!
            codes.append(code)
            #expect(Locales.isLocale(code))
            let info = Locales.info(code)
            #expect(info.nativeName == v["native"]?.stringValue, "\(code) native")
            #expect(info.english == v["english"]?.stringValue, "\(code) english")
            #expect(info.tag == v["tag"]?.stringValue, "\(code) tag")
            #expect(Locales.tag(code) == v["tag"]?.stringValue)
            #expect(info.fallback == v["fallback"]!.arrayValue!.map { $0.stringValue! }, "\(code) fallback")
            #expect(Locales.chain(code) == v["chain"]!.arrayValue!.map { $0.stringValue! }, "\(code) chain")
        }
        #expect(codes == Locales.codes)
    }

    @Test func pickAnswersAsTheContractsPickLocale() {
        let cases = LocalesTests.vectors["pick"]!.arrayValue!
        #expect(cases.count >= 20)
        for c in cases {
            let input = c["in"]!
            let got = input.arrayValue.map { Locales.pick($0.map { $0.stringValue ?? "" }, fallback: "en") } ?? Locales.pick(input.stringValue, fallback: "en")
            #expect(got == c["out"]?.stringValue, "pick \(input.stringify())")
        }
    }

    @Test func slovakIsItsOwnLanguageAndFallsBackToCzechThenEnglish() {
        #expect(Locales.pick(["sk-SK", "cs-CZ"]) == "sk")
        #expect(Locales.chain("sk") == ["sk", "cs", "en"])
        #expect(Locales.info("sk").nativeName == "Slovenčina")
        #expect(Locales.locale("sk").identifier == "sk-SK" || Locales.locale("sk").identifier == "sk_SK")
        #expect(!Locales.isLocale("pl"))
        #expect(!Locales.isLocale(nil))
        #expect(Locales.info("pl").code == "en")
        #expect(Locales.chain("xx") == ["en"])
        #expect(Locales.pick("pl-PL,cs;q=0.5") == "cs")
        #expect(Locales.pick(nil as String?, fallback: "de") == "de")
    }

    @Test func aTextByLanguageFollowsTheChain() {
        let label = JSONObject([("cs", "Les"), ("en", "Forest"), ("es", "")])
        #expect(Locales.text(label, "sk", "?") == "Les")
        #expect(Locales.text(label, "es", "?") == "Forest") // empty counts as missing
        #expect(Locales.text(label, "fi", "?") == "Forest")
        #expect(Locales.text(JSONObject(), "fi", "?") == "?")
        #expect(Locales.text(nil, "cs", "?") == "?")
    }

    @Test func thePluralTableIsIntlsForEveryLanguage() {
        let plurals = LocalesTests.vectors["plurals"]!.objectValue!
        #expect(plurals.count == 9)
        var checked = 0
        for (tag, byCount) in plurals {
            for (n, category) in byCount.objectValue! {
                #expect(Plurals.category(tag, Int64(n)!) == category.stringValue, "\(tag) \(n)")
                checked += 1
            }
        }
        #expect(checked >= 9 * 140)
    }

    @Test func pluralsOfTheSlavicLanguages() {
        #expect(Plurals.category("cs-CZ", 1) == "one")
        #expect(Plurals.category("cs-CZ", 4) == "few")
        #expect(Plurals.category("cs-CZ", 5) == "other")
        #expect(Plurals.category("sk", 2) == "few")
        #expect(Plurals.category("sl-SI", 101) == "one")
        #expect(Plurals.category("sl-SI", 2) == "two")
        #expect(Plurals.category("sl-SI", 204) == "few")
        #expect(Plurals.category("fr-FR", 0) == "one")
        #expect(Plurals.category("es-ES", 1_000_000) == "many")
        #expect(Plurals.category("fi-FI", 0) == "other")
        #expect(Plurals.keys("files", tag: "cs", 3) == ["files#few", "files"])
    }

    @Test func numbersAndDatesAreWrittenAsTheLanguageWritesThem() {
        #expect(Formats.count("cs", 7) == "7")
        #expect(Formats.count("en", 1234) == "1,234")
        #expect(Formats.count("de", 1234) == "1.234")
        for l in ["cs", "sk", "fi", "fr"] {
            let s = Formats.count(l, 1_234_567)
            let digits = s.unicodeScalars.filter { $0 != "\u{a0}" && $0 != "\u{202f}" && $0 != " " }
            #expect(s != "1234567" && String(String.UnicodeScalarView(digits)) == "1234567", "\(l): \(s)")
        }
        #expect(Formats.decimal("cs", 1.5, 1) == "1,5")
        #expect(Formats.decimal("en", 1.5, 1) == "1.5")
        let utc = TimeZone(identifier: "UTC")!
        let at: Int64 = 1_791_217_500_000 // 2026-10-05 16:25 UTC
        #expect(Formats.date("de", at, tz: utc).contains("05.10.2026"))
        #expect(Formats.date("cs", at, tz: utc).replacingOccurrences(of: "\u{a0}", with: " ").replacingOccurrences(of: "\u{202f}", with: " ").contains("5. 10. 2026"))
        #expect(Formats.date("fi", at, tz: utc).contains("5.10.2026"))
        #expect(Formats.date("en", at, tz: utc).contains("Oct 2026"))
        #expect(Formats.date("es", at, tz: utc).lowercased().contains("oct"))
        for l in ["cs", "de", "es", "it", "fr", "sk", "sl", "fi", "en"] {
            let time = Formats.time(l, at, tz: utc)
            #expect(time.replacingOccurrences(of: ".", with: ":").contains("16:25"), "\(l): \(time)")
        }
    }
}

/// android/app/src/test/resources/cz/m5cet/app/names-vectors.json (the web's names.ts answers the same).
@Suite struct NamesTests {
    static let vectors: JSON = try! Repo.json("android/app/src/test/resources/cz/m5cet/app/names-vectors.json")

    @Test func theVectorsNormalizeAndSkeletonAsWritten() {
        let names = NamesTests.vectors["names"]!.arrayValue!
        #expect(names.count >= 30)
        for v in names {
            let input = v["input"]!.stringValue!, note = v["note"]!.stringValue!
            #expect(Array(Names.normalize(input).unicodeScalars) == Array(v["normalized"]!.stringValue!.unicodeScalars), "\(note): normalized")
            #expect(Array(Names.skeleton(input).unicodeScalars) == Array(v["skeleton"]!.stringValue!.unicodeScalars), "\(note): skeleton")
            #expect(Names.mixedScript(input) == v["mixedScript"]!.boolValue!, "\(note): mixed script")
            #expect(Names.normalize(input) == Names.normalize(Names.normalize(input)), "\(note)")
            #expect(Names.skeleton(input) == Names.skeleton(Names.normalize(input)), "\(note)")
        }
    }

    @Test func theVectorsPairsAndFlags() {
        for p in NamesTests.vectors["pairs"]!.arrayValue! {
            let a = p["a"]!.stringValue!, b = p["b"]!.stringValue!, want = p["confusable"]!.boolValue!
            #expect(Names.confusable(a, b) == want, "\(p.stringify())")
            #expect(Names.confusable(b, a) == want, "\(p.stringify())")
        }
        for f in NamesTests.vectors["flags"]!.arrayValue! {
            let people = f["people"]!.arrayValue!.map { Names.Person($0[0]?.stringValue, $0[1]?.stringValue) }
            let want = f["flagged"]!.arrayValue!.map { $0.boolValue! }
            #expect(Names.flags(people) == want, "\(f.stringify())")
        }
    }

    @Test func nothingHiddenSurvives() {
        for c in 0..<0x10000 {
            guard let u = Unicode.Scalar(c) else { continue }
            let cat = u.properties.generalCategory
            if cat != .format && cat != .control { continue }
            let n = Names.normalize("a" + String(Character(u)) + "b")
            #expect(n == "ab" || n == "a b", "\(String(c, radix: 16)) → \(n)")
        }
        #expect(Names.normalize("\u{202E}Alice\u{202C}") == "Alice")
        #expect(Names.normalize(nil) == "")
        #expect(Names.skeleton(nil) == "")
        #expect(!Names.mixedScript(nil))
    }

    @Test func aSenderIsComparedWithTheRoomAndWithMe() {
        let roster = [Names.Member("p-me", "k:me", "Mike"), Names.Member("p-1", "k:alice", "Alice"), Names.Member("p-2", "k:bob", "Bob")]
        #expect(!Names.senderFlag(roster, myName: "Mike", senderId: "p-2", senderName: "Bob"))
        #expect(Names.senderFlag(roster, myName: "Mike", senderId: "p-2", senderName: "Аlice"))
        #expect(Names.senderFlag(roster, myName: "Mike", senderId: "p-2", senderName: "alice"))
        #expect(Names.senderFlag(roster, myName: "Mike", senderId: "p-gone", senderName: "Mıke"))
        #expect(Names.senderFlag(roster, myName: "Mike", senderId: "p-gone", senderName: "mike"))
        #expect(!Names.senderFlag(roster, myName: "Mike", senderId: "p-old", senderName: "Alice"))
        #expect(!Names.senderFlag([], myName: "", senderId: "p-x", senderName: "Carol"))
        #expect(!Names.senderFlag(roster, myName: "Mike", senderId: "p-x", senderName: ""))
    }

    @Test func flaggedNamesAndTheOperator() {
        #expect(Names.shown("Al\u{200B}ice", flagged: true) == "⚠ Alice")
        #expect(Names.shown("Al\u{200B}ice", flagged: false) == "Alice")
        #expect(Names.operator("📣 Alice", "Operator") == "📣 Operator")
        #expect(Names.operator("✉ Bob", "Operator") == "✉ Operator")
        #expect(Names.operator("📌 ", "Operator") == "📌 Operator")
        #expect(Names.operator("Mallory", "Operator") == "📣 Operator")
        #expect(Names.operator(nil, "Operator") == "📣 Operator")
        #expect("notice-x".hasPrefix(Names.noticeId))
    }
}

@Suite struct JSONTests {
    @Test func parseAndStringifyAsJavaScript() throws {
        let text = #"{"b":1,"a":[true,false,null,1.5,-0,1e21,1e-7,123456789012],"s":"a/b \"q\" \n\t\u0001 ž 😀 😀","o":{}}"#
        let v = try JSON.parse(text)
        #expect(v.objectValue?.keys == ["b", "a", "s", "o"])
        #expect(v.stringify() == #"{"b":1,"a":[true,false,null,1.5,0,1e+21,1e-7,123456789012],"s":"a/b \"q\" \n\t\u0001 ž 😀 😀","o":{}}"#)
        #expect(v.canonical().hasPrefix(#"{"a":"#))
        // Duplicate keys: the last value at the first place (JSON.parse).
        #expect(try JSON.parse(#"{"a":1,"b":2,"a":3}"#).stringify() == #"{"a":3,"b":2}"#)
        // Numbers as Number.prototype.toString.
        for (d, s) in [(0.1, "0.1"), (100.0, "100"), (1e20, "100000000000000000000"), (123.456, "123.456"), (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (0.000001, "0.000001"), (-2.5e-7, "-2.5e-7")] {
            #expect(JSONNumber.jsString(d) == s)
        }
        // Strict: what JSON.parse refuses.
        for bad in ["{a:1}", "[1,]", "01", "'x'", "{\"a\":1}x", "\"\u{1}\"", "[1 2]", "nul", "-", "1.", ".5", "{\"a\" 1}"] {
            #expect(throws: JSONParseError.self, "\(bad)") { try JSON.parse(bad) }
        }
        // Order-insensitive equality, numbers by value.
        #expect(try JSON.parse(#"{"x":1,"y":[2.0]}"#) == JSON.parse(#"{"y":[2],"x":1.0}"#))
        #expect(JSONNumber(Int64.max).description == "9223372036854775807")
    }

    @Test func base64HexAndOrdinals() {
        #expect(B64.encode(Array("hello".utf8)) == "aGVsbG8=")
        #expect(B64.decode("aGVsbG8=") == Array("hello".utf8))
        #expect(B64.decode("aGVsbG8") == Array("hello".utf8)) // Java's decoder: padding optional
        #expect(B64.decode("aGVsbG8==") == nil)
        #expect(B64.decode("aGV sbG8=") == nil)
        #expect(B64.url([0xfb, 0xff]) == "-_8")
        #expect(B64.decodeURL("-_8") == [0xfb, 0xff])
        #expect(Hex.encode([0, 15, 255]) == "000fff")
        #expect(Hex.decode("000FFF") == [0, 15, 255])
        #expect(Hex.decode("0") == nil)
        #expect(Ordinal.less("B", "a"))
        // UTF-16 code units, as Java and JavaScript compare: the surrogate 0xD83D sorts before U+FF5E.
        #expect(Ordinal.less("😀", "\u{FF5E}"))
        #expect(" \t x \n".javaTrimmed == "x")
        #expect(ByteOps.ctEqual([1, 2], [1, 2]) && !ByteOps.ctEqual([1], [1, 2]))
    }

    @Test func clocksAndTheLog() {
        let c = ManualClock(5)
        c.advance(10)
        #expect(c.now() == 15)
        #expect(SystemClock().now() > 1_700_000_000_000)
        let log = M5Log(capacity: 3, clock: c)
        log.info("room", "passphrase=hunter2 joined r3.Vm9jdG9yUm9vbUlkRm9yUDQ with key aGVsbG8gd29ybGQgdGhpcyBpcyBsb25n")
        log.debug("x", "not kept at info")
        log.error("mail", "to alice@example.org: 00112233445566778899aabbccddeeff00112233")
        let e = log.entries()
        #expect(e.count == 2)
        #expect(!e[0].message.contains("hunter2"))
        #expect(!e[0].message.contains("aGVsbG8gd29ybGQgdGhpcyBpcyBsb25n"))
        #expect(!e[1].message.contains("alice@example.org"))
        #expect(!e[1].message.contains("00112233445566778899aabbccddeeff"))
        #expect(Texts.t("missing.key", "English") == "English")
        #expect(Texts.f("k", "{0} of {1}", 3, "x") == "3 of x")
        #expect(Texts.n("k", 4, "{n} files") == "4 files")
    }
}
