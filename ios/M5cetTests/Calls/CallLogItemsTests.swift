// 6.8: the History screen's list — calls and messages merged newest first,
// filters, search, what a message may show. Android's ActivityLogTest.

import XCTest
@testable import M5cet

final class CallLogItemsTests: XCTestCase {
    private func msg(_ id: String, _ at: Int64, mine: Bool, _ sender: String, _ text: String) -> CallLogItems.Message {
        CallLogItems.Message(id: id, createdAt: at, mine: mine, senderName: sender, text: text)
    }

    private func call(_ id: String, _ kind: CallTrack.Kind, _ at: Int64, _ room: String, _ people: String...) -> CallLogItems.Item {
        CallLogItems.call(.of(id: id, roomKey: room.lowercased(), room: room,
                              record: CallTrack.Record(kind: kind, at: at, seconds: 61, video: false, people: people)), saved: true)
    }

    private func m(_ x: CallLogItems.Message, hidden: Bool = false) -> CallLogItems.Item {
        CallLogItems.message(roomKey: "team", room: "Team", x, hidden: hidden)!
    }

    func testMergesNewestFirstCallsBeforeMessagesAtTheSameTime() {
        let calls = [call("a", .missed, 300, "Team", "Alice"), call("b", .outgoing, 100, "Family")]
        let messages = [m(msg("m1", 300, mine: false, "Alice", "hi")), m(msg("m2", 200, mine: true, "Me", "hello"))]
        let all = CallLogItems.merge(calls: calls, messages: messages)
        XCTAssertEqual(all.map(\.id), ["c:a", all[1].id, all[2].id, "c:b"])
        XCTAssertEqual(all[1].msgId, "m1")
        XCTAssertEqual(all[2].msgId, "m2")
        XCTAssertEqual(all.map(\.id), CallLogItems.merge(calls: calls, messages: messages).map(\.id), "the same input, the same order")
        XCTAssertEqual(all[1].id, "m:" + String(UInt32(bitPattern: CallLogItems.javaHash("team")), radix: 16) + ":m1")
        XCTAssertEqual(CallLogItems.javaHash("team"), 3_555_933, "Java's String.hashCode")
    }

    func testFiltersAllCallsMessagesMissed() {
        let all = CallLogItems.merge(calls: [call("a", .missed, 5, "Team"), call("b", .declined, 4, "Team"), call("c", .incoming, 3, "Team")],
                                     messages: [m(msg("m", 2, mine: false, "Alice", "x"))])
        XCTAssertEqual(CallLogItems.filter(all, .all).count, 4)
        XCTAssertEqual(CallLogItems.filter(all, .calls).map(\.id), ["c:a", "c:b", "c:c"])
        XCTAssertEqual(CallLogItems.filter(all, .messages).count, 1)
        XCTAssertEqual(CallLogItems.filter(all, .missed).map(\.id), ["c:a"], "missed only (not declined)")
    }

    func testSearchesRoomPeopleAndTextWithoutCaseOrAccents() {
        let all = CallLogItems.merge(calls: [call("a", .incoming, 5, "Žluťoučký kůň", "Řehoř")],
                                     messages: [m(msg("m", 2, mine: false, "Alice", "Zavoláme se po OBĚDĚ?"))])
        XCTAssertEqual(CallLogItems.filter(all, .all, query: "zlutoucky").map(\.id), ["c:a"])
        XCTAssertEqual(CallLogItems.filter(all, .all, query: "REHOR").map(\.id), ["c:a"])
        XCTAssertEqual(CallLogItems.filter(all, .all, query: "obede alice").count, 1)
        XCTAssertEqual(CallLogItems.filter(all, .all, query: "obede bob").count, 0, "every word must match")
        XCTAssertEqual(CallLogItems.filter(all, .calls, query: "obede").count, 0)
    }

    func testSealedHoldVanishingAndHiddenMessagesShowOnlyTheirKind() {
        var sealed = msg("s", 1, mine: false, "Eva", "the secret")
        sealed.sealed = true
        var tap = msg("t", 1, mine: false, "Eva", "hold me")
        tap.tap = true
        var vanish = msg("v", 1, mine: false, "Eva", "gone soon")
        vanish.vanishing = true
        let hidden = msg("h", 1, mine: false, "Eva", "not now")
        for (x, what, word, isHidden) in [(sealed, "sealed", "the", false), (tap, "tap", "hold", false), (vanish, "vanish", "gone", false),
                                          (hidden, "hidden", "not", true)] {
            let it = m(x, hidden: isHidden)
            XCTAssertEqual(it.what, what)
            XCTAssertEqual(it.preview, "")
            XCTAssertTrue(CallLogItems.filter([it], .all, query: word).isEmpty, "the search does not see into it")
        }
        sealed.fileName = "plan.pdf"
        XCTAssertEqual(m(sealed).what, "sealed", "a sealed one even when it is also a file")
    }

    func testFilesCommandsAndTextHaveAOneLinePreview() {
        var file = msg("f", 1, mine: true, "Me", "")
        file.fileName = "plan.pdf"
        file.to = ["Bob"]
        let it = m(file)
        XCTAssertEqual(it.what, "file")
        XCTAssertEqual(it.preview, "plan.pdf")
        XCTAssertEqual(it.dir, "out")
        XCTAssertEqual(it.people, ["Bob"], "a private message of mine names its recipients")
        var fn = msg("c", 1, mine: false, "Alice", "done")
        fn.fnKeyword = "weather"
        XCTAssertEqual(m(fn).preview, "/weather · done")
        let long = "line one\nline\ttwo " + String(repeating: "word ", count: 50)
        let p = m(msg("l", 1, mine: false, "A", long)).preview
        XCTAssertTrue(p.hasPrefix("line one line two word"))
        XCTAssertEqual(p.count, CallLogItems.previewMax)
        XCTAssertTrue(p.hasSuffix("…"))
    }

    func testSystemLinesExpiredAndDeletedMessagesAreLeftOut() {
        var system = msg("s", 1, mine: false, "", "Alice joined")
        system.kind = "sys"
        XCTAssertNil(CallLogItems.message(roomKey: "team", room: "Team", system, hidden: false))
        var expired = msg("e", 1, mine: false, "A", "x")
        expired.expired = true
        XCTAssertNil(CallLogItems.message(roomKey: "team", room: "Team", expired, hidden: false))
        var deleted = msg("d", 1, mine: false, "A", "x")
        deleted.deleted = true
        XCTAssertNil(CallLogItems.message(roomKey: "team", room: "Team", deleted, hidden: false))
        XCTAssertNil(CallLogItems.message(roomKey: "team", room: "Team", nil, hidden: false))
    }

    func testCallsOfARoomNoLongerSavedCannotBeCalled() {
        let it = CallLogItems.call(.of(id: "z", roomKey: "gone", room: "Gone",
                                       record: CallTrack.Record(kind: .outgoing, at: 1, seconds: 0, video: true, people: [])), saved: false)
        XCTAssertFalse(it.saved)
        XCTAssertEqual(it.what, "video")
        XCTAssertEqual(it.dir, "out")
    }

    func testDaysAndLengths() throws {
        let prague = try XCTUnwrap(TimeZone(identifier: "Europe/Prague"))
        let noon: Int64 = 1_759_917_600_000 // 2025-10-08 12:00 in Prague
        XCTAssertEqual(CallLogItems.daysAgo(noon - 11 * 3600_000, now: noon, timeZone: prague), 0)
        XCTAssertEqual(CallLogItems.daysAgo(noon - 13 * 3600_000, now: noon, timeZone: prague), 1)
        XCTAssertEqual(CallLogItems.daysAgo(noon - 2 * 24 * 3600_000, now: noon, timeZone: prague), 2)
        XCTAssertEqual(CallLogItems.daysAgo(noon + 3600_000, now: noon, timeZone: prague), 0, "the future counts as today")
        XCTAssertEqual(CallLogItems.length(0), "")
        XCTAssertEqual(CallLogItems.length(42), "0:42")
        XCTAssertEqual(CallLogItems.length(724), "12:04")
        XCTAssertEqual(CallLogItems.length(3729), "1:02:09")
    }

    @MainActor
    func testCollectMergesTheHistoryWithTheRoomsMessages() {
        final class Source: CallLogMessageSource {
            func savedRooms() -> [CallLogRoom] { [CallLogRoom(key: "team", label: "Team")] }
            func messages(ofRoom roomKey: String) -> [CallLogRoomMessage] {
                [CallLogRoomMessage(message: CallLogItems.Message(id: "m1", createdAt: CallTrack.millis() - 10, mine: false, senderName: "Alice", text: "hi"),
                                    hidden: false)]
            }
        }
        let store = CallHistoryStore(vault: FakeVault())
        store.record(CallTrack.Record(kind: .missed, at: CallTrack.millis() - 5, seconds: 0, video: false, people: ["Bob"]), roomKey: "team", room: "Team")
        store.record(CallTrack.Record(kind: .outgoing, at: CallTrack.millis() - 20, seconds: 9, video: false, people: []), roomKey: "gone", room: "Gone")
        let source = Source()
        let items = CallLogItems.collect(history: store, messages: source)
        XCTAssertEqual(items.map(\.type), ["call", "msg", "call"])
        XCTAssertTrue(items[0].saved)
        XCTAssertFalse(items[2].saved, "a room no longer saved")
    }
}
