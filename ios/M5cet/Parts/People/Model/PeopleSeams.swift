// The People part's seams: what it needs from code other agents own, as narrow
// protocols with a default that does only what is possible without them. The real
// implementations plug in through PeopleParts (Bootstrap / the core):
//
//   PeopleRoomExtras     a room's WebRTC statistics and a forward verified by key (RoomSession.peerStats,
//                        forwardVerified) — the core's RoomController conforms
//   PeopleContacts       the address book (Platform/Contacts' ContactsService conforms)
//   DetailsHiding        hiding / deleting a message in this view and the audit (ui/bubble/Hides, MessageAudit)
//   PeopleProfileService the signed-in account's profile card (profile/Profiles: vault + /api/profile)

import Contacts
import ContactsUI
import Foundation
import M5Core
import M5Crypto
import M5Proto
import os

/// The part's log lines (os.Logger, subsystem cz.m5cet.app, category people) — never a name or a key.
enum PeopleLog {
    static let logger = os.Logger(subsystem: "cz.m5cet.app", category: "people")
    static func warn(_ s: String) { logger.notice("\(s, privacy: .public)") }
}

/// org.json's lenient number reads the Java code relies on (optDouble then a cast).
enum PeopleJSON {
    /// `(long) o.optDouble(key, fallback)`: a number truncated toward zero, else the fallback.
    static func long(_ o: JSONObject, _ key: String, _ fallback: Int64 = 0) -> Int64 {
        guard let d = o.double(key), d.isFinite else { return fallback }
        if d >= 9.2e18 { return Int64.max }
        if d <= -9.2e18 { return Int64.min }
        return Int64(d)
    }
}

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

/// The phone's contacts as People uses them (Android contacts/AddressBook + LinkActivity + Store) — the
/// app's ContactsService (Platform/Contacts) conforms below. iOS lets no app put rows into the Contacts app:
/// a link lives in the vault (`people.links`, the contact's identifier) and the system's suggestions
/// (donated interactions) stand in for Android's "Message / Call via M5cet" rows.
@MainActor
protocol PeopleContacts: AnyObject {
    /// The system's question for reading contacts (only when never asked) — on the person's action.
    func requestAccess() async -> Bool
    /// The person picks a contact (the system's picker: out of process, no permission needed); nil = cancelled.
    func pickContact() async -> ContactCard?
    /// Links an account's username with the picked contact: the contact's name, nil when it cannot be linked.
    @discardableResult func link(username: String, signedIn: Bool, contact: ContactCard, enabled: Bool) -> String?
    func unlink(username: String)
    func unlinkAll()
    /// people.contacts switched (off: the suggestions go, the links stay).
    func setEnabled(_ on: Bool)
    /// A linked contact's photo (image data), read off the main actor; nil without one or without access.
    func contactPhoto(of username: String) async -> Data?
}

extension ContactsService: PeopleContacts {
    func pickContact() async -> ContactCard? { await ContactPicker.pick() }

    func contactPhoto(of username: String) async -> Data? {
        guard let id = identifier(of: username) else { return nil }
        let access = contacts
        return await Task.detached(priority: .utility) { access.contact(id)?.thumbnail }.value
    }
}

/// "Link to a contact": the system's contact picker (CNContactPickerViewController) over the app.
@MainActor
enum ContactPicker {
    private static var delegate: Delegate?

    static func pick() async -> ContactCard? {
        guard let top = SecureDialog.topController() else { return nil }
        return await withCheckedContinuation { (done: CheckedContinuation<ContactCard?, Never>) in
            let d = Delegate { card in
                delegate = nil
                done.resume(returning: card)
            }
            delegate = d
            let picker = CNContactPickerViewController()
            picker.delegate = d
            top.present(picker, animated: true)
        }
    }

    @MainActor
    private final class Delegate: NSObject, @preconcurrency CNContactPickerDelegate {
        let done: @MainActor (ContactCard?) -> Void
        init(done: @escaping @MainActor (ContactCard?) -> Void) { self.done = done }
        func contactPickerDidCancel(_ picker: CNContactPickerViewController) { done(nil) }
        func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) { done(SystemContactStore.card(of: contact)) }
    }
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
