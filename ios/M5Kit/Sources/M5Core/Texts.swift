// Texts from code that has no screen at hand (an error a reader or a sender
// throws) — android core/Texts.java. Every user-visible text goes through a
// design key; the app registers its design's lookup (`Texts.provider`), and
// without one (unit tests) the English given here is used.

import Synchronization

public enum Texts {
    /// Looks a design key up in the app's language (nil when the design has no such key).
    public typealias Lookup = @Sendable (_ key: String) -> String?
    /// Looks a counted key up (the plural form chosen by the provider), "{n}" not yet filled.
    public typealias CountLookup = @Sendable (_ key: String, _ n: Int64) -> String?

    private static let lookups = Mutex<(Lookup?, CountLookup?)>((nil, nil))

    /// The app's design texts (M5Design registers them once a design is loaded).
    public static func setProvider(_ text: Lookup?, counted: CountLookup? = nil) { lookups.withLock { $0 = (text, counted) } }

    /// The design's text of `key`, else the English `en`.
    public static func t(_ key: String, _ en: String) -> String {
        let s = lookups.withLock { $0.0 }?(key)
        return s == nil || s == key ? en : s!
    }

    /// With "{0}", "{1}" … filled from `args`.
    public static func f(_ key: String, _ en: String, _ args: CustomStringConvertible...) -> String {
        fill(t(key, en), args.map { $0.description })
    }

    public static func fill(_ template: String, _ args: [String]) -> String {
        var s = template
        for (i, a) in args.enumerated() { s = s.replacingOccurrences(of: "{\(i)}", with: a) }
        return s
    }

    /// A text with a count: its plural form in the app's language, "{n}" filled in.
    public static func n(_ key: String, _ n: Int64, _ en: String) -> String {
        let s = lookups.withLock { $0.1 }?(key, n)
        if let s, s != key { return s.replacingOccurrences(of: "{n}", with: String(n)) }
        return en.replacingOccurrences(of: "{n}", with: String(n))
    }
}
