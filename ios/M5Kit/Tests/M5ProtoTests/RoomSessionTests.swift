// Two RoomSession actors in one room over an in-memory hub and data channels:
// join with the room proof, sealed signals, hellos, the protocol-4 handshake,
// a message, its receipt, a private message, and a third member who only gets
// what was meant for everyone.

import Foundation
import M5Core
import M5Crypto
@testable import M5Proto
import Synchronization
import Testing

/// The hub (hub.ts's routing, without rooms or limits) and the data channels, delivering in order.
final class FakeNet: Sendable {
    struct State {
        var queue: [@Sendable () async -> Void] = []
        var sessions: [String: RoomSession] = [:]
        var peerIds: [String: String] = [:] // name -> peer id
        var names: [String: String] = [:] // peer id -> name
        var members: [(id: String, name: String)] = []
        var open = Set<String>() // "from>to" peer ids
        var added: [String: [ChatMessage]] = [:]
        var changed: [String: [ChatMessage]] = [:]
        var hubSeen: [String: [JSONObject]] = [:]
        var proven: [String: Bool] = [:]
    }
    let state = Mutex(State())
    let keys: RoomKeys
    let nonce = Prim.b64url(Bytes(repeating: 7, count: 24))
    init(keys: RoomKeys) { self.keys = keys }

    func enqueue(_ work: @escaping @Sendable () async -> Void) { state.withLock { $0.queue.append(work) } }

    /// Runs everything queued, and what that queues, until nothing is left.
    func drain() async {
        while true {
            let next: (@Sendable () async -> Void)? = state.withLock { s in s.queue.isEmpty ? nil : s.queue.removeFirst() }
            guard let next else { return }
            await next()
        }
    }

    func session(_ name: String) -> RoomSession? { state.withLock { $0.sessions[name] } }
    func sessionOf(peer id: String) -> RoomSession? { state.withLock { s in s.names[id].flatMap { s.sessions[$0] } } }
    func peerId(_ name: String) -> String { state.withLock { $0.peerIds[name] ?? "" } }
    func added(_ name: String) -> [ChatMessage] { state.withLock { ($0.added[name] ?? []).filter { $0.kind != "sys" } } }
    func lastChange(_ name: String, _ id: String) -> ChatMessage? { state.withLock { ($0.changed[name] ?? []).last { $0.id == id } } }

    func hub(from name: String, _ f: JSONObject) {
        state.withLock { $0.hubSeen[name, default: []].append(f) }
        switch f.optString("type") {
        case "join":
            let id = f.optString("peerId")
            var proven = false
            if let p = f.object("proof") { proven = HubProof.verify(pub: p.optString("pub"), sig: p.optString("sig"), roomId: keys.roomId, nonce: nonce) }
            let (others, sessions): ([(id: String, name: String)], [String: RoomSession]) = state.withLock { s in
                let o = s.members
                s.members.append((id, f.optString("name")))
                s.peerIds[name] = id
                s.names[id] = name
                s.proven[name] = proven
                return (o, s.sessions)
            }
            let joined = JSONObject([("type", "joined"), ("peerId", .string(id)), ("proven", .bool(proven)),
                                     ("peers", .array(others.map { .object(JSONObject([("peerId", .string($0.id)), ("name", .string($0.name)), ("foreground", true)])) }))])
            enqueue { await sessions[name]?.hubFrame(joined) }
            for o in others {
                let frame = JSONObject([("type", "peer-joined"), ("peerId", .string(id)), ("name", f["name"] ?? ""), ("foreground", true)])
                if let s = sessionOf(peer: o.id) { enqueue { await s.hubFrame(frame) } }
            }
        case "signal":
            let from = peerId(name)
            let frame = JSONObject([("type", "signal"), ("source", .string(from)), ("payload", f["payload"] ?? .null)])
            if let s = sessionOf(peer: f.optString("target")) { enqueue { await s.hubFrame(frame) } }
        default: break
        }
    }

    func openChannel(_ a: String, _ b: String) {
        state.withLock { $0.open.formUnion([a + ">" + b, b + ">" + a]) }
        if let sa = sessionOf(peer: a) { enqueue { await sa.channelOpened(b) } }
        if let sb = sessionOf(peer: b) { enqueue { await sb.channelOpened(a) } }
    }

    func isOpen(_ a: String, _ b: String) -> Bool { state.withLock { $0.open.contains(a + ">" + b) } }
}

struct FakeTransport: RoomTransport {
    let name: String
    let net: FakeNet
    func sendHub(_ frame: JSONObject) { net.enqueue { [net, name] in net.hub(from: name, frame) } }
    func sendText(_ peerId: String, _ text: String) -> Bool {
        let me = net.peerId(name)
        guard net.isOpen(me, peerId), let s = net.sessionOf(peer: peerId) else { return false }
        net.enqueue { await s.peerText(me, text) }
        return true
    }
    func isOpen(_ peerId: String) -> Bool { net.isOpen(net.peerId(name), peerId) }
}

struct FakeEvents: RoomEvents {
    let name: String
    let net: FakeNet
    func added(_ message: ChatMessage, fresh: Bool) { net.state.withLock { $0.added[name, default: []].append(message) } }
    func changed(_ message: ChatMessage) { net.state.withLock { $0.changed[name, default: []].append(message) } }
    func roomChanged() {}
    func createPeer(_ peerId: String, name: String, initiator: Bool) {
        // WebRTC: the one who joined later offers.
        guard initiator, let me = net.session(self.name) else { return }
        net.enqueue { await me.sendSignal(peerId, JSONObject([("type", "offer"), ("sdp", "v=0")])) }
    }
    func dropPeer(_ peerId: String) {}
    func signal(from peerId: String, _ description: JSONObject) {
        if description.string("type") == "offer" { net.openChannel(net.peerId(name), peerId) }
    }
}

@Suite struct RoomSessionTests {
    static let keys = try! RoomKeys.derive(room: "session-room", passphrase: "a shared passphrase", memoryKiB: 64, passes: 1)

    func join(_ net: FakeNet, _ name: String) async -> RoomSession {
        let device = P4Device(store: P4Store(backend: MemoryRecordVault()), origin: "https://chat.example.org", account: nil)
        let s = RoomSession(key: "session-room", room: "session-room", label: "Session room", userName: name, keys: Self.keys, identity: ChatIdentity.generate(),
                            transport: FakeTransport(name: name, net: net), events: FakeEvents(name: name, net: net), device: device,
                            pins: NamePins(vault: MemoryRecordVault()), verifiedDevice: { _ in false })
        net.state.withLock { $0.sessions[name] = s }
        await s.socketOpened()
        await s.hubFrame(JSONObject([("type", "hello"), ("nonce", .string(net.nonce))]))
        await net.drain()
        return s
    }

    @Test func twoMembersTalkInProtocol4() async throws {
        let net = FakeNet(keys: Self.keys)
        let alice = await join(net, "Alice")
        let bob = await join(net, "Bob")
        let aliceId = net.peerId("Alice"), bobId = net.peerId("Bob")
        #expect(net.state.withLock { $0.proven["Alice"] == true && $0.proven["Bob"] == true })
        #expect(await alice.withCore { $0.connected && $0.proven })
        #expect(await alice.withCore { $0.peerList.map(\.id) } == [bobId])
        #expect(await bob.withCore { $0.peerList.map(\.id) } == [aliceId])
        let aliceV4 = await alice.withCore { $0.isV4(bobId) }, bobV4 = await bob.withCore { $0.isV4(aliceId) }
        #expect(aliceV4 && bobV4)
        #expect(await bob.withCore { $0.peer(aliceId)?.name } == "Alice")

        let sent = await alice.send(Outgoing(text: "ahoj Bobe"))
        await net.drain()
        let got = try #require(net.added("Bob").last)
        #expect(got.id == sent.id && got.text == "ahoj Bobe" && got.senderId == aliceId && got.senderName == "Alice" && !got.mine)
        #expect(net.added("Alice").last?.mine == true)

        // Bob's receipt goes in a batch (400 ms after the message; longer while the machine is busy).
        for _ in 0..<100 {
            try await Task.sleep(nanoseconds: 100_000_000)
            await net.drain()
            if await alice.withCore({ $0.message(sent.id)?.receipts.has(bobId) ?? false }) { break }
        }
        let mine = try #require(await alice.withCore { $0.message(sent.id) })
        #expect(mine.receipts.has(bobId))
        #expect(net.lastChange("Alice", sent.id) != nil)

        // A reply, quoting.
        var reply = Outgoing(text: "ahoj Alice")
        reply.replyTo = got
        let r = await bob.send(reply)
        await net.drain()
        let back = try #require(net.added("Alice").last)
        #expect(back.id == r.id && back.replyToId == sent.id && back.text == "ahoj Alice")

        await alice.disconnected()
        await bob.disconnected()
    }

    @Test func aPrivateMessageReachesOnlyItsRecipient() async throws {
        let net = FakeNet(keys: Self.keys)
        let alice = await join(net, "Alice")
        _ = await join(net, "Bob")
        let carol = await join(net, "Carol")
        let bobId = net.peerId("Bob")
        #expect(await alice.withCore { $0.peerList.count } == 2)
        #expect(await carol.withCore { $0.peerList.count } == 2)

        var o = Outgoing(text: "jen pro Boba")
        o.recipients = [bobId]
        o.recipientNames = ["Bob"]
        let m = await alice.send(o)
        await net.drain()
        #expect(net.added("Bob").last?.id == m.id)
        #expect(net.added("Bob").last?.to.isEmpty == false)
        #expect(!net.added("Carol").contains { $0.id == m.id })

        let all = await alice.send(Outgoing(text: "pro všechny"))
        await net.drain()
        #expect(net.added("Bob").contains { $0.id == all.id })
        #expect(net.added("Carol").contains { $0.id == all.id })
        // Carol's copy came once (no replay of the same id).
        #expect(net.added("Carol").filter { $0.id == all.id }.count == 1)
        for n in ["Alice", "Bob", "Carol"] { await net.session(n)?.disconnected() }
    }

    @Test func aSecondCopyOfAFrameIsNotShownTwice() async throws {
        let net = FakeNet(keys: Self.keys)
        let alice = await join(net, "Alice")
        let bob = await join(net, "Bob")
        let aliceId = net.peerId("Alice")
        // Capture what Alice sends to Bob, then replay it.
        let sent = await alice.send(Outgoing(text: "jednou"))
        await net.drain()
        #expect(net.added("Bob").filter { $0.id == sent.id }.count == 1)
        let payload = await alice.withCore { $0.payloadOf($0.message(sent.id)!) }
        // A room-key envelope of the same id from Alice's channel (a protocol-4 peer is heard in protocol 4 only).
        let env = try Envelopes.sealMessage(Self.keys, id: sent.id, payload: payload, identity: ChatIdentity.generate())
        await bob.peerText(aliceId, env.stringify())
        await net.drain()
        #expect(net.added("Bob").filter { $0.id == sent.id }.count == 1)
        await alice.disconnected()
        await bob.disconnected()
    }
}
