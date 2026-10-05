// 6.11: how a Functions model appears as the sender of its answers — a port
// of android fn/ModelIdentity.java (client/src/lib/system-messenger.ts, the
// contract the web, the apps and the server share). A model's answer is an
// INCOMING message from "system-messenger", the app's own internal sender
// (never a real member): the nickname is the model's name, the avatar its
// icon (a lucide name or one emoji) in a circle of its colour — the same
// colour everywhere (the same hash, the same HSL).
//
// Honesty: a model's answer for the whole room is still sent by the caller's
// own client (end-to-end encrypted, signed by them); peers show it under the
// model's identity WITH "via <caller>", and a member can never pass a message
// off as the system's (reservedSender).

import M5Core

/// A Functions model as a sender (android `fn/ModelIdentity.java`).
public struct ModelIdentity: Sendable, Equatable {
    /// The internal sender of model answers (never a real member).
    public static let systemMessengerId = "system-messenger"
    public static let systemMessengerName = "system-messenger"

    /// A run without any sign of life from the server (no event but the
    /// stream's pings) for this long fails; an open question pauses it.
    public static let fnRunTimeoutMs: Int64 = 30_000

    /// The keywords of defaultModelIcons in their order.
    public static let defaultModelIconKeys: [String] = defaultPairs.enumerated().compactMap { $0.offset % 2 == 0 ? $0.element : nil }

    /// Icons for models that do not name one, by keyword (DEFAULT_MODEL_ICONS).
    public static let defaultModelIcons: [String: String] = {
        var m = [String: String]()
        var i = 0
        while i + 1 < defaultPairs.count { m[defaultPairs[i]] = defaultPairs[i + 1]; i += 2 }
        return m
    }()

    private static let defaultPairs = [
        "mail", "mail", "email", "mail", "hlr", "phone", "lookup", "search", "number", "hash", "phone", "phone", "call", "phone-call", "sms", "message-square-text",
        "dns", "globe", "whois", "globe", "ip", "network", "ping", "activity", "http", "globe", "url", "link", "ssl", "shield-check", "cert", "shield-check",
        "weather", "cloud-sun", "time", "clock", "calc", "calculator", "translate", "languages", "ai", "sparkles", "ask", "sparkles", "summary", "file-text",
        "emv", "credit-card", "emv-history", "receipt", "eid", "id-card", "nfc", "nfc", "qr", "qr-code", "code", "code", "run", "play", "help", "circle-help",
        "phone_bridge", "phone-forwarded", "phone-bridge", "phone-forwarded", "remind", "bell", "poll", "chart-bar", "dice", "dice-5",
    ]

    static let fallbackIcon = "bot"

    public let keyword: String
    /// The nickname: the model's name ("/keyword" without one).
    public let name: String
    /// A lucide icon name, or one emoji.
    public let icon: String
    /// The avatar's colour (#rrggbb), stable per keyword.
    public let color: String

    /// modelColor(): a stable colour for a keyword — HSL(hash % 360, 55 %, 45 %), readable with white text.
    public static func modelColor(_ keyword: String?) -> String {
        var h: UInt64 = 0
        // JavaScript: h = (h * 31 + charCodeAt(i)) >>> 0 — the same in 32 unsigned bits.
        for c in (keyword ?? "").utf16 { h = (h &* 31 &+ UInt64(c)) & 0xFFFF_FFFF }
        let hue = Double(h % 360)
        let s = 0.55, l = 0.45
        let c = (1 - abs(2 * l - 1)) * s
        let x = c * (1 - abs((hue / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = l - c / 2
        let (r, g, b): (Double, Double, Double)
        if hue < 60 { (r, g, b) = (c, x, 0) }
        else if hue < 120 { (r, g, b) = (x, c, 0) }
        else if hue < 180 { (r, g, b) = (0, c, x) }
        else if hue < 240 { (r, g, b) = (0, x, c) }
        else if hue < 300 { (r, g, b) = (x, 0, c) }
        else { (r, g, b) = (c, 0, x) }
        return "#" + hex(r + m) + hex(g + m) + hex(b + m)
    }

    private static func hex(_ v: Double) -> String {
        let s = String(Js.round(v * 255), radix: 16)
        return s.count < 2 ? "0" + s : s
    }

    /// modelIdentity(): the model's own icon, else one by its keyword (or the keyword's first part), else a bot.
    public static func of(_ keyword: String?, _ name: String?, _ icon: String?) -> ModelIdentity {
        let k = keyword ?? ""
        let kw = Js.lowerRoot(k)
        let own = icon.map(Js.trim) ?? ""
        let first = kw.utf16.firstIndex { $0 == 0x2D || $0 == 0x5F }.map { Js.string(Array(kw.utf16[..<$0])) } ?? kw
        let ic = !own.isEmpty ? own : defaultModelIcons[kw] ?? defaultModelIcons[first] ?? fallbackIcon
        return ModelIdentity(keyword: k, name: (name ?? "").isEmpty ? "/" + k : name!, icon: ic, color: modelColor(kw))
    }

    public static func of(_ c: Command) -> ModelIdentity { of(c.keyword, c.name, c.icon) }

    /// [A-Za-z0-9_-]{1,40}.
    private static func isKeyword(_ s: String) -> Bool {
        let u = s.utf16
        return !u.isEmpty && u.count <= 40 && u.allSatisfy(Commands.wordUnit)
    }

    /// The identity a message's fn flags (or a stored "model") carry: keyword, name, icon; nil without a keyword.
    public static func fromJson(_ o: JSONObject?) -> ModelIdentity? {
        guard let o else { return nil }
        let kw = o.string("keyword") ?? ""
        if !isKeyword(kw) { return nil }
        return of(kw, o.string("name") ?? "", safeIcon(o["icon"]))
    }

    /// {keyword, name, icon} — what goes into the fn flags and the history (the colour follows from the keyword).
    public func toJson() -> JSONObject {
        JSONObject([("keyword", .string(keyword)), ("name", .string(name)), ("icon", .string(icon))])
    }

    /// [a-z0-9]+(?:-[a-z0-9]+)*.
    static func isLucide(_ s: String) -> Bool {
        let u = Array(s.utf16)
        guard let f = u.first, let l = u.last, f != 0x2D, l != 0x2D else { return false }
        var dash = false
        for c in u {
            if c == 0x2D { if dash { return false }; dash = true; continue }
            dash = false
            if !((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39)) { return false }
        }
        return true
    }

    /// The icon is a lucide name (else: an emoji, drawn as text).
    public var lucide: Bool { ModelIdentity.isLucide(icon) }

    /// The colour as ARGB (0xFFrrggbb).
    public var argb: UInt32 { 0xFF00_0000 | (UInt32(color.dropFirst(), radix: 16) ?? 0) }

    /// An icon as a peer may send it in the fn flags: a lucide name (≤ 40
    /// characters) or one short emoji (no letters, digits, spaces, controls or
    /// markup); nil otherwise — the keyword's icon is used then. `raw` is the
    /// JSON value as received (nil: absent).
    public static func safeIcon(_ raw: JSON?) -> String? {
        guard case .string(let r)? = raw else { return nil }
        let s = Js.trim(r)
        if s.isEmpty || s.utf16.count > 40 { return nil }
        if isLucide(s) { return s }
        if s.utf16.count > 16 || s.unicodeScalars.count > 8 { return nil }
        for u in s.unicodeScalars {
            if Js.isLetterOrDigit(u) || Js.isJavaWhitespace(u) || Js.isISOControl(u) || "<>\"'&`\\/".unicodeScalars.contains(u) { return nil }
            switch u.properties.generalCategory {
            case .unassigned, .privateUse, .surrogate: return nil
            default: break
            }
        }
        return s
    }

    /// An id only this app gives — system-messenger and the older "function:<keyword>"; never a peer's (validate.ts isReservedSender).
    public static func reservedSender(_ id: String) -> Bool {
        id == systemMessengerId || id.utf16.starts(with: (systemMessengerId + ":").utf16) || id.utf16.starts(with: "function:".utf16)
    }

    /// The same for an id that may be missing (nil: not reserved).
    public static func reservedSender(_ id: String?) -> Bool { id.map { reservedSender($0) } ?? false }
}
