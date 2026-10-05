import Foundation
import Testing
@testable import M5Design

/// PaletteTest.java: the templates' colour variants, readable in both tones.
@Suite struct PaletteTests {
    static let templates = ["design", "motorsport", "glass", "terminal", "midnight", "paper", "contrast", "ios", "windows", "aurora", "nord", "sakura", "ocean", "graphite",
                            "forest", "sunset", "lavender", "mocha", "arctic", "ink"]

    @Test func hslConvertsLikeCss() {
        #expect(Palette.hsl(0, 1, 0.5) == DesignColor(argb: 0xFFFF_0000))
        #expect(Palette.hsl(120, 1, 0.251) == DesignColor(argb: 0xFF00_8000))
        #expect(Palette.hsl(240, 1, 0.5) == DesignColor(argb: 0xFF00_00FF))
        #expect(Palette.hsl(77, 0, 0.502) == DesignColor(argb: 0xFF80_8080))
        #expect(Palette.hsl(-30, 0.5, 0.5) == Palette.hsl(330, 0.5, 0.5))
        #expect(Palette.hex(DesignColor(argb: 0xFF1A_2B3C)) == "#1a2b3c")
    }

    @Test func contrastIsWcag() {
        #expect(abs(Palette.contrast(.white, .black) - 21) < 0.01)
        #expect(abs(Palette.contrast(.black, .white) - 21) < 0.01)
        #expect(abs(Palette.contrast(DesignColor(argb: 0xFF77_7777), DesignColor(argb: 0xFF77_7777)) - 1) < 0.0001)
        #expect(Palette.onColor(DesignColor(argb: 0xFF1D_4ED8)) == .white)
        #expect(Palette.onColor(DesignColor(argb: 0xFFFA_CC15)) == Palette.ink)
    }

    @Test func everyTemplateHasSixOrMoreKnownVariants() {
        for t in Self.templates {
            let v = Palette.variants(t)
            #expect(v.count >= 6, "\(t)")
            #expect(Set(v).count == v.count, "\(t) repeats a colour")
            for id in v { #expect(Palette.known(id), "\(t): \(id)") }
        }
    }

    @Test func variantsAreReadableInBothTones() {
        for t in Self.templates {
            for id in Palette.variants(t) {
                let light = Palette.color(t, id, dark: false)!, dark = Palette.color(t, id, dark: true)!
                #expect(Palette.contrast(.white, light) >= 5.9, "\(t)/\(id) light")
                #expect(Palette.onColor(light) == .white)
                #expect(Palette.contrast(dark, Palette.ink) >= Palette.target(t, dark: true) - 0.1, "\(t)/\(id) dark")
                #expect(Palette.contrast(Palette.onColor(dark), dark) >= 4.5)
            }
        }
    }

    @Test func brightTemplatesKeepBrightVariants() {
        for id in Palette.variants("terminal") { #expect(Palette.contrast(Palette.color("terminal", id, dark: true)!, Palette.ink) >= 9.9, "\(id)") }
        #expect(Palette.contrast(Palette.color("midnight", "violet", dark: true)!, Palette.ink) < 9)
    }

    @Test func lookupAndUnknowns() {
        #expect(Palette.has("ios", "red"))
        #expect(!Palette.has("nord", "red"))
        #expect(!Palette.has("ios", ""))
        #expect(!Palette.has("ios", nil))
        #expect(Palette.variants("no-such-template") == Palette.variants("design"))
        #expect(Palette.variants(nil) == Palette.variants("design"))
        #expect(Palette.color("ios", "no-such-colour", dark: false) == nil)
        #expect(Palette.color("no-such-template", "red", dark: true) != nil)
        #expect(Array(Palette.variants("design").prefix(5)) == ["red", "orange", "green", "blue", "violet"])
    }
}

/// MigrationTest.java: 6.1's appearance keys → 6.2's, once.
@Suite struct LookMigrationTests {
    static func plan(_ v: Double, _ preset: String, _ accent: String, _ variant: String, _ known: Bool) -> [String: DesignValue] {
        Dictionary(uniqueKeysWithValues: LookMigration.plan(version: v, preset: preset, accent: accent, variant: variant, presetKnown: known))
    }

    @Test func aWebAccentBecomesTheTemplatesVariant() {
        let p = Self.plan(0, "design", "violet", "", true)
        #expect(p["look.variant"] == "violet" && p["appearance.accent"] == "" && p["look.v"] == .number(LookMigration.version))
        #expect(p["appearance.preset"] == nil)
        #expect(Self.plan(0, "", "blue", "", true)["look.variant"] == "blue")
        #expect(Self.plan(0, "ios", "red", "", true)["look.variant"] == "red")
    }

    @Test func whatStays() {
        let nord = Self.plan(0, "nord", "red", "", true)
        #expect(nord["look.variant"] == nil && nord["appearance.accent"] == nil && nord["look.v"] == 1)
        let custom = Self.plan(0, "design", "#12ab34", "", true)
        #expect(custom["look.variant"] == nil && custom["appearance.accent"] == nil)
        let chosen = Self.plan(0, "design", "red", "teal", true)
        #expect(chosen["look.variant"] == nil && chosen["appearance.accent"] == nil)
        let unknown = Self.plan(0, "vaporwave", "green", "", false)
        #expect(unknown["appearance.preset"] == "design" && unknown["look.variant"] == "green")
        #expect(Self.plan(LookMigration.version, "vaporwave", "red", "", false).isEmpty)
        #expect(Self.plan(LookMigration.version + 1, "design", "red", "", true).isEmpty)
        var s = SettingsModel()
        s.set("appearance.accent", "green")
        s.migrateLook(presetKnown: true)
        #expect(s.str("look.variant") == "green" && s.str("appearance.accent") == "" && s.num("look.v") == 1)
    }
}

/// SwipeTest.java: a row's swipe.
@Suite struct SwipeTests {
    static let rightW = 78.0, leftW = 156.0, slop = 8.0, fling = 650.0

    @Test func sidesAndSettling() {
        #expect(SwipeMath.side(30) == SwipeMath.right && SwipeMath.side(-30) == SwipeMath.left && SwipeMath.side(0) == SwipeMath.closed)
        #expect(SwipeMath.settle(70, velocity: 0, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == Self.rightW)
        #expect(SwipeMath.settle(-150, velocity: 0, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == -Self.leftW)
        let at = SwipeMath.openAt * Self.rightW
        #expect(SwipeMath.settle(at, velocity: 0, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == Self.rightW)
        #expect(SwipeMath.settle(at - 1, velocity: 0, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == 0)
        let atLeft = SwipeMath.openAt * Self.leftW
        #expect(SwipeMath.settle(-atLeft, velocity: 0, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == -Self.leftW)
        #expect(SwipeMath.settle(-atLeft + 1, velocity: 0, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == 0)
        #expect(SwipeMath.settle(Self.rightW + 12, velocity: 0, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == Self.rightW)
        #expect(SwipeMath.pastOpen(at, rightWidth: Self.rightW, leftWidth: Self.leftW))
        #expect(!SwipeMath.pastOpen(at - 1, rightWidth: Self.rightW, leftWidth: Self.leftW))
        #expect(!SwipeMath.pastOpen(0, rightWidth: Self.rightW, leftWidth: Self.leftW))
    }

    @Test func claims() {
        #expect(!SwipeMath.claims(dx: Self.slop, dy: 0, slop: Self.slop, offset: 0, rightWidth: Self.rightW, leftWidth: Self.leftW))
        #expect(SwipeMath.claims(dx: Self.slop + 1, dy: 0, slop: Self.slop, offset: 0, rightWidth: Self.rightW, leftWidth: Self.leftW))
        #expect(SwipeMath.claims(dx: -20, dy: 5, slop: Self.slop, offset: 0, rightWidth: Self.rightW, leftWidth: Self.leftW))
        #expect(!SwipeMath.claims(dx: 20, dy: 30, slop: Self.slop, offset: 0, rightWidth: Self.rightW, leftWidth: Self.leftW))
        #expect(!SwipeMath.claims(dx: 20, dy: 18, slop: Self.slop, offset: 0, rightWidth: Self.rightW, leftWidth: Self.leftW))
        #expect(SwipeMath.claims(dx: 30, dy: 20, slop: Self.slop, offset: 0, rightWidth: Self.rightW, leftWidth: Self.leftW))
        #expect(!SwipeMath.claims(dx: 30, dy: 0, slop: Self.slop, offset: 0, rightWidth: 0, leftWidth: Self.leftW))
        #expect(SwipeMath.claims(dx: -30, dy: 0, slop: Self.slop, offset: 0, rightWidth: 0, leftWidth: Self.leftW))
        #expect(!SwipeMath.claims(dx: -30, dy: 0, slop: Self.slop, offset: 0, rightWidth: Self.rightW, leftWidth: 0))
        #expect(SwipeMath.claims(dx: -30, dy: 0, slop: Self.slop, offset: Self.rightW, rightWidth: Self.rightW, leftWidth: 0))
        #expect(!SwipeMath.claims(dx: 30, dy: 0, slop: Self.slop, offset: 0, rightWidth: 0, leftWidth: 0))
    }

    @Test func clampFlingProgress() {
        #expect(SwipeMath.clamp(40, rightWidth: Self.rightW, leftWidth: Self.leftW) == 40)
        #expect(SwipeMath.clamp(-100, rightWidth: Self.rightW, leftWidth: Self.leftW) == -100)
        #expect(abs(SwipeMath.clamp(Self.rightW + 20, rightWidth: Self.rightW, leftWidth: Self.leftW) - (Self.rightW + 20 * SwipeMath.resist)) < 0.001)
        #expect(abs(SwipeMath.clamp(-Self.leftW - 50, rightWidth: Self.rightW, leftWidth: Self.leftW) - (-Self.leftW - 50 * SwipeMath.resist)) < 0.001)
        #expect(SwipeMath.clamp(60, rightWidth: 0, leftWidth: Self.leftW) == 0)
        #expect(SwipeMath.clamp(-60, rightWidth: Self.rightW, leftWidth: 0) == 0)
        #expect(SwipeMath.settle(10, velocity: Self.fling, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == Self.rightW)
        #expect(SwipeMath.settle(-10, velocity: -Self.fling * 2, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == -Self.leftW)
        #expect(SwipeMath.settle(Self.rightW, velocity: -Self.fling, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == 0)
        #expect(SwipeMath.settle(-Self.leftW, velocity: Self.fling, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == 0)
        #expect(SwipeMath.settle(10, velocity: Self.fling - 1, fling: Self.fling, rightWidth: Self.rightW, leftWidth: Self.leftW) == 0)
        #expect(SwipeMath.settle(Self.rightW, velocity: -5000, fling: 0, rightWidth: Self.rightW, leftWidth: Self.leftW) == Self.rightW)
        #expect(SwipeMath.progress(0, width: Self.rightW) == 0)
        #expect(abs(SwipeMath.progress(Self.rightW / 2, width: Self.rightW) - 0.5) < 0.0001)
        #expect(abs(SwipeMath.progress(-Self.leftW / 2, width: Self.leftW) - 0.5) < 0.0001)
        #expect(SwipeMath.progress(Self.rightW * 2, width: Self.rightW) == 1)
        #expect(SwipeMath.progress(30, width: 0) == 0)
    }

    @Test func buttonIconOffset() {
        #expect(ButtonIconMath.offset(room: 200, text: 60) == 70)
        #expect(ButtonIconMath.offset(room: 50, text: 80) == 0)
        #expect(ButtonIconMath.offset(room: 0, text: 10) == 0)
    }
}

/// Appearance: the user's look over the design (design/Appearance.java), motion and shapes (ui/look/Look.java).
@Suite struct AppearanceTests {
    static func appearance(_ pairs: [(String, DesignValue)]) -> Appearance {
        var s = SettingsModel()
        for (k, v) in pairs { s.set(k, v) }
        return Appearance(settings: s, templates: Fixtures.templates)
    }

    @Test func templatesFromThemesJson() {
        #expect(Fixtures.templates.count >= 19)
        let ios = Fixtures.templates.first { $0.id == "ios" }!
        #expect(ios.family == "system" && ios.forcedDark == nil && ios.radius == 22)
        let motorsport = Fixtures.templates.first { $0.id == "motorsport" }!
        #expect(motorsport.forcedDark == true && motorsport.tokens(dark: false)["primary"] == motorsport.dark?["primary"])
    }

    @Test func accentsVariantsAndTemplates() {
        #expect(Self.appearance([]).override("primary", dark: false) == nil)
        // 6.1's web accent presets, as Color.HSVToColor makes them
        let red = Self.appearance([("appearance.accent", "red")])
        #expect(red.override("primary", dark: false) == Appearance.hsvToColor(Appearance.hslToHsv(356, 0.78, 0.42)))
        #expect(red.override("onPrimary", dark: false) == Palette.onColor(red.override("primary", dark: false)!))
        #expect(red.override("surface", dark: false) == nil)
        #expect(Self.appearance([("appearance.accent", "#123456")]).override("accent", dark: true) == DesignColor(argb: 0xFF12_3456))
        // a variant wins over the accent
        let v = Self.appearance([("appearance.accent", "red"), ("look.variant", "teal")])
        #expect(v.override("bubbleOut", dark: true) == Palette.color("design", "teal", dark: true))
        // a template's tokens; a one-tone template forces its tone
        let mot = Self.appearance([("appearance.preset", "motorsport")])
        #expect(mot.forcedDark() == true && mot.isDark(systemDark: false))
        #expect(mot.override("surface", dark: true) == DesignColor.parse("#11151d"))
        #expect(mot.radius(Fixtures.builtIn) == Fixtures.builtIn.radius)
        let term = Self.appearance([("appearance.preset", "terminal")])
        #expect(term.templateFont() == "mono" && term.radius(Fixtures.builtIn) == 6)
        let tone = Self.appearance([("appearance.tone", "dark")])
        #expect(tone.isDark(systemDark: false) && !Self.appearance([("appearance.tone", "light")]).isDark(systemDark: true))
        #expect(Self.appearance([]).isDark(systemDark: true) && Self.appearance([]).userDark(systemDark: false, legacyTone: "dark"))
    }

    @Test func hsvMatchesSkia() {
        #expect(Appearance.hsvToColor((0, 1, 1)) == DesignColor(argb: 0xFFFF_0000))
        #expect(Appearance.hsvToColor((120, 1, 1)) == DesignColor(argb: 0xFF00_FF00))
        #expect(Appearance.hsvToColor((0, 0, 0.5)) == DesignColor(argb: 0xFF80_8080))
        #expect(Appearance.hsvToColor((360, 1, 1)) == DesignColor(argb: 0xFFFF_0000))
    }

    @Test func sizesAndMotion() {
        #expect(Self.appearance([("appearance.fontScale", 3)]).fontScale == Double(Float(1.8)))
        #expect(Self.appearance([("appearance.density", "comfortable")]).density == Double(Float(1.2)))
        var s = SettingsModel()
        s.set("look.motion", "lively"); s.set("look.speed", 2)
        let look = Look(settings: s)
        #expect(look.ms(220) == 126)            // 220 × 1.15 / 2
        #expect(look.travel == Double(Float(1.6)))
        #expect(look.easing("decelerate") == .overshoot && look.easing("linear") == .linear)
        s.set("look.motion", "off")
        #expect(Look(settings: s).ms(220) == 0 && Look(settings: s).still)
        #expect(Look(settings: SettingsModel(), reducedMotion: true).still)
        s.set("look.shape", "rounded")
        let r = Look(settings: s)
        #expect(r.radius("button") == 12 && r.radius("chip") == 10 && r.radius("icon") == 14 && r.radius("field") == 16)
        #expect(Look(settings: SettingsModel()).radius("chip") == 999)
        #expect(Look(settings: SettingsModel()).family(Fixtures.builtIn) == .sans)
        var f = SettingsModel()
        f.set("look.font", "serif")
        #expect(Look(settings: f).family(Fixtures.builtIn) == .serif)
        #expect(Look.silent("look.haptics") && !Look.silent("look.font"))
    }

    @Test func presetsForTheAppearanceScreen() {
        let a = Self.appearance([("appearance.preset", "nord"), ("look.variant", "sage")])
        let p = a.presets(lang: "cs", designLabel: "M5cet", design: Fixtures.builtIn, systemDark: false, translator: Translator(design: Fixtures.builtIn, lang: "cs"))
        let list = p.arrayValue!
        #expect(list.count == 1 + Fixtures.templates.count)
        #expect(list[0]["value"] == "design" && list[0]["selected"] == false)
        let nord = list.first { $0["value"] == "nord" }!
        #expect(nord["selected"] == true && nord["tone"] == "both")
        #expect(nord["variants"].arrayValue!.contains { $0["value"] == "sage" && $0["selected"] == true })
        #expect(list.first { $0["value"] == "motorsport" }!["tone"] == "dark")
        // families in the picker's order: system, studio, classic
        let families = list.dropFirst().map { $0["family"].stringValue! }
        #expect(families == families.sorted { ["system": 0, "studio": 1, "classic": 2][$0]! < ["system": 0, "studio": 1, "classic": 2][$1]! })
    }
}
