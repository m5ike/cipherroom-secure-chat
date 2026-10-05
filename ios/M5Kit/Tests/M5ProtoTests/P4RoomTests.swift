// Protocol 4 between rooms (android P4RoomTest): two or three P4Rooms wired
// through an ordered in-memory "data channel" — hello v4 both ways, the KEM
// messages, the session, sender keys v4 with their cert, private messages over
// the ratchet, file keys, what waits for a session, the downgrade rule, an
// older peer, resets, and the 6.12 review fixes (P03, P13).

import Foundation
import M5Core
import M5Crypto
@testable import M5Proto
import Testing

final class P4Harness {
    static let room = "r3.p4RoomTestRoomId", check = "00112233aabbccdd"

    final class Side: P4RoomLink, P4HelloExtras {
        let id: String
        let identity: ChatIdentity
        let store = P4Store(backend: MemoryRecordVault())
        var room: P4Room!
        unowned let h: P4Harness
        var privateIn = [JSONObject](), roomIn = [JSONObject]()
        var established = [String]()
        var rehellos = 0, floods = 0
        var withBundle = false, badAccount = false, refuse = false

        init(_ id: String, _ identity: ChatIdentity, _ h: P4Harness) {
            self.id = id
            self.identity = identity
            self.h = h
            room = P4Room(roomId: P4Harness.room, check: P4Harness.check, identity: identity, store: store, extras: nil, link: nil)
            room.connect(link: self, extras: self)
        }

        func mailbox() -> JSONObject? {
            guard withBundle else { return nil }
            return (try? Mailbox(store: store.mailbox, signer: IdentitySigner(identity)).current(SystemClock().now()))??.bundle.json
        }
        func account() -> JSONObject? { badAccount ? JSONObject([("x", 1)]) : nil }
        func sth() -> JSONObject? { nil }

        func v3(_ to: String) throws -> JSONObject {
            JSONObject([("kind", "hello"), ("v", 3), ("check", .string(P4Harness.check)), ("pk", .string(identity.publicKey)), ("dh", .string(identity.dhPublicKey)),
                        ("sig", .string(try identity.sign(Prim.utf8("m5cet/hello/1|room|\(id)|\(to)|\(P4Harness.check)|\(identity.dhPublicKey)")))),
                        ("caps", .array(["bin"]))])
        }

        /// Our hello to `to` (v4, or v3 when `v3only` — or when our hello v4 cannot be made).
        func hello(_ to: Side, v3only: Bool) throws {
            let v3 = try v3(to.id)
            let made = room.hello(myId: id, peerId: to.id, v3: v3)
            h.wire.append((self, to, (v3only ? v3 : made ?? v3).stringify()))
        }

        func send(_ peerId: String, _ text: String) -> Bool {
            if refuse { return false }
            h.wire.append((self, h.side(peerId), text))
            return true
        }
        func delivered(_ peerId: String, _ payload: JSONObject, _ signer: Envelopes.Signer, pairSealed: Bool) {
            #expect(signer.valid)
            #expect(signer.publicKey == h.side(peerId).identity.publicKey)
            if pairSealed { privateIn.append(payload) } else { roomIn.append(payload) }
        }
        func established(_ peerId: String) { established.append(peerId) }
        func rehello(_ peerId: String) { rehellos += 1; try? hello(h.side(peerId), v3only: false) }
        func flood(_ peerId: String) { floods += 1 }
    }

    var wire = [(from: Side, to: Side, text: String)]()
    var sides = [Side]()
    var verdicts = [String]()
    var lastHello = [String: JSONObject]()
    var resetFrames = 0

    func side(_ id: String) -> Side { sides.first { $0.id == id }! }

    func add(_ id: String, _ identity: ChatIdentity = ChatIdentity.generate()) -> Side {
        let s = Side(id, identity, self)
        sides.append(s)
        return s
    }

    /// Delivers everything on the wire, in order, as the room session would.
    func pump() throws {
        while !wire.isEmpty {
            let w = wire.removeFirst()
            let raw = JSON.parseObject(w.text)!
            switch raw.optString("kind") {
            case "hello":
                lastHello[w.from.id + ">" + w.to.id] = raw
                // A new hello from a peer we have a session with (it re-helloed): ours first.
                if let ps = w.to.room.peer(w.from.id), ps.hasSession, !w.to.room.helloSent(w.from.id) { try w.to.hello(w.from, v3only: false) }
                verdicts.append(w.to.room.onHello(w.from.id, raw, ref: "ref-" + w.from.id, now: SystemClock().now()))
            case "p4-kem": w.to.room.onKem(w.from.id, raw)
            case "p4": w.to.room.onFrame(w.from.id, raw)
            case "p4-reset": resetFrames += 1; w.to.room.onReset(w.from.id, raw)
            default:
                if P4Room.isRoomEnvelope(raw) { w.to.roomIn.append(try w.to.room.openRoom(w.from.id, raw)) }
            }
        }
    }

    func connect(_ a: Side, _ b: Side) throws {
        try a.hello(b, v3only: false)
        try b.hello(a, v3only: false)
        try pump()
    }

    static func msg(_ id: String, _ text: String) -> JSONObject {
        JSONObject([("id", .string(id)), ("text", .string(text)), ("createdAt", .int(SystemClock().now())), ("senderId", "x"), ("senderName", "X")])
    }

    /// `n` private messages whose ciphertext was changed on the way.
    func brokenFrames(_ from: Side, _ to: Side, _ n: Int) throws -> [(from: Side, to: Side, text: String)] {
        var bad = [(from: Side, to: Side, text: String)]()
        for i in 0..<n {
            from.room.sendPrivate(to.id, P4Harness.msg("bad-\(i)-\(UUID().uuidString)", "x"))
            let w = wire.removeLast()
            var f = JSON.parseObject(w.text)!
            var c = try Prim.unb64(f.string("c"))
            c[0] ^= 1
            f["c"] = .string(Prim.b64(c))
            bad.append((w.from, w.to, f.stringify()))
        }
        return bad
    }
}

@Suite struct P4RoomTests {
    let now = SystemClock().now()

    @Test func sessionRoomAndPrivateMessages() throws {
        let h = P4Harness()
        let a = h.add("peer-a"), b = h.add("peer-b")
        a.withBundle = true
        try h.connect(a, b)
        #expect(h.verdicts == ["v4", "v4"])
        #expect(a.room.ready("peer-b"))
        #expect(b.room.ready("peer-a"))
        #expect(a.established == ["peer-b"])
        // B learned A's mailbox bundle from the hello (the relay can seal to it later).
        #expect(b.store.devicesOfRef("ref-peer-a").count == 1)
        #expect(b.store.devicesOfRef("ref-peer-a").first?.bundle != nil)
        #expect(b.store.p4Seen(a.identity.publicKey))
        for i in 0..<3 { #expect(try a.room.sendRoom(["peer-b"], id: "m\(i)", payloadJson: P4Harness.msg("m\(i)", "hi \(i)").stringify(), now: now) == 1) }
        try h.pump()
        #expect(b.roomIn.count == 3)
        #expect(b.roomIn[2].string("text") == "hi 2")
        #expect(a.room.sendPrivate("peer-b", P4Harness.msg("p1", "secret")))
        #expect(b.room.sendPrivate("peer-a", P4Harness.msg("p2", "back")))
        #expect(b.room.sendPrivate("peer-a", P4Harness.msg("p3", "again")))
        try h.pump()
        #expect(b.privateIn.first?.string("text") == "secret")
        #expect(a.privateIn.count == 2)
        var fk = Bytes(repeating: 0, count: 32)
        fk[0] = 7
        #expect(a.room.sendFileKey("peer-b", transferId: "xfer-1", fk: fk))
        try h.pump()
        #expect(b.room.fileKey("peer-a", transferId: "xfer-1") == fk)
        #expect(b.room.fileKey("peer-a", transferId: "xfer-2") == nil)
    }

    @Test func whatWaitsForTheSessionGoesInOrder() throws {
        let h = P4Harness()
        let a = h.add("peer-a"), b = h.add("peer-b")
        try a.hello(b, v3only: false)
        try b.hello(a, v3only: false)
        let helloToB = h.wire.removeFirst(), helloToA = h.wire.removeFirst()
        h.wire.append(helloToA)
        try h.pump()
        #expect(a.room.v4("peer-b"))
        #expect(!a.room.ready("peer-b"))
        #expect(a.room.sendPrivate("peer-b", P4Harness.msg("early", "before the session")))
        #expect(try a.room.sendRoom(["peer-b"], id: "r-early", payloadJson: P4Harness.msg("r-early", "room, early").stringify(), now: now) == 1)
        h.wire.append(helloToB)
        try h.pump()
        #expect(a.room.ready("peer-b"))
        #expect(b.privateIn.first?.string("text") == "before the session")
        #expect(b.roomIn.first?.string("text") == "room, early")
    }

    @Test func downgradeIsRefusedAndOlderPeersAreLegacy() throws {
        let h = P4Harness()
        let bId = ChatIdentity.generate()
        let a = h.add("peer-a"), b = h.add("peer-b", bId)
        try h.connect(a, b)
        #expect(a.store.p4Seen(bId.publicKey))
        h.verdicts.removeAll()
        try a.hello(b, v3only: false)
        try b.hello(a, v3only: true)
        try h.pump()
        #expect(h.verdicts[1] == "downgrade")
        #expect(a.room.downgrade("peer-b"))
        #expect(!a.room.v4("peer-b"))
        let c = h.add("peer-c")
        h.verdicts.removeAll()
        try a.hello(c, v3only: false)
        try c.hello(a, v3only: true)
        try h.pump()
        #expect(h.verdicts[1] == "legacy")
        #expect(!a.room.v4("peer-c"))
        #expect(!a.room.sendPrivate("peer-c", P4Harness.msg("x", "y")))
    }

    @Test func brokenFramesResetAndTheSessionComesBack() throws {
        let h = P4Harness()
        let a = h.add("peer-a"), b = h.add("peer-b")
        try h.connect(a, b)
        h.wire += try h.brokenFrames(a, b, 2)
        try h.pump()
        #expect(b.rehellos == 1)
        #expect(a.rehellos == 1)
        #expect(a.room.ready("peer-b"))
        #expect(b.room.ready("peer-a"))
        a.room.sendPrivate("peer-b", P4Harness.msg("after", "works again"))
        try h.pump()
        #expect(b.privateIn.last?.string("text") == "works again")
        #expect(a.floods + b.floods == 0)
        let reset = JSONObject([("kind", "p4-reset"), ("v", 4), ("why", "x")])
        b.room.onReset("peer-a", reset)
        b.room.onReset("peer-a", reset)
        #expect(b.floods == 1)
    }

    @Test func reviewP03_aProtocol4PeerIsNeverLegacyWhenOurHelloV4CannotBeMade() throws {
        let h = P4Harness()
        let bId = ChatIdentity.generate()
        let a = h.add("peer-a"), b = h.add("peer-b", bId)
        try h.connect(a, b)
        #expect(a.store.p4Seen(bId.publicKey))
        h.verdicts.removeAll()
        a.badAccount = true
        try a.hello(b, v3only: false)
        try b.hello(a, v3only: false)
        try h.pump()
        #expect(h.verdicts[1] == "pending")
        #expect(!a.room.v4("peer-b"))
        #expect(!a.room.downgrade("peer-b"))
        let c = h.add("peer-c")
        h.verdicts.removeAll()
        try a.hello(c, v3only: false)
        try c.hello(a, v3only: false)
        try h.pump()
        #expect(h.verdicts[1] == "pending")
        let d = h.add("peer-d")
        h.verdicts.removeAll()
        try a.hello(d, v3only: false)
        try d.hello(a, v3only: true)
        try h.pump()
        #expect(h.verdicts[1] == "legacy")
        a.badAccount = false
        try a.hello(b, v3only: false)
        #expect(a.room.onHello("peer-b", h.lastHello["peer-b>peer-a"]!, ref: "ref-peer-b", now: now) == "v4")
        #expect(a.room.v4("peer-b"))
    }

    @Test func reviewP13_ourChainCountsAsHandedOutOnlyOnceItWent() throws {
        let h = P4Harness()
        let a = h.add("peer-a"), b = h.add("peer-b")
        try a.hello(b, v3only: false)
        try b.hello(a, v3only: false)
        let helloToB = h.wire.removeFirst(), helloToA = h.wire.removeFirst()
        h.wire.append(helloToA)
        try h.pump()
        #expect(try a.room.sendRoom(["peer-b"], id: "q1", payloadJson: P4Harness.msg("q1", "one").stringify(), now: now) == 1)
        #expect(try a.room.sendRoom(["peer-b"], id: "q2", payloadJson: P4Harness.msg("q2", "two").stringify(), now: now) == 1)
        #expect(!a.room.senderKeys.hasOurChain("peer-b"))
        #expect(a.room.peer("peer-b")!.pending.filter { $0.kind == "sk" }.count == 1)
        h.wire.append(helloToB)
        try h.pump()
        #expect(a.room.senderKeys.hasOurChain("peer-b"))
        #expect(b.roomIn.map { $0.optString("text") } == ["one", "two"])
        let c = h.add("peer-c")
        try h.connect(a, c)
        a.refuse = true
        #expect(try a.room.sendRoom(["peer-c"], id: "q3", payloadJson: P4Harness.msg("q3", "lost").stringify(), now: now) == 0)
        #expect(!a.room.senderKeys.hasOurChain("peer-c"))
        a.refuse = false
        #expect(try a.room.sendRoom(["peer-c"], id: "q4", payloadJson: P4Harness.msg("q4", "arrives").stringify(), now: now) == 1)
        try h.pump()
        #expect(c.roomIn.last?.string("text") == "arrives")
    }

    @Test func reviewP13_ourOwnResetsNeverCloseTheChannel() throws {
        let h = P4Harness()
        let a = h.add("peer-a"), b = h.add("peer-b")
        try h.connect(a, b)
        h.wire += try h.brokenFrames(a, b, 2)
        try h.pump()
        #expect(h.resetFrames == 1)
        #expect(b.room.ready("peer-a"))
        h.wire += try h.brokenFrames(a, b, 2)
        try h.pump()
        #expect(b.rehellos == 2)
        #expect(a.floods + b.floods == 0)
        #expect(h.resetFrames == 1)
        #expect(a.room.ready("peer-b"))
        #expect(b.room.ready("peer-a"))
        a.room.sendPrivate("peer-b", P4Harness.msg("after", "still works"))
        try h.pump()
        #expect(b.privateIn.last?.string("text") == "still works")
    }

    @Test func reviewP13_theFailureCountDecays() throws {
        let h = P4Harness()
        let a = h.add("peer-a"), b = h.add("peer-b")
        try h.connect(a, b)
        h.wire += try h.brokenFrames(a, b, 1)
        try h.pump()
        for i in 0..<Ratchet.failureDecayFrames { a.room.sendPrivate("peer-b", P4Harness.msg("ok\(i)", "fine")) }
        try h.pump()
        h.wire += try h.brokenFrames(a, b, 1)
        try h.pump()
        #expect(b.rehellos == 0)
        h.wire += try h.brokenFrames(a, b, 1)
        try h.pump()
        #expect(b.rehellos == 1)
    }

    @Test func aPeerGoneTakesItsChainsAndOursIsReplaced() throws {
        let h = P4Harness()
        let a = h.add("peer-a"), b = h.add("peer-b")
        try h.connect(a, b)
        _ = try a.room.sendRoom(["peer-b"], id: "m1", payloadJson: P4Harness.msg("m1", "x").stringify(), now: now)
        try h.pump()
        #expect(b.roomIn.count == 1)
        let before = a.room.senderKeys.currentKeyId
        a.room.peerGone("peer-b")
        #expect(a.room.senderKeys.currentKeyId == nil)
        #expect(try a.room.sendRoom(["peer-b"], id: "m2", payloadJson: P4Harness.msg("m2", "y").stringify(), now: now) == 0)
        #expect(a.room.senderKeys.currentKeyId != nil)
        #expect(before != a.room.senderKeys.currentKeyId)
        #expect(!a.room.v4("peer-b"))
    }
}
