// The commands engine (android ui/parts/Fn.java) against the server's own
// answers (fixtures made by the real routes) and a manual clock: loading the
// composer and the commands, a run's bubble (start → progress → status) and the
// model's answer, a wrong call checked before it goes and the server's refusal,
// an unknown command, a question answered, a click on a button, the 30 s clock,
// a newer command replacing one in flight, a room answer sent end-to-end, the
// model's card, suggestions, the lock.

import Foundation
import M5Core
import M5Design
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class ToolsFnEngineTests: XCTestCase {
    private var clock: TestClock!
    private var transport: FakeTransport!
    private var engine: ToolsFnEngine!
    private var room: RecordingRoom!
    private var core: CoreModels!
    private var presenter: FakePresenter!
    private var host: DesignHost!

    override func setUp() async throws {
        clock = TestClock()
        transport = ToolsFixtures.server()
        room = RecordingRoom()
        core = toolsCore(room)
        presenter = FakePresenter()
        host = toolsHost()
        let c = clock!
        engine = ToolsFnEngine(transport: transport, now: { c.now })
        let core = self.core!
        engine.core = { core }
        engine.timerEnabled = false
        engine.presenter = presenter
        engine.deviceId = { "ios-device-1" }
        engine.host = host
    }

    /// Loads the composer and the commands (as entering the app does) and waits for them.
    private func loaded() {
        engine.load()
        waitUntil { self.engine.commands().state(bearer: "Bearer tok").enabled == true }
    }

    func testLoadingTheComposerAndTheCommands() {
        XCTAssertEqual(engine.commandChars, ["/"])
        loaded()
        XCTAssertEqual(transport.seen("/api/client-config").first?.authorization, "Bearer tok")
        let st = engine.commands().state(bearer: "Bearer tok")
        XCTAssertEqual(st.commands.map(\.keyword), ["ask", "check", "report", "roomy"])
        XCTAssertEqual(st.find("report")?.icon, "file-text")
        XCTAssertEqual(st.find("report")?.events, ["button"])
        XCTAssertEqual(st.find("check")?.inputs.first?.max, 10)
        // Another account: not this list.
        XCTAssertNil(engine.commands().state(bearer: "Bearer other").enabled)
    }

    func testARunsBubbleThenTheModelsAnswer() throws {
        loaded()
        XCTAssertTrue(engine.run(room: room, text: "/report example.org", host: host))
        // The call shows at once as my own bubble.
        XCTAssertEqual(room.log.first, "start /report example.org")
        waitUntil { self.room.answers.count == 1 }
        let call = try XCTUnwrap(room.messages.first)
        XCTAssertEqual(room.log.filter { $0.hasPrefix("progress") }, ["progress \(call.id) 0.3 Looking up DNS…", "progress \(call.id) 0.7 Checking TLS…"])
        XCTAssertEqual(room.log.last { $0.hasPrefix("status") }, "status \(call.id) ok Answered below answered")
        // The request: the model's id, the inputs as text, where it comes from.
        let req = try XCTUnwrap(transport.seen("/api/functions/run").first?.json)
        XCTAssertEqual(req.optString("model"), "tools-report")
        XCTAssertEqual(req.object("inputs")?.optString("host"), "example.org")
        XCTAssertEqual(req.optString("client"), "ios-device-1")
        XCTAssertEqual(req["room"], .null) // no blind room id known: never the plain name
        XCTAssertEqual(req["stream"], .bool(true))
        // A caller-only answer: an incoming message from system-messenger, a reply to the call, every output kept.
        let a = room.answers[0]
        XCTAssertEqual(a.identity.optString("keyword"), "report")
        XCTAssertEqual(a.identity.optString("icon"), "file-text")
        XCTAssertEqual(a.replyTo, call.id)
        XCTAssertEqual(a.local?.array("outputs")?.map { $0.objectValue?.optString("type") ?? "" }, ["html", "markdown", "table", "button"])
        XCTAssertTrue(a.text.contains("**ok**"))
        XCTAssertEqual(engine.running, 0)
        // The answer's face and its card.
        let m = try XCTUnwrap(room.messages.last)
        XCTAssertTrue(FnMessageContent.handles(m))
        XCTAssertFalse(FnMessageContent.isCall(m))
        XCTAssertTrue(FnMessageContent.wide(m))
        let card = try XCTUnwrap(engine.modelCard(for: m))
        XCTAssertEqual(card.optString("line"), "/report · only you see it")
        XCTAssertEqual(card["known"], .bool(true))
        XCTAssertEqual(card.optString("usage"), "/report <host>")
        XCTAssertEqual(card.optString("guide"), "/report example.org")
        XCTAssertEqual(card.optString("write"), "/report ")
        XCTAssertEqual(card.array("inputs")?.first?.objectValue?.optString("name"), "host")
        XCTAssertEqual(card["hasInputs"], .bool(true))
    }

    func testAWrongCallIsNotSent() throws {
        loaded()
        // n is required: the model's answer says what it expects; nothing went to the server.
        XCTAssertTrue(engine.run(room: room, text: "/check", host: host))
        XCTAssertTrue(transport.seen("/api/functions/run").isEmpty)
        let call = try XCTUnwrap(room.messages.first)
        XCTAssertEqual(room.log, ["start /check", "status \(call.id) error Wrong parameters bad-input", "answer check"])
        let card = try XCTUnwrap(room.answers.first?.share)
        XCTAssertEqual(card["problem"], .bool(true))
        XCTAssertEqual(card.optString("title"), "/check cannot run like this")
        XCTAssertEqual(card.array("outputs")?.first?.objectValue?.optString("type"), "markdown")
    }

    func testTheAppsOwnCheckCatchesARange() throws {
        loaded()
        // 40 is out of the model's 1–10: the app's own check, nothing goes to the server.
        XCTAssertTrue(engine.run(room: room, text: "/check n=40"))
        XCTAssertTrue(transport.seen("/api/functions/run").isEmpty)
        let md = room.answers.first?.share?.array("outputs")?.first?.objectValue?.optString("text") ?? ""
        XCTAssertTrue(md.contains("**Count** (`n`): out of range — expects a whole number 1–10"), md)
    }

    func testTheServersRefusalOfTheInputs() throws {
        loaded()
        // 5 passes the app's check; the server's own answer (the real one, for 40) refuses the range.
        engine.run(room: room, text: "/check n=4")  // a fine one first (ends as cancelled by the next)
        XCTAssertTrue(engine.run(room: room, text: "/check n=5"))
        waitUntil { self.room.answers.count == 1 }
        let call = try XCTUnwrap(room.messages.last { $0.id.hasPrefix("fncall") })
        XCTAssertEqual(room.log.last { $0.hasPrefix("status \(call.id)") }, "status \(call.id) error Wrong parameters bad-input")
        let md = room.answers.first?.share?.array("outputs")?.first?.objectValue?.optString("text") ?? ""
        XCTAssertTrue(md.contains("The server refused the call: Count: must be at most 10"), md)
    }

    func testAnUnknownCommandGoesAsTextAndTheListIsAskedAgain() {
        // Before the list came: not a command (sent as text), the list is asked for at once.
        XCTAssertFalse(engine.run(room: room, text: "/nothing here", host: host))
        waitUntil { !self.transport.seen("/api/functions/commands").isEmpty }
        XCTAssertFalse(engine.run(room: room, text: "hello", host: host))
        XCTAssertTrue(room.log.isEmpty)
    }

    func testANetworkFailureEndsTheRunWithItsWords() throws {
        loaded()
        transport.route("/api/functions/run", .json("{\"ok\":false,\"code\":\"rate\",\"message\":\"Too many function calls; slow down.\"}", status: 429))
        XCTAssertTrue(engine.run(room: room, text: "/report example.org", host: host))
        let call = try XCTUnwrap(room.messages.first)
        waitUntil { self.room.log.contains { $0.hasPrefix("status") } }
        XCTAssertEqual(room.log.last, "status \(call.id) error Too many function calls; slow down. rate")
        XCTAssertTrue(room.answers.isEmpty)
    }

    func testThirtySecondsWithoutASignOfLifeEndIt() throws {
        loaded()
        // The server says it started, then nothing more (the connection stays open).
        transport.route("/api/functions/run", .sse("event: start\ndata: {\"runId\":\"run_9\"}\n\n", stall: true))
        XCTAssertTrue(engine.run(room: room, text: "/report example.org", host: host))
        waitUntil { self.transport.open == 1 }
        settle()
        let call = try XCTUnwrap(room.messages.first)
        clock.advance(29_000)
        engine.checkClock()
        XCTAssertFalse(room.log.contains { $0.hasPrefix("status") })
        clock.advance(1_500)
        engine.checkClock()
        XCTAssertEqual(room.log.last, "status \(call.id) error The model did not answer within 30 s timeout")
        XCTAssertEqual(engine.running, 0)
        // Its connection was closed; nothing it says later counts.
        waitUntil { self.transport.open == 0 }
    }

    func testAQuestionPausesTheClockAndItsAnswerGoesToTheRun() throws {
        loaded()
        transport.route("/api/functions/run") { _ in
            .sse("event: start\ndata: {\"runId\":\"run_q\"}\n\nevent: interaction\ndata: {\"runId\":\"run_q\",\"id\":\"int_1\",\"kind\":\"prompt\",\"spec\":{\"text\":\"Your name?\"}}\n\n", stall: true)
        }
        XCTAssertTrue(engine.run(room: room, text: "/ask", host: host))
        waitUntil { self.presenter.asked.count == 1 }
        let (i, title, answer) = presenter.asked[0]
        XCTAssertEqual(i.text, "Your name?")
        XCTAssertEqual(title, "Asker")
        clock.advance(10 * 60_000)
        engine.checkClock()
        XCTAssertFalse(room.log.contains { $0.hasPrefix("status") }) // the person takes their time
        answer(.string("Alice"))
        waitUntil { !self.transport.seen("/api/functions/runs/").isEmpty }
        let sent = try XCTUnwrap(transport.seen("/api/functions/runs/").first)
        XCTAssertEqual(sent.path, "/api/functions/runs/run_q/events")
        XCTAssertEqual(sent.json?.optString("interactionId"), "int_1")
        XCTAssertEqual(sent.json?.optString("value"), "Alice")
        // The clock starts afresh after the answer.
        clock.advance(31_000)
        engine.checkClock()
        XCTAssertTrue(room.log.last?.hasSuffix("timeout") ?? false)
    }

    func testTheServersOwnQuestionStream() throws {
        loaded()
        XCTAssertTrue(engine.run(room: room, text: "/ask", host: host))
        waitUntil { self.presenter.asked.count == 1 }
        presenter.asked[0].2(.string("Alice"))
        waitUntil { self.room.answers.count == 1 }
        XCTAssertEqual(room.answers[0].text, "hi Alice")
        XCTAssertEqual(room.answers[0].identity.optString("icon"), "🙋")
        // (The replayed stream ends right after its question: the run's end takes the sheet away.)
        XCTAssertEqual(presenter.dismissed, 1)
    }

    func testANewerCommandReplacesTheOneInFlight() throws {
        loaded()
        transport.route("/api/functions/run") { req in
            req.json?.optString("keyword") == "report" ? .sse("event: start\ndata: {\"runId\":\"run_slow\"}\n\n", stall: true) : ToolsFixtures.answer("runAsk")
        }
        XCTAssertTrue(engine.run(room: room, text: "/report example.org", host: host))
        waitUntil { self.transport.open == 1 }
        let first = try XCTUnwrap(room.messages.first)
        XCTAssertTrue(engine.run(room: room, text: "/check n=3", host: host))
        XCTAssertTrue(room.log.contains("status \(first.id) info Cancelled — a newer command replaced it cancelled"))
        waitUntil { self.transport.cancelled >= 1 }
    }

    func testARoomModelsAnswerGoesToTheRoomWithItsIdentity() throws {
        let peers = RecordingRoom("team", peers: [PeerRef(id: "peer-alice", name: "Alice")])
        let c = toolsCore(peers)
        engine.core = { c }
        transport.route("/api/functions/run", .sse("event: done\ndata: {\"runId\":\"r\",\"status\":\"done\",\"outputs\":[{\"type\":\"markdown\",\"text\":\"Hello **room**\"}],\"error\":null,\"visibility\":\"room\",\"keyword\":\"roomy\",\"name\":\"Roomy\",\"icon\":\"\"}\n\n"))
        loaded()
        host.form["msgTo"] = .array([.string("peer-alice")])
        XCTAssertTrue(engine.run(room: peers, text: "/roomy", host: host))
        waitUntil { !peers.sent.isEmpty }
        let o = try XCTUnwrap(peers.sent.first)
        XCTAssertEqual(o.text, "Hello **room**")
        XCTAssertEqual(o.forwardedFrom, "/roomy")
        XCTAssertEqual(o.fn?.optString("keyword"), "roomy")
        XCTAssertEqual(o.replyTo?.id, peers.messages.first?.id) // a reply to the command here
        XCTAssertEqual(o.recipients, ["peer-alice"])           // the private selection of now
        XCTAssertEqual(o.recipientNames, ["Alice"])
        XCTAssertTrue(peers.log.contains { $0.hasSuffix("ok Sent to the room sent") })
    }

    func testARoomAnswerWithNobodyHereStaysHere() {
        transport.route("/api/functions/run", .sse("event: done\ndata: {\"runId\":\"r\",\"status\":\"done\",\"outputs\":[{\"type\":\"text\",\"text\":\"x\"}],\"error\":null,\"visibility\":\"room\"}\n\n"))
        loaded()
        XCTAssertTrue(engine.run(room: room, text: "/roomy", host: host))
        waitUntil { self.room.answers.count == 1 }
        XCTAssertTrue(room.sent.isEmpty)
        XCTAssertEqual(host.flashes.last?.text, "Nobody is here — only you see the result.")
    }

    func testAFailedRunThatNothingAnswered() {
        transport.route("/api/functions/run", .sse("event: done\ndata: {\"runId\":\"r\",\"status\":\"error\",\"outputs\":[],\"error\":{\"type\":\"Error\",\"message\":\"kaboom\"}}\n\n"))
        loaded()
        XCTAssertTrue(engine.run(room: room, text: "/roomy", host: host))
        waitUntil { self.room.log.contains { $0.hasPrefix("status") } }
        XCTAssertTrue(room.log.last?.hasSuffix("error kaboom failed") ?? false, room.log.last ?? "")
        XCTAssertEqual(host.flashes.last?.text, "Error while running the model's function /roomy: kaboom")
    }

    func testAClickOnTheModelsButton() throws {
        loaded()
        var m = ChatMessage()
        m.id = "answer-1"
        room.messages.append(m)
        let meta = JSONObject([("keyword", "report"), ("model", "tools-report"), ("chain", "chn_muvg8whdd2203a19874d199510bbccd5"), ("call", 0), ("events", ["button"])])
        var result: Bool?
        engine.event(key: "answer-1", meta: meta, ev: Commands.button("again", .object(JSONObject([("host", "example.org")]))), host: host) { result = $0 }
        waitUntil { result != nil }
        XCTAssertEqual(result, true)
        XCTAssertEqual(room.answers.first?.text, "again again example.org")
        XCTAssertEqual(room.answers.first?.replyTo, "answer-1") // the answer replies to the message clicked
        let req = try XCTUnwrap(transport.seen("/api/functions/event").first?.json)
        XCTAssertEqual(req.optString("type"), "button")
        XCTAssertEqual(req.optString("chain"), "chn_muvg8whdd2203a19874d199510bbccd5")
        XCTAssertEqual(req.object("data")?.optString("host"), "example.org")
    }

    func testAnExpiredSessionSaysSo() {
        transport.route("/api/functions/event", .json("{\"ok\":false,\"code\":\"expired\",\"message\":\"over\"}", status: 410))
        var result: Bool?
        engine.event(key: "x", meta: JSONObject([("keyword", "report"), ("chain", "chn_aaaaaaa")]), ev: Commands.button("go", nil), host: host) { result = $0 }
        waitUntil { result != nil }
        XCTAssertEqual(result, false)
        XCTAssertEqual(host.flashes.last?.text, "The command's session is over.")
    }

    func testSuggestionsAndTheArgumentHint() throws {
        loaded()
        let r = try XCTUnwrap(engine.suggest(text: "/rep", caret: 4, names: ["Alice"], recent: []))
        XCTAssertEqual(r.kind, "functions")
        XCTAssertEqual(r.items.first?.key, "report")
        let h = try XCTUnwrap(engine.hint(text: "/report ", caret: 8))
        XCTAssertEqual(h.command.keyword, "report")
        XCTAssertEqual(h.input?.name, "host")
        XCTAssertNil(engine.hint(text: "hello", caret: 5))
        // A command run puts it first next time (usage).
        engine.run(room: room, text: "/check n=2")
        let again = try XCTUnwrap(engine.suggest(text: "/", caret: 1, names: [], recent: []))
        XCTAssertEqual(again.items.first?.key, "check")
    }

    func testTheUsageIsKeptAndForgottenAtTheLock() {
        final class Store: FnUsageStore {
            var saved: JSONObject?
            var locked = false
            func loadUsage() -> JSONObject? { locked ? nil : saved ?? JSONObject() }
            func saveUsage(_ o: JSONObject) { saved = o }
        }
        let store = Store()
        engine.usageStore = store
        loaded()
        engine.run(room: room, text: "/check n=2")
        XCTAssertEqual(store.saved?.array("check")?.first, .int(1))
        engine.forget()
        store.locked = true
        engine.run(room: room, text: "/check n=3")
        XCTAssertEqual(store.saved?.array("check")?.first, .int(1)) // locked: nothing written
    }

    func testTheOriginNamesTheBlindRoomIdOnly() {
        engine.roomId = { _ in "team" }
        XCTAssertNil(engine.origin().room)
        engine.roomId = { _ in "r3.AbCdEfGhIjKlMnOpQr_-" }
        XCTAssertEqual(engine.origin().room, "r3.AbCdEfGhIjKlMnOpQr_-")
        XCTAssertEqual(engine.origin().client, "ios-device-1")
        XCTAssertEqual(engine.origin().tz, TimeZone.current.identifier)
    }

    func testAnNfcQuestionWithoutTheNfcPartIsAnsweredUnsupported() throws {
        loaded()
        transport.route("/api/functions/run", .sse("event: interaction\ndata: {\"runId\":\"run_n\",\"id\":\"int_n\",\"kind\":\"nfc\",\"spec\":{\"command\":{\"op\":\"scan\"}}}\n\n", stall: true))
        engine.run(room: room, text: "/ask", host: host)
        waitUntil { !self.transport.seen("/api/functions/runs/").isEmpty }
        let v = try XCTUnwrap(transport.seen("/api/functions/runs/").first?.json?.object("value"))
        XCTAssertEqual(v.optString("status"), "unsupported")
        XCTAssertTrue(presenter.asked.isEmpty)
    }

    func testAnOutputThatCouldNotBeShownIsReportedOnce() {
        let bridge = engine.outputsHost(host)
        let meta = JSONObject([("keyword", "report"), ("chain", "chn_aaaaaaa")])
        let key = "m-" + UUID().uuidString
        fnReport(bridge, key: key, meta: meta, index: 2, type: "ImageError", message: "bad")
        fnReport(bridge, key: key, meta: meta, index: 2, type: "ImageError", message: "bad")
        waitUntil { !self.transport.seen("/api/functions/event").isEmpty }
        settle()
        XCTAssertEqual(transport.seen("/api/functions/event").count, 1)
        let ev = transport.seen("/api/functions/event")[0].json
        XCTAssertEqual(ev?.optString("type"), "error")
        XCTAssertEqual(ev?.optInt("output"), 2)
        XCTAssertEqual(ev?.object("error")?.optString("type"), "ImageError")
        // Without a session, nothing is reported.
        fnReport(bridge, key: key + "-2", meta: JSONObject([("keyword", "x")]), index: 0, type: "", message: "")
        settle()
        XCTAssertEqual(transport.seen("/api/functions/event").count, 1)
    }

    func testFilesGoToThePresenter() {
        let bridge = engine.outputsHost(host)
        bridge.file(name: "a.txt", mime: "text/plain", data: Data("x".utf8), open: true)
        XCTAssertEqual(presenter.files.first?.0, "a.txt")
        XCTAssertEqual(presenter.files.first?.3, true)
    }
}
