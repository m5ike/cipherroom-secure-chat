// What a notification says — the decisions of Android telecom/Notify (message,
// templated, flash, push, the lock's neutral texts) without the platform: the
// app (Notifier) and the notification extension both post what this plans.
//
// Audit S11 / G-22: while the app is locked nothing names a person or a room and
// no message shows; the person's level (within the operator's maximum) decides
// how much shows otherwise; what Android keeps off the lock screen is neutral on
// iOS when the system would show its preview there (LockScreen).
//
// Shared: compiled into the app and, through a symlink, into M5cetNotifications.

import Foundation

/// One notification to post.
struct NotificationPlan: Equatable, Sendable {
    enum Category: String, Sendable, CaseIterable {
        /// A room's message: reply and mark-read actions.
        case message = "m5.message"
        /// Anything without actions (a message while locked, notices, the server's templates without a room).
        case notice = "m5.notice"
        /// A call's ring or a missed call.
        case call = "m5.call"
        /// The server's lock / wipe (neutral, no actions).
        case security = "m5.security"
        /// A new version of the app.
        case update = "m5.update"
    }

    var title: String
    var body: String
    var category: Category
    /// Plays the default sound (a template without sound: none).
    var sound: Bool
    /// Delivered quietly (passive): a kind switched off on the phone or quiet hours — the extension
    /// cannot drop a notification without Apple's filtering entitlement.
    var passive = false
    /// Nothing in it names a person or a room or shows a message.
    var neutral: Bool
    /// The design key of its neutral text (Android Notify EXTRA_NEUTRAL) — what the lock turns it into.
    var neutralKey: String
    /// A communication notification's sender (only where the level shows the sender and the app is unlocked).
    var sender: String?
    /// A communication notification's group name (only where the level shows the room).
    var groupName: String?
    /// The server's opaque room id (the extension maps it to the room's thread; the app to the room).
    var serverRoom: String?
    /// An https link the notification opens (the console's push).
    var url: String?
    /// When it happened (ms), 0 = now.
    var at: Int64 = 0
}

enum PushContent {
    /// The neutral text of a kind in the person's language (the app passes the design's texts instead).
    typealias Texts = (NeutralTexts.Kind) -> String

    static func defaultTexts(_ lang: String) -> Texts { { NeutralTexts.text($0, lang: lang) } }

    private static func str(_ p: [String: Any], _ k: String) -> String? {
        switch p[k] {
        case let s as String: s
        case let n as NSNumber: n.stringValue
        default: nil
        }
    }

    private static func bool(_ p: [String: Any], _ k: String, _ fallback: Bool) -> Bool { (p[k] as? Bool) ?? (p[k] as? NSNumber)?.boolValue ?? fallback }

    /// Android Notify.templated: a "notify" control message (server/notify's payload) drawn again on the device.
    /// `roomName`: the room's own name when the app knows the room (the extension never does).
    static func templated(_ p: [String: Any], locked: Bool, prefs: NotifyMirror, previewsAlways: Bool, now: Int64, roomName: String? = nil,
                          local: Bool = false, texts: Texts) -> NotificationPlan {
        let kind = str(p, "kind") ?? "message"
        let allowed = local || prefs.allows(kind, at: now)
        let privacy = locked ? "neutral" : NotifyTemplate.min(str(p, "privacy") ?? "neutral", "room")
        var vars: [String: String] = [:]
        if let given = p["vars"] as? [String: Any] {
            for (k, v) in given where k != "preview" { vars[k] = (v as? String) ?? (v as? NSNumber)?.stringValue ?? "" }
        }
        if (vars["app"] ?? "").isEmpty { vars["app"] = prefs.appName }
        if let roomName, !locked, NotifyTemplate.rank(privacy) >= 2 { vars["room"] = roomName }
        // 6.14 call wake: a call's end (payload.call.end) is its "missed call", as the server's neutral alert says.
        let callEnd = kind == "call" && ((p["call"] as? [String: Any])?["end"] as? Bool) == true
        let neutralKind: NeutralTexts.Kind = callEnd ? .missed : NeutralTexts.kind(forNotify: kind)
        var title: String, body: String
        if let tpl = p["tpl"] as? [String: Any] {
            (title, body) = NotifyTemplate.notification(str(tpl, "title"), str(tpl, "body"), vars, privacy)
        } else if locked {
            (title, body) = (prefs.appName, texts(neutralKind))
        } else {
            title = NotifyTemplate.clean(str(p, "title") ?? prefs.appName, NotifyTemplate.titleMax)
            body = NotifyTemplate.clean(str(p, "body"), NotifyTemplate.bodyMax)
        }
        if body.isEmpty { body = locked ? texts(neutralKind) : NotifyTemplate.clean(str(p, "body"), NotifyTemplate.bodyMax) }
        if body.isEmpty { body = texts(neutralKind) }
        let neutralNow = LockScreen.neutralText(kind, appLocked: locked, userHides: prefs.lockScreenHide, previewsAlways: previewsAlways)
        if neutralNow { (title, body) = (prefs.appName, texts(neutralKind)) }
        let rank = NotifyTemplate.rank(privacy)
        let messageLike = kind == "message" || kind == "mention"
        let category: NotificationPlan.Category = kind == "call" ? .call
            : bool(p, "actions", false) && !locked && !neutralNow && messageLike && str(p, "room") != nil ? .message : .notice
        let sender = !locked && !neutralNow && messageLike && rank >= 1 ? vars["sender"].map { NotifyTemplate.clean($0, 64) }.flatMap { $0.isEmpty ? nil : $0 } : nil
        let group = !locked && !neutralNow && rank >= 2 ? roomName.flatMap { $0.isEmpty ? nil : $0 } : nil
        return NotificationPlan(title: title, body: body, category: category, sound: bool(p, "sound", true) && allowed, passive: !allowed,
                                neutral: locked || neutralNow || rank == 0, neutralKey: callEnd ? "ring.missed" : kind == "call" ? "ring.call" : "notify.message",
                                sender: sender, groupName: group, serverRoom: str(p, "room").flatMap { $0.isEmpty ? nil : $0 },
                                url: nil, at: (p["at"] as? NSNumber)?.int64Value ?? 0)
    }

    /// Android Notify.flash outside the app: the operator's notice (no person's content).
    static func flash(_ p: [String: Any], appName: String) -> NotificationPlan {
        let title = NotifyTemplate.clean(str(p, "title"), NotifyTemplate.titleMax)
        let text = String((str(p, "text") ?? "").prefix(500))
        return NotificationPlan(title: title.isEmpty ? appName : title, body: text, category: .notice, sound: true, neutral: true,
                                neutralKey: "notify.message")
    }

    /// Android Notify.push: the console's push (title, body, room, an https link).
    static func push(_ p: [String: Any], appName: String) -> NotificationPlan {
        let title = NotifyTemplate.clean(str(p, "title"), NotifyTemplate.titleMax)
        let url = str(p, "url").flatMap { $0.hasPrefix("https://") ? $0 : nil }
        return NotificationPlan(title: title.isEmpty ? appName : title, body: String((str(p, "body") ?? "").prefix(1000)), category: .notice, sound: true,
                                neutral: true, neutralKey: "notify.message", serverRoom: str(p, "room").flatMap { $0.isEmpty ? nil : $0 }, url: url)
    }

    /// The server's lock / wipe, and anything that cannot be opened: what the server's own alert said.
    static func security(appName: String, texts: Texts) -> NotificationPlan {
        NotificationPlan(title: appName, body: texts(.security), category: .security, sound: true, neutral: true, neutralKey: "notify.message")
    }

    static func neutral(_ kind: NeutralTexts.Kind, appName: String, texts: Texts, sound: Bool = true) -> NotificationPlan {
        NotificationPlan(title: appName, body: texts(kind), category: kind == .call || kind == .missed ? .call : .notice, sound: sound, neutral: true,
                         neutralKey: NeutralTexts.designKey(kind))
    }

    /// What a control message becomes in the extension (and in the app for a message it opened itself).
    static func control(kind: String, payload: [String: Any], locked: Bool, prefs: NotifyMirror, previewsAlways: Bool, now: Int64,
                        texts: Texts) -> NotificationPlan {
        switch kind {
        case "notify": templated(payload, locked: locked, prefs: prefs, previewsAlways: previewsAlways, now: now, texts: texts)
        case "flash": flash(payload, appName: prefs.appName)
        case "push": push(payload, appName: prefs.appName)
        case "lock", "wipe": security(appName: prefs.appName, texts: texts)
        default: neutral(.notice, appName: prefs.appName, texts: texts)
        }
    }

    /// The app's privacy level for what it draws itself (Android NotifyPrefs.localPrivacy): the person's choice
    /// ("" = everything) within the operator's maximum; `locked` caps it at "room".
    static func localPrivacy(chosen: String, operatorMax: String?, locked: Bool) -> String {
        let level = NotifyTemplate.min(chosen.isEmpty ? "content" : chosen, operatorMax ?? "content")
        return locked ? NotifyTemplate.min(level, "room") : level
    }

    /// Android Notify.message: new messages of a room the app decrypted itself. `level`: the rank of
    /// localPrivacy("message", hideContent); `templateSound` / `templateActions`: the operator's message template.
    static func message(roomName: String, sender: String, text: String, locked: Bool, level: Int, prefs: NotifyMirror, previewsAlways: Bool,
                        templateSound: Bool, templateActions: Bool, now: Int64, texts: Texts) -> NotificationPlan {
        let allowed = prefs.allows("message", at: now)
        let rank = locked ? 0 : level
        let neutralNow = LockScreen.neutralText("message", appLocked: locked, userHides: prefs.lockScreenHide, previewsAlways: previewsAlways)
        let show = neutralNow ? 0 : rank
        let senderShown = show >= 1 ? NotifyTemplate.clean(sender, 64) : ""
        let title = show >= 2 ? NotifyTemplate.clean(roomName, NotifyTemplate.titleMax) : prefs.appName
        let body = show >= 3 ? NotifyTemplate.clean(text, NotifyTemplate.bodyMax) : texts(.message)
        return NotificationPlan(title: title.isEmpty ? prefs.appName : title, body: body.isEmpty ? texts(.message) : body,
                                category: !locked && !neutralNow && templateActions ? .message : .notice,
                                sound: templateSound && allowed, passive: !allowed, neutral: show == 0, neutralKey: "notify.message",
                                sender: senderShown.isEmpty ? nil : senderShown, groupName: show >= 2 && !roomName.isEmpty ? title : nil)
    }

    /// A missed call (CallCenter.onMissed): its person only within the calls' privacy, never while locked.
    static func missedCall(who: String, roomName: String, level: Int, locked: Bool, appName: String, texts: Texts, at: Int64) -> NotificationPlan {
        let rank = locked ? 0 : level
        let person = rank >= 1 ? NotifyTemplate.clean(who, 64) : ""
        let room = rank >= 2 ? NotifyTemplate.clean(roomName, 64) : ""
        let title = person.isEmpty ? appName : room.isEmpty ? person : "\(person) · \(room)"
        return NotificationPlan(title: title, body: texts(.missed), category: .call, sound: false, neutral: person.isEmpty, neutralKey: "ring.missed", at: at)
    }
}
