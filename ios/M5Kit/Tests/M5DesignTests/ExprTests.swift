import Foundation
import Testing
@testable import M5Design

/// The screens' language: the shared vectors (test/fixtures/android-expr.json — ExprTest.java,
/// server/android/expr.ts), the 6.2 trees' expressions (LockTreeExprTest.java) and the semantics
/// Expr.java has beyond them.
@Suite struct ExprVectorTests {
    static let vectors = try! Fixtures.json("test/fixtures/android-expr.json")
    static let scope = Scope(vectors["scope"].objectValue!)
    static let strings = vectors["strings"].objectValue!
    static let tr = Translator { strings[$0]?.stringValue ?? $0 }

    static func same(_ src: String, _ expected: DesignValue, _ actual: DesignValue) {
        if case .number(let e) = expected, case .number(let a) = actual {
            #expect(abs(e - a) < 1e-9, "\(src)")
        } else {
            #expect(expected == actual, "\(src)")
        }
    }

    @Test func expressions() throws {
        let list = Self.vectors["expressions"].arrayValue!
        #expect(list.count >= 30)
        for c in list {
            let src = c["src"].stringValue!
            Self.same(src, c["value"], try Expr.eval(src, Self.scope, Self.tr))
        }
    }

    @Test func templates() throws {
        let list = Self.vectors["templates"].arrayValue!
        #expect(list.count >= 15)
        for c in list {
            let src = c["src"].stringValue!
            #expect(try Expr.render(src, Self.scope, Self.tr) == c["text"].stringValue!, "\(src)")
        }
    }

    @Test func invalid() {
        for e in Self.vectors["invalid"]["expressions"].arrayValue! { #expect(Expr.check(e.stringValue!) != nil, "\(e)") }
        for t in Self.vectors["invalid"]["templates"].arrayValue! { #expect(Expr.checkTemplate(t.stringValue!) != nil, "\(t)") }
    }
}

/// LockTreeExprTest.java: the expressions of the 6.2 trees (server/android/design-62-fixes.ts).
@Suite struct LockTreeExprTests {
    static let title = "{=$lock.setup ? _('lock.setupTitle') : _('lock.title')}"
    static let hint = "{=$lock.setup ? _('lock.setupHint') : ($lock.mode == 'biometric' ? _('lock.useBiometric') : _('lock.enterPin'))}"
    static let bio = "$lock.biometricAvailable && $lock.wait == 0"
    static let tr = Translator { "[\($0)]" }

    static func truthy(_ src: String, _ s: Scope) throws -> Bool { Expr.truthy(try Expr.eval(src, s, tr)) }

    @Test func lockHeader() throws {
        let locked = Scope(["lock": .obj(["mode": "pin", "setup": false, "wait": 0, "biometricAvailable": true, "wide": false])])
        #expect(Expr.check(String(Self.title.dropFirst(2).dropLast())) == nil)
        #expect(Expr.check(String(Self.hint.dropFirst(2).dropLast())) == nil)
        #expect(try Expr.render(Self.title, locked, Self.tr) == "[lock.title]")
        #expect(try Expr.render(Self.hint, locked, Self.tr) == "[lock.enterPin]")
        #expect(try Self.truthy(Self.bio, locked))
        #expect(try Self.truthy("!$lock.wide", locked))
        #expect(try !Self.truthy("$lock.wide", locked))

        let bio = Scope(["lock": .obj(["mode": "biometric", "setup": false, "wait": 30, "biometricAvailable": true, "wide": true])])
        #expect(try Expr.render(Self.hint, bio, Self.tr) == "[lock.useBiometric]")
        #expect(try !Self.truthy(Self.bio, bio))
        #expect(try Self.truthy("$lock.wide", bio))

        let setup = Scope(["lock": .obj(["mode": "pin", "setup": true, "step": "confirm", "wait": 0, "biometricAvailable": false])])
        #expect(try Expr.render(Self.title, setup, Self.tr) == "[lock.setupTitle]")
        #expect(try Expr.render(Self.hint, setup, Self.tr) == "[lock.setupHint]")
        #expect(try !Self.truthy(Self.bio, setup))
        #expect(try Self.truthy("!$lock.wide", Scope(["lock": .obj(["mode": "pin"])])))
    }

    @Test func deviceBoundAccount() throws {
        let bound = Scope(["account": .obj(["signedIn": true, "deviceBound": true, "canSeal": true, "recovery": false])])
        #expect(try Self.truthy("$account.signedIn && $account.deviceBound", bound))
        #expect(try Expr.value("=$account.deviceBound && !$account.recovery ? 'primary' : 'tonal'", bound, Self.tr) == "primary")
        #expect(try Expr.render("{=$account.recovery ? _('set.user.recoveryReplace') : _('set.user.recoveryCreate')}", bound, Self.tr) == "[set.user.recoveryCreate]")
        let usual = Scope(["account": .obj(["signedIn": true, "deviceBound": false, "canSeal": true, "recovery": true])])
        #expect(try !Self.truthy("$account.signedIn && $account.deviceBound", usual))
        #expect(try Expr.value("=$account.deviceBound && !$account.recovery ? 'primary' : 'tonal'", usual, Self.tr) == "tonal")
        #expect(try Expr.render("{=$account.recovery ? _('set.user.recoverySet') : _('set.user.recoveryNone')}", usual, Self.tr) == "[set.user.recoverySet]")
    }
}

/// Expr.java's semantics, case by case.
@Suite struct ExprSemanticsTests {
    static let s = Scope([
        "n": 5, "half": 0.5, "big": 1_760_000_000_000, "text": "Ahoj", "empty": "", "list": ["a", "b", "c"], "nums": [1, 2.5, "x"],
        "obj": .obj(["a": 1, "length": "custom", "7": "seven"]), "zero": 0, "neg0": .number(-0.0), "t": true, "f": false,
        "emoji": "a🙂b", "cz": "Žluť", "str3": "3", "nan": .number(.nan),
    ])

    func v(_ src: String) throws -> DesignValue { try Expr.eval(src, Self.s, .keys) }
    func t(_ src: String) throws -> String { try Expr.render(src, Self.s, .keys) }

    @Test func arithmeticAndComparisons() throws {
        #expect(try v("7 % 3") == 1)
        #expect(try v("-7 % 3") == -1)          // Java's % keeps the dividend's sign
        #expect(try v("7.5 % 2") == 1.5)
        #expect(try v("1 % 0") == .null)
        #expect(try v("$n / 2") == 2.5)
        #expect(try v("'5' * 2") == 10)          // texts are numbers where a number is asked
        #expect(try v("' 5 ' - 1") == 4)         // trimmed
        #expect(try v("'' + 1") == "1")
        #expect(try v("true + 1") == 2)
        #expect(try v("null + 1") == 1)
        #expect(Expr.num(try v("'abc' * 1")).isNaN)
        #expect(try v("'abc' < 1") == false)     // NaN compares false
        #expect(try v("$neg0 < 0") == true)      // Double.compare: -0.0 below 0.0
        #expect(try v("0 <= $neg0") == false)
        #expect(try v("$neg0 == 0") == true)
        #expect(try v("'B' < 'a'") == true)      // UTF-16 order
        #expect(try v("'é' > 'z'") == true)
        #expect(try v("1e3 + .5") == 1000.5)
        #expect(try v("'1.5f' * 2") == 3)        // Double.parseDouble takes a type suffix
        #expect(Expr.num(try v("'nan' * 1")).isNaN)
        #expect(try v("'Infinity' > 1e300") == true)
        #expect(try v("1 === 1") == true)
        #expect(try v("'a' !== 'a'") == false)
        #expect(try v("$t == 1") == false)       // no conversion for ==
        #expect(try v("$str3 == 3") == false)
        #expect(try v("$nan == $nan") == false)
    }

    @Test func logicReturnsOperands() throws {
        #expect(try v("$empty || 'x'") == "x")
        #expect(try v("$text && $n") == 5)
        #expect(try v("$list && 'yes'") == "yes")  // a list is truthy, even an empty one
        #expect(try v("!$zero") == true)
        #expect(Expr.num(try v("-$text")).isNaN)
        #expect(try v("$f ? 1 : $t ? 2 : 3") == 2)
    }

    @Test func membersAndIndexes() throws {
        #expect(try v("$list[0]") == "a")
        #expect(try v("$list['2']") == "c")
        #expect(try v("$list[1.5]") == .null)
        #expect(try v("$list[-1]") == .null)
        #expect(try v("$list[99999999999]") == .null)
        #expect(try v("$list.length") == 3)
        #expect(try v("$text[1]") == "h")
        #expect(try v("$text.length") == 4)
        #expect(try v("$emoji.length") == 4)     // UTF-16 code units
        #expect(try v("$obj.a") == 1)
        #expect(try v("$obj.length") == "custom")
        #expect(try v("$obj['7']") == "seven")
        #expect(try v("$obj[7]") == .null)       // a number is no key of an object
        #expect(try v("$n.x") == .null)
        #expect(try v("$missing[0].x") == .null)
        #expect(try v("$cz") == "Žluť")
    }

    @Test func textOfValues() {
        #expect(Expr.toText(5) == "5")
        #expect(Expr.toText(-0.0) == "0")
        #expect(Expr.toText(2.5) == "2.5")
        #expect(Expr.toText(.number(0.1 + 0.2)) == "0.3")
        #expect(Expr.toText(.number(1.0 / 3)) == "0.333333")
        #expect(Expr.toText(1_760_000_000_000) == "1760000000000")
        #expect(Expr.toText(1e15) == "1000000000000000" || Expr.toText(1e15).hasPrefix("9223372036854"))
        #expect(Expr.toText(0.0000001) == "0")
        #expect(Expr.toText(0.000001) == "0.000001")
        #expect(Expr.toText(-12.5) == "-12.5")
        #expect(Expr.toText(.number(.nan)) == "")
        #expect(Expr.toText(.number(.infinity)) == "")
        #expect(Expr.toText(true) == "true")
        #expect(Expr.toText(["a", 1, .null, ["b"]]) == "a, 1, , b")
        #expect(Expr.toText(.obj(["a": 1])) == "")
        #expect(Expr.toText(nil) == "")
    }

    @Test func filters() throws {
        #expect(try t("{$text|upper}") == "AHOJ")
        #expect(try t("{$cz|lower}") == "žluť")
        #expect(try t("{$text|truncate:2}") == "A…")
        #expect(try t("{$text|truncate:0}") == "…")
        #expect(try t("{$text|truncate:4}") == "Ahoj")
        #expect(try t("{$text|truncate}") == "Ahoj")
        #expect(try t("{$empty|default:'—'}") == "—")
        #expect(try t("{$empty|default:5}") == "5")
        #expect(try t("{$empty|default}") == "")
        #expect(try t("{$list|count}") == "3")
        #expect(try t("{$text|count}") == "4")
        #expect(try t("{$n|count}") == "0")
        #expect(try t("{$n|size}") == "5 B")
        #expect(Expr.checkTemplate("{=2048|size}") == "unexpected \"|\" at 4") // no filters after an expression
        #expect(Expr.sizeText(2048) == "2 kB")
        #expect(Expr.sizeText(1536) == "1.5 kB")
        #expect(Expr.sizeText(5 * 1024 * 1024 * 1024) == "5 GB")
        #expect(try t("{ $text | upper | lower }") == "ahoj")
        #expect(try t("{$text|  trim}") == "Ahoj")
        #expect(throws: ExprError.self) { try Expr.render("{$text|truncate:'x'}", Self.s, .keys) }
        #expect(Expr.checkTemplate("{$text|upper :x}") != nil)
        #expect(Expr.checkTemplate("{$text|Upper}") != nil)
    }

    @Test func dateFilters() throws {
        let at = 1_791_217_500_000.0 // 2026-10-05 16:25 UTC
        let utc = TimeZone(identifier: "UTC")!
        let fixed = Translator(lang: nil, timeZone: utc) { $0 }
        let sc = Scope(["at": .number(at)])
        #expect(try Expr.render("{$at|date}", sc, fixed) == "5. 10. 2026")
        #expect(try Expr.render("{$at|time}", sc, fixed) == "16:25")
        #expect(try Expr.render("{$at|datetime}", sc, fixed) == "5. 10. 2026 16:25")
        #expect(try Expr.render("{$text|date}", Self.s, fixed) == "")
        // 6.13: in the app's language
        let cs = Translator(lang: "cs", timeZone: utc) { $0 }
        #expect(try Expr.render("{$at|date}", sc, cs).replacingOccurrences(of: "\u{a0}", with: " ").replacingOccurrences(of: "\u{202f}", with: " ") == "5. 10. 2026")
        #expect(try Expr.render("{$at|time}", sc, cs) == "16:25")
        let de = Translator(lang: "de", timeZone: utc) { $0 }
        #expect(try Expr.render("{$at|date}", sc, de) == "05.10.2026")
        let en = Translator(lang: "en", timeZone: utc) { $0 }
        #expect(try Expr.render("{$at|date}", sc, en).contains("Oct 2026"))
    }

    @Test func templateForms() throws {
        #expect(try t("{{$text}") == "{$text}")
        #expect(try t("a } b") == "a } b")
        #expect(try t("{$list.1}") == "b")
        #expect(try t("{$obj.7}") == "")         // .7 becomes [7]: a number is no object key
        #expect(try t("{_\"some.key\"}") == "some.key")
        #expect(try t("{_'k'|upper}") == "K")
        #expect(try t("{_'k' ignored|upper}") == "K") // the text between the key and the first | is ignored, as on Android
        #expect(try t("{= $n * 2 }") == "10")
        #expect(Expr.checkTemplate("{$a.b-c}") != nil)
        #expect(Expr.checkTemplate("{$1a}") != nil)
        #expect(Expr.checkTemplate("{x}")?.contains("use {$var}") == true)
        #expect(Expr.checkTemplate("{_'open}") == "unclosed translation at 0")
        #expect(Expr.checkTemplate("ab{") == "unclosed \"{\" at 2")
    }

    @Test func errorsSpeakJava() {
        #expect(Expr.check("1 +") == "unexpected end of the expression")
        #expect(Expr.check("foo") == "unknown name \"foo\" at 0 (variables start with $)")
        #expect(Expr.check("$") == "bad variable at 0")
        #expect(Expr.check("'x") == "unterminated string at 0")
        #expect(Expr.check("(1") == "expected \")\" at 2")
        #expect(Expr.check("1 2") == "unexpected \"2\" at 2")
        #expect(Expr.check("a = 1") == "unexpected \"=\" at 2") // the lexer comes first
        #expect(Expr.check("1 # 2") == "unexpected \"#\" at 2")
        #expect(Expr.check("$a.") == "expected a name after \".\" at 3")
        #expect(Expr.check("_(1)") == "_() needs a quoted key at 2")
        #expect(Expr.check("1.2.3") == "For input string: \"1.2.3\"")
        #expect(Expr.check(String(repeating: "1+", count: 200) + "1") == "expression longer than 400 characters")
        #expect(Expr.check(String(repeating: "(", count: 41) + "1" + String(repeating: ")", count: 41)) == "expression nested too deep")
        #expect(Expr.check(String(repeating: "(", count: 39) + "1" + String(repeating: ")", count: 39)) == nil)
        #expect(Expr.check("$žluť + 'a\\'b'") == nil) // letters of any script, escapes
    }

    @Test func readsData() {
        #expect(!Expr.readsData(nil))
        #expect(!Expr.readsData("plain"))
        #expect(!Expr.readsData("{_'k'} and {{x}"))
        #expect(!Expr.readsData("=1 + 2 * (3 - 'a')"))
        #expect(Expr.readsData("={'x"))
        #expect(Expr.readsData("{$a}"))
        #expect(Expr.readsData("=_('k')[$i]"))
        #expect(Expr.readsData("{=true ? 1 : $x}"))
    }
}

/// Properties that hold for every input (seeded, so a failure repeats).
@Suite struct ExprPropertyTests {
    struct SplitMix: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// A random integer expression and its value (small numbers: exact in a double).
    static func arith(_ g: inout SplitMix, depth: Int) -> (String, Double) {
        if depth == 0 || Int.random(in: 0..<3, using: &g) == 0 {
            let n = Double(Int.random(in: -50...50, using: &g))
            return n < 0 ? ("(\(Int(n)))", n) : ("\(Int(n))", n)
        }
        let (a, x) = arith(&g, depth: depth - 1), (b, y) = arith(&g, depth: depth - 1)
        switch Int.random(in: 0..<4, using: &g) {
        case 0: return ("(\(a) + \(b))", x + y)
        case 1: return ("(\(a) - \(b))", x - y)
        case 2: return ("(\(a) * \(b))", x * y)
        default: return ("-\(a)", -x)
        }
    }

    @Test func integerArithmeticMatchesDoubles() throws {
        var g = SplitMix(state: 61400)
        for _ in 0..<500 {
            let (src, expected) = Self.arith(&g, depth: 4)
            guard src.utf16.count <= Expr.max else { continue }
            #expect(try Expr.eval(src, .empty) == .number(expected), "\(src)")
        }
    }

    @Test func wholeNumbersReadAsIntegers() {
        var g = SplitMix(state: 7)
        for _ in 0..<1000 {
            let n = Int64.random(in: -999_999_999_999_999...999_999_999_999_999, using: &g)
            #expect(Expr.toText(.number(Double(n))) == String(n))
        }
    }

    @Test func notNotIsTruthy() throws {
        let values: [DesignValue] = [nil, true, false, 0, 1, -0.5, .number(.nan), "", "0", "false", [], .obj([:]), ["x"]]
        for v in values {
            #expect(try Expr.eval("!!$v", Scope(["v": v])) == .bool(Expr.truthy(v)), "\(v)")
        }
    }

    @Test func literalTextRendersAsItIs() throws {
        var g = SplitMix(state: 99)
        let alphabet = Array("abcxyz ÁčŘ🙂.,:;|}$=_'\"\\\n\t")
        for _ in 0..<300 {
            let text = String((0..<Int.random(in: 0...30, using: &g)).map { _ in alphabet.randomElement(using: &g)! })
            #expect(try Expr.render(text, .empty) == text)
            #expect(try Expr.render("{{" + text, .empty) == "{" + text)
            if !text.hasPrefix("=") { #expect(!Expr.readsData(text)) } // "=…" is an expression
        }
    }

    @Test func stringComparisonIsUTF16Order() throws {
        var g = SplitMix(state: 5)
        let alphabet = Array("aAzZéŽ😀~ 0")
        for _ in 0..<300 {
            let a = String((0..<Int.random(in: 0...4, using: &g)).map { _ in alphabet.randomElement(using: &g)! })
            let b = String((0..<Int.random(in: 0...4, using: &g)).map { _ in alphabet.randomElement(using: &g)! })
            let expected = a.utf16.lexicographicallyPrecedes(b.utf16)
            #expect(try Expr.eval("$a < $b", Scope(["a": .string(a), "b": .string(b)])) == .bool(expected), "\(a) < \(b)")
        }
    }

    @Test func randomTextNeverCrashesAndValidMeansEvaluable() {
        var g = SplitMix(state: 2026)
        let alphabet = Array("$abc_0123.()[]!?:+-*/%<>=&|'\" \u{0}éŽ{}")
        var valid = 0
        for _ in 0..<3000 {
            let src = String((0..<Int.random(in: 0...24, using: &g)).map { _ in alphabet.randomElement(using: &g)! })
            if Expr.check(src) == nil {
                valid += 1
                #expect((try? Expr.eval(src, Scope(["a": 1, "abc": "x"]))) != nil, "\(src)")
            }
            _ = Expr.checkTemplate(src)
            _ = Expr.readsData(src)
        }
        #expect(valid > 10)
    }

    @Test func computedArgumentsAreDetectedWherever() {
        var g = SplitMix(state: 11)
        let pieces = ["1", "'a'", "_('k')", "true", "null", "(2 * 3)"]
        for _ in 0..<200 {
            var parts = (0..<Int.random(in: 1...4, using: &g)).map { _ in pieces.randomElement(using: &g)! }
            let literal = "=" + parts.joined(separator: " + ")
            #expect(!Expr.readsData(literal), "\(literal)")
            parts.insert("$msg.text", at: Int.random(in: 0...parts.count, using: &g))
            let computed = "=" + parts.joined(separator: " + ")
            #expect(Expr.readsData(computed), "\(computed)")
        }
    }
}
