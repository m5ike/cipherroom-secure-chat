// What the watch bridge reads from the rest of the app (the seam — the tests give their own): whether the
// person turned Apple Watch on, whether the app is unlocked (Platform/Security), the notification privacy level
// (the same rule as the app's own notifications — push/NotifyPrefs.localPrivacy), the language and the design's
// texts. AppWatchEnvironment is the app's: AppModel.design (settings, language, design) + SecurityCenter.

import Foundation
import M5Design

@MainActor
protocol WatchEnvironment: AnyObject {
    /// The person turned the watch on (WatchSetting).
    var mirrorEnabled: Bool { get }
    func setMirrorEnabled(_ on: Bool)
    /// M5cet is unlocked: a PIN is set up and the data key is in memory. Fails closed (no lock known = locked).
    var unlocked: Bool { get }
    /// The notification privacy level for what the app shows itself: 0 neutral, 1 sender, 2 room, 3 content.
    var privacyLevel: Int { get }
    /// The app's language ("en", "cs"…).
    var lang: String { get }
    /// The design's name of the app.
    var appName: String { get }
    /// A design string in `lang`, nil when the design has none.
    func text(_ key: String) -> String?
}

/// The notification privacy levels (push/NotifyTemplate.PRIVACY, NotifyPrefs.localPrivacy).
enum WatchPrivacy {
    static let levels = ["neutral", "sender", "room", "content"]
    static let neutral = 0, sender = 1, room = 2, content = 3

    /// An unknown level counts as neutral.
    static func rank(_ s: String) -> Int { levels.firstIndex(of: s) ?? 0 }

    /// The level the app shows its own (decrypted) content at: the person's choice ("" = content, as the app always
    /// did), never above the operator's maximum. Only for an unlocked app — a locked one shows the watch nothing.
    static func local(chosen: String, operatorMax: String) -> Int {
        let max = levels.contains(operatorMax) ? rank(operatorMax) : neutral
        let mine = chosen.isEmpty ? content : rank(chosen)
        return min(mine, max)
    }
}

/// The on/off switch: the design's setting `watch.on` — the Apple Watch switch of the iOS design's
/// Settings › Notifications (server/ios/design.ts). M5Design's SettingsModel has it off by default and
/// SettingSchema keeps it in the private area "watch." (no design action may change it, only the person's tap);
/// the app's settings store holds it, so the wipe erases it with the rest.
@MainActor
final class WatchSetting {
    /// The design's settings key.
    static let key = "watch.on"

    private weak var design: DesignServices?

    init(design: DesignServices?) { self.design = design }

    /// Off without the design's settings (fails closed).
    var on: Bool { design?.settings.bool(Self.key) ?? false }

    func set(_ on: Bool) {
        guard let design else { return }
        var s = design.settings
        if s.set(Self.key, .bool(on)) { design.settings = s }
    }
}

/// The app's environment: AppModel.design and SecurityCenter.shared.
@MainActor
final class AppWatchEnvironment: WatchEnvironment {
    private weak var model: AppModel?
    let setting: WatchSetting
    /// The privacy level — default: what Platform/Notifications draws a message the app decrypted itself at
    /// (NotificationPrefs.localPrivacy("message"): the person's notify.privacy within the operator's maximum of
    /// the notify-policy template); before the Notifier is installed, the design's notify.privacy with no maximum.
    var privacy: @MainActor () -> String
    /// Whether the app is unlocked — default: SecurityCenter's lock (set up and not locked).
    var isUnlocked: @MainActor () -> Bool = {
        guard let lock = SecurityCenter.shared?.lock else { return false }
        return lock.isSetUp && !lock.isLocked
    }

    init(model: AppModel) {
        self.model = model
        setting = WatchSetting(design: model.design)
        let design = model.design
        privacy = { [weak design] in
            if let prefs = Notifier.shared?.prefs { return prefs.localPrivacy("message", locked: false) }
            let chosen = design?.settings.str("notify.privacy") ?? "neutral"
            return WatchPrivacy.levels[WatchPrivacy.local(chosen: chosen, operatorMax: "content")]
        }
    }

    var mirrorEnabled: Bool { setting.on }
    func setMirrorEnabled(_ on: Bool) { setting.set(on) }
    var unlocked: Bool { isUnlocked() }
    var privacyLevel: Int { WatchPrivacy.rank(privacy()) }

    var lang: String { model?.design.lang ?? "en" }
    var appName: String { model?.design.design.appName ?? "M5cet" }

    func text(_ key: String) -> String? {
        guard let design = model?.design else { return nil }
        return design.design.text(key, lang: design.lang)
    }
}

/// The texts the phone sends: the design's in the user's language (the iOS design has every `watch.*` key in nine
/// languages — server/ios/design.ts IOS_STRINGS), else the English of WatchWire.english (a design without them).
/// `conversations.neutral` names a room below the "room" level.
@MainActor
enum WatchTexts {
    /// Phone-only texts (not sent): the neutral room name. (The switch's own words, watch.setting, are the design's —
    /// its Settings › Notifications draws them.)
    static let phone: [String: String] = [
        "conversations.neutral": "Conversation {n}",
    ]

    static func t(_ key: String, _ env: any WatchEnvironment) -> String {
        if key == "app" { return env.appName }
        return env.text(key) ?? WatchWire.english[key] ?? phone[key] ?? key
    }

    /// Every string the watch uses, cleaned for the wire.
    static func table(_ env: any WatchEnvironment) -> [String: String] {
        var out: [String: String] = [:]
        for key in WatchWire.english.keys {
            let v = WatchWire.clean(t(key, env), max: WatchWire.maxStringValue)
            out[key] = v.isEmpty ? WatchWire.english[key] : v
        }
        return out
    }

    /// The quick replies (non-empty ones, in order).
    static func quick(_ env: any WatchEnvironment) -> [String] {
        WatchWire.quickKeys.map { WatchWire.clean(t($0, env), max: WatchWire.maxQuickText) }.filter { !$0.isEmpty }
    }
}
