// M5cet's Notification Service Extension: every visible push (`mutable-content: 1`)
// passes through here before iOS shows it (docs/ios-architecture.md § 5 — the
// counterpart of Android's FCM data messages handled in push/FcmService + telecom/Notify).
//
// Now: nothing of a message's content is shown — the title is the app's name and the
// body a neutral text ("New message", Localizable.xcstrings), whatever the push said.
// TODO(wave 2, Platform/Push + Platform/Notifications): open the sealed content (`m5`
// in the payload) with the keys shared through the App Group and the keychain group,
// and show it only while the app is not locked (G-22: locked → neutral text).

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var neutral: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        let content = NotificationText.neutral(request.content)
        neutral = content
        // The decrypt hook (wave 2) replaces `content` here when it can open the payload.
        contentHandler(content)
    }

    /// iOS is about to give up (~30 s): never let the original (possibly revealing) text through.
    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let neutral { contentHandler(neutral) }
    }
}

enum NotificationText {
    /// The app's name and a neutral body; sound, badge, thread and the payload (for the app's tap
    /// handling) stay, everything that could show content goes.
    static func neutral(_ original: UNNotificationContent) -> UNNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "M5cet"
        content.body = String(localized: "notification.neutral.body", defaultValue: "New message",
                              comment: "The neutral text of a notification whose content stays hidden (sealed, or the app is locked).")
        content.sound = original.sound
        content.badge = original.badge
        content.threadIdentifier = original.threadIdentifier
        content.categoryIdentifier = original.categoryIdentifier
        content.userInfo = original.userInfo
        return content
    }
}
