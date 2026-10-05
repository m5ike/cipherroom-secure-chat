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
        // Core — the rooms, the account, the device; the screens' state, the app's actions, the core's slots; and the
        // seams of Calls, Notifications, Location, Contacts, Voice, Watch (Core/README.md). Before the parts: a part's
        // registration replaces the core's fallback for the same action or slot (the later one wins).
        CoreInstall.install(into: model)
        // Parts/People — userPanel, userList, people.* / users.* / profile.* / msg.info / msg.sender, $profile, $myProfile.
        PeopleParts.install(into: model)
        // Parts/NFC — nfcPanel, nfcWork, nfcBuilder, nfc.read / write / emulate / stop, $nfc.
        NfcParts.install(into: model)
        // Parts/Tools — commands engine (core.fn), aiChat, voicePad, History ($log, calllog.*), ai.*, voice.dictate, voiceFx.*.
        ToolParts.install(into: model)
        // (A part: model.design.slots.register(…), model.design.actions.register(…), core.variables — Renderer/README.md.)
        // Core — the seams the parts left for it (the commands engine's device, room and usage).
        CoreInstall.afterParts(into: model)
    }
}
