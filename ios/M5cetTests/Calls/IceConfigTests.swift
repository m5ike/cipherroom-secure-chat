// 6.12: /api/turn answers STUN only ("pending") until the device's hub socket
// is live — never cached (Android's RtcTurnTest); the cache, the fallback,
// relay-only ("Hide my IP address") only with TURN; the peer connection's
// configuration (Android Rtc.config).

import XCTest
@preconcurrency import WebRTC
@testable import M5cet

final class IceConfigTests: XCTestCase {
    func testPendingAnswerIsNeverCached() {
        let now: Int64 = 1_800_000_000_000
        XCTAssertEqual(IceConfig.cacheUntil(IceTurnAnswer(servers: [], pending: true, ttlSeconds: 0), now: now), 0)
        XCTAssertEqual(IceConfig.cacheUntil(IceTurnAnswer(servers: [], pending: true, ttlSeconds: 3600), now: now), 0)
        XCTAssertEqual(IceConfig.cacheUntil(nil, now: now), 0)
    }

    func testFullAnswerIsCachedForItsLifetime() {
        let now: Int64 = 1_800_000_000_000
        XCTAssertEqual(IceConfig.cacheUntil(IceTurnAnswer(servers: [], ttlSeconds: 3600), now: now), now + (3600 - 60) * 1000)
        XCTAssertEqual(IceConfig.cacheUntil(IceTurnAnswer(servers: [], ttlSeconds: 0), now: now), now + 10 * 60_000)
        XCTAssertEqual(IceConfig.cacheUntil(IceTurnAnswer(servers: [], pending: false), now: now), now + 10 * 60_000)
    }

    func testParsesTheServersAnswer() throws {
        // As server/turn.ts answers with TURN_SECRET (ephemeral credentials) and as turn-gate.ts answers before the hub.
        let full = #"{"ok":true,"configured":true,"mode":"ephemeral","ttlSeconds":3600,"expiresAt":1800000000000,"iceServers":[{"urls":"stun:turn.example.com:3478"},{"urls":["turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349"],"username":"1800000000:m5","credential":"c2VjcmV0"},{"urls":[]},{"nothing":1}]}"#
        let a = try XCTUnwrap(IceConfig.parse(Data(full.utf8)))
        XCTAssertFalse(a.pending)
        XCTAssertEqual(a.ttlSeconds, 3600)
        XCTAssertEqual(a.servers, [IceServerSpec(urls: ["stun:turn.example.com:3478"]),
                                   IceServerSpec(urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
                                                 username: "1800000000:m5", credential: "c2VjcmV0")])
        XCTAssertTrue(IceConfig.hasTurn(a.servers))
        let pending = try XCTUnwrap(IceConfig.parse(Data(#"{"ok":true,"configured":true,"mode":"ephemeral","pending":true,"iceServers":[{"urls":"stun:turn.example.com:3478"}],"expiresAt":1,"ttlSeconds":0}"#.utf8)))
        XCTAssertTrue(pending.pending)
        XCTAssertFalse(IceConfig.hasTurn(pending.servers))
        XCTAssertNil(IceConfig.parse(Data("<html>".utf8)))
    }

    func testRelayOnlyNeedsTurn() {
        let stun = [IceServerSpec(urls: ["stun:s.example:3478"])]
        let turn = stun + [IceServerSpec(urls: ["TURN:t.example:3478"], username: "u", credential: "p")]
        XCTAssertFalse(IceConfig.relayOnly(requested: true, servers: stun), "without TURN nothing can be hidden: as it was")
        XCTAssertTrue(IceConfig.relayOnly(requested: true, servers: turn))
        XCTAssertFalse(IceConfig.relayOnly(requested: false, servers: turn))
    }

    @MainActor
    func testTheConfigurationIsAndroids() {
        let servers = [IceServerSpec(urls: ["turn:t.example:3478"], username: "u", credential: "p")]
        let c = RtcEngine.configuration(servers: servers, relayOnly: true)
        XCTAssertEqual(c.sdpSemantics, .unifiedPlan)
        XCTAssertEqual(c.continualGatheringPolicy, .gatherContinually)
        XCTAssertEqual(c.bundlePolicy, .maxBundle)
        XCTAssertEqual(c.rtcpMuxPolicy, .require)
        XCTAssertTrue(c.enableImplicitRollback, "perfect negotiation: the polite side rolls back")
        XCTAssertEqual(c.iceTransportPolicy, .relay)
        XCTAssertEqual(c.iceServers.first?.urlStrings, ["turn:t.example:3478"])
        XCTAssertEqual(c.iceServers.first?.username, "u")
        XCTAssertEqual(c.iceServers.first?.credential, "p")
        XCTAssertEqual(RtcEngine.configuration(servers: servers, relayOnly: false).iceTransportPolicy, .all)
    }

    // MARK: the cache

    private final class Server: TurnFetching, @unchecked Sendable {
        private let lock = NSLock()
        private var answers: [Result<String, any Error>]
        private(set) var asked = 0
        init(_ answers: [Result<String, any Error>]) { self.answers = answers }
        func fetchTurn() async throws -> Data {
            try await Task.sleep(for: .milliseconds(30))
            let next: Result<String, any Error> = lock.withLock {
                asked += 1
                return answers.count > 1 ? answers.removeFirst() : answers[0]
            }
            return Data(try next.get().utf8)
        }
        var count: Int { lock.withLock { asked } }
    }

    private static let pendingJSON = #"{"pending":true,"iceServers":[{"urls":"stun:s.example:3478"}],"ttlSeconds":0}"#
    private static let fullJSON = #"{"ttlSeconds":3600,"iceServers":[{"urls":"stun:s.example:3478"},{"urls":"turn:t.example:3478","username":"u","credential":"p"}]}"#

    @MainActor
    func testAPendingAnswerIsAskedAgainAndAFullOneIsKept() async {
        let server = Server([.success(Self.pendingJSON), .success(Self.fullJSON)])
        var now: Int64 = 1_000
        let cache = IceConfigCache(source: server, now: { now })
        let first = await cache.current()
        XCTAssertFalse(IceConfig.hasTurn(first), "STUN only before the hub")
        let second = await cache.current()
        XCTAssertTrue(IceConfig.hasTurn(second), "asked again: pending is never cached")
        XCTAssertTrue(cache.turnOffered)
        XCTAssertEqual(cache.count, 2)
        now += 30 * 60_000
        _ = await cache.current()
        XCTAssertEqual(server.count, 2, "a full answer is kept for its lifetime")
        now += 40 * 60_000
        _ = await cache.current()
        XCTAssertEqual(server.count, 3, "…and asked again after it")
    }

    @MainActor
    func testTheHubJoiningDropsAStunOnlyStandIn() async {
        struct Down: Error {}
        let server = Server([.failure(Down()), .success(Self.fullJSON)])
        let cache = IceConfigCache(source: server, now: { 1_000 })
        let fallback = await cache.current()
        XCTAssertEqual(fallback, IceConfig.publicStun, "no answer: the public STUN")
        _ = await cache.current()
        XCTAssertEqual(server.count, 1, "a failure is kept a short while")
        cache.hubConnected()
        let after = await cache.current()
        XCTAssertTrue(IceConfig.hasTurn(after), "a joined hub asks again")
        cache.hubConnected()
        _ = await cache.current()
        XCTAssertEqual(server.count, 2, "a full answer survives the next join")
    }

    @MainActor
    func testConcurrentAsksShareOneRequest() async {
        let server = Server([.success(Self.fullJSON)])
        let cache = IceConfigCache(source: server, now: { 1_000 })
        async let a = cache.current()
        async let b = cache.current()
        let (x, y) = await (a, b)
        XCTAssertEqual(x, y)
        XCTAssertEqual(server.count, 1)
    }
}
