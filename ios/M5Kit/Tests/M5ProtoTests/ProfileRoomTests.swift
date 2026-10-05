// 6.7: the room's profile frames — android profile/ProfileRoomTest (the
// web's test/profile-room.test.ts): two phones speak announce → request →
// full over a fake pair channel; only the room view travels, the cache is
// keyed by the sender's device key, a repeated request gets no second copy, a
// frame too large goes without the background.

import M5Core
import M5Proto
import Synchronization
import Testing

/// The fake pair channel: every frame is recorded, parsed as a payload and handed to the other node at once.
final class ProfileWire: Sendable {
    struct State {
        var frames: [(from: String, to: String, json: String)] = []
        var nodes: [String: ProfileRoom.Exchange] = [:]
        var now: Int64 = 1_000
        var fits: @Sendable (JSONObject) -> Bool = { _ in true }
    }

    let state = Mutex(State())

    var frames: [(from: String, to: String, json: String)] { state.withLock { $0.frames } }
    func clearFrames() { state.withLock { $0.frames.removeAll() } }
    func advance(_ ms: Int64) { state.withLock { $0.now += ms } }
    func setFits(_ f: @escaping @Sendable (JSONObject) -> Bool) { state.withLock { $0.fits = f } }

    /// A phone whose room view is what `view` holds.
    func node(_ me: String, _ view: ProfileViewBox) -> ProfileRoom.Exchange {
        let x = ProfileRoom.Exchange(ProfileRoom.Cache(16), ProfileNodeDeps(me: me, wire: self, view: view))
        state.withLock { $0.nodes[me] = x }
        return x
    }

    func send(_ from: String, _ to: String, _ frame: JSONObject) -> Bool {
        let fits = state.withLock { $0.fits }
        if !fits(frame) { return false }
        let text = frame.stringify()
        let peer = state.withLock { s -> ProfileRoom.Exchange? in
            s.frames.append((from, to, text))
            return s.nodes[to]
        }
        if let parsed = ProfileRoom.parse(JSON.parseObject(text)) { peer?.receive(from, parsed) }
        return true
    }
}

/// What a node's room view is now (the tests change it).
final class ProfileViewBox: Sendable {
    let view: Mutex<JSONObject?>
    init(_ v: JSONObject?) { view = Mutex(v) }
    func set(_ v: JSONObject?) { view.withLock { $0 = v } }
}

struct ProfileNodeDeps: ProfileRoom.Deps {
    let me: String
    let wire: ProfileWire
    let view: ProfileViewBox

    func send(_ peerId: String, _ frame: JSONObject) -> Bool { wire.send(me, peerId, frame) }
    func myView() -> JSONObject? { view.view.withLock { $0 } }
    func ownerOf(_ peerId: String) -> String? { "devkey-" + peerId }
    func now() -> Int64 { wire.state.withLock { $0.now } }
}

@Suite("profile ProfileRoom")
struct ProfileRoomTests {
    private let caps: [JSON] = ["bin", "profile"]

    @Test func onlyTheRoomViewTravels() throws {
        let w = ProfileWire()
        let alice = w.node("alice", ProfileViewBox(ProfileCard.viewFor(profileCard(), "room")))
        let bob = w.node("bob", ProfileViewBox(nil))
        bob.hello("alice", caps)
        alice.hello("bob", caps)
        let got = try #require(bob.cache.of("alice"))
        #expect(got.optString("nickname") == "Alice")
        let all = w.frames.map(\.json).joined()
        #expect(!all.contains("+420 777 123 456"))
        #expect(!all.contains("audience"))
    }

    @Test func aPeerWithoutTheCapabilityGetsNothing() {
        let w = ProfileWire()
        let alice = w.node("alice", ProfileViewBox(ProfileCard.viewFor(profileCard(), "room")))
        _ = w.node("bob", ProfileViewBox(nil))
        alice.hello("bob", ["bin"])
        #expect(w.frames.isEmpty)
        #expect(!alice.speaks("bob"))
    }

    @Test func aKnownVersionComesFromTheCache() {
        let w = ProfileWire()
        let alice = w.node("alice", ProfileViewBox(ProfileCard.viewFor(profileCard(), "room")))
        let bob = w.node("bob", ProfileViewBox(nil))
        alice.hello("bob", caps)
        bob.forget("alice")
        #expect(bob.cache.of("alice") == nil)
        w.clearFrames()
        alice.hello("bob", caps)
        #expect(w.frames.count == 1)
        #expect(bob.cache.of("alice") != nil)
    }

    @Test func changesAreAnnouncedAndNothingClears() throws {
        let view = ProfileViewBox(ProfileCard.viewFor(profileCard(), "room"))
        let w = ProfileWire()
        let alice = w.node("alice", view)
        let bob = w.node("bob", ProfileViewBox(nil))
        alice.hello("bob", caps)
        var changed = profileCard()
        changed["about"] = .object(try #require(changed.object("about")).with("value", "New text"))
        view.set(ProfileCard.viewFor(changed, "room"))
        alice.changed()
        #expect(bob.cache.of("alice")?.optString("about") == "New text")
        view.set(nil)
        alice.changed()
        #expect(bob.cache.of("alice") == nil)
    }

    private func fulls(_ w: ProfileWire) -> Int { w.frames.filter { $0.json.contains("\"profile\"") }.count }

    @Test func aRepeatedRequestGetsNoSecondCopy() {
        let view = ProfileCard.viewFor(profileCard(), "room")
        let w = ProfileWire()
        let alice = w.node("alice", ProfileViewBox(view))
        _ = w.node("bob", ProfileViewBox(nil))
        let want = JSONObject([("want", true), ("rev", .string(view.optString("rev")))])
        alice.receive("bob", want)
        alice.receive("bob", want)
        #expect(fulls(w) == 1)
        w.advance(ProfileRoom.answerEveryMs + 1)
        alice.receive("bob", want)
        #expect(fulls(w) == 2)
        alice.receive("bob", profileObj("{\"rev\":\"0000000000000000\",\"want\":true}"))
        #expect(fulls(w) == 2)
    }

    @Test func tooLargeGoesWithoutTheBackground() throws {
        var card = profileCard()
        card["cover"] = .object(try #require(card.object("cover")).with("audience", "room"))
        let w = ProfileWire()
        w.setFits { f in f.object("profile") == nil || !f.object("profile")!.has("cover") }
        let alice = w.node("alice", ProfileViewBox(ProfileCard.viewFor(card, "room")))
        let bob = w.node("bob", ProfileViewBox(nil))
        alice.hello("bob", caps)
        #expect(bob.cache.of("alice")?.has("avatar") == true)
        #expect(bob.cache.of("alice")?.has("cover") == false)
    }

    @Test func aCopyNobodyAskedForIsNotTaken() {
        let view = ProfileCard.viewFor(profileCard(), "room")
        let w = ProfileWire()
        _ = w.node("alice", ProfileViewBox(view))
        let bob = w.node("bob", ProfileViewBox(nil))
        bob.receive("alice", ProfileRoom.parse(ProfileRoom.full(view, false)))
        #expect(bob.cache.of("alice") == nil)
    }

    @Test func nobodyPlantsACopyUnderSomeoneElsesVersion() {
        let cache = ProfileRoom.Cache(8)
        let real = ProfileCard.viewFor(profileCard(), "room")
        cache.received("mallory", "devkey-mallory", JSONObject([("rev", .string(real.optString("rev"))), ("profile", .object(profileObj("{\"v\":1,\"nickname\":\"Not Alice\",\"fields\":[]}")))]))
        #expect(cache.announced("alice", "devkey-alice", real.optString("rev")) == .request)
        #expect(cache.of("alice") == nil)
    }

    @Test func framesAreChecked() throws {
        #expect(ProfileRoom.parse(profileObj("{\"rev\":\"<script>\"}")) == nil)
        #expect(ProfileRoom.parse(profileObj("{\"rev\":\"abc\",\"profile\":{\"v\":9}}")) == nil)
        #expect(ProfileRoom.parse(profileObj("{\"rev\":\"\",\"want\":true}")) == nil)
        #expect(ProfileRoom.parse(profileObj("{\"rev\":\"\"}"))?.optString("rev") == "")
        let full = try #require(ProfileRoom.parse(profileObj("{\"rev\":\"abc\",\"profile\":{\"v\":1,\"nickname\":\"Bob\",\"avatar\":\"https://evil.example/x.png\",\"fields\":[]}}")))
        #expect(full.object("profile")?.optString("nickname") == "Bob")
        #expect(full.object("profile")?.has("avatar") == false)
    }

    @Test func theCacheDropsTheOldestAndRemembersSigningAccounts() {
        let cache = ProfileRoom.Cache(2)
        let v = ProfileCard.viewFor(profileCard(), "room")
        cache.received("p1", "k1", JSONObject([("rev", "r1"), ("profile", .object(v))]))
        cache.received("p2", "k2", JSONObject([("rev", "r2"), ("profile", .object(v))]))
        cache.received("p3", "k3", JSONObject([("rev", "r3"), ("profile", .object(v))]))
        #expect(cache.of("p1") == nil)
        #expect(cache.of("p3") != nil)
        let w = ProfileWire()
        let x = w.node("alice", ProfileViewBox(nil))
        x.signedBy("bob", "ACCOUNTKEY")
        #expect(x.accountKey("bob") == "ACCOUNTKEY")
        x.forget("bob")
        #expect(x.accountKey("bob") == "")
    }

    /// (beyond the Android test) a read keeps a profile in the cache: the least recently used goes first.
    @Test func theCacheIsLeastRecentlyUsed() {
        let cache = ProfileRoom.Cache(2)
        let v = ProfileCard.viewFor(profileCard(), "room")
        cache.received("p1", "k1", JSONObject([("rev", "r1"), ("profile", .object(v))]))
        cache.received("p2", "k2", JSONObject([("rev", "r2"), ("profile", .object(v))]))
        #expect(cache.of("p1") != nil)
        cache.received("p3", "k3", JSONObject([("rev", "r3"), ("profile", .object(v))]))
        #expect(cache.of("p1") != nil)
        #expect(cache.of("p2") == nil)
        #expect(cache.announced("p1", "k1", "r1") == .same)
        #expect(cache.announced("p9", "k1", "r1") == .cached)
        #expect(cache.of("p9") != nil)
        #expect(cache.announced("p9", nil, "r1") == .cleared)
        #expect(cache.announced("p9", "", "") == .same)
    }
}
