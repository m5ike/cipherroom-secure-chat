// 6.2 People: the round monogram of a person, exactly as the web draws it
// (UserBadge.tsx Avatar): one letter — or a short emoji avatar — on a tint of a
// hue derived from the name, so the same person has the same colour on the web
// and on the phone. Port of android/…/contacts/Avatars.java.

import Foundation
import M5Core

enum PeopleAvatars {
    /// avatarGlyphFor(): a 1–2 character emoji avatar if one is given, else the name's first letter
    /// upper-cased, "?" for none.
    static func glyph(_ name: String?, _ avatar: String?) -> String {
        let a = (avatar ?? "").javaTrimmed
        if !a.isEmpty && !a.contains(where: { $0 == "/" || $0 == ":" || $0 == "." }) && a.unicodeScalars.count <= 2 { return a }
        let n = (name ?? "").javaTrimmed
        guard let first = n.unicodeScalars.first else { return "?" }
        return String(first).uppercased(with: Locale(identifier: "en_US_POSIX"))
    }

    /// hueFor(): h = (h·31 + UTF-16 unit) mod 360 over the lower-cased name ("?" for none).
    static func hue(_ name: String?) -> Int {
        let key = ((name ?? "").isEmpty ? "?" : name!).lowercased(with: Locale(identifier: "en_US_POSIX"))
        var h = 0
        for u in key.utf16 { h = (h * 31 + Int(u)) % 360 }
        return h
    }

    /// The monogram's background: hsl(h 62% 42% / 0.22), as #aarrggbb.
    static func background(_ name: String?) -> String { hex(hsl(Float(hue(name)), 0.62, 0.42, 0.22)) }

    /// The letter's colour: hsl(h 70% 42%).
    static func foreground(_ name: String?) -> String { hex(hsl(Float(hue(name)), 0.70, 0.42, 1)) }

    /// CSS hsl() → ARGB (Java's float arithmetic and Math.round).
    static func hsl(_ h: Float, _ s: Float, _ l: Float, _ alpha: Float) -> UInt32 {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        var r: Float = 0, g: Float = 0, b: Float = 0
        if hp < 1 { r = c; g = x } else if hp < 2 { r = x; g = c } else if hp < 3 { g = c; b = x } else if hp < 4 { g = x; b = c } else if hp < 5 { r = x; b = c } else { r = c; b = x }
        let m = l - c / 2
        func round(_ v: Float) -> UInt32 { UInt32(max(0, min(255, (v + 0.5).rounded(.down)))) }
        return round(alpha * 255) << 24 | round((r + m) * 255) << 16 | round((g + m) * 255) << 8 | round((b + m) * 255)
    }

    /// "#aarrggbb" — the form the design's colours take.
    static func hex(_ argb: UInt32) -> String { String(format: "#%08x", argb) }
}
