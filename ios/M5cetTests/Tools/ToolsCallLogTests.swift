// The History screen's part (android ui/parts/CallLogUi.java): $log as the
// design draws it — entries of the filter and search, newest first, each with
// its day, words, icon and colour; a sealed or hidden message only by its kind —
// and calllog.* : open, an entry's room (a message: revealed), a call again
// only after a confirmation, clearing the history, the lock forgetting it all.

import Foundation
import M5Core
import M5Design
import M5Proto
import XCTest
@testable import M5cet

/// The call history's vault record in memory.
@MainActor
final class ToolsMemoryVault: CallHistoryVault {
    var data: Data?
    var isUnlocked = true
    func readCalls() -> Data? { data }
    func writeCalls(_ d: Data) throws { data = d }
    func deleteCalls() { data = nil }
}

@MainActor
final class ToolsCallLogTests: XCTestCase {
    private let now: Int64 = 1_760_000_000_000 // 2025-10-09 08:53 UTC
    private var log: ToolsCallLog!
    private var history: AppCallHistory!
    private var rooms: ToolsFakeRooms!
    private var host: DesignHost!
    private var asked: [(String, [(String, Bool)], String, (Int) -> Void)] = []

    override func setUp() async throws {
        let n = now
        history = AppCallHistory(vault: ToolsMemoryVault(), now: { n })
        func call(_ id: String, _ kind: String, _ at: Int64, video: Bool = false, people: [String] = [], seconds: Int64 = 0, room: String = "team") -> CallHistory.Entry {
            var e = CallHistory.Entry()
            e.id = id; e.roomKey = room; e.room = room.capitalized; e.kind = kind; e.at = at; e.video = video; e.people = people; e.seconds = seconds
            return e
        }
        history.add(call("c1", CallTrack.Kind.missed.rawValue, now - 60_000, people: ["Alice"]))
        history.add(call("c2", CallTrack.Kind.outgoing.rawValue, now - 86_400_000 - 5_000, video: true, people: ["Bob", "Eva"], seconds: 724))
        history.add(call("c3", CallTrack.Kind.outgoing.rawValue, now - 3 * 86_400_000, seconds: 0, room: "gone"))
        let room = ToolsRecordingRoom("team")
        var m1 = ChatMessage()
        m1.id = "m-1"; m1.text = "Zavoláme se po obědě?"; m1.senderName = "Alice"; m1.createdAt = now - 30_000
        var m2 = ChatMessage()
        m2.id = "m-2"; m2.text = "tajné"; m2.senderName = "Eva"; m2.createdAt = now - 20_000; m2.sealed = JSONObject([("v", 1)])
        var m3 = ChatMessage()
        m3.id = "m-3"; m3.text = "skryté"; m3.senderName = "Bob"; m3.createdAt = now - 10_000; m3.hiddenUntil = ChatMessage.untilSignIn
        var m4 = ChatMessage()
        m4.id = "m-4"; m4.text = "moje"; m4.mine = true; m4.to = ["Alice"]; m4.createdAt = now - 5_000
        room.messages = [m1, m2, m3, m4]
        rooms = ToolsFakeRooms(room)
        let core = CoreModels(rooms: rooms, account: ToolsFakeAccount())
        log = ToolsCallLog()
        log.history = { [history] in history! }
        log.core = { core }
        log.now = { n }
        log.timeZone = TimeZone(identifier: "UTC")!
        log.confirm = { [weak self] m, c, x, p in self?.asked.append((m, c, x, p)) }
        host = toolsHost()
    }

    private func items() -> [DesignValue] { log.scope(host: host)["items"].arrayValue ?? [] }

    func testTheListAsTheDesignDrawsIt() {
        log.open(host)
        XCTAssertEqual(host.screen, "log")
        XCTAssertEqual(host.form["logFilter"], "all")
        let s = log.scope(host: host)
        XCTAssertEqual(s["loading"], .bool(false))
        XCTAssertEqual(s["empty"], .bool(false))
        XCTAssertEqual(s["count"], .number(7))
        XCTAssertEqual(s["more"], .bool(false))
        XCTAssertEqual(s["history"], .bool(true))
        let it = items()
        XCTAssertEqual(it.map { $0["id"].stringValue ?? "" }.prefix(5), ["m:\(String(UInt32(bitPattern: CallLogItems.javaHash("team")), radix: 16)):m-4",
                                                                           "m:\(String(UInt32(bitPattern: CallLogItems.javaHash("team")), radix: 16)):m-3",
                                                                           "m:\(String(UInt32(bitPattern: CallLogItems.javaHash("team")), radix: 16)):m-2",
                                                                           "m:\(String(UInt32(bitPattern: CallLogItems.javaHash("team")), radix: 16)):m-1", "c:c1"])
        // My private message, a hidden one, a sealed one, a text: only the kinds that may show their text do.
        XCTAssertEqual(it[0]["detail"], "Me → Alice: moje")
        XCTAssertEqual(it[0]["icon"], "send-horizontal")
        XCTAssertEqual(it[0]["color"], "@primary")
        XCTAssertEqual(it[1]["detail"], "Bob: Hidden message")
        XCTAssertEqual(it[1]["icon"], "eye-off")
        XCTAssertEqual(it[2]["detail"], "Eva: Sealed message")
        XCTAssertEqual(it[2]["icon"], "message-square-lock")
        XCTAssertEqual(it[3]["detail"], "Alice: Zavoláme se po obědě?")
        XCTAssertEqual(it[3]["icon"], "message-circle")
        XCTAssertEqual(it[3]["callable"], .bool(false))
        // Calls: missed today, video yesterday with its length, one to a room no longer saved (not callable).
        XCTAssertEqual(it[4]["detail"], "Missed · Alice")
        XCTAssertEqual(it[4]["icon"], "phone-off")
        XCTAssertEqual(it[4]["color"], "@danger")
        XCTAssertEqual(it[4]["callable"], .bool(true))
        XCTAssertEqual(it[0]["day"], "Today")
        XCTAssertEqual(it[0]["newDay"], .bool(true))
        XCTAssertEqual(it[1]["newDay"], .bool(false))
        XCTAssertEqual(it[5]["detail"], "Outgoing · video · 12:04 · Bob, Eva")
        XCTAssertEqual(it[5]["day"], "Yesterday")
        XCTAssertEqual(it[5]["newDay"], .bool(true))
        XCTAssertEqual(it[5]["icon"], "video")
        XCTAssertEqual(it[5]["length"], "12:04")
        XCTAssertEqual(it[6]["detail"], "Outgoing · nobody came")
        XCTAssertEqual(it[6]["icon"], "phone-outgoing")
        XCTAssertEqual(it[6]["callable"], .bool(false))
        XCTAssertNotEqual(it[6]["day"], "Today")
    }

    func testTheFilterAndTheSearchOfTheForm() {
        log.open(host)
        host.form["logFilter"] = "missed"
        XCTAssertEqual(items().count, 1)
        host.form["logFilter"] = "messages"
        host.form["logQuery"] = "obede" // without accents
        XCTAssertEqual(items().map { $0["detail"].stringValue ?? "" }, ["Alice: Zavoláme se po obědě?"])
        host.form["logQuery"] = "tajné" // a sealed message's text is not searched
        XCTAssertEqual(items().count, 0)
        XCTAssertEqual(log.scope(host: host)["empty"], .bool(true))
    }

    func testAnEntryOpensItsRoomAndRevealsTheMessage() {
        log.open(host)
        let msgId = items()[3]["id"].stringValue ?? ""
        log.run("calllog.item", msgId, host: host)
        XCTAssertEqual(rooms.switched, ["team"])
        XCTAssertEqual(host.screen, "room")
        toolsWait { self.rooms.rooms["team"]?.revealRequest == "m-1" }
        // A room no longer saved: said so.
        log.run("calllog.item", "c:c3", host: host)
        XCTAssertEqual(host.flashes.last?.text, "This room is no longer saved in the app.")
    }

    func testACallAgainOnlyAfterTheConfirmation() {
        var started: [String] = []
        host.services.actions.register(["call.audio", "call.video"]) { a, _ in started.append(a.name) }
        log.open(host)
        log.run("calllog.call", "c:c1", host: host)
        XCTAssertTrue(started.isEmpty)
        XCTAssertEqual(asked.count, 1)
        XCTAssertEqual(asked[0].0, "Call the room Team? Everyone connected there hears the call.")
        XCTAssertEqual(asked[0].1.map(\.0), ["Call", "With video"])
        XCTAssertEqual(asked[0].2, "Close")
        asked[0].3(1)
        XCTAssertEqual(started, ["call.video"])
        XCTAssertEqual(rooms.switched.last, "team")
        XCTAssertEqual(host.screen, "room")
    }

    func testClearingTheHistoryAskedFirst() {
        log.open(host)
        log.run("calllog.clear", "", host: host)
        XCTAssertEqual(history.load().count, 3)
        XCTAssertEqual(asked.first?.0, "Delete the app's call history on this phone? The rooms' messages stay.")
        XCTAssertEqual(asked.first?.1.first?.1, true) // destructive
        asked[0].3(0)
        XCTAssertEqual(history.load().count, 0)
        XCTAssertEqual(host.flashes.last?.text, "The call history is deleted.")
        XCTAssertEqual(items().count, 4) // the messages stay
    }

    func testTheLockForgetsWhatWasGathered() {
        log.open(host)
        XCTAssertEqual(log.all.count, 7)
        log.forget()
        XCTAssertTrue(log.all.isEmpty)
        XCTAssertFalse(log.fresh)
        // Shown again, it is gathered again.
        XCTAssertEqual(items().count, 7)
    }

    func testTheSystemCallLogIsNotTheAppsOnIOS() {
        log.run("calllog.system", "", host: host)
        XCTAssertTrue(asked.isEmpty)
        XCTAssertTrue(host.flashes.isEmpty)
    }

    func testAChatMessageAsTheLogSeesIt() {
        var m = ChatMessage()
        m.id = "x"; m.text = "t"; m.vanishSeconds = 30; m.fn = JSONObject([("keyword", "dns")])
        let x = CoreCallLogSource.message(m, now: now)
        XCTAssertTrue(x.message.vanishing)
        XCTAssertEqual(x.message.fnKeyword, "dns")
        XCTAssertFalse(x.hidden)
        m.hiddenUntil = now + 1000
        XCTAssertTrue(CoreCallLogSource.message(m, now: now).hidden)
        m.hiddenUntil = now - 1000
        XCTAssertFalse(CoreCallLogSource.message(m, now: now).hidden)
    }
}
