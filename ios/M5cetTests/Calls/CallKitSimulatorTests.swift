// The real CallKit of the app (CallSystem.shared, installed at launch) on the
// simulator: a VoIP push that cannot be opened is reported and ended, and a
// call started from the app runs — through CallKit where the simulator
// accepts the transaction, without it ("direct") where it refuses. Which of
// the two happened is printed (the README notes what the simulator does).

import XCTest
@testable import M5cet

@MainActor
final class CallKitSimulatorTests: XCTestCase {
    func testTheRealCallKitTakesAPushReport() async {
        var completed = false
        CallSystem.shared.center.reportVoIP(nil) { completed = true }
        let done = await eventually(10) { completed }
        XCTAssertTrue(done, "CallKit answered the report (PushKit's completion ran)")
        XCTAssertTrue(CallSystem.shared.center.calls.isEmpty)
    }

    func testACallFromTheAppRunsWithOrWithoutCallKit() async throws {
        let system = CallSystem.shared
        let link = RecordingLink()
        let room = system.attach(roomKey: "sim-test", label: "Simulator", link: link)
        defer { system.detach(roomKey: "sim-test") }
        system.center.startCall(roomKey: "sim-test", video: false)
        let started = await eventually(10) { room.inCall }
        XCTAssertTrue(started)
        let call = try XCTUnwrap(system.center.call(forRoom: "sim-test"))
        print("[calls] CallKit on this simulator: \(call.direct ? "refused the transaction — the call ran direct" : "accepted the transaction")")
        XCTAssertEqual(link.statuses.first, .live)
        system.endCall(roomKey: "sim-test")
        let ended = await eventually(10) { !room.inCall && system.center.call(forRoom: "sim-test") == nil }
        XCTAssertTrue(ended)
        XCTAssertEqual(link.statuses.last, .off)
    }
}
