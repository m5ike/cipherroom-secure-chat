// What the People tests share: a room whose people have real keys (the safety
// number vectors of the web), WebRTC statistics and a shared profile; a rooms model
// around it; an address book that answers as told; a window host over the built-in
// design with its own settings; and a core (CoreModels) made of them.

import M5Core
import M5Design
import M5Proto
import Observation
import XCTest
@testable import M5cet

@MainActor
@Observable
final class PeopleFakeRoom: RoomModel, PeopleRoomExtras {
    let key: String
    var room: String { key }
    let label: String
    var status = "joined"
    var notice = ""
    var connected: Bool { status == "joined" }
    var unread = 0
    var lastActivity: Int64 = 1_760_000_000_000
    var messages: [ChatMessage] = []
    var restores = 1
    var historyReady = true
    var freshId: String?
    var revealRequest: String?
    let myId = "peer-me"
    let myName = "Mike"
    let myPublicKey = PeopleKeys.a
    var people: [PersonItem] = []
    var peers: [PeerRef] { people.filter { !$0.me && $0.channel == "open" }.map { PeerRef(id: $0.id, name: $0.name) } }
    var userCount: Int { people.filter { $0.channel == "open" }.count }
    var call = CallInfo()
    var ktAlert = ""
    var scope: DesignValue { ["key": .string(key), "name": .string(label), "users": .number(Double(userCount))] }

    // What the tests read back.
    var verifiedCalls: [(String, Bool)] = []
    var hideCalls: [(String, Int64, String?, String?)] = []
    var statsRefreshed = 0
    var profiles: [String: JSONObject] = [:]
    var accountKeys: [String: String] = [:]
    var stats: [String: RtcStatsSummary] = [:]
    var forwards: Set<String> = []
    var profileChanges = 0

    static let t0: Int64 = 1_760_000_000_000

    init(key: String = "team", label: String = "Tým") {
        self.key = key
        self.label = label
        people = Self.samplePeople()
        profiles["peer-alice"] = ProfileCard.viewFor(JSONObject([
            ("nickname", .object(JSONObject([("value", "Alice Nováková"), ("audience", "room")]))),
            ("about", .object(JSONObject([("value", "Lezu a piju kávu."), ("audience", "room")]))),
            ("fields", .array([.object(JSONObject([("type", "url"), ("label", "Blog"), ("value", "https://alice.example"), ("audience", "public")]))])),
        ]), "room")
        var s = RtcStatsSummary(at: Self.t0)
        s.rttMs = 38; s.localType = "host"; s.remoteType = "srflx"; s.proto = "udp"; s.remoteAddress = "203.0.113.7:51234"
        s.audioCodec = "opus"; s.bytesSent = 86_220; s.bytesReceived = 93_800; s.dtlsState = "connected"; s.tlsVersion = "FEFD"
        s.srtpCipher = "AES_CM_128_HMAC_SHA1_80"; s.dtlsFingerprint = "sha-256 3A:5F:00"
        stats["peer-alice"] = s
    }

    static func person(_ id: String, _ name: String, me: Bool = false, channel: String = "open", user: String = "", key: String = "",
                       trust: String = "new", proto: String = "p4", audio: String = "off", rtt: Double = -1, lastSeen: Int64 = t0,
                       foreground: Bool = true, changed: Bool = false) -> PersonItem {
        PersonItem(scope: JSONObject([("id", .string(id)), ("name", .string(name)), ("me", .bool(me)), ("channel", .string(channel)),
                                      ("username", .string(user)), ("signedIn", .bool(!user.isEmpty)), ("since", .int(t0 - 725_000)),
                                      ("audio", .string(audio)), ("signed", .bool(channel == "open")), ("changed", .bool(changed)),
                                      ("publicKey", .string(key)), ("trust", .string(trust)), ("trustLabel", .string(trust)),
                                      ("protocol", .string(proto)), ("legacy", .bool(proto == "legacy")), ("held", 0), ("kt", ""),
                                      ("connected", .bool(channel == "open")), ("foreground", .bool(foreground)), ("lastSeen", .int(lastSeen)),
                                      ("rtt", .double(rtt))]))
    }

    static func samplePeople() -> [PersonItem] {
        [person("away:acc-eva", "Eva", channel: "away", user: "eva-1234", lastSeen: t0 - 20 * 60_000, foreground: false),
         person("peer-bob", "Bob", proto: "legacy", rtt: 180),
         person("peer-me", "Mike", me: true, user: "bystry-sokol-7k3q", key: PeopleKeys.a, trust: "verified"),
         person("peer-alice", "Alice", user: "alice-novak", key: PeopleKeys.b, trust: "verified", rtt: 38)]
    }

    func message(_ id: String) -> ChatMessage? { messages.last { $0.id == id } }
    func peerName(_ peerId: String) -> String? { peers.first { $0.id == peerId }?.name }
    func isHeld(_ messageId: String?) -> Bool { false }
    func heldCount(_ peerId: String) -> Int { 0 }
    func profile(of peerId: String) -> JSONObject? { profiles[peerId] }
    func accountKey(of peerId: String) -> String { accountKeys[peerId] ?? "" }
    func safetyKeys(_ peerId: String) -> SafetyKeys { SafetyKeys(mine: myPublicKey, theirs: people.first { $0.id == peerId }?.publicKey ?? "") }
    func safetyNumber(_ peerId: String) -> String { Safety.number(myPublicKey, safetyKeys(peerId).theirs) }
    func canPrivate(_ peerId: String) -> Bool { peers.contains { $0.id == peerId } }

    @discardableResult func send(_ o: Outgoing) -> String { "" }
    func sendFile(vaultId: String, name: String, mime: String, size: Int64, _ o: Outgoing) {}
    func markRead(_ ids: [String]) {}
    func touch(_ id: String, _ change: @escaping @Sendable (inout ChatMessage) -> Void) {
        guard let i = messages.lastIndex(where: { $0.id == id }) else { return }
        change(&messages[i])
    }
    func hide(_ id: String, until: Int64, unlock: String?, why: String?) {
        hideCalls.append((id, until, unlock, why))
        touch(id) { m in m.hiddenUntil = until; m.hiddenFor = unlock; _ = m.mark("hidden", why ?? "") }
    }
    func deleteLocal(_ id: String) { messages.removeAll { $0.id == id } }
    func vanished(_ id: String) {}
    func identityVerified(_ peerId: String, _ on: Bool) { verifiedCalls.append((peerId, on)) }
    func addNote(text: String, fileName: String?, fileMime: String?, dataUrl: String?, filePath: String?, fileSize: Int64, toLabel: String?) {}
    func startFnCall(keyword: String, name: String, query: String, icon: String) -> ChatMessage? { nil }
    func fnCallStatus(_ id: String, kind: String, label: String, code: String) {}
    func fnCallProgress(_ id: String, progress: Double, text: String) {}
    func addModelAnswer(identity: JSONObject, text: String, share: JSONObject?, local: JSONObject?, replyTo: ChatMessage?) -> ChatMessage? { nil }
    func refreshStats() { statsRefreshed += 1 }

    func peerStats(_ peerId: String) -> RtcStatsSummary? { stats[peerId] }
    func forwardVerified(_ message: ChatMessage) -> Bool { forwards.contains(message.id) }
    func profileChanged() { profileChanges += 1 }
}

@MainActor
@Observable
final class PeopleFakeRooms: RoomsModel {
    var rooms: [PeopleFakeRoom]
    var activeKey: String
    var ktAlert = ""

    init(_ rooms: [PeopleFakeRoom]) {
        self.rooms = rooms
        activeKey = rooms.first?.key ?? ""
    }

    var loaded: Bool { true }
    var items: [RoomItem] { [] }
    var open: [any RoomModel] { rooms }
    var selectedCount: Int { 0 }
    var connectedCount: Int { rooms.count }
    var unreadTotal: Int { 0 }
    var maxRooms: Int { 8 }
    func room(_ key: String) -> (any RoomModel)? { rooms.first { $0.key == key } }
    func byServerId(_ id: String) -> (any RoomModel)? { nil }
    func saved(_ key: String) -> SavedRoom? { nil }
    func card(_ key: String) -> JSONObject? { nil }
    func switchTo(_ key: String) { activeKey = key }
    func toggleSelected(_ key: String) {}
    func connectSelected() {}
    func leave(_ key: String) {}
    func forget(_ key: String) {}
    func join(room: String, passphrase: String, userName: String) -> String { "" }
    func clone(_ key: String) -> String? { nil }
    func update(_ oldKey: String, room: String, passphrase: String, userName: String) -> String? { nil }
    func setVisible(_ visible: Bool) {}
    func dismissKtAlert() { ktAlert = "" }
}

@MainActor
@Observable
final class PeopleFakeAccount: AccountModel {
    var signedIn = true
    var username = "bystry-sokol-7k3q"
    var scope: DesignValue { ["signedIn": .bool(signedIn), "username": .string(username)] }
    func bearer() async -> String { "" }
}

/// The address book with one contact the person picks (Alice's card), readable in full.
final class PeopleFakeAddressBook: ContactStoreAccess, @unchecked Sendable {
    var access: ContactsAccess = .full
    var cards: [String: ContactCard] = ["ABC-123": ContactCard(identifier: "ABC-123", name: "Alice Nováková", thumbnail: nil)]
    var asked = 0
    func requestAccess() async -> Bool { asked += 1; return true }
    func contact(_ identifier: String) -> ContactCard? { cards[identifier] }
}

/// The system's suggestions, counted.
@MainActor
final class PeopleFakeDonations: PeopleDonating {
    var donated: [String] = []
    var removed: [String] = []
    var removedAll = 0
    func donate(username: String, contact: ContactCard) { donated.append(username) }
    func remove(username: String) { removed.append(username) }
    func removeAll() { removedAll += 1 }
}

/// The app's ContactsService over the test's store, with the picker answering as told.
@MainActor
final class PeopleFakeContacts: PeopleContacts {
    let service: ContactsService
    let book = PeopleFakeAddressBook()
    let donations = PeopleFakeDonations()
    var pick: ContactCard? = ContactCard(identifier: "ABC-123", name: "Alice Nováková", thumbnail: nil)

    init(store: PeopleStore) {
        service = ContactsService(store: store, contacts: book, donations: donations)
    }

    func requestAccess() async -> Bool { await service.requestAccess() }
    func pickContact() async -> ContactCard? { pick }
    func link(username: String, signedIn: Bool, contact: ContactCard, enabled: Bool) -> String? {
        service.link(username: username, signedIn: signedIn, contact: contact, enabled: enabled)
    }
    func unlink(username: String) { service.unlink(username: username) }
    func unlinkAll() { service.unlinkAll() }
    func setEnabled(_ on: Bool) { service.setEnabled(on) }
    func contactPhoto(of username: String) async -> Data? { await service.contactPhoto(of: username) }
}

/// A test core: the fake rooms, an account, People's services in memory, a window host with its own settings.
@MainActor
struct PeopleWorld {
    let core: CoreModels
    let room: PeopleFakeRoom
    let rooms: PeopleFakeRooms
    let host: DesignHost
    let people: PeopleModel
    let profiles: MemoryProfiles
    let vault: PeopleMemoryVault
    let contacts: PeopleFakeContacts

    static func make(card: JSONObject? = MemoryProfiles.sampleCard()) -> PeopleWorld {
        let room = PeopleFakeRoom()
        let rooms = PeopleFakeRooms([room])
        let core = CoreModels(rooms: rooms, account: PeopleFakeAccount())
        CoreModels.shared = core
        let vault = PeopleMemoryVault()
        let store = PeopleStore(vault: vault, clock: ClosureClock { 1_760_000_100_000 })
        let people = PeopleModel(store: store)
        let profiles = MemoryProfiles(card: card)
        people.profiles = { profiles }
        people.now = { PeopleFakeRoom.t0 }
        people.core = { core }
        let contacts = PeopleFakeContacts(store: store)
        people.contacts = contacts
        PeopleParts.profiles = profiles
        let host = RendererTestSupport.host(state: StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false, hasActiveRoom: true)))
        return PeopleWorld(core: core, room: room, rooms: rooms, host: host, people: people, profiles: profiles, vault: vault, contacts: contacts)
    }

    func users() -> [JSONObject] { people.users(room, form: host.form, settings: host.settings, t: host.peopleText) }

    func person(_ id: String) -> JSONObject? { people.person(room, id, form: host.form, settings: host.settings, t: host.peopleText) }

    /// Lets the main actor run the tasks the actions started.
    static func settle(_ seconds: Double = 0.3) async {
        try? await Task.sleep(for: .seconds(seconds))
    }
}
