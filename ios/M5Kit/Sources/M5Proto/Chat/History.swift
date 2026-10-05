// What the chat keeps on this device, through the app's encrypted record store
// (android security/Vault user tier): each room's message log (History,
// record "hist-<hash>"), its peer id and resume secret (Resume, record
// "resume"). Nothing of it is readable before the PIN or biometrics open the
// user key — the app implements `RecordVault` with the Keychain / Secure
// Enclave; `MemoryRecordVault` is the tests' (and a locked app's stand-in).

import Foundation
import M5Core
import M5Crypto
import Synchronization

/// The vault's user tier: named JSON records, encrypted at rest by the app.
public protocol RecordVault: Sendable {
    /// The vault's data key is present (the app is unlocked).
    var unlocked: Bool { get }
    /// The record ({} when absent); nil while it cannot be read (locked, or damaged).
    func record(_ name: String) -> JSONObject?
    /// Like `record`, but nil also for a damaged record (the replay windows fail closed on it).
    func recordStrict(_ name: String) -> JSONObject?
    /// False while it cannot be written (locked).
    @discardableResult func put(_ name: String, _ value: JSONObject) -> Bool
    func delete(_ name: String)
}

public extension RecordVault {
    /// Default: `record` (a vault that cannot tell a damaged record from an absent one).
    func recordStrict(_ name: String) -> JSONObject? { record(name) }
}

/// An in-memory vault (tests; `locked` and `failing` simulate the app's states).
public final class MemoryRecordVault: RecordVault {
    private struct State { var rows = [String: String](); var locked = false; var failing = false }
    private let state = Mutex(State())
    public init() {}
    public var unlocked: Bool { state.withLock { !$0.locked } }
    public func setLocked(_ on: Bool) { state.withLock { $0.locked = on } }
    /// Reads fail (an I/O or decryption error): `recordStrict` answers nil, `record` an empty record.
    public func setFailing(_ on: Bool) { state.withLock { $0.failing = on } }
    public func record(_ name: String) -> JSONObject? {
        state.withLock { s in
            if s.locked { return nil }
            if s.failing { return JSONObject() }
            return s.rows[name].flatMap { JSON.parseObject($0) } ?? JSONObject()
        }
    }
    public func recordStrict(_ name: String) -> JSONObject? {
        if state.withLock({ $0.failing }) { return nil }
        return record(name)
    }
    @discardableResult public func put(_ name: String, _ value: JSONObject) -> Bool {
        state.withLock { s in
            if s.locked { return false }
            s.rows[name] = value.stringify()
            return true
        }
    }
    public func delete(_ name: String) { state.withLock { s in if !s.locked { s.rows[name] = nil } } }
    public var names: [String] { state.withLock { Array($0.rows.keys) } }
}

public enum History {
    /// The last messages kept per room.
    public static let keep = 300

    /// A room key's short hash (android Rooms.hashKey): hex(SHA-256(key))[0:16].
    public static func hashKey(_ key: String) -> String { String(Crypto.hex(Crypto.sha256(Crypto.utf8(key))).prefix(16)) }

    public static func recordName(_ roomKey: String) -> String { "hist-" + hashKey(roomKey) }

    public static func load(_ vault: any RecordVault, _ roomKey: String) -> [ChatMessage] {
        (vault.record(recordName(roomKey))?.array("m") ?? []).compactMap { $0.objectValue.map(ChatMessage.from) }
    }

    /// The record of a room's messages: the last `keep`, without system lines.
    public static func encode(_ messages: [ChatMessage]) -> JSONObject {
        let tail = messages.suffix(keep).filter { $0.kind != "sys" }
        return JSONObject([("m", .array(tail.map { .object($0.json) }))])
    }

    public static func save(_ vault: any RecordVault, _ roomKey: String, _ messages: [ChatMessage]) {
        guard vault.unlocked else { return }
        vault.put(recordName(roomKey), encode(messages))
    }

    /// 6.12 (F-16): a room's list saved when its history is in it (`historyReady`); otherwise merged into the
    /// stored history by id, never written over it.
    public static func saveSession(_ vault: any RecordVault, _ roomKey: String, live: [ChatMessage], historyReady: Bool) {
        guard vault.unlocked else { return }
        if historyReady { save(vault, roomKey, live); return }
        if live.isEmpty { return }
        var byId = OrderedMap<String, ChatMessage>()
        for m in load(vault, roomKey) { byId[m.id] = m }
        for m in live { byId[m.id] = m }
        save(vault, roomKey, byId.orderedValues)
    }

    /// 6.12 (F-16): the lock inbox's items for a room merged into its history.
    public static func merge(_ vault: any RecordVault, _ roomKey: String, items: [JSONObject], now: Int64, lostFiles: Set<String>) {
        guard vault.unlocked else { return }
        var merged = LockedRooms.merge(history: load(vault, roomKey), roomKey: roomKey, items: items, now: now)
        LockedRooms.markLostFiles(&merged, lostFiles)
        save(vault, roomKey, merged)
    }

    public static func delete(_ vault: any RecordVault, _ roomKey: String) { vault.delete(recordName(roomKey)) }
}

/// 6.7: each room's peer id and resume secret (the server's `joined`) — the app comes back as the same member
/// after the system ended it (android chat/Resume.java).
public enum Resume {
    static let record = "resume"
    static let max = 64

    /// (peerId, secret) of a room, or nil.
    public static func load(_ vault: any RecordVault, _ roomKey: String) -> (peerId: String, secret: String)? {
        guard vault.unlocked, let e = vault.record(record)?.object(roomKey), !e.optString("peerId").isEmpty, !e.optString("secret").isEmpty else { return nil }
        return (e.optString("peerId"), e.optString("secret"))
    }

    /// Saved; false when the vault is locked (the caller hands it to the lock inbox then).
    @discardableResult
    public static func save(_ vault: any RecordVault, _ roomKey: String, peerId: String, secret: String, now: Int64) -> Bool {
        if peerId.isEmpty || secret.isEmpty { return true }
        guard vault.unlocked else { return false }
        var all = vault.record(record) ?? JSONObject()
        if let old = all.object(roomKey), old.optString("peerId") == peerId, old.optString("secret") == secret { return true }
        all[roomKey] = nil
        all[roomKey] = .object(JSONObject([("peerId", .string(peerId)), ("secret", .string(secret)), ("at", .int(now))]))
        // Rooms long gone: the oldest go first.
        while all.count > max {
            var oldest: String?
            var at = Int64.max
            for (k, v) in all { let t = v.objectValue?.optInt64("at") ?? 0; if t < at { at = t; oldest = k } }
            guard let o = oldest else { break }
            all[o] = nil
        }
        return vault.put(record, all)
    }
}
