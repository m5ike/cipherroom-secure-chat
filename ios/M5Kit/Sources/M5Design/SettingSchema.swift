// 6.10 (security analysis G-20, G-21): what a setting may hold and who may
// change it — a port of android/…/core/SettingSchema.java.
//
// Values: every key has a rule beside its type (SettingsModel.defaults) — a
// range for a number, a list or a pattern for a text — and SettingsModel.set
// refuses anything else, whoever asks.
//
// Privacy keys: settings that widen what leaves the phone or who sees it. An
// action of the design (setting.set / setting.toggle, a library step, a change
// handler) never changes them; only the user's own tap on the setting's switch
// or choice (an element bound to it) or the app's code does.

import Foundation

public enum SettingSchema {
    /// Keys no action of the design may change (exact).
    static let privateKeys: Set<String> = [
        "callLog", "voice.engine", "voice.autoplay", "voice.dictateSend", "nfc.emulate", "nfc.keyDictionary",
        "messages.receipts", "messages.readReceipts", "people.contacts",
    ]
    /// …and every key under these.
    static let privateAreas = ["calls.", "conversations.", "notify.", "location.", "security."]

    enum TextRule: Sendable {
        case oneOf(Set<String>)
        case pattern(@Sendable (String) -> Bool)
        func matches(_ s: String) -> Bool {
            switch self {
            case .oneOf(let set): return set.contains(s)
            case .pattern(let f): return f(s)
            }
        }
    }

    static let ranges: [String: ClosedRange<Double>] = [
        "messages.vanishSeconds": 1...86_400,
        "messages.ttlMinutes": 0...10_080,
        "location.interval": 5...86_400,
        "voice.rate": 0.1...4,
        "voice.pitch": 0.1...4,
        "appearance.fontScale": 0.5...3,
        "look.speed": 0.1...4,
        "look.v": 0...1000,
        "voiceFx.pitch": -24...24,
        "voiceFx.formant": -24...24,
        "voiceFx.robot": 0...2_000,
        "voiceFx.echo": 0...1,
        "voiceFx.echoMs": 0...5_000,
        "voiceFx.echoFeedback": 0...1,
        "voiceFx.whisper": 0...1,
        "voiceFx.gain": -48...48,
    ]

    // MARK: patterns (written out — Java's regexes, ASCII classes)

    private static func lowerDigit(_ c: Character) -> Bool { c.isASCII && (c.isLowercase || c.isNumber) }

    /// `[a-z0-9][a-z0-9_-]{0,40}`
    static func isId(_ s: String) -> Bool {
        guard let f = s.first, lowerDigit(f), s.count <= 41 else { return false }
        return s.dropFirst().allSatisfy { lowerDigit($0) || $0 == "_" || $0 == "-" }
    }

    /// `^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`
    static func isHour(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard u.count == 5, u[2] == 0x3A else { return false }
        func d(_ x: UInt8) -> Int? { x >= 0x30 && x <= 0x39 ? Int(x - 0x30) : nil }
        guard let h1 = d(u[0]), let h2 = d(u[1]), let m1 = d(u[3]), d(u[4]) != nil else { return false }
        return (h1 <= 1 || (h1 == 2 && h2 <= 3)) && m1 <= 5
    }

    /// `^(?:[a-z]{2,3}(?:-[A-Z]{2})?)?$`
    static func isVoiceLang(_ s: String) -> Bool {
        if s.isEmpty { return true }
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count <= 2, (2...3).contains(parts[0].count), parts[0].allSatisfy({ $0.isASCII && $0.isLowercase }) else { return false }
        if parts.count == 2 { return parts[1].count == 2 && parts[1].allSatisfy { $0.isASCII && $0.isUppercase } }
        return true
    }

    /// `^[A-Za-z0-9 _.#:@+-]{0,100}$` — a TextToSpeech voice's name.
    static func isVoiceName(_ s: String) -> Bool {
        s.unicodeScalars.count <= 100 && s.unicodeScalars.allSatisfy { c in
            c.isASCII && (CharacterSet.alphanumerics.contains(c) || " _.#:@+-".unicodeScalars.contains(c))
        }
    }

    /// `^(?:|[a-z]{2,16}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$`
    static func isAccent(_ s: String) -> Bool {
        if s.isEmpty { return true }
        if s.hasPrefix("#") {
            let h = s.dropFirst()
            return (h.count == 6 || h.count == 8) && h.allSatisfy { $0.isASCII && $0.isHexDigit }
        }
        return (2...16).contains(s.count) && s.allSatisfy { $0.isASCII && $0.isLowercase }
    }

    /// `^(?:CH(?:,CH){0,2})?$` with CH = android|webpush|email.
    static func isNotifyOrder(_ s: String) -> Bool {
        if s.isEmpty { return true }
        let parts = s.split(separator: ",", omittingEmptySubsequences: false)
        return parts.count <= 3 && parts.allSatisfy { ["android", "webpush", "email"].contains(String($0)) }
    }

    /// `^[\p{L}\p{N}\p{P}\p{S}\p{Zs}\t\r\n]{0,200}$` — the NFC workbench's key list (visible text only).
    static func isKeyDictionary(_ s: String) -> Bool {
        var count = 0
        for c in s.unicodeScalars {
            count += 1
            if count > 200 { return false }
            if c == "\t" || c == "\r" || c == "\n" { continue }
            switch c.properties.generalCategory {
            case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
                 .decimalNumber, .letterNumber, .otherNumber,
                 .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation, .initialPunctuation, .finalPunctuation, .otherPunctuation,
                 .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol, .spaceSeparator:
                continue
            default:
                return false
            }
        }
        return true
    }

    static let texts: [String: TextRule] = [
        "voice.engine": .oneOf(["device", "server"]),
        "voice.lang": .pattern(isVoiceLang),
        "voice.voice": .pattern(isVoiceName),
        "calls.logName": .oneOf(["app", "room", "people"]),
        "appearance.tone": .oneOf(["system", "light", "dark"]),
        "appearance.accent": .pattern(isAccent),
        "appearance.density": .oneOf(["compact", "normal", "comfortable"]),
        "appearance.bubbles": .oneOf(["rounded", "square", "minimal"]),
        "appearance.preset": .pattern(isId),
        "look.variant": .pattern({ $0.isEmpty || isId($0) }),
        "look.font": .oneOf(["", "sans", "serif", "mono", "condensed", "medium", "light", "casual", "cursive"]),
        "look.motion": .oneOf(["off", "subtle", "normal", "lively"]),
        "look.buttons": .oneOf(["filled", "tonal", "outlined", "text"]),
        "look.shape": .oneOf(["pill", "rounded", "square"]),
        "look.press": .oneOf(["ripple", "scale", "none"]),
        "nfc.reader": .oneOf(["internal", "usb", "bluetooth"]),
        "nfc.keyDictionary": .pattern(isKeyDictionary),
        "notify.privacy": .oneOf(["", "neutral", "sender", "room", "content"]),
        "notify.order": .pattern(isNotifyOrder),
        "notify.quietFrom": .pattern(isHour),
        "notify.quietTo": .pattern(isHour),
        "voiceFx.preset": .oneOf(["off", "higher", "lower", "deep", "robot", "echo", "whisper", "anonymous", "custom"]),
    ]

    /// The keys with a rule for a number or a text (a yes/no setting needs none).
    public static var ruled: Set<String> { Set(ranges.keys).union(texts.keys) }

    /// Whether a design's action is kept from this setting (only the user's own switch or the app changes it).
    public static func privacy(_ key: String?) -> Bool {
        guard let key else { return true }
        if privateKeys.contains(key) { return true }
        return privateAreas.contains { key.hasPrefix($0) }
    }

    /// Whether the value (already of the key's type, SettingsModel.coerce) is one this key may
    /// hold: a yes/no any, a number within its range, a text that matches its list or pattern.
    /// A number or a text without a rule is refused (fail closed).
    public static func valid(_ key: String?, _ value: DesignValue?) -> Bool {
        guard let key, let value else { return false }
        switch value {
        case .bool: return true
        case .number(let d):
            guard let r = ranges[key] else { return false }
            return d.isFinite && r.contains(d)
        case .string(let s):
            guard let rule = texts[key] else { return false }
            return rule.matches(s)
        default: return false
        }
    }
}
