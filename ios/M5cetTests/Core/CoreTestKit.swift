// What the core's tests share: an in-memory hub (server/signaling/hub.ts's
// routing as far as the rooms use it — hello with a nonce, join with the room
// proof, peers, signals, leave and held members, auth with an account, the
// relay for away members with its acks, key-bundles, kt-lookup, ping), data
// channels between the cores in memory (a loopback RoomWire: an offer opens
// both sides), and a whole AppCore over memory stores per test person.

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import XCTest
@testable import M5cet

// MARK: - the hub

final class FakeHub: HubTransport, @unchecked Sendable {
    struct Member {
        let id: String
        var name: String
        var account: String?
        let socket: FakeSocket
        let joinedAt: Int64
    }

    struct Away { let name: String; let since: Int64 }

    private let lock = NSLock()
    private var rooms: [String: [Member]] = [:]
    private var away: [String: [String: Away]] = [:]
    /// account → room → items
    private var relay: [String: [String: [JSONObject]]] = [:]
    private var seq: Int64 = 0
    let nonce = Prim.b64url(Bytes(repeating: 9, count: 24))
    private(set) var frames: [JSONObject] = []
    private(set) var proven: [String: Bool] = [:]

    func connect(to url: URL, headers: [String: String], timeout: Duration) async throws -> any HubSocket {
        let s = FakeSocket(hub: self)
        s.push(JSONObject([("type", "hello"), ("protocol", 2), ("peerId", ""), ("connId", .string(UUID().uuidString)), ("serverTime", .int(EpochMs.now)),
                           ("maxFrameBytes", 262_144), ("features", ["bin", "call-wake"]), ("nonce", .string(nonce))]))
        return s
    }

    var seenFrames: [JSONObject] { lock.withLock { frames } }
    func relayQueue(_ account: String) -> Int { lock.withLock { relay[account]?.values.reduce(0) { $0 + $1.count } ?? 0 } }

    private func memberOf(_ s: FakeSocket) -> (room: String, member: Member)? {
        for (r, list) in rooms { if let m = list.first(where: { $0.socket === s }) { return (r, m) } }
        return nil
    }

    func handle(_ s: FakeSocket, _ text: String) {
        guard let f = JSON.parseObject(text) else { return }
        var out: [(FakeSocket, JSONObject)] = []
        lock.withLock {
            frames.append(f)
            let now = EpochMs.now
            switch f.optString("type") {
            case "join":
                let roomId = f.optString("room"), id = f.optString("peerId")
                var ok = false
                if let p = f.object("proof") { ok = HubProof.verify(pub: p.optString("pub"), sig: p.optString("sig"), roomId: roomId, nonce: nonce) }
                proven[id] = ok
                var list = rooms[roomId] ?? []
                list.removeAll { $0.id == id }
                let others = list
                let m = Member(id: id, name: f.optString("name"), account: nil, socket: s, joinedAt: now)
                list.append(m)
                rooms[roomId] = list
                let peers: [JSON] = others.map { o in
                    var p = JSONObject([("peerId", .string(o.id)), ("name", .string(o.name)), ("joinedAt", .int(o.joinedAt)), ("foreground", true),
                                        ("lastSeen", .int(now)), ("proven", .bool(proven[o.id] ?? false))])
                    if let a = o.account { p["account"] = .string(a) }
                    return .object(p)
                }
                let aways: [JSON] = (away[roomId] ?? [:]).map { .object(JSONObject([("account", .string($0.key)), ("name", .string($0.value.name)), ("since", .int($0.value.since)), ("lastSeen", .int($0.value.since))])) }
                out.append((s, JSONObject([("type", "joined"), ("protocol", 2), ("peerId", .string(id)), ("room", .string(roomId)), ("resume", .string("res-" + id)),
                                           ("proven", .bool(ok)), ("peers", .array(peers)), ("away", .array(aways)), ("held", .array([]))])))
                for o in others {
                    out.append((o.socket, JSONObject([("type", "peer-joined"), ("peerId", .string(id)), ("name", .string(m.name)), ("joinedAt", .int(now)),
                                                      ("foreground", true), ("lastSeen", .int(now)), ("proven", .bool(ok))])))
                }
            case "auth":
                guard let (roomId, m) = memberOf(s) else { break }
                let account = "acc-" + f.optString("token")
                rooms[roomId] = rooms[roomId]!.map { x in var y = x; if x.id == m.id { y.account = account }; return y }
                out.append((s, JSONObject([("type", "auth-result"), ("ok", true), ("account", .object(JSONObject([("account", .string(account)), ("away", f["away"] ?? false)])))])))
                if away[roomId]?.removeValue(forKey: account) != nil {
                    for o in rooms[roomId]! where o.id != m.id { out.append((o.socket, JSONObject([("type", "peer-back"), ("account", .string(account)), ("peerId", .string(m.id)), ("name", .string(m.name))]))) }
                }
                for o in rooms[roomId]! where o.id != m.id {
                    out.append((o.socket, JSONObject([("type", "peer-updated"), ("peerId", .string(m.id)), ("name", .string(m.name)), ("account", .string(account))])))
                }
                if let items = relay[account]?[roomId], !items.isEmpty {
                    out.append((s, JSONObject([("type", "relay-deliver"), ("items", .array(items.map { .object($0) }))])))
                }
            case "signal":
                guard let (roomId, m) = memberOf(s), let t = rooms[roomId]?.first(where: { $0.id == f.optString("target") }) else { break }
                out.append((t.socket, JSONObject([("type", "signal"), ("source", .string(m.id)), ("payload", f["payload"] ?? .null)])))
            case "leave":
                guard let (roomId, m) = memberOf(s) else { break }
                rooms[roomId]!.removeAll { $0.id == m.id }
                for o in rooms[roomId]! { out.append((o.socket, JSONObject([("type", "peer-left"), ("peerId", .string(m.id))]))) }
            case "relay":
                guard let (roomId, m) = memberOf(s) else { break }
                for r in f.array("to") ?? [] {
                    guard let ref = r.stringValue else { continue }
                    seq += 1
                    var from = JSONObject([("peerId", .string(m.id)), ("name", .string(m.name))])
                    if let a = m.account { from["account"] = .string(a) }
                    let env = f.object("per")?.object(ref) ?? f.object("envelope")
                    let item = JSONObject([("id", .string("ri-\(seq)")), ("seq", .int(seq)), ("kind", "message"), ("messageId", f["messageId"] ?? ""),
                                           ("from", .object(from)), ("envelope", env.map { .object($0) } ?? .null), ("storedAt", .int(now)), ("attempts", 0)])
                    relay[ref, default: [:]][roomId, default: []].append(item)
                    out.append((s, JSONObject([("type", "relay-status"), ("messageId", f["messageId"] ?? ""), ("recipient", .object(JSONObject([("account", .string(ref)), ("name", .string(away[roomId]?[ref]?.name ?? ""))]))),
                                               ("state", "stored"), ("at", .int(now))])))
                }
            case "relay-ack":
                let ids = Set((f.array("ids") ?? []).compactMap(\.stringValue))
                for (acc, byRoom) in relay { for (r, items) in byRoom { relay[acc]![r] = items.filter { !ids.contains($0.optString("id")) } } }
            case "key-bundles": out.append((s, JSONObject([("type", "key-bundles"), ("ref", f["ref"] ?? ""), ("devices", .array([]))])))
            case "kt-lookup": out.append((s, JSONObject([("type", "kt-lookup"), ("ref", f["ref"] ?? ""), ("lookup", .null)])))
            case "ping": out.append((s, JSONObject([("type", "pong"), ("t", f["t"] ?? 0), ("serverTs", .int(now))])))
            case "presence": out.append((s, JSONObject([("type", "presence-ack"), ("away", false)])))
            default: break
            }
        }
        for (sock, frame) in out { sock.push(frame) }
    }

    /// The socket went without `leave`: the member stays listed as away (held) when signed in.
    func closed(_ s: FakeSocket) {
        var out: [(FakeSocket, JSONObject)] = []
        lock.withLock {
            guard let (roomId, m) = memberOf(s) else { return }
            rooms[roomId]!.removeAll { $0.id == m.id }
            let now = EpochMs.now
            for o in rooms[roomId]! {
                var left = JSONObject([("type", "peer-left"), ("peerId", .string(m.id)), ("held", true), ("name", .string(m.name)), ("since", .int(now)), ("lastSeen", .int(now))])
                if let a = m.account { left["account"] = .string(a) }
                out.append((o.socket, left))
            }
            if let a = m.account {
                away[roomId, default: [:]][a] = Away(name: m.name, since: now)
                for o in rooms[roomId]! { out.append((o.socket, JSONObject([("type", "peer-away"), ("account", .string(a)), ("name", .string(m.name)), ("since", .int(now)), ("lastSeen", .int(now))]))) }
            }
        }
        for (sock, frame) in out { sock.push(frame) }
    }
}

final class FakeSocket: HubSocket, @unchecked Sendable {
    private let hub: FakeHub
    private let stream: AsyncStream<HubMessage>
    private let cont: AsyncStream<HubMessage>.Continuation
    private let lock = NSLock()
    private var iterator: AsyncStream<HubMessage>.Iterator?
    private var closeCode: Int?

    init(hub: FakeHub) {
        self.hub = hub
        (stream, cont) = AsyncStream<HubMessage>.makeStream(bufferingPolicy: .unbounded)
        iterator = stream.makeAsyncIterator()
    }

    func push(_ f: JSONObject) { cont.yield(.text(f.stringify())) }

    func send(_ message: HubMessage) async throws {
        if lock.withLock({ closeCode != nil }) { throw HubSocketClosed(code: 1006, reason: "closed") }
        if case .text(let t) = message { hub.handle(self, t) }
    }

    func receive() async throws -> HubMessage {
        var it = lock.withLock { iterator }
        guard let m = await it?.next() else { throw HubSocketClosed(code: lock.withLock { closeCode } ?? 1006, reason: "") }
        lock.withLock { iterator = it }
        return m
    }

    func close(code: Int, reason: String) {
        let first: Bool = lock.withLock { if closeCode != nil { return false }; closeCode = code; return true }
        guard first else { return }
        hub.closed(self)
        cont.finish()
    }

    func abort() { close(code: 1006, reason: "abort") }
}

// MARK: - data channels in memory

/// The data channels of every test core: an offer opens the channel on both sides at once.
@MainActor
final class LoopbackNet {
    private(set) var wires: [LoopbackWire] = []
    private var open = Set<String>()
    private(set) var attached: [String] = []
    private(set) var detached: [String] = []

    func add(_ w: LoopbackWire) { wires.append(w) }
    func noteAttach(_ owner: String, _ key: String) { attached.append(owner + ":" + key) }
    func noteDetach(_ owner: String, _ key: String) { detached.append(owner + ":" + key) }

    func wire(of peerId: String) -> LoopbackWire? { wires.first { $0.myId == peerId && !$0.closed } }

    func isOpen(_ a: String, _ b: String) -> Bool { open.contains(a + ">" + b) }

    func connect(_ a: String, _ b: String) {
        guard !isOpen(a, b) else { return }
        open.formUnion([a + ">" + b, b + ">" + a])
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.wire(of: a)?.controller?.wireOpened(b)
                self.wire(of: b)?.controller?.wireOpened(a)
            }
        }
    }

    func disconnect(_ a: String) {
        for x in open where x.hasPrefix(a + ">") || x.hasSuffix(">" + a) { open.remove(x) }
        for w in wires where !w.closed {
            if w.myId == a { for p in w.peerIds { w.controller?.wireClosed(p) } } else { w.controller?.wireClosed(a) }
        }
    }

    func deliver(_ from: String, _ to: String, text: String?, binary: Data?) -> Bool {
        guard isOpen(from, to) else { return false }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard let w = self.wire(of: to) else { return }
                if let text { w.controller?.wireText(text, from: from) }
                if let binary { w.controller?.wireBinary(binary, from: from) }
            }
        }
        return true
    }
}

@MainActor
final class LoopbackWire: RoomWire {
    let net: LoopbackNet
    weak var controller: RoomController?
    var closed = false
    private(set) var peerIds: [String] = []

    init(net: LoopbackNet, controller: RoomController) { self.net = net; self.controller = controller }

    var myId: String { controller?.myId ?? "" }

    func roomJoined() {}

    func addPeer(id: String, name: String?, initiator: Bool) {
        if !peerIds.contains(id) { peerIds.append(id) }
        // WebRTC: the one who joined later offers; the answer side opens the channel.
        if initiator { controller?.wireSignal(JSONObject([("type", "offer"), ("sdp", "v=0")]), to: id) }
    }

    func renamePeer(id: String, name: String) {}
    func removePeer(id: String) { peerIds.removeAll { $0 == id } }

    func receiveSignal(_ description: JSONObject, from peerId: String, name: String?) {
        if !peerIds.contains(peerId) { peerIds.append(peerId) }
        if description.optString("type") == "offer" { net.connect(myId, peerId) }
    }

    func sendText(_ text: String, to peerId: String) -> Bool { net.deliver(myId, peerId, text: text, binary: nil) }
    func sendBinary(_ data: Data, to peerId: String) -> Bool { net.deliver(myId, peerId, text: nil, binary: data) }
    func isOpen(_ peerId: String) -> Bool { net.isOpen(myId, peerId) }
    var openPeerIds: [String] { peerIds.filter { net.isOpen(myId, $0) } }
    func waitForBuffer(of peerId: String) async {}
    func peerAudioStatus(_ status: String, from peerId: String) {}
    var peerStates: [WirePeer] { peerIds.map { WirePeer(id: $0, name: "", status: net.isOpen(myId, $0) ? "open" : "connecting", audio: "off", rttMs: -1) } }
    var callState: String { "off" }
    var callVideo: Bool { false }
    func refreshStats() async {}
    func disconnect() { closed = true }
}

/// The CallSystem seam in tests: the wires come from the loopback, attach / detach are recorded.
@MainActor
final class LoopbackWires: RoomWireFactory {
    let net: LoopbackNet
    let owner: String
    init(net: LoopbackNet, owner: String) { self.net = net; self.owner = owner }

    private var mine: [String: LoopbackWire] = [:]

    func attach(roomKey: String, label: String, controller: RoomController) -> any RoomWire {
        net.noteAttach(owner, roomKey)
        let w = LoopbackWire(net: net, controller: controller)
        mine[roomKey] = w
        net.add(w)
        return w
    }

    func detach(roomKey: String) {
        net.noteDetach(owner, roomKey)
        if let w = mine.removeValue(forKey: roomKey) {
            net.disconnect(w.myId)
            w.closed = true
        }
    }
}

// MARK: - a person's core

@MainActor
final class TestDevice: DeviceEnrolling {
    var enrolled = true
    var server = "http://hub.test"
    var state: DeviceState? { DeviceState(server: server, deviceId: "dev", serverKey: "k") }
    var define: DesignValue = ["greeting": "ahoj"]
    var prefill: (server: String, code: String, kid: String, seq: Int)?
    var suggestedServer: String { server }
    func enroll(server: String, code: String, name: String, pinKid: String) async throws { enrolled = true }
    func checkIn(reason: String) async -> Bool { true }
    func takeLinkNotice(t: (String) -> String) -> (text: String, level: FlashLevel)? { nil }
}

@MainActor
final class FakePasskeys: PasskeyAuthorizing {
    var registration: PasskeyRegistration?
    var assertion: PasskeyAssertion?
    var failure: PasskeyFailure?
    private(set) var created: [PasskeyCreationOptions] = []
    private(set) var asserted: [PasskeyRequestOptions] = []

    func create(_ options: PasskeyCreationOptions) async throws -> PasskeyRegistration {
        created.append(options)
        if let failure { throw failure }
        guard let registration else { throw PasskeyFailure(code: "cancelled", message: "") }
        return registration
    }

    func assert(_ options: PasskeyRequestOptions) async throws -> PasskeyAssertion {
        asserted.append(options)
        if let failure { throw failure }
        guard let assertion else { throw PasskeyFailure(code: "cancelled", message: "") }
        return assertion
    }
}

@MainActor
struct TestPerson {
    let name: String
    let core: AppCore
    let security: MemorySecurity
    let device: TestDevice

    static func make(_ name: String, hub: FakeHub, net: LoopbackNet, security: MemorySecurity? = nil) -> TestPerson {
        let suite = "cz.m5cet.tests.core." + name
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        let services = DesignServices(store: SettingsStore(defaults: d))
        let sec = security ?? MemorySecurity()
        let dev = TestDevice()
        var timing = HubTiming()
        timing.backoffBaseMs = 50
        timing.backoffMinMs = 10
        let core = AppCore(security: sec, device: dev, services: services, hub: HubRooms(transport: hub, timing: timing),
                           wires: LoopbackWires(net: net, owner: name), fileStore: MemoryFileStore(), passkeys: FakePasskeys())
        core.setUserName(name)
        core.models.userName = name
        return TestPerson(name: name, core: core, security: sec, device: dev)
    }

    var rooms: RoomsController { core.rooms }
    func room(_ key: String) -> RoomController? { core.rooms.controller(key) }
}

/// Waits (polling the main actor) until `condition` holds; fails after `timeout`.
@MainActor
func eventually(_ what: String, timeout: TimeInterval = 20, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return }
        try? await Task.sleep(for: .milliseconds(50))
    }
    XCTFail("timed out: " + what, file: file, line: line)
}
