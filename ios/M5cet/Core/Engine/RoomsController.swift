// Every room of the app (android chat/Rooms.java): the saved rooms (user tier,
// record "rooms" — name, passphrase, nickname, selected, last active), which are
// connected (one RoomController each, several at once up to the policy's
// limit), which one is on screen, unread counts, smart switching, clone / edit,
// the lock (receive while locked into the lock inbox, or disconnect), protocol
// 4 for this device (P4Device: mailbox, key directory upload, KT) and the name
// pins. Main-actor, @Observable: the parts read it as RoomsModel.

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
final class RoomsController: RoomsModel {
    @ObservationIgnored weak var core: AppCore?
    @ObservationIgnored let hub: HubRooms
    @ObservationIgnored let wires: any RoomWireFactory
    @ObservationIgnored var fileStore: (any CoreFileStore)?
    @ObservationIgnored private(set) var p4: P4Device
    @ObservationIgnored private(set) var pins: NamePins
    @ObservationIgnored private(set) var resumeStore: CoreResumeStore
    /// The server's origin ("https://chat.example.com").
    @ObservationIgnored private(set) var server: String
    /// Device keys the person verified (People › verify; contacts/Store.verified) — what makes a relayed message "verified".
    @ObservationIgnored var verifiedDevice: @Sendable (String) -> Bool = { _ in false }
    /// 6.14 (call wake): whether a VoIP push owns a room's call now (CallCenter: ringing, or its record pending) —
    /// the room's relayed items of it then add nothing (one record per call).
    @ObservationIgnored var pushOwnsCall: (String) -> Bool = { _ in false }
    /// 6.14 (call wake): a room's relayed ring that came to nothing — the call log's records, the missed-call notice.
    @ObservationIgnored var onCallWakeStep: ((_ roomKey: String, _ label: String, _ step: CallWake.Step) -> Void)?
    @ObservationIgnored var ktFetcher: Kt.ConsistencyFetcher?
    /// The unlock is merging the lock inbox: histories wait for restoreAll.
    @ObservationIgnored private(set) var draining = false

    private(set) var loaded = false
    private var saved: [SavedRoom] = []
    private(set) var sessions: [String: RoomController] = [:]
    private(set) var activeKey = ""
    private(set) var ktAlert = ""
    var maxRooms = 8
    /// The room screen is on screen in the foreground and unlocked (Rooms.setVisible).
    private(set) var visible = false
    /// Bumped on every change of a room (its badge, status, the list order) — the rooms screen follows it.
    private(set) var revision = 0

    nonisolated static let log = Logger(subsystem: "cz.m5cet.app", category: "rooms")

    init(server: String, records: any RecordVault, hub: HubRooms, wires: any RoomWireFactory, account: (any P4AccountProvider)?) {
        self.server = server
        self.hub = hub
        self.wires = wires
        let rs = CoreResumeStore(records: records)
        resumeStore = rs
        pins = NamePins(vault: records)
        p4 = P4Device(store: P4Store(backend: records), origin: Self.origin(server), account: account)
        pins = NamePins(vault: records, onLockedPin: { [rs] slot, kid in rs.lockedPin(slot: slot, kid: kid) })
    }

    static func origin(_ server: String) -> String {
        guard let u = URL(string: server), let scheme = u.scheme, let host = u.host else { return server }
        return scheme + "://" + host + (u.port.map { ":\($0)" } ?? "")
    }

    private var records: any RecordVault { core?.security.userRecords ?? MemoryRecordVault() }

    /// The device was enrolled with a server (or another one): protocol 4 follows its origin.
    func serverChanged(_ s: String, records: any RecordVault) {
        server = s
        guard sessions.isEmpty else { return }
        p4 = P4Device(store: P4Store(backend: records), origin: Self.origin(s), account: core?.account.p4Provider)
    }

    // MARK: - RoomsModel

    var items: [RoomItem] {
        _ = revision
        return ordered.map { s in
            let r = sessions[s.key]
            return RoomItem(key: s.key, name: s.label, room: s.room, users: r?.userCount ?? 0, unread: r?.unread ?? 0, active: s.key == activeKey,
                            connected: r?.connected ?? false, status: r?.status ?? "saved", selected: s.selected)
        }
    }

    /// Rooms.saved(): latest activity first.
    private var ordered: [SavedRoom] {
        saved.sorted { max($0.lastActive, sessions[$0.key]?.lastActivity ?? 0) > max($1.lastActive, sessions[$1.key]?.lastActivity ?? 0) }
    }

    var open: [any RoomModel] { _ = revision; return connectedSessions }

    /// The connected rooms for the room bar, most recently active first.
    var connectedSessions: [RoomController] { sessions.values.sorted { $0.lastActivity > $1.lastActivity } }

    var selectedCount: Int { _ = revision; return saved.filter { $0.selected && sessions[$0.key] == nil }.count }
    var connectedCount: Int { _ = revision; return sessions.values.filter(\.connected).count }
    var unreadTotal: Int { _ = revision; return sessions.values.reduce(0) { $0 + $1.unread } }

    func room(_ key: String) -> (any RoomModel)? { sessions[key] }
    func controller(_ key: String) -> RoomController? { sessions[key] }
    var activeController: RoomController? { activeKey.isEmpty ? nil : sessions[activeKey] }

    func byServerId(_ id: String) -> (any RoomModel)? {
        guard !id.isEmpty else { return nil }
        return sessions.values.first { $0.keys?.roomId == id }
    }

    func saved(_ key: String) -> SavedRoom? { saved.first { $0.key == key } }
    func card(_ key: String) -> JSONObject? { saved(key)?.card }
    var savedRooms: [SavedRoom] { ordered }

    // MARK: - storage

    /// The saved rooms (after an unlock); what was connected before connects again.
    func load() {
        pins.unlock()
        p4.store.flush()
        guard !loaded else { return }
        let (list, active) = SavedRooms.load(records)
        saved = list
        activeKey = active
        loaded = true
        Self.log.info("\(list.count) saved rooms")
        for s in saved where s.selected { connect(s.key) }
        changed()
    }

    private func persist() {
        guard records.unlocked else { return }
        SavedRooms.save(records, rooms: saved, active: activeKey)
    }

    // MARK: - rooms

    @discardableResult
    func join(room roomName: String, passphrase: String, userName: String) -> String {
        let key = add(roomName, passphrase: passphrase, userName: userName)
        connect(key)
        switchTo(key)
        return key
    }

    /// Rooms.add: saves (or updates) a room, selected. Its key.
    @discardableResult
    func add(_ roomName: String, passphrase: String, userName: String) -> String {
        var s = SavedRooms.make(roomName: roomName, passphrase: passphrase, userName: userName, now: EpochMs.now)
        if let i = saved.firstIndex(where: { $0.key == s.key }) {
            s.lastActive = EpochMs.now
            saved[i] = s
        } else {
            saved.append(s)
        }
        persist()
        core?.setUserName(userName)
        changed()
        return s.key
    }

    func toggleSelected(_ key: String) {
        guard let i = saved.firstIndex(where: { $0.key == key }) else { return }
        saved[i].selected.toggle()
        persist()
        changed()
    }

    /// Every selected room (up to the policy's maximum); the first becomes active when none is.
    func connectSelected() {
        let keys = saved.filter(\.selected).map(\.key)
        for k in keys { connect(k) }
        if activeKey.isEmpty, let first = keys.first { switchTo(first) }
    }

    func connect(_ key: String) {
        guard let s = saved(key) else { return }
        var r = sessions[key]
        if r == nil {
            guard sessions.count < maxRooms else {
                Self.log.warning("at most \(self.maxRooms) rooms at once")
                core?.flash(core?.t("rooms.max") ?? "", level: .warn)
                return
            }
            let name = s.userName.isEmpty ? (core?.userName ?? "") : s.userName
            r = RoomController(saved: s, userName: name, rooms: self)
            sessions[key] = r
        }
        if let i = saved.firstIndex(where: { $0.key == key }) { saved[i].selected = true }
        persist()
        r?.connect()
        changed()
    }

    /// Makes a room the one on screen (connecting it if needed); its badge clears.
    func switchTo(_ key: String) {
        if sessions[key] == nil { connect(key) }
        activeKey = key
        sessions[key]?.unread = 0
        if let i = saved.firstIndex(where: { $0.key == key }) { saved[i].lastActive = EpochMs.now }
        persist()
        core?.notifications?.clearRoom(key)
        changed()
    }

    func leave(_ key: String) {
        let k = key.isEmpty ? activeKey : key
        if let r = sessions.removeValue(forKey: k) { Task { await r.disconnect() } }
        if let i = saved.firstIndex(where: { $0.key == k }) { saved[i].selected = false }
        if k == activeKey { activeKey = connectedSessions.first?.key ?? "" }
        persist()
        changed()
    }

    func forget(_ key: String) {
        leave(key)
        saved.removeAll { $0.key == key }
        persist()
        History.delete(records, key)
        changed()
    }

    @discardableResult
    func clone(_ key: String) -> String? {
        guard let s = saved(key) else { return nil }
        let c = SavedRooms.copy(s, keys: Set(saved.map(\.key)), now: EpochMs.now)
        saved.append(c)
        persist()
        changed()
        return c.key
    }

    /// Rooms.update: a new name is a new room (it takes the old one's place); a connected one reconnects.
    @discardableResult
    func update(_ oldKey: String, room roomName: String, passphrase: String, userName: String) -> String? {
        guard let old = saved(oldKey) else { return nil }
        let room = RoomKeys.normalizeRoom(roomName)
        let label = roomName.javaTrimmed.isEmpty ? room : roomName.javaTrimmed
        let changedAny = room != oldKey || label != old.label || passphrase != old.passphrase || userName != old.userName
        let connected = sessions[oldKey] != nil, wasActive = oldKey == activeKey
        if changedAny && connected { leave(oldKey) }
        let at = saved.firstIndex { $0.key == oldKey } ?? saved.count
        if room != oldKey { saved.removeAll { $0.key == oldKey } }
        var s = saved(room) ?? SavedRoom(key: room, room: room, label: label, passphrase: passphrase, userName: userName)
        s.label = label
        s.passphrase = passphrase
        s.userName = userName
        s.selected = old.selected || connected
        s.lastActive = max(old.lastActive, s.lastActive)
        if let i = saved.firstIndex(where: { $0.key == room }) { saved[i] = s } else { saved.insert(s, at: min(at, saved.count)) }
        persist()
        if changedAny && connected { connect(room); if wasActive { switchTo(room) } }
        changed()
        return room
    }

    /// Leaves every room (the strict lock, a wipe, a sign-out of the device).
    func disconnectAll() {
        let all = sessions.values
        sessions.removeAll()
        for r in all { Task { await r.disconnect() } }
        loaded = false
        saved = []
        activeKey = ""
        changed()
    }

    func setVisible(_ v: Bool) {
        visible = v
        if v, let r = activeController {
            r.unread = 0
            core?.notifications?.clearRoom(r.key)
        }
        changed()
    }

    func dismissKtAlert() {
        Task {
            await p4.dismissKtAlert()
            await refreshKtAlert()
        }
    }

    /// The room is on screen now (open, the app in front and unlocked).
    func onScreen(_ key: String) -> Bool {
        visible && key == activeKey && (core?.inForeground ?? false) && !(core?.security.isLocked ?? true)
    }

    // MARK: - what the rooms tell

    func roomChanged(_ r: RoomController) { changed() }

    func changed() { revision &+= 1 }

    /// Rooms.onMessage: the lock inbox while locked, unread and the notification off screen, reading aloud, the history.
    func onMessage(_ r: RoomController, _ m: ChatMessage, fresh: Bool) {
        if m.kind != "sys", let inbox = core?.security.lockInbox { inbox.seal(LockedRooms.message(roomKey: r.key, m)) }
        let shown = onScreen(r.key)
        if fresh && !shown {
            r.unread += 1
            core?.notifications?.message(room: r, m, locked: core?.security.isLocked ?? true)
        }
        if fresh && shown && m.sealed == nil && !m.tap && m.fileName == nil { core?.speakIncoming(m) }
        if fresh || m.mine { r.saveSoon() }
        changed()
    }

    /// Rooms.messageChanged: the newer state into the lock inbox (not each step of a transfer), the history.
    func onMessageChanged(_ r: RoomController, _ m: ChatMessage) {
        let transferring = m.fileProgress >= 0 && m.fileProgress < 1
        if m.kind != "sys", !transferring, let inbox = core?.security.lockInbox { inbox.seal(LockedRooms.message(roomKey: r.key, m)) }
        if m.mine || m.filePath != nil { r.saveSoon() }
    }

    /// A receipt / relay state for a message not in memory — while locked it goes to the lock inbox.
    func lockedState(_ r: RoomController, messageId: String, who: String, name: String, state: String) {
        core?.security.lockInbox?.seal(LockedRooms.state(roomKey: r.key, id: messageId, who: who, name: name, state: state))
    }

    /// The room's peer id and resume secret (the vault, or the lock inbox while locked).
    func saveResume(_ r: RoomController, peerId: String, secret: String) {
        if !Resume.save(records, r.key, peerId: peerId, secret: secret, now: EpochMs.now) {
            core?.security.lockInbox?.seal(LockedRooms.resume(roomKey: r.key, peerId: peerId, secret: secret))
        }
    }

    /// Is this vault file used by any message of any room (a forward shares it)?
    func fileInUse(_ id: String) -> Bool {
        for s in saved {
            let list = sessions[s.key]?.messages ?? History.load(records, s.key)
            if list.contains(where: { $0.filePath == id || $0.sourceAudio == id }) { return true }
        }
        return false
    }

    // MARK: - settings, foreground, account

    /// What a room reads of the settings (RoomSettings): receipts, read receipts, the account name, presence.
    func roomSettings(foreground: Bool) -> RoomSettings {
        var s = RoomSettings()
        let settings = core?.settings
        s.receipts = settings.map { $0.get("messages.receipts") != .bool(false) } ?? true
        s.readReceipts = settings.map { $0.get("messages.readReceipts") != .bool(false) } ?? true
        s.accountName = core?.account.username ?? ""
        s.foreground = foreground
        s.awayWanted = core?.awayWanted ?? false
        return s
    }

    func settingsChanged() { for r in sessions.values { r.settingsChanged() } }

    /// The app came to the foreground (presence; iOS: the sockets come back as the same members).
    func onForeground() {
        for r in sessions.values { r.setForeground(true) }
        Task { await hub.setForeground(true); await hub.resumeAll() }
    }

    /// The app went to the background: histories saved, presence; the sockets close without leaving (held as away).
    func onBackground() async {
        visible = false
        for r in sessions.values { r.setForeground(false) }
        await hub.setForeground(false)
    }

    /// iOS: the background time is over — every socket closes without `leave` (the hub holds us as away; relay + push).
    func pauseAll() async { await hub.pauseAll() }

    /// Signed in or out: every socket binds the session (auth) — the relay keeps messages for away members.
    func onAccountChanged(token: String?) {
        let away = core?.awayWanted ?? false
        Task { await hub.setAccount(token: token, away: away) }
        settingsChanged()
        changed()
    }

    /// The account's key in the device certificate (the other half of an account safety number), "" when none.
    var myAccountKey: String {
        guard let id = core?.security.chatIdentity(create: false) else { return "" }
        return p4.myAccountKey(id)
    }

    // MARK: - key transparency (P4Device: refresh, alert)

    func refreshKtAlert() async {
        let kind = await p4.ktAlert()
        ktAlert = kind.isEmpty ? "" : P4Texts.t("p4.kt.alert." + kind)
    }

    // MARK: - the lock (Rooms.lockReceiving / disconnectAll, LockedRooms.unlocked)

    /// The default lock: the open rooms stay connected with their own keys; pins of the open rooms kept in memory,
    /// protocol 4 warmed, histories saved and out of memory, the saved rooms out of memory.
    func lockReceiving() {
        let open = Set(sessions.values.map(\.room))
        pins.lock(with: pins.pinsOf(rooms: open))
        if !sessions.isEmpty { p4.store.warm() }
        loaded = false
        saved = []
        for r in sessions.values { Task { await r.dropHistory() } }
        changed()
    }

    func unlocked(draining: Bool) {
        self.draining = draining
        load()
    }

    /// One generation of the lock inbox into the stores (LockedRooms.apply): files, histories, pins, resumes.
    func merge(_ p: LockedRooms.Parsed) {
        var bad = Set<String>()
        for f in p.files where !(core?.storeKeptFile(f) ?? false) { bad.insert(f.optString("id")) }
        let now = EpochMs.now
        // Saved rooms are read again at the unlock (load) before the merge; a room no longer saved is skipped.
        let savedKeys = Set(SavedRooms.load(records).rooms.map(\.key))
        for (room, items) in p.rooms.entries where savedKeys.contains(room) {
            History.merge(records, room, items: items, now: now, lostFiles: bad)
        }
        pins.mergePins(Dictionary(uniqueKeysWithValues: p.pins.entries.map { ($0.key, $0.value) }))
        for (room, r) in p.resumes.entries where r.count == 2 { Resume.save(records, room, peerId: r[0], secret: r[1], now: now) }
        core?.mergeLockedCalls(p.calls)
    }

    /// Back from a lock: each open room's history into its list again (after the merge).
    func restoreAll() {
        draining = false
        for r in sessions.values where !r.historyReady { Task { await r.restoreHistory() } }
        changed()
    }
}

/// Each room's peer id and resume secret for HubConnection (M5Proto Resume: the user tier's "resume" record, Android's
/// format); while locked nothing is read and what changes goes to the lock inbox (the room controller does that).
final class CoreResumeStore: HubResumeStore, @unchecked Sendable {
    let records: any RecordVault
    private let lock = NSLock()
    private var lockedPins: [(String, String)] = []

    init(records: any RecordVault) { self.records = records }

    func load(roomKey: String) async -> (peerId: String, secret: String)? { Resume.load(records, roomKey) }

    func save(roomKey: String, peerId: String, secret: String) async {
        // The room controller saves it (or hands it to the lock inbox) when the core says "joined".
    }

    /// A pin first seen while locked (NamePins keeps it in memory; the lock inbox gets it).
    func lockedPin(slot: String, kid: String) {
        lock.withLock { lockedPins.append((slot, kid)) }
        Task { @MainActor in
            AppCore.current?.security.lockInbox?.seal(LockedRooms.pin(slot: slot, kid: kid))
        }
    }
}
