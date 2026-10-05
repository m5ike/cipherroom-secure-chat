// 6.8: the app's own history of calls — what the History screen lists besides
// the rooms' messages (CallLogItems). One record per call (CallTrack),
// encrypted in the vault's user tier (record "calls", the same JSON as
// Android: {"c":[{id,key,room,kind,at,sec,video,people,sys?}]}), so nothing of
// it is readable before the PIN or a biometric unlock; at most `keep` calls of
// the last `keepMs`. Settings › Calls can stop keeping it (calls.history) or
// clear it; a wipe takes it with the vault.
//
// Port of android/app/src/main/java/cz/m5cet/app/chat/CallHistory.java. The
// "sys" field (Android: the phone call log's row) is kept as read, never set on
// iOS: CallKit writes Recents itself and the app cannot remove those rows.

import Foundation
import os

/// One call of a room.
struct CallHistoryEntry: Equatable, Sendable, Identifiable {
    var id: String
    var roomKey: String
    /// The room's name when the call happened.
    var room: String
    var kind: CallTrack.Kind
    /// ms since 1970
    var at: Int64
    var seconds: Int64
    var video: Bool
    var people: [String]
    /// Android: the row in the phone's call log ("" = none). Kept as read.
    var sys: String = ""

    static func of(id: String, roomKey: String?, room: String?, record r: CallTrack.Record) -> CallHistoryEntry {
        CallHistoryEntry(id: id, roomKey: roomKey ?? "", room: room ?? "", kind: r.kind, at: r.at, seconds: r.seconds,
                         video: r.video, people: r.people)
    }

    var json: [String: Any] {
        var o: [String: Any] = ["id": id, "key": roomKey, "room": room, "kind": kind.rawValue, "at": at, "sec": seconds,
                                "video": video, "people": people]
        if !sys.isEmpty { o["sys"] = sys }
        return o
    }

    /// Reads an entry as tolerantly as org.json's opt* does: an unknown kind is a missed call, junk is empty.
    init(json o: [String: Any]) {
        id = CallJSON.string(o["id"])
        roomKey = CallJSON.string(o["key"])
        room = CallJSON.string(o["room"])
        let k = CallJSON.string(o["kind"])
        kind = CallTrack.Kind(rawValue: k) ?? .missed
        at = CallJSON.int64(o["at"])
        seconds = max(0, CallJSON.int64(o["sec"]))
        video = CallJSON.bool(o["video"])
        var names: [String] = []
        if let p = o["people"] as? [Any] {
            for x in p.prefix(CallTrack.peopleMax) { let n = CallJSON.string(x); if !n.isEmpty { names.append(n) } }
        }
        people = names
        sys = CallJSON.string(o["sys"])
    }

    init(id: String, roomKey: String, room: String, kind: CallTrack.Kind, at: Int64, seconds: Int64, video: Bool,
         people: [String], sys: String = "") {
        self.id = id; self.roomKey = roomKey; self.room = room; self.kind = kind; self.at = at
        self.seconds = max(0, seconds); self.video = video; self.people = people; self.sys = sys
    }
}

/// The pure parts: bounds and the vault record's JSON.
enum CallHistoryCodec {
    static let keep = 500
    static let keepMs: Int64 = 90 * 24 * 3600 * 1000
    /// The vault record's name (user tier).
    static let record = "calls"

    /// The calls kept: those of the last keepMs (none from the future), oldest first, at most keep.
    static func bound(_ list: [CallHistoryEntry], now: Int64) -> [CallHistoryEntry] {
        let window = list.filter { $0.at > now - keepMs && $0.at <= now + 24 * 3600_000 }
        // A stable sort by time (Java's Collections.sort is stable too).
        let out = window.enumerated().sorted { a, b in a.element.at != b.element.at ? a.element.at < b.element.at : a.offset < b.offset }
            .map(\.element)
        return out.count > keep ? Array(out.suffix(keep)) : out
    }

    static func encode(_ list: [CallHistoryEntry]) -> Data {
        let o: [String: Any] = ["c": list.map(\.json)]
        return (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    static func decode(_ data: Data?) -> [CallHistoryEntry] {
        guard let data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let a = o["c"] as? [Any] else { return [] }
        return a.compactMap { ($0 as? [String: Any]).map(CallHistoryEntry.init(json:)) }
    }

    /// A new entry id: 9 random bytes, base64url (as Android's Crypto.b64url(random(9))).
    static func newId() -> String {
        var bytes = [UInt8](repeating: 0, count: 9)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

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

/// The history as the app uses it: kept while the vault is open, in memory while it is closed.
@MainActor
final class CallHistoryStore {
    var vault: (any CallHistoryVault)?
    /// Settings › Calls › Keep a call history (calls.history).
    var enabled: () -> Bool = { true }
    /// Calls that ended while the vault was closed (kept in memory until it opens).
    private(set) var pending: [CallHistoryEntry] = []
    /// After a wipe nothing is kept any more (a room's last call may end while it runs).
    private var wiped = false
    /// Every change (the History list reloads).
    var onChange: (() -> Void)?
    var now: () -> Int64

    init(vault: (any CallHistoryVault)? = nil, now: @escaping () -> Int64 = { CallTrack.millis() }) {
        self.vault = vault
        self.now = now
    }

    /// Every call kept, oldest first (empty while the vault is closed).
    func load() -> [CallHistoryEntry] {
        guard let vault, vault.isUnlocked else { return [] }
        var all = CallHistoryCodec.decode(vault.readCalls())
        if !pending.isEmpty {
            all += pending
            pending.removeAll()
            all = CallHistoryCodec.bound(all, now: now())
            save(all)
        }
        return CallHistoryCodec.bound(all, now: now())
    }

    /// Keeps a call (unless Settings › Calls says not to).
    func add(_ e: CallHistoryEntry) {
        guard !wiped, enabled() else { return }
        guard let vault, vault.isUnlocked else {
            if pending.count < CallHistoryCodec.keep { pending.append(e) }
            onChange?()
            return
        }
        var all = load()
        all.append(e)
        save(CallHistoryCodec.bound(all, now: now()))
        onChange?()
    }

    /// A finished call of a room, as CallTrack recorded it.
    func record(_ r: CallTrack.Record, roomKey: String, room: String) {
        add(.of(id: CallHistoryCodec.newId(), roomKey: roomKey, room: room, record: r))
    }

    /// Deletes the whole call history (Recents rows stay: iOS gives apps no way to remove them).
    func clear() {
        pending.removeAll()
        vault?.deleteCalls()
        onChange?()
    }

    /// A wipe: nothing is kept from now on, and what was is gone.
    func wipe() {
        wiped = true
        clear()
    }

    private func save(_ all: [CallHistoryEntry]) {
        guard let vault, vault.isUnlocked else { return }
        do { try vault.writeCalls(CallHistoryCodec.encode(all)) } catch { CallLog.error("the call history cannot be saved: \(error)") }
    }
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
