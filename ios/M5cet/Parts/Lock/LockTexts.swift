// The lock screen's texts and colours from the design (the bundled
// default-design.json — the same file as Android's): every text the app shows
// comes from the design; until the Renderer hands over the active design, the
// built-in one is read here. Language: the system's preferred languages against
// the design's (sk falls back to cs, then en — Android Locales.chain).

import SwiftUI

struct LockTexts: Sendable {
    private let chain: [[String: String]]

    /// The app's nine languages (Android Locales).
    static let languages = ["cs", "en", "de", "es", "it", "fr", "sk", "sl", "fi"]

    init(strings: [String: [String: String]], languages: [String] = Locale.preferredLanguages) {
        let codes = languages.map { String($0.prefix(2)).lowercased() }
        // The first of the system's languages the app speaks (Android Locales.pick), else English.
        let lang = codes.first { Self.languages.contains($0) } ?? "en"
        var order = [lang]
        if lang == "sk" { order.append("cs") }
        order.append("en")
        chain = order.compactMap { strings[$0] }
    }

    /// The built-in design's strings.
    static let builtIn: LockTexts = LockTexts(strings: LockDesignFile.builtIn.strings)

    func callAsFunction(_ key: String) -> String {
        for table in chain { if let s = table[key] { return s } }
        return key
    }
}

/// The colours the PIN pad uses (theme "@primary", "@background", "@onSurface", "@muted", "@border", "@danger").
struct LockLook: Sendable {
    var primary: Color, background: Color, onSurface: Color, muted: Color, border: Color, danger: Color
    var dark: Bool

    static func builtIn(dark: Bool) -> LockLook {
        let t = (dark ? LockDesignFile.builtIn.dark : LockDesignFile.builtIn.light)
        func c(_ k: String, _ fallback: String) -> Color { Color(lockHex: t[k] ?? fallback) }
        return LockLook(primary: c("primary", dark ? "#fb7185" : "#e11d48"), background: c("background", dark ? "#0f1217" : "#f6f7f9"),
                        onSurface: c("onSurface", dark ? "#e8ecf2" : "#1b2230"), muted: c("muted", dark ? "#8d96a3" : "#667085"),
                        border: c("border", dark ? "#2a313c" : "#e2e5eb"), danger: c("danger", dark ? "#f87171" : "#dc2626"), dark: dark)
    }
}

/// The parts of the bundled design the lock screen needs.
struct LockDesignFile: Sendable {
    var strings: [String: [String: String]] = [:]
    var light: [String: String] = [:]
    var dark: [String: String] = [:]

    static let builtIn: LockDesignFile = {
        guard let url = Bundle.main.url(forResource: "default-design", withExtension: "json", subdirectory: "m5"),
              let data = try? Data(contentsOf: url),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return LockDesignFile() }
        var f = LockDesignFile()
        for (lang, table) in o["strings"] as? [String: Any] ?? [:] {
            f.strings[lang] = (table as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        }
        let theme = o["theme"] as? [String: Any] ?? [:]
        f.light = (theme["light"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        f.dark = (theme["dark"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        return f
    }()
}

fileprivate extension Color {
    /// "#rrggbb" or "#aarrggbb" (the design's colours).
    init(lockHex hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        let v = UInt64(s, radix: 16) ?? 0
        let a, r, g, b: Double
        if s.count == 8 {
            a = Double(v >> 24 & 0xff) / 255; r = Double(v >> 16 & 0xff) / 255; g = Double(v >> 8 & 0xff) / 255; b = Double(v & 0xff) / 255
        } else {
            a = 1; r = Double(v >> 16 & 0xff) / 255; g = Double(v >> 8 & 0xff) / 255; b = Double(v & 0xff) / 255
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}
