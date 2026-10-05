// Port of A/push/Checkin.java (the network part): this device's state to the
// server, and back the policy (signed — DeviceState.apply), pending control
// messages, the newest design bundle and release, the oldest build still
// served. The app runs it when it comes to the front (at most every 5
// minutes, CheckinSchedule), after a silent push says "update"/"config", and
// from a background refresh task (BGAppRefresh; the policy's interval is only
// the shortest — iOS decides when).

import Foundation

/// The device state a check-in reports (server/mobile/device-api.ts sanitizeState). The app fills it.
public struct DeviceStatusReport: Sendable, Equatable {
    /// 0–100, -1 unknown.
    public var battery: Int
    public var charging: Bool
    /// "wifi", "cellular", "ethernet", "other", "none".
    public var network: String
    public var locked: Bool
    public var rooms: Int
    /// The active design bundle: {id, version, state}.
    public var bundle: NetJSON?
    /// How the server reaches this device: "apns" or "poll" (Android: "fcm" / "poll").
    public var push: String
    /// "biometric", "pin" or "none".
    public var lockMode: String
    public var failedAttempts: Int
    public var storage: Int64
    public var permissions: [String]
    /// iOS: the time of the signed policy in force (DeviceState.policyAt).
    public var policyAt: Millis?
    /// iOS: "faceID", "touchID", "opticID" or "none".
    public var biometry: String?

    public init(battery: Int = -1, charging: Bool = false, network: String = "other", locked: Bool = false, rooms: Int = 0, bundle: NetJSON? = nil,
                push: String = "poll", lockMode: String = "none", failedAttempts: Int = 0, storage: Int64 = 0, permissions: [String] = [],
                policyAt: Millis? = nil, biometry: String? = nil) {
        self.battery = battery
        self.charging = charging
        self.network = network
        self.locked = locked
        self.rooms = rooms
        self.bundle = bundle
        self.push = push
        self.lockMode = lockMode
        self.failedAttempts = failedAttempts
        self.storage = storage
        self.permissions = permissions
        self.policyAt = policyAt
        self.biometry = biometry
    }

    public var json: NetJSON {
        .compact([
            "battery": .int(Int64(battery)), "charging": .bool(charging), "network": .string(network), "locked": .bool(locked),
            "rooms": .int(Int64(rooms)), "bundle": bundle ?? .null, "push": .string(push), "lockMode": .string(lockMode),
            "failedAttempts": .int(Int64(failedAttempts)), "storage": .int(storage), "permissions": .strings(permissions),
            "policyAt": policyAt.map { .int($0) }, "biometry": biometry.map { .string($0) },
        ])
    }
}

/// What a check-in brought.
public struct CheckinResult: Sendable {
    public let policy: DeviceState.PolicyOutcome
    /// Control messages in their wire form (ControlInbox handles them like a push).
    public let commands: [NetJSON]
    /// A design bundle newer than the app has, nil when none.
    public let bundle: BundleOffer?
    /// A release record for this device, nil when none.
    public let release: ReleaseRecord?
    /// "apns" / "fcm" / "poll": how the server will reach this device.
    public let push: String
    /// iOS: the oldest build the server serves; `updateRequired`: this app is below it (ask for the update first).
    public let minBuild: Int64
    public let updateRequired: Bool
    /// The server's clock at the answer (ms), for a skew warning.
    public let serverTime: Millis
    public let raw: NetJSON
}

public enum CheckinError: Error, Sendable, Equatable {
    /// 403 device-…: the operator revoked, blocked or wiped this device (`status` after "device-").
    case device(status: String)
}

public enum Checkin {
    /// The body of POST /checkin (Checkin.run; docs/ios-server.md § 3).
    public static func body(device: DeviceDescription, status: DeviceStatusReport, push: PushTokens, config: DeviceAPIConfig) -> NetJSON {
        var o = device.fields(config.platform, enroll: false)
        o["state"] = status.json
        push.add(to: &o, platform: config.platform)
        return .object(o)
    }

    /// One check-in: reports, applies the answer to `state` (the caller saves it), returns what came.
    /// HTTPError 403 device-… becomes CheckinError.device.
    public static func run(client: DeviceAPIClient, credentials: DeviceCredentials, state: inout DeviceState, device: DeviceDescription,
                           status: DeviceStatusReport, push: PushTokens) async throws -> CheckinResult {
        let answer: NetJSON
        do {
            answer = try await client.checkin(credentials, body: body(device: device, status: status, push: push, config: client.config))
        } catch let e as HTTPError where e.status == 403 && e.code.hasPrefix("device-") {
            throw CheckinError.device(status: String(e.code.dropFirst("device-".count)))
        }
        let policy = state.apply(serverAnswer: answer)
        let bundle = answer.obj("bundle").map(BundleOffer.init)
        let release = answer.obj("release").map(ReleaseRecord.init)
        return CheckinResult(policy: policy, commands: answer.arr("commands") ?? [], bundle: bundle, release: release, push: answer.str("push"),
                             minBuild: answer.int("minBuild"), updateRequired: answer.bool("updateRequired"), serverTime: answer.int("time"), raw: answer)
    }
}

/// When a check-in is due (Checkin.runIfDue): in the foreground at most every 5 minutes, forced by a push.
public struct CheckinSchedule: Sendable {
    public private(set) var lastAt: Millis = 0
    public let minGapMs: Millis
    public init(minGapMs: Millis = 5 * 60_000) { self.minGapMs = minGapMs }
    public func due(now: Millis, force: Bool = false) -> Bool { force || now - lastAt > minGapMs }
    public mutating func ran(at now: Millis) { lastAt = now }
    /// The background interval: 12 h with push, the policy's poll interval without.
    public static func backgroundInterval(state: DeviceState, pushEnabled: Bool) -> Int { pushEnabled ? 12 * 3600 : state.pollSeconds }
}
