// MessageList.Adapter.onBindViewHolder: the $msg a row of the design's
// message.in / message.out / message.sys sees — ChatMessage.scope plus what the
// list knows: position (a position message), mapPreview (its bubble draws the
// map), hidden; 6.10 replyTo (the quote card), cont (a run of one person's
// messages), photo (the picture they share with the room); 6.11 model (a model's
// answer under the model's name and face); 6.12 (F-22) the sender's name as the app
// shows it ("⚠ " for a look-alike) and an operator's notice as the operator's.

import Foundation
import M5Core
import M5Design
import M5Proto

@MainActor
enum ChatMessageScope {
    /// Which template draws a message: a notice, mine, or an incoming one (a model's answer is incoming, also my room one).
    static func screen(_ m: ChatMessage) -> String {
        m.kind == "sys" ? "message.sys" : m.mine && BubbleModelFace.of(m) == nil ? "message.out" : "message.in"
    }

    /// The row's scope: $msg, $settings, and the room's key for the msgBody / msgHold slots.
    static func scope(_ m: ChatMessage, previous: ChatMessage?, room: (any RoomModel)?, byId: [String: ChatMessage],
                      roster: ChatRoster, tr: (String) -> String, has: (String) -> Bool, settings: SettingsModel, now: Int64) -> Scope {
        var ms = m.scope
        let hidden = m.hiddenUntil != 0 && BubbleHides.hidden(m, now)
        // 6.12 review P14: a quote of a held message (changed identity, not accepted) shows no text.
        var quote = BubbleReplyQuote.of(m, m.replyToId.flatMap { byId[$0] }, held: m.replyToId != nil && (room?.isHeld(m.replyToId) ?? false), tr)
        let position = BubbleKinds.isPositionMessage(m)
        ms["position"] = .bool(position)
        ms["mapPreview"] = .bool(position && MapBubble.policy(for: m) != nil)
        ms["hidden"] = .bool(hidden)
        // 6.12 (F-22): names as the app shows them; a sender that looks like someone else gets "⚠ ".
        let flag = roster.flagged(m)
        ms["sender"] = .string(Names.shown(m.senderName, flagged: flag))
        ms["senderFlag"] = .bool(flag)
        ms["forwarded"] = .string(Names.normalize(m.forwardedFrom ?? ""))
        if var q = quote { q["sender"] = .string(Names.normalize(q.optString("sender"))); quote = q }
        if m.kind == "sys", m.id.hasPrefix(Names.noticeId) {
            let who = Names.operator(m.senderName, tr("notice.operator"))
            ms["sender"] = .string(who)
            ms["text"] = .string(who + ": " + ms.optString("text"))
        }
        if let quote { ms["replyTo"] = .object(quote) }
        ms["cont"] = .bool(previous != nil && BubbleRuns.continues(previous, m))
        ms["photo"] = .string(m.mine ? "" : senderPhoto(m, room))
        // 6.11: a model's answer — the model is the sender (its name, its face); no "forwarded from /kw".
        if let model = BubbleModelFace.scope(m, tr, has) {
            ms["model"] = .object(model)
            ms["sender"] = .string(model.optString("name"))
            ms["photo"] = ""
            ms["forwarded"] = ""
        } else {
            ms["model"] = .null
        }
        return Scope(["msg": ms.designValue, "settings": settings.scope(), roomKeyName: .string(m.roomKey)])
    }

    /// The scope's own name for the room's key (not a variable of the design).
    static let roomKeyName = "_m5room"

    /// 6.10: the photo the sender shares with this room ("" without one: the design draws the monogram).
    static func senderPhoto(_ m: ChatMessage, _ room: (any RoomModel)?) -> String {
        if m.senderId.isEmpty || m.kind == "sys" { return "" }
        return room?.profile(of: m.senderId)?.optString("avatar") ?? ""
    }

    /// The message a slot of a row draws (msgBody, msgHold): its id from $msg, its room from the row's scope.
    static func message(_ scope: Scope) -> ChatMessage? {
        guard let id = scope["msg"]["id"].stringValue else { return nil }
        let key = scope[roomKeyName].stringValue ?? ""
        let rooms = CoreModels.shared.rooms
        let room = key.isEmpty ? rooms.active : (rooms.room(key) ?? rooms.active)
        return room?.message(id)
    }
}

/// 6.12 (F-22): the room's members as the look-alike check sees them ({id, identity, name}) and my name.
struct ChatRoster {
    let members: [Names.Member]
    let myName: String

    @MainActor init(room: (any RoomModel)?, userName: String) {
        var list = [Names.Member]()
        var me = userName
        for p in room?.people ?? [] {
            list.append(Names.Member(p.id, Self.identity(p), p.name))
            if p.me { me = p.name.isEmpty ? me : p.name }
        }
        members = list
        myName = me
    }

    /// People.identity: the device key, else the account (signed in), else the peer id.
    static func identity(_ p: PersonItem) -> String {
        if !p.publicKey.isEmpty { return "k:" + p.publicKey }
        if p.signedIn && !p.username.isEmpty { return "a:" + p.username.lowercased() }
        return "i:" + p.id
    }

    func flagged(_ m: ChatMessage) -> Bool {
        if m.mine || m.kind == "sys" || m.senderName.isEmpty { return false }
        return Names.senderFlag(members, myName: myName, senderId: m.senderId, senderName: m.senderName)
    }
}
