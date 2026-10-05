// The rooms while the app is locked — the platform half of Android's
// chat/LockedRooms (6.12 F-16). Default "receive while locked" (Settings ›
// Security › "Disconnect when locked" is the strict alternative).
//
// At the lock the vault's data key goes, but the open rooms stay connected with
// their own keys: messages keep arriving, notifications stay neutral. What would
// be written into the encrypted stores meanwhile goes into the lock inbox
// instead (LockBox: sealed to a key pair made at the lock — only its public key
// stays in memory, its private key is sealed by the data key before that is
// zeroed):
//
//   msg      a message of a room, as the history keeps it (new, or changed) — merged by id
//   state    a receipt / relay state of a message of mine from before the lock
//   pin      a key pinned on first sight of a name
//   resume   a room's peer id and resume secret
//   call     an ended call; callUri its row in the system's log
//   file     a received file, checked, kept encrypted under its transfer key
//            (moved into lockbox/files), the key in the item
//
// At the unlock the inbox closes, every generation on the disk is opened with the
// data key (older lock first), handed to the rooms (LockInboxConsumer) and deleted.
// A crash while locked keeps the inbox on the disk, unreadable without the PIN; the
// next unlock drains it (merging twice is harmless: by id). The chat's own rules
// (message validation, receipt ranks, file slots) are the rooms' — `merge` takes them.
//
// Files: lockbox/<kid>.key, lockbox/<kid>.log, lockbox/files/<id>.part — Android's names.
// Data Protection completeUnlessOpen: a log opened at the lock stays writable while the
// device is locked, and is unreadable again once closed until the device is unlocked.

import CryptoKit
import Foundation
import os

/// The rooms' side of a drain: everything of one generation into their stores (each step harmless when done twice).
protocol LockInboxConsumer: AnyObject, Sendable {
    func apply(_ parsed: LockInboxParsed, inbox: LockInbox)
    /// After the drain (or when nothing was pending): the rooms' lists get their histories.
    func restoreAll()
}

/// What a drain hands over, grouped as Android's LockedRooms.Parsed (insertion order kept).
struct LockInboxParsed {
    /// Per room, its msg / state items in their order.
    var rooms: [(room: String, items: [SecRecord])] = []
    /// slot → kid, the first one wins.
    var pins: [(slot: String, kid: String)] = []
    /// room → (peerId, secret), the last one wins (in the room's first place).
    var resumes: [(room: String, peerId: String, secret: String)] = []
    var calls: [SecRecord] = []
    /// id → uri, the last one wins.
    var callUris: [(id: String, uri: String)] = []
    var files: [SecRecord] = []
    var unknown = 0
}

final class LockInbox: @unchecked Sendable {
    let dir: URL
    private let mutex = NSLock()
    private var pub: P256.KeyAgreement.PublicKey?
    private var kid: String?
    private var seq: Int64 = 0
    private var log: FileHandle?
    private var draining = false
    private static let logger = Logger(subsystem: "cz.m5cet.app", category: "lock")

    init(dir: URL) { self.dir = dir }

    var filesDir: URL { dir.appendingPathComponent("files", isDirectory: true) }

    /// Locked in the receiving mode: what would be stored goes into the inbox.
    var isActive: Bool { mutex.withLock { pub != nil } }

    /// The unlock is merging the inbox (a new lock waits — the data key is needed until it is done).
    var isDraining: Bool { mutex.withLock { draining } }

    /// The open generation's id (tests, diagnostics).
    var currentKid: String? { mutex.withLock { kid } }

    // MARK: a lock

    /// At a lock, with the data key still there: a new generation — its private key sealed by the
    /// data key and on the disk before that key goes.
    @discardableResult
    func begin(dek: SecretBytes) -> Bool {
        let kp = LockBox.newKeyPair()
        let k = LockBox.kid(kp.publicKey)
        do {
            try ProtectedFiles.ensureDirectory(dir, protection: .completeUnlessOpen)
            let wrapped = try LockBox.wrapKey(dek: dek, kid: k, kp)
            try ProtectedFiles.writeDurable(wrapped, to: dir.appendingPathComponent(k + ".key"), protection: .completeUnlessOpen)
            let logURL = dir.appendingPathComponent(k + ".log")
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
            }
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            mutex.withLock {
                try? log?.close()
                pub = kp.publicKey
                kid = k
                seq = 0
                log = handle
            }
            return true
        } catch {
            Self.logger.error("the lock inbox could not start")
            return false
        }
    }

    /// At the unlock (and a wipe): nothing more is sealed.
    func close() {
        mutex.withLock {
            try? log?.close()
            log = nil
            pub = nil
            kid = nil
            seq = 0
        }
    }

    /// Seals one item into the open generation; false when none is open or it could not be written.
    @discardableResult
    func seal(_ item: SecRecord) -> Bool {
        mutex.withLock {
            guard let pub, let kid, let log else { return false }
            seq += 1
            do {
                let rec = try LockBox.seal(pub, kid: kid, seq: seq, SecJSON.data(item))
                try log.write(contentsOf: LockBox.line(rec))
                try log.synchronize()
                return true
            } catch {
                Self.logger.warning("an item could not go into the lock inbox")
                return false
            }
        }
    }

    // MARK: items (Android LockedRooms.message / state / pin / resume / call / callUri / keepFile)

    @discardableResult func message(room: String, _ m: SecRecord) -> Bool { seal(["t": "msg", "room": room, "m": m]) }

    @discardableResult func state(room: String, id: String, who: String?, name: String?, state: String) -> Bool {
        seal(["t": "state", "room": room, "id": id, "who": who ?? "", "name": name ?? "", "state": state])
    }

    @discardableResult func pin(slot: String, kid: String) -> Bool { seal(["t": "pin", "slot": slot, "kid": kid]) }

    @discardableResult func resume(room: String, peerId: String, secret: String) -> Bool {
        seal(["t": "resume", "room": room, "peerId": peerId, "secret": secret])
    }

    @discardableResult func call(_ entry: SecRecord) -> Bool { seal(["t": "call", "e": entry]) }

    @discardableResult func callUri(id: String, uri: String) -> Bool { seal(["t": "callUri", "id": id, "uri": uri]) }

    static func partName(_ id: String) -> String {
        String(id.map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "." || $0 == "-") ? $0 : "_" }) + ".part"
    }

    func partURL(id: String) -> URL { filesDir.appendingPathComponent(Self.partName(id)) }

    /// A received file while locked (already checked in full): its slots file moves into the inbox
    /// (still encrypted under the transfer key) and the item carries that key. False when the inbox
    /// is not open — the caller then stores it the usual way (the file untouched).
    func keepFile(room: String, id: String, key: Data, slots tmp: URL, chunkSize: Int, total: Int, size: Int64,
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
        let item: SecRecord = ["t": "file", "room": room, "id": id, "key": Bytes.b64(key), "chunkSize": chunkSize, "total": total,
                               "size": size, "lengths": lengths.prefix(total).map { $0 }, "root": root, "p4": p4]
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

    /// Opens and hands over every generation (older lock first), deleting each after it.
    @discardableResult
    func drain(dek: SecretBytes, apply: (LockInboxParsed) -> Void) -> (items: Int, failed: Int) {
        var items = 0, failed = 0
        var all = true
        for keyFile in keyFiles() {
            let k = String(keyFile.lastPathComponent.dropLast(4))
            let logFile = dir.appendingPathComponent(k + ".log")
            guard let wrapped = try? Data(contentsOf: keyFile) else {
                Self.logger.warning("the lock inbox could not be read now")
                all = false
                continue
            }
            let priv: P256.KeyAgreement.PrivateKey
            do { priv = try LockBox.unwrapKey(dek: dek, kid: k, wrapped) } catch {
                // Not sealed by this vault's key (damaged, another install's): nothing of it can be read, ever.
                Self.logger.warning("a lock inbox generation cannot be opened — removed")
                try? FileManager.default.removeItem(at: keyFile)
                try? FileManager.default.removeItem(at: logFile)
                continue
            }
            let recs: [SecRecord]
            do { recs = try LockBox.read(logFile) } catch {
                all = false
                continue
            }
            let opened = LockBox.openAll(priv, kid: k, recs)
            items += opened.items.count
            failed += opened.failed
            apply(Self.parse(opened.items))
            try? FileManager.default.removeItem(at: logFile)
            try? FileManager.default.removeItem(at: keyFile)
        }
        // Kept files no item named any more: gone once every generation is.
        if all { ProtectedFiles.deleteTree(filesDir) }
        Self.logger.info("the lock inbox merged: \(items) items, \(failed) unreadable")
        return (items, failed)
    }

    /// The items of one generation, grouped (pure).
    static func parse(_ opened: [Data]) -> LockInboxParsed {
        var p = LockInboxParsed()
        var roomIndex: [String: Int] = [:], resumeIndex: [String: Int] = [:], uriIndex: [String: Int] = [:]
        var pinned = Set<String>()
        for b in opened {
            guard let o = SecJSON.parse(b) else { p.unknown += 1; continue }
            switch o.jString("t") {
            case "msg", "state":
                let room = o.jString("room")
                guard !room.isEmpty else { p.unknown += 1; continue }
                if let i = roomIndex[room] { p.rooms[i].items.append(o) } else {
                    roomIndex[room] = p.rooms.count
                    p.rooms.append((room, [o]))
                }
            case "pin":
                let slot = o.jString("slot"), kid = o.jString("kid")
                if !slot.isEmpty, !kid.isEmpty, !pinned.contains(slot) {
                    pinned.insert(slot)
                    p.pins.append((slot, kid))
                }
            case "resume":
                let r = (o.jString("room"), o.jString("peerId"), o.jString("secret"))
                if let i = resumeIndex[r.0] { p.resumes[i] = r } else {
                    resumeIndex[r.0] = p.resumes.count
                    p.resumes.append(r)
                }
            case "call":
                if let e = o.jObject("e") { p.calls.append(e) }
            case "callUri":
                let u = (o.jString("id"), o.jString("uri"))
                if let i = uriIndex[u.0] { p.callUris[i] = u } else {
                    uriIndex[u.0] = p.callUris.count
                    p.callUris.append(u)
                }
            case "file": p.files.append(o)
            default: p.unknown += 1
            }
        }
        return p
    }

    /// A room's history with the inbox's items for it, in their order (Android LockedRooms.merge): a
    /// message by its id — a new one appended, a known one replaced in its place by its newer state;
    /// a state item raises a message of mine. The chat's rules come as closures: `message` validates
    /// an item's message (nil: not kept), `raise` applies a state item to the message it names.
    static func merge<M>(history: [M], items: [SecRecord], id: (M) -> String?, message: (SecRecord) -> M?,
                         raise: (inout M, SecRecord) -> Void) -> [M] {
        var order: [String] = []
        var byId: [String: M] = [:]
        for m in history {
            guard let i = id(m), !i.isEmpty, byId[i] == nil else { continue }
            order.append(i)
            byId[i] = m
        }
        for it in items {
            switch it.jString("t") {
            case "msg":
                guard let o = it.jObject("m"), let m = message(o), let i = id(m), !i.isEmpty else { continue }
                if byId[i] == nil { order.append(i) }
                byId[i] = m // a known id keeps its place
            case "state":
                let i = it.jString("id")
                guard var m = byId[i] else { continue }
                raise(&m, it)
                byId[i] = m
            default: continue
            }
        }
        return order.compactMap { byId[$0] }
    }
}
