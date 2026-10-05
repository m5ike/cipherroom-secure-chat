// APNs for the app (Android push/Push + push/FcmService + the check-in job of
// push/Checkin): AppModel.push (App/AppHooks.swift RemotePushHandling).
//
//   token        didRegister(apnsToken:) → kept in the SYS record "push", reported at enrolment and every
//                check-in (apnsToken, voipToken, apnsEnv = the aps-environment: "sandbox" / "production");
//                a new token → a check-in now (Android: onNewToken → checkin("fcm-token"))
//   silent push  content-available (ping, status, update, config) → DeviceService.handle (ControlInbox:
//                the server's signature, ECIES with the Secure Enclave key, dedupe, expiry) → carried
//                out and acknowledged within iOS's ~30 s
//   alert push   flash, push, notify, lock, wipe go through M5cetNotifications (the extension draws it,
//                notes lock / wipe in the App Group); the app opens them again when it runs (PushHandoff,
//                willPresent, a tap) and at the next check-in — lock and wipe are carried out then
//   check-in     in the foreground (at most every 5 min), after a token change, and as the background task
//                "cz.m5cet.app.checkin" (Info.plist BGTaskSchedulerPermittedIdentifiers): BGAppRefresh when
//                UIBackgroundModes has "fetch", else BGProcessing with network; the earliest start is 12 h
//                with APNs, the policy's pollSeconds without (≥ 15 min) — iOS decides when
//   VoIP         CallSystem's VoIP handler gets an opener (VoIPPayloadOpening) — synchronous, as PushKit needs

import BackgroundTasks
import Foundation
import M5Net
import OSLog
import UIKit
import UserNotifications

@MainActor
final class PushCenter: RemotePushHandling {
    static private(set) var shared: PushCenter?
    static let checkinTask = "cz.m5cet.app.checkin"

    let device: DeviceService
    let facts: SystemDeviceFacts?
    private weak var model: AppModel?
    private(set) var apnsToken: String?
    private(set) var registrationError: String?
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "push")
    private let tokensStore: (any SyncStateStore)?
    /// The VoIP token as Platform/Calls has it (AppModel keeps it too).
    var voipToken: () -> String? = { nil }
    /// "sandbox" / "production" (the aps-environment entitlement; the simulator: sandbox).
    var apnsEnvironment = "sandbox"

    init(device: DeviceService, facts: SystemDeviceFacts?, tokens: (any SyncStateStore)?) {
        self.device = device
        self.facts = facts
        tokensStore = tokens
        apnsToken = tokens?.loadNow("push")?.str("apnsToken").nilIfEmpty
        device.pushTokens = { [weak self] in self?.tokens ?? PushTokens() }
    }

    /// What the server gets: the APNs token (hex) when there is one, the VoIP token, the environment.
    var tokens: PushTokens {
        PushTokens(token: apnsToken, voip: voipToken(), apnsEnv: apnsToken == nil && voipToken() == nil ? nil : apnsEnvironment)
    }

    // MARK: installation (App/Bootstrap.swift)

    static func install(into model: AppModel) {
        guard let security = SecurityCenter.shared else { return }
        let facts = SystemDeviceFacts()
        let store = VaultNetStateStore(vault: security.vault)
        let keys = KeyringEciesOpener(agreement: security.agreement)
        let appCode = Int(AppInfo.build) ?? M5NetInfo.defaultCode
        let bundles = DesignBundleStore(storage: VaultBundleStorage(vault: security.vault), crypto: DeviceBundleCrypto(opener: keys), appCode: appCode)
        let events = DeviceEvents(store: store)
        let handoff = PushHandoff(shared: security.paths.shared)
        let http = HTTPClient(transport: URLSessionHTTPTransport(), userAgent: M5NetInfo.userAgent(version: AppInfo.version))
        var deps = DeviceService.Dependencies(client: DeviceAPIClient(http: http), store: store, signer: KeyringRequestSigner(signer: security.signer),
                                              opener: keys, facts: facts, appCode: appCode)
        deps.buildPin = Bundle.main.object(forInfoDictionaryKey: "M5ServerKeyPin") as? String
        deps.defaultServer = Bundle.main.object(forInfoDictionaryKey: "M5DefaultServer") as? String ?? ""
        deps.applyPolicy = { [weak security] answer, key, id in
            security?.policies.apply(answer: answer.foundation, serverKey: key, deviceId: id) ?? false
        }
        deps.resetPolicy = { [weak security] in security?.policies.reset() }
        deps.isLocked = { [weak security] in security?.lock.isLocked ?? true }
        deps.handoff = handoff
        deps.unmetered = { [weak facts] in facts?.unmetered ?? true }
        deps.agree = keys.agree
        let device = DeviceService(deps, bundles: bundles, events: events)
        let center = PushCenter(device: device, facts: facts, tokens: store)
        center.apnsEnvironment = facts.apnsEnvironment
        center.model = model
        center.voipToken = { [weak model] in model?.voipToken }
        shared = center
        model.push = center

        let host = SystemControlHost(security: security)
        center.host = host
        device.host = host
        // The wipe's report: signed with the device key while it exists, sent at every start until delivered.
        device.wipeReporter.signer = security.signer
        security.wiper.signer = device.wipeReporter
        security.wiper.transport = device.wipeReporter
        security.wiper.addTeardown("device") { [weak center] in center?.wiped() }
        Task { await security.wiper.sendPending() }

        // VoIP pushes (Platform/Calls): opened here, synchronously.
        CallSystem.shared.voip.opener = VoIPInviteOpener(device: device, keys: keys, store: store)
        CallSystem.shared.voip.onToken { [weak center] _ in center?.tokensChanged() }

        center.registerBackgroundTask()
        bundles.loadActive()
        model.onLink { [weak device] link in
            guard case .enroll(let url) = link, let device else { return false }
            return device.takeEnrollLink(url)
        }
        model.onScenePhase { [weak center] phase in
            switch phase {
            case .active: center?.foreground()
            case .background: center?.scheduleCheckin()
            default: break
            }
        }
        device.onCheckin.append { [weak center] in center?.scheduleCheckin() }
        device.onEnrolled.append { [weak center] in center?.scheduleCheckin() }
    }

    /// The command host (Platform/Security + Notifications).
    private var host: SystemControlHost?

    // MARK: RemotePushHandling

    func didRegister(apnsToken token: Data) {
        let hex = PushTokens.hex(token)
        registrationError = nil
        guard hex != apnsToken else { return }
        apnsToken = hex
        tokensStore?.saveNow("push", ["apnsToken": .string(hex), "apnsEnv": .string(apnsEnvironment)])
        logger.info("APNs token ready")
        tokensChanged()
    }

    func didFailToRegister(_ error: any Error) {
        registrationError = error.localizedDescription
        logger.info("no APNs token")
    }

    func didReceiveRemoteNotification(_ userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        guard let w = PushOpener.wire(from: userInfo), let wire = NetJSON.from(w) else {
            // A relay wake-up without a command: the rooms' business (the integration listens to onWake).
            for o in onWake { o(userInfo) }
            return .noData
        }
        switch await device.handle(wire: wire, via: "apns") {
        case .done: return .newData
        case .duplicate: return .noData
        case .dropped: return .failed
        }
    }

    /// A silent push that carried no command (a relay wake-up) — the room session's.
    var onWake: [([AnyHashable: Any]) -> Void] = []

    // MARK: tokens

    /// The APNs or VoIP token changed: the server gets it now.
    func tokensChanged() {
        guard device.isEnrolled else { return }
        Task { await device.checkin("apns-token", force: true) }
    }

    // MARK: foreground and background

    func foreground() {
        facts?.refreshPermissions()
        Task {
            await device.processHandoff()
            await device.checkin("foreground")
        }
    }

    func registerBackgroundTask() {
        let ok = BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.checkinTask, using: nil) { task in
            let box = UncheckedBox(task)
            Task { @MainActor in PushCenter.shared?.runBackground(box.value) }
        }
        if !ok { logger.warning("the check-in task is not permitted (Info.plist)") }
    }

    private func runBackground(_ task: BGTask) {
        scheduleCheckin()
        let work = Task { await device.checkin("job", force: true) }
        task.expirationHandler = { work.cancel() }
        Task {
            let ok = await work.value
            task.setTaskCompleted(success: ok)
        }
    }

    /// The next background check-in (Android Checkin.schedule): 12 h with APNs, the policy's poll interval without.
    func scheduleCheckin() {
        guard let st = device.state, st.enrolled else { return }
        let seconds = CheckinSchedule.backgroundInterval(state: st, pushEnabled: apnsToken != nil && device.pushMode == "apns")
        let refresh = (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String])?.contains("fetch") ?? false
        let request: BGTaskRequest
        if refresh {
            request = BGAppRefreshTaskRequest(identifier: Self.checkinTask)
        } else {
            let p = BGProcessingTaskRequest(identifier: Self.checkinTask)
            p.requiresNetworkConnectivity = true
            request = p
        }
        request.earliestBeginDate = Date(timeIntervalSinceNow: TimeInterval(seconds))
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            logger.info("the background check-in could not be scheduled")
        }
    }

    /// The wipe: no task, no token kept, the device forgotten.
    func wiped() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.checkinTask)
        apnsToken = nil
        device.forgetAll()
        UNUserNotificationCenter.current().setBadgeCount(0)
    }
}

/// A value handed across isolation as it is (a BGTask the system gives once).
struct UncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - the commands' host

/// Lock and wipe through Platform/Security, notices through Platform/Notifications (Notifier).
@MainActor
final class SystemControlHost: DeviceControlHost {
    private weak var security: SecurityCenter?

    init(security: SecurityCenter) { self.security = security }

    func lockNow() { security?.lock.lockNow(remote: true) }

    func wipe(reason: String) { security?.wipe(reason: reason, remote: true, attempts: 0) }

    func flash(title: String, text: String, level: String, alreadyShown: Bool) -> String {
        Notifier.shared?.flash(title: title, text: text, level: level, alreadyShown: alreadyShown) ?? "notification"
    }

    func push(title: String, body: String, room: String, url: String) { Notifier.shared?.push(title: title, body: body, room: room, url: url) }

    func notify(_ payload: [String: Any]) { Notifier.shared?.templated(payload, local: false) }

    func logTail(_ count: Int, errorsOnly: Bool) -> [String] { LogTail.recent(count, errorsOnly: errorsOnly) }
}

/// The app's own log lines (Android Log.tail): this process, the app's subsystem, never debug.
enum LogTail {
    static func recent(_ count: Int, errorsOnly: Bool) -> [String] {
        guard let store = try? OSLogStore(scope: .currentProcessIdentifier),
              let entries = try? store.getEntries(at: store.position(date: Date().addingTimeInterval(-6 * 3600)),
                                                  matching: NSPredicate(format: "subsystem == %@", "cz.m5cet.app")) else { return [] }
        var out: [String] = []
        let f = ISO8601DateFormatter()
        for case let e as OSLogEntryLog in entries {
            if errorsOnly ? (e.level != .error && e.level != .fault) : (e.level == .debug) { continue }
            out.append("\(f.string(from: e.date)) \(e.category) \(e.composedMessage)")
        }
        return Array(out.suffix(count))
    }
}

// MARK: - VoIP pushes

/// Opens a PushKit payload for Platform/Calls (VoIPPayloadOpening): the same wire as the control messages
/// ({"m5":{i,e,iv,ct,s}}), checked synchronously (the server's signature with the pinned key, ECIES with the
/// Secure Enclave key, the id, the expiry) and deduplicated (SYS record "seen-voip"). Contents:
///   {kind:"call"|"call-end", payload:{room: <room key>, who, video, at}}   (Platform/Calls README)
///   {kind:"notify", payload:{kind:"call", room: <the server's room id>, vars:{sender}, at}}   (server/ios/commands.ts today)
@MainActor
final class VoIPInviteOpener: VoIPPayloadOpening {
    private weak var device: DeviceService?
    private let keys: KeyringEciesOpener
    private let store: any SyncStateStore
    static let record = "seen-voip"

    init(device: DeviceService, keys: KeyringEciesOpener, store: any SyncStateStore) {
        self.device = device
        self.keys = keys
        self.store = store
    }

    func openCallInvite(_ payload: [AnyHashable: Any]) -> VoIPCallInvite? {
        guard let st = device?.state, st.enrolled, let wire = PushOpener.wire(from: payload),
              let o = try? PushOpener.open(wire, deviceId: st.deviceId, serverKey: st.serverKey, now: PushOpener.nowMs(), agree: keys.agree) else { return nil }
        var seen = store.loadNow(Self.record)?.arr("ids")?.compactMap(\.stringValue) ?? []
        if seen.contains(o.id) { return nil }
        seen.append(o.id)
        store.saveNow(Self.record, ["ids": .strings(Array(seen.suffix(100)))])
        return Self.invite(o, roomForServerId: { Notifier.shared?.rooms?.roomKey(forServerId: $0) })
    }

    /// The invite of an opened message (nil: not a call, or a room this device does not have).
    static func invite(_ o: PushOpener.Opened, roomForServerId: (String) -> String?) -> VoIPCallInvite? {
        let p = o.payload
        func s(_ k: String, _ from: [String: Any]) -> String { from[k] as? String ?? "" }
        switch o.kind {
        case "call", "call-end":
            let room = s("room", p)
            guard !room.isEmpty else { return nil }
            return VoIPCallInvite(kind: o.kind == "call" ? .ring : .end, id: o.id, roomKey: room, who: s("who", p),
                                  video: (p["video"] as? Bool) ?? false, at: (p["at"] as? NSNumber)?.int64Value ?? o.at)
        case "notify":
            guard s("kind", p) == "call", let room = roomForServerId(s("room", p)) else { return nil }
            let vars = p["vars"] as? [String: Any] ?? [:]
            let who = NotifyTemplate.rank(s("privacy", p)) >= 1 ? s("sender", vars) : ""
            return VoIPCallInvite(kind: .ring, id: o.id, roomKey: room, who: who, video: false, at: (p["at"] as? NSNumber)?.int64Value ?? o.at)
        default:
            return nil
        }
    }
}
