// What a room knows of its people from the server's frames and the hellos
// (android chat/PeerFacts.java, RoomPresence.java): usernames each hello
// claims, which connections are signed in (a room-scoped account reference),
// the signed-in members who are away, whether a join proved the room key,
// who is in the foreground and when the others were last seen, and the
// members whose connection went without a goodbye (held). Values owned by the
// room session; the UI reads copies.

import Foundation
import M5Core

/// cleanUsername() of username.ts (android contacts/Match): a short plain username, or "".
public func cleanUsername(_ value: JSON?) -> String {
    guard let v = value?.stringValue?.javaTrimmed, (3...64).contains(v.utf8.count) else { return "" }
    return v.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }) ? v : ""
}

/// `account` (protocol 2) or its alias `accountId`; "" when absent or null.
func accountRef(_ f: JSONObject) -> String {
    if let v = f.string("account"), !v.isEmpty { return v }
    return f.string("accountId") ?? ""
}

public struct PeerFacts: Sendable {
    public struct Facts: Sendable, Equatable {
        public var username = ""
        public var since: Int64 = 0
        /// An app / platform name, if the hello carries one.
        public var app = ""
    }

    public struct Away: Sendable, Equatable {
        public let account: String, name: String
        public let since: Int64
    }

    private var peers = [String: Facts]()
    /// peer id → the account reference the server gave for its connection.
    private var accounts = [String: String]()
    /// account reference → a signed-in member who is away.
    private var awayByRef = OrderedMap<String, Away>()
    /// account reference → the username its hello named.
    private var users = [String: String]()
    /// When this device joined the room (last "joined").
    public private(set) var joinedAt: Int64 = 0
    /// 6.12 (§ 13): peer id → did its join prove the room key (absent: the server does not say).
    private var provenBy = [String: Bool]()

    public init() {}

    public func proven(_ peerId: String) -> Bool? { provenBy[peerId] }
    public func get(_ peerId: String) -> Facts? { peers[peerId] }
    /// The account reference of a peer's connection, "" for a guest.
    public func account(_ peerId: String) -> String { accounts[peerId] ?? "" }
    public func user(ofAccount account: String) -> String { users[account] ?? "" }
    public var away: [Away] { awayByRef.orderedValues }

    private mutating func noteProven(_ p: JSONObject) {
        let id = p.optString("peerId")
        if id.isEmpty { return }
        if let v = p["proven"]?.boolValue { provenBy[id] = v } else { provenBy[id] = nil }
    }

    /// 6.12 review P04: key transparency does not show this username for the peer's account — the claim is not shown.
    public mutating func dropUsername(_ peerId: String) {
        guard var f = peers[peerId], !f.username.isEmpty else { return }
        let r = account(peerId)
        if !r.isEmpty && users[r] == f.username { users[r] = nil }
        f.username = ""
        peers[peerId] = f
    }

    /// A frame from the server (before the room handles it).
    public mutating func onFrame(_ f: JSONObject, now: Int64) {
        switch f.optString("type") {
        case "joined":
            joinedAt = now
            accounts.removeAll(); awayByRef.removeAll(); provenBy.removeAll()
            for p in f.array("peers") ?? [] {
                guard let p = p.objectValue else { continue }
                if !accountRef(p).isEmpty { accounts[p.optString("peerId")] = accountRef(p) }
                noteProven(p)
            }
            for a in f.array("away") ?? [] {
                guard let a = a.objectValue, !accountRef(a).isEmpty else { continue }
                awayByRef[accountRef(a)] = Away(account: accountRef(a), name: a.optString("name"), since: a.optInt64("since"))
            }
        case "peer-joined", "peer-updated":
            let id = f.optString("peerId"), r = accountRef(f)
            if id.isEmpty { break }
            if f.optString("type") == "peer-joined" { noteProven(f) }
            if r.isEmpty { accounts[id] = nil } else { accounts[id] = r }
            if !r.isEmpty, let x = peers[id], !x.username.isEmpty { users[r] = x.username }
        case "peer-away":
            let r = accountRef(f)
            if !r.isEmpty { awayByRef[r] = Away(account: r, name: f.optString("name"), since: f["since"] == nil ? now : f.optInt64("since")) }
        case "peer-back", "peer-gone": awayByRef.remove(accountRef(f))
        case "peer-left":
            let id = f.optString("peerId")
            peers[id] = nil; accounts[id] = nil; provenBy[id] = nil
        default: break
        }
    }

    /// An accepted hello: the username it names (a claim), the time the channel opened.
    public mutating func onHello(_ peerId: String, _ hello: JSONObject, now: Int64) {
        var x = peers[peerId] ?? Facts()
        x.username = cleanUsername(hello["user"])
        if x.since == 0 { x.since = now }
        if let app = hello.string("app") { x.app = String(app.prefix(60)) }
        peers[peerId] = x
        let r = account(peerId)
        if !r.isEmpty && !x.username.isEmpty { users[r] = x.username }
    }
}

public struct RoomPresence: Sendable {
    public struct Live: Sendable, Equatable {
        public let foreground: Bool
        public let lastSeen: Int64
    }

    public struct Held: Sendable, Equatable {
        public let peerId: String, name: String, account: String
        public let lastSeen: Int64, since: Int64
    }

    private var live = [String: Live]()
    /// In the order they went.
    private var heldMembers = OrderedMap<String, Held>()
    /// account reference → when the away member was last seen.
    private var away = [String: Int64]()

    public init() {}

    private static func time(_ f: JSONObject, _ key: String) -> Int64 { Int64(f.double(key) ?? 0) }

    private mutating func setLive(_ f: JSONObject) {
        let id = f.optString("peerId")
        if id.isEmpty { return }
        heldMembers.remove(id)
        // A server before 6.7 says nothing: the member counts as in the foreground.
        live[id] = Live(foreground: f.bool("foreground") ?? true, lastSeen: RoomPresence.time(f, "lastSeen"))
    }

    private mutating func setHeld(_ f: JSONObject) {
        let id = f.optString("peerId")
        if id.isEmpty { return }
        live[id] = nil
        heldMembers.remove(id)
        heldMembers[id] = Held(peerId: id, name: f.optString("name"), account: accountRef(f), lastSeen: RoomPresence.time(f, "lastSeen"), since: RoomPresence.time(f, "since"))
    }

    /// A frame from the server.
    public mutating func onFrame(_ f: JSONObject, now: Int64) {
        switch f.optString("type") {
        case "joined":
            live.removeAll(); heldMembers.removeAll(); away.removeAll()
            for p in f.array("peers") ?? [] { if let p = p.objectValue { setLive(p) } }
            for h in f.array("held") ?? [] { if let h = h.objectValue { setHeld(h) } }
            for a in f.array("away") ?? [] {
                guard let a = a.objectValue, !accountRef(a).isEmpty else { continue }
                away[accountRef(a)] = RoomPresence.time(a, "lastSeen") > 0 ? RoomPresence.time(a, "lastSeen") : RoomPresence.time(a, "since")
            }
        case "peer-joined": setLive(f)
        case "peer-presence":
            let id = f.optString("peerId")
            if !id.isEmpty { live[id] = Live(foreground: f.bool("foreground") ?? false, lastSeen: RoomPresence.time(f, "lastSeen")) }
        case "peer-left":
            if f.bool("held") == true { setHeld(f); break }
            let id = f.optString("peerId")
            live[id] = nil
            heldMembers.remove(id)
        case "peer-away":
            let r = accountRef(f)
            let seen = RoomPresence.time(f, "lastSeen") > 0 ? RoomPresence.time(f, "lastSeen") : RoomPresence.time(f, "since")
            if !r.isEmpty { away[r] = seen > 0 ? seen : now }
        case "peer-back", "peer-gone": away[accountRef(f)] = nil
        default: break
        }
    }

    /// A live member's presence; nil when the server said nothing of it.
    public func live(_ peerId: String) -> Live? { live[peerId] }

    /// When a relay-covered member was last seen; 0 when not known.
    public func awayLastSeen(_ account: String) -> Int64 { away[account] ?? 0 }

    /// Held members to list — not those listed already: live peers, or the relay's entry for the same account.
    public func held(excluding peerIds: Set<String>, awayAccounts: Set<String>) -> [Held] {
        heldMembers.orderedValues.filter { !peerIds.contains($0.peerId) && ($0.account.isEmpty || !awayAccounts.contains($0.account)) }
    }
}
