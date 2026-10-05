// What every window of the app shares (A/M5.java's design, settings and language):
// the design in use, the user's settings (non-secret — the App Group's defaults;
// secrets live in the Keychain, Platform/Security), the language, and the three
// contracts other code plugs into — the slot registry, the action router and the
// screen state provider. One instance per app: AppModel.design.

import Foundation
import M5Design
import Observation
import os

@MainActor
@Observable
final class DesignServices {
    /// Contract 1: slot name → native part.
    @ObservationIgnored let slots: SlotRegistry
    /// Contract 2: the app's actions.
    @ObservationIgnored let actions: AppActionRouter
    /// Contract 3: where the app is and each screen's variables (UnconfiguredScreenState until the integration installs its own).
    var state: any ScreenStateProvider

    /// The design in use: the built-in one, or an active bundle (with the built-in one behind its texts).
    private(set) var design: Design
    /// default-design.json — what a failing screen of a trial bundle falls back to.
    @ObservationIgnored let builtIn: Design
    @ObservationIgnored let templates: [LookTemplate]

    private var settingsStore: SettingsModel
    /// "" = the phone's language.
    private(set) var langChoice: String

    /// A screen of the design failed to resolve and the built-in one was shown (BundleLedger.renderFailed).
    @ObservationIgnored var onRenderFailure: (@MainActor (String, any Error) -> Void)?

    @ObservationIgnored private let store: SettingsStore
    static let log = Logger(subsystem: "cz.m5cet.app", category: "design")

    init(store: SettingsStore = SettingsStore(), builtIn: Design? = nil, templates: [LookTemplate]? = nil,
         slots: SlotRegistry? = nil, actions: AppActionRouter? = nil, state: (any ScreenStateProvider)? = nil) {
        self.store = store
        let base = builtIn ?? DesignAssets.builtIn
        self.builtIn = base
        self.design = base
        self.templates = templates ?? DesignAssets.templates
        self.slots = slots ?? SlotRegistry()
        self.actions = actions ?? AppActionRouter()
        self.state = state ?? UnconfiguredScreenState()
        var s = store.loadSettings()
        // ui/look/Look.attach: 6.1's appearance keys into 6.2's, once.
        let preset = s.str("appearance.preset")
        let known = preset.isEmpty || preset == "design" || (self.templates.contains { $0.id == preset })
        let before = s
        s.migrateLook(presetKnown: known)
        settingsStore = s
        langChoice = store.loadLang()
        if s != before { store.save(s) }
    }

    // MARK: settings ($settings)

    /// The user's settings; every change is saved at once.
    var settings: SettingsModel {
        get { settingsStore }
        set {
            guard newValue != settingsStore else { return }
            settingsStore = newValue
            store.save(newValue)
        }
    }

    // MARK: language

    /// The app's language: the chosen one, else the first of the phone's the design speaks, else English.
    var lang: String {
        langChoice.isEmpty ? Self.systemLang : langChoice
    }

    static var systemLang: String { DesignLocales.pick(Locale.preferredLanguages, fallback: "en") }

    /// lang.set: one of the nine, or "" for the phone's.
    func setLang(_ l: String) {
        guard l.isEmpty || DesignLocales.isLocale(l) else { return }
        langChoice = l
        store.saveLang(l)
    }

    // MARK: the design

    /// A bundle became active (or the built-in design again): every window draws it.
    func setDesign(_ d: Design) { design = d.withFallback(builtIn) }
}

/// The settings' storage: the App Group's defaults (group.cz.m5cet.app, shared with the notification
/// extension), JSON as Settings.java keeps it. Not for secrets.
struct SettingsStore: @unchecked Sendable {
    static let appGroup = "group.cz.m5cet.app"
    let defaults: UserDefaults
    let settingsKey: String
    let langKey: String

    init(defaults: UserDefaults? = nil, settingsKey: String = "m5.settings", langKey: String = "m5.lang") {
        self.defaults = defaults ?? UserDefaults(suiteName: Self.appGroup) ?? .standard
        self.settingsKey = settingsKey
        self.langKey = langKey
    }

    func loadSettings() -> SettingsModel {
        guard let data = defaults.data(forKey: settingsKey), let v = try? DesignValue.parse(data), let o = v.objectValue else { return SettingsModel() }
        return SettingsModel(data: o)
    }

    func save(_ s: SettingsModel) { defaults.set(Data(DesignValue.object(s.data).jsonText().utf8), forKey: settingsKey) }

    func loadLang() -> String {
        let l = defaults.string(forKey: langKey) ?? ""
        return DesignLocales.isLocale(l) ? l : ""
    }

    func saveLang(_ l: String) { defaults.set(l, forKey: langKey) }
}
