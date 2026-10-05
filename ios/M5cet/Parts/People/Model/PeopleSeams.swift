// The People part's seams: what it needs from code other agents own, as narrow
// protocols with a default that does only what is possible without them. The real
// implementations plug in through PeopleParts (Bootstrap / the core):
//
//   PeopleRoomExtras     a room's WebRTC statistics and a forward verified by key (RoomSession.peerStats,
//                        forwardVerified) — the core's RoomController conforms
//   PeopleContacts       the address book (Platform/Contacts, ContactsService)
//   DetailsHiding        hiding / deleting a message in this view and the audit (ui/bubble/Hides, MessageAudit)
//   PeopleProfileService the signed-in account's profile card (profile/Profiles: vault + /api/profile)

import Foundation
import M5Core
import M5Crypto
import M5Proto

/// What People needs of a room beyond the RoomModel contract. A room without it shows its peers'
/// connection as "connecting" and a forward without the key check.
@MainActor
protocol PeopleRoomExtras: AnyObject {
    /// RoomSession.peerStats: the last WebRTC statistics of a peer (People's detail: transport, candidates, codec, bytes, DTLS).
    func peerStats(_ peerId: String) -> RtcStatsSummary?
    /// RoomSession.forwardVerified (6.12 P09): the forwarded message's original sender verified by their key.
    func forwardVerified(_ message: ChatMessage) -> Bool
    /// The profile card changed: share the new room view (Profiles.changed → RoomSession.profileChanged).
    func profileChanged()
}

// MARK: - the address book

/// A contact the person picked for a link.
struct PeopleContactPick: Sendable, Equatable {
    /// The contact's name as the address book shows it.
    let name: String
    /// Its stable identifier (CNContact.identifier — Android's lookup key).
    let identifier: String
}

/// The phone's contacts as People uses them (Android contacts/AddressBook + LinkActivity). iOS lets no app
/// put rows into the Contacts app; a link lives in the vault (`people.links`) with the contact's identifier.
@MainActor
protocol PeopleContacts: AnyObject {
    /// "Link to a contact": the person picks a contact for this M5cet username (nil: cancelled).
    func pickContact(for username: String, messageLabel: String, callLabel: String) async throws -> PeopleContactPick?
    /// A linked contact's photo (image data), nil without one or without access.
    func photo(identifier: String) async -> Data?
    /// What the app put into the address book for this username goes (the contact itself stays).
    func remove(username: String) async
    /// Every trace of the app in the address book goes (people.contacts off, unlink all, a wipe).
    func removeAll() async
    /// people.contacts on again: the links kept in the vault back where the address book needs them.
    func restore(links: [JSONObject]) async
}

// MARK: - hiding and deleting (MsgDetails)

/// Android ui/bubble/Hides + MessageAudit as the message details need them.
@MainActor
protocol DetailsHiding: AnyObject {
    /// Is the message hidden in this view now?
    func hidden(_ m: ChatMessage, now: Int64) -> Bool
    /// Hides it for DetailsHides.spans[choice]; logged for the audit.
    func hide(_ room: any RoomModel, _ m: ChatMessage, choice: Int)
    /// Shows a hidden message again before its time; logged.
    func unhide(_ room: any RoomModel, _ m: ChatMessage)
    /// Deletes it from this device (view and history); logged.
    func delete(_ room: any RoomModel, _ m: ChatMessage)
}

/// Hides of this device's view (6.2): 15 minutes, an hour, 8 hours, a day or until the next sign-in — the
/// next unlock: such a hide names the unlock it was made in, and every unlock (or a new start of the app)
/// begins a new one. The audit line (MessageAudit: only that it happened, never the text) goes through
/// `audit` when someone installs it.
@MainActor
final class DetailsHides: DetailsHiding, LockParticipant {
    /// The choices of the details view, in order; the "hidden" step's meta names them.
    static let spans: [Int64] = [15 * 60_000, 3_600_000, 8 * 3_600_000, 86_400_000, ChatMessage.untilSignIn]
    static let names = ["15m", "1h", "8h", "1d", "until-signin"]

    /// The unlock the app is in now (never stored: a new start is a new one).
    private(set) var unlock = DetailsHides.newUnlock()
    var now: () -> Int64 = { Millis.now }
    /// MessageAudit.add(action, room, message, until) — "hide", "unhide", "delete".
    var audit: (@MainActor (String, any RoomModel, ChatMessage, Int64) -> Void)?

    static func newUnlock() -> String { Crypto.b64url(Crypto.random(9)) }

    func lockDidUnlock() { unlock = Self.newUnlock() }

    func hidden(_ m: ChatMessage, now: Int64) -> Bool { Self.hidden(m, now: now, unlock: unlock) }

    static func hidden(_ m: ChatMessage, now: Int64, unlock: String) -> Bool {
        if m.hiddenUntil == ChatMessage.untilSignIn { return unlock == m.hiddenFor }
        return m.hiddenUntil > now
    }

    func hide(_ room: any RoomModel, _ m: ChatMessage, choice: Int) {
        let i = max(0, min(Self.spans.count - 1, choice))
        let span = Self.spans[i]
        let until = span == ChatMessage.untilSignIn ? ChatMessage.untilSignIn : now() + span
        room.hide(m.id, until: until, unlock: unlock, why: Self.names[i])
        audit?("hide", room, m, until == ChatMessage.untilSignIn ? 0 : until)
    }

    func unhide(_ room: any RoomModel, _ m: ChatMessage) {
        room.hide(m.id, until: 0, unlock: nil, why: "user")
        audit?("unhide", room, m, 0)
    }

    func delete(_ room: any RoomModel, _ m: ChatMessage) {
        audit?("delete", room, m, 0)
        room.deleteLocal(m.id)
    }
}
