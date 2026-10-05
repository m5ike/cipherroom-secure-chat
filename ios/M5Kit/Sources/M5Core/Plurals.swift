// Which plural form a count takes (6.13; android core/Plurals.java) — the
// CLDR categories zero, one, two, few, many, other for whole numbers in the
// app's nine languages, checked against Intl.PluralRules' answers
// (locales-vectors.json "plurals"). A text with a number can have
// "key#one", "key#few", "key#many", "key#other", falling back to "key".

public enum Plurals {
    public static let categories = ["zero", "one", "two", "few", "many", "other"]

    /// The category of the whole number `n` in the language of `tag` ("cs-CZ", "sk", …): CLDR v46 rules (v = 0, e = 0).
    public static func category(_ tag: String?, _ n: Int64) -> String {
        var lang = (tag ?? "").lowercased()
        if let cut = lang.firstIndex(where: { $0 == "-" || $0 == "_" }) { lang = String(lang[..<cut]) }
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
        default: // en, de, fi and the rest
            return i == 1 ? "one" : "other"
        }
    }

    /// The keys a text with a count is looked up under, in order: "key#<category>", then "key".
    public static func keys(_ key: String, tag: String?, _ n: Int64) -> [String] {
        [key + "#" + category(tag, n), key]
    }
}
