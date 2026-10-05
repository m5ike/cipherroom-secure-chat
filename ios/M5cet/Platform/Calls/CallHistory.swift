// 6.8: the app's own history of calls — what the History screen lists besides
// the rooms' messages (CallLogItems). One record per call (CallTrack),
// encrypted in the vault's user tier (record "calls", the same JSON as
// Android: {"c":[{id,key,room,kind,at,sec,video,people,sys?}]}), so nothing of
// it is readable before the PIN or a biometric unlock; at most 500 calls of
// the last 90 days. Settings › Calls can stop keeping it (calls.history) or
// clear it; a wipe takes it with the vault.
//
// CallTrack, the entries, their JSON (byte for byte Android's, read as
// tolerantly as org.json) and the store are M5Proto's (Chat/Calls.swift, a
// port of android chat/CallTrack.java and CallHistory.java); this file is the
// app's adapter: the main actor, Settings › Calls › Keep a call history, the
// wipe, change notices, and the vault seam Platform/Security implements
// (`CallHistoryVault`, the record's bytes). The "sys" field (Android: the
// phone call log's row) is kept as read, never set on iOS: CallKit writes
// Recents itself and the app cannot remove those rows.

import Foundation
import M5Core
import M5Proto
import os

/// M5Proto's `CallTrack` — the same type (not a second one), for the app's files that do not import M5Proto.
typealias CallTrack = M5Proto.CallTrack

/// Where the history lives: the vault's user tier, record "calls" — Platform/Security implements it.
@MainActor
protocol CallHistoryVault: AnyObject {
    /// The vault is open (PIN / biometric).
    var isUnlocked: Bool { get }
    /// The record's bytes (nil when there is none).
    func readCalls() -> Data?
    func writeCalls(_ data: Data) throws
    func deleteCalls()
}

/// The history as the app uses it — M5Proto's `CallHistoryStore` on the main actor: kept while the vault is
/// open, in memory while it is closed; nothing while Settings › Calls says not to, nothing at all after a wipe.
@MainActor
final class AppCallHistory {
    /// The vault (set when Platform/Security is wired; none = closed).
    var vault: (any CallHistoryVault)? {
        get { bridge.vault }
        set { bridge.vault = newValue }
    }
    /// Settings › Calls › Keep a call history (calls.history).
    var enabled: () -> Bool = { true }
    /// Calls that ended while the vault was closed (kept in memory until it opens).
    var pending: [CallHistory.Entry] { store.waiting }
    /// Every change (the History list reloads).
    var onChange: (() -> Void)?
    var now: () -> Int64 {
        get { bridge.now }
        set { bridge.now = newValue }
    }

    /// After a wipe nothing is kept any more (a room's last call may end while it runs).
    private var wiped = false
    private let bridge: CallHistoryVaultBridge
    private let store: CallHistoryStore

    init(vault: (any CallHistoryVault)? = nil, now: @escaping () -> Int64 = { CallTrack.millis() }) {
        let bridge = CallHistoryVaultBridge(vault: vault, now: now)
        self.bridge = bridge
        store = CallHistoryStore(vault: bridge, clock: ClosureClock { MainActor.assumeIsolated { bridge.now() } })
    }

    /// Every call kept, oldest first (empty while the vault is closed).
    func load() -> [CallHistory.Entry] { store.load() }

    /// Keeps a call (unless Settings › Calls says not to).
    func add(_ e: CallHistory.Entry) {
        guard !wiped, enabled() else { return }
        store.add(e)
        onChange?()
    }

    /// A finished call of a room, as CallTrack recorded it.
    func record(_ r: CallTrack.Record, roomKey: String, room: String) {
        add(.of(id: CallHistory.newId(), roomKey: roomKey, room: room, r))
    }

    /// Deletes the whole call history (Recents rows stay: iOS gives apps no way to remove them).
    func clear() {
        store.clear()
        onChange?()
    }

    /// A wipe: nothing is kept from now on, and what was is gone.
    func wipe() {
        wiped = true
        clear()
    }

    /* ------------------------------------------------- the record's bytes */

    /// The vault record's bytes (M5Proto's JSON: Android's keys in Android's order).
    nonisolated static func encode(_ list: [CallHistory.Entry]) -> Data { Data(CallHistory.json(list).stringify().utf8) }

    /// The entries of the record's bytes; none for nothing, damage or junk.
    nonisolated static func decode(_ data: Data?) -> [CallHistory.Entry] { CallHistory.from(object(data)) }

    nonisolated static func object(_ data: Data?) -> JSONObject? {
        guard let data else { return nil }
        return JSON.parseObject(String(decoding: data, as: UTF8.self))
    }
}

/// The app's vault seam as M5Proto's `RecordVault`. Only `AppCallHistory` (main actor) calls its store, and the
/// store calls back synchronously — so every call here is on the main actor.
private final class CallHistoryVaultBridge: RecordVault, @unchecked Sendable {
    var vault: (any CallHistoryVault)?
    var now: () -> Int64

    init(vault: (any CallHistoryVault)?, now: @escaping () -> Int64) {
        self.vault = vault
        self.now = now
    }

    var unlocked: Bool { MainActor.assumeIsolated { vault?.isUnlocked ?? false } }

    func record(_ name: String) -> JSONObject? {
        MainActor.assumeIsolated {
            guard let vault, vault.isUnlocked else { return nil }
            return AppCallHistory.object(vault.readCalls()) ?? JSONObject()
        }
    }

    @discardableResult func put(_ name: String, _ value: JSONObject) -> Bool {
        MainActor.assumeIsolated {
            guard let vault, vault.isUnlocked else { return false }
            do {
                try vault.writeCalls(Data(value.stringify().utf8))
                return true
            } catch {
                CallLog.error("the call history cannot be saved: \(error)")
                return false
            }
        }
    }

    func delete(_ name: String) { MainActor.assumeIsolated { vault?.deleteCalls() } }
}

/// org.json-like reading of loosely typed JSON values.
enum CallJSON {
    static func string(_ v: Any?) -> String {
        switch v {
        case let s as String: return s
        case let n as NSNumber where !isBool(n): return n.stringValue
        case let n as NSNumber: return n.boolValue ? "true" : "false"
        default: return ""
        }
    }

    static func int64(_ v: Any?) -> Int64 {
        switch v {
        case let n as NSNumber where !isBool(n): return n.int64Value
        case let s as String: return Int64(s) ?? Int64(Double(s) ?? 0)
        default: return 0
        }
    }

    static func bool(_ v: Any?) -> Bool {
        switch v {
        case let n as NSNumber where isBool(n): return n.boolValue
        case let s as String: return s.lowercased() == "true"
        default: return false
        }
    }

    static func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }
}

/// The calls' log lines (unified log, subsystem cz.m5cet.app, category "calls"). Never names, rooms or keys.
enum CallLog {
    private static let logger = Logger(subsystem: "cz.m5cet.app", category: "calls")
    static func info(_ s: String) { logger.info("\(s, privacy: .public)") }
    static func error(_ s: String) { logger.error("\(s, privacy: .public)") }
}
