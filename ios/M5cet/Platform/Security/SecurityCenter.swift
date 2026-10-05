// The device security of the app in one place — what Android's M5 (the
// Application) holds for it: the vault, the lock, the keys, the lock inbox, the
// wipe and the screen privacy. Installed at launch (App/Bootstrap.swift →
// SecurityCenter.install), reached as SecurityCenter.shared by the other parts:
//
//   signer / agreement     the device's Secure Enclave keys for M5Net (DeviceSigner, DeviceAgreement)
//   vault                  the SYS / USER tiers (VaultTier) for every store of the app
//   secrets                small secrets in the Keychain (SecureStore)
//   lock                   AppLockState: isLocked, lockNow(remote:) — the server's lock command
//   inbox                  the lock inbox (LockInbox) the rooms write to while locked
//   policies               the signed policy (PolicyStore.apply — M5Net hands it each server answer)
//   wipe(…)                the server's wipe command, the attempts' wipe, the duress PIN
//   add(_: LockParticipant), inboxConsumer, inCall — how the rooms, calls and caches take part

import Foundation
import os
import SwiftUI
import UIKit
import UserNotifications

/// What else a lock touches (Android M5.forgetSecrets / onUnlocked): rooms, account, caches.
@MainActor
protocol LockParticipant: AnyObject {
    /// The lock is about to zero the data key (it is still there). `inbox`: keep the connections and send
    /// what would be stored into it (Rooms.lockReceiving); nil: close them (security.lockDisconnect, or
    /// no inbox could start — Rooms.disconnectAll).
    func lockWillForget(receiving inbox: LockInbox?)
    /// The data key is gone: drop everything that was opened with it.
    func lockDidForget()
    /// The data key is back (the lock inbox merges right after, through `LockInboxConsumer`).
    func lockDidUnlock()
}

extension LockParticipant {
    func lockWillForget(receiving inbox: LockInbox?) {}
    func lockDidForget() {}
    func lockDidUnlock() {}
}

@MainActor
final class SecurityCenter {
    /// The app's instance (nil until Bootstrap installed it).
    static private(set) var shared: SecurityCenter?

    let paths: SecurityPaths
    /// Small secrets in the Keychain (the unsigned simulator: a development file store).
    let secrets: any SecureStore
    let keyring: Keyring
    let vault: Vault
    let policies: PolicyStore
    let settings: any SecuritySettings
    let duress: DuressPin
    let events: any SecurityEvents
    let lock: AppLock
    let inbox: LockInbox
    let wiper: Wiper
    let privacy: ScreenPrivacy
    lazy var presenter = LockPresenter(center: self)
    /// Puts lock windows up (off in tests).
    var showsWindows = false

    /// The device's request-signing key (M5Net).
    var signer: any DeviceSigner { KeyringSigner(keyring: keyring) }
    /// The device's encryption key (M5Net: ECIES from the server).
    var agreement: any DeviceAgreement { KeyringAgreement(keyring: keyring) }

    /// The rooms' side of the lock inbox's drain (set by the rooms).
    var inboxConsumer: (any LockInboxConsumer)?
    /// A call is running (Platform/Calls): the data key stays until it ends.
    var inCall: @MainActor () -> Bool = { false }
    /// What a remote wipe does after its report (default: a backgrounded app exits).
    var afterRemoteWipe: @MainActor () -> Void = {
        if UIApplication.shared.applicationState == .background { exit(0) }
    }
    /// The "data erased" notice is showing.
    var wipedNotice = false

    private struct Weak { weak var participant: (any LockParticipant)? }
    private var participants: [Weak] = []
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "lock")
    private let clock: any LockClock

    init(paths: SecurityPaths, store: any SecureStore, keyring: Keyring, clock: any LockClock, biometrics: any BiometricAuthenticator,
         background: (any BackgroundTime)?, events: any SecurityEvents, iterations: Int = Vault.pinIterations,
         extraDirs: [URL] = [], defaultsDomains: [String] = []) {
        self.paths = paths
        self.secrets = store
        self.keyring = keyring
        self.clock = clock
        self.events = events
        vault = Vault(paths: paths, keyring: keyring, iterations: iterations)
        let policies = PolicyStore(vault: vault)
        self.policies = policies
        settings = VaultSecuritySettings(vault: vault)
        duress = DuressPin(vault: vault, settings: settings)
        let engine = LockEngine(vault: vault, anchor: KeyringLockAnchor(keyring: keyring), records: SecureStoreLockRecords(store: store),
                                duress: duress, clock: clock, events: events, policy: { policies.lock })
        lock = AppLock(engine: engine, biometrics: biometrics, background: background)
        inbox = LockInbox(dir: paths.lockbox)
        wiper = Wiper(paths: paths, vault: vault, keyring: keyring, stores: [store], inbox: inbox, clock: clock,
                      extraDirs: extraDirs, defaultsDomains: defaultsDomains)
        privacy = ScreenPrivacy()
        lock.hooks = AppLock.Hooks(
            forget: { [weak self] in self?.forgetSecrets() },
            unlocked: { [weak self] in self?.didUnlock() },
            locked: { [weak self] in self?.didLock() },
            wipe: { [weak self] reason, remote, attempts, quiet in self?.wipe(reason: reason, remote: remote, attempts: attempts, quiet: quiet) },
            inCall: { [weak self] in self?.inCall() ?? false },
            draining: { [weak self] in self?.inbox.isDraining ?? false },
            changed: { [weak self] in self?.changed() })
    }

    // MARK: the app's instance

    /// This device's locations, Keychain and Secure Enclave.
    static func system() -> SecurityCenter {
        let paths = SecurityPaths.system()
        let service = "cz.m5cet.app.security"
        #if targetEnvironment(simulator)
        let store: any SecureStore = KeychainSecureStore.usable() ? KeychainSecureStore(service: service) : FileSecureStore(dir: paths.devKeychain)
        #else
        let store: any SecureStore = KeychainSecureStore(service: service)
        #endif
        let fm = FileManager.default
        let group = Bundle.main.object(forInfoDictionaryKey: "M5AppGroup") as? String
        return SecurityCenter(paths: paths, store: store, keyring: .system(store: store), clock: SystemLockClock(),
                              biometrics: SystemBiometrics(), background: SystemBackgroundTime(), events: LoggedSecurityEvents(),
                              extraDirs: [fm.urls(for: .cachesDirectory, in: .userDomainMask)[0], fm.temporaryDirectory],
                              defaultsDomains: [Bundle.main.bundleIdentifier, group].compactMap { $0 })
    }

    /// Installs the app's instance (App/Bootstrap.swift): the lock follows the scene phase.
    static func install(into model: AppModel) {
        let center = system()
        shared = center
        center.showsWindows = true
        center.start()
        model.onScenePhase { [weak center] phase in
            guard let center else { return }
            switch phase {
            case .background: center.lock.onBackground()
            case .active: center.lock.onForeground()
            default: break
            }
        }
        let nc = NotificationCenter.default
        // Before the first frame back in the foreground: the auto-lock is decided before anything shows.
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak center] _ in
            MainActor.assumeIsolated { center?.lock.onForeground() }
        }
        // A scene that connects (the first at launch, another window on iPad) gets the lock window too.
        for name in [UIScene.willConnectNotification, UIScene.didActivateNotification] {
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak center] _ in
                MainActor.assumeIsolated { center?.presenter.update() }
            }
        }
    }

    /// Starts what runs from launch: the system key, the privacy shield, a pending wipe report.
    func start() {
        try? paths.prepare()
        do { _ = try vault.sysKey() } catch { logger.error("the system key is not available") }
        if paths.sharedIsAppGroup == false { logger.info("no App Group container: the system tier is in the app's container") }
        privacy.screenshotsAllowed = { [weak self] in self?.policies.lock.screenshots ?? false }
        privacy.flashOnScreenshot = { [weak self] in self?.settings.bool(SecuritySetting.screenshotFlash) ?? false }
        privacy.onScreenshot = { [weak self] in self?.events.add("screenshot", [:]) }
        privacy.install()
        duress.reconcile()
        installTeardowns()
        // A wipe whose report is still pending, not quiet, nothing set up again: say so once more.
        if wiper.hasPending, !lock.isSetUp, !wiper.pendingQuiet { wipedNotice = true }
        Task { await wiper.sendPending() }
        changed()
    }

    /// Something else to tell about locks (rooms, account, profiles, caches).
    func add(_ participant: any LockParticipant) {
        participants.removeAll { $0.participant == nil }
        participants.append(Weak(participant: participant))
    }

    // MARK: lock and unlock

    /// What a lock takes out of the memory (Android M5.forgetSecrets, 6.12 F-16): by default the
    /// rooms keep receiving into a new lock inbox generation (begun while the data key is still
    /// there); with security.lockDisconnect they close. Then the data key is zeroed and the
    /// participants drop what they opened with it.
    func forgetSecrets() {
        var open: LockInbox?
        if !settings.bool(SecuritySetting.lockDisconnect), let dek = try? vault.userKey(), inbox.begin(dek: dek) { open = inbox }
        let current = participants.compactMap(\.participant)
        for p in current { p.lockWillForget(receiving: open) }
        vault.lock()
        for p in current { p.lockDidForget() }
        logger.info("locked: the data key left the memory")
        changed()
    }

    private func didUnlock() {
        let current = participants.compactMap(\.participant)
        for p in current { p.lockDidUnlock() }
        if let dek = try? vault.userKey() {
            let consumer = inboxConsumer
            let inbox = self.inbox
            let key = inbox.beginUnlock(dek: dek) // now: nothing more is sealed, a drain is marked
            Task { await inbox.finishUnlock(key: key, consumer: consumer) }
        } else {
            inbox.close()
        }
        changed()
    }

    private func didLock() {
        // Android whenLocked: notifications go neutral (Platform/Notifications listens via participants).
        changed()
    }

    // MARK: the wipe

    /// Erases the app (the attempts, a rollback, the duress PIN, the server's command).
    func wipe(reason: String, remote: Bool, attempts: Int, quiet: Bool = false) {
        wiper.wipe(reason: reason, remote: remote, attempts: attempts, quiet: quiet)
        policies.forget()
        lock.reset()
        wipedNotice = !quiet && !remote
        changed()
        let wiper = self.wiper
        Task { [weak self] in
            if remote {
                // The report, at most 8 s, then the end (Android endAfterReport).
                let send = Task { @MainActor in await wiper.sendPending() }
                let deadline = Task {
                    try? await Task.sleep(for: .seconds(8))
                    send.cancel()
                }
                _ = await send.value
                deadline.cancel()
                self?.afterRemoteWipe()
            } else {
                await wiper.sendPending()
            }
        }
    }

    /// Notifications, shortcuts, scheduled work, URL caches and cookies go with the data (Android Wiper.teardown).
    private func installTeardowns() {
        wiper.addTeardown("notifications") {
            let c = UNUserNotificationCenter.current()
            c.removeAllDeliveredNotifications()
            c.removeAllPendingNotificationRequests()
        }
        wiper.addTeardown("shortcuts") { UIApplication.shared.shortcutItems = [] }
        wiper.addTeardown("caches") {
            URLCache.shared.removeAllCachedResponses()
            HTTPCookieStorage.shared.removeCookies(since: .distantPast)
        }
    }

    // MARK: state for the windows and the notification extension

    private func changed() {
        if showsWindows { presenter.update() }
        writeMirror()
    }

    /// lock-state.json in the App Group, for the notification extension (no secret in it):
    /// {v, locked, bg, bgMono, boot, autolock}. The extension treats the app as locked when
    /// `locked`, or when `bg` > 0 and the auto-lock has passed since (same boot: bgMono on
    /// CLOCK_MONOTONIC; another boot: locked).
    func writeMirror() {
        let since = lock.backgroundSince
        let p = policies.lock
        let o: SecRecord = ["v": 1, "locked": lock.isSetUp && lock.isLocked, "bg": since?.wallMs ?? 0, "bgMono": since?.monoMs ?? 0,
                            "boot": since?.boot ?? clock.now().boot, "autolock": p.autolockSeconds, "screenshots": p.screenshots]
        try? ProtectedFiles.ensureDirectory(paths.shared, protection: .completeUntilFirstUserAuthentication)
        try? SecJSON.data(o).write(to: paths.lockState, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: previews

    /// A throwaway instance (SwiftUI previews): memory Keychain, software keys, a temporary directory.
    static func preview() -> SecurityCenter {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("m5-preview-\(UUID().uuidString)", isDirectory: true)
        let store = MemorySecureStore()
        return SecurityCenter(paths: .under(base), store: store, keyring: Keyring(store: store, enclave: nil), clock: SystemLockClock(),
                              biometrics: SystemBiometrics(), background: nil, events: LoggedSecurityEvents(), iterations: 1000)
    }
}
