// 6.8: the app's call history — bounded (500 calls, 90 days), kept as the same
// JSON as Android in the vault; in memory while the vault is closed. Android's
// CallHistoryTest plus the store.

import XCTest
@testable import M5cet

final class CallHistoryTests: XCTestCase {
    private let day: Int64 = 24 * 3600_000

    private func entry(_ id: String, _ at: Int64) -> CallHistoryEntry {
        .of(id: id, roomKey: "team", room: "Team", record: CallTrack.Record(kind: .incoming, at: at, seconds: 5, video: false, people: ["Alice"]))
    }

    func testKeepsTheLast500OldestFirst() {
        let now = 1_000 * day
        var list = (0..<700).map { entry("c\($0)", now - Int64(700 - $0) * 60_000) }
        var rng = SystemRandomNumberGenerator()
        list.shuffle(using: &rng)
        let kept = CallHistoryCodec.bound(list, now: now)
        XCTAssertEqual(kept.count, CallHistoryCodec.keep)
        XCTAssertEqual(kept.first?.id, "c200")
        XCTAssertEqual(kept.last?.id, "c699")
        for i in 1..<kept.count { XCTAssertLessThanOrEqual(kept[i - 1].at, kept[i].at) }
    }

    func testDropsWhatIsOlderThan90DaysOrFromTheFuture() {
        let now = 1_000 * day
        let kept = CallHistoryCodec.bound([entry("old", now - 91 * day), entry("edge", now - 89 * day), entry("new", now),
                                           entry("future", now + 3 * day)], now: now)
        XCTAssertEqual(kept.map(\.id), ["edge", "new"])
    }

    func testRoundTripsThroughJsonAndReadsAndroidsRecord() throws {
        var e = CallHistoryEntry.of(id: "x1", roomKey: "team", room: "Tým",
                                    record: CallTrack.Record(kind: .declined, at: 123, seconds: 0, video: true, people: ["Alice", "Bob"]))
        e.sys = "content://call_log/calls/42"
        let back = CallHistoryCodec.decode(CallHistoryCodec.encode([e]))
        XCTAssertEqual(back, [e])
        // The record as Android writes it (org.json, the vault's user tier record "calls").
        let android = #"{"c":[{"id":"a1","key":"team","room":"Team","kind":"out","at":1760000000000,"sec":62,"video":false,"people":["Alice"]}]}"#
        let read = CallHistoryCodec.decode(Data(android.utf8))
        XCTAssertEqual(read.first?.kind, .outgoing)
        XCTAssertEqual(read.first?.at, 1_760_000_000_000)
        XCTAssertEqual(read.first?.seconds, 62)
        XCTAssertEqual(read.first?.people, ["Alice"])
        // And ours reads back with the same keys.
        let ours = try XCTUnwrap(try JSONSerialization.jsonObject(with: CallHistoryCodec.encode(read)) as? [String: Any])
        let first = try XCTUnwrap((ours["c"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(first.keys), ["id", "key", "room", "kind", "at", "sec", "video", "people"])
    }

    func testAnUnknownKindReadsAsMissedAndNothingBreaksOnJunk() {
        let list = CallHistoryCodec.decode(Data(#"{"c":[{"id":"a","kind":"weird","at":5,"sec":-3},7,null]}"#.utf8))
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0].kind, .missed)
        XCTAssertEqual(list[0].seconds, 0)
        XCTAssertTrue(CallHistoryCodec.decode(Data("{}".utf8)).isEmpty)
        XCTAssertTrue(CallHistoryCodec.decode(nil).isEmpty)
        XCTAssertTrue(CallHistoryCodec.decode(Data("not json".utf8)).isEmpty)
    }

    @MainActor
    func testTheStoreKeepsCallsWhileLockedInMemoryAndMergesThemOnUnlock() {
        let vault = FakeVault()
        vault.isUnlocked = false
        let now: Int64 = 1_000 * day
        let store = CallHistoryStore(vault: vault, now: { now })
        store.add(entry("while-locked", now - 1_000))
        XCTAssertNil(vault.data, "nothing on the disk while the vault is closed")
        XCTAssertTrue(store.load().isEmpty, "nothing readable while locked")
        XCTAssertEqual(store.pending.count, 1)
        vault.isUnlocked = true
        store.add(entry("after", now))
        XCTAssertEqual(store.load().map(\.id), ["while-locked", "after"])
        XCTAssertTrue(store.pending.isEmpty)
    }

    @MainActor
    func testTheStoreKeepsNothingWhenTheSettingIsOffAndClearsAndWipes() {
        let vault = FakeVault()
        let store = CallHistoryStore(vault: vault)
        var keep = false
        store.enabled = { keep }
        store.add(entry("no", CallTrack.millis()))
        XCTAssertTrue(store.load().isEmpty)
        keep = true
        store.record(CallTrack.Record(kind: .missed, at: CallTrack.millis(), seconds: 0, video: false, people: []), roomKey: "k", room: "Room")
        XCTAssertEqual(store.load().count, 1)
        XCTAssertEqual(store.load().first?.id.count, 12, "9 random bytes, base64url")
        store.clear()
        XCTAssertNil(vault.data)
        store.wipe()
        store.add(entry("after-wipe", CallTrack.millis()))
        XCTAssertTrue(store.load().isEmpty, "nothing is kept after a wipe")
    }
}
