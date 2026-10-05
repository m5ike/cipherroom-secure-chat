// M5cet's Notification Service Extension: every visible push (`mutable-content: 1`)
// passes through here before iOS shows it (docs/ios-server.md § 2.1 — the
// counterpart of Android's FCM data messages handled in push/FcmService + telecom/Notify).
//
//   1. the sealed control message in `m5` ({i, e, iv, ct, s}) is checked with the pinned server key and
//      opened with the device's encryption key (Secure Enclave, shared keychain group) — the server's
//      settings and the person's switches come from the vault's SYS tier in the App Group
//      (SysTierReader); the USER tier is never here
//   2. the app's lock as lock-state.json tells it (LockMirror): locked → nothing names a person or a room
//   3. the text: the notifier's template drawn again (PushContent — Android Notify.templated), the console's
//      flash / push, or the neutral security notice for lock / wipe — a Communication Notification with
//      the sender where the level shows him and the app is unlocked
//   4. a note for the app (PushHandoff): it carries out lock / wipe when it runs, and does not show a
//      message twice when the same command arrives with the check-in
//
// Anything that fails — no keys, a wrong signature, a broken payload, the time running out — delivers the
// neutral text (never the payload, never the original if it is not one of the neutral texts).
//
// The shared code (Shared/*.swift) is the app's own: symlinks to ios/M5cet/Platform/Notifications/Shared,
// compiled into both targets and tested in M5cetTests.

import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let delivery = Delivery()

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let fallback = NotificationText.neutral(request.content)
        delivery.begin(contentHandler, fallback: fallback)
        let info = Box(request.content.userInfo)
        let delivery = self.delivery
        Task {
            let content = await ExtensionPipeline.content(info.value)
            delivery.deliver(content)
        }
    }

    /// iOS is about to give up (~30 s): the neutral text, never the original.
    override func serviceExtensionTimeWillExpire() {
        delivery.deliver(nil)
    }
}

/// Delivers exactly once (the pipeline or the timeout, whichever comes first).
final class Delivery: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?

    func begin(_ handler: @escaping (UNNotificationContent) -> Void, fallback: UNNotificationContent) {
        lock.withLock {
            self.handler = handler
            self.fallback = fallback
        }
    }

    /// `content` nil: the neutral fallback.
    func deliver(_ content: UNNotificationContent?) {
        let (h, f) = lock.withLock { () -> (((UNNotificationContent) -> Void)?, UNNotificationContent?) in
            defer { handler = nil }
            return (handler, fallback)
        }
        guard let h, let shown = content ?? f else { return }
        h(shown)
    }
}

struct Box<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

enum ExtensionPipeline {
    /// The content to show, nil when only the neutral text may show.
    static func content(_ userInfo: [AnyHashable: Any]) async -> UNNotificationContent? {
        guard let wire = PushOpener.wire(from: userInfo), let reader = SysTierReader.system(), let ctx = try? reader.context() else { return nil }
        let now = PushOpener.nowMs()
        guard let opened = try? PushOpener.open(wire, deviceId: ctx.deviceId, serverKey: ctx.serverKey, now: now, agree: ctx.agree) else { return nil }
        let locked = LockMirror.appLocked(at: reader.shared.appendingPathComponent("lock-state.json"))
        let security = opened.kind == "lock" || opened.kind == "wipe"
        PushHandoff(shared: reader.shared).record(PushHandoff.Entry(id: opened.id, kind: opened.kind, shown: true, wire: security ? wire : nil, at: now))
        let previewsAlways = await UNUserNotificationCenter.current().notificationSettings().showPreviewsSetting == .always
        let lang = (opened.payload["lang"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (ctx.prefs.lang.isEmpty ? NeutralTexts.deviceLanguage : ctx.prefs.lang)
        let plan = PushContent.control(kind: opened.kind, payload: opened.payload, locked: locked, prefs: ctx.prefs, previewsAlways: previewsAlways,
                                       now: now, texts: PushContent.defaultTexts(lang))
        let thread: String? = plan.serverRoom.flatMap { srv in
            ctx.conversationKey.map { k in
                let key = ThreadIds.serverRoom(secret: k, serverRoomId: srv)
                return ctx.threads[key] ?? key
            }
        }
        let content = NotificationContentFactory.content(plan, threadId: thread, userInfo: userInfo)
        if !locked, plan.sender != nil, let thread {
            return await NotificationContentFactory.communicating(content, plan: plan, conversationId: thread, donate: true)
        }
        return content
    }
}

enum NotificationText {
    /// The app's name and a neutral body; sound and the payload (for the app's tap handling) stay, everything that
    /// could show content goes. The server's own alert is kept only when it is one of the neutral texts.
    static func neutral(_ original: UNNotificationContent) -> UNNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "M5cet"
        content.body = NeutralTexts.isNeutral(original.body) ? original.body
            : String(localized: "notification.neutral.body", defaultValue: "New message",
                     comment: "The neutral text of a notification whose content stays hidden (sealed, or the app is locked).")
        content.sound = original.sound
        content.badge = original.badge
        content.categoryIdentifier = NotificationPlan.Category.notice.rawValue
        content.userInfo = original.userInfo
        return content
    }
}
