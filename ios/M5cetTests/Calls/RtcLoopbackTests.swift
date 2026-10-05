// Two rooms' WebRTC sides in one process, wired as two room sessions would
// wire them (every signal through its JSON, every audio-status as the message
// it is): the real WebRTC M150 — the peer connection, perfect negotiation,
// the "m5cet" data channel with text and binary frames, a call's tracks with
// renegotiation both ways at once, statistics and teardown. Host candidates
// only (no STUN): both ends are this simulator.

import XCTest
@preconcurrency import WebRTC
@testable import M5cet

/// A room session reduced to its WebRTC duties, delivering to the other room on the main queue.
@MainActor
private final class LoopLink: RoomRtcLink {
    let myId: String
    weak var other: RoomRtc?
    var opened: [String] = []
    var closed: [String] = []
    var received: [(String, RtcDataFrame)] = []
    var statuses: [CallAudioState] = []
    var signalsSent = 0

    init(myId: String) { self.myId = myId }

    func rtc(_ room: RoomRtc, sendSignal signal: RtcSignal, to peerId: String) {
        signalsSent += 1
        // Through the JSON the room session seals and opens.
        let data = signal.jsonData
        let me = myId
        let other = self.other
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard let s = RtcSignal(jsonData: data) else { return XCTFail("a signal that does not read back") }
                other?.receiveSignal(s, from: me, name: me.uppercased())
            }
        }
    }

    func rtc(_ room: RoomRtc, channelOpenedWith peerId: String) { opened.append(peerId) }
    func rtc(_ room: RoomRtc, channelClosedWith peerId: String) { closed.append(peerId) }
    func rtc(_ room: RoomRtc, received frame: RtcDataFrame, from peerId: String) { received.append((peerId, frame)) }

    func rtc(_ room: RoomRtc, broadcastAudioStatus status: CallAudioState) {
        statuses.append(status)
        let me = myId
        let other = self.other
        DispatchQueue.main.async { MainActor.assumeIsolated { other?.peerAudioStatus(status.rawValue, from: me) } }
    }
}

@MainActor
private final class Rings: RoomCallEvents {
    var rings: [String] = []
    var over = 0
    func roomCallRings(_ room: RoomRtc, who: String, video: Bool) { rings.append(who) }
    func roomCallRingOver(_ room: RoomRtc) { over += 1 }
    func roomCall(_ room: RoomRtc, recorded: [CallTrack.Record]) {}
    func roomCallChanged(_ room: RoomRtc) {}
}

@MainActor
final class RtcLoopbackTests: XCTestCase {
    private struct Pair {
        let a: RoomRtc, b: RoomRtc
        let la: LoopLink, lb: LoopLink
    }

    /// "a" joined later: it is the initiator towards "b" (as RoomSession does with the "joined" list).
    private func connected() async throws -> Pair {
        let engine = testEngine()
        let a = RoomRtc(roomKey: "loop", label: "Loop", engine: engine)
        let b = RoomRtc(roomKey: "loop", label: "Loop", engine: engine)
        let la = LoopLink(myId: "a"), lb = LoopLink(myId: "b")
        la.other = b
        lb.other = a
        a.link = la
        b.link = lb
        a.roomJoined()
        b.roomJoined()
        a.addPeer(id: "b", name: "B", initiator: true)
        let open = await eventually(20) { la.opened == ["b"] && lb.opened == ["a"] }
        try XCTSkipUnless(open || ProcessInfo.processInfo.environment["M5_RTC_LOOPBACK_STRICT"] != nil,
                          "no ICE path between two peer connections on this machine (a VPN?)")
        XCTAssertTrue(open)
        return Pair(a: a, b: b, la: la, lb: lb)
    }

    func testTheDataChannelOpensAndCarriesTextAndBinaryInOrder() async throws {
        let p = try await connected()
        XCTAssertEqual(p.b.peer("a")?.initiator, false, "made by its first signal")
        XCTAssertEqual(p.b.peer("a")?.name, "A")
        XCTAssertTrue(p.a.isOpen("b"))
        XCTAssertEqual(p.a.openPeerIds, ["b"])
        // Both announced their audio status when the channel opened ("off" too, like the web).
        XCTAssertEqual(p.la.statuses.first, .off)
        XCTAssertEqual(p.lb.statuses.first, .off)

        var chunk = Data(count: 32_768)
        for i in chunk.indices { chunk[i] = UInt8(truncatingIfNeeded: i &* 7) }
        XCTAssertTrue(p.a.send(.text(#"{"type":"hello","caps":["bin"]}"#), to: "b"))
        for _ in 0..<20 { XCTAssertTrue(p.a.send(.binary(chunk), to: "b")) }
        XCTAssertTrue(p.a.send(.text("end"), to: "b"))
        XCTAssertTrue(p.b.send(.text("čau 👋"), to: "a"))
        let arrived = await eventually(10) { p.lb.received.count == 22 && p.la.received.count == 1 }
        XCTAssertTrue(arrived)
        XCTAssertEqual(p.lb.received.first?.1, .text(#"{"type":"hello","caps":["bin"]}"#))
        XCTAssertEqual(p.lb.received.last?.1, .text("end"), "ordered")
        XCTAssertEqual(p.lb.received[5].1, .binary(chunk))
        XCTAssertEqual(p.la.received.first?.0, "b")
        XCTAssertEqual(p.la.received.first?.1, .text("čau 👋"))
        let drained = await p.a.waitForBuffer(of: "b", below: 0, timeout: .seconds(5))
        XCTAssertTrue(drained)
        XCTAssertFalse(p.a.send(.text("x"), to: "nobody"))

        p.a.removePeer(id: "b")
        XCTAssertFalse(p.a.isOpen("b"))
        let closed = await eventually(10) { p.lb.closed == ["a"] || p.b.peer("a")?.status == .closed }
        XCTAssertTrue(closed, "the other side sees it go")
        p.a.disconnect()
        p.b.disconnect()
    }

    func testACallRenegotiatesBothWaysAtOnceAndEnds() async throws {
        let p = try await connected()
        let rings = Rings()
        p.b.events = rings
        // Both start at the same moment: two offers cross — perfect negotiation settles it.
        p.a.startAudio()
        p.b.startAudio()
        let both = await eventually(15) { p.a.peer("b")?.remoteAudio != nil && p.b.peer("a")?.remoteAudio != nil }
        XCTAssertTrue(both, "each hears the other after the glare")
        XCTAssertEqual(p.a.peer("b")?.pc?.signalingState, .stable)
        XCTAssertEqual(p.b.peer("a")?.pc?.signalingState, .stable)
        XCTAssertEqual(p.a.audioState, .live)
        let sawLive = await eventually(5) { p.a.othersInCall && p.b.othersInCall }
        XCTAssertTrue(sawLive, "the audio-status messages arrived")
        XCTAssertTrue(rings.rings.isEmpty || rings.over > 0, "b was in the call: no ring, or it ended at once")

        // Statistics of a live link.
        await p.a.refreshStats()
        let stats = try XCTUnwrap(p.a.peer("b")?.stats)
        XCTAssertEqual(stats.transport, "direct")
        XCTAssertGreaterThan(stats.bytesSent, 0)
        XCTAssertEqual(stats.dtlsState, "connected")
        XCTAssertEqual(stats.audioCodec, "opus")

        // a mutes, holds, hangs up: b hears it.
        p.a.mute(true)
        let muted = await eventually(5) { p.b.peer("a")?.audio == .muted }
        XCTAssertTrue(muted)
        p.a.stop()
        let off = await eventually(5) { p.b.peer("a")?.audio == .off }
        XCTAssertTrue(off)
        XCTAssertEqual(p.a.peer("b")?.senders.count, 0)
        let settled = await eventually(10) { p.a.peer("b")?.pc?.signalingState == .stable && p.b.peer("a")?.pc?.signalingState == .stable }
        XCTAssertTrue(settled, "the removal renegotiated")
        XCTAssertTrue(p.a.isOpen("b"), "the chat goes on after the call")
        p.b.stop()
        p.a.disconnect()
        p.b.disconnect()
    }

    func testSomeoneElsesCallRingsInTheRoom() async throws {
        let p = try await connected()
        let rings = Rings()
        p.b.events = rings
        p.a.startAudio()
        let rang = await eventually(10) { rings.rings == ["A"] }
        XCTAssertTrue(rang, "a's audio going live rings at b (CallTrack)")
        p.b.decline()
        XCTAssertEqual(rings.over, 1)
        p.a.disconnect()
        p.b.disconnect()
    }
}
