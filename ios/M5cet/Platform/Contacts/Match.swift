// Who a contact's "message / call via M5cet" reaches (6.2) — port of
// android/app/src/main/java/cz/m5cet/app/contacts/Match.java. A link holds an
// account's username (the main user identifier; a guest's per-session
// username is not one), so the person must be signed in: the server reports
// an account on their connection and their hello names the username. Of the
// connected rooms the active one wins, then the most recently active one.
//
// No phone numbers, no hashes and no server call are involved: Android links a
// person by their M5cet username only, and nothing of the address book leaves
// the phone. Pure (MatchTests). Candidate for M5Kit (M5Proto, next to PeerFacts).

import Foundation
import M5Core
import M5Proto

enum Match {
    /// How long a lookup waits for rooms and peers that are still connecting before it says "not online".
    static let waitMs: Int64 = 15_000

    enum Decision: String, Sendable {
        case found, wait, missing
    }

    /// cleanUsername() of username.ts: what a peer says its username is — short and plain, or nothing.
    static func cleanUsername(_ value: String?) -> String {
        M5Proto.cleanUsername(value.map { JSON.string($0) })
    }

    /// The same for any JSON value (a number or null is no username).
    static func cleanUsername(json value: JSON?) -> String { M5Proto.cleanUsername(value) }

    /// A person can be linked with a phone contact: signed in, with an account username.
    static func canLink(_ username: String?, signedIn: Bool) -> Bool {
        signedIn && !cleanUsername(username).isEmpty
    }

    /// The key a link is kept under (usernames are unique case-insensitively on the server).
    static func key(_ username: String?) -> String { cleanUsername(username).lowercased(with: Locale(identifier: "en_US_POSIX")) }

    /// One person of one connected room.
    struct Candidate: Sendable, Equatable {
        var roomKey: String
        var peerId: String
        var username: String
        var signedIn: Bool
        var open: Bool
        var activeRoom: Bool
        var roomActivity: Int64

        init(roomKey: String, peerId: String, username: String?, signedIn: Bool, open: Bool, activeRoom: Bool, roomActivity: Int64) {
            self.roomKey = roomKey
            self.peerId = peerId
            self.username = username ?? ""
            self.signedIn = signedIn
            self.open = open
            self.activeRoom = activeRoom
            self.roomActivity = roomActivity
        }
    }

    /// The person to reach: this username, signed in, a channel open; the active room first, then the most
    /// recently active. nil = nobody.
    static func pick(_ candidates: [Candidate]?, username: String?) -> Candidate? {
        let want = key(username)
        guard !want.isEmpty, let candidates else { return nil }
        var best: Candidate?
        for c in candidates where c.open && c.signedIn && key(c.username) == want {
            if let b = best { if better(c, b) { best = c } } else { best = c }
        }
        return best
    }

    private static func better(_ a: Candidate, _ b: Candidate) -> Bool {
        if a.activeRoom != b.activeRoom { return a.activeRoom }
        return a.roomActivity > b.roomActivity
    }

    /// found: act; wait: rooms or peers are still settling and the lookup has not waited `waitMs` yet;
    /// missing: say that the person is not online.
    static func decide(found: Bool, settling: Bool, startedAt: Int64, now: Int64) -> Decision {
        if found { return .found }
        return settling && now - startedAt < waitMs ? .wait : .missing
    }
}
