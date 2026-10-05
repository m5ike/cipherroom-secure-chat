// People on iOS with the vault, the address book and the system's suggestions faked: the vault's
// records (Android's people.links / people.verified JSON), linking only account usernames, nothing
// written to the address book, the suggestions donated and withdrawn, full and limited access (iOS 18),
// requests from Siri / the share sheet / the contact card and m5cet://people links reaching the person
// in the connected rooms (Android ContactIntents) — and only for a username linked here.

import Intents
import XCTest
import M5Core
@testable import M5cet

private final class PeopleFakeVault: PeopleVault, @unchecked Sendable {
    var isUnlocked = true
    var records: [String: Data] = [:]
    var writes = 0
    func readRecord(_ name: String) -> Data? { records[name] }
    func writeRecord(_ name: String, _ data: Data) throws { records[name] = data; writes += 1 }
}

private final class FakeContacts: ContactStoreAccess, @unchecked Sendable {
    var access: ContactsAccess = .notDetermined
    var grant: ContactsAccess = .full
    var cards: [String: ContactCard] = [:]
    /// With limited access: the contacts shared with the app.
    var shared: Set<String> = []
    var asked = 0

    func requestAccess() async -> Bool { asked += 1; access = grant; return grant.canRead }
    func contact(_ identifier: String) -> ContactCard? {
        guard access.canRead else { return nil }
        if access == .limited && !shared.contains(identifier) { return nil }
        return cards[identifier]
    }
}

@MainActor
private final class FakeDonations: PeopleDonating {
    var log: [String] = []
    func donate(username: String, contact: ContactCard) { log.append("donate \(username) \(contact.identifier)") }
    func remove(username: String) { log.append("remove \(username)") }
    func removeAll() { log.append("remove all") }
}

final class PeopleStoreTests: XCTestCase {
    func testTheLinksAsAndroidKeepsThem() throws {
        let vault = PeopleFakeVault()
        let store = PeopleStore(vault: vault, clock: ManualClock(1_760_000_000_000))
        store.putLink(username: "Bystry-Sokol-7k3q", contactName: "Jana Nová", identifier: "ABC:ABPerson")
        let o = try XCTUnwrap(store.link("bystry-sokol-7k3q"))
        XCTAssertEqual("Bystry-Sokol-7k3q", o.optString("username"))
        XCTAssertEqual("Jana Nová", o.optString("contact"))
        XCTAssertEqual("ABC:ABPerson", o.optString("lookup"))
        XCTAssertEqual(1_760_000_000_000, o.int64("at"))
        // The vault's record: Android's JSON under the lower-case key.
        let saved = try JSON.parse(Bytes(try XCTUnwrap(vault.records["people.links"]))).objectValue
        XCTAssertEqual(["bystry-sokol-7k3q"], saved?.keys)
        XCTAssertEqual(["username", "contact", "lookup", "id", "at"], saved?.object("bystry-sokol-7k3q")?.keys)
        XCTAssertEqual(["Bystry-Sokol-7k3q"], store.linkedUsers())
        XCTAssertEqual("Bystry-Sokol-7k3q", store.username(forContact: "ABC:ABPerson"))
        XCTAssertNil(store.username(forContact: "other"))
        store.removeLink("BYSTRY-SOKOL-7K3Q")
        XCTAssertNil(store.link("bystry-sokol-7k3q"))
        store.putLink(username: "a-b-c", contactName: "", identifier: "x")
        store.clearLinks()
        XCTAssertTrue(store.links().isEmpty)
        // A guest's name is no username: nothing kept.
        store.putLink(username: "ab", contactName: "x", identifier: "y")
        XCTAssertTrue(store.links().isEmpty)
    }

    func testALockedVaultReadsEmptyAndKeepsNothing() {
        let vault = PeopleFakeVault()
        let store = PeopleStore(vault: vault)
        store.setVerified("kid-1", true)
        XCTAssertTrue(store.verified("kid-1"))
        vault.isUnlocked = false
        XCTAssertFalse(store.verified("kid-1"))
        let writes = vault.writes
        store.putLink(username: "rys-lis-aaaa", contactName: "x", identifier: "y")
        XCTAssertEqual(writes, vault.writes)
        vault.isUnlocked = true
        XCTAssertTrue(store.verified("kid-1")) // read again after the unlock
        XCTAssertNil(store.link("rys-lis-aaaa"))
        store.setVerified("kid-1", false)
        XCTAssertFalse(store.verified("kid-1"))
        XCTAssertFalse(store.verified(""))
        // forget(): the copies in memory go, the vault answers again.
        store.setVerified("kid-2", true)
        vault.records["people.verified"] = Data("{}".utf8)
        XCTAssertTrue(store.verified("kid-2"))
        store.forget()
        XCTAssertFalse(store.verified("kid-2"))
    }

    func testRoomsAskFromTheirOwnThreads() async {
        let store = PeopleStore(vault: PeopleFakeVault())
        store.setVerified("kid", true)
        let verified: @Sendable (String) -> Bool = { store.verified($0) } // M5Proto RoomSession's verifiedDevice
        let answers = await withTaskGroup(of: Bool.self) { g in
            for _ in 0..<50 { g.addTask { verified("kid") } }
            return await g.reduce(into: [Bool]()) { $0.append($1) }
        }
        XCTAssertEqual(Array(repeating: true, count: 50), answers)
    }
}

@MainActor
final class ContactsServiceTests: XCTestCase {
    private func make() -> (ContactsService, FakeContacts, FakeDonations, PeopleStore, ManualScheduler) {
        let contacts = FakeContacts(), donations = FakeDonations(), store = PeopleStore(vault: PeopleFakeVault()), clock = ManualScheduler()
        let svc = ContactsService(store: store, contacts: contacts, donations: donations, scheduler: clock, clock: ManualClock(1_000_000))
        return (svc, contacts, donations, store, clock)
    }

    private let jana = ContactCard(identifier: "C1", name: "Jana Nová", thumbnail: Data([1, 2]))

    func testOnlyAccountUsernamesAreLinked() {
        let (svc, _, donations, store, _) = make()
        XCTAssertNil(svc.link(username: "bystry-sokol-7k3q", signedIn: false, contact: jana, enabled: true)) // a guest
        XCTAssertNil(svc.link(username: "bystry-sokol-7k3q", signedIn: true, contact: jana, enabled: false)) // people.contacts off
        XCTAssertNil(svc.link(username: "a b", signedIn: true, contact: jana, enabled: true))
        XCTAssertTrue(store.links().isEmpty)
        XCTAssertEqual("Jana Nová", svc.link(username: "bystry-sokol-7k3q", signedIn: true, contact: jana, enabled: true))
        XCTAssertEqual(["donate bystry-sokol-7k3q C1"], donations.log)
        XCTAssertEqual("C1", svc.identifier(of: "Bystry-Sokol-7K3Q"))
    }

    func testUnlinkingWithdrawsTheSuggestions() {
        let (svc, _, donations, store, _) = make()
        svc.link(username: "rys-lis-aaaa", signedIn: true, contact: jana, enabled: true)
        svc.link(username: "jiny-rys-2222", signedIn: true, contact: ContactCard(identifier: "C2", name: "Petr"), enabled: true)
        svc.unlink(username: "rys-lis-aaaa")
        svc.unlink(username: "nobody-here")
        XCTAssertEqual(["jiny-rys-2222"], store.linkedUsers())
        svc.setEnabled(false) // the links stay in the vault, the suggestions go
        XCTAssertEqual(["jiny-rys-2222"], store.linkedUsers())
        svc.unlinkAll()
        XCTAssertTrue(store.links().isEmpty)
        XCTAssertEqual(["donate rys-lis-aaaa C1", "donate jiny-rys-2222 C2", "remove rys-lis-aaaa", "remove jiny-rys-2222", "remove jiny-rys-2222"], donations.log)
        XCTAssertFalse(donations.log.contains("remove all")) // other features' donations stay
        svc.wipe()
        XCTAssertEqual("remove all", donations.log.last)
    }

    func testSwitchedOnAgainTheSuggestionsComeBack() {
        let (svc, contacts, donations, _, _) = make()
        svc.link(username: "rys-lis-aaaa", signedIn: true, contact: jana, enabled: true)
        donations.log.removeAll()
        // Limited access, the contact not shared: suggested with the name kept in the vault.
        contacts.access = .limited
        svc.setEnabled(true)
        XCTAssertEqual(["donate rys-lis-aaaa C1"], donations.log)
        // Full access, the contact deleted meanwhile: no suggestion.
        donations.log.removeAll()
        contacts.access = .full
        svc.setEnabled(true)
        XCTAssertTrue(donations.log.isEmpty)
    }

    func testLimitedAccessAsksForTheContactOnly() async {
        let (svc, contacts, _, _, _) = make()
        contacts.cards["C1"] = jana
        svc.link(username: "rys-lis-aaaa", signedIn: true, contact: jana, enabled: true)
        XCTAssertNil(svc.photo(of: "rys-lis-aaaa")) // no access yet: nothing read, nothing asked
        XCTAssertEqual(0, contacts.asked)
        contacts.grant = .limited
        let granted = await svc.requestAccess()
        XCTAssertTrue(granted)
        XCTAssertEqual(.limited, svc.access)
        XCTAssertTrue(svc.needsAccessPicker(for: "rys-lis-aaaa")) // not shared: ContactAccessButton for it
        contacts.shared = ["C1"]
        XCTAssertFalse(svc.needsAccessPicker(for: "rys-lis-aaaa"))
        XCTAssertEqual(Data([1, 2]), svc.photo(of: "rys-lis-aaaa"))
        _ = await svc.requestAccess()
        XCTAssertEqual(1, contacts.asked) // decided: never asked again
    }

    func testPeopleLinks() {
        let url = ContactsService.link(username: "Rys-Lis-aaaa", kind: .call)
        XCTAssertEqual("m5cet://people/call?u=Rys-Lis-aaaa", url?.absoluteString)
        XCTAssertEqual("Rys-Lis-aaaa", ContactsService.request(from: url!)?.username)
        XCTAssertEqual(.message, ContactsService.request(from: URL(string: "m5cet://people/message?u=rys-lis-aaaa")!)?.kind)
        XCTAssertNil(ContactsService.request(from: URL(string: "m5cet://people/message?u=a%20b")!))
        XCTAssertNil(ContactsService.request(from: URL(string: "m5cet://people/wipe?u=rys-lis-aaaa")!))
        XCTAssertNil(ContactsService.request(from: URL(string: "m5cet://enroll?u=rys-lis-aaaa")!))
        let (svc, _, _, _, _) = make()
        XCTAssertTrue(svc.handle(link: .unsupported(URL(string: "m5cet://people/message?u=rys-lis-aaaa")!)))
        XCTAssertTrue(svc.reach.waiting)
        XCTAssertFalse(svc.handle(link: .unsupported(URL(string: "m5cet://other")!)))
        XCTAssertNil(ContactsService.link(username: "x", kind: .message))
    }

    func testSiriAndTheContactCardReachOnlyLinkedPeople() {
        let (svc, _, _, _, _) = make()
        svc.link(username: "rys-lis-aaaa", signedIn: true, contact: jana, enabled: true)
        let person = SystemPeopleDonations.person(username: "rys-lis-aaaa", contact: jana)
        XCTAssertEqual("m5cet:rys-lis-aaaa", person.customIdentifier)
        XCTAssertEqual("C1", person.contactIdentifier)
        XCTAssertEqual("rys-lis-aaaa", person.personHandle?.value)
        let message = INSendMessageIntent(recipients: [person], outgoingMessageType: .outgoingMessageText, content: nil, speakableGroupName: nil,
                                          conversationIdentifier: nil, serviceName: nil, sender: nil, attachments: nil)
        XCTAssertTrue(svc.handle(intent: message)) // continueUserActivity hands over activity.interaction.intent
        XCTAssertTrue(svc.reach.waiting)
        // A person by the linked contact only (the contact card), and one M5cet does not know.
        let byContact = INPerson(personHandle: INPersonHandle(value: "+420 777", type: .phoneNumber), nameComponents: nil, displayName: "Jana",
                                 image: nil, contactIdentifier: "C1", customIdentifier: nil)
        XCTAssertEqual("rys-lis-aaaa", svc.username(of: [byContact]))
        let stranger = INPerson(personHandle: INPersonHandle(value: "mallory-xyz", type: .unknown), nameComponents: nil, displayName: "M",
                                image: nil, contactIdentifier: nil, customIdentifier: "m5cet:mallory-xyz")
        XCTAssertNil(svc.username(of: [stranger])) // not linked here: another app cannot make it reach anyone
        let call = INStartCallIntent(callRecordFilter: nil, callRecordToCallBack: nil, audioRoute: .unknown, destinationType: .normal,
                                     contacts: [stranger], callCapability: .audioCall)
        XCTAssertFalse(svc.handle(intent: call)) // passed on (Platform/Calls: Recents)
        XCTAssertFalse(svc.continueUserActivity(NSUserActivity(activityType: "other")))
    }
}

@MainActor
private final class Host: ContactReachHost {
    var ready = true
    var contactsEnabled = true
    var activeRoom: String?
    var rooms: [ContactReachRoom] = []
    var notices: [String] = []
    var reached: [String] = []
    func connectedRooms() -> [ContactReachRoom] { rooms }
    func text(_ key: String) -> String { key + "({name})" }
    func notice(_ text: String, level: String) { notices.append(level + ":" + text) }
    func reach(_ kind: ContactReachKind, roomKey: String, peerId: String, username: String) { reached.append("\(kind.rawValue) \(roomKey) \(peerId)") }
}

@MainActor
final class ContactReachTests: XCTestCase {
    private func person(_ id: String, _ user: String, signedIn: Bool = true, channel: String = "open", me: Bool = false) -> JSONObject {
        JSONObject([("id", .string(id)), ("username", .string(user)), ("signedIn", .bool(signedIn)), ("channel", .string(channel)), ("me", .bool(me))])
    }

    private func make() -> (ContactReach, Host, ManualScheduler, ManualClock) {
        let store = PeopleStore(vault: PeopleFakeVault())
        store.putLink(username: "rys-lis-aaaa", contactName: "Jana", identifier: "C1")
        let clock = ManualClock(1_000_000), sched = ManualScheduler()
        let reach = ContactReach(store: store, scheduler: sched, clock: clock)
        let host = Host()
        reach.host = host
        return (reach, host, sched, clock)
    }

    func testTheActiveRoomsPersonGetsAPrivateMessage() {
        let (reach, host, sched, _) = make()
        host.activeRoom = "b"
        host.rooms = [ContactReachRoom(key: "a", label: "A", settling: false, lastActivity: 900, people: [person("me", "rys-lis-aaaa", me: true), person("p1", "rys-lis-aaaa")]),
                      ContactReachRoom(key: "b", label: "B", settling: false, lastActivity: 10, people: [person("p2", "Rys-Lis-AAAA")])]
        reach.accept(username: "rys-lis-aaaa", kind: .message)
        sched.advance(300)
        XCTAssertEqual(["message b p2"], host.reached)
        XCTAssertFalse(reach.waiting)
    }

    func testWaitsForTheUnlockThenForRoomsThatSettle() {
        let (reach, host, sched, clock) = make()
        host.ready = false
        reach.accept(username: "rys-lis-aaaa", kind: .call)
        sched.advance(300 + 600 * 3)
        XCTAssertTrue(host.reached.isEmpty)
        XCTAssertTrue(host.notices.isEmpty)
        host.ready = true
        host.rooms = [ContactReachRoom(key: "a", label: "A", settling: true, lastActivity: 1, people: [person("p1", "rys-lis-aaaa", channel: "connecting")])]
        sched.advance(600)
        XCTAssertEqual(["info:people.searching(Jana)"], host.notices) // said once
        clock.advance(5000)
        sched.advance(700)
        XCTAssertEqual(1, host.notices.count)
        host.rooms[0].people = [person("p1", "rys-lis-aaaa")]
        clock.advance(700)
        sched.advance(700)
        XCTAssertEqual(["call a p1"], host.reached)
    }

    func testSaysWhyItCannotReachThem() {
        let (reach, host, sched, clock) = make()
        reach.accept(username: "nobody-here", kind: .message)
        sched.advance(300)
        XCTAssertEqual(["warn:people.notLinked()"], host.notices)
        reach.accept(username: "rys-lis-aaaa", kind: .message)
        sched.advance(300)
        XCTAssertEqual("warn:people.noRooms(Jana)", host.notices.last)
        host.contactsEnabled = false
        reach.accept(username: "rys-lis-aaaa", kind: .message)
        sched.advance(300)
        XCTAssertEqual("warn:people.contactsOff()", host.notices.last)
        host.contactsEnabled = true
        host.rooms = [ContactReachRoom(key: "a", label: "A", settling: true, lastActivity: 1, people: [person("p1", "rys-lis-aaaa", signedIn: false)])]
        reach.accept(username: "rys-lis-aaaa", kind: .message)
        sched.advance(300)
        clock.advance(Match.waitMs)
        sched.advance(700)
        XCTAssertEqual("warn:people.notOnline(Jana)", host.notices.last) // a guest with that name is not them
        XCTAssertTrue(host.reached.isEmpty)
    }

    func testANewerRequestReplacesTheOldAndFiveMinutesEndIt() {
        let (reach, host, sched, clock) = make()
        host.ready = false
        reach.accept(username: "rys-lis-aaaa", kind: .call)
        reach.accept(username: "rys-lis-aaaa", kind: .message)
        clock.advance(5 * 60_000 + 1)
        sched.advance(10_000)
        XCTAssertFalse(reach.waiting)
        host.ready = true
        sched.advance(10_000)
        XCTAssertTrue(host.reached.isEmpty)
    }
}
