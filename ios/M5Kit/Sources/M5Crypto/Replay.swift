// Replay and freshness (docs/protocol-v4.md § 11, F-21; replay.ts; android
// p4/Replay.java). Accepted message ids are remembered PERSISTENTLY per room as
//
//   key = b64url(H(join("m5cet/p4/seen", roomId, id))[0:16])
//
// (the store never holds a readable id) for 31 days, at most 50 000 per room.
// A message created before the window is refused outright; one dated more than
// 5 minutes ahead is accepted with the receive time ("clamped", § 11 as
// amended in 6.12). History restored from the user's own store is exempt.

import M5Core
import Synchronization

/// The replay window's persistent store (the app keeps it in the vault).
public protocol ReplayStore: Sendable {
    func has(_ roomId: String, _ key: String) -> Bool
    /// Remembers `key` with its time (the message's createdAt).
    func add(_ roomId: String, _ key: String, _ at: Int64)
    /// Forgets keys with at < before, then the oldest beyond max.
    func prune(_ roomId: String, before: Int64, max: Int)
}

/// In memory, insertion-ordered per room; also the app's working copy (it persists `snapshot()` itself).
public final class MemoryReplayStore: ReplayStore {
    private let rooms = Mutex([String: OrderedMap<String, Int64>]())

    public init() {}

    public func has(_ roomId: String, _ key: String) -> Bool { rooms.withLock { $0[roomId]?[key] != nil } }

    public func add(_ roomId: String, _ key: String, _ at: Int64) { rooms.withLock { $0[roomId, default: OrderedMap()][key] = at } }

    public func prune(_ roomId: String, before: Int64, max: Int) {
        rooms.withLock { all in
            guard var room = all[roomId] else { return }
            for (k, at) in room.entries where at < before { room.remove(k) }
            if room.count > max {
                let byAge = room.entries.enumerated().sorted { ($0.element.value, $0.offset) < ($1.element.value, $1.offset) }
                for e in byAge.prefix(room.count - max) { room.remove(e.element.key) }
            }
            all[roomId] = room
        }
    }

    public func size(_ roomId: String) -> Int { rooms.withLock { $0[roomId]?.count ?? 0 } }

    /// The stored keys of a room with their times, oldest insertion first (for persisting).
    public func snapshot(_ roomId: String) -> [(key: String, at: Int64)] { rooms.withLock { ($0[roomId]?.entries ?? []).map { (key: $0.key, at: $0.value) } } }

    /// Every room with stored keys.
    public var roomIds: [String] { rooms.withLock { Array($0.keys) } }
}

public enum Replay {
    /// § 11: the stored form of a message id.
    public static func key(_ roomId: String, _ id: String) throws -> String {
        Prim.b64url(Array(Prim.H(try Prim.join(P4.lReplay, roomId, id)).prefix(16)))
    }
}

/// One incoming message's verdict: ok, clamped, replay, too-old or malformed (replay.ts ReplayGuard).
public final class ReplayGuard: Sendable {
    private let store: any ReplayStore
    private let pruneEvery: Int
    private let added = Mutex([String: Int]())

    public init(store: any ReplayStore, pruneEvery: Int = 256) {
        self.store = store
        self.pruneEvery = pruneEvery <= 0 ? 256 : pruneEvery
    }

    /// "ok" (accepted and remembered), "clamped" (accepted and remembered with
    /// `now`: dated more than REPLAY_FUTURE_MS ahead — the caller takes the
    /// receive time as its time), "replay", "too-old" or "malformed".
    /// `restored`: from the user's own history — no freshness or replay check, only remembered.
    public func check(_ roomId: String, _ id: String, createdAt: JSON?, now: Int64, restored: Bool = false) -> String {
        guard let key = try? Replay.key(roomId, id) else { return "malformed" }
        let safe = Prim.isSafeCount(createdAt)
        let at = safe ? ((try? Prim.count(createdAt)) ?? 0) : 0
        return added.withLock { counts in
            if !restored {
                if !safe { return "malformed" }
                if at < now - P4.replayWindowMs { return "too-old" }
                if store.has(roomId, key) { return "replay" }
            }
            // A far-future date is remembered with the receive time.
            let ahead = safe && at > now + P4.replayFutureMs
            let verdict = remember(&counts, roomId, key, safe && !ahead ? at : now, now)
            return ahead && !restored ? "clamped" : verdict
        }
    }

    public func check(_ roomId: String, _ id: String, createdAt: Int64, now: Int64, restored: Bool = false) -> String {
        check(roomId, id, createdAt: .int(createdAt), now: now, restored: restored)
    }

    /// Protocol 3 (an older peer, no freshness rule of its own): only "replay" for an id seen before, else remembered ("ok").
    public func checkId(_ roomId: String, _ id: String, now: Int64) -> String {
        guard let key = try? Replay.key(roomId, id) else { return "malformed" }
        return added.withLock { counts in
            if store.has(roomId, key) { return "replay" }
            return remember(&counts, roomId, key, now, now)
        }
    }

    private func remember(_ counts: inout [String: Int], _ roomId: String, _ key: String, _ at: Int64, _ now: Int64) -> String {
        store.add(roomId, key, at)
        let count = (counts[roomId] ?? 0) + 1
        counts[roomId] = count
        if count == 1 || count % pruneEvery == 0 { store.prune(roomId, before: now - P4.replayWindowMs, max: P4.replayMaxIdsPerRoom) }
        return "ok"
    }
}
