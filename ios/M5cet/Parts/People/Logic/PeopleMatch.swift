// 6.2 Contacts: who a phone contact's "message / call via M5cet" goes to (port of
// android/…/contacts/Match.java). A link holds an account's username (the main
// user identifier; a guest's per-session username is not one), so the person must
// be signed in: the server reports an account on their connection and their hello
// names the username. Of the connected rooms the active one wins, then the most
// recently active one.

import Foundation
import M5Core

enum PeopleMatch {
    /// How long a lookup waits for rooms and peers that are still connecting before it says "not online".
    static let waitMs: Int64 = 15_000

    static let found = "found", wait = "wait", missing = "missing"

    /// cleanUsername() of username.ts: what a peer says its username is — short and plain, or nothing.
    static func cleanUsername(_ value: Any?) -> String {
        guard let s = value as? String else { return "" }
        let v = s.javaTrimmed
        guard (3...64).contains(v.unicodeScalars.count),
              v.unicodeScalars.allSatisfy({ ($0 >= "A" && $0 <= "Z") || ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || $0 == "_" || $0 == "-" })
        else { return "" }
        return v
    }

    /// A person can be linked with a phone contact: signed in, with an account username.
    static func canLink(_ username: String?, signedIn: Bool) -> Bool { signedIn && !cleanUsername(username).isEmpty }

    /// The key a link is kept under (usernames are unique case-insensitively on the server).
    static func key(_ username: String?) -> String { cleanUsername(username).lowercased(with: Locale(identifier: "en_US_POSIX")) }

    /// One person of one connected room.
    struct Candidate: Equatable {
        let roomKey: String, peerId: String, username: String
        let signedIn: Bool, open: Bool, activeRoom: Bool
        let roomActivity: Int64
    }

    /// The person to reach: this username, signed in, a channel open; the active room first, then the
    /// most recently active. nil = nobody.
    static func pick(_ candidates: [Candidate], _ username: String?) -> Candidate? {
        let want = key(username)
        if want.isEmpty { return nil }
        var best: Candidate?
        for c in candidates where c.open && c.signedIn && key(c.username) == want {
            if let b = best, !better(c, b) { continue }
            best = c
        }
        return best
    }

    private static func better(_ a: Candidate, _ b: Candidate) -> Bool {
        if a.activeRoom != b.activeRoom { return a.activeRoom }
        return a.roomActivity > b.roomActivity
    }

    /// found: act; wait: rooms or peers are still settling and the lookup has not waited waitMs yet;
    /// missing: say that the person is not online.
    static func decide(found: Bool, settling: Bool, startedAt: Int64, now: Int64) -> String {
        if found { return Self.found }
        return settling && now - startedAt < waitMs ? wait : missing
    }
}
