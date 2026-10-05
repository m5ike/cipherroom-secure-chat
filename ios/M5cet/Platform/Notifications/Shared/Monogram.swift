// The web's monograms (Android contacts/Avatars): the first letter on a tint of
// a hue taken from the name — conversation avatars and senders' images.
//
// Shared: compiled into the app and, through a symlink, into M5cetNotifications.

import Foundation

/// The web's monograms (Android contacts/Avatars): the first letter, a hue from the name.
enum Monogram {
    /// A colour with alpha laid over white, opaque (an icon has nothing under it).
    static func opaque(_ argb: UInt32) -> UInt32 {
        let a = argb >> 24 & 0xff
        func ch(_ s: UInt32) -> UInt32 { (argb >> s & 0xff) * a / 255 + 255 * (255 - a) / 255 }
        return 0xff00_0000 | ch(16) << 16 | ch(8) << 8 | ch(0)
    }

    /// The monogram's background: the web's tint hsl(h 62% 42% / 0.22) on white.
    static func background(_ seed: String) -> UInt32 { opaque(hsl(Double(hue(seed)), 0.62, 0.42, 0.22)) }

    /// The monogram's letter: hsl(h 70% 42%).
    static func foreground(_ seed: String) -> UInt32 { hsl(Double(hue(seed)), 0.70, 0.42, 1) }

    /// The first code point of the name, upper case ("?" for none).
    static func glyph(_ name: String) -> String {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = n.unicodeScalars.first else { return "?" }
        return String(Character(first)).uppercased()
    }

    /// hueFor(): h = (h·31 + UTF-16 unit) mod 360 over the lower-cased name ("?" for none).
    static func hue(_ name: String) -> Int {
        let key = (name.isEmpty ? "?" : name).lowercased()
        var h = 0
        for u in key.utf16 { h = (h * 31 + Int(u)) % 360 }
        return h
    }

    /// CSS hsl() → ARGB (Java Math.round).
    static func hsl(_ h: Double, _ s: Double, _ l: Double, _ alpha: Double) -> UInt32 {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        var r = 0.0, g = 0.0, b = 0.0
        switch hp {
        case ..<1: (r, g) = (c, x)
        case ..<2: (r, g) = (x, c)
        case ..<3: (g, b) = (c, x)
        case ..<4: (g, b) = (x, c)
        case ..<5: (r, b) = (x, c)
        default: (r, b) = (c, x)
        }
        let m = l - c / 2
        func round(_ v: Double) -> UInt32 { UInt32(Swift.max(0, (v * 255 + 0.5).rounded(.down))) }
        return round(alpha) << 24 | round(r + m) << 16 | round(g + m) << 8 | round(b + m)
    }
}
