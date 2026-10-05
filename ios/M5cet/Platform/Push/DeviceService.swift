// The device's side of the server (Android net/Server + push/Checkin +
// push/Control + the enrolment of ui/parts/Forms): /api/ios/* with every request
// signed by the Secure Enclave key, the signed policy, the control messages, the
// events, the design bundles and the release records.
//
//   enroll(server:code:name:)   /info, the pins (the build's, the QR code's kid), /enroll, the same key in
//                               its answer, the signed policy — then the first check-in
//   checkin(_:force:)           state → policy, commands, the newest bundle and release, the oldest build
//   handle(wire:via:)           a control message from APNs, the extension or a check-in: checked, opened,
//                               deduplicated, carried out, acknowledged (ControlInbox + execute)
//
// The screens use the observable state (enrolment form, errors, updateRequired, deviceStatus) — the
// enrolment form itself is a Parts screen; links (m5cet://enroll?…) fill `prefill`.

import CryptoKit
import Foundation
import M5Design
import M5Net
import Observation
import OSLog

/// What the commands touch outside the network layer (SystemControlHost wires Security and Notifications).
@MainActor
protocol DeviceControlHost: AnyObject {
    /// "lock": the server's lock (also during a call).
    func lockNow()
    /// "wipe": everything goes (after the acknowledgement); `reason` as the console wrote it.
    func wipe(reason: String)
    /// "flash": in the app when it is on screen ("app"), else a notification ("notification").
    func flash(title: String, text: String, level: String, alreadyShown: Bool) -> String
    /// "push": the console's notification.
    func push(title: String, body: String, room: String, url: String)
    /// "notify": the notifier's template, drawn on the device.
    func notify(_ payload: [String: Any])
    /// "status" with logs: the app's last log lines (errors only, or everything but debug).
    func logTail(_ count: Int, errorsOnly: Bool) -> [String]
}

/// Platform/Location's side (wired by the integration): the policy's location part and the server's requests.
@MainActor
protocol DeviceLocationControl: AnyObject {
    /// policy.location ({track, days, minSeconds}) after every enrolment / check-in; nil when the policy has none.
    func locationPolicyChanged(_ location: [String: Any]?)
    /// A "location" command (not sent by 6.14 servers; Android has none): a position now. True when one was taken.
    func locateNow(reason: String) async -> Bool
}

/// An enrolment link's values for the form (Android Forms.enrollLink: the form's prefill, newer = larger seq).
struct EnrollPrefill: Equatable, Sendable {
    var server: String
    var code: String
    var kid: String
    var seq: Int
}

/// What a link did, for the screen to say (design texts enroll.qr…).
enum EnrollNotice: Equatable, Sendable {
    case invalid
    case applied(noCode: Bool)
    case already(server: String)
    case otherServer(current: String, link: String)
    case locked
}

@MainActor
@Observable
final class DeviceService {
    struct Dependencies {
        var client: DeviceAPIClient
        /// The SYS tier's records ("config", "seen", "events", "acks", …).
        var store: any SyncStateStore
        var signer: any RequestSigner
        var opener: any EciesOpener
        var facts: any DeviceFactsProviding
        var clock: NetClock = .system
        /// CFBundleVersion as a number.
        var appCode: Int
        /// The build's pinned server key (Info.plist M5ServerKeyPin: kid / fingerprint / SHA-256), nil: none.
        var buildPin: String?
        /// The server the form starts with (Info.plist M5DefaultServer; Android BuildConfig.DEFAULT_SERVER).
        var defaultServer: String = ""
        /// The lock policy (Platform/Security PolicyStore): applies policySigned of an answer.
        var applyPolicy: (_ answer: NetJSON, _ serverKey: String, _ deviceId: String) -> Bool = { _, _, _ in false }
        /// A new server: the policy's clock starts again (Android Config.enrolled).
        var resetPolicy: () -> Void = {}
        /// The app lock (an enrolment link while locked says nothing of the server).
        var isLocked: () -> Bool = { false }
        /// The notification extension's notes (lock / wipe it saw, messages it showed).
        var handoff: PushHandoff?
        /// Whether the network is unmetered (bundle downloads with update.wifiOnly).
        var unmetered: () -> Bool = { true }
        /// Raw ECDH with the device's encryption key, synchronously (reading a notification's wire again).
        var agree: (@Sendable (P256.KeyAgreement.PublicKey) throws -> Data)?
    }

    // MARK: observable state

    /// The server, this device's id there, the pinned key, the policy (nil: not enrolled).
    private(set) var state: DeviceState?
    var isEnrolled: Bool { state?.enrolled ?? false }
    private(set) var enrolling = false
    /// Why the last enrolment failed (Android form "enrollError"), nil after a success.
    private(set) var enrollError: String?
    /// A link's values for the enrolment form.
    private(set) var prefill: EnrollPrefill?
    /// What the last enrolment link did.
    var enrollNotice: EnrollNotice?
    /// "" or the operator's verdict on this device (403 device-…): "revoked", "blocked", "wiped", …
    private(set) var deviceStatus = ""
    private(set) var checkingIn = false
    /// When the last check-in succeeded (ms; 0: not in this run).
    private(set) var lastCheckinAt: Millis = 0
    /// The last check-in's problem (network, refused), nil when it went through.
    private(set) var lastError: String?
    /// How the server reaches this device ("apns" / "poll").
    private(set) var pushMode = "poll"
    /// The policy in force ({} before the first signed one).
    var policy: NetJSON { state?.policy ?? .object([:]) }
    /// The app must be updated before anything else (below the server's minimum build, a mandatory release).
    var updateRequired: Bool { update.mandatory }

    let update: UpdateNotice
    let bundles: DesignBundleStore
    let events: DeviceEvents

    // MARK: wiring

    @ObservationIgnored let deps: Dependencies
    @ObservationIgnored weak var host: (any DeviceControlHost)?
    @ObservationIgnored weak var location: (any DeviceLocationControl)?
    /// The tokens to report (PushCenter: the APNs token, AppModel's VoIP token, the environment).
    @ObservationIgnored var pushTokens: () -> PushTokens = { PushTokens() }
    /// After every successful check-in (the integration: Define refresh; PushCenter: the next background task).
    @ObservationIgnored var onCheckin: [() -> Void] = []
    /// The enrolment went through.
    @ObservationIgnored var onEnrolled: [() -> Void] = []
    @ObservationIgnored private var schedule = CheckinSchedule()
    @ObservationIgnored private let inbox: ControlInbox
    @ObservationIgnored private let link: NotifyLink
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    /// An "update" / "config" command arrived during a check-in: one more right after (Android: the next run waits).
    @ObservationIgnored private var rerun: String?
    @ObservationIgnored private let logger = Logger(subsystem: "cz.m5cet.app", category: "device")
    @ObservationIgnored let wipeReporter = DeviceWipeReporter()

    init(_ deps: Dependencies, bundles: DesignBundleStore, events: DeviceEvents) {
        self.deps = deps
        self.bundles = bundles
        self.events = events
        update = UpdateNotice(currentBuild: deps.appCode)
        inbox = ControlInbox(store: deps.store, opener: deps.opener, clock: deps.clock)
        link = NotifyLink(api: deps.client)
        if let j = deps.store.loadNow("config"), case .object = j {
            let st = DeviceState(json: j)
            if st.enrolled { state = st }
        }
        update.noteMinBuild(state?.minBuild ?? 0)
        wipeReporter.update(state)
        let client = deps.client
        events.send = { [weak self] batch in
            guard let creds = await self?.credentials() else { throw NetError.unavailable("not enrolled") }
            try await client.events(creds, batch)
        }
        events.onAdd = { [weak self] in Task { @MainActor in self?.flushSoon() } }
        bundles.event = { [weak self] type, detail in self?.events.add(type, detail: detail) }
        update.onNewRelease.append { [weak self] r in
            self?.events.add("update-available", detail: ["kind": "release", "id": .string(r.id), "version": .string(r.version)])
        }
    }

    private func credentials() -> DeviceCredentials? {
        guard let st = state, st.enrolled else { return nil }
        return try? DeviceEnrollment.credentials(st, signer: deps.signer)
    }

    private func save(_ st: DeviceState?) {
        state = st
        deps.store.saveNow("config", st?.json)
        wipeReporter.update(st)
    }

    private func flushSoon() {
        flushTask?.cancel()
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard !Task.isCancelled else { return }
            await self?.events.flush()
        }
    }

    // MARK: enrolment

    /// m5cet://enroll?server=…&code=…&kid=… (AppModel.onLink): the form's values, or a notice when enrolled.
    @discardableResult
    func takeEnrollLink(_ url: URL) -> Bool {
        guard let l = EnrollLink.parse(url.absoluteString) else {
            enrollNotice = .invalid
            logger.warning("an enrolment link that is not valid")
            return true
        }
        if let st = state, st.enrolled {
            enrollNotice = deps.isLocked() ? .locked
                : EnrollLink.sameServer(st.server, l.server) ? .already(server: st.server) : .otherServer(current: st.server, link: l.server)
            return true
        }
        prefill = EnrollPrefill(server: l.server, code: l.code, kid: l.kid, seq: (prefill?.seq ?? 0) + 1)
        enrollError = nil
        enrollNotice = .applied(noCode: l.code.isEmpty)
        return true
    }

    /// The server the enrolment form shows first: a link's, else the build's default.
    var suggestedServer: String { prefill?.server ?? deps.defaultServer }

    /// Enrols with the code and the name the person typed (the server: a link's or the default).
    @discardableResult
    func enroll(code: String, name: String) async -> Bool { await enroll(server: nil, code: code, name: name) }

    /// Enrols this device (Android Forms.submit): /info, the pins bind the server's key itself (the build's pin,
    /// a link's kid for that server), /enroll, the same key in the answer, the signed policy; then the first
    /// check-in. False with `enrollError` set when it did not go through.
    @discardableResult
    func enroll(server: String?, code: String, name: String) async -> Bool {
        if enrolling || isEnrolled { return false }
        let raw = (server ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let base = normalizeServer(raw.isEmpty ? suggestedServer : raw)
        guard EnrollLink.server(base) != nil else {
            enrollError = "not a server address"
            return false
        }
        enrolling = true
        enrollError = nil
        defer { enrolling = false }
        let kid = prefill.flatMap { EnrollLink.sameServer($0.server, base) ? $0.kid : nil }
        do {
            let client = deps.client
            let info = try await client.info(base: base)
            try ServerKeyPin.check(publicKey: info.server.publicKey, statedKid: info.server.kid, pins: [deps.buildPin, kid])
            let encKey = try await deps.opener.publicKeySPKI()
            let device = deps.facts.description(name: name)
            let answer = try await client.enroll(base: base, code: code.trimmingCharacters(in: .whitespacesAndNewlines), device: device,
                                                 push: pushTokens(), signer: deps.signer, encKey: encKey)
            let answered = answer.obj("server")
            try ServerKeyPin.same(checked: info.server.publicKey, answered: answered?.str("publicKey"), answeredKid: answered?.str("kid"))
            let deviceId = answer.str("deviceId")
            guard !deviceId.isEmpty else { throw NetError.badAnswer("the enrolment answer has no device id") }
            let key = answered?.str("publicKey") ?? ""
            var st = DeviceState(server: base, deviceId: deviceId, serverKey: key, serverKid: answered?.str("kid") ?? "",
                                 serverFingerprint: P256Keys.fingerprint(spki: key))
            st.apply(serverAnswer: answer)
            save(st)
            deps.resetPolicy()
            _ = deps.applyPolicy(answer, key, deviceId)
            policyApplied()
            update.noteMinBuild(max(info.minBuild, answer.int("minBuild")))
            pushMode = answer.obj("apns") != nil && !(pushTokens().token ?? "").isEmpty ? "apns" : "poll"
            prefill = nil
            enrollNotice = nil
            deviceStatus = ""
            logger.info("enrolled")
            events.add("unlock", detail: ["enrolled": true])
            for o in onEnrolled { o() }
            await checkin("enrolled", force: true)
            return true
        } catch let e as HTTPError {
            enrollError = e.message
        } catch let e as NetError {
            enrollError = e.description
        } catch {
            enrollError = "\(error)"
        }
        logger.error("enrolment failed")
        return false
    }

    // MARK: check-in

    /// One check-in (Android Checkin.run): in the foreground at most every 5 minutes (`force`: now).
    @discardableResult
    func checkin(_ why: String, force: Bool = false) async -> Bool {
        guard var st = state, st.enrolled, let creds = credentials() else { return false }
        if checkingIn {
            if force { rerun = why }
            return false
        }
        if !force && !schedule.due(now: deps.clock.now()) { return false }
        checkingIn = true
        defer {
            checkingIn = false
            if let again = rerun {
                rerun = nil
                Task { await self.checkin(again, force: true) }
            }
        }
        let tokens = pushTokens()
        let push = (tokens.token ?? "").isEmpty ? "poll" : "apns"
        do {
            let result = try await Checkin.run(client: deps.client, credentials: creds, state: &st, device: deps.facts.description(name: nil),
                                               status: deps.facts.status(bundle: bundles.report, push: push, policyAt: st.policyAt), push: tokens)
            schedule.ran(at: deps.clock.now())
            lastCheckinAt = deps.clock.now()
            save(st)
            if case .ignored(let reason) = result.policy { logger.warning("\(reason, privacy: .public)") }
            _ = deps.applyPolicy(result.raw, st.serverKey, st.deviceId)
            policyApplied()
            pushMode = result.push.isEmpty ? push : result.push
            deviceStatus = ""
            lastError = nil
            update.onCheckin(release: result.release, minBuild: result.minBuild, updateRequired: result.updateRequired)
            for wire in result.commands { await handle(wire: wire, via: "checkin") }
            await retryAcks()
            if let offer = result.bundle { await offerBundle(offer) }
            if update.state == .available { await verifyRelease() }
            await events.flush()
            logger.debug("check-in done (\(why, privacy: .public))")
            for o in onCheckin { o() }
            return true
        } catch CheckinError.device(let status) {
            deviceStatus = status
            lastError = "device-\(status)"
            logger.warning("check-in refused: device-\(status, privacy: .public)")
        } catch {
            lastError = (error as? HTTPError)?.description ?? (error as? NetError)?.description ?? "\(error)"
            logger.debug("check-in not now")
        }
        return false
    }

    /// In the foreground (Checkin.runIfDue).
    func checkinIfDue() { Task { await checkin("foreground") } }

    private func policyApplied() {
        location?.locationPolicyChanged(policy.obj("location")?.foundation)
    }

    private func offerBundle(_ offer: BundleOffer) async {
        guard let st = state, let creds = credentials() else { return }
        let u = policy.obj("update")
        let client = deps.client
        await bundles.offer(offer, autoDownload: u?.bool("autoDownload", true) ?? true, wifiOnly: u?.bool("wifiOnly", false) ?? false,
                            unmetered: deps.unmetered(),
                            fetch: { id, progress in try await client.bundle(creds, id: id, progress: progress) },
                            keys: .init(serverKey: st.serverKey, serverKid: st.serverKid, deviceId: st.deviceId))
    }

    /// "Download" of a bundle the policy did not fetch at once.
    func downloadOfferedBundle(_ offer: BundleOffer) async -> Bool {
        guard let st = state, let creds = credentials() else { return false }
        let client = deps.client
        return await bundles.download(offer, fetch: { id, progress in try await client.bundle(creds, id: id, progress: progress) },
                                      keys: .init(serverKey: st.serverKey, serverKid: st.serverKid, deviceId: st.deviceId))
    }

    /// GET /releases/:id, checked by the pinned key, before its link is offered.
    func verifyRelease() async {
        guard let st = state, let creds = credentials(), let r = update.release else { return }
        do {
            update.verified(try ReleaseWatcher.verify(try await deps.client.release(creds, id: r.id), serverKey: st.serverKey))
        } catch {
            update.verificationFailed()
            events.add("update-failed", detail: ["kind": "release", "id": .string(r.id), "error": .string("\(error)")])
        }
    }

    // MARK: control messages

    enum Handled: Equatable, Sendable {
        case done(kind: String)
        case dropped(String)
        case duplicate
    }

    /// A control message (Android Control.handle): `alreadyShown` — the extension posted its notification.
    @discardableResult
    func handle(wire: NetJSON, via: String, alreadyShown: Bool = false) async -> Handled {
        guard let st = state, st.enrolled else { return .dropped("not enrolled") }
        let shown = alreadyShown || (deps.handoff?.entry(wire.str("i"))?.shown ?? false)
        switch await inbox.handle(wire, deviceId: st.deviceId, serverKey: st.serverKey, via: via) {
        case .dropped(let why):
            logger.warning("a control message was dropped")
            return .dropped(why)
        case .duplicate(let id):
            // Seen before: its answer may still be owed (the network failed when it ran).
            await retryAcks(only: id)
            return .duplicate
        case .command(let c):
            await execute(c, alreadyShown: shown)
            deps.handoff?.remove(c.id)
            return .done(kind: c.kindName)
        }
    }

    /// Carries out one checked command and answers it (Android Control.handle's switch).
    func execute(_ c: ControlCommand, alreadyShown: Bool) async {
        let p = c.payload
        switch c.kind {
        case .ping:
            await ack(c.id, ok: true, result: ["state": currentStatus().json, "via": .string(c.via)])
        case .status:
            var r: [String: NetJSON] = ["state": currentStatus().json, "bundle": bundles.report, "via": .string(c.via)]
            let logs = policy.str("logs", "errors")
            if p.bool("logs"), logs != "off" { r["log"] = .strings(host?.logTail(200, errorsOnly: logs == "errors") ?? []) }
            await ack(c.id, ok: true, result: .object(r))
        case .flash:
            let shown = host?.flash(title: p.str("title"), text: p.str("text"), level: p.str("level", "info"), alreadyShown: alreadyShown) ?? "notification"
            await ack(c.id, ok: true, result: ["shown": .string(shown)])
        case .push:
            if !alreadyShown { host?.push(title: p.str("title"), body: p.str("body"), room: p.str("room"), url: p.str("url")) }
            await ack(c.id, ok: true, result: ["shown": true])
        case .notify:
            if !alreadyShown { host?.notify(p.foundation) }
            await ack(c.id, ok: true, result: ["shown": true])
        case .update, .config:
            await ack(c.id, ok: true, result: ["checking": true])
            // A push waits for it (iOS gives the silent push its ~30 s); during a check-in it runs once more after.
            await checkin(c.kindName, force: true)
        case .lock:
            host?.lockNow()
            await ack(c.id, ok: true, result: ["locked": true])
        case .wipe:
            // Acknowledge first: afterwards the device key is gone.
            await ack(c.id, ok: true, result: ["wiping": true])
            let reason = p.str("reason")
            host?.wipe(reason: reason.isEmpty ? "remote" : "remote: " + reason)
        case .unknown:
            if c.kindName == "location", let location {
                let ok = await location.locateNow(reason: p.str("reason"))
                await ack(c.id, ok: ok, result: ["located": .bool(ok)], error: ok ? nil : "no position")
            } else {
                await ack(c.id, ok: false, result: nil, error: "unknown kind \(c.kindName)")
            }
        }
    }

    private func currentStatus() -> DeviceStatusReport {
        let push = (pushTokens().token ?? "").isEmpty ? "poll" : "apns"
        return deps.facts.status(bundle: bundles.report, push: push, policyAt: state?.policyAt ?? 0)
    }

    /// POST /ack; an answer that cannot go now waits in the SYS record "acks" for the next check-in.
    private func ack(_ id: String, ok: Bool, result: NetJSON?, error: String? = nil) async {
        let entry: NetJSON = ["id": .string(id), "ok": .bool(ok), "result": result ?? .null, "error": .string(error ?? "")]
        guard let creds = credentials() else { return }
        do {
            try await deps.client.ack(creds, id: id, ok: ok, result: result, error: error)
        } catch let e as HTTPError where (400..<500).contains(e.status) && e.status != 429 {
            logger.warning("the server refused an answer")
        } catch {
            var list = deps.store.loadNow("acks")?.arr("list") ?? []
            list.removeAll { $0.str("id") == id }
            list.append(entry)
            deps.store.saveNow("acks", ["list": .array(Array(list.suffix(50)))])
            logger.info("an answer waits")
        }
    }

    private func retryAcks(only id: String? = nil) async {
        guard let creds = credentials() else { return }
        let list = deps.store.loadNow("acks")?.arr("list") ?? []
        if list.isEmpty { return }
        var rest: [NetJSON] = []
        for a in list {
            if let id, a.str("id") != id { rest.append(a); continue }
            do {
                try await deps.client.ack(creds, id: a.str("id"), ok: a.bool("ok"), result: a["result"].flatMap { $0.isNull ? nil : $0 },
                                          error: a.str("error").isEmpty ? nil : a.str("error"))
            } catch let e as HTTPError where (400..<500).contains(e.status) && e.status != 429 {
                continue
            } catch {
                rest.append(a)
            }
        }
        deps.store.saveNow("acks", rest.isEmpty ? nil : ["list": .array(rest)])
    }

    /// A control message's content without carrying it out (a notification's tap or reply reads its room);
    /// nil when it does not check out.
    func peek(_ wire: [String: String]) -> PushOpener.Opened? {
        guard let st = state, st.enrolled, let agree = deps.agree else { return nil }
        return try? PushOpener.open(wire, deviceId: st.deviceId, serverKey: st.serverKey, now: deps.clock.now(), agree: agree)
    }

    /// What the notification extension saw while the app was not running: a lock or wipe is carried out now
    /// (its wire checked again), notes older than 30 days go.
    func processHandoff() async {
        guard let handoff = deps.handoff else { return }
        handoff.purge(olderThan: 30 * 86_400_000, now: deps.clock.now())
        for e in handoff.entries() {
            guard let w = e.wire, let wire = NetJSON.from(w) else { continue }
            await handle(wire: wire, via: "apns", alreadyShown: e.shown)
        }
    }

    // MARK: the other signed calls

    /// POST /message-audit: a message hidden or deleted in the app's own view (never its content).
    func messageAudit(actions: [NetJSON], account: String?) async throws -> Int64 {
        guard let creds = credentials() else { throw NetError.unavailable("this device is not enrolled") }
        return try await deps.client.messageAudit(creds, actions: actions, account: account)
    }

    /// POST /location: positions the person and the policy allow (Platform/Location). 403 location-off: the server keeps none.
    func uploadLocation(points: [LocationPoint]) async throws -> (stored: Int64, minSeconds: Int64) {
        guard let creds = credentials() else { throw NetError.unavailable("this device is not enrolled") }
        return try await deps.client.location(creds, points: points)
    }

    /// POST /notify: wake this device for the signed-in account (`token`: its session; nil: signed out).
    func linkNotifications(token: String?, wanted: Bool) async -> NotifyLink.Outcome {
        guard let creds = credentials() else { return .unchanged }
        return await link.sync(device: creds, token: token, wanted: wanted)
    }

    var notificationsLinked: Bool { get async { await link.linked } }

    // MARK: the wipe

    /// Everything of the device goes with the data (Platform/Security's wipe removes the records themselves).
    func forgetAll() {
        state = nil
        wipeReporter.update(nil)
        prefill = nil
        enrollError = nil
        enrollNotice = nil
        lastCheckinAt = 0
        lastError = nil
        pushMode = "poll"
        schedule = CheckinSchedule()
        update.reset()
        bundles.reset()
        events.forget()
        if let h = deps.handoff { for e in h.entries() { h.remove(e.id) } }
    }
}

/// The wipe's last report, signed while the device key still exists (Platform/Security WipeReportSigner)
/// and sent later as it was (WipeTransport) — POST <server>/api/ios/events.
final class DeviceWipeReporter: WipeReportSigner, WipeTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var server = "", deviceId = ""
    /// The device's signing key (Platform/Security), nil in tests without one.
    var signer: (any DeviceSigner)?
    var transport: any HTTPTransport = URLSessionHTTPTransport()
    var clock: NetClock = .system

    func update(_ st: DeviceState?) {
        lock.withLock {
            server = st?.server ?? ""
            deviceId = st?.deviceId ?? ""
        }
    }

    func signedEventsRequest(body: Data) throws -> PendingRequest? {
        let (server, deviceId) = lock.withLock { (self.server, self.deviceId) }
        guard !server.isEmpty, !deviceId.isEmpty, let signer else { return nil }
        let path = (URLComponents(string: server)?.percentEncodedPath ?? "") + "/api/ios/events"
        let time = String(clock.now())
        let nonce = Bytes.b64url(Bytes.random(16))
        let text = DeviceSigning.requestString(method: "POST", pathAndQuery: path, time: time, nonce: nonce, body: body)
        let sig = try signer.sign(Data(text.utf8))
        return PendingRequest(url: server + "/api/ios/events",
                              headers: ["X-M5-Device": deviceId, "X-M5-Time": time, "X-M5-Nonce": nonce, "X-M5-Signature": Bytes.b64(sig),
                                        "Content-Type": "application/json", "User-Agent": M5NetInfo.userAgent],
                              body: Bytes.b64(body), quiet: nil)
    }

    func send(_ request: PendingRequest) async throws -> Int {
        guard let url = URL(string: request.url), let body = Data(base64Encoded: request.body) else { return 400 }
        let res = try await transport.send(HTTPRequest(method: "POST", url: url, headers: request.headers, body: body), progress: nil)
        return res.status
    }
}
