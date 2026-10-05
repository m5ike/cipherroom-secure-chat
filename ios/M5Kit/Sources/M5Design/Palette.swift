// The colour variants of the templates (6.2, Settings › Appearance › Colour) —
// a port of android/…/ui/look/Palette.java: a named hue and saturation, shaded
// per tone so it stays readable (about 6:1 like the web's accent presets).

import Foundation

public enum Palette {
    /// The dark tone's text colour and the background the shades are measured against.
    public static let ink = DesignColor(argb: 0xFF0B_0D10)

    /// id → (hue 0–360, saturation 0–1).
    static let named: [String: (h: Double, s: Double)] = [
        "red": (356, 0.82), "coral": (8, 0.78), "orange": (27, 0.92), "amber": (38, 0.95), "yellow": (50, 0.95),
        "lime": (84, 0.75), "green": (146, 0.62), "emerald": (160, 0.72), "mint": (165, 0.55), "teal": (174, 0.72),
        "cyan": (188, 0.85), "sky": (200, 0.88), "blue": (214, 0.88), "indigo": (236, 0.72), "violet": (265, 0.84),
        "purple": (285, 0.68), "magenta": (312, 0.72), "pink": (336, 0.80), "rose": (350, 0.70),
        "brown": (24, 0.45), "slate": (215, 0.22),
        "frost": (193, 0.43), "steel": (213, 0.32), "sage": (92, 0.28), "sand": (40, 0.60), "clay": (14, 0.50), "plum": (311, 0.22),
        "moss": (105, 0.38), "lilac": (272, 0.55), "ice": (198, 0.62), "cocoa": (22, 0.42), "gold": (44, 0.85),
    ]

    /// template id → its variants, in the picker's order (its own colour comes first, not listed).
    static let templates: [String: [String]] = [
        "design": ["red", "orange", "green", "blue", "violet", "teal", "pink"],
        "motorsport": ["red", "orange", "amber", "cyan", "green", "violet"],
        "glass": ["blue", "sky", "indigo", "violet", "teal", "pink"],
        "terminal": ["green", "lime", "amber", "cyan", "magenta", "slate"],
        "midnight": ["violet", "indigo", "blue", "pink", "teal", "amber"],
        "paper": ["brown", "red", "green", "blue", "purple", "teal"],
        "contrast": ["yellow", "cyan", "lime", "orange", "pink", "sky"],
        "ios": ["blue", "indigo", "purple", "pink", "red", "orange", "green", "teal"],
        "windows": ["blue", "sky", "teal", "green", "purple", "rose", "orange"],
        "aurora": ["emerald", "teal", "cyan", "sky", "violet", "pink"],
        "nord": ["frost", "steel", "sage", "sand", "clay", "plum"],
        "sakura": ["pink", "rose", "magenta", "purple", "coral", "mint"],
        "ocean": ["teal", "cyan", "sky", "blue", "indigo", "coral", "emerald"],
        "graphite": ["orange", "amber", "red", "blue", "green", "slate"],
        "forest": ["moss", "emerald", "teal", "sage", "amber", "clay", "sky"],
        "sunset": ["orange", "amber", "gold", "coral", "rose", "violet", "magenta"],
        "lavender": ["lilac", "violet", "purple", "indigo", "pink", "plum", "mint"],
        "mocha": ["cocoa", "brown", "clay", "amber", "sand", "sage", "rose"],
        "arctic": ["ice", "sky", "blue", "cyan", "teal", "indigo", "frost"],
        "ink": ["slate", "blue", "red", "green", "amber", "violet", "pink"],
    ]

    /// The variants a template offers (an unknown template gets the design's list).
    public static func variants(_ template: String?) -> [String] { templates[template ?? ""] ?? templates["design"]! }

    public static func has(_ template: String?, _ id: String?) -> Bool {
        guard let id, !id.isEmpty else { return false }
        return variants(template).contains(id)
    }

    public static func known(_ id: String) -> Bool { named[id] != nil }

    /// Templates that are bright on black (terminal, contrast) keep their variants as bright.
    static func target(_ template: String?, dark: Bool) -> Double {
        if dark && (template == "terminal" || template == "contrast") { return 10 }
        return 6
    }

    /// The variant's colour for a tone of a template, or nil for an unknown id.
    public static func color(_ template: String?, _ id: String, dark: Bool) -> DesignColor? {
        guard let hs = named[id] else { return nil }
        // Java computes in float: the hue and saturation are floats widened to double.
        return shade(Double(Float(hs.h)), Double(Float(hs.s)), dark: dark, target: target(template, dark: dark))
    }

    /// The lightness that reaches the contrast: in the light tone the lightest shade white text
    /// still reads on; in the dark tone the darkest shade that still stands out on the background.
    static func shade(_ h: Double, _ s: Double, dark: Bool, target: Double) -> DesignColor {
        var lo = dark ? 0.35 : 0.12, hi = dark ? 0.92 : 0.62
        for _ in 0..<24 {
            let mid = (lo + hi) / 2
            let c = hsl(h, s, mid)
            let ok = dark ? contrast(c, ink) >= target : contrast(.white, c) >= target
            if dark == ok { hi = mid } else { lo = mid }
        }
        return hsl(h, s, dark ? hi : lo)
    }

    /// White or near-black, whichever reads better on c.
    public static func onColor(_ c: DesignColor) -> DesignColor { contrast(.white, c) >= contrast(c, ink) ? .white : ink }

    /// HSL (h 0–360, s and l 0–1) → an opaque colour.
    public static func hsl(_ h0: Double, _ s: Double, _ l: Double) -> DesignColor {
        let h = (h0.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        let c = (1 - abs(2 * l - 1)) * s
        let x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = l - c / 2
        let (r, g, b): (Double, Double, Double)
        if h < 60 { (r, g, b) = (c, x, 0) } else if h < 120 { (r, g, b) = (x, c, 0) } else if h < 180 { (r, g, b) = (0, c, x) }
        else if h < 240 { (r, g, b) = (0, x, c) } else if h < 300 { (r, g, b) = (x, 0, c) } else { (r, g, b) = (c, 0, x) }
        func ch(_ v: Double) -> UInt32 { UInt32(JavaSemantics.round(max(0, min(1, v)) * 255)) }
        return DesignColor(argb: 0xFF00_0000 | ch(r + m) << 16 | ch(g + m) << 8 | ch(b + m))
    }

    /// WCAG relative luminance.
    public static func luminance(_ c: DesignColor) -> Double { c.luminance }

    /// WCAG contrast ratio (1–21).
    public static func contrast(_ a: DesignColor, _ b: DesignColor) -> Double {
        let x = a.luminance, y = b.luminance
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    public static func hex(_ c: DesignColor) -> String { String(format: "#%06x", c.argb & 0xFF_FFFF) }
}
