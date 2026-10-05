// Files over a room (both lanes), files at rest, saved rooms and their Clone
// (android RoomsCloneTest), a sealed message's iteration bound (SealedBoundTest)
// and Argon2 one at a time (Argon2SerialTest).

import Foundation
import M5Core
import M5Crypto
@testable import M5Proto
import Testing

@Suite struct FileTransferTests {
    static let id = "xfer-1f0c8a2e-1111-4222-8333-944455556666"

    func content(_ n: Int) -> Bytes { (0..<n).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) } }

    /// Sends `data` in `lane` and receives it: the frames a peer would see, then the file it stores.
    func roundTrip(_ data: Bytes, lane: FileTransfer.Lane, identity: ChatIdentity?, fk: Bytes?, roomKeys: RoomKeys?,
                   tamper: ((inout [(Int, Bytes, Bytes)]) -> Void)? = nil) throws -> (Bytes, FileTransfer.Incoming) {
        let id = Self.id
        let meta = FileTransfer.meta(id: id, name: "photo.jpg", mime: "image/jpeg", size: Int64(data.count), senderId: "p-a", senderName: "Alice", createdAt: 1_800_000_000_000)
        let metaFrame = try FileTransfer.bodyFrame(kind: "file-meta", id: id, body: meta, lane: lane, transport: "p2p", identity: identity)
        let total = FileTransfer.total(size: Int64(data.count))
        var chunks = [(Int, Bytes, Bytes)]()
        var hasher = FileTransfer.RootHasher()
        for seq in 0..<total {
            let plain = Array(data[min(data.count, seq * FileTransfer.chunk)..<min(data.count, (seq + 1) * FileTransfer.chunk)])
            hasher.add(plain)
            let s = try FileTransfer.sealChunk(id: id, seq: seq, total: total, plain: plain, lane: lane)
            chunks.append((seq, s.iv, s.ciphertext))
        }
        tamper?(&chunks)
        let endFrame = try FileTransfer.bodyFrame(kind: "file-end", id: id, body: FileTransfer.endBody(root: hasher.root(), total: total, size: Int64(data.count)),
                                                  lane: lane, transport: "p2p", identity: identity)
        let incoming = try FileTransfer.openMeta(id: id, frame: metaFrame, transport: "p2p", fk: fk, p4Signer: "spk", roomKeys: roomKeys, slots: MemoryChunkSlots())
        // Chunks over the binary frame, as a peer with "bin" sends them (in reverse: order does not matter).
        for (seq, iv, ct) in chunks.reversed() {
            let parsed = try #require(FileTransfer.parseBinary(FileTransfer.binaryFrame(id: id, seq: seq, iv: iv, ciphertext: ct)))
            incoming.accept(seq: parsed.seq, iv: parsed.iv, ciphertext: parsed.ciphertext)
        }
        var out = Bytes()
        try incoming.finish(endFrame: endFrame, sink: { out += $0 })
        return (out, incoming)
    }

    @Test func protocol4LaneRoundTrip() throws {
        let fk = Bytes(repeating: 9, count: 32)
        let data = content(FileTransfer.chunk * 2 + 1000)
        let (out, incoming) = try roundTrip(data, lane: try .p4(fk: fk, transferId: Self.id), identity: nil, fk: fk, roomKeys: nil)
        #expect(out == data)
        #expect(incoming.p4 && incoming.signer == "spk" && incoming.total == 3 && incoming.complete)
        let m = FileTransfer.message(incoming, roomKey: "room", fallbackSenderId: "p-x", fallbackName: "X", now: 1_800_000_000_000)
        #expect(m.fileName == "photo.jpg" && m.fileImage && m.fileSize == Int64(data.count) && m.senderName == "Alice")
    }

    @Test func protocol3LaneIsSignedByItsSender() throws {
        let keys = try RoomKeys.derive(room: "files-room", passphrase: "pass", memoryKiB: 64, passes: 1)
        let me = ChatIdentity.generate()
        let data = content(5000)
        let (out, incoming) = try roundTrip(data, lane: .p3(keys, transferId: Self.id), identity: me, fk: nil, roomKeys: keys)
        #expect(out == data)
        #expect(!incoming.p4 && incoming.signer == me.publicKey)
        // A protocol-4 meta needs its file key: the room key does not open it.
        let fk = Bytes(repeating: 1, count: 32)
        let frame = try FileTransfer.bodyFrame(kind: "file-meta", id: Self.id, body: FileTransfer.meta(id: Self.id, name: "a", mime: "text/plain", size: 1, senderId: "p", senderName: "P", createdAt: 0),
                                               lane: try .p4(fk: fk, transferId: Self.id), transport: "p2p", identity: nil)
        #expect(throws: (any Error).self) { try FileTransfer.openMeta(id: Self.id, frame: frame, transport: "p2p", fk: nil, p4Signer: nil, roomKeys: keys, slots: MemoryChunkSlots()) }
    }

    @Test func anEmptyFileIsOneChunk() throws {
        let fk = Bytes(repeating: 3, count: 32)
        let (out, incoming) = try roundTrip([], lane: try .p4(fk: fk, transferId: Self.id), identity: nil, fk: fk, roomKeys: nil)
        #expect(out.isEmpty && incoming.total == 1)
    }

    @Test func aSwappedOrAlteredChunkIsRefused() throws {
        let fk = Bytes(repeating: 4, count: 32)
        let data = content(FileTransfer.chunk * 2)
        #expect(throws: (any Error).self) {
            _ = try roundTrip(data, lane: try .p4(fk: fk, transferId: Self.id), identity: nil, fk: fk, roomKeys: nil) { c in
                let a = c[0]; c[0] = (0, c[1].1, c[1].2); c[1] = (1, a.1, a.2)
            }
        }
        #expect(throws: (any Error).self) {
            _ = try roundTrip(data, lane: try .p4(fk: fk, transferId: Self.id), identity: nil, fk: fk, roomKeys: nil) { c in c[1].2[0] ^= 1 }
        }
    }

    @Test func missingChunksAreAskedFor() throws {
        let fk = Bytes(repeating: 5, count: 32)
        let lane = try FileTransfer.Lane.p4(fk: fk, transferId: Self.id)
        let size = Int64(FileTransfer.chunk * 3)
        let frame = try FileTransfer.bodyFrame(kind: "file-meta", id: Self.id, body: FileTransfer.meta(id: Self.id, name: "a.bin", mime: "application/octet-stream", size: size, senderId: "p", senderName: "P", createdAt: 0),
                                               lane: lane, transport: "proxy", identity: nil)
        let incoming = try FileTransfer.openMeta(id: Self.id, frame: frame, transport: "proxy", fk: fk, p4Signer: nil, roomKeys: nil, slots: MemoryChunkSlots())
        let s = try FileTransfer.sealChunk(id: Self.id, seq: 1, total: 3, plain: content(FileTransfer.chunk), lane: lane)
        #expect(incoming.accept(seq: 1, iv: s.iv, ciphertext: s.ciphertext))
        #expect(!incoming.accept(seq: 1, iv: s.iv, ciphertext: s.ciphertext)) // twice
        #expect(!incoming.accept(seq: 3, iv: s.iv, ciphertext: s.ciphertext)) // beyond the count
        #expect(!incoming.accept(seq: 0, iv: Array(s.iv.prefix(8)), ciphertext: s.ciphertext))
        #expect(incoming.missing() == [0, 2])
        let need = incoming.needFrame()
        #expect(need.string("type") == "proxy-need" && need.string("kind") == "file-need")
        #expect(need.array("seqs")?.compactMap { $0.int64Value } == [0, 2])
        #expect(abs(incoming.progress - 1.0 / 3.0) < 1e-9)
    }

    @Test func aMetaThatLiesAboutItsSizeIsRefused() throws {
        let fk = Bytes(repeating: 6, count: 32)
        let lane = try FileTransfer.Lane.p4(fk: fk, transferId: Self.id)
        var meta = FileTransfer.meta(id: Self.id, name: "a", mime: "text/plain", size: 100, senderId: "p", senderName: "P", createdAt: 0)
        meta["totalChunks"] = 5
        let frame = try FileTransfer.bodyFrame(kind: "file-meta", id: Self.id, body: meta, lane: lane, transport: "p2p", identity: nil)
        #expect(throws: (any Error).self) { try FileTransfer.openMeta(id: Self.id, frame: frame, transport: "p2p", fk: fk, p4Signer: nil, roomKeys: nil, slots: MemoryChunkSlots()) }
        let other = try FileTransfer.bodyFrame(kind: "file-meta", id: Self.id, body: FileTransfer.meta(id: "xfer-other", name: "a", mime: "text/plain", size: 1, senderId: "p", senderName: "P", createdAt: 0),
                                               lane: lane, transport: "p2p", identity: nil)
        #expect(throws: (any Error).self) { try FileTransfer.openMeta(id: Self.id, frame: other, transport: "p2p", fk: fk, p4Signer: nil, roomKeys: nil, slots: MemoryChunkSlots()) }
        var v1 = frame
        v1["v"] = 1
        #expect(throws: (any Error).self) { try FileTransfer.openMeta(id: Self.id, frame: v1, transport: "p2p", fk: fk, p4Signer: nil, roomKeys: nil, slots: MemoryChunkSlots()) }
    }

    @Test func framesAndIds() {
        #expect(FileTransfer.isId(Self.id))
        #expect(!FileTransfer.isId("../etc"))
        #expect(FileTransfer.total(size: 0) == 1 && FileTransfer.total(size: Int64(FileTransfer.chunk)) == 1 && FileTransfer.total(size: Int64(FileTransfer.chunk) + 1) == 2)
        let f = FileTransfer.chunkFrame(id: Self.id, seq: 2, iv: Bytes(repeating: 0, count: 12), ciphertext: Bytes(repeating: 1, count: 16), transport: "proxy", p4: true, proxy: true)
        #expect(f.string("type") == "proxy-chunk" && f.int("v") == 4 && f.int("seq") == 2)
        #expect(FileTransfer.parseBinary([0x4D, 0x01]) == nil)
    }
}

@Suite struct FileVaultFormatTests {
    let key = Bytes(repeating: 0x42, count: 32)

    func stored(_ data: Bytes, id: String, pieces: Int = 3) throws -> Bytes {
        var w = FileVaultFormat.Writer(key: key, id: id)
        var out = Bytes()
        let step = max(1, data.count / pieces)
        var at = 0
        while at < data.count { let n = min(step, data.count - at); out += try w.write(Array(data[at..<at + n])); at += n }
        return out + (try w.finish())
    }

    func reader(_ file: Bytes, id: String) throws -> FileVaultFormat.Reader {
        try FileVaultFormat.Reader(key: key, id: id, length: Int64(file.count)) { pos, n in
            Array(file[Int(pos)..<min(file.count, Int(pos) + n)])
        }
    }

    @Test(arguments: [0, 1, 65_536, 65_537, 200_000])
    func roundTripWithRandomAccess(size: Int) throws {
        let data = (0..<size).map { UInt8(truncatingIfNeeded: $0 &* 13) }
        let file = try stored(data, id: "m:1")
        #expect(Array(file.prefix(4)) == Array("M5F1".utf8))
        let r = try reader(file, id: "m:1")
        #expect(r.size == Int64(size))
        #expect(try r.readAll() == data)
        if size > 70_000 {
            #expect(try r.read(at: 65_530, count: 20) == Array(data[65_530..<65_550]))
            #expect(try r.read(at: Int64(size - 5), count: 100) == Array(data[(size - 5)...]))
        }
        #expect(try r.read(at: Int64(size), count: 10).isEmpty)
    }

    @Test func anotherFilesSegmentsOrATruncatedFileAreRefused() throws {
        let data = (0..<150_000).map { UInt8(truncatingIfNeeded: $0) }
        let file = try stored(data, id: "m:1")
        #expect(throws: (any Error).self) { try reader(file, id: "m:2").readAll() }
        // The last segment dropped: the one before it was not written as the last.
        let truncated = Array(file.prefix(12 + 2 * (FileVaultFormat.segment + 16)))
        #expect(throws: (any Error).self) { try reader(truncated, id: "m:1").readAll() }
        var flipped = file
        flipped[20] ^= 1
        #expect(throws: (any Error).self) { try reader(flipped, id: "m:1").readAll() }
        #expect(throws: (any Error).self) { try reader(Array("XXXX12345678".utf8), id: "m:1") }
    }

    @Test func ids() {
        #expect(FileVaultFormat.isId("msg-1:attachment.v2"))
        #expect(!FileVaultFormat.isId("a/b") && !FileVaultFormat.isId("") && !FileVaultFormat.isId(String(repeating: "a", count: 121)))
        #expect(FileVaultFormat.fileName("m:1") == "m_1.m5f")
    }
}

@Suite struct SavedRoomsTests {
    func keys(_ names: String...) -> Set<String> { Set(names.map(RoomKeys.normalizeRoom)) }

    @Test func theNextNumberNoRoomHas() {
        #expect(SavedRooms.cloneName("Tým", keys("Tým")) == "Tým 2")
        #expect(SavedRooms.cloneName("Tým", keys("Tým", "Tým 2")) == "Tým 3")
        #expect(SavedRooms.cloneName("Tým 2", keys("Tým", "Tým 2")) == "Tým 3")
        #expect(SavedRooms.cloneName("Sprint 12", keys("Sprint 12")) == "Sprint 13")
        #expect(SavedRooms.cloneName("Sprint 12", keys("Sprint 12", "sprint-13")) == "Sprint 14")
    }

    @Test func theCopyIsAnotherRoom() {
        let taken = keys("Rodina", "Rodina 2", "Rodina 3")
        #expect(!taken.contains(RoomKeys.normalizeRoom(SavedRooms.cloneName("Rodina", taken))))
        let longName = "A very long room name that goes on and on and on and on"
        let t2 = keys(longName)
        let copy = SavedRooms.cloneName(longName, t2)
        #expect(copy.hasSuffix(" 2"))
        #expect(!t2.contains(RoomKeys.normalizeRoom(copy)))
        #expect(RoomKeys.normalizeRoom(copy).count <= 48)
    }

    @Test func anEmptyNameStillGetsOne() {
        #expect(SavedRooms.cloneName("", []) == "room 2")
        #expect(SavedRooms.cloneName(nil, []) == "room 2")
    }

    @Test func storedAndLoaded() {
        let vault = MemoryRecordVault()
        let a = SavedRooms.make(roomName: "  Tým Alfa ", passphrase: "secret", userName: "Me", now: 5)
        #expect(a.key == "t-m-alfa" && a.label == "Tým Alfa" && a.selected)
        let b = SavedRooms.copy(a, keys: [a.key], now: 6)
        #expect(b.label == "Tým Alfa 2" && !b.selected && b.passphrase == "secret")
        #expect(SavedRooms.save(vault, rooms: [a, b], active: b.key))
        let loaded = SavedRooms.load(vault)
        #expect(loaded.rooms == [a, b] && loaded.active == b.key)
        #expect(a.card.string("room") == a.room && a.card.int("v") == 1 && a.card.string("name") == "Me")
        vault.setLocked(true)
        #expect(!SavedRooms.save(vault, rooms: [], active: ""))
        #expect(SavedRooms.load(vault).rooms.isEmpty)
    }
}

@Suite struct BoundsTests {
    @Test func aHugeIterationCountFromTheSenderIsRefusedAtOnce() throws {
        let sealed = try Sealed.seal("zpráva", code: "WXYZ-2345-6789")
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta, code: "WXYZ-2345-6789") == "zpráva")
        let t0 = Date()
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta.with("it", 2_000_000_000), code: "WXYZ-2345-6789") == nil)
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta.with("it", 0), code: "WXYZ-2345-6789") == nil)
        #expect(Sealed.open(sealed.ciphertext, meta: sealed.meta.with("it", -5), code: "WXYZ-2345-6789") == nil)
        #expect(Date().timeIntervalSince(t0) < 1)
    }

    @Test func argon2DerivationsTogetherGiveOneResult() async throws {
        let results = try await withThrowingTaskGroup(of: Bytes.self) { group in
            for _ in 0..<6 {
                group.addTask {
                    try Argon2.argon2id(password: Array("passphrase".utf8), salt: Array("m5cet:room:v3:room".utf8), passes: 2, memoryKiB: 1024)
                }
            }
            var out = [Bytes]()
            for try await r in group { out.append(r) }
            return out
        }
        #expect(results.count == 6 && Set(results.map { Crypto.hex($0) }).count == 1)
    }
}
