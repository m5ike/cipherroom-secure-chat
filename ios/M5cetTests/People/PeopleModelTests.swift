// People's model and actions over a room (People.java): the widget's list (order,
// status, signal, avatar, selection, presence, look-alikes), a person's detail
// ($form.person: connection, keys, safety number, what they share), choosing
// recipients, verifying (the vault's mark and the room's identity), contact links,
// the user panel's state and scope — and the same against the DEBUG PreviewCore.

import M5Core
import M5Design
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class PeopleModelTests: XCTestCase {
    func testTheListMeFirstConnectedThenAwayAsTheWidgetDrawsThem() throws {
        let w = PeopleWorld.make()
        let users = w.users()
        XCTAssertEqual(users.map { $0.optString("id") }, ["peer-me", "peer-bob", "peer-alice", "away:acc-eva"])
        let alice = try XCTUnwrap(users.first { $0.optString("id") == "peer-alice" })
        XCTAssertEqual(alice.optString("status"), "online")
        XCTAssertEqual(alice.optString("statusIcon"), "circle-check")
        XCTAssertEqual(alice.optString("statusColor"), "@success")
        XCTAssertEqual(alice.optString("statusLabel"), w.host.peopleText("people.status.online"))
        XCTAssertEqual(alice.double("signal"), 4)
        XCTAssertEqual(alice.optString("signalIcon"), "signal")
        XCTAssertEqual(alice.optString("rttText"), "38 ms")
        XCTAssertEqual(alice.optString("glyph"), "A")
        XCTAssertEqual(alice.optString("avatarBg"), "#38ae2929")
        XCTAssertEqual(alice.bool("selectable"), true)
        XCTAssertEqual(alice.bool("selected"), false)
        XCTAssertEqual(alice.bool("verified"), true)
        XCTAssertEqual(alice.optString("kid"), Safety.keyId(PeopleKeys.b))
        XCTAssertEqual(alice.bool("nameFlag"), false)
        // A guest (no account) is "light", a slower round trip fewer bars.
        let bob = try XCTUnwrap(users.first { $0.optString("id") == "peer-bob" })
        XCTAssertEqual(bob.optString("status"), "light")
        XCTAssertEqual(bob.double("signal"), 2)
        XCTAssertEqual(bob.bool("canLink"), false)
        // Away: the server holds messages; presence from "last seen" 20 min ago.
        let eva = try XCTUnwrap(users.last)
        XCTAssertEqual(eva.optString("status"), "away")
        XCTAssertEqual(eva.bool("away"), true)
        XCTAssertEqual(eva.bool("selectable"), false)
        XCTAssertEqual(eva.optString("presence"), "away")
        XCTAssertEqual(eva.optString("presenceColor"), "@warning")
        // Me: never selectable, my photo from my card when I have one.
        let me = try XCTUnwrap(users.first)
        XCTAssertEqual(me.bool("selectable"), false)
        XCTAssertEqual(me.bool("safetyVerified"), false)
    }

    func testAMembersSharedPhotoAndALookAlikeName() throws {
        let w = PeopleWorld.make()
        w.room.profiles["peer-bob"] = JSONObject([("avatar", "data:image/jpeg;base64,AAAA")])
        // "Аlice" with a Cyrillic А looks like Alice: both are flagged.
        w.room.people.append(PeopleFakeRoom.person("peer-fake", "Аlice", user: "", key: ""))
        let users = w.users()
        XCTAssertEqual(users.first { $0.optString("id") == "peer-bob" }?.optString("photo"), "data:image/jpeg;base64,AAAA")
        let fake = try XCTUnwrap(users.first { $0.optString("id") == "peer-fake" })
        XCTAssertEqual(fake.bool("nameFlag"), true)
        XCTAssertTrue(fake.optString("name").hasPrefix(Names.flag))
    }

    func testThePersonsDetail() throws {
        let w = PeopleWorld.make()
        let p = try XCTUnwrap(w.person("peer-alice"))
        XCTAssertEqual(p.optString("transport"), "direct")
        XCTAssertEqual(p.optString("transportLabel"), w.host.peopleText("people.transport.direct"))
        XCTAssertEqual(p.optString("candidates"), "host → srflx · UDP")
        XCTAssertEqual(p.optString("remote"), "203.0.113.7:51234")
        XCTAssertEqual(p.optString("codec"), "opus")
        XCTAssertEqual(p.optString("traffic"), "84.2 kB / 91.6 kB")
        XCTAssertEqual(p.optString("security"), "AES-GCM 256 (E2EE) · DTLS 1.2 · AES_CM_128_HMAC_SHA1_80")
        XCTAssertEqual(p.optString("dtls"), "sha-256 3A:5F:00")
        XCTAssertEqual(p.optString("fingerprint"), Safety.fingerprint(PeopleKeys.b))
        XCTAssertEqual(p.bool("hasSafety"), true)
        XCTAssertEqual(p.optString("safety"), "13286 60170 84613 24995\n23962 36648 18264 48418\n04707 59157 69365 29038")
        XCTAssertEqual(p.optString("sinceText"), "12 " + w.host.peopleText("people.m") + " 5 " + w.host.peopleText("people.s"))
        XCTAssertEqual(p.optString("room"), "Tým")
        XCTAssertEqual(p.double("others"), 2)
        XCTAssertEqual(p.optString("peerShort"), "peer-alice")
        // What she shares with the room, her public profile not asked for yet.
        let pf = try XCTUnwrap(p.object("profile"))
        XCTAssertEqual(pf.bool("has"), true)
        XCTAssertEqual(pf.object("room")?.optString("nickname"), "Alice Nováková")
        XCTAssertEqual(pf.object("room")?.array("fields")?.first?.objectValue?.optString("icon"), "globe")
        XCTAssertEqual(pf.optString("publicState"), "")
        // Me: my own keys, no safety number, "this device".
        let me = try XCTUnwrap(w.person("peer-me"))
        XCTAssertEqual(me.optString("transport"), "self")
        XCTAssertEqual(me.bool("hasSafety"), false)
        XCTAssertEqual(me.object("profile")?.object("room")?.optString("nickname"), "Mike")
        // A peer without statistics yet: connecting.
        XCTAssertEqual(w.person("peer-bob")?.optString("transport"), "connecting")
        XCTAssertNil(w.person("nobody"))
    }

    func testChoosingWhoGetsTheNextMessage() async {
        let w = PeopleWorld.make()
        w.people.run("people.select", "peer-alice", host: w.host)
        XCTAssertEqual(PeopleModel.selection(w.host.form), ["peer-alice"])
        XCTAssertEqual(w.core.composer(for: w.host).recipientNames, ["Alice"])
        w.people.run("people.select", "peer-bob", host: w.host)
        XCTAssertEqual(PeopleModel.selection(w.host.form), ["peer-alice", "peer-bob"])
        w.people.run("people.select", "peer-alice", host: w.host)
        XCTAssertEqual(PeopleModel.selection(w.host.form), ["peer-bob"])
        // Someone not connected cannot be chosen.
        w.people.run("people.select", "away:acc-eva", host: w.host)
        XCTAssertEqual(PeopleModel.selection(w.host.form), ["peer-bob"])
        w.people.run("people.all", "", host: w.host)
        XCTAssertEqual(Set(PeopleModel.selection(w.host.form)), ["peer-alice", "peer-bob"])
        let scope = UserPanelView.scope(people: w.people, state: UserPanelState(defaults: Self.defaults()), host: w.host)
        XCTAssertEqual(scope["selectedCount"], 2)
        XCTAssertEqual(scope["selectable"], 2)
        XCTAssertEqual(scope["allSelected"], true)
        XCTAssertEqual(scope["count"], 4)
        w.people.run("people.none", "", host: w.host)
        XCTAssertNil(w.host.form["msgTo"])
        // A private message: only them, the composer's field gets the focus.
        let before = w.core.composer(for: w.host).focusRequests
        w.people.run("people.message", "peer-alice", host: w.host)
        XCTAssertEqual(PeopleModel.selection(w.host.form), ["peer-alice"])
        await PeopleWorld.settle(0.4)
        XCTAssertEqual(w.core.composer(for: w.host).focusRequests, before + 1)
    }

    func testTheDetailOpensAsASheetAndNamesWhoseProfileMayBeLookedUp() async {
        let w = PeopleWorld.make()
        w.people.freshDelay = .milliseconds(100)
        XCTAssertNil(w.people.shownUsername())
        w.people.run("people.open", "peer-alice", host: w.host)
        XCTAssertEqual(w.host.sheet?.screen, "users.person")
        XCTAssertEqual(w.host.form["person"]?["id"], "peer-alice")
        XCTAssertEqual(w.people.shownUsername(), "alice-novak")
        // Kept fresh: the statistics are read while it is open.
        await PeopleWorld.settle(2.2)
        XCTAssertGreaterThan(w.room.statsRefreshed, 0)
        w.host.closeOverlay()
        XCTAssertNil(w.people.shownUsername())
    }

    func testVerifyingMarksTheKeyAndTellsTheRoom() throws {
        let w = PeopleWorld.make()
        let kid = Safety.keyId(PeopleKeys.b)
        w.people.setVerified("peer-alice", kid: kid, name: "Alice", on: true, scanned: false, host: w.host)
        XCTAssertTrue(w.people.store.verified(kid))
        XCTAssertNotNil(w.vault.readRecord(PeopleStore.verifiedRecord).flatMap { String(data: $0, encoding: .utf8) }?.range(of: kid))
        XCTAssertEqual(w.room.verifiedCalls.last?.0, "peer-alice")
        XCTAssertEqual(w.room.verifiedCalls.last?.1, true)
        XCTAssertEqual(w.person("peer-alice")?.bool("safetyVerified"), true)
        XCTAssertEqual(w.host.flashes.last?.text, PeopleTexts.fill(w.host.peopleText("people.verify.done"), name: "Alice"))
        w.people.setVerified("peer-alice", kid: kid, name: "Alice", on: false, scanned: false, host: w.host)
        XCTAssertFalse(w.people.store.verified(kid))
        XCTAssertEqual(w.room.verifiedCalls.last?.1, false)
        // By the QR code: the web's words.
        w.people.setVerified("peer-alice", kid: kid, name: "Alice", on: true, scanned: true, host: w.host)
        XCTAssertEqual(w.host.flashes.last?.text, w.host.peopleText("sec.safety.verified"))
        XCTAssertNotEqual(w.host.peopleText("sec.safety.verified"), "sec.safety.verified")
    }

    func testLinkingAContact() async throws {
        let w = PeopleWorld.make()
        _ = w.host.userSetSetting("people.contacts", .bool(true))
        w.contacts.book.access = .notDetermined // the system's question comes with the first link (for the photos)
        XCTAssertEqual(w.person("peer-alice")?.bool("canLink"), true)
        w.people.run("people.link", "peer-alice", host: w.host)
        await PeopleWorld.settle()
        let link = try XCTUnwrap(w.people.store.link("Alice-Novak"))
        XCTAssertEqual(link.optString("contact"), "Alice Nováková")
        XCTAssertEqual(link.optString("lookup"), "ABC-123")
        let p = try XCTUnwrap(w.person("peer-alice"))
        XCTAssertEqual(p.bool("linked"), true)
        XCTAssertEqual(p.optString("contact"), "Alice Nováková")
        XCTAssertEqual(w.host.flashes.last?.text, PeopleTexts.fill(w.host.peopleText("people.linked"), name: "Alice", other: "Alice Nováková"))
        w.people.run("people.unlink", "peer-alice", host: w.host)
        await PeopleWorld.settle()
        XCTAssertNil(w.people.store.link("alice-novak"))
        // The system's suggestions for her: donated with the link, gone with it.
        XCTAssertEqual(w.contacts.donations.donated, ["alice-novak"])
        XCTAssertEqual(w.contacts.donations.removed, ["alice-novak"])
        XCTAssertEqual(w.contacts.book.asked, 1)
        XCTAssertEqual(w.host.flashes.last?.text, w.host.peopleText("people.unlinked"))
        // people.contacts off: the suggestions go, the links stay.
        w.people.run("people.link", "peer-alice", host: w.host)
        await PeopleWorld.settle()
        w.people.contactsSettingChanged(on: false)
        XCTAssertNotNil(w.people.store.link("alice-novak"))
        XCTAssertEqual(w.contacts.donations.removed.count, 2)
        w.people.unlinkAllNow(w.host)
        XCTAssertNil(w.people.store.link("alice-novak"))
        // A guest cannot be linked; with the integration off nothing is.
        w.people.run("people.link", "peer-bob", host: w.host)
        XCTAssertEqual(w.host.flashes.last?.text, w.host.peopleText("people.linkOnlyAccounts"))
        _ = w.host.userSetSetting("people.contacts", .bool(false))
        w.people.run("people.link", "peer-alice", host: w.host)
        XCTAssertEqual(w.host.flashes.last?.text, w.host.peopleText("people.contactsOff"))
    }

    func testTheLockForgetsTheCopies() {
        let w = PeopleWorld.make()
        w.people.store.setVerified("kid-1", true)
        w.vault.setUnlocked(false)
        XCTAssertFalse(w.people.store.verified("kid-1"))
        w.vault.setUnlocked(true)
        w.people.forget()
        XCTAssertTrue(w.people.store.verified("kid-1"))
    }

    // MARK: the panel

    static func defaults() -> UserDefaults {
        let name = "cz.m5cet.tests.people.panel"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func testThePanelsStateIsKeptAndDocks() async {
        let d = Self.defaults()
        let s = UserPanelState(defaults: d)
        XCTAssertFalse(s.open)
        XCTAssertEqual(s.dock, "right")
        s.toggle()
        XCTAssertTrue(s.open)
        XCTAssertTrue(s.revealed)
        s.dock("left")
        s.setAutoHide(true)
        XCTAssertTrue(s.autoHide)
        XCTAssertTrue(s.hides)
        await PeopleWorld.settle(1.0)
        XCTAssertFalse(s.revealed, "an auto-hiding panel tucks itself away")
        s.reveal()
        XCTAssertTrue(s.revealed)
        s.tuck()
        XCTAssertFalse(s.revealed)
        // Floating: never hides itself; its place is kept.
        s.dock("none")
        XCTAssertFalse(s.autoHide)
        s.place(x: 40, y: 120)
        let again = UserPanelState(defaults: d)
        XCTAssertTrue(again.open)
        XCTAssertEqual(again.dock, "none")
        XCTAssertEqual(again.x, 40)
        XCTAssertEqual(again.y, 120)
        XCTAssertEqual(again.scope(count: 3), ["open": true, "dock": "none", "autoHide": false, "count": 3])
        XCTAssertEqual(UserPanelView.away(dock: "left", tucked: true, pw: 264, ph: 300), CGSize(width: -276, height: 0))
        XCTAssertEqual(UserPanelView.away(dock: "bottom", tucked: true, pw: 380, ph: 300), CGSize(width: 0, height: 312))
        XCTAssertEqual(UserPanelView.away(dock: "right", tucked: false, pw: 264, ph: 300), .zero)
    }

    // MARK: the registered parts

    func testTheSlotsActionsAndVariablesAreRegistered() {
        let w = PeopleWorld.make()
        let services = w.host.services
        PeopleParts.install(services: services)
        XCTAssertTrue(services.slots.has("userPanel"))
        XCTAssertTrue(services.slots.has("userList"))
        for a in PeopleParts.actions { XCTAssertTrue(services.actions.handles(a), a) }
        XCTAssertEqual(PeopleParts.actions.count, 24)
        XCTAssertNotNil(services.actions.shownUsername)
        XCTAssertTrue(w.core.variables.has("settings.profile", "profile"))
        XCTAssertTrue(w.core.variables.has("settings", "myProfile"))
        XCTAssertTrue(w.core.variables.has("room", "users"))
        XCTAssertTrue(w.core.variables.has("call", "users"))
        // users.toggle through the router.
        let before = UserPanelState.shared.open
        services.actions.dispatch(.usersToggle, context: ActionContext(host: w.host, source: nil))
        XCTAssertEqual(UserPanelState.shared.open, !before)
        services.actions.dispatch(.usersToggle, context: ActionContext(host: w.host, source: nil))
    }

    // MARK: against the DEBUG PreviewCore

    func testThePanelListsThePreviewRoomsMembers() throws {
        let core = PreviewCore.install()
        defer { CoreModels.shared = CoreModels(rooms: NoRooms(), account: NoAccount()) }
        let host = RendererTestSupport.host()
        let people = PeopleModel(store: PeopleStore(vault: PeopleMemoryVault()))
        people.core = { core }
        let users = people.users(core.rooms.active, form: host.form, settings: host.settings, t: host.peopleText)
        XCTAssertEqual(users.map { $0.optString("name") }, ["Mike", "Alice", "Bob", "Eva"])
        XCTAssertEqual(users.filter { $0.bool("selectable") == true }.map { $0.optString("id") }, ["peer-alice", "peer-bob"])
        // Alice shares a nickname with the room (PreviewRoom.profile).
        let alice = try XCTUnwrap(people.person(core.rooms.active, "peer-alice", form: host.form, settings: host.settings, t: host.peopleText))
        XCTAssertEqual(alice.object("profile")?.bool("has"), true)
        XCTAssertEqual(alice.object("profile")?.object("room")?.optString("about"), "Lezu a piju kávu.")
    }
}
