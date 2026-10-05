// What the tools tests share: a fake HTTP transport (routes by path, answers in
// pieces, can keep a stream open), the server's own answers
// (fixtures/tools-server-fixtures.json, made by generate-tools-fixtures.ts from
// the real routes), a room / rooms / account that record what the engine asks
// of them, a fake voice and presenter, and a wait for the main actor's work.

import Foundation
import M5Core
import M5Design
import M5Proto
import Observation
import XCTest
@testable import M5cet

// MARK: - transport

/// One recorded request.
struct ToolsSeenRequest: Sendable {
    let method: String
    let path: String
    let query: String
    let headers: [String: String]
    let body: Data?

    var json: JSONObject? { body.flatMap { String(data: $0, encoding: .utf8) }.flatMap { (try? JSON.parse($0))?.objectValue } }
    var authorization: String? { headers["Authorization"] }
}

/// How a route answers.
struct ToolsFakeAnswer: Sendable {
    var status = 200
    var contentType = "application/json"
    /// The body in the pieces it is sent in.
    var chunks: [Data] = []
    /// The connection stays open after the pieces (a stream that says nothing more) — until cancelled.
    var stall = false
    /// A pause before each piece (ms).
    var gapMs = 0

    static func json(_ text: String, status: Int = 200) -> ToolsFakeAnswer { ToolsFakeAnswer(status: status, contentType: "application/json; charset=utf-8", chunks: [Data(text.utf8)]) }

    static func sse(_ text: String, pieces: Int = 1, stall: Bool = false) -> ToolsFakeAnswer {
        let bytes = Array(text.utf8)
        let size = max(1, (bytes.count + pieces - 1) / max(1, pieces))
        var chunks = [Data]()
        var i = 0
        while i < bytes.count { chunks.append(Data(bytes[i..<min(bytes.count, i + size)])); i += size }
        return ToolsFakeAnswer(status: 200, contentType: "text/event-stream; charset=utf-8", chunks: chunks, stall: stall)
    }
}

/// Answers by path (the longest matching prefix), records every request; nothing leaves the process.
final class ToolsFakeTransport: FnTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var routes: [(String, @Sendable (ToolsSeenRequest) -> ToolsFakeAnswer)] = []
    private var seenList: [ToolsSeenRequest] = []
    private var openStreams = 0
    private var cancelledStreams = 0

    /// A route (a later one for the same prefix replaces it).
    func route(_ prefix: String, _ answer: @escaping @Sendable (ToolsSeenRequest) -> ToolsFakeAnswer) {
        lock.withLock {
            routes.removeAll { $0.0 == prefix }
            routes.append((prefix, answer))
        }
    }

    func route(_ prefix: String, _ answer: ToolsFakeAnswer) { route(prefix) { _ in answer } }

    var seen: [ToolsSeenRequest] { lock.lock(); defer { lock.unlock() }; return seenList }
    func seen(_ path: String) -> [ToolsSeenRequest] { seen.filter { $0.path.hasPrefix(path) } }
    var open: Int { lock.lock(); defer { lock.unlock() }; return openStreams }
    var cancelled: Int { lock.lock(); defer { lock.unlock() }; return cancelledStreams }

    func open(_ request: FnRequest) async throws -> FnOpened {
        let comps = URLComponents(url: request.url, resolvingAgainstBaseURL: false)
        let s = ToolsSeenRequest(method: request.method, path: comps?.path ?? "", query: comps?.percentEncodedQuery ?? "", headers: request.headers, body: request.body)
        let handler = lock.withLock {
            seenList.append(s)
            return routes.filter { s.path.hasPrefix($0.0) }.max { $0.0.count < $1.0.count }?.1
        }
        guard let handler else {
            return FnOpened(head: FnHead(status: 404, contentType: "text/html"), body: AsyncThrowingStream { $0.yield(Data("<h1>Not found</h1>".utf8)); $0.finish() })
        }
        let a = handler(s)
        let (stream, c) = AsyncThrowingStream<Data, any Error>.makeStream()
        lock.withLock { openStreams += 1 }
        let feeder = Task {
            for chunk in a.chunks {
                if a.gapMs > 0 { try? await Task.sleep(for: .milliseconds(a.gapMs)) }
                if Task.isCancelled { return }
                c.yield(chunk)
            }
            if a.stall {
                while !Task.isCancelled { try? await Task.sleep(for: .milliseconds(20)) }
                return
            }
            c.finish()
        }
        c.onTermination = { [weak self] reason in
            feeder.cancel()
            guard let self else { return }
            self.lock.lock()
            self.openStreams -= 1
            if case .cancelled = reason { self.cancelledStreams += 1 }
            self.lock.unlock()
        }
        return FnOpened(head: FnHead(status: a.status, contentType: a.contentType), body: stream)
    }
}

/// A transport whose every call fails to connect.
struct ToolsDeadTransport: FnTransport {
    func open(_ request: FnRequest) async throws -> FnOpened { throw FnFailure.network("Could not connect to the server.") }
}

// MARK: - the server's answers

/// fixtures/tools-server-fixtures.json: the real routes' answers (see generate-tools-fixtures.ts).
enum ToolsFixtures {
    static let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/tools-server-fixtures.json")

    static let all: JSONObject = {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8), let o = (try? JSON.parse(text))?.objectValue else {
            fatalError("tools-server-fixtures.json missing — run generate-tools-fixtures.ts")
        }
        return o
    }()

    static func captured(_ name: String) -> JSONObject { all.object(name) ?? JSONObject() }
    static func body(_ name: String) -> String { captured(name).optString("body") }
    static func status(_ name: String) -> Int { captured(name).optInt("status") }
    static func request(_ name: String) -> JSONObject? { captured(name).object("request") }

    /// The captured answer as the fake transport gives it.
    static func answer(_ name: String, pieces: Int = 3, stall: Bool = false) -> ToolsFakeAnswer {
        let c = captured(name)
        let ct = c.optString("contentType")
        if ct.contains("event-stream") {
            var a = ToolsFakeAnswer.sse(c.optString("body"), pieces: pieces, stall: stall)
            a.status = c.optInt("status")
            return a
        }
        return ToolsFakeAnswer.json(c.optString("body"), status: c.optInt("status"))
    }

    /// A transport that answers every route the app uses like the server did.
    static func server() -> ToolsFakeTransport {
        let t = ToolsFakeTransport()
        t.route("/api/client-config", answer("clientConfig"))
        t.route("/api/functions/commands", answer("commands"))
        t.route("/api/functions/run") { req in
            switch req.json?.optString("keyword") {
            case "report": return answer("runReport")
            case "check": return answer("runBadInput")
            case "ask": return answer("runAsk")
            default: return answer("runUnknown")
            }
        }
        t.route("/api/functions/event", answer("eventButton"))
        t.route("/api/functions/runs/", .json("{\"ok\":true}"))
        t.route("/api/ai/status", answer("aiStatus"))
        t.route("/api/ai/chat", answer("aiChat", pieces: 7))
        t.route("/api/speech/status", answer("speechStatus"))
        return t
    }
}

// MARK: - the core's side

/// A connected room that records what the engine asks of it.
@MainActor
@Observable
final class ToolsRecordingRoom: RoomModel {
    let key: String
    var room: String { key }
    var label: String { key }
    var status = "joined"
    var notice = ""
    var connected: Bool { true }
    var unread = 0
    var lastActivity: Int64 = 0
    var messages: [ChatMessage] = []
    var restores = 1
    var historyReady = true
    var freshId: String?
    var revealRequest: String?
    let myId = "peer-me"
    let myName = "Mike"
    let myPublicKey = "BKeyMe"
    var people: [PersonItem] = []
    var peers: [PeerRef]
    var userCount: Int { peers.count + 1 }
    var call = CallInfo()
    var ktAlert = ""
    var scope: DesignValue { ["key": .string(key)] }

    /// What happened, in order ("start /x", "status id error label code", "progress id 0.5 text", "send …", "answer …").
    var log: [String] = []
    var sent: [Outgoing] = []
    var answers: [(identity: JSONObject, text: String, share: JSONObject?, local: JSONObject?, replyTo: String?)] = []
    private var n = 0

    init(_ key: String = "team", peers: [PeerRef] = []) {
        self.key = key
        self.peers = peers
    }

    func message(_ id: String) -> ChatMessage? { messages.last { $0.id == id } }
    func peerName(_ peerId: String) -> String? { peers.first { $0.id == peerId }?.name }
    func isHeld(_ messageId: String?) -> Bool { false }
    func heldCount(_ peerId: String) -> Int { 0 }
    func profile(of peerId: String) -> JSONObject? { nil }
    func accountKey(of peerId: String) -> String { "" }
    func safetyKeys(_ peerId: String) -> SafetyKeys { SafetyKeys(mine: "", theirs: "") }
    func safetyNumber(_ peerId: String) -> String { "" }
    func canPrivate(_ peerId: String) -> Bool { false }

    @discardableResult
    func send(_ o: Outgoing) -> String {
        n += 1
        sent.append(o)
        log.append("send " + o.text)
        var m = ChatMessage()
        m.id = "sent-\(n)"
        m.text = o.text
        m.mine = true
        m.fn = o.fn
        m.fnLocal = o.fnLocal
        messages.append(m)
        return m.id
    }

    func sendFile(vaultId: String, name: String, mime: String, size: Int64, _ o: Outgoing) {}
    func markRead(_ ids: [String]) {}
    func touch(_ id: String, _ change: @escaping @Sendable (inout ChatMessage) -> Void) {
        if let i = messages.lastIndex(where: { $0.id == id }) { change(&messages[i]) }
    }
    func hide(_ id: String, until: Int64, unlock: String?, why: String?) {}
    func deleteLocal(_ id: String) {}
    func vanished(_ id: String) {}
    func identityVerified(_ peerId: String, _ on: Bool) {}
    func addNote(text: String, fileName: String?, fileMime: String?, dataUrl: String?, filePath: String?, fileSize: Int64, toLabel: String?) {}

    func startFnCall(keyword: String, name: String, query: String, icon: String) -> ChatMessage? {
        n += 1
        var m = ChatMessage()
        m.id = "fncall-\(n)"
        m.mine = true
        m.text = query
        m.createdAt = EpochMs.now
        m.fnLocal = JSONObject([("keyword", .string(keyword)), ("name", .string(name)), ("query", .string(query)), ("pending", true), ("icon", .string(icon))])
        messages.append(m)
        log.append("start " + query)
        return m
    }

    func fnCallStatus(_ id: String, kind: String, label: String, code: String) {
        log.append("status \(id) \(kind) \(label) \(code)")
        touch(id) { m in
            m.fnLocal?["pending"] = false
            m.fnLocal?["progress"] = nil
            m.fnLocal?["status"] = .object(JSONObject([("kind", .string(kind)), ("label", .string(label)), ("code", .string(code))]))
        }
    }

    func fnCallProgress(_ id: String, progress: Double, text: String) {
        log.append("progress \(id) \(progress) \(text)")
        touch(id) { m in m.fnLocal?["progress"] = .object(JSONObject([("p", .double(progress)), ("text", .string(text))])) }
    }

    func addModelAnswer(identity: JSONObject, text: String, share: JSONObject?, local: JSONObject?, replyTo: ChatMessage?) -> ChatMessage? {
        n += 1
        answers.append((identity, text, share, local, replyTo?.id))
        log.append("answer " + identity.optString("keyword"))
        var m = ChatMessage()
        m.id = "fn-\(n)"
        m.senderId = ModelIdentity.systemMessengerId
        m.senderName = identity.optString("name")
        m.text = text
        m.model = identity
        m.fn = share
        m.fnLocal = local
        m.createdAt = EpochMs.now
        messages.append(m)
        return m
    }

    func refreshStats() {}
}

/// The rooms: one active room (or none).
@MainActor
@Observable
final class ToolsFakeRooms: RoomsModel {
    var rooms: [String: ToolsRecordingRoom] = [:]
    var savedKeys: [String] = []
    var activeKey = ""
    var switched: [String] = []

    init(_ active: ToolsRecordingRoom? = nil) {
        if let active { rooms[active.key] = active; activeKey = active.key; savedKeys = [active.key] }
    }

    var loaded: Bool { true }
    var items: [RoomItem] {
        savedKeys.map { RoomItem(key: $0, name: $0.capitalized, room: $0, users: 1, unread: 0, active: $0 == activeKey, connected: rooms[$0] != nil, status: "joined", selected: true) }
    }
    var open: [any RoomModel] { Array(rooms.values) }
    var selectedCount: Int { 0 }
    var connectedCount: Int { rooms.count }
    var unreadTotal: Int { 0 }
    var maxRooms: Int { 8 }
    var ktAlert: String { "" }
    func room(_ key: String) -> (any RoomModel)? { rooms[key] }
    func byServerId(_ id: String) -> (any RoomModel)? { nil }
    func saved(_ key: String) -> SavedRoom? {
        savedKeys.contains(key) ? SavedRoom(key: key, room: key, label: key, passphrase: "p", userName: "Mike", selected: true, lastActive: 0) : nil
    }
    func card(_ key: String) -> JSONObject? { nil }
    func switchTo(_ key: String) { switched.append(key); activeKey = key }
    func toggleSelected(_ key: String) {}
    func connectSelected() {}
    func leave(_ key: String) {}
    func forget(_ key: String) {}
    func join(room: String, passphrase: String, userName: String) -> String { room }
    func clone(_ key: String) -> String? { nil }
    func update(_ oldKey: String, room: String, passphrase: String, userName: String) -> String? { nil }
    func setVisible(_ visible: Bool) {}
    func dismissKtAlert() {}
}

@MainActor
@Observable
final class ToolsFakeAccount: AccountModel {
    var token: String
    init(_ token: String = "Bearer tok") { self.token = token }
    var signedIn: Bool { !token.isEmpty }
    var username: String { "alice" }
    var scope: DesignValue { ["signedIn": .bool(signedIn)] }
    func bearer() async -> String { token }
}

/// A core over the fakes.
@MainActor
func toolsCore(_ room: ToolsRecordingRoom? = ToolsRecordingRoom(), server: String = "https://chat.example.com", token: String = "Bearer tok") -> CoreModels {
    let c = CoreModels(rooms: ToolsFakeRooms(room), account: ToolsFakeAccount(token))
    c.server = server
    return c
}

/// Questions the engine asks, answered by the test.
@MainActor
final class ToolsFakePresenter: FnPresenting {
    var asked: [(FnRun.Interaction, String, (JSON?) -> Void)] = []
    var files: [(String, String, Data, Bool)] = []
    var dismissed = 0

    final class Handle: FnAskHandle {
        let onDismiss: () -> Void
        init(_ f: @escaping () -> Void) { onDismiss = f }
        func dismiss() { onDismiss() }
    }

    func ask(_ i: FnRun.Interaction, title: String, look: ToolsLook?, answer: @escaping (JSON?) -> Void) -> any FnAskHandle {
        asked.append((i, title, answer))
        return Handle { [weak self] in self?.dismissed += 1 }
    }

    func file(name: String, mime: String, data: Data, open: Bool, host: DesignHost?) { files.append((name, mime, data, open)) }
}

/// A voice that dictates what the test says.
@MainActor
@Observable
final class ToolsFakeVoice: ToolsVoice {
    var available = true
    var dictating = false
    var listening = false
    var speaking = false
    var said: [String] = []
    var fxAllowed = true
    var fxActive = false
    var fxTesting = "idle"
    var resets = 0
    @ObservationIgnored var sink: (@MainActor (String, Bool) -> Void)?

    func dictate(_ sink: @escaping @MainActor (String, Bool) -> Void) async -> Bool {
        self.sink = sink
        dictating = true
        listening = true
        return true
    }
    func stopDictation() { dictating = false; listening = false }
    func say(_ text: String) { said.append(text); speaking = true }
    func stopSpeaking() { speaking = false }
    func voices() async -> [DesignValue] { [["value": "", "label": "Default"], ["value": "cs-CZ", "label": "Čeština"]] }
    func fxToggleTest() { fxTesting = fxTesting == "idle" ? "recording" : "idle" }
    func fxResetCustom() -> [(String, DesignValue)] { resets += 1; return [("voiceFx.pitch", -5)] }
}

// MARK: - waiting

/// Turns the main run loop until `condition` holds (or fails after `timeout` seconds).
@MainActor
func toolsWait(_ timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) {
    let end = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > end { XCTFail("timed out waiting", file: file, line: line); return }
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
}

/// The same from an async test (the main actor is let go between the checks — a nested run loop would not run its jobs).
@MainActor
func toolsWaitAsync(_ timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async {
    let end = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > end { XCTFail("timed out waiting", file: file, line: line); return }
        try? await Task.sleep(for: .milliseconds(10))
    }
}

/// Lets queued main-actor work run.
@MainActor
func toolsSettle(_ seconds: TimeInterval = 0.1) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

/// A window host over the built-in design (English), its own settings.
@MainActor
func toolsHost() -> DesignHost {
    let h = RendererTestSupport.host(state: StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false, hasActiveRoom: true)))
    h.services.setLang("en")
    return h
}

/// A manual clock (ms).
final class ToolsTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t: Int64
    init(_ start: Int64 = 1_800_000_000_000) { t = start }
    var now: Int64 { lock.lock(); defer { lock.unlock() }; return t }
    func advance(_ ms: Int64) { lock.lock(); t += ms; lock.unlock() }
}
