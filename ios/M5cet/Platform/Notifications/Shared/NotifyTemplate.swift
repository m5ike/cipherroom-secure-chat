// Notification templates (Android push/NotifyTemplate, 6.7) — the same rules as
// the server and the web (client/src/lib/notify-template.ts): {name},
// {name|fallback}, [optional part], backslash escapes; values cleaned of control
// and bidi characters and bounded; a privacy level decides which variables show
// at all.
//
// The server's notification comes with the template in the user's language and
// the variables it may show; the app (and the notification extension) renders it
// again with what only it knows. Strings are handled in UTF-16 code units, as
// Java and JavaScript do, so lengths and cuts match the shared vectors
// (test/fixtures/notify-templates.json).
//
// Shared: compiled into the app and, through a symlink, into M5cetNotifications.

import Foundation

enum NotifyTemplate {
    static let privacyLevels = ["neutral", "sender", "room", "content"]
    static let vars = ["app", "sender", "room", "count", "time", "preview", "channel"]
    static let channels = ["android", "webpush", "email"]
    static let kinds = ["message", "mention", "call", "function", "summon", "test"]
    static let titleMax = 100, bodyMax = 240, templateMax = 300

    private static let limits: [String: Int] = ["app": 40, "sender": 64, "room": 64, "count": 6, "time": 16, "preview": 200, "channel": 16]

    static func rank(_ privacy: String) -> Int { privacyLevels.firstIndex(of: privacy) ?? 0 }

    /// The lower of two levels; an unknown level counts as neutral.
    static func min(_ a: String, _ b: String) -> String {
        let x = privacyLevels.contains(a) ? a : "neutral", y = privacyLevels.contains(b) ? b : "neutral"
        return rank(x) <= rank(y) ? x : y
    }

    /// What a level shows.
    static func visible(_ name: String, _ privacy: String) -> Bool {
        switch name {
        case "sender": rank(privacy) >= 1
        case "room": rank(privacy) >= 2
        case "preview": rank(privacy) >= 3
        default: vars.contains(name)
        }
    }

    // MARK: cleaning

    private static func unsafe(_ c: UInt16) -> Bool { c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == 0x2028 || c == 0x2029 }

    private static func bidi(_ c: UInt16) -> Bool {
        (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c == 0xfeff
    }

    /// Java's Character.isWhitespace || Character.isSpaceChar (JavaScript's \s): Unicode space,
    /// line and paragraph separators (no-break ones too), tab, line feeds, file/group/record/unit separators.
    static func space(_ c: UInt16) -> Bool {
        switch c {
        case 0x09...0x0d, 0x1c...0x20, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000: true
        default: false
        }
    }

    /// One line, no control or bidi characters, at most `max` UTF-16 units (an ellipsis when cut).
    static func clean(_ value: String?, _ max: Int) -> String {
        guard let value else { return "" }
        var b: [UInt16] = []
        b.reserveCapacity(value.utf16.count)
        var pendingSpace = false
        for c in value.utf16 {
            if bidi(c) { continue }
            if unsafe(c) || space(c) { pendingSpace = !b.isEmpty; continue }
            if pendingSpace { b.append(0x20); pendingSpace = false }
            b.append(c)
        }
        if b.count <= max { return string(b) }
        var end = Swift.max(0, max - 1)
        // A cut never leaves half of a surrogate pair (JavaScript would keep a lone one).
        if end > 0, UTF16.isLeadSurrogate(b[end - 1]) { end -= 1 }
        while end > 0, space(b[end - 1]) { end -= 1 }
        return string(Array(b[0..<end])) + "…"
    }

    private static func string(_ units: [UInt16]) -> String { String(decoding: units, as: UTF16.self) }

    /// The variables a level shows, cleaned; the rest are empty. A count of one is left out.
    static func visibleVars(_ given: [String: String], _ privacy: String) -> [String: String] {
        var out: [String: String] = [:]
        for k in vars { out[k] = visible(k, privacy) ? clean(given[k], limits[k] ?? 64) : "" }
        if let count = out["count"], !count.isEmpty {
            let n = Double(count.trimmingCharacters(in: .whitespaces)) ?? 0
            if !(n > 1) { out["count"] = "" }
        }
        return out
    }

    // MARK: rendering

    /// Renders one template with visible, cleaned variables (see visibleVars).
    static func render(_ template: String?, _ values: [String: String], _ max: Int) -> String {
        let all = Array((template ?? "").utf16)
        let src = all.count > templateMax ? Array(all[0..<templateMax]) : all
        var out: [UInt16] = []
        var part: [UInt16]?
        var partOk = true
        func append(_ c: UInt16) { if part != nil { part!.append(c) } else { out.append(c) } }
        func append(_ cs: [UInt16]) { if part != nil { part!.append(contentsOf: cs) } else { out.append(contentsOf: cs) } }
        let backslash: UInt16 = 0x5c, open: UInt16 = 0x5b, close: UInt16 = 0x5d, lbrace: UInt16 = 0x7b, rbrace: UInt16 = 0x7d, bar: UInt16 = 0x7c
        var i = 0
        while i < src.count {
            let c = src[i]
            if c == backslash, i + 1 < src.count { append(src[i + 1]); i += 2; continue }
            if c == open {
                if part == nil { part = []; partOk = true } else { part!.append(open) }
                i += 1
                continue
            }
            if c == close {
                if let p = part { if partOk { out.append(contentsOf: p) }; part = nil } else { out.append(close) }
                i += 1
                continue
            }
            if c == lbrace {
                var j = i + 1
                var inner: [UInt16] = []
                while j < src.count, src[j] != rbrace {
                    if src[j] == backslash, j + 1 < src.count { inner.append(backslash); inner.append(src[j + 1]); j += 2; continue }
                    inner.append(src[j])
                    j += 1
                }
                if j >= src.count { append(Array(src[i...])); break }
                var barAt = -1
                var k = 0
                while k < inner.count {
                    if inner[k] == backslash { k += 2; continue }
                    if inner[k] == bar { barAt = k; break }
                    k += 1
                }
                let name = javaTrim(string(barAt < 0 ? inner : Array(inner[0..<barAt])))
                let fallback: [UInt16]? = barAt < 0 ? nil : unescape(Array(inner[(barAt + 1)...]))
                let value = vars.contains(name) ? (values[name] ?? "") : ""
                if !value.isEmpty { append(Array(value.utf16)) }
                else if let fallback { append(fallback) }
                else if part != nil { partOk = false }
                i = j + 1
                continue
            }
            append(c)
            i += 1
        }
        if let p = part, partOk { out.append(contentsOf: p) }
        return clean(string(out), max)
    }

    /// Java's replaceAll("\\\\(.)", "$1"): a backslash and the next character (not a line terminator) → that character.
    private static func unescape(_ s: [UInt16]) -> [UInt16] {
        var out: [UInt16] = []
        var i = 0
        while i < s.count {
            if s[i] == 0x5c, i + 1 < s.count, ![0x0a, 0x0d, 0x85, 0x2028, 0x2029].contains(s[i + 1]) {
                out.append(s[i + 1])
                i += 2
                continue
            }
            out.append(s[i])
            i += 1
        }
        return out
    }

    /// Java's String.trim: code units ≤ U+0020 off both ends.
    private static func javaTrim(_ s: String) -> String {
        var u = Array(s.utf16)
        while let f = u.first, f <= 0x20 { u.removeFirst() }
        while let l = u.last, l <= 0x20 { u.removeLast() }
        return string(u)
    }

    /// Title and body; an empty title falls back to the app's name.
    static func notification(_ titleTemplate: String?, _ bodyTemplate: String?, _ given: [String: String], _ privacy: String) -> (title: String, body: String) {
        let v = visibleVars(given, privacy)
        var title = render(titleTemplate, v, titleMax)
        if title.isEmpty { title = (v["app"] ?? "").isEmpty ? "M5cet" : v["app"]! }
        return (title, render(bodyTemplate, v, bodyMax))
    }

    // MARK: quiet hours

    static func minutes(_ hhmm: String?) -> Int {
        guard let hhmm, hhmm.range(of: "^([01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil else { return -1 }
        let p = hhmm.split(separator: ":")
        return Int(p[0])! * 60 + Int(p[1])!
    }

    /// Inside from–to (across midnight when from > to), in the phone's own time zone (or `tz`; an unknown one is GMT, as Java).
    static func inQuietHours(_ on: Bool, _ from: String?, _ to: String?, _ tz: String?, _ at: Int64) -> Bool {
        let f = minutes(from), t = minutes(to)
        if !on || f < 0 || t < 0 || f == t { return false }
        let zone: TimeZone = (tz ?? "").isEmpty ? .current : TimeZone(identifier: tz!) ?? TimeZone(secondsFromGMT: 0)!
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let parts = cal.dateComponents([.hour, .minute], from: Date(timeIntervalSince1970: Double(at) / 1000))
        let now = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        return f < t ? now >= f && now < t : now >= f || now < t
    }

    // MARK: channels

    /// "android,webpush" → the known channels, once each, in that order.
    static func order(_ csv: String?) -> [String] {
        var out: [String] = []
        for c in (csv ?? "").split(separator: ",", omittingEmptySubsequences: false) {
            let t = javaTrim(String(c))
            if channels.contains(t), !out.contains(t) { out.append(t) }
        }
        return out
    }

    /// One channel a place up (by -1) or down (+1); the rest keep their order.
    static func move(_ csv: String?, _ channel: String, _ by: Int) -> String {
        var list = order(csv)
        guard let i = list.firstIndex(of: channel) else { return list.joined(separator: ",") }
        let j = i + by
        if j < 0 || j >= list.count { return list.joined(separator: ",") }
        list[i] = list[j]
        list[j] = channel
        return list.joined(separator: ",")
    }

    /// A channel used (added at the end) or not.
    static func use(_ csv: String?, _ channel: String, _ on: Bool) -> String {
        var list = order(csv)
        list.removeAll { $0 == channel }
        if on, channels.contains(channel) { list.append(channel) }
        return list.joined(separator: ",")
    }
}
