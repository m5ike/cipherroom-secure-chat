// 6.8: the app's call history — bounded (500 calls, 90 days), kept as the same
// JSON as Android in the vault; in memory while the vault is closed. Android's
// CallHistoryTest plus the store. The history is M5Proto's (CallHistory,
// CallHistoryStore; M5ProtoTests run the same cases); these check it through
// the app's adapter (AppCallHistory) and the vault seam's bytes.

import XCTest
@testable import M5cet
import M5Proto

final class CallHistoryTests: XCTestCase {
    private let day: Int64 = 24 * 3600_000

    private func entry(_ id: String, _ at: Int64) -> CallHistory.Entry {
        .of(id: id, roomKey: "team", room: "Team", CallTrack.Record(kind: .incoming, at: at, seconds: 5, video: false, people: ["Alice"]))
    }

    func testKeepsTheLast500OldestFirst() {
        let now = 1_000 * day
        var list = (0..<700).map { entry("c\($0)", now - Int64(700 - $0) * 60_000) }
        var rng = SystemRandomNumberGenerator()
        list.shuffle(using: &rng)
        let kept = CallHistory.bound(list, now: now)
        XCTAssertEqual(kept.count, CallHistory.keep)
        XCTAssertEqual(kept.first?.id, "c200")
        XCTAssertEqual(kept.last?.id, "c699")
        for i in 1..<kept.count { XCTAssertLessThanOrEqual(kept[i - 1].at, kept[i].at) }
    }

    func testDropsWhatIsOlderThan90DaysOrFromTheFuture() {
        let now = 1_000 * day
        let kept = CallHistory.bound([entry("old", now - 91 * day), entry("edge", now - 89 * day), entry("new", now),
                                      entry("future", now + 3 * day)], now: now)
        XCTAssertEqual(kept.map(\.id), ["edge", "new"])
    }

    func testRoundTripsThroughJsonAndReadsAndroidsRecord() throws {
        var e = CallHistory.Entry.of(id: "x1", roomKey: "team", room: "Tým",
                                     CallTrack.Record(kind: .declined, at: 123, seconds: 0, video: true, people: ["Alice", "Bob"]))
        e.sysUri = "content://call_log/calls/42"
        let back = AppCallHistory.decode(AppCallHistory.encode([e]))
        XCTAssertEqual(back, [e])
        // The record as Android writes it (org.json, the vault's user tier record "calls").
        let android = #"{"c":[{"id":"a1","key":"team","room":"Team","kind":"out","at":1760000000000,"sec":62,"video":false,"people":["Alice"]}]}"#
        let read = AppCallHistory.decode(Data(android.utf8))
        XCTAssertEqual(read.first?.callKind, .outgoing)
        XCTAssertEqual(read.first?.at, 1_760_000_000_000)
        XCTAssertEqual(read.first?.seconds, 62)
        XCTAssertEqual(read.first?.people, ["Alice"])
        // And ours reads back with the same keys — written byte for byte as Android wrote it.
        let ours = try XCTUnwrap(try JSONSerialization.jsonObject(with: AppCallHistory.encode(read)) as? [String: Any])
        let first = try XCTUnwrap((ours["c"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(first.keys), ["id", "key", "room", "kind", "at", "sec", "video", "people"])
        XCTAssertEqual(String(decoding: AppCallHistory.encode(read), as: UTF8.self), android)
    }

    func testAnUnknownKindReadsAsMissedAndNothingBreaksOnJunk() {
        let list = AppCallHistory.decode(Data(#"{"c":[{"id":"a","kind":"weird","at":5,"sec":-3},7,null]}"#.utf8))
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0].callKind, .missed)
        XCTAssertEqual(list[0].seconds, 0)
        XCTAssertTrue(AppCallHistory.decode(Data("{}".utf8)).isEmpty)
        XCTAssertTrue(AppCallHistory.decode(nil).isEmpty)
        XCTAssertTrue(AppCallHistory.decode(Data("not json".utf8)).isEmpty)
    }

    @MainActor
    func testTheStoreKeepsCallsWhileLockedInMemoryAndMergesThemOnUnlock() {
        let vault = FakeVault()
        vault.isUnlocked = false
        let now: Int64 = 1_000 * day
        let store = AppCallHistory(vault: vault, now: { now })
        store.add(entry("while-locked", now - 1_000))
        XCTAssertNil(vault.data, "nothing on the disk while the vault is closed")
        XCTAssertTrue(store.load().isEmpty, "nothing readable while locked")
        XCTAssertEqual(store.pending.count, 1)
        vault.isUnlocked = true
        store.add(entry("after", now))
        XCTAssertEqual(store.load().map(\.id), ["while-locked", "after"])
        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertEqual(AppCallHistory.decode(vault.data).map(\.id), ["while-locked", "after"], "the vault holds both")
    }

    @MainActor
    func testTheStoreKeepsNothingWhenTheSettingIsOffAndClearsAndWipes() {
        let vault = FakeVault()
        let store = AppCallHistory(vault: vault)
        var changes = 0
        store.onChange = { changes += 1 }
        var keep = false
        store.enabled = { keep }
        store.add(entry("no", CallTrack.millis()))
        XCTAssertTrue(store.load().isEmpty)
        XCTAssertEqual(changes, 0)
        keep = true
        store.record(CallTrack.Record(kind: .missed, at: CallTrack.millis(), seconds: 0, video: false, people: []), roomKey: "k", room: "Room")
        XCTAssertEqual(store.load().count, 1)
        XCTAssertEqual(store.load().first?.id.count, 12, "9 random bytes, base64url")
        XCTAssertEqual(changes, 1)
        store.clear()
        XCTAssertNil(vault.data)
        store.wipe()
        store.add(entry("after-wipe", CallTrack.millis()))
        XCTAssertTrue(store.load().isEmpty, "nothing is kept after a wipe")
    }

    @MainActor
    func testTheVaultCanBeWiredLater() {
        let store = AppCallHistory()
        store.add(entry("before-the-vault", CallTrack.millis()))
        XCTAssertEqual(store.pending.count, 1, "no vault yet: kept in memory, as while locked")
        let vault = FakeVault()
        store.vault = vault
        XCTAssertEqual(store.load().map(\.id), ["before-the-vault"])
        XCTAssertNotNil(vault.data)
    }
}
