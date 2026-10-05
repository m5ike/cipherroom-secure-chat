// The lock inbox on the disk (LockInboxFiles over M5Proto's LockInbox / LockedRooms and
// M5Crypto's LockBox — their own tests cover the crypto and the merge rules): a generation
// per lock, items while locked, nothing after close; the drain opens older locks first,
// hands them over grouped and deletes them; a crash leaves them for the next unlock (a cut
// line skipped); another install's generation is dropped; kept files move in and go with the
// drain. And Android's format byte for byte: a generation written by Android's algorithm
// (made with node:crypto) opens from the disk here.

import CryptoKit
import M5Core
import M5Crypto
import M5Proto
import XCTest
@testable import M5cet

final class LockInboxFilesTests: XCTestCase {
    private func drained(_ inbox: LockInboxFiles, _ dek: SecretBytes) -> [LockedRooms.Parsed] {
        var out: [LockedRooms.Parsed] = []
        inbox.drain(dek: dek) { out.append($0) }
        return out
    }

    private func ids(_ items: [JSONObject]?) -> [String] { (items ?? []).compactMap { $0.object("m")?.optString("id") } }

    func testItemsGoInOnlyWhileAGenerationIsOpen() throws {
        let dir = TempDir()
        let inbox = LockInboxFiles(dir: dir.url.appendingPathComponent("lockbox"))
        let dek = SecretBytes(random: 32)
        XCTAssertFalse(inbox.isActive)
        XCTAssertFalse(inbox.seal(TestItems.message(room: "r", id: "x")), "not locked: nothing is sealed")
        XCTAssertTrue(inbox.begin(dek: dek))
        XCTAssertTrue(inbox.isActive)
        let kid = try XCTUnwrap(inbox.currentKid)
        XCTAssertTrue(inbox.seal(TestItems.message(room: "r1", id: "m1", text: "ahoj")))
        XCTAssertTrue(inbox.seal(LockedRooms.pin(slot: "alice", kid: "K1")))
        XCTAssertTrue(inbox.seal(LockedRooms.state(roomKey: "r1", id: "m0", who: "bob", name: "Bob", state: "read")))
        XCTAssertTrue(inbox.seal(LockedRooms.resume(roomKey: "r1", peerId: "p", secret: "s")))
        XCTAssertTrue(inbox.seal(LockedRooms.call(JSONObject([("id", "c1")]))))
        XCTAssertTrue(inbox.seal(LockedRooms.callUri(id: "c1", uri: "content://1")))
        inbox.close()
        XCTAssertFalse(inbox.isActive)
        XCTAssertFalse(inbox.seal(LockedRooms.pin(slot: "x", kid: "y")))
        XCTAssertEqual(Set(dir.files()), ["lockbox/\(kid).key", "lockbox/\(kid).log"])
        // Nothing readable on the disk.
        let log = try Data(contentsOf: dir.url.appendingPathComponent("lockbox/\(kid).log"))
        XCTAssertNil(log.range(of: Data("ahoj".utf8)))
        XCTAssertEqual(log.split(separator: 0x0a).count, 6)
        // The drain: one generation, grouped (M5Proto's LockedRooms.parse).
        let parsed = drained(inbox, dek)
        XCTAssertEqual(parsed.count, 1)
        let p = parsed[0]
        XCTAssertEqual(p.rooms.keys, ["r1"])
        XCTAssertEqual(p.rooms["r1"]?.map { $0.optString("t") }, ["msg", "state"])
        XCTAssertEqual(p.pins.keys, ["alice"])
        XCTAssertEqual(p.resumes["r1"], ["p", "s"])
        XCTAssertEqual(p.calls.count, 1)
        XCTAssertEqual(p.callUris["c1"], "content://1")
        XCTAssertEqual(LockInboxFiles.count(p), 6)
        XCTAssertEqual(dir.files(), [], "a drained generation is deleted")
        XCTAssertFalse(inbox.hasPending)
    }

    func testOlderLocksDrainFirstAndACrashKeepsThem() throws {
        let dir = TempDir()
        let path = dir.url.appendingPathComponent("lockbox")
        let dek = SecretBytes(random: 32)
        var inbox = LockInboxFiles(dir: path)
        XCTAssertTrue(inbox.begin(dek: dek))
        XCTAssertTrue(inbox.seal(TestItems.message(room: "r", id: "a", text: "first lock")))
        inbox.close()
        Thread.sleep(forTimeInterval: 0.02)
        XCTAssertTrue(inbox.begin(dek: dek))
        XCTAssertTrue(inbox.seal(TestItems.message(room: "r", id: "a", text: "second lock")))
        XCTAssertTrue(inbox.seal(TestItems.message(room: "r", id: "b")))
        // The process dies while locked, in the middle of a line: a new one knows nothing but the files.
        let kid = try XCTUnwrap(inbox.currentKid)
        let h = try FileHandle(forWritingTo: path.appendingPathComponent(kid + ".log"))
        try h.seekToEnd()
        try h.write(contentsOf: Data("{\"s\":3,\"e\":\"MFkw".utf8))
        try h.close()
        inbox = LockInboxFiles(dir: path)
        XCTAssertFalse(inbox.isActive)
        XCTAssertTrue(inbox.hasPending)
        let parsed = drained(inbox, dek)
        XCTAssertEqual(parsed.count, 2)
        XCTAssertEqual(parsed[0].rooms["r"]?.compactMap { $0.object("m")?.optString("text") }, ["first lock"])
        XCTAssertEqual(ids(parsed[1].rooms["r"]), ["a", "b"], "the cut line is skipped")
        // Merged in that order (M5Proto's LockedRooms.merge), the newer state of "a" wins in its place.
        var z = ChatMessage()
        z.id = "z"
        var history = [z]
        for p in parsed { history = LockedRooms.merge(history: history, roomKey: "r", items: p.rooms["r"] ?? [], now: 1_000) }
        XCTAssertEqual(history.map(\.id), ["z", "a", "b"])
        XCTAssertEqual(history[1].text, "second lock")
    }

    func testAGenerationOfAnotherDataKeyIsDropped() throws {
        let dir = TempDir()
        let inbox = LockInboxFiles(dir: dir.url.appendingPathComponent("lockbox"))
        XCTAssertTrue(inbox.begin(dek: SecretBytes(random: 32)))
        XCTAssertTrue(inbox.seal(LockedRooms.pin(slot: "s", kid: "k")))
        inbox.close()
        let result = inbox.drain(dek: SecretBytes(random: 32)) { _ in XCTFail("nothing of it can be read") }
        XCTAssertEqual(result.items, 0)
        XCTAssertFalse(inbox.hasPending, "removed: it can never be read")
    }

    func testAKeptFileMovesInAndGoesWithTheDrain() throws {
        let dir = TempDir()
        let inbox = LockInboxFiles(dir: dir.url.appendingPathComponent("lockbox"))
        let dek = SecretBytes(random: 32)
        let slots = dir.url.appendingPathComponent("incoming.slots")
        try Data("encrypted under the transfer key".utf8).write(to: slots)
        XCTAssertFalse(inbox.keepFile(room: "r", id: "f:1", key: [1], slots: slots, chunkSize: 4, total: 1, size: 4,
                                      lengths: [4], root: "root", p4: true), "not locked: the caller stores it")
        XCTAssertTrue(FileManager.default.fileExists(atPath: slots.path))
        XCTAssertTrue(inbox.begin(dek: dek))
        XCTAssertTrue(inbox.keepFile(room: "r", id: "f:1", key: [1, 2, 3], slots: slots, chunkSize: 65_536, total: 1,
                                     size: 33, lengths: [33], root: "root", p4: true))
        XCTAssertFalse(FileManager.default.fileExists(atPath: slots.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: inbox.partURL(id: "f:1").path))
        XCTAssertEqual(inbox.partURL(id: "f:1").lastPathComponent, "f_1.part")
        inbox.close()
        var files: [JSONObject] = []
        inbox.drain(dek: dek) { p in
            files = p.files
            // The rooms store it into the file vault from the part while the drain runs.
            XCTAssertTrue(FileManager.default.fileExists(atPath: inbox.partURL(id: "f:1").path))
        }
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(Bytes.unb64(files[0].optString("key")), Data([1, 2, 3]))
        XCTAssertEqual(files[0].bool("p4"), true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: inbox.partURL(id: "f:1").path), "kept files go with the drain")
    }

    func testUnlockedDrainsOnABackgroundTaskThenRestores() async throws {
        let dir = TempDir()
        let inbox = LockInboxFiles(dir: dir.url.appendingPathComponent("lockbox"))
        let dek = SecretBytes(random: 32)
        let consumer = RecordingConsumer()
        await inbox.unlocked(dek: dek, consumer: consumer)
        XCTAssertEqual(consumer.restored, 1, "nothing pending: restored at once")
        XCTAssertTrue(inbox.begin(dek: dek))
        inbox.seal(TestItems.message(room: "r", id: "m1"))
        inbox.seal(LockedRooms.pin(slot: "carol", kid: "K"))
        await inbox.unlocked(dek: dek, consumer: consumer)
        XCTAssertFalse(inbox.isActive)
        XCTAssertFalse(inbox.isDraining)
        XCTAssertEqual(consumer.parsed.count, 1)
        XCTAssertEqual(consumer.parsed[0].rooms["r"], ["m1"])
        XCTAssertEqual(consumer.parsed[0].pins, ["carol"])
        XCTAssertEqual(consumer.restored, 2)
        XCTAssertFalse(dek.isWiped, "the drain used its own copy")
    }

    // MARK: Android's format, byte for byte

    /// A generation as Android's LockBox writes it (node:crypto, the algorithm of LockBox.java).
    private static let android = """
    {"dek":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=","kid":"YX45olIiRd8fakq3","spki":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHZNUzBvgDvGYeJoCLynIYEXZz258CQdYSmOYuuDOSwGdaw0lwXwGJgGG6Wya7MY7JiA3uVUezMWoJVh4s7l0gQ==","wrapped":"/onmXsdjwjE901a2A2o512wPUE3uJdpGpz5C2UGRXt+/gcongVbUgafOC1rj479UR4WAJILzYcd1X1CdNqrgJ2D0BZHrbQssGz4toUtpa38MKKaWizy3S4/FmyBD/yyAfwLnF70gIGNN2Hywb7LIO9Qh/CuxcAc3j8AaLlzeqGWEn1vyAyzdNdV83/dYKgOLIHNtOkFRqESKl6kBMI44GC99CyGffw==","items":[{"s":1,"e":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUeJ8AXYqB3y4ONNNG7dlYQLp+nr5eBtTVH0lkjaQT1f11KI7Lns5bPamgX6naQLa9y62pjF4dwHwBDDiU6y5tg==","iv":"vctoLlpHohOpcxMl","ct":"60kd087ileSUZlOXqGwXs69zfyJ6yuvDQV6uE3JF25VVn5byHT344FKMjJdj8yfZ9WmxrOEAQBBdwbxpOhx6pYKm5ZqbY9XjV5ACbE0yUgVJaw=="},{"s":2,"e":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKkl8D2PAzT23rnFxQ6ta1lGvK1e+cNl1yLL8hgl4Negbeoy089rEbgNJ8IDtWBY1D3IwwmwT2rTYVFozGZdL9A==","iv":"ILw68Tw6czcX5r40","ct":"QfiT+p+LFWnYa9TzjCPYpC3zVqyKIuVsJbkf03u6gZfDqBbSEQAC/b8B9TAwgKeo"}],"texts":["{\\"t\\":\\"msg\\",\\"room\\":\\"r1\\",\\"m\\":{\\"id\\":\\"a\\",\\"kind\\":\\"text\\",\\"text\\":\\"ahoj\\"}}","{\\"t\\":\\"pin\\",\\"slot\\":\\"s\\",\\"kid\\":\\"k\\"}"]}
    """

    func testAnAndroidGenerationOpensFromTheDisk() throws {
        let v = try XCTUnwrap(JSON.parseObject(Self.android))
        let dek = try XCTUnwrap(Bytes.unb64(v.optString("dek")))
        let kid = v.optString("kid")
        XCTAssertEqual(Ec.kid(v.optString("spki")), kid, "the kid is base64url(SHA-256(SPKI))[0..16]")
        // M5Crypto's LockBox reads Android's PKCS#8 key and items.
        let pair = try LockBox.unwrapKey(dek: Array(dek), kid: kid, Array(try XCTUnwrap(Bytes.unb64(v.optString("wrapped")))))
        XCTAssertEqual(pair.spki, v.optString("spki"), "node's PKCS#8 reads as the same key")
        let items = try XCTUnwrap(v.array("items")).compactMap(\.objectValue)
        let o = LockBox.openAll(pair, kid: kid, items.reversed())
        XCTAssertEqual(o.failed, 0)
        XCTAssertEqual(o.items.map { String(decoding: $0, as: UTF8.self) }, try XCTUnwrap(v.array("texts")).compactMap(\.stringValue))
        // The same generation as files (Android's names: <kid>.key, <kid>.log, one item per line) drains here.
        let dir = TempDir()
        let path = dir.url.appendingPathComponent("lockbox")
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
        try XCTUnwrap(Bytes.unb64(v.optString("wrapped"))).write(to: path.appendingPathComponent(kid + ".key"))
        try Data(items.map { LockBox.line($0) }.joined()).write(to: path.appendingPathComponent(kid + ".log"))
        let parsed = drained(LockInboxFiles(dir: path), SecretBytes(dek))
        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(ids(parsed[0].rooms["r1"]), ["a"])
        XCTAssertEqual(parsed[0].pins["s"], "k")
    }
}
