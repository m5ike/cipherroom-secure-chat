// 6.8: the History screen's list ("log") — the calls and the messages of every
// room in one list, newest first. Calls come from the call history
// (CallHistoryStore), messages from the rooms' own histories as they are
// (CallLogMessageSource — the room session) — nothing is copied or stored again.
//
// What a message may show here: its text, a file's name or a command — but a
// sealed, hold-to-read, vanishing or hidden message only its kind, never a word
// of it (the search does not see into them either). System lines and expired
// messages are left out. Pure (CallLogItemsTests).
//
// Port of android/app/src/main/java/cz/m5cet/app/chat/ActivityLog.java.

import Foundation

enum CallLogItems {
    static let call = "call", msg = "msg"
    /// The filters of the screen.
    enum Filter: String, CaseIterable, Sendable { case all, calls, messages, missed }
    /// A message's preview is cut to this many characters.
    static let previewMax = 120
    /// The newest this many go to the screen (Android CallLogUi.SHOWN).
    static let shown = 200

    /// One line of the log.
    struct Item: Equatable, Sendable, Identifiable {
        var id = ""
        /// `call` or `msg`.
        var type = msg
        /// in | out (calls also missed | declined).
        var dir = "in"
        /// A call: audio | video; a message: text | file | fn | sealed | tap | vanish | hidden.
        var what = "text"
        var roomKey = "", room = ""
        /// A call's others; a message's sender (received) or its recipients (a private one of mine).
        var people: [String] = []
        var at: Int64 = 0
        var seconds: Int64 = 0
        var video = false
        /// What a message says ("" for the kinds that show nothing).
        var preview = ""
        var msgId = ""
        /// The room is still saved in the app (it opens; a call can be made again).
        var saved = false

        var isCall: Bool { type == CallLogItems.call }
    }

    /// A room's message as the room session hands it to the log (only what the log may look at).
    struct Message: Sendable {
        var id: String
        var createdAt: Int64
        var mine: Bool
        var senderName: String
        /// The recipients of a private message of mine.
        var to: [String] = []
        var text: String
        /// "text" for a chat message; anything else (system lines, receipts…) is not listed.
        var kind = "text"
        var deleted = false
        var expired = false
        var sealed = false
        var tap = false
        var vanishing = false
        var fileName: String?
        /// A command's keyword (a function message).
        var fnKeyword: String?

        init(id: String, createdAt: Int64, mine: Bool, senderName: String, text: String) {
            self.id = id; self.createdAt = createdAt; self.mine = mine; self.senderName = senderName; self.text = text
        }
    }

    // MARK: items

    static func call(_ e: CallHistoryEntry, saved: Bool) -> Item {
        var it = Item()
        it.id = "c:" + e.id
        it.type = call
        it.dir = e.kind.rawValue
        it.what = e.video ? "video" : "audio"
        it.roomKey = e.roomKey
        it.room = e.room
        it.people = e.people
        it.at = e.at
        it.seconds = e.seconds
        it.video = e.video
        it.saved = saved
        return it
    }

    /// A message of a room as the log shows it, or nil when it is not listed (system lines, expired, gone).
    static func message(roomKey: String, room: String, _ m: Message?, hidden: Bool) -> Item? {
        guard let m, !m.deleted, m.kind == "text", !m.expired else { return nil }
        var it = Item()
        it.id = "m:" + String(UInt32(bitPattern: javaHash(roomKey)), radix: 16) + ":" + m.id
        it.type = msg
        it.dir = m.mine ? "out" : "in"
        it.what = what(m, hidden: hidden)
        it.roomKey = roomKey
        it.room = room
        if !m.mine && !m.senderName.isEmpty { it.people.append(m.senderName) }
        if m.mine { it.people += m.to }
        it.at = m.createdAt
        it.preview = preview(m, what: it.what)
        it.msgId = m.id
        it.saved = true
        return it
    }

    /// What of a message the log may show: a kind that hides its text wins over everything else.
    static func what(_ m: Message, hidden: Bool) -> String {
        if hidden { return "hidden" }
        if m.sealed { return "sealed" }
        if m.tap { return "tap" }
        if m.vanishing { return "vanish" }
        if m.fileName != nil { return "file" }
        if m.fnKeyword != nil { return "fn" }
        return "text"
    }

    static func preview(_ m: Message, what: String) -> String {
        switch what {
        case "text": return oneLine(m.text)
        case "file": return oneLine((m.fileName ?? "") + (m.text.isEmpty ? "" : " · " + m.text))
        case "fn": return oneLine("/" + (m.fnKeyword ?? "") + (m.text.isEmpty ? "" : " · " + m.text))
        default: return ""
        }
    }

    static func oneLine(_ s: String) -> String {
        var out = ""
        var gap = false
        for scalar in s.unicodeScalars {
            if scalar.properties.generalCategory == .control || scalar.properties.isWhitespace {
                gap = true
            } else {
                if gap && !out.isEmpty { out.unicodeScalars.append(" ") }
                gap = false
                out.unicodeScalars.append(scalar)
            }
        }
        return out.count > previewMax ? String(out.prefix(previewMax - 1)) + "…" : out
    }

    // MARK: merge, filter, search

    /// One list, newest first (the same time: calls before messages, then by id — always the same order).
    static func merge(calls: [Item], messages: [Item]) -> [Item] {
        (calls + messages).sorted { a, b in
            if a.at != b.at { return a.at > b.at }
            if a.type != b.type { return a.type == call }
            return a.id < b.id
        }
    }

    /// The items of a filter that match the search (room, people, what a message says).
    static func filter(_ all: [Item], _ filter: Filter = .all, query: String = "") -> [Item] {
        let words = fold(query.trimmingCharacters(in: .whitespacesAndNewlines)).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        return all.filter { it in
            switch filter {
            case .all: break
            case .calls: if !it.isCall { return false }
            case .messages: if it.isCall { return false }
            case .missed: if !(it.isCall && it.dir == CallTrack.Kind.missed.rawValue) { return false }
            }
            if words.isEmpty { return true }
            let hay = fold(([it.room] + it.people + [it.preview]).joined(separator: "\n"))
            return words.allSatisfy { hay.contains($0) }
        }
    }

    /// Lower case without diacritics ("Žluťoučký" finds "zlutoucky") — NFD without the marks, as Android's.
    static func fold(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in s.decomposedStringWithCanonicalMapping.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: continue
            default: out.append(scalar)
            }
        }
        return String(out).lowercased()
    }

    // MARK: days, lengths

    /// How many calendar days back a time is (0 = today, 1 = yesterday; the future counts as today).
    static func daysAgo(_ at: Int64, now: Int64, timeZone tz: TimeZone) -> Int {
        let day: Int64 = 86_400_000
        func local(_ t: Int64) -> Int64 {
            let offset = Int64(tz.secondsFromGMT(for: Date(timeIntervalSince1970: Double(t) / 1000))) * 1000
            let v = t + offset
            return v >= 0 ? v / day : (v - day + 1) / day
        }
        return Int(max(0, min(Int64(Int32.max), local(now) - local(at))))
    }

    /// A call's length: 0:42, 12:04, 1:02:09 ("" for none).
    static func length(_ seconds: Int64) -> String {
        guard seconds > 0 else { return "" }
        let h = seconds / 3600, m = seconds % 3600 / 60, s = seconds % 60
        return h > 0 ? String(format: "%lld:%02lld:%02lld", h, m, s) : String(format: "%lld:%02lld", m, s)
    }

    /// Java's String.hashCode (the message item id is Android's, for the same room key).
    static func javaHash(_ s: String) -> Int32 {
        var h: Int32 = 0
        for u in s.utf16 { h = h &* 31 &+ Int32(u) }
        return h
    }

    // MARK: collect

    /// Everything the log lists: every call kept and the messages of every saved room, newest first.
    @MainActor
    static func collect(history: CallHistoryStore, messages source: (any CallLogMessageSource)?) -> [Item] {
        var saved = Set<String>()
        var msgs: [Item] = []
        for room in source?.savedRooms() ?? [] {
            saved.insert(room.key)
            for m in source?.messages(ofRoom: room.key) ?? [] {
                if let it = message(roomKey: room.key, room: room.label, m.message, hidden: m.hidden) { msgs.append(it) }
            }
        }
        let calls = history.load().map { call($0, saved: saved.contains($0.roomKey)) }
        return merge(calls: calls, messages: msgs)
    }
}
