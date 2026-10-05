// The core at launch (App/Bootstrap.swift, after Security, Push, Calls and
// Notifications installed themselves): AppCore over SecurityCenter, the device
// service, the vault's files and CallSystem; the three renderer contracts
// (screen state, actions, slots); and every seam the other areas left for "the
// room session / the integration" (their READMEs). Android: M5.onCreate +
// MainActivity's wiring.

import Foundation
import M5Core
import M5Design
import M5Net
import M5Proto
import SwiftUI

@MainActor
enum CoreInstall {
    static func install(into model: AppModel) {
        guard let center = SecurityCenter.shared else { return }
        let security = AppSecurity(center: center)
        // The design's lock screen (route "lock", the lockPad slot) is what every window shows when locked —
        // Security's own lock window would be a second, different lock UI. Its privacy cover (app switcher,
        // recording) stays: that is ScreenPrivacy, not these windows.
        center.showsWindows = false
        center.presenter.update()

        let device: any DeviceEnrolling
        if let d = PushCenter.shared?.device {
            device = PushDeviceAdapter(device: d, security: security)
        } else {
            device = CoreDeviceService(security: security)
        }
        let files = VaultFileStore(vault: FileVault(vault: center.vault))
        let core = AppCore(security: security, device: device, services: model.design, wires: CallSystemWires(), fileStore: files,
                           passkeys: SystemPasskeys())
        core.activate()
        model.core = core

        // Contract 3, 2, 1.
        let state = AppScreenState(core: core)
        model.design.state = state
        let actions = CoreActions(core: core, state: state)
        actions.install(into: model.design.actions)
        CoreSlots.register(into: model.design.slots, core: core, state: state, actions: actions)
        FallbackChatSlots.register(into: model.design.slots, core: core)

        // The app's life.
        model.onScenePhase { [weak core] phase in core?.scenePhase(phase) }

        // Platform/Calls.
        let calls = CallSystem.shared
        let callRooms = CoreCallRooms(core: core)
        calls.directory = callRooms
        calls.setEnvironment(CoreCallEnvironment(core: core))
        calls.history.vault = CoreCallVault(security: security)
        calls.history.enabled = { [weak core] in core?.settings.get("calls.history") != .bool(false) }
        calls.turnSource = CoreTurn { await MainActor.run { core.device.server } }
        security.inCall = { CallSystem.shared.activeCallRoom != nil }
        core.callLogSource = callRooms
        // 6.14 call wake: a room's relayed rings end in CallCenter's call log and missed-call notice; a call a VoIP
        // push rang is CallCenter's own (one record per call).
        core.rooms.pushOwnsCall = { key in CallSystem.shared.center.pushOwnsCall(roomKey: key) }
        core.rooms.onCallWakeStep = { key, label, s in
            let center = CallSystem.shared.center
            for r in s.records { center.history?.record(r, roomKey: key, room: label) }
            if let m = s.missed { center.onMissed?(key, m.people.first ?? "", m.video, m.at) }
        }

        // Platform/Notifications.
        if let n = Notifier.shared {
            let rooms = CoreNotificationRooms(core: core)
            core.notificationRooms = rooms
            n.rooms = rooms
            n.prefs.account = rooms
            n.flashSink = { [weak core] title, text, level in
                guard let h = core?.hosts.first else { return false }
                return h.showFlash(title: title, text: text, level: FlashLevel(rawValue: level) ?? .info)
            }
            n.unreadCount = { [weak core] in core?.rooms.unreadTotal ?? 0 }
            core.notifications = NotifierBridge(notifier: n)
            // Settings › Notifications' $notify (Android MainActivity.scopeFor → NotifyPrefs.scope): the channels'
            // order, the quiet hours' choices, whether push wakes this device, the account's sync.
            core.models.variables.register("settings.notify", "notify") { [weak core, weak n] in
                guard let n else { return .object([:]) }
                return DesignValue(any: n.prefs.scope(pushEnabled: core?.pushMode == "apns", linked: n.prefs.linked))
            }
        }
        if let d = PushCenter.shared?.device { core.pushModeSource = { [weak d] in d?.pushMode ?? "poll" } }

        // Platform/Location.
        let loc = LocationService.shared
        loc.settings = CoreLocationSettings(core: core)
        let signer = security.requestSigner
        loc.reporter = DeviceAPILocationReporter { [weak core] in
            MainActor.assumeIsolated {
                guard let st = core?.device.state, st.enrolled else { return nil }
                return try? DeviceEnrollment.credentials(st, signer: signer)
            }
        }
        loc.install(into: model)
        core.models.position = LocationPositionSource(service: loc)
        if let d = PushCenter.shared?.device {
            let control = CoreLocationControl(service: loc)
            core.locationControl = control
            d.location = control
        }

        // Platform/Contacts (Parts/People installs the vault behind its store and the reach's window side).
        let people = ContactsService.shared
        let store = people.store
        core.rooms.verifiedDevice = { kid in store.verified(kid) }
        people.install(into: model)
        core.onForget.append { store.forget() }
        center.wiper.addTeardown("contacts") { ContactsService.shared.wipe() }

        // Platform/Push: app releases and design bundles (update.install, $update).
        if let d = PushCenter.shared?.device { core.updates = PushUpdates(device: d) }

        // Parts/People: the account's profile card, the audit of hides and deletes (one unlock id with the chat's
        // bubbles: PeopleParts.defaultHides).
        PeopleParts.profiles = core.profileStore
        let audit = core.messageAudit
        if let d = PushCenter.shared?.device {
            audit.upload = { actions, account in _ = try await d.messageAudit(actions: actions, account: account) }
        }
        PeopleParts.defaultHides.audit = { action, room, m, until in audit.add(action, room: room, message: m, until: until) }
        // Parts/Chat: its audit lines (bubbles, MsgDetails through BubbleHides) go to the same journal.
        ChatMessageAudit.sink = audit

        // Parts/NFC: the account root of an M5Cet card's internal records; the forward of a message in no room is the
        // core's until the chat installs its forward sheet.
        NfcUiHooks.accountRoot = { [weak core] in core?.account.cardRoot() }
        NfcUiHooks.forward = { [weak actions] m, host in actions?.forward(m, host) }

        // Platform/Voice.
        let voice = VoiceService.shared
        let env = CoreVoiceEnvironment(core: core)
        core.voiceEnvironment = env
        voice.setSettings(CoreVoiceSettings(core: core))
        voice.environment = env
        let speech = CoreSpeechServer { await MainActor.run { (core.device.server, core.account.signedIn ? core.account.token : "") } }
        voice.server = speech
        voice.configFetcher = speech
        // (VoiceService.install: Parts/Tools' wireVoice, which keeps what is set here.)
        core.voice = env
        core.speaker = { m in VoiceService.shared.speakIncoming(sender: m.senderName, text: m.text) }
        core.onForget.append { VoiceService.shared.forgetSecrets() }
        CallVoiceBridge.shared.vault = FileVaultVoiceSources(files: files.vault)
        core.models.tools.voiceAvailable = true

        // NFC: what the tools sheet offers.
        core.models.tools.nfcAvailable = NfcService.shared.capabilities != .none

        // Settings whose side effects belong to other areas.
        core.settingObservers.append { key, _ in
            if key.hasPrefix("location.") { LocationService.shared.settingChanged(key) }
            if key == "people.contacts" { ContactsService.shared.setEnabled(model.design.settings.bool(key)) }
            if key.hasPrefix("voice") { VoiceService.shared.setSettings(CoreVoiceSettings(core: core)) }
        }

        // Parts/Tools' History: the rooms' histories in the vault (rooms that are not connected too).
        ToolsCallLog.shared.messages = callRooms

        Task {
            await core.start()
            #if DEBUG
            await CoreDebugLaunch.run(core)
            #endif
        }
    }

    /// After the parts (App/Bootstrap.swift): the seams the parts left for the core.
    static func afterParts(into model: AppModel) {
        guard let core = model.core else { return }
        // Parts/Tools' commands engine: this device's id, the room's blind id (a run's origin), the usage in the vault.
        if let engine = ToolParts.engine {
            engine.deviceId = { [weak core] in core?.device.state?.deviceId ?? "" }
            engine.roomId = { r in r.serverId.isEmpty ? nil : r.serverId }
            engine.usageStore = CoreFnUsage(records: core.security.userRecords)
        }
    }
}

/// The commands' usage (Fn.usage): the vault's user tier, record "fn-usage" (nil while locked or empty).
@MainActor
final class CoreFnUsage: FnUsageStore {
    static let record = "fn-usage"
    private let records: any RecordVault
    init(records: any RecordVault) { self.records = records }

    func loadUsage() -> JSONObject? {
        guard records.unlocked, let o = records.record(Self.record), !o.isEmpty else { return nil }
        return o
    }

    func saveUsage(_ o: JSONObject) { records.put(Self.record, o) }
}
