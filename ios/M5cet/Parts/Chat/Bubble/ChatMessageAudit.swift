// ui/bubble/MessageAudit (6.2): hiding and deleting a message goes into the
// operator's audit journal — POST /api/ios/message-audit, signed by the device key
// like the positions (server/message-audit.ts). It says only THAT it happened —
// the action, the message's id, the room as the server knows it (it hashes it),
// the kinds, whether it was mine, until when — never the text or the file.
//
// The entry is built here (pure, tested); keeping the queue in the vault (user
// tier "msg-audit", ≤ 200, a week) and the signed POST are the core's — it plugs
// in a MessageAuditSink. Until one is installed the entries wait in memory.

import Foundation
import M5Core
import M5Proto
import os

/// The core's side of the audit journal (Android MessageAudit.add / flush on the app's vault and server).
@MainActor
protocol MessageAuditSink: AnyObject {
    /// One action to keep and send (`roomKey`: this device's room, to find the server's room id; never sent).
    func record(_ entry: JSONObject, roomKey: String)
    /// Send what waits (after an unlock, when the network is back).
    func flush()
}

@MainActor
enum ChatMessageAudit {
    /// The core's journal; entries made before it was installed are handed over then.
    static var sink: (any MessageAuditSink)? {
        didSet {
            guard let sink else { return }
            let waiting = pending
            pending.removeAll()
            for (e, k) in waiting { sink.record(e, roomKey: k) }
        }
    }

    private static var pending: [(JSONObject, String)] = []
    private static let log = Logger(subsystem: "cz.m5cet.app", category: "audit")

    /// One action; until = a hide's end (ms), 0 = until the next sign-in (and for unhide / delete).
    static func add(_ action: String, room: any RoomModel, message m: ChatMessage, until: Int64) {
        // The server's room id is the core's to fill in (RoomModel does not carry it): "" until then.
        let e = entry(action, m, room: "", until: until, at: EpochMs.now)
        if let sink { sink.record(e, roomKey: room.key) } else {
            pending.append((e, room.key))
            if pending.count > 200 { pending.removeFirst(pending.count - 200) }
            log.debug("audit entry waits for the core's journal")
        }
    }

    static func flush() { sink?.flush() }

    /// The body's action as the server checks it (sanitizeMessageAudit).
    nonisolated static func entry(_ action: String, _ m: ChatMessage, room: String, until: Int64, at: Int64) -> JSONObject {
        var a = JSONObject([("action", .string(action)), ("messageId", .string(m.id)), ("room", .string(room)),
                            ("kinds", .array(BubbleKinds.of(m).map { .string($0) })), ("mine", .bool(m.mine)), ("at", .int(at))])
        if action == "hide" { a["until"] = .int(max(0, until)) }
        return a
    }
}
