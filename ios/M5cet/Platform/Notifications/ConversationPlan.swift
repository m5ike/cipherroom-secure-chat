// Which rooms become conversations and how they look (Android
// telecom/ConversationPlan, 6.8) — the pure part, unit-tested. On Android a
// conversation is a long-lived shortcut; on iOS it is what Communication
// Notifications and Siri's suggestions (the share sheet) learn from the app's
// donated INSendMessageIntents: the conversation id, the group name, the
// sender's avatar.
//
// The joined rooms, the most recently active first; their ids keyed with a
// secret of this install (nothing of the room's name — ThreadIds); the label: the
// room's name, or a neutral "Conversation 2" whenever names may not show
// (switched off, the app locked, or notifications may not name the room); the
// monogram; which of the app's ids have to go; and when a change is worth
// publishing (Android: the system rate-limits shortcut calls in the background).

import Foundation

enum ConversationPlan {
    static let settingOn = "conversations.on"
    static let settingNames = "conversations.names"
    static let prefix = "conv-", oldPrefix = "room-"
    /// At most this many published at once (Android: the dynamic shortcuts).
    static let limit = 8
    static let debounceMs: Int64 = 1_500
    /// A new order alone is published at most this often, and only in the foreground.
    static let rankEveryMs: Int64 = 5 * 60_000
    /// when(): publish now / nothing to do / when the app is next in the foreground (else: in that many ms).
    static let now: Int64 = 0, nothing: Int64 = -2, onForeground: Int64 = -1

    /// The settings' keys and defaults.
    static func defaults(_ d: inout [String: Any]) {
        d[settingOn] = true
        d[settingNames] = true
    }

    struct Room: Equatable, Sendable {
        var key: String
        var label: String
        var activity: Int64
        var joined: Bool
    }

    struct Entry: Equatable, Sendable {
        var id: String
        var key: String
        var label: String
        var glyph: String
        var seed: String
        var rank: Int
        var named: Bool
    }

    /// Names only while wanted, the app unlocked (S11) and notifications may name the room (rank ≥ "room").
    static func names(wanted: Bool, locked: Bool, privacyRank: Int) -> Bool { wanted && !locked && privacyRank >= 2 }

    static func cap(_ systemMax: Int) -> Int { Swift.max(0, Swift.min(limit, systemMax)) }

    /// A room's id: "conv-" + 80 bits of HMAC-SHA256(secret, "m5cet/conversation\0" + room key).
    static func id(_ secret: Data, _ roomKey: String) -> String { ThreadIds.conversation(secret: secret, roomKey: roomKey) }

    /// One of the app's conversation ids (this version's or 6.7's).
    static func ours(_ id: String?) -> Bool { id.map { $0.hasPrefix(prefix) || $0.hasPrefix(oldPrefix) } ?? false }

    /// A neutral label: the design's "Conversation {n}" (without it: "M5cet {n}").
    static func neutral(_ template: String?, _ n: Int) -> String {
        let t = template.flatMap { $0.contains("{n}") ? $0 : nil } ?? "M5cet {n}"
        return t.replacingOccurrences(of: "{n}", with: String(n))
    }

    /// Every joined room, the most recently active first (ties: by key). Named: the label (its key when it has
    /// none). Neutral: numbered in the order of the ids — stable while the same rooms are joined.
    static func plan(_ rooms: [Room?], idOf: (String) -> String, names: Bool, neutralTemplate: String?) -> [Entry] {
        var joined: [Room] = []
        var seen = Set<String>()
        for case let r? in rooms where r.joined && !r.key.isEmpty && seen.insert(r.key).inserted { joined.append(r) }
        joined.sort { $0.activity != $1.activity ? $0.activity > $1.activity : JavaStringOrder.compare($0.key, $1.key) < 0 }
        let ids = joined.map { idOf($0.key) }
        let sorted = ids.sorted { JavaStringOrder.compare($0, $1) < 0 }
        return joined.enumerated().map { i, r in
            if names {
                let trimmed = r.label.trimmingCharacters(in: .whitespacesAndNewlines)
                let name = trimmed.isEmpty ? r.key : trimmed
                return Entry(id: ids[i], key: r.key, label: name, glyph: Monogram.glyph(name), seed: name, rank: i, named: true)
            }
            let n = (sorted.firstIndex(of: ids[i]) ?? 0) + 1
            return Entry(id: ids[i], key: r.key, label: neutral(neutralTemplate, n), glyph: String(n), seed: String(n), rank: i, named: false)
        }
    }

    /// Neutral entries for ids known alone (a start while locked), numbered in id order.
    static func neutralOf(_ ids: [String], neutralTemplate: String?) -> [Entry] {
        var unique: [String] = []
        for id in ids where !unique.contains(id) { unique.append(id) }
        return unique.sorted { JavaStringOrder.compare($0, $1) < 0 }.enumerated().map { i, id in
            Entry(id: id, key: "", label: neutral(neutralTemplate, i + 1), glyph: String(i + 1), seed: String(i + 1), rank: i, named: false)
        }
    }

    static func top(_ all: [Entry], _ cap: Int) -> [Entry] { Array(all.prefix(Swift.max(0, Swift.min(cap, all.count)))) }

    /// The app's ids that have to go: its own not kept, each once, in the order given.
    static func stale(_ existing: [String], keep: Set<String>) -> [String] {
        var out: [String] = []
        for id in existing where ours(id) && !keep.contains(id) && !out.contains(id) { out.append(id) }
        return out
    }

    /// What the system shows (which conversations, their labels, named or not) — not their order.
    static func setSignature(_ all: [Entry], names: Bool) -> String {
        (names ? "named|" : "neutral|") + all.map { "\($0.id)=\($0.label)" }.sorted { JavaStringOrder.compare($0, $1) < 0 }.joined(separator: "\u{0}")
    }

    static func rankSignature(_ all: [Entry]) -> String { all.map(\.id).joined(separator: ",") }

    /// When to publish: what shows changed → now (a name must not outlive the lock); the order alone → at most
    /// every rankEveryMs and only in the foreground.
    static func when(setChanged: Bool, rankChanged: Bool, foreground: Bool, now: Int64, lastAt: Int64) -> Int64 {
        if setChanged { return Self.now }
        if !rankChanged { return nothing }
        if !foreground { return onForeground }
        let wait = lastAt + rankEveryMs - now
        return wait <= 0 ? Self.now : wait
    }

    static func opaque(_ argb: UInt32) -> UInt32 { Monogram.opaque(argb) }

    /// The monogram's background: the web's tint (Avatars.background) on white.
    static func background(_ seed: String) -> UInt32 { Monogram.background(seed) }

    /// The monogram's letter (Avatars.foreground).
    static func foreground(_ seed: String) -> UInt32 { Monogram.foreground(seed) }
}

/// Java's String.compareTo: UTF-16 code units in order.
enum JavaStringOrder {
    static func compare(_ a: String, _ b: String) -> Int {
        var i = a.utf16.makeIterator(), j = b.utf16.makeIterator()
        while true {
            switch (i.next(), j.next()) {
            case (nil, nil): return 0
            case (nil, _): return -1
            case (_, nil): return 1
            case let (x?, y?): if x != y { return Int(x) - Int(y) }
            }
        }
    }
}
