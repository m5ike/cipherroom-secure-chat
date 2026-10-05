// The user's look on top of the design (6.1 / 6.2, Settings › Appearance) —
// the model parts of android/…/design/Appearance.java and ui/look/{Look,
// Migration,Swipe,Buttons,Sheets}.java: templates (themes.json) and their
// colour variants, the accent, the tone, the text size and density, the
// bubbles' shape, motion, the buttons' style and shape, the font. No drawing.

import Foundation

// MARK: - templates (assets/m5/themes.json)

/// A template of the web client (themes.json): its tokens per tone, radius and font.
public struct LookTemplate: Sendable, Hashable {
    public let id: String
    public let label: [String: DesignValue]?
    public let family: String
    public let tones: [String]?
    public let light: [String: String]?
    public let dark: [String: String]?
    public let radius: Int?
    public let font: String?

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        id = Opt.string(o["id"]) ?? ""
        label = o["label"]?.objectValue
        family = Opt.string(o["family"]) ?? "classic"
        tones = o["tones"]?.arrayValue?.compactMap { $0.stringValue }
        light = Opt.stringMap(o["light"])
        dark = Opt.stringMap(o["dark"])
        radius = o["radius"]?.numberValue.map { Int(JavaSemantics.intValue($0)) }
        font = Opt.string(o["font"])
    }

    /// The template's tokens for a tone (its only tone when it has one).
    public func tokens(dark isDark: Bool) -> [String: String] {
        if let t = isDark ? dark : light { return t }
        if let first = tones?.first { return (first == "dark" ? dark : first == "light" ? light : nil) ?? [:] }
        return [:]
    }

    /// A template with a single tone decides the tone (nil = the user's choice applies).
    public var forcedDark: Bool? {
        guard let tones, tones.count == 1 else { return nil }
        return tones[0] == "dark"
    }

    /// Reads themes.json.
    public static func list(_ data: Data) throws -> [LookTemplate] {
        (try DesignValue.parse(data)).arrayValue?.map { LookTemplate(value: $0) } ?? []
    }
}

// MARK: - appearance (colours, tone, sizes)

public struct Appearance: Sendable {
    public var settings: SettingsModel
    public var templates: [LookTemplate]

    public init(settings: SettingsModel = SettingsModel(), templates: [LookTemplate] = []) {
        self.settings = settings
        self.templates = templates
    }

    /// The web's accent presets (index.css): (dark HSL, light HSL).
    static let accents: [String: (dark: (Float, Float, Float), light: (Float, Float, Float))] = [
        "red": ((356, 82, 56), (356, 78, 42)),
        "orange": ((27, 92, 54), (24, 90, 38)),
        "green": ((146, 62, 46), (148, 64, 28)),
        "blue": ((214, 88, 60), (216, 84, 42)),
        "violet": ((265, 84, 68), (264, 62, 46)),
    ]

    /// The web's template families, in its picker's order.
    static let families = ["system", "studio", "classic"]

    public func template(_ id: String?) -> LookTemplate? { id.flatMap { id in templates.first { $0.id == id } } }

    public func hasTemplate(_ id: String?) -> Bool { template(id) != nil }

    public var preset: String { settings.str("appearance.preset") }

    static func accentToken(_ t: String) -> Bool { ["primary", "accent", "bubbleOut", "onPrimary", "onBubbleOut"].contains(t) }

    /// The colour a token has in the user's look, or nil (the design's own).
    public func override(_ token: String, dark: Bool) -> DesignColor? {
        let preset = self.preset, accent = settings.str("appearance.accent"), variant = settings.str("look.variant")
        if Self.accentToken(token) {
            let tpl = template(preset) == nil ? "design" : preset
            let a: DesignColor? = Palette.has(tpl, variant) ? Palette.color(tpl, variant, dark: dark) : accent.isEmpty ? nil : Self.accentColor(accent, dark: dark)
            if let a { return token == "onPrimary" || token == "onBubbleOut" ? Palette.onColor(a) : a }
        }
        guard let th = template(preset), let hex = th.tokens(dark: dark)[token] else { return nil }
        return DesignColor.parse(hex)
    }

    static func accentColor(_ accent: String, dark: Bool) -> DesignColor? {
        if accent.hasPrefix("#") { return DesignColor.parse(accent) }
        guard let p = accents[accent] else { return nil }
        let c = dark ? p.dark : p.light
        return hsvToColor(hslToHsv(c.0, c.1 / 100, c.2 / 100))
    }

    static func hslToHsv(_ h: Float, _ s: Float, _ l: Float) -> (Float, Float, Float) {
        let v = l + s * min(l, 1 - l)
        return (h, v == 0 ? 0 : 2 * (1 - l / v), v)
    }

    /// android.graphics.Color.HSVToColor (Skia's SkHSVToColor), in float.
    static func hsvToColor(_ hsv: (Float, Float, Float)) -> DesignColor {
        func round(_ x: Float) -> UInt32 { UInt32(max(0, (x + 0.5).rounded(.down))) }
        let s = max(0, min(1, hsv.1)), v = max(0, min(1, hsv.2))
        let vb = round(v * 255)
        if abs(s) <= 1.0 / 4096 { return DesignColor(argb: 0xFF00_0000 | vb << 16 | vb << 8 | vb) }
        let hx: Float = (hsv.0 < 0 || hsv.0 >= 360) ? 0 : hsv.0 / 60
        let w = hx.rounded(.down)
        let f = hx - w
        let p = round((1 - s) * v * 255)
        let q = round((1 - s * f) * v * 255)
        let t = round((1 - s * (1 - f)) * v * 255)
        let (r, g, b): (UInt32, UInt32, UInt32)
        switch UInt32(w) {
        case 0: (r, g, b) = (vb, t, p)
        case 1: (r, g, b) = (q, vb, p)
        case 2: (r, g, b) = (p, vb, t)
        case 3: (r, g, b) = (p, q, vb)
        case 4: (r, g, b) = (t, p, vb)
        default: (r, g, b) = (vb, p, q)
        }
        return DesignColor(argb: 0xFF00_0000 | (r & 0xFF) << 16 | (g & 0xFF) << 8 | (b & 0xFF))
    }

    /// A template with a single tone decides the tone (nil = the user's choice applies).
    public func forcedDark() -> Bool? { template(preset)?.forcedDark }

    /// The tone the user chose (Settings › Appearance › Tone, else the 5.x choice, else the system's).
    public func userDark(systemDark: Bool, legacyTone: String = "") -> Bool {
        let t = settings.str("appearance.tone")
        if t == "dark" { return true }
        if t == "light" { return false }
        if legacyTone == "dark" { return true }
        if legacyTone == "light" { return false }
        return systemDark
    }

    /// Ui.dark: a one-tone template decides; else the user's tone.
    public func isDark(systemDark: Bool, legacyTone: String = "") -> Bool { forcedDark() ?? userDark(systemDark: systemDark, legacyTone: legacyTone) }

    /// 6.2: the template's corner radius (dp), else the design's.
    public func radius(_ design: Design?) -> Int {
        if let r = template(preset)?.radius { return max(0, min(28, r)) }
        return design?.radius ?? 14
    }

    /// 6.2: the template's font (sans / serif / mono), or nil (the design's).
    public func templateFont() -> String? {
        let f = template(preset)?.font ?? ""
        return f.isEmpty ? nil : f
    }

    /// The text size factor, 0.7 … 1.8.
    public var fontScale: Double {
        let s = settings.num("appearance.fontScale")
        return Double(Float(s <= 0 ? 1 : max(0.7, min(1.8, s))))
    }

    /// Padding, margins and gaps: compact 0.8, comfortable 1.2.
    public var density: Double {
        switch settings.str("appearance.density") {
        case "compact": return Double(Float(0.8))
        case "comfortable": return Double(Float(1.2))
        default: return 1
        }
    }

    /// rounded | square | minimal
    public var bubbles: String { settings.str("appearance.bubbles") }

    /// $presets of Settings › Appearance: the design's own look first, then the templates by
    /// family, each with its preview colours and colour variants.
    public func presets(lang: String?, designLabel: String, design: Design, systemDark: Bool, translator: Translator) -> DesignValue {
        let current = preset, variant = settings.str("look.variant")
        let userDark = self.userDark(systemDark: systemDark)
        var out: [DesignValue] = [entry(id: "design", label: designLabel, family: "design", template: nil, current: current, variant: variant, userDark: userDark, design: design, translator: translator)]
        for family in Self.families {
            for th in templates where th.family == family {
                out.append(entry(id: th.id, label: th.label.map { DesignLocales.text($0, lang, th.id) } ?? th.id, family: family, template: th, current: current, variant: variant, userDark: userDark, design: design, translator: translator))
            }
        }
        for th in templates where !Self.families.contains(th.family) {
            out.append(entry(id: th.id, label: th.label.map { DesignLocales.text($0, lang, th.id) } ?? th.id, family: th.family, template: th, current: current, variant: variant, userDark: userDark, design: design, translator: translator))
        }
        return .array(out)
    }

    private func entry(id: String, label: String, family: String, template th: LookTemplate?, current: String, variant: String, userDark: Bool, design: Design, translator: Translator) -> DesignValue {
        let chosen = id == current || (id == "design" && (current.isEmpty || template(current) == nil))
        let forced = th?.forcedDark
        let dark = forced ?? userDark
        let tokens = th?.tokens(dark: dark) ?? (design.theme?.tone(dark: dark) ?? [:])
        let primary = tokens["primary"] ?? "#888888"
        var variants: [DesignValue] = [[
            "value": "", "label": .string(translator.t("look.variant.own")), "color": .string(primary),
            "on": .string(tokens["onPrimary"] ?? "#ffffff"), "selected": .bool(chosen && !Palette.has(id, variant)),
        ]]
        for v in Palette.variants(id) {
            guard let c = Palette.color(id, v, dark: dark) else { continue }
            variants.append(["value": .string(v), "label": .string(translator.t("color." + v)), "color": .string(Palette.hex(c)),
                             "on": .string(Palette.hex(Palette.onColor(c))), "selected": .bool(chosen && v == variant)])
        }
        return [
            "value": .string(id), "label": .string(label), "family": .string(family), "selected": .bool(chosen),
            "tone": .string(forced == nil ? "both" : forced! ? "dark" : "light"),
            "bg": .string(tokens["background"] ?? "#808080"), "surface": .string(tokens["surface"] ?? "#909090"),
            "fg": .string(tokens["onSurface"] ?? "#000000"), "primary": .string(primary), "onPrimary": .string(tokens["onPrimary"] ?? "#ffffff"),
            "variants": .array(variants),
        ]
    }
}

// MARK: - look (motion, buttons, font)

/// The font families of the design and the user's look (Look.familyName).
public enum FontFamily: String, Sendable, CaseIterable {
    case sans, serif, mono, condensed, medium, light, casual, cursive

    /// A font choice of the design or the settings ("" and anything unknown: sans).
    public init(choice: String?) { self = FontFamily(rawValue: choice ?? "") ?? .sans }
}

/// The easing curves of the design's animations (Ui.easing).
public enum Easing: String, Sendable, CaseIterable {
    /// PathInterpolator(0.4, 0, 0.2, 1)
    case standard
    /// DecelerateInterpolator(1.6)
    case decelerate
    /// AccelerateInterpolator(1.4)
    case accelerate
    case linear
    /// OvershootInterpolator(1.6)
    case overshoot
    case bounce

    public init(name: String?) { self = Easing(rawValue: name ?? "") ?? .standard }
}

public struct Look: Sendable {
    public var settings: SettingsModel
    public var appearance: Appearance
    /// The system asks for less motion (Ui.reducedMotion).
    public var reducedMotion: Bool

    public init(settings: SettingsModel, appearance: Appearance? = nil, reducedMotion: Bool = false) {
        self.settings = settings
        self.appearance = appearance ?? Appearance(settings: settings)
        self.reducedMotion = reducedMotion
    }

    public static let keys = (variant: "look.variant", font: "look.font", motion: "look.motion", speed: "look.speed", buttons: "look.buttons",
                              shape: "look.shape", press: "look.press", haptics: "look.haptics", toolsDock: "look.toolsDock",
                              hintSend: "look.hintSendOptions", version: "look.v")

    private func str(_ key: String, _ dflt: String) -> String { let v = settings.str(key); return v.isEmpty ? dflt : v }

    /// off | subtle | normal | lively
    public var motion: String { str(Self.keys.motion, "normal") }

    /// 0.5 (slow) … 2 (fast).
    public var speed: Double {
        let v = settings.num(Self.keys.speed)
        return Double(Float(v <= 0 ? 1 : max(0.5, min(2, v))))
    }

    /// No animations at all.
    public var still: Bool { motion == "off" || reducedMotion }

    /// A duration of the design (ms) scaled by the motion and the speed (0 when motion is off).
    public func ms(_ base: Double) -> Double {
        let m = motion
        if m == "off" { return 0 }
        let k = m == "subtle" ? 0.8 : m == "lively" ? 1.15 : 1
        return Double(max(0, JavaSemantics.round(base * k / speed)))
    }

    /// How far things slide / how much they grow: subtle less, lively more.
    public var travel: Double { motion == "subtle" ? Double(Float(0.4)) : motion == "lively" ? Double(Float(1.6)) : 1 }

    /// Lively motion overshoots where the design decelerates.
    public func easing(_ name: String?) -> Easing {
        if motion == "lively", name == nil || name == "" || name == "decelerate" || name == "standard" { return .overshoot }
        return Easing(name: name)
    }

    /// filled | tonal | outlined | text — the main (primary) buttons.
    public var buttons: String { str(Self.keys.buttons, "filled") }
    /// pill | rounded | square
    public var shape: String { str(Self.keys.shape, "pill") }
    /// ripple | scale | none
    public var press: String { str(Self.keys.press, "ripple") }
    public var haptics: Bool { settings.bool(Self.keys.haptics) }

    /// The corner radius (dp) of a button ("button"), a chip ("chip"), a round icon button ("icon") or a text field ("field").
    public func radius(_ role: String) -> Double {
        if shape == "pill" { return 999 }
        let square = shape == "square"
        switch role {
        case "chip": return square ? 4 : 10
        case "icon": return square ? 6 : 14
        case "field": return square ? 6 : 16
        default: return square ? 4 : 12
        }
    }

    /// "" (the template's / design's) | sans | serif | mono | condensed | medium | light | casual | cursive
    public var font: String { str(Self.keys.font, "") }

    /// The font family in use: the user's, else the template's, else the design's.
    public func family(_ design: Design?) -> FontFamily {
        var f = font
        if f.isEmpty { f = appearance.templateFont() ?? design?.font ?? "sans" }
        return FontFamily(choice: f)
    }

    /// Tools as a floating dock above the composer (else the bottom sheet of 6.1).
    public var toolsDock: Bool { settings.get(Self.keys.toolsDock) != .bool(false) }

    /// Keys whose change does not redraw the screen.
    public static func silent(_ key: String) -> Bool {
        [keys.hintSend, keys.version, keys.haptics, keys.toolsDock].contains(key)
    }
}

extension SettingsModel {
    /// look.set: a look.* or appearance.* key; a colour the new template does not offer goes back to the template's own.
    @discardableResult
    public mutating func lookSet(_ key: String, _ value: String) -> Bool {
        guard key.hasPrefix("look.") || key.hasPrefix("appearance.") else { return false }
        let variant = str(Look.keys.variant)
        if key == "appearance.preset", !variant.isEmpty, !Palette.has(value, variant) { set(Look.keys.variant, "") }
        return set(key, .string(value))
    }

    /// The keys look.reset / appearance.reset put back to their defaults.
    public static let lookResetKeys = ["appearance.tone", "appearance.preset", "appearance.accent", "appearance.fontScale", "appearance.density", "appearance.bubbles",
                                       "look.variant", "look.font", "look.motion", "look.speed", "look.buttons", "look.shape", "look.press", "look.haptics", "look.toolsDock"]

    /// appearance.reset / look.reset: the design's own look again.
    public mutating func lookReset() {
        for k in Self.lookResetKeys { if let d = Self.defaults[k] { set(k, d) } }
    }

    /// The one-time move of 6.1's appearance keys into 6.2's (ui/look/Migration); `presetKnown`:
    /// the stored template exists (or is the design's own).
    public mutating func migrateLook(presetKnown: Bool) {
        for (k, v) in LookMigration.plan(version: num(Look.keys.version), preset: str("appearance.preset"), accent: str("appearance.accent"),
                                         variant: str(Look.keys.variant), presetKnown: presetKnown) {
            set(k, v)
        }
    }
}

/// ui/look/Migration: 6.1's appearance keys → 6.2's, once.
public enum LookMigration {
    public static let version: Double = 1

    /// key → new value; nothing when the settings are already migrated.
    public static func plan(version current: Double, preset: String?, accent: String?, variant: String?, presetKnown: Bool) -> [(String, DesignValue)] {
        var out: [(String, DesignValue)] = []
        if current >= version { return out }
        var p = (preset ?? "").isEmpty ? "design" : preset!
        if !presetKnown { p = "design"; out.append(("appearance.preset", "design")) }
        let a = accent ?? ""
        if (variant ?? "").isEmpty && Palette.has(p, a) {
            out.append(("look.variant", .string(a)))
            out.append(("appearance.accent", ""))
        }
        out.append(("look.v", .number(version)))
        return out
    }
}

/// ui/look/Swipe: the arithmetic of a row's swipe (offsets in points, positive = moved right).
public enum SwipeMath {
    public static let closed = 0, right = 1, left = -1
    /// A drag is the row's once it is this many times more sideways than down.
    public static let dominance: Double = Double(Float(1.25))
    /// Let go past this share of a side's actions, the row stays open on that side.
    public static let openAt: Double = Double(Float(0.45))
    /// Past its actions the row follows the finger only this much.
    public static let resist: Double = Double(Float(0.2))
    /// A fling this fast (dp/s) decides on its own.
    public static let flingDp: Double = 650
    /// At most this many actions on a side (SwipeRow.MAX_PER_SIDE).
    public static let maxPerSide = 4

    public static func side(_ offset: Double) -> Int { offset > 0 ? right : offset < 0 ? left : closed }

    public static func claims(dx: Double, dy: Double, slop: Double, offset: Double, rightWidth: Double, leftWidth: Double) -> Bool {
        let ax = abs(dx)
        if ax <= slop || ax < dominance * abs(dy) { return false }
        if offset != 0 { return true }
        return dx > 0 ? rightWidth > 0 : leftWidth > 0
    }

    public static func clamp(_ offset: Double, rightWidth: Double, leftWidth: Double) -> Double {
        if offset > 0 {
            if rightWidth <= 0 { return 0 }
            return offset <= rightWidth ? offset : rightWidth + (offset - rightWidth) * resist
        }
        if offset < 0 {
            if leftWidth <= 0 { return 0 }
            return -offset <= leftWidth ? offset : -leftWidth + (offset + leftWidth) * resist
        }
        return 0
    }

    public static func settle(_ offset: Double, velocity: Double, fling: Double, rightWidth: Double, leftWidth: Double) -> Double {
        let s = side(offset)
        if s == closed { return 0 }
        let width = s == right ? rightWidth : leftWidth
        if width <= 0 { return 0 }
        if fling > 0 && abs(velocity) >= fling { return velocity * Double(s) > 0 ? Double(s) * width : 0 }
        return abs(offset) >= openAt * width ? Double(s) * width : 0
    }

    public static func pastOpen(_ offset: Double, rightWidth: Double, leftWidth: Double) -> Bool {
        let width = offset > 0 ? rightWidth : leftWidth
        return width > 0 && offset != 0 && abs(offset) >= openAt * width
    }

    public static func progress(_ offset: Double, width: Double) -> Double {
        if width <= 0 { return 0 }
        return max(0, min(1, abs(offset) / width))
    }
}

/// ui/look/Buttons: how far a wide button's icon moves in from the edge to sit beside its label.
public enum ButtonIconMath {
    public static func offset(room: Double, text: Double) -> Double {
        room <= 0 ? 0 : max(0, Double(JavaSemantics.roundInt((room - min(text, room)) / 2)))
    }
}
