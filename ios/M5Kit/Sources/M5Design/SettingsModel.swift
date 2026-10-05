// The user's settings (6.1) as the design reads and changes them — a port of
// android/…/core/Settings.java without its storage: one JSON object nested by
// area ("voice.rate" → {"voice": {"rate": …}}), every known key with a typed
// default; screens read it as $settings and change it with setting.set /
// setting.toggle (ActionGuard first) or an element bound to a key.
//
// The app keeps `data` (the JSON) wherever it keeps settings (Keychain / the
// vault's system tier) and saves it after every successful `set`.

import Foundation

public struct SettingsModel: Sendable, Hashable {
    /// key → default (a Bool, a number or a text), in Android's order.
    public static let defaultList: [(String, DesignValue)] = {
        var d: [(String, DesignValue)] = [
            // Messages
            ("messages.vanishSeconds", 60), ("messages.ttlMinutes", 0), ("messages.receipts", true), ("messages.readReceipts", true), ("messages.enterSends", false),
            // Location
            ("location.inHeader", false), ("location.track", false), ("location.interval", 60), ("location.precise", true),
            // Voice
            ("voice.engine", "device"), ("voice.lang", ""), ("voice.voice", ""), ("voice.rate", 1.0), ("voice.pitch", 1.0),
            ("voice.autoplay", false), ("voice.dictateSpeak", false), ("voice.dictateSend", false),
            // Calls
            ("calls.audioText", false), ("calls.speaker", true), ("callLog", false), ("calls.logName", "app"), ("calls.history", true),
            // Appearance
            ("appearance.tone", "system"), ("appearance.accent", ""), ("appearance.fontScale", 1.0), ("appearance.density", "normal"),
            ("appearance.bubbles", "rounded"), ("appearance.preset", "design"),
            // 6.2 look
            ("look.variant", ""), ("look.font", ""), ("look.motion", "normal"), ("look.speed", 1.0), ("look.buttons", "filled"),
            ("look.shape", "pill"), ("look.press", "ripple"), ("look.haptics", true), ("look.toolsDock", true), ("look.hintSendOptions", false), ("look.v", 0),
            // NFC
            ("nfc.emulate", false), ("nfc.reader", "internal"), ("nfc.keyDictionary", ""), ("nfc.saveKeys", false),
        ]
        // 6.7 notify (push/NotifyPrefs.defaults)
        d.append(("notify.on", true))
        d.append(("notify.away", true))
        for k in ["message", "mention", "call", "function", "summon"] { d.append(("notify." + k, true)) }
        d += [("notify.privacy", ""), ("notify.order", "android,webpush,email"), ("notify.quiet", false), ("notify.quietFrom", "22:00"),
              ("notify.quietTo", "07:00"), ("notify.lockScreenHide", false)]
        // Security
        d += [("security.shufflePin", false), ("security.duress", false), ("security.lockDisconnect", false)]
        // People
        d.append(("people.contacts", true))
        // 6.7 voice changer (voice/MicFx.defaults)
        d += [("voiceFx.on", false), ("voiceFx.preset", "deep"), ("voiceFx.pitch", -5.0), ("voiceFx.formant", -3.0), ("voiceFx.robot", 0),
              ("voiceFx.echo", 0), ("voiceFx.echoMs", 250), ("voiceFx.echoFeedback", 0.35), ("voiceFx.whisper", 0), ("voiceFx.gain", 0)]
        // 6.8 conversations (telecom/ConversationPlan.defaults)
        d += [("conversations.on", true), ("conversations.names", true)]
        return d
    }()

    public static let defaults: [String: DesignValue] = Dictionary(uniqueKeysWithValues: defaultList)

    /// The stored settings (nested by area; a flat "a.b" key is read too).
    public private(set) var data: [String: DesignValue]

    public init(data: [String: DesignValue] = [:]) { self.data = data }

    // MARK: reading

    /// The value of a key: the stored one when it has the default's type and fits its rule, else the default.
    public func get(_ key: String) -> DesignValue {
        let v = Self.find(data, key)
        guard let dflt = Self.defaults[key] else { return v ?? .null }
        guard let v, !v.isNull else { return dflt }
        switch dflt {
        case .bool: if case .bool = v { return v } else { return dflt }
        case .number:
            if case .number(let d) = v, SettingSchema.valid(key, .number(d)) { return v }
            return dflt
        default:
            if case .string = v, SettingSchema.valid(key, v) { return v }
            return dflt
        }
    }

    public func bool(_ key: String) -> Bool { get(key) == .bool(true) }
    public func num(_ key: String) -> Double { get(key).numberValue ?? 0 }
    public func str(_ key: String) -> String {
        let v = get(key)
        if case .null = v { return "" }
        return v.optString("") ?? ""
    }

    /// The settings as a screen sees them ($settings): every default filled in, nested by area.
    public func scope() -> DesignValue {
        var out: [String: DesignValue] = [:]
        for (k, _) in Self.defaultList { Self.put(&out, k, get(k)) }
        return .object(out)
    }

    // MARK: changing

    /// Sets a value; a text is converted to the key's type ("true", "1.2"). Unknown keys are refused,
    /// and so is a value outside the key's rule. Returns whether it was set.
    @discardableResult
    public mutating func set(_ key: String, _ value: DesignValue?) -> Bool {
        guard let dflt = Self.defaults[key] else { return false }
        guard let v = Self.coerce(dflt, value), SettingSchema.valid(key, v) else { return false }
        Self.put(&data, key, v)
        return true
    }

    /// Flips a yes/no setting.
    @discardableResult
    public mutating func toggle(_ key: String) -> Bool {
        guard case .bool = Self.defaults[key] else { return false }
        return set(key, .bool(!bool(key)))
    }

    /// A value as the key's type (the default's): "true" → true, "1.2" → 1.2; nil when it is not one.
    public static func coerce(_ dflt: DesignValue?, _ value: DesignValue?) -> DesignValue? {
        switch dflt {
        case .bool?:
            if case .bool? = value { return value }
            let s = JavaSemantics.trim(javaString(value))
            if s == "true" || s == "1" || s == "on" { return .bool(true) }
            if s == "false" || s == "0" || s == "off" || s.isEmpty { return .bool(false) }
            return nil
        case .number?:
            if case .number(let d)? = value { return .number(d) }
            guard let d = JavaSemantics.parseDouble(JavaSemantics.trim(javaString(value))), d.isFinite else { return nil }
            return .number(d)
        default:
            let s = value.map { $0.isNull ? "" : javaString($0) } ?? ""
            let u = Array(s.utf16)
            return .string(u.count > 200 ? JavaSemantics.string(u[0..<200]) : s)
        }
    }

    /// String.valueOf(value) as Settings.coerce sees it ("null" for a null).
    static func javaString(_ v: DesignValue?) -> String {
        switch v ?? .null {
        case .null: return "null"
        case .string(let s): return s
        case .bool(let b): return b ? "true" : "false"
        case .number(let d):
            // Java prints a Double with ".0" (Double.toString); a whole number reads "1.0".
            if d.isFinite && d == d.rounded() && abs(d) < 1e7 { return String(format: "%.1f", d) }
            return "\(d)"
        default: return v?.jsonText() ?? ""
        }
    }

    // MARK: nested keys

    static func find(_ o: [String: DesignValue], _ key: String) -> DesignValue? {
        if let v = o[key] { return v }
        var cur: DesignValue = .object(o)
        for p in key.split(separator: ".", omittingEmptySubsequences: false) {
            guard case .object(let obj) = cur else { return nil }
            guard let next = obj[String(p)] else { return nil }
            cur = next
        }
        return cur
    }

    static func put(_ o: inout [String: DesignValue], _ key: String, _ v: DesignValue) {
        let path = key.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        func put(_ obj: inout [String: DesignValue], _ i: Int) {
            if i == path.count - 1 { obj[path[i]] = v; return }
            var next = obj[path[i]]?.objectValue ?? [:]
            put(&next, i + 1)
            obj[path[i]] = .object(next)
        }
        put(&o, 0)
    }
}
