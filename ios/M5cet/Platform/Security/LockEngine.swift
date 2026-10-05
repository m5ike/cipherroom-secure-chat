// The decisions of the app lock without UI (Android security/AppLock's counting
// half): the PIN, biometrics and the duress PIN against the attempt counter
// (LockCounter rules, LockStore seal) and the policy — every failure counts; after
// the last allowed one the policy's wipe or an hour's lock-out. Synchronous and
// serial (one attempt at a time); AppLock runs it off the main thread for the PIN
// (PBKDF2 + Secure Enclave) and turns its outcomes into the lock's state.

import Foundation
import LocalAuthentication
import os

/// Where security events go (Android core/Events): "unlock", "unlock-failed", "lockout",
/// "key-invalidated", "screenshot" — M5Net queues them for the server.
protocol SecurityEvents: AnyObject, Sendable {
    func add(_ type: String, _ detail: [String: any Sendable])
}

/// Until M5Net's queue is installed: the event types in the system log (never details that could identify).
final class LoggedSecurityEvents: SecurityEvents, @unchecked Sendable {
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "security")
    private let lock = NSLock()
    private var recent: [(String, [String: any Sendable])] = []

    func add(_ type: String, _ detail: [String: any Sendable]) {
        logger.info("event \(type, privacy: .public)")
        lock.withLock {
            recent.append((type, detail))
            if recent.count > 50 { recent.removeFirst() }
        }
    }

    /// The last events (tests, the security screen).
    var events: [(type: String, detail: [String: any Sendable])] { lock.withLock { recent.map { ($0.0, $0.1) } } }
}

final class LockEngine: @unchecked Sendable {
    enum Outcome: Equatable {
        /// Unlocked; `before`: the failed attempts before this one.
        case ok(before: Int)
        case wrong
        /// Not checked: the wait is still running (or the attempt could not be counted).
        case wait
        case lockedOut
        /// The policy's wipe (reason "attempts" or "rollback").
        case wipe(reason: String, attempts: Int)
        /// The duress PIN.
        case duress
        /// A biometric prompt cancelled at the key — not counted.
        case cancelled
    }

    let vault: Vault
    let duress: DuressPin
    let clock: any LockClock
    let events: any SecurityEvents
    private let store: LockStore
    private let records: any LockRecords
    private let policyProvider: @Sendable () -> LockPolicy
    private let serial = NSLock()
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "lock")

    init(vault: Vault, anchor: any LockAnchor, records: any LockRecords, duress: DuressPin, clock: any LockClock,
         events: any SecurityEvents, policy: @escaping @Sendable () -> LockPolicy) {
        self.vault = vault
        self.store = LockStore(anchor: anchor, records: records)
        self.records = records
        self.duress = duress
        self.clock = clock
        self.events = events
        self.policyProvider = policy
    }

    var policy: LockPolicy { policyProvider() }

    // MARK: the counter as the lock screen shows it (not checked — what decides is the sealed view)

    func counterState() -> SecRecord { LockStore.fields(records.read() ?? [:]) }

    var attempts: Int { counterState().jInt("attempts") }

    var left: Int { max(0, policy.maxAttempts - attempts) }

    var waitSeconds: Int64 { LockCounter.waitSeconds(counterState(), now: clock.now()) }

    // MARK: setup

    func setUp(pin: String) throws {
        try serial.withLock {
            try vault.createUserKey(pin: pin)
            reset()
        }
    }

    private func reset() {
        if !store.save(LockCounter.fresh()) { logger.warning("the attempt counter could not be reset") }
    }

    // MARK: attempts

    /// unlock: an unlock attempt (the duress PIN counts); otherwise the current PIN before a change
    /// (6.7, audit N18) — counted and wiped after like an unlock.
    func attemptPin(_ pin: String, unlock: Bool) -> Outcome {
        serial.withLock {
            // 6.12: the duress PIN first, also during a wait — it only erases.
            if unlock && duress.check(pin) { return .duress }
            let v = store.load()
            if v.verdict == .rollback { return rolledBack() }
            var s = v.state
            let now = clock.now()
            // iOS: a wait from another boot session, anchored on this one's monotonic clock.
            if LockCounter.needsReanchor(s, now: now) {
                LockCounter.reanchor(&s, now: now)
                if !store.save(s) { return .wait }
            }
            // An attempt the app was killed in the middle of counts as a failure first.
            if LockCounter.interrupted(s) {
                let r = settleFailure("pin-interrupted")
                if r != .wrong { return r }
                s = store.load().state
            }
            if LockCounter.waitLeftMs(s, now: clock.now()) > 0 { return .wait }
            // The attempt is counted and stored BEFORE the slow derivation: killing the app meanwhile cannot undo it.
            LockCounter.begin(&s, now: clock.now())
            guard store.save(s) else {
                logger.error("the attempt could not be counted; not checking the PIN")
                return .wait
            }
            do {
                if try vault.unlockWithPin(pin) {
                    if unlock { return succeeded() }
                    reset()
                    return .ok(before: 0)
                }
            } catch {
                logger.error("PIN unlock failed")
            }
            return settleFailure("pin")
        }
    }

    /// A failure of any kind from outside (a biometric that did not open the key).
    func failed(_ how: String) -> Outcome { serial.withLock { settleFailure(how) } }

    /// The biometric prompt succeeded: unwrap the data key with its context.
    func biometricSucceeded(context: LAContext?) -> Outcome {
        serial.withLock {
            // A finger does not open a counter that was put back.
            if store.load().verdict == .rollback { return rolledBack() }
            do {
                try vault.unlockWithBiometrics(context: context)
                return succeeded()
            } catch SecurityError.cancelled {
                return .cancelled
            } catch {
                logger.error("biometric unlock failed")
                return settleFailure("biometric")
            }
        }
    }

    private func succeeded() -> Outcome {
        let s = counterState()
        let before = s.jInt("attempts") - (LockCounter.interrupted(s) ? 1 : 0) // not the attempt that just opened it
        reset()
        return .ok(before: max(0, before))
    }

    /// An older copy of the counter (or none where one must be): every attempt counts as used.
    private func rolledBack() -> Outcome {
        logger.warning("the attempt counter does not match its seal: every attempt counts as used")
        return settleFailure("rollback")
    }

    /// Decides on the wait, the lock-out or the wipe.
    private func settleFailure(_ how: String) -> Outcome {
        let p = policy
        let v = store.load()
        // A rollback leaves one attempt short of the maximum: this failure is the last one.
        var s = v.verdict == .rollback ? LockCounter.rolledBack(maxAttempts: p.maxAttempts) : v.state
        let o = LockCounter.settle(&s, now: clock.now(), maxAttempts: p.maxAttempts, wipe: p.wipe, backoff: p.backoff)
        let attempts = s.jInt("attempts")
        if !store.save(s) { logger.warning("the failure could not be stored") }
        if o == .wrong {
            events.add("unlock-failed", ["attempts": attempts, "method": how, "left": max(0, p.maxAttempts - attempts)])
            return .wrong
        }
        events.add("lockout", ["attempts": attempts, "method": how, "wipe": o == .wipe])
        if o == .wipe { return .wipe(reason: how == "rollback" ? "rollback" : "attempts", attempts: attempts) }
        return .lockedOut
    }
}
