// The user's notification settings on the server (Android push/NotifyPrefs,
// the network part): which kinds, how much a notification shows, the order of
// the channels the server tries, quiet hours — sent while signed in so the
// server knows how to notify (PUT /api/account/notify); and this device's link
// to the account (the device API's POST /notify, signed by the device key and
// carrying the account's session): the server then keeps messages for it and
// wakes it with a sealed push while the app is closed. Signed out, the link
// goes. The operator's templates (GET /api/notify/config, public) are kept so
// a notification can be drawn while the app is locked (the NSE reads them).

import Foundation

/// The settings as the server keeps them (client/src/lib/notify-template.ts UserNotifyPrefs).
public struct NotifyPrefs: Sendable, Equatable {
    public static let kinds = ["message", "mention", "call", "function", "summon"]

    public var on: Bool
    public var kinds: [String: Bool]
    /// "" (the server's default) | neutral | sender | room | content.
    public var privacy: String
    /// The channels in the order the server tries them: "android" (the mobile apps — it wakes linked iOS devices
    /// too, through APNs; the id stays for users' settings), "webpush", "email".
    public var order: [String]
    public var quiet: Bool
    public var quietFrom: String
    public var quietTo: String
    /// The time zone of the quiet hours (TimeZone.current.identifier).
    public var timeZone: String
    public var lang: String

    public init(on: Bool = true, kinds: [String: Bool] = Dictionary(uniqueKeysWithValues: NotifyPrefs.kinds.map { ($0, true) }), privacy: String = "",
                order: [String], quiet: Bool = false, quietFrom: String = "22:00", quietTo: String = "07:00", timeZone: String = TimeZone.current.identifier,
                lang: String) {
        self.on = on
        self.kinds = kinds
        self.privacy = privacy
        self.order = order
        self.quiet = quiet
        self.quietFrom = quietFrom
        self.quietTo = quietTo
        self.timeZone = timeZone
        self.lang = lang
    }

    public var json: NetJSON {
        var k: [String: NetJSON] = [:]
        for kind in Self.kinds { k[kind] = .bool(kinds[kind] ?? true) }
        return ["on": .bool(on), "kinds": .object(k), "privacy": .string(privacy), "order": .strings(order),
                "quiet": ["on": .bool(quiet), "from": .string(quietFrom), "to": .string(quietTo), "tz": .string(timeZone)], "lang": .string(lang)]
    }
}

public struct NotifyClient: Sendable {
    public let base: String
    public let http: HTTPClient
    public init(base: String, http: HTTPClient = HTTPClient()) {
        self.base = normalizeServer(base)
        self.http = http
    }

    /// The operator's templates (public).
    public func config() async throws -> NetJSON {
        try await http.json("GET", try HTTPClient.url(base, "/api/notify/config"), maxBytes: 512 * 1024)
    }

    /// The user's settings to the server (signed in).
    @discardableResult
    public func putPrefs(token: String, prefs: NotifyPrefs) async throws -> NetJSON {
        try await http.json("PUT", try HTTPClient.url(base, "/api/account/notify"), body: prefs.json, headers: ["Authorization": "Bearer \(token)"], maxBytes: 256 * 1024)
    }

    /// "Send a test notification" through the account's channels: {ok, channel?, skipped?} — a refusal's body too.
    public func test(token: String) async throws -> NetJSON {
        do {
            return try await http.json("POST", try HTTPClient.url(base, "/api/account/notify/test"), body: .object([:]), headers: ["Authorization": "Bearer \(token)"],
                                       maxBytes: 256 * 1024)
        } catch let e as HTTPError where e.body.objectValue?.isEmpty == false {
            return e.body
        }
    }
}

/// Keeps this device linked to the signed-in account for wake-ups (NotifyPrefs.link): links once per session
/// token, unlinks when signed out.
public actor NotifyLink {
    private let api: DeviceAPIClient
    private var linkedToken = ""

    public init(api: DeviceAPIClient) { self.api = api }

    public var linked: Bool { !linkedToken.isEmpty }

    public enum Outcome: Sendable, Equatable { case linked, unlinked, unchanged, failed(String) }

    /// `token`: the session (nil: signed out); `wanted`: notifications and "away" are on.
    public func sync(device: DeviceCredentials, token: String?, wanted: Bool) async -> Outcome {
        let t = token ?? ""
        let on = wanted && !t.isEmpty
        if on, t == linkedToken { return .unchanged }
        if !on, linkedToken.isEmpty, t.isEmpty { return .unchanged }
        do {
            try await api.notify(device, on: on, token: on ? t : nil)
            linkedToken = on ? t : ""
            return on ? .linked : .unlinked
        } catch {
            return .failed("\(error)")
        }
    }
}
