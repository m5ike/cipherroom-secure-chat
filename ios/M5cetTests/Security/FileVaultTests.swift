// Files at rest (Android FileVault): 64 KiB AES-GCM segments in Android's format,
// round trips at the segment edges, random access, and every kind of tampering —
// a changed byte, a dropped last segment, segments swapped, a file moved to
// another id — is refused. A writer keeps its own key: a lock meanwhile does not
// cut the file in half; nothing opens while locked.

import XCTest
@testable import M5cet

final class FileVaultTests: XCTestCase {
    /// The test's directories live as long as the test.
    private var dirs: [TempDir] = []

    private func make() throws -> (TempDir, Vault, FileVault) {
        let dir = TempDir()
        dirs.append(dir)
        let v = Vault(paths: .under(dir.url), keyring: TestKeys.software(MemorySecureStore()), iterations: 1000)
        try v.createUserKey(pin: "123456")
        return (dir, v, FileVault(vault: v))
    }

    private func data(_ n: Int) -> Data { Data((0..<n).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) }) }

    func testRoundTripsAtTheSegmentEdges() throws {
        let (_, _, fv) = try make()
        let seg = FileVault.segment
        for n in [0, 1, seg - 1, seg, seg + 1, 3 * seg + 17] {
            let id = "f:\(n)"
            try fv.write(id, data(n))
            XCTAssertEqual(try fv.readAll(id), data(n), "\(n) bytes")
            let file = try Data(contentsOf: fv.url(id))
            XCTAssertEqual(file.prefix(4), Data("M5F1".utf8))
            let segments = max(1, (n + seg - 1) / seg)
            XCTAssertEqual(file.count, 12 + n + 16 * (n == 0 ? 1 : segments), "\(n) bytes: header, data, a tag per segment")
            XCTAssertEqual(try fv.reader(id).size, UInt64(n))
        }
        XCTAssertEqual(try fv.url("room:file").lastPathComponent, "room_file.m5f")
        XCTAssertThrowsError(try fv.url("../x"))
    }

    func testRandomAccess() throws {
        let (_, _, fv) = try make()
        let d = data(200_000)
        try fv.write("media", d)
        let r = try fv.reader("media")
        XCTAssertEqual(try r.read(at: 65_530, count: 20), d[65_530..<65_550])
        XCTAssertEqual(try r.read(at: 199_990, count: 100), d[199_990..<200_000])
        XCTAssertEqual(try r.read(at: 300_000, count: 10), Data())
        r.close()
    }

    func testTamperingIsRefused() throws {
        let (_, _, fv) = try make()
        let seg = FileVault.segment
        try fv.write("a", data(2 * seg + 5))
        let url = try fv.url("a")
        let original = try Data(contentsOf: url)
        func refused(_ bytes: Data, _ why: String) throws {
            try bytes.write(to: url)
            XCTAssertThrowsError(try fv.readAll("a"), why)
        }
        var flipped = original
        flipped[20] ^= 1
        try refused(flipped, "a changed byte")
        try refused(original.prefix(12 + 2 * (seg + 16)), "the last segment dropped (the one before is not 'last')")
        let s0 = original[12..<(12 + seg + 16)], s1 = original[(12 + seg + 16)..<(12 + 2 * (seg + 16))]
        try refused(original.prefix(12) + s1 + s0 + original.suffix(from: 12 + 2 * (seg + 16)), "segments swapped")
        var magic = original
        magic[0] = UInt8(ascii: "X")
        try refused(magic, "not a vault file")
        // Moved to another id: its AAD names "a".
        try original.write(to: url)
        try FileManager.default.copyItem(at: url, to: fv.url("b"))
        XCTAssertThrowsError(try fv.readAll("b"))
        XCTAssertEqual(try fv.readAll("a"), data(2 * seg + 5))
    }

    func testAWriterSurvivesALockAndNothingOpensWhileLocked() throws {
        let (_, v, fv) = try make()
        let w = try fv.writer("big")
        try w.write(data(100_000))
        v.lock()
        try w.write(data(50_000))
        try w.close()
        XCTAssertThrowsError(try fv.readAll("big")) { XCTAssertEqual($0 as? SecurityError, .locked) }
        XCTAssertTrue(try v.unlockWithPin("123456"))
        XCTAssertEqual(try fv.readAll("big"), data(100_000) + data(50_000))
        // An aborted writer leaves nothing.
        let a = try fv.writer("gone")
        try a.write(data(10))
        a.abort()
        XCTAssertFalse(fv.has("gone"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: try fv.url("gone").appendingPathExtension("part").path))
    }

    func testADecryptedCopyForSharing() throws {
        let (_, _, fv) = try make()
        try fv.write("doc", Data("hello".utf8))
        let copy = try fv.decryptedCopy("doc", name: "a/b:c.txt")
        XCTAssertEqual(copy.lastPathComponent, "a_b_c.txt")
        XCTAssertEqual(try Data(contentsOf: copy), Data("hello".utf8))
        FileVault.discard(copy)
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
    }
}
