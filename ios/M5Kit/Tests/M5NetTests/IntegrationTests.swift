// The real transports: URLSessionWebSocketTask against a local WebSocket
// server (Network.framework, 127.0.0.1) — the hello, the join, presence, the
// server's close codes 4001 / 4003 through URLSession, a dropped connection
// and the reconnect with the resume secret; and URLSession for HTTP with a
// URLProtocol stub — redirects not followed, the size cap, the headers.

import Foundation
import Network
import Synchronization
import Testing
@testable import M5Net
import M5Core

/* ------------------------------------------- a local WebSocket server */

final class LocalWSConnection: @unchecked Sendable {
    let conn: NWConnection
    private let inbox = Mailbox<String>()

    init(_ conn: NWConnection) {
        self.conn = conn
        receiveNext()
    }

    private func receiveNext() {
        conn.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if let error { _ = error; self.inbox.close(); return }
            let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if meta?.opcode == .close { self.inbox.close(); return }
            if let data, meta?.opcode == .text, let s = String(data: data, encoding: .utf8) { self.inbox.put(s) }
            self.receiveNext()
        }
    }

    func send(_ frame: NetJSON) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "text", metadata: [meta])
        conn.send(content: Data(frame.text.utf8), contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
    }

    /// A close frame with this code.
    func close(_ code: UInt16, _ reason: String = "") {
        let meta = NWProtocolWebSocket.Metadata(opcode: .close)
        meta.closeCode = .privateCode(code)
        let ctx = NWConnection.ContentContext(identifier: "close", metadata: [meta])
        conn.send(content: Data(reason.utf8), contentContext: ctx, isComplete: true, completion: .contentProcessed { [conn] _ in
            conn.cancel()
        })
    }

    /// Drops the TCP connection without a close frame.
    func drop() { conn.forceCancel() }

    func next(_ type: String, timeout: Duration = .seconds(3)) async -> NetJSON? {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            guard let t = await inbox.take(timeout: deadline - ContinuousClock.now), let j = try? NetJSON.parse(t) else { return nil }
            if j.str("type") == type { return j }
        }
        return nil
    }
}

final class LocalWSServer: @unchecked Sendable {
    let listener: NWListener
    let connections = Mailbox<LocalWSConnection>()
    private let queue = DispatchQueue(label: "local-ws")

    init() async throws {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: params)
        let ready = Mailbox<Bool>()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.put(true)
            case .failed: ready.put(false)
            default: break
            }
        }
        listener.newConnectionHandler = { [connections, queue] conn in
            conn.start(queue: queue)
            connections.put(LocalWSConnection(conn))
        }
        listener.start(queue: queue)
        guard await ready.take(timeout: .seconds(5)) == true else { throw NetError.network("the local server did not start") }
    }

    var base: String { "http://127.0.0.1:\(listener.port!.rawValue)" }
    func accept(timeout: Duration = .seconds(5)) async -> LocalWSConnection? { await connections.take(timeout: timeout) }
    func stop() { listener.cancel() }
}

@Suite(.serialized) struct URLSessionHubTests {
    func connection(_ server: LocalWSServer, resume: (any HubResumeStore)? = nil) -> HubConnection {
        var timing = HubTiming.fast
        timing.connectTimeout = .seconds(5)
        return HubConnection(room: HubRoom(key: "k", server: server.base, roomId: "plain-room", name: "Alice"), transport: URLSessionHubTransport(),
                             resumeStore: resume, timing: timing, random: { 0.5 })
    }

    @Test func joinsAndHearsTheServersCloseCodes() async throws {
        let server = try await LocalWSServer()
        defer { server.stop() }
        for (code, frame, reason) in [(UInt16(4001), true, HubStopReason.replaced), (4001, false, .replaced), (4003, false, .closedByServer(""))] {
            let c = connection(server)
            await c.connect()
            let conn = try #require(await server.accept())
            conn.send(["type": "hello", "protocol": 2, "peerId": "p-1", "connId": "c-1", "serverTime": 1, "nonce": .string(Bytes.b64url(Data(count: 24)))])
            let join = try #require(await conn.next("join"))
            #expect(join.str("room") == "plain-room" && join["proof"] == nil && join.arr("features") == ["bin"])
            conn.send(["type": "joined", "protocol": 2, "peerId": .string(join.str("peerId")), "room": "plain-room", "resume": "cmVzdW1lLXJlc3VtZS1yZXN1bWUtcmVzdW1lMDA=", "peers": [], "away": [], "held": []])
            await eventually("joined") { await c.status == .joined }
            await c.setForeground(false)
            #expect(await conn.next("presence")?.bool("foreground", true) == false)
            if frame { conn.send(["type": "replaced", "reason": "the same client connected again"]) }
            conn.close(code, "bye")
            // 4001 / 4003 come through URLSession (with or without the frame before): no reconnect.
            await eventually("stopped \(code)") {
                if case .stopped = await c.status { return true }
                return false
            }
            let status = await c.status
            if case .stopped(.closedByServer) = status, case .closedByServer = reason {} else { #expect(status == .stopped(reason), "\(code)") }
            #expect(await server.accept(timeout: .milliseconds(300)) == nil)
        }
    }

    @Test func aDroppedConnectionComesBackAsTheSameMember() async throws {
        let server = try await LocalWSServer()
        defer { server.stop() }
        let c = connection(server, resume: StoredResumeStore(store: MemoryNetStateStore()))
        await c.connect()
        let first = try #require(await server.accept())
        first.send(["type": "hello", "protocol": 2, "peerId": "p-1", "connId": "c-1", "serverTime": 1])
        let join = try #require(await first.next("join", timeout: .seconds(3)))
        first.send(["type": "joined", "protocol": 2, "peerId": "peer-me", "room": "plain-room", "resume": "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0MDA=", "peers": [], "away": [], "held": []])
        await eventually("joined") { await c.status == .joined }
        #expect(!join.str("peerId").isEmpty)
        first.drop()
        let second = try #require(await server.accept())
        second.send(["type": "hello", "protocol": 2, "peerId": "p-2", "connId": "c-2", "serverTime": 1])
        let again = try #require(await second.next("join"))
        #expect(again.str("peerId") == "peer-me" && again.str("resume") == "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0MDA=")
        await c.disconnect()
        #expect(await second.next("leave") != nil)
    }

    @Test func aServerThatIsNotThereIsRetried() async throws {
        let c = HubConnection(room: HubRoom(key: "k", server: "http://127.0.0.1:9", roomId: "r", name: "n"), transport: URLSessionHubTransport(), timing: .fast)
        let log = EventLog.watch(c.events)
        await c.connect()
        await eventually("two attempts") { await log.count(.connecting) >= 2 }
        await c.shutdown()
    }
}

/* --------------------------------------------------- URLSession HTTP */

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let h = Self.handler else { return }
        var req = request
        if req.httpBody == nil, let stream = req.httpBodyStream {
            stream.open()
            var data = Data()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
            stream.close()
            req.httpBody = data
        }
        let (status, headers, body) = h(req)
        let res = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        if (300..<400).contains(status), let loc = headers["Location"], let to = URL(string: loc) {
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: to), redirectResponse: res)
        }
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized) struct URLSessionHTTPTests {
    func transport() -> URLSessionHTTPTransport {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubURLProtocol.self]
        return URLSessionHTTPTransport(configuration: c)
    }

    @Test func answersHeadersRedirectsAndTheCap() async throws {
        let seen = Mutexed<[String]>([])
        StubURLProtocol.handler = { req in
            seen.value.append("\(req.httpMethod ?? "") \(req.url!.path) \(req.value(forHTTPHeaderField: "User-Agent") ?? "") \(String(data: req.httpBody ?? Data(), encoding: .utf8) ?? "")")
            switch req.url!.path {
            case "/ok": return (200, ["Content-Type": "application/json"], Data(#"{"ok":true}"#.utf8))
            case "/moved": return (302, ["Location": "https://elsewhere.example/ok"], Data())
            case "/big": return (200, [:], Data(repeating: 0x41, count: 200_000))
            default: return (404, [:], Data(#"{"ok":false,"code":"nope","message":"not here"}"#.utf8))
            }
        }
        defer { StubURLProtocol.handler = nil }
        let http = HTTPClient(transport: transport(), userAgent: "M5cet-iOS/6.14.0")
        #expect(try await http.json("POST", URL(string: "https://h.example/ok")!, body: ["a": 1]).bool("ok"))
        #expect(seen.value.first == #"POST /ok M5cet-iOS/6.14.0 {"a":1}"#)
        await #expect(throws: HTTPError.self) { _ = try await http.json("GET", URL(string: "https://h.example/moved")!) }
        #expect(!seen.value.contains { $0.contains("elsewhere") })
        do {
            _ = try await http.send("GET", URL(string: "https://h.example/big")!, maxBytes: 100_000)
            Issue.record("no cap")
        } catch let e as NetError {
            guard case .tooLarge(let n) = e else { Issue.record("\(e)"); return }
            #expect(n > 100_000) // stopped as soon as it went over (no Content-Length here)
        }
        do {
            _ = try await http.json("GET", URL(string: "https://h.example/missing")!)
        } catch let e as HTTPError {
            #expect(e.status == 404 && e.code == "nope" && e.message == "not here")
        }
    }
}
