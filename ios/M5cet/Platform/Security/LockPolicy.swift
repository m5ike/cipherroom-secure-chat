// The device policy from the console, applied only as the server signed it for
// this device (Android security/SignedPolicy + core/Config.applyServerAnswer, 6.7 F-16):
//
//   policySigned = { at, policy: "<JSON text>", sig }
//   sig          = ECDSA P-256 (P1363) by the pinned server key over
//                  "m5policy/1|<deviceId>|<at>|<JSON text>"
//
// never older than the policy applied before (a replay). The verification is
// M5Crypto's `SignedPolicy`; what the lock reads of it (`LockPolicy`) and where
// the applied policy is kept for the lock (`PolicyStore`, the SYS tier) are here.
// M5Net's `DeviceState` keeps the same signed policy in its "config" record: the
// part that stores DeviceState hands every server answer to `PolicyStore.apply`
// too (or a policy DeviceState already verified to `adopt`).

import Foundation
import M5Core
import M5Crypto

/// The lock part of the policy ("lock": {…}), with Android's defaults and limits (AppLock).
struct LockPolicy: Sendable, Equatable {
    /// "required" / "optional" / "off".
    var biometric = "optional"
    /// 4–12.
    var pinLength = 6
    /// 3–20.
    var maxAttempts = 8
    /// Wipe after the last attempt (else an hour's lock-out).
    var wipe = true
    /// A growing wait from the third failure.
    var backoff = true
    /// Screenshots, screen recording and the app switcher's preview allowed (Android: no FLAG_SECURE).
    var screenshots = false
    /// 0–86 400; the lock after this long in the background.
    var autolockSeconds = 60

    init() {}

    init(_ lock: JSONObject) {
        let b = lock.optString("biometric")
        biometric = ["required", "optional", "off"].contains(b) ? b : "optional"
        pinLength = max(4, min(12, lock.optInt("pinLength", 6)))
        maxAttempts = max(3, min(20, lock.optInt("maxAttempts", 8)))
        wipe = lock.bool("wipe") ?? true
        backoff = lock.bool("backoff") ?? true
        screenshots = lock.bool("screenshots") ?? false
        autolockSeconds = max(0, min(86_400, lock.optInt("autolockSeconds", 60)))
    }
}

/// The applied policy in the SYS tier (record "policy": {policy, policyAt}); AppLock and
/// ScreenPrivacy read `lock`.
final class PolicyStore: @unchecked Sendable {
    private let vault: Vault
    private let mutex = NSLock()
    private var cached: JSONObject?
    static let record = "policy"

    init(vault: Vault) { self.vault = vault }

    private func data() -> JSONObject {
        mutex.withLock {
            if let cached { return cached }
            let d = vault.json(.sys, Self.record)
            cached = d
            return d
        }
    }

    /// The whole applied policy ({} before the first signed one).
    var policy: JSONObject { data().object("policy") ?? JSONObject() }

    /// When the applied policy was signed (ms; 0: none yet).
    var appliedAt: Int64 { data().optInt64("policyAt") }

    var lock: LockPolicy { LockPolicy(policy.object("lock") ?? JSONObject()) }

    /// Applies `policySigned` of a server answer (M5Crypto `SignedPolicy.open`); false (and nothing changed)
    /// when it is missing, not signed by the pinned key for this device, or older than the applied one.
    @discardableResult
    func apply(answer: JSONObject, serverKey: String, deviceId: String) -> Bool {
        guard let signed = answer.object("policySigned"),
              let p = SignedPolicy.open(signed, serverKey: serverKey, deviceId: deviceId, lastAt: appliedAt) else { return false }
        return store(p, at: signed.optInt64("at"))
    }

    /// A server answer as its JSON text (M5Net's NetJSON stringified).
    @discardableResult
    func apply(answerText: String, serverKey: String, deviceId: String) -> Bool {
        guard let answer = JSON.parseObject(answerText) else { return false }
        return apply(answer: answer, serverKey: serverKey, deviceId: deviceId)
    }

    /// A policy M5Net's DeviceState verified already (`SignedDevicePolicy`): kept when it is not older.
    @discardableResult
    func adopt(policy: JSONObject, at: Int64) -> Bool {
        guard at >= appliedAt else { return false }
        return store(policy, at: at)
    }

    private func store(_ p: JSONObject, at: Int64) -> Bool {
        let d = JSONObject([("policy", .object(p)), ("policyAt", .int(at))])
        do { try vault.putJson(.sys, Self.record, d, durable: true) } catch { return false }
        mutex.withLock { cached = d }
        return true
    }

    /// A new server: its own policy clock (Android Config.enrolled removes policyAt).
    func reset() {
        vault.delete(.sys, Self.record)
        mutex.withLock { cached = nil }
    }

    /// Drops the cached copy (the wipe).
    func forget() { mutex.withLock { cached = nil } }
}
