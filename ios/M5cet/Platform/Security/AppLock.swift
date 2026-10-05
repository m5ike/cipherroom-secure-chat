// Opening the app (Android security/AppLock): biometrics or the PIN, the policy
// from the console (biometric required / optional / off, PIN length, attempts,
// wipe, a growing wait, auto-lock). LockEngine counts and decides; this is the
// lock's state on the main actor, observed by the lock screen (Parts/Lock).
//
// 6.12 (F-16) as on Android:
//   - a lock forgets: "Lock" (the menu, the design's lock.now, the server's lock
//     command) and the auto-lock zero the vault's data key and drop what was opened
//     with it (SecurityCenter.forgetSecrets). By default the open rooms keep
//     receiving into the lock inbox, merged at the unlock; with
//     security.lockDisconnect they close too. During a call the key stays until
//     the call ends (the screen is locked at once), and while the unlock merges
//     the inbox;
//   - the attempt counter is sealed by a Secure Enclave key that changes with every
//     write (LockStore): a rollback counts as every attempt used;
//   - the duress PIN (off by default) erases the app.
//
// iOS: the auto-lock. Android's alarm wakes the process when the auto-lock's time
// passes in the background; iOS wakes no suspended app at a time. While the app
// still runs in the background (its background task, ≈30 s, or longer during a
// call) a timer locks at the time; when iOS is about to suspend it earlier, the
// data key goes then (`forgetWhenSuspended`, the background task's expiration) —
// the key never sleeps in a suspended app. Coming back checks the time again on
// the monotonic clock (a changed wall clock moves nothing).

import Foundation
import LocalAuthentication
import Observation
import UIKit

/// How an unlock attempt ended (Android AppLock.Result).
enum UnlockResult: Equatable, Sendable {
    case ok, wrong, wait, wiped, lockedOut, duress
    /// A biometric prompt cancelled (or not possible): nothing counted.
    case cancelled
}

/// What the rest of the app sees of the lock (SecurityCenter.shared.lock).
@MainActor
protocol AppLockState: AnyObject {
    /// A PIN is set up (the user tier exists).
    var isSetUp: Bool { get }
    /// Locked: the UI must not show the user's data (also in the background past the auto-lock — notifications neutral).
    var isLocked: Bool { get }
    var policy: LockPolicy { get }
    /// Locks now and forgets the data key; `remote` (the server's command): also during a call.
    func lockNow(remote: Bool)
}

/// The system's background time — UIApplication's background task; scripted in tests.
@MainActor
protocol BackgroundTime: AnyObject {
    func begin(expiration: @escaping @MainActor () -> Void) -> Int
    func end(_ id: Int)
}

@MainActor
final class SystemBackgroundTime: BackgroundTime {
    func begin(expiration: @escaping @MainActor () -> Void) -> Int {
        UIApplication.shared.beginBackgroundTask(withName: "cz.m5cet.app.lock") { expiration() }.rawValue
    }

    func end(_ id: Int) { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id)) }
}

@MainActor
@Observable
final class AppLock: AppLockState {
    /// How often a lock that waits for a call to end looks again (Android FORGET_RETRY_MS).
    static let forgetRetry: Duration = .seconds(15)

    /// The data key goes when iOS suspends the app before the auto-lock's time (see the file's header).
    @ObservationIgnored var forgetWhenSuspended = true

    /// The UI is locked (the data key is gone too, except while a call or a merge keeps it — forgetWaiting).
    private(set) var uiLocked = true
    /// A PIN check (PBKDF2 + Secure Enclave) is running.
    private(set) var busy = false
    /// Bumped when the counter, the wait or the lock changed — the lock screen reads again.
    private(set) var revision = 0

    @ObservationIgnored let engine: LockEngine
    @ObservationIgnored let biometrics: any BiometricAuthenticator
    @ObservationIgnored private let background: (any BackgroundTime)?
    @ObservationIgnored var hooks = Hooks()
    @ObservationIgnored private(set) var backgroundSince: LockTime?
    @ObservationIgnored private(set) var forgetWaiting = false
    @ObservationIgnored private var autolockTask: Task<Void, Never>?
    @ObservationIgnored private var backgroundTask: Int?

    /// What the lock does to the rest of the app (SecurityCenter fills them in).
    struct Hooks {
        /// Zero the data key and drop what was opened with it (M5.forgetSecrets).
        var forget: @MainActor () -> Void = {}
        /// Unlocked: the data key is back (the lock inbox merges, the rooms load).
        var unlocked: @MainActor () -> Void = {}
        /// Locked (notifications neutral, the screens drop what they show).
        var locked: @MainActor () -> Void = {}
        /// The wipe (reason, remote, attempts, quiet).
        var wipe: @MainActor (String, Bool, Int, Bool) -> Void = { _, _, _, _ in }
        /// A call is running (the key stays until it ends).
        var inCall: @MainActor () -> Bool = { false }
        /// The unlock is merging the lock inbox.
        var draining: @MainActor () -> Bool = { false }
        /// Anything changed (the notification extension's mirror, the lock windows).
        var changed: @MainActor () -> Void = {}
    }

    init(engine: LockEngine, biometrics: any BiometricAuthenticator, background: (any BackgroundTime)?) {
        self.engine = engine
        self.biometrics = biometrics
        self.background = background
    }

    private var vault: Vault { engine.vault }

    // MARK: state

    var policy: LockPolicy { engine.policy }
    var isSetUp: Bool { vault.hasUserKey }

    var isLocked: Bool {
        uiLocked || !vault.unlocked || Self.autolockDue(since: backgroundSince?.monoMs, now: engine.clock.now().monoMs,
                                                         seconds: policy.autolockSeconds)
    }

    /// In the background (since) at least the auto-lock time: locked, as if it had come back (6.7, audit S11).
    nonisolated static func autolockDue(since: Int64?, now: Int64, seconds: Int) -> Bool {
        guard let since else { return false }
        return now - since >= Int64(seconds) * 1000
    }

    var pinLength: Int { policy.pinLength }
    var maxAttempts: Int { policy.maxAttempts }
    var attempts: Int { engine.attempts }
    var left: Int { engine.left }
    /// Seconds until the next attempt is allowed.
    var waitSeconds: Int64 { engine.waitSeconds }
    /// What protects the PIN ("secure-enclave" / "software" / "").
    var pinKeyLevel: String { vault.pinKeyLevel }

    var biometricAvailable: Bool {
        policy.biometric != "off" && vault.bioEnrolled && biometrics.available
    }

    // MARK: setup and PIN changes

    func setUp(pin: String) async throws {
        busy = true
        defer { busy = false; changed() }
        let engine = self.engine
        try await Task.detached(priority: .userInitiated) { try engine.setUp(pin: pin) }.value
        uiLocked = false
    }

    func unlock(pin: String) async -> UnlockResult { await attempt(pin, unlock: true) }

    /// The current PIN before a change (counted, wiped after, like an unlock).
    func confirm(pin: String) async -> UnlockResult { await attempt(pin, unlock: false) }

    private func attempt(_ pin: String, unlock: Bool) async -> UnlockResult {
        guard !busy else { return .wait }
        busy = true
        defer { busy = false; changed() }
        let engine = self.engine
        let outcome = await Task.detached(priority: .userInitiated) { engine.attemptPin(pin, unlock: unlock) }.value
        return apply(outcome, method: "pin", unlock: unlock)
    }

    enum PinChange: Equatable { case ok, wrongCurrent(UnlockResult), refused(String) }

    /// A new unlock PIN after the current one: not the duress PIN, the policy's length.
    func changePin(current: String, new: String) async -> PinChange {
        guard new.count == pinLength, new.allSatisfy({ $0.isASCII && $0.isNumber }) else { return .refused("length") }
        let r = await confirm(pin: current)
        guard r == .ok else { return .wrongCurrent(r) }
        let engine = self.engine
        let duress = engine.duress
        if await Task.detached(operation: { duress.isDuressPin(new) }).value { return .refused("duress") }
        do {
            try await Task.detached(priority: .userInitiated) { try engine.vault.changePin(new) }.value
            return .ok
        } catch {
            return .refused("store")
        }
    }

    /// Sets the duress PIN (with the current PIN checked by the caller): nil, or Duress's refusal ("length", "same").
    func setDuress(pin: String) async -> String? {
        let engine = self.engine
        let length = pinLength
        return await Task.detached(priority: .userInitiated) { () -> String? in
            if let refusal = DuressVerifier.refusal(pin, length: length, isUnlockPin: engine.vault.opensWith(pin)) { return refusal }
            do { try engine.duress.set(pin) } catch { return "store" }
            return nil
        }.value
    }

    // MARK: biometrics

    static let bioStateRecord = "bio-state"

    /// Wraps the data key to a new biometric key (unlocked only). No prompt is needed on iOS:
    /// the wrap uses the key's public half; every unwrap asks for a biometric.
    func enrollBiometrics() throws {
        _ = try vault.enrollBiometrics()
        if let hash = biometrics.enrolmentHash { try? vault.put(.sys, Self.bioStateRecord, hash) }
        changed()
    }

    func disableBiometrics() {
        vault.disableBiometrics()
        vault.delete(.sys, Self.bioStateRecord)
        changed()
    }

    func unlockWithBiometrics(reason: String, fallbackTitle: String) async -> UnlockResult {
        guard biometricAvailable, !busy else { return .cancelled }
        // A changed enrolment: the key no longer opens (Android KeyPermanentlyInvalidatedException).
        if let kept = try? vault.get(.sys, Self.bioStateRecord), let now = biometrics.enrolmentHash, kept != now {
            disableBiometrics()
            engine.events.add("key-invalidated", ["reason": "biometrics changed"])
            return .cancelled
        }
        busy = true
        defer { busy = false; changed() }
        switch await biometrics.authenticate(reason: reason, fallbackTitle: fallbackTitle) {
        case .success(let context):
            return apply(engine.biometricSucceeded(context: context), method: "biometric", unlock: true)
        case .cancelled, .lockout, .unavailable:
            return .cancelled
        }
    }

    // MARK: outcomes

    private func apply(_ o: LockEngine.Outcome, method: String, unlock: Bool) -> UnlockResult {
        switch o {
        case .ok(let before):
            guard unlock else { return .ok }
            uiLocked = false
            forgetWaiting = false
            if before > 0 { engine.events.add("unlock", ["method": method, "after": before]) }
            hooks.unlocked()
            return .ok
        case .wrong: return .wrong
        case .wait: return .wait
        case .lockedOut: return .lockedOut
        case .cancelled: return .cancelled
        case .wipe(let reason, let attempts):
            hooks.wipe(reason, false, attempts, false)
            uiLocked = true
            return .wiped
        case .duress:
            // The app erases itself quietly: no "data erased" notice on the next start.
            hooks.wipe("duress", false, 0, true)
            uiLocked = true
            return .duress
        }
    }

    private func changed() {
        revision &+= 1
        hooks.changed()
    }

    // MARK: locking

    func onBackground() {
        backgroundSince = engine.clock.now()
        defer { changed() }
        guard isSetUp, vault.unlocked else { return }
        let seconds = policy.autolockSeconds
        if seconds == 0 {
            autolocked()
            return
        }
        if backgroundTask == nil { backgroundTask = background?.begin { [weak self] in self?.suspending() } }
        autolockTask?.cancel()
        autolockTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.autolocked()
        }
    }

    /// On return to the app: locks (and forgets) when it was away longer than the policy allows.
    func onForeground() {
        let due = Self.autolockDue(since: backgroundSince?.monoMs, now: engine.clock.now().monoMs, seconds: policy.autolockSeconds)
        backgroundSince = nil
        autolockTask?.cancel()
        autolockTask = nil
        endBackgroundTask()
        defer { changed() }
        guard due else { return }
        let was = uiLocked
        uiLocked = true
        let held = vault.unlocked
        forgetOrWait(force: false)
        if !was || held { hooks.locked() }
    }

    /// The auto-lock's time passed in the background (the timer while the app still runs).
    func autolocked() {
        guard isLocked, vault.unlocked, !forgetWaiting else { return }
        let was = uiLocked
        uiLocked = true
        forgetOrWait(force: false)
        if !was { hooks.locked() }
        endBackgroundTask()
        changed()
    }

    /// iOS is about to suspend the app (the background task's end): the data key does not sleep in it.
    func suspending() {
        defer { endBackgroundTask() }
        guard forgetWhenSuspended, isSetUp, vault.unlocked, !hooks.inCall() else { return }
        let was = uiLocked
        uiLocked = true
        forgetOrWait(force: false)
        if !was { hooks.locked() }
        changed()
    }

    /// Locks the screen and forgets the data key; remote (the server's lock command): at once, a call
    /// or not; otherwise a call keeps the key until it ends.
    func lockNow(remote: Bool) {
        uiLocked = true
        forgetOrWait(force: remote)
        hooks.locked()
        changed()
    }

    /// After a wipe: no PIN, nothing held.
    func reset() {
        uiLocked = true
        forgetWaiting = false
        backgroundSince = nil
        autolockTask?.cancel()
        endBackgroundTask()
        changed()
    }

    private func endBackgroundTask() {
        if let id = backgroundTask { background?.end(id) }
        backgroundTask = nil
    }

    private func forgetOrWait(force: Bool) {
        guard vault.unlocked else { return }
        let draining = hooks.draining()
        if (!force && hooks.inCall()) || draining {
            if !forgetWaiting {
                forgetWaiting = true
                Task { [weak self] in
                    try? await Task.sleep(for: draining ? .seconds(1) : Self.forgetRetry)
                    self?.retryForget()
                }
            }
            return
        }
        forgetWaiting = false
        hooks.forget()
    }

    private func retryForget() {
        guard forgetWaiting else { return }
        forgetWaiting = false
        if isLocked && vault.unlocked { forgetOrWait(force: false) }
    }
}
