// The lock inbox on the disk — the file half of Android's chat/LockedRooms
// (6.12 F-16). Default "receive while locked" (Settings › Security ›
// "Disconnect when locked" is the strict alternative).
//
// The format, the generation's sealing and the merge are M5Kit's: M5Crypto's
// `LockBox` (ECIES records, the wrapped generation key — Android's format byte for
// byte), M5Proto's `LockInbox` (the open generation: begin / seal / close / drain)
// and `LockedRooms` (the items msg / state / pin / resume / call / callUri / file,
// `parse`, `merge`, `partName`). This is where they live and how they get there:
//
//   lockbox/<kid>.key   the generation's private key sealed by the data key — written
//                       durably at the lock, before the data key is zeroed
//   lockbox/<kid>.log   one sealed item per line, appended and synced
//   lockbox/files/<id>.part   a received file kept for the unlock (still under its transfer key)
//
// At the unlock every generation on the disk (older lock first, also one a crash
// left) is opened with the data key, handed to the rooms (LockInboxConsumer — they
// merge with `LockedRooms.merge`) and deleted. Data Protection completeUnlessOpen: a
// log opened at the lock stays writable while the device is locked, and is
// unreadable again once closed until the device is unlocked.

import CryptoKit
import Foundation
import M5Core
import M5Crypto
import M5Proto
import os

/// The rooms' side of a drain: everything of one generation into their stores (each step harmless when done twice).
protocol LockInboxConsumer: AnyObject, Sendable {
    func apply(_ parsed: LockedRooms.Parsed, inbox: LockInboxFiles)
    /// After the drain (or when nothing was pending): the rooms' lists get their histories.
    func restoreAll()
}

final class LockInboxFiles: @unchecked Sendable {
    let dir: URL
    /// The open generation (M5Proto): its public key and sequence; nothing of the private key.
    private let generation = LockInbox()
    private let mutex = NSLock()
    private var kid: String?
    private var log: FileHandle?
    private var draining = false
    private static let logger = Logger(subsystem: "cz.m5cet.app", category: "lock")

    init(dir: URL) { self.dir = dir }

    var filesDir: URL { dir.appendingPathComponent("files", isDirectory: true) }

    /// Locked in the receiving mode: what would be stored goes into the inbox.
    var isActive: Bool { generation.active }

    /// The unlock is merging the inbox (a new lock waits — the data key is needed until it is done).
    var isDraining: Bool { mutex.withLock { draining } }

    /// The open generation's id (tests, diagnostics).
    var currentKid: String? { mutex.withLock { kid } }

    // MARK: a lock

    /// At a lock, with the data key still there: a new generation — its private key sealed by the
    /// data key and on the disk before that key goes.
    @discardableResult
    func begin(dek: SecretBytes) -> Bool {
        do {
            var dataKey = try dek.bytes()
            defer { ByteOps.wipe(&dataKey) }
            let (k, wrapped) = try generation.begin(dataKey: dataKey)
            try ProtectedFiles.ensureDirectory(dir, protection: .completeUnlessOpen)
            try ProtectedFiles.writeDurable(Data(wrapped), to: dir.appendingPathComponent(k + ".key"), protection: .completeUnlessOpen)
            let logURL = dir.appendingPathComponent(k + ".log")
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
            }
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            mutex.withLock {
                try? log?.close()
                kid = k
                log = handle
            }
            return true
        } catch {
            generation.close()
            Self.logger.error("the lock inbox could not start")
            return false
        }
    }

    /// At the unlock (and a wipe): nothing more is sealed.
    func close() {
        generation.close()
        mutex.withLock {
            try? log?.close()
            log = nil
            kid = nil
        }
    }

    /// Seals one item (`LockedRooms.message(…)`, `.state`, `.pin`, `.resume`, `.call`, `.callUri`) into the open
    /// generation's log; false when none is open or it could not be written.
    @discardableResult
    func seal(_ item: JSONObject) -> Bool {
        mutex.withLock {
            guard let log, let kid, let (k, line) = generation.seal(item), k == kid else { return false }
            do {
                try log.write(contentsOf: Data(line))
                try log.synchronize()
                return true
            } catch {
                Self.logger.warning("an item could not go into the lock inbox")
                return false
            }
        }
    }

    func partURL(id: String) -> URL { filesDir.appendingPathComponent(LockedRooms.partName(id)) }

    /// A received file while locked (already checked in full): its slots file moves into the inbox
    /// (still encrypted under the transfer key) and the item (`LockedRooms.file`) carries that key. False
    /// when the inbox is not open — the caller then stores it the usual way (the file untouched).
    func keepFile(room: String, id: String, key: Bytes, slots tmp: URL, chunkSize: Int, total: Int, size: Int64,
                  lengths: [Int], root: String, p4: Bool) -> Bool {
        guard isActive else { return false }
        let dest = partURL(id: id)
        do {
            ProtectedFiles.fullSync(path: tmp.path)
            try ProtectedFiles.ensureDirectory(filesDir, protection: .completeUnlessOpen)
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            ProtectedFiles.fullSync(path: filesDir.path)
        } catch {
            Self.logger.warning("a file could not be kept for the unlock")
            return false
        }
        let item = LockedRooms.file(roomKey: room, id: id, key: key, chunkSize: chunkSize, total: total, size: size,
                                    lengths: Array(lengths.prefix(total)), root: root, p4: p4)
        if seal(item) { return true }
        try? FileManager.default.moveItem(at: dest, to: tmp)
        return false
    }

    // MARK: the unlock

    /// Generations on the disk (from this lock, or one a crash left behind).
    var hasPending: Bool { !keyFiles().isEmpty }

    private func keyFiles() -> [URL] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return urls.filter { $0.pathExtension == "key" }.sorted { a, b in
            let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return da == db ? a.lastPathComponent < b.lastPathComponent : da < db
        }
    }

    /// At the unlock (the data key back): stops sealing and — when a generation is on the disk —
    /// merges it on a background task first; `consumer.restoreAll()` after it (or at once).
    func unlocked(dek: SecretBytes, consumer: LockInboxConsumer?) async {
        await finishUnlock(key: beginUnlock(dek: dek), consumer: consumer)
    }

    /// The unlock's first step, at once on the caller's thread (a lock right after it must not have its new
    /// generation closed by a later step): stops sealing; when a generation is pending, marks the drain
    /// (`isDraining` — a lock waits for it) and returns the drain's own copy of the data key.
    func beginUnlock(dek: SecretBytes) -> SecretBytes? {
        close()
        guard hasPending, let key = try? dek.copy() else { return nil }
        mutex.withLock { draining = true }
        return key
    }

    /// The unlock's second step: the drain on a background task (with `key` from beginUnlock), then restoreAll.
    func finishUnlock(key: SecretBytes?, consumer: LockInboxConsumer?) async {
        guard let key else {
            consumer?.restoreAll()
            return
        }
        await Task.detached(priority: .userInitiated) { [self] in
            _ = drain(dek: key) { parsed in consumer?.apply(parsed, inbox: self) }
            key.wipe()
        }.value
        mutex.withLock { draining = false }
        consumer?.restoreAll()
    }

    /// How many items a generation held (what `parse` grouped).
    static func count(_ p: LockedRooms.Parsed) -> Int {
        p.rooms.orderedValues.reduce(0) { $0 + $1.count } + p.pins.count + p.resumes.count + p.calls.count + p.callUris.count + p.files.count + p.unknown
    }

    /// Opens and hands over every generation (older lock first), deleting each after it.
    @discardableResult
    func drain(dek: SecretBytes, apply: (LockedRooms.Parsed) -> Void) -> (items: Int, failed: Int) {
        var items = 0, failed = 0
        var all = true
        guard var dataKey = try? dek.bytes() else { return (0, 0) }
        defer { ByteOps.wipe(&dataKey) }
        for keyFile in keyFiles() {
            let k = String(keyFile.lastPathComponent.dropLast(4))
            let logFile = dir.appendingPathComponent(k + ".log")
            guard let wrapped = try? Data(contentsOf: keyFile) else {
                Self.logger.warning("the lock inbox could not be read now")
                all = false
                continue
            }
            let log: Data
            if FileManager.default.fileExists(atPath: logFile.path) {
                guard let l = try? Data(contentsOf: logFile) else {
                    all = false
                    continue
                }
                log = l
            } else {
                log = Data()
            }
            let opened: (parsed: LockedRooms.Parsed, failed: Int)
            do {
                opened = try LockInbox.drain(dataKey: dataKey, kid: k, wrappedKey: Array(wrapped), log: Array(log))
            } catch {
                // Not sealed by this vault's key (damaged, another install's): nothing of it can be read, ever.
                Self.logger.warning("a lock inbox generation cannot be opened — removed")
                try? FileManager.default.removeItem(at: keyFile)
                try? FileManager.default.removeItem(at: logFile)
                continue
            }
            items += Self.count(opened.parsed)
            failed += opened.failed
            apply(opened.parsed)
            try? FileManager.default.removeItem(at: logFile)
            try? FileManager.default.removeItem(at: keyFile)
        }
        // Kept files no item named any more: gone once every generation is.
        if all { ProtectedFiles.deleteTree(filesDir) }
        Self.logger.info("the lock inbox merged: \(items) items, \(failed) unreadable")
        return (items, failed)
    }
}
