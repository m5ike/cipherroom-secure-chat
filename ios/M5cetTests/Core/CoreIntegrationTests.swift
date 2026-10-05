// The core's side of the parts merged in 6.14 (People, NFC): a member's profile
// card travels to the others of the room, sealed for one peer at a time, and a
// new version follows (ProfileRoom through the core's controllers, two people over
// the in-memory hub); People's room extras (forwards verified by key, settling);
// the operator's audit of hides and deletes (MessageAudit: queued in the vault,
// the room's id, never the text, a refusal dropped, a network failure kept);
// screen variables per window and over the core's own; the hooks installed.

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class CoreIntegrationTests: XCTestCase {
    private func signIn(_ p: TestPerson, _ username: String) {
        p.security.userRecords.put(AccountService.record, JSONObject([("token", .string("t-" + username)),
                                                                     ("account", .object(JSONObject([("username", .string(username))])))]))
        p.core.account.reload()
    }

    private static func card(nick: String, about: String) -> JSONObject {
        func item(_ v: String, _ aud: String) -> JSON { .object(JSONObject([("value", .string(v)), ("audience", .string(aud))])) }
        return JSONObject([("nickname", item(nick, "public")), ("about", item(about, "room")), ("avatar", item("", "room")), ("cover", item("", "me")),
                           ("fields", .array([.object(JSONObject([("id", "f1"), ("type", "phone"), ("label", "Mobil"), ("value", "+420 777 000 111"),
                                                                  ("audience", "me")]))]))])
    }

    func testAProfileCardTravelsToTheRoomAndANewVersionFollows() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let alice = TestPerson.make("Alice", hub: hub, net: net), bob = TestPerson.make("Bob", hub: hub, net: net)
        signIn(alice, "alice")
        alice.core.profileStore.useCard(Self.card(nick: "Ali", about: "Hraju na kytaru."))
        XCTAssertNotNil(alice.core.profileStore.myRoomView, "a room-audience field: something to share")
        let key = alice.rooms.join(room: "Profile Room", passphrase: "profile room passphrase", userName: "Alice")
        await eventually("Alice joined") { alice.room(key)?.connected == true }
        _ = bob.rooms.join(room: "Profile Room", passphrase: "profile room passphrase", userName: "Bob")
        await eventually("the channel") { alice.room(key)?.peers.count == 1 && bob.room(key)?.peers.count == 1 }
        let bobRoom = try XCTUnwrap(bob.room(key)), aliceRoom = try XCTUnwrap(alice.room(key))
        let aliceId = aliceRoom.myId
        await eventually("Bob has Alice's room view", timeout: 30) { bobRoom.profile(of: aliceId) != nil }
        let shared = try XCTUnwrap(bobRoom.profile(of: aliceId))
        XCTAssertTrue(shared.stringify().contains("Hraju na kytaru."), "the room-audience text")
        XCTAssertFalse(shared.stringify().contains("777"), "never what is only for me")
        // Bob has no card: Alice has nothing of him.
        XCTAssertNil(aliceRoom.profile(of: bobRoom.myId))
        // A new version: the members learn it and ask for it.
        alice.core.profileStore.useCard(Self.card(nick: "Ali", about: "Teď hraju na basu."))
        await eventually("the new version", timeout: 30) { bobRoom.profile(of: aliceId)?.stringify().contains("Teď hraju na basu.") == true }
        // The lock forgets what the members shared.
        bob.core.profileStore.forget()
        XCTAssertNil(bobRoom.profile(of: aliceId))
        alice.rooms.leave(key)
        bob.rooms.leave(key)
    }

    func testForwardsVerifiedByKeyAndSettling() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let alice = TestPerson.make("Alice", hub: hub, net: net), bob = TestPerson.make("Bob", hub: hub, net: net)
        let key = alice.rooms.join(room: "Forward Room", passphrase: "forward room passphrase", userName: "Alice")
        await eventually("Alice joined") { alice.room(key)?.connected == true }
        _ = bob.rooms.join(room: "Forward Room", passphrase: "forward room passphrase", userName: "Bob")
        let bobRoom = try XCTUnwrap(bob.room(key))
        XCTAssertTrue(bobRoom.peopleSettling, "connecting")
        await eventually("the channel") { alice.room(key)?.peers.count == 1 && bobRoom.peers.count == 1 }
        let aliceRoom = try XCTUnwrap(alice.room(key))
        aliceRoom.sendText("Sraz v 18:00 u kašny")
        await eventually("Bob has it") { bobRoom.messages.contains { $0.text == "Sraz v 18:00 u kašny" } }
        // A forward that names Alice, with her text: backed by her original from her pinned key.
        var fwd = ChatMessage()
        fwd.id = "fwd-1"; fwd.text = "Sraz v 18:00 u kašny"; fwd.forwardedFrom = "Alice"; fwd.senderName = "Carol"
        XCTAssertTrue(bobRoom.forwardVerified(fwd))
        fwd.text = "Sraz v 20:00 u kašny"
        XCTAssertFalse(bobRoom.forwardVerified(fwd), "a text Alice never sent")
        fwd.forwardedFrom = nil
        XCTAssertFalse(bobRoom.forwardVerified(fwd))
        // No WebRTC statistics in memory; the joined room settles after its first seconds.
        XCTAssertNil(bobRoom.peerStats(aliceRoom.myId))
        alice.rooms.leave(key)
        bob.rooms.leave(key)
    }

    func testTheAuditOfHidesAndDeletes() async throws {
        let sec = MemorySecurity()
        let audit = MessageAudit(records: sec.userRecords)
        var t: Int64 = 1_760_000_000_000
        audit.now = { t }
        var ids: [String: String] = [:]
        audit.roomId = { ids[$0] ?? "" }
        audit.account = { "mike" }
        let room = PreviewRoom(key: "team", label: "Team", sample: false)
        var m = ChatMessage()
        m.id = "m-1"; m.text = "tajný text"; m.mine = true; m.tap = true
        // No upload yet (not enrolled): it waits in the vault, never with the text.
        audit.add("hide", room: room, message: m, until: t + 3_600_000)
        XCTAssertEqual(audit.waiting.count, 1)
        XCTAssertFalse(audit.waiting[0].stringify().contains("tajný"))
        XCTAssertEqual(audit.waiting[0].array("kinds"), [.string("text"), .string("tap")])
        XCTAssertEqual(audit.waiting[0].int64("until"), t + 3_600_000)
        XCTAssertEqual(audit.waiting[0].string("roomKey"), "team")
        // The room's id is not known yet: nothing goes (in order).
        var sent: [[NetJSON]] = []
        var fail: (any Error)?
        audit.upload = { actions, account in
            if let fail { throw fail }
            XCTAssertEqual(account, "mike")
            sent.append(actions)
        }
        audit.flush()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(sent.isEmpty)
        // Connected: the hub's room id goes, this device's room key does not.
        ids["team"] = "r3.team"
        audit.add("delete", room: room, message: m, until: 0)
        await eventually("sent") { !sent.isEmpty }
        XCTAssertEqual(sent[0].count, 2)
        XCTAssertEqual(sent[0][0].str("room"), "r3.team")
        XCTAssertNil(sent[0][0]["roomKey"])
        XCTAssertNotNil(sent[0][0]["until"])
        XCTAssertNil(sent[0][1]["until"], "only a hide has its end")
        await eventually("dropped once sent") { audit.waiting.isEmpty }
        // A network failure keeps it; the server's refusal (400) drops it.
        fail = NetError.unavailable("offline")
        audit.add("unhide", room: room, message: m, until: 0)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(audit.waiting.count, 1)
        fail = HTTPError(status: 400, code: "bad", message: "bad", body: .null, retryAfter: nil)
        audit.flush()
        await eventually("refused: dropped") { audit.waiting.isEmpty }
        // Older than a week: the server would not take it.
        fail = NetError.unavailable("offline")
        audit.add("hide", room: room, message: m, until: 0)
        try await Task.sleep(for: .milliseconds(150))
        t += MessageAudit.keepMs + 1
        fail = nil
        sent = []
        audit.flush()
        await eventually("expired") { audit.waiting.isEmpty }
        XCTAssertTrue(sent.isEmpty)
    }

    func testScreenVariablesPerWindowAndOverTheCoresOwn() throws {
        let p = TestPerson.make("Vars", hub: FakeHub(), net: LoopbackNet())
        let state = AppScreenState(core: p.core)
        let vars = p.core.models.variables
        let host = DesignHost(services: p.core.services)
        host.form["nick"] = "Ali"
        vars.register("settings.profile", "profile", window: { h in .string(h?.form["nick"]?.stringValue ?? "none") })
        vars.register("room", "users", { ["open": true, "count": 7] })
        let ctx = ScreenContext(wide: false, regularWidth: false, lang: "en")
        XCTAssertEqual(state.variables(for: "settings.profile", context: ctx, host: host)["profile"], "Ali")
        XCTAssertEqual(state.variables(for: "settings.profile", context: ctx)["profile"], "none")
        // $users is People's (the core makes none); a part's value wins over the core's.
        XCTAssertEqual(state.variables(for: "room", context: ctx)["users"]?["count"], 7)
        vars.register("tools", "tools", { ["ai": false] })
        XCTAssertEqual(state.variables(for: "tools", context: ctx)["tools"]?["ai"], false)
        // A new core keeps what the parts registered on the old one.
        let other = TestPerson.make("Vars2", hub: FakeHub(), net: LoopbackNet())
        other.core.models.variables.adopt(vars)
        XCTAssertTrue(other.core.models.variables.has("settings.profile", "profile"))
    }

    func testTheHooksTheCoreInstallsForThePartsAnswer() {
        let p = TestPerson.make("Hooks", hub: FakeHub(), net: LoopbackNet())
        // Signed out: no card root (the NFC workbench asks to sign in), no card.
        XCTAssertNil(p.core.account.cardRoot())
        XCTAssertNil(p.core.profileStore.card)
        signIn(p, "hooks")
        XCTAssertNil(p.core.account.cardRoot(), "no root kept with this session")
        var s = p.security.userRecords.record(AccountService.record) ?? JSONObject()
        s["root"] = .string(Crypto.b64(Bytes(repeating: 7, count: 32)))
        p.security.userRecords.put(AccountService.record, s)
        p.core.account.reload()
        XCTAssertEqual(p.core.account.cardRoot(), Bytes(repeating: 7, count: 32))
        XCTAssertEqual(p.core.profileStore.prefill("Hooks"), "Hooks")
        p.core.profileStore.useCard(Self.card(nick: "Hookie", about: ""))
        XCTAssertEqual(p.core.profileStore.prefill("Hooks"), "Hookie")
    }
}
