// The messages' files at rest (android security/FileVault + ui/media/VaultMedia
// as the chat uses them): Platform/Files' FileVault (Android's "M5F1" format,
// files/<id>.m5f) behind the parts' MessageFiles contract and the transfers'
// streaming needs. A received file is written while it is decrypted and
// checked; nothing of it is plaintext on the disk.

import Foundation
import M5Core
import M5Proto

/// What the engine needs of the file store besides the parts' MessageFiles.
protocol CoreFileStore: AnyObject, Sendable {
    func store(_ data: Data) throws -> String
    func store(contentsOf url: URL) throws -> (id: String, size: Int64)
    func read(_ id: String) throws -> Data
    func temporaryCopy(_ id: String, name: String) throws -> URL
    func discard(_ copy: URL)
    /// Writes a received file under `id` from the chunks `body` hands to its sink (decrypted, checked); aborted on a throw.
    func receive(id: String, _ body: (_ sink: @escaping (Bytes) throws -> Void) throws -> Void) throws
    /// A range of a stored file's plaintext (a transfer's chunk).
    func readRange(_ id: String, offset: Int64, count: Int) throws -> Bytes
    func delete(_ id: String)
    func has(_ id: String) -> Bool
    /// The plaintext's size (nil: no such file).
    func size(_ id: String) -> Int64?
}

/// The core's store as the parts' MessageFiles (main actor).
@MainActor
final class StoreMessageFiles: MessageFiles {
    let base: any CoreFileStore
    init(_ base: any CoreFileStore) { self.base = base }
    func store(_ data: Data) throws -> String { try base.store(data) }
    func store(contentsOf url: URL) throws -> (id: String, size: Int64) { try base.store(contentsOf: url) }
    func read(_ id: String) throws -> Data { try base.read(id) }
    func temporaryCopy(_ id: String, name: String) throws -> URL { try base.temporaryCopy(id, name: name) }
    func discard(_ copy: URL) { base.discard(copy) }

    // Off the main actor: the store is Sendable (FileVault reads with its own handle per call).
    func load(_ id: String) async throws -> Data {
        let b = base
        return try await Task.detached(priority: .userInitiated) { try b.read(id) }.value
    }

    func readRange(_ id: String, offset: Int64, count: Int) async throws -> Data {
        let b = base
        return try await Task.detached(priority: .userInitiated) { () throws -> Data in
            guard let size = b.size(id), offset < size, count > 0 else { return Data() }
            return Data(try b.readRange(id, offset: max(0, offset), count: Int(min(Int64(count), size - max(0, offset)))))
        }.value
    }

    func size(_ id: String) async -> Int64? {
        let b = base
        return await Task.detached(priority: .userInitiated) { b.size(id) }.value
    }
}

/// Platform/Files' FileVault as the core's store.
final class VaultFileStore: CoreFileStore, @unchecked Sendable {
    let vault: FileVault
    private let counter = NSLock()
    private var seq: Int64 = 0

    init(vault: FileVault) { self.vault = vault }

    /// "out-<n>" as Android names a file it sends.
    private func newId() -> String {
        counter.withLock { seq += 1; return "out-\(DispatchTime.now().uptimeNanoseconds)\(seq)" }
    }

    func store(_ data: Data) throws -> String {
        let id = newId()
        try vault.write(id, data)
        return id
    }

    func store(contentsOf url: URL) throws -> (id: String, size: Int64) {
        let id = newId()
        let w = try vault.writer(id)
        var total: Int64 = 0
        do {
            let h = try FileHandle(forReadingFrom: url)
            defer { try? h.close() }
            while let chunk = try h.read(upToCount: 64 * 1024), !chunk.isEmpty {
                try w.write(chunk)
                total += Int64(chunk.count)
            }
            try w.close()
        } catch {
            w.abort()
            throw error
        }
        return (id, total)
    }

    func read(_ id: String) throws -> Data { try vault.readAll(id) }
    func temporaryCopy(_ id: String, name: String) throws -> URL { try vault.decryptedCopy(id, name: name) }
    func discard(_ copy: URL) { FileVault.discard(copy) }

    func receive(id: String, _ body: (@escaping (Bytes) throws -> Void) throws -> Void) throws {
        let w = try vault.writer(id)
        do {
            try body { try w.write(Data($0)) }
            try w.close()
        } catch {
            w.abort()
            throw error
        }
    }

    func readRange(_ id: String, offset: Int64, count: Int) throws -> Bytes {
        let r = try vault.reader(id)
        defer { r.close() }
        return Array(try r.read(at: UInt64(offset), count: count))
    }

    func delete(_ id: String) { vault.delete(id) }
    func has(_ id: String) -> Bool { vault.has(id) }

    func size(_ id: String) -> Int64? {
        guard vault.has(id), let r = try? vault.reader(id) else { return nil }
        defer { r.close() }
        return Int64(r.size)
    }
}

/// Files in memory (tests).
final class MemoryFileStore: CoreFileStore, @unchecked Sendable {
    private let lock = NSLock()
    private var files: [String: Data] = [:]
    private var n = 0

    func store(_ data: Data) throws -> String { lock.withLock { n += 1; let id = "out-\(n)"; files[id] = data; return id } }
    func store(contentsOf url: URL) throws -> (id: String, size: Int64) { let d = try Data(contentsOf: url); return (try store(d), Int64(d.count)) }
    func read(_ id: String) throws -> Data {
        guard let d = lock.withLock({ files[id] }) else { throw CocoaError(.fileNoSuchFile) }
        return d
    }
    func temporaryCopy(_ id: String, name: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try read(id).write(to: url)
        return url
    }
    func discard(_ copy: URL) { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
    func receive(id: String, _ body: (@escaping (Bytes) throws -> Void) throws -> Void) throws {
        var out = Data()
        try body { out.append(contentsOf: $0) }
        lock.withLock { files[id] = out }
    }
    func readRange(_ id: String, offset: Int64, count: Int) throws -> Bytes {
        let d = try read(id)
        let start = Int(min(Int64(d.count), offset))
        return Array(d[start..<min(d.count, start + count)])
    }
    func delete(_ id: String) { lock.withLock { files[id] = nil } }
    func has(_ id: String) -> Bool { lock.withLock { files[id] != nil } }
    func size(_ id: String) -> Int64? { lock.withLock { files[id].map { Int64($0.count) } } }
}
