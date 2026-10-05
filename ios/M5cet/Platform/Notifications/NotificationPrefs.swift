// The person's notification settings (Android push/NotifyPrefs, 6.7): which
// kinds, how much a notification shows (within what the operator allows), the
// order of the channels the server tries, quiet hours, "hide on the lock screen"
// — kept as settings ("notify.*", Settings › Notifications, a screen of the design)
// and, signed in, sent to the server so it knows how to notify (PUT
// /api/account/notify). Signed in, this device also asks to be woken for the
// account (POST /api/ios/notify, signed by the device key, carrying the session).
//
// The operator's templates (GET /api/notify/config) are kept in the SYS tier
// ("notify-policy"), and the switches the extension needs in "notify-prefs"
// (NotifyMirror), so a notification can be drawn while the app is locked or not
// running.

import Foundation
import M5Net
import OSLog

/// Where the notify.* settings live (the design's settings — the integration wires SettingsModel).
@MainActor
protocol NotifySettingsSource: AnyObject {
    func value(_ key: String) -> Any?
    func set(_ key: String, _ value: Any)
}

/// The account's session for the server calls (the integration wires the account).
@MainActor
protocol NotifyAccount: AnyObject {
    var signedIn: Bool { get }
    /// The session token (Bearer), nil when signed out or locked.
    var sessionToken: String? { get }
}

/// The settings until the design's are wired: Android's defaults, kept in UserDefaults (the wipe removes them).
@MainActor
final class DefaultsNotifySettings: NotifySettingsSource {
    private let defaults: UserDefaults
    private static let prefix = "cz.m5cet.settings."
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    func value(_ key: String) -> Any? { defaults.object(forKey: Self.prefix + key) ?? NotificationPrefs.defaults[key] }
    func set(_ key: String, _ value: Any) { defaults.set(value, forKey: Self.prefix + key) }
}

@MainActor
final class NotificationPrefs {
    static let kinds = NotifyMirror.kinds

    /// The settings' keys and defaults (Android NotifyPrefs.defaults + ConversationPlan.defaults).
    static let defaults: [String: Any] = {
        var d: [String: Any] = [
            "notify.on": true, "notify.away": true, "notify.privacy": "", "notify.order": "android,webpush,email",
            "notify.quiet": false, "notify.quietFrom": "22:00", "notify.quietTo": "07:00", LockScreen.setting: false,
        ]
        for k in kinds { d["notify." + k] = true }
        ConversationPlan.defaults(&d)
        return d
    }()

    /// The notify.* settings (the design's once Notifier.connect(design:) ran; UserDefaults before).
    var settings: any NotifySettingsSource
    weak var account: (any NotifyAccount)?
    private let store: (any SyncStateStore)?
    /// The device (the account link, the server's address); nil before Platform/Push is installed.
    weak var device: DeviceService?
    /// The app's texts (the design's translator), nil → English.
    var texts: (String) -> String? = { _ in nil }
    /// The app's name (the design's).
    var appName: () -> String = { "M5cet" }
    /// The person's language (the design's).
    var lang: () -> String = { NeutralTexts.deviceLanguage }
    /// A change the screen should show again; a flash for the screen.
    var onChange: () -> Void = {}
    var onFlash: (_ text: String, _ level: String) -> Void = { _, _ in }
    /// A local test notification (Notifier).
    var postLocalTest: ([String: Any]) -> Void = { _ in }
    /// The account's sync went through ("" = fine).
    private(set) var status = ""
    private(set) var busy = false
    /// This device is linked to the account's notifications (the last sync's answer; Android: a linked token).
    private(set) var linked = false
    private var pending: Task<Void, Never>?
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "notify")
    var http = HTTPClient()
    /// Whether the user tier is open (a locked app has no account session — that is not a sign-out).
    var unlocked: () -> Bool = { SecurityCenter.shared?.vault.unlocked ?? false }

    init(settings: any NotifySettingsSource, store: (any SyncStateStore)?) {
        self.settings = settings
        self.store = store
    }

    // MARK: reading

    func bool(_ key: String) -> Bool {
        switch settings.value(key) {
        case let b as Bool: b
        case let n as NSNumber: n.boolValue
        case let s as String: s == "true"
        default: (Self.defaults[key] as? Bool) ?? false
        }
    }

    func string(_ key: String) -> String { settings.value(key) as? String ?? (Self.defaults[key] as? String) ?? "" }

    var on: Bool { bool("notify.on") }

    /// Join the rooms so that the server covers for this device while the app is closed.
    var awayWanted: Bool { (account?.signedIn ?? false) && on && bool("notify.away") }

    /// Whether a notification of `kind` may show now (the switches and quiet hours; a test always).
    func allows(_ kind: String, at: Int64) -> Bool { mirror.allows(kind, at: at) }

    /// The operator's templates as last fetched ({} before the first fetch).
    var policy: NetJSON { store?.loadNow("notify-policy") ?? .object([:]) }

    /// One kind's template ({title:{cs,en,…}, body:{…}, privacy, maxPrivacy, accent, sound, actions…}), or nil.
    func template(_ kind: String) -> NetJSON? { policy.obj("templates")?.obj(kind) }

    /// The level a notification the app draws itself shows (Android localPrivacy): the person's choice within the
    /// operator's maximum; a locked app never shows content.
    func localPrivacy(_ kind: String, locked: Bool) -> String {
        PushContent.localPrivacy(chosen: string("notify.privacy"), operatorMax: template(kind)?.str("maxPrivacy", "content"), locked: locked)
    }

    /// The switches as the extension reads them (SYS "notify-prefs").
    var mirror: NotifyMirror {
        var m = NotifyMirror()
        m.on = on
        for k in Self.kinds { m.kinds[k] = bool("notify." + k) }
        m.privacy = string("notify.privacy")
        m.quiet = bool("notify.quiet")
        m.quietFrom = string("notify.quietFrom")
        m.quietTo = string("notify.quietTo")
        m.timeZone = TimeZone.current.identifier
        m.lockScreenHide = bool(LockScreen.setting)
        m.appName = appName()
        m.lang = lang()
        return m
    }

    /// Writes the mirror for the extension (after every change and at start).
    func writeMirror() {
        guard let store, let j = try? NetJSON.parse(mirror.data) else { return }
        store.saveNow(NotifyMirror.record, j)
    }

    // MARK: the screen

    private func t(_ key: String, _ fallback: String) -> String { texts(key) ?? fallback }

    /// $notify for Settings › Notifications (Android NotifyPrefs.scope).
    func scope(pushEnabled: Bool, linked: Bool) -> [String: Any] {
        var rows: [[String: Any]] = []
        let used = NotifyTemplate.order(string("notify.order"))
        for (i, c) in used.enumerated() {
            rows.append(["id": c, "used": true, "n": Double(i + 1), "first": i == 0, "last": i == used.count - 1,
                         "label": t("notify.channel." + c, c)])
        }
        for c in NotifyTemplate.channels where !used.contains(c) {
            rows.append(["id": c, "used": false, "n": 0.0, "first": true, "last": true, "label": t("notify.channel." + c, c)])
        }
        let hours: [[String: Any]] = (0..<48).map { h in
            let v = String(format: "%02d:%@", h / 2, h % 2 == 0 ? "00" : "30")
            return ["value": v, "label": v]
        }
        let p = policy
        return ["signedIn": account?.signedIn ?? false, "linked": linked, "busy": busy, "status": status, "push": pushEnabled,
                "serverOff": p["enabled"] != nil && !p.bool("enabled", true), "channels": rows, "hours": hours]
    }

    /// notify.up / notify.down / notify.use / notify.drop / notify.test / notify.sync — from the design's screen.
    func run(_ action: String, _ arg: String) {
        let order = string("notify.order")
        switch action {
        case "notify.up": settings.set("notify.order", NotifyTemplate.move(order, arg, -1)); settingChanged("notify.order")
        case "notify.down": settings.set("notify.order", NotifyTemplate.move(order, arg, 1)); settingChanged("notify.order")
        case "notify.use": settings.set("notify.order", NotifyTemplate.use(order, arg, true)); settingChanged("notify.order")
        case "notify.drop": settings.set("notify.order", NotifyTemplate.use(order, arg, false)); settingChanged("notify.order")
        case "notify.test": Task { await test() }
        case "notify.sync": Task { await sync(); onChange() }
        default: logger.warning("unknown notify action")
        }
        onChange()
    }

    // MARK: the server

    /// A notify.* setting changed: the mirror now, the server a moment later (several changes go as one).
    func settingChanged(_ key: String) {
        guard key.hasPrefix("notify.") || key.hasPrefix("conversations.") else { return }
        writeMirror()
        guard key.hasPrefix("notify.") else { return }
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    /// The settings as the server keeps them (client/src/lib/notify-template.ts UserNotifyPrefs).
    var serverPrefs: M5Net.NotifyPrefs {
        var kinds: [String: Bool] = [:]
        for k in Self.kinds { kinds[k] = bool("notify." + k) }
        return M5Net.NotifyPrefs(on: on, kinds: kinds, privacy: string("notify.privacy"), order: NotifyTemplate.order(string("notify.order")),
                                 quiet: bool("notify.quiet"), quietFrom: string("notify.quietFrom"), quietTo: string("notify.quietTo"),
                                 timeZone: TimeZone.current.identifier, lang: lang())
    }

    private var client: NotifyClient? {
        guard let server = device?.state?.server, !server.isEmpty else { return nil }
        return NotifyClient(base: server, http: http)
    }

    /// The operator's templates (public), kept for drawing notifications while locked.
    func fetchPolicy() async {
        guard let client else { return }
        do { store?.saveNow("notify-policy", try await client.config()) } catch { logger.info("the server's templates: not now") }
    }

    /// Sends the settings (signed in) and links or unlinks this device (Android NotifyPrefs.sync).
    func sync() async {
        await fetchPolicy()
        writeMirror()
        // 6.12 (F-16): a locked app has no account session in memory — that is not a sign-out (the link stays).
        guard unlocked() else { return }
        guard let account, account.signedIn, let token = account.sessionToken else {
            _ = await device?.linkNotifications(token: nil, wanted: false)
            linked = await device?.notificationsLinked ?? false
            return
        }
        do {
            if let client { try await client.putPrefs(token: token, prefs: serverPrefs) }
            status = ""
        } catch {
            status = (error as? HTTPError)?.message ?? "\(error)"
            logger.warning("settings not saved on the server")
        }
        _ = await device?.linkNotifications(token: token, wanted: on && bool("notify.away"))
        linked = await device?.notificationsLinked ?? false
    }

    /// Signed in or out: the settings and the link follow.
    func accountChanged() { Task { await sync() } }

    /// "Send a test notification": through the server and the account's channels; signed out, a local one.
    func test() async {
        guard let account, account.signedIn, let token = account.sessionToken, let client else {
            postLocalTest(testPayload())
            onFlash(t("notify.test.local", "Notifications work (the app showed it)."), "info")
            return
        }
        busy = true
        onChange()
        var text: String, level = "success"
        do {
            await sync()
            let r = try await client.test(token: token)
            if r.bool("ok") {
                text = t("notify.test.ok", "Sent through {channel}.").replacingOccurrences(of: "{channel}", with: t("notify.channel." + r.str("channel"), r.str("channel")))
            } else if !r.str("skipped").isEmpty {
                text = t("notify.test.skipped", "Not sent: {reason}").replacingOccurrences(of: "{reason}", with: r.str("skipped"))
                level = "warn"
            } else {
                text = t("notify.test.failed", "The test notification could not be sent.")
                level = "error"
            }
        } catch {
            text = (error as? HTTPError)?.message ?? "\(error)"
            level = "error"
        }
        busy = false
        onFlash(text, level)
        onChange()
    }

    /// A local test notification (signed out: there is no server side).
    func testPayload() -> [String: Any] {
        let t = template("test")
        let lang = self.lang()
        func localized(_ o: NetJSON?, _ fallback: String) -> String {
            guard let o else { return fallback }
            return o.str(lang).isEmpty ? (o.str("en").isEmpty ? fallback : o.str("en")) : o.str(lang)
        }
        let local = self.t("notify.test.local", "Notifications work (the app showed it).")
        return ["kind": "test", "privacy": "neutral", "tag": "m5-test", "vars": ["app": appName()],
                "tpl": ["title": localized(t?.obj("title"), "{app} · test"), "body": t == nil ? local : localized(t?.obj("body"), "")],
                "title": appName(), "body": local, "sound": true, "vibrate": true]
    }
}
