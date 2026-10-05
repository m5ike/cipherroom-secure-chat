// A NotificationPlan as UserNotifications content, and — where the plan may name
// the sender — a Communication Notification (INSendMessageIntent: the sender's
// name and monogram, the conversation; Android's conversation shortcuts and
// MessagingStyle). Without the entitlement com.apple.developer.usernotifications.
// communication `updating(from:)` fails and the plain content is posted.
//
// Ids handed to the system are opaque (ThreadIds): the conversation id, the
// thread id and the sender's handle never contain a room key or a name.
//
// Shared: compiled into the app and, through a symlink, into M5cetNotifications.

import Foundation
import Intents
import UIKit
import UserNotifications

enum NotificationContentFactory {
    /// userInfo keys the app reads back (a tap, a reply): the opaque thread, the neutral text's key, the link.
    static let threadKey = "m5.thread", neutralKey = "m5.neutral", isNeutralKey = "m5.isNeutral", urlKey = "m5.url", kindKey = "m5.kind"

    static func content(_ plan: NotificationPlan, threadId: String?, userInfo: [AnyHashable: Any] = [:]) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = plan.title
        c.body = plan.body
        c.categoryIdentifier = plan.category.rawValue
        if plan.sound { c.sound = .default }
        if plan.passive { c.interruptionLevel = .passive }
        else if plan.category == .call { c.interruptionLevel = .timeSensitive }
        if let threadId { c.threadIdentifier = threadId }
        var info = userInfo
        info[neutralKey] = plan.neutralKey
        info[isNeutralKey] = plan.neutral
        if let threadId { info[threadKey] = threadId }
        if let url = plan.url { info[urlKey] = url }
        c.userInfo = info
        return c
    }

    /// The content as a Communication Notification when the plan names a sender; the content itself otherwise
    /// (or when the system refuses — no entitlement). `donate`: the interaction is donated first (Siri's
    /// suggestions, the share sheet) under `conversationId` as its group, so it can be deleted again.
    nonisolated(nonsending) static func communicating(_ content: UNMutableNotificationContent, plan: NotificationPlan, conversationId: String?,
                              donate: Bool) async -> UNNotificationContent {
        guard let sender = plan.sender, !sender.isEmpty, let conversationId else { return content }
        let person = INPerson(personHandle: INPersonHandle(value: senderHandle(sender, conversationId), type: .unknown), nameComponents: nil,
                              displayName: sender, image: monogram(sender), contactIdentifier: nil,
                              customIdentifier: senderHandle(sender, conversationId), isMe: false, suggestionType: .none)
        let group = plan.groupName.map { INSpeakableString(spokenPhrase: $0) }
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText, content: nil, speakableGroupName: group,
                                         conversationIdentifier: conversationId, serviceName: nil, sender: person, attachments: nil)
        if let group = plan.groupName { intent.setImage(monogram(group), forParameterNamed: \.speakableGroupName) }
        if donate {
            let interaction = INInteraction(intent: intent, response: nil)
            interaction.direction = .incoming
            interaction.groupIdentifier = conversationId
            try? await interaction.donate()
        }
        do {
            return try content.updating(from: intent)
        } catch {
            return content
        }
    }

    /// An opaque handle per sender and conversation (not a name, not a room).
    static func senderHandle(_ sender: String, _ conversationId: String) -> String {
        "m5-" + String(ThreadIds.hmacHex(Data(conversationId.utf8), "m5cet/sender\u{0}" + sender).prefix(16))
    }

    /// The web's monogram (Monogram: the first letter on the tint of the name's hue) as an image.
    static func monogram(_ name: String, size: CGFloat = 96) -> INImage? {
        func color(_ argb: UInt32) -> UIColor {
            UIColor(red: CGFloat(argb >> 16 & 0xff) / 255, green: CGFloat(argb >> 8 & 0xff) / 255, blue: CGFloat(argb & 0xff) / 255,
                    alpha: CGFloat(argb >> 24 & 0xff) / 255)
        }
        let glyph = Monogram.glyph(name)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
        let image = renderer.image { ctx in
            color(Monogram.background(name)).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
            let font = UIFont.systemFont(ofSize: size * (glyph.count > 1 ? 0.34 : 0.42), weight: .semibold)
            let text = NSAttributedString(string: glyph, attributes: [.font: font, .foregroundColor: color(Monogram.foreground(name))])
            let b = text.size()
            text.draw(at: CGPoint(x: (size - b.width) / 2, y: (size - b.height) / 2))
        }
        return image.pngData().map { INImage(imageData: $0) }
    }
}
