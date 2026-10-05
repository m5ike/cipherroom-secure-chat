// The snapshot the watch gets, made from CoreModels.shared.rooms (the parts' contract, Core/README.md): the
// saved rooms (opaque ids, names, unread, state, a preview line) and the newest messages of the most recently
// active open rooms — as much as the notification privacy level shows (push/NotifyTemplate.visible: "sender"
// names the sender, "room" the room, "content" the text). Placeholders, never content, for what the phone
// itself keeps behind a step (sealed, hold to read, vanishing, hidden, held identity) and for media and
// positions (a kind and a caption at most — no file bytes, names or coordinates).

import Foundation
import M5Core
import M5Proto

/// Opaque room ids for the watch — random, never the room's name or key — kept until the next clear (a lock,
/// sign-out, off, wipe), and a number per room for its neutral name ("Conversation 3").
@MainActor
final class WatchRoomIds {
    private var byKey: [String: (id: String, n: Int)] = [:]
    private var byId: [String: String] = [:]

    /// The id and number of a room key (made on first use).
    func entry(for key: String) -> (id: String, n: Int) {
        if let e = byKey[key] { return e }
        var id = "r" + WatchWire.newId()
        while byId[id] != nil { id = "r" + WatchWire.newId() }
        let e = (id: id, n: byKey.count + 1)
        byKey[key] = e
        byId[id] = key
        return e
    }

    /// The room key behind an id the watch sent, nil when this generation never made it.
    func key(for id: String) -> String? { byId[id] }

    var count: Int { byKey.count }
}

@MainActor
struct WatchSnapshotBuilder {
    /// How much a snapshot carries (shrunk step by step until it fits WatchWire.snapshotBudget).
    struct Limits: Equatable, Sendable {
        var rooms = WatchWire.maxRooms
        var roomsWithMessages = WatchWire.maxRoomsWithMessages
        var messages = WatchWire.maxMessages
        var text = WatchWire.maxText

        static let steps: [Limits] = [
            Limits(),
            Limits(messages: 20),
            Limits(messages: 12, text: 200),
            Limits(roomsWithMessages: 4, messages: 8, text: 140),
            Limits(roomsWithMessages: 3, messages: 5, text: 100),
            Limits(roomsWithMessages: 2, messages: 3, text: 80),
            Limits(rooms: 8, roomsWithMessages: 1, messages: 3, text: 80),
            Limits(rooms: 12, roomsWithMessages: 0, messages: 0, text: 80),
            Limits(rooms: 6, roomsWithMessages: 0, messages: 0, text: 80),
            Limits(rooms: 0, roomsWithMessages: 0, messages: 0, text: 80),
        ]
    }

    /// 0 neutral … 3 content (WatchPrivacy).
    let level: Int
    let now: Int64
    /// A resolved UI string (WatchTexts.t).
    let t: (String) -> String
    let ids: WatchRoomIds

    // MARK: rooms

    func rooms(_ model: any RoomsModel, limits: Limits) -> [WatchRoom] {
        var out: [WatchRoom] = []
        var withMessages = 0
        for item in model.items.prefix(max(0, limits.rooms)) {
            let session = model.room(item.key)
            let e = ids.entry(for: item.key)
            var messages: [WatchMessage]?
            if let session, withMessages < limits.roomsWithMessages {
                messages = recent(session, limit: limits.messages, textMax: limits.text)
                withMessages += 1
            }
            let unread = min(max(0, item.unread), WatchWire.maxUnread)
            out.append(WatchRoom(id: e.id, name: name(item.name, n: e.n), unread: unread,
                                 status: WatchWire.isCode(item.status) && !item.status.isEmpty ? item.status : "other",
                                 at: max(0, session?.lastActivity ?? 0), preview: preview(session, unread: unread),
                                 reply: session != nil, messages: messages))
        }
        return out
    }

    /// The room's name from the "room" level up, else "Conversation n".
    func name(_ label: String, n: Int) -> String {
        if level >= WatchPrivacy.room {
            let v = WatchWire.clean(label, max: WatchWire.maxName)
            if !v.isEmpty { return v }
        }
        return WatchWire.clean(t("conversations.neutral").replacingOccurrences(of: "{n}", with: String(n)), max: WatchWire.maxName)
    }

    /// The newest `limit` messages the watch may list, oldest first.
    func recent(_ room: any RoomModel, limit: Int, textMax: Int = WatchWire.maxText) -> [WatchMessage] {
        guard limit > 0 else { return [] }
        var out: [WatchMessage] = []
        for m in room.messages.reversed() {
            guard let w = message(m, in: room, textMax: textMax) else { continue }
            out.append(w)
            if out.count == limit { break }
        }
        return out.reversed()
    }

    /// The list's line for a room: the last message as the level shows it ("content"), else "New message"
    /// while something is unread.
    func preview(_ room: (any RoomModel)?, unread: Int) -> String {
        guard let room else { return "" }
        guard level >= WatchPrivacy.content else { return unread > 0 ? WatchWire.clean(t("notify.message"), max: WatchWire.maxPreview) : "" }
        guard let last = recent(room, limit: 1, textMax: WatchWire.maxPreview).last else { return "" }
        let body = last.text.isEmpty ? label(last.kind) : last.text.replacingOccurrences(of: "\n", with: " ")
        let line = last.mine || last.sender.isEmpty || last.kind == WatchKind.sys ? body : last.sender + ": " + body
        return WatchWire.clean(line, max: WatchWire.maxPreview)
    }

    /// A placeholder's words (also what the watch shows for these kinds).
    func label(_ kind: String) -> String {
        switch kind {
        case WatchKind.image: t("attach.photo")
        case WatchKind.audio: t("attach.voice")
        case WatchKind.video: t("watch.kind.video")
        case WatchKind.file: t("attach.file")
        case WatchKind.location: t("attach.position")
        case WatchKind.sealed: t("log.kind.sealed")
        case WatchKind.tap: t("log.kind.tap")
        case WatchKind.vanish: t("log.kind.vanish")
        case WatchKind.hidden: t("log.kind.hidden")
        case WatchKind.held: t("watch.kind.held")
        case WatchKind.fn: t("watch.kind.fn")
        default: t("notify.message")
        }
    }

    // MARK: messages

    /// One message as the watch may see it, nil for one it does not list (gone, expired, a system line below
    /// the "content" level — it names people —, a call's audio state).
    func message(_ m: ChatMessage, in room: any RoomModel, textMax: Int = WatchWire.maxText) -> WatchMessage? {
        if m.deleted || m.vanished || m.kind == "audio-status" || m.expired(now) { return nil }
        guard WatchWire.isId(m.id) else { return nil }
        var kind = Self.kind(of: m, held: room.isHeld(m.id), now: now)
        if kind == WatchKind.sys && level < WatchPrivacy.content { return nil }
        var body = ""
        if level >= WatchPrivacy.content {
            body = Self.text(of: m, kind: kind, max: textMax)
        } else {
            kind = WatchKind.neutral
        }
        let sender = m.mine || kind == WatchKind.sys || level < WatchPrivacy.sender ? "" : WatchWire.clean(m.senderName, max: WatchWire.maxName)
        let status = m.mine && WatchWire.isCode(m.status) ? m.status : ""
        return WatchMessage(id: m.id, kind: kind, sender: sender, mine: m.mine, at: max(0, m.createdAt), text: body, status: status)
    }

    /// What a message is, before the privacy level: the steps the phone keeps it behind come first (their
    /// text never leaves), then media and positions, commands, notes, text.
    static func kind(of m: ChatMessage, held: Bool, now: Int64) -> String {
        if m.kind == "sys" { return WatchKind.sys }
        if held || m.changed { return WatchKind.held }
        if m.hiddenUntil == ChatMessage.untilSignIn || m.hiddenUntil > now { return WatchKind.hidden }
        if m.sealed != nil { return WatchKind.sealed }
        if m.tap { return WatchKind.tap }
        if m.vanishSeconds > 0 { return WatchKind.vanish }
        if m.loc != nil { return WatchKind.location }
        if m.fileName != nil || m.fileMime != nil || m.filePath != nil {
            let mime = (m.fileMime ?? "").lowercased()
            if m.fileImage || mime.hasPrefix("image/") { return WatchKind.image }
            if mime.hasPrefix("audio/") { return WatchKind.audio }
            if mime.hasPrefix("video/") { return WatchKind.video }
            return WatchKind.file
        }
        if m.fn != nil || m.fnCall { return WatchKind.fn }
        if m.kind == "note" { return WatchKind.note }
        return WatchKind.text
    }

    /// The text a kind may carry at the "content" level: a message's text, a caption, a command's keyword.
    static func text(of m: ChatMessage, kind: String, max: Int) -> String {
        switch kind {
        case WatchKind.text, WatchKind.note, WatchKind.sys, WatchKind.file, WatchKind.image, WatchKind.audio, WatchKind.video:
            return WatchWire.clean(m.text, max: max, lines: true)
        case WatchKind.fn:
            if m.fnCall, let l = m.fnLocal {
                return WatchWire.clean("/" + l.optString("keyword") + " " + l.optString("query"), max: max, lines: true)
            }
            let keyword = m.fn?.optString("keyword") ?? ""
            return WatchWire.clean("/" + keyword + (m.text.isEmpty ? "" : " · " + m.text), max: max, lines: true)
        default:
            return ""
        }
    }
}
