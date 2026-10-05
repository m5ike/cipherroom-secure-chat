// Numbers, dates and times as the app's language writes them (6.13; android
// core/Formats.java) — with the language's BCP 47 tag (Locales.tag: cs-CZ,
// sk-SK, fi-FI …), not the device's region, so a text and the date in it speak
// one language. Foundation's formatters with the platform's CLDR data.

import Foundation

public enum Formats {
    private static func loc(_ lang: String?) -> Locale { Locales.locale(lang) }

    private static func dateFormatter(_ lang: String?, date: DateFormatter.Style, time: DateFormatter.Style, tz: TimeZone?) -> DateFormatter {
        let f = DateFormatter()
        f.locale = loc(lang)
        f.dateStyle = date
        f.timeStyle = time
        if let tz { f.timeZone = tz }
        return f
    }

    private static func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: TimeInterval(ms) / 1000) }

    /// A whole number: 7, 1 234 (cs), 1.234 (de), 1,234 (en).
    public static func count(_ lang: String?, _ n: Int64) -> String {
        if n > -1000 && n < 1000 { return String(n) }
        let f = NumberFormatter()
        f.locale = loc(lang)
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// A number with exactly `digits` decimals: 1,5 (cs), 1.5 (en).
    public static func decimal(_ lang: String?, _ v: Double, _ digits: Int) -> String {
        let f = NumberFormatter()
        f.locale = loc(lang)
        f.numberStyle = .decimal
        f.minimumFractionDigits = max(0, digits)
        f.maximumFractionDigits = max(0, digits)
        return f.string(from: NSNumber(value: v)) ?? String(v)
    }

    /// A day: 5. 10. 2026 (cs), 05.10.2026 (de), 5 Oct 2026 (en-GB).
    public static func date(_ lang: String?, _ at: Int64, tz: TimeZone? = nil) -> String {
        dateFormatter(lang, date: .medium, time: .none, tz: tz).string(from: date(at))
    }

    /// A time of day, hours and minutes.
    public static func time(_ lang: String?, _ at: Int64, tz: TimeZone? = nil) -> String {
        dateFormatter(lang, date: .none, time: .short, tz: tz).string(from: date(at))
    }

    /// A time of day with seconds.
    public static func timeSeconds(_ lang: String?, _ at: Int64, tz: TimeZone? = nil) -> String {
        dateFormatter(lang, date: .none, time: .medium, tz: tz).string(from: date(at))
    }

    /// Day and time (medium day, minutes).
    public static func dateTime(_ lang: String?, _ at: Int64, tz: TimeZone? = nil) -> String {
        dateFormatter(lang, date: .medium, time: .short, tz: tz).string(from: date(at))
    }

    /// Day and time in full (a message's details): the long day, the time with seconds.
    public static func full(_ lang: String?, _ at: Int64, tz: TimeZone? = nil) -> String {
        dateFormatter(lang, date: .long, time: .medium, tz: tz).string(from: date(at))
    }

    /// Short day and the time with seconds.
    public static func shortFull(_ lang: String?, _ at: Int64, tz: TimeZone? = nil) -> String {
        dateFormatter(lang, date: .short, time: .medium, tz: tz).string(from: date(at))
    }
}
