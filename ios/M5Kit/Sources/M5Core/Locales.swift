// The languages M5cet speaks (6.13) — the Swift copy of the contract
// client/src/lib/locales.ts (android core/Locales.java): the same codes,
// native names, BCP 47 tags and fallbacks, checked against
// android/app/src/test/resources/cz/m5cet/app/core/locales-vectors.json.
// English is the source language and the last fallback; Slovak falls back to
// Czech, then English.

import Foundation

public enum Locales {
    public struct Info: Sendable, Equatable {
        public let code: String
        /// The language's own name, as the language picker shows it.
        public let nativeName: String
        /// English name (logs).
        public let english: String
        /// BCP 47 tag for dates, numbers, collation and plural rules.
        public let tag: String
        /// Where a missing text comes from, in order, before English.
        public let fallback: [String]

        public var locale: Locale { Locale(identifier: tag) }
    }

    /// In the contract's order (LOCALES).
    public static let codes = ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"]

    private static let table: [String: Info] = {
        let all = [
            Info(code: "en", nativeName: "English", english: "English", tag: "en-GB", fallback: []),
            Info(code: "cs", nativeName: "Čeština", english: "Czech", tag: "cs-CZ", fallback: []),
            Info(code: "de", nativeName: "Deutsch", english: "German", tag: "de-DE", fallback: []),
            Info(code: "es", nativeName: "Español", english: "Spanish", tag: "es-ES", fallback: []),
            Info(code: "it", nativeName: "Italiano", english: "Italian", tag: "it-IT", fallback: []),
            Info(code: "fr", nativeName: "Français", english: "French", tag: "fr-FR", fallback: []),
            Info(code: "sk", nativeName: "Slovenčina", english: "Slovak", tag: "sk-SK", fallback: ["cs"]),
            Info(code: "sl", nativeName: "Slovenščina", english: "Slovenian", tag: "sl-SI", fallback: []),
            Info(code: "fi", nativeName: "Suomi", english: "Finnish", tag: "fi-FI", fallback: []),
        ]
        return Dictionary(uniqueKeysWithValues: all.map { ($0.code, $0) })
    }()

    public static func isLocale(_ v: String?) -> Bool { v.map { table[$0] != nil } ?? false }

    /// The language's facts, or English's for anything else.
    public static func info(_ code: String?) -> Info { code.flatMap { table[$0] } ?? table["en"]! }

    public static func tag(_ code: String?) -> String { info(code).tag }

    public static func locale(_ code: String?) -> Locale { info(code).locale }

    /// The best supported language for a list of BCP 47 tags (preferred languages, Accept-Language), else `fallback`.
    public static func pick(_ preferred: [String]?, fallback: String = "en") -> String {
        for raw in preferred ?? [] {
            var code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if let semi = code.firstIndex(of: ";") { code = String(code[..<semi]) }
            code = code.lowercased()
            if let cut = code.firstIndex(where: { $0 == "-" || $0 == "_" }) { code = String(code[..<cut]) }
            if isLocale(code) { return code }
        }
        return fallback
    }

    /// The same for a comma-separated list ("sk-SK,cs;q=0.8,en").
    public static func pick(_ preferred: String?, fallback: String = "en") -> String {
        guard let p = preferred else { return fallback }
        return pick(p.components(separatedBy: ","), fallback: fallback)
    }

    /// The chain a text is looked up in: the language, its fallbacks, then English (English's for anything unknown).
    public static func chain(_ code: String?) -> [String] {
        let i = info(code)
        var out = [i.code] + i.fallback
        if !out.contains("en") { out.append("en") }
        return out
    }

    /// A text from a { "cs": …, "en": … } object along the language's chain; empty texts count as missing.
    public static func text(_ byLang: JSONObject?, _ code: String?, _ fallback: String) -> String {
        guard let o = byLang else { return fallback }
        for l in chain(code) {
            if let v = o.string(l), !v.isEmpty { return v }
        }
        return fallback
    }
}
