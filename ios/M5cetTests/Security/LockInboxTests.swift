// The lock inbox around LockBox (Android LockedRooms): a generation per lock,
// items while locked, nothing after close; the drain opens older locks first and
// each in its order, hands them over grouped as Android's Parsed, and deletes them;
// a crash leaves them for the next unlock; another install's generation is dropped;
// kept files move in and go with the drain; the merge keeps places by id.

import XCTest
@testable import M5cet

final class LockInboxTests: XCTestCase {
    private func drained(_ inbox: LockInbox, _ dek: SecretBytes) -> [LockInboxParsed] {
        var out: [LockInboxParsed] = []
        inbox.drain(dek: dek) { out.append($0) }
        return out
    }

    func testItemsGoInOnlyWhileAGenerationIsOpen() throws {
        let dir = TempDir()
        let inbox = LockInbox(dir: dir.url.appendingPathComponent("lockbox"))
        let dek = SecretBytes(random: 32)
        XCTAssertFalse(inbox.isActive)
        XCTAssertFalse(inbox.message(room: "r", ["id": "x"]), "not locked: nothing is sealed")
        XCTAssertTrue(inbox.begin(dek: dek))
        XCTAssertTrue(inbox.isActive)
        let kid = try XCTUnwrap(inbox.currentKid)
        XCTAssertTrue(inbox.message(room: "r1", ["id": "m1", "kind": "text", "text": "ahoj"]))
        XCTAssertTrue(inbox.pin(slot: "alice", kid: "K1"))
        XCTAssertTrue(inbox.state(room: "r1", id: "m0", who: "bob", name: "Bob", state: "read"))
        XCTAssertTrue(inbox.resume(room: "r1", peerId: "p", secret: "s"))
        XCTAssertTrue(inbox.call(["id": "c1"]))
        XCTAssertTrue(inbox.callUri(id: "c1", uri: "content://1"))
        inbox.close()
        XCTAssertFalse(inbox.isActive)
        XCTAssertFalse(inbox.pin(slot: "x", kid: "y"))
        XCTAssertEqual(Set(dir.files()), ["lockbox/\(kid).key", "lockbox/\(kid).log"])
        // Nothing readable on the disk.
        let log = try Data(contentsOf: dir.url.appendingPathComponent("lockbox/\(kid).log"))
        XCTAssertNil(log.range(of: Data("ahoj".utf8)))
        XCTAssertEqual(log.split(separator: 0x0a).count, 6)
        // The drain: one generation, grouped.
        let parsed = drained(inbox, dek)
        XCTAssertEqual(parsed.count, 1)
        let p = parsed[0]
        XCTAssertEqual(p.rooms.map(\.room), ["r1"])
        XCTAssertEqual(p.rooms[0].items.map { $0.jString("t") }, ["msg", "state"])
        XCTAssertEqual(p.pins.map(\.slot), ["alice"])
        XCTAssertEqual(p.resumes.map(\.peerId), ["p"])
        XCTAssertEqual(p.calls.count, 1)
        XCTAssertEqual(p.callUris.map(\.uri), ["content://1"])
        XCTAssertEqual(dir.files(), [], "a drained generation is deleted")
        XCTAssertFalse(inbox.hasPending)
    }

    func testOlderLocksDrainFirstAndACrashKeepsThem() throws {
        let dir = TempDir()
        let path = dir.url.appendingPathComponent("lockbox")
        let dek = SecretBytes(random: 32)
        var inbox = LockInbox(dir: path)
        XCTAssertTrue(inbox.begin(dek: dek))
        XCTAssertTrue(inbox.message(room: "r", ["id": "a", "text": "first lock"]))
        inbox.close()
        Thread.sleep(forTimeInterval: 0.02)
        XCTAssertTrue(inbox.begin(dek: dek))
        XCTAssertTrue(inbox.message(room: "r", ["id": "a", "text": "second lock"]))
        XCTAssertTrue(inbox.message(room: "r", ["id": "b"]))
        // The process dies while locked: a new one knows nothing of the generation but the files.
        inbox = LockInbox(dir: path)
        XCTAssertFalse(inbox.isActive)
        XCTAssertTrue(inbox.hasPending)
        let parsed = drained(inbox, dek)
        XCTAssertEqual(parsed.count, 2)
        XCTAssertEqual(parsed[0].rooms[0].items.compactMap { $0.jObject("m")?.jString("text") }, ["first lock"])
        XCTAssertEqual(parsed[1].rooms[0].items.compactMap { $0.jObject("m")?.jString("id") }, ["a", "b"])
        // Merged in that order, the newer state of "a" wins in its place.
        var history: [SecRecord] = [["id": "z", "text": "before"]]
        for p in parsed {
            history = LockInbox.merge(history: history, items: p.rooms[0].items, id: { $0.jString("id") },
                                      message: { $0 }, raise: { _, _ in })
        }
        XCTAssertEqual(history.map { $0.jString("id") }, ["z", "a", "b"])
        XCTAssertEqual(history[1].jString("text"), "second lock")
    }

    func testAGenerationOfAnotherDataKeyIsDropped() throws {
        let dir = TempDir()
        let inbox = LockInbox(dir: dir.url.appendingPathComponent("lockbox"))
        XCTAssertTrue(inbox.begin(dek: SecretBytes(random: 32)))
        XCTAssertTrue(inbox.pin(slot: "s", kid: "k"))
        inbox.close()
        let result = inbox.drain(dek: SecretBytes(random: 32)) { _ in XCTFail("nothing of it can be read") }
        XCTAssertEqual(result.items, 0)
        XCTAssertFalse(inbox.hasPending, "removed: it can never be read")
    }

    func testAKeptFileMovesInAndGoesWithTheDrain() throws {
        let dir = TempDir()
        let inbox = LockInbox(dir: dir.url.appendingPathComponent("lockbox"))
        let dek = SecretBytes(random: 32)
        let slots = dir.url.appendingPathComponent("incoming.slots")
        try Data("encrypted under the transfer key".utf8).write(to: slots)
        XCTAssertFalse(inbox.keepFile(room: "r", id: "f:1", key: Data([1]), slots: slots, chunkSize: 4, total: 1, size: 4,
                                      lengths: [4], root: "root", p4: true), "not locked: the caller stores it")
        XCTAssertTrue(FileManager.default.fileExists(atPath: slots.path))
        XCTAssertTrue(inbox.begin(dek: dek))
        XCTAssertTrue(inbox.keepFile(room: "r", id: "f:1", key: Data([1, 2, 3]), slots: slots, chunkSize: 65_536, total: 1,
                                     size: 33, lengths: [33], root: "root", p4: true))
        XCTAssertFalse(FileManager.default.fileExists(atPath: slots.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: inbox.partURL(id: "f:1").path))
        XCTAssertEqual(inbox.partURL(id: "f:1").lastPathComponent, "f_1.part")
        inbox.close()
        var files: [SecRecord] = []
        inbox.drain(dek: dek) { p in
            files = p.files
            // The rooms store it into the file vault from the part while the drain runs.
            XCTAssertTrue(FileManager.default.fileExists(atPath: inbox.partURL(id: "f:1").path))
        }
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(Bytes.unb64(files[0].jString("key")), Data([1, 2, 3]))
        XCTAssertEqual(files[0].jBool("p4"), true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: inbox.partURL(id: "f:1").path), "kept files go with the drain")
    }

    func testParseGroupsAsAndroid() {
        func j(_ o: SecRecord) -> Data { SecJSON.data(o) }
        let p = LockInbox.parse([
            j(["t": "msg", "room": "r2", "m": ["id": "1"]]),
            j(["t": "pin", "slot": "a", "kid": "first"]),
            j(["t": "msg", "room": "r1", "m": ["id": "2"]]),
            j(["t": "pin", "slot": "a", "kid": "second"]),
            j(["t": "resume", "room": "r1", "peerId": "p1", "secret": "s1"]),
            j(["t": "resume", "room": "r1", "peerId": "p2", "secret": "s2"]),
            j(["t": "state", "room": "r2", "id": "1", "state": "read"]),
            j(["t": "msg", "room": "", "m": ["id": "3"]]),
            j(["t": "weird"]),
            Data("not json".utf8),
        ])
        XCTAssertEqual(p.rooms.map(\.room), ["r2", "r1"])
        XCTAssertEqual(p.rooms[0].items.count, 2)
        XCTAssertEqual(p.pins.map(\.kid), ["first"], "the first pin wins")
        XCTAssertEqual(p.resumes.map(\.peerId), ["p2"], "the last resume wins")
        XCTAssertEqual(p.unknown, 3)
    }

    func testMergeKeepsPlacesAndRaisesStates() {
        struct M { var id: String; var text: String; var state = "" }
        let history = [M(id: "a", text: "A"), M(id: "b", text: "B")]
        let items: [SecRecord] = [
            ["t": "msg", "m": ["id": "c", "text": "C"]],
            ["t": "msg", "m": ["id": "a", "text": "A2"]],
            ["t": "state", "id": "b", "state": "read"],
            ["t": "state", "id": "nobody", "state": "read"],
            ["t": "msg", "m": ["id": "", "text": "no id"]],
            ["t": "msg", "m": ["id": "x", "text": "refused"]],
        ]
        let merged = LockInbox.merge(history: history, items: items, id: { $0.id },
                                     message: { $0.jString("id") == "x" ? nil : M(id: $0.jString("id"), text: $0.jString("text")) },
                                     raise: { m, it in m.state = it.jString("state") })
        XCTAssertEqual(merged.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(merged[0].text, "A2", "a known id is replaced in its place")
        XCTAssertEqual(merged[1].state, "read")
    }

    func testUnlockedDrainsOnABackgroundTaskThenRestores() async throws {
        let dir = TempDir()
        let inbox = LockInbox(dir: dir.url.appendingPathComponent("lockbox"))
        let dek = SecretBytes(random: 32)
        let consumer = RecordingConsumer()
        await inbox.unlocked(dek: dek, consumer: consumer)
        XCTAssertEqual(consumer.restored, 1, "nothing pending: restored at once")
        XCTAssertTrue(inbox.begin(dek: dek))
        inbox.message(room: "r", ["id": "m1"])
        inbox.pin(slot: "carol", kid: "K")
        await inbox.unlocked(dek: dek, consumer: consumer)
        XCTAssertFalse(inbox.isActive)
        XCTAssertFalse(inbox.isDraining)
        XCTAssertEqual(consumer.parsed.count, 1)
        XCTAssertEqual(consumer.parsed[0].rooms["r"], ["m1"])
        XCTAssertEqual(consumer.parsed[0].pins, ["carol"])
        XCTAssertEqual(consumer.restored, 2)
        XCTAssertFalse(dek.isWiped, "the drain used its own copy")
    }
}
