// ICE servers for WebRTC from /api/turn (Android rtc/Rtc.iceServers;
// server/turn.ts, turn-gate.ts):
//
//   { ok, configured, mode: "ephemeral" | "static" | "none", iceServers: [{urls, username?, credential?}],
//     ttlSeconds?, expiresAt?, pending? }
//
// 6.12 (F-28): the server hands TURN credentials only to an address with a
// live hub WebSocket that joined a room; before that it answers STUN only with
// `pending: true` — such an answer is NEVER cached, so the next peer
// connection asks again, by then over a connected room. A full answer is kept
// 10 minutes, or the TURN credentials' lifetime less a minute.

import Foundation

public struct IceServer: Sendable, Equatable {
    public let urls: [String]
    public let username: String?
    public let credential: String?
    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }
}

public struct TurnAnswer: Sendable, Equatable {
    public let iceServers: [IceServer]
    public let pending: Bool
    public let ttlSeconds: Int64
    public let expiresAt: Millis
    public let mode: String
    public let configured: Bool

    public init(_ j: NetJSON) {
        iceServers = (j.arr("iceServers") ?? []).compactMap { s in
            let urls: [String]
            if let list = s.arr("urls") { urls = list.compactMap(\.stringValue) } else if let one = s["urls"]?.stringValue { urls = [one] } else { urls = [] }
            guard !urls.isEmpty else { return nil }
            return IceServer(urls: urls, username: s["username"]?.stringValue, credential: s["credential"]?.stringValue)
        }
        pending = j.bool("pending")
        ttlSeconds = j.int("ttlSeconds")
        expiresAt = j.int("expiresAt")
        mode = j.str("mode")
        configured = j.bool("configured")
    }

    /// How long an answer may be reused (Rtc.cacheUntil): never when pending (0), else the credentials' lifetime
    /// less a minute (ttl > 120 s), else 10 minutes.
    public static func cacheUntil(_ answer: NetJSON?, now: Millis) -> Millis {
        guard let answer, !answer.bool("pending") else { return 0 }
        let ttl = answer.int("ttlSeconds")
        return ttl > 120 ? now + (ttl - 60) * 1000 : now + 10 * 60_000
    }
}

/// The ICE servers for the next peer connection, cached as Rtc does.
public actor IceServerCache {
    public static let fallback = [IceServer(urls: ["stun:stun.l.google.com:19302"])]
    private let base: String
    private let http: HTTPClient
    private let clock: NetClock
    private var servers: [IceServer]?
    private var until: Millis = 0

    public init(base: String, http: HTTPClient = HTTPClient(), clock: NetClock = .system) {
        self.base = base
        self.http = http
        self.clock = clock
    }

    /// The server's ICE servers (STUN, TURN with fresh credentials); the public STUN fallback when it gave none.
    public func iceServers() async -> [IceServer] {
        if let servers, clock.now() < until { return servers }
        var out: [IceServer] = []
        var next = clock.now() + 10 * 60_000
        do {
            let answer = try await http.json("GET", try HTTPClient.url(base, "/api/turn"), maxBytes: 1 << 20)
            out = TurnAnswer(answer).iceServers
            next = TurnAnswer.cacheUntil(answer, now: clock.now())
        } catch {
            // No answer: the fallback for now, asked again in 10 minutes.
        }
        if out.isEmpty { out = Self.fallback }
        servers = out
        until = next
        return out
    }

    /// 6.12: a room's hub socket joined — an answer without TURN (pending) is not reused for the calls that follow.
    public func hubConnected() {
        if until == 0 { servers = nil }
    }

    /// How many ICE servers the server gave (the settings' connection info).
    public var count: Int { servers?.count ?? 0 }
}
