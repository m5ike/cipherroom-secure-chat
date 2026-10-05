// The app's notifications (Android telecom/Notify + ReplyReceiver): what it posts
// under which id and thread, what the lock leaves of it, and where a reply, a
// "mark read" and a tap go — only into a room the app is in, never while locked.

import Foundation
import M5Net
import UserNotifications
import XCTest
@testable import M5cet

@MainActor
final class NotifierTests: XCTestCase {
    final class Rooms: NotificationRooms {
        var joinedRoomKeys = ["team-key", "family-key"]
        var servers = ["srv-team": "team-key"]
        var labels = ["team-key": "Team", "family-key": "Family"]
        var replies: [(String, String)] = []
        var reads: [String] = []
        var opened: [String] = []
        func roomKey(forServerId id: String) -> String? { servers[id] }
        func label(ofRoom roomKey: String) -> String? { labels[roomKey] }
        func reply(roomKey: String, text: String) async -> Bool { replies.append((roomKey, text)); return true }
        func markRead(roomKey: String) { reads.append(roomKey) }
        func open(roomKey: String) { opened.append(roomKey) }
    }

    final class Settings: NotifySettingsSource {
        var values: [String: Any] = [:]
        func value(_ key: String) -> Any? { values[key] ?? NotificationPrefs.defaults[key] }
        func set(_ key: String, _ value: Any) { values[key] = value }
    }

    private var posted: [UNNotificationRequest] = []
    private var locked = false
    private let rooms = Rooms()

    private func notifier() -> Notifier {
        let store = MemorySyncStateStore()
        let n = Notifier(prefs: NotificationPrefs(settings: Settings(), store: store), conversations: Conversations(store: store), system: nil)
        n.post = { [unowned self] in self.posted.append($0) }
        n.isLocked = { [unowned self] in self.locked }
        n.isForeground = { false }
        n.callPrivacyLevel = { 2 }
        n.now = { 1 }
        n.rooms = rooms
        n.conversations.deleteDonations = { _ in }
        return n
    }

    private func settle(_ count: Int) async {
        for _ in 0..<200 where posted.count < count { try? await Task.sleep(for: .milliseconds(10)) }
    }

    func testARoomsMessageUnderItsOpaqueThread() async throws {
        let n = notifier()
        n.message(roomKey: "team-key", roomName: "Team", sender: "Bob", text: "Hello", hideContent: false)
        await settle(1)
        let r = try XCTUnwrap(posted.first)
        let conv = n.conversations.id("team-key")
        XCTAssertEqual(r.identifier, "room." + conv)
        XCTAssertEqual(r.content.threadIdentifier, conv)
        XCTAssertFalse(r.content.threadIdentifier.contains("team"), "never the room key")
        XCTAssertEqual(r.content.title, "Team")
        XCTAssertEqual(r.content.body, "Hello")
        XCTAssertEqual(r.content.categoryIdentifier, "m5.message")
        XCTAssertEqual(r.content.userInfo[NotificationContentFactory.isNeutralKey] as? Bool, false)
        XCTAssertEqual(r.content.userInfo[NotificationContentFactory.neutralKey] as? String, "notify.message")
        XCTAssertNil(r.content.userInfo["room"], "the room key is not stored with the notification")
    }

    func testWhileLockedOnlyTheNeutralText() async throws {
        locked = true
        let n = notifier()
        n.message(roomKey: "team-key", roomName: "Team", sender: "Bob", text: "Hello", hideContent: false)
        await settle(1)
        let r = try XCTUnwrap(posted.first)
        XCTAssertEqual(r.content.title, "M5cet")
        XCTAssertEqual(r.content.body, "New message")
        XCTAssertEqual(r.content.categoryIdentifier, "m5.notice", "no reply while locked")
        XCTAssertEqual(r.content.userInfo[NotificationContentFactory.isNeutralKey] as? Bool, true)
    }

    func testTheNotifiersMessageWithTheRoomsOwnName() async throws {
        let n = notifier()
        n.templated(["kind": "message", "privacy": "room", "room": "srv-team", "actions": true, "vars": ["app": "M5cet", "sender": "Bob"],
                     "tpl": ["title": "{app}[ · {room}]", "body": "[{sender}: ]{preview|New message}"]], local: false)
        await settle(1)
        let r = try XCTUnwrap(posted.first)
        XCTAssertEqual(r.identifier, "room." + n.conversations.id("team-key"), "it replaces the room's notification (Android: the same id)")
        XCTAssertEqual(r.content.title, "M5cet · Team")
        XCTAssertEqual(r.content.body, "Bob: New message")
        // A room this device is not in: its own thread, no name.
        n.templated(["kind": "message", "privacy": "room", "room": "srv-unknown", "tag": "t1", "tpl": ["title": "{app}[ · {room}]", "body": "x"]], local: false)
        await settle(2)
        XCTAssertEqual(posted.last?.content.title, "M5cet")
        XCTAssertTrue(posted.last?.content.threadIdentifier.hasPrefix("srv-") == true)
    }

    func testSwitchedOffKindsAreNotPosted() async {
        let n = notifier()
        (n.prefs.settings as? Settings)?.set("notify.message", false)
        n.message(roomKey: "team-key", roomName: "Team", sender: "Bob", text: "Hello", hideContent: false)
        n.templated(["kind": "message", "tpl": ["title": "a", "body": "b"]], local: false)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(posted.isEmpty)
        n.templated(["kind": "message", "tpl": ["title": "a", "body": "b"]], local: true)
        await settle(1)
        XCTAssertEqual(posted.count, 1, "a local test always shows")
    }

    func testRepliesGoOnlyIntoARoomTheAppIsInAndNeverWhileLocked() async {
        let n = notifier()
        let conv = n.conversations.id("team-key")
        let info: [AnyHashable: Any] = [NotificationContentFactory.threadKey: conv]
        await n.respond(action: Notifier.replyAction, text: "On my way", info: info)
        XCTAssertEqual(rooms.replies.map(\.0), ["team-key"])
        XCTAssertEqual(rooms.replies.map(\.1), ["On my way"])
        // Empty text, a room the app left, a forged thread, the app locked: nothing.
        await n.respond(action: Notifier.replyAction, text: "  ", info: info)
        rooms.joinedRoomKeys = ["family-key"]
        await n.respond(action: Notifier.replyAction, text: "hi", info: info)
        rooms.joinedRoomKeys = ["team-key", "family-key"]
        await n.respond(action: Notifier.replyAction, text: "hi", info: [NotificationContentFactory.threadKey: "conv-0000000000000000000"])
        locked = true
        await n.respond(action: Notifier.replyAction, text: "hi", info: info)
        XCTAssertEqual(rooms.replies.count, 1)
        locked = false
        await n.respond(action: Notifier.readAction, text: nil, info: info)
        XCTAssertEqual(rooms.reads, ["team-key"])
        await n.respond(action: UNNotificationDefaultActionIdentifier, text: nil, info: [NotificationContentFactory.threadKey: n.conversations.id("family-key")])
        XCTAssertEqual(rooms.opened, ["family-key"])
    }

    func testFlashesShowInTheAppWhenItIsOnScreen() async {
        let n = notifier()
        var shown: [String] = []
        n.flashSink = { _, text, _ in shown.append(text); return true }
        n.isForeground = { true }
        XCTAssertEqual(n.flash(title: "", text: "Maintenance", level: "warn"), "app")
        XCTAssertEqual(shown, ["Maintenance"])
        n.isForeground = { false }
        XCTAssertEqual(n.flash(title: "", text: "Later", level: "info"), "notification")
        await settle(1)
        XCTAssertEqual(posted.first?.content.title, "M5cet")
        XCTAssertEqual(posted.first?.content.body, "Later")
        // The extension already showed it: not again.
        XCTAssertEqual(n.flash(title: "", text: "Again", level: "info", alreadyShown: true), "notification")
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(posted.count, 1)
    }

    func testMissedCallsAndUpdates() async {
        let n = notifier()
        n.missedCall(roomKey: "team-key", who: "Alice", video: false, at: 5)
        await settle(1)
        XCTAssertEqual(posted.first?.content.title, "Alice · Team")
        XCTAssertEqual(posted.first?.content.body, "Missed call")
        XCTAssertEqual(posted.first?.content.categoryIdentifier, "m5.call")
        XCTAssertEqual(posted.first?.content.threadIdentifier, n.conversations.id("team-key"))
        locked = true
        n.missedCall(roomKey: "team-key", who: "Alice", video: false, at: 6)
        await settle(2)
        XCTAssertEqual(posted.last?.content.title, "M5cet")
        n.update(title: "A new version of the app", text: "6.15.0")
        await settle(3)
        XCTAssertEqual(posted.last?.identifier, "update")
        XCTAssertEqual(posted.last?.content.categoryIdentifier, "m5.update")
    }

    func testTheLockRemovesNamedConversations() {
        let n = notifier()
        var deleted = 0
        n.conversations.deleteDonations = { _ in deleted += 1 }
        n.lockDidForget()
        XCTAssertEqual(deleted, 1)
        // Switching conversations off removes them too.
        (n.prefs.settings as? Settings)?.set(ConversationPlan.settingOn, false)
        n.settingChanged(ConversationPlan.settingOn)
        XCTAssertEqual(deleted, 2)
    }

    func testTheContentFactory() {
        let plan = NotificationPlan(title: "T", body: "B", category: .call, sound: true, passive: false, neutral: false, neutralKey: "ring.call",
                                    url: "https://example.com")
        let c = NotificationContentFactory.content(plan, threadId: "conv-1", userInfo: ["m5": ["i": "x"]])
        XCTAssertEqual(c.interruptionLevel, .timeSensitive)
        XCTAssertEqual(c.userInfo[NotificationContentFactory.urlKey] as? String, "https://example.com")
        XCTAssertNotNil(c.userInfo["m5"], "the wire stays for the app's tap")
        var quiet = plan
        quiet.passive = true
        quiet.sound = false
        let q = NotificationContentFactory.content(quiet, threadId: nil)
        XCTAssertEqual(q.interruptionLevel, .passive)
        XCTAssertNil(q.sound)
        XCTAssertNotNil(NotificationContentFactory.monogram("Žofie"))
        XCTAssertEqual(Monogram.glyph("žofie"), "Ž")
        XCTAssertNotEqual(NotificationContentFactory.senderHandle("Bob", "conv-1"), NotificationContentFactory.senderHandle("Bob", "conv-2"))
        XCTAssertFalse(NotificationContentFactory.senderHandle("Bob", "conv-1").contains("Bob"))
    }
}
