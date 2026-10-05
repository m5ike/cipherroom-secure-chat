// The wire between M5cet on the iPhone and on Apple Watch (6.14) — WatchConnectivity payloads.
//
// TWO IDENTICAL COPIES of this file are compiled: ios/M5cet/Platform/Watch/WatchWire.swift (the iPhone app)
// and ios/M5cetWatch/WatchWire.swift (the watch app). The targets' synchronized folders cannot share one file
// without a project change, so it is duplicated; M5cetTests/Watch/WatchWireTests.testBothCopiesAreIdentical
// fails when they differ — change both, byte for byte. Pure Foundation (no M5Kit, no UIKit/WatchKit).
//
// Every WatchConnectivity dictionary has one entry, `m5w`, whose value is the JSON of a `WatchEnvelope`
// (version, type, one body). The phone publishes `snapshot`s (applicationContext — the latest one wins;
// sendMessage too when the watch app is open), the watch sends `request`s (sendMessage with a reply when the
// phone is reachable, else the transferUserInfo queue) and gets a `result` (the reply, or a transferUserInfo
// back). Both sides refuse what is too big, of another version, or outside the limits below.
//
// What crosses: room names, sender names and short message texts as the notification privacy level allows,
// counts, the UI strings. Never keys, passphrases, file contents, positions, sealed / tap / vanishing /
// hidden / held texts — those travel as a kind only, the watch draws a placeholder.

import Foundation

enum WatchWire {
    /// The wire's version. A receiver refuses another one (the phone answers "version").
    static let version = 1
    /// The one key of every WatchConnectivity dictionary; its value is the envelope's JSON (Data).
    static let key = "m5w"

    /// Anything bigger is refused unread (WatchConnectivity itself refuses a message over 64 KiB).
    static let maxEnvelopeBytes = 60_000
    /// The phone shrinks a snapshot (fewer messages, shorter texts, fewer rooms) until its JSON fits.
    static let snapshotBudget = 48_000
    /// A request from the watch.
    static let maxRequestBytes = 8_192

    static let maxRooms = 12
    /// Only the most recently active open rooms carry messages.
    static let maxRoomsWithMessages = 5
    static let maxMessages = 30
    static let maxText = 280
    static let maxPreview = 80
    static let maxName = 64
    static let maxReply = 1_000
    static let maxReadIds = 100
    static let maxId = 128
    static let maxStrings = 80
    static let maxStringKey = 48
    static let maxStringValue = 240
    static let maxQuick = 8
    static let maxQuickText = 60
    static let maxUnread = 999_999

    /// How long the watch may show a snapshot's content without a newer one (phone time, ms) — a backstop for
    /// a "locked" that could not reach the watch. The phone refreshes an unchanged snapshot every `refreshMs`.
    static let lifetimeMs: Int64 = 10 * 60_000
    static let refreshMs: Int64 = 4 * 60_000

    // MARK: ids and texts

    /// A random id (requests, generations): 16 characters of [a-z0-9].
    static func newId() -> String {
        let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var g = SystemRandomNumberGenerator()
        return String((0..<16).map { _ in chars[Int(g.next(upperBound: UInt64(chars.count)))] })
    }

    /// An id on the wire: 1–128 characters of [A-Za-z0-9_.:=+/-].
    static func isId(_ s: String) -> Bool {
        guard !s.isEmpty, s.utf8.count <= maxId else { return false }
        return s.utf8.allSatisfy { c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || "_.:=+/-".utf8.contains(c)
        }
    }

    /// A key of the strings table (the design's keys): 1–48 characters of [A-Za-z0-9.].
    static func isStringKey(_ s: String) -> Bool {
        guard !s.isEmpty, s.utf8.count <= maxStringKey else { return false }
        return s.utf8.allSatisfy { c in (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2E }
    }

    /// A short code (a state, a reason, a kind, a language): 0–24 characters of [a-z0-9-].
    static func isCode(_ s: String) -> Bool {
        s.utf8.count <= 24 && s.utf8.allSatisfy { c in (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7A) || c == 0x2D }
    }

    /// Invisible and direction-changing characters (spoofing). The joiners U+200C / U+200D stay: emoji need them.
    private static func bidi(_ v: UInt32) -> Bool {
        v == 0x200B || v == 0x200E || v == 0x200F || (0x202A...0x202E).contains(v) || (0x2060...0x2069).contains(v) || v == 0xFEFF
    }

    private static func control(_ v: UInt32) -> Bool { v < 0x20 || (0x7F...0x9F).contains(v) || v == 0x2028 || v == 0x2029 }

    /// What may be shown (push/NotifyTemplate.clean, as the notifications): no control or bidi characters, runs of
    /// spaces as one, trimmed, at most `max` characters (an ellipsis when cut). `lines`: newlines stay (two at most
    /// in a row) — a message's text; otherwise one line — names, previews.
    static func clean(_ s: String, max: Int, lines: Bool = false) -> String {
        var out = String.UnicodeScalarView()
        var space = false, newlines = 0
        for u in s.unicodeScalars {
            let v = u.value
            if bidi(v) { continue }
            if lines && (v == 0x0A || v == 0x2028 || v == 0x2029) {
                space = false
                if !out.isEmpty && newlines < 2 {
                    while let last = out.last, last == " " { out.removeLast() }
                    out.append("\n")
                    newlines += 1
                }
                continue
            }
            if control(v) || u.properties.isWhitespace {
                space = !out.isEmpty && newlines == 0
                continue
            }
            if space { out.append(" "); space = false }
            newlines = 0
            out.append(u)
        }
        var text = String(out)
        while let last = text.last, last.isWhitespace { text.removeLast() }
        guard text.count > max else { return text }
        var cut = String(text.prefix(Swift.max(0, max - 1)))
        while let last = cut.last, last.isWhitespace { cut.removeLast() }
        return cut + "…"
    }

    /// Already what `clean` makes of it (a receiver's check).
    static func isClean(_ s: String, max: Int, lines: Bool = false) -> Bool { s.count <= max && clean(s, max: max, lines: lines) == s }

    // MARK: the UI strings

    /// The texts the watch shows, in English (the watch's fallback; the phone sends them from the design in the
    /// user's language). The keys without the `watch.` prefix are the design's own (default-design.json).
    static let english: [String: String] = [
        "app": "M5cet",
        "rooms.title": "Rooms",
        "notify.message": "New message",
        "notify.reply": "Reply",
        "notify.markRead": "Mark read",
        "room.connecting": "Connecting…",
        "room.offline": "Offline — retrying",
        "rooms.saved": "Saved",
        "room.send": "Send",
        "users.me": "me",
        "attach.photo": "Photo",
        "attach.file": "File",
        "attach.voice": "Voice message",
        "attach.position": "Position",
        "log.kind.sealed": "Sealed message",
        "log.kind.tap": "\"Hold to read\" message",
        "log.kind.vanish": "Vanishing message",
        "log.kind.hidden": "Hidden message",
        "watch.kind.video": "Video",
        "watch.kind.held": "Held — check the identity on the iPhone",
        "watch.kind.fn": "Command",
        "watch.locked": "Locked on iPhone",
        "watch.locked.hint": "Unlock M5cet on your iPhone to see your rooms here.",
        "watch.off": "Off on iPhone",
        "watch.off.hint": "Turn on Apple Watch in M5cet on your iPhone.",
        "watch.waiting": "Open M5cet on your iPhone",
        "watch.waiting.hint": "Your rooms show here while M5cet is unlocked on your iPhone.",
        "watch.away": "iPhone not connected",
        "watch.away.hint": "Messages show again when your iPhone is near and M5cet is unlocked.",
        "watch.unreachable": "iPhone not reachable — replies wait",
        "watch.noRooms": "No rooms on the iPhone yet.",
        "watch.noMessages": "No messages yet.",
        "watch.notOpen": "This room's messages are on the iPhone.",
        "watch.open": "Open on iPhone",
        "watch.opened": "The room is ready in M5cet on your iPhone.",
        "watch.write": "Dictate or write…",
        "watch.quick": "Quick replies",
        "watch.reply.sending": "Sending…",
        "watch.reply.queued": "Waits for the iPhone",
        "watch.reply.sent": "Sent",
        "watch.reply.failed": "Not sent",
        "watch.reply.locked": "Not sent — M5cet is locked on the iPhone",
        "watch.quick.1": "OK",
        "watch.quick.2": "Yes",
        "watch.quick.3": "No",
        "watch.quick.4": "On my way",
        "watch.quick.5": "I'll write later",
    ]

    /// The quick replies' keys, in order.
    static let quickKeys = ["watch.quick.1", "watch.quick.2", "watch.quick.3", "watch.quick.4", "watch.quick.5"]
}

// MARK: - the payloads

/// What the phone says: content (`ok`), or why there is none.
enum WatchState: String, Codable, Sendable, Equatable {
    case ok
    /// M5cet on the iPhone is locked (or has no PIN yet): nothing to show.
    case locked
    /// The person turned Apple Watch off in M5cet (or the app was erased).
    case off
}

/// A message's kind on the watch. Only `text`, `sys`, `note` and `fn` carry text (and only at the "content"
/// privacy level); the others are a placeholder (and `file`/`image`/… a caption at most).
enum WatchKind {
    static let text = "text", sys = "sys", note = "note", fn = "fn"
    static let file = "file", image = "image", audio = "audio", video = "video", location = "location"
    static let sealed = "sealed", tap = "tap", vanish = "vanish", hidden = "hidden", held = "held"
    /// The privacy level shows no content: "New message".
    static let neutral = "neutral"
    static let all: Set<String> = [text, sys, note, fn, file, image, audio, video, location, sealed, tap, vanish, hidden, held, neutral]
    /// Kinds whose `text` may be non-empty.
    static let withText: Set<String> = [text, sys, note, fn, file, image, audio, video]
}

struct WatchMessage: Codable, Sendable, Equatable, Identifiable {
    var id: String
    /// A `WatchKind` (an unknown one is drawn as `neutral`).
    var kind: String
    /// "" for my own and at the "neutral" level.
    var sender: String
    var mine: Bool
    /// Phone time, ms since 1970.
    var at: Int64
    /// The text (≤ maxText) or "" — see WatchKind.
    var text: String
    /// Mine: "sending" | "queued" | "sent" | "stored" | "forwarded" | "delivered" | "read"; "" otherwise.
    var status: String
}

struct WatchRoom: Codable, Sendable, Equatable, Identifiable {
    /// An opaque id the phone made for this room (never its name); new after every clear.
    var id: String
    /// The room's name, or "Conversation n" below the "room" privacy level.
    var name: String
    var unread: Int
    /// "joined" | "connecting" | "offline" | "saved" | another of the room's states.
    var status: String
    var at: Int64
    /// One line for the list (the last message as the privacy level allows), or "".
    var preview: String
    /// A reply can go (the room is open on the phone).
    var reply: Bool
    /// The newest messages, oldest first — nil for a room the snapshot carries no messages for.
    var messages: [WatchMessage]?
}

struct WatchSnapshot: Codable, Sendable, Equatable {
    /// The generation: new after every clear (lock, off, sign-out, wipe). Requests name it; another is refused.
    var epoch: String
    /// The order within a generation.
    var seq: Int64
    /// Phone time (ms) it was made.
    var at: Int64
    /// The content may be shown until (phone time, ms); 0 for a snapshot without content.
    var exp: Int64
    var state: WatchState
    /// Why the content went: "" | "lock" | "off" | "wipe" | "signout".
    var reason: String
    /// The language of `strings` ("en", "cs"…).
    var lang: String
    /// The UI strings (WatchWire.english's keys) in the user's language.
    var strings: [String: String]
    /// Quick replies, in order.
    var quick: [String]
    var unread: Int
    var rooms: [WatchRoom]
}

struct WatchRequest: Codable, Sendable, Equatable {
    enum Kind: String, Codable, Sendable {
        /// Send me the current snapshot (the watch app opened).
        case sync
        /// Text (dictated, written or a quick reply) to a room.
        case reply
        /// These messages were read on the watch.
        case read
        /// Make this room the one M5cet on the iPhone shows.
        case open
    }

    var id: String
    var kind: Kind
    /// Watch time, ms.
    var at: Int64
    /// The snapshot generation the watch saw ("" for sync).
    var epoch: String
    /// The room's id from the snapshot ("" for sync).
    var room: String
    var text: String
    var ids: [String]

    init(id: String = WatchWire.newId(), kind: Kind, at: Int64, epoch: String = "", room: String = "", text: String = "", ids: [String] = []) {
        self.id = id; self.kind = kind; self.at = at; self.epoch = epoch; self.room = room; self.text = text; self.ids = ids
    }
}

struct WatchResult: Codable, Sendable, Equatable {
    /// Why a request was refused.
    enum Reason {
        static let off = "off", locked = "locked", stale = "stale", unknownRoom = "unknown-room", notOpen = "not-open"
        static let invalid = "invalid", empty = "empty", version = "version"
        static let all: Set<String> = [off, locked, stale, unknownRoom, notOpen, invalid, empty, version]
    }

    /// The request's id.
    var id: String
    var ok: Bool
    /// "" when ok, else a Reason.
    var reason: String
    /// A reply: the id the phone gave the message ("" otherwise).
    var sent: String

    static func ok(_ id: String, sent: String = "") -> WatchResult { WatchResult(id: id, ok: true, reason: "", sent: sent) }
    static func refused(_ id: String, _ reason: String) -> WatchResult { WatchResult(id: id, ok: false, reason: reason, sent: "") }
}

enum WatchWireError: Error, Equatable {
    case tooLarge
    case malformed
    case version(Int)
    case invalid(String)
}

/// One payload: the version, its type and the one body of that type.
struct WatchEnvelope: Codable, Sendable, Equatable {
    var v: Int
    /// "snapshot" | "request" | "result"
    var t: String
    var snapshot: WatchSnapshot?
    var request: WatchRequest?
    var result: WatchResult?

    static func snapshot(_ s: WatchSnapshot) -> WatchEnvelope { WatchEnvelope(v: WatchWire.version, t: "snapshot", snapshot: s) }
    static func request(_ r: WatchRequest) -> WatchEnvelope { WatchEnvelope(v: WatchWire.version, t: "request", request: r) }
    static func result(_ r: WatchResult) -> WatchEnvelope { WatchEnvelope(v: WatchWire.version, t: "result", result: r) }

    /// The JSON (sorted keys: the same envelope is the same bytes).
    func encoded() throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try e.encode(self)
    }

    /// The WatchConnectivity dictionary ([m5w: JSON]).
    func dictionary() throws -> [String: Any] { [WatchWire.key: try encoded()] }

    /// Reads and checks an envelope: its size first, then the JSON, the version, and every limit of its body.
    static func decode(_ data: Data, maxBytes: Int = WatchWire.maxEnvelopeBytes) throws -> WatchEnvelope {
        guard data.count <= maxBytes else { throw WatchWireError.tooLarge }
        guard let env = try? JSONDecoder().decode(WatchEnvelope.self, from: data) else {
            // An envelope of another version may not parse as this one: say "version" when it says so.
            if let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let v = o["v"] as? Int, v != WatchWire.version {
                throw WatchWireError.version(v)
            }
            throw WatchWireError.malformed
        }
        guard env.v == WatchWire.version else { throw WatchWireError.version(env.v) }
        try env.validate()
        return env
    }

    /// The envelope in a WatchConnectivity dictionary (applicationContext, userInfo).
    static func decode(dictionary: [String: Any], maxBytes: Int = WatchWire.maxEnvelopeBytes) throws -> WatchEnvelope {
        guard let data = dictionary[WatchWire.key] as? Data else { throw WatchWireError.malformed }
        return try decode(data, maxBytes: maxBytes)
    }

    func validate() throws {
        switch t {
        case "snapshot":
            guard let s = snapshot, request == nil, result == nil else { throw WatchWireError.invalid("body") }
            try s.validate()
        case "request":
            guard let r = request, snapshot == nil, result == nil else { throw WatchWireError.invalid("body") }
            try r.validate()
        case "result":
            guard let r = result, snapshot == nil, request == nil else { throw WatchWireError.invalid("body") }
            try r.validate()
        default:
            throw WatchWireError.invalid("type")
        }
    }
}

// MARK: - validation

private func check(_ ok: Bool, _ what: String) throws { if !ok { throw WatchWireError.invalid(what) } }

extension WatchMessage {
    func validate() throws {
        try check(WatchWire.isId(id), "message.id")
        try check(WatchWire.isCode(kind) && !kind.isEmpty, "message.kind")
        try check(WatchWire.isClean(sender, max: WatchWire.maxName), "message.sender")
        try check(WatchWire.isClean(text, max: WatchWire.maxText, lines: true), "message.text")
        try check(text.isEmpty || !WatchKind.all.contains(kind) || WatchKind.withText.contains(kind), "message.text.kind")
        try check(WatchWire.isCode(status), "message.status")
        try check(at >= 0, "message.at")
    }
}

extension WatchRoom {
    func validate() throws {
        try check(WatchWire.isId(id), "room.id")
        try check(WatchWire.isClean(name, max: WatchWire.maxName), "room.name")
        try check((0...WatchWire.maxUnread).contains(unread), "room.unread")
        try check(WatchWire.isCode(status), "room.status")
        try check(WatchWire.isClean(preview, max: WatchWire.maxPreview), "room.preview")
        try check(at >= 0, "room.at")
        if let m = messages {
            try check(m.count <= WatchWire.maxMessages, "room.messages")
            for x in m { try x.validate() }
        }
    }
}

extension WatchSnapshot {
    func validate() throws {
        try check(WatchWire.isId(epoch), "epoch")
        try check(seq >= 0 && at >= 0, "seq")
        try check(WatchWire.isCode(reason), "reason")
        try check(WatchWire.isCode(lang), "lang")
        try check(strings.count <= WatchWire.maxStrings, "strings")
        for (k, v) in strings {
            try check(WatchWire.isStringKey(k) && WatchWire.isClean(v, max: WatchWire.maxStringValue), "strings.entry")
        }
        try check(quick.count <= WatchWire.maxQuick && quick.allSatisfy { !$0.isEmpty && WatchWire.isClean($0, max: WatchWire.maxQuickText) }, "quick")
        try check((0...WatchWire.maxUnread).contains(unread), "unread")
        if state == .ok {
            try check(exp > at, "exp")
        } else {
            try check(rooms.isEmpty && unread == 0, "content without ok")
        }
        try check(rooms.count <= WatchWire.maxRooms, "rooms")
        try check(rooms.filter { $0.messages != nil }.count <= WatchWire.maxRoomsWithMessages, "rooms.withMessages")
        try check(Set(rooms.map(\.id)).count == rooms.count, "rooms.ids")
        for r in rooms { try r.validate() }
    }
}

extension WatchRequest {
    func validate() throws {
        try check(WatchWire.isId(id), "request.id")
        try check(at >= 0, "request.at")
        switch kind {
        case .sync:
            try check(room.isEmpty && text.isEmpty && ids.isEmpty, "sync")
            try check(epoch.isEmpty || WatchWire.isId(epoch), "sync.epoch")
        case .reply:
            try check(WatchWire.isId(epoch) && WatchWire.isId(room) && ids.isEmpty, "reply")
            try check(!text.isEmpty && text.count <= WatchWire.maxReply, "reply.text")
        case .read:
            try check(WatchWire.isId(epoch) && WatchWire.isId(room) && text.isEmpty, "read")
            try check(!ids.isEmpty && ids.count <= WatchWire.maxReadIds && ids.allSatisfy(WatchWire.isId), "read.ids")
        case .open:
            try check(WatchWire.isId(epoch) && WatchWire.isId(room) && text.isEmpty && ids.isEmpty, "open")
        }
    }
}

extension WatchResult {
    func validate() throws {
        try check(WatchWire.isId(id), "result.id")
        try check(ok ? reason.isEmpty : WatchResult.Reason.all.contains(reason), "result.reason")
        try check(sent.isEmpty || WatchWire.isId(sent), "result.sent")
    }
}
