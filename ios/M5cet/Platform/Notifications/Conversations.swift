// The rooms as conversations on iOS (Android telecom/Conversations, 6.8). Android
// publishes long-lived shortcuts; iOS learns conversations from the app's
// Communication Notifications and donated INSendMessageIntents (Siri's
// suggestions, the share sheet, Focus breakthrough). What carries over:
//
//   ids        "conv-" + 80 bits of HMAC(install secret, room key) — the thread id and the intent's
//              conversation id; nothing of the name (SYS record "conversations" {k, named})
//   names      only while wanted (conversations.on / .names), the app unlocked and notifications may name
//              the room (ConversationPlan.names); else no group name at all
//   the lock   donations that carried names are deleted when the app locks (a name must not outlive the
//              lock — G-24); switched off: all of them
//   rooms gone their donations are deleted (INInteraction.delete(with: group id))
//   threads    the server's opaque room id → the room's thread id (SYS record "threads"), so a notification
//              the extension draws joins the room's thread without knowing the room
//
// Android's shortcut list (launcher, direct share targets) has no iOS counterpart; the share sheet's
// suggestions come from the donations.

import Foundation
import Intents
import M5Net
import OSLog

@MainActor
final class Conversations {
    private let store: (any SyncStateStore)?
    private var cachedSecret: Data?
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "conversations")
    /// The switches (conversations.on / .names) and the privacy rank of messages.
    var on: () -> Bool = { true }
    var namesWanted: () -> Bool = { true }
    var privacyRank: () -> Int = { 3 }
    var isLocked: () -> Bool = { false }
    /// Deletes donations (tests replace it).
    var deleteDonations: ([String]?) -> Void = { ids in
        if let ids { INInteraction.delete(with: ids) } else { INInteraction.deleteAll() }
    }

    init(store: (any SyncStateStore)?) { self.store = store }

    private var record: NetJSON { store?.loadNow(ThreadIds.record) ?? .object([:]) }

    /// The key of the ids, made once per install (a fresh one in memory when it cannot be kept).
    var secret: Data {
        if let cachedSecret { return cachedSecret }
        if let k = ThreadIds.secret(fromRecord: record.foundation) {
            cachedSecret = k
            return k
        }
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        store?.saveNow(ThreadIds.record, record.with("k", .string(hex)))
        let k = ThreadIds.secret(fromRecord: store?.loadNow(ThreadIds.record)?.foundation) ?? Data(bytes)
        cachedSecret = k
        return k
    }

    /// A room's conversation and thread id.
    func id(_ roomKey: String) -> String { ConversationPlan.id(secret, roomKey) }

    /// The room a conversation id stands for, among the rooms the app has (Android Conversations.roomOf).
    func room(of id: String, among keys: [String]) -> String? {
        guard id.hasPrefix(ConversationPlan.prefix) else { return nil }
        return keys.first { self.id($0) == id }
    }

    /// Whether the room's name may show now.
    var namesNow: Bool { on() && ConversationPlan.names(wanted: namesWanted(), locked: isLocked(), privacyRank: privacyRank()) }

    /// A room connected and knows its id on the server: notifications the extension draws for it join its thread.
    func noteServerRoom(roomKey: String, serverId: String) {
        guard !serverId.isEmpty, let store else { return }
        let k = ThreadIds.serverRoom(secret: secret, serverRoomId: serverId)
        var t = store.loadNow("threads")?.obj("t")?.objectValue ?? [:]
        let v = id(roomKey)
        if t[k]?.stringValue == v { return }
        t[k] = .string(v)
        if t.count > 256 { for key in t.keys.sorted().prefix(t.count - 256) { t.removeValue(forKey: key) } }
        store.saveNow("threads", ["t": .object(t)])
    }

    /// The thread a server room id belongs to (the room's, when the app noted it).
    func thread(forServerRoom serverId: String) -> String {
        let k = ThreadIds.serverRoom(secret: secret, serverRoomId: serverId)
        return store?.loadNow("threads")?.obj("t")?.str(k).nilIfEmpty ?? k
    }

    /// A donation that carried a name was made (the lock deletes it).
    func donatedNamed() {
        guard !record.bool("named") else { return }
        store?.saveNow(ThreadIds.record, record.with("named", true))
    }

    var hasNamedDonations: Bool { record.bool("named") }

    /// The app locked (or started locked): names go — every donation (the extension's too: it cannot note them).
    func locked() {
        deleteDonations(nil)
        store?.saveNow(ThreadIds.record, record.with("named", false))
        logger.info("named conversations removed (locked)")
    }

    /// Rooms left, deleted or renamed: their donations go. Switched off: all.
    func roomsGone(_ keys: [String]) {
        if keys.isEmpty { return }
        deleteDonations(keys.map(id))
    }

    func switchedOff() {
        deleteDonations(nil)
        store?.saveNow(ThreadIds.record, record.with("named", false))
    }
}
