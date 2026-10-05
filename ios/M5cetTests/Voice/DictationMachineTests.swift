// Port of android/app/src/test/java/cz/m5cet/app/voice/DictationMachineTest.java — 6.7: "dictation
// cannot be stopped" — the state machine behind the phone's dictation. A stop always ends it: the last
// words still come, a pending restart is dropped, a recogniser that does not end is aborted (the
// microphone is free), a late event of an old session changes nothing; a pause after silence starts
// it again; the app speaking pauses it.

import XCTest
@testable import M5cet

/// Timers run by hand.
@MainActor
final class ManualScheduler: DictationScheduler {
    var now: Int64 = 0
    private var next = 0
    private(set) var queue: [(at: Int64, id: Int, block: @MainActor () -> Void)] = []

    func post(_ ms: Int64, _ block: @escaping @MainActor () -> Void) -> AnyHashable {
        next += 1
        queue.append((now + ms, next, block))
        queue.sort { ($0.at, $0.id) < ($1.at, $1.id) }
        return next
    }

    func cancel(_ token: AnyHashable) { queue.removeAll { AnyHashable($0.id) == token } }

    func advance(_ ms: Int64) {
        let until = now + ms
        while let first = queue.first, first.at <= until {
            queue.removeFirst()
            now = first.at
            first.block()
        }
        now = until
    }
}

@MainActor
final class FakeDictationSession: DictationSession {
    let ev: any DictationEvents
    var stops = 0, aborts = 0
    init(_ ev: any DictationEvents) { self.ev = ev }
    func stop() { stops += 1 }
    func abort() { aborts += 1 }
}

private struct NoRecogniser: Error {}

@MainActor
private final class Rig: DictationEngine, DictationMachineListener {
    var sessions: [FakeDictationSession] = []
    var texts: [String] = [], errors: [String] = [], states: [String] = []
    let clock = ManualScheduler()
    var failStart = false
    var m: DictationMachine!

    init() { m = DictationMachine(engine: self, scheduler: clock, lang: "cs-CZ", listener: self) }

    func start(lang: String, events: any DictationEvents) throws -> any DictationSession {
        if failStart { throw NoRecogniser() }
        let s = FakeDictationSession(events)
        sessions.append(s)
        return s
    }

    /// States and errors in the order they came.
    var order: [String] = []

    func onText(_ text: String, fin: Bool) { texts.append((fin ? "F:" : "P:") + text) }
    func onState(_ state: DictationMachine.State) { states.append(state.rawValue); order.append(state.rawValue) }
    func onError(_ code: String) { errors.append(code); order.append("E:" + code) }

    var last: FakeDictationSession { sessions[sessions.count - 1] }
}

@MainActor
final class DictationMachineTests: XCTestCase {
    func testStopFinishesTheWordsThenIdle() {
        let r = Rig()
        XCTAssertTrue(r.m.start())
        r.last.ev.ready()
        XCTAssertTrue(r.m.listening)
        r.last.ev.partial("ahoj")
        r.m.toggle() // the same icon again
        XCTAssertEqual(.stopping, r.m.state)
        XCTAssertEqual(1, r.last.stops)
        r.last.ev.fin("ahoj jak se máš")
        r.last.ev.end()
        XCTAssertEqual(.idle, r.m.state)
        XCTAssertEqual(["P:ahoj", "F:ahoj jak se máš"], r.texts)
        XCTAssertEqual(["STARTING", "LISTENING", "STOPPING", "IDLE"], r.states)
        XCTAssertTrue(r.m.start())
    }

    func testARecogniserThatNeverEndsIsAbortedAndItsLateEventsIgnored() {
        let r = Rig()
        r.m.start()
        let s = r.last
        s.ev.ready()
        r.m.stop()
        r.clock.advance(1499)
        XCTAssertEqual(.stopping, r.m.state)
        r.clock.advance(1)
        XCTAssertEqual(.idle, r.m.state)
        XCTAssertEqual(1, s.aborts)
        s.ev.fin("late")
        s.ev.end()
        XCTAssertTrue(r.texts.isEmpty)
        r.clock.advance(60_000)
        XCTAssertEqual(1, r.sessions.count)
    }

    func testKeepsListeningAfterAPauseAndStopBetweenSessionsEndsIt() {
        let r = Rig()
        r.m.start()
        r.last.ev.ready()
        r.last.ev.error("no-speech")
        r.last.ev.end()
        XCTAssertEqual(.restarting, r.m.state)
        r.clock.advance(250)
        XCTAssertEqual(2, r.sessions.count)
        r.last.ev.ready()
        r.last.ev.end()
        r.m.stop() // while restarting: nothing listens, idle at once
        XCTAssertEqual(.idle, r.m.state)
        r.clock.advance(10_000)
        XCTAssertEqual(2, r.sessions.count)
        XCTAssertTrue(r.clock.queue.isEmpty)
        XCTAssertTrue(r.errors.isEmpty) // a pause is no error
    }

    func testALateEndOfAnOldSessionDoesNotTouchTheNewOne() {
        let r = Rig()
        r.m.start()
        let first = r.last
        first.ev.ready()
        first.ev.end()
        r.clock.advance(250)
        let second = r.last
        second.ev.ready()
        first.ev.end()
        first.ev.fin("ghost")
        XCTAssertEqual(.listening, r.m.state)
        XCTAssertTrue(r.texts.isEmpty)
    }

    func testAFatalErrorStopsForGoodAndIsSaid() {
        let r = Rig()
        r.m.start()
        r.last.ev.error("not-allowed")
        XCTAssertEqual(.idle, r.m.state)
        XCTAssertEqual(["not-allowed"], r.errors)
        XCTAssertEqual(1, r.last.aborts)
        r.clock.advance(10_000)
        XCTAssertEqual(1, r.sessions.count)
    }

    func testBusyWaitsLongerAndGivesUpAfterEndingAgainAndAgain() {
        let r = Rig()
        r.m.maxIdleRestarts = 2
        r.m.start()
        r.last.ev.error("busy")
        r.last.ev.end()
        r.clock.advance(250)
        XCTAssertEqual(1, r.sessions.count) // a busy recogniser gets more time
        r.clock.advance(450)
        XCTAssertEqual(2, r.sessions.count)
        r.last.ev.end()
        r.clock.advance(250)
        r.last.ev.end()
        XCTAssertEqual(.idle, r.m.state)
        XCTAssertEqual(["ended"], r.errors)
    }

    func testTheAppSpeakingPausesItAndItComesBack() {
        let r = Rig()
        r.m.start()
        let s = r.last
        s.ev.ready()
        r.m.pause()
        XCTAssertEqual(.paused, r.m.state)
        XCTAssertEqual(1, s.aborts)
        s.ev.end() // after our own abort: ignored
        r.clock.advance(5000)
        XCTAssertEqual(1, r.sessions.count)
        r.m.resume()
        XCTAssertEqual(2, r.sessions.count)
        XCTAssertEqual(.starting, r.m.state)
        r.m.pause()
        r.m.stop() // stopped while paused: idle
        XCTAssertEqual(.idle, r.m.state)
    }

    func testARecogniserThatCannotStart() {
        let r = Rig()
        r.failStart = true
        XCTAssertFalse(r.m.start())
        XCTAssertEqual(.idle, r.m.state)
        XCTAssertEqual(["unsupported"], r.errors)
    }

    func testTheErrorThatEndsItIsSaidBeforeItIsIdle() {
        // iOS: the owner hears why before it hears that the dictation ended (Android's order lost the error:
        // its Dictation drops the listener on IDLE, so the composer never flashed "not-allowed").
        let r = Rig()
        r.m.start()
        r.last.ev.error("audio-capture")
        XCTAssertEqual(["STARTING", "E:audio-capture", "IDLE"], r.order)
        let fail = Rig()
        fail.failStart = true
        fail.m.start()
        XCTAssertEqual(["STARTING", "E:unsupported", "IDLE"], fail.order)
        let tired = Rig()
        tired.m.maxIdleRestarts = 0
        tired.m.start()
        tired.last.ev.end()
        XCTAssertEqual(["STARTING", "E:ended", "IDLE"], tired.order)
    }

    func testAbortDropsAtOnce() {
        let r = Rig()
        r.m.start()
        r.last.ev.ready()
        r.m.abort()
        XCTAssertEqual(.idle, r.m.state)
        r.last.ev.fin("x")
        XCTAssertTrue(r.texts.isEmpty)
        XCTAssertEqual("STARTING", r.states.first)
    }
}
