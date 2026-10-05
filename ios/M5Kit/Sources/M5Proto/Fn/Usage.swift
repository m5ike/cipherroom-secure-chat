// 6.11: which commands this person runs, how often and when last — a port of
// android fn/Usage.java. The suggester puts the frequent and recent ones
// first. Kept on this device only (the app stores it in the vault's user
// tier), at most `keep` keywords. Thread-safe.

import M5Core
import Synchronization

/// How often and how lately each command ran (android `fn/Usage.java`).
public final class Usage: Sendable {
    public static let keep = 50
    public static let hour: Int64 = 3_600_000
    public static let day: Int64 = 24 * hour

    private struct Uses {
        /// Keywords in insertion order (a use moves one to the end).
        var order: [String] = []
        /// keyword → (count, last use in ms).
        var map: [String: (count: Int64, last: Int64)] = [:]

        mutating func remove(_ k: String) -> (count: Int64, last: Int64)? {
            guard let v = map.removeValue(forKey: k) else { return nil }
            order.removeAll { Js.same($0, k) }
            return v
        }

        mutating func put(_ k: String, _ v: (count: Int64, last: Int64)) {
            if map.updateValue(v, forKey: k) == nil { order.append(k) }
        }

        /// The newest `keep` only (sorted newest first, as Java's trim leaves them).
        mutating func trim() {
            if order.count <= Usage.keep { return }
            let sorted = order.enumerated().sorted { x, y in
                let a = map[x.element]!.last, b = map[y.element]!.last
                return a != b ? a > b : x.offset < y.offset
            }.prefix(Usage.keep).map(\.element)
            map = Dictionary(uniqueKeysWithValues: sorted.map { ($0, map[$0]!) })
            order = sorted
        }
    }

    private let uses = Mutex(Uses())

    public init() {}

    /// From what toJson() wrote: {keyword: [count, last]}; anything else is skipped.
    public static func from(_ o: JSONObject?) -> Usage {
        let u = Usage()
        guard let o else { return u }
        u.uses.withLock { s in
            for (k, v) in o {
                guard let a = v.arrayValue, a.count >= 2, k.utf16.count <= 40 else { continue }
                let count = Js.orgLongValue(a[0]) ?? 0, last = Js.orgLongValue(a[1]) ?? 0
                if count > 0 && last > 0 { s.put(k, (Swift.min(count, 1_000_000), last)) }
            }
            s.trim()
        }
        return u
    }

    /// A command ran (or was asked for).
    public func used(_ keyword: String?, _ now: Int64) {
        guard let keyword, !keyword.isEmpty else { return }
        uses.withLock { s in
            let u = s.remove(keyword)
            s.put(keyword, u.map { (Swift.min($0.count + 1, 1_000_000), now) } ?? (1, now))
            s.trim()
        }
    }

    /// How much a keyword leads (0: never used): its uses (up to 20) weighed
    /// by how recent the last one is — this hour ×8, today ×4, this week ×2,
    /// this month ×1, older ×0.5.
    public func score(_ keyword: String, _ now: Int64) -> Double {
        guard let u = uses.withLock({ $0.map[keyword] }) else { return 0 }
        let age = Swift.max(0, now - u.last)
        let w: Double = age < Usage.hour ? 8 : age < Usage.day ? 4 : age < 7 * Usage.day ? 2 : age < 30 * Usage.day ? 1 : 0.5
        return Double(Swift.min(u.count, 20)) * w
    }

    public func count(_ keyword: String) -> Int { Int(uses.withLock { $0.map[keyword]?.count } ?? 0) }

    /// {keyword: [count, last]} in order.
    public func toJson() -> JSONObject {
        uses.withLock { s in
            var o = JSONObject()
            for k in s.order { let v = s.map[k]!; o[k] = .array([.int(v.count), .int(v.last)]) }
            return o
        }
    }
}
