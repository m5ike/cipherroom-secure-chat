// HubConnection against an in-memory hub (MockHubTransport): the join with
// the proof at the hello (p4.json hubProof vector), the fallback join, the
// proof refusals (legacy retry, stop), resume across reconnects, close codes,
// presence throttling, the account's auth, rate limits, keepalive, the
// directory's request / answer, pause / disconnect, several rooms.

import CryptoKit
import Foundation
import Testing
@testable import M5Net
import M5Core
import M5Crypto

private let blindRoom = "r3.Vm9jdG9yUm9vbUlkRm9yUDQ"

private func makeConnection(_ transport: MockHubTransport, room: String = blindRoom, signer: (any HubProofSigner)? = nil,
                            resume: (any HubResumeStore)? = nil, timing: HubTiming = .fast) -> HubConnection {
    HubConnection(room: HubRoom(key: "room-key", server: "https://chat.example.com/m5", roomId: room, name: "Alice"), transport: transport,
                  proofSigner: signer, resumeStore: resume, timing: timing, random: { 0.5 })
}

/// Opens, says hello, answers the join with joined; returns the socket and the join frame.
private func joinedSocket(_ t: MockHubTransport, _ c: HubConnection, peerId: String = "peer-a", proven: Bool? = true) async throws -> (MockSocket, NetJSON) {
    let s = try #require(await t.accept())
    s.hello()
    let join = try #require(await s.next("join"))
    s.joined(peerId: peerId, proven: proven)
    await eventually("joined") { await c.status == .joined }
    return (s, join)
}

@Suite(.serialized) struct HubConnectionTests {
    @Test func joinsWithTheProofOverTheHellosNonce() async throws {
        let v = try #require(try Fixtures.p4().arr("hubProof")?.first)
        let t = MockHubTransport()
        let signer = try TestHubSigner(seed: try #require(Bytes.unb64(v.str("seed"))))
        let c = HubConnection(room: HubRoom(key: "k", server: "chat.example.com", roomId: v.str("roomId"), name: "Alice"), transport: t,
                              proofSigner: signer, timing: .fast)
        let log = EventLog.watch(c.events)
        await c.connect()
        let s = try #require(await t.accept())
        #expect(t.urls.first?.absoluteString == "wss://chat.example.com/ws")
        s.hello(nonce: v.str("nonce"))
        let join = try #require(await s.next("join"))
        #expect(join.str("room") == v.str("roomId"))
        #expect(join.str("name") == "Alice")
        #expect(join.int("protocol") == 2)
        #expect(join.bool("away") == false && join.bool("foreground") == true)
        #expect(join.arr("features") == ["bin"])
        #expect(join.str("peerId").hasPrefix("peer-"))
        // The proof: the vector's key, a signature over exactly the vector's signed data.
        #expect(try HubProofFrames.message(roomId: v.str("roomId"), nonce: v.str("nonce")) == Data(v.str("signedData").utf8))
        let proof = try #require(join.obj("proof"))
        #expect(proof.str("pub") == v.str("pub"))
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: Bytes.unb64(proof.str("pub"))!)
        #expect(key.isValidSignature(Bytes.unb64(proof.str("sig"))!, for: Data(v.str("signedData").utf8)))
        // …and the vector's own signature verifies over the same bytes (Ed25519 by the web reference).
        #expect(key.isValidSignature(Bytes.unb64(v.str("sig"))!, for: try HubProofFrames.message(roomId: v.str("roomId"), nonce: v.str("nonce"))))
        s.joined(peerId: join.str("peerId"), proven: true)
        await eventually("joined") { await c.status == .joined }
        #expect(await c.proven == true)
        let statuses = await log.statuses
        #expect(statuses.starts(with: [.connecting, .joining, .joined]))
        await c.shutdown()
    }

    /// The proof's bytes and keys are M5Crypto's: the seed signer gives the vector's own (deterministic) signature,
    /// the same as `HubProof.build`, and the hub's side verifies it.
    @Test func theSeedSignerMakesTheVectorsProofThroughM5Crypto() async throws {
        let v = try #require(try Fixtures.p4().arr("hubProof")?.first)
        let seed = Array(try #require(Bytes.unb64(v.str("seed"))))
        let proof = try #require(await HubProofFrames.build(signer: HubSeedSigner(seed: seed), roomId: v.str("roomId"), nonce: v.str("nonce")))
        #expect(proof.pub == v.str("pub"))
        #expect(proof.sig == v.str("sig"))
        let crypto = try HubProof.build(seed: seed, roomId: v.str("roomId"), nonce: v.str("nonce"))
        #expect(crypto.string("pub") == proof.pub && crypto.string("sig") == proof.sig)
        #expect(HubProof.verify(pub: proof.pub, sig: proof.sig, roomId: v.str("roomId"), nonce: v.str("nonce")))
        #expect(HubProofFrames.joinLabel == "m5cet/hub-join/4")
        // A nonce that is not 24 bytes of canonical base64url, or a part with "|": NetError, and no proof.
        #expect(throws: NetError.self) { try HubProofFrames.message(roomId: v.str("roomId"), nonce: "c2hvcnQ") }
        #expect(throws: NetError.self) { try HubProofFrames.message(roomId: v.str("roomId"), nonce: v.str("nonce") + "=") }
        #expect(throws: NetError.self) { try HubProofFrames.message(roomId: "r3.a|b", nonce: v.str("nonce")) }
        #expect(await HubProofFrames.build(signer: HubSeedSigner(seed: seed), roomId: "r3.a|b", nonce: v.str("nonce")) == nil)
    }

    @Test func aServerWithoutHelloGetsTheJoinWithoutProof() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t, signer: try TestHubSigner(seed: Data(repeating: 1, count: 32)))
        await c.connect()
        let s = try #require(await t.accept())
        let join = try #require(await s.next("join", timeout: .seconds(1)))
        #expect(join["proof"] == nil)
        await c.shutdown()
    }

    @Test func aPlainNameRoomNeverProves() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t, room: "plain room", signer: try TestHubSigner(seed: Data(repeating: 1, count: 32)))
        await c.connect()
        let s = try #require(await t.accept())
        s.hello()
        let join = try #require(await s.next("join"))
        #expect(join["proof"] == nil && join.str("room") == "plain room")
        await c.shutdown()
    }

    @Test func aRefusedProofJoinsAgainWithoutItWhenTheServerAllows() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t, signer: try TestHubSigner(seed: Data(repeating: 2, count: 32)))
        let log = EventLog.watch(c.events)
        await c.connect()
        let s = try #require(await t.accept())
        s.hello()
        let first = try #require(await s.next("join"))
        #expect(first["proof"] != nil)
        s.push(["type": "error", "code": "room-proof", "message": "another key", "legacyAllowed": true])
        let second = try #require(await s.next("join"))
        #expect(second["proof"] == nil)
        #expect(second.str("peerId") == first.str("peerId"))
        await eventually("legacy notice") { await log.notices.contains(.proofLegacy) }
        // Refused again on this socket: stop.
        s.push(["type": "error", "code": "room-proof", "message": "another key", "legacyAllowed": true])
        await eventually("stopped") { await c.status == .stopped(.proofRefused(code: "room-proof")) }
        #expect(await s.next("leave") != nil)
        await c.shutdown()
    }

    @Test func proofsGoUnsentForAnHourAfterALegacyJoin() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t, signer: try TestHubSigner(seed: Data(repeating: 3, count: 32)))
        await c.connect()
        let s1 = try #require(await t.accept())
        s1.hello()
        _ = await s1.next("join")
        s1.push(["type": "error", "code": "room-proof-required", "message": "x", "legacyAllowed": true])
        _ = await s1.next("join")
        s1.joined(peerId: "peer-a", proven: false)
        await eventually("joined") { await c.status == .joined }
        s1.serverClose(1006)
        let s2 = try #require(await t.accept())
        s2.hello()
        let join = try #require(await s2.next("join"))
        #expect(join["proof"] == nil)
        await c.shutdown()
    }

    @Test func requiredProofsStopTheConnection() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        await c.connect()
        let s = try #require(await t.accept())
        s.hello()
        _ = await s.next("join")
        s.push(["type": "error", "code": "room-proof-required", "message": "proofs required", "legacyAllowed": false])
        await eventually("stopped") { await c.status == .stopped(.proofRefused(code: "room-proof-required")) }
        #expect(await t.accept(timeout: .milliseconds(200)) == nil)
    }

    @Test func aBlockedOrFullRoomStops() async throws {
        for (code, reason) in [("room-blocked", HubStopReason.roomBlocked("closed")), ("room-full", HubStopReason.roomFull("closed"))] {
            let t = MockHubTransport()
            let c = makeConnection(t)
            await c.connect()
            let s = try #require(await t.accept())
            s.hello()
            _ = await s.next("join")
            s.push(["type": "error", "code": .string(code), "message": "closed"])
            await eventually(code) { await c.status == .stopped(reason) }
            #expect(await t.accept(timeout: .milliseconds(150)) == nil)
        }
    }

    @Test func theSameMemberComesBackWithItsResumeSecret() async throws {
        let t = MockHubTransport()
        let store = MemoryNetStateStore()
        let resume = StoredResumeStore(store: store)
        let c = makeConnection(t, resume: resume)
        await c.connect()
        let (s1, _) = try await joinedSocket(t, c, peerId: "peer-kept")
        #expect(await resume.load(roomKey: "room-key")?.peerId == "peer-kept")
        // The connection drops: it reconnects (backoff) and asks for its own place back.
        s1.serverClose(1006)
        let s2 = try #require(await t.accept())
        s2.hello()
        let join = try #require(await s2.next("join"))
        #expect(join.str("peerId") == "peer-kept")
        #expect(join.str("resume") == "cmVzdW1lLXNlY3JldC0wMTIzNDU2Nzg5YWJjZGVm")
        await c.shutdown()
        // A new connection (the app was ended) reads them from the store.
        let t2 = MockHubTransport()
        let c2 = makeConnection(t2, resume: resume)
        await c2.connect()
        let s3 = try #require(await t2.accept())
        s3.hello()
        let join3 = try #require(await s3.next("join"))
        #expect(join3.str("peerId") == "peer-kept" && !join3.str("resume").isEmpty)
        await c2.shutdown()
    }

    @Test func resumeSecretsAreKeptForAtMost64Rooms() async throws {
        let store = MemoryNetStateStore()
        let clock = TestClock(1_000)
        let r = StoredResumeStore(store: store, clock: clock.clock)
        for i in 0..<70 {
            clock.advance(1)
            await r.save(roomKey: "room-\(i)", peerId: "p\(i)", secret: "s\(i)")
        }
        #expect(await store.load("resume")?.objectValue?.count == 64)
        #expect(await r.load(roomKey: "room-0") == nil)
        #expect(await r.load(roomKey: "room-69")?.secret == "s69")
    }

    @Test func replacedOrClosedByTheOperatorDoesNotReconnect() async throws {
        for (code, reason) in [(4001, HubStopReason.replaced), (4003, HubStopReason.closedByServer(""))] {
            let t = MockHubTransport()
            let c = makeConnection(t)
            await c.connect()
            let (s, _) = try await joinedSocket(t, c)
            s.serverClose(code, "x")
            await eventually("stopped \(code)") { await c.status == .stopped(reason) }
            #expect(await t.accept(timeout: .milliseconds(150)) == nil)
        }
        // The frame before the close says it too (a close code URLSession could not carry).
        let t = MockHubTransport()
        let c = makeConnection(t)
        await c.connect()
        let (s, _) = try await joinedSocket(t, c)
        s.push(["type": "replaced", "reason": "the same client connected again"])
        s.serverClose(1006)
        await eventually("replaced") { await c.status == .stopped(.replaced) }
    }

    @Test func connectFailuresAreRetriedWithBackoff() async throws {
        let t = MockHubTransport()
        t.fail(2)
        let c = makeConnection(t)
        let log = EventLog.watch(c.events)
        await c.connect()
        let s = try #require(await t.accept())
        #expect(t.urls.count == 3)
        #expect(t.urls[0].absoluteString == "wss://chat.example.com/m5/ws")
        s.hello()
        _ = await s.next("join")
        await eventually("offline twice") { await log.count(.offline) >= 2 }
        await c.shutdown()
    }

    @Test func theAccountIsBoundAfterTheJoin() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        await c.setAccount(token: "tok-1", away: true)
        await c.connect()
        let (s, _) = try await joinedSocket(t, c)
        let auth = try #require(await s.next("auth"))
        #expect(auth == ["type": "auth", "token": "tok-1", "away": true])
        await c.setAccount(token: "tok-2", away: false)
        #expect(await s.next("auth") == ["type": "auth", "token": "tok-2", "away": false])
        // Signed out: nothing (the server ends the session on its own).
        await c.setAccount(token: nil, away: false)
        #expect(await s.next("auth", timeout: .milliseconds(150)) == nil)
        await c.shutdown()
    }

    @Test func presenceGoesAtMostOncePerGapAndOnlyTheLatest() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        await c.connect()
        let (s, join) = try await joinedSocket(t, c)
        #expect(join.bool("foreground"))
        await c.setForeground(false)
        let p1 = try #require(await s.next("presence"))
        #expect(p1 == ["type": "presence", "away": false, "foreground": false])
        await c.setForeground(true)
        await c.setForeground(false)
        await c.setForeground(true)
        let p2 = try #require(await s.next("presence", timeout: .seconds(1)))
        #expect(p2.bool("foreground") == true)
        #expect(await s.next("presence", timeout: .milliseconds(300)) == nil)
        await c.shutdown()
    }

    @Test func aJoinInTheBackgroundSaysSo() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        await c.setForeground(false)
        await c.connect()
        let (s, join) = try await joinedSocket(t, c)
        #expect(join.bool("foreground", true) == false)
        #expect(await s.next("presence", timeout: .milliseconds(200)) == nil)
        await c.shutdown()
    }

    @Test func rateLimitsAreKept() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        let log = EventLog.watch(c.events)
        await c.connect()
        let (s, _) = try await joinedSocket(t, c)
        // The client's own buckets: receipts 30 at once.
        var results: [HubSendResult] = []
        for i in 0..<31 { results.append(await c.send(.receipt(messageIds: ["m-\(i)"], state: .read))) }
        #expect(results.prefix(30).allSatisfy { $0 == .sent })
        guard case .throttled(let wait) = results[30] else { Issue.record("not throttled"); return }
        #expect(wait > 0 && wait <= 1000)
        // The server's word: nothing of that class until its time has passed.
        s.push(["type": "rate-limited", "frame": "relay-ack", "retryAfterMs": 5000])
        await eventually("notice") { await log.notices.contains(.rateLimited(frame: "relay-ack", retryAfterMs: 5000)) }
        guard case .throttled = await c.send(.relayAck(ids: ["q"])) else { Issue.record("relay not blocked"); return }
        #expect(await c.send(.keyBundles(ref: "r")) == .sent)
        await c.shutdown()
    }

    @Test func invalidFramesAreNotSent() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        await c.connect()
        _ = try await joinedSocket(t, c)
        guard case .invalid = await c.send(.receipt(messageIds: [], state: .read)) else { Issue.record("sent"); return }
        await c.shutdown()
        #expect(await c.send(.ping(t: 1)) == .notConnected)
    }

    @Test func framesNeedTheRoom() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        #expect(await c.send(.relayAck(ids: ["x"])) == .notConnected)
        await c.connect()
        let s = try #require(await t.accept())
        #expect(await c.send(.relayAck(ids: ["x"])) == .notConnected)
        #expect(await c.send(.ping(t: 5)) == .sent)
        #expect(await s.next("ping")?.int("t") == 5)
        await c.shutdown()
    }

    @Test func keepaliveFindsADeadConnection() async throws {
        var timing = HubTiming.fast
        timing.heartbeat = .milliseconds(60)
        timing.deadAfter = .milliseconds(200)
        let t = MockHubTransport()
        let c = makeConnection(t, timing: timing)
        await c.connect()
        let (s1, _) = try await joinedSocket(t, c)
        let ping = try #require(await s1.next("ping"))
        // An answer keeps it alive and measures the round trip.
        s1.push(["type": "pong", "t": .int(ping.int("t")), "serverTs": .int(ping.int("t") + 5)])
        await eventually("rtt") { await c.rttMs != nil }
        // Then silence: dropped and reconnected.
        let s2 = try #require(await t.accept(timeout: .seconds(2)))
        #expect(s1.aborted)
        s2.hello()
        #expect(await s2.next("join") != nil)
        await c.shutdown()
    }

    @Test func disconnectLeavesAndPauseDoesNot() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        await c.connect()
        let (s1, _) = try await joinedSocket(t, c, peerId: "peer-p")
        await c.pause()
        #expect(await c.status == .stopped(.paused))
        #expect(await s1.next("leave", timeout: .milliseconds(150)) == nil)
        #expect(s1.clientCloseCode == 1000)
        // Back: the same member.
        await c.connect()
        let s2 = try #require(await t.accept())
        s2.hello()
        let join = try #require(await s2.next("join"))
        #expect(join.str("peerId") == "peer-p" && !join.str("resume").isEmpty)
        s2.joined(peerId: "peer-p")
        await eventually("joined") { await c.status == .joined }
        await c.disconnect()
        #expect(await s2.next("leave") == ["type": "leave", "away": false])
        #expect(s2.clientCloseCode == 1000)
        #expect(await c.status == .stopped(.left))
        #expect(await t.accept(timeout: .milliseconds(150)) == nil)
    }

    @Test func theDirectoryIsAskedOverTheHub() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        await c.connect()
        let (s, _) = try await joinedSocket(t, c)
        async let devices = c.keyBundles(ref: "ref-b")
        let ask = try #require(await s.next("key-bundles"))
        #expect(ask == ["type": "key-bundles", "ref": "ref-b"])
        s.push(["type": "key-bundles", "ref": "ref-b", "devices": [["pk": "x"]]])
        #expect(await devices?.count == 1)
        async let lookup = c.ktLookup(ref: "ref-b")
        _ = await s.next("kt-lookup")
        s.push(["type": "kt-lookup", "ref": "ref-b", "lookup": .null])
        let l = await lookup
        #expect(l != nil && l! == nil) // answered: KT is not running there
        // No answer: nil after the timeout.
        #expect(await c.keyBundles(ref: "ref-silent") == nil)
        await c.shutdown()
    }

    @Test func everyFrameAndBinaryMessageIsPassedOn() async throws {
        let t = MockHubTransport()
        let c = makeConnection(t)
        let log = EventLog.watch(c.events)
        await c.connect()
        let (s, _) = try await joinedSocket(t, c)
        s.push(["type": "peer-joined", "peerId": "p2", "name": "Bob", "joinedAt": 1, "foreground": true, "lastSeen": 1, "proven": true])
        s.pushBinary(try BinaryChunkFrame(version: 4, transferId: "t", seq: 1, iv: Data(count: 12), data: Data(count: 20)).encode())
        s.pushRaw("garbage")
        await eventually("frames") { await log.frameTypes.contains("peer-joined") }
        await eventually("binary") { await log.events.contains { if case .binary = $0 { return true }; return false } }
        #expect(await log.frameTypes.starts(with: ["hello", "joined", "peer-joined"]))
        // A proxy chunk goes out binary too.
        let chunk = try BinaryChunkFrame(version: 2, transferId: "t-9", seq: 3, iv: Data(count: 12), data: Data(count: 32)).encode()
        #expect(await c.sendBinary(chunk) == .sent)
        guard case .binary(let sent)? = await s.sent.take(timeout: .seconds(1)) else { Issue.record("no binary"); return }
        #expect(sent == chunk)
        await c.shutdown()
    }
}

@Suite(.serialized) struct HubRoomsTests {
    @Test func oneSocketPerRoomWithinThePolicysLimit() async throws {
        let t = MockHubTransport()
        let rooms = HubRooms(transport: t, timing: .fast, maxRooms: 2)
        await rooms.setAccount(token: "tok", away: false)
        let a = try #require(await rooms.open(HubRoom(key: "a", server: "https://h", roomId: "room-a", name: "Me")))
        let b = try #require(await rooms.open(HubRoom(key: "b", server: "https://h", roomId: "room-b", name: "Me")))
        #expect(await rooms.open(HubRoom(key: "c", server: "https://h", roomId: "room-c", name: "Me")) == nil)
        // The two rooms connect concurrently: which socket is which, their joins say.
        var byRoom: [String: MockSocket] = [:]
        for _ in 0..<2 {
            let s = try #require(await t.accept())
            s.hello()
            let join = try #require(await s.next("join"))
            byRoom[join.str("room")] = s
            s.joined(peerId: "p-" + join.str("room"))
        }
        let sa = try #require(byRoom["room-a"]), sb = try #require(byRoom["room-b"])
        await eventually("both joined") { await rooms.joinedCount() == 2 }
        let authA = await sa.next("auth"), authB = await sb.next("auth")
        #expect(authA != nil && authB != nil)
        await rooms.setForeground(false)
        #expect(await sa.next("presence")?.bool("foreground", true) == false)
        #expect(await sb.next("presence")?.bool("foreground", true) == false)
        await rooms.close("a")
        #expect(await sa.next("leave") != nil)
        #expect(await a.status == .stopped(.left))
        await rooms.shutdown()
        #expect(await sb.next("leave") != nil)
        #expect(await b.status == .stopped(.left))
    }
}
