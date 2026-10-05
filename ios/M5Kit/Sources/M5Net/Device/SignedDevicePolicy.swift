// Port of A/security/SignedPolicy.java (6.7, security analysis F-16): the
// device policy — lock (PIN length, attempts, wipe, auto-lock, screenshots),
// logs, location, updates — is applied only as the server signed it for this
// device:
//
//   policySigned = { at, policy: "<JSON text>", sig }
//   sig          = ECDSA P-256 (P1363) by the pinned server key over
//                  "m5policy/1|<deviceId>|<at>|<JSON text>"
//
// and never older than the policy the app already has (a replayed one). TLS
// alone (a proxy, a mis-issued certificate) cannot switch the screen shield
// or the wipe off. server/android/crypto.ts policySignedString.

import Foundation

public enum SignedDevicePolicy {
    public static func signedString(deviceId: String, at: Millis, policyJson: String) -> String {
        DeviceSigning.policyString(deviceId: deviceId, at: at, policyJson: policyJson)
    }

    /// The policy and its time, when `wire` holds a valid signature of `serverKey` for this device and is not
    /// older than `lastAt`; nil otherwise.
    public static func open(_ wire: NetJSON?, serverKey: String, deviceId: String, lastAt: Millis) -> (policy: NetJSON, at: Millis)? {
        guard let wire, case .object = wire, !serverKey.isEmpty, !deviceId.isEmpty else { return nil }
        guard let atRaw = wire["at"], atRaw.isNumber, let at = atRaw.int64Value else { return nil }
        let json = wire.str("policy")
        let sig = wire.str("sig")
        if json.isEmpty || sig.isEmpty || at < lastAt { return nil }
        guard P256Keys.verify(spki: serverKey, text: signedString(deviceId: deviceId, at: at, policyJson: json), signature: sig) else { return nil }
        guard let policy = try? NetJSON.parse(json), case .object = policy else { return nil }
        return (policy, at)
    }
}
