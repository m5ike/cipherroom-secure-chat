// The core at launch (App/Bootstrap.swift, after Security, Push, Calls and
// Notifications installed themselves): AppCore over SecurityCenter, the device
// service, the vault's files and CallSystem; the three renderer contracts
// (screen state, actions, slots); and every seam the other areas left for "the
// room session / the integration" (their READMEs). Android: M5.onCreate +
// MainActivity's wiring.

import Foundation
import M5Design
import M5Net
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
        }

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

        // Platform/Contacts.
        let people = ContactsService.shared
        people.store.setVault(SecurityPeopleVault(vault: center.vault))
        let store = people.store
        core.rooms.verifiedDevice = { kid in store.verified(kid) }
        let reach = CoreReachHost(core: core)
        core.reachHost = reach
        people.reach.host = reach
        people.install(into: model)
        core.onForget.append { store.forget() }

        // Platform/Voice.
        let voice = VoiceService.shared
        let env = CoreVoiceEnvironment(core: core)
        core.voiceEnvironment = env
        voice.setSettings(CoreVoiceSettings(core: core))
        voice.environment = env
        let speech = CoreSpeechServer { await MainActor.run { (core.device.server, core.account.signedIn ? core.account.token : "") } }
        voice.server = speech
        voice.configFetcher = speech
        voice.install(into: model)
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

        Task { await core.start() }
    }
}
