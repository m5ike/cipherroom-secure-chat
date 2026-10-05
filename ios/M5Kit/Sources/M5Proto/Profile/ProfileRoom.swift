// 6.7: profiles inside a room, as the web speaks them — a port of android
// profile/ProfileRoom.java (client/src/lib/profile/room.ts). What a member
// marked "room members" (and "public") travels as a payload {kind:"profile"}
// sealed with the pair key to one peer at a time — never the room key, never
// through the server:
//
//   announce  {rev}              my profile's version ("" = none), to a peer
//                                whose hello offered caps "profile", and to
//                                everyone when it changes
//   request   {rev, want:true}   "send me that one"
//   full      {rev, profile}     the view (ProfileCard.normalizeShared on arrival)
//
// The Cache keeps what came by the sender's device key and rev, so another
// member cannot plant a copy under someone else's version.

import M5Core
import Synchronization

/// The room's profile frames (android `profile/ProfileRoom.java`).
public enum ProfileRoom {
    public static let cap = "profile"
    /// A sealed frame longer than this goes again without the background.
    public static let frameMaxChars = 240_000
    /// A peer asking for the same version again within this long gets no second copy.
    public static let answerEveryMs: Int64 = 30_000

    /// ^[0-9a-z]{0,40}$.
    private static func isRev(_ s: String) -> Bool {
        let u = s.utf16
        return u.count <= 40 && u.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x7A) }
    }

    /// The profile part of a checked payload, or nil: {rev} / {rev, want} / {rev, profile}.
    public static func parse(_ p: JSONObject?) -> JSONObject? {
        guard let p, case .string(let rev)? = p["rev"], isRev(rev) else { return nil }
        if p.orgBool("want") { return rev.isEmpty ? nil : JSONObject([("rev", .string(rev)), ("want", true)]) }
        if p.has("profile") {
            guard let profile = ProfileCard.normalizeShared(p["profile"]), !rev.isEmpty else { return nil }
            return JSONObject([("rev", .string(rev)), ("profile", .object(profile))])
        }
        return JSONObject([("rev", .string(rev))])
    }

    /// {rev} of my view ("" without one).
    public static func announce(_ view: JSONObject?) -> JSONObject {
        JSONObject([("rev", .string(view?.orgString("rev") ?? ""))])
    }

    /// The full frame; `lite` leaves the background out.
    public static func full(_ view: JSONObject, _ lite: Bool) -> JSONObject {
        let v = lite ? view.without("cover") : view
        return JSONObject([("rev", .string(view.orgString("rev"))), ("profile", .object(v))])
    }

    /// What Cache.announced decided.
    public enum Announced: String, Sendable {
        /// Known: taken from the cache.
        case cached
        /// Unknown: ask the peer for it.
        case request
        /// The peer has no profile (any more).
        case cleared
        /// Nothing changed.
        case same
    }

    /// What this phone knows of the other members' profiles (shared by every room), least recently used out first.
    public final class Cache: Sendable {
        private struct Store {
            /// owner|rev keys, least recently used first.
            var order: [String] = []
            var byKey: [String: JSONObject] = [:]
            /// peer id → owner|rev
            var peers: [String: String] = [:]

            mutating func touch(_ key: String) {
                if let i = order.firstIndex(of: key) { order.remove(at: i) }
                order.append(key)
            }
        }

        private let max: Int
        private let store = Mutex(Store())

        public init(_ max: Int) { self.max = max }

        public func announced(_ peerId: String, _ owner: String?, _ rev: String?) -> Announced {
            store.withLock { s in
                let before = s.peers[peerId]
                guard let rev, !rev.isEmpty, let owner, !owner.isEmpty else {
                    if before == nil { return .same }
                    s.peers[peerId] = nil
                    return .cleared
                }
                let key = owner + "|" + rev
                if key == before && s.byKey[key] != nil { return .same }
                if s.byKey[key] != nil { s.peers[peerId] = key; s.touch(key); return .cached }
                return .request
            }
        }

        @discardableResult
        public func received(_ peerId: String, _ owner: String?, _ frame: JSONObject?) -> JSONObject? {
            guard let profile = frame?.object("profile"), let rev = frame?.orgString("rev"), !rev.isEmpty, let owner, !owner.isEmpty else { return nil }
            let key = owner + "|" + rev
            store.withLock { s in
                s.byKey[key] = profile
                s.touch(key)
                s.peers[peerId] = key
                while s.byKey.count > max, let eldest = s.order.first {
                    s.order.removeFirst()
                    s.byKey[eldest] = nil
                }
            }
            return profile
        }

        public func of(_ peerId: String) -> JSONObject? {
            store.withLock { s in
                guard let key = s.peers[peerId], let v = s.byKey[key] else { return nil }
                s.touch(key)
                return v
            }
        }

        public func forget(_ peerId: String) { store.withLock { $0.peers[peerId] = nil } }

        public func clear() { store.withLock { $0 = Store() } }
    }

    /// What the exchange needs from its room.
    public protocol Deps: Sendable {
        /// Seals the frame with the pair key and sends it to that one peer; false when it could not go (or would not fit).
        func send(_ peerId: String, _ frame: JSONObject) -> Bool
        /// What room members may see of me now (nil: nothing).
        func myView() -> JSONObject?
        /// The peer's device key (the cache's owner) — nil before its hello was accepted.
        func ownerOf(_ peerId: String) -> String?
        func now() -> Int64
    }

    /// The protocol between this phone and the peers of one room. Its state is
    /// locked; the room's sends happen outside the lock (they may come back
    /// into this exchange, as a loop-back peer does in the tests).
    public final class Exchange: Sendable {
        public let cache: Cache
        private let deps: any Deps

        private struct State {
            var peers = Set<String>()
            var answered = [String: Int64]()
            /// The version asked of each peer: only that copy is taken (nobody fills the cache unasked).
            var asked = [String: String]()
            /// The account key that signed each peer's messages (a public profile's is compared with it).
            var accountKeys = [String: String]()
        }

        private let state = Mutex(State())

        public init(_ cache: Cache, _ deps: any Deps) { self.cache = cache; self.deps = deps }

        public func speaks(_ peerId: String) -> Bool { state.withLock { $0.peers.contains(peerId) } }

        /// Their hello was accepted: if they speak profiles, they learn my rev.
        public func hello(_ peerId: String, _ caps: [JSON]?) {
            let yes = (caps ?? []).contains { Js.orgText($0) == ProfileRoom.cap }
            if !yes { state.withLock { _ = $0.peers.remove(peerId) }; return }
            state.withLock { _ = $0.peers.insert(peerId) }
            _ = deps.send(peerId, announce(deps.myView()))
        }

        public func receive(_ peerId: String, _ frame: JSONObject?) {
            guard let owner = deps.ownerOf(peerId), !owner.isEmpty, let frame else { return }
            let rev = frame.orgString("rev")
            if frame.orgBool("want") {
                guard let view = deps.myView(), rev == view.orgString("rev") else { return }
                let key = peerId + "|" + rev
                let now = deps.now()
                let go = state.withLock { s -> Bool in
                    if let last = s.answered[key], now - last < answerEveryMs { return false }
                    s.answered[key] = now
                    return true
                }
                if go && !deps.send(peerId, full(view, false)) { _ = deps.send(peerId, full(view, true)) }
                return
            }
            if frame.has("profile") {
                let take = state.withLock { s -> Bool in
                    guard s.asked[peerId] == rev else { return false }
                    s.asked[peerId] = nil
                    return true
                }
                if take { cache.received(peerId, owner, frame) }
                return
            }
            if cache.announced(peerId, owner, rev) == .request {
                state.withLock { $0.asked[peerId] = rev }
                _ = deps.send(peerId, JSONObject([("rev", .string(rev)), ("want", true)]))
            }
        }

        /// My profile changed (saved, loaded, signed out): everyone who speaks profiles learns the new rev.
        public func changed() {
            let frame = announce(deps.myView())
            for peerId in state.withLock({ Array($0.peers) }) { _ = deps.send(peerId, frame) }
        }

        public func signedBy(_ peerId: String, _ accountKey: String?) {
            guard let accountKey, !accountKey.isEmpty else { return }
            state.withLock { $0.accountKeys[peerId] = accountKey }
        }

        public func accountKey(_ peerId: String) -> String { state.withLock { $0.accountKeys[peerId] ?? "" } }

        public func forget(_ peerId: String) {
            state.withLock { s in
                s.peers.remove(peerId)
                s.asked[peerId] = nil
                s.accountKeys[peerId] = nil
                let prefix = peerId + "|"
                s.answered = s.answered.filter { !$0.key.utf16.starts(with: prefix.utf16) }
            }
            cache.forget(peerId)
        }
    }
}
