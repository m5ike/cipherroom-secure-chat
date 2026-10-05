// The device policy from the console, applied only as the server signed it for
// this device (Android security/SignedPolicy + core/Config.applyServerAnswer, 6.7 F-16):
//
//   policySigned = { at, policy: "<JSON text>", sig }
//   sig          = ECDSA P-256 (P1363) by the pinned server key over
//                  "m5policy/1|<deviceId>|<at>|<JSON text>"
//
// never older than the policy applied before (a replay). TLS alone (a proxy, a
// mis-issued certificate) cannot switch the screenshot shield or the wipe off.
// server/android/crypto.ts policySignedString — the iOS API signs the same way.

import Foundation

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

    init(_ lock: SecRecord) {
        biometric = ["required", "optional", "off"].contains(lock.jString("biometric")) ? lock.jString("biometric") : "optional"
        pinLength = max(4, min(12, lock.jInt("pinLength", 6)))
        maxAttempts = max(3, min(20, lock.jInt("maxAttempts", 8)))
        wipe = lock.jBool("wipe", true)
        backoff = lock.jBool("backoff", true)
        screenshots = lock.jBool("screenshots", false)
        autolockSeconds = max(0, min(86_400, lock.jInt("autolockSeconds", 60)))
    }
}

enum SignedPolicy {
    static func signedString(deviceId: String, at: Int64, policyJson: String) -> String {
        "m5policy/1|\(deviceId)|\(at)|\(policyJson)"
    }

    /// The policy, when the wire holds a valid signature of serverKey (SPKI base64) for this device
    /// and is not older than lastAt; nil otherwise.
    static func open(_ wire: SecRecord?, serverKey: String, deviceId: String, lastAt: Int64) -> SecRecord? {
        guard let wire, !serverKey.isEmpty, !deviceId.isEmpty else { return nil }
        guard let atNumber = wire["at"] as? NSNumber, CFGetTypeID(atNumber) != CFBooleanGetTypeID() else { return nil }
        let at = atNumber.int64Value
        let json = wire.jString("policy"), sig = wire.jString("sig")
        guard !json.isEmpty, !sig.isEmpty, at >= lastAt else { return nil }
        guard EcP256.verify(spki: serverKey, data: Bytes.utf8(signedString(deviceId: deviceId, at: at, policyJson: json)), signature: sig) else {
            return nil
        }
        return SecJSON.parse(json)
    }
}

/// The applied policy in the SYS tier (record "policy": {policy, policyAt}) — M5Net hands it every
/// server answer (enrol, check-in); AppLock and ScreenPrivacy read `lock`.
final class PolicyStore: @unchecked Sendable {
    private let vault: Vault
    private let mutex = NSLock()
    private var cached: SecRecord?
    static let record = "policy"

    init(vault: Vault) { self.vault = vault }

    private func data() -> SecRecord {
        mutex.withLock {
            if let cached { return cached }
            let d = vault.json(.sys, Self.record)
            cached = d
            return d
        }
    }

    /// The whole applied policy ({} before the first signed one).
    var policy: SecRecord { data().jObject("policy") ?? [:] }

    /// When the applied policy was signed (ms; 0: none yet).
    var appliedAt: Int64 { data().jInt64("policyAt") }

    var lock: LockPolicy { LockPolicy(policy.jObject("lock") ?? [:]) }

    /// Applies `policySigned` of a server answer; false (and nothing changed) when it is missing,
    /// not signed by the pinned key for this device, or older than the applied one.
    @discardableResult
    func apply(answer: SecRecord, serverKey: String, deviceId: String) -> Bool {
        guard let signed = answer.jObject("policySigned"),
              let p = SignedPolicy.open(signed, serverKey: serverKey, deviceId: deviceId, lastAt: appliedAt) else { return false }
        let d: SecRecord = ["policy": p, "policyAt": signed.jInt64("at")]
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
