// File transfer v2 (6.1) and its protocol-4 lane (§ 8), byte-compatible with
// client/src/lib/file-transfer.ts (android chat/Files.java) — the frames, the
// checks and the state of a transfer, without the transport and the disk:
//
//   meta → chunks → end, to every open channel (the server relays — "proxy" —
//   when none is open). Protocol 3: the file key is HKDF(files key, salt =
//   transferId, "file"), meta and end are signed bodies. Protocol 4: a random
//   FK per transfer handed to each peer over the ratchet (or sealed per device
//   for a proxied file), HKDF(salt = transferId, FK, "m5cet/p4/file"), the
//   AADs of § 8, meta and end padded. Chunks are raw (32 KiB), binary frames
//   to peers that announced "bin", JSON to the others; the end carries
//   SHA-256 over the chunks' SHA-256s; missing chunks are asked for again
//   (file-need, three rounds). The receiver keeps the still encrypted chunks
//   (`ChunkSlots`) and decrypts and checks them only at the end.

import CryptoKit
import Foundation
import M5Core
import M5Crypto

/// Where a receiver keeps the encrypted chunks of a transfer until its end (a temporary file in the app).
public protocol ChunkSlots: AnyObject {
    func write(seq: Int, iv: Bytes, ciphertext: Bytes) throws
    func read(seq: Int, length: Int) throws -> (iv: Bytes, ciphertext: Bytes)
}

/// Chunks in memory (tests, small files).
public final class MemoryChunkSlots: ChunkSlots {
    private var slots = [Int: (Bytes, Bytes)]()
    public init() {}
    public func write(seq: Int, iv: Bytes, ciphertext: Bytes) throws { slots[seq] = (iv, ciphertext) }
    public func read(seq: Int, length: Int) throws -> (iv: Bytes, ciphertext: Bytes) {
        guard let s = slots[seq], s.1.count == length else { throw CryptoError("missing chunk") }
        return (s.0, s.1)
    }
}

public enum FileTransfer {
    public static let chunk = 32_768
    public static let maxBytes: Int64 = 2 * 1024 * 1024 * 1024
    public static let maxChunks = 2_000_000, maxResendRounds = 3

    /// A transfer id: [A-Za-z0-9_:.-]{1,96}.
    public static func isId(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return (1...96).contains(u.count) && u.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 58 || $0 == 46 || $0 == 45 }
    }

    /// The chunk count of a file: at least one.
    public static func total(size: Int64, chunkSize: Int = chunk) -> Int { max(1, Int(clamping: (size + Int64(chunkSize) - 1) / Int64(chunkSize))) }

    /* ------------------------------------------------------------ frames */

    /// A binary chunk: 'M' | 0x01 (p2p) / 0x11 (proxy) | version | L | id | seq u32 | iv 12 | ct+tag.
    public static func binaryFrame(id: String, seq: Int, iv: Bytes, ciphertext: Bytes, type: UInt8 = 0x01, version: Int = 2) -> Bytes {
        let idb = Array(id.utf8)
        return [0x4D, type, UInt8(version), UInt8(idb.count)] + idb + ByteOps.be32(UInt32(seq)) + iv + ciphertext
    }

    public struct BinaryChunk: Sendable, Equatable {
        public let id: String
        public let seq: Int
        public let iv: Bytes
        public let ciphertext: Bytes
        public let proxy: Bool
        public let version: Int
    }

    /// A binary chunk frame, or nil when it is not one.
    public static func parseBinary(_ b: Bytes) -> BinaryChunk? {
        guard b.count >= 37, b[0] == 0x4D, b[1] == 0x01 || b[1] == 0x11 else { return nil }
        let l = Int(b[3])
        guard l >= 1, l <= 96, b.count >= 20 + l + 16, let id = UTF8Text.decode(Array(b[4..<4 + l])), isId(id) else { return nil }
        let seq = b[(4 + l)..<(8 + l)].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        return BinaryChunk(id: id, seq: seq > UInt32(Int32.max) ? -1 : Int(seq), iv: Array(b[(8 + l)..<(20 + l)]), ciphertext: Array(b[(20 + l)...]),
                           proxy: b[1] == 0x11, version: Int(b[2]))
    }

    /// The AAD of a chunk in its lane.
    public static func chunkAad(id: String, seq: Int, total: Int, p4: Bool) throws -> Bytes {
        p4 ? try Files4.chunkAad(id, Int64(seq), Int64(total)) : Envelopes.fileChunkContext(id, seq, total)
    }

    /* ------------------------------------------------------------- lanes */

    /// One way a transfer goes: protocol 4 (from the FK) or protocol 3 (from the room key).
    public struct Lane: Sendable {
        public let p4: Bool
        public let key: Bytes
        public init(p4: Bool, key: Bytes) { self.p4 = p4; self.key = key }

        public static func p4(fk: Bytes, transferId: String) throws -> Lane { Lane(p4: true, key: try Files4.fileKey(fk, transferId)) }
        public static func p3(_ keys: RoomKeys, transferId: String) -> Lane { Lane(p4: false, key: keys.fileKey(transferId)) }
    }

    /// The meta of a file as the web writes it.
    public static func meta(id: String, name: String, mime: String, size: Int64, senderId: String, senderName: String, createdAt: Int64) -> JSONObject {
        JSONObject([("transferId", .string(id)), ("name", .string(Payloads.prefixUTF16(name, 200))), ("mime", .string(mime)), ("size", .int(size)),
                    ("totalChunks", .int(total(size: size))), ("chunkSize", .int(chunk)), ("senderId", .string(senderId)),
                    ("senderName", .string(senderName)), ("createdAt", .int(createdAt))])
    }

    /// A body frame (file-meta / file-end) sealed in its lane. `transport`: p2p | proxy.
    public static func bodyFrame(kind: String, id: String, body: JSONObject, lane: Lane, transport: String, identity: ChatIdentity?, rng: any Rng = SystemRng()) throws -> JSONObject {
        let sealed: JSONObject
        if lane.p4 {
            let aad = kind == "file-meta" ? try Files4.metaAad(id) : try Files4.endAad(id)
            sealed = try Files4.sealBody(lane.key, aad, body.stringify(), rng)
        } else {
            let ctx = kind == "file-meta" ? Envelopes.fileMetaContext(id) : Envelopes.fileEndContext(id)
            sealed = try Envelopes.sealFileBody(lane.key, ctx, body, identity)
        }
        return JSONObject([("kind", .string(kind)), ("transferId", .string(id)), ("transport", .string(transport)), ("v", .int(lane.p4 ? 4 : 2)),
                           ("iv", sealed["iv"]!), ("ciphertext", sealed["ciphertext"]!)])
    }

    /// One chunk sealed in its lane (a fresh IV).
    public static func sealChunk(id: String, seq: Int, total: Int, plain: Bytes, lane: Lane) throws -> (iv: Bytes, ciphertext: Bytes) {
        let iv = Crypto.random(12)
        return (iv, try Crypto.gcmSeal(lane.key, iv, plain, try chunkAad(id: id, seq: seq, total: total, p4: lane.p4)))
    }

    /// A chunk as a JSON frame (peers without "bin", the proxy).
    public static func chunkFrame(id: String, seq: Int, iv: Bytes, ciphertext: Bytes, transport: String, p4: Bool, proxy: Bool) -> JSONObject {
        var f = JSONObject()
        if proxy { f["type"] = "proxy-chunk" }
        f["kind"] = "file-chunk"
        f["transferId"] = .string(id)
        f["seq"] = .int(seq)
        f["transport"] = .string(transport)
        f["v"] = .int(p4 ? 4 : 2)
        f["iv"] = .string(Crypto.b64(iv))
        f["ciphertext"] = .string(Crypto.b64(ciphertext))
        return f
    }

    /// The end of a file: SHA-256 over the chunks' SHA-256s, the count and the size.
    public struct RootHasher: Sendable {
        private var h = SHA256()
        public init() {}
        public mutating func add(_ plainChunk: Bytes) { h.update(data: Array(SHA256.hash(data: plainChunk))) }
        public func root() -> String { Crypto.b64(Array(h.finalize())) }
    }

    public static func endBody(root: String, total: Int, size: Int64) -> JSONObject {
        JSONObject([("root", .string(root)), ("totalChunks", .int(total)), ("size", .int(size))])
    }

    /* ----------------------------------------------------------- receive */

    /// A transfer being received: its meta checked, its chunks kept (still encrypted) in `slots`.
    public final class Incoming {
        public let id: String
        public let transport: String
        /// 6.12: a protocol-4 transfer (per-transfer key, protocol-4 AADs, padded bodies).
        public let p4: Bool
        public let key: Bytes
        public let meta: JSONObject
        /// The device key that signed (p3) or sealed / sent (p4) it; nil for an unsigned one.
        public let signer: String?
        public let total: Int, chunkSize: Int
        public let size: Int64
        public let slots: ChunkSlots
        public private(set) var lengths: [Int]
        private var got: [Bool]
        public private(set) var received = 0
        public var rounds = 0

        init(id: String, transport: String, p4: Bool, key: Bytes, meta: JSONObject, signer: String?, total: Int, chunkSize: Int, size: Int64, slots: ChunkSlots) {
            self.id = id; self.transport = transport; self.p4 = p4; self.key = key; self.meta = meta; self.signer = signer
            self.total = total; self.chunkSize = chunkSize; self.size = size; self.slots = slots
            lengths = Array(repeating: 0, count: total)
            got = Array(repeating: false, count: total)
        }

        public var progress: Double { Double(received) / Double(total) }
        public var complete: Bool { received == total }

        /// A chunk (true when it was new and kept).
        @discardableResult
        public func accept(seq: Int, iv: Bytes, ciphertext: Bytes) -> Bool {
            guard seq >= 0, seq < total, !got[seq], iv.count == 12, ciphertext.count >= 16, ciphertext.count <= chunkSize + 16 else { return false }
            do { try slots.write(seq: seq, iv: iv, ciphertext: ciphertext) } catch { return false }
            lengths[seq] = ciphertext.count
            got[seq] = true
            received += 1
            return true
        }

        /// The chunks still missing (at most `limit`).
        public func missing(limit: Int = 5000) -> [Int] {
            var out = [Int]()
            for i in 0..<total where !got[i] { out.append(i); if out.count >= limit { break } }
            return out
        }

        /// The file-need frame for the missing chunks (proxied: with type "proxy-need").
        public func needFrame() -> JSONObject {
            var f = JSONObject([("kind", "file-need"), ("transferId", .string(id)), ("seqs", .array(missing().map { .int($0) })), ("transport", .string(transport))])
            if transport == "proxy" { f["type"] = "proxy-need" }
            return f
        }

        /// The end frame's root (its body opened and checked like `finish` does) — what the lock inbox keeps with a file
        /// received while the app is locked (LockedRooms.file), so the unlock can check it again.
        public func endRoot(_ f: JSONObject) throws -> String {
            let end: JSONObject
            if p4 {
                end = try Envelopes.parse(try Files4.openBody(key, try Files4.endAad(id), iv: f.optString("iv"), ciphertext: f.optString("ciphertext")))
            } else {
                let body = try Envelopes.openFileBodyFull(key, Envelopes.fileEndContext(id), iv: f.optString("iv"), ciphertext: f.optString("ciphertext"))
                if let s = signer, body.signer == nil || body.signer?.valid != true || body.signer?.publicKey != s { throw CryptoError("the end is not signed by the sender") }
                end = try Envelopes.parse(body.body)
            }
            if end.optInt64("totalChunks") != Int64(total) || end.optInt64("size") != size { throw CryptoError("size") }
            return end.optString("root")
        }

        /// The end frame: its body checked (protocol 3: signed by the meta's signer), the chunks decrypted in order and
        /// checked against its root — into `sink` (nil: only checked). Returns the plaintext size.
        @discardableResult
        public func finish(endFrame f: JSONObject, sink: ((Bytes) throws -> Void)?) throws -> Int64 {
            let end: JSONObject
            if p4 {
                end = try Envelopes.parse(try Files4.openBody(key, try Files4.endAad(id), iv: f.optString("iv"), ciphertext: f.optString("ciphertext")))
            } else {
                let body = try Envelopes.openFileBodyFull(key, Envelopes.fileEndContext(id), iv: f.optString("iv"), ciphertext: f.optString("ciphertext"))
                if let s = signer, body.signer == nil || body.signer?.valid != true || body.signer?.publicKey != s { throw CryptoError("the end is not signed by the sender") }
                end = try Envelopes.parse(body.body)
            }
            if end.optInt64("totalChunks") != Int64(total) || end.optInt64("size") != size { throw CryptoError("size") }
            return try FileTransfer.decryptSlots(slots, key: key, id: id, total: total, chunkSize: chunkSize, lengths: lengths, size: size,
                                                 root: end.optString("root"), p4: p4, sink: sink)
        }
    }

    /// A meta frame opened and checked: protocol 4 (`fk` given — never the room key) or protocol 3 (`roomKeys`).
    /// `p4Signer`: the device the session (or the proxied FK's seal) authenticated.
    public static func openMeta(id: String, frame f: JSONObject, transport: String, fk: Bytes?, p4Signer: String?, roomKeys: RoomKeys?,
                                slots: ChunkSlots) throws -> Incoming {
        let v = f.optInt("v", 1)
        guard v == 2 || v == 4 else { throw CryptoError("file frame version \(v) is not received") }
        let p4 = v == 4
        let key: Bytes
        if p4 {
            guard let fk else { throw CryptoError("a protocol-4 file without its key") }
            key = try Files4.fileKey(fk, id)
        } else {
            guard let roomKeys else { throw CryptoError("no room key") }
            key = roomKeys.fileKey(id)
        }
        let m: JSONObject
        let signer: String?
        if p4 {
            m = try Envelopes.parse(try Files4.openBody(key, try Files4.metaAad(id), iv: f.optString("iv"), ciphertext: f.optString("ciphertext")))
            signer = p4Signer
        } else {
            let body = try Envelopes.openFileBodyFull(key, Envelopes.fileMetaContext(id), iv: f.optString("iv"), ciphertext: f.optString("ciphertext"))
            if let s = body.signer, !s.valid { throw CryptoError("bad signature") }
            m = try Envelopes.parse(body.body)
            signer = body.signer?.publicKey
        }
        if m.optString("transferId") != id { throw CryptoError("transfer id") }
        let size = m.optInt64("size", -1)
        let chunkSize = Int(clamping: m.optInt64("chunkSize", 0))
        let total = Int(clamping: m.optInt64("totalChunks", 0))
        if size < 0 || size > maxBytes || chunkSize < 1 || chunkSize > 1_048_576 { throw CryptoError("size") }
        if total != FileTransfer.total(size: size, chunkSize: chunkSize) || total > maxChunks { throw CryptoError("chunks") }
        return Incoming(id: id, transport: transport, p4: p4, key: key, meta: m, signer: signer, total: total, chunkSize: chunkSize, size: size, slots: slots)
    }

    /// The message a received file shows as (its bubble), from its meta.
    public static func message(_ incoming: Incoming, roomKey: String, fallbackSenderId: String, fallbackName: String, now: Int64) -> ChatMessage {
        var m = ChatMessage()
        m.id = incoming.id
        m.roomKey = roomKey
        m.senderId = incoming.meta.string("senderId") ?? fallbackSenderId
        m.senderName = Payloads.clean(incoming.meta["senderName"], Payloads.nameMax, fallbackName) ?? fallbackName
        m.createdAt = min(incoming.meta.int64("createdAt") ?? now, now + Payloads.futureSkew)
        m.fileName = Payloads.safeFileName(incoming.meta["name"])
        m.fileMime = Payloads.safeMime(incoming.meta.optString("mime"))
        m.fileImage = Payloads.inlineImage(m.fileMime)
        m.fileSize = incoming.size
        m.fileProgress = 0
        return m
    }

    /// The chunks (iv 12 ‖ ct per slot) decrypted in order and checked against the end's root; into `sink`, or only
    /// checked. Also the unlock's way to store a file kept in the lock inbox.
    @discardableResult
    public static func decryptSlots(_ slots: ChunkSlots, key: Bytes, id: String, total: Int, chunkSize: Int, lengths: [Int], size: Int64, root: String,
                                    p4: Bool, sink: ((Bytes) throws -> Void)?) throws -> Int64 {
        var hasher = RootHasher()
        var bytes: Int64 = 0
        for seq in 0..<total {
            if lengths[seq] < 16 || lengths[seq] > chunkSize + 16 { throw CryptoError("chunk size") }
            let s = try slots.read(seq: seq, length: lengths[seq])
            let plain = try Crypto.gcmOpen(key, s.iv, s.ciphertext, try chunkAad(id: id, seq: seq, total: total, p4: p4))
            if plain.count > chunkSize { throw CryptoError("chunk too large") }
            hasher.add(plain)
            try sink?(plain)
            bytes += Int64(plain.count)
        }
        if bytes != size { throw CryptoError("size") }
        if hasher.root() != root { throw CryptoError("the file does not match its hash") }
        return bytes
    }
}

/// Files at rest (6.1; android security/FileVault.java): what the chat receives or sends as a file is kept
/// encrypted with the vault's user key.
///
///   "M5F1" | nonce (8) | segments; each segment AES-256-GCM over up to 64 KiB, IV = nonce ‖ index (u32 BE),
///   AAD = "m5file|<id>|<index>|<last>" — segments cannot be reordered, dropped at the end or moved between files.
public enum FileVaultFormat {
    public static let segment = 64 * 1024
    static let magic: Bytes = Array("M5F1".utf8)

    /// A vault file id: [A-Za-z0-9_.:-]{1,120}.
    public static func isId(_ id: String) -> Bool {
        let u = Array(id.utf8)
        return (1...120).contains(u.count) && u.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 46 || $0 == 58 || $0 == 45 }
    }

    /// The file name a vault file is stored under.
    public static func fileName(_ id: String) -> String { id.replacingOccurrences(of: ":", with: "_") + ".m5f" }

    static func aad(_ id: String, _ index: Int64, _ last: Bool) -> Bytes { Crypto.utf8("m5file|\(id)|\(index)|\(last ? 1 : 0)") }
    static func iv(_ nonce: Bytes, _ index: Int64) -> Bytes { nonce + ByteOps.be32(UInt32(truncatingIfNeeded: index)) }

    /// Writes plaintext segment by segment: `write` returns the bytes to append, `finish` the last ones.
    public struct Writer {
        private let key: Bytes, nonce: Bytes, id: String
        private var buf = Bytes()
        private var index: Int64 = 0
        private var started = false

        public init(key: Bytes, id: String, nonce: Bytes = Crypto.random(8)) { self.key = key; self.id = id; self.nonce = nonce }

        public mutating func write(_ data: Bytes) throws -> Bytes {
            var out = started ? Bytes() : FileVaultFormat.magic + nonce
            started = true
            var at = 0
            while at < data.count {
                if buf.count == FileVaultFormat.segment { out += try seal(last: false) }
                let n = min(data.count - at, FileVaultFormat.segment - buf.count)
                buf += data[at..<at + n]
                at += n
            }
            return out
        }

        private mutating func seal(last: Bool) throws -> Bytes {
            let ct = try Crypto.gcmSeal(key, FileVaultFormat.iv(nonce, index), buf, FileVaultFormat.aad(id, index, last))
            index += 1
            buf.removeAll(keepingCapacity: true)
            return ct
        }

        public mutating func finish() throws -> Bytes {
            var out = started ? Bytes() : FileVaultFormat.magic + nonce
            started = true
            out += try seal(last: true)
            return out
        }
    }

    /// Random access to a stored file's plaintext: `read(offset, count)` reads the stored bytes.
    public final class Reader {
        private let key: Bytes, nonce: Bytes, id: String
        private let length: Int64
        private let read: (Int64, Int) throws -> Bytes
        private let segments: Int64
        public let size: Int64
        private var cachedIndex: Int64 = -1
        private var cached = Bytes()

        public init(key: Bytes, id: String, length: Int64, read: @escaping (Int64, Int) throws -> Bytes) throws {
            self.key = key; self.id = id; self.length = length; self.read = read
            let head = try read(0, 12)
            guard head.count == 12, Array(head[0..<4]) == FileVaultFormat.magic else { throw CryptoError("not a vault file") }
            nonce = Array(head[4..<12])
            let body = length - 12
            let seg = Int64(FileVaultFormat.segment + 16)
            segments = max(1, (body + seg - 1) / seg)
            let lastLen = body - (segments - 1) * seg - 16
            size = (segments - 1) * Int64(FileVaultFormat.segment) + max(0, lastLen)
        }

        private func segment(_ index: Int64) throws -> Bytes {
            if index == cachedIndex { return cached }
            let last = index == segments - 1
            let pos = 12 + index * Int64(FileVaultFormat.segment + 16)
            let len = Int(min(Int64(FileVaultFormat.segment + 16), length - pos))
            let ct = try read(pos, len)
            do { cached = try Crypto.gcmOpen(key, FileVaultFormat.iv(nonce, index), ct, FileVaultFormat.aad(id, index, last)) }
            catch { throw CryptoError("the file is damaged") }
            cachedIndex = index
            return cached
        }

        /// Up to `count` bytes at `position` (empty at the end).
        public func read(at position: Int64, count: Int) throws -> Bytes {
            var out = Bytes()
            while out.count < count && position + Int64(out.count) < size {
                let p = position + Int64(out.count)
                let seg = try segment(p / Int64(FileVaultFormat.segment))
                let at = Int(p % Int64(FileVaultFormat.segment))
                let n = min(count - out.count, seg.count - at)
                if n <= 0 { break }
                out += seg[at..<at + n]
            }
            return out
        }

        /// The whole plaintext.
        public func readAll() throws -> Bytes { try read(at: 0, count: Int(clamping: size)) }
    }
}
