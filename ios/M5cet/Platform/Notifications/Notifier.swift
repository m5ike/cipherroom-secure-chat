// The app's notifications (Android telecom/Notify + ReplyReceiver + LockScreen,
// the app half of push/NotifyPrefs): UNUserNotificationCenter's delegate (App/
// Bootstrap installs it), the categories, what the app posts itself and what it
// does with what the extension posted.
//
//   message(…)      a room's new message the app decrypted (the person's level within the operator's
//                   maximum; never content, sender or room while locked — S11; a Communication
//                   Notification with the sender where the level shows him)
//   templated(…)    the notifier's "notify" message drawn on the device (the room's own name at "room")
//   flash / push    the console's notices (a flash shows inside the app when it is on screen)
//   update          a new version of the app
//   missedCall      CallCenter.onMissed — within the calls' privacy level
//   the lock        every notification that could name someone becomes neutral (re-posted under the same id,
//                   quietly — Android neutralizeAll); donated conversations with names are deleted
//   reply / read    UNTextInputNotificationAction → the room (only one the app is in, never while locked —
//                   G-23), then the room's notifications go
//   threads         per room, opaque (Conversations.id); the server's room id maps to it (the extension)
//
// What the integration wires: `rooms` (NotificationRooms: server id → room, labels, reply, read, open),
// `texts` (the design's), `flashSink` (the in-app flash), `prefs.settings` / `prefs.account`.

import Foundation
import Intents
import M5Net
import OSLog
import UIKit
import UserNotifications

/// The room side of notifications (the room session; the integration wires it).
@MainActor
protocol NotificationRooms: AnyObject {
    /// The rooms the app is in (their keys) — a notification only ever opens or replies into one of these.
    var joinedRoomKeys: [String] { get }
    /// The room with this id on the server (the notifier's opaque `room`), nil when the app is not in it.
    func roomKey(forServerId id: String) -> String?
    /// The room's own name.
    func label(ofRoom roomKey: String) -> String?
    /// A direct reply from a notification: sends `text` into the room; false when it could not.
    func reply(roomKey: String, text: String) async -> Bool
    /// "Mark read" from a notification.
    func markRead(roomKey: String)
    /// A tap: shows the room.
    func open(roomKey: String)
}

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate, LockParticipant {
    static private(set) var shared: Notifier?

    static let replyAction = "m5.reply", readAction = "m5.read"

    let prefs: NotificationPrefs
    let conversations: Conversations
    private let system: UNUserNotificationCenter?
    weak var rooms: (any NotificationRooms)?
    weak var device: DeviceService?
    /// The design's texts (key → text), nil → the built-in English / neutral table.
    var texts: (String) -> String? = { _ in nil } {
        didSet { prefs.texts = texts }
    }
    /// The design's in-app flash (Android FlashSink): true when it showed.
    var flashSink: ((_ title: String, _ text: String, _ level: String) -> Bool)?
    var isForeground: () -> Bool = { UIApplication.shared.applicationState == .active }
    var isLocked: () -> Bool = { SecurityCenter.shared?.lock.isLocked ?? false }
    /// The calls' privacy (Platform/Calls CallPrivacy.level 0–2) for missed calls.
    var callPrivacyLevel: () -> Int = { CallSystem.shared.environment.callPrivacy.level }
    /// The unread count for the badge (the rooms); nil: the delivered notifications are counted.
    var unreadCount: (() -> Int)?
    /// Posts a request (tests record them).
    var post: @MainActor (UNNotificationRequest) async -> Void
    private var previewsAlways = false
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "notify")
    var now: () -> Int64 = { PushOpener.nowMs() }

    init(prefs: NotificationPrefs, conversations: Conversations, system: UNUserNotificationCenter?) {
        self.prefs = prefs
        self.conversations = conversations
        self.system = system
        post = { req in
            guard let system else { return }
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in system.add(req) { _ in c.resume() } }
        }
        super.init()
        conversations.on = { [weak prefs] in prefs?.bool(ConversationPlan.settingOn) ?? true }
        conversations.namesWanted = { [weak prefs] in prefs?.bool(ConversationPlan.settingNames) ?? true }
        conversations.privacyRank = { [weak prefs] in NotifyTemplate.rank(prefs?.localPrivacy("message", locked: false) ?? "content") }
        conversations.isLocked = { [weak self] in self?.isLocked() ?? true }
    }

    // MARK: installation (App/Bootstrap.swift)

    static func install(into model: AppModel) {
        let security = SecurityCenter.shared
        let store: (any SyncStateStore)? = security.map { VaultNetStateStore(vault: $0.vault) }
        let prefs = NotificationPrefs(settings: DefaultsNotifySettings(), store: store)
        let n = Notifier(prefs: prefs, conversations: Conversations(store: store), system: .current())
        shared = n
        let center = UNUserNotificationCenter.current()
        center.delegate = n
        n.connect(design: model.design)
        n.device = PushCenter.shared?.device
        prefs.device = n.device
        prefs.postLocalTest = { [weak n] p in n?.templated(p, local: true) }
        security?.add(n)
        security?.wiper.addTeardown("conversations") { [weak n] in
            n?.conversations.switchedOff()
            UNUserNotificationCenter.current().setBadgeCount(0)
        }
        prefs.writeMirror()
        CallSystem.shared.center.onMissed = { [weak n] room, who, video, at in n?.missedCall(roomKey: room, who: who, video: video, at: at) }
        n.device?.update.onNewRelease.append { [weak n] r in
            n?.update(title: n?.t("update.release", "A new version of the app") ?? "", text: r.version)
        }
        n.device?.onEnrolled.append { [weak n] in Task { await n?.requestAuthorization() } }
        model.onScenePhase { [weak n] phase in
            guard phase == .active, let n else { return }
            Task {
                await n.refreshSettings()
                await n.refreshBadge()
            }
        }
        Task {
            await n.refreshSettings()
            if n.device?.isEnrolled == true { await n.requestAuthorization() }
            // A start while locked: what an earlier process left with names goes neutral.
            if n.isLocked() { await n.neutralizeAll() }
        }
    }

    /// Asks for alerts, sounds and badges (once; the system remembers the answer).
    @discardableResult
    func requestAuthorization() async -> Bool {
        guard let system else { return false }
        let settings = await system.notificationSettings()
        if settings.authorizationStatus != .notDetermined { return settings.authorizationStatus == .authorized }
        return (try? await system.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// The person's "Show Previews" (Always: what Android keeps off the lock screen is posted neutral).
    func refreshSettings() async {
        guard let system else { return }
        previewsAlways = await system.notificationSettings().showPreviewsSetting == .always
    }

    func t(_ key: String, _ fallback: String) -> String { texts(key) ?? fallback }

    private var appName: String { prefs.appName() }

    /// The neutral texts: the design's where it has one, else the server's table in the person's language.
    private var neutralTexts: PushContent.Texts {
        let lang = prefs.lang()
        let texts = self.texts
        return { kind in
            let design: String? = switch kind {
            case .message: texts("notify.message")
            case .missed: texts("ring.missed")
            case .call: texts("ring.call")
            case .notice, .security: nil
            }
            return design ?? NeutralTexts.text(kind, lang: lang)
        }
    }

    /// A notify.* or conversations.* setting changed (the screen's toggles): the mirror, the server, the donations.
    func settingChanged(_ key: String) {
        prefs.settingChanged(key)
        if key == ConversationPlan.settingOn, !prefs.bool(ConversationPlan.settingOn) { conversations.switchedOff() }
        if key == ConversationPlan.settingNames, !prefs.bool(ConversationPlan.settingNames) { conversations.locked() }
    }

    /// The design (its texts) changed: the actions' titles and the hidden-preview texts follow.
    func textsChanged() {
        registerCategories()
        prefs.writeMirror()
    }

    // MARK: categories

    func registerCategories() {
        let reply = UNTextInputNotificationAction(identifier: Self.replyAction, title: t("notify.reply", "Reply"), options: [.authenticationRequired],
                                                  textInputButtonTitle: t("notify.reply", "Reply"), textInputPlaceholder: "")
        let read = UNNotificationAction(identifier: Self.readAction, title: t("notify.markRead", "Mark read"), options: [.authenticationRequired])
        let hidden = neutralTexts(.message)
        let categories: Set<UNNotificationCategory> = [
            UNNotificationCategory(identifier: NotificationPlan.Category.message.rawValue, actions: [reply, read],
                                   intentIdentifiers: [INSendMessageIntentIdentifier], hiddenPreviewsBodyPlaceholder: hidden, options: []),
            UNNotificationCategory(identifier: NotificationPlan.Category.notice.rawValue, actions: [], intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: neutralTexts(.notice), options: []),
            UNNotificationCategory(identifier: NotificationPlan.Category.call.rawValue, actions: [], intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: neutralTexts(.call), options: []),
            UNNotificationCategory(identifier: NotificationPlan.Category.security.rawValue, actions: [], intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: neutralTexts(.security), options: []),
            UNNotificationCategory(identifier: NotificationPlan.Category.update.rawValue, actions: [], intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: neutralTexts(.notice), options: []),
        ]
        system?.setNotificationCategories(categories)
    }

    // MARK: posting

    private func request(_ id: String, _ plan: NotificationPlan, thread: String?, userInfo: [AnyHashable: Any] = [:],
                         conversation: String? = nil, donate: Bool = false) async {
        let content = NotificationContentFactory.content(plan, threadId: thread, userInfo: userInfo)
        let final: UNNotificationContent
        if conversation != nil, plan.sender != nil {
            final = await NotificationContentFactory.communicating(content, plan: plan, conversationId: conversation, donate: donate)
            if donate { conversations.donatedNamed() }
        } else {
            final = content
        }
        await post(UNNotificationRequest(identifier: id, content: final, trigger: nil))
        await refreshBadge()
    }

    /// Android Notify.message: a room's new message the app decrypted itself.
    func message(roomKey: String, roomName: String, sender: String, text: String, hideContent: Bool) {
        if !prefs.allows("message", at: now()) { return }
        let locked = isLocked()
        let tpl = prefs.template("message")
        let level = NotifyTemplate.rank(prefs.localPrivacy("message", locked: hideContent))
        let plan = PushContent.message(roomName: conversations.namesWanted() ? roomName : "", sender: sender, text: text, locked: locked, level: level,
                                       prefs: prefs.mirror, previewsAlways: previewsAlways, templateSound: tpl?.bool("sound", true) ?? true,
                                       templateActions: tpl?.bool("actions", true) ?? true, now: now(), texts: neutralTexts)
        let conv = conversations.id(roomKey)
        let showsSender = !locked && conversations.on()
        Task { await request("room." + conv, plan, thread: conv, conversation: showsSender ? conv : nil, donate: showsSender) }
    }

    /// Android Notify.templated: the notifier's message drawn with what only the app knows (the room's name).
    func templated(_ p: [String: Any], local: Bool) {
        let kind = p["kind"] as? String ?? "message"
        if !local, !prefs.allows(kind, at: now()) { return }
        let locked = isLocked()
        let serverRoom = (p["room"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let roomKey = serverRoom.flatMap { rooms?.roomKey(forServerId: $0) }
        let roomName = roomKey.flatMap { rooms?.label(ofRoom: $0) }
        let plan = PushContent.templated(p, locked: locked, prefs: prefs.mirror, previewsAlways: previewsAlways, now: now(),
                                         roomName: conversations.namesWanted() ? roomName : nil, local: local, texts: neutralTexts)
        let thread = roomKey.map(conversations.id) ?? serverRoom.map(conversations.thread(forServerRoom:))
        let id = roomKey.map { "room." + conversations.id($0) } ?? "notify." + String(ThreadIds.hmacHex(conversations.secret, p["tag"] as? String ?? "m5-\(kind)").prefix(16))
        Task { await request(id, plan, thread: thread, conversation: thread, donate: !locked && conversations.on()) }
    }

    /// The server's flash: in the app when it is on screen ("app"), else a notification ("notification").
    @discardableResult
    func flash(title: String, text: String, level: String, alreadyShown: Bool = false) -> String {
        if isForeground(), let flashSink, flashSink(title, text, level) { return "app" }
        if alreadyShown { return "notification" }
        let plan = PushContent.flash(["title": title, "text": text], appName: appName)
        Task { await request("flash." + String(ThreadIds.hmacHex(Data("flash".utf8), text).prefix(16)), plan, thread: nil) }
        return "notification"
    }

    /// The console's push (a room's thread when the app is in it, an https link).
    func push(title: String, body: String, room: String, url: String) {
        let plan = PushContent.push(["title": title, "body": body, "room": room, "url": url], appName: appName)
        let thread = room.isEmpty ? nil : rooms?.roomKey(forServerId: room).map(conversations.id)
        Task { await request("push." + String(ThreadIds.hmacHex(Data("push".utf8), title + "\u{0}" + body).prefix(16)), plan, thread: thread) }
    }

    /// A new version of the app (Android Notify.update).
    func update(title: String, text: String) {
        let plan = NotificationPlan(title: title, body: text, category: .update, sound: false, neutral: true, neutralKey: "notify.message")
        Task { await request("update", plan, thread: nil) }
    }

    /// A missed call (CallCenter.onMissed): quiet, the person only within the calls' privacy, never while locked.
    func missedCall(roomKey: String, who: String, video: Bool, at: Int64) {
        guard prefs.allows("call", at: now()) else { return }
        let plan = PushContent.missedCall(who: who, roomName: rooms?.label(ofRoom: roomKey) ?? "", level: callPrivacyLevel(), locked: isLocked(),
                                          appName: appName, texts: neutralTexts, at: at)
        let conv = conversations.id(roomKey)
        Task { await request("missed." + conv + "." + String(at), plan, thread: conv) }
    }

    // MARK: removing and the lock

    /// The room was read (or replied to): its notifications go (Android Notify.clearRoom).
    func clearRoom(_ roomKey: String) {
        let conv = conversations.id(roomKey)
        Task {
            guard let system else { return }
            let delivered = await system.deliveredNotifications()
            let ids = delivered.filter { $0.request.identifier == "room." + conv || $0.request.content.threadIdentifier == conv }.map(\.request.identifier)
            system.removeDeliveredNotifications(withIdentifiers: ids)
            await refreshBadge()
        }
    }

    /// The app locked (or started locked): every notification that may name a room or a person or show a message
    /// is posted again under its id with only the app's name and its neutral text, quietly; a reply goes
    /// (Android neutralizeAll, 6.10 G-22).
    func neutralizeAll() async {
        guard let system else { return }
        var n = 0
        for d in await system.deliveredNotifications() {
            let c = d.request.content
            guard let key = c.userInfo[NotificationContentFactory.neutralKey] as? String,
                  (c.userInfo[NotificationContentFactory.isNeutralKey] as? Bool) == false else { continue }
            let kind: NeutralTexts.Kind = key == "ring.call" ? .call : key == "ring.missed" ? .missed : .message
            var plan = PushContent.neutral(kind, appName: appName, texts: neutralTexts, sound: false)
            plan.passive = true
            var info = c.userInfo
            info.removeValue(forKey: NotificationContentFactory.threadKey)
            let content = NotificationContentFactory.content(plan, threadId: c.threadIdentifier.isEmpty ? nil : c.threadIdentifier, userInfo: info)
            await post(UNNotificationRequest(identifier: d.request.identifier, content: content, trigger: nil))
            n += 1
        }
        if n > 0 { logger.info("\(n) notifications made neutral (locked)") }
    }

    /// The badge: the rooms' unread count, else the delivered notifications.
    func refreshBadge() async {
        guard let system else { return }
        let count: Int
        if let unreadCount { count = unreadCount() } else { count = await system.deliveredNotifications().count }
        try? await system.setBadgeCount(count)
    }

    // MARK: LockParticipant

    func lockDidForget() {
        conversations.locked()
        Task { await neutralizeAll() }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        let info = UncheckedBox(notification.request.content.userInfo)
        return await MainActor.run { self.present(info.value) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = UncheckedBox(response.notification.request.content.userInfo)
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await Task { @MainActor in await self.respond(action: action, text: text, info: info.value) }.value
    }

    /// In the foreground: a message the extension drew is carried out now (lock / wipe at once, the rest
    /// answered); a flash shows inside the app instead of a banner.
    func present(_ info: [AnyHashable: Any]) -> UNNotificationPresentationOptions {
        if let w = PushOpener.wire(from: info), let device {
            let opened = device.peek(w)
            if opened?.kind == "flash", let flashSink, let p = opened?.payload,
               flashSink(p["title"] as? String ?? "", p["text"] as? String ?? "", p["level"] as? String ?? "info") {
                Task { await device.handle(wire: NetJSON.from(w) ?? .object([:]), via: "apns", alreadyShown: true) }
                return []
            }
            Task { await device.handle(wire: NetJSON.from(w) ?? .object([:]), via: "apns", alreadyShown: true) }
        }
        return [.banner, .list, .sound, .badge]
    }

    /// A tap, a reply or "mark read".
    func respond(action: String, text: String?, info: [AnyHashable: Any]) async {
        var roomKey: String?
        let joined = rooms?.joinedRoomKeys ?? []
        if let thread = info[NotificationContentFactory.threadKey] as? String { roomKey = conversations.room(of: thread, among: joined) }
        if let w = PushOpener.wire(from: info), let device {
            if roomKey == nil, let server = device.peek(w)?.payload["room"] as? String { roomKey = rooms?.roomKey(forServerId: server) }
            await device.handle(wire: NetJSON.from(w) ?? .object([:]), via: "apns", alreadyShown: true)
        }
        if let key = roomKey, !joined.contains(key) { roomKey = nil }
        switch action {
        case Self.replyAction:
            // Never while the app is locked (the phone was unlocked for the action, the app may not be).
            guard let key = roomKey, let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !isLocked() else {
                logger.info("a reply was not sent")
                return
            }
            _ = await rooms?.reply(roomKey: key, text: text)
            clearRoom(key)
        case Self.readAction:
            guard let key = roomKey, !isLocked() else { return }
            rooms?.markRead(roomKey: key)
            clearRoom(key)
        case UNNotificationDefaultActionIdentifier:
            if let s = info[NotificationContentFactory.urlKey] as? String, s.hasPrefix("https://"), let url = URL(string: s) {
                _ = await UIApplication.shared.open(url)
            } else if let key = roomKey {
                rooms?.open(roomKey: key)
            }
        default:
            break
        }
    }
}
