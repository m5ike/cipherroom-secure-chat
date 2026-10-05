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
        // Platform/Watch — the Apple Watch companion (WatchConnectivity; only while unlocked and turned on).
        WatchBridge.install(into: model)
        // Platform/Notifications — UNUserNotificationCenter delegate, categories, neutral texts.
        Notifier.install(into: model)
        // Platform/NFC, Voice, Location, Contacts, Files — on demand from the screens.
        ChatParts.install(into: model)
        // Parts and the app's actions — model.design.slots.register(…), model.design.actions.register(…),
        // model.design.state = … (Renderer/README.md: the three contracts).
    }
}
