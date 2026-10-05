// Files at rest (Android security/FileVault, 6.1): what the chat receives or sends
// as a file is kept in the app's container, encrypted with the USER tier's key —
// unreadable until the PIN or biometrics open the app. Data Protection complete,
// excluded from backups.
//
// Format (Android's, byte for byte): "M5F1" | nonce (8) | segments; each segment is
// AES-256-GCM over up to 64 KiB with IV = nonce ‖ index (u32 BE) and
// AAD = "m5file|<id>|<index>|<last 1/0>" — segments cannot be reordered, dropped at
// the end or moved between files. A writer and a reader keep their own copy of the
// data key (zeroed when they finish): a lock meanwhile does not cut a file in half.

import CryptoKit
import Foundation

final class FileVault: @unchecked Sendable {
    static let segment = 64 * 1024
    static let magic = Data("M5F1".utf8)

    let vault: Vault
    let dir: URL

    init(vault: Vault, dir: URL? = nil) {
        self.vault = vault
        self.dir = dir ?? vault.paths.files
    }

    static func validId(_ id: String) -> Bool {
        (1...120).contains(id.count) && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "_.:-".contains($0)) }
    }

    func url(_ id: String) throws -> URL {
        guard Self.validId(id) else { throw SecurityError.damaged("bad file id") }
        return dir.appendingPathComponent(id.replacingOccurrences(of: ":", with: "_") + ".m5f")
    }

    func has(_ id: String) -> Bool { (try? url(id)).map { FileManager.default.fileExists(atPath: $0.path) } ?? false }

    func delete(_ id: String) { if let u = try? url(id) { try? FileManager.default.removeItem(at: u) } }

    static func aad(_ id: String, _ index: UInt32, last: Bool) -> Data { Bytes.utf8("m5file|\(id)|\(index)|\(last ? 1 : 0)") }

    static func iv(_ nonce: Data, _ index: UInt32) -> Data { nonce + Bytes.u32be(index) }

    /// A writer of a new file (plaintext in, segment by segment; close() seals the last one).
    func writer(_ id: String) throws -> Writer { try Writer(vault: self, id: id) }

    /// Random access to a stored file's plaintext.
    func reader(_ id: String) throws -> Reader { try Reader(vault: self, id: id) }

    func readAll(_ id: String) throws -> Data {
        let r = try reader(id)
        defer { r.close() }
        return try r.read(at: 0, count: Int(r.size))
    }

    func write(_ id: String, _ data: Data) throws {
        let w = try writer(id)
        do {
            try w.write(data)
            try w.close()
        } catch {
            w.abort()
            throw error
        }
    }

    // MARK: sharing (Android VaultMedia's FilesProvider)

    /// A decrypted copy for the share sheet / an export (Data Protection complete, in tmp);
    /// delete it with `discard` as soon as the system took it.
    func decryptedCopy(_ id: String, name: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("m5-share/\(UUID().uuidString)", isDirectory: true)
        try ProtectedFiles.ensureDirectory(folder, protection: .complete)
        let safe = String(name.map { $0 == "/" || $0 == ":" ? "_" : $0 }.prefix(120))
        let out = folder.appendingPathComponent(safe.isEmpty ? "file" : safe)
        var plain = try readAll(id)
        defer { Bytes.wipe(&plain) }
        guard FileManager.default.createFile(atPath: out.path, contents: plain, attributes: [.protectionKey: FileProtectionType.complete]) else {
            throw SecurityError.io("cannot write the copy")
        }
        return out
    }

    /// Removes a decrypted copy (its folder).
    static func discard(_ copy: URL) { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }

    // MARK: writer

    final class Writer {
        private let key: SecretBytes
        private let nonce: Data
        private let id: String
        private let tmp: URL, target: URL
        private let handle: FileHandle
        private var buffer = Data()
        private var index: UInt32 = 0
        private var finished = false

        fileprivate init(vault fv: FileVault, id: String) throws {
            self.id = id
            target = try fv.url(id)
            tmp = target.appendingPathExtension("part")
            // Its own copy of the data key, zeroed at the end (a lock meanwhile zeroes the vault's, not this one).
            key = try fv.vault.userKey().copy()
            nonce = Bytes.random(8)
            try ProtectedFiles.ensureDirectory(fv.dir, protection: .complete)
            guard FileManager.default.createFile(atPath: tmp.path, contents: FileVault.magic + nonce,
                                                 attributes: [.protectionKey: FileProtectionType.complete]) else {
                key.wipe()
                throw SecurityError.io("cannot create the file")
            }
            handle = try FileHandle(forWritingTo: tmp)
            try handle.seekToEnd()
        }

        deinit { if !finished { abort() } }

        func write(_ data: Data) throws {
            var rest = data[...]
            while !rest.isEmpty {
                if buffer.count == FileVault.segment { try flush(last: false) }
                let n = min(rest.count, FileVault.segment - buffer.count)
                buffer.append(rest.prefix(n))
                rest = rest.dropFirst(n)
            }
        }

        private func flush(last: Bool) throws {
            let sealed = try SecCrypto.gcmSeal(key, iv: FileVault.iv(nonce, index), buffer, aad: FileVault.aad(id, index, last: last))
            try handle.write(contentsOf: sealed)
            Bytes.wipe(&buffer)
            index += 1
        }

        func close() throws {
            defer {
                finished = true
                key.wipe()
            }
            try flush(last: true)
            try handle.synchronize()
            try handle.close()
            try? FileManager.default.removeItem(at: target)
            do { try FileManager.default.moveItem(at: tmp, to: target) } catch { throw SecurityError.io("cannot store the file") }
        }

        func abort() {
            finished = true
            try? handle.close()
            Bytes.wipe(&buffer)
            key.wipe()
            try? FileManager.default.removeItem(at: tmp)
        }
    }

    // MARK: reader

    final class Reader {
        private let key: SecretBytes
        private let handle: FileHandle
        private let nonce: Data
        private let id: String
        private let length: UInt64
        private let segments: UInt64
        /// The plaintext's size.
        let size: UInt64
        private var cachedIndex: UInt64 = .max
        private var cached = Data()

        fileprivate init(vault fv: FileVault, id: String) throws {
            self.id = id
            key = try fv.vault.userKey().copy() // its own copy (a send under way survives a lock), zeroed at close
            do { handle = try FileHandle(forReadingFrom: fv.url(id)) } catch {
                key.wipe()
                throw SecurityError.io("no such file")
            }
            length = (try? handle.seekToEnd()) ?? 0
            try handle.seek(toOffset: 0)
            let head = try handle.read(upToCount: 12) ?? Data()
            guard head.count == 12, head.prefix(4) == FileVault.magic else {
                try? handle.close()
                key.wipe()
                throw SecurityError.damaged("not a vault file")
            }
            nonce = Bytes.fresh(head.suffix(8))
            let body = length - 12
            let seg = UInt64(FileVault.segment + 16)
            segments = max(1, (body + seg - 1) / seg)
            let lastLen = Int64(body) - Int64((segments - 1) * seg) - 16
            size = (segments - 1) * UInt64(FileVault.segment) + UInt64(max(0, lastLen))
        }

        deinit { close() }

        private func segment(_ index: UInt64) throws -> Data {
            if index == cachedIndex { return cached }
            let seg = UInt64(FileVault.segment + 16)
            let pos = 12 + index * seg
            let len = Int(min(seg, length - pos))
            try handle.seek(toOffset: pos)
            let ct = try handle.read(upToCount: len) ?? Data()
            guard ct.count == len else { throw SecurityError.damaged("the file is damaged") }
            Bytes.wipe(&cached)
            do {
                cached = try SecCrypto.gcmOpen(key, iv: FileVault.iv(nonce, UInt32(index)), ct,
                                               aad: FileVault.aad(id, UInt32(index), last: index == segments - 1))
            } catch {
                throw SecurityError.damaged("the file is damaged")
            }
            cachedIndex = index
            return cached
        }

        /// Up to `count` bytes at `position` (fewer at the end; empty past it).
        func read(at position: UInt64, count: Int) throws -> Data {
            var out = Data()
            var p = position
            while out.count < count && p < size {
                let s = try segment(p / UInt64(FileVault.segment))
                let at = Int(p % UInt64(FileVault.segment))
                let n = min(count - out.count, s.count - at)
                if n <= 0 { break }
                out.append(s[s.startIndex + at ..< s.startIndex + at + n])
                p += UInt64(n)
            }
            return out
        }

        func close() {
            key.wipe()
            Bytes.wipe(&cached)
            try? handle.close()
        }
    }
}
