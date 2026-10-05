// Notifications on the Renderer's contracts (Renderer/README.md): the notify.* and
// conversations.* settings are the design's settings (DesignServices.settings —
// Settings › Notifications, a screen of the design), the actions notify.up / down /
// use / drop / test / sync go through the action router, every setting change
// reaches NotificationPrefs (Android MainActivity.settingChanged → NotifyPrefs.
// onSetting), the texts and the app's name are the design's.

import Foundation
import M5Design

/// NotifySettingsSource over the design's settings (SettingsModel: typed, validated, saved at once).
@MainActor
final class DesignNotifySettings: NotifySettingsSource {
    private weak var services: DesignServices?

    init(services: DesignServices) { self.services = services }

    func value(_ key: String) -> Any? {
        guard let s = services?.settings else { return NotificationPrefs.defaults[key] }
        switch s.get(key) {
        case .bool(let b): return b
        case .string(let v): return v
        case .number(let d): return d
        default: return NotificationPrefs.defaults[key]
        }
    }

    func set(_ key: String, _ value: Any) {
        guard let services else { return }
        let v: DesignValue? = switch value {
        case let b as Bool: .bool(b)
        case let s as String: .string(s)
        case let n as Double: .number(n)
        case let n as Int: .number(Double(n))
        default: nil
        }
        var s = services.settings
        if s.set(key, v) { services.settings = s }
    }
}

extension Notifier {
    /// The design's side (App/AppModel.design): settings, actions, setting changes, texts, the app's name, language.
    func connect(design services: DesignServices) {
        prefs.settings = DesignNotifySettings(services: services)
        texts = { [weak services] key in services.flatMap { $0.design.text(key, lang: $0.lang) } }
        prefs.appName = { [weak services] in services?.design.appName ?? "M5cet" }
        prefs.lang = { [weak services] in services?.lang ?? NeutralTexts.deviceLanguage }
        services.actions.register(["notify.up", "notify.down", "notify.use", "notify.drop", "notify.test", "notify.sync"]) { [weak self] action, ctx in
            guard let self else { return }
            let arg: String = switch action {
            case .notifyUp(let s), .notifyDown(let s), .notifyUse(let s), .notifyDrop(let s), .notifyTest(let s), .notifySync(let s): s
            default: ""
            }
            let host = ctx.host
            prefs.onChange = { [weak host] in host?.refresh() }
            prefs.onFlash = { [weak host] text, level in host?.flash(title: "", text: text, level: FlashLevel(rawValue: level) ?? .info) }
            prefs.run(action.name, arg)
        }
        services.actions.onSettingChanged { [weak self] key, _ in self?.settingChanged(key) }
        prefs.writeMirror()
        registerCategories()
    }
}
