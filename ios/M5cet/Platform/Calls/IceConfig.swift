// The ICE servers from the server's /api/turn (STUN, TURN with short-lived
// credentials), cached until shortly before the credentials expire.
//
// 6.12: the server hands TURN credentials only to an address with a live hub
// WebSocket that joined a room (server/turn-gate.ts); before that it answers
// STUN only with `pending: true` and an expiry of "now". Such an answer is
// never cached, so the next peer connection asks again — by then over a
// joined room (RoomRtc.roomJoined → RtcEngine.hubConnected drops it).
// Otherwise 10 minutes, or the TURN credentials' lifetime less a minute.
//
// 6.12 (F-15, the web's rtc.ts): "Hide my IP address" makes every peer
// connection relay-only (iceTransportPolicy relay) — only when the server
// offered a TURN server; without one the setting cannot hide anything and the
// connection stays as it was.
//
// Port of android/app/src/main/java/cz/m5cet/app/rtc/Rtc.java (iceServers,
// cacheUntil, hubConnected) + client/src/lib/rtc.ts (hasTurn, relay-only).

import Foundation

/// One ICE server as /api/turn lists it.
struct IceServerSpec: Equatable, Sendable {
    var urls: [String]
    var username: String?
    var credential: String?
}

/// An /api/turn answer.
struct TurnAnswer: Equatable, Sendable {
    var servers: [IceServerSpec]
    /// STUN only until this device's hub socket is up (never cached).
    var pending = false
    var ttlSeconds: Int64 = 0
}

/// GET /api/turn of the enrolled server — the network side (M5Net) implements it.
protocol TurnFetching: Sendable {
    /// The answer's JSON body (`{iceServers, ttlSeconds?, expiresAt?, pending?}`).
    func fetchTurn() async throws -> Data
}

enum IceConfig {
    /// The fallback for a server that offers none (or cannot be asked).
    static let publicStun = [IceServerSpec(urls: ["stun:stun.l.google.com:19302"])]
    /// How long an answer without a lifetime is reused.
    static let defaultCacheMs: Int64 = 10 * 60_000
    /// A failed ask is retried after this long at the latest (Android keeps the fallback 10 min; a
    /// shorter wait lets TURN come as soon as the server answers again).
    static let failureCacheMs: Int64 = 30_000

    static func parse(_ data: Data) -> TurnAnswer? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return parse(json: o)
    }

    static func parse(json o: [String: Any]) -> TurnAnswer {
        var out: [IceServerSpec] = []
        for case let s as [String: Any] in (o["iceServers"] as? [Any]) ?? [] {
            var urls: [String] = []
            switch s["urls"] {
            case let a as [Any]: urls = a.compactMap { $0 as? String }
            case let u as String: urls = [u]
            default: break
            }
            urls = urls.filter { !$0.isEmpty }
            if urls.isEmpty { continue }
            out.append(IceServerSpec(urls: urls, username: s["username"] as? String, credential: s["credential"] as? String))
        }
        return TurnAnswer(servers: out, pending: CallJSON.bool(o["pending"]), ttlSeconds: CallJSON.int64(o["ttlSeconds"]))
    }

    /// How long an answer may be reused (ms since 1970); 0 = never (pending, or no answer).
    static func cacheUntil(_ answer: TurnAnswer?, now: Int64) -> Int64 {
        guard let answer, !answer.pending else { return 0 }
        return answer.ttlSeconds > 120 ? now + (answer.ttlSeconds - 60) * 1000 : now + defaultCacheMs
    }

    /// Does this list hold a TURN server (turn: / turns:)?
    static func hasTurn(_ servers: [IceServerSpec]) -> Bool {
        servers.contains { $0.urls.contains { $0.lowercased().hasPrefix("turn:") || $0.lowercased().hasPrefix("turns:") } }
    }

    /// Relay-only when the person asked for it and the server offered TURN.
    static func relayOnly(requested: Bool, servers: [IceServerSpec]) -> Bool { requested && hasTurn(servers) }
}

/// The cached servers (one for the app — RtcEngine.ice).
@MainActor
final class IceConfigCache {
    var source: (any TurnFetching)?
    private let fallback: [IceServerSpec]
    private let now: () -> Int64
    private var servers: [IceServerSpec]?
    private var until: Int64 = 0
    /// The cached list is a STUN-only stand-in (pending or failed): a joined hub drops it.
    private var provisional = true
    private var inFlight: Task<[IceServerSpec], Never>?

    init(source: (any TurnFetching)? = nil, fallback: [IceServerSpec] = IceConfig.publicStun,
         now: @escaping () -> Int64 = { CallTrack.millis() }) {
        self.source = source
        self.fallback = fallback
        self.now = now
    }

    /// How many ICE servers the server gave (the settings' connection info).
    var count: Int { servers?.count ?? 0 }
    /// Whether the last answer offered TURN (the "Hide my IP address" setting can work).
    var turnOffered: Bool { IceConfig.hasTurn(servers ?? []) }

    /// The servers for a new peer connection: cached while fresh, asked once at a time otherwise.
    func current() async -> [IceServerSpec] {
        if let servers, now() < until { return servers }
        if let inFlight { return await inFlight.value }
        let task = Task { @MainActor [source, fallback, now] () -> [IceServerSpec] in
            var out: [IceServerSpec] = []
            var until: Int64 = now() + IceConfig.failureCacheMs
            var provisional = true
            if let source {
                do {
                    let data = try await source.fetchTurn()
                    if let answer = IceConfig.parse(data) {
                        out = answer.servers
                        until = IceConfig.cacheUntil(answer, now: now())
                        provisional = answer.pending
                        if until == 0 { CallLog.info("STUN only until this device's hub socket is up (pending)") }
                    }
                } catch {
                    CallLog.error("no ICE servers from the server: \(error.localizedDescription)")
                }
            }
            if out.isEmpty { out = fallback }
            self.servers = out
            self.until = until
            self.provisional = provisional
            return out
        }
        inFlight = task
        let out = await task.value
        inFlight = nil
        return out
    }

    /// A room's hub socket joined: an answer without TURN is not reused for the calls that follow.
    func hubConnected() {
        if provisional || until == 0 { servers = nil; until = 0 }
    }

    /// Forget everything (a wipe, another server).
    func reset() {
        servers = nil
        until = 0
        provisional = true
    }
}
