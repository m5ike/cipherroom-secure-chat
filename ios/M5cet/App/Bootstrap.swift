// Where the Platform code of wave 2 plugs into the app at launch — one line per area.
// Called from AppDelegate.application(_:didFinishLaunchingWithOptions:) on the main
// actor, before PushKit and APNs registration. Keep it light: Android's M5.onCreate
// does the same (the rooms and the UI come later).

import Foundation

@MainActor
enum Bootstrap {
    static func install(into model: AppModel) {
        // Platform/Security — Keychain, Secure Enclave, Vault, AppLock (lock on model.onScenePhase).
        SecurityCenter.install(into: model)
        // Platform/Push — model.push = …; BGTaskScheduler "cz.m5cet.app.checkin" (Info.plist).
        PushCenter.install(into: model)
        // Platform/Calls — model.voip = … (CallKit + PushKit; reports every VoIP push).
        CallSystem.shared.install(into: model)
        // Platform/Notifications — UNUserNotificationCenter delegate, categories, neutral texts.
        Notifier.install(into: model)
        // Core — the rooms, the account, the device; the screens' state, the app's actions, the core's slots; and the
        // seams of Calls, Notifications, Location, Contacts, Voice (Core/README.md). Before the parts: theirs win.
        CoreInstall.install(into: model)
        // Parts — model.design.slots.register(…), model.design.actions.register(…) (one line per parts area).
    }
}
