// Calls as the app records them (6.8; android chat/CallTrack.java,
// CallHistory.java, ActivityLog.java) — the call state model without WebRTC:
//
//   CallTrack     what a room's call was for me, from my audio and the others'
//                 audio-status: outgoing, incoming, missed, declined (one
//                 record per call), and when it rings
//   CallHistory   the calls kept in the vault (record "calls"), at most 500 of
//                 the last 90 days; with CallKit the app also notes the
//                 system's call log row (`sysUri`)
//   ActivityLog   the History screen: calls and the messages of every room,
//                 newest first, never a word of a sealed / tap / vanishing /
//                 hidden message

import Foundation
import M5Core
import M5Crypto
import Synchronization

public struct CallTrack: Sendable {
    /// How long nobody may be in a call before it is over.
    public static let graceMs: Int64 = 20_000
    /// At most this many names in a record.
    public static let peopleMax = 8

    public static let out = "out", incoming = "in", missed = "missed", declined = "declined"

    /// One call as I had it.
    public struct Record: Sendable, Equatable {
        public let kind: String
        public let at: Int64
        public let seconds: Int64
        public let video: Bool
        public let people: [String]
        public init(kind: String, at: Int64, seconds: Int64, video: Bool, people: [String]) {
            self.kind = kind; self.at = at; self.seconds = max(0, seconds); self.video = video; self.people = people
        }
    }

    /// What the room does after an update.
    public struct Step: Sendable, Equatable {
        public var records: [Record] = []
        /// Someone else started a call and I am not in it: ring.
        public var ring = false
        /// The ring is over (I joined, declined, or the call ended).
        public var ringOver = false
        /// Update again at this time; 0 = no need.
        public var recheckAt: Int64 = 0
        /// Who rings (the first of the others), whether with video.
        public var who = ""
        public var video = false
    }

    private var call = false, joined = false, declined = false, ringingNow = false, callVideo = false
    private var callAt: Int64 = 0, quietSince: Int64 = 0
    private var callPeople = OrderedMap<String, Bool>()
    private var me = false, meOutgoing = false, meVideo = false
    private var meSince: Int64 = 0
    private var mePeople = OrderedMap<String, Bool>()

    public init() {}

    private static func add(_ to: inout OrderedMap<String, Bool>, _ names: [String]) {
        for n in names {
            if to.count >= peopleMax { return }
            if !n.isEmpty { to[n] = true }
        }
    }

    /// The room now: whether my audio is on (and my camera), the names of the others whose audio is on, whether any of them sends video.
    public mutating func update(now: Int64, meOn: Bool, myVideo: Bool, live: [String], peerVideo: Bool) -> Step {
        var s = Step()
        let others = !live.isEmpty
        let any = meOn || others
        if !call && any {
            call = true
            callAt = now
            joined = false; declined = false; ringingNow = false; callVideo = false
            callPeople.removeAll()
        }
        if call {
            CallTrack.add(&callPeople, live)
            callVideo = callVideo || peerVideo || myVideo
        }
        if meOn && !me {
            me = true
            meSince = now
            meOutgoing = !others
            meVideo = false
            mePeople.removeAll()
            joined = true
        }
        if meOn {
            meVideo = meVideo || myVideo || peerVideo
            CallTrack.add(&mePeople, live)
        } else if me {
            me = false
            s.records.append(Record(kind: meOutgoing ? CallTrack.out : CallTrack.incoming, at: meSince, seconds: (now - meSince) / 1000, video: meVideo, people: mePeople.keys))
        }
        if call && others && !joined && !declined && !ringingNow {
            ringingNow = true
            s.ring = true
            s.who = live[0]
            s.video = callVideo
        }
        if ringingNow && (joined || declined) { ringingNow = false; s.ringOver = true }
        if call && !any {
            if quietSince == 0 { quietSince = now }
            if now - quietSince >= CallTrack.graceMs { end(&s) } else { s.recheckAt = quietSince + CallTrack.graceMs }
        } else {
            quietSince = 0
        }
        return s
    }

    /// I declined the ring: the call counts as declined unless I join it after all.
    public mutating func decline() -> Step {
        var s = Step()
        if !call || joined { return s }
        declined = true
        if ringingNow { ringingNow = false; s.ringOver = true }
        return s
    }

    /// The room is gone: whatever was open is recorded now.
    public mutating func flush(now: Int64) -> Step {
        var s = Step()
        if me {
            me = false
            s.records.append(Record(kind: meOutgoing ? CallTrack.out : CallTrack.incoming, at: meSince, seconds: (now - meSince) / 1000, video: meVideo, people: mePeople.keys))
        }
        if call { end(&s) }
        return s
    }

    /// Whether a call is ringing here now.
    public var ringing: Bool { ringingNow }

    private mutating func end(_ s: inout Step) {
        call = false
        quietSince = 0
        if ringingNow { ringingNow = false; s.ringOver = true }
        if !joined && !callPeople.isEmpty {
            s.records.append(Record(kind: declined ? CallTrack.declined : CallTrack.missed, at: callAt, seconds: 0, video: callVideo, people: callPeople.keys))
        }
        callPeople.removeAll()
    }
}

public enum CallHistory {
    public static let keep = 500
    public static let keepMs: Int64 = 90 * 24 * 3600 * 1000
    public static let record = "calls"

    /// One call of a room.
    public struct Entry: Sendable, Equatable {
        public var id = ""
        public var roomKey = ""
        /// The room's name when the call happened.
        public var room = ""
        public var kind = CallTrack.missed
        public var at: Int64 = 0
        public var seconds: Int64 = 0
        public var video = false
        public var people: [String] = []
        /// The row in the system's call log ("" = none).
        public var sysUri = ""

        public init() {}

        public static func of(id: String, roomKey: String?, room: String?, _ r: CallTrack.Record) -> Entry {
            var e = Entry()
            e.id = id; e.roomKey = roomKey ?? ""; e.room = room ?? ""
            e.kind = r.kind; e.at = r.at; e.seconds = r.seconds; e.video = r.video; e.people = r.people
            return e
        }

        public var json: JSONObject {
            var o = JSONObject([("id", .string(id)), ("key", .string(roomKey)), ("room", .string(room)), ("kind", .string(kind)), ("at", .int(at)),
                                ("sec", .int(seconds)), ("video", .bool(video)), ("people", .array(people.map { .string($0) }))])
            if !sysUri.isEmpty { o["sys"] = .string(sysUri) }
            return o
        }

        public static func from(_ o: JSONObject) -> Entry {
            var e = Entry()
            e.id = o.optString("id")
            e.roomKey = o.optString("key")
            e.room = o.optString("room")
            let k = o.optString("kind")
            e.kind = [CallTrack.incoming, CallTrack.out, CallTrack.declined].contains(k) ? k : CallTrack.missed
            e.at = o.optInt64("at")
            e.seconds = max(0, o.optInt64("sec"))
            e.video = o.bool("video") ?? false
            for p in (o.array("people") ?? []).prefix(CallTrack.peopleMax) { if let n = p.stringValue, !n.isEmpty { e.people.append(n) } }
            e.sysUri = o.optString("sys")
            return e
        }
    }

    /// The calls kept: those of the last keepMs (none from the future), oldest first, at most keep.
    public static func bound(_ list: [Entry], now: Int64) -> [Entry] {
        let kept = list.enumerated().filter { $0.element.at > now - keepMs && $0.element.at <= now + 24 * 3600_000 }
            .sorted { ($0.element.at, $0.offset) < ($1.element.at, $1.offset) }.map(\.element)
        return kept.count > keep ? Array(kept.suffix(keep)) : kept
    }

    public static func json(_ list: [Entry]) -> JSONObject { JSONObject([("c", .array(list.map { .object($0.json) }))]) }

    public static func from(_ o: JSONObject?) -> [Entry] { (o?.array("c") ?? []).compactMap { $0.objectValue.map(Entry.from) } }

    public static func newId() -> String { Crypto.b64url(Crypto.random(9)) }
}

/// The call history in the vault (android CallHistory's storage): calls ended while locked wait in memory
/// (or go to the lock inbox — the app decides with `onLocked`).
public final class CallHistoryStore: Sendable {
    private let vault: any RecordVault
    private let clock: any Clock
    private let pending = Mutex<[CallHistory.Entry]>([])

    public init(vault: any RecordVault, clock: any Clock = SystemClock()) { self.vault = vault; self.clock = clock }

    /// Every call kept, oldest first (empty while the vault is closed).
    public func load() -> [CallHistory.Entry] {
        guard vault.unlocked else { return [] }
        var all = CallHistory.from(vault.record(CallHistory.record))
        let waiting = pending.withLock { p -> [CallHistory.Entry] in defer { p.removeAll() }; return p }
        if !waiting.isEmpty { all += waiting; all = CallHistory.bound(all, now: clock.now()); save(all) }
        return CallHistory.bound(all, now: clock.now())
    }

    /// Keeps a call; locked: `toInbox` may take it (the lock inbox), else it waits in memory.
    public func add(_ e: CallHistory.Entry, toInbox: ((CallHistory.Entry) -> Bool)? = nil) {
        guard vault.unlocked else {
            if toInbox?(e) == true { return }
            pending.withLock { if $0.count < CallHistory.keep { $0.append(e) } }
            return
        }
        var all = load()
        all.append(e)
        save(CallHistory.bound(all, now: clock.now()))
    }

    /// A call from the lock inbox — once, even when the inbox is merged a second time.
    public func addOnce(_ e: CallHistory.Entry) {
        guard vault.unlocked, !e.id.isEmpty else { return }
        var all = load()
        if all.contains(where: { $0.id == e.id }) { return }
        all.append(e)
        save(CallHistory.bound(all, now: clock.now()))
    }

    /// Remembers the system call log row of a call kept before.
    public func setSysUri(_ id: String, _ uri: String) {
        if uri.isEmpty { return }
        let hit = pending.withLock { p -> Bool in
            guard let i = p.firstIndex(where: { $0.id == id }) else { return false }
            p[i].sysUri = uri
            return true
        }
        if hit || !vault.unlocked { return }
        var all = load()
        guard let i = all.firstIndex(where: { $0.id == id }) else { return }
        all[i].sysUri = uri
        save(all)
    }

    public func clear() {
        pending.withLock { $0.removeAll() }
        vault.delete(CallHistory.record)
    }

    private func save(_ all: [CallHistory.Entry]) {
        guard vault.unlocked else { return }
        vault.put(CallHistory.record, CallHistory.json(all))
    }
}

public enum ActivityLog {
    public static let call = "call", msg = "msg"
    public static let all = "all", calls = "calls", messages = "messages", missed = "missed"
    static let previewMax = 120

    /// One line of the log.
    public struct Item: Sendable, Equatable {
        public var id = ""
        public var type = ActivityLog.msg
        /// in | out (calls also missed | declined).
        public var dir = "in"
        /// text | file | fn | sealed | tap | vanish | hidden (messages); audio | video (calls).
        public var what = "text"
        public var roomKey = "", room = ""
        public var people: [String] = []
        public var at: Int64 = 0
        public var seconds: Int64 = 0
        public var video = false
        public var preview = ""
        public var msgId = ""
        /// The room is still saved in the app.
        public var saved = false
        public init() {}
    }

    public static func call(_ e: CallHistory.Entry, saved: Bool) -> Item {
        var it = Item()
        it.id = "c:" + e.id
        it.type = call
        it.dir = e.kind
        it.what = e.video ? "video" : "audio"
        it.roomKey = e.roomKey; it.room = e.room
        it.people = e.people
        it.at = e.at; it.seconds = e.seconds; it.video = e.video
        it.saved = saved
        return it
    }

    /// Java's String.hashCode (the item id's room part).
    static func javaHash(_ s: String) -> Int32 {
        var h: Int32 = 0
        for u in s.utf16 { h = h &* 31 &+ Int32(u) }
        return h
    }

    /// A message of a room as the log shows it, or nil when it is not listed (system lines, expired, gone).
    public static func message(roomKey: String, room: String, _ m: ChatMessage, hidden: Bool, now: Int64) -> Item? {
        if m.deleted || m.kind != "text" || m.expired(now) { return nil }
        var it = Item()
        it.id = "m:" + String(UInt32(bitPattern: javaHash(roomKey)), radix: 16) + ":" + m.id
        it.type = msg
        it.dir = m.mine ? "out" : "in"
        it.what = what(m, hidden: hidden)
        it.roomKey = roomKey; it.room = room
        if !m.mine && !m.senderName.isEmpty { it.people.append(m.senderName) }
        if m.mine { it.people += m.to }
        it.at = m.createdAt
        it.preview = preview(m, it.what)
        it.msgId = m.id
        it.saved = true
        return it
    }

    /// What of a message the log may show: a kind that hides its text wins over everything else.
    public static func what(_ m: ChatMessage, hidden: Bool) -> String {
        if hidden { return "hidden" }
        if m.sealed != nil { return "sealed" }
        if m.tap { return "tap" }
        if m.vanishSeconds > 0 || m.vanished { return "vanish" }
        if m.fileName != nil { return "file" }
        if m.fn != nil { return "fn" }
        return "text"
    }

    static func preview(_ m: ChatMessage, _ what: String) -> String {
        switch what {
        case "text": return oneLine(m.text)
        case "file": return oneLine((m.fileName ?? "") + (m.text.isEmpty ? "" : " · " + m.text))
        case "fn": return oneLine("/" + (m.fn?.optString("keyword") ?? "") + (m.text.isEmpty ? "" : " · " + m.text))
        default: return ""
        }
    }

    /// Runs of control characters and white space → one space; trimmed; at most previewMax.
    static func oneLine(_ s: String) -> String {
        var out = ""
        var space = false
        for u in s.unicodeScalars {
            // Java's [\p{Cntrl}\s]: U+0000–U+0020 and U+007F.
            if u.value <= 0x20 || u.value == 0x7f { space = true; continue }
            if space && !out.isEmpty { out += " " }
            space = false
            out.unicodeScalars.append(u)
        }
        let units = Array(out.utf16)
        if units.count > previewMax { return Payloads.prefixUTF16(out, previewMax - 1) + "…" }
        return out
    }

    /// One list, newest first (the same time: calls before messages, then by id).
    public static func merge(_ calls: [Item], _ messages: [Item]) -> [Item] {
        (calls + messages).sorted { a, b in
            if a.at != b.at { return a.at > b.at }
            if a.type != b.type { return a.type == call }
            return Ordinal.less(a.id, b.id)
        }
    }

    /// The items of a filter (all | calls | messages | missed) that match the search.
    public static func filter(_ items: [Item], filter: String?, query: String?) -> [Item] {
        let f = filter ?? all
        let q = fold((query ?? "").javaTrimmed)
        return items.filter { it in
            if f == calls && it.type != call { return false }
            if f == messages && it.type != msg { return false }
            if f == missed && !(it.type == call && it.dir == CallTrack.missed) { return false }
            return q.isEmpty || matches(it, q)
        }
    }

    private static func matches(_ it: Item, _ q: String) -> Bool {
        let hay = fold(([it.room] + it.people + [it.preview]).joined(separator: "\n"))
        for word in q.split(whereSeparator: { $0.isWhitespace }) where !hay.contains(word) { return false }
        return true
    }

    /// Lower case without diacritics ("Žluťoučký" finds "zlutoucky").
    public static func fold(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for u in s.decomposedStringWithCanonicalMapping.unicodeScalars {
            switch u.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: continue
            default: out.append(u)
            }
        }
        return String(out).lowercased()
    }

    /// How many calendar days back a time is (0 = today, 1 = yesterday; the future counts as today).
    public static func daysAgo(_ at: Int64, now: Int64, tz: TimeZone) -> Int {
        let day: Int64 = 86_400_000
        func local(_ t: Int64) -> Int64 {
            let off = Int64(tz.secondsFromGMT(for: Date(timeIntervalSince1970: TimeInterval(t) / 1000))) * 1000
            let v = t + off
            return v >= 0 ? v / day : (v - day + 1) / day
        }
        return Int(max(0, min(Int64(Int.max), local(now) - local(at))))
    }

    /// A call's length: 0:42, 12:04, 1:02:09 ("" for none).
    public static func length(_ seconds: Int64) -> String {
        if seconds <= 0 { return "" }
        let h = seconds / 3600, m = seconds % 3600 / 60, s = seconds % 60
        func two(_ v: Int64) -> String { v < 10 ? "0\(v)" : "\(v)" }
        return h > 0 ? "\(h):\(two(m)):\(two(s))" : "\(m):\(two(s))"
    }
}
