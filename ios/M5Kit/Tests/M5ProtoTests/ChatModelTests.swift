// The chat models against the Android tests: ActivityLogTest, CallHistoryTest,
// CallTrackTest, LockedRoomsTest, PeerFactsTest, RoomPresenceTest,
// VerifiedTest, SendPlanTest, TimelineTest.

import Foundation
import M5Core
import M5Crypto
@testable import M5Proto
import Testing

func j(_ s: String) -> JSONObject { JSON.parseObject(s)! }

func msg(_ id: String, _ at: Int64, mine: Bool, _ sender: String, _ text: String) -> ChatMessage {
    var m = ChatMessage()
    m.id = id; m.createdAt = at; m.mine = mine; m.senderName = sender; m.text = text
    return m
}

@Suite struct ActivityLogTests {
    static let now: Int64 = 1_760_000_000_000

    func call(_ id: String, _ kind: String, _ at: Int64, _ room: String, _ people: String...) -> ActivityLog.Item {
        ActivityLog.call(CallHistory.Entry.of(id: id, roomKey: room.lowercased(), room: room, CallTrack.Record(kind: kind, at: at, seconds: 61, video: false, people: people)), saved: true)
    }

    func message(_ m: ChatMessage, hidden: Bool = false) -> ActivityLog.Item? { ActivityLog.message(roomKey: "team", room: "Team", m, hidden: hidden, now: Self.now) }

    @Test func mergesNewestFirstCallsBeforeMessagesAtTheSameTime() {
        let calls = [call("a", CallTrack.missed, 300, "Team", "Alice"), call("b", CallTrack.out, 100, "Family")]
        let messages = [message(msg("m1", 300, mine: false, "Alice", "hi"))!, message(msg("m2", 200, mine: true, "Me", "hello"))!]
        let all = ActivityLog.merge(calls, messages)
        #expect(all.count == 4)
        #expect(all[0].id == "c:a")
        #expect(all[1].type == ActivityLog.msg && all[1].msgId == "m1")
        #expect(all[2].msgId == "m2")
        #expect(all[3].id == "c:b")
        #expect(all.map(\.id) == ActivityLog.merge(calls, messages).map(\.id))
    }

    @Test func filtersAllCallsMessagesMissed() {
        let all = ActivityLog.merge([call("a", CallTrack.missed, 5, "Team"), call("b", CallTrack.declined, 4, "Team"), call("c", CallTrack.incoming, 3, "Team")],
                                    [message(msg("m", 2, mine: false, "Alice", "x"))!])
        #expect(ActivityLog.filter(all, filter: "all", query: "").count == 4)
        #expect(ActivityLog.filter(all, filter: nil, query: nil).count == 4)
        #expect(ActivityLog.filter(all, filter: "calls", query: "").map(\.id) == ["c:a", "c:b", "c:c"])
        #expect(ActivityLog.filter(all, filter: "messages", query: "").count == 1)
        #expect(ActivityLog.filter(all, filter: "missed", query: "").map(\.id) == ["c:a"])
    }

    @Test func searchesRoomPeopleAndTextWithoutCaseOrAccents() {
        let all = ActivityLog.merge([call("a", CallTrack.incoming, 5, "Žluťoučký kůň", "Řehoř")], [message(msg("m", 2, mine: false, "Alice", "Zavoláme se po OBĚDĚ?"))!])
        #expect(ActivityLog.filter(all, filter: "all", query: "zlutoucky").map(\.id) == ["c:a"])
        #expect(ActivityLog.filter(all, filter: "all", query: "REHOR").map(\.id) == ["c:a"])
        #expect(ActivityLog.filter(all, filter: "all", query: "obede alice").count == 1)
        #expect(ActivityLog.filter(all, filter: "all", query: "obede bob").isEmpty)
        #expect(ActivityLog.filter(all, filter: "calls", query: "obede").isEmpty)
    }

    @Test func sealedHoldVanishingAndHiddenMessagesShowOnlyTheirKind() {
        var sealed = msg("s", 1, mine: false, "Eva", "CIPHERTEXT")
        sealed.sealed = JSONObject()
        sealed.sealPlain = "the secret"
        var tap = msg("t", 1, mine: false, "Eva", "hold me")
        tap.tap = true
        var vanish = msg("v", 1, mine: false, "Eva", "gone soon")
        vanish.vanishSeconds = 30
        let hidden = msg("h", 1, mine: false, "Eva", "not now")
        let cases: [(ChatMessage, String, String, Bool)] = [(sealed, "sealed", "the", false), (tap, "tap", "hold", false), (vanish, "vanish", "gone", false), (hidden, "hidden", "not", true)]
        for (m, what, word, isHidden) in cases {
            let it = message(m, hidden: isHidden)!
            #expect(it.what == what)
            #expect(it.preview == "")
            #expect(ActivityLog.filter([it], filter: "all", query: word).isEmpty)
        }
        sealed.fileName = "plan.pdf"
        #expect(message(sealed)?.what == "sealed")
    }

    @Test func filesCommandsAndTextHaveAOneLinePreview() {
        var file = msg("f", 1, mine: true, "Me", "")
        file.fileName = "plan.pdf"
        file.to = ["Bob"]
        let it = message(file)!
        #expect(it.what == "file" && it.preview == "plan.pdf" && it.dir == "out" && it.people == ["Bob"])
        var fn = msg("c", 1, mine: false, "Alice", "done")
        fn.fn = j(#"{"keyword":"weather"}"#)
        #expect(message(fn)?.preview == "/weather · done")
        var long = "line one\nline\ttwo "
        for _ in 0..<50 { long += "word " }
        let p = message(msg("l", 1, mine: false, "A", long))!.preview
        #expect(p.hasPrefix("line one line two word"))
        #expect(p.utf16.count == ActivityLog.previewMax)
        #expect(p.hasSuffix("…"))
    }

    @Test func systemLinesExpiredAndDeletedMessagesAreLeftOut() {
        #expect(message(ChatMessage.system(roomKey: "team", text: "Alice joined", now: 1)) == nil)
        var expired = msg("e", 1, mine: false, "A", "x")
        expired.expiresAt = Self.now - 1
        #expect(message(expired) == nil)
        var deleted = msg("d", 1, mine: false, "A", "x")
        deleted.deleted = true
        #expect(message(deleted) == nil)
    }

    @Test func callsOfARoomNoLongerSavedCannotBeCalled() {
        let it = ActivityLog.call(CallHistory.Entry.of(id: "z", roomKey: "gone", room: "Gone", CallTrack.Record(kind: CallTrack.out, at: 1, seconds: 0, video: true, people: [])), saved: false)
        #expect(!it.saved && it.what == "video" && it.dir == "out")
    }

    @Test func daysAndLengths() {
        let prague = TimeZone(identifier: "Europe/Prague")!
        let noon: Int64 = 1_759_917_600_000 // 2025-10-08 12:00 in Prague
        #expect(ActivityLog.daysAgo(noon - 11 * 3600_000, now: noon, tz: prague) == 0)
        #expect(ActivityLog.daysAgo(noon - 13 * 3600_000, now: noon, tz: prague) == 1)
        #expect(ActivityLog.daysAgo(noon - 2 * 24 * 3600_000, now: noon, tz: prague) == 2)
        #expect(ActivityLog.daysAgo(noon + 3600_000, now: noon, tz: prague) == 0)
        #expect(ActivityLog.length(0) == "")
        #expect(ActivityLog.length(42) == "0:42")
        #expect(ActivityLog.length(724) == "12:04")
        #expect(ActivityLog.length(3729) == "1:02:09")
    }
}

@Suite struct CallHistoryTests {
    static let day: Int64 = 24 * 3600_000

    func entry(_ id: String, _ at: Int64) -> CallHistory.Entry {
        CallHistory.Entry.of(id: id, roomKey: "team", room: "Team", CallTrack.Record(kind: CallTrack.incoming, at: at, seconds: 5, video: false, people: ["Alice"]))
    }

    @Test func keepsTheLast500OldestFirst() {
        let now = 1_000 * Self.day
        var list = (0..<700).map { entry("c\($0)", now - Int64(700 - $0) * 60_000) }
        list.shuffle()
        let kept = CallHistory.bound(list, now: now)
        #expect(kept.count == CallHistory.keep)
        #expect(kept.first?.id == "c200")
        #expect(kept.last?.id == "c699")
        for i in 1..<kept.count { #expect(kept[i - 1].at <= kept[i].at) }
    }

    @Test func dropsWhatIsOlderThan90DaysOrFromTheFuture() {
        let now = 1_000 * Self.day
        let kept = CallHistory.bound([entry("old", now - 91 * Self.day), entry("edge", now - 89 * Self.day), entry("new", now), entry("future", now + 3 * Self.day)], now: now)
        #expect(kept.map(\.id) == ["edge", "new"])
    }

    @Test func roundTripsThroughJson() {
        var e = CallHistory.Entry.of(id: "x1", roomKey: "team", room: "Tým", CallTrack.Record(kind: CallTrack.declined, at: 123, seconds: 0, video: true, people: ["Alice", "Bob"]))
        e.sysUri = "callkit://42"
        let back = CallHistory.from(JSON.parseObject(CallHistory.json([e]).stringify()))[0]
        #expect(back == e)
    }

    @Test func anUnknownKindReadsAsMissedAndNothingBreaksOnJunk() {
        let list = CallHistory.from(j(#"{"c":[{"id":"a","kind":"weird","at":5,"sec":-3},7,null]}"#))
        #expect(list.count == 1)
        #expect(list[0].kind == CallTrack.missed)
        #expect(list[0].seconds == 0)
        #expect(CallHistory.from(JSONObject()).isEmpty)
        #expect(CallHistory.from(nil).isEmpty)
    }

    /// The record as Android writes it (org.json, the vault's user tier record "calls") reads here and is written
    /// back byte for byte: the same keys in Android's order.
    @Test func readsAndroidsRecordAndWritesItBackByteForByte() {
        let android = #"{"c":[{"id":"a1","key":"team","room":"Team","kind":"out","at":1760000000000,"sec":62,"video":false,"people":["Alice"]}]}"#
        let read = CallHistory.from(j(android))
        #expect(read.count == 1)
        #expect(read.first?.callKind == .outgoing)
        #expect(read.first?.at == 1_760_000_000_000)
        #expect(read.first?.seconds == 62)
        #expect(read.first?.people == ["Alice"])
        #expect(CallHistory.json(read).stringify() == android)
        var e = read[0]
        e.sysUri = "content://call_log/calls/42"
        #expect(CallHistory.json([e]).stringify() == #"{"c":[{"id":"a1","key":"team","room":"Team","kind":"out","at":1760000000000,"sec":62,"video":false,"people":["Alice"],"sys":"content://call_log/calls/42"}]}"#)
    }

    /// As org.json's opt* read it (the app's reader did too): numbers and booleans where text belongs, numeric
    /// strings where numbers belong, "TRUE" — and null / arrays / objects as nothing.
    @Test func readsAsTolerantlyAsOrgJson() {
        let list = CallHistory.from(j(#"{"c":[{"id":5,"key":true,"room":null,"kind":"declined","at":"1760000000000","sec":"62.9","video":"TRUE","people":["A",7,null,"",false,[1]],"sys":{}}]}"#))
        #expect(list.count == 1)
        let e = list[0]
        #expect(e.id == "5" && e.roomKey == "true" && e.room == "")
        #expect(e.callKind == .declined)
        #expect(e.at == 1_760_000_000_000 && e.seconds == 62)
        #expect(e.video)
        #expect(e.people == ["A", "7", "false"])
        #expect(e.sysUri == "")
        let odd = CallHistory.from(j(#"{"c":[{"at":"x","sec":-1.5,"video":"yes"},{"at":1e30,"sec":"1e30"}]}"#))
        #expect(odd.map(\.at) == [0, 0] && odd.map(\.seconds) == [0, 0] && odd.map(\.video) == [false, false])
    }

    @Test func theKindsAsATypeAndTheClock() {
        #expect(CallTrack.Kind.allCases.map(\.rawValue) == [CallTrack.out, CallTrack.incoming, CallTrack.missed, CallTrack.declined])
        let r = CallTrack.Record(kind: .incoming, at: 5, seconds: -3, video: true, people: ["Bob"])
        #expect(r == CallTrack.Record(kind: CallTrack.incoming, at: 5, seconds: 0, video: true, people: ["Bob"]))
        #expect(r.callKind == .incoming)
        #expect(CallTrack.Record(kind: "weird", at: 0, seconds: 0, video: false, people: []).callKind == .missed)
        #expect(CallTrack.millis(Date(timeIntervalSince1970: 1.0006)) == 1001)
        let e = CallHistory.Entry.of(id: "x", roomKey: "k", room: "R", r)
        #expect(e.id == "x" && e.callKind == .incoming)
    }

    @Test func theStoreKeepsCallsAndWaitsWhileLocked() {
        let vault = MemoryRecordVault()
        let clock = ManualClock(1_000 * Self.day)
        let store = CallHistoryStore(vault: vault, clock: clock)
        store.add(entry("a", clock.now() - 1000))
        vault.setLocked(true)
        store.add(entry("b", clock.now() - 500))
        #expect(store.load().isEmpty)
        #expect(store.waiting.map(\.id) == ["b"])
        vault.setLocked(false)
        #expect(store.load().map(\.id) == ["a", "b"])
        #expect(store.waiting.isEmpty)
        store.addOnce(entry("a", 1))
        #expect(store.load().count == 2)
        store.setSysUri("b", "callkit://b")
        #expect(store.load().last?.sysUri == "callkit://b")
        store.clear()
        #expect(store.load().isEmpty)
    }
}

@Suite struct CallTrackTests {
    let nobody: [String] = []

    @Test func iStartAloneOthersComeIHangUpOutgoing() {
        var t = CallTrack()
        do { let v = t.update(now: 1_000, meOn: true, myVideo: false, live: nobody, peerVideo: false).records.isEmpty; #expect(v) }
        var s = t.update(now: 2_000, meOn: true, myVideo: false, live: ["Alice"], peerVideo: false)
        #expect(!s.ring)
        _ = t.update(now: 3_000, meOn: true, myVideo: false, live: ["Alice", "Bob"], peerVideo: false)
        s = t.update(now: 63_000, meOn: false, myVideo: false, live: ["Alice", "Bob"], peerVideo: false)
        #expect(s.records == [CallTrack.Record(kind: CallTrack.out, at: 1_000, seconds: 62, video: false, people: ["Alice", "Bob"])])
        _ = t.update(now: 70_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        do { let v = t.update(now: 70_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false).records.isEmpty; #expect(v) }
    }

    @Test func anOutgoingCallNobodyCameToIsStillOneOutgoing() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: true, myVideo: false, live: nobody, peerVideo: false)
        let s = t.update(now: 30_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        #expect(s.records.count == 1 && s.records[0].kind == CallTrack.out && s.records[0].people.isEmpty)
        do { let v = t.update(now: 30_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false).records.isEmpty; #expect(v) }
    }

    @Test func someoneCallsItRingsIJoinIncomingWithVideo() {
        var t = CallTrack()
        var s = t.update(now: 1_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: true)
        #expect(s.ring && s.who == "Alice" && s.video)
        do { let v = !t.update(now: 2_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: true).ring; #expect(v) }
        s = t.update(now: 5_000, meOn: true, myVideo: false, live: ["Alice"], peerVideo: true)
        #expect(s.ringOver)
        s = t.update(now: 65_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: true)
        #expect(s.records[0].kind == CallTrack.incoming && s.records[0].at == 5_000 && s.records[0].seconds == 60 && s.records[0].video)
    }

    @Test func myCameraMakesItAVideoCall() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: true, myVideo: true, live: nobody, peerVideo: false)
        _ = t.update(now: 1_000, meOn: true, myVideo: false, live: ["Bob"], peerVideo: false)
        do { let v = t.update(now: 9_000, meOn: false, myVideo: false, live: ["Bob"], peerVideo: false).records[0].video; #expect(v) }
    }

    @Test func aCallThatEndsWithoutMeIsMissedAfterTheGrace() {
        var t = CallTrack()
        do { let v = t.update(now: 1_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false).ring; #expect(v) }
        var s = t.update(now: 10_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        #expect(s.records.isEmpty && s.recheckAt == 10_000 + CallTrack.graceMs)
        s = t.update(now: 10_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        #expect(s.records == [CallTrack.Record(kind: CallTrack.missed, at: 1_000, seconds: 0, video: false, people: ["Alice"])])
        #expect(s.ringOver)
    }

    @Test func aDroppedConnectionWithinTheGraceIsTheSameCall() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        _ = t.update(now: 5_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        var s = t.update(now: 9_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        #expect(!s.ring && s.records.isEmpty)
        _ = t.update(now: 20_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        s = t.update(now: 20_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        #expect(s.records.count == 1 && s.records[0].at == 0)
    }

    @Test func declinedUnlessIJoinAfterAll() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        do { let v = t.decline().ringOver; #expect(v) }
        #expect(!t.ringing)
        _ = t.update(now: 3_000, meOn: false, myVideo: false, live: nobody, peerVideo: false)
        do { let v = t.update(now: 3_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false).records[0].kind == CallTrack.declined; #expect(v) }
        var u = CallTrack()
        _ = u.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        _ = u.decline()
        do { let v = !u.update(now: 1_000, meOn: false, myVideo: false, live: ["Alice", "Bob"], peerVideo: false).ring; #expect(v) }
        _ = u.update(now: 2_000, meOn: true, myVideo: false, live: ["Alice", "Bob"], peerVideo: false)
        do { let v = u.update(now: 12_000, meOn: false, myVideo: false, live: nobody, peerVideo: false).records[0].kind == CallTrack.incoming; #expect(v) }
        do { let v = u.update(now: 12_000 + CallTrack.graceMs, meOn: false, myVideo: false, live: nobody, peerVideo: false).records.isEmpty; #expect(v) }
    }

    @Test func aDeclineWithoutACallChangesNothing() {
        var t = CallTrack()
        do { let v = !t.decline().ringOver; #expect(v) }
        _ = t.update(now: 0, meOn: true, myVideo: false, live: nobody, peerVideo: false)
        _ = t.decline()
        do { let v = t.update(now: 5_000, meOn: false, myVideo: false, live: nobody, peerVideo: false).records[0].kind == CallTrack.out; #expect(v) }
    }

    @Test func flushRecordsWhatIsOpen() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: true, myVideo: false, live: ["Alice"], peerVideo: false)
        var s = t.flush(now: 30_000)
        #expect(s.records.count == 1 && s.records[0].kind == CallTrack.incoming && s.records[0].seconds == 30)
        var u = CallTrack()
        _ = u.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        s = u.flush(now: 5_000)
        #expect(s.records[0].kind == CallTrack.missed && s.ringOver)
        do { let v = u.flush(now: 6_000).records.isEmpty; #expect(v) }
    }

    @Test func rejoiningIsASecondRecordOfMine() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        _ = t.update(now: 1_000, meOn: true, myVideo: false, live: ["Alice"], peerVideo: false)
        do { let v = t.update(now: 11_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false).records[0].kind == CallTrack.incoming; #expect(v) }
        do { let v = !t.update(now: 12_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false).ring; #expect(v) }
        _ = t.update(now: 20_000, meOn: true, myVideo: false, live: ["Alice"], peerVideo: false)
        let s = t.update(now: 50_000, meOn: false, myVideo: false, live: ["Alice"], peerVideo: false)
        #expect(s.records[0].kind == CallTrack.incoming && s.records[0].seconds == 30)
    }

    @Test func namesAreKeptInOrderOnceAndBounded() {
        var t = CallTrack()
        _ = t.update(now: 0, meOn: true, myVideo: false, live: ["A", "B"], peerVideo: false)
        _ = t.update(now: 1, meOn: true, myVideo: false, live: ["B", "A", "", "C"], peerVideo: false)
        for i in 0..<20 { _ = t.update(now: Int64(2 + i), meOn: true, myVideo: false, live: ["P\(i)"], peerVideo: false) }
        let people = t.update(now: 100, meOn: false, myVideo: false, live: nobody, peerVideo: false).records[0].people
        #expect(Array(people.prefix(3)) == ["A", "B", "C"])
        #expect(people.count == CallTrack.peopleMax)
    }
}

@Suite struct LockedRoomsTests {
    static let room = "team"
    static let now: Int64 = 1_800_000_000_000

    func m(_ id: String, _ text: String, mine: Bool, _ at: Int64) -> ChatMessage {
        var x = msg(id, at, mine: mine, mine ? "me" : "Alice", text)
        x.roomKey = Self.room
        x.status = mine ? "sent" : "received"
        return x
    }
    func item(_ x: ChatMessage) -> JSONObject { LockedRooms.message(roomKey: Self.room, x) }
    func state(_ id: String, _ who: String, _ name: String, _ s: String) -> JSONObject { LockedRooms.state(roomKey: Self.room, id: id, who: who, name: name, state: s) }

    @Test func newOnesAfterTheHistoryAKnownIdInItsPlace() {
        let history = [m("a", "first", mine: false, 1), m("b", "second", mine: false, 2), m("c", "mine", mine: true, 3)]
        var b2 = m("b", "second", mine: false, 2)
        b2.filePath = "xfer-1"
        var d2 = m("d", "while locked", mine: false, 10)
        d2.vanished = true
        let items = [item(m("d", "while locked", mine: false, 10)), item(b2), state("c", "peer-1", "Bob", "delivered"), item(m("e", "later", mine: false, 11)), item(d2)]
        let merged = LockedRooms.merge(history: history, roomKey: Self.room, items: items, now: Self.now)
        #expect(merged.map(\.id) == ["a", "b", "c", "d", "e"])
        #expect(merged[1].filePath == "xfer-1")
        #expect(merged[3].vanished)
        #expect(merged[2].receipts.optString("peer-1") == "delivered")
        #expect(merged[2].status == "delivered")
    }

    @Test func aSecondMergeChangesNothing() {
        let history = [m("a", "first", mine: false, 1), m("c", "mine", mine: true, 3)]
        let items = [item(m("d", "x", mine: false, 10)), state("c", "peer-1", "Bob", "read"), item(m("e", "y", mine: false, 11))]
        let once = LockedRooms.merge(history: history, roomKey: Self.room, items: items, now: Self.now)
        let twice = LockedRooms.merge(history: once, roomKey: Self.room, items: items, now: Self.now)
        #expect(once.map(\.id) == twice.map(\.id))
        #expect(twice[1].receipts.optString("peer-1") == "read" && twice[1].status == "read")
    }

    @Test func receiptsMoveUpOnlyOnMine() {
        let history = [m("c", "mine", mine: true, 3), m("x", "theirs", mine: false, 4)]
        let items = [state("c", "peer-1", "Bob", "read"), state("c", "peer-1", "Bob", "delivered"), state("x", "peer-1", "Bob", "read"),
                     state("gone", "peer-1", "Bob", "read"), state("c", "relay", "relay", "nonsense")]
        let merged = LockedRooms.merge(history: history, roomKey: Self.room, items: items, now: Self.now)
        #expect(merged[0].receipts.optString("peer-1") == "read" && merged[0].status == "read")
        #expect(merged[1].receipts.optString("peer-1") == "")
        #expect(merged.count == 2)
    }

    @Test func onlyWhatAHistoryKeeps() {
        var sys = m("s1", "connected", mine: false, 5)
        sys.kind = "sys"
        var other = m("o", "elsewhere", mine: false, 8)
        other.roomKey = "elsewhere"
        let items = [item(sys), item(m(String(repeating: "x", count: 97), "too long an id", mine: false, 6)), item(m("", "no id", mine: false, 7)),
                     item(m("f", "from the future", mine: false, Self.now + 86_400_000)), item(other), JSONObject([("t", "msg"), ("room", .string(Self.room))])]
        let merged = LockedRooms.merge(history: [], roomKey: Self.room, items: items, now: Self.now)
        #expect(merged.map(\.id) == ["f", "o"])
        #expect(merged[0].createdAt == Self.now + Payloads.futureSkew)
        #expect(merged[1].roomKey == Self.room)
        #expect(LockedRooms.valid(nil, roomKey: Self.room, now: Self.now) == nil)
        #expect(LockedRooms.valid(m("ok", "fine", mine: false, 1).json, roomKey: Self.room, now: Self.now) != nil)
    }

    @Test func itemsAreGroupedForTheirStores() {
        var opened = [JSONObject]([
            item(m("a", "x", mine: false, 1)),
            state("a", "p", "P", "read"),
            JSONObject([("t", "msg"), ("room", "other"), ("m", .object(m("b", "y", mine: false, 2).json))]),
            LockedRooms.pin(slot: "team\u{0}alice", kid: "K1"),
            LockedRooms.pin(slot: "team\u{0}alice", kid: "K2"),
            LockedRooms.resume(roomKey: Self.room, peerId: "peer-9", secret: "s"),
            LockedRooms.call(JSONObject([("id", "c1"), ("key", .string(Self.room))])),
            LockedRooms.callUri(id: "c1", uri: "callkit://1"),
            JSONObject([("t", "file"), ("id", "xfer-1")]),
            JSONObject([("t", "what")]),
        ]).map { Crypto.utf8($0.stringify()) }
        opened.append(Crypto.utf8("not json"))
        let p = LockedRooms.parse(opened)
        #expect(Set(p.rooms.keys) == [Self.room, "other"])
        #expect(p.rooms[Self.room]?.count == 2)
        #expect(p.pins["team\u{0}alice"] == "K1")
        #expect(p.resumes[Self.room]?[0] == "peer-9")
        #expect(p.calls.count == 1)
        #expect(p.callUris["c1"] == "callkit://1")
        #expect(p.files.count == 1)
        #expect(p.unknown == 2)
    }

    @Test func aFileThatCouldNotBeStoredSaysSo() {
        var got = m("m1", "", mine: false, 1)
        got.filePath = "xfer-1"
        var mine = m("m2", "", mine: true, 2)
        mine.filePath = "xfer-1"
        var list = [got, mine]
        LockedRooms.markLostFiles(&list, ["xfer-1"])
        #expect(list[0].filePath == nil && list[0].fileProgress == -2)
        #expect(list[1].filePath == "xfer-1")
    }

    @Test func theInboxSealsWhileLockedAndDrainsAtTheUnlock() throws {
        let inbox = LockInbox()
        let dek = Crypto.random(32)
        #expect(inbox.seal(JSONObject()) == nil)
        let gen = try inbox.begin(dataKey: dek)
        #expect(inbox.active)
        var log = Bytes()
        for i in 0..<3 { log += inbox.seal(item(m("w\(i)", "while locked", mine: false, Int64(10 + i))))!.line }
        log += inbox.seal(LockedRooms.pin(slot: "s", kid: "k"))!.line
        inbox.close()
        #expect(!inbox.active)
        let drained = try LockInbox.drain(dataKey: dek, kid: gen.kid, wrappedKey: gen.wrappedKey, log: log)
        #expect(drained.failed == 0)
        #expect(drained.parsed.rooms[Self.room]?.count == 3)
        #expect(drained.parsed.pins["s"] == "k")
        #expect(throws: (any Error).self) { try LockInbox.drain(dataKey: Crypto.random(32), kid: gen.kid, wrappedKey: gen.wrappedKey, log: log) }
    }
}

@Suite struct PeopleTests {
    let now: Int64 = 1_800_000_000_000

    @Test func signedInConnectionsAndAwayMembersFromJoined() {
        var f = PeerFacts()
        f.onFrame(j(#"{"type":"joined","peerId":"me","peers":[{"peerId":"p1","name":"Alice","account":"ref-a","accountId":"ref-a"},{"peerId":"p2","name":"Bob"}],"away":[{"name":"Cyril","since":5,"account":"ref-c"}]}"#), now: now)
        #expect(f.account("p1") == "ref-a")
        #expect(f.account("p2") == "")
        #expect(f.away.count == 1 && f.away[0].name == "Cyril" && f.away[0].since == 5)
        #expect(f.joinedAt > 0)
    }

    @Test func theOldAliasAndNullAccounts() {
        var f = PeerFacts()
        f.onFrame(j(#"{"type":"peer-joined","peerId":"p1","name":"A","accountId":"ref-1"}"#), now: now)
        #expect(f.account("p1") == "ref-1")
        f.onFrame(j(#"{"type":"peer-updated","peerId":"p1","name":"A","account":null,"accountId":null}"#), now: now)
        #expect(f.account("p1") == "")
    }

    @Test func helloNamesTheUsernameAndAwayMembersKeepIt() {
        var f = PeerFacts()
        f.onFrame(j(#"{"type":"peer-joined","peerId":"p1","name":"Alice","account":"ref-a"}"#), now: now)
        f.onHello("p1", j(#"{"kind":"hello","user":"bystry-sokol-7k3q"}"#), now: now)
        #expect(f.get("p1")?.username == "bystry-sokol-7k3q")
        #expect((f.get("p1")?.since ?? 0) > 0)
        f.onFrame(j(#"{"type":"peer-left","peerId":"p1"}"#), now: now)
        #expect(f.get("p1") == nil)
        f.onFrame(j(#"{"type":"peer-away","account":"ref-a","name":"Alice","since":9}"#), now: now)
        #expect(f.user(ofAccount: "ref-a") == "bystry-sokol-7k3q")
        f.onFrame(j(#"{"type":"peer-back","account":"ref-a"}"#), now: now)
        #expect(f.away.isEmpty)
    }

    @Test func aClaimThatIsNotAUsernameIsIgnored() {
        var f = PeerFacts()
        f.onHello("p1", j(#"{"kind":"hello","user":{"name":"x"}}"#), now: now)
        #expect(f.get("p1")?.username == "")
        f.onHello("p2", j(#"{"kind":"hello","user":"<script>"}"#), now: now)
        #expect(f.get("p2")?.username == "")
    }

    @Test func signingInLaterStillLearnsTheUsername() {
        var f = PeerFacts()
        f.onHello("p1", j(#"{"kind":"hello","user":"rys-lis-aaaa"}"#), now: now)
        f.onFrame(j(#"{"type":"peer-updated","peerId":"p1","name":"A","account":"ref-z"}"#), now: now)
        #expect(f.user(ofAccount: "ref-z") == "rys-lis-aaaa")
    }

    @Test func presenceFromJoined() {
        var p = RoomPresence()
        p.onFrame(j(#"{"type":"joined","peerId":"me","peers":[{"peerId":"p1","name":"A","foreground":true,"lastSeen":100},{"peerId":"p2","name":"B","foreground":false,"lastSeen":50}],"held":[{"peerId":"p3","name":"C","lastSeen":20,"since":30,"account":"ref-c"}],"away":[{"account":"ref-d","name":"D","since":9,"lastSeen":7}]}"#), now: now)
        #expect(p.live("p1")?.foreground == true)
        #expect(p.live("p2")?.foreground == false && p.live("p2")?.lastSeen == 50)
        let held = p.held(excluding: [], awayAccounts: [])
        #expect(held.map(\.peerId) == ["p3"] && held[0].name == "C" && held[0].lastSeen == 20 && held[0].since == 30)
        #expect(p.awayLastSeen("ref-d") == 7)
        #expect(p.awayLastSeen("ref-x") == 0)
    }

    @Test func presenceBackgroundHeldBackAndGone() {
        var p = RoomPresence()
        p.onFrame(j(#"{"type":"peer-joined","peerId":"p0","name":"A"}"#), now: now)
        #expect(p.live("p0")?.foreground == true && p.live("p0")?.lastSeen == 0)
        #expect(p.live("p9") == nil)
        p.onFrame(j(#"{"type":"peer-joined","peerId":"p1","name":"A","foreground":true,"lastSeen":1}"#), now: now)
        p.onFrame(j(#"{"type":"peer-presence","peerId":"p1","foreground":false,"lastSeen":5}"#), now: now)
        #expect(p.live("p1")?.foreground == false && p.live("p1")?.lastSeen == 5)
        p.onFrame(j(#"{"type":"peer-left","peerId":"p1","held":true,"name":"A","lastSeen":5,"since":8}"#), now: now)
        #expect(p.live("p1") == nil)
        #expect(p.held(excluding: [], awayAccounts: []).map(\.peerId) == ["p1"])
        p.onFrame(j(#"{"type":"peer-joined","peerId":"p1","name":"A","foreground":true,"lastSeen":9}"#), now: now)
        #expect(p.held(excluding: [], awayAccounts: []).isEmpty)
        p.onFrame(j(#"{"type":"peer-left","peerId":"p1","held":true,"name":"A","lastSeen":9,"since":10}"#), now: now)
        p.onFrame(j(#"{"type":"peer-left","peerId":"p1"}"#), now: now)
        #expect(p.held(excluding: [], awayAccounts: []).isEmpty)
    }

    @Test func heldMembersAreNotListedTwiceAndAwayKeepsLastSeen() {
        var p = RoomPresence()
        p.onFrame(j(#"{"type":"peer-left","peerId":"p1","held":true,"name":"Ann","account":"ref-ann","lastSeen":1,"since":2}"#), now: now)
        p.onFrame(j(#"{"type":"peer-left","peerId":"p2","held":true,"name":"Ben","lastSeen":1,"since":2}"#), now: now)
        #expect(p.held(excluding: [], awayAccounts: ["ref-ann"]).map(\.peerId) == ["p2"])
        #expect(p.held(excluding: ["p2"], awayAccounts: []).map(\.peerId) == ["p1"])
        #expect(p.held(excluding: [], awayAccounts: []).map(\.peerId) == ["p1", "p2"])
        p.onFrame(j(#"{"type":"peer-away","account":"ref-a","name":"A","since":20,"lastSeen":15}"#), now: now)
        #expect(p.awayLastSeen("ref-a") == 15)
        p.onFrame(j(#"{"type":"peer-away","accountId":"ref-b","name":"B","since":30}"#), now: now)
        #expect(p.awayLastSeen("ref-b") == 30)
        p.onFrame(j(#"{"type":"peer-back","account":"ref-a"}"#), now: now)
        #expect(p.awayLastSeen("ref-a") == 0)
        p.onFrame(j(#"{"type":"unknown"}"#), now: now)
        p.onFrame(JSONObject(), now: now)
    }
}

@Suite struct VerifiedTests {
    static let alice = Prim.generateP256().spki
    static let mallory = Prim.generateP256().spki

    func signed(_ key: String, _ valid: Bool) -> Envelopes.Signer { Envelopes.Signer(publicKey: key, valid: valid, accountKey: nil, accountValid: false) }

    @Test func peerToPeer() {
        let a = Self.alice, m = Self.mallory
        #expect(Verified.p2p(signed(a, true), helloKey: a, changed: false, claimedName: "Alice", peerName: "alice "))
        #expect(!Verified.p2p(signed(m, true), helloKey: a, changed: false, claimedName: "Alice", peerName: "Alice"))
        #expect(!Verified.p2p(signed(m, true), helloKey: m, changed: false, claimedName: "Alice", peerName: "Mallory"))
        #expect(!Verified.p2p(signed(a, false), helloKey: a, changed: false, claimedName: "Alice", peerName: "Alice"))
        #expect(!Verified.p2p(signed(a, true), helloKey: a, changed: true, claimedName: "Alice", peerName: "Alice"))
        #expect(!Verified.p2p(nil, helloKey: a, changed: false, claimedName: "Alice", peerName: "Alice"))
        #expect(!Verified.p2p(signed(a, true), helloKey: nil, changed: false, claimedName: "Alice", peerName: "Alice"))
        #expect(!Verified.p2p(signed(a, true), helloKey: a, changed: false, claimedName: "", peerName: ""))
    }

    @Test func throughTheRelay() {
        let a = Self.alice
        #expect(Verified.relay(signed(a, true), pinnedKid: Ec.kid(a)))
        #expect(!Verified.relay(signed(Self.mallory, true), pinnedKid: Ec.kid(a)))
        #expect(!Verified.relay(signed(a, true), pinnedKid: ""))
        #expect(!Verified.relay(signed(a, false), pinnedKid: Ec.kid(a)))
        #expect(!Verified.relay(signed("not a key", true), pinnedKid: Ec.kid(a)))
        #expect(!Verified.relay(nil, pinnedKid: Ec.kid(a)))
    }

    @Test func namePinsFirstUseAndLocked() {
        let vault = MemoryRecordVault()
        let pins = NamePins(vault: vault)
        #expect(pins.pin("team", "Alice", "K1") == "new")
        #expect(pins.pin("team", " alice", "K1") == "match")
        #expect(pins.pin("team", "ALICE", "K2") == "changed")
        #expect(pins.verdict("team", "Bob", "K3") == "new")
        #expect(pins.pinned("team", "alice") == "K1")
        pins.repin("team", "Alice", "K2")
        #expect(pins.pinned("team", "alice") == "K2")
        // Locked: the open rooms' pins in memory; a new one goes to the inbox.
        let seen = PinsSeen()
        let lockedPins = NamePins(vault: vault, onLockedPin: { slot, kid in seen.add(slot, kid) })
        lockedPins.lock(with: lockedPins.pinsOf(rooms: ["team"]))
        vault.setLocked(true)
        #expect(lockedPins.pin("team", "Carol", "K9") == "new")
        #expect(lockedPins.pin("team", "alice", "K2") == "match")
        #expect(seen.all == ["team\u{0}carol=K9"])
        vault.setLocked(false)
        lockedPins.unlock()
        lockedPins.mergePins(["team\u{0}carol": "K9", "team\u{0}alice": "K0"])
        #expect(pins.pinned("team", "carol") == "K9")
        #expect(pins.pinned("team", "alice") == "K2") // first use wins
    }
}

final class PinsSeen: @unchecked Sendable {
    private let lock = NSLock()
    private var items = [String]()
    func add(_ s: String, _ k: String) { lock.lock(); items.append(s + "=" + k); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
}

@Suite struct SendPlanTests {
    func apply(_ f: inout [String: JSON], _ arg: String) -> Bool { SendPlan.apply(&f, arg, defaultVanish: 60, newCode: { "ABCD-EFGH-JKMN" }) }

    @Test func nothingOnSendsTheTextAsItIs() {
        let p = SendPlan.of([:])
        #expect(p.step(hasText: true, voiceBusy: false) == .text)
        #expect(p.step(hasText: false, voiceBusy: false) == .none)
        #expect(p.count == 0 && !p.sealed && p.sealCode == nil)
    }

    @Test func asVoiceAndSpeakItSendText() {
        var f = [String: JSON]()
        do { let v = apply(&f, "asVoice"); #expect(v) }
        var p = SendPlan.of(f)
        #expect(p.asVoice)
        #expect(p.step(hasText: true, voiceBusy: false) == .speak)
        #expect(p.step(hasText: false, voiceBusy: false) == .dictateSpeak)
        #expect(p.step(hasText: true, voiceBusy: true) == .wait)
        var g = [String: JSON]()
        _ = apply(&g, "voiceText")
        p = SendPlan.of(g)
        #expect(p.step(hasText: false, voiceBusy: false) == .dictateText)
        #expect(p.step(hasText: true, voiceBusy: false) == .text)
        #expect(p.step(hasText: false, voiceBusy: true) == .wait)
    }

    @Test func theTwoVoiceOptionsExcludeEachOther() {
        var f = [String: JSON]()
        _ = apply(&f, "asVoice")
        _ = apply(&f, "voiceText")
        var p = SendPlan.of(f)
        #expect(p.voiceText && !p.asVoice)
        _ = apply(&f, "asVoice")
        p = SendPlan.of(f)
        #expect(p.asVoice && !p.voiceText && f[SendPlan.voiceTextKey] == nil)
        let both: [String: JSON] = [SendPlan.asVoiceKey: true, SendPlan.voiceTextKey: true]
        #expect(!SendPlan.of(both).voiceText && SendPlan.of(both).count == 1)
    }

    @Test func tappingAnOptionAgainTurnsItOffAndKindsCombine() {
        var f = [String: JSON]()
        for o in ["asVoice", "voiceText", "tap", "vanish", "seal"] { _ = apply(&f, o); _ = apply(&f, o) }
        #expect(f.isEmpty)
        for o in ["tap", "vanish", "seal", "asVoice"] { _ = apply(&f, o) }
        let p = SendPlan.of(f)
        #expect(p.tap && p.vanishSeconds == 60 && p.sealCode == "" && p.count == 4)
    }

    @Test func vanishTakesItsTimeAndTheCode() {
        var f = [String: JSON]()
        _ = apply(&f, "vanish:300")
        #expect(SendPlan.of(f).vanishSeconds == 300)
        f[SendPlan.vanishKey] = "15"
        #expect(SendPlan.of(f).vanishSeconds == 15)
        _ = apply(&f, "vanish:0")
        #expect(f[SendPlan.vanishKey] == nil)
        var g = [String: JSON]()
        _ = SendPlan.apply(&g, "vanish", defaultVanish: 0, newCode: { "" })
        #expect(SendPlan.of(g).vanishSeconds == 15)
        var c = [String: JSON]()
        _ = apply(&c, "seal")
        #expect(SendPlan.of(c).sealCode == "")
        c[SendPlan.sealKey] = "  moje-tajne  "
        #expect(SendPlan.of(c).sealCode == "moje-tajne")
        c[SendPlan.sealKey] = " - - "
        #expect(SendPlan.of(c).sealCode == "")
        _ = apply(&c, "newCode")
        #expect(SendPlan.of(c).sealCode == "ABCD-EFGH-JKMN")
        _ = apply(&c, "seal:XYZ")
        #expect(SendPlan.of(c).sealCode == "XYZ")
    }

    @Test func noneTurnsAllOffButKeepsTheRecipientsAndLeftovers() {
        var f: [String: JSON] = ["msgTo": .array(["peer-1"])]
        _ = apply(&f, "asVoice"); _ = apply(&f, "tap"); _ = apply(&f, "newCode")
        do { let v = apply(&f, "none"); #expect(v) }
        #expect(SendPlan.of(f).count == 0 && f["msgTo"] != nil)
        do { let v = !apply(&f, "nonsense"); #expect(v) }
        #expect(SendPlan.leftover(field: "Ahoj ", sent: "Ahoj") == "")
        #expect(SendPlan.leftover(field: "whatever", sent: nil) == "")
        #expect(SendPlan.leftover(field: "Ahoj a dál", sent: "Ahoj") == "a dál")
        #expect(SendPlan.leftover(field: "něco jiného", sent: "Ahoj") == "něco jiného")
        #expect(SendPlan.leftover(field: "text", sent: "") == "text")
    }
}

@Suite struct TimelineTests {
    func states(_ m: ChatMessage) -> [String] { m.timeline.map { $0.state + ($0.meta.isEmpty ? "" : ":" + $0.meta) } }

    @Test func aStatusMoveIsAStepAndARecipientsReceiptNamesThem() {
        var m = ChatMessage()
        m.status = "sending"
        m.mark("created", "", at: 100)
        m.mark("encrypted", "", at: 110)
        do { let v = m.raise("sent", who: "Jana, Petr"); #expect(v) }
        #expect(m.status == "sent")
        m.raise("delivered", who: "Jana")
        m.raise("delivered", who: "Petr")
        do { let v = !m.raise("sent"); #expect(v) }
        m.raise("read", who: "Jana")
        #expect(m.status == "read")
        let s = states(m)
        #expect(s.first == "created" && s[1] == "encrypted")
        for x in ["sent:Jana, Petr", "delivered:Jana", "delivered:Petr", "read:Jana"] { #expect(s.contains(x)) }
        #expect(!s.contains("sent"))
        #expect(s.count == 6)
    }

    @Test func theOutboxRaiseIsAStepTooAndHidesRepeat() {
        var m = ChatMessage()
        m.status = "queued"
        m.mark("queued")
        do { let v = m.raise("sent"); #expect(v) }
        #expect(states(m).contains("sent"))
        do { let v = !m.raise("sent"); #expect(v) }
        #expect(m.timeline.count == 2)
        var h = ChatMessage()
        do { let v = h.mark("displayed"); #expect(v) }
        do { let v = !h.mark("displayed"); #expect(v) }
        do { let v = h.mark("revealed"); #expect(v) }
        do { let v = h.mark("hidden", "1h", at: 10); #expect(v) }
        do { let v = h.mark("unhidden", "time", at: 20); #expect(v) }
        do { let v = h.mark("hidden", "1h", at: 30); #expect(v) }
        #expect(h.timeline.count == 5)
        #expect(h.has("revealed") && !h.has("opened"))
    }

    @Test func stepsInOrderAndKeptInTheHistory() {
        var m = ChatMessage()
        m.id = "msg-1"; m.roomKey = "k"; m.text = "ahoj"; m.createdAt = 100
        m.mark("received", "p2p", at: 200)
        m.mark("created", "", at: 100)
        m.mark("displayed", "", at: 250)
        #expect(m.timeline[0].state == "created" && m.timeline[0].at == 100)
        m.hiddenUntil = ChatMessage.untilSignIn
        m.hiddenFor = "u1"
        var stored = JSON.parseObject(m.json.stringify())!
        let back = ChatMessage.from(stored)
        #expect(states(back) == states(m))
        #expect(back.timeline[1].at == 200 && back.timeline[1].meta == "p2p")
        #expect(back.hiddenUntil == ChatMessage.untilSignIn && back.hiddenFor == "u1" && !back.deleted)
        stored["timeline"] = nil; stored["hiddenUntil"] = nil; stored["hiddenFor"] = nil
        let old = ChatMessage.from(stored)
        #expect(old.timeline.isEmpty && old.hiddenUntil == 0 && old.hiddenFor == nil && !old.json.has("hiddenUntil"))
    }

    @Test func aLongTimelineKeepsItsFirstStep() {
        var m = ChatMessage()
        m.mark("created", "", at: 1)
        for i in 0..<(ChatMessage.timelineMax + 20) { m.mark("delivered", "peer\(i)", at: Int64(10 + i)) }
        #expect(m.timeline.count == ChatMessage.timelineMax)
        #expect(m.timeline[0].state == "created")
    }

    @Test func deliveryStatesOnlyGoUpAndNotifications() {
        var m = ChatMessage()
        m.status = "sending"
        do { let v = m.raise("sent") && m.raise("delivered") && !m.raise("sent") && m.raise("read"); #expect(v) }
        m.status = "queued"
        do { let v = m.raise("sent"); #expect(v) }
        var held = msg("h1", 1, mine: false, "Bob", "pay 100 to X")
        held.changed = true
        #expect(held.notifyText == "⚠")
        held.changed = false
        #expect(held.notifyText == "pay 100 to X")
    }
}
