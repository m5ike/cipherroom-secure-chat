// A port of android/app/src/test/java/cz/m5cet/app/fn/ApiTest.java: the calls
// over URLSession (a URLProtocol in this process stands in for the server):
// headers, bodies, streams in pieces, failures with the server's words,
// cancelling closes the connection, no redirects, the command list kept 10 s
// per account, the assistant's conversation, the server's speech.

import Foundation
import M5Core
import M5Proto
import XCTest
@testable import M5cet

/// The server in this process: routes by path prefix, answers in pieces, records requests.
final class StubServerProtocol: URLProtocol, @unchecked Sendable {
    struct Answer: Sendable {
        var status = 200
        var headers: [String: String] = ["Content-Type": "application/json"]
        var chunks: [Data] = []
        /// Pieces of a stream that keeps coming until the app goes away (a ping every 50 ms).
        var pingForever = false
    }

    nonisolated(unsafe) static var routes: [String: @Sendable (URLRequest, Data) -> Answer] = [:]
    nonisolated(unsafe) static var seen: [String: (auth: String, type: String, query: String, body: Data)] = [:]
    nonisolated(unsafe) static var stopped = 0
    static let lock = NSLock()

    static func reset() { lock.lock(); routes = [:]; seen = [:]; stopped = 0; lock.unlock() }

    private var timer: Timer?
    private var going = true

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "stub.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let path = url.path
        var body = request.httpBody ?? Data()
        if body.isEmpty, let s = request.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            s.close()
        }
        Self.lock.lock()
        let key = Self.routes.keys.filter { path.hasPrefix($0) }.max { $0.count < $1.count }
        let handler = key.flatMap { Self.routes[$0] }
        if let key {
            Self.seen[key] = (request.value(forHTTPHeaderField: "Authorization") ?? "-", request.value(forHTTPHeaderField: "Content-Type") ?? "null",
                              url.query(percentEncoded: true) ?? "null", body)
        }
        Self.lock.unlock()
        guard let handler else {
            let r = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/html"])!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("<h1>Not found</h1>".utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let a = handler(request, body)
        if (300..<400).contains(a.status), let loc = a.headers["Location"], let to = URL(string: loc) {
            let r = HTTPURLResponse(url: url, statusCode: a.status, httpVersion: "HTTP/1.1", headerFields: a.headers)!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: to), redirectResponse: r)
            // Refused by the session's delegate: the redirect itself is the answer.
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let r = HTTPURLResponse(url: url, statusCode: a.status, httpVersion: "HTTP/1.1", headerFields: a.headers)!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        for c in a.chunks { client?.urlProtocol(self, didLoad: c) }
        if a.pingForever {
            let t = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
                guard let self, self.going else { return }
                self.client?.urlProtocol(self, didLoad: Data(": ping\n\n".utf8))
            }
            RunLoop.current.add(t, forMode: .common)
            timer = t
            return
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        going = false
        timer?.invalidate()
        Self.lock.lock(); Self.stopped += 1; Self.lock.unlock()
    }

    static func json(_ s: String, status: Int = 200) -> Answer { Answer(status: status, headers: ["Content-Type": "application/json; charset=utf-8"], chunks: [Data(s.utf8)]) }
    static func events(_ pieces: [String], forever: Bool = false) -> Answer {
        Answer(status: 200, headers: ["Content-Type": "text/event-stream; charset=utf-8"], chunks: pieces.map { Data($0.utf8) }, pingForever: forever)
    }
}

@MainActor
final class FnApiTests: XCTestCase {
    private var transport: FnURLSessionTransport!
    private let base = "https://stub.test/"

    override func setUp() async throws {
        StubServerProtocol.reset()
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubServerProtocol.self]
        transport = FnURLSessionTransport(configuration: c)
        StubServerProtocol.routes["/api/functions/run"] = { _, _ in
            StubServerProtocol.events([": ping\n\nevent: start\ndata: {\"runId\":\"run_1\"}\n\n",
                                       "event: progress\ndata: {\"p\":1,\"text\":\"ž\"}\n\nevent: done\ndata: {\"runId\":\"run_1\",\"status\":\"done\",\"outputs\":[{\"type\":\"text\",\"text\":\"hi\"}],\"visibility\":\"caller\"}\n\n"])
        }
        StubServerProtocol.routes["/api/functions/event"] = { _, _ in StubServerProtocol.events(["event: start\ndata: {\"runId\":\"run_2\"}\n\n"], forever: true) }
        StubServerProtocol.routes["/api/functions/commands"] = { _, _ in
            StubServerProtocol.json("{\"ok\":true,\"enabled\":true,\"commands\":[{\"keyword\":\"dns\",\"name\":\"DNS\",\"summary\":\"\",\"inputs\":[{\"name\":\"name\",\"type\":\"hostname\",\"required\":true}],\"events\":[\"button\"],\"model\":\"m1\"}]}")
        }
        StubServerProtocol.routes["/api/functions/runs/"] = { _, _ in StubServerProtocol.json("{\"ok\":true}") }
        StubServerProtocol.routes["/api/ai/status"] = { _, _ in
            StubServerProtocol.json("{\"ok\":true,\"enabled\":true,\"state\":\"ready\",\"default\":\"p/b\",\"models\":[{\"ref\":\"p/a\",\"label\":\"A\",\"reasoning\":true},{\"ref\":\"p/b\",\"label\":\"B\"}],\"limits\":{\"maxInputChars\":100}}")
        }
        StubServerProtocol.routes["/api/ai/chat"] = { _, body in
            let o = (try? JSON.parse(String(decoding: body, as: UTF8.self)))?.objectValue
            if (o?.array("messages")?.count ?? 0) >= 3 { return StubServerProtocol.json("{\"ok\":false,\"code\":\"rate\",\"message\":\"slow down\"}", status: 429) }
            return StubServerProtocol.events(["event: delta\ndata: {\"text\":\"Ahoj\"}\n\nevent: reasoning\ndata: {\"text\":\"hm\"}\n\nevent: delta\ndata: {\"text\":\" světe\"}\n\n",
                                              "event: done\ndata: {\"text\":\"Ahoj světe\",\"ms\":1200,\"usage\":{\"input\":3,\"output\":7}}\n\n"])
        }
        StubServerProtocol.routes["/api/speech/tts"] = { _, _ in StubServerProtocol.json("{\"ok\":true,\"audioBase64\":\"" + Data([1, 2, 3]).base64EncodedString() + "\",\"mime\":\"audio/wav\"}") }
        StubServerProtocol.routes["/api/speech/stt"] = { _, body in StubServerProtocol.json("{\"ok\":true,\"text\":\"slyším \(body.count)\"}") }
        StubServerProtocol.routes["/moved"] = { _, _ in StubServerProtocol.Answer(status: 302, headers: ["Location": "https://elsewhere.test/steal"]) }
    }

    private func api(_ b: String? = nil) -> FnApi { FnApi(base: b ?? base, transport: transport, userAgent: "M5cet-iOS/test") }

    private final class Box {
        var events: [String] = []
    }

    private func handlers(_ box: Box) -> FnRunHandlers {
        var h = FnRunHandlers()
        h.start = { box.events.append("start " + $0) }
        h.progress = { p, t in box.events.append("progress \(Js.numberToString(p)) \(t)") }
        h.done = { d in box.events.append("done \(d.outputs.count) \(d.visibility ?? "nil")") }
        h.error = { c, m in box.events.append("error \(c) \(m)") }
        return h
    }

    private func seen(_ key: String) -> (auth: String, type: String, query: String, body: JSONObject?) {
        StubServerProtocol.lock.lock()
        defer { StubServerProtocol.lock.unlock() }
        guard let s = StubServerProtocol.seen[key] else { return ("", "", "", nil) }
        return (s.auth, s.type, s.query, (try? JSON.parse(String(decoding: s.body, as: UTF8.self)))?.objectValue)
    }

    func testRunStreamsWithTheAccount() {
        let box = Box()
        let c = FnCommandsClient(api: api())
        _ = c.run(bearer: "Bearer tok", keyword: "dns", model: nil, inputs: JSONObject([("name", "a.cz")]),
                  origin: FnRun.Origin(room: nil, client: "dev1", lang: "cs", tz: "Europe/Prague"), handlers: handlers(box))
        waitUntil { box.events.count >= 3 }
        XCTAssertEqual(box.events, ["start run_1", "progress 1 ž", "done 1 caller"])
        let req = seen("/api/functions/run")
        XCTAssertEqual(req.auth, "Bearer tok")
        XCTAssertEqual(req.type, "application/json")
        XCTAssertEqual(req.body.map { JSON.object($0).canonical() },
                       JSON.object((try? JSON.parse("{\"keyword\":\"dns\",\"inputs\":{\"name\":\"a.cz\"},\"room\":null,\"client\":\"dev1\",\"lang\":\"cs\",\"tz\":\"Europe/Prague\",\"stream\":true}"))!.objectValue!).canonical())
    }

    func testAGuestSendsNoAuthorizationAndABareTokenGetsItsScheme() {
        XCTAssertNil(FnApi.authorization(""))
        XCTAssertEqual(FnApi.authorization("tok"), "Bearer tok")
        XCTAssertEqual(FnApi.authorization("Bearer tok"), "Bearer tok")
        XCTAssertEqual(FnApi.url("https://a.cz//", "/api/x"), "https://a.cz/api/x")
    }

    func testCancellingClosesTheConnection() {
        let box = Box()
        let meta = JSONObject([("keyword", "demo"), ("model", "m1"), ("chain", "chn_1"), ("call", 2)])
        let call = FnCommandsClient(api: api()).event(bearer: "", meta: meta, ev: Commands.button("go", nil), origin: FnRun.Origin(room: "room1", client: "", lang: "en", tz: nil),
                                                       handlers: handlers(box))
        waitUntil { box.events == ["start run_2"] }
        call.cancel()
        waitUntil { StubServerProtocol.stopped > 0 }
        settle(0.3)
        XCTAssertEqual(box.events, ["start run_2"]) // nothing more after the cancel
        let req = seen("/api/functions/event")
        XCTAssertEqual(req.auth, "-")
        XCTAssertEqual(req.body.map { JSON.object($0).canonical() },
                       JSON.object((try? JSON.parse("{\"model\":\"m1\",\"keyword\":\"demo\",\"chain\":\"chn_1\",\"call\":2,\"room\":\"room1\",\"client\":null,\"lang\":\"en\",\"type\":\"button\",\"name\":\"go\",\"stream\":true}"))!.objectValue!).canonical())
    }

    func testFailuresCarryTheServersWords() {
        let box = Box()
        _ = FnCommandsClient(api: api(base + "nothing-here")).run(bearer: "", keyword: "x", model: nil, inputs: nil, origin: FnRun.Origin(lang: "en"), handlers: handlers(box))
        waitUntil { !box.events.isEmpty }
        XCTAssertEqual(box.events, ["error error HTTP 404"])
        let dead = Box()
        _ = FnCommandsClient(api: FnApi(base: base, transport: DeadTransport())).run(bearer: "", keyword: "x", model: nil, inputs: nil, origin: FnRun.Origin(lang: "en"), handlers: handlers(dead))
        waitUntil { !dead.events.isEmpty }
        XCTAssertTrue(dead.events[0].hasPrefix("error network "), dead.events[0])
    }

    func testARedirectIsNeverFollowed() async {
        // The account's token would go elsewhere: the 302 is the answer.
        let r = await api().json("/moved", bearer: "Bearer secret")
        guard case .failure(let f) = r else { return XCTFail("followed a redirect") }
        XCTAssertEqual(f.status, 302)
        XCTAssertEqual(f.message, "HTTP 302")
    }

    func testTheCommandListIsKeptTenSecondsPerAccount() async {
        let clock = TestClock()
        var calls = 0
        let counting = FakeTransport()
        counting.route("/api/functions/commands") { _ in
            .json("{\"ok\":true,\"enabled\":true,\"commands\":[{\"keyword\":\"dns\",\"name\":\"DNS\",\"inputs\":[],\"events\":[\"button\"],\"model\":\"m1\"}]}")
        }
        let commands = FnCommandsClient(api: FnApi(base: base, transport: counting), now: { clock.now })
        XCTAssertNil(commands.state(bearer: "Bearer a").enabled)
        let s = await commands.refresh(bearer: "Bearer a")
        XCTAssertEqual(s.enabled, true)
        XCTAssertEqual(s.find("dns")?.model, "m1")
        XCTAssertEqual(s.find("dns")?.events, ["button"])
        _ = await commands.refresh(bearer: "Bearer a")
        calls = counting.seen("/api/functions/commands").count
        XCTAssertEqual(calls, 1)
        clock.advance(10_001)
        _ = await commands.refresh(bearer: "Bearer a")
        XCTAssertEqual(counting.seen("/api/functions/commands").count, 2)
        _ = await commands.refresh(bearer: "Bearer a", force: true)
        XCTAssertEqual(counting.seen("/api/functions/commands").count, 3)
        XCTAssertNil(commands.state(bearer: "Bearer b").enabled)
        _ = await commands.refresh(bearer: "Bearer b")
        XCTAssertEqual(counting.seen("/api/functions/commands").count, 4)
        XCTAssertEqual(counting.seen("/api/functions/commands").last?.authorization, "Bearer b")
        // A failure is "off", as on the web.
        let off = await FnCommandsClient(api: FnApi(base: base, transport: DeadTransport())).refresh(bearer: "")
        XCTAssertEqual(off.enabled, false)

        FnCommandsClient(api: api()).answer(bearer: "Bearer a", runId: "run 1", interactionId: "int_1", value: .object(JSONObject([("a", "b")])))
        await waitAsync { StubServerProtocol.seen["/api/functions/runs/"] != nil }
        XCTAssertEqual(seen("/api/functions/runs/").body.map { JSON.object($0).canonical() }, "{\"interactionId\":\"int_1\",\"value\":{\"a\":\"b\"}}")
    }

    func testTheAnswersPathIsEncoded() {
        XCTAssertEqual(FnCommandsClient.encode("run 1/ž"), "run%201%2F%C5%BE")
        XCTAssertEqual(FnCommandsClient.encode("a-b_c.d*e"), "a-b_c.d*e")
    }

    func testTheAssistantKeepsTheConversation() async {
        let ai = AiAssistant(api: api())
        ai.model = "p/a"
        let st = await ai.loadStatus(bearer: "Bearer t")
        XCTAssertEqual(st.state, "ready")
        XCTAssertEqual(st.maxInputChars, 100)
        XCTAssertEqual(st.maxOutputTokens, 2048)
        XCTAssertEqual(ai.model, "p/a")
        ai.setReasoning("high")
        var finished: [AiAssistant.Turn] = []
        ai.onFinished = { finished.append($0) }
        XCTAssertTrue(ai.send(bearer: "Bearer t", question: " Ahoj? "))
        await waitAsync { finished.count == 1 }
        XCTAssertEqual(finished.first?.text, "Ahoj světe")
        XCTAssertEqual(finished.first?.reasoning, "hm")
        XCTAssertEqual(finished.first?.outputTokens, 7)
        XCTAssertEqual(seen("/api/ai/chat").body.map { JSON.object($0).canonical() },
                       JSON.object((try? JSON.parse("{\"model\":\"p/a\",\"reasoning\":\"high\",\"messages\":[{\"role\":\"user\",\"content\":\"Ahoj?\"}],\"stream\":true}"))!.objectValue!).canonical())
        // The second question carries the first with its answer; a refusal is the server's code.
        XCTAssertTrue(ai.send(bearer: "Bearer t", question: "A dál?"))
        await waitAsync { finished.count == 2 }
        XCTAssertEqual(finished.dropFirst().first?.errorCode, "rate")
        XCTAssertEqual(finished.dropFirst().first?.errorMessage, "slow down")
        XCTAssertEqual(seen("/api/ai/chat").body?.array("messages")?.count, 3)
        XCTAssertEqual(seen("/api/ai/chat").body?.array("messages")?[1].objectValue?.optString("content"), "Ahoj světe")
        // A failed answer and its question are left out of the next one.
        XCTAssertTrue(ai.send(bearer: "Bearer t", question: "Třetí"))
        await waitAsync { finished.count == 3 }
        XCTAssertEqual(seen("/api/ai/chat").body?.array("messages")?.count, 3)
        XCTAssertEqual(seen("/api/ai/chat").body?.array("messages")?[2].objectValue?.optString("content"), "Třetí")
        XCTAssertFalse(ai.send(bearer: "Bearer t", question: "   "))
        XCTAssertEqual(ai.lastAnswer?.text, "Ahoj světe")
        XCTAssertEqual(ai.turns.count, 6)
    }

    func testSpeech() async {
        let speech = FnSpeech(api: api())
        guard case .success(let a) = await speech.tts(bearer: "Bearer t", text: "Ahoj", connector: "p/v", voice: nil) else { return XCTFail("no audio") }
        XCTAssertEqual(a.bytes, Data([1, 2, 3]))
        XCTAssertEqual(a.mime, "audio/wav")
        XCTAssertEqual(seen("/api/speech/tts").body.map { JSON.object($0).canonical() }, "{\"connector\":\"p/v\",\"text\":\"Ahoj\"}")
        guard case .success(let text) = await speech.stt(bearer: "", wav: Data("RIFF1234".utf8), connector: "p/w x") else { return XCTFail("no text") }
        XCTAssertEqual(text, "slyším 8")
        let req = seen("/api/speech/stt")
        XCTAssertEqual(req.type, "audio/wav")
        XCTAssertEqual(req.query, "connector=p%2Fw%20x")
        // The server's own status answer: speech off.
        let fake = FakeTransport()
        fake.route("/api/speech/status", ToolsFixtures.answer("speechStatus"))
        let st = await FnSpeech(api: FnApi(base: base, transport: fake)).status(bearer: "")
        XCTAssertEqual(st, FnSpeech.none)
    }
}
