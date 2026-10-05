// Hiding and deleting a message goes into the operator's audit journal (6.2;
// android ui/bubble/MessageAudit.java): POST …/message-audit, signed by the
// device key (Platform/Push's DeviceService.messageAudit, server/message-audit.ts).
// It says only THAT it happened — the action, the message's id, the room as the
// server knows it (it hashes it), the kinds, whether it was mine, until when —
// never the text or the file. Waiting actions are kept in the vault (user tier,
// record "msg-audit", like Android) and sent again later. People's message
// details (PeopleParts.defaultHides.audit) and the chat's bubbles feed it.

import Foundation
import M5Core
import M5Net
import M5Proto
import os

@MainActor
final class MessageAudit: MessageAuditSink {
    static let record = "msg-audit"
    static let max = 200
    /// The server takes device times up to a week back.
    static let keepMs: Int64 = 7 * 86_400_000

    private let records: any RecordVault
    /// The signed upload (DeviceService.messageAudit); nil: nothing goes (not enrolled with Push here) — they wait.
    var upload: (@MainActor ([NetJSON], String?) async throws -> Void)?
    /// The signed-in account's username ("" signed out).
    var account: @MainActor () -> String = { "" }
    /// A room's id as the hub knows it ("" while it is not connected).
    var roomId: @MainActor (String) -> String = { _ in "" }
    var now: () -> Int64 = { EpochMs.now }
    private var sending = false
    nonisolated static let log = Logger(subsystem: "cz.m5cet.app", category: "audit")

    init(records: any RecordVault) { self.records = records }

    /// One action; `until` = a hide's end (ms), 0 = until the next sign-in (and for unhide / delete). Kept at once, sent soon.
    func add(_ action: String, room: any RoomModel, message m: ChatMessage, until: Int64) {
        record(Self.entry(action, m, room: "", until: until, at: now()), roomKey: room.key)
    }

    /// MessageAuditSink (the chat's ChatMessageAudit): one entry to keep and send; the room's id is filled in here.
    func record(_ entry: JSONObject, roomKey: String) {
        var a = entry
        if a.optString("room").isEmpty { a["room"] = .string(roomId(roomKey)) }
        a["roomKey"] = .string(roomKey) // this device's, to find the room's id later; dropped before sending
        var q = queue()
        q.append(.object(a))
        if q.count > Self.max { q.removeFirst(q.count - Self.max) }
        save(q)
        flush()
    }

    /// The body's action as the server checks it (sanitizeMessageAudit).
    static func entry(_ action: String, _ m: ChatMessage, room: String, until: Int64, at: Int64) -> JSONObject {
        var a = JSONObject([("action", .string(action)), ("messageId", .string(m.id)), ("room", .string(room)),
                            ("kinds", .array(MsgDetailsModel.kindsOf(m).map { .string($0) })), ("mine", .bool(m.mine)), ("at", .int(at))])
        if action == "hide" { a["until"] = .int(Swift.max(0, until)) }
        return a
    }

    /// Sends what waits (a batch of up to 50); what the network kept back stays for the next time.
    func flush() {
        guard !sending, records.unlocked, let upload else { return }
        sending = true
        Task { @MainActor [weak self] in
            await self?.send(upload)
            self?.sending = false
        }
    }

    private func send(_ upload: @MainActor ([NetJSON], String?) async throws -> Void) async {
        guard records.unlocked else { return }
        let n = now()
        var keep = [JSON]()
        for x in queue() {
            guard var a = x.objectValue, n - a.optInt64("at") <= Self.keepMs else { continue }
            if a.optString("room").isEmpty {
                let id = roomId(a.optString("roomKey"))
                if !id.isEmpty { a["room"] = .string(id) } else if n - a.optInt64("at") > 600_000 { a["room"] = "local" } // the room never connected
            }
            keep.append(.object(a))
        }
        save(keep)
        var batch = [JSONObject]()
        for x in keep where batch.count < 50 {
            guard let a = x.objectValue else { continue }
            if a.optString("room").isEmpty { break } // in order: wait for the room's id
            batch.append(a.without("roomKey"))
        }
        if batch.isEmpty { return }
        let user = account()
        let name: String? = user.range(of: "^[A-Za-z0-9_.-]{1,64}$", options: .regularExpression) != nil ? user : nil
        do {
            try await upload(batch.compactMap { try? NetJSON.parse($0.stringify()) }, name)
            drop(batch)
        } catch let e as HTTPError {
            if e.status == 400 { drop(batch) } // the server will never take these
            Self.log.notice("message actions not recorded: \(e.status)")
        } catch {
            Self.log.notice("message actions wait")
        }
    }

    private static func id(_ a: JSONObject) -> String { a.optString("action") + "|" + a.optString("messageId") + "|" + String(a.optInt64("at")) }

    private func drop(_ sent: [JSONObject]) {
        let gone = Set(sent.map(Self.id))
        save(queue().filter { x in x.objectValue.map { !gone.contains(Self.id($0)) } ?? false })
    }

    private func queue() -> [JSON] { records.record(Self.record)?.array("q") ?? [] }

    private func save(_ q: [JSON]) { records.put(Self.record, JSONObject([("q", .array(q))])) }

    /// What waits (tests).
    var waiting: [JSONObject] { queue().compactMap(\.objectValue) }
}
