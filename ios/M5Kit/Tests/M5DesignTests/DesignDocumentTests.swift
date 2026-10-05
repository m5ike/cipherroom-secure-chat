import Foundation
import Testing
@testable import M5Design

/// The real default-design.json: it decodes, round-trips, and this version knows everything in it.
@Suite struct DesignDocumentTests {
    static let raw = try! Fixtures.data(Fixtures.assets + "default-design.json")

    @Test func theBuiltInDesignDecodes() throws {
        let d = Fixtures.builtIn
        #expect(d.source == "built-in")
        #expect(d.version == d.document.rev)
        #expect(d.document.format == 1)
        #expect(d.appName == "M5cet")
        #expect(d.document.screens.count >= 44)
        for id in Design.requiredScreens { #expect(d.screen(id) != nil, "\(id)") }
        #expect(d.menu("main")?.isEmpty == false)
        #expect(d.library("lock-and-rooms")?.steps?.count == 2)
        #expect(Set(d.document.strings.keys) == Set(DesignLocales.codes))
        #expect(d.theme?.light?["primary"] != nil && d.theme?.dark?["primary"] != nil)
        #expect(d.anim("screen").type == "slide-left")
        #expect(d.anim("splash").style == "orbit")
        #expect(d.anim("flash").stay == 3500)
        #expect(d.radius > 0)
    }

    @Test func roundTripsThroughCodable() throws {
        let original = try DesignValue.parse(Self.raw)
        let doc = try JSONDecoder().decode(DesignDocument.self, from: Self.raw)
        let encoded = try JSONEncoder().encode(doc)
        let again = try DesignValue.parse(encoded)
        #expect(again == original)
        // and the typed model through its value
        #expect(DesignDocument(value: original).value == original)
        #expect(try JSONDecoder().decode(DesignDocument.self, from: encoded) == doc)
    }

    @Test func thisVersionKnowsEverythingInIt() {
        let report = DesignReport.check(Fixtures.builtIn.document)
        #expect(report.unknownElements.isEmpty, "\(report.unknownElements)")
        #expect(report.unknownActions.isEmpty, "\(report.unknownActions)")
        #expect(report.unknownEvents.isEmpty, "\(report.unknownEvents)")
        #expect(report.expressionErrors.isEmpty, "\(report.expressionErrors.prefix(5))")
        #expect(report.problems.isEmpty, "\(report.problems.prefix(5))")
        #expect(report.nodeCount > 500)
    }

    @Test func unknownElementsActionsAndKeysAreKeptAndReported() throws {
        let src = """
        {"format": 1, "futureKey": {"x": [1, 2]}, "app": {"name": "X", "icon": "new"},
         "theme": {"light": {"primary": "#112233"}, "dark": {"primary": "#445566"}, "radius": 9, "glass": true},
         "screens": {"splash": {"id": "root", "el": "hologram", "glow": 3, "props": {"beam": "=$x"},
                                "on": {"pinch": {"action": "space.warp", "arg": "7", "speed": 2}},
                                "children": [{"id": "t", "el": "text", "text": "{$a}"}, 5]}},
         "menus": {"main": [{"id": "a", "icon": "star", "label": "A", "action": "teleport", "badge": 1}], "odd": 3},
         "strings": {"en": {"a": "A", "n": 5}}, "libraries": {"l": {"description": "", "steps": [{"do": "warp.drive"}, 7]}},
         "assets": {}, "rev": "r1"}
        """
        let v = try DesignValue.parse(src)
        let doc = DesignDocument(value: v)
        #expect(doc.extra["futureKey"] != nil)
        #expect(doc.appExtra["icon"] == "new")
        #expect(doc.theme?.extra["glass"] == true)
        let splash = try #require(doc.screens["splash"])
        #expect(splash.element == .unknown("hologram"))
        #expect(splash.extra["glow"] == 3)
        #expect(splash.on?["pinch"]?.extra["speed"] == 2)
        #expect(splash.children?.count == 1) // what is not an object is no child
        #expect(doc.menus["main"]??.first?.extra["badge"] == 1)
        #expect(doc.menus["odd"] == .some(nil))
        #expect(doc.strings["en"]?["n"] == "5")
        // what this version does not know is reported, not refused
        let r = DesignReport.check(doc)
        #expect(r.unknownElements == ["hologram"])
        #expect(r.unknownActions == ["space.warp", "teleport", "warp.drive"])
        #expect(r.unknownEvents == ["pinch"])
        #expect(r.problems.contains("no lock screen"))
        // and it encodes back with the unknown keys
        let back = doc.value
        #expect(back["futureKey"] == v["futureKey"])
        #expect(back["screens"]["splash"]["glow"] == 3)
        #expect(back["screens"]["splash"]["on"]["pinch"]["speed"] == 2)
        #expect(back["menus"]["main"][0]["badge"] == 1)
        #expect(back["libraries"]["l"]["steps"][1] == 7)
    }

    @Test func limitsAreReported() {
        var kids: [DesignNode] = []
        for i in 0..<(ElementCatalog.Limits.nodes + 1) { kids.append(DesignNode(id: "t\(i)", el: "text", text: "x")) }
        var deep = DesignNode(id: "d0", el: "column")
        for i in 1...(ElementCatalog.Limits.depth + 2) { deep = DesignNode(id: "d\(i)", el: "column", children: [deep]) }
        var doc = DesignDocument(value: .obj([:]))
        doc.screens["wide"] = DesignNode(id: "root", el: "column", children: kids)
        doc.screens["deep"] = deep
        doc.screens["long"] = DesignNode(id: "root", el: "text", text: String(repeating: "x", count: ElementCatalog.Limits.text + 1))
        doc.libraries["l"] = DesignLibrary(description: "", steps: Array(repeating: LibraryStep(action: "lib.run", arg: "l"), count: ElementCatalog.Limits.steps + 1))
        doc.menus["m"] = Array(repeating: DesignMenuItem(id: "x", icon: "nope", label: "{x}", action: "back"), count: ElementCatalog.Limits.menuItems + 1)
        let r = DesignReport.check(doc)
        #expect(r.problems.contains("wide: more than 1500 elements"))
        #expect(r.problems.contains { $0.contains("nested deeper than 30") })
        #expect(r.problems.contains("long/root: text longer than 4000"))
        #expect(r.problems.contains("libraries.l: more than 60 steps"))
        #expect(r.problems.contains("libraries.l[0]: a library cannot run another library"))
        #expect(r.problems.contains("menus.m: more than 40 items"))
        #expect(r.problems.contains("menus.m[0]: unknown icon \"nope\""))
        #expect(r.expressionErrors.contains { $0.hasPrefix("menus.m[0] label:") })
    }

    @Test func aBundlesFilesMakeADesign() throws {
        let doc = Fixtures.builtIn.document
        func json(_ v: DesignValue) -> Data { Data(v.jsonText().utf8) }
        var files: [String: Data] = [
            "app.json": json(.obj(["name": "Bundle"])),
            "theme.json": json(doc.theme!.value),
            "animations.json": json(.object(doc.animations!.mapValues { $0.value })),
            "menus/main.json": json(.array(doc.menus["main"]!!.map { $0.value })),
            "strings/en.json": json(.obj(["only.here": "Here"])),
            "lib/x.json": json(.obj(["description": "", "steps": []])),
            "assets/logo.png": Data([1, 2, 3]),
        ]
        for id in Design.requiredScreens { files["screens/\(id).json"] = json(doc.screens[id]!.value) }
        let d = try Design.fromFiles(bundleId: "bld_1", version: "6.14.0-b1", files: files)
        #expect(d.source == "bld_1" && d.version == "6.14.0-b1" && d.appName == "Bundle")
        #expect(d.assets["logo.png"] == Data([1, 2, 3]))
        #expect(d.menu("main")?.count == doc.menus["main"]!!.count)
        #expect(d.t("only.here", lang: "cs") == "Here")
        #expect(d.t("rooms.title", lang: "cs") == "rooms.title")
        #expect(d.withFallback(Fixtures.builtIn).t("rooms.title", lang: "cs") == "Místnosti")

        var missing = files
        missing["screens/lock.json"] = nil
        #expect(throws: DesignLoadError("the bundle has no lock screen")) { try Design.fromFiles(bundleId: "b", version: "v", files: missing) }
        var noTheme = files
        noTheme["theme.json"] = json(.obj(["dark": .obj([:])]))
        #expect(throws: DesignLoadError("the bundle has no theme")) { try Design.fromFiles(bundleId: "b", version: "v", files: noTheme) }
        var noApp = files
        noApp["app.json"] = nil
        #expect(throws: DesignLoadError("the bundle has no app.json")) { try Design.fromFiles(bundleId: "b", version: "v", files: noApp) }
        var broken = files
        broken["screens/extra.json"] = Data("{".utf8)
        #expect(throws: DesignLoadError.self) { try Design.fromFiles(bundleId: "b", version: "v", files: broken) }
    }

    @Test func colours() {
        let d = Fixtures.builtIn
        #expect(d.color("@primary", dark: false, fallback: .black) == DesignColor.parse(d.theme!.light!["primary"]!))
        #expect(d.color("@nope", dark: false, fallback: .magenta) == .magenta)
        #expect(d.color("#102030", dark: true, fallback: .black) == DesignColor(argb: 0xFF10_2030))
        #expect(d.color("#80102030", dark: true, fallback: .black) == DesignColor(argb: 0x8010_2030))
        #expect(d.color("teal", dark: true, fallback: .black) == DesignColor(argb: 0xFF00_8080))
        #expect(d.color("#12345", dark: true, fallback: .white) == .white)
        #expect(d.color("", dark: true, fallback: .white) == .white)
        #expect(d.color(nil, dark: true, fallback: .white) == .white)
        #expect(DesignColor.parse("#99000000")?.alpha8 == 0x99)
        #expect(DesignColor.white.withAlpha(0.14).alpha8 == 36)
        #expect(DesignColor(argb: 0xFFFF_FFFF).badgeContrast == DesignColor(argb: 0xFF1C_2330))
        #expect(DesignColor(argb: 0xFFE1_1D48).badgeContrast == .white)
    }
}

/// DesignTextsTest.java: the chain, the built-in design behind a bundle, plural forms.
@Suite struct DesignTextsTests {
    static func design(_ strings: DesignValue) -> Design { Design.fromDocument(DesignDocument(value: .obj(["rev": "t", "strings": strings]))) }

    @Test func aMissingTextComesFromTheChain() {
        let d = Self.design(.obj(["cs": .obj(["a": "cs-a"]), "en": .obj(["a": "en-a", "b": "en-b"]), "sk": .obj([:])]))
        #expect(d.t("a", lang: "sk") == "cs-a")
        #expect(d.t("b", lang: "sk") == "en-b")
        #expect(d.t("a", lang: "fi") == "en-a")
        #expect(d.t("c", lang: "sk") == "c")
        #expect(d.text("c", lang: "sk") == nil)
        #expect(d.t("a", lang: "xx") == "en-a")
    }

    @Test func anEmptyTextIsATextNotAGap() {
        let d = Self.design(.obj(["cs": .obj(["a": ""]), "en": .obj(["a": "A"])]))
        #expect(d.t("a", lang: "cs") == "")
    }

    @Test func anOlderBundleIsBackedByTheBuiltInDesignPerLanguage() {
        let builtIn = Self.design(.obj(["cs": .obj(["a": "built-cs-a", "x": "built-cs-x"]), "es": .obj(["a": "built-es-a"]), "en": .obj(["a": "built-en-a", "y": "built-en-y"])]))
        let bundle = Self.design(.obj(["cs": .obj(["y": "bundle-cs-y"]), "en": .obj(["a": "bundle-en-a"]), "de": .obj([:])])).withFallback(builtIn)
        #expect(bundle.t("a", lang: "en") == "bundle-en-a")
        #expect(bundle.t("a", lang: "cs") == "built-cs-a")
        #expect(bundle.t("a", lang: "es") == "built-es-a")
        #expect(bundle.t("x", lang: "sk") == "built-cs-x")
        #expect(bundle.t("y", lang: "sk") == "bundle-cs-y")
        #expect(bundle.t("y", lang: "de") == "built-en-y")
        #expect(bundle.t("z", lang: "de") == "z")
        #expect(builtIn.withFallback(builtIn) === builtIn)
        #expect(builtIn.t("y", lang: "fi") == "built-en-y")
    }

    @Test func aCountPicksItsPluralFormThenThePlainKey() {
        let d = Self.design(.obj([
            "cs": .obj(["k#one": "{n} zpráva", "k#few": "{n} zprávy", "k#other": "{n} zpráv", "k": "zprávy: {n}"]),
            "sl": .obj(["k#two": "{n} sporočili", "k#other": "{n} sporočil"]),
            "en": .obj(["k": "messages: {n}", "p#one": "{n} item"]),
        ]))
        #expect(d.tn("k", 1, lang: "cs") == "1 zpráva")
        #expect(d.tn("k", 3, lang: "cs") == "3 zprávy")
        #expect(d.tn("k", 5, lang: "cs") == "5 zpráv")
        #expect(d.tn("k", 3, lang: "sk") == "3 zprávy")
        #expect(d.tn("k", 102, lang: "sl") == "102 sporočili")
        #expect(d.tn("k", 3, lang: "sl") == "3 sporočil")
        #expect(d.tn("k", 2, lang: "de") == "messages: 2")
        #expect(d.tn("p", 1, lang: "fi") == "1 item")
        #expect(d.tn("p", 2, lang: "fi") == "p")
        let big = d.tn("k", 1234, lang: "cs")
        #expect(big.hasSuffix("zpráv"))
        #expect(big.unicodeScalars.filter { $0 != "\u{a0}" && $0 != "\u{202f}" && $0 != " " }.map(String.init).joined().hasPrefix("1234"))
    }

    @Test func theBuiltInDesignHasEveryTextInAllNineLanguages() {
        let strings = Fixtures.builtIn.document.strings
        let en = strings["en"]!
        #expect(en.count > 1400)
        for lang in DesignLocales.codes {
            let table = strings[lang] ?? [:]
            let missing = en.keys.filter { table[$0] == nil }
            #expect(missing.isEmpty, "\(lang) lacks \(missing.prefix(5))")
        }
        let d = Fixtures.builtIn
        #expect(d.t("settings.languageSystem", lang: "fi") == "Puhelimen mukaan")
        #expect(DesignLocales.info("sk").nativeName == "Slovenčina")
        #expect(!d.t("settings.language", lang: "sk").isEmpty && d.t("settings.language", lang: "sk") != "settings.language")
        #expect(d.tn("set.security.duress.length", 4, lang: "cs") == "Nouzový PIN musí mít 4 číslice.")
        #expect(d.tn("set.security.duress.length", 6, lang: "cs") == "Nouzový PIN musí mít 6 číslic.")
        #expect(d.tn("p4.heldDropped", 3, lang: "sk") == "3 zadržané správy sa nezobrazili (identita sa zmenila a nebola overená)")
        #expect(d.tn("nfc.eid.sum.images", 2, lang: "sl") == "2 sliki")
        #expect(d.tn("nfc.eid.sum.images", 1, lang: "de") == "1 Bild")
    }
}

/// LocalesTest.java against the vectors the TypeScript side writes (core/locales-vectors.json).
@Suite struct LocalesTests {
    static let vectors = try! Fixtures.json("android/app/src/test/resources/cz/m5cet/app/core/locales-vectors.json")

    @Test func theLanguagesAreTheContractsInItsOrder() {
        let locales = Self.vectors["locales"].arrayValue!
        #expect(locales.count == 9)
        var codes: [String] = []
        for v in locales {
            let code = v["code"].stringValue!
            codes.append(code)
            #expect(DesignLocales.isLocale(code))
            let info = DesignLocales.info(code)
            #expect(info.nativeName == v["native"].stringValue)
            #expect(info.english == v["english"].stringValue)
            #expect(info.tag == v["tag"].stringValue)
            #expect(info.fallback == v["fallback"].arrayValue!.map { $0.stringValue! })
            #expect(DesignLocales.chain(code) == v["chain"].arrayValue!.map { $0.stringValue! })
        }
        #expect(codes == DesignLocales.codes)
    }

    @Test func pickAnswersAsTheContractsPickLocale() {
        let cases = Self.vectors["pick"].arrayValue!
        #expect(cases.count >= 20)
        for c in cases {
            let got: String
            if let list = c["in"].arrayValue { got = DesignLocales.pick(list.map { $0.stringValue }, fallback: "en") }
            else { got = DesignLocales.pick(c["in"].stringValue, fallback: "en") }
            #expect(got == c["out"].stringValue, "\(c["in"])")
        }
    }

    @Test func slovakAndTheRest() {
        #expect(DesignLocales.pick(["sk-SK", "cs-CZ"], fallback: "en") == "sk")
        #expect(DesignLocales.chain("sk") == ["sk", "cs", "en"])
        #expect(!DesignLocales.isLocale("pl") && !DesignLocales.isLocale(nil))
        #expect(DesignLocales.info("pl").code == "en")
        #expect(DesignLocales.chain("xx") == ["en"])
        #expect(DesignLocales.pick("pl-PL,cs;q=0.5", fallback: "en") == "cs")
        #expect(DesignLocales.pick(nil as String?, fallback: "de") == "de")
        let label: [String: DesignValue] = ["cs": "Les", "en": "Forest", "es": ""]
        #expect(DesignLocales.text(label, "sk", "?") == "Les")
        #expect(DesignLocales.text(label, "es", "?") == "Forest")
        #expect(DesignLocales.text([:], "fi", "?") == "?")
        #expect(DesignLocales.text(nil, "cs", "?") == "?")
    }

    @Test func thePluralTableIsIntlsForEveryLanguage() {
        let plurals = Self.vectors["plurals"].objectValue!
        #expect(plurals.count == 9)
        var checked = 0
        for (tag, byCount) in plurals {
            for (n, cat) in byCount.objectValue! {
                #expect(DesignPlurals.category(tag, Int64(n)!) == cat.stringValue, "\(tag) \(n)")
                checked += 1
            }
        }
        #expect(checked >= 9 * 140)
        #expect(DesignPlurals.category("sl-SI", 101) == "one")
        #expect(DesignPlurals.category("fr-FR", 0) == "one")
        #expect(DesignPlurals.category("es-ES", 1_000_000) == "many")
        #expect(DesignPlurals.category("fi-FI", 0) == "other")
    }

    @Test func numbersAndDatesAreWrittenAsTheLanguageWritesThem() {
        func plain(_ s: String) -> String { String(s.unicodeScalars.filter { $0 != "\u{a0}" && $0 != "\u{202f}" && $0 != " " }.map(Character.init)) }
        #expect(DesignFormats.count("cs", 7) == "7")
        #expect(DesignFormats.count("en", 1234) == "1,234")
        #expect(DesignFormats.count("de", 1234) == "1.234")
        for l in ["cs", "sk", "fi", "fr"] {
            let s = DesignFormats.count(l, 1_234_567)
            #expect(s != "1234567" && plain(s) == "1234567", "\(l): \(s)")
        }
        #expect(DesignFormats.decimal("cs", 1.5, 1) == "1,5")
        #expect(DesignFormats.decimal("en", 1.5, 1) == "1.5")
        let utc = TimeZone(identifier: "UTC")!
        let at: Int64 = 1_791_217_500_000
        #expect(DesignFormats.date("de", at, timeZone: utc).contains("05.10.2026"))
        #expect(plain(DesignFormats.date("cs", at, timeZone: utc)).contains("5.10.2026"))
        #expect(DesignFormats.date("fi", at, timeZone: utc).contains("5.10.2026"))
        #expect(DesignFormats.date("en", at, timeZone: utc).contains("Oct 2026"))
        #expect(DesignFormats.date("es", at, timeZone: utc).lowercased().contains("oct"))
        for l in DesignLocales.codes {
            #expect(DesignFormats.time(l, at, timeZone: utc).replacingOccurrences(of: ".", with: ":").contains("16:25"), "\(l)")
        }
    }
}
