// The nine languages as the design's texts need them: the lookup chain
// (Slovak → Czech → English), the CLDR plural categories, and numbers and
// dates written as the language writes them. A copy of Android's
// core/Locales.java (chain), core/Plurals.java (builtIn table) and
// core/Formats.java — the contract itself (client/src/lib/locales.ts) is
// M5Core's; the app may hand its own `DesignLanguage` to the design instead.

import Foundation
import Synchronization

/// What the design's texts ask of the app's languages. `BuiltInLanguages` is
/// the port of Android's tables; the app may wire M5Core's locales instead.
public protocol DesignLanguage: Sendable {
    /// The languages a text is looked up in, in order (the language, its fallbacks, English).
    func chain(_ lang: String?) -> [String]
    /// The CLDR plural category (zero, one, two, few, many, other) of a whole number.
    func pluralCategory(_ lang: String?, _ n: Int64) -> String
    /// A whole number as the language writes it (1 234, 1.234, 1,234).
    func count(_ lang: String?, _ n: Int64) -> String
}

public struct BuiltInLanguages: DesignLanguage {
    public init() {}
    public func chain(_ lang: String?) -> [String] { DesignLocales.chain(lang) }
    public func pluralCategory(_ lang: String?, _ n: Int64) -> String { DesignPlurals.category(DesignLocales.tag(lang), n) }
    public func count(_ lang: String?, _ n: Int64) -> String { DesignFormats.count(lang, n) }
}

/// core/Locales.java: codes, native names, BCP 47 tags, fallbacks.
public enum DesignLocales {
    public struct Info: Sendable, Equatable {
        public let code: String
        public let nativeName: String
        public let english: String
        public let tag: String
        public let fallback: [String]
    }

    /// In the contract's order.
    public static let codes = ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"]

    private static let infos: [String: Info] = [
        "en": Info(code: "en", nativeName: "English", english: "English", tag: "en-GB", fallback: []),
        "cs": Info(code: "cs", nativeName: "Čeština", english: "Czech", tag: "cs-CZ", fallback: []),
        "de": Info(code: "de", nativeName: "Deutsch", english: "German", tag: "de-DE", fallback: []),
        "es": Info(code: "es", nativeName: "Español", english: "Spanish", tag: "es-ES", fallback: []),
        "it": Info(code: "it", nativeName: "Italiano", english: "Italian", tag: "it-IT", fallback: []),
        "fr": Info(code: "fr", nativeName: "Français", english: "French", tag: "fr-FR", fallback: []),
        "sk": Info(code: "sk", nativeName: "Slovenčina", english: "Slovak", tag: "sk-SK", fallback: ["cs"]),
        "sl": Info(code: "sl", nativeName: "Slovenščina", english: "Slovenian", tag: "sl-SI", fallback: []),
        "fi": Info(code: "fi", nativeName: "Suomi", english: "Finnish", tag: "fi-FI", fallback: []),
    ]

    public static func isLocale(_ v: String?) -> Bool { v.map { infos[$0] != nil } ?? false }

    /// The language's facts, or English's for anything else.
    public static func info(_ code: String?) -> Info { code.flatMap { infos[$0] } ?? infos["en"]! }

    public static func tag(_ code: String?) -> String { info(code).tag }

    /// The chain a text is looked up in: the language, its fallbacks, then English.
    public static func chain(_ code: String?) -> [String] {
        let i = info(code)
        var out = [i.code] + i.fallback
        if !out.contains("en") { out.append("en") }
        return out
    }

    /// The best supported language for a list of BCP 47 tags, else `fallback`.
    public static func pick(_ preferred: [String?]?, fallback: String) -> String {
        for raw in preferred ?? [] {
            guard let raw else { continue }
            var code = JavaSemantics.trim(raw)
            if let semi = code.firstIndex(of: ";") { code = String(code[..<semi]) }
            code = code.lowercased()
            if let cut = code.firstIndex(where: { $0 == "-" || $0 == "_" }) { code = String(code[..<cut]) }
            if isLocale(code) { return code }
        }
        return fallback
    }

    /// The same for a comma-separated list ("sk-SK,cs;q=0.8,en").
    public static func pick(_ preferred: String?, fallback: String) -> String {
        guard let preferred else { return fallback }
        return pick(preferred.split(separator: ",", omittingEmptySubsequences: false).map { String($0) }, fallback: fallback)
    }

    /// A text from a { "cs": …, "en": … } object along the language's chain; empty texts count as missing.
    public static func text(_ byLang: [String: DesignValue]?, _ code: String?, _ dflt: String) -> String {
        guard let byLang else { return dflt }
        for l in chain(code) {
            if let v = byLang[l]?.optString(""), !v.isEmpty { return v }
        }
        return dflt
    }
}

/// core/Plurals.java: the CLDR rules (v46) of the app's languages for whole numbers.
public enum DesignPlurals {
    public static let categories = ["zero", "one", "two", "few", "many", "other"]

    public static func category(_ tag: String?, _ n: Int64) -> String {
        let t = (tag ?? "").lowercased()
        let lang = String(t.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? "")
        let i = n == Int64.min ? Int64.max : abs(n)
        switch lang {
        case "cs", "sk":
            return i == 1 ? "one" : (i >= 2 && i <= 4) ? "few" : "other"
        case "sl":
            let h = i % 100
            return h == 1 ? "one" : h == 2 ? "two" : (h == 3 || h == 4) ? "few" : "other"
        case "fr":
            return (i == 0 || i == 1) ? "one" : i % 1_000_000 == 0 ? "many" : "other"
        case "es", "it":
            return i == 1 ? "one" : (i != 0 && i % 1_000_000 == 0) ? "many" : "other"
        default:
            return i == 1 ? "one" : "other"
        }
    }
}

/// core/Formats.java: numbers, dates and times as the app's language writes them (its BCP 47 tag).
public enum DesignFormats {
    private static let formatters = Mutex([String: Formatter]())

    private static func with<T: Sendable>(_ key: String, _ make: () -> Formatter, _ use: (Formatter) -> T) -> T {
        formatters.withLock { cache in
            let f: Formatter
            if let cached = cache[key] { f = cached } else { f = make(); cache[key] = f }
            return use(f)
        }
    }

    private static func locale(_ lang: String?) -> Locale { Locale(identifier: DesignLocales.tag(lang)) }

    /// A whole number: 7, 1 234 (cs), 1.234 (de), 1,234 (en).
    public static func count(_ lang: String?, _ n: Int64) -> String {
        if n > -1000 && n < 1000 { return String(n) }
        return with("count|\(DesignLocales.tag(lang))", {
            let f = NumberFormatter()
            f.locale = locale(lang)
            f.numberStyle = .decimal
            f.maximumFractionDigits = 0
            return f
        }) { ($0 as! NumberFormatter).string(from: NSNumber(value: n)) ?? String(n) }
    }

    /// A number with exactly `digits` decimals: 1,5 (cs), 1.5 (en).
    public static func decimal(_ lang: String?, _ v: Double, _ digits: Int) -> String {
        with("decimal|\(DesignLocales.tag(lang))|\(digits)", {
            let f = NumberFormatter()
            f.locale = locale(lang)
            f.numberStyle = .decimal
            f.maximumFractionDigits = Swift.max(0, digits)
            f.minimumFractionDigits = Swift.max(0, digits)
            f.roundingMode = .halfEven
            return f
        }) { ($0 as! NumberFormatter).string(from: NSNumber(value: v)) ?? String(v) }
    }

    private static func dateText(_ lang: String?, _ at: Int64, _ tz: TimeZone?, _ date: DateFormatter.Style, _ time: DateFormatter.Style) -> String {
        let zone = tz ?? .current
        return with("date|\(DesignLocales.tag(lang))|\(date.rawValue)|\(time.rawValue)|\(zone.identifier)", {
            let f = DateFormatter()
            f.locale = locale(lang)
            f.timeZone = zone
            f.dateStyle = date
            f.timeStyle = time
            return f
        }) { ($0 as! DateFormatter).string(from: Date(timeIntervalSince1970: Double(at) / 1000)) }
    }

    /// A day: 5. 10. 2026 (cs), 05.10.2026 (de), 5 Oct 2026 (en-GB).
    public static func date(_ lang: String?, _ at: Int64, timeZone: TimeZone? = nil) -> String { dateText(lang, at, timeZone, .medium, .none) }

    /// A time of day, hours and minutes.
    public static func time(_ lang: String?, _ at: Int64, timeZone: TimeZone? = nil) -> String { dateText(lang, at, timeZone, .none, .short) }

    /// A time of day with seconds.
    public static func timeSeconds(_ lang: String?, _ at: Int64, timeZone: TimeZone? = nil) -> String { dateText(lang, at, timeZone, .none, .medium) }

    /// Day and time (medium day, minutes).
    public static func dateTime(_ lang: String?, _ at: Int64, timeZone: TimeZone? = nil) -> String { dateText(lang, at, timeZone, .medium, .short) }

    /// Day and time in full (a message's details).
    public static func full(_ lang: String?, _ at: Int64, timeZone: TimeZone? = nil) -> String { dateText(lang, at, timeZone, .long, .medium) }
}
