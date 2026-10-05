// Ports of android/app/src/test/java/cz/m5cet/app/fn/{SseTest, RunWatchTest, RunTest}:
// Server-Sent Events arriving in any pieces, a run's clock and its single ending,
// a run's stream told to the listener and the message its outputs become.

import M5Core
import M5Proto
import XCTest
@testable import M5cet

final class FnSseTests: XCTestCase {
    private static let stream = ": ping\n\n"
        + "event: start\ndata: {\"runId\":\"run_1 Počasí ☀\"}\n\n"
        + ": ping\n\n"
        + "event: progress\ndata: {\"p\":0.5}\n\n"
        + "event: output\ndata:{\"text\":\n"
        + "data: \"a\\n\\nb 😀\"}\n\n"
        + "event: nothing\n\n"
        + "event: broken\ndata: {not json\n\n"
        + "event: scalar\ndata: 5\n\n"
        + "data: {\"plain\":true}\n\n"
        + "event:  done \ndata: {\"outputs\":[]}\n\n"
        + "event: tail\ndata: {\"never\":true}"

    private static let expected = [
        "start {\"runId\":\"run_1 Počasí ☀\"}",
        "progress {\"p\":0.5}",
        "output {\"text\":\"a\\n\\nb 😀\"}",
        "message {\"plain\":true}",
        "done {\"outputs\":[]}",
    ]

    private static func names(_ events: [(String, JSONObject)]) -> [String] { events.map { $0.0 + " " + JSON.object($0.1).stringify() } }

    func testWholeStream() throws {
        var sse = FnSse()
        XCTAssertEqual(Self.names(try sse.feed(Self.stream)), Self.expected)
    }

    func testTextSplitAtEveryPoint() throws {
        let bytes = Array(Self.stream.utf8)
        var cut = 0
        while cut <= bytes.count {
            var cut2 = cut
            while cut2 <= bytes.count {
                var sse = FnSse()
                var got = try sse.feed(Data(bytes[0..<cut]))
                got += try sse.feed(Data(bytes[cut..<cut2]))
                got += try sse.feed(Data(bytes[cut2...]))
                XCTAssertEqual(Self.names(got), Self.expected, "cut at \(cut)/\(cut2)")
                cut2 += 7
            }
            cut += 1
        }
    }

    /// Bytes in pieces of n — UTF-8 characters split between reads.
    func testBytesSplitInsideCharacters() throws {
        let bytes = Array(Self.stream.utf8)
        for n in 1...7 {
            var sse = FnSse()
            var got = [(String, JSONObject)]()
            var i = 0
            while i < bytes.count { got += try sse.feed(Data(bytes[i..<min(bytes.count, i + n)])); i += n }
            XCTAssertEqual(Self.names(got), Self.expected, "pieces of \(n)")
        }
    }

    func testALargeEventInManyPieces() throws {
        let big = String(repeating: "A", count: 300_000)
        let bytes = Array("event: done\ndata: {\"data\":\"\(big)\"}\n\n".utf8)
        var sse = FnSse()
        var got = [(String, JSONObject)]()
        var i = 0
        while i < bytes.count { got += try sse.feed(Data(bytes[i..<min(bytes.count, i + 1000)])); i += 1000 }
        XCTAssertEqual(Self.names(got), ["done {\"data\":\"\(big)\"}"])
    }

    /// The server's own stream (fixtures): every event, the pings left out.
    func testTheServersRunStream() throws {
        var sse = FnSse()
        let events = try sse.feed(ToolsFixtures.body("runReport"))
        XCTAssertEqual(events.map(\.0), ["start", "progress", "progress", "done"])
        XCTAssertEqual(events[1].1.optString("text"), "Looking up DNS…")
    }
}

final class FnRunWatchTests: XCTestCase {
    func testThirtySecondsOfSilenceEndIt() {
        var w = FnRunWatch(now: 1_000)
        XCTAssertEqual(w.remaining(1_000), 30_000)
        XCTAssertFalse(w.expired(30_999))
        XCTAssertTrue(w.expired(31_000))
        XCTAssertEqual(w.remaining(40_000), 0)
        XCTAssertTrue(w.settle(.timeout))
        XCTAssertEqual(w.ended, .timeout)
        // The answer that comes after the timeout changes nothing.
        XCTAssertFalse(w.settle(.done))
        XCTAssertEqual(w.ended, .timeout)
        XCTAssertFalse(w.expired(100_000))
        XCTAssertEqual(w.remaining(100_000), .max)
    }

    func testProgressAndEveryEventMoveTheClock() {
        var w = FnRunWatch(now: 0)
        w.alive(20_000)
        XCTAssertFalse(w.expired(45_000))
        w.alive(45_000)
        XCTAssertEqual(w.remaining(45_000), 30_000)
        XCTAssertTrue(w.expired(75_000))
    }

    func testAnOpenQuestionPausesItAndTheAnswerStartsItAfresh() {
        var w = FnRunWatch(now: 0)
        w.asked()
        XCTAssertTrue(w.paused)
        XCTAssertFalse(w.expired(10 * 60_000))
        XCTAssertEqual(w.remaining(10 * 60_000), .max)
        w.asked()
        w.answered(11 * 60_000)
        XCTAssertTrue(w.paused)
        w.answered(12 * 60_000)
        XCTAssertFalse(w.paused)
        XCTAssertEqual(w.remaining(12 * 60_000), 30_000)
        XCTAssertTrue(w.expired(12 * 60_000 + 30_000))
        var v = FnRunWatch(now: 0)
        v.answered(25_000)
        XCTAssertTrue(v.expired(30_000))
    }

    func testEveryEndingSettlesOnce() {
        for first in FnRunWatch.End.allCases {
            var w = FnRunWatch(now: 0)
            XCTAssertNil(w.ended)
            XCTAssertFalse(w.over)
            XCTAssertTrue(w.settle(first))
            XCTAssertTrue(w.over)
            for later in FnRunWatch.End.allCases { XCTAssertFalse(w.settle(later)) }
            XCTAssertEqual(w.ended, first)
            w.alive(1)
            w.asked()
            XCTAssertFalse(w.paused)
            XCTAssertFalse(w.expired(1_000_000))
        }
    }

    func testTheContractsTimeout() {
        XCTAssertEqual(FnRunWatch(now: 5).remaining(5), ModelIdentity.fnRunTimeoutMs)
        XCTAssertEqual(ModelIdentity.fnRunTimeoutMs, 30_000)
    }
}

@MainActor
final class FnRunTests: XCTestCase {
    @MainActor
    private final class Heard {
        var events: [String] = []
        var done: FnRun.Done?
        var asked: FnRun.Interaction?
        var alive = 0

        var handlers: FnRunHandlers {
            var h = FnRunHandlers()
            h.alive = { self.alive += 1 }
            h.start = { self.events.append("start " + $0) }
            h.progress = { p, t in self.events.append("progress \(Js.numberToString(p)) \(t)") }
            h.output = { self.events.append("output " + $0.optString("type")) }
            h.interaction = { i in self.asked = i; self.events.append("interaction \(i.kind) \(i.id)") }
            h.done = { d in self.done = d; self.events.append("done " + d.status) }
            h.error = { c, m in self.events.append("error \(c) \(m)") }
            return h
        }
    }

    private func obj(_ s: String) -> JSONObject { (try? JSON.parse(s))?.objectValue ?? JSONObject() }

    func testTheStreamInOrderThenOneEnd() {
        let h = Heard()
        let s = FnRunStream(h.handlers)
        s.event("start", obj("{\"runId\":\"run_1\"}"))
        s.event("progress", obj("{\"runId\":\"run_1\",\"type\":\"progress\",\"p\":0.5,\"text\":\"half\"}"))
        s.event("log", obj("{\"msg\":\"x\"}"))
        s.event("interaction", obj("{\"runId\":\"run_1\",\"id\":\"int_1\",\"kind\":\"form\",\"spec\":{\"title\":\"T\",\"fields\":[{\"name\":\"a\",\"required\":true,\"values\":[\"x\",\"y\"]},{\"label\":\"no name\"}]}}"))
        s.event("output", obj("{\"type\":\"text\",\"text\":\"hi\"}"))
        s.event("done", obj("{\"ok\":true,\"runId\":\"run_1\",\"status\":\"done\",\"outputs\":[{\"type\":\"text\",\"text\":\"hi\"}],\"error\":null,\"visibility\":\"room\",\"chain\":\"chn_1\",\"call\":0}"))
        s.event("error", obj("{\"code\":\"late\",\"message\":\"ignored\"}"))
        s.end()
        XCTAssertEqual(h.events, ["start run_1", "progress 0.5 half", "interaction form int_1", "output text", "done done"])
        XCTAssertEqual(h.alive, 5) // start, progress, log, interaction, output — not the end
        XCTAssertEqual(h.asked?.title, "T")
        XCTAssertEqual(h.asked?.fields.count, 1)
        XCTAssertEqual(h.asked?.fields.first?.required, true)
        XCTAssertEqual(h.asked?.fields.first?.values, ["x", "y"])
        XCTAssertEqual(h.asked?.runId, "run_1")
        XCTAssertEqual(h.done?.failedUnanswered, false)
        XCTAssertEqual(h.done?.call, 0)
    }

    func testAnNfcAskKeepsItsKindAndCommand() {
        let h = Heard()
        FnRunStream(h.handlers).event("interaction", obj("{\"runId\":\"run_2\",\"id\":\"int_9\",\"kind\":\"nfc\",\"spec\":{\"command\":{\"op\":\"emv-read\",\"args\":{\"maxApps\":2}}}}"))
        XCTAssertEqual(h.asked?.kind, "nfc")
        XCTAssertEqual(h.asked?.runId, "run_2")
        XCTAssertEqual(h.asked?.id, "int_9")
        XCTAssertEqual(h.asked?.spec.object("command")?.optString("op"), "emv-read")
        let other = Heard()
        FnRunStream(other.handlers).event("interaction", obj("{\"runId\":\"r\",\"id\":\"i\",\"kind\":\"weird\",\"spec\":{}}"))
        XCTAssertEqual(other.asked?.kind, "prompt")
    }

    func testFailuresAndAStreamThatStops() {
        let a = Heard()
        FnRunStream(a.handlers).fail(FnFailure(404, "no-command", "No such command, or it is not available to you."))
        XCTAssertEqual(a.events, ["error no-command No such command, or it is not available to you."])
        let b = Heard()
        FnRunStream(b.handlers).fail(FnFailure(502, "", "HTTP 502"))
        XCTAssertEqual(b.events, ["error error HTTP 502"])
        let c = Heard()
        let s = FnRunStream(c.handlers)
        s.event("error", obj("{\"code\":\"expired\",\"message\":\"over\"}"))
        s.end()
        XCTAssertEqual(c.events, ["error expired over"])
        let d = Heard()
        FnRunStream(d.handlers).end()
        XCTAssertEqual(d.events.first, "error incomplete The answer stopped before it was complete.")
    }

    func testTheMessageOfARun() {
        let d = FnRun.Done(obj("{\"runId\":\"r\",\"status\":\"done\",\"outputs\":[{\"type\":\"markdown\",\"text\":\"**hi**\"},"
            + "{\"type\":\"image\",\"mime\":\"image/png\",\"data\":\"" + String(repeating: "A", count: 800_000) + "\"}],\"error\":null,\"visibility\":\"room\","
            + "\"chain\":\"chn_1\",\"call\":2,\"model\":\"m1\",\"keyword\":\"demo\",\"name\":\"Demo\",\"events\":[\"button\",\"form\"]}"))
        let m = d.message(keyword: "fallback", name: "Fallback", visibility: "caller")
        XCTAssertTrue(m.room)
        XCTAssertEqual(m.text, "**hi**\n\n_(image: image/png)_")
        XCTAssertEqual(JSON.object(m.fn).canonical(), JSON.object(obj("{\"keyword\":\"demo\",\"name\":\"Demo\",\"model\":\"m1\",\"chain\":\"chn_1\",\"call\":2,\"events\":[\"button\",\"form\"],"
            + "\"outputs\":[{\"type\":\"markdown\",\"text\":\"**hi**\"},{\"type\":\"text\",\"text\":\"(image — too large to share in the room)\"}]}")).canonical())
        XCTAssertEqual(m.local.array("outputs")?.count, 2)
        XCTAssertEqual(m.local.array("outputs")?[1].objectValue?.optString("type"), "image")

        // Only browser code: the command's name is the text; nothing at all: "" (the app says functions.empty).
        let js = FnRun.Done(obj("{\"outputs\":[{\"type\":\"js\",\"code\":\"x\"}],\"handled\":true,\"error\":null}")).message(keyword: "demo", name: "Demo", visibility: "caller")
        XCTAssertEqual(js.text, "/demo")
        XCTAssertFalse(js.room)
        XCTAssertEqual(JSON.object(js.fn).canonical(), JSON.object(obj("{\"keyword\":\"demo\",\"name\":\"Demo\",\"origin\":\"error\",\"outputs\":[{\"type\":\"js\",\"code\":\"x\"}]}")).canonical())
        XCTAssertEqual(FnRun.Done(obj("{\"outputs\":[]}")).message(keyword: "demo", name: "Demo", visibility: "room").text, "")
        XCTAssertTrue(FnRun.Done(obj("{\"outputs\":[],\"error\":{\"type\":\"Error\",\"message\":\"boom\"}}")).failedUnanswered)
    }

    func testTheModelsIconTravelsWithItsAnswer() {
        let d = FnRun.Done(obj(ToolsFixtures.body("runReport").components(separatedBy: "\n\n").first { $0.hasPrefix("event: done") }!
            .components(separatedBy: "\n").first { $0.hasPrefix("data: ") }!.dropFirst(6).description))
        let m = d.message(keyword: "report", name: "Domain report", visibility: "caller", icon: "bot")
        XCTAssertEqual(m.fn.optString("icon"), "file-text") // the server's
        XCTAssertEqual(m.fn.optString("chain"), d.chain)
        XCTAssertFalse(m.room)
        XCTAssertEqual(m.local.array("outputs")?.first?.objectValue?.optString("type"), "html")
    }

    func testAPeersMetadataIsCheckedAgain() {
        XCTAssertEqual(FnRun.meta(.object(obj("{\"keyword\":\"demo\",\"name\":\"Demo\",\"chain\":\"chn_abc123def\",\"call\":3,\"events\":[\"button\",\"hack\",\"button\"],\"outputs\":[{\"type\":\"button\",\"name\":\"go\",\"title\":\"Go\"}]}"))).map { JSON.object($0).canonical() },
                       JSON.object(obj("{\"keyword\":\"demo\",\"name\":\"Demo\",\"chain\":\"chn_abc123def\",\"call\":3,\"events\":[\"button\"],\"outputs\":[{\"type\":\"button\",\"name\":\"go\",\"title\":\"Go\"}]}")).canonical())
        XCTAssertEqual(FnRun.meta(.object(obj("{\"keyword\":\"k\",\"model\":\"Bad Model\",\"chain\":\"chn_x\",\"call\":2.5,\"events\":[],\"outputs\":[{\"type\":\"nope\"}],\"origin\":\"error\"}"))).map { JSON.object($0).canonical() },
                       JSON.object(obj("{\"keyword\":\"k\",\"name\":\"k\",\"origin\":\"error\"}")).canonical())
        XCTAssertNil(FnRun.meta(.object(obj("{\"name\":\"no keyword\"}"))))
        XCTAssertNil(FnRun.meta(.string("fn")))
    }
}
