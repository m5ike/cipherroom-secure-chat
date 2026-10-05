// The server's device API (Android: net/Server, /api/android/*) — on iOS
// /api/ios/* (docs/ios-server.md § 3) with the same semantics: every request after enrolment is
// signed with the device key ("m5android/1|METHOD|path?query|time|nonce|
// b64(sha256(body))", P1363 — DeviceSigning), the policy is signed per device
// (SignedDevicePolicy), control messages and bundles are sealed for the
// device's encryption key (ECIES, EciesOpener).
//
//   GET  /info                 public: the server's key, enrolment mode, push settings
//   POST /enroll               register this device (its keys, proof of holding them, a code if required)
//   POST /checkin        (s)   state → policy, pending commands, the newest bundle / release
//   POST /ack            (s)   the outcome of a command
//   POST /notify         (s)   { token, on } wake this device for the signed-in account
//   POST /events         (s)   security and update events (also signed long ago: after a wipe)
//   POST /message-audit  (s)   a message hidden or deleted in the app's own view
//   POST /location       (s)   positions, when the user and the policy allow it
//   GET  /bundles/:id    (s)   a published design build, its key wrapped for this device
//   GET  /releases/:id   (s)   a release record and the server's signature over it

import Foundation
import M5Core
import M5Crypto

public enum DevicePlatform: String, Sendable {
    case ios, android
}

/// Where and how the device API is reached. The defaults are the iOS API with Android's signatures.
public struct DeviceAPIConfig: Sendable {
    /// "/api/ios" (Android: "/api/android").
    public var prefix: String
    /// Which app's fields the bodies carry (iOS: apnsToken / voipToken / apnsEnv, osVersion, idiom, modelName;
    /// Android: fcmToken, sdk, manufacturer).
    public var platform: DevicePlatform
    /// The label of a signed request (server/mobile/crypto.ts requestSignedString — the same on both platforms).
    public var requestLabel: String
    /// The label of the enrolment proof (enrollSignedString).
    public var enrollLabel: String

    public init(prefix: String = "/api/ios", platform: DevicePlatform = .ios, requestLabel: String = DeviceSigning.requestLabel,
                enrollLabel: String = DeviceSigning.enrollLabel) {
        self.prefix = prefix
        self.platform = platform
        self.requestLabel = requestLabel
        self.enrollLabel = enrollLabel
    }

    public static let ios = DeviceAPIConfig()
    public static let android = DeviceAPIConfig(prefix: "/api/android", platform: .android)
}

/// The push tokens a device reports (enroll, check-in). nil: not reported (the server keeps what it has);
/// "": the user turned notifications off (the server forgets the token).
public struct PushTokens: Sendable, Equatable {
    /// iOS: the APNs device token (hex); Android: the FCM token.
    public var token: String?
    /// iOS: the PushKit (VoIP) token, hex.
    public var voip: String?
    /// iOS: "production" or "sandbox" (the aps-environment entitlement).
    public var apnsEnv: String?

    public init(token: String? = nil, voip: String? = nil, apnsEnv: String? = nil) {
        self.token = token
        self.voip = voip
        self.apnsEnv = apnsEnv
    }

    /// A device token as hex (what the server keeps).
    public static func hex(_ deviceToken: Data) -> String { Bytes.hex(deviceToken) }

    func add(to o: inout [String: NetJSON], platform: DevicePlatform) {
        switch platform {
        case .ios:
            if let token { o["apnsToken"] = .string(token) }
            if let voip { o["voipToken"] = .string(voip) }
            if let apnsEnv { o["apnsEnv"] = .string(apnsEnv) }
        case .android:
            if let token { o["fcmToken"] = .string(token) }
        }
    }
}

/// The server's signing key as /info and /enroll present it.
public struct ServerKeyInfo: Sendable, Equatable {
    public let kid: String
    public let publicKey: String
    public let fingerprint: String
    init(_ j: NetJSON?) {
        kid = j?.str("kid") ?? ""
        publicKey = j?.str("publicKey") ?? ""
        fingerprint = j?.str("fingerprint") ?? ""
    }
}

/// GET /info.
public struct DeviceServerInfo: Sendable {
    public let name: String
    /// "ios" (the Android API does not say).
    public let platform: String
    public let version: String
    public let protocolVersion: Int64
    /// "open", "code" or "closed".
    public let enrollment: String
    public let server: ServerKeyInfo
    public let minAppCode: Int64
    /// iOS: the oldest build the server still serves (below it the app asks for an update first).
    public let minBuild: Int64
    public let bundleId: String
    /// iOS: { appStore, testFlight } links (null when not set).
    public let store: NetJSON?
    /// The push settings the server hands out (iOS `apns`: {topic, environment, voipTopic}; Android `fcm`), nil when none.
    public let push: NetJSON?
    public let raw: NetJSON

    public init(_ j: NetJSON) {
        name = j.str("name")
        platform = j.str("platform")
        version = j.str("version")
        protocolVersion = j.int("protocol")
        enrollment = j.str("enrollment")
        server = ServerKeyInfo(j.obj("server"))
        minAppCode = j.int("minAppCode")
        minBuild = j.int("minBuild")
        bundleId = j.str("bundleId", j.str("packageName"))
        store = j.obj("store")
        push = DeviceServerInfo.pushSettings(j)
        raw = j
    }

    static func pushSettings(_ j: NetJSON) -> NetJSON? {
        for k in ["apns", "fcm"] { if let v = j.obj(k) { return v } }
        return nil
    }
}

/// What this device says about itself at enrolment and check-in.
public struct DeviceDescription: Sendable {
    public var name: String
    /// The hardware identifier ("iPhone17,1").
    public var model: String
    /// The marketing name ("iPhone 17 Pro").
    public var modelName: String
    /// "phone", "pad", "watch", "mac", "vision", "tv".
    public var idiom: String
    /// "iOS", "iPadOS", "watchOS".
    public var os: String
    /// "26.0".
    public var osVersion: String
    public var appVersion: String
    /// The build: major·10000 + minor·100 + patch (6.14.0 → 61400).
    public var appCode: Int
    public var locale: String
    /// Android only: the SDK level and the manufacturer.
    public var sdk: Int
    public var manufacturer: String

    public init(name: String, model: String, modelName: String = "", idiom: String = "phone", os: String = "iOS", osVersion: String,
                appVersion: String = M5NetInfo.defaultVersion, appCode: Int = M5NetInfo.defaultCode, locale: String, sdk: Int = 0, manufacturer: String = "Apple") {
        self.name = name
        self.model = model
        self.modelName = modelName
        self.idiom = idiom
        self.os = os
        self.osVersion = osVersion
        self.appVersion = appVersion
        self.appCode = appCode
        self.locale = locale
        self.sdk = sdk
        self.manufacturer = manufacturer
    }

    /// The fields a body carries for `platform` (enroll: all; check-in: the ones that can change).
    func fields(_ platform: DevicePlatform, enroll: Bool) -> [String: NetJSON] {
        var o: [String: NetJSON] = ["appVersion": .string(appVersion), "appCode": .int(Int64(appCode)), "locale": .string(locale)]
        switch platform {
        case .ios:
            o["os"] = .string(os)
            o["osVersion"] = .string(osVersion)
            if enroll {
                o["name"] = .string(name)
                o["model"] = .string(model)
                o["modelName"] = .string(modelName)
                o["idiom"] = .string(idiom)
            }
        case .android:
            o["sdk"] = .int(Int64(sdk))
            if enroll {
                o["name"] = .string(name)
                o["model"] = .string(model)
                o["manufacturer"] = .string(manufacturer)
                o["os"] = .string("\(os) \(osVersion)")
            }
        }
        return o
    }
}

/// A request signed now and sent later (Android: events stored before a wipe — the server accepts a 30-day skew).
public struct PresignedRequest: Sendable, Codable, Equatable {
    public let method: String
    public let url: String
    public let headers: [String: String]
    public let body: Data
}

/// This enrolled device: the server, its id there, its signing key.
public struct DeviceCredentials: Sendable {
    public let server: String
    public let deviceId: String
    public let signer: any RequestSigner
    public init(server: String, deviceId: String, signer: any RequestSigner) {
        self.server = server
        self.deviceId = deviceId
        self.signer = signer
    }
}

public struct DeviceAPIClient: Sendable {
    public let http: HTTPClient
    public let config: DeviceAPIConfig
    public let clock: NetClock

    public init(http: HTTPClient = HTTPClient(), config: DeviceAPIConfig = .ios, clock: NetClock = .system) {
        self.http = http
        self.config = config
        self.clock = clock
    }

    /* -------------------------------------------------------- unsigned */

    /// GET /info (public).
    public func info(base: String) async throws -> DeviceServerInfo {
        DeviceServerInfo(try await http.json("GET", try HTTPClient.url(normalizeServer(base), config.prefix + "/info"), maxBytes: 1 << 20))
    }

    /// POST /enroll: this device's keys and the proof that it holds the signing key.
    public func enroll(base: String, code: String, device: DeviceDescription, push: PushTokens, signer: any RequestSigner, encKey: String) async throws -> NetJSON {
        let signKey = try await signer.publicKeySPKI()
        let time = clock.now()
        let proof = try await signer.signP1363(Data(DeviceSigning.enrollString(label: config.enrollLabel, signKey: signKey, encKey: encKey, time: time).utf8))
        var o = device.fields(config.platform, enroll: true)
        o["code"] = .string(code)
        o["signKey"] = .string(signKey)
        o["encKey"] = .string(encKey)
        o["time"] = .int(time)
        o["proof"] = .string(Bytes.b64(proof))
        push.add(to: &o, platform: config.platform)
        return try await http.json("POST", try HTTPClient.url(normalizeServer(base), config.prefix + "/enroll"), body: .object(o), maxBytes: 1 << 20)
    }

    /* ---------------------------------------------------------- signed */

    /// The path the server sees (`originalUrl`): the server address's own path (a prefix) + the API path.
    func signedPath(_ server: String, _ path: String) -> String {
        let basePath = URLComponents(string: server)?.percentEncodedPath ?? ""
        return basePath + path
    }

    /// A signed request; the answer's body (2xx) or HTTPError.
    public func signed(_ device: DeviceCredentials, _ method: String, _ path: String, body: NetJSON? = nil, maxBytes: Int = 1 << 20,
                       progress: HTTPProgress? = nil) async throws -> Data {
        let raw = body?.data ?? Data()
        let headers = try await DeviceSigning.headers(deviceId: device.deviceId, method: method, pathAndQuery: signedPath(device.server, path),
                                                      body: raw, time: clock.now(), signer: device.signer, label: config.requestLabel)
        return try await http.send(method, try HTTPClient.url(device.server, path), body: method == "GET" ? nil : raw, headers: headers,
                                   maxBytes: maxBytes, progress: progress)
    }

    /// Signs a request now for sending later (`time`: when it is signed).
    public func presign(_ device: DeviceCredentials, _ method: String, _ path: String, body: NetJSON?) async throws -> PresignedRequest {
        let raw = body?.data ?? Data()
        var headers = try await DeviceSigning.headers(deviceId: device.deviceId, method: method, pathAndQuery: signedPath(device.server, path),
                                                      body: raw, time: clock.now(), signer: device.signer, label: config.requestLabel)
        headers["Content-Type"] = "application/json"
        return PresignedRequest(method: method, url: device.server + path, headers: headers, body: raw)
    }

    /// Sends a presigned request as it was signed.
    public func send(_ p: PresignedRequest) async throws -> Data {
        guard let url = URL(string: p.url) else { throw NetError.invalid("not a URL: \(p.url)") }
        return try await http.send(p.method, url, body: p.method == "GET" ? nil : p.body, headers: p.headers)
    }

    private func signedJSON(_ device: DeviceCredentials, _ method: String, _ path: String, body: NetJSON? = nil, maxBytes: Int = 1 << 20) async throws -> NetJSON {
        try HTTPClient.object(try await signed(device, method, path, body: body, maxBytes: maxBytes))
    }

    /// POST /checkin (the body: CheckinReport.body).
    public func checkin(_ device: DeviceCredentials, body: NetJSON) async throws -> NetJSON {
        try await signedJSON(device, "POST", config.prefix + "/checkin", body: body, maxBytes: 4 << 20)
    }

    /// POST /ack: the outcome of a command.
    @discardableResult
    public func ack(_ device: DeviceCredentials, id: String, ok: Bool, result: NetJSON?, error: String?) async throws -> NetJSON {
        try await signedJSON(device, "POST", config.prefix + "/ack",
                             body: ["id": .string(id), "ok": .bool(ok), "result": result ?? .null, "error": .string(error ?? "")])
    }

    /// POST /notify: the device and the account's session together — wake this device for the account (or no longer).
    @discardableResult
    public func notify(_ device: DeviceCredentials, on: Bool, token: String?) async throws -> NetJSON {
        var body: NetJSON = ["on": .bool(on)]
        if on, let token { body = body.with("token", .string(token)) }
        return try await signedJSON(device, "POST", config.prefix + "/notify", body: body, maxBytes: 64 * 1024)
    }

    /// POST /events: up to 100 events ({id, type, at, detail}); answers how many the server stored.
    @discardableResult
    public func events(_ device: DeviceCredentials, _ events: [DeviceEvent]) async throws -> Int64 {
        try await signedJSON(device, "POST", config.prefix + "/events", body: ["events": .array(events.prefix(100).map(\.json))]).int("stored")
    }

    /// The events request signed now, to be sent later (after a wipe the key is gone).
    public func presignEvents(_ device: DeviceCredentials, _ events: [DeviceEvent]) async throws -> PresignedRequest {
        try await presign(device, "POST", config.prefix + "/events", body: ["events": .array(events.prefix(100).map(\.json))])
    }

    /// POST /message-audit: messages hidden or deleted in the app's own view (never their content).
    @discardableResult
    public func messageAudit(_ device: DeviceCredentials, actions: [NetJSON], account: String?) async throws -> Int64 {
        var body: NetJSON = ["actions": .array(Array(actions.prefix(50)))]
        if let account, !account.isEmpty { body = body.with("account", .string(account)) }
        return try await signedJSON(device, "POST", config.prefix + "/message-audit", body: body).int("recorded")
    }

    /// POST /location: up to 100 points. 403 location-off when the server keeps no positions.
    public func location(_ device: DeviceCredentials, points: [LocationPoint]) async throws -> (stored: Int64, minSeconds: Int64) {
        let a = try await signedJSON(device, "POST", config.prefix + "/location", body: ["points": .array(points.prefix(100).map(\.json))])
        return (a.int("stored"), a.int("minSeconds"))
    }

    /// GET /bundles/:id — the raw .m5ab file (DesignBundleFile parses and verifies it).
    public func bundle(_ device: DeviceCredentials, id: String, progress: HTTPProgress? = nil) async throws -> Data {
        try await signed(device, "GET", config.prefix + "/bundles/" + id, maxBytes: 80 << 20, progress: progress)
    }

    /// GET /releases/:id — { release, signed, signature, kid } (ReleaseWatcher verifies it).
    public func release(_ device: DeviceCredentials, id: String) async throws -> NetJSON {
        try await signedJSON(device, "GET", config.prefix + "/releases/" + id)
    }
}

/* ---------------------------------------------------------------- models */

/// One event for POST /events (server/android/routes.ts EVENT_TYPES): `id` 8–64 of [A-Za-z0-9_-], unique per device.
public struct DeviceEvent: Sendable, Equatable, Codable {
    public let id: String
    public let type: String
    public let at: Millis
    public let detail: NetJSON

    public init(id: String = Bytes.b64url(Bytes.random(12)), type: String, at: Millis, detail: NetJSON = .object([:])) {
        self.id = id
        self.type = type
        self.at = at
        self.detail = detail
    }

    public var json: NetJSON { ["id": .string(id), "type": .string(type), "at": .int(at), "detail": detail] }

    /// The kinds the server keeps (anything else is dropped there).
    public static let knownTypes: Set<String> = [
        "unlock-failed", "lockout", "wipe", "remote-wipe", "integrity", "key-invalidated", "unlock", "bundle-installed", "bundle-failed",
        "bundle-rollback", "update-available", "update-installed", "update-failed", "crash", "push-received", "log",
    ]
}

/// One position for POST /location.
public struct LocationPoint: Sendable, Equatable {
    public var at: Millis
    public var lat: Double
    public var lon: Double
    public var acc: Double
    public var alt: Double?
    public var speed: Double?
    public var heading: Double?

    public init(at: Millis, lat: Double, lon: Double, acc: Double, alt: Double? = nil, speed: Double? = nil, heading: Double? = nil) {
        self.at = at
        self.lat = lat
        self.lon = lon
        self.acc = acc
        self.alt = alt
        self.speed = speed
        self.heading = heading
    }

    public var json: NetJSON {
        .compact(["at": .int(at), "lat": .double(lat), "lon": .double(lon), "acc": .double(acc),
                  "alt": alt.map { .double($0) }, "speed": speed.map { .double($0) }, "heading": heading.map { .double($0) }])
    }
}
