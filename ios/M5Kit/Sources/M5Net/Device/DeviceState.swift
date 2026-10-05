// What the app knows about its server and itself (Android: core/Config, the
// system tier's "config" record): the server's address and pinned key, this
// device's id there, the policy as the server signed it, the poll interval,
// the push settings. Kept as one JSON document with Android's field names, in
// a store readable while the app is locked (the policy decides the lock).
//
// The enrolment (Android: ui/parts/Forms.submit + Config.enrolled): /info, the
// pins against the server's key itself (ServerKeyPin), /enroll, the same key
// in its answer, the signed policy.

import Foundation

public struct DeviceState: Sendable, Equatable {
    public var server: String
    public var deviceId: String
    public var serverKey: String
    public var serverKid: String
    /// Computed here from the key, never taken from the server.
    public var serverFingerprint: String
    /// The policy as the pinned key signed it ({} before the first one).
    public var policy: NetJSON
    /// The signed policy's time: an older one is never applied (replay).
    public var policyAt: Millis
    public var pollSecondsRaw: Int
    /// The server's push settings (Android `fcm`; iOS `apns`), nil when it has none.
    public var push: NetJSON?
    /// Everything else of the record, kept as it was (UI choices the app stores next to it).
    public var extra: [String: NetJSON]

    public init(server: String = "", deviceId: String = "", serverKey: String = "", serverKid: String = "", serverFingerprint: String = "",
                policy: NetJSON = .object([:]), policyAt: Millis = 0, pollSecondsRaw: Int = 1800, push: NetJSON? = nil, extra: [String: NetJSON] = [:]) {
        self.server = server
        self.deviceId = deviceId
        self.serverKey = serverKey
        self.serverKid = serverKid
        self.serverFingerprint = serverFingerprint
        self.policy = policy
        self.policyAt = policyAt
        self.pollSecondsRaw = pollSecondsRaw
        self.push = push
        self.extra = extra
    }

    public var enrolled: Bool { !deviceId.isEmpty && !serverKey.isEmpty }
    /// At least 15 minutes (Android: max(900, pollSeconds)).
    public var pollSeconds: Int { max(900, pollSecondsRaw) }
    public var lockPolicy: NetJSON { policy.obj("lock") ?? .object([:]) }
    /// The policy's room limit (rooms.max, 1–16, default 8).
    public var maxRooms: Int {
        guard let r = policy.obj("rooms") else { return 8 }
        return max(1, min(16, Int(r.int("max", 8))))
    }

    /// The record as Android keeps it.
    public var json: NetJSON {
        var o = extra
        o["server"] = .string(server)
        o["deviceId"] = .string(deviceId)
        o["serverKey"] = .string(serverKey)
        o["serverKid"] = .string(serverKid)
        o["serverFingerprint"] = .string(serverFingerprint)
        o["policy"] = policy
        o["policyAt"] = .int(policyAt)
        o["pollSeconds"] = .int(Int64(pollSecondsRaw))
        o["push"] = push ?? .null
        return .object(o)
    }

    public init(json j: NetJSON) {
        var rest = j.objectValue ?? [:]
        for k in ["server", "deviceId", "serverKey", "serverKid", "serverFingerprint", "policy", "policyAt", "pollSeconds", "push", "fcm"] { rest.removeValue(forKey: k) }
        self.init(server: j.str("server"), deviceId: j.str("deviceId"), serverKey: j.str("serverKey"), serverKid: j.str("serverKid"),
                  serverFingerprint: j.str("serverFingerprint"), policy: j.obj("policy") ?? .object([:]), policyAt: j.int("policyAt"),
                  pollSecondsRaw: Int(j.int("pollSeconds", 1800)), push: j.obj("push") ?? j.obj("fcm"), extra: rest)
    }

    /// What applying a server answer did with its policy.
    public enum PolicyOutcome: Sendable, Equatable {
        /// A newer policy signed by the pinned key for this device is in force now.
        case applied(at: Millis)
        /// The answer had a policy without a valid signature (or an older one): ignored, the old one stays.
        case ignored(reason: String)
        /// The answer carried no policy.
        case none
    }

    /// Policy, poll interval and push settings from an enrolment or a check-in (Config.applyServerAnswer).
    /// The policy only as the pinned server key signed it for this device, and never an older one.
    @discardableResult
    public mutating func apply(serverAnswer answer: NetJSON) -> PolicyOutcome {
        var outcome = PolicyOutcome.none
        let signed = answer.obj("policySigned")
        if let opened = SignedDevicePolicy.open(signed, serverKey: serverKey, deviceId: deviceId, lastAt: policyAt) {
            policy = opened.policy
            policyAt = opened.at
            outcome = .applied(at: opened.at)
        } else if signed != nil || answer["policy"] != nil {
            outcome = .ignored(reason: signed == nil ? "an unsigned policy was ignored" : "a policy with a bad or old signature was ignored")
        }
        if let p = answer["pollSeconds"], let n = p.int64Value { pollSecondsRaw = Int(n) } else if answer["pollSeconds"] != nil { pollSecondsRaw = 1800 }
        if let p = DeviceServerInfo.pushSettings(answer) { push = p } else if answer["fcm"] != nil || answer["apns"] != nil { push = nil }
        return outcome
    }

    /// Persists under `key` ("config", as Android's record).
    public func save(to store: any NetStateStore, key: String = "config") async { await store.save(key, json) }

    public static func load(from store: any NetStateStore, key: String = "config") async -> DeviceState? {
        guard let j = await store.load(key), case .object = j else { return nil }
        return DeviceState(json: j)
    }
}

/* ------------------------------------------------------------- enrolment */

public enum DeviceEnrollment {
    /// Enrols this device: /info, the server's key against the pins (the build's pinned key, the QR code's kid —
    /// empty: trust on first use), /enroll, the same key in its answer, the signed policy. Returns the new state
    /// (the caller stores it). Throws NetError.security when a pin or the key does not hold, HTTPError when the
    /// server refuses (closed, bad-code, clock, device-…).
    public static func enroll(base rawBase: String, code: String, device: DeviceDescription, pushToken: String?, pins: [String?],
                              signer: any RequestSigner, encKey: String, client: DeviceAPIClient) async throws -> DeviceState {
        let base = normalizeServer(rawBase)
        let info = try await client.info(base: base)
        // 6.7 (audit V6): the pins bind the server's public key itself — its hash — not the kid string it sends.
        try ServerKeyPin.check(publicKey: info.server.publicKey, statedKid: info.server.kid, pins: pins)
        let answer = try await client.enroll(base: base, code: code, device: device, pushToken: pushToken, signer: signer, encKey: encKey)
        let answered = ServerKeyInfo(answer.obj("server"))
        try ServerKeyPin.same(checked: info.server.publicKey, answered: answered.publicKey, answeredKid: answered.kid)
        let deviceId = answer.str("deviceId")
        guard !deviceId.isEmpty else { throw NetError.badAnswer("the enrolment answer has no device id") }
        var state = DeviceState(server: base, deviceId: deviceId, serverKey: answered.publicKey, serverKid: answered.kid,
                                serverFingerprint: P256Keys.fingerprint(spki: answered.publicKey))
        state.apply(serverAnswer: answer)
        return state
    }

    /// The credentials of an enrolled device for the signed calls.
    public static func credentials(_ state: DeviceState, signer: any RequestSigner) throws -> DeviceCredentials {
        guard state.enrolled else { throw NetError.unavailable("this device is not enrolled") }
        return DeviceCredentials(server: state.server, deviceId: state.deviceId, signer: signer)
    }
}
