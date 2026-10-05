// 6.14 — call wake (CallWake; android CallWakeTest, the web's lib/call-wake.ts):
// when a call I start rings the away members and when hanging up ends the ring;
// the sealed payload and the relay frame's fields; a relayed item checked like a
// message (and dropped by Payloads.validate — what an older app does); the
// server's pushed call; the inbox — a pushed ring rings, a relayed one waits for
// the room, the room showing the call takes it over (one record per call), the
// rest is a missed (or declined) call, once. And the room: the relay frames a
// call I start sends, and a relayed call item handed to the room's events.

import Foundation
import M5Core
import M5Crypto
@testable import M5Proto
import Synchronization
import Testing

@Suite struct CallWakeTests {
    static let now: Int64 = 1_760_000_000_000

    // MARK: - sender

    @Test func aCallIStartRingsTheAwayMembers() throws {
        var s = CallWake.Sender()
        let started = s.start(serverWakes: true, othersInCall: 0, away: ["a", "b", "a"], video: true, now: Self.now) { "cw-1" }
        let ring = try #require(started)
        #expect(ring.callId == "cw-1" && ring.video && ring.at == Self.now)
        #expect(ring.refs == ["a", "b"])
        #expect(s.ringing == ring)
    }

    @Test func ringsNobodyOnAnOlderServerWhenJoiningSomeonesCallOrWithNobodyAway() {
        var s = CallWake.Sender()
        let older = s.start(serverWakes: false, othersInCall: 0, away: ["a"], video: false, now: Self.now) { "cw-1" }
        let joining = s.start(serverWakes: true, othersInCall: 1, away: ["a"], video: false, now: Self.now) { "cw-1" }
        let nobody = s.start(serverWakes: true, othersInCall: 0, away: [], video: false, now: Self.now) { "cw-1" }
        let stopped = s.stop(awayNow: ["a"])
        #expect(older == nil && joining == nil && nobody == nil && stopped == nil)
        let many = (0..<80).map { "r\($0)" }
        let capped = s.start(serverWakes: true, othersInCall: 0, away: many, video: false, now: Self.now) { "cw-2" }
        #expect(capped?.refs.count == 50)
    }

    @Test func hangingUpUnansweredEndsTheRingForThoseStillAway() throws {
        var s = CallWake.Sender()
        _ = s.start(serverWakes: true, othersInCall: 0, away: ["a", "b"], video: false, now: Self.now) { "cw-1" }
        let stopped = s.stop(awayNow: ["b", "c"])
        let end = try #require(stopped)
        #expect(end.callId == "cw-1" && end.refs == ["b"])
        let again = s.stop(awayNow: ["b"])
        #expect(again == nil, "once")
        _ = s.start(serverWakes: true, othersInCall: 0, away: ["a"], video: false, now: Self.now) { "cw-2" }
        s.markAnswered()
        #expect(s.ringing == nil)
        let answered = s.stop(awayNow: ["a"])
        #expect(answered == nil, "answered: no end")
        _ = s.start(serverWakes: true, othersInCall: 0, away: ["a"], video: false, now: Self.now) { "cw-3" }
        let back = s.stop(awayNow: [])
        #expect(back == nil, "everyone came back")
    }

    @Test func thePayloadAndTheRelayFields() {
        let p = CallWake.payload(callId: "cw-7", state: CallWake.ring, video: true, at: Self.now - 5, senderId: "peer-1", senderName: "Bob", now: Self.now)
        #expect(p.string("kind") == "call" && p.string("id") == "cw-7:r" && p.int64("createdAt") == Self.now)
        #expect(p.string("senderId") == "peer-1" && p.string("senderName") == "Bob" && p.string("call") == "cw-7")
        #expect(p.string("state") == "ring" && p["video"] == .bool(true) && p.int64("at") == Self.now - 5)
        #expect(CallWake.messageId("cw-7", CallWake.end) == "cw-7:e")
        let ring = CallWake.relayFields(callId: "cw-7", state: CallWake.ring, video: true)
        #expect(ring["call"] == .bool(true) && !ring.has("callEnd") && ring.string("callId") == "cw-7" && ring["video"] == .bool(true))
        let end = CallWake.relayFields(callId: "cw-7", state: CallWake.end, video: false)
        #expect(end["callEnd"] == .bool(true) && !end.has("call") && !end.has("video"))
        let id = CallWake.newCallId()
        #expect(id.count == 27 && id.hasPrefix("cw-") && id.dropFirst(3).allSatisfy { "0123456789abcdef".contains($0) })
    }

    // MARK: - parsing

    static func item(_ state: String) -> JSONObject {
        CallWake.payload(callId: "cw-7", state: state, video: false, at: now - 1_000, senderId: "peer-1", senderName: "Bob", now: now - 1_000)
    }

    @Test func aRelayedItemIsCheckedLikeAMessage() throws {
        let it = try #require(CallWake.parse(Self.item(CallWake.ring), transportSender: "peer-1", myId: "me", now: Self.now))
        #expect(it.call == "cw-7" && !it.isEnd && it.senderName == "Bob" && it.at == Self.now - 1_000)
        #expect(CallWake.parse(Self.item(CallWake.ring), transportSender: "peer-2", myId: "me", now: Self.now) == nil, "another sender")
        #expect(CallWake.parse(Self.item(CallWake.ring).with("senderId", "me"), transportSender: nil, myId: "me", now: Self.now) == nil, "us")
        #expect(CallWake.parse(Self.item(CallWake.ring).with("senderId", "system"), transportSender: nil, myId: "me", now: Self.now) == nil, "reserved")
        #expect(CallWake.parse(Self.item(CallWake.ring).with("state", "ringing"), transportSender: nil, myId: "me", now: Self.now) == nil)
        #expect(CallWake.parse(Self.item(CallWake.ring).with("call", "with space"), transportSender: nil, myId: "me", now: Self.now) == nil)
        #expect(CallWake.parse(Self.item(CallWake.ring).with("kind", "text"), transportSender: nil, myId: "me", now: Self.now) == nil)
        let ahead = try #require(CallWake.parse(Self.item(CallWake.end).with("at", .int(Self.now + 3_600_000)).with("video", "yes"),
                                                transportSender: nil, myId: "me", now: Self.now))
        #expect(ahead.isEnd && ahead.at == Self.now + Payloads.futureSkew && !ahead.video)
    }

    @Test func anOlderAppDropsItSilently() {
        #expect(Payloads.validate(Self.item(CallWake.ring), transportSender: "peer-1", myId: "me", now: Self.now) == nil)
    }

    static func notify(_ call: JSONObject, sender: String? = "Bob", kind: String = "call") -> JSONObject {
        var n = JSONObject([("kind", .string(kind)), ("call", .object(call))])
        if let sender { n["vars"] = .object(JSONObject([("sender", .string(sender))])) }
        return n
    }

    @Test func theServersPushedCall() throws {
        let c = JSONObject([("id", "cw-7"), ("room", "r3.alpha"), ("video", true), ("at", .int(Self.now - 2_000))])
        let p = try #require(CallWake.pushed(Self.notify(c), now: Self.now))
        #expect(p.call == "cw-7" && p.room == "r3.alpha" && p.who == "Bob" && p.video && !p.end && p.at == Self.now - 2_000)
        #expect(CallWake.pushed(Self.notify(c.with("end", true)), now: Self.now)?.end == true)
        #expect(CallWake.pushed(Self.notify(JSONObject([("id", "cw-7")])), now: Self.now) == nil, "no room (not the app channel)")
        #expect(CallWake.pushed(JSONObject([("kind", "call")]), now: Self.now) == nil, "a 6.13 call notification")
        #expect(CallWake.pushed(Self.notify(c, kind: "message"), now: Self.now) == nil)
        var neutral = Self.notify(c)
        neutral["vars"] = .object(JSONObject())
        #expect(CallWake.pushed(neutral, now: Self.now)?.who == "", "privacy neutral: no name")
    }

    // MARK: - inbox

    static func push(_ call: String, end: Bool, at: Int64, sender: String? = "Bob") -> CallWake.Pushed? {
        CallWake.pushed(notify(JSONObject([("id", .string(call)), ("room", "r3.alpha"), ("at", .int(at)), ("end", .bool(end))]), sender: sender), now: at)
    }

    static func relayed(_ call: String, _ state: String) -> CallWake.Item? {
        CallWake.parse(CallWake.payload(callId: call, state: state, video: false, at: now, senderId: "peer-1", senderName: "Bob", now: now),
                       transportSender: "peer-1", myId: "me", now: now)
    }

    @Test func aPushedRingRingsAndUnansweredBecomesAMissedCall() throws {
        var box = CallWake.Inbox()
        var s = box.push(Self.push("cw-1", end: false, at: Self.now), now: Self.now, roomInCall: false)
        #expect(s.ring && s.who == "Bob" && box.waiting)
        #expect(box.nextDue == Self.now + CallWake.ringMs)
        let early = box.due(now: Self.now + CallWake.ringMs - 1)
        #expect(early.records.isEmpty)
        s = box.due(now: Self.now + CallWake.ringMs)
        #expect(s.over && s.records.count == 1)
        #expect(s.records[0].kind == CallTrack.missed && s.records[0].at == Self.now && s.records[0].people == ["Bob"])
        #expect(s.missed != nil && !box.waiting)
        // The same call again (the relayed item later): nothing.
        let r1 = box.relayed(Self.relayed("cw-1", CallWake.ring), now: Self.now + 70_000, roomInCall: false)
        let r2 = box.relayed(Self.relayed("cw-1", CallWake.end), now: Self.now + 70_000, roomInCall: false)
        #expect(r1.records.isEmpty && r2.records.isEmpty)
    }

    @Test func itsEndStopsTheRingAndRecordsTheMissedCallAtOnce() {
        var box = CallWake.Inbox()
        _ = box.push(Self.push("cw-1", end: false, at: Self.now), now: Self.now, roomInCall: false)
        let s = box.push(Self.push("cw-1", end: true, at: Self.now + 5_000), now: Self.now + 5_000, roomInCall: false)
        #expect(s.over && !s.ring && s.records.first?.kind == CallTrack.missed && s.records.first?.at == Self.now && s.missed != nil)
        let later = box.due(now: Self.now + CallWake.ringMs)
        #expect(later.records.isEmpty)
    }

    @Test func declinedPushedRingIsADeclinedCallWithoutAMissedNotice() {
        var box = CallWake.Inbox()
        _ = box.push(Self.push("cw-1", end: false, at: Self.now), now: Self.now, roomInCall: false)
        box.decline()
        let s = box.due(now: Self.now + CallWake.ringMs)
        #expect(s.records.first?.kind == CallTrack.declined && s.missed == nil)
    }

    @Test func theRoomShowingTheCallTakesItOverOneRecordPerCall() {
        var box = CallWake.Inbox()
        _ = box.push(Self.push("cw-1", end: false, at: Self.now), now: Self.now, roomInCall: false)
        let declined1 = box.roomInCall()
        #expect(!declined1, "not declined")
        #expect(!box.waiting)
        let later = box.due(now: Self.now + CallWake.ringMs)
        #expect(later.records.isEmpty)
        let itsEnd = box.push(Self.push("cw-1", end: true, at: Self.now + 9_000), now: Self.now + 9_000, roomInCall: false)
        #expect(itsEnd.records.isEmpty, "its end: CallTrack records it")
        // Declined before the room showed it: the room declines its ring.
        _ = box.push(Self.push("cw-2", end: false, at: Self.now), now: Self.now, roomInCall: false)
        box.decline()
        let declined2 = box.roomInCall()
        #expect(declined2)
        // A ring while the room already shows a call: the room's own CallTrack rings.
        let s = box.push(Self.push("cw-3", end: false, at: Self.now), now: Self.now, roomInCall: true)
        #expect(!s.ring && !box.waiting)
    }

    @Test func aRelayedRingNeverRingsItWaitsForTheRoom() {
        var box = CallWake.Inbox()
        var s = box.relayed(Self.relayed("cw-1", CallWake.ring), now: Self.now, roomInCall: false)
        #expect(!s.ring && box.nextDue == Self.now + CallWake.settleMs)
        s = box.due(now: Self.now + CallWake.settleMs)
        #expect(!s.over, "it never rang")
        #expect(s.records.first?.kind == CallTrack.missed)
        // An end whose ring never came is a missed call by itself; one the room shows nothing.
        let lone = box.relayed(Self.relayed("cw-2", CallWake.end), now: Self.now, roomInCall: false)
        #expect(lone.records.first?.kind == CallTrack.missed)
        let shown = box.relayed(Self.relayed("cw-3", CallWake.ring), now: Self.now, roomInCall: true)
        #expect(shown.records.isEmpty)
        #expect(!box.waiting)
    }

    @Test func aLatePushDoesNotRingItWaitsLikeARelayedOne() {
        var box = CallWake.Inbox()
        let s = box.push(Self.push("cw-1", end: false, at: Self.now - CallWake.ringMs - 1), now: Self.now, roomInCall: false)
        #expect(!s.ring && box.nextDue == Self.now + CallWake.settleMs)
    }

    @Test func thePushDidNotNameTheCallerTheRelayedItemDoes() {
        var box = CallWake.Inbox()
        let anonymous = box.push(Self.push("cw-1", end: false, at: Self.now, sender: nil), now: Self.now, roomInCall: false)
        #expect(anonymous.who == "")
        _ = box.relayed(Self.relayed("cw-1", CallWake.ring), now: Self.now + 1_000, roomInCall: false)
        let due = box.due(now: Self.now + CallWake.ringMs)
        #expect(due.records.first?.people == ["Bob"])
    }

    // MARK: - the room

    static let keys = try! RoomKeys.derive(room: "wake-room", passphrase: "a shared passphrase", memoryKiB: 64, passes: 1)

    final class Sink: RoomTransport, RoomEvents, @unchecked Sendable {
        let state = Mutex<(hub: [JSONObject], wakes: [CallWake.Item])>(([], []))
        func sendHub(_ frame: JSONObject) { state.withLock { $0.hub.append(frame) } }
        func sendText(_ peerId: String, _ text: String) -> Bool { true }
        func isOpen(_ peerId: String) -> Bool { false }
        func added(_ message: ChatMessage, fresh: Bool) {}
        func changed(_ message: ChatMessage) {}
        func roomChanged() {}
        func createPeer(_ peerId: String, name: String, initiator: Bool) {}
        func dropPeer(_ peerId: String) {}
        func signal(from peerId: String, _ description: JSONObject) {}
        func callWake(_ item: CallWake.Item) { state.withLock { $0.wakes.append(item) } }
        var relays: [JSONObject] { state.withLock { $0.hub.filter { $0.string("type") == "relay" } } }
    }

    static func joined(_ c: RoomCore, features: [JSON]) {
        c.onHubFrame(JSONObject([("type", "hello"), ("nonce", "n1"), ("features", .array(features))]))
        let bob = JSONObject([("account", "ref-bob"), ("name", "Bob"), ("since", .int(1))])
        c.onHubFrame(JSONObject([("type", "joined"), ("peerId", "peer-me"), ("peers", .array([])), ("away", .array([.object(bob)]))]))
    }

    static func core(_ sink: Sink) -> RoomCore {
        RoomCore(key: "wake-room", room: "wake-room", label: "Wake", userName: "Ann", keys: keys, identity: ChatIdentity.generate(),
                 transport: sink, events: sink, device: P4Device(store: P4Store(backend: MemoryRecordVault()), origin: "https://x.example", account: nil),
                 pins: NamePins(vault: MemoryRecordVault()), verifiedDevice: { _ in false })
    }

    @Test func myCallRingsTheAwayMemberAndAnUnansweredHangUpEndsIt() throws {
        let sink = Sink()
        let c = Self.core(sink)
        Self.joined(c, features: ["bin", "call-wake"])
        #expect(c.serverCallWake)
        c.ringAway(video: true, othersInCall: 0)
        // It waits for the directory's answer (no device: the room envelope).
        #expect(sink.state.withLock { $0.hub.contains { $0.string("type") == "key-bundles" && $0.string("ref") == "ref-bob" } })
        #expect(sink.relays.isEmpty)
        c.onHubFrame(JSONObject([("type", "key-bundles"), ("ref", "ref-bob"), ("devices", .array([]))]))
        let ring = try #require(sink.relays.last)
        let callId = try #require(ring.string("callId"))
        #expect(ring["call"] == .bool(true) && ring["video"] == .bool(true) && callId.hasPrefix("cw-"))
        #expect(ring.string("messageId") == callId + ":r" && ring.array("to") == [.string("ref-bob")] && ring.object("envelope") != nil)
        // The room envelope opens to the call item, from me.
        let opened = try Envelopes.openMessage(Self.keys, try #require(ring.object("envelope")))
        let item = try #require(CallWake.parse(opened.payload, transportSender: "peer-me", myId: "peer-other", now: CallTrack.millis()))
        #expect(item.call == callId && item.state == CallWake.ring && item.video && item.senderName == "Ann")
        // Nobody answered: the end, to Bob who is still away.
        c.endRing()
        let end = try #require(sink.relays.last)
        #expect(end["callEnd"] == .bool(true) && end["call"] == nil && end.string("callId") == callId && end.string("messageId") == callId + ":e")
        // Once.
        let count = sink.relays.count
        c.endRing()
        #expect(sink.relays.count == count)
    }

    @Test func noRingOnAServerWithoutTheFeatureOrWhenSomeoneAnswered() throws {
        let sink = Sink()
        let c = Self.core(sink)
        Self.joined(c, features: ["bin"])
        c.onHubFrame(JSONObject([("type", "key-bundles"), ("ref", "ref-bob"), ("devices", .array([]))]))
        c.ringAway(video: false, othersInCall: 0)
        #expect(!c.serverCallWake && sink.relays.isEmpty && c.wakeRinging == nil)
        // On a waking server, joining someone's call rings nobody.
        let sink2 = Sink()
        let c2 = Self.core(sink2)
        Self.joined(c2, features: ["call-wake"])
        c2.onHubFrame(JSONObject([("type", "key-bundles"), ("ref", "ref-bob"), ("devices", .array([]))]))
        c2.ringAway(video: false, othersInCall: 1)
        #expect(sink2.relays.isEmpty)
        c2.ringAway(video: false, othersInCall: 0)
        #expect(sink2.relays.count == 1 && c2.wakeRinging != nil)
        c2.wakeSender.markAnswered()
        c2.endRing()
        #expect(sink2.relays.count == 1, "answered: no end")
    }

    @Test func aRelayedCallItemGoesToTheRoomsInboxOnce() throws {
        let sink = Sink()
        let c = Self.core(sink)
        Self.joined(c, features: ["call-wake"])
        let bob = ChatIdentity.generate()
        let payload = CallWake.payload(callId: "cw-abc", state: CallWake.ring, video: false, at: CallTrack.millis(), senderId: "peer-bob",
                                       senderName: "Bob", now: CallTrack.millis())
        let env = try Envelopes.sealMessage(Self.keys, id: "cw-abc:r", payload: payload, identity: bob)
        let item = JSONObject([("id", "q-1"), ("envelope", .object(env)), ("from", .object(JSONObject([("peerId", "peer-bob")])))])
        c.onHubFrame(JSONObject([("type", "relay-deliver"), ("items", .array([.object(item)]))]))
        c.onHubFrame(JSONObject([("type", "relay-deliver"), ("items", .array([.object(item.with("id", "q-2"))]))]))
        let wakes = sink.state.withLock { $0.wakes }
        #expect(wakes.count == 1 && wakes.first?.call == "cw-abc" && wakes.first?.senderName == "Bob")
        // Acknowledged, never shown as a message.
        #expect(!c.messages.contains { $0.id.hasPrefix("cw-abc") || $0.senderId == "peer-bob" })
        #expect(sink.state.withLock { $0.hub.contains { $0.string("type") == "relay-ack" } })
    }
}
