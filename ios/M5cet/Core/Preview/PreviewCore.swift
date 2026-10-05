// DEBUG only: the core without the engine — rooms, messages, people and an
// account made from the console's sample data (Renderer/Debug/SampleScreenData)
// plus a few messages of every kind, so the parts can be built, previewed and
// screenshotted (`-M5Screen room`) before the engine runs. Operations work in
// memory: send appends a bubble (sending → sent → delivered), hide / delete /
// touch change the list, join / leave / switch move the rooms.
//
//   PreviewCore.install()                 // CoreModels.shared = the sample core
//   #Preview { MessagesPart().task { PreviewCore.install() } }

#if DEBUG
import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Proto
import Observation

@MainActor
enum PreviewCore {
    /// Installs the sample core as CoreModels.shared (idempotent) and returns it.
    @discardableResult
    static func install() -> CoreModels {
        if let c = installed { CoreModels.shared = c; return c }
        let rooms = PreviewRooms()
        let core = CoreModels(rooms: rooms, account: PreviewAccount())
        core.userName = "Mike"
        core.server = "https://chat.example.com"
        core.files = PreviewFiles()
        core.position = PreviewPosition()
        core.tools.nfcAvailable = true
        core.tools.voice = ["dictating": false, "listening": false, "speaking": false, "available": true]
        installed = core
        CoreModels.shared = core
        return core
    }

    private static var installed: CoreModels?

    /// The console's samples by screen ("rooms" → $rooms…).
    static let samples: [String: DesignValue] = (try? DesignValue.parse(SampleScreenData.json))?.objectValue ?? [:]

    static let t0: Int64 = 1_760_000_000_000
}

@MainActor
@Observable
final class PreviewRooms: RoomsModel {
    var loaded = true
    private(set) var saved: [SavedRoom] = []
    private(set) var sessions: [String: PreviewRoom] = [:]
    var activeKey = "team"
    var ktAlert = ""
    var visible = false

    init() {
        let list = PreviewCore.samples["rooms"]?["rooms"].arrayValue ?? []
        for (i, r) in list.enumerated() {
            let key = r["key"].stringValue ?? "room\(i)"
            let label = key == "team" ? "Tým" : key == "family" ? "Rodina" : key
            saved.append(SavedRoom(key: key, room: key, label: label, passphrase: "sample-passphrase", userName: "Mike",
                                   selected: r["selected"].boolValue ?? false, lastActive: PreviewCore.t0 - Int64(i) * 60_000))
            if r["connected"].boolValue == true {
                let room = PreviewRoom(key: key, label: label, sample: key == "team")
                room.unread = Int(r["unread"].numberValue ?? 0)
                sessions[key] = room
            }
        }
    }

    var items: [RoomItem] {
        saved.sorted { max($0.lastActive, sessions[$0.key]?.lastActivity ?? 0) > max($1.lastActive, sessions[$1.key]?.lastActivity ?? 0) }.map { s in
            let r = sessions[s.key]
            return RoomItem(key: s.key, name: s.label, room: s.room, users: r?.userCount ?? 0, unread: r?.unread ?? 0, active: s.key == activeKey,
                            connected: r?.connected ?? false, status: r?.status ?? "saved", selected: s.selected)
        }
    }

    var open: [any RoomModel] { sessions.values.sorted { $0.lastActivity > $1.lastActivity } }
    var selectedCount: Int { saved.filter { $0.selected && sessions[$0.key] == nil }.count }
    var connectedCount: Int { sessions.values.filter(\.connected).count }
    var unreadTotal: Int { sessions.values.reduce(0) { $0 + $1.unread } }
    var maxRooms: Int { 8 }

    func room(_ key: String) -> (any RoomModel)? { sessions[key] }
    func byServerId(_ id: String) -> (any RoomModel)? { nil }
    func saved(_ key: String) -> SavedRoom? { saved.first { $0.key == key } }
    func card(_ key: String) -> JSONObject? { saved(key)?.card }

    func switchTo(_ key: String) {
        if sessions[key] == nil { connect(key) }
        activeKey = key
        sessions[key]?.unread = 0
    }

    private func connect(_ key: String) {
        guard let s = saved(key), sessions[key] == nil else { return }
        sessions[key] = PreviewRoom(key: key, label: s.label, sample: false)
        if let i = saved.firstIndex(where: { $0.key == key }) { saved[i].selected = true }
    }

    func toggleSelected(_ key: String) { if let i = saved.firstIndex(where: { $0.key == key }) { saved[i].selected.toggle() } }

    func connectSelected() {
        for s in saved where s.selected { connect(s.key) }
        if activeKey.isEmpty, let first = saved.first(where: \.selected) { switchTo(first.key) }
    }

    func leave(_ key: String) {
        let k = key.isEmpty ? activeKey : key
        sessions[k] = nil
        if let i = saved.firstIndex(where: { $0.key == k }) { saved[i].selected = false }
        if k == activeKey { activeKey = open.first?.key ?? "" }
    }

    func forget(_ key: String) {
        leave(key)
        saved.removeAll { $0.key == key }
    }

    func join(room: String, passphrase: String, userName: String) -> String {
        var s = SavedRooms.make(roomName: room, passphrase: passphrase, userName: userName, now: EpochMs.now)
        if let i = saved.firstIndex(where: { $0.key == s.key }) { s.lastActive = EpochMs.now; saved[i] = s } else { saved.append(s) }
        connect(s.key)
        switchTo(s.key)
        return s.key
    }

    func clone(_ key: String) -> String? {
        guard let s = saved(key) else { return nil }
        let c = SavedRooms.copy(s, keys: Set(saved.map(\.key)), now: EpochMs.now)
        saved.append(c)
        return c.key
    }

    func update(_ oldKey: String, room: String, passphrase: String, userName: String) -> String? {
        guard let i = saved.firstIndex(where: { $0.key == oldKey }) else { return nil }
        let n = SavedRooms.make(roomName: room, passphrase: passphrase, userName: userName, now: saved[i].lastActive)
        saved[i] = SavedRoom(key: n.key, room: n.room, label: n.label, passphrase: passphrase, userName: userName, selected: saved[i].selected, lastActive: saved[i].lastActive)
        return n.key
    }

    func setVisible(_ visible: Bool) { self.visible = visible; if visible { sessions[activeKey]?.unread = 0 } }
    func dismissKtAlert() { ktAlert = "" }
}

@MainActor
@Observable
final class PreviewRoom: RoomModel {
    let key: String
    var room: String { key }
    let label: String
    var status = "joined"
    var notice = ""
    var connected: Bool { status == "joined" }
    var unread = 0
    var lastActivity: Int64 = PreviewCore.t0
    var messages: [ChatMessage] = []
    var restores = 1
    var historyReady = true
    var freshId: String?
    var revealRequest: String?
    let myId = "peer-me"
    let myName = "Mike"
    let myPublicKey = "BPreviewMyKey"
    var people: [PersonItem] = []
    var peers: [PeerRef] = []
    var userCount: Int { people.filter { $0.channel == "open" }.count }
    var call = CallInfo()
    var ktAlert = ""
    private var hidden: Set<String> = []

    init(key: String, label: String, sample: Bool) {
        self.key = key
        self.label = label
        people = Self.samplePeople()
        peers = people.filter { !$0.me && $0.channel == "open" }.map { PeerRef(id: $0.id, name: $0.name) }
        messages = sample ? Self.sampleMessages(key) : [ChatMessage.system(roomKey: key, text: "Alice joined", now: PreviewCore.t0)]
        lastActivity = messages.last?.createdAt ?? PreviewCore.t0
    }

    var scope: DesignValue {
        ["key": .string(key), "name": .string(label), "users": .number(Double(userCount)), "unread": .number(Double(unread)), "status": .string(status),
         "connected": .bool(connected), "notice": .string(notice), "active": .bool(CoreModels.shared.rooms.activeKey == key)]
    }

    func message(_ id: String) -> ChatMessage? { messages.last { $0.id == id } }
    func peerName(_ peerId: String) -> String? { peers.first { $0.id == peerId }?.name }
    func isHeld(_ messageId: String?) -> Bool { false }
    func heldCount(_ peerId: String) -> Int { 0 }
    func profile(of peerId: String) -> JSONObject? { peerId == "peer-alice" ? JSONObject([("nickname", "Alice"), ("about", "Lezu a piju kávu.")]) : nil }
    func accountKey(of peerId: String) -> String { "" }
    func safetyKeys(_ peerId: String) -> SafetyKeys { SafetyKeys(mine: myPublicKey, theirs: people.first { $0.id == peerId }?.publicKey ?? "") }
    func safetyNumber(_ peerId: String) -> String { "13286 60170 84613 24995\n23962 36648 18264 48418\n04707 59157 69365 29038" }
    func canPrivate(_ peerId: String) -> Bool { peers.contains { $0.id == peerId } }

    @discardableResult
    func send(_ o: Outgoing) -> String {
        var m = ChatMessage()
        m.id = "msg-" + String(UInt64.random(in: 0..<UInt64.max), radix: 16)
        m.roomKey = key
        m.text = o.text
        m.createdAt = EpochMs.now
        m.senderName = myName
        m.senderId = myId
        m.mine = true
        m.verified = true
        m.status = "sending"
        m.mark("created", "", at: m.createdAt)
        m.tap = o.tap
        m.vanishSeconds = o.vanishSeconds
        m.to = o.recipientNames
        m.forwardedFrom = o.forwardedFrom
        m.loc = o.loc
        if let r = o.replyTo { m.replyToId = r.id; m.replyToSender = r.senderName; m.replyToText = r.visibleText }
        if let d = o.dataUrl { m.fileName = o.fileName; m.fileMime = o.fileMime; m.fileSize = o.fileSize; m.fileDataUrl = d; m.fileImage = o.fileImage }
        if let code = o.sealCode, !m.text.isEmpty { m.sealCode = code.isEmpty ? Sealed.newCode() : code; m.sealPlain = m.text }
        messages.append(m)
        freshId = m.id
        lastActivity = m.createdAt
        let id = m.id
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            self?.touch(id) { $0.raise("sent") }
            try? await Task.sleep(for: .milliseconds(900))
            self?.touch(id) { $0.raise("delivered", who: "Alice") }
        }
        return id
    }

    func sendFile(vaultId: String, name: String, mime: String, size: Int64, _ o: Outgoing) {
        var m = ChatMessage()
        m.id = "msg-" + String(UInt64.random(in: 0..<UInt64.max), radix: 16)
        m.roomKey = key; m.createdAt = EpochMs.now; m.mine = true; m.senderName = myName; m.senderId = myId; m.status = "sent"
        m.fileName = name; m.fileMime = mime; m.fileSize = size; m.filePath = vaultId; m.fileProgress = -1; m.text = o.text
        messages.append(m)
        freshId = m.id
    }

    func markRead(_ ids: [String]) { unread = 0 }

    func touch(_ id: String, _ change: @escaping @Sendable (inout ChatMessage) -> Void) {
        guard let i = messages.lastIndex(where: { $0.id == id }) else { return }
        change(&messages[i])
    }

    func hide(_ id: String, until: Int64, unlock: String?, why: String?) {
        touch(id) { m in m.hiddenUntil = until; m.hiddenFor = unlock; m.mark("hidden", why ?? "") }
    }

    func deleteLocal(_ id: String) { messages.removeAll { $0.id == id } }
    func vanished(_ id: String) { touch(id) { $0.vanished = true } }
    func identityVerified(_ peerId: String, _ on: Bool) {}

    func addNote(text: String, fileName: String?, fileMime: String?, dataUrl: String?, filePath: String?, fileSize: Int64, toLabel: String?) {
        var m = ChatMessage()
        m.id = "note-" + String(EpochMs.now, radix: 36)
        m.roomKey = key; m.kind = "note"; m.mine = true; m.senderName = myName; m.createdAt = EpochMs.now; m.text = text; m.status = "sent"
        m.fileName = fileName; m.fileMime = fileMime; m.fileDataUrl = dataUrl; m.filePath = filePath; m.fileSize = fileSize
        messages.append(m)
    }

    func startFnCall(keyword: String, name: String, query: String, icon: String) -> ChatMessage? {
        var m = ChatMessage()
        m.id = "fncall-" + String(EpochMs.now, radix: 36)
        m.roomKey = key; m.mine = true; m.senderName = myName; m.createdAt = EpochMs.now; m.status = "sent"; m.text = query
        m.fnLocal = JSONObject([("keyword", .string(keyword)), ("name", .string(name)), ("icon", .string(icon)), ("query", .string(query)), ("pending", true)])
        messages.append(m)
        return m
    }

    func fnCallStatus(_ id: String, kind: String, label: String, code: String) {
        touch(id) { m in
            m.fnLocal?["pending"] = false
            m.fnLocal?["status"] = .object(JSONObject([("kind", .string(kind)), ("label", .string(label)), ("code", .string(code))]))
        }
    }

    func fnCallProgress(_ id: String, progress: Double, text: String) {
        touch(id) { m in m.fnLocal?["progress"] = .double(progress); m.fnLocal?["progressText"] = .string(text) }
    }

    func addModelAnswer(identity: JSONObject, text: String, share: JSONObject?, local: JSONObject?, replyTo: ChatMessage?) -> ChatMessage? {
        var m = ChatMessage()
        m.id = "msg-" + String(EpochMs.now, radix: 36)
        m.roomKey = key; m.mine = true; m.senderName = myName; m.createdAt = EpochMs.now; m.status = "sent"; m.text = text
        m.model = identity; m.fn = share; m.fnLocal = local
        messages.append(m)
        return m
    }

    func refreshStats() {}

    // MARK: samples

    static func samplePeople() -> [PersonItem] {
        func p(_ id: String, _ name: String, me: Bool = false, channel: String = "open", user: String = "", trust: String = "new", proto: String = "p4") -> PersonItem {
            PersonItem(scope: JSONObject([("id", .string(id)), ("name", .string(name)), ("me", .bool(me)), ("channel", .string(channel)), ("username", .string(user)),
                                          ("signedIn", .bool(!user.isEmpty)), ("since", .int(PreviewCore.t0)), ("audio", "off"), ("signed", .bool(channel == "open")),
                                          ("changed", false), ("publicKey", .string(channel == "open" ? "BKey" + id : "")), ("trust", .string(trust)),
                                          ("trustLabel", .string(trust == "verified" ? "Ověřeno" : "Nový")), ("protocol", .string(proto)),
                                          ("legacy", .bool(proto == "legacy")), ("held", 0), ("kt", ""), ("connected", .bool(channel == "open")),
                                          ("foreground", .bool(channel == "open")), ("lastSeen", .int(PreviewCore.t0)), ("rtt", .double(channel == "open" ? 38 : -1))]))
        }
        return [p("peer-me", "Mike", me: true, user: "bystry-sokol-7k3q", trust: "verified"),
                p("peer-alice", "Alice", user: "alice", trust: "verified"),
                p("peer-bob", "Bob", proto: "legacy"),
                p("away:acc-eva", "Eva", channel: "away", user: "eva")]
    }

    static func sampleMessages(_ room: String) -> [ChatMessage] {
        var out = [ChatMessage]()
        var t = PreviewCore.t0
        func msg(_ id: String, _ text: String, mine: Bool = false, from: String = "Alice", _ edit: (inout ChatMessage) -> Void = { _ in }) {
            var m = ChatMessage()
            m.id = id; m.roomKey = room; m.text = text; m.createdAt = t; m.mine = mine
            m.senderName = mine ? "Mike" : from; m.senderId = mine ? "peer-me" : (from == "Alice" ? "peer-alice" : "peer-bob")
            m.status = mine ? "read" : "received"; m.verified = true
            m.mark("created", "", at: t)
            edit(&m)
            out.append(m)
            t += 60_000
        }
        out.append(ChatMessage.system(roomKey: room, text: "Alice joined", now: t)); t += 1000
        msg("m1", "Ahoj, jak to jde?")
        msg("m2", "Dobře, díky! Posílám plán na zítřek.", mine: true) { $0.replyToId = "m1"; $0.replyToSender = "Alice"; $0.replyToText = "Ahoj, jak to jde?" }
        msg("m3", "", from: "Bob") { m in
            m.fileName = "plan.pdf"; m.fileMime = "application/pdf"; m.fileSize = 182_331; m.filePath = "in-sample"; m.fileProgress = -1
        }
        msg("m4", "📍 50.08804, 14.42076 (±12 m) https://www.openstreetmap.org/?mlat=50.088040&mlon=14.420760#map=15/50.088040/14.420760") { m in
            m.loc = JSONObject([("lat", .double(50.08804)), ("lon", .double(14.42076)), ("acc", 12), ("at", .int(t))])
        }
        msg("m5", "Tajný kód je v zapečetěné zprávě.", mine: true) { m in m.sealCode = "K7Q2"; m.sealPlain = m.text; m.sealed = JSONObject([("v", 1)]) }
        msg("m6", "Přečti a zmizí 👀") { m in m.tap = true }
        msg("m7", "Tahle zpráva zmizí za minutu.", from: "Bob") { m in m.vanishSeconds = 60 }
        msg("m8", "Jen pro tebe.", mine: true) { m in m.to = ["Alice"]; m.status = "delivered" }
        msg("m9", "Super, jdu na to 👍")
        return out
    }
}

@MainActor
@Observable
final class PreviewAccount: AccountModel {
    var signedIn = true
    var username = "bystry-sokol-7k3q"
    var scope: DesignValue { PreviewCore.samples["settings.user"]?["account"] ?? ["signedIn": .bool(signedIn), "username": .string(username)] }
    func bearer() async -> String { "" }
}

/// Files in memory.
@MainActor
final class PreviewFiles: MessageFiles {
    private var data: [String: Data] = [:]
    func store(_ d: Data) throws -> String { let id = "out-\(EpochMs.now)"; data[id] = d; return id }
    func store(contentsOf url: URL) throws -> (id: String, size: Int64) { let d = try Data(contentsOf: url); return (try store(d), Int64(d.count)) }
    func read(_ id: String) throws -> Data { data[id] ?? Data("M5cet sample file\n".utf8) }
    func temporaryCopy(_ id: String, name: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try read(id).write(to: url)
        return url
    }
    func discard(_ copy: URL) { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
}

/// Prague, always.
@MainActor
final class PreviewPosition: PositionSource {
    var permitted: Bool { true }
    func recent() -> JSONObject? { JSONObject([("lat", .double(50.08804)), ("lon", .double(14.42076)), ("acc", 12), ("at", .int(EpochMs.now))]) }
    func current() async -> JSONObject? { recent() }
}
#endif
