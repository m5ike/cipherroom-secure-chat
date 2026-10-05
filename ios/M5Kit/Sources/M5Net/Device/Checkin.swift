// Port of A/push/Checkin.java (the network part): this device's state to the
// server, and back the policy (signed — DeviceState.apply), pending control
// messages, the newest design bundle and release. The app runs it when it
// comes to the front (at most every 5 minutes, CheckinSchedule), after a
// silent push says "update", and from a background refresh task at the
// policy's interval.

import Foundation

/// The device state a check-in reports (server/android/routes.ts sanitizeState). The app fills it.
public struct DeviceStatusReport: Sendable, Equatable {
    /// 0–100, -1 unknown.
    public var battery: Int
    public var charging: Bool
    /// "wifi", "cellular", "ethernet", "other", "none".
    public var network: String
    public var locked: Bool
    public var rooms: Int
    /// The active design bundle: {id, version, state} (BundleState.report).
    public var bundle: NetJSON?
    /// How the server reaches this device: "apns", "poll" or "none" (Android: "fcm" / "poll").
    public var push: String
    /// "biometric", "pin" or "none".
    public var lockMode: String
    public var failedAttempts: Int
    public var storage: Int64
    public var permissions: [String]

    public init(battery: Int = -1, charging: Bool = false, network: String = "other", locked: Bool = false, rooms: Int = 0, bundle: NetJSON? = nil,
                push: String = "none", lockMode: String = "none", failedAttempts: Int = 0, storage: Int64 = 0, permissions: [String] = []) {
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
    }

    public var json: NetJSON {
        .compact([
            "battery": .int(Int64(battery)), "charging": .bool(charging), "network": .string(network), "locked": .bool(locked),
            "rooms": .int(Int64(rooms)), "bundle": bundle, "push": .string(push), "lockMode": .string(lockMode),
            "failedAttempts": .int(Int64(failedAttempts)), "storage": .int(storage), "permissions": .strings(permissions),
        ])
    }
}

/// What a check-in brought.
public struct CheckinResult: Sendable {
    public let policy: DeviceState.PolicyOutcome
    /// Control messages in their wire form (ControlInbox handles them like a push).
    public let commands: [NetJSON]
    /// A design bundle newer than the app has (BundleOffer), nil when none.
    public let bundle: BundleOffer?
    /// A release record for this platform, nil when none.
    public let release: ReleaseRecord?
    /// "apns" / "fcm" / "poll": how the server will reach this device.
    public let push: String
    /// The server's clock at the answer (ms), for a skew warning.
    public let serverTime: Millis
    public let raw: NetJSON
}

public enum CheckinError: Error, Sendable, Equatable {
    /// 403 device-…: the operator revoked, blocked or wiped this device (`status` after "device-").
    case device(status: String)
}

public enum Checkin {
    /// The body of POST /checkin (Checkin.run).
    public static func body(device: DeviceDescription, status: DeviceStatusReport, pushToken: String?, config: DeviceAPIConfig) -> NetJSON {
        var o: [String: NetJSON] = [
            "appVersion": .string(device.appVersion), "appCode": .int(Int64(device.appCode)), "sdk": .int(Int64(device.sdk)),
            "os": .string(device.os), "locale": .string(device.locale), "state": status.json,
        ]
        if let pushToken, !pushToken.isEmpty { o[config.pushTokenField] = .string(pushToken) }
        return .object(o)
    }

    /// One check-in: reports, applies the answer to `state` (the caller saves it), returns what came.
    /// HTTPError 403 device-… becomes CheckinError.device.
    public static func run(client: DeviceAPIClient, credentials: DeviceCredentials, state: inout DeviceState, device: DeviceDescription,
                           status: DeviceStatusReport, pushToken: String?) async throws -> CheckinResult {
        let answer: NetJSON
        do {
            answer = try await client.checkin(credentials, body: body(device: device, status: status, pushToken: pushToken, config: client.config))
        } catch let e as HTTPError where e.status == 403 && e.code.hasPrefix("device-") {
            throw CheckinError.device(status: String(e.code.dropFirst("device-".count)))
        }
        let policy = state.apply(serverAnswer: answer)
        let bundle = answer.obj("bundle").map(BundleOffer.init)
        let release = answer.obj("release").map(ReleaseRecord.init)
        return CheckinResult(policy: policy, commands: answer.arr("commands") ?? [], bundle: bundle, release: release,
                             push: answer.str("push"), serverTime: answer.int("time"), raw: answer)
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
