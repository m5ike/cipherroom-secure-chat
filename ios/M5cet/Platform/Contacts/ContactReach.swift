// "Message / call via M5cet" for a linked contact (6.2) — port of
// android/app/src/main/java/cz/m5cet/app/contacts/ContactIntents.java. Android
// takes the Contacts app's row (ACTION_VIEW on the M5cet MIME types); iOS takes
// the Siri / share-sheet / contact-card intent or an m5cet://people link
// (ContactsService). Once the app is unlocked the username is looked for in the
// connected rooms — waiting a little while rooms and peers are still connecting
// (Match.waitMs) — and the person gets a private message (their room opens,
// only they are selected, the composer has the focus) or, after a confirmation,
// a call. When they are not online anywhere, the app says so.
//
// A request acts only for a username linked in this app (PeopleStore), so
// another app (or a crafted link) cannot make it reach whoever it likes. One
// request at a time (a newer one replaces it); given up after 5 minutes.

import Foundation
import M5Core

enum ContactReachKind: String, Sendable { case message, call }

/// One connected room as the reach sees it (RoomSession.peopleScope on Android).
struct ContactReachRoom: Sendable {
    var key: String
    var label: String
    /// Rooms or peers are still connecting (RoomSession.peopleSettling).
    var settling: Bool
    var lastActivity: Int64
    /// The people of the room (peopleScope entries: id, username, signedIn, channel, me).
    var people: [JSONObject]
}

/// What the reach needs of the app (the integration: rooms, lock, screens, design texts, navigation).
@MainActor
protocol ContactReachHost: AnyObject {
    /// The app is unlocked and on its screens (not the splash, lock or enrolment screen).
    var ready: Bool { get }
    /// Settings › People › Link with contacts (people.contacts).
    var contactsEnabled: Bool { get }
    /// The room on screen (its key), nil when none.
    var activeRoom: String? { get }
    func connectedRooms() -> [ContactReachRoom]
    /// The design's text for a key.
    func text(_ key: String) -> String
    /// A flash message (info, warn…).
    func notice(_ text: String, level: String)
    /// The person was found: open their room and — message — select only them with the composer focused,
    /// or — call — ask first ("people.callAsk") and start the room's call (calls are the room's, as on the web).
    func reach(_ kind: ContactReachKind, roomKey: String, peerId: String, username: String)
}

@MainActor
final class ContactReach {
    private struct Pending {
        let username: String
        let kind: ContactReachKind
        let at: Int64
        var searchSince: Int64 = 0
        var told = false
    }

    weak var host: (any ContactReachHost)?
    private let store: PeopleStore
    private let scheduler: any DictationScheduler
    private let clock: any Clock
    private var pending: Pending?
    private var loop = 0

    init(store: PeopleStore, scheduler: any DictationScheduler = MainQueueScheduler(), clock: any Clock = SystemClock()) {
        self.store = store
        self.scheduler = scheduler
        self.clock = clock
    }

    /// A request from Contacts / Siri / a link: reach `username` (as the intent named it).
    func accept(username: String, kind: ContactReachKind) {
        pending = Pending(username: username, kind: kind, at: clock.now())
        loop += 1
        later(loop, 300)
    }

    var waiting: Bool { pending != nil }

    private func later(_ g: Int, _ ms: Int64) {
        _ = scheduler.post(ms) { [weak self] in self?.tick(g) }
    }

    private func fill(_ text: String, _ name: String, _ room: String) -> String {
        text.replacingOccurrences(of: "{name}", with: name).replacingOccurrences(of: "{room}", with: room)
    }

    private func drop(_ host: any ContactReachHost, _ key: String?, _ level: String, name: String = "") {
        pending = nil
        if let key { host.notice(fill(host.text(key), name, ""), level: level) }
    }

    private func tick(_ g: Int) {
        guard var p = pending, g == loop, let host else { return }
        let now = clock.now()
        if now - p.at > 5 * 60_000 { pending = nil; return }
        // First the app is unlocked and on its screens.
        if !host.ready { later(g, 600); return }
        if !host.contactsEnabled { drop(host, "people.contactsOff", "warn"); return }
        guard let link = store.link(p.username) else { drop(host, "people.notLinked", "warn"); return }
        let contact = link.optString("contact")
        let name = contact.isEmpty ? p.username : contact
        let rooms = host.connectedRooms()
        if rooms.isEmpty { drop(host, "people.noRooms", "warn", name: name); return }
        var candidates = [Match.Candidate]()
        var settling = false
        for r in rooms {
            settling = settling || r.settling
            for u in r.people where u.bool("me") != true {
                candidates.append(Match.Candidate(roomKey: r.key, peerId: u.optString("id"), username: u.optString("username"),
                                                  signedIn: u.bool("signedIn") ?? false, open: u.optString("channel") == "open",
                                                  activeRoom: r.key == host.activeRoom, roomActivity: r.lastActivity))
            }
        }
        if p.searchSince == 0 { p.searchSince = now }
        let found = Match.pick(candidates, username: p.username)
        switch Match.decide(found: found != nil, settling: settling, startedAt: p.searchSince, now: now) {
        case .found:
            pending = nil
            host.reach(p.kind, roomKey: found!.roomKey, peerId: found!.peerId, username: p.username)
        case .wait:
            if !p.told { p.told = true; host.notice(fill(host.text("people.searching"), name, ""), level: "info") }
            pending = p
            later(g, 700)
        case .missing:
            drop(host, "people.notOnline", "warn", name: name)
        }
    }
}
