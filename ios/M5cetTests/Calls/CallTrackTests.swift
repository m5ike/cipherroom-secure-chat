// 6.8: what a room's call was for me — incoming, outgoing, missed, declined;
// one record per call. The same cases as Android's CallTrackTest.

import XCTest
@testable import M5cet

final class CallTrackTests: XCTestCase {
    private let nobody: [String] = []

    func testIStartAloneOthersComeIHangUpOutgoing() {
        var t = CallTrack()
        XCTAssertTrue(t.update(now: 1_000, meOn: true, myVideo: false, live: nobody, peerVideo: false).records.isEmpty)
        var s = t.update(now: 2_000, meOn: true, myVideo: false, live: ["Alice"], peerVideo: false)
        XCTAssertFalse(s.ring, "my own call does not ring")
        _ = t.update(now: 3_000, meOn: true, myVideo: false, live: ["Alice", "Bob"], peerVideo: false)
        s = t.update(now: 63_000, meOn: false, myVideo: false, live: ["Alice", "Bob"], peerVideo: false)
        XCTAssertEqual(s.records.count, 1)
        let r = s.records[0]
        XCTAssertEqual(r.callKind, .outgoing)
        XCTAssertEqual(r.at, 1_000)
        XCTAssertEqual(r.seconds, 62)
        XCTAssertFalse(r.video)
        XCTAssertEqual(r.people, ["Alice", "Bob"])
        // The others go on and end: nothing more for me (I was in it).
        _ = t.update(now: 70_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        XCTAssertTrue(t.update(now: 70_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false).records.isEmpty)
    }

    func testAnOutgoingCallNobodyCameToIsStillOneOutgoing() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: true, myVideo: false, live: nobody, peerVideo: false)
        let s = t.update(now: 30_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        XCTAssertEqual(s.records.count, 1)
        XCTAssertEqual(s.records[0].callKind, .outgoing)
        XCTAssertTrue(s.records[0].people.isEmpty)
        XCTAssertTrue(t.update(now: 30_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false).records.isEmpty,
                      "no missed call after it")
    }

    func testSomeoneCallsItRingsIJoinIncomingWithVideo() {
        var t = CallTrack()
        var s = t.update(now: 1_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: true)
        XCTAssertTrue(s.ring)
        XCTAssertEqual(s.who, "Alice")
        XCTAssertTrue(s.video)
        XCTAssertFalse(t.update(now: 2_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: true).ring, "rings once")
        s = t.update(now: 5_000, meOn: true, myVideo: false, live: ["Alice"], peerVideo: true)
        XCTAssertTrue(s.ringOver, "joining ends the ring")
        s = t.update(now: 65_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: true)
        XCTAssertEqual(s.records[0].callKind, .incoming)
        XCTAssertEqual(s.records[0].at, 5_000)
        XCTAssertEqual(s.records[0].seconds, 60)
        XCTAssertTrue(s.records[0].video, "the others' video makes it a video call")
    }

    func testMyCameraMakesItAVideoCall() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: true, myVideo: true, live: nobody, peerVideo: false)
        _ = t.update(now: 1_000, meOn: true, myVideo: false, live: ["Bob"], peerVideo: false) // the camera off later: still video
        XCTAssertTrue(t.update(now: 9_000, meOn: false, myVideo: false, live: ["Bob"], peerVideo: false).records[0].video)
    }

    func testACallThatEndsWithoutMeIsMissedAfterTheGrace() {
        var t = CallTrack()
        XCTAssertTrue(t.update(now: 1_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false).ring)
        var s = t.update(now: 10_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        XCTAssertTrue(s.records.isEmpty, "not yet: the call may come back")
        XCTAssertEqual(s.recheckAt, 10_000 + CallTrack.graceMs)
        s = t.update(now: 10_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        XCTAssertEqual(s.records.count, 1)
        let r = s.records[0]
        XCTAssertEqual(r.callKind, .missed)
        XCTAssertEqual(r.at, 1_000, "when the call started")
        XCTAssertEqual(r.seconds, 0)
        XCTAssertEqual(r.people, ["Alice"])
        XCTAssertTrue(s.ringOver)
    }

    func testADroppedConnectionWithinTheGraceIsTheSameCall() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        _ = t.update(now: 5_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)            // the channel dropped
        var s = t.update(now: 9_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)     // and came back
        XCTAssertFalse(s.ring, "no second ring")
        XCTAssertTrue(s.records.isEmpty)
        _ = t.update(now: 20_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        s = t.update(now: 20_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        XCTAssertEqual(s.records.count, 1, "one missed call, not two")
        XCTAssertEqual(s.records[0].at, 0)
    }

    func testDeclinedUnlessIJoinAfterAll() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        XCTAssertTrue(t.decline().ringOver)
        XCTAssertFalse(t.ringing)
        _ = t.update(now: 3_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        var s = t.update(now: 3_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        XCTAssertEqual(s.records[0].callKind, .declined)

        var u = CallTrack()
        _ = u.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        _ = u.decline()
        XCTAssertFalse(u.update(now: 1_000, meOn: false, myVideo: false, live: ["Alice", "Bob"], peerVideo: false).ring,
                       "a declined call does not ring again")
        _ = u.update(now: 2_000, meOn: true, myVideo: false, live: ["Alice", "Bob"], peerVideo: false)
        s = u.update(now: 12_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        XCTAssertEqual(s.records[0].callKind, .incoming)
        XCTAssertTrue(u.update(now: 12_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false).records.isEmpty)
    }

    func testADeclineWithoutACallChangesNothing() {
        var t = CallTrack()
        XCTAssertFalse(t.decline().ringOver)
        _ = t.update(now: 0, meOn: true, myVideo: false, live: nobody, peerVideo: false)
        _ = t.decline() // I am in it
        XCTAssertEqual(t.update(now: 5_000, meOn: false, myVideo: false, live: nobody, peerVideo: false).records[0].callKind, .outgoing)
    }

    func testFlushRecordsWhatIsOpen() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: true, myVideo: false, live: ["Alice"], peerVideo: false)
        var s = t.flush(now: 30_000)
        XCTAssertEqual(s.records.count, 1)
        XCTAssertEqual(s.records[0].callKind, .incoming)
        XCTAssertEqual(s.records[0].seconds, 30)

        var u = CallTrack()
        _ = u.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        s = u.flush(now: 5_000)
        XCTAssertEqual(s.records[0].callKind, .missed)
        XCTAssertTrue(s.ringOver)
        XCTAssertTrue(u.flush(now: 6_000).records.isEmpty, "nothing twice")
    }

    func testRejoiningIsASecondRecordOfMine() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        _ = t.update(now: 1_000, meOn: true, myVideo: false, live: ["Alice"], peerVideo: false)
        XCTAssertEqual(t.update(now: 11_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false).records[0].callKind, .incoming)
        XCTAssertFalse(t.update(now: 12_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false).ring, "no ring once I was in it")
        _ = t.update(now: 20_000, meOn: true, myVideo: false, live: ["Alice"], peerVideo: false)
        let s = t.update(now: 50_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        XCTAssertEqual(s.records[0].callKind, .incoming)
        XCTAssertEqual(s.records[0].seconds, 30)
    }

    func testNamesAreKeptInOrderOnceAndBounded() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: true, myVideo: false, live: ["A", "B"], peerVideo: false)
        _ = t.update(now: 1, meOn: true, myVideo: false, live: ["B", "A", "", "C"], peerVideo: false)
        for i in 0..<20 { _ = t.update(now: Int64(2 + i), meOn: true, myVideo: false, live: ["P\(i)"], peerVideo: false) }
        let people = t.update(now: 100, meOn: false, myVideo: false, live: nobody, peerVideo: false).records[0].people
        XCTAssertEqual(Array(people.prefix(3)), ["A", "B", "C"])
        XCTAssertEqual(people.count, CallTrack.peopleMax)
    }
}
