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

/// The on/off switch. The design's settings know no key for it yet (SettingsModel refuses unknown keys), so it
/// lives in the app's UserDefaults (`m5.watch.on`, off by default — the wipe erases it); once SettingsModel has
/// `watch.on`, the design's switch is the one place (Settings › Notifications) and this reads it there.
@MainActor
final class WatchSetting {
    /// The design's settings key (to add to SettingsModel.defaults, false, and to SettingSchema.privateAreas "watch.").
    static let key = "watch.on"
    /// Until then: a UserDefaults flag. In a debug run `-m5.watch.on YES` turns it on (the argument domain).
    static let defaultsKey = "m5.watch.on"

    private let defaults: UserDefaults
    private weak var design: DesignServices?

    init(defaults: UserDefaults = .standard, design: DesignServices?) {
        self.defaults = defaults
        self.design = design
    }

    /// The design's settings have the key.
    static var inDesign: Bool { SettingsModel.defaults[key] != nil }

    var on: Bool {
        if Self.inDesign, let design { return design.settings.bool(Self.key) }
        return defaults.bool(forKey: Self.defaultsKey)
    }

    func set(_ on: Bool) {
        if Self.inDesign, let design {
            var s = design.settings
            s.set(Self.key, .bool(on))
            design.settings = s
        }
        defaults.set(on, forKey: Self.defaultsKey)
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

    init(model: AppModel, defaults: UserDefaults = .standard) {
        self.model = model
        setting = WatchSetting(defaults: defaults, design: model.design)
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

/// The texts the phone sends: the design's in the user's language, else the English of WatchWire.english
/// (the `watch.*` keys are not in the design yet). `conversations.neutral` names a room below the "room" level.
@MainActor
enum WatchTexts {
    /// Phone-only texts (not sent): the neutral room name and the setting's own words for the design's switch.
    static let phone: [String: String] = [
        "conversations.neutral": "Conversation {n}",
        "watch.setting": "Apple Watch",
        "watch.setting.hint": "Your rooms and their latest messages on Apple Watch while M5cet is unlocked on this iPhone, as much as the notification privacy shows. Nothing stays on the watch once the app locks.",
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
