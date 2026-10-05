// What a message to send is made of (android chat/Outgoing.java), and "send
// another way" (6.8, android chat/SendPlan.java): the composer's options —
// as voice, speak-it-send-text, sealed, vanishing, tap to reveal — kept in
// the composer's form until turned off and applied only when a message goes.

import Foundation
import M5Core
import M5Crypto

/// What a message to send is made of (6.1): text, reply, attachment, kind, recipients, expiry, position, command output.
public struct Outgoing: Sendable {
    public var text = ""
    public var replyTo: ChatMessage?
    /// An inline attachment (small files and pictures): a data URL with the safe type.
    public var fileName: String?, fileMime: String?, dataUrl: String?
    public var fileSize: Int64 = 0
    public var fileImage = false
    public var tap = false
    public var vanishSeconds = 0
    /// Seal with this code (nil = not sealed; "" = a new random code).
    public var sealCode: String?
    /// Private: only these peers (ids) get it; their names go into "to". Empty = everyone.
    public var recipients: [String] = []
    public var recipientNames: [String] = []
    /// Absolute expiry (the room's default), 0 = none.
    public var ttlMinutes = 0
    public var loc: JSONObject?
    /// A command's result for the room (flags.fn), and the full local copy.
    public var fn: JSONObject?, fnLocal: JSONObject?
    public var forwardedFrom: String?
    public var sourceAudio: String?
    public init(text: String = "") { self.text = text }
}

public struct SendPlan: Sendable, Equatable {
    public static let asVoiceKey = "msgAsVoice", voiceTextKey = "msgVoiceText", tapKey = "msgTap", vanishKey = "msgVanish", sealKey = "msgSeal"

    /// What Send does with the field.
    public enum Step: String, Sendable { case none, text, speak, dictateSpeak, dictateText, wait }

    public let asVoice: Bool, voiceText: Bool, tap: Bool
    /// 0 = not vanishing.
    public let vanishSeconds: Int
    /// nil = not sealed; "" = a new random code when it is sent.
    public let sealCode: String?

    init(asVoice: Bool, voiceText: Bool, tap: Bool, vanishSeconds: Int, sealCode: String?) {
        self.asVoice = asVoice
        self.voiceText = voiceText && !asVoice
        self.tap = tap
        self.vanishSeconds = vanishSeconds
        self.sealCode = sealCode
    }

    /// The options as the form holds them now.
    public static func of(_ form: [String: JSON]) -> SendPlan {
        var code: String? = form[sealKey].map { v in (v.stringValue ?? v.stringify()).javaTrimmed }
        // Only spaces or dashes would seal with an empty code: that is "a random one" instead.
        if let c = code, Sealed.normalize(c).isEmpty { code = "" }
        return SendPlan(asVoice: form[asVoiceKey] == .bool(true), voiceText: form[voiceTextKey] == .bool(true), tap: form[tapKey] == .bool(true),
                        vanishSeconds: seconds(form[vanishKey]), sealCode: code)
    }

    public var sealed: Bool { sealCode != nil }

    /// How many options are on.
    public var count: Int { (asVoice ? 1 : 0) + (voiceText ? 1 : 0) + (tap ? 1 : 0) + (vanishSeconds > 0 ? 1 : 0) + (sealed ? 1 : 0) }

    /// What Send does: `hasText` — the field has something; `voiceBusy` — still dictating or speaking an earlier one.
    public func step(hasText: Bool, voiceBusy: Bool) -> Step {
        if asVoice { return voiceBusy ? .wait : hasText ? .speak : .dictateSpeak }
        if voiceText && !hasText { return voiceBusy ? .wait : .dictateText }
        return hasText ? .text : .none
    }

    /// send.option — asVoice | voiceText | tap | vanish[:seconds] | seal[:code] | newCode | none. True when something changed.
    @discardableResult
    public static func apply(_ form: inout [String: JSON], _ arg: String?, defaultVanish: Int, newCode: () -> String) -> Bool {
        let k = (arg ?? "").javaTrimmed
        let colon = k.firstIndex(of: ":")
        let name = colon.map { String(k[..<$0]) } ?? k
        let value = colon.map { String(k[k.index(after: $0)...]) }
        switch name {
        case "asVoice": if toggle(&form, asVoiceKey) { form[voiceTextKey] = nil }; return true
        case "voiceText": if toggle(&form, voiceTextKey) { form[asVoiceKey] = nil }; return true
        case "tap": toggle(&form, tapKey); return true
        case "vanish":
            let s = value == nil ? (form[vanishKey] != nil ? 0 : defaultVanish > 0 ? defaultVanish : 15) : seconds(.string(value!))
            if s > 0 { form[vanishKey] = .double(Double(s)) } else { form[vanishKey] = nil }
            return true
        case "seal":
            if let value { form[sealKey] = .string(value) }
            else if form[sealKey] != nil { form[sealKey] = nil }
            else { form[sealKey] = "" }
            return true
        case "newCode": form[sealKey] = .string(newCode()); return true
        case "none", "normal":
            for key in [asVoiceKey, voiceTextKey, tapKey, vanishKey, sealKey] { form[key] = nil }
            return true
        default: return false
        }
    }

    /// What stays in the field once `sent` went (nil: the whole field went).
    public static func leftover(field: String?, sent: String?) -> String {
        let now = field ?? ""
        guard let sent else { return "" }
        let s = sent.javaTrimmed, t = now.javaTrimmed
        if s.isEmpty { return now }
        if t == s { return "" }
        if t.hasPrefix(s) { return String(t.dropFirst(s.count)).javaTrimmed }
        return now
    }

    /// On: switched off (false); off: switched on (true).
    @discardableResult
    private static func toggle(_ form: inout [String: JSON], _ key: String) -> Bool {
        if form[key] == .bool(true) { form[key] = nil; return false }
        form[key] = true
        return true
    }

    static func seconds(_ v: JSON?) -> Int {
        guard let v, !v.isNull else { return 0 }
        let d: Double
        if let n = v.doubleValue { d = n }
        else if let parsed = Double((v.stringValue ?? v.stringify()).javaTrimmed) { d = parsed }
        else { return 0 }
        if d.isNaN || d <= 0 { return 0 }
        return Int(min(d, Double(7 * 24 * 3600)))
    }
}
