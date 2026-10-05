// 6.10 (security analysis G-20, G-21 — the class of F-01): what an action of
// the server's design may do with an argument it computed. A port of
// android/…/ui/ActionGuard.java, DesignUrls.java and DesignShare.java.
//
//   lib.run, url.open,     the argument is the design's own literal (a
//   fn.run, profile.public  library's name, a fixed address, a command);
//                          profile.public also takes exactly the username of
//                          the person the app itself shows (their detail)
//   setting.set, look.set  "key=value": the key is literal (the value may be
//                          computed — "voice.rate={$value}" — and must fit
//                          the key's rule, SettingSchema)
//   setting.toggle         the key is literal
//   setting.* on a         never from the design (G-21) — only the user's own
//   privacy key            tap on that setting's switch or choice

import Foundation

public enum ActionGuard {
    /// The argument must be the design's literal.
    public static let literal: Set<String> = ["lib.run", "url.open", "fn.run", "profile.public"]
    /// "key=value" with a literal key.
    public static let keyValue: Set<String> = ["setting.set", "look.set"]

    /// Why an action was refused (fixed words: they go to the log, never the value).
    public enum Refusal: String, Sendable, Equatable, CustomStringConvertible {
        case computed = "a computed argument"
        case computedKey = "a computed setting key"
        case privacy = "a privacy setting"
        case unknown = "an unknown setting"
        case outside = "a value outside the setting's rule"
        public var description: String { rawValue }
    }

    /// Whether the argument was computed: the raw text reads data, or there is a value
    /// without a raw text the design wrote (it came from elsewhere).
    public static func computed(_ raw: String?, _ value: DesignValue?) -> Bool {
        guard let raw else { return value != nil && value != .null }
        return Expr.readsData(raw)
    }

    /// The literal key of a raw "key=value" ("voice.rate={$value}" → voice.rate), or nil when the key is computed.
    public static func literalKey(_ raw: String?) -> String? {
        guard let raw, !raw.hasPrefix("=") else { return nil }
        let u = Array(raw.utf16)
        let eq = JavaSemantics.indexOf(u, 0x3D), brace = JavaSemantics.indexOf(u, 0x7B)
        if eq <= 0 || (brace >= 0 && brace < eq) { return nil }
        let key = JavaSemantics.trim(JavaSemantics.string(u[0..<eq]))
        return key.isEmpty ? nil : key
    }

    /// nil: the action may run; otherwise why not.
    ///   action  the action's name (the design's literal)
    ///   raw     its argument as the design wrote it (nil: none, or not from the design)
    ///   value   the argument now (raw evaluated in the element's scope)
    ///   own     what the app itself shows for this action — profile.public: the username of the
    ///           person whose detail is open — or nil
    public static func check(_ action: String?, raw: String?, value: DesignValue?, own: String?) -> Refusal? {
        guard let action else { return nil }
        let text = value.map { Expr.toText($0) } ?? ""
        if literal.contains(action) {
            if !computed(raw, value) { return nil }
            if action == "profile.public", let own, !own.isEmpty, own == text { return nil }
            return .computed
        }
        if keyValue.contains(action) {
            let u = Array(text.utf16)
            let eq = JavaSemantics.indexOf(u, 0x3D)
            if eq <= 0 { return nil } // nothing to set (the action ignores it)
            let key = JavaSemantics.trim(JavaSemantics.string(u[0..<eq]))
            if computed(raw, value) && key != literalKey(raw) { return .computedKey }
            return setting(key, .string(JavaSemantics.trim(JavaSemantics.string(u[(eq + 1)...]))))
        }
        if action == "setting.toggle" {
            if computed(raw, value) { return .computedKey }
            let key = JavaSemantics.trim(text)
            guard case .bool? = SettingsModel.defaults[key] else { return .unknown }
            return SettingSchema.privacy(key) ? .privacy : nil
        }
        return nil
    }

    /// A design's write of one setting: a known key, not a privacy one, a value within its rule.
    static func setting(_ key: String, _ value: DesignValue) -> Refusal? {
        guard let dflt = SettingsModel.defaults[key] else { return .unknown }
        if SettingSchema.privacy(key) { return .privacy }
        guard let v = SettingsModel.coerce(dflt, value), SettingSchema.valid(key, v) else { return .outside }
        return nil
    }
}

/// 6.7 (security analysis F-01): what of the design may reach the network.
public enum DesignUrls {
    /// url.open: longer than this cannot be read in a dialog — refused, not cut.
    public static let urlMax = 300

    /// The value is computed from data at bind time: an expression or a template.
    static func dynamic(_ raw: String?) -> Bool {
        guard let raw else { return true }
        return raw.hasPrefix("=") || raw.contains("{")
    }

    /// A source on the phone (the design's assets, inline image data) — no request leaves it.
    static func local(_ src: String) -> Bool { src.hasPrefix("asset:") || src.hasPrefix("data:image/") }

    /// What the image element may load for this raw prop and its bound value ("" = nothing):
    /// a computed value only a local source; a remote https image only as the design's fixed literal.
    public static func image(raw: String?, bound: String?) -> String {
        let src = JavaSemantics.trim(bound ?? "")
        if src.isEmpty { return "" }
        if local(src) { return src }
        if !src.hasPrefix("https://") { return "" }
        guard let raw, !dynamic(raw), JavaSemantics.trim(raw) == src else { return "" }
        return src
    }

    /// Spaces of any kind, control characters, invisible formatting (`[\s\p{Z}\p{Cc}\p{Cf}]`).
    static func hidden(_ c: Unicode.Scalar) -> Bool {
        switch c.value {
        case 0x20, 0x09, 0x0A, 0x0B, 0x0C, 0x0D: return true
        default: break
        }
        switch c.properties.generalCategory {
        case .spaceSeparator, .lineSeparator, .paragraphSeparator, .control, .format: return true
        default: return false
        }
    }

    /// 6.10 (G-20): whether url.open may offer this address — https, at most 300 characters, all of it visible.
    public static func openable(_ url: String?) -> Bool {
        guard let url, url.hasPrefix("https://") else { return false }
        let n = url.utf16.count
        return n > "https://".count && n <= urlMax && !url.unicodeScalars.contains(where: hidden)
    }

    /// The address's host (the confirmation's title), or nil.
    public static func host(_ url: String) -> String? { URLComponents(string: url)?.host ?? URL(string: url)?.host }
}

/// 6.12 (security analysis G-20): the design's copy / share with a text it computed are
/// shown to the person first, hidden characters made visible, never cut.
public enum DesignShare {
    /// Longer than this (code points) cannot be read in a dialog — refused, not cut.
    public static let max = 2000

    /// The text as the dialog shows it: every invisible formatting or control character
    /// (bidi overrides, zero-width…, but not a line break or a tab) as [U+XXXX].
    public static func shown(_ text: String?) -> String {
        guard let text else { return "" }
        var out = ""
        for c in text.unicodeScalars {
            let cat = c.properties.generalCategory
            let hidden = (cat == .format || cat == .control || cat == .unassigned || cat == .privateUse || cat == .surrogate) && c != "\n" && c != "\t"
            if hidden { out += String(format: "[U+%04X]", c.value) } else { out.unicodeScalars.append(c) }
        }
        return out
    }

    /// Whether a computed text may be offered: at most `max` code points.
    public static func fits(_ text: String?) -> Bool {
        guard let text else { return false }
        return text.unicodeScalars.count <= max
    }
}
