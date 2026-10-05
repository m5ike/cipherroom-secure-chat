// Files at rest (Android security/FileVault, 6.1): what the chat receives or sends
// as a file is kept in the app's container, encrypted with the USER tier's key —
// unreadable until the PIN or biometrics open the app. Data Protection complete,
// excluded from backups.
//
// The format and its crypto are M5Proto's `FileVaultFormat` (Android's, byte for
// byte: "M5F1" | nonce (8) | 64 KiB AES-256-GCM segments, IV = nonce ‖ index (u32 BE),
// AAD "m5file|<id>|<index>|<last>"); this is the storage: where the files are, how
// they are written (a temporary part, renamed when complete) and read (random
// access over a file handle). A writer and a reader take their own copy of the
// data key: a lock meanwhile does not cut a file in half.

import CryptoKit
import Foundation
import M5Core
import M5Crypto
import M5Proto

final class FileVault: @unchecked Sendable {
    static var segment: Int { FileVaultFormat.segment }

    let vault: Vault
    let dir: URL

    init(vault: Vault, dir: URL? = nil) {
        self.vault = vault
        self.dir = dir ?? vault.paths.files
    }

    func url(_ id: String) throws -> URL {
        guard FileVaultFormat.isId(id) else { throw SecurityError.damaged("bad file id") }
        return dir.appendingPathComponent(FileVaultFormat.fileName(id))
    }

    func has(_ id: String) -> Bool { (try? url(id)).map { FileManager.default.fileExists(atPath: $0.path) } ?? false }

    func delete(_ id: String) { if let u = try? url(id) { try? FileManager.default.removeItem(at: u) } }

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
        defer { SecData.wipe(&plain) }
        guard FileManager.default.createFile(atPath: out.path, contents: plain, attributes: [.protectionKey: FileProtectionType.complete]) else {
            throw SecurityError.io("cannot write the copy")
        }
        return out
    }

    /// Removes a decrypted copy (its folder).
    static func discard(_ copy: URL) { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }

    // MARK: writer

    final class Writer {
        private var format: FileVaultFormat.Writer
        private var key: Bytes
        private let tmp: URL, target: URL
        private let handle: FileHandle
        private var finished = false

        fileprivate init(vault fv: FileVault, id: String) throws {
            target = try fv.url(id)
            tmp = target.appendingPathExtension("part")
            // Its own copy of the data key, zeroed at the end (a lock meanwhile zeroes the vault's, not this one).
            key = try fv.vault.userKey().bytes()
            format = FileVaultFormat.Writer(key: key, id: id)
            try ProtectedFiles.ensureDirectory(fv.dir, protection: .complete)
            guard FileManager.default.createFile(atPath: tmp.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]) else {
                ByteOps.wipe(&key)
                throw SecurityError.io("cannot create the file")
            }
            handle = try FileHandle(forWritingTo: tmp)
        }

        deinit { if !finished { abort() } }

        func write(_ data: Data) throws {
            let out = try format.write(Array(data))
            if !out.isEmpty { try handle.write(contentsOf: Data(out)) }
        }

        func close() throws {
            defer {
                finished = true
                ByteOps.wipe(&key)
            }
            try handle.write(contentsOf: Data(try format.finish()))
            try handle.synchronize()
            try handle.close()
            try? FileManager.default.removeItem(at: target)
            do { try FileManager.default.moveItem(at: tmp, to: target) } catch { throw SecurityError.io("cannot store the file") }
        }

        func abort() {
            finished = true
            try? handle.close()
            ByteOps.wipe(&key)
            try? FileManager.default.removeItem(at: tmp)
        }
    }

    // MARK: reader

    final class Reader {
        private var key: Bytes
        private let handle: FileHandle
        private let format: FileVaultFormat.Reader
        /// The plaintext's size.
        let size: UInt64

        fileprivate init(vault fv: FileVault, id: String) throws {
            key = try fv.vault.userKey().bytes() // its own copy (a send under way survives a lock), zeroed at close
            let h: FileHandle
            do { h = try FileHandle(forReadingFrom: fv.url(id)) } catch {
                ByteOps.wipe(&key)
                throw SecurityError.io("no such file")
            }
            handle = h
            let length = Int64((try? h.seekToEnd()) ?? 0)
            do {
                format = try FileVaultFormat.Reader(key: key, id: id, length: length) { offset, count in
                    try h.seek(toOffset: UInt64(offset))
                    return Array(try h.read(upToCount: count) ?? Data())
                }
            } catch {
                try? h.close()
                ByteOps.wipe(&key)
                throw SecurityError.damaged("not a vault file")
            }
            size = UInt64(max(0, format.size))
        }

        deinit { close() }

        /// Up to `count` bytes at `position` (fewer at the end; empty past it).
        func read(at position: UInt64, count: Int) throws -> Data {
            do { return Data(try format.read(at: Int64(position), count: count)) } catch { throw SecurityError.damaged("the file is damaged") }
        }

        func close() {
            ByteOps.wipe(&key)
            try? handle.close()
        }
    }
}
