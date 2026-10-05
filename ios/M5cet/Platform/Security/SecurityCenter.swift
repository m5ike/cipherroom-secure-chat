// The device security of the app in one place — what Android's M5 (the
// Application) holds for it: the vault, the lock, the keys, the lock inbox, the
// wipe and the screen privacy. Installed at launch (App/Bootstrap.swift →
// SecurityCenter.install), reached as SecurityCenter.shared by the other parts:
//
//   signer() / agreement() the device's Secure Enclave keys: M5Net's RequestSigner and M5Crypto's
//                          DeviceSigner (KeyringSigner), M5Crypto's KeyAgreer (KeyringAgreement)
//   vault                  the SYS / USER tiers (VaultTier) for every store of the app
//   secrets                small secrets in the app-only keychain group (SecureStore)
//   sharedSecrets          the keychain group the notification extension shares — only what it must read
//   lock                   AppLockState: isLocked, lockNow(remote:) — the server's lock command
//   inbox                  the lock inbox's files (LockInboxFiles over M5Proto's LockInbox)
//   policies               the signed policy (PolicyStore.apply — M5Net hands it each server answer)
//   wipe(…)                the server's wipe command, the attempts' wipe, the duress PIN
//   add(_: LockParticipant), inboxConsumer, inCall — how the rooms, calls and caches take part

import Foundation
import M5Core
import os
import SwiftUI
import UIKit
import UserNotifications

/// What else a lock touches (Android M5.forgetSecrets / onUnlocked): rooms, account, caches.
@MainActor
protocol LockParticipant: AnyObject {
    /// The lock is about to zero the data key (it is still there). `inbox`: keep the connections and send
    /// what would be stored into it (`inbox.seal(LockedRooms.message(…))`, Rooms.lockReceiving); nil: close
    /// them (security.lockDisconnect, or no inbox could start — Rooms.disconnectAll).
    func lockWillForget(receiving inbox: LockInboxFiles?)
    /// The data key is gone: drop everything that was opened with it.
    func lockDidForget()
    /// The data key is back (the lock inbox merges right after, through `LockInboxConsumer`).
    func lockDidUnlock()
}

extension LockParticipant {
    func lockWillForget(receiving inbox: LockInboxFiles?) {}
    func lockDidForget() {}
    func lockDidUnlock() {}
}

@MainActor
final class SecurityCenter {
    /// The app's instance (nil until Bootstrap installed it).
    static private(set) var shared: SecurityCenter?

    let paths: SecurityPaths
    let keyring: Keyring
    let vault: Vault
    let policies: PolicyStore
    let settings: any SecuritySettings
    let duress: DuressPin
    let events: any SecurityEvents
    let lock: AppLock
    let inbox: LockInboxFiles
    let wiper: Wiper
    let privacy: ScreenPrivacy
    lazy var presenter = LockPresenter(center: self)
    /// Puts lock windows up (off in tests).
    var showsWindows = false

    /// Small secrets of the app only (the app-only keychain group; the unsigned simulator: a development file store).
    var secrets: any SecureStore { keyring.store }
    /// The keychain group the notification extension shares: only what it must read (README).
    var sharedSecrets: any SecureStore { keyring.shared }

    /// The device's request-signing key — M5Net `RequestSigner`, M5Crypto `DeviceSigner` (made on first use).
    func signer() throws -> KeyringSigner { try KeyringSigner(keyring: keyring) }
    /// The device's encryption key — M5Crypto `KeyAgreer` for `Ecies.open` (made on first use).
    func agreement() throws -> KeyringAgreement { try KeyringAgreement(keyring: keyring) }

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

    /// `keyring` carries the two stores (app-only and shared); the attempt counter is in the app-only one.
    init(paths: SecurityPaths, keyring: Keyring, clock: any LockClock, biometrics: any BiometricAuthenticator,
         background: (any BackgroundTime)?, events: any SecurityEvents, iterations: Int = Vault.pinIterations,
         extraDirs: [URL] = [], defaultsDomains: [String] = []) {
        self.paths = paths
        self.keyring = keyring
        self.clock = clock
        self.events = events
        vault = Vault(paths: paths, keyring: keyring, iterations: iterations)
        let policies = PolicyStore(vault: vault)
        self.policies = policies
        settings = VaultSecuritySettings(vault: vault)
        duress = DuressPin(vault: vault, settings: settings)
        let engine = LockEngine(vault: vault, anchor: KeyringLockAnchor(keyring: keyring), records: SecureStoreLockRecords(store: keyring.store),
                                duress: duress, clock: clock, events: events, policy: { policies.lock })
        lock = AppLock(engine: engine, biometrics: biometrics, background: background)
        inbox = LockInboxFiles(dir: paths.lockbox)
        wiper = Wiper(paths: paths, vault: vault, keyring: keyring, stores: [keyring.store, keyring.shared], inbox: inbox, clock: clock,
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

    /// The keychain services of the two stores (each in its own access group).
    nonisolated static let appService = "cz.m5cet.app.security"
    nonisolated static let sharedService = "cz.m5cet.shared.security"

    /// The app-only and the shared store: Keychain groups `<prefix>cz.m5cet.app` / `<prefix>cz.m5cet.shared`;
    /// in an unsigned simulator build (no keychain entitlement) the development file stores, the shared one
    /// on the App Group side.
    nonisolated static func systemStores(_ paths: SecurityPaths) -> (app: any SecureStore, shared: any SecureStore) {
        if let prefix = KeychainSecureStore.groupPrefix() {
            return (KeychainSecureStore(service: appService, accessGroup: prefix + KeychainSecureStore.appGroupSuffix),
                    KeychainSecureStore(service: sharedService, accessGroup: prefix + KeychainSecureStore.sharedGroupSuffix))
        }
        #if targetEnvironment(simulator)
        return (FileSecureStore(dir: paths.devKeychain), FileSecureStore(dir: paths.devSharedKeychain))
        #else
        // A device build always has the entitlement; without it every Keychain call fails (and says so).
        return (KeychainSecureStore(service: appService, accessGroup: nil), KeychainSecureStore(service: sharedService, accessGroup: nil))
        #endif
    }

    /// This device's locations, Keychain and Secure Enclave.
    static func system() -> SecurityCenter {
        let paths = SecurityPaths.system()
        let stores = systemStores(paths)
        let fm = FileManager.default
        let group = Bundle.main.object(forInfoDictionaryKey: "M5AppGroup") as? String
        return SecurityCenter(paths: paths, keyring: .system(store: stores.app, shared: stores.shared), clock: SystemLockClock(),
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
        var open: LockInboxFiles?
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
        let o = JSONObject([("v", .int(1)), ("locked", .bool(lock.isSetUp && lock.isLocked)), ("bg", .int(since?.wallMs ?? 0)),
                            ("bgMono", .int(since?.monoMs ?? 0)), ("boot", .string(since?.boot ?? clock.now().boot)),
                            ("autolock", .int(p.autolockSeconds)), ("screenshots", .bool(p.screenshots))])
        try? ProtectedFiles.ensureDirectory(paths.shared, protection: .completeUntilFirstUserAuthentication)
        try? SecData.json(o).write(to: paths.lockState, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: previews

    /// A throwaway instance (SwiftUI previews): memory Keychain, software keys, a temporary directory.
    static func preview() -> SecurityCenter {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("m5-preview-\(UUID().uuidString)", isDirectory: true)
        return SecurityCenter(paths: .under(base), keyring: Keyring(store: MemorySecureStore(), shared: MemorySecureStore(), enclave: nil),
                              clock: SystemLockClock(), biometrics: SystemBiometrics(), background: nil, events: LoggedSecurityEvents(),
                              iterations: 1000)
    }
}
