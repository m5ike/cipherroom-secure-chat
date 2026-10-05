// Android NotifyTemplateTest, LockScreenTest and ConversationPlanTest, case by
// case: the shared template vectors (test/fixtures/notify-templates.json — the
// server's and the web's own), privacy, quiet hours, the channels' order,
// cleaning; what stays off the lock screen; which rooms become conversations.

import Foundation
import M5Net
import XCTest
@testable import M5cet

final class NotifyTemplateTests: XCTestCase {
    private static let vectors: NetJSON = (try? PushFixtures.json("test/fixtures/notify-templates.json")) ?? .object([:])

    private func vars(_ o: NetJSON?) -> [String: String] {
        var m: [String: String] = [:]
        for (k, v) in o?.objectValue ?? [:] { m[k] = v.stringValue ?? v.int64Value.map { String($0) } ?? "" }
        return m
    }

    func testEverySharedCaseRendersAsOnTheServerAndTheWeb() throws {
        let cases = try XCTUnwrap(Self.vectors.arr("cases"))
        XCTAssertGreaterThan(cases.count, 20)
        for c in cases {
            let got = NotifyTemplate.render(c.str("template"), NotifyTemplate.visibleVars(vars(c.obj("vars")), c.str("privacy")), NotifyTemplate.bodyMax)
            XCTAssertEqual(got, c.str("text"), "\(c.str("template")) @\(c.str("privacy"))")
        }
    }

    func testEveryDefaultTemplateInEveryLanguage() throws {
        let list = try XCTUnwrap(Self.vectors.arr("notifications"))
        XCTAssertFalse(list.isEmpty)
        for n in list {
            let tb = NotifyTemplate.notification(n.str("title"), n.str("body"), vars(n.obj("vars")), n.str("privacy"))
            XCTAssertEqual(tb.title, n.obj("expect")?.str("title"), "\(n.str("kind"))/\(n.str("lang"))")
            XCTAssertEqual(tb.body, n.obj("expect")?.str("body"), "\(n.str("kind"))/\(n.str("lang"))")
        }
    }

    func testPrivacyLevels() {
        XCTAssertEqual(NotifyTemplate.min("content", "room"), "room")
        XCTAssertEqual(NotifyTemplate.min("sender", "neutral"), "neutral")
        XCTAssertEqual(NotifyTemplate.min("whatever", "content"), "neutral")
        XCTAssertFalse(NotifyTemplate.visible("sender", "neutral"))
        XCTAssertTrue(NotifyTemplate.visible("sender", "sender"))
        XCTAssertFalse(NotifyTemplate.visible("room", "sender"))
        XCTAssertTrue(NotifyTemplate.visible("room", "room"))
        XCTAssertFalse(NotifyTemplate.visible("preview", "room"))
        XCTAssertTrue(NotifyTemplate.visible("preview", "content"))
        XCTAssertTrue(NotifyTemplate.visible("app", "neutral"))
        XCTAssertFalse(NotifyTemplate.visible("nonsense", "content"))
    }

    func testQuietHoursAcrossMidnight() {
        var c = DateComponents()
        (c.year, c.month, c.day, c.hour, c.minute) = (2026, 10, 4, 22, 30)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let at = Int64(cal.date(from: c)!.timeIntervalSince1970 * 1000)
        XCTAssertTrue(NotifyTemplate.inQuietHours(true, "22:00", "07:00", "UTC", at))
        XCTAssertFalse(NotifyTemplate.inQuietHours(true, "08:00", "17:00", "UTC", at))
        XCTAssertTrue(NotifyTemplate.inQuietHours(true, "00:00", "01:00", "Europe/Prague", at)) // 00:30 there
        XCTAssertFalse(NotifyTemplate.inQuietHours(false, "22:00", "07:00", "UTC", at))
        XCTAssertFalse(NotifyTemplate.inQuietHours(true, "25:00", "07:00", "UTC", at))
        XCTAssertFalse(NotifyTemplate.inQuietHours(true, "07:00", "07:00", "UTC", at))
    }

    func testChannelOrder() {
        XCTAssertEqual(NotifyTemplate.order("webpush, sms ,android,webpush"), ["webpush", "android"])
        XCTAssertEqual(NotifyTemplate.move("android,webpush,email", "webpush", -1), "webpush,android,email")
        XCTAssertEqual(NotifyTemplate.move("android,webpush,email", "webpush", 1), "android,email,webpush")
        XCTAssertEqual(NotifyTemplate.move("android,webpush,email", "android", -1), "android,webpush,email")
        XCTAssertEqual(NotifyTemplate.use("android,webpush,email", "webpush", false), "android,email")
        XCTAssertEqual(NotifyTemplate.use("android,email", "webpush", true), "android,email,webpush")
        XCTAssertEqual(NotifyTemplate.use("android,email", "pigeon", true), "android,email")
    }

    func testCleaning() {
        XCTAssertEqual(NotifyTemplate.clean("Eve\u{202e}\u{2066}gnp.exe\r\nBcc: x\u{0000}\u{200b}", 64), "Evegnp.exe Bcc: x")
        XCTAssertEqual(NotifyTemplate.clean("abcdefgh", 4), "abc…")
        XCTAssertEqual(NotifyTemplate.clean(nil, 10), "")
        // iOS: a cut never splits a surrogate pair.
        XCTAssertEqual(NotifyTemplate.clean("ab😀cd", 4), "ab…")
    }
}

final class LockScreenTests: XCTestCase {
    func testMessagesLeaveTheLockScreenWhenHiddenOrLocked() {
        for kind in ["message", "mention", "function", "summon", "test", "notify.message"] {
            XCTAssertFalse(LockScreen.secret(kind, appLocked: false, userHides: false), "\(kind): as before")
            XCTAssertTrue(LockScreen.secret(kind, appLocked: false, userHides: true), "\(kind): the person hides it")
            XCTAssertTrue(LockScreen.secret(kind, appLocked: true, userHides: false), "\(kind): the app is locked")
            XCTAssertTrue(LockScreen.secret(kind, appLocked: true, userHides: true), kind)
        }
    }

    func testARingStaysAnswerable() {
        for kind in ["call", "ring.call", "ring.missed"] {
            XCTAssertFalse(LockScreen.secret(kind, appLocked: true, userHides: true), kind)
            XCTAssertFalse(LockScreen.secret(kind, appLocked: false, userHides: true), kind)
        }
        XCTAssertEqual(LockScreen.setting, "notify.lockScreenHide")
    }

    func testOnIOSTheTextGoesNeutralWhereTheSystemWouldShowItOnALockedPhone() {
        // The person hides it, the system shows previews always: neutral.
        XCTAssertTrue(LockScreen.neutralText("message", appLocked: false, userHides: true, previewsAlways: true))
        // Previews "when unlocked" (the default): the system hides it there itself.
        XCTAssertFalse(LockScreen.neutralText("message", appLocked: false, userHides: true, previewsAlways: false))
        // The app locked: neutral whatever the system does.
        XCTAssertTrue(LockScreen.neutralText("message", appLocked: true, userHides: false, previewsAlways: false))
        XCTAssertFalse(LockScreen.neutralText("message", appLocked: false, userHides: false, previewsAlways: true))
        XCTAssertFalse(LockScreen.neutralText("call", appLocked: true, userHides: true, previewsAlways: true))
    }
}

final class ConversationPlanTests: XCTestCase {
    private static let secret = Data([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
    private let idOf: (String) -> String = { ConversationPlan.id(ConversationPlanTests.secret, $0) }

    private func room(_ key: String, _ label: String, _ activity: Int64, _ joined: Bool) -> ConversationPlan.Room {
        ConversationPlan.Room(key: key, label: label, activity: activity, joined: joined)
    }

    private var rooms: [ConversationPlan.Room?] {
        [room("rodina", "Rodina", 300, true), room("prace", "Práce", 900, true), room("stara", "Stará", 999, false), room("klub", "Klub", 300, true),
         room("bez-nazvu", "  ", 100, true)]
    }

    func testOnlyJoinedRoomsMostRecentFirst() {
        let all = ConversationPlan.plan(rooms, idOf: idOf, names: true, neutralTemplate: "Konverzace {n}")
        XCTAssertEqual(all.map(\.key), ["prace", "klub", "rodina", "bez-nazvu"])
        XCTAssertEqual(all.map(\.rank), [0, 1, 2, 3])
        XCTAssertEqual(all[0].label, "Práce")
        XCTAssertEqual(all[0].glyph, "P")
        XCTAssertEqual(all[0].seed, "Práce")
        XCTAssertEqual(all[3].label, "bez-nazvu")
        XCTAssertTrue(all[0].named)
    }

    func testARoomTwiceCountsOnce() {
        XCTAssertEqual(ConversationPlan.plan([room("a", "A", 1, true), room("a", "A again", 2, true), nil], idOf: idOf, names: true, neutralTemplate: "C {n}").count, 1)
    }

    func testCapFollowsTheSystemButStaysSmall() {
        XCTAssertEqual(ConversationPlan.cap(15), 8)
        XCTAssertEqual(ConversationPlan.cap(5), 5)
        XCTAssertEqual(ConversationPlan.cap(0), 0)
        XCTAssertEqual(ConversationPlan.cap(-1), 0)
        let all = ConversationPlan.plan(rooms, idOf: idOf, names: true, neutralTemplate: "C {n}")
        let top = ConversationPlan.top(all, 2)
        XCTAssertEqual(top.map(\.key), ["prace", "klub"])
        XCTAssertEqual(ConversationPlan.top(all, 10).count, 4)
        XCTAssertEqual(ConversationPlan.top(all, 0).count, 0)
    }

    func testNamesOnlyWhenWantedUnlockedAndNotificationsMayNameTheRoom() {
        XCTAssertTrue(ConversationPlan.names(wanted: true, locked: false, privacyRank: 2))
        XCTAssertTrue(ConversationPlan.names(wanted: true, locked: false, privacyRank: 3))
        XCTAssertFalse(ConversationPlan.names(wanted: true, locked: true, privacyRank: 3))
        XCTAssertFalse(ConversationPlan.names(wanted: true, locked: false, privacyRank: 1))
        XCTAssertFalse(ConversationPlan.names(wanted: true, locked: false, privacyRank: 0))
        XCTAssertFalse(ConversationPlan.names(wanted: false, locked: false, privacyRank: 3))
    }

    func testNeutralLabelsSayNothingOfTheRoomAndStayPutWhenTheOrderChanges() {
        let neutral = ConversationPlan.plan(rooms, idOf: idOf, names: false, neutralTemplate: "Konverzace {n}")
        var labels = Set<String>()
        for e in neutral {
            XCTAssertFalse(e.named)
            XCTAssertNotNil(e.label.range(of: "^Konverzace [1-4]$", options: .regularExpression), e.label)
            XCTAssertEqual(e.glyph, String(e.label.dropFirst("Konverzace ".count)))
            XCTAssertEqual(e.glyph, e.seed)
            for name in ["Rodina", "Práce", "Klub", "rodina", "prace", "klub", "bez-nazvu"] {
                XCTAssertFalse(e.label.contains(name))
                XCTAssertFalse(e.id.contains(name))
            }
            labels.insert(e.label)
        }
        XCTAssertEqual(labels.count, 4)
        let later = [room("rodina", "Rodina", 5000, true), room("prace", "Práce", 900, true), room("klub", "Klub", 300, true), room("bez-nazvu", "", 100, true)]
        let after = ConversationPlan.plan(later, idOf: idOf, names: false, neutralTemplate: "Konverzace {n}")
        XCTAssertEqual(after[0].key, "rodina")
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: neutral.map { ($0.id, $0.label) }), Dictionary(uniqueKeysWithValues: after.map { ($0.id, $0.label) }))
        XCTAssertEqual(ConversationPlan.setSignature(neutral, names: false), ConversationPlan.setSignature(after, names: false))
        XCTAssertNotEqual(ConversationPlan.rankSignature(neutral), ConversationPlan.rankSignature(after))
    }

    func testNeutralTemplateFallsBack() {
        XCTAssertEqual(ConversationPlan.neutral("Conversation {n}", 3), "Conversation 3")
        XCTAssertEqual(ConversationPlan.neutral("conversations.neutral", 2), "M5cet 2")
        XCTAssertEqual(ConversationPlan.neutral(nil, 1), "M5cet 1")
    }

    func testNeutralOfKnownIdsAlone() {
        let n = ConversationPlan.neutralOf(["conv-b", "conv-a", "conv-b"], neutralTemplate: "C {n}")
        XCTAssertEqual(n.count, 2)
        XCTAssertEqual(n[0].id, "conv-a")
        XCTAssertEqual(n[0].label, "C 1")
        XCTAssertEqual(n[1].label, "C 2")
        XCTAssertFalse(n[1].named)
    }

    func testIdsAreKeyedStableAndCarryNoName() {
        let a = ConversationPlan.id(Self.secret, "rodina")
        XCTAssertEqual(a, ConversationPlan.id(Self.secret, "rodina"))
        XCTAssertNotNil(a.range(of: "^conv-[0-9a-f]{20}$", options: .regularExpression), a)
        XCTAssertNotEqual(a, ConversationPlan.id(Self.secret, "prace"))
        XCTAssertNotEqual(a, ConversationPlan.id(Data([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00]), "rodina"))
        XCTAssertTrue(ConversationPlan.ours(a))
        XCTAssertTrue(ConversationPlan.ours("room-1a2b"))
        XCTAssertFalse(ConversationPlan.ours("other"))
        XCTAssertFalse(ConversationPlan.ours(nil))
    }

    func testTheIdIsAndroidsHmac() {
        // HMAC-SHA256(secret, "m5cet/conversation\0rodina") — the same id on both platforms for the same secret.
        let mac = ThreadIds.hmacHex(Self.secret, "m5cet/conversation\u{0}rodina")
        XCTAssertEqual(ConversationPlan.id(Self.secret, "rodina"), "conv-" + mac.prefix(20))
        XCTAssertEqual(mac.count, 64)
    }

    func testWhatGoesWhenARoomIsLeftDeletedOrRenamed() {
        let rodina = idOf("rodina"), prace = idOf("prace"), klub = idOf("klub")
        let existing = [rodina, prace, klub, "room-6a1f", "other-shortcut", prace]
        var keep: Set<String> = [rodina, prace]
        XCTAssertEqual(ConversationPlan.stale(existing, keep: keep), [klub, "room-6a1f"])
        keep.insert(klub)
        XCTAssertEqual(ConversationPlan.stale(existing, keep: keep), ["room-6a1f"])
    }

    func testEverythingGoesWhenSwitchedOff() {
        let rodina = idOf("rodina"), prace = idOf("prace")
        XCTAssertEqual(ConversationPlan.stale([rodina, prace, "room-6a1f", "other-shortcut"], keep: []), [rodina, prace, "room-6a1f"])
    }

    func testSignaturesSeparateWhatShowsFromTheOrder() {
        let named = ConversationPlan.plan(rooms, idOf: idOf, names: true, neutralTemplate: "C {n}")
        let neutral = ConversationPlan.plan(rooms, idOf: idOf, names: false, neutralTemplate: "C {n}")
        XCTAssertNotEqual(ConversationPlan.setSignature(named, names: true), ConversationPlan.setSignature(neutral, names: false))
        let renamed = [room("rodina", "Naši", 300, true), room("prace", "Práce", 900, true), room("klub", "Klub", 300, true), room("bez-nazvu", "", 100, true)]
        XCTAssertNotEqual(ConversationPlan.setSignature(named, names: true),
                          ConversationPlan.setSignature(ConversationPlan.plan(renamed, idOf: idOf, names: true, neutralTemplate: "C {n}"), names: true))
        let busier = [room("rodina", "Rodina", 5000, true), room("prace", "Práce", 900, true), room("klub", "Klub", 300, true), room("bez-nazvu", "  ", 100, true)]
        let after = ConversationPlan.plan(busier, idOf: idOf, names: true, neutralTemplate: "C {n}")
        XCTAssertEqual(ConversationPlan.setSignature(named, names: true), ConversationPlan.setSignature(after, names: true))
        XCTAssertNotEqual(ConversationPlan.rankSignature(named), ConversationPlan.rankSignature(after))
        let left = [room("prace", "Práce", 900, true), room("klub", "Klub", 300, true), room("bez-nazvu", "  ", 100, true)]
        XCTAssertNotEqual(ConversationPlan.setSignature(named, names: true),
                          ConversationPlan.setSignature(ConversationPlan.plan(left, idOf: idOf, names: true, neutralTemplate: "C {n}"), names: true))
    }

    func testWhenToPublish() {
        let now: Int64 = 1_000_000_000, last = now - 60_000
        XCTAssertEqual(ConversationPlan.when(setChanged: true, rankChanged: false, foreground: false, now: now, lastAt: last), ConversationPlan.now)
        XCTAssertEqual(ConversationPlan.when(setChanged: true, rankChanged: true, foreground: true, now: now, lastAt: now), ConversationPlan.now)
        XCTAssertEqual(ConversationPlan.when(setChanged: false, rankChanged: false, foreground: true, now: now, lastAt: last), ConversationPlan.nothing)
        XCTAssertEqual(ConversationPlan.when(setChanged: false, rankChanged: true, foreground: false, now: now, lastAt: last), ConversationPlan.onForeground)
        XCTAssertEqual(ConversationPlan.when(setChanged: false, rankChanged: true, foreground: true, now: now, lastAt: last), ConversationPlan.rankEveryMs - 60_000)
        XCTAssertEqual(ConversationPlan.when(setChanged: false, rankChanged: true, foreground: true, now: now, lastAt: now - ConversationPlan.rankEveryMs),
                       ConversationPlan.now)
    }

    func testMonogramColoursAreOpaqueTintsOfTheWebs() {
        XCTAssertEqual(ConversationPlan.opaque(0x0012_3456), 0xffff_ffff)
        XCTAssertEqual(ConversationPlan.opaque(0xff12_3456), 0xff12_3456)
        let bg = ConversationPlan.background("Rodina")
        XCTAssertEqual(bg >> 24, 0xff)
        let fg = ConversationPlan.foreground("Rodina")
        for shift: UInt32 in [0, 8, 16] { XCTAssertGreaterThan(bg >> shift & 0xff, fg >> shift & 0xff) }
        XCTAssertEqual(ConversationPlan.background("rodina"), bg)
    }

    func testDefaultsAreOn() {
        var d: [String: Any] = [:]
        ConversationPlan.defaults(&d)
        XCTAssertEqual(d["conversations.on"] as? Bool, true)
        XCTAssertEqual(d["conversations.names"] as? Bool, true)
    }
}
