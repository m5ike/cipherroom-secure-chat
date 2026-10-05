// One connected room (android chat/RoomSession.java — its connection, its
// wiring and what its UI reads): M5Net's HubConnection (the socket: join with
// the room proof, resume, auth, presence, ping, reconnect) ↔ M5Proto's
// RoomSession actor (the chat protocol) ↔ the room's WebRTC side (RoomWire:
// RoomRtc in the app). Main-actor, @Observable: the parts read it as RoomModel.
//
// The room's history is in its list from the start (History, record
// "hist-<hash>"), saved soon after each change; while the app is locked what
// would be stored goes into the lock inbox instead (LockedRooms items).

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import Observation
import os

@MainActor
@Observable
final class RoomController: RoomModel {
    let key: String
    let room: String
    private(set) var label: String
    @ObservationIgnored let passphrase: String
    let myName: String

    private(set) var status = "offline"
    private(set) var notice = ""
    var unread = 0
    private(set) var lastActivity: Int64 = 0
    private(set) var messages: [ChatMessage] = []
    private(set) var restores = 0
    private(set) var historyReady = false
    private(set) var freshId: String?
    var revealRequest: String?
    private(set) var myId = ""
    private(set) var myPublicKey = ""
    private(set) var people: [PersonItem] = []
    private(set) var peers: [PeerRef] = []
    private(set) var userCount = 0
    private(set) var call = CallInfo()
    private(set) var ktAlert = ""
    /// The user panel's $users list (RoomSession.usersScope).
    private(set) var users: [DesignValue] = []

    var connected: Bool { status == "joined" }

    @ObservationIgnored weak var rooms: RoomsController?
    @ObservationIgnored private(set) var session: RoomSession?
    @ObservationIgnored private(set) var keys: RoomKeys?
    @ObservationIgnored private(set) var connection: HubConnection?
    @ObservationIgnored private(set) var wire: (any RoomWire)?
    @ObservationIgnored private var bridge: RoomBridge?
    @ObservationIgnored private var input: AsyncStream<RoomInput>.Continuation?
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private(set) var snap = RoomSnap()
    @ObservationIgnored private var refreshQueued = false
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var wanted = false
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var socketOpen = false
    /// The hub's hello features (6.14 "call-wake").
    @ObservationIgnored private(set) var hubFeatures: Set<String> = []
    /// 6.14 (call wake): my audio as I last announced it; the relayed rings waiting for the room to show the call.
    @ObservationIgnored private var myAudio = "off"
    @ObservationIgnored private var wakeInbox = CallWake.Inbox()
    @ObservationIgnored private var wakeTimer: Task<Void, Never>?
    /// Peers' names announced before their first signal (Rooms.pendingNames).
    @ObservationIgnored private var pendingNames: [String: String] = [:]
    @ObservationIgnored lazy var files = RoomFiles(room: self)
    @ObservationIgnored private var foreground = true
    nonisolated static let log = Logger(subsystem: "cz.m5cet.app", category: "room")

    init(saved: SavedRoom, userName: String, rooms: RoomsController) {
        key = saved.key
        room = saved.room
        label = saved.label
        passphrase = saved.passphrase
        myName = userName
        self.rooms = rooms
        lastActivity = saved.lastActive
    }

    private func t(_ key: String) -> String { rooms?.core?.t(key) ?? key }

    // MARK: - connect / disconnect (RoomSession.connect, disconnect, destroy)

    /// Connects (and keeps reconnecting); the history comes into the list first.
    func connect() {
        if wanted, let c = connection { Task { await c.connect() }; return }
        wanted = true
        guard !starting, session == nil else { return }
        starting = true
        status = "connecting"
        notice = t("app.decrypting")
        Task { await start() }
    }

    private func start() async {
        defer { starting = false }
        guard let rooms, let core = rooms.core else { return }
        let (r, pass) = (room, passphrase)
        let derived: RoomKeys
        do {
            derived = try await Task.detached(priority: .userInitiated) { try RoomKeys.derive(room: r, passphrase: pass) }.value
        } catch {
            status = "offline"
            notice = error.localizedDescription
            return
        }
        guard wanted else { return }
        guard let identity = core.security.chatIdentity(create: true) else {
            status = "offline"
            notice = t("room.locked")
            return
        }
        keys = derived
        myPublicKey = identity.publicKey
        let bridge = RoomBridge()
        bridge.controller = self
        self.bridge = bridge
        let pins = rooms.pins
        let device = rooms.p4
        let session = RoomSession(key: key, room: room, label: label, userName: myName, keys: derived, identity: identity, transport: bridge, events: bridge,
                                  device: device, pins: pins, verifiedDevice: rooms.verifiedDevice,
                                  settings: rooms.roomSettings(foreground: foreground), ktFetch: rooms.ktFetcher)
        self.session = session
        // The inputs, in order, one at a time.
        let (stream, cont) = AsyncStream<RoomInput>.makeStream(bufferingPolicy: .unbounded)
        input = cont
        tasks.append(Task.detached { for await i in stream { await RoomController.run(i, session) } })
        // The history into the list (6.12 F-16: not while the unlock merges the lock inbox — restoreAll does it after).
        if !rooms.draining { await restoreHistory() }
        wire = rooms.wires.attach(roomKey: key, label: label, controller: self)
        let hubRoom = HubRoom(key: key, server: rooms.server, roomId: derived.roomId, name: myName)
        guard let conn = await rooms.hub.open(hubRoom, proofSigner: HubSeedSigner(seed: derived.hubSeed())) else {
            Self.log.warning("at most \(rooms.maxRooms) rooms at once")
            status = "offline"
            notice = t("rooms.max")
            return
        }
        guard wanted else { await rooms.hub.close(key); return }
        connection = conn
        // Frames of the room core for the hub, in order.
        let frames = bridge.hubFrames
        tasks.append(Task.detached {
            for await f in frames {
                guard let typed = HubFrameBridge.clientFrame(f) else { continue }
                _ = await conn.send(typed)
            }
        })
        // What the hub says, in order, on the main actor.
        tasks.append(Task { @MainActor [weak self] in
            for await ev in conn.events { self?.onHub(ev) }
        })
        await session.refreshKt()
        scheduleRefresh()
    }

    private nonisolated static func run(_ i: RoomInput, _ s: RoomSession) async {
        switch i {
        case .socketOpened: await s.socketOpened()
        case .socketClosed(let code): await s.socketClosed(code: code)
        case .hub(let f): await s.hubFrame(f)
        case .channelOpened(let p): await s.channelOpened(p)
        case .channelGone(let p): await s.channelGone(p)
        case .text(let p, let t): await s.peerText(p, t)
        }
    }

    private func send(_ i: RoomInput) { input?.yield(i) }

    /// Leaves: `leave`, the socket closed, the call recorded, everything of the connection forgotten.
    func disconnect() async {
        wanted = false
        saveNow()
        if let rooms { await rooms.hub.close(key) }
        connection = nil
        files.clear()
        bridge?.clearOpen()
        bridge?.finish()
        input?.finish()
        input = nil
        for t in tasks { t.cancel() }
        tasks.removeAll()
        if let s = session { await s.disconnected() }
        rooms?.wires.detach(roomKey: key)
        wire = nil
        session = nil
        socketOpen = false
        status = "offline"
        call = CallInfo()
    }

    /// The app went to the background / came back (presence, last seen).
    func setForeground(_ on: Bool) {
        foreground = on
        if !on { saveNow() }
        guard let s = session, let rooms else { return }
        let settings = rooms.roomSettings(foreground: on)
        Task { await s.setSettings(settings) }
    }

    /// Settings changed (receipts, read receipts, the account): the room reads them anew.
    func settingsChanged() {
        guard let s = session, let rooms else { return }
        let settings = rooms.roomSettings(foreground: foreground)
        Task { await s.setSettings(settings) }
    }

    // MARK: - the hub (HubConnection events)

    private func onHub(_ ev: HubEvent) {
        switch ev {
        case .status(let st):
            switch st {
            case .joining:
                socketOpen = true
                send(.socketOpened)
            case .offline, .connecting:
                if socketOpen { socketOpen = false; send(.socketClosed(1006)) }
            case .stopped(let reason):
                if socketOpen { socketOpen = false }
                switch reason {
                case .replaced: send(.socketClosed(4001))
                case .closedByServer: send(.socketClosed(4003))
                case .left, .paused: send(.socketClosed(1000))
                case .roomBlocked, .roomFull, .proofRefused: break // the room core said so from the error frame
                }
            case .joined: break // the joined frame tells the core
            }
        case .frame(let frame, let raw):
            guard let o = HubFrameBridge.object(raw) else { return }
            switch frame {
            case .hello(let h): hubFeatures = Set(h.features)
            case .joined: wire?.roomJoined()
            default: break
            }
            switch o.optString("type") {
            case "peer-joined": pendingNames[o.optString("peerId")] = o.optString("name")
            case "peer-updated": if let n = o.string("name") { wire?.renamePeer(id: o.optString("peerId"), name: n) }
            default: break
            }
            send(.hub(o))
        case .binary(let data):
            files.onBinary(nil, Array(data))
        case .notice:
            break
        }
    }

    // MARK: - the data channels (RoomRtcLink through RoomWire)

    func wireSignal(_ signal: JSONObject, to peerId: String) {
        guard let s = session else { return }
        Task { await s.sendSignal(peerId, signal) }
    }

    func wireReceive(_ description: JSONObject, from peerId: String) {
        wire?.receiveSignal(description, from: peerId, name: pendingNames[peerId])
    }

    func wireOpened(_ peerId: String) {
        bridge?.setOpen(peerId, true)
        send(.channelOpened(peerId))
        scheduleRefresh()
    }

    func wireClosed(_ peerId: String) {
        guard bridge?.isOpen(peerId) == true else { return }
        bridge?.setOpen(peerId, false)
        scheduleRefresh()
    }

    func wireText(_ text: String, from peerId: String) { send(.text(peer: peerId, text)) }

    /// A frame for the hub from the app's side (file transfers), in order with the core's.
    func sendHubFrame(_ f: JSONObject) { bridge?.sendHub(f) }

    /// The peers that read binary file chunks (their hello's "bin").
    func binaryPeers() async -> Set<String> {
        guard let s = session else { return [] }
        return await s.local { Set($0.peerList.filter(\.bin).map(\.id)) }
    }

    func wireBinary(_ data: Data, from peerId: String) { files.onBinary(peerId, Array(data)) }

    /// audio-status to everyone (sealed like a message). 6.14 (call wake): my call starting rings the away members
    /// when nobody else is in it, hanging up unanswered ends that ring (Android Calls.startAudio / stop →
    /// RoomSession.ringAway / endRing).
    func broadcastAudio(_ state: String) {
        guard let s = session else { return }
        let was = myAudio
        myAudio = state
        let starts = state == "live" && was == "off", stops = state == "off" && was != "off"
        let others = othersInCallCount
        let video = wire?.callWantsVideo ?? false
        Task {
            await s.broadcastAudio(state)
            if starts { await s.ringAway(video: video, othersInCall: others) }
            if stops { await s.endRing() }
        }
        scheduleRefresh()
    }

    // MARK: - 6.14 call wake: relayed rings until the room shows the call, or they are missed (Calls.wakeInbox)

    /// How many others' audio is on here now (Calls.othersInCallCount).
    private var othersInCallCount: Int { wire?.peerStates.filter { $0.audio != "off" && $0.status != "closed" }.count ?? 0 }

    /// A relayed call item (RoomCore's relay-deliver): never rings by itself — the room does, or it is a missed call.
    func onRelayedWake(_ item: CallWake.Item) {
        // A VoIP push rang this call already: CallCenter has it (its ring, its record) — one record per call.
        if rooms?.pushOwnsCall(key) == true { return }
        applyWake(wakeInbox.relayed(item, now: EpochMs.now, roomInCall: othersInCallCount > 0))
    }

    /// A peer's audio-status: the room shows a call — the waiting rings are that call (its CallTrack records it).
    func peerAudioChanged(_ state: String) {
        guard state == "live" || state == "muted", wakeInbox.waiting else { return }
        _ = wakeInbox.roomInCall()
        applyWake(CallWake.Step())
    }

    private func applyWake(_ s: CallWake.Step) {
        if !s.records.isEmpty || s.missed != nil { rooms?.onCallWakeStep?(key, label, s) }
        wakeTimer?.cancel()
        wakeTimer = nil
        let next = wakeInbox.nextDue
        guard next > 0 else { return }
        let wait = max(100, next - EpochMs.now + 50)
        wakeTimer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(wait))
            guard !Task.isCancelled, let self else { return }
            // A call that showed meanwhile is the room's; the rest is due now.
            if self.othersInCallCount > 0 { _ = self.wakeInbox.roomInCall() }
            self.applyWake(self.wakeInbox.due(now: EpochMs.now))
        }
    }

    // MARK: - what the core says

    func coreAdded(_ m: ChatMessage, fresh: Bool) {
        if let i = messages.lastIndex(where: { $0.id == m.id }) { messages[i] = m } else {
            messages.append(m)
            if messages.count > 600 { messages.removeFirst(messages.count - 600) }
        }
        lastActivity = max(lastActivity, m.createdAt)
        if fresh || m.mine { freshId = m.id }
        rooms?.onMessage(self, m, fresh: fresh)
        scheduleRefresh()
    }

    func coreChanged(_ m: ChatMessage) {
        if m.deleted {
            messages.removeAll { $0.id == m.id }
        } else if let i = messages.lastIndex(where: { $0.id == m.id }) {
            messages[i] = m
        }
        rooms?.onMessageChanged(self, m)
        scheduleRefresh()
    }

    func coreRoomChanged() { scheduleRefresh() }

    func joined(peerId: String, resume: String) {
        myId = peerId
        rooms?.saveResume(self, peerId: peerId, secret: resume)
    }

    func lockedState(messageId: String, who: String, name: String, state: String) {
        rooms?.lockedState(self, messageId: messageId, who: who, name: name, state: state)
    }

    func profileFrame(_ peerId: String, _ frame: JSONObject) { rooms?.core?.profiles?.frame(room: self, peerId: peerId, frame) }
    func profileHello(_ peerId: String, caps: [JSON]?) { rooms?.core?.profiles?.hello(room: self, peerId: peerId, caps: caps) }

    /// A copy of the core after a change (coalesced): status, peers, people, the list.
    func scheduleRefresh() {
        guard !refreshQueued else { return }
        refreshQueued = true
        Task { @MainActor [weak self] in
            await Task.yield()
            await self?.refreshNow()
        }
    }

    func refreshNow() async {
        refreshQueued = false
        guard let s = session else { return }
        let snap = await s.local { RoomSnap.of($0) }
        apply(snap)
    }

    private func apply(_ s: RoomSnap) {
        snap = s
        if status != s.status { status = s.status }
        if notice != s.notice { notice = s.notice }
        if myId != s.myId { myId = s.myId }
        if messages != s.messages { messages = s.messages }
        if let last = s.messages.last { lastActivity = max(lastActivity, last.createdAt) }
        let wirePeers = wire?.peerStates ?? []
        let open = Set(wire?.openPeerIds ?? [])
        let peerRefs = s.peers.filter { open.contains($0.id) }.map { PeerRef(id: $0.id, name: $0.name) }
        if peers != peerRefs { peers = peerRefs }
        let count = (connected ? 1 : 0) + wirePeers.filter { $0.status != "closed" }.count
        if userCount != count { userCount = count }
        let callNow = CallInfo(state: wire?.callState ?? "off", video: wire?.callVideo ?? false, peers: max(0, count - 1))
        if call != callNow { call = callNow }
        let account = rooms?.core?.account.username ?? ""
        let list = RoomPeople.people(s, wire: wirePeers, me: (myName, account, myPublicKey, wire?.callState ?? "off", foreground), connected: connected,
                                     now: EpochMs.now).map(PersonItem.init(scope:))
        if people != list { people = list }
        let u = RoomPeople.users(s, wire: wirePeers, myName: myName, myAudio: wire?.callState ?? "off", connected: connected)
        if users != u { users = u }
        rooms?.roomChanged(self)
    }

    // MARK: - history (History, Resume — records as Android's)

    /// The stored history into the list (Rooms.connect → session.restore(History.load)).
    func restoreHistory() async {
        guard let s = session, let core = rooms?.core, core.security.unlocked else { return }
        let history = History.load(core.security.userRecords, key)
        await s.restore(history)
        historyReady = true
        restores += 1
        await refreshNow()
    }

    /// History.saveSoon: in 1.5 s, once.
    func saveSoon() {
        guard saveTask == nil else { return }
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            self?.saveTask = nil
            self?.saveNow()
        }
    }

    /// History.saveSession: the list when the history is in it, else merged into the stored one (never over it).
    func saveNow() {
        saveTask?.cancel()
        saveTask = nil
        guard let core = rooms?.core, core.security.unlocked else { return }
        History.saveSession(core.security.userRecords, key, live: messages, historyReady: historyReady)
    }

    /// 6.12 (F-16): the app locked and the room keeps receiving — the history is saved and leaves the memory.
    func dropHistory() async {
        saveNow()
        historyReady = false
        messages = []
        guard let s = session else { return }
        await s.local { core in core.dropAll() }
        await refreshNow()
    }

    // MARK: - RoomModel: lookups

    var scope: DesignValue {
        ["key": .string(key), "name": .string(label), "users": .number(Double(userCount)), "unread": .number(Double(unread)), "status": .string(status),
         "connected": .bool(connected), "notice": .string(notice), "active": .bool(rooms?.activeKey == key)]
    }

    func message(_ id: String) -> ChatMessage? { messages.last { $0.id == id } }
    func peerName(_ peerId: String) -> String? { snap.peers.first { $0.id == peerId }?.name }
    func isHeld(_ messageId: String?) -> Bool { messageId.map { snap.heldIds.contains($0) } ?? false }
    func heldCount(_ peerId: String) -> Int { snap.peers.first { $0.id == peerId }?.held ?? 0 }
    func profile(of peerId: String) -> JSONObject? { rooms?.core?.profiles?.profile(of: peerId) }
    func accountKey(of peerId: String) -> String { rooms?.core?.profiles?.accountKey(room: self, peerId: peerId) ?? "" }

    /// § 12.2: both account keys when both sides are attested, else both device keys.
    func safetyKeys(_ peerId: String) -> SafetyKeys {
        let p = snap.peers.first { $0.id == peerId }
        let mine = rooms?.myAccountKey ?? ""
        if let p, !p.accountKey.isEmpty, !mine.isEmpty { return SafetyKeys(mine: mine, theirs: p.accountKey) }
        return SafetyKeys(mine: myPublicKey, theirs: p?.publicKey ?? "")
    }

    func safetyNumber(_ peerId: String) -> String {
        let k = safetyKeys(peerId)
        guard !k.mine.isEmpty, !k.theirs.isEmpty else { return "" }
        return ChatIdentity.safetyNumber(k.mine, k.theirs)
    }

    func canPrivate(_ peerId: String) -> Bool { bridge?.isOpen(peerId) == true && snap.peers.contains { $0.id == peerId && !$0.proto.isEmpty && !$0.downgrade } }

    // MARK: - profiles (RoomSession.profiles' Deps.send)

    /// A profile frame for one peer: sealed for it alone (the ratchet, or the pair key) — never the room key, never
    /// through the server. False when the sealed frame would not fit (ProfileRoom then sends it without the cover).
    func sendProfileFrame(_ peerId: String, _ frame: JSONObject) -> Bool {
        guard let s = session, bridge?.isOpen(peerId) == true, !myId.isEmpty else { return false }
        var payload = frame
        payload["kind"] = "profile"
        payload["id"] = .string("prof-" + Crypto.hex(Crypto.random(12)))
        payload["createdAt"] = .int(EpochMs.now)
        payload["senderId"] = .string(myId)
        payload["senderName"] = .string(myName)
        // The sealed frame (base64 of the padded body, either protocol) stays under the limit.
        if Pad.paddedLength(payload.stringify().utf8.count) * 4 / 3 + 2048 > ProfileRoom.frameMaxChars { return false }
        let sealedFor = payload
        Task { _ = await s.local { core in core.canPrivate(peerId) && core.privateTo(peerId, sealedFor) } }
        return true
    }

    // MARK: - RoomModel: messages

    @discardableResult
    func send(_ o: Outgoing) -> String {
        var o = o
        let id = o.id ?? "msg-" + Crypto.hex(Crypto.random(12))
        o.id = id
        guard let s = session else {
            notice = t("room.offline")
            return id
        }
        Task { await s.send(o) }
        return id
    }

    func sendFile(vaultId: String, name: String, mime: String, size: Int64, _ o: Outgoing) {
        guard let s = session else { return }
        let id = "file-" + Crypto.hex(Crypto.random(12))
        let loc = o.loc
        Task { @MainActor in
            let bubble = await s.local { $0.composeFile(vaultId: vaultId, name: name, mime: mime, size: size, loc: loc, id: id) }
            self.files.send(vaultId: vaultId, name: name, mime: Payloads.safeMime(mime), size: size, bubbleId: bubble.id)
        }
    }

    func markRead(_ ids: [String]) {
        unread = 0
        guard let s = session, !ids.isEmpty else { return }
        Task { await s.markRead(ids) }
    }

    func touch(_ id: String, _ change: @escaping @Sendable (inout ChatMessage) -> Void) {
        guard let s = session else { return }
        Task { _ = await s.touch(id, change); self.saveSoon() }
    }

    func hide(_ id: String, until: Int64, unlock: String?, why: String?) {
        guard let s = session else { return }
        Task { await s.hide(id, until: until, unlock: unlock, why: why); self.saveSoon() }
    }

    /// Deleted on this device: out of the view, the outbox and the stored history at once; its file too when nothing
    /// else uses it (RoomSession.deleteLocal, fileInUse).
    func deleteLocal(_ id: String) {
        guard let s = session else { return }
        let m = message(id)
        messages.removeAll { $0.id == id }
        Task {
            await s.deleteLocal(id)
            self.saveNow()
            for f in [m?.filePath, m?.sourceAudio].compactMap({ $0 }) where !f.isEmpty {
                if self.rooms?.fileInUse(f) != true { self.rooms?.core?.deleteFile(f) }
            }
        }
    }

    func vanished(_ id: String) {
        guard let s = session else { return }
        Task { await s.vanished(id); self.saveSoon() }
    }

    func identityVerified(_ peerId: String, _ on: Bool) {
        guard let s = session else { return }
        Task { await s.identityVerified(peerId, on); await self.refreshNow() }
    }

    func addNote(text: String, fileName: String?, fileMime: String?, dataUrl: String?, filePath: String?, fileSize: Int64, toLabel: String?) {
        guard let s = session else { return }
        Task {
            _ = await s.local { $0.addNote(text: text, fileName: fileName, fileMime: fileMime, dataUrl: dataUrl, filePath: filePath, fileSize: fileSize, toLabel: toLabel) }
            self.saveSoon()
        }
    }

    // MARK: - functions

    func startFnCall(keyword: String, name: String, query: String, icon: String) -> ChatMessage? {
        guard let s = session else { return nil }
        // The bubble's value now (the id the caller settles), the same message on the actor.
        var m = ChatMessage()
        m.id = "fncall-" + Crypto.hex(Crypto.random(10))
        m.roomKey = key
        m.senderId = myId
        m.senderName = myName
        m.text = query
        m.createdAt = EpochMs.now
        m.mine = true
        m.verified = true
        m.status = "displayed"
        m.mark("displayed", "", at: m.createdAt)
        var fn = JSONObject([("keyword", .string(keyword)), ("name", .string(name)), ("query", .string(query)), ("pending", true)])
        if !icon.isEmpty { fn["icon"] = .string(icon) }
        m.fnLocal = fn
        let bubble = m
        Task { await s.local { $0.addLocal(bubble) } }
        return m
    }

    func fnCallStatus(_ id: String, kind: String, label: String, code: String) {
        guard let s = session else { return }
        Task { await s.local { $0.fnCallStatus(id, kind: kind, label: label, code: code.isEmpty ? nil : code) }; self.saveSoon() }
    }

    func fnCallProgress(_ id: String, progress: Double, text: String) {
        guard let s = session else { return }
        Task { await s.local { $0.fnCallProgress(id, progress: progress, text: text) } }
    }

    @discardableResult
    func addModelAnswer(identity: JSONObject, text: String, share: JSONObject?, local: JSONObject?, replyTo: ChatMessage?) -> ChatMessage? {
        guard let s = session else { return nil }
        var m = ChatMessage()
        m.id = "fn-" + Crypto.hex(Crypto.random(10))
        m.roomKey = key
        m.senderId = ModelIdentity.systemMessengerId
        m.senderName = identity.string("name") ?? ModelIdentity.systemMessengerName
        m.text = text
        m.createdAt = max(EpochMs.now, (replyTo?.createdAt ?? -1) + 1)
        m.verified = true
        m.model = identity
        m.fn = share
        m.fnLocal = local
        m.mark("displayed", "", at: m.createdAt)
        if let r = replyTo {
            m.replyToId = r.id
            m.replyToSender = r.senderName
            m.replyToText = String(decoding: Array(r.visibleText.utf16.prefix(200)), as: UTF16.self)
        }
        let answer = m
        Task { await s.local { $0.addLocal(answer) }; self.saveSoon() }
        return m
    }

    func refreshStats() {
        guard let w = wire else { return }
        Task { await w.refreshStats(); await self.refreshNow() }
    }

    /// A system line of this room (a file failed…).
    func systemNotice(_ text: String) {
        guard let s = session else { return }
        Task { await s.local { $0.systemNotice(text) } }
    }

    /// The room's name changed (an edit of the saved room that keeps its key).
    func relabel(_ l: String) { label = l }
}

// MARK: - People (Parts/People: PeopleRoomExtras; RoomSession.peerStats / forwardVerified / profileChanged / peopleSettling)

extension RoomController: PeopleRoomExtras {
    /// The last WebRTC statistics of a peer (People's detail: transport, candidates, codec, bytes, DTLS).
    func peerStats(_ peerId: String) -> RtcStatsSummary? { wire?.peerStats(peerId) }

    /// Review P09: the forwarded message's original sender verified by their key (Verified.forward).
    func forwardVerified(_ message: ChatMessage) -> Bool {
        guard let from = message.forwardedFrom, !from.isEmpty else { return false }
        return Verified.forward(message, messages, pinnedKid: rooms?.pins.pinned(room, from), myName: myName)
    }

    /// My profile card changed: this room's members who speak profiles learn the new version.
    func profileChanged() { rooms?.core?.profiles?.profileChanged(room: self) }

    var serverId: String { keys?.roomId ?? "" }

    var peopleSettling: Bool {
        if !connected { return wanted && status != "mismatch" }
        if EpochMs.now - snap.facts.joinedAt < 8_000 { return true }
        for p in wire?.peerStates ?? [] where p.status != "closed" {
            if p.status != "open" || snap.facts.get(p.id) == nil { return true }
        }
        return false
    }
}
