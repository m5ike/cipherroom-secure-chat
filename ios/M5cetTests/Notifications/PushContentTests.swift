// What a notification says (Android telecom/Notify's rules, PushContent) and the
// person's settings (push/NotifyPrefs): the lock (S11), the levels within the
// operator's maximum, quiet hours, the extension's mirror and the server's shape.

import Foundation
import M5Net
import XCTest
@testable import M5cet

final class PushContentTests: XCTestCase {
    private let texts = PushContent.defaultTexts("en")
    private var prefs: NotifyMirror {
        var p = NotifyMirror()
        p.appName = "M5cet"
        return p
    }

    private let notify: [String: Any] = [
        "v": 1, "id": "n1", "kind": "message", "title": "Bob in a room", "body": "New message",
        "tpl": ["title": "{app}[ · {room}]", "body": "[{sender}: ]{preview|New message}[ ({count})]"],
        "vars": ["app": "M5cet", "sender": "Bob", "count": "3", "preview": "Hello there"], "privacy": "content", "room": "srv1", "tag": "m5-message",
        "group": "room", "sound": true, "actions": true, "lang": "en", "at": 1_700_000_000_000,
    ]

    func testTheServersTemplateDrawnAgain() {
        let p = PushContent.templated(notify, locked: false, prefs: prefs, previewsAlways: false, now: 1, roomName: "Team", texts: texts)
        // The level is at most "room" for the server's templates; the preview never shows (the server has none).
        XCTAssertEqual(p.title, "M5cet · Team")
        XCTAssertEqual(p.body, "Bob: New message (3)")
        XCTAssertEqual(p.category, .message)
        XCTAssertEqual(p.sender, "Bob")
        XCTAssertEqual(p.groupName, "Team")
        XCTAssertEqual(p.serverRoom, "srv1")
        XCTAssertFalse(p.neutral)
        XCTAssertTrue(p.sound)
        XCTAssertEqual(p.at, 1_700_000_000_000)
        // Without the room's name (the extension): no room.
        let ext = PushContent.templated(notify, locked: false, prefs: prefs, previewsAlways: false, now: 1, texts: texts)
        XCTAssertEqual(ext.title, "M5cet")
        XCTAssertNil(ext.groupName)
    }

    func testLockedNothingNamesAPersonOrARoom() {
        let p = PushContent.templated(notify, locked: true, prefs: prefs, previewsAlways: false, now: 1, roomName: "Team", texts: texts)
        XCTAssertEqual(p.title, "M5cet")
        XCTAssertEqual(p.body, "New message")
        XCTAssertNil(p.sender)
        XCTAssertNil(p.groupName)
        XCTAssertTrue(p.neutral)
        XCTAssertEqual(p.category, .notice, "no reply while locked")
        // Without a template the server's own title (which may name the sender) does not show either.
        var plain = notify
        plain.removeValue(forKey: "tpl")
        let q = PushContent.templated(plain, locked: true, prefs: prefs, previewsAlways: false, now: 1, texts: texts)
        XCTAssertEqual(q.title, "M5cet")
        XCTAssertEqual(q.body, "New message")
        let unlocked = PushContent.templated(plain, locked: false, prefs: prefs, previewsAlways: false, now: 1, texts: texts)
        XCTAssertEqual(unlocked.title, "Bob in a room")
    }

    func testTheLevelDecidesWhatShows() {
        var n = notify
        n["privacy"] = "sender"
        let s = PushContent.templated(n, locked: false, prefs: prefs, previewsAlways: false, now: 1, roomName: "Team", texts: texts)
        XCTAssertEqual(s.title, "M5cet")
        XCTAssertEqual(s.body, "Bob: New message (3)")
        XCTAssertEqual(s.sender, "Bob")
        XCTAssertNil(s.groupName)
        n["privacy"] = "neutral"
        let z = PushContent.templated(n, locked: false, prefs: prefs, previewsAlways: false, now: 1, roomName: "Team", texts: texts)
        XCTAssertEqual(z.body, "New message (3)")
        XCTAssertNil(z.sender)
        XCTAssertTrue(z.neutral)
    }

    func testHiddenFromTheLockScreenWhereTheSystemWouldShowIt() {
        var p = prefs
        p.lockScreenHide = true
        let hidden = PushContent.templated(notify, locked: false, prefs: p, previewsAlways: true, now: 1, roomName: "Team", texts: texts)
        XCTAssertEqual(hidden.title, "M5cet")
        XCTAssertEqual(hidden.body, "New message")
        XCTAssertNil(hidden.sender)
        let system = PushContent.templated(notify, locked: false, prefs: p, previewsAlways: false, now: 1, roomName: "Team", texts: texts)
        XCTAssertEqual(system.title, "M5cet · Team", "the system hides the preview on the lock screen itself")
    }

    func testSwitchedOffOrQuietIsDeliveredQuietly() {
        var p = prefs
        p.kinds["message"] = false
        let off = PushContent.templated(notify, locked: false, prefs: p, previewsAlways: false, now: 1, texts: texts)
        XCTAssertTrue(off.passive)
        XCTAssertFalse(off.sound)
        // A local test always shows.
        var test = notify
        test["kind"] = "test"
        XCTAssertFalse(PushContent.templated(test, locked: false, prefs: p, previewsAlways: false, now: 1, texts: texts).passive)
        var q = prefs
        (q.quiet, q.quietFrom, q.quietTo, q.timeZone) = (true, "00:00", "23:59", "UTC")
        XCTAssertTrue(PushContent.templated(notify, locked: false, prefs: q, previewsAlways: false, now: 1_700_000_000_000, texts: texts).passive)
    }

    func testCallsAndOtherKinds() {
        var call = notify
        call["kind"] = "call"
        call.removeValue(forKey: "tpl")
        let c = PushContent.templated(call, locked: true, prefs: prefs, previewsAlways: false, now: 1, texts: texts)
        XCTAssertEqual(c.category, .call)
        XCTAssertEqual(c.body, "Incoming call")
        XCTAssertEqual(c.neutralKey, "ring.call")
        let lock = PushContent.control(kind: "lock", payload: ["reason": "lost"], locked: false, prefs: prefs, previewsAlways: false, now: 1, texts: texts)
        XCTAssertEqual(lock.body, "Security notice")
        XCTAssertEqual(lock.category, .security)
        let flash = PushContent.control(kind: "flash", payload: ["title": "", "text": "Maintenance"], locked: true, prefs: prefs, previewsAlways: false,
                                        now: 1, texts: texts)
        XCTAssertEqual(flash.title, "M5cet")
        XCTAssertEqual(flash.body, "Maintenance")
        let push = PushContent.control(kind: "push", payload: ["title": "News", "body": "Read", "url": "http://insecure.example"], locked: false,
                                       prefs: prefs, previewsAlways: false, now: 1, texts: texts)
        XCTAssertNil(push.url, "only https links")
        XCTAssertEqual(PushContent.push(["url": "https://example.com"], appName: "M").url, "https://example.com")
        XCTAssertEqual(PushContent.control(kind: "ping", payload: [:], locked: false, prefs: prefs, previewsAlways: false, now: 1, texts: texts).body,
                       "New notification")
        XCTAssertEqual(PushContent.defaultTexts("cs")(.security), "Bezpečnostní oznámení")
    }

    func testTheAppsOwnMessages() {
        // Android Notify.message: content only at "content", the sender from "sender", the room from "room"; never while locked.
        func m(_ level: Int, locked: Bool = false) -> NotificationPlan {
            PushContent.message(roomName: "Team", sender: "Bob\u{202e}", text: "Hello", locked: locked, level: level, prefs: prefs, previewsAlways: false,
                                templateSound: true, templateActions: true, now: 1, texts: texts)
        }
        XCTAssertEqual([m(3).title, m(3).body, m(3).sender], ["Team", "Hello", "Bob"])
        XCTAssertEqual(m(3).category, .message)
        XCTAssertEqual([m(2).title, m(2).body], ["Team", "New message"])
        XCTAssertEqual([m(1).title, m(1).body, m(1).sender], ["M5cet", "New message", "Bob"])
        XCTAssertNil(m(1).groupName)
        XCTAssertEqual([m(0).title, m(0).body], ["M5cet", "New message"])
        XCTAssertNil(m(0).sender)
        let locked = m(3, locked: true)
        XCTAssertEqual([locked.title, locked.body], ["M5cet", "New message"])
        XCTAssertNil(locked.sender)
        XCTAssertEqual(locked.category, .notice)
        XCTAssertTrue(locked.neutral)
        // The operator's maximum caps the person's choice; a locked app at most "room".
        XCTAssertEqual(PushContent.localPrivacy(chosen: "", operatorMax: "room", locked: false), "room")
        XCTAssertEqual(PushContent.localPrivacy(chosen: "content", operatorMax: nil, locked: false), "content")
        XCTAssertEqual(PushContent.localPrivacy(chosen: "content", operatorMax: nil, locked: true), "room")
        XCTAssertEqual(PushContent.localPrivacy(chosen: "sender", operatorMax: "content", locked: false), "sender")
    }

    func testMissedCalls() {
        let a = PushContent.missedCall(who: "Alice", roomName: "Team", level: 2, locked: false, appName: "M5cet", texts: texts, at: 5)
        XCTAssertEqual(a.title, "Alice · Team")
        XCTAssertEqual(a.body, "Missed call")
        XCTAssertFalse(a.sound)
        XCTAssertEqual(PushContent.missedCall(who: "Alice", roomName: "Team", level: 1, locked: false, appName: "M5cet", texts: texts, at: 5).title, "Alice")
        XCTAssertEqual(PushContent.missedCall(who: "Alice", roomName: "Team", level: 0, locked: false, appName: "M5cet", texts: texts, at: 5).title, "M5cet")
        XCTAssertEqual(PushContent.missedCall(who: "Alice", roomName: "Team", level: 2, locked: true, appName: "M5cet", texts: texts, at: 5).title, "M5cet")
    }

    func testNeutralTexts() {
        XCTAssertEqual(NeutralTexts.text(.message, lang: "cs-CZ"), "Nová zpráva")
        XCTAssertEqual(NeutralTexts.text(.call, lang: "xx"), "Incoming call")
        XCTAssertTrue(NeutralTexts.isNeutral("Uusi viesti"))
        XCTAssertFalse(NeutralTexts.isNeutral("Bob: hello"))
        for lang in NeutralTexts.languages { for k in NeutralTexts.Kind.allCases { XCTAssertFalse(NeutralTexts.text(k, lang: lang).isEmpty) } }
    }
}

@MainActor
final class NotificationPrefsTests: XCTestCase {
    final class Settings: NotifySettingsSource {
        var values: [String: Any] = [:]
        func value(_ key: String) -> Any? { values[key] ?? NotificationPrefs.defaults[key] }
        func set(_ key: String, _ value: Any) { values[key] = value }
    }

    final class Account: NotifyAccount {
        var signedIn = true
        var sessionToken: String? = "session"
    }

    func testDefaultsAreAndroids() {
        let p = NotificationPrefs(settings: Settings(), store: nil)
        XCTAssertTrue(p.on)
        XCTAssertEqual(p.string("notify.order"), "android,webpush,email")
        XCTAssertEqual(p.string("notify.quietFrom"), "22:00")
        XCTAssertFalse(p.bool(LockScreen.setting))
        for k in NotificationPrefs.kinds { XCTAssertTrue(p.bool("notify." + k)) }
        XCTAssertTrue(p.allows("message", at: 1))
        XCTAssertEqual(p.localPrivacy("message", locked: false), "content")
        XCTAssertEqual(p.localPrivacy("message", locked: true), "room")
    }

    func testSwitchesQuietHoursAndTheMirror() throws {
        let s = Settings()
        let store = MemorySyncStateStore()
        let p = NotificationPrefs(settings: s, store: store)
        s.set("notify.mention", false)
        XCTAssertFalse(p.allows("mention", at: 1))
        XCTAssertTrue(p.allows("test", at: 1))
        s.set("notify.on", false)
        XCTAssertFalse(p.allows("message", at: 1))
        s.set("notify.on", true)
        s.set("notify.privacy", "sender")
        s.set(LockScreen.setting, true)
        p.settingChanged("notify.privacy")
        let m = NotifyMirror.from(store.loadNow(NotifyMirror.record)?.data)
        XCTAssertEqual(m.privacy, "sender")
        XCTAssertTrue(m.lockScreenHide)
        XCTAssertEqual(m.kinds["mention"], false)
        XCTAssertEqual(m, p.mirror)
        // The operator's maximum (the kept templates).
        store.saveNow("notify-policy", ["templates": ["message": ["maxPrivacy": "neutral"]]])
        s.set("notify.privacy", "")
        XCTAssertEqual(p.localPrivacy("message", locked: false), "neutral")
    }

    func testTheChannelsScreen() {
        let s = Settings()
        let p = NotificationPrefs(settings: s, store: nil)
        p.run("notify.down", "android")
        XCTAssertEqual(p.string("notify.order"), "webpush,android,email")
        p.run("notify.drop", "email")
        XCTAssertEqual(p.string("notify.order"), "webpush,android")
        p.run("notify.use", "email")
        p.run("notify.up", "email")
        XCTAssertEqual(p.string("notify.order"), "webpush,email,android")
        let scope = p.scope(pushEnabled: true, linked: false)
        let rows = scope["channels"] as? [[String: Any]] ?? []
        XCTAssertEqual(rows.map { $0["id"] as? String }, ["webpush", "email", "android"])
        XCTAssertEqual((scope["hours"] as? [Any])?.count, 48)
    }

    func testTheServersShapeAndTheSync() async throws {
        let s = Settings()
        s.set("notify.quiet", true)
        let rig = DeviceRig()
        _ = await rig.enroll()
        let store = MemorySyncStateStore()
        let p = NotificationPrefs(settings: s, store: store)
        p.device = rig.device
        p.http = HTTPClient(transport: rig.server)
        p.unlocked = { true }
        let account = Account()
        p.account = account
        let j = p.serverPrefs.json
        XCTAssertEqual(Set(j.objectValue!.keys), ["on", "kinds", "privacy", "order", "quiet", "lang"])
        XCTAssertEqual(j.obj("quiet")?.bool("on"), true)
        XCTAssertEqual(j.arr("order")?.count, 3)
        await p.sync()
        // The operator's templates kept for the lock; the settings to the account; the device linked (refused here: 401).
        XCTAssertEqual(store.loadNow("notify-policy")?.obj("templates")?.obj("message")?.str("maxPrivacy"), "room")
        let put = try XCTUnwrap(rig.server.requests("/api/account/notify").first)
        XCTAssertEqual(put.headers["Authorization"], "Bearer session")
        XCTAssertEqual(put.json?.obj("quiet")?.bool("on"), true)
        XCTAssertEqual(rig.server.requests("/api/ios/notify").last?.json?.str("token"), "session")
        // Locked: no account session — nothing is unlinked.
        p.unlocked = { false }
        let before = rig.server.requests("/api/ios/notify").count
        await p.sync()
        XCTAssertEqual(rig.server.requests("/api/ios/notify").count, before)
    }

    func testALocalTestNotificationWhenSignedOut() async {
        let p = NotificationPrefs(settings: Settings(), store: nil)
        var posted: [[String: Any]] = []
        var flashes: [String] = []
        p.postLocalTest = { posted.append($0) }
        p.onFlash = { t, _ in flashes.append(t) }
        await p.test()
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual(posted.first?["kind"] as? String, "test")
        XCTAssertEqual(flashes.count, 1)
    }
}
