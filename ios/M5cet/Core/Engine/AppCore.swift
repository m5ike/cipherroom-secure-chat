// The app's core (android A/M5.java): one instance of every part the screens
// and the parts use — the device and its server, the rooms, the account, the
// files, the screen state, the actions, the slots — and what the app's life
// does to them: the scene phase (foreground: sockets back as the same members;
// background: ~30 s to flush the outbox and receipts and save, then the sockets
// close without leaving — the hub holds us as away, the relay and push cover),
// the lock (receive into the lock inbox, or disconnect), the unlock (the
// inbox's merge, the histories back).

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import Observation
import SwiftUI
import UIKit
import os

/// Build-time settings of the app (Android BuildConfig.DEFAULT_SERVER / SERVER_KEY_PIN): Info.plist keys, all optional.
enum CoreConfig {
    /// The enrolment form's server (Info.plist M5DefaultServer), "" = none.
    static var defaultServer: String { Bundle.main.object(forInfoDictionaryKey: "M5DefaultServer") as? String ?? "" }
    /// A pin of the server's key (kid / fingerprint / SHA-256) this build trusts, nil = trust on first use.
    static var serverKeyPin: String? { (Bundle.main.object(forInfoDictionaryKey: "M5ServerKeyPin") as? String).flatMap { $0.isEmpty ? nil : $0 } }
}

/// The notification side the rooms use (Platform/Notifications installs one).
@MainActor
protocol CoreNotifying: AnyObject {
    /// A message arrived off screen (`locked`: neutral text only).
    func message(room: RoomController, _ m: ChatMessage, locked: Bool)
    /// The room came on screen: its notifications go.
    func clearRoom(_ key: String)
    /// A lock: every notification neutral.
    func neutralizeAll()
}

/// Profiles shared in rooms (A/profile: ProfileRoom.Exchange, Profiles cache) — CoreProfiles.
@MainActor
protocol RoomProfiles: AnyObject {
    func frame(room: RoomController, peerId: String, _ frame: JSONObject)
    func hello(room: RoomController, peerId: String, caps: [JSON]?)
    func profile(of peerId: String) -> JSONObject?
    func accountKey(room: RoomController, peerId: String) -> String
    /// A peer left the room; the room went.
    func peerGone(room: RoomController, peerId: String)
    func roomGone(_ key: String)
    /// My profile changed: this room's members learn its version (PeopleRoomExtras.profileChanged).
    func profileChanged(room: RoomController)
    /// The lock: profiles leave the memory.
    func forget()
}

/// Reading aloud (Platform/Voice): voice.speak, voice.stop.
@MainActor
protocol CoreVoice: AnyObject {
    func speak(_ text: String)
    func stopSpeaking()
}

/// What update.install does (Platform/Push: a design bundle staged, an App Store release).
@MainActor
protocol CoreUpdates: AnyObject {
    /// update.install (Parts.installUpdate).
    func install(_ host: DesignHost)
    /// $update of the "update" screen (Parts.updateScope) as this window shows it ($form.updateKind).
    func scope(_ host: DesignHost?, lang: String) -> DesignValue
}

/// Settings › Notifications' channel order (Android push/NotifyPrefs.run: notify.up / down / use / drop / test / sync).
@MainActor
protocol CoreNotifyPrefs: AnyObject {
    func run(_ action: String, _ arg: String, _ host: DesignHost)
}

@MainActor
@Observable
final class AppCore {
    /// The app's core (nil before Bootstrap made it; tests make their own).
    static private(set) weak var current: AppCore?

    @ObservationIgnored let security: any CoreSecurity
    @ObservationIgnored let device: any DeviceEnrolling
    @ObservationIgnored let services: DesignServices
    let rooms: RoomsController
    let account: AccountService
    @ObservationIgnored let models: CoreModels
    @ObservationIgnored let fileStore: any CoreFileStore
    @ObservationIgnored var notifications: (any CoreNotifying)?
    /// Hides and deletes in this device's view for the operator's audit journal (MessageAudit).
    @ObservationIgnored let messageAudit: MessageAudit
    /// The profile card and the rooms' profile frames (People's PeopleParts.profiles).
    @ObservationIgnored private(set) var profileStore: CoreProfiles!
    @ObservationIgnored var profiles: (any RoomProfiles)? { profileStore }
    /// Read an incoming message aloud (voice.autoplay) — Platform/Voice installs it.
    @ObservationIgnored var speaker: (@MainActor (ChatMessage) -> Void)?
    /// What else a lock clears (the parts' copies — composers, pictures, the assistant).
    @ObservationIgnored var onForget: [@MainActor () -> Void] = []
    @ObservationIgnored var voice: (any CoreVoice)?
    @ObservationIgnored var updates: (any CoreUpdates)?
    @ObservationIgnored var notifyPrefs: (any CoreNotifyPrefs)?
    /// Settings whose side effects other parts own (location.*, voice.lang, callLog…).
    @ObservationIgnored var settingObservers: [@MainActor (String, DesignHost) -> Void] = []
    /// A room a notification or a link opened before the app was unlocked (MainActivity.pendingRoom).
    @ObservationIgnored var pendingRoom: String?
    /// "apns" | "poll" (Settings › User › Connection).
    @ObservationIgnored var pushMode = "poll"
    @ObservationIgnored private(set) var lastCheckin: Int64 = 0
    @ObservationIgnored var iceCount = 0
    /// The device key's id (what the server calls its kid).
    @ObservationIgnored private(set) var deviceKid = "—"
    /// The seams handed to other areas (they keep weak references).
    @ObservationIgnored var callLogSource: AnyObject?
    @ObservationIgnored var notificationRooms: AnyObject?
    @ObservationIgnored var voiceEnvironment: AnyObject?
    @ObservationIgnored var locationControl: AnyObject?
    /// The app is in the foreground.
    private(set) var inForeground = true
    /// Bumped when the route's inputs change (enrolled, lock).
    private(set) var routeRevision = 0
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var pauseTask: Task<Void, Never>?
    nonisolated static let log = Logger(subsystem: "cz.m5cet.app", category: "core")

    init(security: any CoreSecurity, device: any DeviceEnrolling, services: DesignServices, hub: HubRooms = HubRooms(),
         wires: any RoomWireFactory, fileStore: any CoreFileStore, passkeys: any PasskeyAuthorizing) {
        self.security = security
        self.device = device
        self.services = services
        self.fileStore = fileStore
        let account = AccountService(security: security, passkeys: passkeys)
        self.account = account
        rooms = RoomsController(server: device.server, records: security.userRecords, hub: hub, wires: wires, account: account.p4Provider)
        models = CoreModels(rooms: rooms, account: account)
        messageAudit = MessageAudit(records: security.userRecords)
        rooms.core = self
        rooms.fileStore = fileStore
        account.core = self
        models.files = StoreMessageFiles(fileStore)
        models.server = device.server
        models.userName = userName
        security.setLockListener(self)
        profileStore = CoreProfiles(core: self)
        messageAudit.account = { [weak self] in self?.account.signedIn == true ? self?.account.username ?? "" : "" }
        messageAudit.roomId = { [weak self] key in self?.rooms.controller(key)?.keys?.roomId ?? "" }
        installTexts()
    }

    /// Becomes the app's core (CoreModels.shared, the Texts provider).
    func activate() {
        AppCore.current = self
        // What the parts registered on the core in use so far stays (their $nfc, $users, $profile…).
        models.variables.adopt(CoreModels.shared.variables)
        CoreModels.shared = models
    }

    // MARK: - texts, flash, settings

    /// The design's text in the app's language.
    func t(_ key: String) -> String { services.design.t(key, lang: services.lang) }

    /// M5Core Texts (protocol notices, P4Texts) read the design in the app's language.
    func installTexts() {
        let design = services.design, lang = services.lang
        Texts.setProvider({ key in let s = design.t(key, lang: lang); return s == key ? nil : s },
                          counted: { key, n in design.tn(key, n, lang: lang) })
    }

    /// A flash in every window (the windows' hosts register themselves).
    func flash(_ text: String, level: FlashLevel = .info) {
        for h in hosts { h.flash(title: "", text: text, level: level) }
    }

    var settings: SettingsModel { services.settings }

    /// The device's chat name (Config.userName): the last name used in a room.
    var userName: String { UserDefaults.standard.string(forKey: "m5.userName") ?? "" }

    func setUserName(_ n: String) {
        UserDefaults.standard.set(n, forKey: "m5.userName")
        models.userName = n
    }

    /// With notifications on, the server covers for this device while the app is closed (RoomSettings.awayWanted).
    var awayWanted: Bool { true }

    func speakIncoming(_ m: ChatMessage) {
        guard settings.bool("voice.autoplay") else { return }
        speaker?(m)
    }

    // MARK: - windows

    private struct WeakHost { weak var host: DesignHost? }
    @ObservationIgnored private var hostRefs: [WeakHost] = []
    var hosts: [DesignHost] { hostRefs.compactMap(\.host) }

    func attach(_ host: DesignHost) {
        hostRefs.removeAll { $0.host == nil || $0.host === host }
        hostRefs.append(WeakHost(host: host))
    }

    // MARK: - start

    /// After the launch: the device's state, the policy, the rooms when unlocked.
    func start() async {
        if let d = device as? CoreDeviceService {
            await d.load()
            d.onPolicy = { [weak self] st in self?.policyChanged(st) }
        }
        if let st = device.state { policyChanged(st) }
        models.server = device.server
        if let spki = try? await security.requestSigner.publicKeySPKI(), let der = try? M5Crypto.Crypto.unb64(spki) {
            deviceKid = String(M5Crypto.Crypto.b64url(M5Crypto.Crypto.sha256(der)).prefix(16))
        }
        routeChanged()
    }

    /// A check-in (the policy, $define); the time of the last good one for Settings › User.
    func checkIn(_ reason: String) async {
        if await device.checkIn(reason: reason) { lastCheckin = EpochMs.now }
    }

    private func policyChanged(_ st: DeviceState) {
        rooms.maxRooms = st.maxRooms
        Task { await rooms.hub.setMaxRooms(st.maxRooms) }
        if rooms.server != st.server { rooms.serverChanged(st.server, records: security.userRecords) }
        models.server = st.server
    }

    /// The route's inputs changed (enrolled, PIN set, locked): every window routes again.
    func routeChanged() {
        routeRevision &+= 1
        for h in hosts { h.route() }
    }

    /// MainActivity.enterApp: after the unlock the saved rooms, the account's session, a check-in.
    func enterApp() {
        rooms.load()
        account.restore()
        refreshKt()
        uploadKeys()
        messageAudit.flush()
        Task { await checkIn("enter") }
    }

    // MARK: - the scene (M5.Lifecycle: onStart / onStop)

    func scenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            pauseTask?.cancel()
            pauseTask = nil
            endBackgroundTask()
            guard !inForeground else { return }
            inForeground = true
            rooms.onForeground()
            Task { await checkIn("foreground") }
        case .background:
            guard inForeground else { return }
            inForeground = false
            enterBackground()
        default:
            break
        }
    }

    /// iOS gives ~30 s: save, tell the rooms (presence), let the outboxes and receipts go, then close the sockets
    /// without leaving (the hub holds the members as away; relay + push deliver meanwhile).
    private func enterBackground() {
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "m5.rooms") { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.pauseTask?.cancel()
                Task { await self.rooms.pauseAll(); self.endBackgroundTask() }
            }
        }
        pauseTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for r in self.rooms.sessions.values { r.saveNow() }
            await self.rooms.onBackground()
            for r in self.rooms.sessions.values { if let s = r.session { await s.flushOutbox() } }
            // Receipts go in batches of 400 ms; a short grace for the last ones and the presence frame.
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, !self.inForeground else { return }
            // A call keeps the room's socket (and the audio background mode keeps the app running).
            if CallSystem.shared.activeCallRoom == nil { await self.rooms.pauseAll() }
            self.endBackgroundTask()
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    // MARK: - protocol 4: key directory, key transparency (P4Device.upload, refreshKt)

    /// 6.12 (§ 7.5): signed in — this device's certificate v2 and mailbox bundle go to the key directory.
    func uploadKeys() {
        guard account.signedIn, security.unlocked, let id = security.chatIdentity(create: true) else { return }
        let p4 = rooms.p4
        guard let up = p4.uploadBody(id, unlocked: security.unlocked) else { return }
        let base = device.server, token = account.token
        let body = up.body
        Task.detached {
            do {
                _ = try await KeyDirectoryClient().putBundle(base: base, token: token, upload: KeyBundleUpload(
                    pk: body.optString("pk"), certExp: body.object("cert")?.optInt64("exp") ?? 0, certSig: body.object("cert")?.optString("sig") ?? "",
                    bundle: HubFrameBridge.net(body["bundle"] ?? .null), apk: body.optString("apk")))
                p4.uploaded(up.mark)
            } catch let e as HTTPError where e.status == 429 || e.code == "kt-quota" {
                p4.quotaRefused(up.mark)
            } catch {
                AppCore.log.notice("key directory: not now")
            }
        }
    }

    /// Key transparency (every 10 min at most): the server's KT key pinned, the newest head checked, the rooms told.
    func refreshKt() {
        let p4 = rooms.p4
        guard p4.ktRefreshDue(), !device.server.isEmpty else { return }
        let base = device.server
        let client = KtClient()
        let fetch: Kt.ConsistencyFetcher = { from, to in JSON.parseObject(try await client.consistency(base: base, from: from, to: to).text) }
        rooms.ktFetcher = fetch
        Task { @MainActor in
            guard let key = try? await client.key(base: base), let sth = try? await client.sth(base: base),
                  let sthObj = JSON.parseObject(sth.text) else { return }
            _ = await p4.refreshKt(key: key, sth: sthObj, fetch: fetch)
            for r in self.rooms.sessions.values { if let s = r.session { await s.refreshKt() } }
            await self.rooms.refreshKtAlert()
        }
    }

    // MARK: - files

    func deleteFile(_ id: String) { fileStore.delete(id) }

    /// A file kept in the lock inbox into the vault (LockedRooms.storeFile).
    func storeKeptFile(_ item: JSONObject) -> Bool {
        let id = item.optString("id")
        guard FileTransfer.isId(id) else { return false }
        if fileStore.has(id) { return true }
        guard let url = security.keptFileURL(id: id), FileManager.default.fileExists(atPath: url.path) else { return false }
        let total = item.optInt("total")
        let lengths = (item.array("lengths") ?? []).compactMap { $0.int64Value.map { Int($0) } }
        guard total >= 1, lengths.count == total, let key = try? M5Crypto.Crypto.unb64(item.optString("key")) else { return false }
        do {
            let slots = try KeptSlots(url: url, chunkSize: item.optInt("chunkSize"))
            defer { slots.close() }
            try fileStore.receive(id: id) { sink in
                try FileTransfer.decryptSlots(slots, key: key, id: id, total: total, chunkSize: item.optInt("chunkSize"), lengths: lengths,
                                              size: item.optInt64("size"), root: item.optString("root"), p4: item.bool("p4") ?? false, sink: sink)
            }
            try? FileManager.default.removeItem(at: url)
            return true
        } catch {
            Self.log.warning("a file kept while locked could not be stored")
            return false
        }
    }

    /// Calls of the lock inbox ("call" items — Android's; iOS keeps calls in memory while locked) into the history.
    func mergeLockedCalls(_ calls: [JSONObject]) {
        for c in calls { CallSystem.shared.history.add(CallHistory.Entry.from(c)) }
    }
}

// MARK: - the lock (M5.forgetSecrets / onUnlocked / onLocked)

extension AppCore: CoreLockListener {
    func coreLockWillForget(receiving inbox: (any LockInboxWriting)?) {
        if inbox == nil { rooms.disconnectAll() } else { rooms.lockReceiving() }
    }

    func coreLockDidForget() {
        account.reload()
        profiles?.forget()
        models.fn?.forget()
        for c in models.allComposers { c.forget() }
        for f in onForget { f() }
        notifications?.neutralizeAll()
        for h in hosts { h.forgetUi() }
        routeChanged()
    }

    func coreLockDidUnlock() {
        rooms.unlocked(draining: true)
    }

    func coreMerge(_ parsed: LockedRooms.Parsed) { rooms.merge(parsed) }

    func coreRestoreAll() {
        rooms.restoreAll()
        routeChanged()
    }
}

/// A kept file's slots (lockbox/files/<id>.part) read at the unlock — Android's slot layout.
final class KeptSlots: ChunkSlots {
    private let handle: FileHandle
    private let slot: UInt64
    init(url: URL, chunkSize: Int) throws {
        handle = try FileHandle(forReadingFrom: url)
        slot = UInt64(12 + chunkSize + 16)
    }
    func write(seq: Int, iv: Bytes, ciphertext: Bytes) throws { throw CocoaError(.fileWriteNoPermission) }
    func read(seq: Int, length: Int) throws -> (iv: Bytes, ciphertext: Bytes) {
        try handle.seek(toOffset: UInt64(seq) * slot)
        guard let d = try handle.read(upToCount: 12 + length), d.count == 12 + length else { throw CocoaError(.fileReadCorruptFile) }
        let b = Array(d)
        return (Array(b[0..<12]), Array(b[12...]))
    }
    func close() { try? handle.close() }
}
